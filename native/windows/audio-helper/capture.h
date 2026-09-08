// Uma captura WASAPI de loopback por processo.
//
// Cada instância representa uma árvore de processos. O áudio entra por uma
// thread de evento do WASAPI e sai por `Read`, chamado pelo misturador em um
// ritmo fixo. O anel entre as duas pontas tem tamanho fechado: uma live longa
// não pode crescer em memória porque o consumidor atrasou um pouco.
#pragma once

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "protocol.h"

namespace tumacord {

struct CaptureStats {
  uint64_t underruns = 0;
  uint64_t overruns = 0;
};

class ProcessLoopbackCapture {
 public:
  ProcessLoopbackCapture() = default;
  ~ProcessLoopbackCapture();

  ProcessLoopbackCapture(const ProcessLoopbackCapture&) = delete;
  ProcessLoopbackCapture& operator=(const ProcessLoopbackCapture&) = delete;

  // `includeTree` verdadeiro captura a árvore do processo; falso captura tudo
  // menos a árvore dele. O Tumacord só usa o modo de inclusão em produção — a
  // exclusão existe para a sondagem de disponibilidade.
  HRESULT Start(DWORD pid, bool includeTree);
  void Stop();

  DWORD pid() const { return pid_; }
  bool running() const { return running_.load(std::memory_order_acquire); }

  // Soma no destino as `frames` amostras estéreo disponíveis. Devolve quantos
  // quadros existiam de verdade; o que faltar é silêncio para o misturador.
  uint32_t Mix(float* destination, uint32_t frames);

  CaptureStats stats() const;

 private:
  void CaptureLoop();
  void Push(const float* samples, uint32_t frames);
  HRESULT Activate(DWORD pid, bool includeTree, IAudioClient** client);

  DWORD pid_ = 0;
  IAudioClient* client_ = nullptr;
  IAudioCaptureClient* capture_ = nullptr;
  HANDLE sampleReady_ = nullptr;
  HANDLE stop_ = nullptr;
  std::thread thread_;
  std::atomic<bool> running_{false};
  // 400 ms de anel. Passar disso significa que o consumidor parou, e nesse
  // caso guardar mais só aumentaria a latência quando ele voltar.
  static constexpr uint32_t kRingFrames = kSampleRate * 4 / 10;
  mutable std::mutex ringMutex_;
  std::vector<float> ring_ = std::vector<float>(static_cast<size_t>(kRingFrames) * kChannels, 0.0f);
  uint32_t readIndex_ = 0;
  uint32_t writeIndex_ = 0;
  uint32_t filled_ = 0;
  uint64_t underruns_ = 0;
  uint64_t overruns_ = 0;
  bool floatFormat_ = true;
  uint16_t sourceChannels_ = kChannels;
};

}  // namespace tumacord
