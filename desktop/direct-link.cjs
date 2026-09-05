// Orquestração do enlace direto.
//
// Junta o que `nat.cjs` e `upnp.cjs` descobrem em um relatório único: por
// quais endereços este computador aceita entrada, que nota de alcance ele tem
// para a eleição de host e qual chave protege a porta quando ela fica exposta
// à internet. Também mantém viva a regra de porta pedida ao roteador e a
// devolve no encerramento.

const { randomBytes } = require('node:crypto');
const nat = require('./nat.cjs');
const upnp = require('./upnp.cjs');

const SIGNALING_PORT = 3927;
const MAPPING_LIFETIME_SECONDS = 3600;
const PROBE_TTL_MS = 5 * 60 * 1000;

function parseIpv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address).trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function classifyIpv4(address) {
  const octets = parseIpv4(address);
  if (!octets) return null;
  const [first, second] = octets;
  if (first === 127) return 'loopback';
  if (first === 10) return 'private';
  if (first === 172 && second >= 16 && second <= 31) return 'private';
  if (first === 192 && second === 168) return 'private';
  if (first === 169 && second === 254) return 'link-local';
  if (first === 100 && second >= 64 && second <= 127) return 'cgnat';
  return 'public';
}

function isGlobalIpv6(address) {
  const clean = String(address).split('%')[0].toLowerCase();
  if (!clean.includes(':')) return false;
  if (clean === '::1' || clean.startsWith('fe80') || clean.startsWith('fec0')) return false;
  const first = Number.parseInt(clean.split(':')[0] || '0', 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  // 2000::/3 é a única faixa unicast global entregue hoje. O resto é
  // documentação, transição ou multicast e não serve de endereço de entrada.
  return (first & 0xe000) === 0x2000;
}

function isZeroTierInterface(name, address) {
  if (/^zt[a-z0-9]*$/i.test(String(name).trim())) return true;
  const octets = parseIpv4(address);
  return Boolean(octets && octets[0] === 10 && octets[1] === 147);
}

function stunServersFrom(urls) {
  const parsed = [];
  for (const url of urls ?? []) {
    const match = /^(?:stun:)?\[?([^\]]+?)\]?(?::(\d{1,5}))?$/.exec(String(url).trim());
    if (!match) continue;
    const port = Number(match[2] ?? 3478);
    if (!match[1] || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    parsed.push({ host: match[1], port });
  }
  return parsed.length ? parsed : nat.DEFAULT_STUN_SERVERS;
}

class DirectLink {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port ?? SIGNALING_PORT;
    this.key = options.key ?? randomBytes(24).toString('base64url');
    this.preferences = { zeroTierEnabled: false, portMapping: true, stunEnabled: true, stunServers: [], ...options.preferences };
    this.mapping = null;
    this.renewTimer = null;
    this.report = null;
    this.probedAt = 0;
    this.probing = null;
    this.closed = false;
  }

  setPreferences(preferences) {
    const previous = this.preferences;
    this.preferences = { ...previous, ...preferences };
    // Desligar o mapeamento tem de fechar a porta que já está aberta; deixar a
    // regra viva no roteador seria contrariar o que o usuário acabou de pedir.
    if (previous.portMapping && !this.preferences.portMapping) void this.releaseMapping();
    if (previous.zeroTierEnabled !== this.preferences.zeroTierEnabled || previous.stunEnabled !== this.preferences.stunEnabled) this.probedAt = 0;
    return this.preferences;
  }

  interfaces() {
    return nat.localAddresses({
      networkInterfaces: this.options.networkInterfaces,
      allowZeroTier: this.preferences.zeroTierEnabled,
      isZeroTier: isZeroTierInterface,
    });
  }

  // O IPv4 que vale como endereço de entrada é o da rota padrão. Entre vários,
  // o critério é: público ganha de privado, e privado ganha de CGNAT.
  primaryIpv4() {
    const candidates = this.interfaces()
      .filter((entry) => entry.family === 'IPv4' && classifyIpv4(entry.address))
      .map((entry) => ({ ...entry, class: classifyIpv4(entry.address) }))
      .filter((entry) => entry.class !== 'loopback' && entry.class !== 'link-local');
    const rank = { public: 0, private: 1, cgnat: 2 };
    return candidates.sort((a, b) => rank[a.class] - rank[b.class])[0] ?? null;
  }

  primaryIpv6() {
    const candidates = this.interfaces().filter((entry) => entry.family === 'IPv6' && isGlobalIpv6(entry.address));
    return candidates[0] ?? null;
  }

  async probe({ force = false } = {}) {
    if (this.closed) return this.emptyReport();
    if (!force && this.report && Date.now() - this.probedAt < PROBE_TTL_MS) return this.report;
    if (this.probing) return this.probing;
    this.probing = this.runProbe().finally(() => { this.probing = null; });
    return this.probing;
  }

  emptyReport() {
    return { grade: 'blocked', paths: [], ipv6: false, cgnat: false, natMapping: 'unknown', key: this.key, port: this.port, checkedAt: Date.now(), zeroTier: [] };
  }

  async runProbe() {
    const ipv4 = this.primaryIpv4();
    const ipv6 = this.primaryIpv6();
    const paths = [];
    if (ipv4) paths.push({ kind: 'lan', host: ipv4.address, port: this.port, via: 'interface' });
    if (ipv6) paths.push({ kind: 'ipv6', host: ipv6.address, port: this.port, via: 'interface' });

    let natMapping = 'unknown';
    let publicIpv4;
    if (this.preferences.stunEnabled) {
      const probe = await nat.probeNatMapping({
        servers: stunServersFrom(this.preferences.stunServers),
        createSocket: this.options.createSocket,
      }).catch(() => ({ mapping: 'unknown', results: [] }));
      natMapping = probe.mapping;
      publicIpv4 = probe.results.find((result) => result.family === 'IPv4')?.address;
    }

    const ipv4Class = ipv4 ? classifyIpv4(ipv4.address) : null;
    const publicOnInterface = ipv4Class === 'public';
    // CGNAT é o caso em que abrir porta no roteador de casa não resolve: o
    // endereço público mora no equipamento da operadora. O sinal mais claro é
    // o endereço 100.64/10 na interface; o reforço é o STUN devolver um IP
    // diferente de um IPv4 que já era público.
    const cgnat = ipv4Class === 'cgnat' || Boolean(publicIpv4 && ipv4Class === 'public' && publicIpv4 !== ipv4.address);

    if (publicOnInterface && !cgnat) {
      paths.push({ kind: 'ipv4', host: ipv4.address, port: this.port, via: 'interface' });
    } else if (this.preferences.portMapping && ipv4) {
      const mapping = await this.ensureMapping(ipv4.address).catch(() => null);
      const external = mapping?.externalAddress ?? publicIpv4;
      if (mapping && external && classifyIpv4(external) === 'public') {
        paths.push({ kind: 'ipv4', host: external, port: mapping.externalPort, via: mapping.via });
      }
    }

    const mapped = paths.some((path) => path.kind === 'ipv4' && path.via !== 'interface');
    const grade = publicOnInterface && paths.some((path) => path.kind === 'ipv4') ? 'open'
      : mapped ? 'mapped'
      : ipv6 ? 'ipv6'
      : ipv4 ? 'lan'
      : 'blocked';
    const base = { open: 100, mapped: 80, ipv6: 60, lan: 30, blocked: 0 };
    this.report = {
      grade,
      score: Math.min(100, base[grade] + (natMapping === 'endpoint-independent' ? 5 : 0)),
      paths,
      ipv6: Boolean(ipv6),
      cgnat,
      natMapping,
      publicIpv4,
      mappedPort: this.mapping?.externalPort,
      mappedVia: this.mapping?.via,
      key: this.key,
      port: this.port,
      checkedAt: Date.now(),
      zeroTier: nat.localAddresses({ networkInterfaces: this.options.networkInterfaces, isZeroTier: isZeroTierInterface })
        .filter((entry) => entry.zeroTier)
        .map((entry) => entry.address),
    };
    this.probedAt = Date.now();
    return this.report;
  }

  // PCP primeiro porque é o único que uma operadora pode atender no próprio
  // CGNAT; NAT-PMP em seguida por ser barato; UPnP por último por ser o mais
  // lento, ainda que seja o mais comum nos roteadores domésticos.
  async ensureMapping(clientAddress) {
    if (this.mapping) return this.mapping;
    const gateway = nat.defaultGateway(this.options.readRouteTable);
    const send = this.options.send ?? nat.sendAndWait;
    const attempt = async (factory) => { try { return await factory(); } catch { return null; } };

    let mapping = gateway ? await attempt(() => nat.requestPcpMapping({ gateway, clientAddress, protocol: 'tcp', internalPort: this.port, lifetimeSeconds: MAPPING_LIFETIME_SECONDS, send })) : null;
    if (!mapping && gateway) mapping = await attempt(() => nat.requestNatPmpMapping({ gateway, protocol: 'tcp', internalPort: this.port, lifetimeSeconds: MAPPING_LIFETIME_SECONDS, send }));
    if (!mapping) {
      const service = await attempt(() => (this.options.describeGateway ?? upnp.describeGateway)({}));
      if (service) mapping = await attempt(() => (this.options.addPortMapping ?? upnp.addPortMapping)({ service, internalPort: this.port, clientAddress, lifetimeSeconds: MAPPING_LIFETIME_SECONDS }));
    }
    if (!mapping) return null;
    this.mapping = mapping;
    this.scheduleRenewal();
    return mapping;
  }

  scheduleRenewal() {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.closed || !this.mapping) return;
    // Renovar na metade do prazo dá uma segunda chance antes de a regra cair;
    // um piso de um minuto evita que um roteador que devolve prazo curto
    // transforme isso em um laço apertado.
    const lifetime = Math.max(60, Number(this.mapping.lifetimeSeconds) || MAPPING_LIFETIME_SECONDS);
    this.renewTimer = setTimeout(() => {
      const previous = this.mapping;
      this.mapping = null;
      void this.ensureMapping(previous?.clientAddress ?? this.primaryIpv4()?.address).catch(() => undefined);
    }, (lifetime / 2) * 1000);
    if (typeof this.renewTimer.unref === 'function') this.renewTimer.unref();
  }

  async releaseMapping() {
    const mapping = this.mapping;
    this.mapping = null;
    if (this.renewTimer) { clearTimeout(this.renewTimer); this.renewTimer = null; }
    if (!mapping) return false;
    if (mapping.via === 'upnp') return (this.options.deletePortMapping ?? upnp.deletePortMapping)(mapping).catch(() => false);
    return nat.releasePortMapping(mapping, { send: this.options.send }).catch(() => false);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.releaseMapping().catch(() => undefined);
  }
}

module.exports = { DirectLink, SIGNALING_PORT, classifyIpv4, isGlobalIpv6, isZeroTierInterface, stunServersFrom };
