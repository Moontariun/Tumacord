const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, session, Tray } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TumacordDiscovery } = require('./discovery.cjs');
const { ScreenAudioRouter } = require('./audio-router.cjs');
const { detectLinuxGpuVendors, streamingFeatures } = require('./gpu-policy.cjs');
const { appendRuntimeEvent, consumeSafeGpuMode, recordGpuFailure, safeRelaunchArgs } = require('./runtime-health.cjs');

// Torna os fluxos de saída identificáveis no PipeWire. O roteador de live usa
// isso para manter a voz da call fora do áudio compartilhado.
process.env['PULSE_PROP_application.name'] = 'Tumacord';
process.env['PULSE_PROP_application.id'] = 'br.com.tumacord.app';
process.env['PULSE_PROP_media.role'] = 'phone';

// PipeWire é o caminho nativo de captura no Wayland. Expor os IPs de interface
// permite que o ICE enxergue o adaptador virtual do ZeroTier.
const gpuVendors = detectLinuxGpuVendors();
const runtimeHealthFile = path.join(app.getPath('userData'), 'runtime-health.json');
const runtimeLogFile = path.join(app.getPath('userData'), 'logs', 'runtime-health.log');
const safeGpuMode = consumeSafeGpuMode(runtimeHealthFile);
if (safeGpuMode) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-features', streamingFeatures(process.platform, gpuVendors, safeGpuMode).join(','));
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

const isDevelopment = Boolean(process.env.TUMACORD_WEB_URL);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let discovery;
let mainWindow;
let tray;
let mediaFullscreenActive = false;
let mediaFullscreenWasActive = false;
const screenAudioRouter = new ScreenAudioRouter();
let quittingAfterAudioCleanup = false;
let safeGpuRelaunching = false;

if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('child-process-gone', (_event, details) => {
  appendRuntimeEvent(runtimeLogFile, {
    event: 'child-process-gone',
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
    safeGpuMode,
  });
  const health = recordGpuFailure(runtimeHealthFile, details);
  if (!health.shouldRelaunch || safeGpuMode || safeGpuRelaunching) return;
  safeGpuRelaunching = true;
  discovery?.close();
  // O Chromium normalmente recria um processo GPU isolado. Se ele cair duas
  // vezes em dez minutos, continuar insistindo no mesmo driver arrisca levar
  // o compositor Wayland junto. A próxima execução usa software apenas nessa
  // sessão; a abertura seguinte volta a testar aceleração normalmente.
  const cleanupDeadline = new Promise((resolve) => setTimeout(resolve, 4_000));
  void Promise.race([screenAudioRouter.stop(), cleanupDeadline]).finally(() => {
    app.relaunch({ args: safeRelaunchArgs() });
    app.exit(0);
  });
});

function blockedCaptureSource(name) {
  return /\b(?:tumacord|discord)\b/i.test(name);
}

async function startEmbeddedServer() {
  if (process.env.TUMACORD_EXTERNAL_SERVER === '1') return;
  process.env.HOST = '0.0.0.0';
  process.env.PORT = process.env.PORT || '3927';
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'server-data');
  // A instalação desktop carrega a interface direto do bundle local. O
  // servidor embutido existe somente para descoberta/sinalização P2P e não
  // publica mais uma cópia web na rede.
  process.env.TUMACORD_P2P_MODE = '1';
  process.env.TUMACORD_SERVE_WEB = '0';
  // Variáveis destinadas a um contêiner dedicado não podem acidentalmente
  // bloquear ou transformar o servidor pessoal iniciado junto do desktop.
  process.env.SERVER_ACCESS_KEY = '';
  process.env.TLS_CERT_FILE = '';
  process.env.TLS_KEY_FILE = '';
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
  window.webContents.on('render-process-gone', (_event, details) => {
    appendRuntimeEvent(runtimeLogFile, { event: 'render-process-gone', reason: details.reason, exitCode: details.exitCode, safeGpuMode });
  });
  window.webContents.on('unresponsive', () => appendRuntimeEvent(runtimeLogFile, { event: 'renderer-unresponsive', safeGpuMode }));
  window.webContents.on('responsive', () => appendRuntimeEvent(runtimeLogFile, { event: 'renderer-responsive', safeGpuMode }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('enter-full-screen', () => window.webContents.send('tumacord:fullscreen-changed', true));
  window.on('leave-full-screen', () => {
    window.webContents.send('tumacord:fullscreen-changed', false);
    if (mediaFullscreenActive) {
      mediaFullscreenActive = false;
      window.webContents.send('tumacord:media-fullscreen-changed', false);
    }
  });

  const target = process.env.TUMACORD_WEB_URL || `file://${path.join(__dirname, '../dist-web/index.html')}`;
  const trustedOrigin = new URL(target).origin;
  window.webContents.on('will-navigate', (event, destination) => {
    try {
      const destinationUrl = new URL(destination);
      const trusted = isDevelopment ? destinationUrl.origin === trustedOrigin : destination === target;
      if (!trusted) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  await window.loadURL(target);
  if (isDevelopment) window.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, '../assets/tumacord-tray.png');
  const source = nativeImage.createFromPath(iconPath);
  // A bandeja usa uma marca branca própria para permanecer legível nos temas
  // escuros do KDE; o menu de aplicativos continua usando a versão colorida.
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
  if (!hasSingleInstanceLock) return;
  // Remove módulos deixados por encerramento forçado ou atualização. Assim,
  // reiniciar apenas o aplicativo basta para recuperar o áudio da live.
  await screenAudioRouter.reset().catch(() => undefined);
  await startEmbeddedServer();
  discovery = new TumacordDiscovery((calls) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tumacord:calls-changed', calls);
  });
  const trustedMediaRequest = (webContents, permission) => webContents === mainWindow?.webContents && ['media', 'display-capture'].includes(permission);
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => trustedMediaRequest(webContents, permission));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(trustedMediaRequest(webContents, permission)));

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

  await createWindow();
  createTray();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (!hasSingleInstanceLock) return;
  if (quittingAfterAudioCleanup) return;
  quittingAfterAudioCleanup = true;
  discovery?.close();
  event.preventDefault();
  void screenAudioRouter.stop().finally(() => app.quit());
});
