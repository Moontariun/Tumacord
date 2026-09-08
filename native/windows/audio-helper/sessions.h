// As sessões de áudio ativas do sistema.
//
// Para transmitir "a tela inteira com som" sem devolver a call, o helper
// precisa saber quem está tocando som agora. A lista vem das sessões do
// WASAPI — que já são por processo — e não de títulos de janela, que mudam,
// são traduzidos e não dizem nada sobre quem é dono do áudio.
#pragma once

#include <windows.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <string>
#include <vector>

namespace tumacord {

struct AudioSessionInfo {
  DWORD pid = 0;
  std::wstring executable;
  bool active = false;
  bool expired = false;
  bool systemSounds = false;
};

class SessionScanner {
 public:
  SessionScanner() = default;
  ~SessionScanner();

  SessionScanner(const SessionScanner&) = delete;
  SessionScanner& operator=(const SessionScanner&) = delete;

  HRESULT Initialize();
  void Shutdown();

  // Varre todos os pontos de saída ativos, não apenas o padrão: um jogo pode
  // estar tocando no fone enquanto o navegador toca na TV, e quem assiste
  // espera ouvir os dois.
  std::vector<AudioSessionInfo> Scan();

  // Verdadeiro uma única vez depois que o Windows avisou que uma sessão nasceu
  // ou que o dispositivo padrão mudou.
  bool ConsumeDirty();
  void MarkDirty() { dirty_.store(true, std::memory_order_release); }

 private:
  HRESULT RefreshEndpoints();

  struct Endpoint {
    Microsoft::WRL::ComPtr<IAudioSessionManager2> manager;
    Microsoft::WRL::ComPtr<IAudioSessionNotification> notification;
  };

  Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator_;
  std::vector<Endpoint> endpoints_;
  Microsoft::WRL::ComPtr<IMMNotificationClient> deviceNotifications_;
  std::atomic<bool> dirty_{true};
  bool endpointsStale_ = true;
};

}  // namespace tumacord
