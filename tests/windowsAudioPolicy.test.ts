import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  BLOCKED_EXECUTABLES,
  captureCommand,
  createFrameDecoder,
  isBlockedExecutable,
  normalizeExecutable,
  parseEvent,
  selectCaptureRoots,
  sourceKindFromId,
  windowCommand,
  windowHandleFromSourceId,
} = require('../desktop/windows-audio-policy.cjs') as {
  BLOCKED_EXECUTABLES: readonly string[];
  captureCommand: (pids: unknown) => string;
  createFrameDecoder: () => (chunk: Buffer) => Array<{ type: number; payload: Buffer }>;
  isBlockedExecutable: (value: unknown) => boolean;
  normalizeExecutable: (value: unknown) => string;
  parseEvent: (payload: Buffer) => Record<string, unknown> | null;
  selectCaptureRoots: (input: unknown) => {
    roots: number[];
    included: Array<{ pid: number; exe: string; active: boolean }>;
    excluded: Array<{ pid: number; exe: string; reason: string }>;
  };
  sourceKindFromId: (value: unknown) => string;
  windowCommand: (handle: unknown) => string;
  windowHandleFromSourceId: (value: unknown) => number;
};

function session(pid: number, exe: string, extra: Record<string, unknown> = {}) {
  return { pid, exe, active: true, expired: false, system: false, ancestors: [], ...extra };
}

function reasonFor(result: ReturnType<typeof selectCaptureRoots>, pid: number): string {
  return result.excluded.find((entry) => entry.pid === pid)?.reason ?? '';
}

test('o executável é comparado sem caminho e sem caixa', () => {
  assert.equal(normalizeExecutable('C:\\Program Files\\Discord\\Discord.exe'), 'discord.exe');
  assert.equal(normalizeExecutable('/opt/Discord/DISCORD.EXE'), 'discord.exe');
  assert.equal(normalizeExecutable(42), '');
});

test('os três canais do Discord e o próprio Tumacord estão bloqueados', () => {
  for (const executable of ['Discord.exe', 'DiscordCanary.exe', 'DiscordPTB.exe', 'DiscordDevelopment.exe', 'Tumacord.exe', 'tumacord-audio-helper.exe']) {
    assert.equal(isBlockedExecutable(executable), true, `${executable} precisa ficar fora da live`);
  }
  assert.equal(isBlockedExecutable('game.exe'), false);
  assert.equal(isBlockedExecutable('chrome.exe'), false);
  // A lista é o contrato desta proteção: um item removido sem querer volta a
  // devolver a voz da call pela transmissão.
  assert.ok(BLOCKED_EXECUTABLES.includes('discord.exe'));
});

test('o áudio de um jogo entra e o do Discord não', () => {
  const result = selectCaptureRoots({
    sessions: [session(100, 'game.exe'), session(200, 'Discord.exe'), session(300, 'chrome.exe')],
    selfPids: [10],
  });
  assert.deepEqual(result.roots.sort((left, right) => left - right), [100, 300]);
  assert.equal(reasonFor(result, 200), 'blocked-executable');
});

// O Discord é Electron: o processo que toca o som é um filho, e em versões
// recentes ele nem sempre carrega o mesmo nome de executável. O que identifica
// com segurança é a árvore.
test('um processo auxiliar do Discord é bloqueado pelo ancestral', () => {
  const result = selectCaptureRoots({
    sessions: [session(501, 'DiscordAudioHelper.exe', { ancestors: [{ pid: 500, exe: 'DiscordCanary.exe' }] })],
    selfPids: [10],
  });
  assert.deepEqual(result.roots, []);
  assert.equal(reasonFor(result, 501), 'blocked-ancestor');
});

test('os processos do próprio Tumacord ficam fora mesmo com outro nome', () => {
  const result = selectCaptureRoots({
    sessions: [
      session(11, 'algum-utilitario.exe', { ancestors: [{ pid: 10, exe: 'algum-utilitario.exe' }] }),
      session(10, 'algum-utilitario.exe'),
    ],
    selfPids: [10],
  });
  assert.deepEqual(result.roots, []);
  assert.equal(reasonFor(result, 10), 'self');
  assert.equal(reasonFor(result, 11), 'self');
});

// Capturar a árvore do pai e a do filho entregaria o mesmo som duas vezes, com
// o dobro da amplitude e um eco curto entre as duas capturas.
test('pai e filho da mesma aplicação viram uma única captura', () => {
  const result = selectCaptureRoots({
    sessions: [
      session(700, 'chrome.exe'),
      session(701, 'chrome.exe', { ancestors: [{ pid: 700, exe: 'chrome.exe' }] }),
      session(702, 'chrome.exe', { ancestors: [{ pid: 701, exe: 'chrome.exe' }, { pid: 700, exe: 'chrome.exe' }] }),
    ],
    selfPids: [],
  });
  assert.deepEqual(result.roots, [700]);
  assert.equal(reasonFor(result, 701), 'covered-by-ancestor');
  assert.equal(reasonFor(result, 702), 'covered-by-ancestor');
});

test('sessões encerradas e os sons do sistema não viram captura', () => {
  const result = selectCaptureRoots({
    sessions: [session(800, 'antigo.exe', { expired: true }), session(801, '', { system: true })],
    selfPids: [],
  });
  assert.deepEqual(result.roots, []);
  assert.equal(reasonFor(result, 800), 'expired');
  assert.equal(reasonFor(result, 801), 'system-sounds');
});

// Um aplicativo que abre no meio da live precisa entrar; um que fecha precisa
// sair. A política é recalculada do zero a cada aviso, então o teste é a
// segunda chamada com a lista nova.
test('a lista é recalculada quando um processo abre ou fecha durante a live', () => {
  const antes = selectCaptureRoots({ sessions: [session(100, 'game.exe')], selfPids: [] });
  assert.deepEqual(antes.roots, [100]);
  const depois = selectCaptureRoots({
    sessions: [session(100, 'game.exe'), session(200, 'Discord.exe'), session(300, 'spotify.exe')],
    selfPids: [],
  });
  assert.deepEqual(depois.roots.sort((left, right) => left - right), [100, 300]);
  assert.equal(reasonFor(depois, 200), 'blocked-executable');
});

// O mesmo aplicativo reiniciado aparece com outro PID. Nada aqui guarda estado
// entre chamadas, e é isso que faz a reconstrução funcionar sozinha.
test('um processo que reinicia é capturado com o PID novo', () => {
  const reiniciado = selectCaptureRoots({ sessions: [session(9100, 'game.exe')], selfPids: [] });
  assert.deepEqual(reiniciado.roots, [9100]);
});

test('quem está tocando tem prioridade quando o teto é alcançado', () => {
  const sessions = [
    session(1, 'quieto-a.exe', { active: false }),
    session(2, 'tocando.exe', { active: true }),
    session(3, 'quieto-b.exe', { active: false }),
  ];
  const result = selectCaptureRoots({ sessions, selfPids: [], limit: 2 });
  assert.ok(result.roots.includes(2), 'a sessão ativa precisa entrar');
  assert.equal(result.roots.length, 2);
  assert.equal(result.excluded.filter((entry) => entry.reason === 'limit').length, 1);
});

test('o identificador de janela do Electron entrega o HWND', () => {
  assert.equal(windowHandleFromSourceId('window:265728:0'), 265728);
  assert.equal(sourceKindFromId('window:265728:0'), 'window');
  assert.equal(sourceKindFromId('screen:0:0'), 'screen');
  // Nada de adivinhar: um identificador que não é dos nossos vale zero, e o
  // roteador recusa em vez de mandar um PID inventado ao helper.
  assert.equal(windowHandleFromSourceId('screen:0:0'), 0);
  assert.equal(windowHandleFromSourceId('window:abc:0'), 0);
  assert.equal(windowHandleFromSourceId('window:-5:0'), 0);
  assert.equal(windowHandleFromSourceId(null), 0);
  assert.equal(sourceKindFromId('qualquer-coisa'), '');
});

test('os comandos saem em uma linha só, com os PIDs válidos', () => {
  assert.equal(captureCommand([12, 34]), 'CAPTURE 12,34\n');
  assert.equal(captureCommand([]), 'CAPTURE\n');
  assert.equal(captureCommand(['x', -1, 0, 7]), 'CAPTURE 7\n');
  assert.equal(captureCommand(null), 'CAPTURE\n');
  assert.equal(windowCommand(265728), 'WINDOW 265728\n');
  assert.equal(windowCommand(-3), 'WINDOW 0\n');
});

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 0x54;
  header[1] = 0x41;
  header[2] = type;
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test('o decodificador remonta um quadro partido em vários pedaços', () => {
  const decode = createFrameDecoder();
  const payload = Buffer.from(new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer);
  const complete = frame(1, payload);
  assert.deepEqual(decode(complete.subarray(0, 3)), []);
  assert.deepEqual(decode(complete.subarray(3, 10)), []);
  const frames = decode(complete.subarray(10));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 1);
  assert.deepEqual([...new Float32Array(frames[0].payload.buffer, frames[0].payload.byteOffset, 4)], [0.5, -0.5, 0.25, -0.25]);
});

test('vários quadros na mesma leitura saem na ordem em que chegaram', () => {
  const decode = createFrameDecoder();
  const event = Buffer.from('{"event":"ready"}', 'utf8');
  const pcm = Buffer.from(new Float32Array([1, 1]).buffer);
  const frames = decode(Buffer.concat([frame(2, event), frame(1, pcm), frame(2, event)]));
  assert.deepEqual(frames.map((entry) => entry.type), [2, 1, 2]);
  assert.deepEqual(parseEvent(frames[0].payload), { event: 'ready' });
});

test('lixo antes de um quadro válido não faz o áudio parar para sempre', () => {
  const decode = createFrameDecoder();
  const pcm = Buffer.from(new Float32Array([0.75, 0.75]).buffer);
  const frames = decode(Buffer.concat([Buffer.from([0x00, 0x54, 0x99, 0x41]), frame(1, pcm)]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 1);
});

test('um evento ilegível vira nulo em vez de derrubar o processo', () => {
  assert.equal(parseEvent(Buffer.from('{isso não é json', 'utf8')), null);
  assert.equal(parseEvent(Buffer.from('"texto"', 'utf8')), null);
});
