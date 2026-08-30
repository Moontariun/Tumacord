const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tumacordDesktop', {
  isDesktop: true,
  getSources: () => ipcRenderer.invoke('tumacord:desktop-sources'),
  selectDesktopSource: (sourceId, includeAudio, audioDevice) => {
    ipcRenderer.sendSync('tumacord:select-desktop-source', {
      sourceId,
      includeAudio,
      audioDeviceId: audioDevice?.deviceId,
      audioDeviceName: audioDevice?.deviceName,
    });
  },
  prepareScreenAudio: () => ipcRenderer.invoke('tumacord:prepare-screen-audio'),
  stopScreenAudio: () => ipcRenderer.invoke('tumacord:stop-screen-audio'),
  discoverCalls: () => ipcRenderer.invoke('tumacord:discover-calls'),
  onCallsChanged: (listener) => {
    const handler = (_event, calls) => listener(calls);
    ipcRenderer.on('tumacord:calls-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:calls-changed', handler);
  },
  setHosting: (details) => ipcRenderer.invoke('tumacord:set-hosting', details),
  toggleFullscreen: () => ipcRenderer.invoke('tumacord:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('tumacord:is-fullscreen'),
  onFullscreenChanged: (listener) => {
    const handler = (_event, fullscreen) => listener(Boolean(fullscreen));
    ipcRenderer.on('tumacord:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('tumacord:fullscreen-changed', handler);
  },
});
