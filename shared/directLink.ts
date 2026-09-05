// Enlace direto: a camada que substitui o ZeroTier como caminho padrão.
//
// O ZeroTier resolvia um problema só — colocar todo mundo na mesma rede L3 —
// e cobrava por isso uma conta em serviço externo, um adaptador virtual e um
// salto a mais em cada pacote. O enlace direto troca aquilo por três coisas
// que já existem na internet: endereço IPv6 global, mapeamento de porta no
// roteador (PCP/NAT-PMP/UPnP) e travessia de NAT por ICE/STUN para a mídia.
//
// Este módulo é a parte pura dessa camada: classificação de endereços,
// pontuação de alcance, ordenação de caminhos e o codec do código de convite.
// Ele roda igual no servidor (Node) e na interface (navegador), por isso não
// depende de `Buffer`, `btoa` nem de nada específico de plataforma.

export type DirectPathKind = 'lan' | 'ipv6' | 'ipv4';
export type DirectPathVia = 'interface' | 'pcp' | 'nat-pmp' | 'upnp' | 'stun';

export interface DirectPath {
  kind: DirectPathKind;
  host: string;
  port: number;
  via: DirectPathVia;
}

export type Ipv4Class = 'loopback' | 'private' | 'cgnat' | 'link-local' | 'public';
export type Ipv6Class = 'loopback' | 'link-local' | 'unique-local' | 'global';

// Como o NAT trata a porta de origem decide se dá para furar CGNAT: mapeamento
// independente do destino ("cone") mantém a mesma porta externa para todo
// mundo e o ICE atravessa; simétrico troca a porta a cada destino e só um
// relay resolveria.
export type NatMappingBehavior = 'open' | 'endpoint-independent' | 'symmetric' | 'unknown';

export type ReachabilityGrade = 'open' | 'mapped' | 'ipv6' | 'lan' | 'blocked';

export interface ReachabilityReport {
  grade: ReachabilityGrade;
  paths: DirectPath[];
  ipv6: boolean;
  cgnat: boolean;
  natMapping: NatMappingBehavior;
  publicIpv4?: string;
  mappedPort?: number;
  mappedVia?: DirectPathVia;
}

export interface DirectInvite {
  version: 1;
  callId: string;
  callName: string;
  hostUsername: string;
  key: string;
  paths: DirectPath[];
  issuedAt: number;
  ttlMs: number;
}

export const DIRECT_INVITE_PREFIX = 'TUMA1';
export const DIRECT_INVITE_TTL_MS = 12 * 60 * 60 * 1000;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseIpv4(address: string): number[] | null {
  const match = IPV4_PATTERN.exec(address.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

export function classifyIpv4(address: string): Ipv4Class | null {
  const octets = parseIpv4(address);
  if (!octets) return null;
  const [first, second] = octets;
  if (first === 127) return 'loopback';
  if (first === 10) return 'private';
  if (first === 172 && second >= 16 && second <= 31) return 'private';
  if (first === 192 && second === 168) return 'private';
  if (first === 169 && second === 254) return 'link-local';
  // 100.64.0.0/10 é o espaço reservado ao CGNAT (RFC 6598). Um endereço desse
  // na interface significa que o provedor divide um IPv4 público entre vários
  // assinantes: mapear porta no roteador de casa não abre nada para fora.
  if (first === 100 && second >= 64 && second <= 127) return 'cgnat';
  return 'public';
}

export function expandIpv6(address: string): number[] | null {
  const clean = address.trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (!clean || !/^[0-9a-fA-F:.]+$/.test(clean)) return null;
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const readGroups = (part: string): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    const chunks = part.split(':');
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk.includes('.')) {
        if (index !== chunks.length - 1) return null;
        const octets = parseIpv4(chunk);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };
  const head = readGroups(halves[0]);
  const tail = halves.length === 2 ? readGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

export function classifyIpv6(address: string): Ipv6Class | null {
  const groups = expandIpv6(address);
  if (!groups) return null;
  if (groups.every((group, index) => (index === 7 ? group === 1 : group === 0))) return 'loopback';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((groups[0] & 0xfe00) === 0xfc00) return 'unique-local';
  return 'global';
}

// Quem chega por um endereço da própria rede já passou pela porta de casa: é o
// mesmo nível de confiança que a descoberta por broadcast sempre teve. O
// espaço de CGNAT fica de fora de propósito — ele carrega assinantes
// desconhecidos do mesmo provedor, não a rede do usuário.
export function isTrustedLocalAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  const ipv4 = classifyIpv4(normalized);
  if (ipv4) return ipv4 === 'loopback' || ipv4 === 'private' || ipv4 === 'link-local';
  const ipv6 = classifyIpv6(normalized);
  return ipv6 === 'loopback' || ipv6 === 'link-local' || ipv6 === 'unique-local';
}

// O nome da interface é o sinal mais confiável de ZeroTier no Linux: o driver
// sempre cria `ztXXXXXXXX`. A faixa 10.147.x é o padrão das redes públicas
// dele e serve de reforço quando o nome não chega até aqui.
export function isZeroTierInterface(name: string, address?: string): boolean {
  if (/^zt[a-z0-9]*$/i.test(name.trim())) return true;
  if (!address) return false;
  const octets = parseIpv4(address);
  return Boolean(octets && octets[0] === 10 && octets[1] === 147);
}

export function reachabilityScore(report: Pick<ReachabilityReport, 'grade' | 'natMapping'>): number {
  const base: Record<ReachabilityGrade, number> = { open: 100, mapped: 80, ipv6: 60, lan: 30, blocked: 0 };
  const bonus = report.natMapping === 'endpoint-independent' ? 5 : 0;
  return Math.min(100, base[report.grade] + bonus);
}

export function gradeFor(input: { paths: DirectPath[]; publicIpv4Interface: boolean; ipv6: boolean; mapped: boolean }): ReachabilityGrade {
  if (input.publicIpv4Interface && input.paths.some((path) => path.kind === 'ipv4')) return 'open';
  if (input.mapped && input.paths.some((path) => path.kind === 'ipv4')) return 'mapped';
  if (input.ipv6 && input.paths.some((path) => path.kind === 'ipv6')) return 'ipv6';
  if (input.paths.some((path) => path.kind === 'lan')) return 'lan';
  return 'blocked';
}

// Ordem de tentativa (Happy Eyeballs do RFC 8305 aplicado ao nosso caso): a
// rede local primeiro porque não sai de casa, depois IPv6 porque não tem NAT
// no meio, e só então o IPv4 mapeado, que depende do roteador manter a regra.
const PATH_ORDER: Record<DirectPathKind, number> = { lan: 0, ipv6: 1, ipv4: 2 };

export function orderPaths(paths: readonly DirectPath[], options: { ipv6Available?: boolean } = {}): DirectPath[] {
  const usable = paths.filter((path) => path.port > 0 && path.port < 65_536 && Boolean(path.host));
  const deduplicated = new Map<string, DirectPath>();
  for (const path of usable) {
    const key = `${path.kind}:${path.host}:${path.port}`;
    if (!deduplicated.has(key)) deduplicated.set(key, path);
  }
  return [...deduplicated.values()]
    .filter((path) => path.kind !== 'ipv6' || options.ipv6Available !== false)
    .sort((a, b) => PATH_ORDER[a.kind] - PATH_ORDER[b.kind] || a.host.localeCompare(b.host) || a.port - b.port);
}

export function pathToUrl(path: DirectPath): string {
  const host = path.kind === 'ipv6' || path.host.includes(':') ? `[${path.host.replace(/^\[|\]$/g, '')}]` : path.host;
  return `http://${host}:${path.port}`;
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64URL[first >> 2];
    output += BASE64URL[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    output += BASE64URL[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    output += BASE64URL[third & 0x3f];
  }
  return output;
}

function decodeBase64Url(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = BASE64URL.indexOf(character);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  // `for…of` percorre pontos de código, então pares substitutos já chegam
  // inteiros aqui e um apelido com emoji atravessa o convite sem quebrar.
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string | null {
  let output = '';
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    let code: number;
    let size: number;
    if (first < 0x80) { code = first; size = 1; }
    else if ((first & 0xe0) === 0xc0) { code = first & 0x1f; size = 2; }
    else if ((first & 0xf0) === 0xe0) { code = first & 0x0f; size = 3; }
    else if ((first & 0xf8) === 0xf0) { code = first & 0x07; size = 4; }
    else return null;
    if (index + size > bytes.length) return null;
    for (let offset = 1; offset < size; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) return null;
      code = (code << 6) | (next & 0x3f);
    }
    output += String.fromCodePoint(code);
    index += size;
  }
  return output;
}

// Um convite viaja por WhatsApp, Discord e às vezes por voz. O dígito de
// verificação existe para o app dizer "esse código está truncado" em vez de
// tentar conectar em um endereço remendado.
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(-7);
}

const PATH_KIND_CODE: Record<DirectPathKind, string> = { lan: 'l', ipv6: '6', ipv4: '4' };
const PATH_VIA_CODE: Record<DirectPathVia, string> = { interface: 'i', pcp: 'p', 'nat-pmp': 'n', upnp: 'u', stun: 's' };
const CODE_TO_PATH_KIND = new Map(Object.entries(PATH_KIND_CODE).map(([kind, code]) => [code, kind as DirectPathKind]));
const CODE_TO_PATH_VIA = new Map(Object.entries(PATH_VIA_CODE).map(([via, code]) => [code, via as DirectPathVia]));

export function encodeInvite(invite: DirectInvite): string {
  const compact = {
    v: 1,
    r: invite.callId,
    n: invite.callName,
    h: invite.hostUsername,
    k: invite.key,
    t: Math.round(invite.issuedAt),
    x: Math.round(invite.ttlMs),
    p: invite.paths.map((path) => [PATH_KIND_CODE[path.kind], path.host, path.port, PATH_VIA_CODE[path.via]]),
  };
  const payload = encodeBase64Url(utf8Encode(JSON.stringify(compact)));
  return `${DIRECT_INVITE_PREFIX}.${payload}.${checksumOf(payload)}`;
}

export function decodeInvite(code: string): DirectInvite | null {
  const parts = code.trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 3) return null;
  const [prefix, payload, checksum] = parts;
  if (prefix.toUpperCase() !== DIRECT_INVITE_PREFIX) return null;
  if (checksumOf(payload) !== checksum.toLowerCase()) return null;
  const bytes = decodeBase64Url(payload);
  if (!bytes) return null;
  const json = utf8Decode(bytes);
  if (!json) return null;
  let compact: Record<string, unknown>;
  try {
    compact = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (compact.v !== 1) return null;
  const callId = typeof compact.r === 'string' ? compact.r : '';
  const key = typeof compact.k === 'string' ? compact.k : '';
  if (!callId || key.length < 22) return null;
  const rawPaths = Array.isArray(compact.p) ? compact.p : [];
  const paths: DirectPath[] = [];
  for (const entry of rawPaths) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const kind = CODE_TO_PATH_KIND.get(String(entry[0]));
    const host = typeof entry[1] === 'string' ? entry[1] : '';
    const port = Number(entry[2]);
    const via = CODE_TO_PATH_VIA.get(String(entry[3])) ?? 'interface';
    if (!kind || !host || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (kind === 'ipv6' ? !classifyIpv6(host) : !classifyIpv4(host)) continue;
    paths.push({ kind, host, port, via });
  }
  if (!paths.length) return null;
  return {
    version: 1,
    callId,
    callName: typeof compact.n === 'string' && compact.n ? compact.n : 'Call Geral',
    hostUsername: typeof compact.h === 'string' ? compact.h : '',
    key,
    paths,
    issuedAt: Number.isFinite(compact.t) ? Number(compact.t) : 0,
    ttlMs: Number.isFinite(compact.x) ? Number(compact.x) : DIRECT_INVITE_TTL_MS,
  };
}

export function inviteExpired(invite: DirectInvite, now = Date.now()): boolean {
  if (!invite.issuedAt || !invite.ttlMs) return false;
  return now > invite.issuedAt + invite.ttlMs;
}

export function describeReachability(report: ReachabilityReport): string {
  if (report.grade === 'open') return 'IPv4 público direto: qualquer pessoa entra pelo convite.';
  if (report.grade === 'mapped') {
    const via = report.mappedVia === 'pcp' ? 'PCP' : report.mappedVia === 'nat-pmp' ? 'NAT-PMP' : 'UPnP';
    return `Porta aberta no roteador por ${via}${report.ipv6 ? ', com IPv6 de reserva' : ''}.`;
  }
  if (report.grade === 'ipv6') {
    return report.cgnat
      ? 'Seu IPv4 está em CGNAT, mas o IPv6 está livre: quem tiver IPv6 entra direto.'
      : 'Entrada pelo IPv6 do seu computador; o IPv4 não aceita conexão de fora.';
  }
  if (report.grade === 'lan') return 'Só a rede local alcança este computador. Peça para outra pessoa abrir a call.';
  return 'Nenhum caminho de entrada disponível. Outra pessoa precisa ser host, ou ligue o ZeroTier nas configurações.';
}

// Quem tem o melhor caminho de entrada deve ser o host: a sinalização mora no
// host, e um host inalcançável deixa a call inteira sem porta de entrada. O
// ping continua desempatando, como antes.
export function betterHost<T extends { reachability?: number; pingMs: number; id: string }>(a: T, b: T): number {
  const reach = (candidate: T) => Math.max(0, Math.min(100, Math.round(candidate.reachability ?? 0)));
  return reach(b) - reach(a) || a.pingMs - b.pingMs || a.id.localeCompare(b.id);
}
