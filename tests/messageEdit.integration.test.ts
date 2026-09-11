import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { ChatMessage, ChatSyncBundle } from '../shared/types.js';
import { freePort } from './freePort';

// Editar e apagar, contra um servidor de verdade.
//
// Duas coisas se provam aqui e não dá para provar num modelo puro: que quem
// recusa uma edição alheia é o servidor — esconder o botão é conveniência —, e
// que a replicação do P2P não ressuscita o que alguém apagou.
//
// A segunda é a que importa mais. O merge antigo olhava só o `id`: um pacote
// de sincronização de quem ainda tinha a cópia antiga era simplesmente
// ignorado, e a mensagem apagada continuava apagada — até que o contrário
// acontecesse, com a cópia antiga chegando a quem já tinha esquecido a
// mensagem. A lápide é o que fecha esse caminho, e ela só vale se o merge
// souber compará-la com o que chega.

function waitFor<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 6_000): Promise<T> {
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`servidor encerrou (${child.exitCode})${motivoDaSaida(child)}`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('servidor não iniciou a tempo');
}

async function ambiente(context: { after: (fn: () => Promise<void>) => void }, p2p = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-mensagem-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = comDiagnostico(spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: p2p ? '1' : '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  const sockets: Socket[] = [];
  context.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5_000).unref?.(); });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  });
  await waitForServer(url, child);

  const entrar = async (username: string): Promise<Socket> => {
    const resposta = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'senha-de-teste', allowCreate: true }),
    });
    const { token } = await resposta.json() as { token: string };
    const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket);
    if (!socket.connected) await waitFor(socket, 'connect');
    return socket;
  };

  const enviar = async (socket: Socket, body: string): Promise<ChatMessage> => {
    const chegou = waitFor<ChatMessage>(socket, 'chat:message', (message) => message.body === body);
    socket.emit('chat:send', { channelId: 'geral', body });
    return chegou;
  };

  const empurrar = (socket: Socket, messages: ChatMessage[]) => new Promise<ChatSyncBundle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chat:sync:push não respondeu')), 6_000);
    socket.emit('chat:sync:push', { channels: [], messages, profiles: [], availableAttachmentIds: [] }, (resultado: ChatSyncBundle) => {
      clearTimeout(timer);
      resolve(resultado);
    });
  });

  return { url, entrar, enviar, empurrar };
}

test('editar chega a todo mundo, e o texto novo é o que fica', { timeout: 40_000 }, async (context) => {
  const { entrar, enviar } = await ambiente(context);
  const autora = await entrar('Ana');
  const outra = await entrar('Bia');
  const original = await enviar(autora, 'texto original');

  const naOutra = waitFor<ChatMessage>(outra, 'chat:message:updated');
  autora.emit('chat:edit', { id: original.id, body: 'texto corrigido' });
  const atualizada = await naOutra;
  assert.equal(atualizada.id, original.id);
  assert.equal(atualizada.body, 'texto corrigido');
  assert.equal(atualizada.revision, 1);
  assert.ok(atualizada.editedAt, 'a edição diz quando foi');
});

test('apagar deixa a lápide, e a lápide não carrega o conteúdo', { timeout: 40_000 }, async (context) => {
  const { entrar, enviar } = await ambiente(context);
  const autora = await entrar('Ana');
  const outra = await entrar('Bia');
  const original = await enviar(autora, 'mensagem que vai sair');

  const naOutra = waitFor<ChatMessage>(outra, 'chat:message:updated');
  autora.emit('chat:delete', { id: original.id });
  const apagada = await naOutra;
  assert.equal(apagada.body, '', 'apagar é apagar: o texto não fica na lápide');
  assert.ok(apagada.deletedAt);

  const historico = await new Promise<ChatMessage[]>((resolve) => outra.emit('chat:history', 'geral', resolve));
  const guardada = historico.find((message) => message.id === original.id);
  assert.ok(guardada?.deletedAt, 'a lápide fica no histórico — é ela que impede a mensagem de voltar');
  assert.equal(guardada?.body, '');
});

// Esconder o botão do outro lado é conveniência. Quem recusa é o servidor.
test('ninguém edita nem apaga a mensagem de outra pessoa', { timeout: 40_000 }, async (context) => {
  const { entrar, enviar } = await ambiente(context);
  const autora = await entrar('Ana');
  const outra = await entrar('Bia');
  const original = await enviar(autora, 'minha mensagem');

  const silencio = naoChega(autora, 'chat:message:updated');
  outra.emit('chat:edit', { id: original.id, body: 'não é sua' });
  outra.emit('chat:delete', { id: original.id });
  assert.equal(await silencio, true, 'nada mudou');

  const historico = await new Promise<ChatMessage[]>((resolve) => autora.emit('chat:history', 'geral', resolve));
  const guardada = historico.find((message) => message.id === original.id);
  assert.equal(guardada?.body, 'minha mensagem');
  assert.equal(guardada?.deletedAt, undefined);
});

// --- a prioridade na replicação do P2P --------------------------------------

test('P2P: a cópia antiga não ressuscita o que foi apagado', { timeout: 40_000 }, async (context) => {
  const { entrar, enviar, empurrar } = await ambiente(context, true);
  const autora = await entrar('Ana');
  const original = await enviar(autora, 'mensagem que vai sair');

  const apagada = waitFor<ChatMessage>(autora, 'chat:message:updated');
  autora.emit('chat:delete', { id: original.id });
  await apagada;

  // Quem estava offline volta com a mensagem inteira, sem saber da exclusão.
  const devolvido = await empurrar(autora, [original]);
  const depois = devolvido.messages.find((message) => message.id === original.id);
  assert.ok(depois?.deletedAt, 'a lápide venceu a cópia antiga');
  assert.equal(depois?.body, '');
});

test('P2P: uma exclusão feita offline alcança quem ainda tinha a mensagem', { timeout: 40_000 }, async (context) => {
  const { entrar, enviar, empurrar } = await ambiente(context, true);
  const autora = await entrar('Ana');
  const outra = await entrar('Bia');
  const original = await enviar(autora, 'apagada do outro lado');

  // O outro computador apagou enquanto estava fora e agora se encontra com este.
  const lapide: ChatMessage = { ...original, body: '', revision: 1, deletedAt: new Date().toISOString() };
  const avisada = waitFor<ChatMessage[]>(outra, 'chat:sync:messages', (lista) => lista.some((item) => item.id === original.id));
  await empurrar(autora, [lapide]);
  const chegou = await avisada;
  assert.ok(chegou.find((item) => item.id === original.id)?.deletedAt, 'quem está com a tela aberta é avisado na hora');

  const historico = await new Promise<ChatMessage[]>((resolve) => outra.emit('chat:history', 'geral', resolve));
  assert.ok(historico.find((message) => message.id === original.id)?.deletedAt);
});

test('P2P: uma edição feita offline vence o texto que estava guardado', { timeout: 40_000 }, async (context) => {
  const { entrar, enviar, empurrar } = await ambiente(context, true);
  const autora = await entrar('Ana');
  const original = await enviar(autora, 'texto original');

  const editadaLaFora: ChatMessage = { ...original, body: 'texto de fora', revision: 3, editedAt: new Date().toISOString() };
  const devolvido = await empurrar(autora, [editadaLaFora]);
  assert.equal(devolvido.messages.find((message) => message.id === original.id)?.body, 'texto de fora');

  // E o caminho contrário: o texto antigo, com revisão menor, não desfaz nada.
  const devolvidoDeNovo = await empurrar(autora, [original]);
  assert.equal(devolvidoDeNovo.messages.find((message) => message.id === original.id)?.body, 'texto de fora');
});
