// Lado da interface do convite: gerar o código do host e, do outro lado,
// conferir que o servidor de encontro que ele aponta responde pela call certa.

import {
  DIRECT_INVITE_TTL_MS,
  decodeInvite,
  decodeShortInvite,
  encodeBase64Url,
  encodeInvite,
  encodeShortInvite,
  inviteExpired,
  normalizeRendezvousUrl,
  type DirectInvite,
  type DirectPath,
} from '../../shared/directLink';

export type { DirectInvite, DirectPath } from '../../shared/directLink';

// Pedir ao servidor um convite curto. Quem chama já tem sessão: convidar é
// ato de quem está dentro. O token volta uma vez só; o servidor guarda o hash.
//
// Com prazo, porque sem ele um servidor que aceita a conexão e não responde
// deixa a janela de convite em "Pedindo um código ao servidor…" para sempre —
// não há erro, não há reserva, não há nada a fazer além de fechar.
export const SHORT_INVITE_TIMEOUT_MS = 8_000;

export async function requestShortInvite(
  serverUrl: string,
  token: string,
  call: { callId: string; callName: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const { fetchImpl = fetch, timeoutMs = SHORT_INVITE_TIMEOUT_MS } = options;
  const base = normalizeRendezvousUrl(serverUrl);
  if (!base) return null;
  const controller = new AbortController();
  const prazo = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(call),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) return null;
    return encodeShortInvite({ server: base, token: body.token }) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(prazo);
  }
}

// Ler um convite curto é perguntar ao servidor de que call ele trata. Um
// código vencido ou inventado devolve nada, e é o servidor que decide isso —
// o prazo deixou de morar dentro do código.
export async function resolveShortInvite(code: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ResolvedInvite | null> {
  const { fetchImpl = fetch, timeoutMs = SHORT_INVITE_TIMEOUT_MS } = options;
  const parsed = decodeShortInvite(code);
  if (!parsed) return null;
  const controller = new AbortController();
  const prazo = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${parsed.server}/api/invite/${parsed.token}`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json() as { callId?: unknown; callName?: unknown; hostUsername?: unknown };
    if (typeof body.callId !== 'string' || !body.callId) return null;
    return {
      invite: {
        version: 1,
        callId: body.callId,
        callName: typeof body.callName === 'string' && body.callName ? body.callName : 'Call',
        hostUsername: typeof body.hostUsername === 'string' ? body.hostUsername : '',
        // O token faz as vezes da chave de acesso, com escopo deste convite.
        key: parsed.token,
        server: parsed.server,
        issuedAt: 0,
        ttlMs: 0,
      },
      url: parsed.server,
      mode: 'server',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(prazo);
  }
}

export interface ResolvedInvite {
  invite: DirectInvite;
  url: string;
  // Sobrou um modo só. O campo continua porque quem chama decide o que fazer
  // com a sessão a partir dele, e porque um convite futuro por outro caminho
  // vai precisar se distinguir aqui.
  mode: 'server';
}

export interface DirectReport {
  grade: 'open' | 'mapped' | 'ipv6' | 'lan' | 'blocked';
  score: number;
  paths: DirectPath[];
  ipv6: boolean;
  cgnat: boolean;
  natMapping: 'open' | 'endpoint-independent' | 'symmetric' | 'unknown';
  publicIpv4?: string;
  mappedPort?: number;
  mappedVia?: 'pcp' | 'nat-pmp' | 'upnp';
  key: string;
  port: number;
  checkedAt: number;
  zeroTier: string[];
}

export async function readDirectReport(options: { force?: boolean } = {}): Promise<DirectReport | null> {
  const bridge = window.tumacordDesktop;
  if (!bridge) return null;
  try {
    return (await bridge.directReport(options)) as DirectReport;
  } catch {
    return null;
  }
}

// O convite precisa ser o mesmo texto enquanto a call for a mesma e os
// caminhos não mudarem. Sem esta memória, `issuedAt` era carimbado a cada
// chamada: como a tela da call re-renderiza a cada atualização de ping, o
// código mudava por inteiro várias vezes por segundo — e mudar o valor de um
// campo enquanto a pessoa seleciona o texto atrapalha até a cópia.
//
// O que identifica um convite é a call, a chave e os endereços de entrada. Se
// nada disso mudou, o código anterior continua valendo e é ele que aparece.
const INVITE_RENEWAL_MARGIN_MS = 60 * 60 * 1000;

let cachedInvite: { signature: string; code: string; issuedAt: number } | null = null;

// O convite não carrega endereço de máquina nenhuma: só a call, o servidor de
// encontro e o segredo que prova o direito de entrar. Sem servidor não há
// convite — é o que a 0.8.3 passou a exigir.
export function buildInvite(call: { callId: string; callName: string; hostUsername: string; server?: string; key?: string }, now = Date.now()): string | null {
  const server = normalizeRendezvousUrl(call.server);
  const key = call.key ?? '';
  if (!server || !key) return null;
  const signature = [call.callId, call.callName, call.hostUsername, key, server].join('|');
  // Renova com uma hora de folga: um código que vence no bolso de quem
  // recebeu é pior do que um código novo.
  const stillUseful = cachedInvite
    && cachedInvite.signature === signature
    && now >= cachedInvite.issuedAt
    && now < cachedInvite.issuedAt + DIRECT_INVITE_TTL_MS - INVITE_RENEWAL_MARGIN_MS;
  if (stillUseful && cachedInvite) return cachedInvite.code;
  const code = encodeInvite({
    version: 1,
    callId: call.callId,
    callName: call.callName,
    hostUsername: call.hostUsername,
    key,
    server,
    issuedAt: now,
    ttlMs: DIRECT_INVITE_TTL_MS,
  });
  cachedInvite = { signature, code, issuedAt: now };
  return code;
}

// Existe para os testes e para o caso de a pessoa querer explicitamente um
// código novo; o uso normal nunca precisa disso.
export function forgetCachedInvite(): void {
  cachedInvite = null;
}

export function readInvite(code: string): DirectInvite | null {
  const invite = decodeInvite(code);
  if (!invite || inviteExpired(invite)) return null;
  return invite;
}

// Existem dois formatos de convite vivos: o curto `TUMA2`, que é o atual, e o
// longo `TUMA1`, que continua sendo lido para não invalidar código que já
// circulou. Reconhecer o formato é local e barato; alcançar o servidor é outra
// coisa, e vem depois.
//
// Quem só sabia ler `TUMA1` recusava o convite da 0.8.4 antes mesmo de tentar
// alcançar o servidor — e a mensagem dizia "código inválido ou vencido" para
// um código recém-emitido. Era o formato novo sendo barrado pela porta.
export function inviteFormat(code: string): 'short' | 'long' | null {
  if (decodeShortInvite(code)) return 'short';
  return readInvite(code) ? 'long' : null;
}

// O código curto é o formato atual; o longo é a reserva. Uma única função para
// os dois evita que um caminho da interface conheça um formato e o outro não.
export async function resolveAnyInvite(code: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ResolvedInvite | null> {
  return (await resolveShortInvite(code, options).catch(() => null))
    ?? (await resolveInvite(code, options).catch(() => null));
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

// O host devolve um HMAC do nonce com a chave do convite. Sem essa conferência,
// um endereço que trocou de dono desde que o convite foi gerado receberia o
// usuário e a senha de quem tentasse entrar.
async function proofMatches(key: string, nonce: string, proofs: string[] | undefined): Promise<boolean> {
  if (!proofs?.length) return false;
  const subtle = globalThis.crypto?.subtle;
  // Sem WebCrypto ainda é seguro: o servidor continua exigindo a chave no
  // login. O que se perde é só a checagem antecipada, feita aqui.
  if (!subtle) return true;
  try {
    const encoder = new TextEncoder();
    const cryptoKey = await subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await subtle.sign('HMAC', cryptoKey, encoder.encode(nonce));
    return proofs.includes(encodeBase64Url(new Uint8Array(signature)));
  } catch {
    return false;
  }
}

export async function probeDirectHost(url: string, key: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<boolean> {
  const { timeoutMs = 2500, fetchImpl = fetch } = options;
  const nonce = randomNonce();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}/api/direct/hello?nonce=${encodeURIComponent(nonce)}`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; requiresKey?: boolean; proofs?: string[] };
    if (!body.ok) return false;
    // Um host de rede local pode não exigir chave; nesse caso não há prova a
    // conferir e o alcance por si só já responde a pergunta.
    if (!body.requiresKey) return true;
    return await proofMatches(key, nonce, body.proofs);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Um convite aponta para um servidor de encontro e nada mais. A corrida entre
// endereços do host — rede local, IPv6, IPv4 mapeado — saiu na 0.8.3 junto com
// o convite que os carregava.
export async function resolveInvite(code: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ResolvedInvite | null> {
  const invite = readInvite(code);
  if (!invite) return null;
  // O servidor de encontro é alcançado por conexão de saída, que é o caminho
  // que funciona mesmo com os dois lados em CGNAT.
  const reachable = await probeDirectHost(invite.server, invite.key, options);
  return reachable ? { invite, url: invite.server, mode: 'server' } : null;
}

// Entrar em uma call pelo convite de outra pessoa significa passar a aceitar
// aquele mesmo convite aqui: é o que mantém o código válido quando o host sai
// e este computador assume a call.
export async function adoptDirectKey(key: string): Promise<boolean> {
  if (!window.tumacordDesktop || key.length < 22) return false;
  try {
    const response = await fetch('http://127.0.0.1:3927/api/direct/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function describeGrade(grade: DirectReport['grade']): string {
  if (grade === 'open') return 'IPv4 público';
  if (grade === 'mapped') return 'porta aberta no roteador';
  if (grade === 'ipv6') return 'IPv6 direto';
  if (grade === 'lan') return 'somente rede local';
  return 'sem entrada';
}
