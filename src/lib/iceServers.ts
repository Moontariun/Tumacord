// A lista de servidores ICE que cada enlace da call recebe.
//
// São duas metades com origens diferentes. O STUN vem das preferências locais
// e serve só para descobrir o endereço público — ele não transporta nada. O
// TURN vem do servidor, com credencial temporária, e é o único que pode
// acabar carregando a mídia; por isso ele só existe quando há um servidor
// configurado para isso E quando esta pessoa ligou o relay.
//
// O relay é opt-in por pessoa e nasce desligado. Ter o servidor anunciando um
// relay não é razão para usá-lo: a mídia passaria por uma máquina de terceiro,
// cifrada mas passando, e gastando banda dela. Quem decide é quem não fecha
// caminho direto, e decide para si — a escolha não vem do servidor.
//
// A ordem entre eles não é decidida aqui: o ICE compara candidatos por
// prioridade e um par direto sempre vence um par por relay. O relay entra
// quando nenhum direto se forma, e sai de cena se um direto aparecer depois.

import { currentNetworkPreferences, iceServersFor, type NetworkPreferences } from './networkPreferences';

interface CachedTurn {
  servers: RTCIceServer[];
  expiresAt: number;
  source: string;
}

let cachedTurn: CachedTurn | null = null;

// Uma credencial que vence no meio de uma call derrubaria a reconexão de um
// enlace justamente quando ela é mais necessária. A renovação acontece com
// cinco minutos de folga.
const RENEWAL_MARGIN_MS = 5 * 60 * 1000;

export function turnServersAreFresh(now = Date.now()): boolean {
  return Boolean(cachedTurn && cachedTurn.expiresAt - RENEWAL_MARGIN_MS > now);
}

export function cachedTurnServers(): RTCIceServer[] {
  return cachedTurn?.servers ?? [];
}

export function forgetTurnServers(): void {
  cachedTurn = null;
}

function usableTurnServers(input: unknown): RTCIceServer[] {
  if (!Array.isArray(input)) return [];
  const servers: RTCIceServer[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(candidate.urls) ? candidate.urls : [candidate.urls])
      .filter((url): url is string => typeof url === 'string' && /^turns?:/i.test(url));
    if (!urls.length) continue;
    servers.push({
      urls,
      ...(typeof candidate.username === 'string' ? { username: candidate.username } : {}),
      ...(typeof candidate.credential === 'string' ? { credential: candidate.credential } : {}),
    });
  }
  return servers;
}

export async function refreshTurnServers(serverUrl: string, token: string, options: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<RTCIceServer[]> {
  const { fetchImpl = fetch, now = Date.now() } = options;
  const source = serverUrl.replace(/\/$/, '');
  if (cachedTurn?.source === source && turnServersAreFresh(now)) return cachedTurn.servers;
  try {
    const response = await fetchImpl(`${source}/api/turn`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return cachedTurn?.source === source ? cachedTurn.servers : [];
    const body = await response.json() as { iceServers?: unknown; expiresAt?: unknown };
    const servers = usableTurnServers(body.iceServers);
    const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) ? body.expiresAt : 0;
    cachedTurn = servers.length ? { servers, expiresAt, source } : null;
    return servers;
  } catch {
    // Um servidor sem TURN, ou fora do ar por um instante, não pode impedir a
    // call de começar: sem relay ela ainda funciona em todo caminho direto.
    return cachedTurn?.source === source ? cachedTurn.servers : [];
  }
}

export function iceServers(preferences: NetworkPreferences = currentNetworkPreferences(), now = Date.now()): RTCIceServer[] {
  const stun = iceServersFor(preferences);
  // A checagem fica aqui, e não só em quem busca a credencial, porque este é o
  // ponto por onde toda `RTCPeerConnection` passa. Uma credencial que sobrou de
  // antes de desligar não pode virar candidato depois.
  const relay = preferences.turnEnabled && cachedTurn && cachedTurn.expiresAt > now ? cachedTurn.servers : [];
  return [...stun, ...relay];
}
