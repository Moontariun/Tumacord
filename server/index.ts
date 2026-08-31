import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Channel, PublicUser, ServerSnapshot, StreamMeta, UserProfile } from '../shared/types.js';
import { createToken, hashPassword, normalizeUsername, verifyPassword } from './auth.js';
import { JsonStore, type StoredUser } from './store.js';
import { VoiceRooms } from './voiceRooms.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3927);
const serverName = process.env.SERVER_NAME?.trim() || 'Tumacord da Turma';
const dataDirectory = process.env.DATA_DIR ?? './data';
const sessionTtl = Number(process.env.SESSION_TTL_DAYS ?? 30) * 86_400_000;
const store = new JsonStore(dataDirectory);
const storeReady = store.load();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: false }, maxHttpBufferSize: 4e6 });
const rooms = new VoiceRooms();
const handoffRooms = new Set<string>();
const sessions = new Map<string, { userId: string; expiresAt: number }>();
const connectedUsers = new Map<string, PublicUser>();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const credentialsInput = z.object({
  username: z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}_. -]+$/u),
  password: z.string().min(4).max(128),
});
const loginInput = credentialsInput.extend({ allowCreate: z.boolean().optional() });
const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  previewDataUrl: z.string().max(120_000).regex(/^data:image\/(?:jpeg|png|webp);base64,/).optional(),
});
const replicatedMessageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().min(1).max(80),
  author: z.object({ id: z.string().min(1).max(80), username: z.string().trim().min(1).max(24) }),
  body: z.string().max(2000),
  createdAt: z.string().datetime(),
  attachment: attachmentSchema.optional(),
});
const replicatedChannelSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(32), type: z.enum(['text', 'voice']) });
const syncBundleSchema = z.object({
  channels: z.array(replicatedChannelSchema).max(100),
  messages: z.array(replicatedMessageSchema).max(500),
  availableAttachmentIds: z.array(z.string().uuid()).max(500).optional().default([]),
});
const profileMediaSchema = z.object({ id: z.string().uuid(), mimeType: z.string().regex(/^image\/(?:gif|png|jpeg|webp)$/) });
const profileSchema = z.object({
  bio: z.string().trim().max(190).default(''),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ff5c5c'),
  avatar: profileMediaSchema.optional(),
  banner: profileMediaSchema.optional(),
});

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, name: serverName, users: connectedUsers.size, version: '0.2.0' });
});

async function issueSession(user: StoredUser): Promise<string> {
  const token = createToken();
  const session = { userId: user.id, expiresAt: Date.now() + sessionTtl };
  sessions.set(token, session);
  await store.addSession({ token, ...session });
  return token;
}

app.post('/api/auth/register', async (request, response) => {
  const parsed = credentialsInput.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Use um nome de 2–24 caracteres e uma senha de pelo menos 4.' });
    return;
  }
  const normalizedUsername = normalizeUsername(parsed.data.username);
  if (store.users.some((candidate) => candidate.normalizedUsername === normalizedUsername)) {
    response.status(409).json({ error: 'Esse usuário já existe. Escolha outro nome ou entre na conta.' });
    return;
  }
  const user = {
    id: randomUUID(),
    username: parsed.data.username.trim(),
    normalizedUsername,
    passwordHash: await hashPassword(parsed.data.password),
    createdAt: new Date().toISOString(),
  } satisfies StoredUser;
  await store.addUser(user);
  response.status(201).json({ token: await issueSession(user), user: publicUser(user), serverName, created: true });
});

app.post('/api/auth/login', async (request, response) => {
  const parsed = loginInput.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Use um nome de 2–24 caracteres e uma senha de pelo menos 4.' });
    return;
  }
  const normalizedUsername = normalizeUsername(parsed.data.username);
  let user = store.users.find((candidate) => candidate.normalizedUsername === normalizedUsername);
  if (!user && !parsed.data.allowCreate) {
    response.status(404).json({ error: 'Conta não encontrada. Clique em “Criar conta” para se cadastrar.' });
    return;
  }
  if (!user) {
    user = {
      id: randomUUID(),
      username: parsed.data.username.trim(),
      normalizedUsername,
      passwordHash: await hashPassword(parsed.data.password),
      createdAt: new Date().toISOString(),
    } satisfies StoredUser;
    await store.addUser(user);
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    response.status(401).json({ error: 'Senha incorreta.' });
    return;
  }
  response.json({ token: await issueSession(user), user: publicUser(user), serverName, created: false });
});

function publicUser(user: StoredUser): PublicUser {
  return { id: user.id, username: user.username, profile: user.profile };
}

function authenticatedUser(token: unknown): PublicUser | undefined {
  if (typeof token !== 'string') return undefined;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    void store.removeSession(token);
    return undefined;
  }
  const user = store.users.find((candidate) => candidate.id === session.userId);
  return user ? publicUser(user) : undefined;
}

function httpUser(request: express.Request): PublicUser | undefined {
  const authorization = request.headers.authorization;
  return authenticatedUser(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);
}

function isLoopbackRequest(request: express.Request): boolean {
  const address = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
  return address === '127.0.0.1' || address === '::1';
}

function decodedHeader(value: string | string[] | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try { return decodeURIComponent(value); } catch { return fallback; }
}

function attachmentHeaders(id: string): { name: string; mimeType: string } {
  const attachment = store.messages.find((message) => message.attachment?.id === id)?.attachment;
  return { name: attachment?.name ?? 'arquivo', mimeType: attachment?.mimeType ?? 'application/octet-stream' };
}

async function sendAttachment(id: string, response: express.Response): Promise<void> {
  if (!(await store.hasAttachment(id))) {
    response.status(404).json({ error: 'Arquivo não está neste computador.' });
    return;
  }
  const contents = await store.readAttachment(id);
  const metadata = attachmentHeaders(id);
  response.setHeader('content-type', metadata.mimeType);
  response.setHeader('content-length', String(contents.length));
  response.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`);
  response.send(contents);
}

app.post('/api/attachments', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (request, response) => {
  if (!httpUser(request)) return void response.status(401).json({ error: 'Sessão inválida.' });
  const contents = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const name = decodedHeader(request.headers['x-file-name'], 'arquivo').trim().slice(0, 200);
  const mimeType = decodedHeader(request.headers['x-file-type'], 'application/octet-stream').trim().slice(0, 120) || 'application/octet-stream';
  if (!contents.length || contents.length > 25 * 1024 * 1024) return void response.status(400).json({ error: 'O arquivo precisa ter entre 1 byte e 25 MB.' });
  const id = randomUUID();
  await store.saveAttachment(id, contents);
  response.status(201).json({ id, name, mimeType, size: contents.length });
});

app.get('/api/attachments/:id', async (request, response) => {
  if (!httpUser(request)) return void response.status(401).json({ error: 'Sessão inválida.' });
  const parsed = z.string().uuid().safeParse(request.params.id);
  if (!parsed.success) return void response.status(400).json({ error: 'Arquivo inválido.' });
  await sendAttachment(parsed.data, response);
});

app.post('/api/profile/media', express.raw({ type: ['image/gif', 'image/png', 'image/jpeg', 'image/webp'], limit: '6mb' }), async (request, response) => {
  if (!httpUser(request)) return void response.status(401).json({ error: 'Sessão inválida.' });
  const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
  const parsedType = z.string().regex(/^image\/(?:gif|png|jpeg|webp)$/).safeParse(mimeType);
  const contents = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (!parsedType.success || !contents.length || contents.length > 6 * 1024 * 1024) return void response.status(400).json({ error: 'Use GIF, PNG, JPG ou WebP de até 6 MB.' });
  const id = randomUUID();
  await store.saveAttachment(id, contents);
  response.status(201).json({ id, mimeType: parsedType.data });
});

app.get('/api/profile/media/:id', async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id);
  if (!id.success || !(await store.hasAttachment(id.data))) return void response.status(404).end();
  const media = store.users.flatMap((candidate) => [candidate.profile?.avatar, candidate.profile?.banner]).find((candidate) => candidate?.id === id.data);
  if (!media) return void response.status(404).end();
  const contents = await store.readAttachment(id.data);
  response.setHeader('content-type', media.mimeType);
  response.setHeader('cache-control', 'public, max-age=31536000, immutable');
  response.send(contents);
});

app.put('/api/profile', async (request, response) => {
  const user = httpUser(request);
  if (!user) return void response.status(401).json({ error: 'Sessão inválida.' });
  const parsed = profileSchema.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: 'Perfil inválido.' });
  const referenced = [parsed.data.avatar, parsed.data.banner].filter(Boolean) as UserProfile['avatar'][];
  if ((await Promise.all(referenced.map((media) => store.hasAttachment(media!.id)))).some((exists) => !exists)) return void response.status(400).json({ error: 'Uma das imagens não chegou ao servidor.' });
  const updated = await store.updateUserProfile(user.id, parsed.data);
  if (!updated) return void response.status(404).json({ error: 'Usuário não encontrado.' });
  const nextUser = publicUser(updated);
  for (const [socketId, connected] of connectedUsers) {
    if (connected.id !== user.id) continue;
    connectedUsers.set(socketId, nextUser);
    const connectedSocket = io.sockets.sockets.get(socketId);
    if (connectedSocket) connectedSocket.data.user = nextUser;
  }
  for (const channelId of rooms.updateUser(nextUser)) io.to(`voice:${channelId}`).emit('voice:members', rooms.members(channelId));
  broadcastSnapshot();
  response.json(nextUser);
});

app.get('/api/peer/attachments/:id', async (request, response) => {
  const parsed = z.string().uuid().safeParse(request.params.id);
  if (!parsed.success) return void response.status(400).end();
  await sendAttachment(parsed.data, response);
});

app.get('/api/local/sync', async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).json({ error: 'Disponível apenas localmente.' });
  response.json({
    channels: [...store.channels],
    messages: store.messages.slice(-500),
    availableAttachmentIds: await store.availableAttachmentIds(),
  });
});

app.post('/api/local/sync', async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).json({ error: 'Disponível apenas localmente.' });
  const parsed = syncBundleSchema.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: 'Histórico inválido.' });
  await store.mergeChannels(parsed.data.channels);
  await store.mergeMessages(parsed.data.messages);
  response.json({ ok: true });
});

app.put('/api/local/attachments/:id', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).end();
  const parsed = z.string().uuid().safeParse(request.params.id);
  const contents = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (!parsed.success || !contents.length || contents.length > 25 * 1024 * 1024) return void response.status(400).end();
  await store.saveAttachment(parsed.data, contents);
  response.json({ ok: true });
});

app.get('/api/local/attachments/:id', async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).end();
  const parsed = z.string().uuid().safeParse(request.params.id);
  if (!parsed.success) return void response.status(400).end();
  await sendAttachment(parsed.data, response);
});

function snapshot(): ServerSnapshot {
  const uniqueUsers = [...new Map([...connectedUsers.values()].map((user) => [user.id, user])).values()];
  return { serverName, channels: [...store.channels], onlineUsers: uniqueUsers, voiceRooms: rooms.snapshot() };
}

function broadcastSnapshot(): void {
  io.emit('server:snapshot', snapshot());
}

io.use((socket, next) => {
  const user = authenticatedUser(socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user as PublicUser;
  connectedUsers.set(socket.id, user);
  socket.emit('server:snapshot', snapshot());
  broadcastSnapshot();

  socket.on('chat:history', (channelId: unknown, acknowledge: (messages: unknown[]) => void) => {
    if (typeof channelId !== 'string') return acknowledge([]);
    acknowledge(store.messages.filter((message) => message.channelId === channelId).slice(-500));
  });

  socket.on('chat:send', async (payload: unknown) => {
    const parsed = z.object({ channelId: z.string(), body: z.string().trim().max(2000).default(''), attachment: attachmentSchema.optional() })
      .refine((value) => Boolean(value.body || value.attachment), { message: 'Mensagem vazia.' })
      .safeParse(payload);
    if (!parsed.success || !store.channels.some((channel) => channel.id === parsed.data.channelId && channel.type === 'text')) return;
    if (parsed.data.attachment && !(await store.hasAttachment(parsed.data.attachment.id))) return;
    const message = { id: randomUUID(), ...parsed.data, author: user, createdAt: new Date().toISOString() };
    await store.addMessage(message);
    io.emit('chat:message', message);
  });

  socket.on('chat:sync:push', async (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = syncBundleSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false });
    const addedChannels = await store.mergeChannels(parsed.data.channels);
    const addedMessages = await store.mergeMessages(parsed.data.messages);
    if (addedChannels.length) broadcastSnapshot();
    if (addedMessages.length) io.emit('chat:sync:messages', addedMessages);
    acknowledge?.({
      ok: true,
      channels: [...store.channels],
      messages: store.messages.slice(-500),
      availableAttachmentIds: await store.availableAttachmentIds(),
    });
  });

  socket.on('chat:file:find', (payload: unknown) => {
    const parsed = z.object({ requestId: z.string().uuid(), attachmentId: z.string().uuid() }).safeParse(payload);
    if (!parsed.success) return;
    socket.broadcast.emit('chat:file:find', { ...parsed.data, requester: socket.id });
  });

  socket.on('chat:file:offer', (payload: unknown) => {
    const parsed = z.object({ requestId: z.string().uuid(), attachmentId: z.string().uuid(), requester: z.string().min(1) }).safeParse(payload);
    if (!parsed.success || !io.sockets.sockets.has(parsed.data.requester)) return;
    io.to(parsed.data.requester).emit('chat:file:offer', {
      requestId: parsed.data.requestId,
      attachmentId: parsed.data.attachmentId,
      url: `${endpointFor(socket.handshake.address)}/api/peer/attachments/${parsed.data.attachmentId}`,
    });
  });

  socket.on('channel:create', async (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(32), type: z.enum(['text', 'voice']) }).safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false });
    const slug = parsed.data.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || randomUUID().slice(0, 8);
    const channel: Channel = { id: `${slug}-${randomUUID().slice(0, 4)}`, ...parsed.data };
    await store.addChannel(channel);
    broadcastSnapshot();
    acknowledge?.({ ok: true, channel });
  });

  socket.on('voice:join', (input: unknown, acknowledge: (result: unknown) => void) => {
    const channelId = typeof input === 'string' ? input : z.object({ channelId: z.string() }).safeParse(input).data?.channelId;
    if (typeof channelId !== 'string' || !store.channels.some((channel) => channel.id === channelId && channel.type === 'voice')) return;
    const previousChannels = rooms.leaveEverywhere(socket.id);
    for (const previous of previousChannels) {
      socket.leave(`voice:${previous}`);
      io.to(`voice:${previous}`).emit('voice:peer-left', socket.id);
      io.to(`voice:${previous}`).emit('voice:members', rooms.members(previous));
    }
    const existingPeers = rooms.members(channelId);
    socket.join(`voice:${channelId}`);
    rooms.join(channelId, { ...user, socketId: socket.id, endpoint: endpointFor(socket.handshake.address) });
    acknowledge({ ok: true, selfId: socket.id, peers: existingPeers });
    // Participantes que já estavam na call mantêm câmera/tela locais. Este
    // aviso faz cada um recriar apenas o enlace P2P do usuário que voltou,
    // sem reiniciar a live nem alterar o estado visual da sala.
    socket.to(`voice:${channelId}`).emit('voice:peer-joined', rooms.members(channelId).find((member) => member.socketId === socket.id));
    io.to(`voice:${channelId}`).emit('voice:members', rooms.members(channelId));
    broadcastSnapshot();
  });

  socket.on('voice:leave', () => leaveVoice(socket.id));

  socket.on('voice:state', (patch: unknown) => {
    const channelId = rooms.roomOf(socket.id);
    const parsed = z.object({ muted: z.boolean().optional(), speaking: z.boolean().optional(), deafened: z.boolean().optional(), camera: z.boolean().optional(), screen: z.boolean().optional() }).safeParse(patch);
    if (!channelId || !parsed.success) return;
    io.to(`voice:${channelId}`).emit('voice:members', rooms.update(channelId, socket.id, parsed.data));
    broadcastSnapshot();
  });

  socket.on('voice:latency', (value: unknown) => {
    const channelId = rooms.roomOf(socket.id);
    const parsed = z.number().finite().min(0).max(9999).safeParse(value);
    if (!channelId || !parsed.success) return;
    io.to(`voice:${channelId}`).emit('voice:members', rooms.updatePing(channelId, socket.id, parsed.data));
  });

  for (const event of ['rtc:offer', 'rtc:answer', 'rtc:ice', 'rtc:resync'] as const) {
    socket.on(event, (payload: { target?: unknown; [key: string]: unknown }) => {
      if (typeof payload?.target !== 'string' || !sameVoiceRoom(socket.id, payload.target)) return;
      const { target, ...forwarded } = payload;
      io.to(target).emit(event, { ...forwarded, from: socket.id, user });
    });
  }

  socket.on('rtc:stream-meta', (payload: { target?: unknown; meta?: StreamMeta }) => {
    if (typeof payload?.target !== 'string' || !sameVoiceRoom(socket.id, payload.target)) return;
    io.to(payload.target).emit('rtc:stream-meta', { from: socket.id, meta: payload.meta });
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    leaveVoice(socket.id);
    broadcastSnapshot();
  });

  // Cada entrada pede uma rodada curta de mesclagem. Assim, qualquer pessoa
  // online pode devolver ao host atual mensagens que ele ainda não possua.
  io.emit('chat:sync:request');
});

function sameVoiceRoom(first: string, second: string): boolean {
  return Boolean(rooms.roomOf(first) && rooms.roomOf(first) === rooms.roomOf(second));
}

function endpointFor(rawAddress: string): string {
  const address = rawAddress.replace(/^::ffff:/, '');
  const printable = address.includes(':') ? `[${address}]` : address;
  return `http://${printable}:${port}`;
}

function leaveVoice(socketId: string): void {
  const channelId = rooms.roomOf(socketId);
  if (!channelId) return;
  const leavingWasHost = rooms.members(channelId).some((member) => member.socketId === socketId && member.isHost);
  const remaining = rooms.leave(channelId, socketId);
  const leavingSocket = io.sockets.sockets.get(socketId);
  leavingSocket?.leave(`voice:${channelId}`);
  io.to(`voice:${channelId}`).emit('voice:peer-left', socketId);
  io.to(`voice:${channelId}`).emit('voice:members', remaining);
  if (leavingWasHost && remaining.length && !handoffRooms.has(channelId)) {
    const nextHost = remaining.find((member) => member.isHost);
    if (nextHost) {
      handoffRooms.add(channelId);
      io.to(`voice:${channelId}`).emit('voice:host-handoff', { channelId, host: nextHost, switchAt: Date.now() + 800 });
      setTimeout(() => handoffRooms.delete(channelId), 5000).unref();
    }
  }
  broadcastSnapshot();
}

const webDirectory = path.resolve(process.env.WEB_DIR ?? './dist-web');
if (existsSync(webDirectory)) {
  app.use(express.static(webDirectory));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) return next();
    response.sendFile(path.join(webDirectory, 'index.html'));
  });
}

storeReady.then(async () => {
  await store.pruneSessions();
  for (const session of store.sessions) sessions.set(session.token, { userId: session.userId, expiresAt: session.expiresAt });
  httpServer.listen(port, host, () => {
    console.log(`🍅 ${serverName} em http://${host}:${port}`);
  });
}).catch((error) => {
  console.error('Falha ao iniciar o servidor Tumacord:', error);
  process.exitCode = 1;
});
