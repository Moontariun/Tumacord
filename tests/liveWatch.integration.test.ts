import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { VoiceState } from '../shared/types.js';
import { freePort } from './freePort';

// A live por escolha, provada contra um servidor de verdade.
//
// O pedido de assistir é sinalização como qualquer outra: quem confere se ele
// pode atravessar é o servidor, e é isso que um cliente modificado encontra.
//
// Este arquivo também guardava as regras do desenho sobre a transmissão, que
// saiu na 0.9.9 — o desenho do Tumacord é a mesa compartilhada, que não depende
// de live nem de call e é provada em `whiteboard.integration.test.ts`.

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

/**
 * O que o servidor de teste reclamou antes de sair.
 *
 * Com `stdio: 'ignore'` uma saída com código 1 era só um código: o CI dizia
 * "servidor encerrou (1)" e não havia como saber por quê. Guardar as últimas
 * linhas do erro custa nada e transforma a próxima ocorrência em diagnóstico.
 */
function comDiagnostico(child: ChildProcess): ChildProcess {
  const queixas: string[] = [];
  child.stderr?.on('data', (pedaco: Buffer) => { queixas.push(pedaco.toString()); });
  Object.defineProperty(child, 'queixas', { value: queixas, configurable: true });
  return child;
}

function motivoDaSaida(child: ChildProcess): string {
  const queixas = (child as ChildProcess & { queixas?: string[] }).queixas ?? [];
  const texto = queixas.join('').trim().split('\n').slice(-4).join(' | ');
  return texto ? `: ${texto}` : ' sem dizer por quê (nada no erro padrão)';
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`servidor encerrou (${child.exitCode})${motivoDaSaida(child)}`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('servidor não iniciou a tempo');
}

async function ambiente(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-desenho-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = comDiagnostico(spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
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

// A live por escolha explícita.
//
// O pedido de assistir é sinalização como qualquer outra: ele só atravessa
// dentro da mesma call, e só chega a quem transmite. Sem essa conferência,
// alguém de fora poderia pedir mídia de uma transmissão da qual não participa.
test('o pedido de assistir só chega a quem transmite, e só dentro da call', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const deFora = await entrar('Estranho');
  const eu = await juntar(transmite);
  await juntar(assiste);

  const chegou = waitFor<{ from: string; stream: string; watching: boolean }>(transmite, 'rtc:watch');
  assiste.emit('rtc:watch', { target: eu.selfId, stream: 'transmissao-1', watching: true });
  const pedido = await chegou;
  assert.equal(pedido.stream, 'transmissao-1');
  assert.equal(pedido.watching, true);

  // Quem não está na call não alcança quem transmite.
  const silencio = naoChega(transmite, 'rtc:watch');
  deFora.emit('rtc:watch', { target: eu.selfId, stream: 'transmissao-1', watching: true });
  assert.equal(await silencio, true, 'quem não está na call não pede mídia de quem está');
});

test('parar de assistir também é dito a quem transmite', { timeout: 40_000 }, async (context) => {
  const { entrar, juntar } = await ambiente(context);
  const transmite = await entrar('Host');
  const assiste = await entrar('Amiga');
  const eu = await juntar(transmite);
  await juntar(assiste);

  const chegou = waitFor<{ watching: boolean }>(transmite, 'rtc:watch', (payload) => payload.watching === false);
  assiste.emit('rtc:watch', { target: eu.selfId, stream: 'transmissao-1', watching: false });
  assert.equal((await chegou).watching, false);
});
