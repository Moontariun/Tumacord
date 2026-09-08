import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createScreenAudioRouter, LinuxScreenAudioBridge, UnsupportedScreenAudioBridge } = require('../desktop/screen-audio.cjs') as {
  createScreenAudioRouter: (options?: Record<string, unknown>) => Bridge;
  LinuxScreenAudioBridge: new (options?: Record<string, unknown>) => Bridge;
  UnsupportedScreenAudioBridge: new () => Bridge;
};
const { WindowsScreenAudioRouter } = require('../desktop/windows-audio-router.cjs') as {
  WindowsScreenAudioRouter: new (options?: Record<string, unknown>) => unknown;
};

interface Bridge {
  available: () => Promise<boolean>;
  prepare: (request?: unknown) => Promise<Record<string, unknown>>;
  stop: () => Promise<{ ok: boolean }>;
  reset: () => Promise<{ ok: boolean }>;
  capabilities: () => { mode: string; supported: boolean | null };
  diagnostics: () => Record<string, unknown>;
}

// Um roteador do Linux de mentira: o de verdade fala com o PipeWire, e o que
// interessa aqui é que a ponte não mude o que ele faz.
function fakeLinuxRouter(result: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    router: {
      active: true,
      links: new Set(['1:2', '3:4']),
      available: async () => { calls.push('available'); return true; },
      prepare: async (...args: unknown[]) => { calls.push(`prepare(${args.length})`); return result; },
      stop: async () => { calls.push('stop'); return { ok: true }; },
      reset: async () => { calls.push('reset'); return { ok: true }; },
    },
  };
}

test('no Linux a fábrica devolve a ponte do PipeWire, não a do Windows', () => {
  const bridge = createScreenAudioRouter({ platform: 'linux', router: fakeLinuxRouter({ ok: true }).router });
  assert.ok(bridge instanceof LinuxScreenAudioBridge);
});

test('no Windows a fábrica devolve o roteador de captura por processo', () => {
  const bridge = createScreenAudioRouter({ platform: 'win32', helperPath: '' });
  assert.ok(bridge instanceof WindowsScreenAudioRouter);
});

test('em outro sistema a recusa é explícita, sem procurar componente nenhum', async () => {
  const bridge = createScreenAudioRouter({ platform: 'darwin' });
  assert.ok(bridge instanceof UnsupportedScreenAudioBridge);
  assert.equal(await bridge.available(), false);
  const result = await bridge.prepare({ sourceId: 'screen:0:0' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported');
});

// O roteador do Linux monta o mesmo barramento para qualquer fonte. Passar o
// identificador da janela adiante não mudaria nada e só criaria a chance de
// alguém, um dia, fazer o Linux depender dele.
test('a ponte do Linux não repassa a fonte escolhida ao roteador do PipeWire', async () => {
  const { router, calls } = fakeLinuxRouter({ ok: true, deviceId: 'tumacord_stream_source', deviceName: 'Tumacord Stream Audio' });
  const bridge = new LinuxScreenAudioBridge({ router });
  const result = await bridge.prepare({ sourceId: 'window:12345:0' });
  assert.deepEqual(calls, ['prepare(0)']);
  assert.equal(result.ok, true);
  assert.equal(result.deviceName, 'Tumacord Stream Audio');
});

test('o resultado do Linux ganha o modo de dispositivo sem perder nada do que já tinha', async () => {
  const { router } = fakeLinuxRouter({ ok: true, deviceId: 'tumacord_stream_source', deviceName: 'Tumacord Stream Audio' });
  const bridge = new LinuxScreenAudioBridge({ router });
  const result = await bridge.prepare();
  assert.equal(result.mode, 'device');
  assert.equal(result.isolation, 'bus');
  assert.equal(result.deviceId, 'tumacord_stream_source');
});

test('uma falha do PipeWire chega intacta, sem virar modo nenhum', async () => {
  const { router } = fakeLinuxRouter({ ok: false, error: 'pactl/PipeWire não está disponível.' });
  const bridge = new LinuxScreenAudioBridge({ router });
  const result = await bridge.prepare();
  assert.equal(result.ok, false);
  assert.equal(result.mode, undefined);
  assert.match(String(result.error), /PipeWire/);
});

test('parar e reiniciar continuam indo direto ao roteador do PipeWire', async () => {
  const { router, calls } = fakeLinuxRouter({ ok: true });
  const bridge = new LinuxScreenAudioBridge({ router });
  await bridge.stop();
  await bridge.reset();
  assert.equal(await bridge.available(), true);
  assert.deepEqual(calls, ['stop', 'reset', 'available']);
});

test('o diagnóstico do Linux descreve o barramento e não inventa capacidade', () => {
  const { router } = fakeLinuxRouter({ ok: true });
  const bridge = new LinuxScreenAudioBridge({ router });
  assert.deepEqual(bridge.diagnostics(), { platform: 'linux', mechanism: 'pipewire-bus', active: true, isolation: 'bus', links: 2 });
  assert.deepEqual(bridge.capabilities(), { mode: 'device', supported: null, isolation: 'bus' });
});
