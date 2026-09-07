const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tumacordDesktop', {
  // A captura de áudio da live não tem um caminho só. No Linux é preciso
  // montar um barramento no PipeWire; no Windows o próprio Chromium entrega o
  // loopback do sistema junto com o vídeo. Quem decide é o renderer, e para
  // isso ele precisa saber onde está rodando.
  platform: process.platform,
  isDesktop: true,
  getSources: () => ipcRenderer.invoke('tumacord:desktop-sources'),
  prepareScreenAudio: () => ipcRenderer.invoke('tumacord:prepare-screen-audio'),
  stopScreenAudio: () => ipcRenderer.invoke('tumacord:stop-screen-audio'),
  discoverCalls: () => ipcRenderer.invoke('tumacord:discover-calls'),
  onCallsChanged: (listener) => {
    const handler = (_event, calls) => listener(calls);
    ipcRenderer.on('tumacord:calls-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:calls-changed', handler);
  },
  setHosting: (details) => ipcRenderer.invoke('tumacord:set-hosting', details),
  // Pinta o traço por cima do desktop de verdade enquanto o monitor inteiro
  // está sendo transmitido. Sem traço nenhum, fecha a janela.
  drawOverlay: (payload) => ipcRenderer.invoke('tumacord:draw-overlay', payload),
  getNetworkPreferences: () => ipcRenderer.invoke('tumacord:network-preferences'),
  setNetworkPreferences: (patch) => ipcRenderer.invoke('tumacord:set-network-preferences', patch),
  onNetworkPreferencesChanged: (listener) => {
    const handler = (_event, preferences) => listener(preferences);
    ipcRenderer.on('tumacord:network-preferences-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:network-preferences-changed', handler);
  },
  directReport: (options) => ipcRenderer.invoke('tumacord:direct-report', options),
  toggleFullscreen: () => ipcRenderer.invoke('tumacord:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('tumacord:is-fullscreen'),
  onFullscreenChanged: (listener) => {
    const handler = (_event, fullscreen) => listener(Boolean(fullscreen));
    ipcRenderer.on('tumacord:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:fullscreen-changed', handler);
  },
  beginMediaFullscreen: () => ipcRenderer.invoke('tumacord:begin-media-fullscreen'),
  endMediaFullscreen: () => ipcRenderer.invoke('tumacord:end-media-fullscreen'),
  onMediaFullscreenChanged: (listener) => {
    const handler = (_event, fullscreen) => listener(Boolean(fullscreen));
    ipcRenderer.on('tumacord:media-fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:media-fullscreen-changed', handler);
  },
});
