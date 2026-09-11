import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { freePort } from './freePort';

// Quem responde pelo histórico, pelos perfis e pela sala.
//
// No dedicado é o servidor, e essas três coisas tinham furos que só apareciam
// quando alguém as procurava: a mensagem entrava assinada por quem o pacote
// dissesse, o limite da call era guardado e nunca consultado, e o canal
// apagado deixava gente dentro de uma sala que já não existia.
//
// No P2P a resposta é outra em uma delas — a replicação entre pessoas é o que
// segura o histórico na troca de host —, e por isso os dois modos aparecem
// aqui lado a lado.

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do teste (${child.exitCode}).`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* ainda subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Servidor não iniciou a tempo.');
}

function connect(url: string, token: string): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket não conectou')), 15_000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function ask<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} não respondeu`)), 15_000);
    socket.emit(event, payload, (result: T) => { clearTimeout(timer); resolve(result); });
  });
}

function waitFor<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 15_000): Promise<T> {
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

async function entrar(url: string, username: string, password = 'senha-de-teste') {
  const resposta = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, allowCreate: true }),
  });
  return await resposta.json() as { token: string; user: { id: string; username: string; isAdmin?: boolean } };
}

async function servidor(context: { after: (fn: () => Promise<void>) => void }, p2p = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-autoridade-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: p2p ? '1' : '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      ADMIN_USERNAME: 'Chefe', TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];
  context.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  });
  await waitForServer(url, child);
  return { url, sockets, child };
}

const pacote = (mensagens: unknown[], perfis: unknown[] = []) => ({ channels: [], messages: mensagens, profiles: perfis, availableAttachmentIds: [] });

const mensagemForjada = (id: string, autor: { id: string; username: string }) => ({
  id, channelId: 'geral', author: autor, body: 'isto não foi escrito por quem parece', createdAt: new Date().toISOString(),
});

// O buraco: o autor vinha do pacote, não da sessão. Qualquer conta autenticada
// podia inserir no histórico uma mensagem assinada por outra pessoa.
test('no dedicado, ninguém insere mensagem assinada por outra pessoa', { timeout: 60_000 }, async (context) => {
  const { url, sockets } = await servidor(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  const fulano = await entrar(url, 'Fulano');
  const socketFulano = await connect(url, fulano.token);
  sockets.push(socketFulano);

  const resposta = await ask<{ ok: boolean; messages?: Array<{ id: string }> }>(socketFulano, 'chat:sync:push', pacote([
    mensagemForjada('11111111-1111-4111-8111-111111111111', { id: chefe.user.id, username: 'Chefe' }),
  ]));
  assert.equal(resposta.ok, true, 'a metade legítima da sincronização continua respondendo');
  assert.equal(resposta.messages?.some((mensagem) => mensagem.id === '11111111-1111-4111-8111-111111111111'), false);

  // E ela não aparece para mais ninguém, nem depois.
  const outro = await connect(url, chefe.token);
  sockets.push(outro);
  const historico = await new Promise<Array<{ id: string }>>((resolve) => socketFulano.emit('chat:history', 'geral', resolve));
  assert.equal(historico.some((mensagem) => mensagem.id === '11111111-1111-4111-8111-111111111111'), false);
});

// A outra metade da mesma decisão: o pacote traz a conversa inteira de um
// grupo P2P, e o dedicado não é lugar para ela.
test('no dedicado, a conversa de um grupo P2P não entra na comunidade', { timeout: 60_000 }, async (context) => {
  const { url, sockets } = await servidor(context);
  await entrar(url, 'Chefe', 'senha-do-chefe');
  const fulano = await entrar(url, 'Fulano');
  const socketFulano = await connect(url, fulano.token);
  sockets.push(socketFulano);

  const doGrupo = Array.from({ length: 5 }, (_valor, indice) => mensagemForjada(`2222222${indice}-2222-4222-8222-222222222222`, fulano.user));
  const resposta = await ask<{ ok: boolean; messages?: Array<{ id: string }> }>(socketFulano, 'chat:sync:push', pacote(doGrupo));
  assert.equal(resposta.messages?.length ?? 0, 0, 'o histórico do dedicado continua sendo só o do dedicado');
});

// No P2P a replicação é o que preserva o histórico quando o host troca de
// máquina. Ela precisa continuar funcionando exatamente como antes.
test('no P2P, a replicação entre pessoas continua preservando o histórico', { timeout: 60_000 }, async (context) => {
  const { url, sockets } = await servidor(context, true);
  const ana = await entrar(url, 'Ana');
  const socketAna = await connect(url, ana.token);
  sockets.push(socketAna);

  const bia = { id: 'conta-da-bia', username: 'Bia' };
  const resposta = await ask<{ ok: boolean; messages?: Array<{ id: string; author: { username: string } }> }>(socketAna, 'chat:sync:push', pacote([
    { id: '33333333-3333-4333-8333-333333333333', channelId: 'geral', author: bia, body: 'dita antes de o host trocar', createdAt: new Date().toISOString() },
  ]));
  const devolvida = resposta.messages?.find((mensagem) => mensagem.id === '33333333-3333-4333-8333-333333333333');
  assert.ok(devolvida, 'o host novo passa a ter a mensagem que o grupo já tinha');
  assert.equal(devolvida?.author.username, 'Bia');
});

// A garantia que o teste da sinalização protegia até a 0.9.3, mudada de lugar:
// ela vale onde a replicação entre pessoas é a política, e não no dedicado.
test('no P2P, o perfil replicado vale, e uma cópia antiga não substitui a nova', { timeout: 60_000 }, async (context) => {
  const { url, sockets } = await servidor(context, true);
  const ana = await entrar(url, 'Ana');
  const bia = await entrar(url, 'Bia');
  const socketAna = await connect(url, ana.token);
  const socketBia = await connect(url, bia.token);
  sockets.push(socketAna, socketBia);

  const novoPerfil = {
    username: 'Ana',
    profile: { bio: 'perfil novo', accentColor: '#d63545', updatedAt: '2026-09-02T12:00:00.000Z' },
  };
  const aceito = await ask<{ ok: boolean; profiles: Array<{ username: string; profile: { bio: string } }> }>(socketAna, 'chat:sync:push', pacote([], [novoPerfil]));
  assert.equal(aceito.profiles.find((entry) => entry.username === 'Ana')?.profile.bio, 'perfil novo');

  // Outra pessoa devolvendo uma cópia antiga não pode desfazer o que é mais
  // recente — é o que mantém o perfil certo quando o host troca de máquina.
  const antigo = { ...novoPerfil, profile: { ...novoPerfil.profile, bio: 'perfil antigo', updatedAt: '2026-09-02T11:00:00.000Z' } };
  const depois = await ask<{ ok: boolean; profiles: Array<{ username: string; profile: { bio: string } }> }>(socketBia, 'chat:sync:push', pacote([], [antigo]));
  assert.equal(depois.profiles.find((entry) => entry.username === 'Ana')?.profile.bio, 'perfil novo');
});

// O limite era guardado pelo painel e nunca consultado na entrada.
test('o limite de pessoas da call é aplicado na entrada, no servidor', { timeout: 60_000 }, async (context) => {
  const { url, sockets } = await servidor(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  const canal = await (await fetch(`${url}/api/admin/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${chefe.token}` },
    body: JSON.stringify({ name: 'dupla', type: 'voice', userLimit: 2 }),
  })).json() as { channel: { id: string } };

  const entrantes: Socket[] = [];
  for (const nome of ['Ana', 'Bia']) {
    const conta = await entrar(url, nome);
    const socket = await connect(url, conta.token);
    sockets.push(socket);
    entrantes.push(socket);
    const resultado = await ask<{ ok: boolean }>(socket, 'voice:join', { channelId: canal.channel.id });
    assert.equal(resultado.ok, true, `${nome} devia caber`);
  }

  const caio = await entrar(url, 'Caio');
  const socketCaio = await connect(url, caio.token);
  sockets.push(socketCaio);
  const recusado = await ask<{ ok: boolean; error?: string }>(socketCaio, 'voice:join', { channelId: canal.channel.id });
  assert.equal(recusado.ok, false);
  assert.match(recusado.error ?? '', /cheia/i);

  // A administração entra assim mesmo: um canal cheio não pode trancar do lado
  // de fora quem precisa mediar o que está acontecendo lá dentro.
  const socketChefe = await connect(url, chefe.token);
  sockets.push(socketChefe);
  assert.equal((await ask<{ ok: boolean }>(socketChefe, 'voice:join', { channelId: canal.channel.id })).ok, true);

  // E quem sai abre a vaga de volta. A administração sai junto: ela entrou
  // acima do limite, então a sala só volta a ter espaço quando ela também sai.
  entrantes[0].emit('voice:leave');
  socketChefe.emit('voice:leave');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await ask<{ ok: boolean }>(socketCaio, 'voice:join', { channelId: canal.channel.id })).ok, true);
});

// Apagar o canal deixava gente numa sala de um canal que já não existe: a
// pessoa continuava "na voz" de um lugar que a interface não mostra mais.
test('apagar um canal de voz tira da call quem estava dentro', { timeout: 60_000 }, async (context) => {
  const { url, sockets } = await servidor(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  const canal = await (await fetch(`${url}/api/admin/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${chefe.token}` },
    body: JSON.stringify({ name: 'efemero', type: 'voice' }),
  })).json() as { channel: { id: string } };

  const ana = await entrar(url, 'Ana');
  const socketAna = await connect(url, ana.token);
  sockets.push(socketAna);
  assert.equal((await ask<{ ok: boolean }>(socketAna, 'voice:join', { channelId: canal.channel.id })).ok, true);

  const aviso = waitFor<{ channelId: string; reason?: string }>(socketAna, 'voice:evicted');
  const apagado = await fetch(`${url}/api/admin/channels/${canal.channel.id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${chefe.token}` },
  });
  assert.equal(apagado.status, 200);

  const recebido = await aviso;
  assert.equal(recebido.channelId, canal.channel.id);
  assert.match(recebido.reason ?? '', /apagado/i);

  // E a sala fica vazia de verdade, não só na tela de quem saiu. O retrato é
  // reenviado a cada entrada e saída de qualquer pessoa no servidor, então o
  // que interessa é o primeiro em que esta sala já não tem ninguém — e não o
  // primeiro que chegar.
  const snapshot = await waitFor<{ voiceRooms: Record<string, unknown[]> }>(
    socketAna,
    'server:snapshot',
    (payload) => (payload.voiceRooms?.[canal.channel.id] ?? []).length === 0,
  );
  assert.equal((snapshot.voiceRooms[canal.channel.id] ?? []).length, 0);
});
