import assert from 'node:assert/strict';
import test from 'node:test';
import { activePathMetrics, adaptScreenBitrate, inboundAudioMetrics, median, outboundVideoMetrics } from '../src/lib/networkQuality.js';

test('latência usa o par ICE selecionado e ignora rota antiga', () => {
  const metrics = activePathMetrics([
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'active' },
    { id: 'old', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.9, bytesSent: 99_000_000 },
    { id: 'active', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.042, availableOutgoingBitrate: 8_000_000 },
  ]);
  assert.equal(metrics.rttMs, 42);
  assert.equal(metrics.availableOutgoingBitrate, 8_000_000);
});

test('rota nomeada é preferida quando o transporte não informa o id', () => {
  const metrics = activePathMetrics([
    { id: 'stale', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.8, bytesSent: 8_000_000 },
    { id: 'active', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.031 },
  ]);
  assert.equal(metrics.rttMs, 31);
});

test('mediana evita que um caminho isolado distorça a latência da call', () => {
  assert.equal(median([35, 38, 900]), 38);
  assert.equal(median([30, 40]), 35);
});

test('telemetria de vídeo associa perda remota ao envio selecionado', () => {
  const metrics = outboundVideoMetrics([
    { id: 'out', type: 'outbound-rtp', kind: 'video', bytesSent: 1234, packetsSent: 12, remoteId: 'remote' },
    { id: 'remote', type: 'remote-inbound-rtp', localId: 'out', fractionLost: 0.04 },
  ]);
  assert.deepEqual(metrics, { bytesSent: 1234, packetsSent: 12, fractionLost: 0.04 });
});

test('telemetria de voz soma apenas pacotes de áudio recebidos', () => {
  assert.deepEqual(inboundAudioMetrics([
    { id: 'voice-a', type: 'inbound-rtp', kind: 'audio', bytesReceived: 4_000, packetsReceived: 40 },
    { id: 'voice-b', type: 'inbound-rtp', mediaType: 'audio', bytesReceived: 2_000, packetsReceived: 20 },
    { id: 'screen', type: 'inbound-rtp', kind: 'video', bytesReceived: 90_000, packetsReceived: 900 },
  ]), { bytesReceived: 6_000, packetsReceived: 60 });
});

test('congestionamento derruba bitrate rapidamente sem chegar a zero', () => {
  const result = adaptScreenBitrate({
    targetBitrate: 14_000_000,
    currentBitrate: 14_000_000,
    healthySamples: 2,
    rttMs: 430,
    availableOutgoingBitrate: 2_000_000,
    fractionLost: 0.1,
  });
  assert.equal(result.congested, true);
  assert.equal(result.bitrate, 1_500_000);
  assert.equal(result.healthySamples, 0);
});

test('bitrate volta gradualmente depois de três amostras saudáveis', () => {
  const result = adaptScreenBitrate({
    targetBitrate: 5_000_000,
    currentBitrate: 2_000_000,
    healthySamples: 2,
    rttMs: 45,
    availableOutgoingBitrate: 8_000_000,
    fractionLost: 0,
  });
  assert.equal(result.congested, false);
  assert.equal(result.bitrate, 2_300_000);
  assert.equal(result.healthySamples, 0);
});
