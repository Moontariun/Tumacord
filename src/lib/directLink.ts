// Lado da interface do enlace direto: gerar o convite do host e, do outro
// lado, descobrir por qual dos caminhos anunciados dá para chegar nele.

import {
  DIRECT_INVITE_TTL_MS,
  decodeInvite,
  encodeBase64Url,
  encodeInvite,
  inviteExpired,
  orderPaths,
  pathToUrl,
  type DirectInvite,
  type DirectPath,
} from '../../shared/directLink';

export type { DirectInvite, DirectPath } from '../../shared/directLink';

export interface ResolvedInvite {
  invite: DirectInvite;
  url: string;
  path: DirectPath;
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

export function buildInvite(report: DirectReport, call: { callId: string; callName: string; hostUsername: string }, now = Date.now()): string | null {
  const paths = orderPaths(report.paths);
  if (!paths.length || !report.key) return null;
  return encodeInvite({
    version: 1,
    callId: call.callId,
    callName: call.callName,
    hostUsername: call.hostUsername,
    key: report.key,
    paths,
    issuedAt: now,
    ttlMs: DIRECT_INVITE_TTL_MS,
  });
}

export function readInvite(code: string): DirectInvite | null {
  const invite = decodeInvite(code);
  if (!invite || inviteExpired(invite)) return null;
  return invite;
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

// Happy Eyeballs: em vez de esperar cada caminho falhar em série — o que faria
// um IPv4 mapeado que caiu custar dois segundos e meio antes de tentar o IPv6 —
// os caminhos entram escalonados e o primeiro que responder vence.
export async function resolveInvite(code: string, options: { timeoutMs?: number; staggerMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ResolvedInvite | null> {
  const invite = readInvite(code);
  if (!invite) return null;
  const { staggerMs = 300 } = options;
  const paths = orderPaths(invite.paths);
  if (!paths.length) return null;
  const attempts = paths.map(async (path, index) => {
    if (index) await new Promise((resolve) => setTimeout(resolve, index * staggerMs));
    const url = pathToUrl(path);
    const reachable = await probeDirectHost(url, invite.key, options);
    if (!reachable) throw new Error(`caminho indisponível: ${url}`);
    return { invite, url, path } satisfies ResolvedInvite;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
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
