import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { ServerSnapshot, VoiceState } from '../shared/types.js';
import { freePort } from './freePort';

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do teste (${child.exitCode}).`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Compilação TypeScript e criação do armazenamento ainda em curso.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Servidor não iniciou a tempo.');
}

function waitForEvent<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tempo esgotado aguardando ${event}.`)), 3_000);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function connect(url: string, token: string): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  return socket.connected ? Promise.resolve(socket) : waitForEvent(socket, 'connect').then(() => socket);
}

function join(socket: Socket, channelId = 'call-geral'): Promise<{ ok: boolean; peers: VoiceState[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('voice:join não respondeu.')), 3_000);
    socket.emit('voice:join', channelId, (result: { ok: boolean; peers: VoiceState[] }) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

test('servidor dedicado hospeda o cliente web, protege o acesso e sinaliza tela com áudio', { timeout: 20_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-dedicated-'));
  const dataDirectory = path.join(root, 'data');
  const webDirectory = path.join(root, 'web');
  await mkdir(webDirectory, { recursive: true });
  await writeFile(path.join(webDirectory, 'index.html'), '<!doctype html><title>Tumacord Web QA</title>');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDirectory, WEB_DIR: webDirectory, SERVER_ACCESS_KEY: 'turma-secreta', ADMIN_USERNAME: 'Moontariun', TLS_CERT_FILE: '', TLS_KEY_FILE: '', TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '1' },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });

  await waitForServer(url, child);
  const health = await (await fetch(`${url}/api/health`)).json() as { mode: string; web: boolean; security: { accessKeyRequired: boolean; media: string } };
  assert.deepEqual({ mode: health.mode, web: health.web, key: health.security.accessKeyRequired, media: health.security.media }, { mode: 'server', web: true, key: true, media: 'DTLS-SRTP' });
  assert.match(await (await fetch(url)).text(), /Tumacord Web QA/);

  const denied = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Conta Local', password: 'senha-local', allowCreate: true }) });
  assert.equal(denied.status, 403);
  const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Conta Local', password: 'senha-local', allowCreate: true, serverKey: 'turma-secreta' }) });
  assert.equal(login.status, 200);
  const firstSession = await login.json() as { token: string; created: boolean };
  assert.equal(firstSession.created, true, 'as credenciais locais devem provisionar a conta no primeiro acesso ao servidor');
  const viewerRegistration = await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Viewer Server', password: 'senha-viewer', serverKey: 'turma-secreta' }) });
  const viewerSession = await viewerRegistration.json() as { token: string };

  const unauthenticatedLargeUpload = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(25 * 1024 * 1024 + 1),
  });
  assert.equal(unauthenticatedLargeUpload.status, 401, 'autenticação precisa ocorrer antes de alocar o corpo grande');
  const invalidMimeUpload = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${viewerSession.token}`, 'content-type': 'application/octet-stream', 'x-file-type': encodeURIComponent('text/plain\r\nx-injected: yes') },
    body: Buffer.from('não salvar'),
  });
  assert.equal(invalidMimeUpload.status, 400, 'MIME decodificado não pode injetar cabeçalhos na resposta de download');
  const attachmentUpload = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${viewerSession.token}`,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('../ relatório QA #1.txt'),
      'x-file-type': encodeURIComponent('application/x-tumacord-qa'),
    },
    body: Buffer.from('anexo seguro'),
  });
  assert.equal(attachmentUpload.status, 201);
  const attachment = await attachmentUpload.json() as { id: string; name: string; mimeType: string };
  assert.equal(attachment.name, 'relatório QA #1.txt');
  assert.equal(attachment.mimeType, 'application/x-tumacord-qa');
  const attachmentDownload = await fetch(`${url}/api/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${viewerSession.token}` } });
  assert.equal(await attachmentDownload.text(), 'anexo seguro');
  assert.match(attachmentDownload.headers.get('content-disposition') ?? '', /filename\*=UTF-8''relat%C3%B3rio%20QA%20%231\.txt/);
  const oversizedUpload = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${viewerSession.token}`, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(25 * 1024 * 1024 + 1),
  });
  assert.equal(oversizedUpload.status, 413);

  const stored = JSON.parse(await readFile(path.join(dataDirectory, 'tumacord.json'), 'utf8')) as { sessions: Array<{ token?: string; tokenHash?: string }> };
  assert.equal(stored.sessions.some((session) => Boolean(session.token)), false, 'tokens não devem ficar legíveis no disco');
  assert.match(stored.sessions[0].tokenHash ?? '', /^[a-f0-9]{64}$/);

  const streamer = await connect(url, firstSession.token);
  const viewer = await connect(url, viewerSession.token);
  sockets.push(streamer, viewer);
  await join(streamer);
  await join(viewer);
  const screenState = waitForEvent<VoiceState[]>(viewer, 'voice:members', (members) => members.some((member) => member.socketId === streamer.id && member.screen && member.screenAudio));
  streamer.emit('voice:state', { screen: true, screenAudio: true });
  await screenState;

  const adminLogin = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Moontariun', password: 'senha-admin-local', allowCreate: true, serverKey: 'turma-secreta' }) });
  assert.equal(adminLogin.status, 200);
  const adminSession = await adminLogin.json() as { token: string; user: { isAdmin?: boolean } };
  assert.equal(adminSession.user.isAdmin, true, 'Moontariun deve receber a função administrativa no servidor dedicado');
  const deniedOverview = await fetch(`${url}/api/admin/overview`, { headers: { authorization: `Bearer ${viewerSession.token}` } });
  assert.equal(deniedOverview.status, 403);
  const overviewResponse = await fetch(`${url}/api/admin/overview`, { headers: { authorization: `Bearer ${adminSession.token}` } });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json() as { security: { media: string }; voiceRooms: Record<string, VoiceState[]> };
  assert.equal(overview.security.media, 'DTLS-SRTP');
  assert.equal(overview.voiceRooms['call-geral'].some((member) => member.screenAudio), true);
  const deniedDisconnect = await fetch(`${url}/api/admin/users/${viewerSession.token.slice(0, 8)}/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${viewerSession.token}` } });
  assert.equal(deniedDisconnect.status, 403, 'usuário comum não pode executar ações administrativas');
  const viewerId = overview.voiceRooms['call-geral'].find((member) => member.socketId === viewer.id)?.id;
  assert.ok(viewerId);
  const viewerDisconnected = waitForEvent<string>(viewer, 'disconnect');
  const disconnectResponse = await fetch(`${url}/api/admin/users/${viewerId}/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${adminSession.token}` } });
  assert.equal(disconnectResponse.status, 200);
  await viewerDisconnected;
});

test('servidor embutido P2P não publica web nem canais extras', { timeout: 20_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-p2p-'));
  const webDirectory = path.join(root, 'web');
  await mkdir(webDirectory, { recursive: true });
  await writeFile(path.join(webDirectory, 'index.html'), '<title>não deve aparecer</title>');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'), WEB_DIR: webDirectory, SERVER_ACCESS_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '', TUMACORD_P2P_MODE: '1', TUMACORD_SERVE_WEB: '0' },
    stdio: 'ignore',
  });
  let socket: Socket | undefined;
  context.after(async () => {
    socket?.disconnect();
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });

  await waitForServer(url, child);
  const health = await (await fetch(`${url}/api/health`)).json() as { mode: string; web: boolean };
  assert.equal(health.mode, 'p2p');
  assert.equal(health.web, false);
  assert.equal((await fetch(url)).status, 404);
  const registration = await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'P2P QA', password: 'senha-p2p' }) });
  const { token } = await registration.json() as { token: string };
  socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const snapshotPromise = waitForEvent<ServerSnapshot>(socket, 'server:snapshot');
  if (!socket.connected) await waitForEvent(socket, 'connect');
  const snapshot = await snapshotPromise;
  assert.deepEqual(snapshot.channels.map((channel) => [channel.id, channel.type]), [['geral', 'text'], ['call-geral', 'voice']]);
  const creation = await new Promise<{ ok: boolean }>((resolve) => socket!.emit('channel:create', { name: 'extra', type: 'text' }, resolve));
  assert.equal(creation.ok, false);
});
