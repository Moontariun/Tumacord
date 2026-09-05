// Por onde a mídia realmente está passando.
//
// Saber que a call "está funcionando" não diz se ela foi direto, se furou o
// NAT ou se está sendo repassada pelo relay — e a diferença importa: relay
// custa banda do servidor e some se um caminho direto aparecer depois. O
// WebRTC já sabe a resposta, no par de candidatos que ele escolheu; só nunca
// tínhamos olhado.
//
// `host`   endereço da própria interface — mesma rede, ou IPv6 direto
// `srflx`  endereço público descoberto por STUN — o NAT foi furado
// `prflx`  descoberto durante a checagem, também travessia direta
// `relay`  passando pelo TURN

export type CandidateKind = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';
export type AddressFamily = 'IPv4' | 'IPv6' | 'unknown';

export interface RtcStatLike {
  type?: string;
  id?: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  protocol?: string;
  address?: string;
  ip?: string;
  relayProtocol?: string;
  currentRoundTripTime?: number;
}

export interface SelectedPath {
  local: CandidateKind;
  remote: CandidateKind;
  protocol: string;
  family: AddressFamily;
  relayed: boolean;
  roundTripMs?: number;
}

function kindOf(value: unknown): CandidateKind {
  return value === 'host' || value === 'srflx' || value === 'prflx' || value === 'relay' ? value : 'unknown';
}

// A família sai do formato do endereço, não de um campo — nem todo navegador
// informa `addressFamily`, mas todos informam o endereço.
export function addressFamily(address: unknown): AddressFamily {
  if (typeof address !== 'string' || !address) return 'unknown';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return 'IPv4';
  return address.includes(':') ? 'IPv6' : 'unknown';
}

export function selectedCandidatePath(stats: Iterable<RtcStatLike>): SelectedPath | null {
  const entries = [...stats];
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
  // O par vale quando está em uso: `selected` quando o navegador informa, e
  // `succeeded` + `nominated` no formato padrão.
  const pair = entries.find((entry) => entry.type === 'candidate-pair' && entry.selected)
    ?? entries.find((entry) => entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated)
    ?? entries.find((entry) => entry.type === 'candidate-pair' && entry.state === 'succeeded');
  if (!pair) return null;
  const local = pair.localCandidateId ? byId.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? byId.get(pair.remoteCandidateId) : undefined;
  const localKind = kindOf(local?.candidateType);
  const remoteKind = kindOf(remote?.candidateType);
  return {
    local: localKind,
    remote: remoteKind,
    protocol: (local?.protocol ?? remote?.protocol ?? 'udp').toLowerCase(),
    family: addressFamily(local?.address ?? local?.ip ?? remote?.address ?? remote?.ip),
    // Basta um lado pelo relay para a mídia passar por ele.
    relayed: localKind === 'relay' || remoteKind === 'relay',
    ...(typeof pair.currentRoundTripTime === 'number' ? { roundTripMs: Math.round(pair.currentRoundTripTime * 1000) } : {}),
  };
}

export function describeSelectedPath(path: SelectedPath | null): string {
  if (!path) return 'caminho ainda não escolhido';
  const como = path.relayed
    ? 'pelo relay TURN'
    : path.local === 'host' && path.remote === 'host'
      ? 'direto, sem NAT no meio'
      : 'direto, furando o NAT';
  const familia = path.family === 'unknown' ? '' : ` · ${path.family}`;
  return `${como}${familia} · ${path.protocol.toUpperCase()}`;
}

// Agregado para o painel do servidor: quantas conexões vão direto e quantas
// dependem do relay. Nenhum endereço sai daqui.
export interface PathSummary {
  total: number;
  direct: number;
  relayed: number;
  ipv6: number;
  unknown: number;
}

export function summarizePaths(paths: readonly (SelectedPath | null)[]): PathSummary {
  const summary: PathSummary = { total: paths.length, direct: 0, relayed: 0, ipv6: 0, unknown: 0 };
  for (const path of paths) {
    if (!path) { summary.unknown += 1; continue; }
    if (path.relayed) summary.relayed += 1;
    else summary.direct += 1;
    if (path.family === 'IPv6') summary.ipv6 += 1;
  }
  return summary;
}
