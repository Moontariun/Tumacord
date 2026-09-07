import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { streamingFeatures } = require('../desktop/gpu-policy.cjs') as { streamingFeatures: (platform: string, vendors: string[], safeGpuMode?: boolean) => string[] };

test('AMD e Intel habilitam o encoder VA-API suportado no Linux', () => {
  assert.equal(streamingFeatures('linux', ['0x1002']).includes('VaapiVideoEncoder'), true);
  assert.equal(streamingFeatures('linux', ['0x8086']).includes('VaapiVideoEncoder'), true);
});

test('NVIDIA não recebe a flag VA-API experimental que causa instabilidade', () => {
  const features = streamingFeatures('linux', ['0x10de']);
  assert.equal(features.includes('VaapiVideoEncoder'), false);
  assert.equal(features.includes('VaapiOnNvidiaGPUs'), false);
  assert.equal(features.includes('WebRTCPipeWireCapturer'), true);
});

test('modo seguro remove aceleração forçada também em AMD e Intel', () => {
  assert.equal(streamingFeatures('linux', ['0x1002'], true).includes('VaapiVideoEncoder'), false);
  assert.equal(streamingFeatures('linux', ['0x8086'], true).includes('VaapiVideoEncoder'), false);
  assert.equal(streamingFeatures('linux', ['0x8086'], true).includes('WebRTCPipeWireCapturer'), true);
});

// PipeWire e as decorações do Wayland são do Linux. No Windows a captura de
// tela e o loopback de áudio vêm do próprio Chromium, e a lista precisa sair
// vazia — o processo não deve nascer anunciando bandeiras de outro sistema.
test('fora do Linux nenhuma bandeira de PipeWire ou Wayland é ligada', () => {
  for (const plataforma of ['win32', 'darwin']) {
    assert.deepEqual(streamingFeatures(plataforma, []), [], `${plataforma} não usa PipeWire`);
    assert.deepEqual(streamingFeatures(plataforma, ['0x8086']), [], `nem com GPU Intel`);
    assert.deepEqual(streamingFeatures(plataforma, ['0x1002'], true), [], `nem em modo seguro`);
  }
});
