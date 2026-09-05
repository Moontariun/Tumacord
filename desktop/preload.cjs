const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tumacordDesktop', {
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
