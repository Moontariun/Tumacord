export type RtcStatLike = Record<string, unknown> & {
  id?: string;
  type?: string;
};

export interface ActivePathMetrics {
  rttMs?: number;
  availableOutgoingBitrate?: number;
}

export interface OutboundVideoMetrics {
  bytesSent?: number;
  packetsSent?: number;
  fractionLost?: number;
  framesEncoded?: number;
  framesSent?: number;
  framesPerSecond?: number;
  totalEncodeTime?: number;
  qualityLimitationReason?: string;
}

export interface InboundAudioMetrics {
  bytesReceived?: number;
  packetsReceived?: number;
}

export interface InboundVideoMetrics {
  bytesReceived?: number;
  packetsReceived?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesPerSecond?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
}

export interface EncoderAdaptationInput {
  targetFps: number;
  currentScale: number;
  minimumScale?: number;
  maximumScale?: number;
  healthySamples: number;
  pressureSamples: number;
  averageEncodeMs?: number;
  qualityLimitationReason?: string;
  receiverFrozen?: boolean;
}

export interface EncoderAdaptationResult {
  scale: number;
  healthySamples: number;
  pressureSamples: number;
  stressed: boolean;
}

export interface StreamAdaptationInput {
  targetBitrate: number;
  currentBitrate: number;
  healthySamples: number;
  rttMs?: number;
  availableOutgoingBitrate?: number;
  fractionLost?: number;
  warmingUp?: boolean;
  sendingBitrate?: number;
}

export interface StreamAdaptationResult {
  bitrate: number;
  healthySamples: number;
  congested: boolean;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function activeCandidatePair(stats: RtcStatLike[]): RtcStatLike | undefined {
  const byId = new Map(stats.filter((stat) => stat.id).map((stat) => [stat.id as string, stat]));
  const transportSelected = stats
    .filter((stat) => stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string')
    .map((stat) => byId.get(stat.selectedCandidatePairId as string))
    .filter((stat): stat is RtcStatLike => Boolean(stat));
  if (transportSelected.length) return transportSelected[0];

  const succeeded = stats.filter((stat) => stat.type === 'candidate-pair' && stat.state === 'succeeded');
  const selected = succeeded.find((stat) => stat.selected === true);
  if (selected) return selected;
  const nominated = succeeded.filter((stat) => stat.nominated === true);
  const candidates = nominated.length ? nominated : succeeded;
  return candidates.sort((left, right) => {
    const leftTraffic = (finiteNumber(left.bytesSent) ?? 0) + (finiteNumber(left.bytesReceived) ?? 0);
    const rightTraffic = (finiteNumber(right.bytesSent) ?? 0) + (finiteNumber(right.bytesReceived) ?? 0);
    return rightTraffic - leftTraffic;
  })[0];
}

export function activePathMetrics(stats: RtcStatLike[]): ActivePathMetrics {
  const pair = activeCandidatePair(stats);
  if (!pair) return {};
  const rttSeconds = finiteNumber(pair.currentRoundTripTime);
  return {
    rttMs: rttSeconds === undefined ? undefined : rttSeconds * 1_000,
    availableOutgoingBitrate: finiteNumber(pair.availableOutgoingBitrate),
  };
}

export function outboundVideoMetrics(stats: RtcStatLike[]): OutboundVideoMetrics {
  const outbound = stats
    .filter((stat) => stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video') && stat.isRemote !== true)
    .sort((left, right) => (finiteNumber(right.bytesSent) ?? 0) - (finiteNumber(left.bytesSent) ?? 0))[0];
  if (!outbound) return {};
  const remote = stats.find((stat) => (
    (typeof outbound.remoteId === 'string' && stat.id === outbound.remoteId)
    || (stat.type === 'remote-inbound-rtp' && stat.localId === outbound.id)
  ));
  return {
    bytesSent: finiteNumber(outbound.bytesSent),
    packetsSent: finiteNumber(outbound.packetsSent),
    fractionLost: finiteNumber(remote?.fractionLost),
    framesEncoded: finiteNumber(outbound.framesEncoded),
    framesSent: finiteNumber(outbound.framesSent),
    framesPerSecond: finiteNumber(outbound.framesPerSecond),
    totalEncodeTime: finiteNumber(outbound.totalEncodeTime),
    qualityLimitationReason: typeof outbound.qualityLimitationReason === 'string' ? outbound.qualityLimitationReason : undefined,
  };
}

export function inboundAudioMetrics(stats: RtcStatLike[]): InboundAudioMetrics {
  const inbound = stats.filter((stat) => stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio') && stat.isRemote !== true);
  if (!inbound.length) return {};
  return {
    bytesReceived: inbound.reduce((total, stat) => total + (finiteNumber(stat.bytesReceived) ?? 0), 0),
    packetsReceived: inbound.reduce((total, stat) => total + (finiteNumber(stat.packetsReceived) ?? 0), 0),
  };
}

export function inboundVideoMetrics(stats: RtcStatLike[]): InboundVideoMetrics {
  const inbound = stats
    .filter((stat) => stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video') && stat.isRemote !== true)
    .sort((left, right) => (finiteNumber(right.bytesReceived) ?? 0) - (finiteNumber(left.bytesReceived) ?? 0))[0];
  if (!inbound) return {};
  return {
    bytesReceived: finiteNumber(inbound.bytesReceived),
    packetsReceived: finiteNumber(inbound.packetsReceived),
    framesReceived: finiteNumber(inbound.framesReceived),
    framesDecoded: finiteNumber(inbound.framesDecoded),
    framesPerSecond: finiteNumber(inbound.framesPerSecond),
    freezeCount: finiteNumber(inbound.freezeCount),
    totalFreezesDuration: finiteNumber(inbound.totalFreezesDuration),
  };
}

export function median(values: number[]): number | undefined {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundedBitrate(value: number): number {
  return Math.max(50_000, Math.round(value / 50_000) * 50_000);
}

export function adaptScreenBitrate(input: StreamAdaptationInput): StreamAdaptationResult {
  const target = Math.max(300_000, input.targetBitrate);
  const minimum = Math.min(target, Math.max(350_000, Math.min(1_500_000, target * 0.12)));
  const current = Math.min(target, Math.max(minimum, input.currentBitrate));
  // A estimativa do Chromium não mede a capacidade do enlace em abstrato: ela
  // cresce a partir do que realmente sai. Com a tela parada o envio despenca e
  // a estimativa junto — e ler isso como congestionamento cortava o teto até o
  // piso, deixando a live borrada assim que a cena voltava a se mexer, com
  // ping baixo o tempo todo. Enquanto não estamos usando o teto, a estimativa
  // não diz nada sobre capacidade. O mesmo vale nos primeiros segundos, quando
  // ela ainda sobe a partir de ~300 kbps.
  const probing = input.sendingBitrate === undefined || input.sendingBitrate >= current * 0.5;
  const available = input.warmingUp || !probing ? undefined : input.availableOutgoingBitrate;
  const rtt = input.rttMs;
  const loss = input.fractionLost;
  const severelyCongested = (rtt !== undefined && rtt >= 320)
    || (loss !== undefined && loss >= 0.08)
    || (available !== undefined && available < current * 0.55);
  const congested = severelyCongested
    || (rtt !== undefined && rtt >= 180)
    || (loss !== undefined && loss >= 0.02)
    || (available !== undefined && available < current * 0.9);

  if (congested) {
    const reduction = current * (severelyCongested ? 0.64 : 0.8);
    const capacityLimit = available === undefined ? reduction : Math.min(reduction, available * 0.72);
    return { bitrate: roundedBitrate(Math.max(minimum, capacityLimit)), healthySamples: 0, congested: true };
  }

  const healthy = (rtt === undefined || rtt < 120)
    && (loss === undefined || loss < 0.01)
    && (available === undefined || available > current * 1.2);
  const healthySamples = healthy ? input.healthySamples + 1 : Math.max(0, input.healthySamples - 1);
  if (current < target && healthySamples >= 2) {
    // Quando a rota mostra folga larga não faz sentido subir de 14% em 14%:
    // em LAN/ZeroTier isso levava minutos até a live ficar nítida.
    const roomy = available !== undefined && available > current * 2 ? available * 0.75 : 0;
    return {
      bitrate: roundedBitrate(Math.min(target, Math.max(current + 1_000_000, current * 1.45, roomy))),
      healthySamples: 0,
      congested: false,
    };
  }
  return { bitrate: roundedBitrate(current), healthySamples, congested: false };
}

function roundedScale(value: number, minimum = 1, maximum = 2): number {
  return Math.round(Math.min(Math.max(minimum, maximum), Math.max(minimum, value)) * 20) / 20;
}

// Bitrate adaptation handles the network. This second controller reacts only
// to encoder/decoder pressure so a 1440p game can temporarily step down toward
// 1080p/720p instead of preserving resolution while dropping most frames.
export function adaptEncoderScale(input: EncoderAdaptationInput): EncoderAdaptationResult {
  const minimumScale = Math.max(1, input.minimumScale ?? 1);
  const maximumScale = Math.max(minimumScale, input.maximumScale ?? 2);
  const frameBudgetMs = 1_000 / Math.max(1, input.targetFps);
  // A 60 FPS o orçamento é de 16,7 ms por quadro. Marcar pressão já em 13,7 ms
  // derrubava a resolução em cenas normais de jogo; o encoder só está mesmo
  // atrasado quando encosta no orçamento inteiro.
  const encoderOverBudget = input.averageEncodeMs !== undefined && input.averageEncodeMs >= frameBudgetMs * 0.95;
  const stressed = Boolean(input.receiverFrozen) || input.qualityLimitationReason === 'cpu' || encoderOverBudget;
  const pressureSamples = stressed ? input.pressureSamples + 1 : Math.max(0, input.pressureSamples - 1);
  const pressureThreshold = input.receiverFrozen ? 1 : 2;
  if (stressed && pressureSamples >= pressureThreshold) {
    return {
      scale: roundedScale(Math.max(input.currentScale + 0.25, input.currentScale * 1.2), minimumScale, maximumScale),
      healthySamples: 0,
      pressureSamples: 0,
      stressed: true,
    };
  }

  const healthy = !stressed
    && (input.qualityLimitationReason === undefined || input.qualityLimitationReason === 'none')
    && (input.averageEncodeMs === undefined || input.averageEncodeMs < frameBudgetMs * 0.7);
  const healthySamples = healthy ? input.healthySamples + 1 : Math.max(0, input.healthySamples - 1);
  // A resolução caía em duas amostras e voltava em seis, de 0,15 em 0,15: um
  // engasgo isolado custava quase um minuto de imagem borrada.
  if (input.currentScale > minimumScale && healthySamples >= 3) {
    return {
      scale: roundedScale(Math.max(minimumScale, input.currentScale - 0.25), minimumScale, maximumScale),
      healthySamples: 0,
      pressureSamples,
      stressed: false,
    };
  }
  return { scale: roundedScale(input.currentScale, minimumScale, maximumScale), healthySamples, pressureSamples, stressed };
}

// Cada mudança de `scaleResolutionDownBy` obriga o encoder a se reconfigurar:
// sai um keyframe e, com ele, um quadro visivelmente quadriculado. Com uma
// amostra a cada dois segundos, um controlador que muda de ideia com
// frequência transforma isso em piscadas constantes na transmissão. A escala
// só se move quando a diferença importa e depois de segurar por um tempo —
// exceto num salto grande, que é sinal de aperto real.
export const SCALE_HOLD_MS = 12_000;

export function shouldApplyScaleChange(input: { currentScale: number; nextScale: number; msSinceChange: number }): boolean {
  const delta = Math.abs(input.nextScale - input.currentScale);
  if (delta < 0.2) return false;
  if (delta >= 0.5) return true;
  return input.msSinceChange >= SCALE_HOLD_MS;
}

// O teto de bitrate não reconfigura o encoder, mas reaplicá-lo por causa de
// 50 kbps em 8 Mbps é ruído: 0,6% de diferença não muda imagem nenhuma.
export function shouldApplyBitrateChange(currentBitrate: number, nextBitrate: number): boolean {
  return Math.abs(nextBitrate - currentBitrate) >= Math.max(150_000, currentBitrate * 0.1);
}
