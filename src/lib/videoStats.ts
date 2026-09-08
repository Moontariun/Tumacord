// Leitura por vídeo do relatório do WebRTC.
//
// A regra que atravessa este arquivo: estatística ausente vira `undefined`, e
// `undefined` é relatado como desconhecido. Nunca zero, nunca um palpite. Um
// relatório que inventa "0 quadros descartados" quando o navegador não contou
// nada é pior que um relatório vazio, porque parece resposta.
//
// Duas confusões que este módulo existe para não cometer:
//
// **Aceleração da interface não é encode por hardware.** `gpu_compositing`
// ligado diz que a janela é composta pela GPU. Quem diz se a live está sendo
// codificada em hardware é `encoderImplementation` — e, quando o Chromium
// oferece, `powerEfficientEncoder`.
//
// **Tempo médio de encode não é um número que o navegador entrega.** O que
// existe é `totalEncodeTime` acumulado; a média por quadro é a diferença dele
// dividida pela diferença de `framesEncoded` na mesma janela.

import type { RtcStatLike } from './networkQuality';

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export interface OutboundVideoCounters {
  bytesSent?: number;
  framesEncoded?: number;
  framesSent?: number;
  totalEncodeTime?: number;
  framesCaptured?: number;
  framesDroppedBeforeEncode?: number;
  at: number;
}

export interface InboundVideoCounters {
  bytesReceived?: number;
  framesDecoded?: number;
  framesReceived?: number;
  totalDecodeTime?: number;
  framesDropped?: number;
  at: number;
}

export interface OutboundVideoDiagnostic {
  /** O que a captura está entregando de verdade, por `media-source`. */
  captureWidth?: number;
  captureHeight?: number;
  captureFps?: number;
  capturedFramesDelta?: number;
  capturedDroppedDelta?: number;
  /** O que sai no fio depois da escala do encoder. */
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  codec?: string;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  framesEncodedDelta?: number;
  framesSentDelta?: number;
  averageEncodeMs?: number;
  bitrateBps?: number;
  qualityLimitationReason?: string;
  qualityLimitationCpuMs?: number;
  counters: OutboundVideoCounters;
}

export interface InboundVideoDiagnostic {
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  codec?: string;
  decoderImplementation?: string;
  powerEfficientDecoder?: boolean;
  framesReceivedDelta?: number;
  framesDecodedDelta?: number;
  framesDroppedDelta?: number;
  averageDecodeMs?: number;
  bitrateBps?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  counters: InboundVideoCounters;
}

function codecOf(stats: RtcStatLike[], rtp: RtcStatLike): string | undefined {
  const codecId = text(rtp.codecId);
  if (!codecId) return undefined;
  const codec = stats.find((stat) => stat.id === codecId);
  const mime = text(codec?.mimeType);
  if (!mime) return undefined;
  // `video/VP9` basta. O resto da linha do codec carrega parâmetros de perfil
  // que não ajudam ninguém a ler o relatório.
  return mime.replace(/^video\//i, '');
}

function ratePerSecond(current: number | undefined, previous: number | undefined, seconds: number): number | undefined {
  if (current === undefined || previous === undefined || seconds <= 0) return undefined;
  const delta = current - previous;
  return delta < 0 ? undefined : delta / seconds;
}

function delta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) return undefined;
  const value = current - previous;
  return value < 0 ? undefined : value;
}

export function readOutboundVideo(stats: RtcStatLike[], previous: OutboundVideoCounters | undefined, now: number): OutboundVideoDiagnostic | null {
  const outbound = stats
    .filter((stat) => stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video') && stat.isRemote !== true)
    .sort((left, right) => (finiteNumber(right.bytesSent) ?? 0) - (finiteNumber(left.bytesSent) ?? 0))[0];
  if (!outbound) return null;
  const mediaSourceId = text(outbound.mediaSourceId);
  const source = mediaSourceId ? stats.find((stat) => stat.id === mediaSourceId) : stats.find((stat) => stat.type === 'media-source' && stat.kind === 'video');
  const seconds = previous ? (now - previous.at) / 1_000 : 0;
  const framesEncoded = finiteNumber(outbound.framesEncoded);
  const totalEncodeTime = finiteNumber(outbound.totalEncodeTime);
  const encodedDelta = delta(framesEncoded, previous?.framesEncoded);
  const encodeTimeDelta = delta(totalEncodeTime, previous?.totalEncodeTime);
  const bytesRate = ratePerSecond(finiteNumber(outbound.bytesSent), previous?.bytesSent, seconds);
  return {
    captureWidth: finiteNumber(source?.width),
    captureHeight: finiteNumber(source?.height),
    captureFps: finiteNumber(source?.framesPerSecond),
    capturedFramesDelta: delta(finiteNumber(source?.framesCaptured), previous?.framesCaptured),
    capturedDroppedDelta: delta(finiteNumber(source?.framesDropped), previous?.framesDroppedBeforeEncode),
    frameWidth: finiteNumber(outbound.frameWidth),
    frameHeight: finiteNumber(outbound.frameHeight),
    framesPerSecond: finiteNumber(outbound.framesPerSecond),
    codec: codecOf(stats, outbound),
    encoderImplementation: text(outbound.encoderImplementation),
    powerEfficientEncoder: typeof outbound.powerEfficientEncoder === 'boolean' ? outbound.powerEfficientEncoder : undefined,
    framesEncodedDelta: encodedDelta,
    framesSentDelta: delta(finiteNumber(outbound.framesSent), previous?.framesSent),
    averageEncodeMs: encodedDelta !== undefined && encodedDelta > 0 && encodeTimeDelta !== undefined ? (encodeTimeDelta * 1_000) / encodedDelta : undefined,
    bitrateBps: bytesRate === undefined ? undefined : bytesRate * 8,
    qualityLimitationReason: text(outbound.qualityLimitationReason),
    qualityLimitationCpuMs: (() => {
      const durations = outbound.qualityLimitationDurations as Record<string, unknown> | undefined;
      const cpu = durations && typeof durations === 'object' ? finiteNumber(durations.cpu) : undefined;
      return cpu === undefined ? undefined : cpu * 1_000;
    })(),
    counters: {
      bytesSent: finiteNumber(outbound.bytesSent),
      framesEncoded,
      framesSent: finiteNumber(outbound.framesSent),
      totalEncodeTime,
      framesCaptured: finiteNumber(source?.framesCaptured),
      framesDroppedBeforeEncode: finiteNumber(source?.framesDropped),
      at: now,
    },
  };
}

export function readInboundVideo(stats: RtcStatLike[], previous: InboundVideoCounters | undefined, now: number): InboundVideoDiagnostic | null {
  const inbound = stats
    .filter((stat) => stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video') && stat.isRemote !== true)
    .sort((left, right) => (finiteNumber(right.bytesReceived) ?? 0) - (finiteNumber(left.bytesReceived) ?? 0))[0];
  if (!inbound) return null;
  const seconds = previous ? (now - previous.at) / 1_000 : 0;
  const framesDecoded = finiteNumber(inbound.framesDecoded);
  const totalDecodeTime = finiteNumber(inbound.totalDecodeTime);
  const decodedDelta = delta(framesDecoded, previous?.framesDecoded);
  const decodeTimeDelta = delta(totalDecodeTime, previous?.totalDecodeTime);
  const bytesRate = ratePerSecond(finiteNumber(inbound.bytesReceived), previous?.bytesReceived, seconds);
  return {
    frameWidth: finiteNumber(inbound.frameWidth),
    frameHeight: finiteNumber(inbound.frameHeight),
    framesPerSecond: finiteNumber(inbound.framesPerSecond),
    codec: codecOf(stats, inbound),
    decoderImplementation: text(inbound.decoderImplementation),
    powerEfficientDecoder: typeof inbound.powerEfficientDecoder === 'boolean' ? inbound.powerEfficientDecoder : undefined,
    framesReceivedDelta: delta(finiteNumber(inbound.framesReceived), previous?.framesReceived),
    framesDecodedDelta: decodedDelta,
    framesDroppedDelta: delta(finiteNumber(inbound.framesDropped), previous?.framesDropped),
    averageDecodeMs: decodedDelta !== undefined && decodedDelta > 0 && decodeTimeDelta !== undefined ? (decodeTimeDelta * 1_000) / decodedDelta : undefined,
    bitrateBps: bytesRate === undefined ? undefined : bytesRate * 8,
    freezeCount: finiteNumber(inbound.freezeCount),
    totalFreezesDuration: finiteNumber(inbound.totalFreezesDuration),
    counters: {
      bytesReceived: finiteNumber(inbound.bytesReceived),
      framesDecoded,
      framesReceived: finiteNumber(inbound.framesReceived),
      totalDecodeTime,
      framesDropped: finiteNumber(inbound.framesDropped),
      at: now,
    },
  };
}

function unknown(value: unknown): string {
  return value === undefined || value === null ? 'desconhecido' : String(value);
}

function resolution(width?: number, height?: number, fps?: number): string {
  if (width === undefined && height === undefined && fps === undefined) return 'desconhecida';
  const size = width !== undefined && height !== undefined ? `${width}×${height}` : 'desconhecida';
  return `${size} · ${fps === undefined ? 'FPS desconhecido' : `${Math.round(fps)} FPS`}`;
}

export function formatOutboundVideo(diagnostic: OutboundVideoDiagnostic, requested: { width: number; height: number; frameRate: number }): string[] {
  return [
    `  captura pedida: ${requested.width}×${requested.height} · ${requested.frameRate} FPS`,
    `  captura efetiva: ${resolution(diagnostic.captureWidth, diagnostic.captureHeight, diagnostic.captureFps)}`,
    `  enviado: ${resolution(diagnostic.frameWidth, diagnostic.frameHeight, diagnostic.framesPerSecond)}`,
    `  codec: ${unknown(diagnostic.codec)} · encoder: ${unknown(diagnostic.encoderImplementation)}${diagnostic.powerEfficientEncoder === undefined ? '' : diagnostic.powerEfficientEncoder ? ' (eficiente)' : ' (não eficiente)'}`,
    `  quadros na janela: capturados ${unknown(diagnostic.capturedFramesDelta)} · largados na captura ${unknown(diagnostic.capturedDroppedDelta)} · codificados ${unknown(diagnostic.framesEncodedDelta)} · enviados ${unknown(diagnostic.framesSentDelta)}`,
    `  tempo médio de encode: ${diagnostic.averageEncodeMs === undefined ? 'desconhecido' : `${diagnostic.averageEncodeMs.toFixed(1)} ms`}`,
    `  bitrate: ${diagnostic.bitrateBps === undefined ? 'desconhecido' : `${Math.round(diagnostic.bitrateBps / 1_000)} kbps`}`,
    `  limitação: ${unknown(diagnostic.qualityLimitationReason)}${diagnostic.qualityLimitationCpuMs === undefined ? '' : ` · ${Math.round(diagnostic.qualityLimitationCpuMs)} ms por CPU`}`,
  ];
}

export function formatInboundVideo(diagnostic: InboundVideoDiagnostic): string[] {
  return [
    `  recebido: ${resolution(diagnostic.frameWidth, diagnostic.frameHeight, diagnostic.framesPerSecond)}`,
    `  codec: ${unknown(diagnostic.codec)} · decoder: ${unknown(diagnostic.decoderImplementation)}${diagnostic.powerEfficientDecoder === undefined ? '' : diagnostic.powerEfficientDecoder ? ' (eficiente)' : ' (não eficiente)'}`,
    `  quadros na janela: recebidos ${unknown(diagnostic.framesReceivedDelta)} · decodificados ${unknown(diagnostic.framesDecodedDelta)} · descartados ${unknown(diagnostic.framesDroppedDelta)}`,
    `  tempo médio de decode: ${diagnostic.averageDecodeMs === undefined ? 'desconhecido' : `${diagnostic.averageDecodeMs.toFixed(1)} ms`}`,
    `  bitrate: ${diagnostic.bitrateBps === undefined ? 'desconhecido' : `${Math.round(diagnostic.bitrateBps / 1_000)} kbps`}`,
    `  congelamentos: ${unknown(diagnostic.freezeCount)}${diagnostic.totalFreezesDuration === undefined ? '' : ` · ${diagnostic.totalFreezesDuration.toFixed(1)} s`}`,
  ];
}
