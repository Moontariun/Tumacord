// Preferências de rede vistas pela interface.
//
// A fonte da verdade é o processo principal, que precisa delas antes de a
// janela existir. Aqui guardamos um espelho síncrono porque o
// `RTCPeerConnection` é construído no meio de um evento e não pode esperar uma
// ida e volta de IPC para saber se deve oferecer STUN.

export interface NetworkPreferences {
  zeroTierEnabled: boolean;
  portMapping: boolean;
  stunEnabled: boolean;
  turnEnabled: boolean;
  stunServers: string[];
}

const MIRROR_KEY = 'tumacord.network-preferences';

export const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const DEFAULT_NETWORK_PREFERENCES: NetworkPreferences = {
  zeroTierEnabled: false,
  portMapping: true,
  stunEnabled: true,
  turnEnabled: false,
  stunServers: DEFAULT_STUN_SERVERS,
};

export function sanitizeNetworkPreferences(input: unknown): NetworkPreferences {
  const source = (input ?? {}) as Partial<NetworkPreferences>;
  const servers = Array.isArray(source.stunServers)
    ? source.stunServers.filter((server): server is string => typeof server === 'string' && Boolean(server.trim())).map((server) => server.trim()).slice(0, 8)
    : DEFAULT_STUN_SERVERS;
  return {
    zeroTierEnabled: typeof source.zeroTierEnabled === 'boolean' ? source.zeroTierEnabled : DEFAULT_NETWORK_PREFERENCES.zeroTierEnabled,
    portMapping: typeof source.portMapping === 'boolean' ? source.portMapping : DEFAULT_NETWORK_PREFERENCES.portMapping,
    stunEnabled: typeof source.stunEnabled === 'boolean' ? source.stunEnabled : DEFAULT_NETWORK_PREFERENCES.stunEnabled,
    turnEnabled: typeof source.turnEnabled === 'boolean' ? source.turnEnabled : DEFAULT_NETWORK_PREFERENCES.turnEnabled,
    stunServers: servers.length ? servers : DEFAULT_STUN_SERVERS,
  };
}

function readMirror(): NetworkPreferences {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    return raw ? sanitizeNetworkPreferences(JSON.parse(raw)) : { ...DEFAULT_NETWORK_PREFERENCES };
  } catch {
    return { ...DEFAULT_NETWORK_PREFERENCES };
  }
}

let current = readMirror();
const listeners = new Set<(preferences: NetworkPreferences) => void>();

function publish(next: NetworkPreferences): NetworkPreferences {
  current = next;
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(next));
  } catch {
    // Espelho é conveniência; a preferência real está no processo principal.
  }
  for (const listener of listeners) listener(next);
  return next;
}

export function currentNetworkPreferences(): NetworkPreferences {
  return current;
}

export async function loadNetworkPreferences(): Promise<NetworkPreferences> {
  const bridge = window.tumacordDesktop;
  if (!bridge) return current;
  try {
    return publish(sanitizeNetworkPreferences(await bridge.getNetworkPreferences()));
  } catch {
    return current;
  }
}

export async function updateNetworkPreferences(patch: Partial<NetworkPreferences>): Promise<NetworkPreferences> {
  const optimistic = sanitizeNetworkPreferences({ ...current, ...patch });
  publish(optimistic);
  const bridge = window.tumacordDesktop;
  if (!bridge) return optimistic;
  try {
    return publish(sanitizeNetworkPreferences(await bridge.setNetworkPreferences(patch)));
  } catch {
    return optimistic;
  }
}

export function subscribeNetworkPreferences(listener: (preferences: NetworkPreferences) => void): () => void {
  listeners.add(listener);
  const bridge = window.tumacordDesktop;
  const unsubscribe = bridge?.onNetworkPreferencesChanged((preferences) => publish(sanitizeNetworkPreferences(preferences)));
  return () => {
    listeners.delete(listener);
    unsubscribe?.();
  };
}

// Sem servidor STUN o ICE só oferece o endereço da própria interface, e é
// exatamente por isso que a 0.7.8 precisava do ZeroTier: fora da mesma rede,
// nenhum candidato servia. Com STUN o navegador aprende o endereço público e
// fura o NAT — inclusive boa parte do CGNAT — sem nada no meio do caminho.
export function iceServersFor(preferences: NetworkPreferences = current): RTCIceServer[] {
  if (!preferences.stunEnabled) return [];
  const urls = preferences.stunServers
    .map((server) => (server.startsWith('stun:') || server.startsWith('stuns:') ? server : `stun:${server}`))
    .filter((server, index, all) => all.indexOf(server) === index)
    .slice(0, 8);
  return urls.length ? [{ urls }] : [];
}
