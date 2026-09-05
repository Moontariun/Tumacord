import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do teste (${child.exitCode}).`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Servidor não iniciou a tempo.');
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function connect(url: string, token: string): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket não conectou')), 5_000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function ask<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} não respondeu`)), 5_000);
    socket.emit(event, payload, (result: T) => { clearTimeout(timer); resolve(result); });
  });
}

async function entrar(url: string, username: string, password: string) {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, allowCreate: true }),
  });
  return { status: response.status, body: await response.json() as { token: string; user: { isAdmin?: boolean } } };
}

async function servidorDedicado(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-admin-'));
  const port = 32_000 + Math.floor(Math.random() * 8_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      ADMIN_USERNAME: 'Chefe', TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);
  return { url, sockets };
}

// Antes desta versão `channel:create` não verificava nada: qualquer usuário
// autenticado criava canal de texto e de voz no servidor dedicado.
test('usuário comum não cria canal; a administração cria', { timeout: 30_000 }, async (context) => {
  const { url, sockets } = await servidorDedicado(context);

  const comum = await entrar(url, 'Fulano', 'senha-do-fulano');
  assert.equal(comum.body.user.isAdmin ?? false, false);
  const socketComum = await connect(url, comum.body.token);
  sockets.push(socketComum);

  const recusado = await ask<{ ok: boolean; error?: string }>(socketComum, 'channel:create', { name: 'invasao', type: 'text' });
  assert.equal(recusado.ok, false);
  assert.match(recusado.error ?? '', /administração/i);

  const recusadoVoz = await ask<{ ok: boolean }>(socketComum, 'channel:create', { name: 'invasao-voz', type: 'voice' });
  assert.equal(recusadoVoz.ok, false, 'canal de voz também precisa ser bloqueado');

  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  assert.equal(chefe.body.user.isAdmin, true);
  const socketChefe = await connect(url, chefe.body.token);
  sockets.push(socketChefe);

  const criado = await ask<{ ok: boolean; channel?: { id: string; type: string } }>(socketChefe, 'channel:create', { name: 'anuncios', type: 'text' });
  assert.equal(criado.ok, true);
  assert.equal(criado.channel?.type, 'text');
});

// Segundo caminho para o mesmo estrago: empurrar um pacote de sincronização
// com canais novos dentro.
test('sincronização de usuário comum não injeta canais', { timeout: 30_000 }, async (context) => {
  const { url, sockets } = await servidorDedicado(context);
  const comum = await entrar(url, 'Fulano', 'senha-do-fulano');
  const socketComum = await connect(url, comum.body.token);
  sockets.push(socketComum);

  const resultado = await ask<{ ok: boolean; channels: Array<{ id: string }> }>(socketComum, 'chat:sync:push', {
    channels: [{ id: 'canal-invadido', name: 'invadido', type: 'text' }],
    messages: [],
    profiles: [],
    availableAttachmentIds: [],
  });
  assert.equal(resultado.ok, true, 'a sincronização de mensagens continua funcionando');
  assert.equal(resultado.channels.some((channel) => channel.id === 'canal-invadido'), false, 'o canal não pode ter entrado');
});

// Medido antes da correção: doze senhas erradas em 595 ms, todas 401.
test('senhas erradas em sequência passam a esbarrar em limite', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  await entrar(url, 'Alvo', 'senha-verdadeira');

  const status: number[] = [];
  for (let tentativa = 0; tentativa < 9; tentativa += 1) {
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Alvo', password: `chute-${tentativa}` }),
    });
    status.push(response.status);
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0, 'a resposta precisa dizer quanto esperar');
      break;
    }
  }
  assert.ok(status.includes(429), `nenhuma tentativa foi barrada: ${status.join(', ')}`);
  assert.equal(status[0], 401, 'a primeira tentativa errada ainda responde senha incorreta');
});

test('quem acerta a senha não fica preso no limite do vizinho', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  await entrar(url, 'Alvo', 'senha-verdadeira');
  for (let tentativa = 0; tentativa < 8; tentativa += 1) {
    await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Alvo', password: 'errada' }),
    });
  }
  const outro = await entrar(url, 'Vizinho', 'senha-do-vizinho');
  assert.equal(outro.status, 200, 'o bloqueio é por usuário e origem, não global');
});

test('o anexo entre pares continua servindo a rede local, sem regressão', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  const sessao = await entrar(url, 'Fulano', 'senha-do-fulano');
  const envio = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessao.body.token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'nota.txt' },
    body: Buffer.from('conteudo do grupo'),
  });
  const anexo = await envio.json() as { id: string };
  // O teste roda em 127.0.0.1, que é endereço da própria máquina e continua
  // liberado — é o caso do P2P na mesma rede. A recusa para endereço público
  // é coberta pelos testes de `isTrustedLocalAddress`.
  const local = await fetch(`${url}/api/peer/attachments/${anexo.id}`);
  assert.equal(local.status, 200);
  assert.equal(await local.text(), 'conteudo do grupo');
});
