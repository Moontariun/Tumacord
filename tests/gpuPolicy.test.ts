import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { decodeCapability, encodeCapability, ozoneSwitches, streamingFeatures } = require('../desktop/gpu-policy.cjs') as {
  decodeCapability: (status: Record<string, string> | null) => { hardwareDecode: boolean | null; detail: string };
  encodeCapability: (status: Record<string, string> | null) => { hardwareEncode: boolean | null; detail: string };
  ozoneSwitches: (platform: string, mitigation?: string) => Array<[string, string]>;
  streamingFeatures: (platform: string, vendors: string[], safeGpuMode?: boolean) => string[];
};

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


// A ausência da bandeira VA-API nunca provou nada sobre NVENC nem sobre
// software encoding. Quem responde é a medição, e ela tem três estados.
test('a capacidade de encode tem "não medido" como estado próprio', () => {
  assert.deepEqual(encodeCapability(null), { hardwareEncode: null, detail: 'não medido' });
  assert.deepEqual(encodeCapability({}), { hardwareEncode: null, detail: 'não medido' });
  assert.equal(encodeCapability({ video_encode: 'disabled_software' }).hardwareEncode, false);
  assert.equal(encodeCapability({ video_encode: 'enabled' }).hardwareEncode, true);
  assert.equal(decodeCapability({ video_decode: 'enabled' }).hardwareDecode, true);
  assert.equal(decodeCapability({ video_decode: 'disabled_software' }).hardwareDecode, false);
  assert.equal(decodeCapability(null).hardwareDecode, null);
});

test('o backend padrão continua sendo a escolha automática; X11 só como comparação', () => {
  assert.deepEqual(ozoneSwitches('linux'), [['ozone-platform-hint', 'auto']]);
  assert.deepEqual(ozoneSwitches('linux', 'reduce-effects'), [['ozone-platform-hint', 'auto']]);
  assert.deepEqual(ozoneSwitches('linux', 'xwayland'), [['ozone-platform', 'x11']]);
});

// Nada de bandeira de Linux no Windows: a linha de comando do processo é a
// primeira coisa que alguém lê ao diagnosticar, e ela não pode mentir.
test('fora do Linux não sai nenhuma bandeira de Ozone', () => {
  for (const plataforma of ['win32', 'darwin']) {
    assert.deepEqual(ozoneSwitches(plataforma), []);
    assert.deepEqual(ozoneSwitches(plataforma, 'xwayland'), []);
  }
});

// A correção da 0.8.9 não é ligar VA-API na NVIDIA. A medição desta máquina
// (Electron 41.10.7, Chromium 146, NVIDIA 610.57.04, Wayland) devolve
// `video_encode: disabled_software`, com ou sem bandeira: não existe encoder
// de vídeo por hardware ali para forçar.
test('NVIDIA continua sem a bandeira VA-API experimental, e isso não é uma afirmação sobre NVENC', () => {
  const features = streamingFeatures('linux', ['0x10de']);
  assert.equal(features.includes('VaapiVideoEncoder'), false);
  assert.equal(features.includes('VaapiOnNvidiaGPUs'), false);
  assert.equal(features.some((feature) => /vulkan|vsync|frame-rate/i.test(feature)), false);
});
