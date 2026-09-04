import assert from 'node:assert/strict';
import test from 'node:test';
import { activePathMetrics, adaptEncoderScale, adaptScreenBitrate, inboundAudioMetrics, inboundVideoMetrics, median, outboundVideoMetrics } from '../src/lib/networkQuality.js';

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
  assert.deepEqual(metrics, {
    bytesSent: 1234,
    packetsSent: 12,
    fractionLost: 0.04,
    framesEncoded: undefined,
    framesSent: undefined,
    framesPerSecond: undefined,
    totalEncodeTime: undefined,
    qualityLimitationReason: undefined,
  });
});

test('telemetria de vídeo recebido expõe travamentos do decodificador', () => {
  assert.deepEqual(inboundVideoMetrics([
    { id: 'screen', type: 'inbound-rtp', kind: 'video', bytesReceived: 90_000, packetsReceived: 900, framesReceived: 450, framesDecoded: 444, freezeCount: 2, totalFreezesDuration: 1.4 },
  ]), {
    bytesReceived: 90_000,
    packetsReceived: 900,
    framesReceived: 450,
    framesDecoded: 444,
    framesPerSecond: undefined,
    freezeCount: 2,
    totalFreezesDuration: 1.4,
  });
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

test('rota com folga larga recupera o perfil escolhido sem arrastar por minutos', () => {
  const result = adaptScreenBitrate({
    targetBitrate: 5_000_000,
    currentBitrate: 2_000_000,
    healthySamples: 2,
    rttMs: 45,
    availableOutgoingBitrate: 8_000_000,
    fractionLost: 0,
  });
  assert.equal(result.congested, false);
  assert.equal(result.bitrate, 5_000_000);
  assert.equal(result.healthySamples, 0);
});

test('folga modesta ainda sobe em degraus, sem estourar a rota', () => {
  const result = adaptScreenBitrate({
    targetBitrate: 8_000_000,
    currentBitrate: 2_000_000,
    healthySamples: 1,
    rttMs: 40,
    availableOutgoingBitrate: 3_000_000,
    fractionLost: 0,
  });
  assert.equal(result.bitrate, 3_000_000);
});

test('estimativa inicial baixa não derruba a live durante a abertura', () => {
  const warming = adaptScreenBitrate({
    targetBitrate: 8_000_000,
    currentBitrate: 8_000_000,
    healthySamples: 0,
    rttMs: 22,
    availableOutgoingBitrate: 300_000,
    fractionLost: 0,
    warmingUp: true,
  });
  assert.equal(warming.congested, false);
  assert.equal(warming.bitrate, 8_000_000);

  const settled = adaptScreenBitrate({
    targetBitrate: 8_000_000,
    currentBitrate: 8_000_000,
    healthySamples: 0,
    rttMs: 22,
    availableOutgoingBitrate: 300_000,
    fractionLost: 0,
  });
  assert.equal(settled.congested, true);
  assert.ok(settled.bitrate < 8_000_000);
});

test('pressão persistente do encoder reduz resolução para manter FPS', () => {
  const result = adaptEncoderScale({
    targetFps: 60,
    currentScale: 1,
    healthySamples: 0,
    pressureSamples: 1,
    averageEncodeMs: 16,
    qualityLimitationReason: 'cpu',
  });
  assert.equal(result.stressed, true);
  assert.equal(result.scale, 1.25);
  assert.equal(result.pressureSamples, 0);
});

test('congelamento informado pelo receptor reduz resolução imediatamente', () => {
  const result = adaptEncoderScale({
    targetFps: 60,
    currentScale: 1.25,
    healthySamples: 3,
    pressureSamples: 0,
    receiverFrozen: true,
  });
  assert.equal(result.scale, 1.5);
  assert.equal(result.healthySamples, 0);
});

test('encoder saudável recupera resolução aos poucos sem oscilar', () => {
  const result = adaptEncoderScale({
    targetFps: 60,
    currentScale: 1.5,
    healthySamples: 5,
    pressureSamples: 0,
    averageEncodeMs: 5,
    qualityLimitationReason: 'none',
  });
  assert.equal(result.scale, 1.35);
  assert.equal(result.healthySamples, 0);
});

test('adaptação respeita a escala mínima do perfil sem voltar à resolução máxima', () => {
  const result = adaptEncoderScale({
    targetFps: 30,
    currentScale: 2.15,
    minimumScale: 2,
    maximumScale: 4,
    healthySamples: 5,
    pressureSamples: 0,
    averageEncodeMs: 5,
    qualityLimitationReason: 'none',
  });
  assert.equal(result.scale, 2);
});
