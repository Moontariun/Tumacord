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
