#include "sessions.h"

#include <wrl/implements.h>

#include <algorithm>

#include "processes.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace tumacord {
namespace {

// O Windows avisa quando uma sessao nasce e quando o dispositivo padrao muda.
// Reagir ao aviso e o que permite um jogo aberto no meio da live entrar no som
// compartilhado sem varrer a lista varias vezes por segundo.
class SessionArrival : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FtmBase, IAudioSessionNotification> {
 public:
  explicit SessionArrival(SessionScanner* scanner) : scanner_(scanner) {}

  STDMETHODIMP OnSessionCreated(IAudioSessionControl*) override {
    scanner_->MarkDirty();
    return S_OK;
  }

 private:
  SessionScanner* scanner_;
};

class DeviceArrival : public RuntimeClass<RuntimeClassFlags<Microsoft::WRL::ClassicCom>, FtmBase, IMMNotificationClient> {
 public:
  explicit DeviceArrival(SessionScanner* scanner) : scanner_(scanner) {}

  STDMETHODIMP OnDeviceStateChanged(LPCWSTR, DWORD) override { return Touch(); }
  STDMETHODIMP OnDeviceAdded(LPCWSTR) override { return Touch(); }
  STDMETHODIMP OnDeviceRemoved(LPCWSTR) override { return Touch(); }
  STDMETHODIMP OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { return Touch(); }
  STDMETHODIMP OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  HRESULT Touch() {
    scanner_->MarkDirty();
    return S_OK;
  }

  SessionScanner* scanner_;
};

}  // namespace

SessionScanner::~SessionScanner() {
  Shutdown();
}

HRESULT SessionScanner::Initialize() {
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator_));
  if (FAILED(hr)) return hr;
  auto notifications = Microsoft::WRL::Make<DeviceArrival>(this);
  if (notifications) {
    deviceNotifications_ = notifications;
    enumerator_->RegisterEndpointNotificationCallback(deviceNotifications_.Get());
  }
  endpointsStale_ = true;
  return S_OK;
}

void SessionScanner::Shutdown() {
  for (Endpoint& endpoint : endpoints_) {
    if (endpoint.manager && endpoint.notification) endpoint.manager->UnregisterSessionNotification(endpoint.notification.Get());
  }
  endpoints_.clear();
  if (enumerator_ && deviceNotifications_) enumerator_->UnregisterEndpointNotificationCallback(deviceNotifications_.Get());
  deviceNotifications_.Reset();
  enumerator_.Reset();
}

HRESULT SessionScanner::RefreshEndpoints() {
  for (Endpoint& endpoint : endpoints_) {
    if (endpoint.manager && endpoint.notification) endpoint.manager->UnregisterSessionNotification(endpoint.notification.Get());
  }
  endpoints_.clear();
  if (!enumerator_) return E_FAIL;
  ComPtr<IMMDeviceCollection> devices;
  HRESULT hr = enumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices);
  if (FAILED(hr)) return hr;
  UINT count = 0;
  hr = devices->GetCount(&count);
  if (FAILED(hr)) return hr;
  for (UINT index = 0; index < count; index += 1) {
    ComPtr<IMMDevice> device;
    if (FAILED(devices->Item(index, &device))) continue;
    Endpoint endpoint;
    if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &endpoint.manager))) continue;
    // A enumeracao precisa acontecer uma vez antes de a notificacao passar a
    // valer: sem ela o gerenciador de sessoes nem chega a ser construido, e o
    // aviso de sessao nova nunca chega.
    ComPtr<IAudioSessionEnumerator> sessions;
    endpoint.manager->GetSessionEnumerator(&sessions);
    auto arrival = Microsoft::WRL::Make<SessionArrival>(this);
    if (arrival && SUCCEEDED(endpoint.manager->RegisterSessionNotification(arrival.Get()))) endpoint.notification = arrival;
    endpoints_.push_back(std::move(endpoint));
  }
  endpointsStale_ = false;
  return endpoints_.empty() ? E_FAIL : S_OK;
}

std::vector<AudioSessionInfo> SessionScanner::Scan() {
  std::vector<AudioSessionInfo> found;
  if (endpointsStale_ || endpoints_.empty()) RefreshEndpoints();
  const std::vector<ProcessInfo> processes = SnapshotProcesses();
  for (Endpoint& endpoint : endpoints_) {
    ComPtr<IAudioSessionEnumerator> sessions;
    if (FAILED(endpoint.manager->GetSessionEnumerator(&sessions))) {
      // Um ponto de saida que sumiu invalida o gerenciador inteiro; a proxima
      // varredura reconstroi a lista a partir dos dispositivos atuais.
      endpointsStale_ = true;
      continue;
    }
    int count = 0;
    if (FAILED(sessions->GetCount(&count))) continue;
    for (int index = 0; index < count; index += 1) {
      ComPtr<IAudioSessionControl> control;
      if (FAILED(sessions->GetSession(index, &control))) continue;
      ComPtr<IAudioSessionControl2> control2;
      if (FAILED(control.As(&control2))) continue;
      DWORD pid = 0;
      if (FAILED(control2->GetProcessId(&pid)) || !pid) continue;
      AudioSessionState state = AudioSessionStateInactive;
      control->GetState(&state);
      AudioSessionInfo info;
      info.pid = pid;
      info.executable = ExecutableName(processes, pid);
      info.active = state == AudioSessionStateActive;
      info.expired = state == AudioSessionStateExpired;
      info.systemSounds = control2->IsSystemSoundsSession() == S_OK;
      const auto duplicate = std::find_if(found.begin(), found.end(), [pid](const AudioSessionInfo& other) { return other.pid == pid; });
      if (duplicate == found.end()) {
        found.push_back(std::move(info));
      } else if (info.active) {
        // O mesmo processo pode ter uma sessao por ponto de saida. Uma delas
        // tocando ja torna o processo interessante para a transmissao.
        duplicate->active = true;
        duplicate->expired = false;
      }
    }
  }
  return found;
}

bool SessionScanner::ConsumeDirty() {
  return dirty_.exchange(false, std::memory_order_acq_rel);
}

}  // namespace tumacord
