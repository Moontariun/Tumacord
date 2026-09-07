const { contextBridge, ipcRenderer } = require('electron');

// A janela sobreposta não fala com o servidor, não tem sessão e não pede nada:
// ela só recebe traços já validados pelo processo principal e os pinta. Esta
// é a superfície inteira dela.
contextBridge.exposeInMainWorld('tumacordOverlay', {
  onStrokes: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('tumacord:overlay-strokes', handler);
    return () => ipcRenderer.removeListener('tumacord:overlay-strokes', handler);
  },
});
