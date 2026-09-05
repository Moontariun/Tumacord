import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DirectLink, classifyIpv4, isGlobalIpv6, isZeroTierInterface, stunServersFrom } = require('../desktop/direct-link.cjs') as {
  DirectLink: new (options: Record<string, unknown>) => {
    key: string;
    mapping: Record<string, unknown> | null;
    probe: (options?: { force?: boolean }) => Promise<Record<string, unknown>>;
    setPreferences: (patch: Record<string, unknown>) => Record<string, unknown>;
    releaseMapping: () => Promise<boolean>;
    close: () => Promise<void>;
    emptyReport: () => Record<string, unknown>;
  };
  classifyIpv4: (address: string) => string | null;
  isGlobalIpv6: (address: string) => boolean;
  isZeroTierInterface: (name: string, address?: string) => boolean;
  stunServersFrom: (urls: string[]) => Array<{ host: string; port: number }>;
};

const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

function stunReply(transactionId: Buffer, address: string, port: number): Buffer {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(port ^ 0x2112, 2);
  address.split('.').forEach((octet, index) => value.writeUInt8(Number(octet) ^ COOKIE[index], 4 + index));
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0);
  header.writeUInt16BE(12, 2);
  COOKIE.copy(header, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, Buffer.from([0x00, 0x20, 0x00, 0x08]), value]);
}

class FakeStunSocket extends EventEmitter {
  constructor(private readonly publicAddress: string | null) { super(); }
  bind(_options: unknown, callback: () => void): void { callback(); }
  send(packet: Buffer, _port: number, _host: string, callback?: (error?: Error) => void): void {
    callback?.();
    if (!this.publicAddress) return;
    setImmediate(() => this.emit('message', stunReply(packet.subarray(8, 20), this.publicAddress as string, 41_827)));
  }
  close(): void {}
}

function interfacesOf(entries: Record<string, Array<{ address: string; family: string }>>) {
  return () => Object.fromEntries(Object.entries(entries).map(([name, list]) => [
    name,
    list.map((entry) => ({ ...entry, netmask: entry.family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::', internal: false, mac: '', cidr: '' })),
  ]));
}

const silentRouter = async () => null;

test('endereço 100.64/10 é CGNAT e 2000::/3 é o único IPv6 de entrada', () => {
  assert.equal(classifyIpv4('100.90.1.2'), 'cgnat');
  assert.equal(classifyIpv4('192.168.1.2'), 'private');
  assert.equal(isGlobalIpv6('2804:14d:1::a'), true);
  assert.equal(isGlobalIpv6('fe80::1%wlan0'), false);
  assert.equal(isGlobalIpv6('fd12::1'), false);
  assert.equal(isGlobalIpv6('::1'), false);
  assert.equal(isGlobalIpv6('192.168.0.1'), false);
  assert.equal(isZeroTierInterface('ztabc12345'), true);
  assert.equal(isZeroTierInterface('eth0', '10.147.1.1'), true);
});

test('a lista de STUN aceita URL com e sem esquema e volta ao padrão quando vazia', () => {
  assert.deepEqual(stunServersFrom(['stun:stun.exemplo:3478', 'outro.exemplo']), [
    { host: 'stun.exemplo', port: 3478 },
    { host: 'outro.exemplo', port: 3478 },
  ]);
  assert.ok(stunServersFrom([]).length >= 3);
  assert.ok(stunServersFrom(['   ']).length >= 3);
});

test('CGNAT com IPv6 vira caminho por IPv6, e o PCP ainda é tentado', async () => {
  let mappingAttempts = 0;
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: true, stunEnabled: true, stunServers: [] },
    networkInterfaces: interfacesOf({
      wlan0: [{ address: '100.90.1.2', family: 'IPv4' }, { address: '2804:14d:1::a', family: 'IPv6' }],
    }),
    createSocket: () => new FakeStunSocket('189.40.12.7'),
    readRouteTable: () => 'Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0100A8C0\t0003\n',
    send: async () => { mappingAttempts += 1; return null; },
    describeGateway: async () => null,
  });
  const report = await link.probe();
  assert.equal(report.grade, 'ipv6');
  assert.equal(report.cgnat, true);
  assert.equal(report.ipv6, true);
  assert.equal(report.natMapping, 'endpoint-independent');
  assert.equal(report.publicIpv4, '189.40.12.7');
  assert.deepEqual((report.paths as Array<{ kind: string; host: string }>).map((path) => `${path.kind}:${path.host}`), ['lan:100.90.1.2', 'ipv6:2804:14d:1::a']);
  assert.ok(mappingAttempts > 0, 'PCP ainda é tentado: uma operadora que fale PCP consegue abrir porta mesmo em CGNAT');
  await link.close();
});

test('IPv4 público na interface dispensa mapeamento e dá a nota máxima', async () => {
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: true, stunEnabled: true, stunServers: [] },
    networkInterfaces: interfacesOf({ eth0: [{ address: '189.40.12.7', family: 'IPv4' }] }),
    createSocket: () => new FakeStunSocket('189.40.12.7'),
    readRouteTable: () => '',
    send: silentRouter,
    describeGateway: async () => null,
  });
  const report = await link.probe();
  assert.equal(report.grade, 'open');
  assert.equal(report.cgnat, false);
  assert.equal(report.score, 100);
  assert.deepEqual((report.paths as Array<{ kind: string }>).map((path) => path.kind), ['lan', 'ipv4']);
  await link.close();
});

test('IPv4 público que o STUN contradiz é tratado como CGNAT, não como porta aberta', async () => {
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: false, stunEnabled: true, stunServers: [] },
    networkInterfaces: interfacesOf({ eth0: [{ address: '189.40.12.7', family: 'IPv4' }] }),
    createSocket: () => new FakeStunSocket('200.1.2.3'),
    readRouteTable: () => '',
    send: silentRouter,
  });
  const report = await link.probe();
  assert.equal(report.cgnat, true);
  assert.equal(report.grade, 'lan');
  await link.close();
});

test('rede privada com PCP disponível vira caminho IPv4 mapeado', async () => {
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: true, stunEnabled: false, stunServers: [] },
    networkInterfaces: interfacesOf({ wlan0: [{ address: '192.168.0.4', family: 'IPv4' }] }),
    readRouteTable: () => 'Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0100A8C0\t0003\n',
    send: async (packet: Buffer) => {
      if (packet.length !== 60) return null;
      const response = Buffer.alloc(60);
      response.writeUInt8(2, 0);
      response.writeUInt8(0x81, 1);
      response.writeUInt32BE(3600, 4);
      packet.subarray(24, 36).copy(response, 24);
      response.writeUInt8(6, 36);
      response.writeUInt16BE(3927, 40);
      response.writeUInt16BE(52_100, 42);
      response.writeUInt16BE(0xffff, 54);
      Buffer.from([189, 40, 12, 7]).copy(response, 56);
      return response;
    },
  });
  const report = await link.probe();
  assert.equal(report.grade, 'mapped');
  assert.equal(report.mappedPort, 52_100);
  assert.equal(report.mappedVia, 'pcp');
  assert.deepEqual((report.paths as Array<{ kind: string; host: string; port: number }>).at(-1), { kind: 'ipv4', host: '189.40.12.7', port: 52_100, via: 'pcp' });
  await link.close();
});

test('sem PCP nem NAT-PMP, o UPnP é a última tentativa', async () => {
  let described = 0;
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: true, stunEnabled: false, stunServers: [] },
    networkInterfaces: interfacesOf({ wlan0: [{ address: '192.168.0.4', family: 'IPv4' }] }),
    readRouteTable: () => 'Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0100A8C0\t0003\n',
    send: silentRouter,
    describeGateway: async () => { described += 1; return { serviceType: 'urn:x:1', controlUrl: 'http://192.168.0.1/ctl' }; },
    addPortMapping: async () => ({ via: 'upnp', protocol: 'tcp', internalPort: 3927, externalPort: 3927, externalAddress: '189.40.12.7', lifetimeSeconds: 3600, clientAddress: '192.168.0.4' }),
    deletePortMapping: async () => true,
  });
  const report = await link.probe();
  assert.equal(described, 1);
  assert.equal(report.grade, 'mapped');
  assert.equal(report.mappedVia, 'upnp');
  await link.close();
});

test('desligar o mapeamento fecha a porta que já estava aberta', async () => {
  let deleted = 0;
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: true, stunEnabled: false, stunServers: [] },
    networkInterfaces: interfacesOf({ wlan0: [{ address: '192.168.0.4', family: 'IPv4' }] }),
    readRouteTable: () => 'Iface\tDestination\tGateway \tFlags\nwlan0\t00000000\t0100A8C0\t0003\n',
    send: silentRouter,
    describeGateway: async () => ({ serviceType: 'urn:x:1', controlUrl: 'http://192.168.0.1/ctl' }),
    addPortMapping: async () => ({ via: 'upnp', protocol: 'tcp', internalPort: 3927, externalPort: 3927, externalAddress: '189.40.12.7', lifetimeSeconds: 3600, clientAddress: '192.168.0.4' }),
    deletePortMapping: async () => { deleted += 1; return true; },
  });
  await link.probe();
  assert.notEqual(link.mapping, null);
  link.setPreferences({ portMapping: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleted, 1);
  assert.equal(link.mapping, null);
  await link.close();
});

test('a interface do ZeroTier só entra nos caminhos quando a preferência permite', async () => {
  const options = {
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: false, stunEnabled: false, stunServers: [] },
    networkInterfaces: interfacesOf({ ztyorlqm7u: [{ address: '10.147.17.9', family: 'IPv4' }] }),
    readRouteTable: () => '',
    send: silentRouter,
  };
  const off = new DirectLink(options);
  const offReport = await off.probe();
  assert.equal(offReport.grade, 'blocked');
  assert.deepEqual(offReport.paths, []);
  assert.deepEqual(offReport.zeroTier, ['10.147.17.9'], 'a interface continua sendo listada para a interface poder explicar a situação');
  await off.close();

  const on = new DirectLink({ ...options, preferences: { ...options.preferences, zeroTierEnabled: true } });
  const onReport = await on.probe();
  assert.equal(onReport.grade, 'lan');
  assert.deepEqual((onReport.paths as Array<{ host: string }>).map((path) => path.host), ['10.147.17.9']);
  await on.close();
});

test('o relatório fica em cache e só refaz a sondagem quando forçado', async () => {
  let probes = 0;
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: false, stunEnabled: false, stunServers: [] },
    networkInterfaces: () => { probes += 1; return interfacesOf({ wlan0: [{ address: '192.168.0.4', family: 'IPv4' }] })(); },
    readRouteTable: () => '',
    send: silentRouter,
  });
  await link.probe();
  const afterFirst = probes;
  await link.probe();
  assert.equal(probes, afterFirst, 'a segunda leitura vem do cache');
  await link.probe({ force: true });
  assert.ok(probes > afterFirst);
  await link.close();
});

test('trocar a preferência de ZeroTier ou STUN invalida o cache', async () => {
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: false, stunEnabled: false, stunServers: [] },
    networkInterfaces: interfacesOf({ ztabc: [{ address: '10.147.17.9', family: 'IPv4' }] }),
    readRouteTable: () => '',
    send: silentRouter,
  });
  assert.equal((await link.probe()).grade, 'blocked');
  link.setPreferences({ zeroTierEnabled: true });
  assert.equal((await link.probe()).grade, 'lan');
  await link.close();
});

test('depois de fechado, a sondagem devolve o relatório vazio em vez de tocar na rede', async () => {
  const link = new DirectLink({
    key: 'chave-de-teste-com-tamanho-suficiente',
    preferences: { zeroTierEnabled: false, portMapping: false, stunEnabled: false, stunServers: [] },
    networkInterfaces: interfacesOf({ wlan0: [{ address: '192.168.0.4', family: 'IPv4' }] }),
    readRouteTable: () => '',
    send: silentRouter,
  });
  await link.close();
  await link.close();
  const report = await link.probe();
  assert.equal(report.grade, 'blocked');
  assert.deepEqual(report.paths, []);
});
