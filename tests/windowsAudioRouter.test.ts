import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { WindowsScreenAudioRouter } = require('../desktop/windows-audio-router.cjs') as {
  WindowsScreenAudioRouter: new (options?: Record<string, unknown>) => Router;
};

interface PrepareResult {
  ok: boolean;
  mode?: string;
  isolation?: string;
  sources?: number;
  code?: string;
  error?: string;
}

interface Router {
  prepare: (request?: { sourceId?: string }) => Promise<PrepareResult>;
  stop: () => Promise<{ ok: boolean }>;
  available: () => Promise<boolean>;
  capabilities: () => { mode: string; supported: boolean | null; reason: string };
  diagnostics: () => Record<string, unknown>;
  child: unknown;
}

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 0x54;
  header[1] = 0x41;
  header[2] = type;
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function eventFrame(value: unknown): Buffer {
  return frame(2, Buffer.from(JSON.stringify(value), 'utf8'));
}

interface HelperOptions {
  processLoopback?: boolean;
  build?: number;
  window?: { pid: number; exe: string };
  sessions?: unknown[];
  silentReady?: boolean;
}

// Um helper de mentira. Ele existe só nos testes: o de produção é o binário
// nativo, e nada aqui substitui aquele caminho no aplicativo.
class FakeHelper extends EventEmitter {
  stdout = new EventEmitter();
  commands: string[] = [];
  killed = false;
  exited = false;
  stdin = {
    writable: true,
    write: (chunk: string) => {
      this.commands.push(chunk.trim());
      this.respond(chunk.trim());
      return true;
    },
    // O helper de verdade sai quando o stdin fecha: é assim que ele nunca fica
    // órfão se o Tumacord for encerrado à força.
    end: () => this.exit(),
  };

  constructor(private readonly options: HelperOptions, private readonly probeMode: boolean) {
    super();
    setImmediate(() => this.announce());
  }

  announce() {
    if (this.probeMode) {
      this.stdout.emit('data', eventFrame({
        event: 'probe',
        protocol: 1,
        processLoopback: this.options.processLoopback ?? true,
        build: this.options.build ?? 22631,
      }));
      this.exit();
      return;
    }
    if (this.options.silentReady) return;
    this.stdout.emit('data', eventFrame({
      event: 'ready',
      protocol: 1,
      processLoopback: this.options.processLoopback ?? true,
      build: this.options.build ?? 22631,
      pid: 4242,
    }));
  }

  respond(command: string) {
    if (command.startsWith('WINDOW')) {
      const target = this.options.window ?? { pid: 0, exe: '' };
      this.stdout.emit('data', eventFrame({ event: 'window', hwnd: Number(command.split(' ')[1]), pid: target.pid, exe: target.exe, ancestors: [] }));
      return;
    }
    if (command === 'SCAN') {
      if (this.options.sessions) this.stdout.emit('data', eventFrame({ event: 'sessions', items: this.options.sessions }));
      return;
    }
    if (command.startsWith('CAPTURE')) {
      const list = command.slice(7).trim();
      const pids = list ? list.split(',').map(Number) : [];
      this.stdout.emit('data', eventFrame({ event: 'capturing', pids, failed: [] }));
      return;
    }
    if (command === 'STOP') {
      this.stdout.emit('data', eventFrame({ event: 'stopped' }));
      return;
    }
    if (command === 'QUIT') this.exit();
  }

  pushSessions(items: unknown[]) {
    this.stdout.emit('data', eventFrame({ event: 'sessions', items }));
  }

  pushPcm(samples: Float32Array) {
    this.stdout.emit('data', frame(1, Buffer.from(samples.buffer)));
  }

  exit() {
    if (this.exited) return;
    this.exited = true;
    this.stdin.writable = false;
    setImmediate(() => this.emit('exit', 0, null));
  }

  kill() {
    this.killed = true;
    this.exit();
    return true;
  }
}

function makeRouter(options: HelperOptions & Record<string, unknown> = {}) {
  const helpers: FakeHelper[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const pcm: Buffer[] = [];
  const router = new WindowsScreenAudioRouter({
    platform: 'win32',
    helperPath: 'C:/fake/tumacord-audio-helper.exe',
    selfPids: [10],
    commandTimeoutMs: 500,
    restartBaseMs: 5,
    onPcm: (payload: Buffer) => pcm.push(Buffer.from(payload)),
    onDiagnostic: (details: Record<string, unknown>) => diagnostics.push(details),
    spawn: (_path: string, args: string[]) => {
      const helper = new FakeHelper(options, args?.[0] === '--probe');
      helpers.push(helper);
      return helper;
    },
    ...options,
  });
  return { router, helpers, diagnostics, pcm };
}


function session(pid: number, exe: string, extra: Record<string, unknown> = {}) {
  return { pid, exe, active: true, expired: false, system: false, ancestors: [], ...extra };
}

test('uma janela vira uma captura da árvore daquele processo', async () => {
  const { router, helpers } = makeRouter({ window: { pid: 3100, exe: 'game.exe' } });
  const result = await router.prepare({ sourceId: 'window:98765:0' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'stream');
  assert.equal(result.isolation, 'process');
  assert.equal(result.sources, 1);
  const helper = helpers.at(-1)!;
  assert.deepEqual(helper.commands, ['WINDOW 98765', 'CAPTURE 3100']);
  await router.stop();
});

test('um monitor inteiro captura as aplicações permitidas e nenhuma bloqueada', async () => {
  const { router, helpers } = makeRouter({
    sessions: [session(100, 'game.exe'), session(200, 'Discord.exe'), session(10, 'Tumacord.exe')],
  });
  const result = await router.prepare({ sourceId: 'screen:0:0' });
  assert.equal(result.ok, true);
  assert.equal(result.isolation, 'system');
  const helper = helpers.at(-1)!;
  assert.ok(helper.commands.includes('SCAN'));
  const capture = helper.commands.filter((command) => command.startsWith('CAPTURE')).at(-1);
  assert.equal(capture, 'CAPTURE 100', 'só o jogo pode entrar; Discord e Tumacord ficam de fora');
  await router.stop();
});

test('o Discord aberto no meio da live não entra no áudio compartilhado', async () => {
  const { router, helpers } = makeRouter({ sessions: [session(100, 'game.exe')] });
  await router.prepare({ sourceId: 'screen:0:0' });
  const helper = helpers.at(-1)!;
  helper.pushSessions([session(100, 'game.exe'), session(900, 'Discord.exe'), session(901, 'DiscordHelper.exe', { ancestors: [{ pid: 900, exe: 'Discord.exe' }] })]);
  await new Promise((resolve) => setImmediate(resolve));
  const capture = helper.commands.filter((command) => command.startsWith('CAPTURE')).at(-1);
  assert.equal(capture, 'CAPTURE 100');
  await router.stop();
});

test('um aplicativo novo com som entra sem recomeçar a transmissão', async () => {
  const { router, helpers } = makeRouter({ sessions: [session(100, 'game.exe')] });
  await router.prepare({ sourceId: 'screen:0:0' });
  const helper = helpers.at(-1)!;
  helper.pushSessions([session(100, 'game.exe'), session(300, 'spotify.exe')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(helper.commands.filter((command) => command.startsWith('CAPTURE')).at(-1), 'CAPTURE 100,300');
  assert.equal(helpers.filter((entry) => !entry.exited).length, 1, 'nenhum helper extra foi criado');
  await router.stop();
});

test('preparar duas vezes a mesma fonte não recaptura nada', async () => {
  const { router, helpers } = makeRouter({ window: { pid: 3100, exe: 'game.exe' } });
  await router.prepare({ sourceId: 'window:98765:0' });
  const helper = helpers.at(-1)!;
  const before = helper.commands.length;
  const again = await router.prepare({ sourceId: 'window:98765:0' });
  assert.equal(again.ok, true);
  assert.equal(helper.commands.length, before, 'a verificação de saúde não pode cortar o áudio');
  await router.stop();
});

test('parar duas vezes é seguro e encerra o componente uma única vez', async () => {
  const { router, helpers } = makeRouter({ window: { pid: 3100, exe: 'game.exe' } });
  await router.prepare({ sourceId: 'window:98765:0' });
  const helper = helpers.at(-1)!;
  assert.equal((await router.stop()).ok, true);
  assert.equal((await router.stop()).ok, true);
  assert.equal(helper.exited, true);
  assert.equal(router.child, null);
});

test('uma janela que sumiu devolve erro e libera o componente', async () => {
  const { router } = makeRouter({ window: { pid: 0, exe: '' } });
  const result = await router.prepare({ sourceId: 'window:98765:0' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /não está mais aberta/);
  assert.equal(router.child, null, 'o helper não pode ficar vivo depois de uma falha');
});

test('a janela de um aplicativo bloqueado nunca vira captura', async () => {
  const { router } = makeRouter({ window: { pid: 900, exe: 'DiscordPTB.exe' } });
  const result = await router.prepare({ sourceId: 'window:98765:0' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /não pode ser transmitido/);
});

// Sem isolamento, a única reserva possível seria o loopback do dispositivo
// inteiro. É exatamente ele que devolve a call para dentro da live, então a
// resposta certa é recusar o áudio — e dizer isso com todas as letras.
test('sem loopback por processo o áudio é recusado, sem cair no loopback do sistema', async () => {
  const { router, helpers } = makeRouter({ processLoopback: false, build: 18363 });
  const result = await router.prepare({ sourceId: 'screen:0:0' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'process-loopback-unavailable');
  assert.match(String(result.error), /continuará sem áudio/);
  assert.equal(helpers.filter((helper) => !helper.exited).length, 0);
  assert.equal(await router.available(), false);
  assert.equal(router.capabilities().supported, false);
});

test('uma fonte que não é tela nem janela é recusada antes de qualquer captura', async () => {
  const { router, helpers } = makeRouter({});
  const result = await router.prepare({ sourceId: 'algo-inventado' });
  assert.equal(result.ok, false);
  assert.equal(helpers.length, 0, 'nem a sondagem precisa rodar para um identificador inválido');
});

test('o PCM do componente chega inteiro ao processo principal', async () => {
  const { router, helpers, pcm } = makeRouter({ window: { pid: 3100, exe: 'game.exe' } });
  await router.prepare({ sourceId: 'window:98765:0' });
  const helper = helpers.at(-1)!;
  const samples = new Float32Array([0.1, -0.1, 0.2, -0.2]);
  helper.pushPcm(samples);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pcm.length, 1);
  assert.deepEqual([...new Float32Array(pcm[0].buffer, pcm[0].byteOffset, 4)], [...samples]);
  await router.stop();
});

test('um componente que morre no meio da live é reconstruído', async () => {
  const { router, helpers, diagnostics } = makeRouter({ window: { pid: 3100, exe: 'game.exe' } });
  await router.prepare({ sourceId: 'window:98765:0' });
  const first = helpers.at(-1)!;
  first.exit();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(diagnostics.some((entry) => entry.event === 'screen-audio-helper-gone'), 'a queda precisa aparecer no diagnóstico');
  const rebuilt = helpers.at(-1)!;
  assert.notEqual(rebuilt, first);
  assert.deepEqual(rebuilt.commands, ['WINDOW 98765', 'CAPTURE 3100']);
  await router.stop();
});

test('fora do Windows o roteador recusa em vez de procurar o componente', async () => {
  const { router, helpers } = makeRouter({ platform: 'linux' });
  const result = await router.prepare({ sourceId: 'screen:0:0' });
  assert.equal(result.ok, false);
  assert.equal(helpers.length, 0);
  assert.equal(await router.available(), false);
});

test('o diagnóstico conta fontes incluídas e excluídas sem citar nome nenhum', async () => {
  const { router } = makeRouter({ sessions: [session(100, 'game.exe'), session(200, 'Discord.exe')] });
  await router.prepare({ sourceId: 'screen:0:0' });
  const report = router.diagnostics();
  assert.equal(report.mechanism, 'wasapi-process-loopback');
  assert.equal(report.isolation, 'system');
  assert.equal(report.sources, 1);
  assert.equal(report.excluded, 1);
  assert.deepEqual(report.excludedReasons, { 'blocked-executable': 1 });
  const serialized = JSON.stringify(report);
  assert.equal(/discord|game\.exe/i.test(serialized), false, 'o relatório não carrega nome de aplicativo');
  await router.stop();
});

