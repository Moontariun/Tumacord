// A sessão, ligada ao armazenamento do navegador.
//
// A decisão de o que lembrar e o que esquecer mora em `keyring.ts`, pura e
// testável. Aqui fica só a parte que depende de `localStorage`: ler, escrever
// e a migração da gaveta única que existia até a 0.9.5.

import type { SessionResponse } from '../../shared/types';
import { originFor } from './origin';
import { identityForLogin, type IdentityAttempt } from './identity';
import {
  abandonSession as descartarDoChaveiro,
  activeSession as chaveiroAtivo,
  destinations as chaveiroDestinos,
  emptyKeyring,
  endSession,
  forgetDestination,
  forgetEverything,
  keyAt,
  migrateSingleSession,
  putSession,
  rememberKey,
  sessionAt,
  switchTo,
  type Keyring,
  type SavedSession,
} from './keyring';

export type { SavedSession } from './keyring';

const KEYRING_KEY = 'tumacord.keyring';
const SERVER_KEY = 'tumacord.server';
/** A gaveta única de até a 0.9.5. Lida para migrar, nunca escrita de novo. */
const LEGACY_SESSION_KEY = 'tumacord.session';
/**
 * Que a conversão da gaveta única já aconteceu.
 *
 * Sem esta marca a conversão rodava a cada leitura, e a gaveta antiga — que
 * não é apagada de propósito — repunha a sessão logo depois de sair da conta.
 * No P2P a sessão antiga e a nova caem no mesmo destino, então sair de uma
 * conta do modo P2P não acontecia: ela voltava na leitura seguinte.
 *
 * A marca mora fora do chaveiro porque não é conteúdo dele: "esquecer tudo"
 * esvazia o chaveiro e não pode ressuscitar a gaveta de antes.
 */
const MIGRATION_KEY = 'tumacord.keyring.migrado';

export function destinationOf(session: SavedSession): string {
  return originFor({
    connectionMode: session.connectionMode ?? 'p2p',
    installationId: session.installationId,
    serverUrl: session.serverUrl,
    inviteKey: session.inviteKey ?? session.directKey,
  });
}

function parse(raw: string | null): Partial<Keyring> {
  try { return raw ? JSON.parse(raw) as Partial<Keyring> : {}; } catch { return {}; }
}

function readLegacy(): SavedSession | null {
  const raw = localStorage.getItem(LEGACY_SESSION_KEY) ?? sessionStorage.getItem(LEGACY_SESSION_KEY);
  try { return raw ? JSON.parse(raw) as SavedSession : null; } catch { return null; }
}

export function readKeyring(): Keyring {
  const persistido = parse(localStorage.getItem(KEYRING_KEY));
  const daAbertura = parse(sessionStorage.getItem(KEYRING_KEY));
  const chaveiro: Keyring = {
    remembered: persistido.remembered ?? {},
    ephemeral: daAbertura.ephemeral ?? {},
    keys: persistido.keys ?? {},
    active: daAbertura.active || persistido.active || '',
  };
  if (localStorage.getItem(MIGRATION_KEY)) return chaveiro;
  // Ler escrevendo é o preço de uma conversão que só pode acontecer uma vez.
  // A marca é gravada mesmo quando não havia nada para converter: o que se
  // registra é que este computador já passou por aqui.
  const convertido = migrateSingleSession(chaveiro, readLegacy(), destinationOf);
  localStorage.setItem(MIGRATION_KEY, new Date().toISOString());
  if (convertido !== chaveiro) writeKeyring(convertido);
  return convertido;
}

function writeKeyring(keyring: Keyring): void {
  localStorage.setItem(KEYRING_KEY, JSON.stringify({ remembered: keyring.remembered, keys: keyring.keys, active: keyring.active }));
  sessionStorage.setItem(KEYRING_KEY, JSON.stringify({ ephemeral: keyring.ephemeral, active: keyring.active }));
}

export function defaultServerUrl(): string {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return window.location.origin;
  return localStorage.getItem(SERVER_KEY) ?? 'http://127.0.0.1:3927';
}

/**
 * A call que a sessão estava retomando não é coisa de guardar.
 *
 * `resumeChannelId` existe para o agora: um convite aponta uma call, uma troca
 * de host reaponta a mesma. Guardá-lo no chaveiro fazia o aplicativo entrar
 * sozinho naquela call em toda abertura seguinte — para sempre, porque nada o
 * apagava. Entrar no Tumacord não é entrar na call.
 *
 * A limpeza vale na escrita e na leitura: na escrita para não gravar de novo,
 * na leitura para que quem já tem um valor gravado não entre sozinho uma
 * última vez.
 */
function semRetomada(session: SavedSession): SavedSession;
function semRetomada(session: SavedSession | null): SavedSession | null;
function semRetomada(session: SavedSession | null): SavedSession | null {
  if (!session?.resumeChannelId) return session;
  const { resumeChannelId: _agora, ...resto } = session;
  return resto;
}

export function loadSession(): SavedSession | null {
  return semRetomada(chaveiroAtivo(readKeyring()));
}

/** Os destinos que dá para retomar sem digitar nada. */
export function rememberedDestinations(): Array<{ destination: string; session: SavedSession }> {
  return chaveiroDestinos(readKeyring());
}

export function sessionFor(destination: string): SavedSession | null {
  return semRetomada(sessionAt(readKeyring(), destination));
}

export function saveSession(session: SavedSession): void {
  const chaveiro = readKeyring();
  writeKeyring(putSession(chaveiro, destinationOf(session), semRetomada(session)));
  localStorage.setItem(SERVER_KEY, session.serverUrl);
}

/** Sair da conta: encerra a sessão aberta e deixa as outras onde estão. */
export function clearSession(): void {
  const chaveiro = readKeyring();
  writeKeyring(chaveiro.active ? endSession(chaveiro, chaveiro.active) : chaveiro);
}

/**
 * Trocar de conta ou de servidor sem encerrar nada.
 *
 * Fecha a gaveta aberta e deixa a sessão dentro dela. É o que faltava para o
 * chaveiro servir para alguma coisa: até aqui, o único caminho de volta à tela
 * de entrada era sair da conta — e sair encerra.
 */
export function suspendActive(): void {
  const chaveiro = readKeyring();
  writeKeyring(switchTo(chaveiro, ''));
}

/**
 * Descartar uma sessão que foi gravada e nunca adotada.
 *
 * Quem chama é a recuperação automática do P2P, que autentica antes de saber
 * se a tela ainda está de pé. Sai só o que aquela tentativa escreveu.
 */
export function abandonSession(session: SavedSession): void {
  const chaveiro = readKeyring();
  writeKeyring(descartarDoChaveiro(chaveiro, destinationOf(session), session.token));
}

export function forgetThisDestination(destination: string): void {
  writeKeyring(forgetDestination(readKeyring(), destination));
}

export function forgetAllDestinations(): void {
  writeKeyring(forgetEverything());
}

export function useDestination(destination: string): SavedSession | null {
  const chaveiro = switchTo(readKeyring(), destination);
  writeKeyring(chaveiro);
  return semRetomada(sessionAt(chaveiro, destination));
}

// A chave do servidor, guardada só quando a pessoa pede.
//
// Mascarar o campo na tela não é proteger o que está no disco, e isto aqui é o
// disco: guardar continua sendo uma escolha explícita, separada de manter a
// sessão. Um armazenamento nativo protegido é o passo seguinte e não muda esta
// interface.
export function rememberServerKey(destination: string, key: string): void {
  writeKeyring(rememberKey(readKeyring(), destination, key));
}

export function savedServerKey(destination: string): string {
  return keyAt(readKeyring(), destination);
}

/**
 * O destino de um endereço, antes de qualquer autenticação.
 *
 * É o que permite a um convite reaproveitar a sessão que já existe para aquele
 * lugar em vez de pedir senha — ou derrubar tudo, que era o que acontecia.
 */
export async function resolveDestination(serverUrl: string, connectionMode: 'p2p' | 'server', inviteKey = ''): Promise<{ destination: string; serverName: string; installationId: string }> {
  const normalizado = serverUrl.trim().replace(/\/$/, '');
  let installationId = '';
  let serverName = '';
  try {
    const corpo = await (await fetch(`${normalizado}/api/health`)).json() as { installationId?: string; name?: string };
    installationId = typeof corpo?.installationId === 'string' ? corpo.installationId : '';
    serverName = typeof corpo?.name === 'string' ? corpo.name : '';
  } catch {
    // Servidor fora do ar ou anterior à 0.9.5: o endereço vira a identidade,
    // que separa pior e ainda separa.
  }
  return { destination: originFor({ connectionMode, installationId, serverUrl: normalizado, inviteKey }), serverName, installationId };
}

async function authenticate(
  path: 'login' | 'register',
  serverUrl: string,
  username: string,
  password: string,
  resumeChannelId?: string,
  allowCreate = false,
  connectionMode: 'p2p' | 'server' = 'p2p',
  rememberMe = true,
  serverKey = '',
): Promise<SavedSession> {
  const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
  // No P2P o nome é provado pela chave deste dispositivo. Um host anterior a
  // esta versão não pede prova, e o login segue exatamente como antes.
  const attempt: IdentityAttempt = connectionMode === 'p2p' ? await identityForLogin(normalizedUrl, username, serverKey.trim()) : {};
  const response = await fetch(`${normalizedUrl}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      ...(allowCreate ? { allowCreate: true } : {}),
      ...(serverKey.trim() ? { serverKey: serverKey.trim() } : {}),
      ...(attempt.identity ? { identity: attempt.identity } : {}),
    }),
  });
  const body = await response.json() as SessionResponse & { error?: string; identityRefusal?: string };
  if (!response.ok) {
    // Um chaveiro fechado não é "atualize o aplicativo". Quando a prova não
    // saiu por causa deste computador, é o motivo daqui que a pessoa lê.
    if (body.identityRefusal === 'proof-required' && attempt.unavailableMessage) throw new Error(attempt.unavailableMessage);
    throw new Error(body.error || 'Não foi possível entrar.');
  }
  const { installationId } = await resolveDestination(normalizedUrl, connectionMode, serverKey);
  // A senha só precisa acompanhar a sessão no modo dinâmico: ela permite
  // autenticar automaticamente no novo host durante a troca P2P. No servidor
  // dedicado o token persistente é suficiente, então não guardamos a senha.
  const saved: SavedSession = {
    serverUrl: normalizedUrl,
    token: body.token,
    user: body.user,
    serverName: body.serverName,
    password: connectionMode === 'p2p' ? password : undefined,
    resumeChannelId,
    connectionMode,
    rememberMe,
    // Cada chave no seu lugar: convite identifica grupo, chave de acesso abre
    // servidor. Guardá-las no mesmo campo era o que fazia uma valer pela outra.
    inviteKey: connectionMode === 'p2p' ? (serverKey.trim() || undefined) : undefined,
    installationId: installationId || undefined,
  };
  saveSession(saved);
  return saved;
}

export function login(serverUrl: string, username: string, password: string, resumeChannelId?: string, allowCreate = false, connectionMode: 'p2p' | 'server' = 'p2p', rememberMe = true, serverKey = ''): Promise<SavedSession> {
  return authenticate('login', serverUrl, username, password, resumeChannelId, allowCreate, connectionMode, rememberMe, serverKey);
}

export function register(serverUrl: string, username: string, password: string, resumeChannelId?: string, connectionMode: 'p2p' | 'server' = 'p2p', rememberMe = true, serverKey = ''): Promise<SavedSession> {
  return authenticate('register', serverUrl, username, password, resumeChannelId, false, connectionMode, rememberMe, serverKey);
}
