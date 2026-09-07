import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildInvite, forgetCachedInvite, inviteFormat, readInvite, requestShortInvite, resolveAnyInvite, resolveInvite, resolveShortInvite } from '../src/lib/directLink';
import { decodeInvite, encodeInvite, encodeShortInvite, normalizeRendezvousUrl } from '../shared/directLink';

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

// Um servidor que aceita a conexão e não responde deixava a janela de convite
// em "Pedindo um código ao servidor…" para sempre: sem erro, sem reserva, sem
// nada além de fechar a janela. Um prazo transforma isso no que já existia
// como caminho — cair no formato longo.
test('pedido de convite curto que não responde termina no prazo, sem pendurar a tela', async () => {
  let abortada = false;
  const fetchQueNuncaResponde: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    const signal = (init as RequestInit | undefined)?.signal;
    signal?.addEventListener('abort', () => {
      abortada = true;
      reject(new DOMException('Abortado.', 'AbortError'));
    });
  });
  const comecou = Date.now();
  const codigo = await requestShortInvite('https://call.exemplo.com', 'token-de-sessao', { callId: 'call-geral', callName: 'Call' }, {
    fetchImpl: fetchQueNuncaResponde,
    timeoutMs: 40,
  });
  assert.equal(codigo, null, 'sem código, quem chama cai no formato longo');
  assert.equal(abortada, true, 'o pedido precisa ser realmente abortado, não só ignorado');
  assert.ok(Date.now() - comecou < 4_000, 'o prazo precisa valer');
});

test('consulta de convite curto também tem prazo', async () => {
  const fetchQueNuncaResponde: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    (init as RequestInit | undefined)?.signal?.addEventListener('abort', () => reject(new DOMException('Abortado.', 'AbortError')));
  });
  const resolvido = await resolveShortInvite('TUMA2~call.exemplo.com~7K3P9QXM2W4V', { fetchImpl: fetchQueNuncaResponde, timeoutMs: 40 });
  assert.equal(resolvido, null);
});

test('o caminho normal continua devolvendo o código curto', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ token: '7K3P9QXM2W4V', expiresAt: Date.now() + 1000 }), { status: 200 });
  const codigo = await requestShortInvite('https://call.exemplo.com', 'token-de-sessao', { callId: 'call-geral', callName: 'Call' }, { fetchImpl });
  assert.equal(codigo, 'TUMA2~call.exemplo.com~7K3P9QXM2W4V');
});

// O defeito mais caro encontrado na auditoria da 0.8.4: a interface só sabia
// reconhecer o formato antigo. "Entrar por convite" conferia o código com
// `readInvite` — que só lê `TUMA1` — antes de tentar alcançar o servidor, e a
// tela de entrada só chamava `resolveInvite`. O convite curto, que é o único
// que o servidor da 0.8.4 emite, era recusado como "inválido ou vencido" sem
// nunca ter sido tentado.
test('o formato curto é reconhecido, e o longo continua sendo', () => {
  const curto = encodeShortInvite({ server: 'https://call.exemplo.com', token: '7K3P9QXM2W4V' })!;
  assert.equal(inviteFormat(curto), 'short');

  const longo = buildInvite({ ...call, server: 'https://call.exemplo.com', key: KEY })!;
  assert.equal(inviteFormat(longo), 'long');

  assert.equal(inviteFormat('qualquer coisa'), null);
  assert.equal(inviteFormat(''), null);
  assert.equal(inviteFormat('TUMA2~call.exemplo.com~CURTO'), null, 'token com tamanho errado não é convite');
});

test('resolver um convite aceita os dois formatos pelo mesmo caminho', async () => {
  const curto = encodeShortInvite({ server: 'https://call.exemplo.com', token: '7K3P9QXM2W4V' })!;
  const consultas: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    consultas.push(String(url));
    return new Response(JSON.stringify({ callId: 'call-geral', callName: 'Call do grupo', hostUsername: 'Moontariun' }), { status: 200 });
  };
  const resolvido = await resolveAnyInvite(curto, { fetchImpl });
  assert.equal(resolvido?.invite.callId, 'call-geral');
  assert.equal(resolvido?.url, 'https://call.exemplo.com');
  assert.equal(resolvido?.invite.key, '7K3P9QXM2W4V', 'o token do convite é a chave de acesso desta entrada');
  assert.deepEqual(consultas, ['https://call.exemplo.com/api/invite/7K3P9QXM2W4V']);
});

test('um código que não é convite nenhum não vira consulta de rede', async () => {
  let consultou = false;
  const fetchImpl: typeof fetch = async () => { consultou = true; return new Response('{}', { status: 200 }); };
  assert.equal(await resolveAnyInvite('bom dia', { fetchImpl }), null);
  assert.equal(consultou, false);
});
