// Travessia de NAT sem ZeroTier.
//
// Três protocolos padronizados dão conta do que o adaptador virtual fazia:
//
// - STUN (RFC 5389) diz qual é o endereço público e, comparando a resposta de
//   dois servidores diferentes, se o NAT mantém a mesma porta externa para
//   destinos distintos. Manter é o que permite furar CGNAT: é assim que o ICE
//   do WebRTC leva voz e vídeo até o outro lado sem intermediário;
// - PCP (RFC 6887) e NAT-PMP (RFC 6886) pedem uma porta externa ao roteador.
//   O PCP é o único desses que uma operadora pode responder no equipamento de
//   CGNAT, então ele é tentado primeiro mesmo quando o IPv4 local é 100.64/10;
// - as interfaces da máquina entregam o IPv6 global, que não tem NAT no meio e
//   por isso costuma ser o caminho mais limpo justamente para quem está em
//   CGNAT.
//
// Nada aqui abre porta sozinho: quem chama decide, e todo mapeamento pedido é
// devolvido ao roteador no encerramento.

const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_COOKIE_BYTES = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_ATTRIBUTE_MAPPED_ADDRESS = 0x0001;
const STUN_ATTRIBUTE_XOR_MAPPED_ADDRESS = 0x0020;
const PORT_CONTROL_PORT = 5351;

const DEFAULT_STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.nextcloud.com', port: 443 },
];

function formatIpv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push((bytes[index] << 8) | bytes[index + 1]);
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      const length = index - start;
      if (length > bestLength) { bestStart = start; bestLength = length; }
      start = -1;
    }
  }
  const text = groups.map((group) => group.toString(16));
  if (bestLength < 2) return text.join(':');
  return `${text.slice(0, bestStart).join(':')}::${text.slice(bestStart + bestLength).join(':')}`;
}

function buildStunBindingRequest(transactionId) {
  const packet = Buffer.alloc(20);
  packet.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(packet, 8);
  return packet;
}

function readStunAddress(value, transactionId, xored) {
  if (value.length < 8) return null;
  const family = value.readUInt8(1);
  const rawPort = value.readUInt16BE(2);
  const port = xored ? rawPort ^ (STUN_MAGIC_COOKIE >>> 16) : rawPort;
  if (family === 0x01) {
    const raw = value.subarray(4, 8);
    const octets = [...raw].map((octet, index) => (xored ? octet ^ STUN_COOKIE_BYTES[index] : octet));
    return { address: octets.join('.'), port, family: 'IPv4' };
  }
  if (family === 0x02) {
    if (value.length < 20) return null;
    const key = Buffer.concat([STUN_COOKIE_BYTES, transactionId]);
    const raw = [...value.subarray(4, 20)].map((octet, index) => (xored ? octet ^ key[index] : octet));
    return { address: formatIpv6(raw), port, family: 'IPv6' };
  }
  return null;
}

function parseStunResponse(packet, transactionId) {
  if (!Buffer.isBuffer(packet) || packet.length < 20) return null;
  if (packet.readUInt16BE(0) !== STUN_BINDING_RESPONSE) return null;
  if (packet.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;
  if (!packet.subarray(8, 20).equals(transactionId)) return null;
  const end = Math.min(packet.length, 20 + packet.readUInt16BE(2));
  let mapped = null;
  let offset = 20;
  while (offset + 4 <= end) {
    const type = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 2);
    const value = packet.subarray(offset + 4, offset + 4 + length);
    if (value.length < length) break;
    // O XOR-MAPPED-ADDRESS existe porque roteadores antigos reescreviam o IP
    // que enxergavam dentro do pacote. Ele tem prioridade; o campo legado só
    // entra quando o servidor não mandou o moderno.
    if (type === STUN_ATTRIBUTE_XOR_MAPPED_ADDRESS) mapped = readStunAddress(value, transactionId, true) ?? mapped;
    else if (type === STUN_ATTRIBUTE_MAPPED_ADDRESS && !mapped) mapped = readStunAddress(value, transactionId, false);
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return mapped;
}

function stunQuery(server, options = {}) {
  const { createSocket = dgram.createSocket, timeoutMs = 1500, socketType = 'udp4', socket: providedSocket } = options;
  return new Promise((resolve) => {
    const transactionId = randomBytes(12);
    const socket = providedSocket ?? createSocket({ type: socketType, reuseAddr: true });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onError);
      if (!providedSocket) { try { socket.close(); } catch { /* já fechado */ } }
      resolve(result);
    };
    const onMessage = (buffer) => {
      const mapped = parseStunResponse(buffer, transactionId);
      if (mapped) finish({ ...mapped, server });
    };
    const onError = () => finish(null);
    // O prazo não é `unref`: ele é curto e precisa disparar, senão uma
    // consulta sem resposta deixaria a promessa pendurada para sempre.
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
    try {
      socket.send(buildStunBindingRequest(transactionId), server.port, server.host, (error) => {
        if (error) finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

// Duas consultas pela mesma porta local: se o endereço público volta igual nas
// duas, o NAT é independente do destino e o ICE consegue furar. Se a porta
// muda, é NAT simétrico e nem o WebRTC atravessa sem relay.
async function probeNatMapping(options = {}) {
  const { servers = DEFAULT_STUN_SERVERS, socketType = 'udp4', createSocket = dgram.createSocket, timeoutMs = 1500, localAddress } = options;
  const socket = createSocket({ type: socketType, reuseAddr: true });
  const bound = await new Promise((resolve) => {
    let done = false;
    const settle = (value) => { if (!done) { done = true; resolve(value); } };
    socket.once('error', () => settle(false));
    try {
      socket.bind({ port: 0, address: localAddress, exclusive: false }, () => settle(true));
    } catch {
      settle(false);
    }
  });
  if (!bound) {
    try { socket.close(); } catch { /* nunca chegou a abrir */ }
    return { mapping: 'unknown', results: [] };
  }
  const results = [];
  for (const server of servers.slice(0, 3)) {
    const result = await stunQuery(server, { socket, timeoutMs });
    if (result) results.push(result);
    if (results.length === 2) break;
  }
  try { socket.close(); } catch { /* já fechado */ }
  if (!results.length) return { mapping: 'unknown', results };
  if (results.length === 1) return { mapping: 'unknown', results };
  const [first, second] = results;
  const stable = first.address === second.address && first.port === second.port;
  return { mapping: stable ? 'endpoint-independent' : 'symmetric', results };
}

// O gateway sai da tabela de rotas do kernel. Adivinhar `x.y.z.1` acertaria na
// maioria das casas e erraria em silêncio no resto, então nada de chute.
function defaultGateway(readRouteTable = () => fs.readFileSync('/proc/net/route', 'utf8')) {
  let table;
  try {
    table = readRouteTable();
  } catch {
    return null;
  }
  for (const line of table.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const [, destination, gateway, flagsText] = columns;
    if (destination !== '00000000') continue;
    const flags = Number.parseInt(flagsText, 16);
    if (!Number.isFinite(flags) || !(flags & 0x2)) continue;
    const value = Number.parseInt(gateway, 16);
    if (!Number.isFinite(value) || value === 0) continue;
    // /proc/net/route guarda o endereço em ordem de host (little-endian nos
    // processadores que nos interessam), por isso os octetos saem invertidos.
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff].join('.');
  }
  return null;
}

function buildNatPmpMapRequest({ protocol, internalPort, externalPort, lifetimeSeconds }) {
  const packet = Buffer.alloc(12);
  packet.writeUInt8(0, 0);
  packet.writeUInt8(protocol === 'tcp' ? 2 : 1, 1);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt16BE(internalPort, 4);
  packet.writeUInt16BE(externalPort, 6);
  packet.writeUInt32BE(lifetimeSeconds, 8);
  return packet;
}

function parseNatPmpMapResponse(packet, protocol) {
  if (!Buffer.isBuffer(packet) || packet.length < 16) return null;
  if (packet.readUInt8(0) !== 0) return null;
  if (packet.readUInt8(1) !== (protocol === 'tcp' ? 130 : 129)) return null;
  const resultCode = packet.readUInt16BE(2);
  if (resultCode !== 0) return { ok: false, resultCode };
  return {
    ok: true,
    resultCode,
    internalPort: packet.readUInt16BE(8),
    externalPort: packet.readUInt16BE(10),
    lifetimeSeconds: packet.readUInt32BE(12),
  };
}

function buildNatPmpAddressRequest() {
  return Buffer.from([0, 0]);
}

function parseNatPmpAddressResponse(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) return null;
  if (packet.readUInt8(0) !== 0 || packet.readUInt8(1) !== 128) return null;
  if (packet.readUInt16BE(2) !== 0) return null;
  return [...packet.subarray(8, 12)].join('.');
}

function ipv4MappedBytes(address) {
  const octets = String(address).split('.').map(Number);
  const bytes = Buffer.alloc(16);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return bytes;
  bytes.writeUInt16BE(0xffff, 10);
  for (let index = 0; index < 4; index += 1) bytes.writeUInt8(octets[index], 12 + index);
  return bytes;
}

function readMappedIpv4(bytes) {
  const prefixIsIpv4Mapped = bytes.subarray(0, 10).every((byte) => byte === 0) && bytes.readUInt16BE(10) === 0xffff;
  if (prefixIsIpv4Mapped) return [...bytes.subarray(12, 16)].join('.');
  return formatIpv6([...bytes]);
}

function buildPcpMapRequest({ clientAddress, nonce, protocol, internalPort, externalPort, lifetimeSeconds }) {
  const packet = Buffer.alloc(60);
  packet.writeUInt8(2, 0);
  packet.writeUInt8(1, 1);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt32BE(lifetimeSeconds, 4);
  ipv4MappedBytes(clientAddress).copy(packet, 8);
  nonce.copy(packet, 24);
  packet.writeUInt8(protocol === 'tcp' ? 6 : 17, 36);
  packet.writeUInt16BE(internalPort, 40);
  packet.writeUInt16BE(externalPort, 42);
  return packet;
}

function parsePcpMapResponse(packet, nonce) {
  if (!Buffer.isBuffer(packet) || packet.length < 60) return null;
  if (packet.readUInt8(0) !== 2 || packet.readUInt8(1) !== 0x81) return null;
  const resultCode = packet.readUInt8(3);
  if (!packet.subarray(24, 36).equals(nonce)) return null;
  if (resultCode !== 0) return { ok: false, resultCode };
  return {
    ok: true,
    resultCode,
    lifetimeSeconds: packet.readUInt32BE(4),
    internalPort: packet.readUInt16BE(40),
    externalPort: packet.readUInt16BE(42),
    externalAddress: readMappedIpv4(packet.subarray(44, 60)),
  };
}

function sendAndWait(packet, { host, port, timeoutMs = 900, createSocket = dgram.createSocket }) {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* já fechado */ }
      resolve(value);
    };
    // O prazo não é `unref`: ele é curto e precisa disparar, senão uma
    // consulta sem resposta deixaria a promessa pendurada para sempre.
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('message', (buffer) => finish(buffer));
    socket.on('error', () => finish(null));
    try {
      socket.send(packet, port, host, (error) => { if (error) finish(null); });
    } catch {
      finish(null);
    }
  });
}

async function requestPcpMapping(options) {
  const { gateway, clientAddress, protocol = 'tcp', internalPort, externalPort = internalPort, lifetimeSeconds = 3600, nonce = randomBytes(12), send = sendAndWait, timeoutMs = 900 } = options;
  if (!gateway || !clientAddress) return null;
  const request = buildPcpMapRequest({ clientAddress, nonce, protocol, internalPort, externalPort, lifetimeSeconds });
  const response = await send(request, { host: gateway, port: PORT_CONTROL_PORT, timeoutMs });
  const parsed = response && parsePcpMapResponse(response, nonce);
  if (!parsed?.ok) return null;
  return {
    via: 'pcp',
    protocol,
    internalPort,
    externalPort: parsed.externalPort,
    externalAddress: parsed.externalAddress,
    lifetimeSeconds: parsed.lifetimeSeconds,
    nonce,
    gateway,
    clientAddress,
  };
}

async function requestNatPmpMapping(options) {
  const { gateway, protocol = 'tcp', internalPort, externalPort = internalPort, lifetimeSeconds = 3600, send = sendAndWait, timeoutMs = 900 } = options;
  if (!gateway) return null;
  const response = await send(buildNatPmpMapRequest({ protocol, internalPort, externalPort, lifetimeSeconds }), { host: gateway, port: PORT_CONTROL_PORT, timeoutMs });
  const parsed = response && parseNatPmpMapResponse(response, protocol);
  if (!parsed?.ok) return null;
  const addressResponse = await send(buildNatPmpAddressRequest(), { host: gateway, port: PORT_CONTROL_PORT, timeoutMs });
  return {
    via: 'nat-pmp',
    protocol,
    internalPort,
    externalPort: parsed.externalPort,
    externalAddress: (addressResponse && parseNatPmpAddressResponse(addressResponse)) || undefined,
    lifetimeSeconds: parsed.lifetimeSeconds,
    gateway,
  };
}

async function releasePortMapping(mapping, options = {}) {
  const { send = sendAndWait, timeoutMs = 700 } = options;
  if (!mapping?.gateway) return false;
  // Tempo de vida zero é o pedido de remoção nos dois protocolos. Deixar a
  // porta aberta depois de fechar o app seria abrir a casa e ir embora.
  if (mapping.via === 'pcp' && mapping.nonce && mapping.clientAddress) {
    const request = buildPcpMapRequest({
      clientAddress: mapping.clientAddress,
      nonce: mapping.nonce,
      protocol: mapping.protocol,
      internalPort: mapping.internalPort,
      externalPort: 0,
      lifetimeSeconds: 0,
    });
    await send(request, { host: mapping.gateway, port: PORT_CONTROL_PORT, timeoutMs });
    return true;
  }
  if (mapping.via === 'nat-pmp') {
    const request = buildNatPmpMapRequest({ protocol: mapping.protocol, internalPort: mapping.internalPort, externalPort: 0, lifetimeSeconds: 0 });
    await send(request, { host: mapping.gateway, port: PORT_CONTROL_PORT, timeoutMs });
    return true;
  }
  return false;
}

function localAddresses(options = {}) {
  const { networkInterfaces = os.networkInterfaces, allowZeroTier = true, isZeroTier = () => false } = options;
  const entries = [];
  for (const [name, list] of Object.entries(networkInterfaces() ?? {})) {
    for (const entry of list ?? []) {
      if (!entry || entry.internal) continue;
      const zeroTier = isZeroTier(name, entry.address);
      if (zeroTier && !allowZeroTier) continue;
      entries.push({ name, address: entry.address, family: entry.family === 6 || entry.family === 'IPv6' ? 'IPv6' : 'IPv4', netmask: entry.netmask, zeroTier, scopeid: entry.scopeid });
    }
  }
  return entries;
}

module.exports = {
  DEFAULT_STUN_SERVERS,
  PORT_CONTROL_PORT,
  buildNatPmpAddressRequest,
  buildNatPmpMapRequest,
  buildPcpMapRequest,
  buildStunBindingRequest,
  defaultGateway,
  formatIpv6,
  localAddresses,
  parseNatPmpAddressResponse,
  parseNatPmpMapResponse,
  parsePcpMapResponse,
  parseStunResponse,
  probeNatMapping,
  releasePortMapping,
  requestNatPmpMapping,
  requestPcpMapping,
  sendAndWait,
  stunQuery,
};
