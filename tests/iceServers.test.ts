import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedTurnServers, forgetTurnServers, iceServers, refreshTurnServers, turnServersAreFresh } from '../src/lib/iceServers';
import { DEFAULT_NETWORK_PREFERENCES, type NetworkPreferences } from '../src/lib/networkPreferences';

// `turnEnabled: true` aqui é deliberado: o padrão do produto é o relay
// desligado, então todo teste que quer ver o relay precisa pedi-lo. O teste
// logo abaixo trava exatamente esse padrão.
const preferences: NetworkPreferences = { ...DEFAULT_NETWORK_PREFERENCES, stunServers: ['stun:stun.exemplo:3478'], turnEnabled: true };

function respondWith(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

const RELAY = {
  iceServers: [{ urls: ['turn:relay.exemplo:3478', 'turns:relay.exemplo:5349'], username: '1788600000:renan', credential: 'abc=' }],
  expiresAt: 1_788_600_000_000,
};

test('sem TURN buscado, a lista tem apenas o STUN local', () => {
  forgetTurnServers();
  assert.deepEqual(iceServers(preferences), [{ urls: ['stun:stun.exemplo:3478'] }]);
});

test('o relay vem desligado por padrão', () => {
  assert.equal(DEFAULT_NETWORK_PREFERENCES.turnEnabled, false, 'a mídia não passa por máquina de terceiro sem alguém pedir');
});

test('com o relay desligado, a credencial em mãos não vira candidato', async () => {
  forgetTurnServers();
  const servers = await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  assert.equal(servers.length, 1, 'buscar continua possível; oferecer ao navegador é que não');
  assert.deepEqual(
    iceServers({ ...preferences, turnEnabled: false }, 1_700_000_000_000),
    [{ urls: ['stun:stun.exemplo:3478'] }],
    'desligar vale agora, não só na próxima renovação',
  );
  assert.equal(iceServers(preferences, 1_700_000_000_000).length, 2, 'e religar devolve o relay sem buscar de novo');
});

test('desligado, e sem STUN, a lista fica vazia em vez de cair no relay', async () => {
  forgetTurnServers();
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  assert.deepEqual(iceServers({ ...preferences, stunEnabled: false, turnEnabled: false }, 1_700_000_000_000), []);
});

test('o TURN do servidor entra depois do STUN, com as credenciais', async () => {
  forgetTurnServers();
  const servers = await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  assert.equal(servers.length, 1);
  const combinado = iceServers(preferences, 1_700_000_000_000);
  assert.deepEqual(combinado, [
    { urls: ['stun:stun.exemplo:3478'] },
    { urls: ['turn:relay.exemplo:3478', 'turns:relay.exemplo:5349'], username: '1788600000:renan', credential: 'abc=' },
  ]);
});

test('a preferência de desligar STUN não apaga o relay já obtido', async () => {
  forgetTurnServers();
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  const semStun = iceServers({ ...preferences, stunEnabled: false }, 1_700_000_000_000);
  assert.equal(semStun.length, 1);
  assert.equal(semStun[0].urls[0], 'turn:relay.exemplo:3478');
});

test('credencial vencida sai da lista em vez de ser oferecida ao navegador', async () => {
  forgetTurnServers();
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  assert.deepEqual(iceServers(preferences, RELAY.expiresAt + 1), [{ urls: ['stun:stun.exemplo:3478'] }]);
});

test('a renovação acontece com folga antes do vencimento', async () => {
  forgetTurnServers();
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  assert.equal(turnServersAreFresh(RELAY.expiresAt - 6 * 60_000), true);
  assert.equal(turnServersAreFresh(RELAY.expiresAt - 4 * 60_000), false, 'cinco minutos de folga evitam vencer no meio de uma reconexão');
});

test('enquanto está fresca, a credencial não é buscada de novo', async () => {
  forgetTurnServers();
  let chamadas = 0;
  const contando = (async () => { chamadas += 1; return { ok: true, json: async () => RELAY }; }) as unknown as typeof fetch;
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: contando, now: 1_700_000_000_000 });
  await refreshTurnServers('https://call.exemplo/', 'token', { fetchImpl: contando, now: 1_700_000_000_100 });
  assert.equal(chamadas, 1, 'a barra final não pode contar como outro servidor');
});

test('servidor sem TURN ou fora do ar não impede a call de começar', async () => {
  forgetTurnServers();
  assert.deepEqual(await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith({ iceServers: [], expiresAt: 0 }) }), []);
  assert.deepEqual(cachedTurnServers(), []);
  forgetTurnServers();
  const quebrado = (async () => { throw new Error('sem rede'); }) as unknown as typeof fetch;
  assert.deepEqual(await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: quebrado }), []);
  assert.deepEqual(iceServers(preferences), [{ urls: ['stun:stun.exemplo:3478'] }]);
});

test('entrada malformada do servidor é descartada em vez de virar candidato inválido', async () => {
  forgetTurnServers();
  const lixo = { iceServers: [{ urls: 'http://nao-e-turn' }, { urls: ['stun:x:3478'] }, 'texto', null, { urls: ['turn:ok:3478'] }], expiresAt: 1_788_600_000_000 };
  const servers = await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(lixo), now: 1_700_000_000_000 });
  assert.deepEqual(servers, [{ urls: ['turn:ok:3478'] }]);
});

test('resposta de erro mantém a credencial anterior em vez de esvaziar', async () => {
  forgetTurnServers();
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  const depois = await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith({}, false), now: RELAY.expiresAt - 60_000 });
  assert.equal(depois.length, 1);
});

test('trocar de servidor descarta a credencial do anterior', async () => {
  forgetTurnServers();
  await refreshTurnServers('https://call.exemplo', 'token', { fetchImpl: respondWith(RELAY), now: 1_700_000_000_000 });
  const outro = await refreshTurnServers('https://outra.exemplo', 'token', { fetchImpl: respondWith({ iceServers: [], expiresAt: 0 }), now: 1_700_000_000_000 });
  assert.deepEqual(outro, [], 'credencial de um servidor não vale no outro');
  forgetTurnServers();
});
