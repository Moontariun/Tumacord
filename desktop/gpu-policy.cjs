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

function streamingFeatures(platform = process.platform, vendors = detectLinuxGpuVendors(platform)) {
  const features = ['WebRTCPipeWireCapturer', 'WaylandWindowDecorations'];
  // VA-API é estável no Chromium com Intel/AMD. A implementação NVIDIA no
  // Linux continua experimental, por isso não forçamos VaapiOnNvidiaGPUs:
  // nesses hosts o WebRTC usa o caminho que o Chromium validar e o controlador
  // adaptativo reduz resolução caso o encoder de software fique pressionado.
  if (platform === 'linux' && vendors.some((vendor) => vendor === '0x1002' || vendor === '0x8086')) features.push('VaapiVideoEncoder');
  return features;
}

module.exports = { detectLinuxGpuVendors, streamingFeatures };
