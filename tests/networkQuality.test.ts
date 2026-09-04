import assert from 'node:assert/strict';
import test from 'node:test';
import { activePathMetrics, adaptEncoderScale, adaptScreenBitrate, inboundAudioMetrics, inboundVideoMetrics, median, outboundVideoMetrics, SCALE_HOLD_MS, shouldApplyBitrateChange, shouldApplyScaleChange } from '../src/lib/networkQuality.js';

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

test('encoder saudável recupera resolução sem arrastar por um minuto', () => {
  const result = adaptEncoderScale({
    targetFps: 60,
    currentScale: 1.5,
    healthySamples: 2,
    pressureSamples: 0,
    averageEncodeMs: 5,
    qualityLimitationReason: 'none',
  });
  assert.equal(result.scale, 1.25);
  assert.equal(result.healthySamples, 0);
});

test('cena normal de jogo não conta como encoder atrasado', () => {
  const result = adaptEncoderScale({
    targetFps: 60,
    currentScale: 1,
    healthySamples: 0,
    pressureSamples: 1,
    averageEncodeMs: 14,
    qualityLimitationReason: 'bandwidth',
  });
  assert.equal(result.stressed, false);
  assert.equal(result.scale, 1);
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

test('tela parada não vira congestionamento: a estimativa só vale quando estamos usando o teto', () => {
  const idle = adaptScreenBitrate({
    targetBitrate: 8_000_000,
    currentBitrate: 8_000_000,
    healthySamples: 0,
    rttMs: 12,
    availableOutgoingBitrate: 300_000,
    fractionLost: 0,
    sendingBitrate: 240_000,
  });
  assert.equal(idle.congested, false);
  assert.equal(idle.bitrate, 8_000_000);
});

test('com o teto realmente em uso, a estimativa volta a valer', () => {
  const busy = adaptScreenBitrate({
    targetBitrate: 8_000_000,
    currentBitrate: 8_000_000,
    healthySamples: 0,
    rttMs: 12,
    availableOutgoingBitrate: 3_000_000,
    fractionLost: 0,
    sendingBitrate: 7_400_000,
  });
  assert.equal(busy.congested, true);
  assert.ok(busy.bitrate < 8_000_000);
});

test('perda e latência continuam derrubando o bitrate mesmo com pouco envio', () => {
  const lossy = adaptScreenBitrate({
    targetBitrate: 8_000_000,
    currentBitrate: 8_000_000,
    healthySamples: 0,
    rttMs: 400,
    fractionLost: 0.12,
    sendingBitrate: 120_000,
  });
  assert.equal(lossy.congested, true);
});

test('a resolução só muda quando a diferença importa e depois de segurar', () => {
  // Ruído: meia amostra de diferença não vale um keyframe.
  assert.equal(shouldApplyScaleChange({ currentScale: 1.5, nextScale: 1.6, msSinceChange: 60_000 }), false);
  // Diferença real, mas cedo demais depois da última mudança.
  assert.equal(shouldApplyScaleChange({ currentScale: 1, nextScale: 1.25, msSinceChange: 4_000 }), false);
  assert.equal(shouldApplyScaleChange({ currentScale: 1, nextScale: 1.25, msSinceChange: SCALE_HOLD_MS }), true);
  // Salto grande é aperto de verdade e não espera.
  assert.equal(shouldApplyScaleChange({ currentScale: 1, nextScale: 1.75, msSinceChange: 500 }), true);
});

test('o teto de bitrate não é reaplicado por ruído', () => {
  assert.equal(shouldApplyBitrateChange(8_000_000, 8_050_000), false);
  assert.equal(shouldApplyBitrateChange(8_000_000, 6_400_000), true);
  assert.equal(shouldApplyBitrateChange(1_000_000, 1_160_000), true);
  assert.equal(shouldApplyBitrateChange(1_000_000, 1_060_000), false);
});
