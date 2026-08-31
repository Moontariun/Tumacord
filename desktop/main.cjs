const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, session, Tray } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TumacordDiscovery } = require('./discovery.cjs');
const { ScreenAudioRouter } = require('./audio-router.cjs');

// Torna os fluxos de saída identificáveis no PipeWire. O roteador de live usa
// isso para manter a voz da call fora do áudio compartilhado.
process.env['PULSE_PROP_application.name'] = 'Tumacord';
process.env['PULSE_PROP_application.id'] = 'br.com.tumacord.app';
process.env['PULSE_PROP_media.role'] = 'phone';

// PipeWire é o caminho nativo de captura no Wayland. Expor os IPs de interface
// permite que o ICE enxergue o adaptador virtual do ZeroTier.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

const isDevelopment = Boolean(process.env.TUMACORD_WEB_URL);
let discovery;
let mainWindow;
let tray;
let pendingDesktopSource;
let mediaFullscreenActive = false;
let mediaFullscreenWasActive = false;
const screenAudioRouter = new ScreenAudioRouter();

function blockedCaptureSource(name) {
  return /\b(?:tumacord|discord)\b/i.test(name);
}

async function startEmbeddedServer() {
  if (process.env.TUMACORD_EXTERNAL_SERVER === '1') return;
  process.env.HOST = '0.0.0.0';
  process.env.PORT = process.env.PORT || '3927';
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'server-data');
  process.env.WEB_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked/dist-web')
    : path.join(__dirname, '../dist-web');
  const entry = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked/dist-server/server-bundle.cjs')
    : path.join(__dirname, '../dist-server/server-bundle.cjs');
  await import(pathToFileURL(entry).href);
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 620,
    minHeight: 480,
    backgroundColor: '#111219',
    icon: path.join(__dirname, '../assets/tumacord-logo.png'),
    title: 'Tumacord',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  mainWindow = window;
  window.on('enter-full-screen', () => window.webContents.send('tumacord:fullscreen-changed', true));
  window.on('leave-full-screen', () => {
    window.webContents.send('tumacord:fullscreen-changed', false);
    if (mediaFullscreenActive) {
      mediaFullscreenActive = false;
      window.webContents.send('tumacord:media-fullscreen-changed', false);
    }
  });

  const target = process.env.TUMACORD_WEB_URL || `file://${path.join(__dirname, '../dist-web/index.html')}`;
  await window.loadURL(target);
  if (isDevelopment) window.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, '../assets/tumacord-logo.png');
  const source = nativeImage.createFromPath(iconPath);
  // Um ícone pequeno evita que o mascote fique borrado na bandeja do KDE.
  const icon = source.isEmpty() ? source : source.resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('Tumacord');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Tumacord', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Sair do Tumacord', click: () => app.quit() },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

app.whenReady().then(async () => {
  await startEmbeddedServer();
  discovery = new TumacordDiscovery((calls) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tumacord:calls-changed', calls);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => ['media', 'display-capture'].includes(permission));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(['media', 'display-capture'].includes(permission)));

  ipcMain.handle('tumacord:desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true,
    });
    return sources.filter((source) => !blockedCaptureSource(source.name)).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('window:') ? 'window' : 'screen',
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL(),
    }));
  });
  ipcMain.on('tumacord:select-desktop-source', (event, details) => {
    event.returnValue = false;
    if (!details || typeof details.sourceId !== 'string') return;
    pendingDesktopSource = {
      sourceId: details.sourceId,
      includeAudio: Boolean(details.includeAudio),
      audioDeviceId: typeof details.audioDeviceId === 'string' ? details.audioDeviceId : '',
      audioDeviceName: typeof details.audioDeviceName === 'string' ? details.audioDeviceName : '',
    };
    event.returnValue = true;
  });
  ipcMain.handle('tumacord:prepare-screen-audio', () => screenAudioRouter.prepare());
  ipcMain.handle('tumacord:stop-screen-audio', () => screenAudioRouter.stop());
  ipcMain.handle('tumacord:discover-calls', () => discovery.list());
  ipcMain.handle('tumacord:set-hosting', (_event, details) => discovery.setHosting(details));
  ipcMain.handle('tumacord:toggle-fullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });
  ipcMain.handle('tumacord:is-fullscreen', () => Boolean(mainWindow?.isFullScreen()));
  ipcMain.handle('tumacord:begin-media-fullscreen', () => {
    if (!mainWindow) return false;
    if (!mediaFullscreenActive) {
      mediaFullscreenWasActive = mainWindow.isFullScreen();
      mediaFullscreenActive = true;
      if (!mediaFullscreenWasActive) mainWindow.setFullScreen(true);
      mainWindow.webContents.send('tumacord:media-fullscreen-changed', true);
    }
    return true;
  });
  ipcMain.handle('tumacord:end-media-fullscreen', () => {
    if (!mainWindow) return false;
    const restoreWindow = mediaFullscreenActive && !mediaFullscreenWasActive;
    mediaFullscreenActive = false;
    mainWindow.webContents.send('tumacord:media-fullscreen-changed', false);
    if (restoreWindow && mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    return false;
  });

  // getDisplayMedia é o caminho do Chromium que diferencia áudio da janela
  // de áudio geral do sistema. O renderer escolhe a fonte antes de chamar a
  // API; aqui só entregamos essa fonte ao pedido correspondente.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } })).filter((source) => !blockedCaptureSource(source.name));
      const requested = pendingDesktopSource;
      pendingDesktopSource = undefined;
      const source = sources.find((candidate) => candidate.id === requested?.sourceId) ?? sources[0];
      if (!source) return callback({});
      const result = { video: source };
      // Para uma janela, o Chromium/PipeWire tenta entregar apenas o áudio da
      // própria janela. Para uma tela inteira, o áudio disponível é o mix do
      // monitor/sistema — é exatamente o comportamento esperado pelo usuário
      // quando marca “Transmitir áudio da fonte”.
      if (request.audioRequested && requested?.includeAudio) {
        // Electron aceita {id,name} como escape hatch para o dispositivo de
        // áudio associado à fonte. No Windows, loopback é o caminho oficial;
        // no CachyOS o Chromium resolve o dispositivo via PipeWire.
        const routedAudio = requested.audioDeviceId
          ? { id: requested.audioDeviceId, name: requested.audioDeviceName || 'Tumacord Stream Audio' }
          : null;
        callback({ ...result, audio: process.platform === 'win32' ? 'loopbackWithMute' : routedAudio ?? { id: source.id, name: source.name } });
      } else {
        callback(result);
      }
    } catch {
      callback({});
    }
  });

  await createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  discovery?.close();
  void screenAudioRouter.stop();
});
