#include "processes.h"

#include <tlhelp32.h>

#include <algorithm>
#include <unordered_map>

namespace tumacord {
namespace {

// `GetProcessTimes` exige um handle, e abrir um por processo em toda varredura
// custaria caro. Ele só é consultado quando um vínculo pai/filho precisa ser
// validado, o que acontece uma vez por sessão de áudio nova.
bool CreationTime(DWORD pid, uint64_t* out) {
  const HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!handle) return false;
  FILETIME creation{}, exit{}, kernel{}, user{};
  const BOOL ok = GetProcessTimes(handle, &creation, &exit, &kernel, &user);
  CloseHandle(handle);
  if (!ok) return false;
  ULARGE_INTEGER value{};
  value.LowPart = creation.dwLowDateTime;
  value.HighPart = creation.dwHighDateTime;
  *out = value.QuadPart;
  return true;
}

}  // namespace

std::vector<ProcessInfo> SnapshotProcesses() {
  std::vector<ProcessInfo> processes;
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return processes;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      ProcessInfo info;
      info.pid = entry.th32ProcessID;
      info.parent = entry.th32ParentProcessID;
      info.executable = entry.szExeFile;
      processes.push_back(std::move(info));
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return processes;
}

std::vector<ProcessInfo> AncestorChain(const std::vector<ProcessInfo>& snapshot, DWORD pid) {
  std::unordered_map<DWORD, const ProcessInfo*> byPid;
  byPid.reserve(snapshot.size());
  for (const ProcessInfo& info : snapshot) byPid.emplace(info.pid, &info);

  std::vector<ProcessInfo> chain;
  DWORD current = pid;
  uint64_t currentCreation = 0;
  const bool haveCurrentCreation = CreationTime(current, &currentCreation);
  // Uma árvore de processos não tem ciclo, mas PID reciclado pode criar um.
  // O teto protege contra um laço infinito num retrato inconsistente.
  for (int depth = 0; depth < 32; depth += 1) {
    const auto found = byPid.find(current);
    if (found == byPid.end()) break;
    const DWORD parent = found->second->parent;
    if (!parent || parent == current) break;
    const auto parentInfo = byPid.find(parent);
    if (parentInfo == byPid.end()) break;
    uint64_t parentCreation = 0;
    if (haveCurrentCreation && CreationTime(parent, &parentCreation) && parentCreation > currentCreation) {
      // O "pai" é mais novo que o filho: este PID foi reaproveitado pelo
      // sistema e a ligação não existe de verdade.
      break;
    }
    chain.push_back(*parentInfo->second);
    current = parent;
    currentCreation = parentCreation;
  }
  return chain;
}

DWORD ProcessIdForWindow(HWND window) {
  if (!window || !IsWindow(window)) return 0;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  return pid;
}

std::wstring ExecutableName(const std::vector<ProcessInfo>& snapshot, DWORD pid) {
  const auto found = std::find_if(snapshot.begin(), snapshot.end(), [pid](const ProcessInfo& info) { return info.pid == pid; });
  return found == snapshot.end() ? std::wstring() : found->executable;
}

bool ProcessIsAlive(DWORD pid) {
  const HANDLE handle = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!handle) {
    // Sem permissão para sincronizar não dá para afirmar que morreu; o
    // toolhelp continua enxergando o processo mesmo assim.
    const std::vector<ProcessInfo> snapshot = SnapshotProcesses();
    return std::any_of(snapshot.begin(), snapshot.end(), [pid](const ProcessInfo& info) { return info.pid == pid; });
  }
  const DWORD status = WaitForSingleObject(handle, 0);
  CloseHandle(handle);
  return status == WAIT_TIMEOUT;
}

}  // namespace tumacord
