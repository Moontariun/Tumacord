const { contextBridge, ipcRenderer } = require('electron');

// Uma `MessagePort` não atravessa a ponte de contexto: ela não é serializável.
// O caminho previsto pelo Electron é reenviá-la ao mundo principal por
// `window.postMessage`, onde ela continua sendo um objeto vivo com o mesmo
// isolamento de sempre.
const SCREEN_AUDIO_PORT = 'tumacord:screen-audio-port';
ipcRenderer.on(SCREEN_AUDIO_PORT, (event) => {
  const port = event.ports?.[0];
  if (port) window.postMessage(SCREEN_AUDIO_PORT, '*', [port]);
});

contextBridge.exposeInMainWorld('tumacordDesktop', {
  // A captura de áudio da live não tem um caminho só. No Linux é preciso
  // montar um barramento no PipeWire; no Windows a captura é por árvore de
  // processo e o PCM chega por uma porta dedicada. Quem decide é o renderer, e
  // para isso ele precisa saber onde está rodando.
  platform: process.platform,
  isDesktop: true,
  getSources: () => ipcRenderer.invoke('tumacord:desktop-sources'),
  // O identificador da fonte é o único parâmetro aceito, e o processo
  // principal só o aceita se ele tiver saído da lista que ele mesmo ofereceu.
  prepareScreenAudio: (request) => ipcRenderer.invoke('tumacord:prepare-screen-audio', {
    sourceId: typeof request?.sourceId === 'string' ? request.sourceId : '',
  }),
  stopScreenAudio: () => ipcRenderer.invoke('tumacord:stop-screen-audio'),
  // Pede uma porta nova para o PCM da transmissão. A anterior é fechada, o que
  // é o comportamento certo: duas portas vivas entregariam o áudio de duas
  // capturas ao mesmo destino.
  requestScreenAudioPort: () => ipcRenderer.invoke('tumacord:request-screen-audio-port'),
  screenAudioCapabilities: () => ipcRenderer.invoke('tumacord:screen-audio-capabilities'),
  screenAudioDiagnostics: () => ipcRenderer.invoke('tumacord:screen-audio-diagnostics'),
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
  // Estado real da janela, medido pelo processo principal. `document.hidden`
  // não serve aqui: o aplicativo desliga o estrangulamento de segundo plano de
  // propósito, e com isso uma janela minimizada continua se dizendo visível.
  onWindowActivity: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('tumacord:window-activity', handler);
    return () => ipcRenderer.removeListener('tumacord:window-activity', handler);
  },
  // Diagnóstico gráfico opcional. Nada é coletado enquanto ninguém pede.
  setGraphicsDiagnostics: (enabled) => ipcRenderer.invoke('tumacord:set-graphics-diagnostics', enabled !== false),
  graphicsReport: (media) => ipcRenderer.invoke('tumacord:graphics-report', media ?? null),
  graphicsCapability: () => ipcRenderer.invoke('tumacord:graphics-capability'),
  onGraphicsCapability: (listener) => {
    const handler = (_event, capability) => listener(capability);
    ipcRenderer.on('tumacord:graphics-capability', handler);
    return () => ipcRenderer.removeListener('tumacord:graphics-capability', handler);
  },
  // A janela parou de pintar estando em primeiro plano. Quem mede é o
  // renderer; quem decide o degrau da recuperação é o processo principal.
  reportPresentationFault: (details) => ipcRenderer.invoke('tumacord:presentation-fault', details ?? null),
  onReduceEffects: (listener) => {
    const handler = (_event, enabled) => listener(Boolean(enabled));
    ipcRenderer.on('tumacord:reduce-effects', handler);
    return () => ipcRenderer.removeListener('tumacord:reduce-effects', handler);
  },
  onMitigationArmed: (listener) => {
    const handler = (_event, details) => listener(details);
    ipcRenderer.on('tumacord:mitigation-armed', handler);
    return () => ipcRenderer.removeListener('tumacord:mitigation-armed', handler);
  },
  beginMediaFullscreen: () => ipcRenderer.invoke('tumacord:begin-media-fullscreen'),
  endMediaFullscreen: () => ipcRenderer.invoke('tumacord:end-media-fullscreen'),
  onMediaFullscreenChanged: (listener) => {
    const handler = (_event, fullscreen) => listener(Boolean(fullscreen));
    ipcRenderer.on('tumacord:media-fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:media-fullscreen-changed', handler);
  },
});
