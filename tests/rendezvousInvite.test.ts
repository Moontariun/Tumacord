import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildInvite, forgetCachedInvite, readInvite, resolveInvite, type DirectReport } from '../src/lib/directLink';
import { decodeInvite, encodeInvite, normalizeRendezvousUrl } from '../shared/directLink';

const call = { callId: 'call-geral', callName: 'Call do grupo', hostUsername: 'Moontariun' };
const KEY = 'chave-de-acesso-do-servidor-de-encontro';

const directReport: DirectReport = {
  grade: 'ipv6',
  score: 60,
  paths: [{ kind: 'ipv6', host: '2804:14d:1::a', port: 3927, via: 'interface' }],
  ipv6: true,
  cgnat: true,
  natMapping: 'endpoint-independent',
  key: 'chave-do-enlace-direto-com-tamanho',
  port: 3927,
  checkedAt: 0,
  zeroTier: [],
};

test('a URL do servidor de encontro é validada antes de virar destino de login', () => {
  assert.equal(normalizeRendezvousUrl('https://call.exemplo.com'), 'https://call.exemplo.com');
  assert.equal(normalizeRendezvousUrl('https://call.exemplo.com/'), 'https://call.exemplo.com');
  assert.equal(normalizeRendezvousUrl('http://192.168.0.9:4600'), 'http://192.168.0.9:4600');
  assert.equal(normalizeRendezvousUrl('ftp://call.exemplo.com'), undefined);
  assert.equal(normalizeRendezvousUrl('javascript:alert(1)'), undefined);
  assert.equal(normalizeRendezvousUrl('https://usuario:senha@call.exemplo.com'), undefined, 'credencial embutida na URL não passa');
  assert.equal(normalizeRendezvousUrl(''), undefined);
  assert.equal(normalizeRendezvousUrl(42), undefined);
});

// A promessa da arquitetura: o convite identifica a call e prova o direito de
// entrar, sem carregar endereço de máquina nenhuma.
test('o convite de encontro não leva endereço de máquina', () => {
  forgetCachedInvite();
  const code = buildInvite(directReport, { ...call, server: 'https://call.exemplo.com', key: KEY }, 1_757_000_000_000);
  assert.ok(code);
  const decoded = decodeInvite(code);
  assert.equal(decoded?.server, 'https://call.exemplo.com');
  assert.deepEqual(decoded?.paths, [], 'nenhum IP do host viaja no código');
  assert.equal(decoded?.key, KEY);
  assert.equal(decoded?.callId, 'call-geral');
});

test('sem servidor, o convite continua sendo o do enlace direto', () => {
  forgetCachedInvite();
  const code = buildInvite(directReport, call, 1_757_000_000_000);
  const decoded = decodeInvite(code!);
  assert.equal(decoded?.server, undefined);
  assert.equal(decoded?.paths.length, 1);
});

test('um convite de encontro dispensa até o relatório de alcance', () => {
  forgetCachedInvite();
  const code = buildInvite(null, { ...call, server: 'https://call.exemplo.com', key: KEY }, 1_757_000_000_000);
  assert.ok(code, 'quem está no servidor não precisa sondar a própria rede para convidar');
  assert.equal(decodeInvite(code)?.server, 'https://call.exemplo.com');
});

test('sem chave não sai convite de encontro nenhum', () => {
  forgetCachedInvite();
  assert.equal(buildInvite(null, { ...call, server: 'https://call.exemplo.com' }, 1), null);
});

test('um convite sem caminho e sem servidor é recusado na leitura', () => {
  const vazio = encodeInvite({ version: 1, callId: 'c', callName: 'n', hostUsername: 'h', key: KEY, paths: [], issuedAt: 1, ttlMs: 1_000_000 });
  assert.equal(decodeInvite(vazio), null);
});

test('servidor com esquema inválido é ignorado na leitura, não aceito como destino', () => {
  const code = encodeInvite({ version: 1, callId: 'c', callName: 'n', hostUsername: 'h', key: KEY, paths: [], server: 'ftp://mau.exemplo', issuedAt: 1, ttlMs: 1_000_000 });
  assert.equal(decodeInvite(code), null, 'sem caminho e com servidor inválido não sobra forma de entrar');
});

function helloServer(expectedUrl: string, key: string | null): typeof fetch {
  return (async (input: string) => {
    const url = new URL(String(input));
    if (`${url.protocol}//${url.host}` !== expectedUrl) return { ok: false, json: async () => ({}) };
    const nonce = url.searchParams.get('nonce') ?? '';
    if (!key) return { ok: true, json: async () => ({ ok: true, requiresKey: false, proofs: [] }) };
    return {
      ok: true,
      json: async () => ({ ok: true, requiresKey: true, proofs: [createHmac('sha256', key).update(nonce, 'utf8').digest('base64url')] }),
    };
  }) as unknown as typeof fetch;
}

test('entrar por convite de encontro usa o modo servidor, sem corrida de caminhos', async () => {
  forgetCachedInvite();
  const code = buildInvite(null, { ...call, server: 'https://call.exemplo.com', key: KEY }, Date.now());
  const resolved = await resolveInvite(code!, { fetchImpl: helloServer('https://call.exemplo.com', KEY) });
  assert.equal(resolved?.mode, 'server');
  assert.equal(resolved?.url, 'https://call.exemplo.com');
  assert.equal(resolved?.path, undefined);
  assert.equal(resolved?.invite.key, KEY);
});

test('servidor de encontro fora do ar devolve nada, em vez de tentar o host', async () => {
  forgetCachedInvite();
  const code = buildInvite(null, { ...call, server: 'https://call.exemplo.com', key: KEY }, Date.now());
  const mudo = (async () => { throw new Error('sem rede'); }) as unknown as typeof fetch;
  assert.equal(await resolveInvite(code!, { fetchImpl: mudo }), null);
});

test('um servidor que não conhece a chave do convite é recusado', async () => {
  forgetCachedInvite();
  const code = buildInvite(null, { ...call, server: 'https://call.exemplo.com', key: KEY }, Date.now());
  const impostor = helloServer('https://call.exemplo.com', 'outra-chave-qualquer-suficientemente-longa');
  assert.equal(await resolveInvite(code!, { fetchImpl: impostor }), null, 'a prova HMAC impede entrar em um endereço que trocou de dono');
});

test('convite direto continua resolvendo em modo P2P', async () => {
  forgetCachedInvite();
  const code = buildInvite(directReport, call, Date.now());
  const resolved = await resolveInvite(code!, { fetchImpl: helloServer('http://[2804:14d:1::a]:3927', directReport.key), staggerMs: 0 });
  assert.equal(resolved?.mode, 'p2p');
  assert.equal(resolved?.path?.kind, 'ipv6');
});

test('o convite de encontro também é estável entre leituras', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const primeiro = buildInvite(null, { ...call, server: 'https://call.exemplo.com', key: KEY }, inicio);
  for (const passo of [1_000, 60_000, 10 * 60_000]) {
    assert.equal(buildInvite(null, { ...call, server: 'https://call.exemplo.com', key: KEY }, inicio + passo), primeiro);
  }
  assert.notEqual(buildInvite(null, { ...call, server: 'https://outro.exemplo.com', key: KEY }, inicio), primeiro);
});

test('convite de encontro vencido não é lido', () => {
  const code = encodeInvite({ version: 1, callId: 'c', callName: 'n', hostUsername: 'h', key: KEY, paths: [], server: 'https://call.exemplo.com', issuedAt: 1_000, ttlMs: 1_000 });
  assert.equal(readInvite(code), null);
});
