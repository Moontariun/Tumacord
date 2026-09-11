import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { VoiceState } from '../shared/types.js';
import { freePort } from './freePort';

// A regra desta versão, provada contra um servidor de verdade: quem transmite
// decide se aceita desenho. Esconder o lápis do outro lado é conveniência —
// quem recusa é o servidor, e é isso que um cliente modificado encontra.
//
// Na 0.9.0 a decisão passou a ter duas metades, e as duas moram no servidor: o
// sistema de quem transmite precisa saber receber traço (`drawSupported`, que
// só o Windows declara) e a pessoa precisa permitir (`allowDraw`). Faltando
// qualquer uma, o traço não é repassado.

function waitFor<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`tempo esgotado em ${event}`)); }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

function naoChega(socket: Socket, event: string, janelaMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    let chegou = false;
    const listener = () => { chegou = true; };
    socket.on(event, listener);
    setTimeout(() => { socket.off(event, listener); resolve(!chegou); }, janelaMs);
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`servidor encerrou (${child.exitCode})`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('servidor não iniciou a tempo');
}

async function ambiente(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-desenho-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];
  context.after(async () => {
    // Esperar o processo sair antes de apagar o diretório. Desde a 0.9.1 o
    // encerramento do servidor grava as mesas em disco, e apagar a pasta
    // embaixo de quem ainda está escrevendo devolve ENOTEMPTY — falha que só
    // aparece em máquina lenta, que é justamente onde ninguém está olhando.
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5_000).unref?.(); });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  });
  await waitForServer(url, child);

  const entrar = async (username: string) => {
    const r = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'senha-de-teste', allowCreate: true }),
    });
    const { token } = await r.json() as { token: string };
    const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket);
    if (!socket.connected) await waitFor(socket, 'connect');
    return socket;
  };

  const juntar = (socket: Socket) => new Promise<{ selfId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('voice:join não respondeu')), 4_000);
    socket.emit('voice:join', 'call-geral', (result: { ok: boolean; selfId: string }) => {
      clearTimeout(timer);
      result?.ok ? resolve(result) : reject(new Error('não entrou na call'));
    });
  });

  return { url, entrar, juntar };
}

const traco = (target: string, extra: Record<string, unknown> = {}) => ({
  target, strokeId: 's1', color: '#ff5c5c', points: [{ x: 0.5, y: 0.5 }], ...extra,
});

test('quem transmite recebe o traço, e todo mundo na call vê o mesmo', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const terceiro = await entrar('Fulano');
  const eu = await juntar(transmite);
  await juntar(assiste);
  await juntar(terceiro);

  transmite.emit('voice:state', { screen: true, allowDraw: true, drawSupported: true });
  await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.screen));

  const noHost = waitFor<Record<string, unknown>>(transmite, 'rtc:draw');
  const noTerceiro = waitFor<Record<string, unknown>>(terceiro, 'rtc:draw');
  assiste.emit('rtc:draw', traco(eu.selfId));

  const recebido = await noHost;
  assert.equal(recebido.target, eu.selfId);
  assert.equal(recebido.authorName, 'Amiga', 'o traço chega assinado, para cada um ter a própria cor e o próprio limpar');
  assert.deepEqual(recebido.points, [{ x: 0.5, y: 0.5 }]);
  await noTerceiro;
});

// O pedido explícito da versão: desligar faz o desenho parar de funcionar de
// verdade, não só sumir da tela de quem assiste.
test('com a opção desligada, o servidor recusa o traço', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);

  transmite.emit('voice:state', { screen: true, allowDraw: false, drawSupported: true });
  const membros = await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.allowDraw === false));
  assert.equal(membros.find((x) => x.socketId === eu.selfId)?.allowDraw, false, 'a recusa é anunciada para quem assiste');

  const silencio = naoChega(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', traco(eu.selfId));
  assert.equal(await silencio, true, 'um cliente modificado não desenha na tela de quem recusou');

  // E religar volta a funcionar, sem precisar reentrar na call.
  transmite.emit('voice:state', { allowDraw: true, drawSupported: true });
  await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.allowDraw !== false));
  const volta = waitFor(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', traco(eu.selfId));
  await volta;
});

// O caso do Linux, que é o motivo da regra: a janela que pinta o traço sobre a
// área de trabalho rouba o foco do teclado de quem está jogando, e o portal do
// PipeWire não sabe deixá-la fora da captura.
test('sem sistema que receba desenho, nem permitir adianta', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);

  transmite.emit('voice:state', { screen: true, allowDraw: true, drawSupported: false });
  const membros = await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.screen));
  assert.equal(membros.find((x) => x.socketId === eu.selfId)?.drawSupported, false, 'quem assiste sabe que o lápis fica desabilitado');

  const silencio = naoChega(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', traco(eu.selfId));
  assert.equal(await silencio, true, 'permitir não basta: o sistema de quem transmite precisa receber');

  // E o mesmo vale para um cliente anterior à 0.9.0, que não declara nada.
  const semDeclarar = await entrar('Antiga');
  const outro = await juntar(semDeclarar);
  semDeclarar.emit('voice:state', { screen: true, allowDraw: true });
  await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === outro.selfId && x.screen));
  const mudo = naoChega(semDeclarar, 'rtc:draw');
  assiste.emit('rtc:draw', traco(outro.selfId));
  assert.equal(await mudo, true, 'ausência é lida como "não sabe receber", não como permissão');
});

test('não se desenha sobre quem não está transmitindo', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);
  transmite.emit('voice:state', { screen: false, allowDraw: true, drawSupported: true });

  const silencio = naoChega(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', traco(eu.selfId));
  assert.equal(await silencio, true);
});

test('limpar tudo é de quem transmite; os outros só limpam o que é seu', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);
  transmite.emit('voice:state', { screen: true, allowDraw: true, drawSupported: true });
  await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.screen));

  const negado = naoChega(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', { ...traco(eu.selfId), points: [], clearAll: true });
  assert.equal(await negado, true, 'quem assiste não apaga o que os outros desenharam');

  // O próprio, sim.
  const permitido = waitFor<Record<string, unknown>>(assiste, 'rtc:draw');
  transmite.emit('rtc:draw', { ...traco(eu.selfId), points: [], clearAll: true });
  assert.equal((await permitido).clearAll, true);

  // E limpar só o que é seu vale para qualquer um.
  const proprio = waitFor<Record<string, unknown>>(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', { ...traco(eu.selfId), points: [], clear: true });
  assert.equal((await proprio).clear, true);
});

test('quem não está na mesma call não alcança a tela de ninguém', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const deFora = await entrar('Estranho');
  const eu = await juntar(transmite);
  transmite.emit('voice:state', { screen: true, allowDraw: true, drawSupported: true });

  const silencio = naoChega(transmite, 'rtc:draw');
  deFora.emit('rtc:draw', traco(eu.selfId));
  assert.equal(await silencio, true);
});

test('payload malformado é descartado sem derrubar o servidor', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);
  transmite.emit('voice:state', { screen: true, allowDraw: true, drawSupported: true });
  await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.screen));

  const silencio = naoChega(transmite, 'rtc:draw');
  for (const ruim of [
    null, 'texto', 42, {},
    { target: eu.selfId },
    traco(eu.selfId, { color: 'javascript:alert(1)' }),
    traco(eu.selfId, { points: [{ x: 5, y: 0.5 }] }),
    traco(eu.selfId, { points: [{ x: Number.NaN, y: 0.5 }] }),
    traco(eu.selfId, { points: Array.from({ length: 5_000 }, () => ({ x: 0.5, y: 0.5 })) }),
    traco(eu.selfId, { strokeId: 'x'.repeat(500) }),
  ]) assiste.emit('rtc:draw', ruim);
  assert.equal(await silencio, true, 'nada malformado é repassado');

  // E o servidor continua de pé para o traço bom logo depois.
  const bom = waitFor(transmite, 'rtc:draw');
  assiste.emit('rtc:draw', traco(eu.selfId));
  await bom;
});

// Uma mão desenhando produz alguns pedidos por segundo. Um cliente adulterado
// produziria milhares, e cada um é reenviado para a sala inteira.
test('inundação de traços é cortada, e a mão normal continua passando', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);
  transmite.emit('voice:state', { screen: true, allowDraw: true, drawSupported: true });
  await waitFor<VoiceState[]>(assiste, 'voice:members', (m) => m.some((x) => x.socketId === eu.selfId && x.screen));

  let recebidos = 0;
  transmite.on('rtc:draw', () => { recebidos += 1; });
  for (let i = 0; i < 400; i += 1) assiste.emit('rtc:draw', traco(eu.selfId, { strokeId: `s${i}` }));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.ok(recebidos > 0, 'o começo do jorro passa');
  assert.ok(recebidos < 400, `o balde precisa cortar a inundação; passaram ${recebidos}`);
});
