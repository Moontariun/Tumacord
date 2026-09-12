// A identidade deste dispositivo, do lado da interface.
//
// A interface não assina nada: ela pede ao processo principal, por campos, e
// leva o resultado ao host. Fora do desktop — no navegador, num servidor
// dedicado — não há identidade de grupo, e nada aqui acontece.

import type { Socket } from 'socket.io-client';
import type { IdentityClaim, IdentityRelease, LoginProof } from '../../shared/identity';

const LOCAL_SERVER = 'http://127.0.0.1:3927';
/** Quanto esperar por um host. Um host anterior a esta versão nunca responde. */
const ACK_TIMEOUT_MS = 5_000;
/** Quantas páginas uma sincronização percorre antes de parar. */
const MAX_PAGES = 25;

export interface IdentityAttempt {
  identity?: { proof: LoginProof; claim?: IdentityClaim };
  /** Por que a identidade não pôde ser usada, quando o motivo é deste computador. */
  unavailableMessage?: string;
}

interface IdentityPage {
  ok?: boolean;
  claims?: IdentityClaim[];
  releases?: IdentityRelease[];
  next?: number;
}

/** A mensagem do processo principal, sem o prefixo que o IPC acrescenta. */
function bridgeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/**
 * A prova de identidade para um login P2P, quando dá para ter uma.
 *
 * Nunca impede o login por conta própria. Sem desktop, com um host anterior a
 * esta versão ou com o desafio indisponível, o pedido segue sem prova, e é o
 * host que decide o que aceita — um nome reivindicado é recusado lá, com o
 * motivo.
 */
export async function identityForLogin(serverUrl: string, username: string, inviteKey: string, fetchImpl: typeof fetch = fetch): Promise<IdentityAttempt> {
  const bridge = typeof window === 'undefined' ? undefined : window.tumacordDesktop?.identity;
  if (!bridge) return {};
  let challenge: { nonce?: unknown; nameState?: unknown; accountExists?: unknown };
  try {
    const response = await fetchImpl(`${serverUrl}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, ...(inviteKey ? { serverKey: inviteKey } : {}) }),
      signal: AbortSignal.timeout(8_000),
    });
    // 404 é um host anterior a esta versão: o login segue como sempre foi.
    if (!response.ok) return {};
    challenge = await response.json() as typeof challenge;
  } catch {
    return {};
  }
  if (typeof challenge.nonce !== 'string') return {};
  try {
    const signed = await bridge.login({
      inviteKey,
      username,
      nonce: challenge.nonce,
      // O claim só vai quando o host diz que o nome está livre: reivindicar a
      // cada login deixaria um registro por entrada.
      withClaim: challenge.nameState === 'free',
      legacy: challenge.accountExists === true,
    });
    return { identity: signed.claim ? { proof: signed.proof, claim: signed.claim } : { proof: signed.proof } };
  } catch (error) {
    return { unavailableMessage: bridgeMessage(error) };
  }
}

async function localPage(after: number): Promise<IdentityPage | null> {
  try {
    const response = await fetch(`${LOCAL_SERVER}/api/local/identity?after=${after}`);
    return response.ok ? await response.json() as IdentityPage : null;
  } catch {
    return null;
  }
}

async function acknowledged(socket: Socket, event: string, payload: unknown): Promise<IdentityPage | null> {
  try {
    return await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload) as IdentityPage;
  } catch {
    return null;
  }
}

/**
 * Leva ao host os nomes que este computador conhece, e traz os que o host sabe.
 *
 * O que chega é guardado no servidor embutido deste computador. É isso que faz
 * a troca de host não reabrir os nomes: se esta máquina assumir, ela já sabe de
 * quem cada nome é, e quem chegar primeiro a ela não leva o nome de ninguém.
 */
export async function syncIdentity(socket: Socket): Promise<void> {
  if (typeof window === 'undefined' || !window.tumacordDesktop) return;

  let after = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const local = await localPage(after);
    if (!local || (!local.claims?.length && !local.releases?.length)) break;
    const pushed = await acknowledged(socket, 'identity:push', { claims: local.claims ?? [], releases: local.releases ?? [] });
    // Sem resposta é um host anterior, ou um que recusou: não insistir.
    if (!pushed?.ok) return;
    if (!local.next) break;
    after = local.next;
  }

  after = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const remote = await acknowledged(socket, 'identity:records', { after });
    if (!remote?.ok) return;
    if (remote.claims?.length || remote.releases?.length) {
      await fetch(`${LOCAL_SERVER}/api/local/identity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claims: remote.claims ?? [], releases: remote.releases ?? [] }),
      }).catch(() => undefined);
    }
    if (!remote.next) break;
    after = remote.next;
  }
}
