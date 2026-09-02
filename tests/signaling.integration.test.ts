import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { VoiceState } from '../shared/types.js';

function waitForEvent<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Tempo esgotado aguardando ${event}.`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor de teste encerrou com código ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // O processo ainda está carregando TypeScript e o arquivo de dados.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Servidor de teste não iniciou.');
}

async function register(url: string, username: string): Promise<string> {
  const response = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'qa-test-password' }),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { token: string }).token;
}

async function connect(url: string, token: string): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  if (!socket.connected) await waitForEvent(socket, 'connect', () => true);
  return socket;
}

function join(socket: Socket, channelId: string): Promise<{ ok: boolean; selfId: string; peers: VoiceState[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('voice:join não respondeu.')), 3_000);
    socket.emit('voice:join', channelId, (result: { ok: boolean; selfId: string; peers: VoiceState[] }) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

test('sinalização preserva live ao reconectar e permite reconstruir o enlace', { timeout: 20_000 }, async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'tumacord-signaling-'));
  const port = 31_000 + Math.floor(Math.random() * 9_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDirectory, SERVER_NAME: 'Tumacord QA' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets: Socket[] = [];
  context.after(async () => {
    for (const socket of sockets) socket.disconnect();
    child.kill('SIGTERM');
    await rm(dataDirectory, { recursive: true, force: true });
  });

  await waitForServer(url, child);
  const [streamerToken, viewerToken, outsiderToken] = await Promise.all([
    register(url, 'Streamer QA'),
    register(url, 'Viewer QA'),
    register(url, 'Outsider QA'),
  ]);
  const streamer = await connect(url, streamerToken);
  let viewer = await connect(url, viewerToken);
  const outsider = await connect(url, outsiderToken);
  sockets.push(streamer, viewer, outsider);

  const profileMediaId = 'd77c705a-aa6d-4236-80cd-cfaf26b37786';
  const mediaUpload = await fetch(`${url}/api/profile/media/${profileMediaId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${streamerToken}`, 'content-type': 'image/png' },
    body: Buffer.from('perfil-qa'),
  });
  assert.equal(mediaUpload.status, 200);
  const firstProfile = {
    username: 'Streamer QA',
    profile: {
      bio: 'perfil sincronizado',
      accentColor: '#d63545',
      avatar: { id: profileMediaId, mimeType: 'image/png' },
      updatedAt: '2026-09-02T12:00:00.000Z',
    },
  };
  const profileSnapshot = waitForEvent<{ onlineUsers: Array<{ username: string; profile?: { bio: string } }> }>(viewer, 'server:snapshot', (snapshot) => snapshot.onlineUsers.some((member) => member.username === 'Streamer QA' && member.profile?.bio === 'perfil sincronizado'));
  streamer.emit('chat:sync:push', { channels: [], messages: [], profiles: [firstProfile], availableAttachmentIds: [profileMediaId] });
  await profileSnapshot;
  const replicatedMedia = await fetch(`${url}/api/profile/media/${profileMediaId}`);
  assert.equal(replicatedMedia.status, 200);

  const olderProfile = { ...firstProfile, profile: { ...firstProfile.profile, bio: 'perfil antigo', updatedAt: '2026-09-02T11:00:00.000Z' } };
  const syncResult = await new Promise<{ profiles: Array<{ username: string; profile: { bio: string } }> }>((resolve) => {
    viewer.emit('chat:sync:push', { channels: [], messages: [], profiles: [olderProfile], availableAttachmentIds: [] }, resolve);
  });
  assert.equal(syncResult.profiles.find((entry) => entry.username === 'Streamer QA')?.profile.bio, 'perfil sincronizado', 'uma cópia antiga não pode substituir avatar ou perfil novos');

  const streamerJoin = await join(streamer, 'call-geral');
  assert.equal(streamerJoin.ok, true);
  await join(viewer, 'call-geral');
  await join(outsider, 'jogos');

  const screenState = waitForEvent<VoiceState[]>(viewer, 'voice:members', (members) => members.some((member) => member.socketId === streamer.id && member.screen && member.screenAudio));
  streamer.emit('voice:state', { screen: true, screenAudio: true, camera: false });
  await screenState;

  viewer.disconnect();
  sockets.splice(sockets.indexOf(viewer), 1);
  viewer = await connect(url, viewerToken);
  sockets.push(viewer);
  const peerJoined = waitForEvent<VoiceState>(streamer, 'voice:peer-joined', (member) => member.id === 'Viewer QA' || member.username === 'Viewer QA');
  const viewerRejoin = await join(viewer, 'call-geral');
  await peerJoined;
  const streamerAfterRejoin = viewerRejoin.peers.find((member) => member.socketId === streamer.id);
  assert.equal(streamerAfterRejoin?.screen, true, 'o estado AO VIVO deve sobreviver à saída e volta do espectador');
  assert.equal(streamerAfterRejoin?.screenAudio, true, 'a expectativa de áudio da live também deve sobreviver à reconexão');

  const metaReceived = waitForEvent<{ from: string; meta: { streamId: string; kind: string } }>(viewer, 'rtc:stream-meta');
  streamer.emit('rtc:stream-meta', { target: viewer.id, meta: { streamId: 'screen-stream-qa', kind: 'screen' } });
  assert.deepEqual((await metaReceived).meta, { streamId: 'screen-stream-qa', kind: 'screen' });

  const healthReceived = waitForEvent<{ from: string; frozen: boolean }>(streamer, 'rtc:stream-health', (payload) => payload.from === viewer.id && payload.frozen);
  viewer.emit('rtc:stream-health', { target: streamer.id, frozen: true });
  await healthReceived;

  const resyncReceived = waitForEvent<{ from: string }>(streamer, 'rtc:resync', (payload) => payload.from === viewer.id);
  viewer.emit('rtc:resync', { target: streamer.id });
  await resyncReceived;

  let leakedAcrossRooms = false;
  streamer.once('rtc:resync', () => { leakedAcrossRooms = true; });
  outsider.emit('rtc:resync', { target: streamer.id });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(leakedAcrossRooms, false, 'sinalização nunca deve atravessar salas de voz');
});
