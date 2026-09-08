import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptLocalPressure,
  classifyPressure,
  clampFps,
  HEALTHY_SAMPLES_TO_RECOVER,
  initialPressureState,
  lowerFps,
  MIN_FPS,
  PRESSURE_SAMPLES_TO_REDUCE,
  raiseFps,
  type PressureSample,
  type PressureState,
} from '../src/lib/localPressure.js';

const BASE: PressureSample = { targetFps: 60, peers: 1 };

test('congestionamento de rede não é confundido com encoder saturado', () => {
  assert.equal(classifyPressure({ ...BASE, rttMs: 400, fractionLost: 0.2 }), 'network');
  assert.equal(classifyPressure({ ...BASE, qualityLimitationReason: 'cpu' }), 'encode');
  // Encoder estourando o orçamento do quadro é pressão de encode mesmo com a
  // rede perfeita.
  assert.equal(classifyPressure({ ...BASE, averageEncodeMs: 20 }), 'encode');
  assert.equal(classifyPressure({ ...BASE, averageEncodeMs: 5 }), 'none');
});

test('vários espectadores somam no orçamento do quadro', () => {
  // 10 ms por enlace cabe em 16,7 ms sozinho e não cabe com três enlaces.
  assert.equal(classifyPressure({ ...BASE, peers: 1, averageEncodeMs: 10 }), 'none');
  assert.equal(classifyPressure({ ...BASE, peers: 3, averageEncodeMs: 10 }), 'encode');
});

test('captura faminta é separada de encoder e de rede', () => {
  assert.equal(classifyPressure({ ...BASE, framesCapturedDelta: 30, framesDroppedDelta: 20 }), 'capture');
  assert.equal(classifyPressure({ ...BASE, capturedFps: 12 }), 'capture');
  assert.equal(classifyPressure({ ...BASE, capturedFps: 55 }), 'none');
});

test('pintura local descartando quadros recebidos é pressão de render', () => {
  assert.equal(classifyPressure({ ...BASE, renderFramesDelta: 30, renderDroppedDelta: 30 }), 'render');
  assert.equal(classifyPressure({ ...BASE, renderFramesDelta: 60, renderDroppedDelta: 1 }), 'none');
});

test('a estimativa de banda só conta enquanto o teto está sendo usado', () => {
  // Tela parada: envio bem abaixo do teto, estimativa baixa junto. Isso não é
  // congestionamento, e ler assim borrava a live quando a cena voltava.
  assert.equal(classifyPressure({ ...BASE, currentBitrate: 8_000_000, sendingBitrate: 400_000, availableOutgoingBitrate: 1_000_000 }), 'none');
  assert.equal(classifyPressure({ ...BASE, currentBitrate: 8_000_000, sendingBitrate: 7_000_000, availableOutgoingBitrate: 1_000_000 }), 'network');
});

test('o teto de FPS desce sob pressão local com histerese e não a cada amostra', () => {
  let state: PressureState = initialPressureState(60);
  const apertado: PressureSample = { ...BASE, qualityLimitationReason: 'cpu' };
  const primeira = adaptLocalPressure(state, apertado);
  assert.equal(primeira.changed, false, 'uma amostra ruim sozinha não muda nada');
  assert.equal(primeira.pressureSamples, 1);
  state = primeira;
  const segunda = adaptLocalPressure(state, apertado);
  assert.equal(segunda.changed, true);
  assert.equal(segunda.fpsBudget, 48);
  assert.equal(PRESSURE_SAMPLES_TO_REDUCE, 2);
});

test('aperto severo desce dois degraus de uma vez', () => {
  let state: PressureState = initialPressureState(60);
  const severo: PressureSample = { ...BASE, qualityLimitationReason: 'cpu', framesCapturedDelta: 20, framesDroppedDelta: 20 };
  state = adaptLocalPressure(state, severo);
  const decisao = adaptLocalPressure(state, severo);
  assert.equal(decisao.fpsBudget, 30);
});

test('a recuperação é lenta e nunca passa do perfil', () => {
  let state: PressureState = { source: 'encode', pressureSamples: 0, healthySamples: 0, fpsBudget: 30 };
  const calmo: PressureSample = { ...BASE, averageEncodeMs: 2, qualityLimitationReason: 'none' };
  for (let i = 0; i < HEALTHY_SAMPLES_TO_RECOVER - 1; i += 1) {
    const passo = adaptLocalPressure(state, calmo);
    assert.equal(passo.changed, false, `amostra ${i} não deveria subir ainda`);
    state = passo;
  }
  const subiu = adaptLocalPressure(state, calmo);
  assert.equal(subiu.changed, true);
  assert.equal(subiu.fpsBudget, 48);
  // Um perfil de 30 FPS nunca vira 48 por causa de folga.
  const trinta = adaptLocalPressure({ source: 'none', pressureSamples: 0, healthySamples: 99, fpsBudget: 30 }, { ...BASE, targetFps: 30, averageEncodeMs: 1 });
  assert.equal(trinta.fpsBudget, 30);
});

test('congestionamento de rede não derruba o teto de FPS: quem cuida disso é o bitrate', () => {
  let state: PressureState = initialPressureState(60);
  const congestionado: PressureSample = { ...BASE, rttMs: 400 };
  for (let i = 0; i < 6; i += 1) state = adaptLocalPressure(state, congestionado);
  assert.equal(state.fpsBudget, 60);
  assert.equal(state.source, 'network');
});

test('o piso de FPS existe e a escada não passa dele', () => {
  assert.equal(lowerFps(15, 60), MIN_FPS);
  assert.equal(lowerFps(20, 60, true), MIN_FPS);
  assert.equal(raiseFps(60, 60), 60);
  assert.equal(clampFps(999, 30), 30);
  assert.equal(clampFps(45, 60), 30, 'o teto é o degrau mais alto que não passa do pedido');
});
