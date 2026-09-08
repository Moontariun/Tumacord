const { app, BrowserWindow, desktopCapturer, ipcMain, Menu, MessageChannelMain, nativeImage, session, Tray } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TumacordDiscovery } = require('./discovery.cjs');
const { DirectLink } = require('./direct-link.cjs');
const { readNetworkPreferences, writeNetworkPreferences } = require('./network-preferences.cjs');
const { createScreenAudioRouter } = require('./screen-audio.cjs');
const { detectLinuxGpuVendors, encodeCapability, decodeCapability, ozoneSwitches, streamingFeatures } = require('./gpu-policy.cjs');
const { appendRuntimeEvent, consumeMitigation, consumeSafeGpuMode, recordGpuFailure, recordHealthyRun, recordPresentationFault, safeRelaunchArgs } = require('./runtime-health.cjs');
const { GraphicsReporter, readAccelerationSummary } = require('./graphics-report.cjs');
const { WindowActivity } = require('./window-activity.cjs');
const { DrawingOverlay } = require('./drawing-overlay.cjs');

// Torna os fluxos de saída identificáveis no PipeWire. O roteador de live usa
// isso para manter a voz da call fora do áudio compartilhado.
process.env['PULSE_PROP_application.name'] = 'Tumacord';
process.env['PULSE_PROP_application.id'] = 'br.com.tumacord.app';
process.env['PULSE_PROP_media.role'] = 'phone';

// PipeWire é o caminho nativo de captura no Wayland. Expor os IPs de interface
// é o que permite ao ICE oferecer o IPv6 global e o endereço da rede local —
// e, quando o ZeroTier está ligado nas configurações, também o adaptador dele.
const gpuVendors = detectLinuxGpuVendors();
const runtimeHealthFile = path.join(app.getPath('userData'), 'runtime-health.json');
const runtimeLogFile = path.join(app.getPath('userData'), 'logs', 'runtime-health.log');
const safeGpuMode = consumeSafeGpuMode(runtimeHealthFile);
// Qual degrau da escada de recuperação vale nesta execução. Ele não muda
// driver, compositor nem configuração de jogo nenhum: o alcance é o processo
// do Tumacord, e só.
const mitigation = safeGpuMode ? 'safe-gpu' : consumeMitigation(runtimeHealthFile);
if (safeGpuMode) app.disableHardwareAcceleration();
const enabledFeatures = streamingFeatures(process.platform, gpuVendors, safeGpuMode);
if (enabledFeatures.length) app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));
// Esta vale em todo sistema: sem ela o Chromium esconde os endereços locais
// atrás de nomes mDNS e o ICE perde o candidato da própria rede.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Ozone é a camada de janelas do Chromium no Linux. No Windows não existe.
// O degrau `xwayland` troca o hint automático por X11 explícito — é uma
// COMPARAÇÃO de backend, não uma correção: serve para separar um defeito do
// caminho Wayland/GBM de um defeito do driver, e a captura pelo portal
// continua sendo verificada nos dois.
for (const [name, value] of ozoneSwitches(process.platform, mitigation)) app.commandLine.appendSwitch(name, value);
// Degrau medido, não chute. Com encoder de vídeo por SOFTWARE e composição por
// GPU ligada, cada quadro precisa voltar da GPU para a memória do sistema antes
// de ser codificado — e nesta máquina isso mediu ~43 ms por quadro contra
// ~1,5 ms com a composição fora da GPU, no mesmo codec e na mesma resolução.
// O alcance é o processo do Tumacord: nenhum outro programa é afetado.
if (mitigation === 'software-composite') app.commandLine.appendSwitch('disable-gpu-compositing');
// Sem estes, o Chromium trata a janela coberta pela live flutuante como
// oculta e reduz o ritmo de composição: a imagem escurece e engasga
// exatamente quando a janela solta ganha foco.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const isDevelopment = Boolean(process.env.TUMACORD_WEB_URL);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const networkPreferencesFile = path.join(app.getPath('userData'), 'network-preferences.json');
let networkPreferences = readNetworkPreferences(networkPreferencesFile);
// O enlace direto nasce junto do processo: a chave precisa existir antes de o
// servidor embutido subir, e a sondagem de alcance precisa estar pronta antes
// de alguém pedir um convite.
const directLink = new DirectLink({ key: networkPreferences.directKey, preferences: networkPreferences });
let discovery;
let mainWindow;
let tray;
let mediaFullscreenActive = false;
let mediaFullscreenWasActive = false;
// O PCM da transmissão viaja por um canal próprio, não pelo IPC comum: são
// cem mensagens por segundo durante a live inteira, e o caminho de `invoke`
// serializa cada uma junto com o resto do tráfego da interface.
let screenAudioChannel = null;
const screenAudioRouter = createScreenAudioRouter({
  onPcm: (payload) => {
    const port = screenAudioChannel?.port1;
    if (!port) return;
    // O quadro é uma fatia do buffer de leitura do processo filho; ele será
    // reaproveitado na próxima leitura. A cópia é de 3840 bytes.
    const block = new Uint8Array(payload.byteLength);
    block.set(payload);
    try { port.postMessage(block); } catch { /* o renderer fechou a porta */ }
  },
  onDiagnostic: (details) => appendRuntimeEvent(runtimeLogFile, details),
});
const drawingOverlay = new DrawingOverlay();
// O renderer só pode pedir captura de uma fonte que o próprio Tumacord
// ofereceu. Sem esta lista, um renderer comprometido poderia mandar um
// identificador arbitrário e pedir o áudio de qualquer processo da máquina.
let offeredSources = new Map();
// A fonte de uma transmissão em andamento continua válida mesmo depois de uma
// nova listagem: a verificação periódica de saúde e a reconstrução do
// componente usam o mesmo identificador, e recusá-lo deixaria a live sem
// caminho de volta se o helper caísse.
let activeScreenAudioSource = '';
let quittingAfterAudioCleanup = false;
let safeGpuRelaunching = false;
const liveWindows = new Set();
const graphicsReporter = new GraphicsReporter({
  app,
  readWindows: () => [mainWindow, ...liveWindows].filter((window) => window && !window.isDestroyed()),
  safeGpuMode,
  enabledFeatures,
  gpuVendors,
});
// O estado real de cada janela, medido pelo processo principal e mandado ao
// renderer. Com `backgroundThrottling: false` o renderer não consegue saber
// disso sozinho: `document.hidden` continua falso com a janela minimizada.
const windowActivity = new WindowActivity({
  readDetached: () => [...liveWindows],
  send: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tumacord:window-activity', state);
  },
});
// Uma abertura que passa quinze minutos sem falha de apresentação conta como
// saudável e devolve, aos poucos, os degraus da escada de recuperação.
let healthyRunTimer = setTimeout(() => {
  const relaxed = recordHealthyRun(runtimeHealthFile);
  if (relaxed.relaxed) appendRuntimeEvent(runtimeLogFile, { event: 'mitigation-relaxed', mitigation: relaxed.mitigation });
}, 15 * 60_000);
if (typeof healthyRunTimer.unref === 'function') healthyRunTimer.unref();
let presentationRelaunching = false;

// `getGPUFeatureStatus` só vale depois deste evento. Antes dele, o Chromium
// ainda responde com o que supôs — foi por isso que "provavelmente usa NVENC"
// e "provavelmente é software" tinham o mesmo peso na 0.8.8.
app.on('gpu-info-update', () => {
  graphicsReporter.observeGpuInfoUpdate();
  void graphicsReporter.collectGpuInfo().then(() => {
    const status = graphicsReporter.featureStatus;
    const aceleracao = readAccelerationSummary(status);
    appendRuntimeEvent(runtimeLogFile, {
      event: 'gpu-feature-status',
      mitigation,
      composicao: aceleracao.compositing,
      encodeVideo: aceleracao.videoEncode,
      decodeVideo: aceleracao.videoDecode,
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tumacord:graphics-capability', {
        ...encodeCapability(status),
        ...decodeCapability(status),
        compositing: aceleracao.compositing,
        mitigation,
      });
    }
  });
});

// A janela solta abre acima das outras; daí em diante quem manda é a barra de
// título do sistema, que já oferece "manter acima". Nem todo compositor honra
// os dois ajustes, então nenhum deles pode derrubar a janela se falhar.
function raiseLiveWindow(target) {
  if (!target || target.isDestroyed()) return;
  try { target.setAlwaysOnTop(true, 'screen-saver'); } catch { /* compositor sem suporte */ }
  try { target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindow: true }); } catch { /* idem */ }
}

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
  void directLink.close().catch(() => undefined);
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

// Uma porta nova a cada transmissão. Reaproveitar a anterior deixaria o áudio
// de uma live encerrada chegando na seguinte se o renderer demorasse a soltar
// a referência.
function openScreenAudioChannel() {
  closeScreenAudioChannel();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const channel = new MessageChannelMain();
  screenAudioChannel = channel;
  channel.port1.start();
  mainWindow.webContents.postMessage('tumacord:screen-audio-port', null, [channel.port2]);
}

function closeScreenAudioChannel() {
  if (!screenAudioChannel) return;
  try { screenAudioChannel.port1.close(); } catch { /* já fechada */ }
  screenAudioChannel = null;
}

async function startEmbeddedServer() {
  if (process.env.TUMACORD_EXTERNAL_SERVER === '1') return;
  // `::` atende IPv4 e IPv6 na mesma porta; sem isso não existe entrada pelo
  // IPv6, que é justamente o caminho de quem está atrás de CGNAT.
  process.env.HOST = '::';
  process.env.PORT = process.env.PORT || '3927';
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'server-data');
  // A instalação desktop carrega a interface direto do bundle local. O
  // servidor embutido existe somente para descoberta/sinalização P2P e não
  // publica mais uma cópia web na rede.
  process.env.TUMACORD_P2P_MODE = '1';
  process.env.TUMACORD_SERVE_WEB = '0';
  // Sem ZeroTier a porta de sinalização aceita conexão da internet. Quem vem
  // de fora da rede local precisa apresentar a chave que viaja no convite.
  process.env.TUMACORD_DIRECT_KEY = directLink.key;
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
      // Sem isso o Chromium estrangula timers e mídia quando a janela é
      // minimizada — justamente quando a live fica em uma janela flutuante.
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  // Quando o renderizador morre, a janela fica simplesmente preta e o app
  // parece travado. Recarregar devolve a tela de login/sessão salva; o teto de
  // três tentativas evita um laço de recarga se a falha for permanente.
  let rendererReloads = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    appendRuntimeEvent(runtimeLogFile, { event: 'render-process-gone', reason: details.reason, exitCode: details.exitCode, safeGpuMode });
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    const now = Date.now();
    rendererReloads = [...rendererReloads.filter((at) => now - at < 5 * 60_000), now];
    if (rendererReloads.length > 3) return;
    appendRuntimeEvent(runtimeLogFile, { event: 'renderer-reload', attempt: rendererReloads.length, safeGpuMode });
    setTimeout(() => { if (!window.isDestroyed()) window.reload(); }, 400);
  });
  window.webContents.on('unresponsive', () => appendRuntimeEvent(runtimeLogFile, { event: 'renderer-unresponsive', safeGpuMode }));
  window.webContents.on('responsive', () => appendRuntimeEvent(runtimeLogFile, { event: 'renderer-responsive', safeGpuMode }));
  // A única janela extra permitida é a da live solta: mesma origem, sem
  // navegação e sempre acima dos outros aplicativos. Todo o resto continua
  // bloqueado.
  window.webContents.setWindowOpenHandler(({ frameName, url }) => {
    // Cada mídia solta abre com um nome próprio (`tumacord-live-tela`,
    // `tumacord-live-camera`…). Exigir o nome exato aqui negava todas elas.
    if (!frameName.startsWith('tumacord-live') || (url && url !== 'about:blank')) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 960,
        height: 540,
        minWidth: 320,
        minHeight: 180,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        backgroundColor: '#06070b',
        title: 'Tumacord · AO VIVO',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          // O vídeo é MOVIDO para cá, não recriado — mas basta uma pausa
          // (troca de faixa, renegociação) para o `play()` seguinte precisar
          // de gesto que ninguém vai dar numa janela sem controles, e a live
          // solta fica preta. A janela principal já nasce com esta política;
          // faltava a janela flutuante.
          autoplayPolicy: 'no-user-gesture-required',
        },
      },
    };
  });
  window.webContents.on('did-create-window', (child) => {
    // Sem soltar do pai, a janela é arrastada junto com a principal: ela some
    // quando o Tumacord é minimizado e não consegue subir acima de outro app.
    try { child.setParentWindow(null); } catch { /* alguns compositores recusam */ }
    try { child.setSkipTaskbar(false); } catch { /* idem */ }
    raiseLiveWindow(child);
    child.setMenuBarVisibility(false);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    // Soltar do pai também significa que ela não fecha junto: sem isto, fechar
    // o Tumacord deixaria a janela da live órfã segurando o processo.
    liveWindows.add(child);
    windowActivity.refresh();
    for (const evento of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) child.on(evento, () => windowActivity.refresh());
    child.on('closed', () => { liveWindows.delete(child); windowActivity.refresh(); });
  });
  window.on('closed', () => {
    windowActivity.unwatch();
    drawingOverlay.close();
    closeScreenAudioChannel();
    for (const child of liveWindows) {
      if (!child.isDestroyed()) child.close();
    }
    liveWindows.clear();
  });
  window.on('enter-full-screen', () => window.webContents.send('tumacord:fullscreen-changed', true));
  window.on('leave-full-screen', () => {
    window.webContents.send('tumacord:fullscreen-changed', false);
    if (mediaFullscreenActive) {
      mediaFullscreenActive = false;
      window.webContents.send('tumacord:media-fullscreen-changed', false);
    }
  });

  // `file://` colado a um caminho de arquivo só dá certo por coincidência: no
  // Linux o caminho já começa com `/`, que completa as três barras. No Windows
  // ele começa com `C:\`, e o resultado — `file://C:\...` — não é um endereço
  // válido: o navegador normaliza para `file:///C:/...` e a comparação de
  // `will-navigate` abaixo deixa de bater, bloqueando a própria recarga do
  // aplicativo. Um caminho de instalação com espaço ou acento quebra do mesmo
  // jeito no Linux, porque o navegador percent-encoda e o texto guardado aqui
  // não. `pathToFileURL` já entrega o endereço normalizado nos dois sistemas.
  const target = process.env.TUMACORD_WEB_URL || pathToFileURL(path.join(__dirname, '../dist-web/index.html')).href;
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
  windowActivity.watch(window);
  if (isDevelopment) window.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, '../assets/tumacord-logo.png');
  const source = nativeImage.createFromPath(iconPath);
  // A bandeja usa a marca oficial colorida, a mesma do menu de aplicativos.
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
  // O servidor embutido é o que sustenta o modo P2P desta máquina, e perdê-lo
  // dói. Mas ele não pode custar a janela: sem janela o aplicativo "abre" e
  // não mostra nada, sem uma linha dizendo por quê — era o que acontecia,
  // porque a falha subia por uma promessa que ninguém tratava e o resto da
  // inicialização, inclusive `createWindow`, simplesmente não corria. Com a
  // janela de pé ainda dá para entrar em um servidor dedicado.
  try {
    await startEmbeddedServer();
    discovery = new TumacordDiscovery((calls) => {
      // Só a janela principal tem o preload e um ouvinte para isto. A janela
      // solta da live recebia o mesmo aviso a cada segundo e não fazia nada
      // com ele — trabalho de IPC gasto justamente durante uma transmissão.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tumacord:calls-changed', calls);
    }, { allowZeroTier: networkPreferences.zeroTierEnabled, key: directLink.key });
  } catch (error) {
    appendRuntimeEvent(runtimeLogFile, { event: 'embedded-server-failed', message: String(error && error.message ? error.message : error) });
    console.error('Tumacord: o servidor embutido não subiu; o modo P2P fica indisponível nesta sessão.', error);
  }
  // `clipboard-sanitized-write` é o que o Chromium exige para
  // `navigator.clipboard.writeText`. Sem ela na lista, o botão de copiar o
  // convite tinha a promessa rejeitada e não copiava nada. A leitura da área
  // de transferência continua negada: colar um convite é uma ação da pessoa,
  // e o aplicativo não precisa ler o que está copiado.
  const allowedPermissions = ['media', 'display-capture', 'clipboard-sanitized-write'];
  const trustedRequest = (webContents, permission) => webContents === mainWindow?.webContents && allowedPermissions.includes(permission);
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => trustedRequest(webContents, permission));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(trustedRequest(webContents, permission)));

  ipcMain.handle('tumacord:desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true,
    });
    const offered = sources.filter((source) => !blockedCaptureSource(source.name)).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('window:') ? 'window' : 'screen',
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon?.toDataURL(),
    }));
    offeredSources = new Map(offered.map((source) => [source.id, source.kind]));
    return offered;
  });
  ipcMain.handle('tumacord:screen-audio-capabilities', async () => {
    // A sondagem é o que dá a resposta honesta no Windows: ela tenta uma
    // ativação real de loopback por processo em vez de comparar número de
    // build. O resultado fica em cache no roteador.
    await screenAudioRouter.available().catch(() => undefined);
    return screenAudioRouter.capabilities();
  });
  ipcMain.handle('tumacord:screen-audio-diagnostics', () => screenAudioRouter.diagnostics());
  ipcMain.handle('tumacord:prepare-screen-audio', async (event, request) => {
    const sourceId = request && typeof request === 'object' && typeof request.sourceId === 'string' ? request.sourceId : '';
    // O Linux monta o mesmo barramento para qualquer fonte e não precisa do
    // identificador. No Windows ele decide qual árvore de processo capturar, e
    // por isso precisa ter saído desta lista — nunca do renderer direto.
    if (sourceId && sourceId !== activeScreenAudioSource && !offeredSources.has(sourceId)) {
      return { ok: false, code: 'unknown-source', error: 'Esta fonte não está mais disponível para captura.' };
    }
    const result = await screenAudioRouter.prepare({ sourceId, kind: offeredSources.get(sourceId) ?? '' });
    if (result.ok) activeScreenAudioSource = sourceId;
    return result;
  });
  // A porta é pedida pelo renderer, e não entregue junto da preparação. A
  // verificação periódica de saúde chama `prepare` com a mesma fonte a cada
  // dez segundos; entregar uma porta nova ali fecharia a que está tocando e a
  // live ficaria muda depois do primeiro minuto.
  ipcMain.handle('tumacord:request-screen-audio-port', (event) => {
    if (event.sender !== mainWindow?.webContents) return false;
    if (!activeScreenAudioSource) return false;
    openScreenAudioChannel();
    return true;
  });
  ipcMain.handle('tumacord:stop-screen-audio', async () => {
    activeScreenAudioSource = '';
    const result = await screenAudioRouter.stop();
    closeScreenAudioChannel();
    return result;
  });
  // Diagnóstico gráfico: opcional, e o renderer é quem pede. Ele nunca sai
  // sozinho para lugar nenhum, e o conteúdo é número e nome de recurso do
  // Chromium — sem SDP, sem endereço, sem convite, sem nome de janela.
  ipcMain.handle('tumacord:graphics-report', (event, media) => {
    if (event.sender !== mainWindow?.webContents) return null;
    return graphicsReporter.snapshot(media && typeof media === 'object' ? media : null);
  });
  ipcMain.handle('tumacord:set-graphics-diagnostics', (event, enabled) => {
    if (event.sender !== mainWindow?.webContents) return false;
    return graphicsReporter.enable(enabled !== false);
  });
  ipcMain.handle('tumacord:graphics-capability', (event) => {
    if (event.sender !== mainWindow?.webContents) return null;
    const status = graphicsReporter.featureStatus;
    if (!status) return { hardwareEncode: null, hardwareDecode: null, compositing: 'desconhecido', mitigation, detail: 'ainda não medido' };
    return { ...encodeCapability(status), ...decodeCapability(status), compositing: readAccelerationSummary(status).compositing, mitigation };
  });
  // A interface parou de pintar com a janela em primeiro plano. O renderer
  // mede a própria cadência; aqui só se escolhe o degrau, e nunca dois de uma
  // vez nem em laço — a escada tem carência de dois minutos.
  ipcMain.handle('tumacord:presentation-fault', (event, details) => {
    if (event.sender !== mainWindow?.webContents) return null;
    const payload = details && typeof details === 'object' ? details : {};
    const decision = recordPresentationFault(runtimeHealthFile, {}, Date.now(), process.platform);
    appendRuntimeEvent(runtimeLogFile, {
      event: 'presentation-fault',
      verdict: typeof payload.verdict === 'string' ? payload.verdict : undefined,
      paintFps: Number.isFinite(payload.paintFps) ? Math.round(payload.paintFps * 10) / 10 : undefined,
      longestGapMs: Number.isFinite(payload.longestGapMs) ? Math.round(payload.longestGapMs) : undefined,
      mitigation,
      escalatedTo: decision.escalated ? decision.step : undefined,
    });
    if (!decision.escalated) return { step: decision.step, relaunching: false };
    if (decision.step === 'reduce-effects') {
      // Este degrau acontece aqui dentro: a interface larga desfoque, animação
      // e prévia. Nada de reiniciar, nada de derrubar a call.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tumacord:reduce-effects', true);
      return { step: decision.step, relaunching: false };
    }
    if (!decision.shouldRelaunch || presentationRelaunching) return { step: decision.step, relaunching: false };
    // Reiniciar no meio de uma chamada é pior que a falha. O degrau fica
    // guardado e vale na PRÓXIMA abertura, que é quando dá para comparar os
    // dois backends sem tirar ninguém da conversa.
    presentationRelaunching = true;
    appendRuntimeEvent(runtimeLogFile, { event: 'mitigation-armed', step: decision.step, applyOn: 'próxima abertura' });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tumacord:mitigation-armed', { step: decision.step });
    return { step: decision.step, relaunching: false };
  });
  ipcMain.handle('tumacord:discover-calls', () => discovery?.list() ?? []);
  ipcMain.handle('tumacord:network-preferences', () => networkPreferences);
  ipcMain.handle('tumacord:set-network-preferences', (_event, patch) => {
    networkPreferences = writeNetworkPreferences(networkPreferencesFile, { ...networkPreferences, ...(patch && typeof patch === 'object' ? patch : {}) });
    directLink.setPreferences(networkPreferences);
    discovery?.setNetworkPreferences({ allowZeroTier: networkPreferences.zeroTierEnabled, key: directLink.key });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tumacord:network-preferences-changed', networkPreferences);
    return networkPreferences;
  });
  // A sondagem fala com STUN e com o roteador: ela pode demorar alguns
  // segundos, então a interface pede e espera, em vez de bloquear a abertura.
  ipcMain.handle('tumacord:direct-report', async (_event, options) => {
    try {
      return await directLink.probe({ force: Boolean(options && options.force) });
    } catch {
      // Devolver um relatório vazio aqui fazia a tela de rede anunciar "sem
      // entrada", "IPv6 ausente" e "NAT não medido" por causa de uma falha
      // passageira. O que se sabia antes continua valendo.
      return directLink.lastKnownReport();
    }
  });
  // O renderer manda o que precisa ser pintado; a janela sobreposta abre, se
  // atualiza ou fecha a partir disso. Sem transmissão de monitor inteiro, o
  // pedido é recusado e o desenho fica só dentro do aplicativo.
  ipcMain.handle('tumacord:draw-overlay', (_event, payload) => {
    try {
      if (!payload || !Array.isArray(payload.strokes) || !payload.strokes.length) {
        // Esvaziar em vez de fechar. Fechar e reabrir a cada pausa do desenho
        // custava um mapeamento de janela por rajada — e no KDE/Wayland cada
        // mapeamento tira o foco de teclado de quem estava digitando.
        if (!drawingOverlay.clear()) drawingOverlay.close();
        return false;
      }
      return drawingOverlay.show(payload);
    } catch (error) {
      appendRuntimeEvent(runtimeLogFile, { event: 'draw-overlay-failed', message: String(error && error.message ? error.message : error) });
      drawingOverlay.close();
      return false;
    }
  });
  ipcMain.handle('tumacord:set-hosting', (_event, details) => discovery?.setHosting(details) ?? null);
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
}).catch((error) => {
  // Última rede: uma falha aqui deixaria o processo vivo e mudo. Registrada,
  // ela aparece no arquivo de diagnóstico em vez de virar um aplicativo que
  // "não abre" sem explicação nenhuma.
  appendRuntimeEvent(runtimeLogFile, { event: 'startup-failed', message: String(error && error.message ? error.message : error) });
  console.error('Tumacord: falha ao iniciar.', error);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (!hasSingleInstanceLock) return;
  if (quittingAfterAudioCleanup) return;
  quittingAfterAudioCleanup = true;
  drawingOverlay.close();
  closeScreenAudioChannel();
  discovery?.close();
  event.preventDefault();
  // Fechar o app sem devolver a regra de porta deixaria o roteador aceitando
  // conexão para uma porta que não atende mais ninguém.
  void Promise.allSettled([screenAudioRouter.stop(), directLink.close()]).finally(() => app.quit());
});
