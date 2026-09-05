import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { z } from 'zod';
import packageMetadata from '../package.json' with { type: 'json' };
import type { AdminOverview, Channel, PublicUser, ServerSnapshot, StreamMeta, UserProfile } from '../shared/types.js';
import { safeAttachmentName } from '../shared/attachmentName.js';
import { isTrustedLocalAddress } from '../shared/directLink.js';
import { createToken, hashPassword, hashToken, normalizeUsername, proveKey, verifyPassword, verifySecret } from './auth.js';
import { ephemeralTurnCredentials, turnConfiguration, turnIceServers } from './turn.js';
import { AuthRateLimiter } from './rateLimit.js';
import { canManageChannels, canManageUsers, isAdministrator, normalizeRole, planRemoval, planRoleChange, roleForNewUser, type Role } from './roles.js';
import { applyOrder, buildChannelTree, canChangeChannelType, canDeleteChannel, slugify, validateCategoryName, validateChannelName, validateTopic, validateUserLimit } from './channels.js';
import { createAuditEntry } from './audit.js';
import { JsonStore, type StoredUser } from './store.js';
import { VoiceRooms } from './voiceRooms.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3927);
const serverName = process.env.SERVER_NAME?.trim() || 'Tumacord';
const dataDirectory = process.env.DATA_DIR ?? './data';
const sessionTtl = Number(process.env.SESSION_TTL_DAYS ?? 30) * 86_400_000;
const serverVersion = packageMetadata.version;
const startedAt = new Date();
const p2pMode = process.env.TUMACORD_P2P_MODE === '1';
const serveWeb = process.env.TUMACORD_SERVE_WEB !== '0';
const serverAccessKey = process.env.SERVER_ACCESS_KEY?.trim() ?? '';
const adminUsername = normalizeUsername(process.env.ADMIN_USERNAME?.trim() || 'Moontariun');
// Chave do enlace direto. Ela existe porque, sem ZeroTier, a porta de
// sinalização passa a aceitar conexão vinda da internet: quem chega de fora da
// rede local precisa apresentar o convite. Endereço da própria rede continua
// entrando sem chave, exatamente como a descoberta por broadcast sempre fez.
const directKey = process.env.TUMACORD_DIRECT_KEY?.trim() ?? '';
// O relay TURN é a rede de segurança para o caso em que nem o enlace direto
// nem o ICE atravessam: os dois lados atrás de CGNAT simétrico, sem IPv6.
// Quando não está configurado, o servidor simplesmente não anuncia nada.
const turn = turnConfiguration(process.env);
const loginLimiter = new AuthRateLimiter();
const tlsCertificateFile = process.env.TLS_CERT_FILE?.trim();
const tlsKeyFile = process.env.TLS_KEY_FILE?.trim();
if (Boolean(tlsCertificateFile) !== Boolean(tlsKeyFile)) throw new Error('TLS_CERT_FILE e TLS_KEY_FILE precisam ser configurados juntos.');
const tlsEnabled = Boolean(tlsCertificateFile && tlsKeyFile);
const store = new JsonStore(dataDirectory);
const storeReady = store.load();

const app = express();
const httpServer = tlsEnabled
  ? createHttpsServer({ cert: readFileSync(tlsCertificateFile!), key: readFileSync(tlsKeyFile!) }, app)
  : createHttpServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: false }, maxHttpBufferSize: 4e6 });
const rooms = new VoiceRooms();
const sessions = new Map<string, { userId: string; expiresAt: number }>();
const connectedUsers = new Map<string, PublicUser>();
const p2pTextChannelId = 'geral';
const p2pVoiceChannelId = 'call-geral';

function availableChannels(): Channel[] {
  if (!p2pMode) return [...store.channels];
  const text = store.channels.find((channel) => channel.id === p2pTextChannelId && channel.type === 'text')
    ?? store.channels.find((channel) => channel.type === 'text');
  const voice = store.channels.find((channel) => channel.id === p2pVoiceChannelId && channel.type === 'voice')
    ?? store.channels.find((channel) => channel.type === 'voice');
  return [text, voice].filter((channel): channel is Channel => Boolean(channel));
}

function channelIsAvailable(channelId: string, type?: Channel['type']): boolean {
  return availableChannels().some((channel) => channel.id === channelId && (!type || channel.type === type));
}

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '8mb' }));

function requestAddress(request: express.Request): string {
  return request.socket.remoteAddress ?? '';
}

function presentedDirectKey(request: express.Request): string {
  const header = request.headers['x-tumacord-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const body = request.body as { serverKey?: unknown } | undefined;
  return typeof body?.serverKey === 'string' ? body.serverKey.trim() : '';
}

// A chave não é da máquina, é da call. Quando o host sai, quem assume precisa
// aceitar o mesmo convite que já circulou entre os amigos — senão a troca
// automática de host deixaria todo mundo com um código que não abre mais nada.
// Por isso o servidor aceita um conjunto: a chave própria mais as adotadas ao
// entrar em uma call pelo convite de outra pessoa.
const acceptedDirectKeys = new Set<string>(directKey ? [directKey] : []);
const MAX_ACCEPTED_DIRECT_KEYS = 8;

function directKeyMatches(presented: string): boolean {
  if (!presented) return false;
  for (const candidate of acceptedDirectKeys) {
    if (verifySecret(presented, candidate)) return true;
  }
  return false;
}

function directAccessAllowed(request: express.Request): boolean {
  if (!acceptedDirectKeys.size) return true;
  if (isTrustedLocalAddress(requestAddress(request))) return true;
  if (httpUser(request)) return true;
  return directKeyMatches(presentedDirectKey(request));
}

// A liberação vale para a API inteira, e não só para o login: anexo e
// sincronização também são dados do grupo. Três exceções, e o motivo de cada
// uma: `/api/health` e `/api/direct/hello` são o que o convite consulta para
// escolher o caminho, e a leitura de mídia de perfil é o avatar dentro de uma
// tag `<img>`, que não tem como enviar cabeçalho. Avatar e banner já são
// replicados para todo participante e ficam atrás de um UUID sorteado.
function directGateExempt(request: express.Request): boolean {
  if (request.path === '/api/health' || request.path === '/api/direct/hello') return true;
  return request.method === 'GET' && request.path.startsWith('/api/profile/media/');
}

app.use((request, response, next) => {
  if (!request.path.startsWith('/api/') || directGateExempt(request)) return next();
  if (directAccessAllowed(request)) return next();
  response.status(403).json({ error: 'Esta call exige o código de convite do host.' });
});

const credentialsInput = z.object({
  username: z.string().trim().min(2).max(24).regex(/^[\p{L}\p{N}_. -]+$/u),
  password: z.string().min(4).max(128),
  serverKey: z.string().max(256).optional().default(''),
});
const loginInput = credentialsInput.extend({ allowCreate: z.boolean().optional() });
const attachmentMimeTypeSchema = z.string().trim().min(1).max(120)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).transform((name) => safeAttachmentName(name)),
  mimeType: attachmentMimeTypeSchema,
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
const profileMediaSchema = z.object({ id: z.string().uuid(), mimeType: z.string().regex(/^image\/(?:gif|png|jpeg|webp)$/) });
const profileSchema = z.object({
  bio: z.string().trim().max(190).default(''),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ff5c5c'),
  avatar: profileMediaSchema.optional(),
  banner: profileMediaSchema.optional(),
  updatedAt: z.string().datetime().optional(),
});
const replicatedProfileSchema = z.object({
  username: z.string().trim().min(1).max(24),
  profile: profileSchema.extend({ updatedAt: z.string().datetime() }),
});
const syncBundleSchema = z.object({
  channels: z.array(replicatedChannelSchema).max(100),
  messages: z.array(replicatedMessageSchema).max(500),
  profiles: z.array(replicatedProfileSchema).max(200).optional().default([]),
  availableAttachmentIds: z.array(z.string().uuid()).max(500).optional().default([]),
});
const rtcTargetSchema = z.string().min(1).max(160);
const rtcOfferSchema = z.object({ target: rtcTargetSchema, sdp: z.object({ type: z.literal('offer'), sdp: z.string().max(1_000_000) }) });
const rtcAnswerSchema = z.object({ target: rtcTargetSchema, sdp: z.object({ type: z.literal('answer'), sdp: z.string().max(1_000_000) }) });
const rtcIceSchema = z.object({
  target: rtcTargetSchema,
  candidate: z.object({
    candidate: z.string().max(8_192),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(256).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }),
});
const rtcResyncSchema = z.object({ target: rtcTargetSchema });
const rtcStreamHealthSchema = z.object({ target: rtcTargetSchema, frozen: z.boolean() });
const rtcStreamMetaSchema = z.object({ target: rtcTargetSchema, meta: z.object({ streamId: z.string().min(1).max(256), kind: z.enum(['camera', 'screen']) }) });

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    name: serverName,
    users: connectedUsers.size,
    version: serverVersion,
    mode: p2pMode ? 'p2p' : 'server',
    web: serveWeb,
    security: { accessKeyRequired: Boolean(serverAccessKey), tls: tlsEnabled, media: 'DTLS-SRTP' },
    turn: Boolean(turn),
  });
});

// As credenciais são curtas e assinadas na hora; o servidor não guarda senha
// de TURN nenhuma. Exigir sessão evita que a porta vire um relay aberto para
// quem passar na frente.
app.get('/api/turn', (request, response) => {
  const user = httpUser(request);
  if (!user) return void response.status(401).json({ error: 'Sessão inválida.' });
  if (!turn) return void response.json({ iceServers: [], expiresAt: 0 });
  const credentials = ephemeralTurnCredentials(turn, user.username);
  response.json({ iceServers: turnIceServers(turn, credentials), expiresAt: credentials.expiresAt });
});

// O host prova que é ele mesmo devolvendo um HMAC do nonce com a chave do
// convite. Sem isso, um endereço reaproveitado por outra máquina receberia
// usuário e senha de quem tentasse entrar por um convite antigo.
app.get('/api/direct/hello', (request, response) => {
  const nonce = typeof request.query.nonce === 'string' ? request.query.nonce.slice(0, 128) : '';
  response.json({
    ok: true,
    version: serverVersion,
    mode: p2pMode ? 'p2p' : 'server',
    requiresKey: acceptedDirectKeys.size > 0,
    // Uma prova por chave aceita. Quem chegou com o convite reconhece a sua na
    // lista; as outras não dizem nada sobre as chaves em si.
    proofs: nonce ? [...acceptedDirectKeys].map((candidate) => proveKey(candidate, nonce)) : [],
  });
});

// Só o próprio computador adota chave: é a interface avisando "entrei nesta
// call, passe a aceitar este convite também".
app.post('/api/direct/keys', requireLoopback, (request, response) => {
  const parsed = z.object({ key: z.string().trim().min(22).max(256) }).safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: 'Chave de convite inválida.' });
  if (!directKeyMatches(parsed.data.key)) {
    acceptedDirectKeys.add(parsed.data.key);
    while (acceptedDirectKeys.size > MAX_ACCEPTED_DIRECT_KEYS) acceptedDirectKeys.delete([...acceptedDirectKeys][0]);
  }
  response.json({ ok: true, accepted: acceptedDirectKeys.size });
});

function hasServerAccess(serverKey: string): boolean {
  return !serverAccessKey || verifySecret(serverKey, serverAccessKey);
}

async function issueSession(user: StoredUser): Promise<string> {
  const token = createToken();
  const session = { userId: user.id, expiresAt: Date.now() + sessionTtl };
  const tokenHash = hashToken(token);
  sessions.set(tokenHash, session);
  await store.addSession({ tokenHash, ...session });
  return token;
}

app.post('/api/auth/register', async (request, response) => {
  const parsed = credentialsInput.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Use um nome de 2–24 caracteres e uma senha de pelo menos 4.' });
    return;
  }
  if (!hasServerAccess(parsed.data.serverKey)) {
    response.status(403).json({ error: 'Chave do servidor incorreta.' });
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
    role: p2pMode ? 'member' : roleForNewUser(store.users, normalizedUsername, adminUsername),
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
  const origin = requestAddress(request);
  const identity = normalizeUsername(parsed.data.username);
  const gate = loginLimiter.check(identity, origin);
  if (!gate.allowed) {
    const seconds = Math.ceil(gate.retryAfterMs / 1000);
    response.setHeader('retry-after', String(seconds));
    response.status(429).json({ error: `Muitas tentativas seguidas. Tente de novo em ${seconds} s.` });
    return;
  }
  if (!hasServerAccess(parsed.data.serverKey)) {
    loginLimiter.fail(identity, origin);
    response.status(403).json({ error: 'Chave do servidor incorreta.' });
    return;
  }
  const normalizedUsername = identity;
  let user = store.users.find((candidate) => candidate.normalizedUsername === normalizedUsername);
  let created = false;
  if (!user && !parsed.data.allowCreate) {
    response.status(404).json({ error: 'Conta não encontrada. Clique em “Criar conta” para se cadastrar.' });
    return;
  }
  if (!user) {
    created = true;
    user = {
      id: randomUUID(),
      username: parsed.data.username.trim(),
      normalizedUsername,
      passwordHash: await hashPassword(parsed.data.password),
      createdAt: new Date().toISOString(),
      role: p2pMode ? 'member' : roleForNewUser(store.users, normalizedUsername, adminUsername),
    } satisfies StoredUser;
    await store.addUser(user);
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    loginLimiter.fail(identity, origin);
    response.status(401).json({ error: 'Senha incorreta.' });
    return;
  }
  loginLimiter.succeed(identity, origin);
  response.json({ token: await issueSession(user), user: publicUser(user), serverName, created });
});

function publicUser(user: StoredUser): PublicUser {
  // No modo P2P não existe administração de servidor: cada pessoa é dona do
  // próprio servidor embutido, e um papel ali não significaria nada.
  const role = p2pMode ? 'member' : normalizeRole(user.role);
  return {
    id: user.id,
    username: user.username,
    profile: store.profileForUsername(user.username) ?? user.profile,
    ...(isAdministrator(role) ? { isAdmin: true } : {}),
    ...(p2pMode ? {} : { role }),
  };
}

function roleOfSocket(socket: { data: { user?: PublicUser } }): Role {
  return p2pMode ? 'member' : normalizeRole(socket.data.user?.role);
}

function authenticatedUser(token: unknown): PublicUser | undefined {
  if (typeof token !== 'string') return undefined;
  const tokenHash = hashToken(token);
  const session = sessions.get(tokenHash);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(tokenHash);
    void store.removeSession(tokenHash);
    return undefined;
  }
  const user = store.users.find((candidate) => candidate.id === session.userId);
  return user ? publicUser(user) : undefined;
}

function httpUser(request: express.Request): PublicUser | undefined {
  const authorization = request.headers.authorization;
  return authenticatedUser(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);
}

function adminOverview(): AdminOverview {
  return {
    serverName,
    version: serverVersion,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    onlineUsers: [...new Map([...connectedUsers.values()].map((user) => [user.id, user])).values()],
    channels: availableChannels(),
    voiceRooms: rooms.snapshot(),
    security: { accessKeyRequired: Boolean(serverAccessKey), tls: tlsEnabled, media: 'DTLS-SRTP' },
  };
}

// Toda ação administrativa passa por aqui. A interface pode esconder um botão,
// mas quem decide é o servidor: esconder não é autorizar.
interface AdminContext { user: PublicUser; role: Role }

function requireAdmin(request: express.Request, response: express.Response): AdminContext | null {
  const user = httpUser(request);
  const role = p2pMode ? 'member' : normalizeRole(store.users.find((candidate) => candidate.id === user?.id)?.role);
  if (!user || !isAdministrator(role)) {
    response.status(403).json({ error: 'Acesso exclusivo da administração do servidor.' });
    return null;
  }
  return { user, role };
}

async function audit(actor: PublicUser, action: string, target?: string, result: 'ok' | 'denied' | 'error' = 'ok', detail?: unknown): Promise<void> {
  await store.recordAudit(createAuditEntry({
    id: randomUUID(), actorId: actor.id, actorUsername: actor.username, action, target, result, detail,
  })).catch(() => undefined);
}

// Um único ponto de difusão: quem está com o app aberto vê a mudança sem
// recarregar nada.
function broadcastChannels(): void {
  io.emit('server:channels', { channels: availableChannels(), categories: store.categories });
  broadcastSnapshot();
}

function refuse(response: express.Response, status: number, error: string): void {
  response.status(status).json({ error });
}

app.get('/api/admin/audit', (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  response.json({ entries: store.auditLog.slice(0, 200) });
});

app.get('/api/admin/users', (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const online = new Set([...connectedUsers.values()].map((user) => user.id));
  const sessoes = new Map<string, number>();
  for (const sessao of store.sessions) sessoes.set(sessao.userId, (sessoes.get(sessao.userId) ?? 0) + 1);
  response.json({
    users: store.users.map((user) => ({
      id: user.id,
      username: user.username,
      role: normalizeRole(user.role),
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      online: online.has(user.id),
      sessions: sessoes.get(user.id) ?? 0,
    })),
    ownerCount: store.ownerCount,
  });
});

app.post('/api/admin/users/:id/role', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const alvo = store.users.find((candidate) => candidate.id === request.params.id);
  const proximo = normalizeRole((request.body as { role?: unknown } | undefined)?.role);
  if (!alvo) return refuse(response, 404, 'Esse usuário não existe.');
  const veredito = planRoleChange({
    actorId: context.user.id, actorRole: context.role,
    targetId: alvo.id, targetRole: normalizeRole(alvo.role),
    nextRole: proximo, ownerCount: store.ownerCount,
  });
  if (!veredito.allowed) {
    await audit(context.user, 'user.role', alvo.username, 'denied', veredito.error);
    return refuse(response, 403, veredito.error ?? 'Ação não permitida.');
  }
  await store.setUserRole(alvo.id, proximo);
  await audit(context.user, 'user.role', alvo.username, 'ok', `papel agora é ${proximo}`);
  refreshProfilePresence(new Set([alvo.normalizedUsername]));
  response.json({ ok: true, id: alvo.id, role: proximo });
});

app.delete('/api/admin/users/:id', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const alvo = store.users.find((candidate) => candidate.id === request.params.id);
  if (!alvo) return refuse(response, 404, 'Esse usuário não existe.');
  const veredito = planRemoval({
    actorId: context.user.id, actorRole: context.role,
    targetId: alvo.id, targetRole: normalizeRole(alvo.role), ownerCount: store.ownerCount,
  });
  if (!veredito.allowed) {
    await audit(context.user, 'user.remove', alvo.username, 'denied', veredito.error);
    return refuse(response, 403, veredito.error ?? 'Ação não permitida.');
  }
  await store.removeUser(alvo.id);
  for (const [socketId, connected] of connectedUsers) {
    if (connected.id !== alvo.id) continue;
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
  await audit(context.user, 'user.remove', alvo.username);
  broadcastSnapshot();
  response.json({ ok: true });
});

app.post('/api/admin/channels', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  if (p2pMode) return refuse(response, 400, 'O modo P2P possui somente uma conversa e uma call.');
  const corpo = request.body as { name?: unknown; type?: unknown; categoryId?: unknown; topic?: unknown; userLimit?: unknown };
  const nome = validateChannelName(corpo?.name);
  if (!nome.ok) return refuse(response, 400, nome.error ?? 'Nome inválido.');
  const type = corpo?.type === 'voice' ? 'voice' : 'text';
  const topico = validateTopic(corpo?.topic);
  if (!topico.ok) return refuse(response, 400, topico.error ?? 'Tópico inválido.');
  const limite = validateUserLimit(corpo?.userLimit, type);
  if (!limite.ok) return refuse(response, 400, limite.error ?? 'Limite inválido.');
  const categoryId = typeof corpo?.categoryId === 'string' && store.categories.some((c) => c.id === corpo.categoryId) ? corpo.categoryId : undefined;
  const canal = await store.createChannel({
    id: `${slugify(nome.value!) || 'canal'}-${randomUUID().slice(0, 4)}`,
    name: nome.value!, type,
    ...(categoryId ? { categoryId } : {}),
    ...(topico.value ? { topic: topico.value } : {}),
    ...(limite.value ? { userLimit: limite.value } : {}),
  });
  await audit(context.user, 'channel.create', canal.name, 'ok', `${type}`);
  broadcastChannels();
  response.status(201).json({ ok: true, channel: canal });
});

app.patch('/api/admin/channels/:id', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const canal = store.channels.find((candidate) => candidate.id === request.params.id);
  if (!canal) return refuse(response, 404, 'Esse canal não existe mais.');
  const corpo = request.body as { name?: unknown; topic?: unknown; userLimit?: unknown; categoryId?: unknown; type?: unknown };
  const patch: Partial<Channel> = {};
  if (corpo?.name !== undefined) {
    const nome = validateChannelName(corpo.name);
    if (!nome.ok) return refuse(response, 400, nome.error ?? 'Nome inválido.');
    patch.name = nome.value;
  }
  if (corpo?.topic !== undefined) {
    const topico = validateTopic(corpo.topic);
    if (!topico.ok) return refuse(response, 400, topico.error ?? 'Tópico inválido.');
    patch.topic = topico.value || undefined;
  }
  const tipoFinal = corpo?.type === 'voice' || corpo?.type === 'text' ? corpo.type : canal.type;
  if (tipoFinal !== canal.type) {
    const temMensagens = store.messages.some((message) => message.channelId === canal.id);
    const temGente = (rooms.snapshot()[canal.id] ?? []).length > 0;
    const veredito = canChangeChannelType(canal, temMensagens, temGente);
    if (!veredito.ok) {
      await audit(context.user, 'channel.update', canal.name, 'denied', veredito.error);
      return refuse(response, 409, veredito.error ?? 'Não dá para converter este canal.');
    }
    patch.type = tipoFinal;
  }
  if (corpo?.userLimit !== undefined) {
    const limite = validateUserLimit(corpo.userLimit, tipoFinal);
    if (!limite.ok) return refuse(response, 400, limite.error ?? 'Limite inválido.');
    patch.userLimit = limite.value;
  }
  if (corpo?.categoryId !== undefined) {
    patch.categoryId = typeof corpo.categoryId === 'string' && store.categories.some((c) => c.id === corpo.categoryId) ? corpo.categoryId : undefined;
  }
  const atualizado = await store.updateChannel(canal.id, patch);
  await audit(context.user, 'channel.update', atualizado?.name ?? canal.name, 'ok', Object.keys(patch).join(', '));
  broadcastChannels();
  response.json({ ok: true, channel: atualizado });
});

app.delete('/api/admin/channels/:id', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const canal = store.channels.find((candidate) => candidate.id === request.params.id);
  const veredito = canDeleteChannel(store.channels, request.params.id);
  if (!veredito.ok) {
    await audit(context.user, 'channel.delete', canal?.name ?? request.params.id, 'denied', veredito.error);
    return refuse(response, 409, veredito.error ?? 'Não dá para apagar este canal.');
  }
  await store.deleteChannel(request.params.id);
  await audit(context.user, 'channel.delete', canal?.name ?? request.params.id);
  broadcastChannels();
  response.json({ ok: true });
});

app.post('/api/admin/channels/order', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const ids = (request.body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return refuse(response, 400, 'Ordem inválida.');
  await store.setChannelOrder(ids as string[]);
  await audit(context.user, 'channel.reorder', undefined, 'ok', `${ids.length} canais`);
  broadcastChannels();
  response.json({ ok: true, channels: availableChannels() });
});

app.post('/api/admin/categories', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const nome = validateCategoryName((request.body as { name?: unknown } | undefined)?.name);
  if (!nome.ok) return refuse(response, 400, nome.error ?? 'Nome inválido.');
  const categoria = await store.createCategory({ id: `${slugify(nome.value!) || 'categoria'}-${randomUUID().slice(0, 4)}`, name: nome.value! });
  await audit(context.user, 'category.create', categoria.name);
  broadcastChannels();
  response.status(201).json({ ok: true, category: categoria });
});

app.patch('/api/admin/categories/:id', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const nome = validateCategoryName((request.body as { name?: unknown } | undefined)?.name);
  if (!nome.ok) return refuse(response, 400, nome.error ?? 'Nome inválido.');
  const categoria = await store.updateCategory(request.params.id, { name: nome.value });
  if (!categoria) return refuse(response, 404, 'Essa categoria não existe mais.');
  await audit(context.user, 'category.update', categoria.name);
  broadcastChannels();
  response.json({ ok: true, category: categoria });
});

app.delete('/api/admin/categories/:id', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const categoria = store.categories.find((candidate) => candidate.id === request.params.id);
  if (!categoria) return refuse(response, 404, 'Essa categoria não existe mais.');
  await store.deleteCategory(categoria.id);
  await audit(context.user, 'category.delete', categoria.name, 'ok', 'os canais dela ficaram sem categoria');
  broadcastChannels();
  response.json({ ok: true });
});

app.post('/api/admin/categories/order', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const ids = (request.body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return refuse(response, 400, 'Ordem inválida.');
  await store.setCategoryOrder(ids as string[]);
  await audit(context.user, 'category.reorder', undefined, 'ok', `${ids.length} categorias`);
  broadcastChannels();
  response.json({ ok: true, categories: store.categories });
});

app.get('/api/admin/overview', (request, response) => {
  const user = httpUser(request);
  if (!user?.isAdmin) return void response.status(403).json({ error: 'Acesso exclusivo do administrador do servidor.' });
  response.json(adminOverview());
});

app.post('/api/admin/users/:id/disconnect', (request, response) => {
  const admin = httpUser(request);
  if (!admin?.isAdmin) return void response.status(403).json({ error: 'Acesso exclusivo do administrador do servidor.' });
  if (request.params.id === admin.id) return void response.status(400).json({ error: 'O administrador não pode desconectar a própria sessão por este painel.' });
  let disconnected = 0;
  for (const [socketId, user] of connectedUsers) {
    if (user.id !== request.params.id) continue;
    io.sockets.sockets.get(socketId)?.disconnect(true);
    disconnected += 1;
  }
  response.json({ ok: true, disconnected });
});

function isLoopbackRequest(request: express.Request): boolean {
  const address = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
  return address === '127.0.0.1' || address === '::1';
}

function requireHttpSession(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (!httpUser(request)) {
    response.status(401).json({ error: 'Sessão inválida.' });
    return;
  }
  next();
}

function requireLoopback(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (!isLoopbackRequest(request)) {
    response.status(403).json({ error: 'Disponível apenas localmente.' });
    return;
  }
  next();
}

function decodedHeader(value: string | string[] | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try { return decodeURIComponent(value); } catch { return fallback; }
}

function attachmentHeaders(id: string): { name: string; mimeType: string } {
  const attachment = store.attachmentForId(id)
    ?? store.messages.find((message) => message.attachment?.id === id)?.attachment;
  const mimeType = attachmentMimeTypeSchema.safeParse(attachment?.mimeType);
  return { name: safeAttachmentName(attachment?.name), mimeType: mimeType.success ? mimeType.data : 'application/octet-stream' };
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

app.post('/api/attachments', requireHttpSession, express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (request, response) => {
  const contents = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const name = safeAttachmentName(decodedHeader(request.headers['x-file-name'], 'arquivo'));
  const parsedMimeType = attachmentMimeTypeSchema.safeParse(decodedHeader(request.headers['x-file-type'], 'application/octet-stream'));
  if (!parsedMimeType.success) return void response.status(400).json({ error: 'Tipo MIME inválido.' });
  const mimeType = parsedMimeType.data;
  if (!contents.length || contents.length > 25 * 1024 * 1024) return void response.status(400).json({ error: 'O arquivo precisa ter entre 1 byte e 25 MB.' });
  const id = randomUUID();
  const attachment = { id, name, mimeType, size: contents.length };
  await store.saveAttachment(id, contents, attachment);
  response.status(201).json(attachment);
});

app.get('/api/attachments/:id', async (request, response) => {
  if (!httpUser(request)) return void response.status(401).json({ error: 'Sessão inválida.' });
  const parsed = z.string().uuid().safeParse(request.params.id);
  if (!parsed.success) return void response.status(400).json({ error: 'Arquivo inválido.' });
  await sendAttachment(parsed.data, response);
});

app.post('/api/profile/media', requireHttpSession, express.raw({ type: ['image/gif', 'image/png', 'image/jpeg', 'image/webp'], limit: '6mb' }), async (request, response) => {
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
  const media = store.profiles.flatMap((candidate) => [candidate.profile.avatar, candidate.profile.banner]).find((candidate) => candidate?.id === id.data)
    ?? store.users.flatMap((candidate) => [candidate.profile?.avatar, candidate.profile?.banner]).find((candidate) => candidate?.id === id.data);
  if (!media) return void response.status(404).end();
  const contents = await store.readAttachment(id.data);
  response.setHeader('content-type', media.mimeType);
  response.setHeader('cache-control', 'public, max-age=31536000, immutable');
  response.send(contents);
});

app.put('/api/profile/media/:id', requireHttpSession, express.raw({ type: ['image/gif', 'image/png', 'image/jpeg', 'image/webp'], limit: '6mb' }), async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id);
  const mimeType = request.headers['content-type']?.split(';')[0] ?? '';
  const parsedType = z.string().regex(/^image\/(?:gif|png|jpeg|webp)$/).safeParse(mimeType);
  const contents = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (!id.success || !parsedType.success || !contents.length || contents.length > 6 * 1024 * 1024) return void response.status(400).json({ error: 'Mídia de perfil inválida.' });
  if (await store.hasAttachment(id.data)) return void response.json({ ok: true, id: id.data, mimeType: parsedType.data, cached: true });
  await store.saveAttachment(id.data, contents);
  response.json({ ok: true, id: id.data, mimeType: parsedType.data });
});

app.put('/api/profile', async (request, response) => {
  const user = httpUser(request);
  if (!user) return void response.status(401).json({ error: 'Sessão inválida.' });
  const parsed = profileSchema.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: 'Perfil inválido.' });
  const referenced = [parsed.data.avatar, parsed.data.banner].filter(Boolean) as UserProfile['avatar'][];
  if ((await Promise.all(referenced.map((media) => store.hasAttachment(media!.id)))).some((exists) => !exists)) return void response.status(400).json({ error: 'Uma das imagens não chegou ao servidor.' });
  const updated = await store.updateUserProfile(user.id, { ...parsed.data, updatedAt: new Date().toISOString() });
  if (!updated) return void response.status(404).json({ error: 'Usuário não encontrado.' });
  const nextUser = publicUser(updated);
  refreshProfilePresence(new Set([updated.normalizedUsername]));
  response.json(nextUser);
});

// Esta rota nasceu para a troca de arquivos entre pares no modo P2P, onde
// quem pede está na mesma rede e não tem sessão no servidor embutido do outro.
// No servidor dedicado ela ficava aberta na internet: quem soubesse o UUID de
// um anexo baixava sem conta nenhuma, enquanto `/api/attachments/:id` — o
// mesmo arquivo — exigia sessão. Agora vale a mesma confiança da descoberta
// por broadcast: rede local entra, internet precisa de sessão.
app.get('/api/peer/attachments/:id', async (request, response) => {
  const parsed = z.string().uuid().safeParse(request.params.id);
  if (!parsed.success) return void response.status(400).end();
  if (!isTrustedLocalAddress(requestAddress(request)) && !httpUser(request)) {
    return void response.status(401).json({ error: 'Sessão inválida.' });
  }
  await sendAttachment(parsed.data, response);
});

app.get('/api/local/sync', async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).json({ error: 'Disponível apenas localmente.' });
  response.json({
    channels: availableChannels(),
    messages: store.messages.filter((message) => channelIsAvailable(message.channelId)).slice(-500),
    profiles: store.profiles,
    availableAttachmentIds: await store.availableAttachmentIds(),
  });
});

app.post('/api/local/sync', async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).json({ error: 'Disponível apenas localmente.' });
  const parsed = syncBundleSchema.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: 'Histórico inválido.' });
  if (!p2pMode) await store.mergeChannels(parsed.data.channels);
  await store.mergeMessages(parsed.data.messages.filter((message) => channelIsAvailable(message.channelId)));
  await store.mergeProfiles(parsed.data.profiles);
  response.json({ ok: true });
});

app.put('/api/local/attachments/:id', requireLoopback, express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (request, response) => {
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
  return { serverName, channels: availableChannels(), onlineUsers: uniqueUsers, voiceRooms: rooms.snapshot() };
}

function broadcastSnapshot(): void {
  io.emit('server:snapshot', snapshot());
}

function refreshProfilePresence(normalizedUsernames: ReadonlySet<string>): void {
  const changedRooms = new Set<string>();
  for (const [socketId, connected] of connectedUsers) {
    if (!normalizedUsernames.has(normalizeUsername(connected.username))) continue;
    const stored = store.users.find((candidate) => candidate.normalizedUsername === normalizeUsername(connected.username));
    if (!stored) continue;
    const next = publicUser(stored);
    connectedUsers.set(socketId, next);
    const connectedSocket = io.sockets.sockets.get(socketId);
    if (connectedSocket) connectedSocket.data.user = next;
    for (const channelId of rooms.updateUser(next)) changedRooms.add(channelId);
  }
  for (const channelId of changedRooms) io.to(`voice:${channelId}`).emit('voice:members', rooms.members(channelId));
  broadcastSnapshot();
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
    acknowledge(channelIsAvailable(channelId, 'text') ? store.messages.filter((message) => message.channelId === channelId).slice(-500) : []);
  });

  socket.on('chat:send', async (payload: unknown) => {
    const parsed = z.object({ channelId: z.string(), body: z.string().trim().max(2000).default(''), attachment: attachmentSchema.optional() })
      .refine((value) => Boolean(value.body || value.attachment), { message: 'Mensagem vazia.' })
      .safeParse(payload);
    if (!parsed.success || !channelIsAvailable(parsed.data.channelId, 'text')) return;
    if (parsed.data.attachment && !(await store.hasAttachment(parsed.data.attachment.id))) return;
    const message = { id: randomUUID(), ...parsed.data, author: socket.data.user as PublicUser, createdAt: new Date().toISOString() };
    await store.addMessage(message);
    io.emit('chat:message', message);
  });

  socket.on('chat:sync:push', async (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = syncBundleSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false });
    // A sincronização era um segundo caminho para criar canal: qualquer
    // usuário empurrava um pacote com canais novos e eles entravam. Fora do
    // P2P, só a administração define a lista de canais.
    const mayDefineChannels = !p2pMode && canManageChannels(roleOfSocket(socket));
    const addedChannels = mayDefineChannels ? await store.mergeChannels(parsed.data.channels) : [];
    const addedMessages = await store.mergeMessages(parsed.data.messages.filter((message) => channelIsAvailable(message.channelId)));
    const changedProfiles = await store.mergeProfiles(parsed.data.profiles);
    if (changedProfiles.length) refreshProfilePresence(new Set(changedProfiles.map((entry) => normalizeUsername(entry.username))));
    else if (addedChannels.length) broadcastSnapshot();
    if (addedMessages.length) io.emit('chat:sync:messages', addedMessages);
    acknowledge?.({
      ok: true,
      channels: availableChannels(),
      messages: store.messages.filter((message) => channelIsAvailable(message.channelId)).slice(-500),
      profiles: store.profiles,
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
    if (p2pMode) return acknowledge?.({ ok: false, error: 'O modo P2P possui somente uma conversa e uma call.' });
    // Não havia verificação nenhuma: qualquer usuário autenticado criava canal
    // de texto e de voz no servidor dedicado.
    if (!canManageChannels(roleOfSocket(socket))) return acknowledge?.({ ok: false, error: 'Apenas a administração do servidor cria canais.' });
    const parsed = z.object({ name: z.string().trim().min(1).max(32), type: z.enum(['text', 'voice']) }).safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false });
    const slug = parsed.data.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || randomUUID().slice(0, 8);
    const channel: Channel = { id: `${slug}-${randomUUID().slice(0, 4)}`, ...parsed.data };
    await store.addChannel(channel);
    broadcastSnapshot();
    acknowledge?.({ ok: true, channel });
  });

  socket.on('voice:join', (input: unknown, acknowledge?: (result: unknown) => void) => {
    const channelId = typeof input === 'string' ? input : z.object({ channelId: z.string() }).safeParse(input).data?.channelId;
    if (typeof channelId !== 'string' || !channelIsAvailable(channelId, 'voice')) return acknowledge?.({ ok: false, error: 'Call inválida.' });
    const previousChannels = rooms.leaveEverywhere(socket.id);
    for (const previous of previousChannels) {
      socket.leave(`voice:${previous}`);
      io.to(`voice:${previous}`).emit('voice:peer-left', socket.id);
      io.to(`voice:${previous}`).emit('voice:members', rooms.members(previous));
    }
    const existingPeers = rooms.members(channelId);
    socket.join(`voice:${channelId}`);
    const reachability = z.number().finite().min(0).max(100).safeParse((input as { reachability?: unknown } | null)?.reachability).data ?? 0;
    rooms.join(channelId, { ...(socket.data.user as PublicUser), socketId: socket.id, endpoint: endpointFor(socket.handshake.address), reachability });
    acknowledge?.({ ok: true, selfId: socket.id, peers: existingPeers });
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
    const parsed = z.object({ muted: z.boolean().optional(), speaking: z.boolean().optional(), deafened: z.boolean().optional(), camera: z.boolean().optional(), screen: z.boolean().optional(), screenAudio: z.boolean().optional() }).safeParse(patch);
    if (!channelId || !parsed.success) return;
    io.to(`voice:${channelId}`).emit('voice:members', rooms.update(channelId, socket.id, parsed.data));
    broadcastSnapshot();
  });

  socket.on('voice:reachability', (value: unknown) => {
    const channelId = rooms.roomOf(socket.id);
    const parsed = z.number().finite().min(0).max(100).safeParse(value);
    if (!channelId || !parsed.success) return;
    io.to(`voice:${channelId}`).emit('voice:members', rooms.updateReachability(channelId, socket.id, parsed.data));
  });

  socket.on('voice:latency', (value: unknown) => {
    const channelId = rooms.roomOf(socket.id);
    const parsed = z.number().finite().min(0).max(9999).safeParse(value);
    if (!channelId || !parsed.success) return;
    io.to(`voice:${channelId}`).emit('voice:members', rooms.updatePing(channelId, socket.id, parsed.data));
  });

  const rtcSchemas = {
    'rtc:offer': rtcOfferSchema,
    'rtc:answer': rtcAnswerSchema,
    'rtc:ice': rtcIceSchema,
    'rtc:resync': rtcResyncSchema,
    'rtc:stream-health': rtcStreamHealthSchema,
  } as const;
  for (const event of Object.keys(rtcSchemas) as Array<keyof typeof rtcSchemas>) {
    socket.on(event, (payload: unknown) => {
      const parsed = rtcSchemas[event].safeParse(payload);
      if (!parsed.success || !sameVoiceRoom(socket.id, parsed.data.target)) return;
      const { target, ...forwarded } = parsed.data;
      io.to(target).emit(event, { ...forwarded, from: socket.id, user: socket.data.user as PublicUser });
    });
  }

  socket.on('rtc:stream-meta', (payload: unknown) => {
    const parsed = rtcStreamMetaSchema.safeParse(payload);
    if (!parsed.success || !sameVoiceRoom(socket.id, parsed.data.target)) return;
    io.to(parsed.data.target).emit('rtc:stream-meta', { from: socket.id, meta: parsed.data.meta satisfies StreamMeta });
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
  return `${tlsEnabled ? 'https' : 'http'}://${printable}:${port}`;
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
  if (leavingWasHost && remaining.length) {
    const nextHost = remaining.find((member) => member.isHost);
    if (nextHost) {
      io.to(`voice:${channelId}`).emit('voice:host-handoff', { channelId, host: nextHost, switchAt: Date.now() + 800 });
    }
  }
  broadcastSnapshot();
}

const webDirectory = path.resolve(process.env.WEB_DIR ?? './dist-web');
if (serveWeb && existsSync(webDirectory)) {
  app.use(express.static(webDirectory));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) return next();
    response.sendFile(path.join(webDirectory, 'index.html'));
  });
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
  if (status === 413) return void response.status(413).json({ error: 'Arquivo acima do limite permitido.' });
  response.status(500).json({ error: 'Erro interno do servidor.' });
});

storeReady.then(async () => {
  await store.pruneSessions();
  if (!p2pMode) {
    const migracao = await store.migrateUserRoles(adminUsername);
    if (migracao.changed) console.log(`Tumacord: papéis migrados${migracao.ownerId ? ' — dono definido' : ''}.`);
  }
  for (const storedSession of store.sessions) {
    const storedTokenHash = storedSession.tokenHash ?? (storedSession.token ? hashToken(storedSession.token) : '');
    if (storedTokenHash) sessions.set(storedTokenHash, { userId: storedSession.userId, expiresAt: storedSession.expiresAt });
  }
  // `::` atende IPv4 e IPv6 na mesma porta na configuração padrão do Linux, e
  // é o que permite alguém entrar pelo IPv6 do host sem ZeroTier. Em um
  // sistema com `bindv6only` ligado — ou sem IPv6 — a abertura falha, e aí o
  // servidor volta para IPv4 em vez de não subir.
  const listen = (address: string, onFailure?: (error: NodeJS.ErrnoException) => void): void => {
    const handleFailure = (error: NodeJS.ErrnoException): void => {
      httpServer.removeListener('error', handleFailure);
      if (onFailure) return onFailure(error);
      console.error('Falha ao abrir a porta do servidor Tumacord:', error.message);
      process.exitCode = 1;
    };
    httpServer.once('error', handleFailure);
    httpServer.listen(port, address, () => {
      httpServer.removeListener('error', handleFailure);
      console.log(`Tumacord ${p2pMode ? 'P2P' : 'Server'} em ${tlsEnabled ? 'https' : 'http'}://${address}:${port}${serveWeb ? ' (web ativo)' : ''}`);
    });
  };
  if (host === '::') listen('::', () => listen('0.0.0.0'));
  else listen(host);
}).catch((error) => {
  console.error('Falha ao iniciar o servidor Tumacord:', error);
  process.exitCode = 1;
});
