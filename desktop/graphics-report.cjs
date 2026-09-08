// Diagnóstico da inicialização gráfica e da mídia, no processo principal.
//
// Ele é opcional, leve e limitado, e existe porque a versão 0.8.8 não permitia
// responder três perguntas básicas depois de uma interface corrompida: qual
// backend de janelas o Chromium escolheu, o que ele ligou e desligou na GPU, e
// se a live estava sendo codificada em hardware ou não. Sem isso, "provavelmente
// é o driver" e "provavelmente é software encoding" tinham exatamente o mesmo
// peso — nenhum.
//
// Três limites que ele respeita:
//
// **Opt-in.** Só coleta quando alguém pede, por variável de ambiente, por
// bandeira ou pelo botão de diagnóstico. Um relatório que roda sempre é mais um
// consumidor de recursos no caminho que estamos tentando aliviar.
//
// **Limitado.** Uma coleta a cada dois segundos, no máximo; sem histórico
// crescente; sem `getGPUInfo('complete')` em laço, porque ele acorda o processo
// GPU.
//
// **Sem dados de ninguém.** Nada de SDP, endereço IP, convite, nome de janela
// capturada ou identificador de usuário. O que entra são números, nomes de
// recursos do Chromium e estados de janela.

const GRAPHICS_SWITCHES = new Set([
  'ozone-platform',
  'ozone-platform-hint',
  'enable-features',
  'disable-features',
  'disable-gpu',
  'disable-gpu-compositing',
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
  'use-gl',
  'use-angle',
  'in-process-gpu',
  'tumacord-safe-gpu',
  'tumacord-xwayland',
  'tumacord-diagnostics',
]);

// A linha de comando carrega caminho de instalação, e caminho de instalação
// carrega o nome da pessoa em `/home/<nome>`. Só as bandeiras conhecidas
// atravessam, e só com valor quando o valor é uma lista de recursos.
function sanitizeSwitches(argv = []) {
  const seen = [];
  for (const entry of argv) {
    if (typeof entry !== 'string' || !entry.startsWith('--')) continue;
    const [name, ...rest] = entry.slice(2).split('=');
    if (!GRAPHICS_SWITCHES.has(name)) continue;
    const value = rest.join('=');
    seen.push(value && /^[\w,.:-]+$/.test(value) ? `${name}=${value}` : name);
  }
  return [...new Set(seen)];
}

// Qual camada de janelas está de fato em uso. `ozone-platform-hint=auto` não
// responde: ele diz "decida você". A variável de sessão diz o que o desktop
// oferece, e a bandeira explícita, quando existe, vence.
function effectiveOzoneBackend(argv = [], environment = {}, platform = process.platform) {
  if (platform !== 'linux') return platform === 'win32' ? 'windows' : platform;
  const explicit = argv.find((entry) => typeof entry === 'string' && entry.startsWith('--ozone-platform='));
  if (explicit) return explicit.split('=')[1] || 'unknown';
  const hint = argv.find((entry) => typeof entry === 'string' && entry.startsWith('--ozone-platform-hint='));
  const hinted = hint ? hint.split('=')[1] : '';
  if (hinted && hinted !== 'auto') return hinted;
  if (environment.WAYLAND_DISPLAY && environment.XDG_SESSION_TYPE !== 'x11') return 'wayland (por hint automático)';
  if (environment.DISPLAY) return 'x11 (por hint automático)';
  return 'desconhecido';
}

function summarizeMetrics(metrics = []) {
  return metrics
    .filter((metric) => metric && typeof metric === 'object')
    .map((metric) => ({
      type: metric.type,
      cpuPercent: metric.cpu && typeof metric.cpu.percentCPUUsage === 'number' ? Math.round(metric.cpu.percentCPUUsage * 10) / 10 : undefined,
      memoryMb: metric.memory && typeof metric.memory.workingSetSize === 'number' ? Math.round(metric.memory.workingSetSize / 1_024) : undefined,
    }));
}

// O estado que a interface precisa conhecer para decidir o que parar de
// pintar. `document.hidden` não serve sozinho: com `backgroundThrottling`
// desligado, uma janela minimizada continua se dizendo visível.
function describeWindow(window) {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  return {
    id: safe(() => window.id, 0),
    minimized: safe(() => window.isMinimized(), false),
    visible: safe(() => window.isVisible(), true),
    focused: safe(() => window.isFocused(), false),
    fullscreen: safe(() => window.isFullScreen(), false),
    destroyed: safe(() => window.isDestroyed(), false),
  };
}

class GraphicsReporter {
  constructor(options = {}) {
    this.app = options.app;
    this.readWindows = options.readWindows ?? (() => []);
    this.argv = options.argv ?? process.argv;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.safeGpuMode = Boolean(options.safeGpuMode);
    this.enabledFeatures = options.enabledFeatures ?? [];
    this.gpuVendors = options.gpuVendors ?? [];
    this.now = options.now ?? (() => Date.now());
    this.gpuInfoUpdatedAt = 0;
    this.featureStatus = null;
    this.gpuInfo = null;
    this.gpuInfoError = '';
    this.lastSnapshotAt = 0;
    this.cached = null;
    this.forced = false;
  }

  get active() {
    return this.forced
      || this.environment.TUMACORD_DIAGNOSTICS === '1'
      || this.argv.includes('--tumacord-diagnostics');
  }

  enable(value = true) {
    this.forced = Boolean(value);
    return this.active;
  }

  // O Chromium responde `getGPUFeatureStatus` antes de ter decidido: os valores
  // só valem depois de `gpu-info-update`. Sem esperar por ele, um relatório
  // podia anunciar "video_encode: enabled" numa máquina que codifica em
  // software o tempo todo.
  observeGpuInfoUpdate() {
    this.gpuInfoUpdatedAt = this.now();
    try { this.featureStatus = this.app?.getGPUFeatureStatus?.() ?? null; }
    catch { this.featureStatus = null; }
  }

  async collectGpuInfo() {
    if (!this.app?.getGPUInfo) return;
    try {
      const info = await this.app.getGPUInfo('basic');
      const aux = info && info.auxAttributes ? info.auxAttributes : {};
      this.gpuInfo = {
        glImplementation: aux.glImplementationParts ?? aux.glImplementation,
        passthroughCmdDecoder: aux.passthroughCmdDecoder,
        hardwareSupportsVulkan: aux.hardwareSupportsVulkan,
        devices: Array.isArray(info?.gpuDevice) ? info.gpuDevice.map((device) => ({ vendorId: device.vendorId, deviceId: device.deviceId, active: device.active })) : [],
      };
      this.gpuInfoError = '';
    } catch (error) {
      // Uma falha aqui é informação, não motivo para nenhum caminho quebrar.
      this.gpuInfo = null;
      this.gpuInfoError = String(error && error.message ? error.message : error);
    }
  }

  // `media` chega do renderer: capturas ativas e enlaces vivos, sem nome de
  // janela e sem identificador de pessoa.
  snapshot(media = null) {
    const now = this.now();
    if (this.cached && now - this.lastSnapshotAt < 2_000) return { ...this.cached, media: media ?? this.cached.media };
    const windows = this.readWindows().filter(Boolean).map(describeWindow);
    const report = {
      at: new Date(now).toISOString(),
      platform: this.platform,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      ozoneBackend: effectiveOzoneBackend(this.argv, this.environment, this.platform),
      sessionType: this.platform === 'linux' ? (this.environment.XDG_SESSION_TYPE || 'desconhecido') : undefined,
      switches: sanitizeSwitches(this.argv),
      enabledFeatures: this.enabledFeatures,
      gpuVendors: this.gpuVendors,
      safeGpuMode: this.safeGpuMode,
      // `null` significa que o Chromium ainda não avisou. Não é "tudo certo".
      gpuFeatureStatus: this.featureStatus,
      gpuFeatureStatusAt: this.gpuInfoUpdatedAt ? new Date(this.gpuInfoUpdatedAt).toISOString() : null,
      gpuInfo: this.gpuInfo,
      gpuInfoError: this.gpuInfoError || undefined,
      processes: summarizeMetrics(this.app?.getAppMetrics?.() ?? []),
      windows,
      media,
    };
    this.cached = report;
    this.lastSnapshotAt = now;
    return report;
  }
}

// A leitura curta que interessa: encode e decode por hardware são coisas
// distintas de composição acelerada, e as três precisam aparecer separadas.
function readAccelerationSummary(featureStatus) {
  if (!featureStatus || typeof featureStatus !== 'object') {
    return { compositing: 'desconhecido', videoEncode: 'desconhecido', videoDecode: 'desconhecido' };
  }
  const label = (value) => {
    if (typeof value !== 'string') return 'desconhecido';
    if (value.startsWith('enabled')) return 'acelerado';
    if (value.includes('software')) return 'software';
    if (value.startsWith('disabled')) return 'desligado';
    return value;
  };
  return {
    compositing: label(featureStatus.gpu_compositing),
    videoEncode: label(featureStatus.video_encode),
    videoDecode: label(featureStatus.video_decode),
  };
}

module.exports = { GraphicsReporter, describeWindow, effectiveOzoneBackend, readAccelerationSummary, sanitizeSwitches, summarizeMetrics, GRAPHICS_SWITCHES };
