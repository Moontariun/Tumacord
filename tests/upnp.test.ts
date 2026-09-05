import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const upnp = require('../desktop/upnp.cjs') as {
  buildSearchRequest: (target: string, waitSeconds?: number) => Buffer;
  parseSsdpLocation: (text: string) => string | null;
  parseServiceControlUrl: (xml: string, location: string) => { serviceType: string; controlUrl: string } | null;
  buildSoapEnvelope: (serviceType: string, action: string, args: Record<string, unknown>) => string;
  parseSoapValue: (xml: string, tag: string) => string | null;
  parseSoapError: (xml: string) => number | null;
  describeGateway: (options: Record<string, unknown>) => Promise<{ serviceType: string; controlUrl: string } | null>;
  addPortMapping: (options: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  deletePortMapping: (mapping: Record<string, unknown>, options?: Record<string, unknown>) => Promise<boolean>;
};

const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
  <serviceList>
    <service>
      <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
      <controlURL>/ctl/L3F</controlURL>
    </service>
  </serviceList>
  <deviceList><device><deviceList><device><serviceList>
    <service>
      <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
      <controlURL>/ctl/IPConn</controlURL>
    </service>
  </serviceList></device></deviceList></device></deviceList>
</device></root>`;

test('a busca SSDP pede o alvo certo no cabeçalho', () => {
  const request = upnp.buildSearchRequest('urn:schemas-upnp-org:device:InternetGatewayDevice:1').toString('utf8');
  assert.match(request, /^M-SEARCH \* HTTP\/1\.1\r\n/);
  assert.match(request, /HOST: 239\.255\.255\.250:1900\r\n/);
  assert.match(request, /MAN: "ssdp:discover"\r\n/);
  assert.match(request, /ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n/);
  assert.ok(request.endsWith('\r\n\r\n'));
});

test('o LOCATION é lido sem depender da caixa do cabeçalho, e só em HTTP', () => {
  assert.equal(upnp.parseSsdpLocation('HTTP/1.1 200 OK\r\nlocation: http://192.168.0.1:5000/rootDesc.xml\r\n\r\n'), 'http://192.168.0.1:5000/rootDesc.xml');
  assert.equal(upnp.parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.0.1:5000/x.xml\r\n'), 'http://192.168.0.1:5000/x.xml');
  assert.equal(upnp.parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: file:///etc/passwd\r\n'), null);
  assert.equal(upnp.parseSsdpLocation('HTTP/1.1 200 OK\r\n\r\n'), null);
});

test('o serviço de conexão é achado no aninhamento e vira URL absoluta', () => {
  assert.deepEqual(upnp.parseServiceControlUrl(DESCRIPTION, 'http://192.168.0.1:5000/rootDesc.xml'), {
    serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    controlUrl: 'http://192.168.0.1:5000/ctl/IPConn',
  });
  assert.equal(upnp.parseServiceControlUrl('<root></root>', 'http://192.168.0.1:5000/rootDesc.xml'), null);
});

test('a versão 2 do serviço tem preferência sobre a 1', () => {
  const xml = `<root>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/v1</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>/v2</controlURL></service>
  </root>`;
  assert.equal(upnp.parseServiceControlUrl(xml, 'http://192.168.0.1/d.xml')?.controlUrl, 'http://192.168.0.1/v2');
});

test('o envelope SOAP escapa o conteúdo dos argumentos', () => {
  const envelope = upnp.buildSoapEnvelope('urn:x:1', 'AddPortMapping', { NewPortMappingDescription: 'Tuma<&>cord', NewExternalPort: 3927 });
  assert.match(envelope, /<u:AddPortMapping xmlns:u="urn:x:1">/);
  assert.match(envelope, /<NewPortMappingDescription>Tuma&lt;&amp;&gt;cord<\/NewPortMappingDescription>/);
  assert.match(envelope, /<NewExternalPort>3927<\/NewExternalPort>/);
});

test('valores e códigos de erro são extraídos da resposta SOAP', () => {
  assert.equal(upnp.parseSoapValue('<NewExternalIPAddress>189.40.12.7</NewExternalIPAddress>', 'NewExternalIPAddress'), '189.40.12.7');
  assert.equal(upnp.parseSoapValue('<a:NewExternalIPAddress xmlns:a="x">10.0.0.1</a:NewExternalIPAddress>', 'NewExternalIPAddress'), null);
  assert.equal(upnp.parseSoapError('<UPnPError><errorCode>725</errorCode></UPnPError>'), 725);
  assert.equal(upnp.parseSoapError('<s:Body/>'), null);
});

test('a descrição do roteador só é aceita com HTTP 200', async () => {
  const search = async () => 'http://192.168.0.1:5000/rootDesc.xml';
  assert.equal(await upnp.describeGateway({ search, request: async () => ({ status: 404, body: '' }) }), null);
  assert.equal(await upnp.describeGateway({ search: async () => null, request: async () => ({ status: 200, body: DESCRIPTION }) }), null);
  const service = await upnp.describeGateway({ search, request: async () => ({ status: 200, body: DESCRIPTION }) });
  assert.equal(service?.controlUrl, 'http://192.168.0.1:5000/ctl/IPConn');
});

test('erro 725 faz o pedido ser repetido com prazo indefinido', async () => {
  const calls: string[] = [];
  const request = async (_url: string, _options: unknown, body: string) => {
    const action = /<u:(\w+)/.exec(body)?.[1] ?? '';
    calls.push(`${action}:${/<NewLeaseDuration>(\d+)</.exec(body)?.[1] ?? '-'}`);
    if (action === 'AddPortMapping' && !body.includes('<NewLeaseDuration>0</NewLeaseDuration>')) {
      return { status: 500, body: '<UPnPError><errorCode>725</errorCode></UPnPError>' };
    }
    if (action === 'GetExternalIPAddress') return { status: 200, body: '<NewExternalIPAddress>189.40.12.7</NewExternalIPAddress>' };
    return { status: 200, body: '<ok/>' };
  };
  const mapping = await upnp.addPortMapping({
    service: { serviceType: 'urn:x:1', controlUrl: 'http://192.168.0.1/ctl' },
    internalPort: 3927,
    clientAddress: '192.168.0.4',
    request,
  });
  assert.deepEqual(calls, ['AddPortMapping:3600', 'AddPortMapping:0', 'GetExternalIPAddress:-']);
  assert.equal(mapping?.via, 'upnp');
  assert.equal(mapping?.externalPort, 3927);
  assert.equal(mapping?.externalAddress, '189.40.12.7');
});

test('erro que não é 725 encerra a tentativa sem abrir porta nenhuma', async () => {
  const request = async () => ({ status: 500, body: '<UPnPError><errorCode>718</errorCode></UPnPError>' });
  assert.equal(await upnp.addPortMapping({
    service: { serviceType: 'urn:x:1', controlUrl: 'http://192.168.0.1/ctl' },
    internalPort: 3927,
    clientAddress: '192.168.0.4',
    request,
  }), null);
  assert.equal(await upnp.addPortMapping({ service: null, internalPort: 3927, clientAddress: '192.168.0.4', request }), null);
});

test('remover o mapeamento envia DeletePortMapping para o mesmo serviço', async () => {
  const bodies: string[] = [];
  const request = async (_url: string, _options: unknown, body: string) => { bodies.push(body); return { status: 200, body: '<ok/>' }; };
  const removed = await upnp.deletePortMapping({ service: { serviceType: 'urn:x:1', controlUrl: 'http://192.168.0.1/ctl' }, externalPort: 3927, protocol: 'tcp' }, { request });
  assert.equal(removed, true);
  assert.match(bodies[0], /<u:DeletePortMapping/);
  assert.match(bodies[0], /<NewProtocol>TCP<\/NewProtocol>/);
  assert.equal(await upnp.deletePortMapping({ externalPort: 3927 }, { request }), false);
});
