import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const nat = require('../desktop/nat.cjs') as {
  buildStunBindingRequest: (transactionId: Buffer) => Buffer;
  parseStunResponse: (packet: Buffer, transactionId: Buffer) => { address: string; port: number; family: string } | null;
  formatIpv6: (bytes: number[]) => string;
  buildNatPmpMapRequest: (input: { protocol: string; internalPort: number; externalPort: number; lifetimeSeconds: number }) => Buffer;
  parseNatPmpMapResponse: (packet: Buffer, protocol: string) => { ok: boolean; resultCode: number; externalPort?: number; lifetimeSeconds?: number } | null;
  parseNatPmpAddressResponse: (packet: Buffer) => string | null;
  buildPcpMapRequest: (input: { clientAddress: string; nonce: Buffer; protocol: string; internalPort: number; externalPort: number; lifetimeSeconds: number }) => Buffer;
  parsePcpMapResponse: (packet: Buffer, nonce: Buffer) => { ok: boolean; resultCode: number; externalPort?: number; externalAddress?: string } | null;
  defaultGateway: (read?: () => string) => string | null;
  localAddresses: (options: Record<string, unknown>) => Array<{ name: string; address: string; family: string; zeroTier: boolean }>;
  probeNatMapping: (options: Record<string, unknown>) => Promise<{ mapping: string; results: Array<{ address: string; port: number }> }>;
  requestPcpMapping: (options: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  requestNatPmpMapping: (options: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  releasePortMapping: (mapping: Record<string, unknown>, options?: Record<string, unknown>) => Promise<boolean>;
  stunQuery: (server: { host: string; port: number }, options: Record<string, unknown>) => Promise<unknown>;
};

const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

function stunResponse(transactionId: Buffer, attributes: Buffer, type = 0x0101): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(attributes.length, 2);
  COOKIE.copy(header, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, attributes]);
}

function xorMappedIpv4(address: string, port: number): Buffer {
  const value = Buffer.alloc(8);
  value.writeUInt8(0, 0);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(port ^ 0x2112, 2);
  address.split('.').forEach((octet, index) => value.writeUInt8(Number(octet) ^ COOKIE[index], 4 + index));
  const attribute = Buffer.alloc(4);
  attribute.writeUInt16BE(0x0020, 0);
  attribute.writeUInt16BE(value.length, 2);
  return Buffer.concat([attribute, value]);
}

test('a requisição STUN carrega o cookie mágico e o identificador da transação', () => {
  const transactionId = Buffer.alloc(12, 7);
  const packet = nat.buildStunBindingRequest(transactionId);
  assert.equal(packet.length, 20);
  assert.equal(packet.readUInt16BE(0), 0x0001);
  assert.equal(packet.readUInt16BE(2), 0);
  assert.equal(packet.readUInt32BE(4), 0x2112a442);
  assert.deepEqual(packet.subarray(8, 20), transactionId);
});

test('o endereço público sai do XOR-MAPPED-ADDRESS', () => {
  const transactionId = Buffer.alloc(12, 3);
  const packet = stunResponse(transactionId, xorMappedIpv4('189.40.12.7', 41_827));
  assert.deepEqual(nat.parseStunResponse(packet, transactionId), { address: '189.40.12.7', port: 41_827, family: 'IPv4' });
});

test('resposta com transação, tipo ou cookie errado é descartada', () => {
  const transactionId = Buffer.alloc(12, 3);
  const attribute = xorMappedIpv4('189.40.12.7', 41_827);
  assert.equal(nat.parseStunResponse(stunResponse(transactionId, attribute), Buffer.alloc(12, 9)), null);
  assert.equal(nat.parseStunResponse(stunResponse(transactionId, attribute, 0x0111), transactionId), null);
  const corrupted = stunResponse(transactionId, attribute);
  corrupted.writeUInt32BE(0xdeadbeef, 4);
  assert.equal(nat.parseStunResponse(corrupted, transactionId), null);
  assert.equal(nat.parseStunResponse(Buffer.alloc(8), transactionId), null);
});

test('o MAPPED-ADDRESS legado só entra quando não há o moderno, e o moderno vence', () => {
  const transactionId = Buffer.alloc(12, 5);
  const legacyValue = Buffer.alloc(8);
  legacyValue.writeUInt8(0x01, 1);
  legacyValue.writeUInt16BE(3927, 2);
  '10.0.0.9'.split('.').forEach((octet, index) => legacyValue.writeUInt8(Number(octet), 4 + index));
  const legacy = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x08]), legacyValue]);
  assert.deepEqual(nat.parseStunResponse(stunResponse(transactionId, legacy), transactionId), { address: '10.0.0.9', port: 3927, family: 'IPv4' });
  const both = Buffer.concat([legacy, xorMappedIpv4('189.40.12.7', 41_827)]);
  assert.deepEqual(nat.parseStunResponse(stunResponse(transactionId, both), transactionId), { address: '189.40.12.7', port: 41_827, family: 'IPv4' });
});

test('IPv6 é remontado a partir do XOR com cookie e transação, na forma comprimida', () => {
  const transactionId = Buffer.alloc(12, 0x11);
  const key = Buffer.concat([COOKIE, transactionId]);
  const raw = Buffer.from([0x28, 0x04, 0x01, 0x4d, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0a]);
  const value = Buffer.alloc(20);
  value.writeUInt8(0x02, 1);
  value.writeUInt16BE(3927 ^ 0x2112, 2);
  for (let index = 0; index < 16; index += 1) value.writeUInt8(raw[index] ^ key[index], 4 + index);
  const attribute = Buffer.concat([Buffer.from([0x00, 0x20, 0x00, 0x14]), value]);
  assert.deepEqual(nat.parseStunResponse(stunResponse(transactionId, attribute), transactionId), { address: '2804:14d:1::a', port: 3927, family: 'IPv6' });
});

test('a forma comprimida do IPv6 usa a maior sequência de zeros', () => {
  assert.equal(nat.formatIpv6([0x28, 0x04, 1, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), '2804:14d::1');
  assert.equal(nat.formatIpv6(Array.from({ length: 16 }, (_value, index) => (index === 15 ? 1 : 0))), '::1');
  assert.equal(nat.formatIpv6([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]), '1:2:3:4:5:6:7:8');
});

test('o pedido NAT-PMP segue o formato do RFC 6886 e a resposta é lida de volta', () => {
  const request = nat.buildNatPmpMapRequest({ protocol: 'tcp', internalPort: 3927, externalPort: 3927, lifetimeSeconds: 3600 });
  assert.equal(request.length, 12);
  assert.equal(request.readUInt8(0), 0);
  assert.equal(request.readUInt8(1), 2);
  assert.equal(request.readUInt16BE(4), 3927);
  assert.equal(request.readUInt32BE(8), 3600);

  const response = Buffer.alloc(16);
  response.writeUInt8(0, 0);
  response.writeUInt8(130, 1);
  response.writeUInt16BE(0, 2);
  response.writeUInt16BE(3927, 8);
  response.writeUInt16BE(41_827, 10);
  response.writeUInt32BE(3600, 12);
  assert.deepEqual(nat.parseNatPmpMapResponse(response, 'tcp'), { ok: true, resultCode: 0, internalPort: 3927, externalPort: 41_827, lifetimeSeconds: 3600 });
  assert.equal(nat.parseNatPmpMapResponse(response, 'udp'), null, 'a resposta de TCP não pode ser lida como se fosse de UDP');

  const refused = Buffer.from(response);
  refused.writeUInt16BE(2, 2);
  assert.deepEqual(nat.parseNatPmpMapResponse(refused, 'tcp'), { ok: false, resultCode: 2 });

  const address = Buffer.alloc(12);
  address.writeUInt8(128, 1);
  Buffer.from([189, 40, 12, 7]).copy(address, 8);
  assert.equal(nat.parseNatPmpAddressResponse(address), '189.40.12.7');
});

test('o pedido PCP tem 60 bytes e a resposta precisa trazer o mesmo nonce', () => {
  const nonce = Buffer.alloc(12, 0x5a);
  const request = nat.buildPcpMapRequest({ clientAddress: '192.168.0.4', nonce, protocol: 'tcp', internalPort: 3927, externalPort: 3927, lifetimeSeconds: 3600 });
  assert.equal(request.length, 60);
  assert.equal(request.readUInt8(0), 2);
  assert.equal(request.readUInt8(1), 1);
  assert.equal(request.readUInt32BE(4), 3600);
  assert.equal(request.readUInt16BE(18), 0xffff, 'o endereço do cliente vai como IPv6 mapeado de IPv4');
  assert.deepEqual([...request.subarray(20, 24)], [192, 168, 0, 4]);
  assert.deepEqual(request.subarray(24, 36), nonce);
  assert.equal(request.readUInt8(36), 6);

  const response = Buffer.alloc(60);
  response.writeUInt8(2, 0);
  response.writeUInt8(0x81, 1);
  response.writeUInt8(0, 3);
  response.writeUInt32BE(1800, 4);
  nonce.copy(response, 24);
  response.writeUInt8(6, 36);
  response.writeUInt16BE(3927, 40);
  response.writeUInt16BE(52_100, 42);
  response.writeUInt16BE(0xffff, 54);
  Buffer.from([189, 40, 12, 7]).copy(response, 56);
  assert.deepEqual(nat.parsePcpMapResponse(response, nonce), {
    ok: true, resultCode: 0, lifetimeSeconds: 1800, internalPort: 3927, externalPort: 52_100, externalAddress: '189.40.12.7',
  });
  assert.equal(nat.parsePcpMapResponse(response, Buffer.alloc(12, 1)), null, 'resposta de outro pedido é ignorada');
});

test('o gateway sai da rota padrão, com os octetos na ordem certa', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    'wlan0\t00000000\t0100A8C0\t0003\t0\t0\t600\t00000000',
    'wlan0\t0000A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF',
  ].join('\n');
  assert.equal(nat.defaultGateway(() => table), '192.168.0.1');
  assert.equal(nat.defaultGateway(() => 'Iface\tDestination\tGateway\tFlags\n'), null);
  assert.equal(nat.defaultGateway(() => { throw new Error('sem /proc'); }), null);
});

test('a rota padrão sem bandeira de gateway não é usada como gateway', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags',
    'tun0\t00000000\t00000000\t0001',
    'wlan0\t00000000\t0100A8C0\t0003',
  ].join('\n');
  assert.equal(nat.defaultGateway(() => table), '192.168.0.1');
});

test('as interfaces locais separam ZeroTier e respeitam a preferência', () => {
  const networkInterfaces = () => ({
    wlan0: [{ address: '192.168.0.4', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: '' }],
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '', cidr: '' }],
    ztyorlqm7u: [{ address: '10.147.17.9', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '', cidr: '' }],
  });
  const isZeroTier = (name: string) => name.startsWith('zt');
  const withZeroTier = nat.localAddresses({ networkInterfaces, isZeroTier, allowZeroTier: true });
  assert.deepEqual(withZeroTier.map((entry) => entry.address), ['192.168.0.4', '10.147.17.9']);
  assert.equal(withZeroTier.find((entry) => entry.address === '10.147.17.9')?.zeroTier, true);
  const withoutZeroTier = nat.localAddresses({ networkInterfaces, isZeroTier, allowZeroTier: false });
  assert.deepEqual(withoutZeroTier.map((entry) => entry.address), ['192.168.0.4']);
});

class FakeStunSocket extends EventEmitter {
  sent: Array<{ host: string; port: number }> = [];
  closed = false;
  constructor(private readonly reply: (host: string, packet: Buffer) => Buffer | null) { super(); }
  bind(_options: unknown, callback: () => void): void { callback(); }
  send(packet: Buffer, port: number, host: string, callback?: (error?: Error) => void): void {
    this.sent.push({ host, port });
    callback?.();
    const response = this.reply(host, packet);
    if (response) setImmediate(() => this.emit('message', response));
  }
  close(): void { this.closed = true; }
}

test('duas respostas iguais indicam NAT atravessável; portas diferentes, NAT simétrico', async () => {
  const build = (portFor: (host: string) => number) => new FakeStunSocket((host, packet) => {
    const transactionId = packet.subarray(8, 20);
    return stunResponse(transactionId, xorMappedIpv4('189.40.12.7', portFor(host)));
  });

  const stable = build(() => 41_827);
  const cone = await nat.probeNatMapping({ createSocket: () => stable, servers: [{ host: 'a', port: 3478 }, { host: 'b', port: 3478 }] });
  assert.equal(cone.mapping, 'endpoint-independent');
  assert.equal(cone.results.length, 2);
  assert.equal(stable.closed, true);

  const shifting = build((host) => (host === 'a' ? 41_827 : 41_828));
  const symmetric = await nat.probeNatMapping({ createSocket: () => shifting, servers: [{ host: 'a', port: 3478 }, { host: 'b', port: 3478 }] });
  assert.equal(symmetric.mapping, 'symmetric');
});

test('sem resposta de STUN o comportamento do NAT fica como desconhecido', async () => {
  const silent = new FakeStunSocket(() => null);
  const result = await nat.probeNatMapping({ createSocket: () => silent, servers: [{ host: 'a', port: 3478 }], timeoutMs: 30 });
  assert.deepEqual(result, { mapping: 'unknown', results: [] });
});

test('a consulta STUN desiste no prazo em vez de ficar pendurada', async () => {
  const silent = new FakeStunSocket(() => null);
  assert.equal(await nat.stunQuery({ host: 'a', port: 3478 }, { socket: silent, timeoutMs: 20 }), null);
});

test('PCP responde com a porta externa e o endereço público atribuídos', async () => {
  const send = async (packet: Buffer) => {
    const nonce = packet.subarray(24, 36);
    const response = Buffer.alloc(60);
    response.writeUInt8(2, 0);
    response.writeUInt8(0x81, 1);
    response.writeUInt32BE(3600, 4);
    nonce.copy(response, 24);
    response.writeUInt8(6, 36);
    response.writeUInt16BE(3927, 40);
    response.writeUInt16BE(52_100, 42);
    response.writeUInt16BE(0xffff, 54);
    Buffer.from([189, 40, 12, 7]).copy(response, 56);
    return response;
  };
  const mapping = await nat.requestPcpMapping({ gateway: '192.168.0.1', clientAddress: '192.168.0.4', internalPort: 3927, send });
  assert.equal(mapping?.via, 'pcp');
  assert.equal(mapping?.externalPort, 52_100);
  assert.equal(mapping?.externalAddress, '189.40.12.7');
});

test('roteador mudo em PCP e NAT-PMP devolve nenhum mapeamento em vez de travar', async () => {
  const send = async () => null;
  assert.equal(await nat.requestPcpMapping({ gateway: '192.168.0.1', clientAddress: '192.168.0.4', internalPort: 3927, send }), null);
  assert.equal(await nat.requestNatPmpMapping({ gateway: '192.168.0.1', internalPort: 3927, send }), null);
  assert.equal(await nat.requestPcpMapping({ gateway: null, clientAddress: '192.168.0.4', internalPort: 3927, send }), null);
});

test('devolver a porta ao roteador usa tempo de vida zero nos dois protocolos', async () => {
  const sent: Buffer[] = [];
  const send = async (packet: Buffer) => { sent.push(packet); return null; };
  await nat.releasePortMapping({ via: 'nat-pmp', gateway: '192.168.0.1', protocol: 'tcp', internalPort: 3927 }, { send });
  assert.equal(sent[0].readUInt32BE(8), 0);
  assert.equal(sent[0].readUInt16BE(6), 0);

  sent.length = 0;
  await nat.releasePortMapping({ via: 'pcp', gateway: '192.168.0.1', protocol: 'tcp', internalPort: 3927, nonce: Buffer.alloc(12, 2), clientAddress: '192.168.0.4' }, { send });
  assert.equal(sent[0].readUInt32BE(4), 0);
  assert.equal(sent[0].readUInt16BE(42), 0);

  assert.equal(await nat.releasePortMapping({ via: 'upnp', internalPort: 3927 }, { send }), false);
  assert.equal(await nat.releasePortMapping(null as unknown as Record<string, unknown>, { send }), false);
});
