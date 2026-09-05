// UPnP-IGD: a terceira tentativa de abrir porta no roteador.
//
// PCP e NAT-PMP são binários, curtos e previsíveis; quando existem, funcionam.
// O problema é que boa parte dos roteadores domésticos vendidos por aqui só
// fala UPnP, que é SSDP para achar o aparelho, HTTP para ler a descrição e
// SOAP para pedir a porta. É verboso, mas é o que abre a porta na casa da
// maioria das pessoas — por isso ele entra, e entra por último.

const dgram = require('node:dgram');
const http = require('node:http');
const { URL } = require('node:url');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const CONNECTION_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function buildSearchRequest(target, waitSeconds = 2) {
  return Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${waitSeconds}`,
    `ST: ${target}`,
    '',
    '',
  ].join('\r\n'));
}

function parseSsdpLocation(text) {
  const match = /^location:\s*(\S+)\s*$/im.exec(String(text));
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character]);
}

function decodeXml(value) {
  return String(value).replace(/&(lt|gt|amp|apos|quot|#\d+);/g, (entity, name) => {
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'amp') return '&';
    if (name === 'apos') return "'";
    if (name === 'quot') return '"';
    return String.fromCharCode(Number(name.slice(1)));
  });
}

// A descrição do aparelho é XML com namespaces variados e um serviço por bloco
// `<service>`. Ler bloco a bloco com expressão regular é feio, mas evita uma
// dependência de parser inteira para extrair dois campos.
function parseServiceControlUrl(xml, locationUrl) {
  const text = String(xml);
  const blocks = text.match(/<service\b[\s\S]*?<\/service>/gi) ?? [];
  const services = blocks.map((block) => ({
    type: decodeXml(/<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1] ?? ''),
    controlUrl: decodeXml(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1] ?? ''),
  })).filter((service) => service.type && service.controlUrl);
  for (const wanted of CONNECTION_SERVICES) {
    const service = services.find((candidate) => candidate.type.toLowerCase() === wanted.toLowerCase());
    if (!service) continue;
    try {
      return { serviceType: service.type, controlUrl: new URL(service.controlUrl, locationUrl).href };
    } catch {
      return null;
    }
  }
  return null;
}

function buildSoapEnvelope(serviceType, action, args) {
  const body = Object.entries(args).map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join('');
  return `<?xml version="1.0"?>`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;
}

function parseSoapValue(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>\\s*([^<]*?)\\s*</${tag}>`, 'i').exec(String(xml));
  return match ? decodeXml(match[1]) : null;
}

function parseSoapError(xml) {
  const code = parseSoapValue(xml, 'errorCode');
  return code ? Number(code) : null;
}

function httpRequest(url, options = {}, body = '') {
  const { timeoutMs = 2500, headers = {}, method = 'GET' } = options;
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve(null);
    }
    if (target.protocol !== 'http:') return resolve(null);
    const request = http.request(target, { method, headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        // A descrição de um roteador cabe em poucos kB. Um aparelho que
        // responde megabytes é um aparelho em que não vamos confiar.
        if (size > 256 * 1024) return request.destroy();
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    if (body) request.write(body);
    request.end();
  });
}

function searchGateway(options = {}) {
  const { createSocket = dgram.createSocket, timeoutMs = 2200, targets = SEARCH_TARGETS } = options;
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
    socket.on('error', () => finish(null));
    socket.on('message', (buffer) => {
      const location = parseSsdpLocation(buffer.toString('utf8'));
      if (location) finish(location);
    });
    try {
      socket.bind(0, () => {
        try { socket.setBroadcast(true); } catch { /* nem todo sistema permite */ }
        for (const target of targets) {
          socket.send(buildSearchRequest(target), SSDP_PORT, SSDP_ADDRESS, (error) => { if (error && !settled) { /* uma busca falha não encerra as outras */ } });
        }
      });
    } catch {
      finish(null);
    }
  });
}

async function describeGateway(options = {}) {
  const { search = searchGateway, request = httpRequest, timeoutMs = 2500 } = options;
  const location = await search(options);
  if (!location) return null;
  const description = await request(location, { timeoutMs });
  if (!description || description.status !== 200) return null;
  const service = parseServiceControlUrl(description.body, location);
  return service ? { ...service, location } : null;
}

async function callAction(service, action, args, options = {}) {
  const { request = httpRequest, timeoutMs = 2500 } = options;
  const body = buildSoapEnvelope(service.serviceType, action, args);
  const response = await request(service.controlUrl, {
    method: 'POST',
    timeoutMs,
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      'content-length': Buffer.byteLength(body),
      soapaction: `"${service.serviceType}#${action}"`,
      connection: 'close',
    },
  }, body);
  if (!response) return { ok: false, error: 'sem-resposta' };
  if (response.status !== 200) return { ok: false, error: `http-${response.status}`, code: parseSoapError(response.body), body: response.body };
  return { ok: true, body: response.body };
}

async function addPortMapping(options) {
  const { service, internalPort, externalPort = internalPort, clientAddress, protocol = 'TCP', description = 'Tumacord', lifetimeSeconds = 3600 } = options;
  if (!service || !clientAddress) return null;
  const args = (lease) => ({
    NewRemoteHost: '',
    NewExternalPort: externalPort,
    NewProtocol: protocol.toUpperCase(),
    NewInternalPort: internalPort,
    NewInternalClient: clientAddress,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: lease,
  });
  let result = await callAction(service, 'AddPortMapping', args(lifetimeSeconds), options);
  // Erro 725 é "OnlyPermanentLeasesSupported". Vários roteadores domésticos
  // respondem assim e aceitam a mesma regra com prazo indefinido; nesse caso a
  // remoção no encerramento deixa de ser cortesia e vira obrigação.
  if (!result.ok && result.code === 725) result = await callAction(service, 'AddPortMapping', args(0), options);
  if (!result.ok) return null;
  const external = await callAction(service, 'GetExternalIPAddress', {}, options);
  return {
    via: 'upnp',
    protocol: protocol.toLowerCase(),
    internalPort,
    externalPort,
    clientAddress,
    service,
    lifetimeSeconds,
    externalAddress: external.ok ? parseSoapValue(external.body, 'NewExternalIPAddress') ?? undefined : undefined,
  };
}

async function deletePortMapping(mapping, options = {}) {
  if (!mapping?.service) return false;
  const result = await callAction(mapping.service, 'DeletePortMapping', {
    NewRemoteHost: '',
    NewExternalPort: mapping.externalPort,
    NewProtocol: String(mapping.protocol).toUpperCase(),
  }, options);
  return result.ok;
}

module.exports = {
  CONNECTION_SERVICES,
  SEARCH_TARGETS,
  SSDP_ADDRESS,
  SSDP_PORT,
  addPortMapping,
  buildSearchRequest,
  buildSoapEnvelope,
  callAction,
  deletePortMapping,
  describeGateway,
  httpRequest,
  parseServiceControlUrl,
  parseSoapError,
  parseSoapValue,
  parseSsdpLocation,
  searchGateway,
};
