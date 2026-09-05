import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildInvite, forgetCachedInvite, readInvite, resolveInvite } from '../src/lib/directLink';
import { decodeInvite, encodeInvite, normalizeRendezvousUrl } from '../shared/directLink';

const call = { callId: 'call-geral', callName: 'Call do grupo', hostUsername: 'Moontariun' };
const KEY = 'chave-de-acesso-do-servidor-de-encontro';

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
  const code = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, 1_757_000_000_000);
  assert.ok(code);
  const decoded = decodeInvite(code);
  assert.equal(decoded?.server, 'https://call.exemplo.com');
  assert.equal(decoded?.server, 'https://call.exemplo.com');
  assert.equal(decoded?.key, KEY);
  assert.equal(decoded?.callId, 'call-geral');
});

test('um convite de encontro é a call, o servidor e a chave', () => {
  forgetCachedInvite();
  const code = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, 1_757_000_000_000);
  assert.ok(code, 'quem está no servidor não precisa sondar a própria rede para convidar');
  assert.equal(decodeInvite(code)?.server, 'https://call.exemplo.com');
});

test('sem chave não sai convite de encontro nenhum', () => {
  forgetCachedInvite();
  assert.equal(buildInvite({ ...call, server: 'https://call.exemplo.com' }, 1), null);
});

test('um convite sem servidor é recusado na leitura', () => {
  const vazio = encodeInvite({ version: 1, callId: 'c', callName: 'n', hostUsername: 'h', key: KEY, issuedAt: 1, ttlMs: 1_000_000 });
  assert.equal(decodeInvite(vazio), null);
});

test('servidor com esquema inválido é ignorado na leitura, não aceito como destino', () => {
  const code = encodeInvite({ version: 1, callId: 'c', callName: 'n', hostUsername: 'h', key: KEY, server: 'ftp://mau.exemplo', issuedAt: 1, ttlMs: 1_000_000 });
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

test('entrar por convite usa sempre o modo servidor', async () => {
  forgetCachedInvite();
  const code = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, Date.now());
  const resolved = await resolveInvite(code!, { fetchImpl: helloServer('https://call.exemplo.com', KEY) });
  assert.equal(resolved?.mode, 'server');
  assert.equal(resolved?.url, 'https://call.exemplo.com');
  assert.equal(resolved?.path, undefined);
  assert.equal(resolved?.invite.key, KEY);
});

test('servidor de encontro fora do ar devolve nada, em vez de tentar o host', async () => {
  forgetCachedInvite();
  const code = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, Date.now());
  const mudo = (async () => { throw new Error('sem rede'); }) as unknown as typeof fetch;
  assert.equal(await resolveInvite(code!, { fetchImpl: mudo }), null);
});

test('um servidor que não conhece a chave do convite é recusado', async () => {
  forgetCachedInvite();
  const code = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, Date.now());
  const impostor = helloServer('https://call.exemplo.com', 'outra-chave-qualquer-suficientemente-longa');
  assert.equal(await resolveInvite(code!, { fetchImpl: impostor }), null, 'a prova HMAC impede entrar em um endereço que trocou de dono');
});

test('o convite de encontro também é estável entre leituras', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const primeiro = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, inicio);
  for (const passo of [1_000, 60_000, 10 * 60_000]) {
    assert.equal(buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY }, inicio + passo), primeiro);
  }
  assert.notEqual(buildInvite({ ...call, server: 'https://outro.exemplo.com', key: KEY }, inicio), primeiro);
});

test('convite de encontro vencido não é lido', () => {
  const code = encodeInvite({ version: 1, callId: 'c', callName: 'n', hostUsername: 'h', key: KEY, server: 'https://call.exemplo.com', issuedAt: 1_000, ttlMs: 1_000 });
  assert.equal(readInvite(code), null);
});
