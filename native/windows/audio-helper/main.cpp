// tumacord-audio-helper.exe
//
// Captura o áudio de aplicações específicas no Windows e devolve uma única
// mistura PCM ao Tumacord. Existe porque o loopback genérico do Chromium pega
// o dispositivo inteiro — inclusive o próprio Tumacord e o Discord —, e isso
// devolve a voz da call para dentro da transmissão.
//
// Ele não decide o que capturar. Quem escolhe é o processo principal, em
// JavaScript, onde a política pode ser testada; aqui só se executa a escolha.
// A única decisão tomada deste lado é uma recusa: o helper nunca captura a
// própria árvore do Tumacord, aconteça o que acontecer com a lista recebida.

#include <windows.h>

#include <avrt.h>
#include <timeapi.h>

#include <algorithm>
#include <cstdio>
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "capture.h"
#include "processes.h"
#include "protocol.h"
#include "sessions.h"

namespace tumacord {
namespace {

std::mutex g_capturesMutex;
std::vector<std::unique_ptr<ProcessLoopbackCapture>> g_captures;
std::atomic<bool> g_streaming{false};
std::atomic<bool> g_quit{false};
std::atomic<uint64_t> g_blocks{0};
DWORD g_selfPid = 0;
DWORD g_parentPid = 0;

DWORD WindowsBuild() {
  using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return 0;
  const auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!rtlGetVersion) return 0;
  RTL_OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  if (rtlGetVersion(&info) != 0) return 0;
  return info.dwBuildNumber;
}

DWORD ParentProcessId() {
  const std::vector<ProcessInfo> processes = SnapshotProcesses();
  const auto found = std::find_if(processes.begin(), processes.end(), [](const ProcessInfo& info) { return info.pid == g_selfPid; });
  return found == processes.end() ? 0 : found->parent;
}

// Última linha de defesa contra o eco. Se a lista recebida trouxesse a árvore
// do Tumacord por engano — um identificador reaproveitado, uma corrida entre
// varredura e escolha — o helper devolveria a call para dentro da live.
bool BelongsToTumacord(DWORD pid, const std::vector<ProcessInfo>& snapshot) {
  if (pid == g_selfPid || (g_parentPid && pid == g_parentPid)) return true;
  for (const ProcessInfo& ancestor : AncestorChain(snapshot, pid)) {
    if (ancestor.pid == g_selfPid || (g_parentPid && ancestor.pid == g_parentPid)) return true;
  }
  return false;
}

std::string AncestorsJson(const std::vector<ProcessInfo>& snapshot, DWORD pid) {
  std::string json = "[";
  bool first = true;
  for (const ProcessInfo& ancestor : AncestorChain(snapshot, pid)) {
    if (!first) json += ",";
    first = false;
    json += "{\"pid\":" + std::to_string(ancestor.pid) + ",\"exe\":\"" + JsonEscape(ancestor.executable) + "\"}";
  }
  return json + "]";
}

std::string SessionsJson(const std::vector<AudioSessionInfo>& sessions, const std::vector<ProcessInfo>& snapshot) {
  std::string json = "{\"event\":\"sessions\",\"items\":[";
  bool first = true;
  for (const AudioSessionInfo& session : sessions) {
    if (!first) json += ",";
    first = false;
    json += "{\"pid\":" + std::to_string(session.pid);
    json += ",\"exe\":\"" + JsonEscape(session.executable) + "\"";
    json += ",\"active\":" + std::string(session.active ? "true" : "false");
    json += ",\"expired\":" + std::string(session.expired ? "true" : "false");
    json += ",\"system\":" + std::string(session.systemSounds ? "true" : "false");
    json += ",\"ancestors\":" + AncestorsJson(snapshot, session.pid);
    json += "}";
  }
  return json + "]}";
}

std::string SessionSignature(const std::vector<AudioSessionInfo>& sessions) {
  std::vector<std::string> parts;
  parts.reserve(sessions.size());
  for (const AudioSessionInfo& session : sessions) {
    parts.push_back(std::to_string(session.pid) + (session.active ? "+" : (session.expired ? "x" : "-")));
  }
  std::sort(parts.begin(), parts.end());
  std::string signature;
  for (const std::string& part : parts) signature += part + ";";
  return signature;
}

std::vector<DWORD> ParsePidList(const std::string& text) {
  std::vector<DWORD> pids;
  DWORD current = 0;
  bool digits = false;
  for (const char character : text) {
    if (character >= '0' && character <= '9') {
      current = current * 10 + static_cast<DWORD>(character - '0');
      digits = true;
      continue;
    }
    if (digits) pids.push_back(current);
    current = 0;
    digits = false;
  }
  if (digits) pids.push_back(current);
  return pids;
}

void ApplyCaptureSet(const std::vector<DWORD>& requested) {
  const std::vector<ProcessInfo> snapshot = SnapshotProcesses();
  std::unordered_set<DWORD> wanted;
  for (const DWORD pid : requested) {
    if (!pid || BelongsToTumacord(pid, snapshot)) continue;
    wanted.insert(pid);
  }

  // Fecha primeiro o que saiu da lista, para que o WASAPI não fique com duas
  // capturas da mesma árvore durante a troca.
  std::vector<std::unique_ptr<ProcessLoopbackCapture>> retired;
  std::vector<DWORD> alive;
  {
    std::lock_guard<std::mutex> guard(g_capturesMutex);
    auto boundary = std::stable_partition(g_captures.begin(), g_captures.end(), [&wanted](const std::unique_ptr<ProcessLoopbackCapture>& capture) {
      return wanted.count(capture->pid()) != 0;
    });
    for (auto entry = boundary; entry != g_captures.end(); ++entry) retired.push_back(std::move(*entry));
    g_captures.erase(boundary, g_captures.end());
    for (const auto& capture : g_captures) alive.push_back(capture->pid());
  }
  // Parar junta a thread de captura; fora do cadeado para não travar a mistura.
  retired.clear();

  std::string failures;
  std::vector<std::unique_ptr<ProcessLoopbackCapture>> created;
  for (const DWORD pid : wanted) {
    if (std::find(alive.begin(), alive.end(), pid) != alive.end()) continue;
    auto capture = std::make_unique<ProcessLoopbackCapture>();
    const HRESULT hr = capture->Start(pid, true);
    if (FAILED(hr)) {
      char buffer[64];
      sprintf_s(buffer, sizeof(buffer), "{\"pid\":%lu,\"hr\":\"0x%08lx\"}", pid, static_cast<unsigned long>(hr));
      if (!failures.empty()) failures += ",";
      failures += buffer;
      continue;
    }
    created.push_back(std::move(capture));
  }
  {
    std::lock_guard<std::mutex> guard(g_capturesMutex);
    for (auto& capture : created) g_captures.push_back(std::move(capture));
    alive.clear();
    for (const auto& capture : g_captures) alive.push_back(capture->pid());
  }

  std::string json = "{\"event\":\"capturing\",\"pids\":[";
  for (size_t index = 0; index < alive.size(); index += 1) {
    if (index) json += ",";
    json += std::to_string(alive[index]);
  }
  json += "],\"failed\":[" + failures + "]}";
  WriteEvent(json);
}

void ReleaseAllCaptures() {
  std::vector<std::unique_ptr<ProcessLoopbackCapture>> retired;
  {
    std::lock_guard<std::mutex> guard(g_capturesMutex);
    retired.swap(g_captures);
  }
  retired.clear();
}

void MixerThread() {
  std::vector<float> block(static_cast<size_t>(kFramesPerBlock) * kChannels, 0.0f);
  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  bool coarse = false;
  if (!timer) {
    // Antes do Windows 10 1803 não existe temporizador de alta resolução. O
    // período de 1 ms deixa o comum próximo o bastante, e o amortecedor do
    // AudioWorklet cobre o resto.
    timer = CreateWaitableTimerW(nullptr, FALSE, nullptr);
    coarse = true;
    timeBeginPeriod(1);
  }
  LARGE_INTEGER due{};
  due.QuadPart = -100000;  // 10 ms em unidades de 100 ns.
  SetWaitableTimer(timer, &due, 10, nullptr, nullptr, FALSE);
  DWORD taskIndex = 0;
  const HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  while (!g_quit.load(std::memory_order_acquire)) {
    if (WaitForSingleObject(timer, 200) != WAIT_OBJECT_0) continue;
    if (!g_streaming.load(std::memory_order_acquire)) continue;
    std::fill(block.begin(), block.end(), 0.0f);
    {
      std::lock_guard<std::mutex> guard(g_capturesMutex);
      for (const auto& capture : g_captures) capture->Mix(block.data(), kFramesPerBlock);
    }
    // A soma sai em float sem limitador: float32 comporta a soma de dezenas de
    // fontes sem estourar, e o corte suave acontece uma única vez, no
    // AudioWorklet, onde pode ser testado.
    WriteFrame(kFrameTypePcm, block.data(), static_cast<uint32_t>(block.size() * sizeof(float)));
    g_blocks.fetch_add(1, std::memory_order_relaxed);
  }
  if (task) AvRevertMmThreadCharacteristics(task);
  CancelWaitableTimer(timer);
  CloseHandle(timer);
  if (coarse) timeEndPeriod(1);
}

void StdinThread(std::deque<std::string>* queue, std::mutex* queueMutex) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  std::string pending;
  char buffer[512];
  while (!g_quit.load(std::memory_order_acquire)) {
    DWORD read = 0;
    if (!ReadFile(input, buffer, sizeof(buffer), &read, nullptr) || read == 0) break;
    pending.append(buffer, read);
    size_t newline;
    while ((newline = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, newline);
      pending.erase(0, newline + 1);
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
      if (line.empty()) continue;
      std::lock_guard<std::mutex> guard(*queueMutex);
      queue->push_back(std::move(line));
    }
  }
  // stdin fechado significa que o Tumacord saiu. Continuar vivo deixaria um
  // processo órfão segurando uma captura de áudio.
  g_quit.store(true, std::memory_order_release);
}

bool ProbeProcessLoopback() {
  ProcessLoopbackCapture probe;
  // Inclusão sobre o próprio processo: prova que a ativação funciona sem
  // tocar no áudio de ninguém.
  const HRESULT hr = probe.Start(GetCurrentProcessId(), true);
  probe.Stop();
  return SUCCEEDED(hr);
}

int Run() {
  g_selfPid = GetCurrentProcessId();
  g_parentPid = ParentProcessId();
  const DWORD build = WindowsBuild();
  const bool processLoopback = ProbeProcessLoopback();
  WriteEvent("{\"event\":\"ready\",\"protocol\":1,\"processLoopback\":" + std::string(processLoopback ? "true" : "false") +
             ",\"build\":" + std::to_string(build) + ",\"pid\":" + std::to_string(g_selfPid) + "}");

  SessionScanner scanner;
  const bool scannerReady = SUCCEEDED(scanner.Initialize());
  if (!scannerReady) WriteEvent("{\"event\":\"error\",\"code\":\"session-scanner\",\"message\":\"nao foi possivel enumerar as sessoes de audio\"}");

  std::deque<std::string> queue;
  std::mutex queueMutex;
  std::thread reader(StdinThread, &queue, &queueMutex);
  std::thread mixer(MixerThread);

  std::string signature;
  bool monitoring = false;
  ULONGLONG lastScan = 0;
  ULONGLONG lastStats = GetTickCount64();
  while (!g_quit.load(std::memory_order_acquire)) {
    std::vector<std::string> commands;
    {
      std::lock_guard<std::mutex> guard(queueMutex);
      while (!queue.empty()) {
        commands.push_back(std::move(queue.front()));
        queue.pop_front();
      }
    }
    for (const std::string& command : commands) {
      if (command == "QUIT") {
        g_quit.store(true, std::memory_order_release);
      } else if (command == "STOP") {
        g_streaming.store(false, std::memory_order_release);
        monitoring = false;
        ReleaseAllCaptures();
        signature.clear();
        WriteEvent("{\"event\":\"stopped\"}");
      } else if (command == "SCAN") {
        scanner.MarkDirty();
        monitoring = true;
      } else if (command == "MONITOR OFF") {
        monitoring = false;
      } else if (command.rfind("WINDOW ", 0) == 0) {
        const std::vector<DWORD> parsed = ParsePidList(command.substr(7));
        const HWND window = parsed.empty() ? nullptr : reinterpret_cast<HWND>(static_cast<ULONG_PTR>(parsed[0]));
        const DWORD pid = ProcessIdForWindow(window);
        const std::vector<ProcessInfo> snapshot = SnapshotProcesses();
        std::string json = "{\"event\":\"window\",\"hwnd\":" + std::to_string(parsed.empty() ? 0 : parsed[0]);
        json += ",\"pid\":" + std::to_string(pid);
        json += ",\"exe\":\"" + JsonEscape(ExecutableName(snapshot, pid)) + "\"";
        json += ",\"ancestors\":" + AncestorsJson(snapshot, pid) + "}";
        WriteEvent(json);
      } else if (command.rfind("CAPTURE", 0) == 0) {
        g_streaming.store(true, std::memory_order_release);
        ApplyCaptureSet(ParsePidList(command.size() > 7 ? command.substr(7) : std::string()));
      } else {
        WriteEvent("{\"event\":\"error\",\"code\":\"unknown-command\",\"message\":\"comando desconhecido\"}");
      }
    }

    const ULONGLONG now = GetTickCount64();
    // A varredura acontece quando o Windows avisa que algo mudou. A rede de
    // 3 s existe só para o caso de um aviso perdido; ela não é o mecanismo.
    if (scannerReady && monitoring && (scanner.ConsumeDirty() || now - lastScan > 3000)) {
      lastScan = now;
      const std::vector<AudioSessionInfo> sessions = scanner.Scan();
      const std::string next = SessionSignature(sessions);
      if (next != signature) {
        signature = next;
        WriteEvent(SessionsJson(sessions, SnapshotProcesses()));
      }
    }

    std::vector<DWORD> gone;
    {
      std::lock_guard<std::mutex> guard(g_capturesMutex);
      for (const auto& capture : g_captures) {
        if (!ProcessIsAlive(capture->pid())) gone.push_back(capture->pid());
      }
    }
    for (const DWORD pid : gone) {
      std::vector<std::unique_ptr<ProcessLoopbackCapture>> retired;
      {
        std::lock_guard<std::mutex> guard(g_capturesMutex);
        auto boundary = std::stable_partition(g_captures.begin(), g_captures.end(), [pid](const std::unique_ptr<ProcessLoopbackCapture>& capture) {
          return capture->pid() != pid;
        });
        for (auto entry = boundary; entry != g_captures.end(); ++entry) retired.push_back(std::move(*entry));
        g_captures.erase(boundary, g_captures.end());
      }
      retired.clear();
      WriteEvent("{\"event\":\"source-gone\",\"pid\":" + std::to_string(pid) + "}");
    }

    if (now - lastStats > 5000) {
      lastStats = now;
      uint64_t underruns = 0;
      uint64_t overruns = 0;
      size_t sources = 0;
      {
        std::lock_guard<std::mutex> guard(g_capturesMutex);
        sources = g_captures.size();
        for (const auto& capture : g_captures) {
          const CaptureStats stats = capture->stats();
          underruns += stats.underruns;
          overruns += stats.overruns;
        }
      }
      WriteEvent("{\"event\":\"stats\",\"sources\":" + std::to_string(sources) +
                 ",\"underruns\":" + std::to_string(underruns) +
                 ",\"overruns\":" + std::to_string(overruns) +
                 ",\"blocks\":" + std::to_string(g_blocks.load(std::memory_order_relaxed)) + "}");
    }
    Sleep(50);
  }

  g_streaming.store(false, std::memory_order_release);
  if (mixer.joinable()) mixer.join();
  ReleaseAllCaptures();
  scanner.Shutdown();
  // A thread de stdin fica presa em ReadFile até o descritor fechar. Cancelar
  // a operação é o que permite sair sem esperar por uma leitura que nunca vem.
  CancelIoEx(GetStdHandle(STD_INPUT_HANDLE), nullptr);
  if (reader.joinable()) reader.join();
  return 0;
}

}  // namespace
}  // namespace tumacord

int wmain(int argc, wchar_t** argv) {
  const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return 1;
  int result = 0;
  if (argc > 1 && std::wstring(argv[1]) == L"--probe") {
    const DWORD build = tumacord::WindowsBuild();
    const bool available = tumacord::ProbeProcessLoopback();
    tumacord::WriteEvent("{\"event\":\"probe\",\"protocol\":1,\"processLoopback\":" + std::string(available ? "true" : "false") +
                         ",\"build\":" + std::to_string(build) + "}");
  } else {
    result = tumacord::Run();
  }
  CoUninitialize();
  return result;
}
