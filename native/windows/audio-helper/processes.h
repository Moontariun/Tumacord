// Quem é dono de qual som.
//
// A janela que a pessoa escolheu no seletor do Tumacord é um HWND. O que a
// API de loopback por processo aceita é um PID, e aplicativos modernos —
// navegadores, jogos com anticheat, o próprio Discord — tocam áudio a partir
// de um processo auxiliar que não é o dono da janela. Por isso tudo aqui gira
// em torno da árvore: subir do processo até a raiz e descer capturando a
// árvore inteira é o que faz o som do jogo escolhido chegar completo.
#pragma once

#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>

namespace tumacord {

struct ProcessInfo {
  DWORD pid = 0;
  DWORD parent = 0;
  std::wstring executable;
};

// Retrato dos processos vivos. Barato: uma única varredura do toolhelp, sem
// abrir um handle por processo.
std::vector<ProcessInfo> SnapshotProcesses();

// A cadeia do processo até a raiz, do pai imediato para cima. Um vínculo em
// que o "pai" nasceu depois do filho é reciclagem de PID e é descartado.
std::vector<ProcessInfo> AncestorChain(const std::vector<ProcessInfo>& snapshot, DWORD pid);

DWORD ProcessIdForWindow(HWND window);

std::wstring ExecutableName(const std::vector<ProcessInfo>& snapshot, DWORD pid);

bool ProcessIsAlive(DWORD pid);

}  // namespace tumacord
