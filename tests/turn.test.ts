import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TURN_TTL_SECONDS,
  ephemeralTurnCredentials,
  parseTurnUrls,
  turnConfiguration,
  turnIceServers,
} from '../server/turn';

const SECRET = 'segredo-de-teste-do-coturn';

// Vetor conferido contra uma implementação independente:
//   printf '1788600000:renan' | openssl dgst -sha1 -hmac "$SECRET" -binary | openssl base64
// Se este valor mudar, o coturn passa a recusar as credenciais que geramos.
const EXPECTED_CREDENTIAL = 'bFy+ty2jGN6u0X5VWSyi0ExWfZU=';

test('a credencial é o HMAC-SHA1 do usuário com o segredo, em base64', () => {
  const configuration = { urls: ['turn:exemplo:3478'], secret: SECRET, ttlSeconds: 3600 };
  const credentials = ephemeralTurnCredentials(configuration, 'renan', (1_788_600_000 - 3600) * 1000);
  assert.equal(credentials.username, '1788600000:renan');
  assert.equal(credentials.credential, EXPECTED_CREDENTIAL);
  assert.equal(credentials.expiresAt, 1_788_600_000 * 1000);
});

test('o nome do usuário é higienizado antes de virar credencial', () => {
  const configuration = { urls: ['turn:exemplo:3478'], secret: SECRET, ttlSeconds: 3600 };
  const now = (1_788_600_000 - 3600) * 1000;
  assert.equal(ephemeralTurnCredentials(configuration, 'renan:com dois pontos', now).username, '1788600000:renancomdoispontos');
  assert.equal(ephemeralTurnCredentials(configuration, '🍅', now).username, '1788600000:tumacord', 'um nome que some na higienização vira o padrão');
  assert.equal(ephemeralTurnCredentials(configuration, 'a'.repeat(80), now).username.split(':')[1].length, 32);
});

test('a mesma entrada gera sempre a mesma credencial, e segredos diferentes divergem', () => {
  const now = 1_700_000_000_000;
  const base = { urls: ['turn:exemplo:3478'], secret: SECRET, ttlSeconds: 3600 };
  assert.equal(ephemeralTurnCredentials(base, 'renan', now).credential, ephemeralTurnCredentials(base, 'renan', now).credential);
  assert.notEqual(
    ephemeralTurnCredentials(base, 'renan', now).credential,
    ephemeralTurnCredentials({ ...base, secret: 'outro-segredo' }, 'renan', now).credential,
  );
});

test('só URLs de TURN entram na lista, sem repetição', () => {
  assert.deepEqual(parseTurnUrls('turn:a:3478, turns:b:5349 ,turn:a:3478'), ['turn:a:3478', 'turns:b:5349']);
  assert.deepEqual(parseTurnUrls('stun:c:3478,http://d'), [], 'STUN e HTTP não são relay');
  assert.deepEqual(parseTurnUrls(undefined), []);
});

test('sem URL ou sem segredo o servidor simplesmente não anuncia TURN', () => {
  assert.equal(turnConfiguration({ TURN_URLS: 'turn:a:3478' }), null, 'anunciar sem credencial faria o navegador falhar na autenticação à toa');
  assert.equal(turnConfiguration({ TURN_SECRET: SECRET }), null);
  assert.equal(turnConfiguration({}), null);
  const configured = turnConfiguration({ TURN_URLS: 'turn:a:3478', TURN_SECRET: SECRET });
  assert.deepEqual(configured, { urls: ['turn:a:3478'], secret: SECRET, ttlSeconds: DEFAULT_TURN_TTL_SECONDS });
});

test('o prazo das credenciais fica dentro de limites sensatos', () => {
  const base = { TURN_URLS: 'turn:a:3478', TURN_SECRET: SECRET };
  assert.equal(turnConfiguration({ ...base, TURN_TTL_SECONDS: '3600' })?.ttlSeconds, 3600);
  assert.equal(turnConfiguration({ ...base, TURN_TTL_SECONDS: '10' })?.ttlSeconds, DEFAULT_TURN_TTL_SECONDS, 'curto demais renovaria sem parar');
  assert.equal(turnConfiguration({ ...base, TURN_TTL_SECONDS: '999999' })?.ttlSeconds, DEFAULT_TURN_TTL_SECONDS, 'longo demais transforma um vazamento em problema duradouro');
  assert.equal(turnConfiguration({ ...base, TURN_TTL_SECONDS: 'abacaxi' })?.ttlSeconds, DEFAULT_TURN_TTL_SECONDS);
});

test('as URLs saem em um bloco único, com a credencial junto', () => {
  const configuration = { urls: ['turn:a:3478', 'turns:b:5349'], secret: SECRET, ttlSeconds: 3600 };
  const credentials = ephemeralTurnCredentials(configuration, 'renan', 1_700_000_000_000);
  assert.deepEqual(turnIceServers(configuration, credentials), [{
    urls: ['turn:a:3478', 'turns:b:5349'],
    username: credentials.username,
    credential: credentials.credential,
  }]);
  assert.deepEqual(turnIceServers(null, credentials), []);
  assert.deepEqual(turnIceServers(configuration, null), []);
});
