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
}

export interface StreamAdaptationInput {
  targetBitrate: number;
  currentBitrate: number;
  healthySamples: number;
  rttMs?: number;
  availableOutgoingBitrate?: number;
  fractionLost?: number;
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
  const available = input.availableOutgoingBitrate;
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
  if (current < target && healthySamples >= 3) {
    return {
      bitrate: roundedBitrate(Math.min(target, Math.max(current + 100_000, current * 1.14))),
      healthySamples: 0,
      congested: false,
    };
  }
  return { bitrate: roundedBitrate(current), healthySamples, congested: false };
}
