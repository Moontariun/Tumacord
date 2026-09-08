const fs = require('node:fs');

function detectLinuxGpuVendors(platform = process.platform, drmRoot = '/sys/class/drm') {
  if (platform !== 'linux') return [];
  try {
    return [...new Set(fs.readdirSync(drmRoot)
      .filter((entry) => /^card\d+$/.test(entry))
      .flatMap((entry) => {
        try { return [fs.readFileSync(`${drmRoot}/${entry}/device/vendor`, 'utf8').trim().toLowerCase()]; }
        catch { return []; }
      }))];
  } catch {
    return [];
  }
}

function streamingFeatures(platform = process.platform, vendors = detectLinuxGpuVendors(platform), safeGpuMode = false) {
  // PipeWire e as decorações do Wayland só existem no Linux. Fora dele a lista
  // é vazia: no Windows a captura de tela e o loopback de áudio vêm do próprio
  // Chromium, e ligar bandeiras de outro sistema operacional só embaralha o
  // diagnóstico de quem for ler a linha de comando do processo.
  if (platform !== 'linux') return [];
  const features = ['WebRTCPipeWireCapturer', 'WaylandWindowDecorations'];
  // VA-API é estável no Chromium com Intel/AMD. A implementação NVIDIA no
  // Linux continua experimental, por isso não forçamos VaapiOnNvidiaGPUs:
  // nesses hosts o WebRTC usa o caminho que o Chromium validar e o controlador
  // adaptativo reduz resolução caso o encoder de software fique pressionado.
  //
  // O que MUDOU na 0.8.9 não foi essa escolha — foi parar de adivinhar. A
  // medição nesta máquina (Electron 41.10.7 / Chromium 146, NVIDIA 610.57.04,
  // Wayland) devolve `video_encode: disabled_software`: não existe encoder de
  // vídeo por hardware disponível aqui, com ou sem bandeira. Forçar VA-API não
  // criaria um; só trocaria uma falha silenciosa por outra. O que resolve é
  // reduzir o trabalho de verdade, e é isso que o orçamento de captura e o
  // controlador de pressão fazem.
  if (!safeGpuMode && vendors.some((vendor) => vendor === '0x1002' || vendor === '0x8086')) features.push('VaapiVideoEncoder');
  return features;
}

// Backend de janelas. `auto` é o padrão e deixa o Chromium escolher; `x11` é o
// degrau de comparação da escada de recuperação, para separar um defeito do
// caminho Wayland/GBM de um defeito do driver. Nenhum dos dois desliga VSync,
// mexe no compositor ou fura a lista de bloqueio: essas seriam mudanças
// globais que a pessoa não pediu e que mascarariam o defeito.
function ozoneSwitches(platform = process.platform, mitigation = 'none') {
  if (platform !== 'linux') return [];
  if (mitigation === 'xwayland') return [['ozone-platform', 'x11']];
  return [['ozone-platform-hint', 'auto']];
}

// Leitura honesta do que o Chromium decidiu, para o orçamento de software.
//
// `null` em `hardwareEncode` significa "ainda não medido", e é diferente de
// `false`. Enquanto for `null`, nada aqui muda o comportamento do aplicativo:
// um palpite errado nessa direção deixaria a live pior sem motivo.
function encodeCapability(featureStatus) {
  const raw = featureStatus && typeof featureStatus === 'object' ? featureStatus.video_encode : undefined;
  if (typeof raw !== 'string') return { hardwareEncode: null, detail: 'não medido' };
  if (raw.startsWith('enabled')) return { hardwareEncode: true, detail: raw };
  if (raw.includes('software')) return { hardwareEncode: false, detail: raw };
  return { hardwareEncode: false, detail: raw };
}

function decodeCapability(featureStatus) {
  const raw = featureStatus && typeof featureStatus === 'object' ? featureStatus.video_decode : undefined;
  if (typeof raw !== 'string') return { hardwareDecode: null, detail: 'não medido' };
  return { hardwareDecode: raw.startsWith('enabled'), detail: raw };
}

module.exports = { decodeCapability, detectLinuxGpuVendors, encodeCapability, ozoneSwitches, streamingFeatures };
