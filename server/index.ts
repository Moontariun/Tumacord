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
import type { AdminOverview, Channel, ChatMessage, PublicUser, ServerSnapshot, StreamMeta, UserProfile } from '../shared/types.js';
import { safeAttachmentName } from '../shared/attachmentName.js';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_BOARD_NAME,
  MAX_OPS_PER_BATCH,
  MAX_POINTS_PER_BOARD_STROKE,
  type BoardActor,
  type BoardOp,
} from '../shared/whiteboard.js';
import { isTrustedLocalAddress } from '../shared/directLink.js';
import { INVITE_TOKEN_LENGTH, createInviteToken, createToken, hashPassword, hashToken, normalizeInviteToken, normalizeUsername, proveKey, verifyPassword, verifySecret } from './auth.js';
import { ephemeralTurnCredentials, turnConfiguration, turnIceServers } from './turn.js';
import { AuthRateLimiter, TokenBucket } from './rateLimit.js';
import { MAX_MESSAGE_BODY, canModify, deleteMessage, editMessage } from '../shared/messageSync.js';
import { canManageChannels, isAdministrator, normalizeRole, planRemoval, planRoleChange, roleForNewUser, type Role } from './roles.js';
import { canChangeChannelType, canDeleteChannel, slugify, validateCategoryName, validateChannelName, validateTopic, validateUserLimit } from './channels.js';
import { createAuditEntry } from './audit.js';
import { SelfUpdater, executorTokenMatches, selfUpdateConfig, unavailableReason } from './selfUpdate.js';
import { JsonStore, type StoredUser } from './store.js';
import { VoiceRooms } from './voiceRooms.js';
import { Whiteboards, type StoredBoard } from './whiteboards.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3927);
const serverName = process.env.SERVER_NAME?.trim() || 'Tumacord';
const dataDirectory = process.env.DATA_DIR ?? './data';
const sessionTtl = Number(process.env.SESSION_TTL_DAYS ?? 30) * 86_400_000;
const serverVersion = packageMetadata.version;
// Posto pelo empacotamento (`--build-arg TUMACORD_COMMIT`). Sem ele, vazio.
const serverCommit = (process.env.TUMACORD_COMMIT ?? '').trim();
const startedAt = new Date();
const p2pMode = process.env.TUMACORD_P2P_MODE === '1';
const serveWeb = process.env.TUMACORD_SERVE_WEB !== '0';
const serverAccessKey = process.env.SERVER_ACCESS_KEY?.trim() ?? '';
// Doze horas, o mesmo prazo que o convite anterior carregava dentro do código.
// Aqui o prazo mora no servidor, então vencer é o convite sumir do arquivo.
const INVITE_TTL_MS = 12 * 60 * 60 * 1000;
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
// Atualizar o próprio servidor pelo painel. Desligado por padrão, e por
// decisão: um servidor que ganhou esta versão não passa a aceitar troca de
// código porque atualizou. Quem hospeda liga isso sabendo o que é.
const selfUpdateSettings = selfUpdateConfig(process.env);
const selfUpdater = new SelfUpdater(selfUpdateSettings);
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
// A identidade do grupo onde uma mesa nasce. Ela existe para uma coisa só:
// impedir que o conteúdo de uma mesa atravesse para onde não é dele. Um
// servidor dedicado nunca adota mesa de fora — nem de um grupo P2P, nem de
// outro dedicado —, e no P2P a adoção da troca de host exige que quem entrega
// esteja na mesma call agora.
const boardOrigin = p2pMode ? 'p2p' : `server:${serverName}`;
const whiteboards = new Whiteboards(() => scheduleBoardSave(), () => {
  // Excluir não pode esperar a janela de coalescência: se o servidor cair
  // nesse meio segundo, a mesa volta na subida seguinte como se nada tivesse
  // acontecido — e quem a excluiu não teria como saber por quê.
  if (!p2pMode) void saveBoardsNow();
});
let boardSaveTimer: NodeJS.Timeout | null = null;
let lastBoardSaveAt = 0;
/** Intervalo mínimo entre duas gravações do arquivo por causa das mesas. É
 *  também o tamanho da janela que uma queda sem aviso pode levar embora. */
const BOARD_SAVE_INTERVAL_MS = 500;

// A primeira mudança grava na hora; as seguintes esperam.
//
// Desenhar produz operações a poucos milissegundos de distância, e o arquivo é
// reescrito inteiro a cada gravação — juntar meio segundo de mão andando em uma
// gravação só é a diferença entre salvar a mesa e brigar com o disco.
//
// Mas adiar *também* a primeira seria apostar num encerramento gracioso que nem
// todo sistema oferece: no Windows um processo encerrado por `kill` morre na
// hora, sem passar por manipulador nenhum. Gravar na borda de subida fecha essa
// janela: a mesa chega ao disco na primeira operação, sem esperar a mão parar,
// e o pior caso de uma queda sem aviso é meio segundo de traço em cima de uma
// mesa que já está gravada — não a mesa inteira.
function scheduleBoardSave(): void {
  // No P2P a mesa vive enquanto o grupo estiver reunido, e é isso que a
  // interface promete. Gravá-la no disco de quem por acaso é o host hoje
  // guardaria o desenho do grupo na máquina de uma pessoa, sem que ninguém
  // tivesse pedido isso.
  if (p2pMode || boardSaveTimer) return;
  const desde = Date.now() - lastBoardSaveAt;
  if (desde >= BOARD_SAVE_INTERVAL_MS) return void saveBoardsNow();
  boardSaveTimer = setTimeout(() => {
    boardSaveTimer = null;
    void saveBoardsNow();
  }, BOARD_SAVE_INTERVAL_MS - desde);
  boardSaveTimer.unref?.();
}

function saveBoardsNow(): Promise<void> {
  lastBoardSaveAt = Date.now();
  return store.saveBoards(whiteboards.toStored(), whiteboards.deletedBoards).catch(() => undefined);
}

// Onde existe encerramento gracioso — Linux, contêiner, `docker compose down` —
// o último traço é gravado antes da saída, e nem aquele segundo se perde. Onde
// não existe, a gravação na borda de subida já garantiu que a mesa está em
// disco. O prazo evita que um disco travado transforme "parar o servidor" em
// "servidor que não para".
function flushBoards(): Promise<void> {
  if (boardSaveTimer) {
    clearTimeout(boardSaveTimer);
    boardSaveTimer = null;
  }
  if (p2pMode) return Promise.resolve();
  return saveBoardsNow();
}

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sinal, () => {
    const prazo = setTimeout(() => process.exit(0), 2_000);
    prazo.unref?.();
    void flushBoards().finally(() => process.exit(0));
  });
}
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
  body: z.string().max(MAX_MESSAGE_BODY),
  createdAt: z.string().datetime(),
  attachment: attachmentSchema.optional(),
  // A revisão é o que faz uma edição ou uma exclusão vencer a cópia antiga de
  // quem ainda não soube. O teto existe pelo mesmo motivo dos outros: um campo
  // que chega da rede não decide sozinho o tamanho do que guardamos.
  revision: z.number().int().min(0).max(100_000).optional(),
  editedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
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
// Assinatura de uma live. `stream` identifica *qual* transmissão: sem isso, o
// consentimento dado a uma live encerrada valeria para a próxima que a mesma
// pessoa abrisse.
const rtcWatchSchema = z.object({ target: rtcTargetSchema, stream: z.string().min(1).max(128), watching: z.boolean() });
const rtcStreamHealthSchema = z.object({ target: rtcTargetSchema, frozen: z.boolean() });
const rtcStreamMetaSchema = z.object({ target: rtcTargetSchema, meta: z.object({ streamId: z.string().min(1).max(256), kind: z.enum(['camera', 'screen']) }) });
// Mesa de desenho compartilhada. `id` identifica o pedaço enviado — é a chave
// contra reentrega —, e `stroke` identifica o traço, que é o objeto que a
// borracha apaga e o desfazer remove.
const boardPointSchema = z.object({
  x: z.number().finite().min(0).max(BOARD_WIDTH),
  y: z.number().finite().min(0).max(BOARD_HEIGHT),
});
const boardOpIdSchema = z.string().min(1).max(64);
const boardOpSchema = z.discriminatedUnion('kind', [
  z.object({
    id: boardOpIdSchema,
    kind: z.literal('stroke'),
    stroke: boardOpIdSchema,
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    width: z.number().finite().min(1).max(64),
    points: z.array(boardPointSchema).min(1).max(MAX_POINTS_PER_BOARD_STROKE),
    done: z.boolean().optional(),
  }),
  z.object({ id: boardOpIdSchema, kind: z.literal('erase'), targets: z.array(boardOpIdSchema).min(1).max(64) }),
  z.object({ id: boardOpIdSchema, kind: z.literal('undo'), target: boardOpIdSchema }),
]);
const boardOpsSchema = z.object({ boardId: z.string().min(1).max(64), ops: z.array(boardOpSchema).min(1).max(MAX_OPS_PER_BATCH) });
const boardJoinSchema = z.object({ boardId: z.string().min(1).max(64), observer: z.boolean().optional() });
const boardSyncSchema = z.object({ boardId: z.string().min(1).max(64), since: z.number().int().min(0).max(10_000_000) });
const boardCursorSchema = z.object({ boardId: z.string().min(1).max(64), x: z.number().finite().min(0).max(BOARD_WIDTH), y: z.number().finite().min(0).max(BOARD_HEIGHT), color: z.string().regex(/^#[0-9a-f]{6}$/i) });
const boardManageSchema = z.object({
  boardId: z.string().min(1).max(64),
  action: z.enum(['lock', 'unlock', 'observers', 'clear', 'close', 'reopen', 'archive', 'rename', 'revoke', 'restore', 'delete']),
  value: z.union([z.string().max(MAX_BOARD_NAME * 4), z.boolean()]).optional(),
});
// A mesa que volta para o ar depois da troca de host, no P2P. O que chega aqui
// é conteúdo de outra máquina: ele é validado como qualquer coisa vinda do
// fio, e o servidor dedicado não aceita nenhum.
const boardAdoptSchema = z.object({
  board: z.object({
    id: z.string().min(1).max(64),
    name: z.string().max(MAX_BOARD_NAME * 4),
    channelId: z.string().min(1).max(64),
    origin: z.string().max(128),
    createdBy: z.string().min(1).max(64),
    createdByName: z.string().min(1).max(64),
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
    status: z.enum(['open', 'closed', 'archived']),
    locked: z.boolean(),
    allowObservers: z.boolean(),
    revoked: z.array(z.string().min(1).max(64)).max(64),
    snapshot: z.object({
      revision: z.number().int().min(0).max(10_000_000),
      strokes: z.array(z.object({
        id: boardOpIdSchema,
        author: z.string().min(1).max(64),
        authorName: z.string().min(1).max(64),
        color: z.string().regex(/^#[0-9a-f]{6}$/i),
        width: z.number().finite().min(1).max(64),
        points: z.array(boardPointSchema).max(MAX_POINTS_PER_BOARD_STROKE),
        at: z.number().finite(),
      })).max(4_000),
    }),
    // O histórico posterior não viaja: o snapshot já é o quadro inteiro, e
    // reenviar as duas coisas só daria margem para elas discordarem.
  }),
});

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    name: serverName,
    users: connectedUsers.size,
    version: serverVersion,
    // O commit exato de onde esta build saiu. `version` sozinha não prova que
    // a atualização aconteceu: duas builds do mesmo número podem diferir, e
    // uma imagem que não foi reconstruída responde a versão nova do
    // `package.json` com o código antigo dentro. Vazio quando a build não
    // recebeu o commit — e vazio é dito, não inventado.
    commit: serverCommit,
    mode: p2pMode ? 'p2p' : 'server',
    web: serveWeb,
    // Identidade estável desta instalação. É ela que o cliente usa para não
    // misturar o histórico de dois servidores: nome, apelido e endereço podem
    // coincidir ou mudar; este id não.
    installationId: store.installationId,
    security: { accessKeyRequired: Boolean(serverAccessKey), tls: tlsEnabled, media: 'DTLS-SRTP' },
    turn: Boolean(turn),
    // O cliente pergunta o que este servidor sabe fazer, em vez de deduzir de
    // um número de versão. Uma instalação parada ou um fork quebrariam a
    // dedução; a declaração, não.
    capabilities: {
      turn: Boolean(turn),
      roles: !p2pMode,
      adminChannels: !p2pMode,
      adminUsers: !p2pMode,
      adminAudit: !p2pMode,
      mediaDiagnostics: true,
      // A mesa existe nos dois modos. O que muda é o que acontece com ela
      // depois: o dedicado guarda, o P2P mantém enquanto o grupo durar.
      boards: true,
      boardPersistence: !p2pMode,
    },
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

// O convite é uma chave de acesso de escopo estreito: vale enquanto não
// vencer, e some do arquivo depois. É o que permite o código curto — a chave
// longa do servidor deixa de viajar em algo que se cola em conversa.
function inviteFor(presented: string): ReturnType<typeof store.inviteForHash> {
  const token = normalizeInviteToken(presented);
  if (token.length !== INVITE_TOKEN_LENGTH) return undefined;
  return store.inviteForHash(hashToken(token));
}

function hasServerAccess(serverKey: string): boolean {
  if (!serverAccessKey) return true;
  if (verifySecret(serverKey, serverAccessKey)) return true;
  return Boolean(inviteFor(serverKey));
}

async function issueSession(user: StoredUser): Promise<string> {
  const token = createToken();
  const session = { userId: user.id, expiresAt: Date.now() + sessionTtl };
  const tokenHash = hashToken(token);
  sessions.set(tokenHash, session);
  await store.addSession({ tokenHash, ...session });
  return token;
}

const inviteInput = z.object({
  callId: z.string().min(1).max(64),
  callName: z.string().max(64).optional().default('Call'),
});

// Emitir exige sessão: convidar é ato de quem já está dentro. O token volta
// uma única vez, em texto; o servidor guarda só o hash.
app.post('/api/invite', async (request, response) => {
  const user = httpUser(request);
  if (!user) {
    response.status(401).json({ error: 'Entre na conta antes de gerar um convite.' });
    return;
  }
  const parsed = inviteInput.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Informe a call do convite.' });
    return;
  }
  const token = createInviteToken();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  await store.addInvite({
    tokenHash: hashToken(token),
    callId: parsed.data.callId,
    callName: parsed.data.callName,
    hostUsername: user.username,
    createdBy: user.id,
    expiresAt,
  });
  response.json({ token, expiresAt });
});

// Quem recebeu o código consulta antes de entrar, para ver de que call se
// trata. Responde só o que já estava no convite antigo — nada a mais.
app.get('/api/invite/:token', (request, response) => {
  const invite = inviteFor(String(request.params.token ?? ''));
  if (!invite) {
    response.status(404).json({ error: 'Convite inválido ou vencido.' });
    return;
  }
  response.json({ callId: invite.callId, callName: invite.callName, hostUsername: invite.hostUsername, expiresAt: invite.expiresAt });
});

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
  // A recusa rápida, antes de gastar um hash de senha. Ela é conveniência e
  // **não** é a garantia: entre esta linha e a inserção há um `await`, e é
  // nessa janela que seis pedidos simultâneos do mesmo nome produziam seis
  // contas. Quem garante é `store.createUser`, que confere e insere sem
  // devolver o laço de eventos no meio.
  if (store.users.some((candidate) => candidate.normalizedUsername === normalizedUsername)) {
    response.status(409).json({ error: 'Esse usuário já existe. Escolha outro nome ou entre na conta.' });
    return;
  }
  if (store.reservationFor(normalizedUsername)) {
    response.status(409).json({ error: 'Esse nome já pertenceu a alguém neste servidor. Escolha outro, ou peça ao dono para recuperar a conta.' });
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
  const resultado = await store.createUser(user);
  if (!resultado.created) {
    response.status(409).json({
      error: resultado.conflict === 'reservation'
        ? 'Esse nome já pertenceu a alguém neste servidor. Escolha outro, ou peça ao dono para recuperar a conta.'
        : 'Esse usuário já existe. Escolha outro nome ou entre na conta.',
    });
    return;
  }
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
    if (store.reservationFor(normalizedUsername)) {
      // O nome já pertenceu a alguém aqui. Criar uma conta nova com ele
      // entregaria a identidade de quem saiu a quem chegou — e informar uma
      // senha nova não é prova de ser a mesma pessoa.
      response.status(409).json({ error: 'Esse nome já pertenceu a alguém neste servidor. Peça ao dono para recuperar a conta.' });
      return;
    }
    const candidato = {
      id: randomUUID(),
      username: parsed.data.username.trim(),
      normalizedUsername,
      passwordHash: await hashPassword(parsed.data.password),
      createdAt: new Date().toISOString(),
      role: p2pMode ? 'member' : roleForNewUser(store.users, normalizedUsername, adminUsername),
    } satisfies StoredUser;
    // O mesmo caminho protegido do cadastro. Este era o segundo lugar que
    // inseria conta sem garantia de unicidade, e conferir só na rota não
    // bastava: `hashPassword` devolve o laço de eventos antes da inserção.
    const resultado = await store.createUser(candidato);
    if (resultado.created) {
      created = true;
      user = candidato;
    } else if (resultado.conflict === 'user' && resultado.existing) {
      // Alguém ganhou a corrida com o mesmo nome. Isto não vira conta nova:
      // segue pela conferência de senha da conta que existe, exatamente como
      // um login normal — senha errada é recusada, e não cria nada.
      user = resultado.existing;
    } else {
      response.status(409).json({ error: 'Esse nome já pertenceu a alguém neste servidor. Peça ao dono para recuperar a conta.' });
      return;
    }
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
    categories: [...store.categories],
    voiceRooms: rooms.snapshot(),
    security: { accessKeyRequired: Boolean(serverAccessKey), tls: tlsEnabled, media: 'DTLS-SRTP' },
    turn: Boolean(turn),
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

/**
 * Criar um canal. **A** operação — não uma delas.
 *
 * Até a 0.9.9 havia duas: a rota de administração e o `channel:create` do
 * socket. Elas divergiam em tudo o que importa — a do socket não validava o
 * nome pelas mesmas regras, não atribuía posição (o canal nascia no fim por
 * acidente de inserção), não aceitava categoria, tópico nem limite, e não
 * deixava registro na auditoria. Duas regras para a mesma pergunta significam
 * que a resposta depende de por qual porta se entrou.
 *
 * A autorização é conferida **aqui**, sobre o papel persistido, e não sobre o
 * que a interface resolveu mostrar: esconder o botão é conveniência, e um
 * cliente que chame a API ou o socket direto passa pelo mesmo lugar.
 */
async function criarCanal(actor: PublicUser, role: Role, entrada: { name?: unknown; type?: unknown; categoryId?: unknown; topic?: unknown; userLimit?: unknown }): Promise<{ ok: true; channel: Channel } | { ok: false; status: number; error: string }> {
  if (p2pMode) return { ok: false, status: 400, error: 'O modo P2P possui somente uma conversa e uma call.' };
  if (!canManageChannels(role)) {
    await audit(actor, 'channel.create', typeof entrada?.name === 'string' ? entrada.name : '', 'denied');
    return { ok: false, status: 403, error: 'Apenas a administração do servidor cria canais.' };
  }
  const nome = validateChannelName(entrada?.name);
  if (!nome.ok) return { ok: false, status: 400, error: nome.error ?? 'Nome inválido.' };
  const type = entrada?.type === 'voice' ? 'voice' : 'text';
  const topico = validateTopic(entrada?.topic);
  if (!topico.ok) return { ok: false, status: 400, error: topico.error ?? 'Tópico inválido.' };
  const limite = validateUserLimit(entrada?.userLimit, type);
  if (!limite.ok) return { ok: false, status: 400, error: limite.error ?? 'Limite inválido.' };
  const categoryId = typeof entrada?.categoryId === 'string' && store.categories.some((c) => c.id === entrada.categoryId) ? entrada.categoryId : undefined;
  // O sufixo aleatório é o que garante id único sem consultar a lista: dois
  // canais com o mesmo nome não colidem, e recriar um nome antigo não herda as
  // mensagens do canal que foi apagado.
  const canal = await store.createChannel({
    id: `${slugify(nome.value!) || 'canal'}-${randomUUID().slice(0, 4)}`,
    name: nome.value!, type,
    ...(categoryId ? { categoryId } : {}),
    ...(topico.value ? { topic: topico.value } : {}),
    ...(limite.value ? { userLimit: limite.value } : {}),
  });
  await audit(actor, 'channel.create', canal.name, 'ok', `${type}`);
  broadcastChannels();
  return { ok: true, channel: canal };
}

app.post('/api/admin/channels', async (request, response) => {
  const context = requireAdmin(request, response);
  if (!context) return;
  const resultado = await criarCanal(context.user, normalizeRole(context.user.role), request.body as Record<string, unknown>);
  if (!resultado.ok) return refuse(response, resultado.status, resultado.error);
  response.status(201).json({ ok: true, channel: resultado.channel });
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
  // Apagar o canal sem tirar quem estava na call deixava gente numa sala de um
  // canal que já não existe: a lista de membros continuava chegando, e a
  // pessoa não conseguia sair por um canal que a interface não mostra mais.
  for (const member of rooms.members(request.params.id)) {
    io.to(member.socketId).emit('voice:evicted', { channelId: request.params.id, reason: 'Este canal foi apagado.' });
    leaveVoice(member.socketId);
  }
  await store.deleteChannel(request.params.id);
  // As mesas do canal apagado saem junto com ele. Mantê-las vivas deixaria um
  // quadro acessível por um canal que não existe mais — e a permissão da mesa
  // é justamente a permissão do canal ao qual ela está vinculada.
  const mesas = whiteboards.removeChannel(request.params.id);
  if (mesas.length) {
    void store.saveBoards(whiteboards.toStored()).catch(() => undefined);
    for (const boardId of mesas) io.emit('board:closed', { boardId, reason: 'O canal desta mesa foi apagado.' });
  }
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

// Atualizar o servidor.
//
// É a ação mais perigosa do painel: ela troca o código que está rodando. Três
// coisas a cercam, e nenhuma depende de o botão estar escondido no navegador:
//
//   1. **é do dono.** Administrador cuida de canais e de gente; trocar o código
//      do servidor é de quem responde por ele;
//   2. **o navegador só manda uma etiqueta.** A lista de versões é buscada por
//      este servidor, e a etiqueta escolhida é conferida contra ela — aqui e de
//      novo dentro do `SelfUpdater`, contra uma lista buscada na hora;
//   3. **fica registrado.** A tentativa entra na auditoria antes de qualquer
//      coisa acontecer, com quem pediu e para qual versão.
/**
 * Quem pode pausar e liberar a escrita: o dono, ou o executor.
 *
 * O executor pausa antes da cópia que antecede cada aplicação, e não tem — nem
 * deve ter — uma sessão de dono: uma sessão expira em dias, e a cópia pararia
 * de funcionar sem ninguém perceber até a hora de restaurar. Ele se identifica
 * pelo segredo que só ele e este servidor conhecem, e a auditoria registra
 * `executor` como autor, e não um dono que não pediu nada.
 *
 * Só estas duas rotas aceitam o segredo. Ele não abre nenhuma outra porta do
 * painel.
 */
function writeGateCaller(request: express.Request, response: express.Response): { audit: (action: string) => Promise<void> } | null {
  if (executorTokenMatches(selfUpdateSettings, request.headers.authorization)) {
    return { audit: (action) => auditExecutor(action) };
  }
  const context = requireOwner(request, response);
  if (!context) return null;
  return { audit: (action) => audit(context.user, action, '', 'ok') };
}

async function auditExecutor(action: string): Promise<void> {
  await store.recordAudit(createAuditEntry({
    id: randomUUID(), actorId: 'executor', actorUsername: 'executor', action, target: '', result: 'ok',
  })).catch(() => undefined);
}

function requireOwner(request: express.Request, response: express.Response): AdminContext | null {
  const context = requireAdmin(request, response);
  if (!context) return null;
  if (context.role !== 'owner') {
    refuse(response, 403, 'Só o dono do servidor pode trocar a versão que ele roda.');
    return null;
  }
  return context;
}

app.get('/api/admin/update', async (request, response) => {
  const context = requireOwner(request, response);
  if (!context) return;
  const reason = unavailableReason(selfUpdateSettings);
  if (reason) {
    return response.json({ enabled: false, reason, current: serverVersion, releases: [], state: selfUpdater.snapshot() });
  }
  // O estado vem do executor, e não da memória deste processo: uma aplicação
  // reinicia justamente este servidor, e o trabalho precisa continuar legível
  // depois disso.
  const estado = await selfUpdater.refresh();
  try {
    response.json({ enabled: true, reason: '', current: serverVersion, releases: await selfUpdater.offers(serverVersion), state: estado });
  } catch (erro) {
    response.json({ enabled: true, reason: '', current: serverVersion, releases: [], state: estado, error: erro instanceof Error ? erro.message : 'Não consegui consultar as versões publicadas.' });
  }
});

const updateBucket = new TokenBucket(3, 1);

/**
 * Pausar a escrita, para o backup capturar um ponto consistente.
 *
 * O servidor grava de forma coordenada dentro do processo, mas isso não
 * protege contra alguém copiar o volume no meio de uma gravação: o `tar`
 * pegaria o JSON entre o `write` e o `rename`, ou o estado de um instante com
 * os anexos de outro. Nenhuma dessas falhas aparece na hora — elas aparecem na
 * restauração, quando já não há de onde tirar outra cópia.
 *
 * Volta só depois de o disco estar em dia. É essa espera que dá o ponto.
 *
 * A call **não** é interrompida: voz e vídeo não passam pelo armazenamento. O
 * que fica em espera são o envio de mensagem e de anexo, por segundos.
 */
app.post('/api/admin/pause-writes', async (request, response) => {
  const caller = writeGateCaller(request, response);
  if (!caller) return;
  const parsed = z.object({ timeoutMs: z.number().int().min(1_000).max(30 * 60_000).optional() }).safeParse(request.body ?? {});
  if (!parsed.success) return refuse(response, 400, 'Tempo limite inválido.');
  await store.pauseWrites(parsed.data.timeoutMs);
  await caller.audit('server.pause-writes');
  response.json({
    ok: true,
    paused: true,
    // O tempo limite é uma rede de segurança: um backup que morreu no meio não
    // pode deixar o servidor sem gravar para sempre.
    autoResumeMs: parsed.data.timeoutMs ?? 5 * 60_000,
  });
});

/** Liberar as gravações que esperavam. */
app.post('/api/admin/resume-writes', async (request, response) => {
  const caller = writeGateCaller(request, response);
  if (!caller) return;
  store.resumeWrites();
  await caller.audit('server.resume-writes');
  response.json({ ok: true, paused: false });
});

app.post('/api/admin/update', async (request, response) => {
  const context = requireOwner(request, response);
  if (!context) return;
  const parsed = z.object({ tag: z.string().max(32) }).safeParse(request.body);
  if (!parsed.success) return refuse(response, 400, 'Versão inválida.');
  if (!updateBucket.take()) {
    await audit(context.user, 'server.update', parsed.data.tag, 'denied', 'pedidos demais');
    return refuse(response, 429, 'Muitos pedidos de atualização. Espere um pouco.');
  }
  // Registrado antes de acontecer: uma atualização que derruba o servidor no
  // meio não deixaria rastro se o registro viesse depois.
  await audit(context.user, 'server.update', parsed.data.tag, 'ok', 'pedido');
  const resultado = await selfUpdater.start(parsed.data.tag, serverVersion);
  if (!resultado.ok) {
    await audit(context.user, 'server.update', parsed.data.tag, 'denied', resultado.error);
    return refuse(response, 409, resultado.error);
  }
  response.json({ ok: true, tag: resultado.release.tag, state: selfUpdater.snapshot() });
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

// O cache local, separado por origem.
//
// Ele era o mesmo armazenamento que o servidor embutido usa para hospedar: o
// que este computador via em um servidor dedicado era espelhado aqui e passava
// a ser servido — e republicado — como se fosse do grupo P2P desta máquina.
// Guardar e hospedar são responsabilidades diferentes, e agora moram em
// lugares diferentes do mesmo arquivo.
//
// A origem vem de quem pergunta, e é ela que delimita: o histórico de um
// servidor só volta para aquele servidor.
app.get('/api/local/sync', (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).json({ error: 'Disponível apenas localmente.' });
  const origin = z.string().min(1).max(200).safeParse(request.query.origin);
  if (!origin.success) return void response.status(400).json({ error: 'Informe a origem do histórico.' });
  const guardado = store.mirrorFor(origin.data);
  response.json({
    channels: guardado.channels,
    messages: guardado.messages.slice(-500),
    profiles: guardado.profiles,
    availableAttachmentIds: [],
  });
});

app.post('/api/local/sync', async (request, response) => {
  if (!isLoopbackRequest(request)) return void response.status(403).json({ error: 'Disponível apenas localmente.' });
  const origin = z.string().min(1).max(200).safeParse((request.body as { origin?: unknown } | undefined)?.origin);
  if (!origin.success) return void response.status(400).json({ error: 'Informe a origem do histórico.' });
  const parsed = syncBundleSchema.safeParse(request.body);
  if (!parsed.success) return void response.status(400).json({ error: 'Histórico inválido.' });
  await store.mergeMirror(origin.data, parsed.data);
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
  // O painel de administração mostra "visto <data>" desde a 0.8.1, e o campo
  // nunca era preenchido: `touchUser` existia sem nenhum ponto de chamada.
  // Entrar é o evento certo, e o próprio método já limita a gravação a um
  // carimbo por minuto.
  void store.touchUser(user.id).catch(() => undefined);
  socket.emit('server:snapshot', snapshot());
  broadcastSnapshot();

  socket.on('chat:history', (channelId: unknown, acknowledge: (messages: unknown[]) => void) => {
    if (typeof channelId !== 'string') return acknowledge([]);
    acknowledge(channelIsAvailable(channelId, 'text') ? readableMessages(socket).filter((message) => message.channelId === channelId).slice(-500) : []);
  });

  socket.on('chat:send', async (payload: unknown) => {
    const parsed = z.object({ channelId: z.string(), body: z.string().trim().max(MAX_MESSAGE_BODY).default(''), attachment: attachmentSchema.optional() })
      .refine((value) => Boolean(value.body || value.attachment), { message: 'Mensagem vazia.' })
      .safeParse(payload);
    if (!parsed.success || !channelIsAvailable(parsed.data.channelId, 'text')) return;
    if (parsed.data.attachment && !(await store.hasAttachment(parsed.data.attachment.id))) return;
    const message = { id: randomUUID(), ...parsed.data, author: socket.data.user as PublicUser, createdAt: new Date().toISOString() };
    await store.addMessage(message);
    io.emit('chat:message', message);
  });

  // Editar e apagar.
  //
  // Quem pode é o autor, e a conferência é aqui — esconder o botão do outro
  // lado é conveniência, não permissão. No P2P a identidade é o apelido
  // normalizado, e não o `id`: cada host tem o próprio cadastro, e sem isso
  // trocar de host tirava de você o direito de apagar as suas mensagens.
  //
  // As duas saem pelo mesmo evento porque para quem recebe são a mesma coisa:
  // esta mensagem mudou, fique com esta versão.
  const chatEditBucket = new TokenBucket(30, 15);

  async function aplicarMudanca(id: unknown, mudar: (message: ChatMessage) => ChatMessage): Promise<void> {
    if (typeof id !== 'string' || !chatEditBucket.take()) return;
    const atual = store.messages.find((message) => message.id === id);
    const quem = socket.data.user as PublicUser;
    if (!atual || !channelIsAvailable(atual.channelId, 'text')) return;
    if (!canModify(atual, quem, { p2pMode, normalize: normalizeUsername })) return;
    const mudada = mudar(atual);
    await store.replaceMessage(mudada);
    io.emit('chat:message:updated', mudada);
  }

  socket.on('chat:edit', (payload: unknown) => {
    const parsed = z.object({ id: z.string().uuid(), body: z.string().trim().min(1).max(MAX_MESSAGE_BODY) }).safeParse(payload);
    if (!parsed.success) return;
    void aplicarMudanca(parsed.data.id, (message) => editMessage(message, parsed.data.body, new Date().toISOString()));
  });

  socket.on('chat:delete', (payload: unknown) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(payload);
    if (!parsed.success) return;
    void aplicarMudanca(parsed.data.id, (message) => deleteMessage(message, new Date().toISOString()));
  });

  // A replicação entre pessoas é do P2P, e só dele.
  //
  // No P2P ela é o que segura o histórico quando o host troca de máquina: cada
  // participante devolve ao host novo o que tem, e o autor vem no pacote
  // porque é mesmo a mensagem de outra pessoa.
  //
  // No dedicado esse mesmo caminho era um buraco. O servidor mesclava o pacote
  // como se fosse verdade, e com ele vinham duas coisas que não deveriam
  // entrar: mensagem assinada como qualquer um — o autor vinha do pacote, não
  // da sessão — e a conversa de um grupo P2P inteiro, despejada dentro da
  // comunidade. Ali quem responde pelo histórico e pelos perfis é o servidor,
  // e ele já tem os dois: a mensagem chega por `chat:send` e o perfil por
  // `PUT /api/profile`, cada um com o autor conferido.
  //
  // A resposta continua igual para os dois modos, porque a outra metade da
  // sincronização — receber o que o servidor tem — é legítima em qualquer um.
  socket.on('chat:sync:push', async (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = syncBundleSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false });
    const addedChannels = p2pMode ? await store.mergeChannels(parsed.data.channels) : [];
    // `mergeMessages` devolve o que entrou **e** o que foi substituído por uma
    // revisão maior: uma edição que chega pela replicação precisa alcançar
    // quem está com a tela aberta, igual a uma mensagem nova.
    const addedMessages = p2pMode ? await store.mergeMessages(parsed.data.messages.filter((message) => channelIsAvailable(message.channelId))) : [];
    const changedProfiles = p2pMode ? await store.mergeProfiles(parsed.data.profiles) : [];
    if (changedProfiles.length) refreshProfilePresence(new Set(changedProfiles.map((entry) => normalizeUsername(entry.username))));
    else if (addedChannels.length) broadcastSnapshot();
    if (addedMessages.length) io.emit('chat:sync:messages', addedMessages);
    acknowledge?.({
      ok: true,
      channels: availableChannels(),
      messages: readableMessages(socket).filter((message) => channelIsAvailable(message.channelId)).slice(-500),
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
    // A mesma operação da rota de administração, e o mesmo papel persistido.
    // Este caminho tinha as próprias regras: outro `slugify`, sem posição, sem
    // categoria, sem tópico, sem limite e sem auditoria — um canal criado por
    // aqui saía diferente de um canal criado por lá.
    const dono = socket.data.user as PublicUser | undefined;
    if (!dono) return acknowledge?.({ ok: false, error: 'Sessão expirada; entre de novo.' });
    const resultado = await criarCanal(dono, roleOfSocket(socket), payload as Record<string, unknown>);
    if (!resultado.ok) return acknowledge?.({ ok: false, error: resultado.error });
    acknowledge?.({ ok: true, channel: resultado.channel });
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
    // O limite de pessoas era guardado pelo painel e nunca consultado aqui: a
    // call aceitava todo mundo, e quem o configurou não tinha como saber. Ele
    // vale no servidor porque é ele quem admite na sala — esconder o botão de
    // entrar seria pedir a cooperação de quem quer entrar.
    //
    // Quem já está dentro não é expulso por um limite que baixou depois, e a
    // administração entra assim mesmo: um canal cheio não pode trancar do lado
    // de fora quem precisa mediar o que está acontecendo lá.
    const limite = availableChannels().find((channel) => channel.id === channelId)?.userLimit ?? 0;
    const jaEstava = existingPeers.some((member) => member.socketId === socket.id);
    if (limite > 0 && !jaEstava && existingPeers.length >= limite && !isAdministrator(roleOfSocket(socket))) {
      return acknowledge?.({ ok: false, error: `Esta call está cheia: ela aceita ${limite} ${limite === 1 ? 'pessoa' : 'pessoas'}.` });
    }
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
    const parsed = z.object({
      muted: z.boolean().optional(), speaking: z.boolean().optional(), deafened: z.boolean().optional(),
      camera: z.boolean().optional(), screen: z.boolean().optional(), screenAudio: z.boolean().optional(),
    }).safeParse(patch);
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
    // Quem assiste avisa quem transmite. O encaminhamento é o mesmo dos
    // outros: só dentro da mesma call, e só para o alvo.
    'rtc:watch': rtcWatchSchema,
  } as const;
  for (const event of Object.keys(rtcSchemas) as Array<keyof typeof rtcSchemas>) {
    socket.on(event, (payload: unknown) => {
      const parsed = rtcSchemas[event].safeParse(payload);
      if (!parsed.success || !sameVoiceRoom(socket.id, parsed.data.target)) return;
      const { target, ...forwarded } = parsed.data;
      io.to(target).emit(event, { ...forwarded, from: socket.id, user: socket.data.user as PublicUser });
    });
  }

  // --- mesa de desenho compartilhada ---------------------------------------
  //
  // A mesa não depende de live nem de janela sobreposta: ela é desenhada
  // dentro do app, e por isso funciona igual no Linux e no Windows. Também não
  // depende da call — dá para desenhar com a voz ligada ou sem ela.
  //
  // Os dois baldes separam coisas de naturezas diferentes: a operação é
  // durável e vai para o histórico, o cursor é enfeite que some. Um cursor
  // frenético não pode consumir a vazão de quem está desenhando.
  const boardBucket = new TokenBucket(120, 60);
  const cursorBucket = new TokenBucket(20, 12);

  function boardActor(): BoardActor {
    const quem = socket.data.user as PublicUser;
    return { userId: quem.id, username: quem.username, serverAdmin: !p2pMode && isAdministrator(roleOfSocket(socket)) };
  }

  // O anúncio vai para quem enxerga o canal da mesa. Hoje todo canal listado é
  // visível para toda sessão autenticada, então isto é uma emissão geral; o
  // dia em que houver permissão por canal, o filtro entra exatamente aqui — e
  // não no cliente, que esconder botão não é autorizar.
  function announceBoard(event: string, payload: Record<string, unknown>): void {
    io.emit(event, payload);
  }

  socket.on('board:create', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = z.object({ channelId: z.string().min(1).max(64), name: z.string().max(MAX_BOARD_NAME * 4).optional() }).safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false, error: 'Pedido inválido.' });
    // A mesa fica vinculada a um canal ao qual os participantes têm acesso: um
    // convite para a mesa não ultrapassa a permissão desse canal.
    if (!channelIsAvailable(parsed.data.channelId)) return acknowledge?.({ ok: false, error: 'Esse canal não existe aqui.' });
    const created = whiteboards.create({ channelId: parsed.data.channelId, name: parsed.data.name, origin: boardOrigin, actor: boardActor() });
    if (!created.ok) return acknowledge?.({ ok: false, error: created.error });
    announceBoard('board:announce', { board: created.value });
    acknowledge?.({ ok: true, board: created.value });
  });

  socket.on('board:list', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = z.object({ channelId: z.string().min(1).max(64).optional(), archived: z.boolean().optional() }).safeParse(payload ?? {});
    if (!parsed.success) return acknowledge?.({ ok: false });
    const canais = availableChannels().map((channel) => channel.id).filter((id) => !parsed.data.channelId || id === parsed.data.channelId);
    acknowledge?.({ ok: true, boards: whiteboards.list(canais, parsed.data.archived === true) });
  });

  socket.on('board:join', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = boardJoinSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false, error: 'Pedido inválido.' });
    const board = whiteboards.get(parsed.data.boardId);
    if (!board || !channelIsAvailable(board.channelId)) return acknowledge?.({ ok: false, error: 'Essa mesa não existe mais.' });
    const entrou = whiteboards.join(parsed.data.boardId, socket.id, boardActor(), parsed.data.observer === true);
    if (!entrou.ok) return acknowledge?.({ ok: false, error: entrou.error });
    socket.join(`board:${parsed.data.boardId}`);
    io.to(`board:${parsed.data.boardId}`).emit('board:participants', { boardId: parsed.data.boardId, participants: whiteboards.participants(parsed.data.boardId) });
    acknowledge?.({ ok: true, ...entrou.value });
  });

  socket.on('board:leave', (payload: unknown) => {
    const parsed = z.object({ boardId: z.string().min(1).max(64) }).safeParse(payload);
    if (!parsed.success) return;
    leaveBoard(socket.id, parsed.data.boardId);
    socket.leave(`board:${parsed.data.boardId}`);
  });

  socket.on('board:ops', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = boardOpsSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false, error: 'Operação inválida.' });
    const board = whiteboards.get(parsed.data.boardId);
    if (!board || !channelIsAvailable(board.channelId)) return acknowledge?.({ ok: false, error: 'Essa mesa não existe mais.' });
    if (!board.participants.has(socket.id)) return acknowledge?.({ ok: false, error: 'Entre na mesa antes de desenhar nela.' });
    // `retry` separa "espere um instante" de "não, e não adianta insistir". Sem
    // essa distinção o cliente teria de escolher entre perder o traço de quem
    // desenhou rápido demais e reenviar para sempre o que foi recusado por
    // permissão.
    if (!boardBucket.take()) return acknowledge?.({ ok: false, retry: true, error: 'Muitas operações seguidas. Espere um instante.' });
    const result = whiteboards.submit(parsed.data.boardId, socket.id, boardActor(), parsed.data.ops as BoardOp[]);
    if (!result.ok) return acknowledge?.({ ok: false, error: result.error });
    if (result.value.accepted.length) {
      io.to(`board:${parsed.data.boardId}`).emit('board:ops', { boardId: parsed.data.boardId, ops: result.value.accepted });
      announceBoard('board:updated', { board: whiteboards.summary(board) });
    }
    acknowledge?.({ ok: true, ...result.value });
  });

  // Recuperação. Quem reconectou diz até onde chegou e recebe a diferença — ou
  // o quadro inteiro, se ficou para trás demais. É o mesmo caminho de quem
  // percebeu uma lacuna na sequência de revisões.
  socket.on('board:sync', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = boardSyncSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false, error: 'Pedido inválido.' });
    const board = whiteboards.get(parsed.data.boardId);
    if (!board || !channelIsAvailable(board.channelId)) return acknowledge?.({ ok: false, error: 'Essa mesa não existe mais.' });
    if (!board.participants.has(socket.id)) return acknowledge?.({ ok: false, error: 'Entre na mesa antes de sincronizá-la.' });
    const recovered = whiteboards.recover(parsed.data.boardId, parsed.data.since);
    if (!recovered.ok) return acknowledge?.({ ok: false, error: recovered.error });
    acknowledge?.({ ok: true, board: whiteboards.summary(board), ...recovered.value });
  });

  socket.on('board:cursor', (payload: unknown) => {
    const parsed = boardCursorSchema.safeParse(payload);
    if (!parsed.success) return;
    const board = whiteboards.get(parsed.data.boardId);
    if (!board?.participants.has(socket.id) || !cursorBucket.take()) return;
    const quem = socket.data.user as PublicUser;
    // O cursor alheio é temporário e não pertence ao histórico durável: ele
    // não ganha revisão, não entra no log e não sobrevive a um recarregamento.
    socket.to(`board:${parsed.data.boardId}`).emit('board:cursor', {
      boardId: parsed.data.boardId,
      cursor: { socketId: socket.id, userId: quem.id, username: quem.username, color: parsed.data.color, x: parsed.data.x, y: parsed.data.y, at: Date.now() },
    });
  });

  socket.on('board:manage', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const parsed = boardManageSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false, error: 'Pedido inválido.' });
    const board = whiteboards.get(parsed.data.boardId);
    if (!board || !channelIsAvailable(board.channelId)) return acknowledge?.({ ok: false, error: 'Essa mesa não existe mais.' });
    const result = whiteboards.manage(parsed.data.boardId, boardActor(), parsed.data.action, parsed.data.value);
    if (!result.ok) return acknowledge?.({ ok: false, error: result.error });
    // Excluída: não há mais mesa para descrever nem sala para atualizar. O
    // aviso vai para quem enxerga o canal, e não só para quem estava dentro.
    if (result.value.deleted) {
      announceBoard('board:closed', { boardId: parsed.data.boardId, reason: `${(socket.data.user as PublicUser).username} excluiu a mesa “${result.value.board.name}”.` });
      void audit(socket.data.user as PublicUser, 'board:delete', result.value.board.name).catch(() => undefined);
      return acknowledge?.({ ok: true, deleted: true, board: result.value.board });
    }
    // Limpar tudo é uma operação como outra qualquer: ela chega pelo mesmo
    // caminho, com revisão, e por isso quem reconectar depois também a vê.
    if (result.value.op) io.to(`board:${parsed.data.boardId}`).emit('board:ops', { boardId: parsed.data.boardId, ops: [result.value.op] });
    io.to(`board:${parsed.data.boardId}`).emit('board:state', { board: result.value.board, participants: whiteboards.participants(parsed.data.boardId) });
    announceBoard('board:updated', { board: result.value.board });
    void audit(socket.data.user as PublicUser, `board:${parsed.data.action}`, parsed.data.boardId).catch(() => undefined);
    acknowledge?.({ ok: true, board: result.value.board });
  });

  // A mesa que atravessa a troca de host, no P2P.
  //
  // Quando o host sai, a sinalização muda de máquina e o servidor novo sobe
  // vazio. Quem estava na mesa devolve o snapshot que tem, e o grupo continua
  // de onde parou. Três recusas guardam este caminho: um servidor dedicado
  // nunca adota nada vindo do fio, a origem precisa bater, e quem entrega
  // precisa estar na call daquele canal agora — não basta ter sido do grupo
  // algum dia.
  socket.on('board:adopt', (payload: unknown, acknowledge?: (result: unknown) => void) => {
    if (!p2pMode) return acknowledge?.({ ok: false, error: 'Um servidor dedicado não recebe mesas de fora.' });
    const parsed = boardAdoptSchema.safeParse(payload);
    if (!parsed.success) return acknowledge?.({ ok: false, error: 'Mesa inválida.' });
    const entrada = parsed.data.board;
    // A primeira pergunta é se ela foi excluída. Responder "entre na call"
    // para quem tenta devolver uma mesa apagada manda a pessoa resolver o
    // problema errado — e a resposta certa não depende de onde ela está.
    if (whiteboards.wasDeleted(entrada.id)) return acknowledge?.({ ok: false, error: 'Essa mesa foi excluída.' });
    if (!channelIsAvailable(entrada.channelId)) return acknowledge?.({ ok: false, error: 'Esse canal não existe aqui.' });
    // Estar na call deste host agora é o que significa "ser do grupo que está
    // reunido". Não é o mesmo que provar que a mesa é daqui — isso ninguém
    // consegue provar do lado de fora —, e é por isso que a promessa do P2P é
    // a que está escrita na tela: a mesa vive enquanto o grupo estiver junto.
    if (!rooms.roomOf(socket.id)) return acknowledge?.({ ok: false, error: 'Entre na call do grupo antes de devolver a mesa dele.' });
    const adotada = whiteboards.adopt({ ...entrada, log: [] } satisfies StoredBoard, boardOrigin);
    if (!adotada.ok) return acknowledge?.({ ok: false, error: adotada.error });
    announceBoard('board:announce', { board: adotada.value, restored: true });
    acknowledge?.({ ok: true, board: adotada.value });
  });

  socket.on('rtc:stream-meta', (payload: unknown) => {
    const parsed = rtcStreamMetaSchema.safeParse(payload);
    if (!parsed.success || !sameVoiceRoom(socket.id, parsed.data.target)) return;
    io.to(parsed.data.target).emit('rtc:stream-meta', { from: socket.id, meta: parsed.data.meta satisfies StreamMeta });
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    leaveVoice(socket.id);
    // Sair da mesa não apaga nada do que foi desenhado: some só a presença.
    for (const board of whiteboards.leave(socket.id)) {
      io.to(`board:${board.id}`).emit('board:participants', { boardId: board.id, participants: whiteboards.participants(board.id) });
    }
    broadcastSnapshot();
  });

  // Cada entrada pede uma rodada curta de mesclagem. Assim, qualquer pessoa
  // online pode devolver ao host atual mensagens que ele ainda não possua.
  io.emit('chat:sync:request');
});

function leaveBoard(socketId: string, boardId: string): void {
  const board = whiteboards.get(boardId);
  if (!board?.participants.delete(socketId)) return;
  io.to(`board:${boardId}`).emit('board:participants', { boardId, participants: whiteboards.participants(boardId) });
}

// O histórico anterior à separação por origem.
//
// Antes da 0.9.5 o cache local e o armazenamento de hospedagem eram o mesmo
// lugar: o que esta máquina viu em um servidor dedicado foi espelhado aqui.
// Esse material está misturado e não dá para saber de onde veio cada linha —
// então ele não é apagado nem publicado. Quem continua vendo é quem está nesta
// máquina; para quem chega de fora, ele não existe.
function isLoopbackSocket(socket: { handshake: { address: string } }): boolean {
  const address = String(socket.handshake.address ?? '').replace(/^::ffff:/, '');
  return address === '::1' || address.startsWith('127.');
}

function readableMessages(socket: { handshake: { address: string } }): readonly ChatMessage[] {
  const corte = store.legacyHistoryUntil;
  if (!corte || isLoopbackSocket(socket)) return store.messages;
  return store.messages.filter((message) => message.createdAt > corte);
}

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
  // As mesas guardadas voltam inteiras: salvar e reabrir preserva o conteúdo,
  // que é o que o dedicado promete. No P2P nada foi gravado, e a lista sobe
  // vazia — a mesa de lá vive enquanto o grupo estiver reunido.
  if (!p2pMode) whiteboards.load(store.boards, store.deletedBoards);
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
