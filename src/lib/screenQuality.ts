export type StreamQuality = 'source' | 'ultra60' | 'ultra30' | 'high' | 'balanced' | 'data';

export interface ScreenQualityConfig {
  label: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
}

export const SCREEN_QUALITIES: Record<StreamQuality, ScreenQualityConfig> = {
  source: { label: '1080p · 60 FPS', width: 1920, height: 1080, frameRate: 60, bitrate: 8_000_000 },
  ultra60: { label: '1440p · 60 FPS', width: 2560, height: 1440, frameRate: 60, bitrate: 14_000_000 },
  ultra30: { label: '1440p · 30 FPS', width: 2560, height: 1440, frameRate: 30, bitrate: 10_000_000 },
  high: { label: '1080p · 30 FPS', width: 1920, height: 1080, frameRate: 30, bitrate: 5_000_000 },
  balanced: { label: '720p · 30 FPS', width: 1280, height: 720, frameRate: 30, bitrate: 2_500_000 },
  data: { label: '480p · 15 FPS', width: 854, height: 480, frameRate: 15, bitrate: 900_000 },
};

// A ordem do objeto acima existe por motivos históricos e não serve para a
// interface. O seletor lista da menor para a maior resolução e, dentro da
// mesma resolução, do menor para o maior FPS.
export const screenQualityOptions = (Object.entries(SCREEN_QUALITIES) as [StreamQuality, ScreenQualityConfig][])
  .sort(([, left], [, right]) => (left.height - right.height)
    || (left.width - right.width)
    || (left.frameRate - right.frameRate));

export const screenQualityOrder = screenQualityOptions.map(([value]) => value);

const CAPTURE_ENVELOPE = SCREEN_QUALITIES.ultra60;

export function parseStreamQuality(value: unknown): StreamQuality {
  return typeof value === 'string' && Object.hasOwn(SCREEN_QUALITIES, value) ? value as StreamQuality : 'source';
}

// A captura do portal permanece a mesma durante toda a transmissão. Os perfis
// são aplicados no encoder de cada peer, portanto mudar a qualidade nunca pede
// ao PipeWire/Wayland que escolha a tela novamente.
export function screenCaptureConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: CAPTURE_ENVELOPE.width, max: CAPTURE_ENVELOPE.width },
    height: { ideal: CAPTURE_ENVELOPE.height, max: CAPTURE_ENVELOPE.height },
    frameRate: { ideal: CAPTURE_ENVELOPE.frameRate, max: CAPTURE_ENVELOPE.frameRate },
  };
}

export function desktopScreenCaptureConstraints(): Record<string, number | string> {
  return {
    chromeMediaSource: 'desktop',
    maxWidth: CAPTURE_ENVELOPE.width,
    maxHeight: CAPTURE_ENVELOPE.height,
    maxFrameRate: CAPTURE_ENVELOPE.frameRate,
  };
}

export function screenScaleForQuality(settings: Pick<MediaTrackSettings, 'width' | 'height'>, config: ScreenQualityConfig): number {
  const widthRatio = settings.width ? settings.width / config.width : 1;
  const heightRatio = settings.height ? settings.height / config.height : 1;
  return Math.round(Math.min(4, Math.max(1, widthRatio, heightRatio)) * 100) / 100;
}

export function maximumAdaptiveScreenScale(baseScale: number): number {
  return Math.min(4, Math.max(baseScale, baseScale * 2));
}

// O controle de congestionamento do Chromium começa perto de 300 kbps e leva
// dezenas de segundos para descobrir um enlace LAN/ZeroTier. Anunciar o piso e
// o ponto de partida na SDP faz a live abrir já nítida em vez de subir de
// qualidade um minuto depois.
export function screenBitrateHints(config: ScreenQualityConfig): { startKbps: number; minKbps: number; maxKbps: number } {
  const maxKbps = Math.round(config.bitrate / 1_000);
  return {
    startKbps: Math.round(maxKbps * 0.7),
    minKbps: Math.round(maxKbps * 0.25),
    maxKbps,
  };
}
