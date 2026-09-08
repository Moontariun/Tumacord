#include "capture.h"

#include <audioclientactivationparams.h>
#include <avrt.h>
#include <wrl/implements.h>

#include <algorithm>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace tumacord {
namespace {

// `ActivateAudioInterfaceAsync` devolve o resultado por callback. Como o resto
// do helper é síncrono, o manipulador apenas sinaliza um evento e o chamador
// espera — sem bomba de mensagens, porque o processo roda em MTA.
class ActivationHandler : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  explicit ActivationHandler(HANDLE done) : done_(done) {}

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activationResult = E_UNEXPECTED;
    ComPtr<IUnknown> activated;
    const HRESULT hr = operation->GetActivateResult(&activationResult, &activated);
    result_ = SUCCEEDED(hr) ? activationResult : hr;
    if (SUCCEEDED(result_) && activated) activated.As(&client_);
    SetEvent(done_);
    return S_OK;
  }

  HRESULT result() const { return result_; }
  ComPtr<IAudioClient> client() const { return client_; }

 private:
  HANDLE done_;
  HRESULT result_ = E_UNEXPECTED;
  ComPtr<IAudioClient> client_;
};

WAVEFORMATEX FloatFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;
  return format;
}

WAVEFORMATEX PcmFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;
  return format;
}

}  // namespace

ProcessLoopbackCapture::~ProcessLoopbackCapture() {
  Stop();
}

HRESULT ProcessLoopbackCapture::Activate(DWORD pid, bool includeTree, IAudioClient** client) {
  AUDIOCLIENT_ACTIVATION_PARAMS activation{};
  activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activation.ProcessLoopbackParams.TargetProcessId = pid;
  activation.ProcessLoopbackParams.ProcessLoopbackMode =
      includeTree ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT parameter{};
  parameter.vt = VT_BLOB;
  parameter.blob.cbSize = sizeof(activation);
  parameter.blob.pBlobData = reinterpret_cast<BYTE*>(&activation);

  const HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!done) return HRESULT_FROM_WIN32(GetLastError());
  auto handler = Microsoft::WRL::Make<ActivationHandler>(done);
  if (!handler) {
    CloseHandle(done);
    return E_OUTOFMEMORY;
  }
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &parameter, handler.Get(), &operation);
  if (SUCCEEDED(hr)) {
    // Dois segundos e folga larga para uma ativacao que normalmente responde em
    // microssegundos. Passar disso e o servico de audio travado, e devolver
    // erro e melhor do que segurar a transmissao indefinidamente.
    hr = WaitForSingleObject(done, 2000) == WAIT_OBJECT_0 ? handler->result() : HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  }
  CloseHandle(done);
  if (FAILED(hr)) return hr;
  ComPtr<IAudioClient> activated = handler->client();
  if (!activated) return E_NOINTERFACE;
  *client = activated.Detach();
  return S_OK;
}

HRESULT ProcessLoopbackCapture::Start(DWORD pid, bool includeTree) {
  Stop();
  pid_ = pid;
  IAudioClient* client = nullptr;
  HRESULT hr = Activate(pid, includeTree, &client);
  if (FAILED(hr)) return hr;

  WAVEFORMATEX format = FloatFormat();
  floatFormat_ = true;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          200000, 0, &format, nullptr);
  if (hr == AUDCLNT_E_UNSUPPORTED_FORMAT || hr == E_INVALIDARG) {
    // O dispositivo virtual de loopback aceita float em todo Windows que
    // suporta captura por processo. A reserva em 16 bits existe para nao
    // transformar uma recusa de formato em "sem audio nenhum". Um cliente ja
    // inicializado nao aceita outro formato, por isso a ativacao e refeita.
    client->Release();
    client = nullptr;
    hr = Activate(pid, includeTree, &client);
    if (FAILED(hr)) return hr;
    format = PcmFormat();
    floatFormat_ = false;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            200000, 0, &format, nullptr);
  }
  if (FAILED(hr)) {
    client->Release();
    return hr;
  }
  sourceChannels_ = format.nChannels;

  sampleReady_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  stop_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!sampleReady_ || !stop_) {
    client->Release();
    Stop();
    return E_FAIL;
  }
  hr = client->SetEventHandle(sampleReady_);
  if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture_));
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) {
    client->Release();
    Stop();
    return hr;
  }
  client_ = client;
  running_.store(true, std::memory_order_release);
  thread_ = std::thread([this] { CaptureLoop(); });
  return S_OK;
}

void ProcessLoopbackCapture::Stop() {
  if (stop_) SetEvent(stop_);
  running_.store(false, std::memory_order_release);
  if (thread_.joinable()) thread_.join();
  if (client_) {
    client_->Stop();
    client_->Release();
    client_ = nullptr;
  }
  if (capture_) {
    capture_->Release();
    capture_ = nullptr;
  }
  if (sampleReady_) {
    CloseHandle(sampleReady_);
    sampleReady_ = nullptr;
  }
  if (stop_) {
    CloseHandle(stop_);
    stop_ = nullptr;
  }
  std::lock_guard<std::mutex> guard(ringMutex_);
  readIndex_ = 0;
  writeIndex_ = 0;
  filled_ = 0;
}

void ProcessLoopbackCapture::CaptureLoop() {
  // A thread de captura precisa de prioridade de midia: sem isso um jogo em
  // tela cheia atrasa a leitura do anel do WASAPI e a live engasga.
  DWORD taskIndex = 0;
  const HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  HANDLE waits[2] = {stop_, sampleReady_};
  std::vector<float> scratch(static_cast<size_t>(kSampleRate) * kChannels / 10, 0.0f);
  while (true) {
    const DWORD signalled = WaitForMultipleObjects(2, waits, FALSE, 500);
    if (signalled == WAIT_OBJECT_0) break;
    if (!running_.load(std::memory_order_acquire)) break;
    if (signalled == WAIT_TIMEOUT) continue;
    while (true) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      const HRESULT hr = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
      if (FAILED(hr)) {
        running_.store(false, std::memory_order_release);
        break;
      }
      if (frames) {
        const size_t needed = static_cast<size_t>(frames) * kChannels;
        if (scratch.size() < needed) scratch.resize(needed);
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          std::fill_n(scratch.begin(), needed, 0.0f);
        } else if (floatFormat_) {
          const float* source = reinterpret_cast<const float*>(data);
          if (sourceChannels_ == kChannels) {
            std::copy_n(source, needed, scratch.begin());
          } else {
            for (UINT32 frame = 0; frame < frames; frame += 1) {
              const float sample = source[static_cast<size_t>(frame) * sourceChannels_];
              scratch[static_cast<size_t>(frame) * kChannels] = sample;
              scratch[static_cast<size_t>(frame) * kChannels + 1] = sample;
            }
          }
        } else {
          const int16_t* source = reinterpret_cast<const int16_t*>(data);
          for (UINT32 frame = 0; frame < frames; frame += 1) {
            for (uint16_t channel = 0; channel < kChannels; channel += 1) {
              const uint16_t sourceChannel = channel < sourceChannels_ ? channel : 0;
              scratch[static_cast<size_t>(frame) * kChannels + channel] =
                  static_cast<float>(source[static_cast<size_t>(frame) * sourceChannels_ + sourceChannel]) / 32768.0f;
            }
          }
        }
        Push(scratch.data(), frames);
      }
      capture_->ReleaseBuffer(frames);
    }
  }
  if (task) AvRevertMmThreadCharacteristics(task);
}

void ProcessLoopbackCapture::Push(const float* samples, uint32_t frames) {
  std::lock_guard<std::mutex> guard(ringMutex_);
  for (uint32_t frame = 0; frame < frames; frame += 1) {
    if (filled_ == kRingFrames) {
      // O anel encheu: descartar o quadro mais antigo mantem a latencia
      // limitada e e preferivel a deixar a memoria crescer sem teto.
      readIndex_ = (readIndex_ + 1) % kRingFrames;
      filled_ -= 1;
      overruns_ += 1;
    }
    const size_t base = static_cast<size_t>(writeIndex_) * kChannels;
    for (uint16_t channel = 0; channel < kChannels; channel += 1) {
      ring_[base + channel] = samples[static_cast<size_t>(frame) * kChannels + channel];
    }
    writeIndex_ = (writeIndex_ + 1) % kRingFrames;
    filled_ += 1;
  }
}

uint32_t ProcessLoopbackCapture::Mix(float* destination, uint32_t frames) {
  std::lock_guard<std::mutex> guard(ringMutex_);
  const uint32_t available = filled_ < frames ? filled_ : frames;
  for (uint32_t frame = 0; frame < available; frame += 1) {
    const size_t base = static_cast<size_t>(readIndex_) * kChannels;
    for (uint16_t channel = 0; channel < kChannels; channel += 1) {
      destination[static_cast<size_t>(frame) * kChannels + channel] += ring_[base + channel];
    }
    readIndex_ = (readIndex_ + 1) % kRingFrames;
  }
  filled_ -= available;
  // So conta como falta quem ja tinha entregue alguma coisa. Um processo em
  // silencio nao produz pacote nenhum, e chamar isso de underrun encheria o
  // diagnostico de ruido.
  if (available < frames && writeIndex_ != 0) underruns_ += 1;
  return available;
}

CaptureStats ProcessLoopbackCapture::stats() const {
  std::lock_guard<std::mutex> guard(ringMutex_);
  CaptureStats snapshot;
  snapshot.underruns = underruns_;
  snapshot.overruns = overruns_;
  return snapshot;
}

}  // namespace tumacord
