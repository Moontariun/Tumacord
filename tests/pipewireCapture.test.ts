import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PcmFramer, captureRoutePlan, captureArguments, CAPTURE_NAME, PipewireStreamCapture } = require('../desktop/pipewire-capture.cjs');
const { LinuxScreenAudioBridge } = require('../desktop/screen-audio.cjs');

test('blocos saem sempre com quadros inteiros, mesmo com pedaços cortados no meio de uma amostra', () => {
  const blocos: Buffer[] = [];
  const framer = new PcmFramer((bloco: Buffer) => blocos.push(Buffer.from(bloco)), 16);
  framer.push(Buffer.from([1, 2, 3, 4, 5, 6, 7]));
  framer.push(Buffer.from([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]));
  assert.equal(blocos.length, 1);
  assert.deepEqual([...blocos[0]], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  framer.push(Buffer.from([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]));
  assert.equal(blocos.length, 2);
  assert.equal(blocos[1][0], 17);
});

test('o fluxo de captura não é dispositivo: não se liga a nada sozinho e sai em float cru', () => {
  const args = captureArguments();
  assert.ok(args.includes('--raw'));
  assert.deepEqual(args.slice(args.indexOf('--target'), args.indexOf('--target') + 2), ['--target', '0']);
  assert.ok(args[args.indexOf('--format') + 1] === 'f32');
  const propriedades = args[args.indexOf('-P') + 1];
  assert.match(propriedades, new RegExp(`node.name = "${CAPTURE_NAME}"`));
  assert.match(propriedades, /node.autoconnect = false/);
  assert.doesNotMatch(propriedades, /media.class = "Audio\/(Sink|Source)"/, 'dispositivo é justamente o que não se quer');
});

const GRAFO = [
  { id: 50, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': CAPTURE_NAME, 'application.process.id': 999, 'media.class': 'Stream/Input/Audio' } } },
  { id: 51, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': CAPTURE_NAME, 'application.process.id': 111, 'media.class': 'Stream/Input/Audio' } } },
  { id: 20, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'Firefox', 'application.name': 'Firefox', 'media.class': 'Stream/Output/Audio' } } },
  { id: 21, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'WEBRTC VoiceEngine', 'application.process.binary': 'Discord', 'media.class': 'Stream/Output/Audio' } } },
  { id: 500, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 50, 'port.direction': 'in', 'audio.channel': 'FL' } } },
  { id: 501, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 50, 'port.direction': 'in', 'audio.channel': 'FR' } } },
  { id: 502, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 50, 'port.direction': 'out', 'audio.channel': 'FL' } } },
  { id: 510, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 51, 'port.direction': 'in', 'audio.channel': 'FL' } } },
  { id: 200, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 20, 'port.direction': 'out', 'audio.channel': 'FL' } } },
  { id: 201, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 20, 'port.direction': 'out', 'audio.channel': 'FR' } } },
  { id: 210, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 21, 'port.direction': 'out', 'audio.channel': 'FL' } } },
];

test('aplicativos vão para o nó de captura DESTE processo; a call fica de fora', () => {
  const plano = captureRoutePlan(GRAFO, 999);
  assert.equal(plano.captureFound, true);
  assert.deepEqual(plano.links, [['200', '500'], ['201', '501']]);
});

test('um nó que sobrou de uma execução anterior não recebe nada', () => {
  assert.deepEqual(captureRoutePlan(GRAFO, 4242), { captureFound: false, links: [] });
});

function processoFalso(pid: number) {
  const filho = Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { this.killed = true; setImmediate(() => this.emit('exit', 0)); return true; } });
  return filho;
}

test('prepara, liga as saídas e entrega o PCM em blocos; parar encerra o processo', async () => {
  const blocos: number[] = [];
  const ligados: string[][] = [];
  let filho: ReturnType<typeof processoFalso> | null = null;
  const captura = new PipewireStreamCapture({
    platform: 'linux',
    retryDelayMs: 1,
    intervalMs: 60_000,
    spawn: () => { filho = processoFalso(999); return filho; },
    execFile: async (command: string, args: string[]) => {
      if (command === 'pw-record') return { stdout: 'uso: pw-record --raw ...' };
      if (command === 'pw-link' && args[0] === '-L') ligados.push(args.slice(1));
      return { stdout: '' };
    },
    pipewireGraph: async () => GRAFO,
    onPcm: (bloco: Buffer) => blocos.push(bloco.length),
  });
  const preparado = await captura.prepare();
  assert.deepEqual({ ok: preparado.ok, mode: preparado.mode }, { ok: true, mode: 'stream' });
  assert.deepEqual(ligados, [['200', '500'], ['201', '501']]);
  filho!.stdout.emit('data', Buffer.alloc(3_840 + 100));
  assert.deepEqual(blocos, [3_840]);
  // Preparar de novo é a verificação de saúde: nada de processo novo.
  const antes = filho;
  await captura.prepare();
  assert.equal(filho, antes);
  await captura.stop();
  assert.equal(antes!.killed, true);
  assert.equal(captura.diagnostics().active, false);
});

test('sem `pw-record --raw`, a ponte do Linux cai no barramento antigo', async () => {
  const chamadas: string[] = [];
  const bridge = new LinuxScreenAudioBridge({
    capture: { available: async () => false, prepare: async () => ({ ok: true }), stop: async () => ({ ok: true }), reset: async () => ({ ok: true }) },
    router: { active: true, links: new Set(), available: async () => { chamadas.push('available'); return true; }, prepare: async () => { chamadas.push('prepare'); return { ok: true, deviceName: 'Tumacord Stream Audio' }; }, stop: async () => ({ ok: true }), reset: async () => ({ ok: true }) },
  });
  const resultado = await bridge.prepare();
  assert.equal(resultado.mode, 'device');
  assert.deepEqual(chamadas, ['available', 'prepare']);
  assert.equal(bridge.capabilities().mode, 'device');
});

test('com a captura disponível, a ponte do Linux entrega por stream e não monta dispositivo', async () => {
  let roteadorUsado = false;
  const bridge = new LinuxScreenAudioBridge({
    capture: { available: async () => true, prepare: async () => ({ ok: true, deviceName: '' }), stop: async () => ({ ok: true }), reset: async () => ({ ok: true }), diagnostics: () => ({ mechanism: 'pipewire-capture' }) },
    router: { available: async () => true, prepare: async () => { roteadorUsado = true; return { ok: true }; }, stop: async () => ({ ok: true }), reset: async () => ({ ok: true }) },
  });
  assert.equal(await bridge.available(), true);
  const resultado = await bridge.prepare();
  assert.deepEqual({ mode: resultado.mode, isolation: resultado.isolation }, { mode: 'stream', isolation: 'bus' });
  assert.equal(roteadorUsado, false);
  assert.equal(bridge.capabilities().mode, 'stream');
  assert.equal(bridge.diagnostics().mechanism, 'pipewire-capture');
});
