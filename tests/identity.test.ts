import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify as verifyBytes } from 'node:crypto';
import test from 'node:test';
import {
  IDENTITY_CONTRACT, LOCAL_NETWORK_GROUP, LOGIN_MESSAGES, MAX_BATCH,
  claimMessage, claimShapeIsValid, decideLogin, emptyLedger, isNonce, loginMessage, mergeLedger, normalizeName,
  recordsForSync, releaseMessage, statusOfName, verifyClaim, verifyLoginProof,
  type IdentityClaim, type IdentityLedger, type IdentityRelease, type LoginProof, type SignatureVerifier,
} from '../shared/identity';

// A identidade P2P, do lado que decide.
//
// O que precisa ser provado: que um nome não troca de dono por quem chega
// primeiro a um host novo, que atrasar o relógio não compra precedência, que
// uma liberação não é desfeita por reapresentação, e que um aplicativo antigo
// continua entrando onde ninguém reivindicou nada.

const verifier: SignatureVerifier = (publicKey, message, signature) => {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  return verifyBytes(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
};

function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const encoded = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signText = (message: string) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
  return {
    publicKey: encoded,
    claim(group: string, name: string, overrides: Partial<Omit<IdentityClaim, 'signature'>> = {}): IdentityClaim {
      const unsigned = {
        contract: IDENTITY_CONTRACT, group, name, displayName: name, publicKey: encoded,
        issuedAt: '2026-09-12T10:00:00.000Z', legacy: false, ...overrides,
      };
      return { ...unsigned, signature: signText(claimMessage(unsigned)) };
    },
    release(group: string, name: string, releasedAt = '2026-09-12T11:00:00.000Z'): IdentityRelease {
      const unsigned = { contract: IDENTITY_CONTRACT, group, name, publicKey: encoded, releasedAt };
      return { ...unsigned, signature: signText(releaseMessage(unsigned)) };
    },
    prove(group: string, name: string, nonce: string): LoginProof {
      const unsigned = { group, name, nonce, publicKey: encoded };
      return { ...unsigned, signature: signText(loginMessage(unsigned)) };
    },
  };
}

const GROUP = 'a'.repeat(64);
const FOREIGN_GROUP = 'b'.repeat(64);
const groups = new Set([GROUP, LOCAL_NETWORK_GROUP]);
const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const NEWLINE = String.fromCharCode(10);

function merge(ledger: IdentityLedger, incoming: { claims?: unknown[]; releases?: unknown[] }, now = NOW, maxRecordsPerGroup?: number) {
  return mergeLedger(ledger, incoming, { verify: verifier, acceptedGroups: groups, now, maxRecordsPerGroup });
}

test('um claim assinado confere, e qualquer campo trocado quebra a assinatura', () => {
  const alice = device();
  const claim = alice.claim(GROUP, 'alice', { displayName: 'Alice' });
  assert.equal(verifyClaim(claim, verifier), true);
  for (const tampered of [
    { ...claim, name: 'bob' },
    { ...claim, displayName: 'Bob' },
    { ...claim, group: FOREIGN_GROUP },
    { ...claim, legacy: true },
    { ...claim, issuedAt: '2020-01-01T00:00:00.000Z' },
    { ...claim, publicKey: device().publicKey },
  ]) {
    assert.equal(verifyClaim(tampered, verifier), false, JSON.stringify(tampered).slice(0, 80));
  }
});

test('cada propósito assina num domínio próprio', () => {
  const alice = device();
  const proof = alice.prove(GROUP, 'alice', 'n'.repeat(32));
  // A mesma chave, o mesmo nome — mas uma assinatura de login não serve de claim.
  const forged = { ...alice.claim(GROUP, 'alice'), signature: proof.signature };
  assert.equal(verifyClaim(forged, verifier), false);
  assert.notEqual(claimMessage(alice.claim(GROUP, 'alice')).split(NEWLINE)[0], loginMessage(proof).split(NEWLINE)[0]);
});

test('o que está fora do formato é recusado antes de qualquer criptografia', () => {
  let calls = 0;
  const counting: SignatureVerifier = (...args) => { calls += 1; return verifier(...args); };
  const claim = device().claim(GROUP, 'alice');
  for (const malformed of [
    { ...claim, group: 'um-grupo-qualquer' },
    { ...claim, name: `ali${NEWLINE}ce` },
    { ...claim, name: 'x'.repeat(65) },
    { ...claim, name: ' alice' },
    { ...claim, publicKey: 'não é base64' },
    { ...claim, issuedAt: 'ontem' },
    { ...claim, contract: 2 },
    { ...claim, legacy: 'sim' },
    null,
    'claim',
  ]) {
    assert.equal(claimShapeIsValid(malformed), false);
    assert.equal(verifyClaim(malformed, counting), false);
  }
  assert.equal(calls, 0, 'a verificação criptográfica rodou para algo malformado');
});

test('uma chave que nem é chave dá "não confere", e não derruba o servidor', () => {
  const claim = device().claim(GROUP, 'alice');
  const garbageKey = { ...claim, publicKey: Buffer.from('não é uma chave pública').toString('base64') };
  assert.equal(verifyClaim(garbageKey, verifier), false);
});

test('um nome livre fica com o primeiro claim, e o mesmo dispositivo não vira disputa', () => {
  const alice = device();
  let { ledger } = merge(emptyLedger(), { claims: [alice.claim(GROUP, 'alice')] });
  assert.equal(statusOfName(ledger, GROUP, 'alice').state, 'bound');
  // O mesmo dispositivo reenviando, e reenviando com outro carimbo.
  ledger = merge(ledger, { claims: [alice.claim(GROUP, 'alice'), alice.claim(GROUP, 'alice', { issuedAt: '2026-09-12T10:30:00.000Z' })] }).ledger;
  assert.equal(statusOfName(ledger, GROUP, 'alice').state, 'bound');
  assert.equal(ledger.entries.length, 1, 'reivindicar de novo o próprio nome não pode acumular registros');
  assert.equal(statusOfName(ledger, GROUP, 'bob').state, 'free');
});

test('o nome é normalizado com a mesma regra de sempre do servidor', () => {
  assert.equal(normalizeName('  Álvaro '), 'álvaro');
  // Letras de largura cheia viram as comuns: não dá para ter dois "tuma".
  assert.equal(normalizeName(String.fromCharCode(0xff54, 0xff55, 0xff4d, 0xff41)), 'tuma');
});

test('a precedência é de quem este host viu primeiro — atrasar o relógio não compra o nome', () => {
  const alice = device();
  const mallory = device();
  let { ledger } = merge(emptyLedger(), { claims: [alice.claim(GROUP, 'alice', { issuedAt: '2026-09-12T10:00:00.000Z' })] }, NOW);
  // Assinado com um carimbo de anos atrás, e chegando depois.
  ledger = merge(ledger, { claims: [mallory.claim(GROUP, 'alice', { issuedAt: '2020-01-01T00:00:00.000Z' })] }, NOW + 1_000).ledger;
  const status = statusOfName(ledger, GROUP, 'alice');
  assert.equal(status.state, 'contested');
  assert.equal(status.state === 'contested' && status.holder.claim.publicKey, alice.publicKey);
});

test('claim de outro grupo, do futuro ou com assinatura errada não entra', () => {
  const alice = device();
  const { ledger, rejected } = merge(emptyLedger(), {
    claims: [
      alice.claim(FOREIGN_GROUP, 'alice'),
      alice.claim(GROUP, 'alice', { issuedAt: '2026-09-12T13:00:00.000Z' }),
      { ...alice.claim(GROUP, 'alice'), displayName: 'Outra' },
    ],
  });
  assert.equal(ledger.entries.length, 0);
  assert.deepEqual(rejected.map((item) => item.reason), ['group', 'future', 'signature']);
});

test('mesclar não altera o registro de quem chamou', () => {
  const before = emptyLedger();
  const snapshot = JSON.stringify(before);
  merge(before, { claims: [device().claim(GROUP, 'alice')] });
  assert.equal(JSON.stringify(before), snapshot);
});

test('a liberação tira o nome, e o claim antigo não volta por reapresentação', () => {
  const alice = device();
  const original = alice.claim(GROUP, 'alice');
  let { ledger } = merge(emptyLedger(), { claims: [original] });
  ledger = merge(ledger, { releases: [alice.release(GROUP, 'alice')] }).ledger;
  assert.equal(statusOfName(ledger, GROUP, 'alice').state, 'free');

  // A assinatura é a mesma, então o registro já existe: nada muda.
  const replay = merge(ledger, { claims: [original] });
  assert.equal(statusOfName(replay.ledger, GROUP, 'alice').state, 'free');

  // Num host que nunca viu o claim, a liberação chegando junto também vence.
  const elsewhere = merge(emptyLedger(), { claims: [original], releases: [alice.release(GROUP, 'alice')] });
  assert.equal(statusOfName(elsewhere.ledger, GROUP, 'alice').state, 'free');
  assert.deepEqual(elsewhere.rejected.map((item) => item.reason), ['released']);

  // A mesma chave pode reivindicar de novo, com um claim posterior à liberação.
  ledger = merge(ledger, { claims: [alice.claim(GROUP, 'alice', { issuedAt: '2026-09-12T11:30:00.000Z' })] }).ledger;
  assert.equal(statusOfName(ledger, GROUP, 'alice').state, 'bound');
});

test('liberar numa disputa resolve a favor do outro, e deixa de ser provisório', () => {
  const alice = device();
  const bob = device();
  let { ledger } = merge(emptyLedger(), { claims: [alice.claim(GROUP, 'tuma')] }, NOW);
  ledger = merge(ledger, { claims: [bob.claim(GROUP, 'tuma')] }, NOW + 1_000).ledger;
  assert.equal(statusOfName(ledger, GROUP, 'tuma').state, 'contested');

  ledger = merge(ledger, { releases: [alice.release(GROUP, 'tuma')] }, NOW + 2_000).ledger;
  const status = statusOfName(ledger, GROUP, 'tuma');
  assert.equal(status.state, 'bound');
  assert.equal(status.state === 'bound' && status.holder.claim.publicKey, bob.publicKey);
  assert.deepEqual(decideLogin(status, { publicKey: bob.publicKey, valid: true }), { allow: true, binding: 'existing', provisional: false });
});

test('ninguém libera o nome de outra pessoa', () => {
  const alice = device();
  const mallory = device();
  let { ledger } = merge(emptyLedger(), { claims: [alice.claim(GROUP, 'alice')] });
  // Uma liberação que diz ser da chave da Alice, assinada por outra.
  const forged = { ...alice.release(GROUP, 'alice'), signature: mallory.release(GROUP, 'alice').signature };
  const outcome = merge(ledger, { releases: [forged, mallory.release(GROUP, 'alice')] });
  ledger = outcome.ledger;
  assert.deepEqual(outcome.rejected.map((item) => item.reason), ['signature']);
  assert.equal(statusOfName(ledger, GROUP, 'alice').state, 'bound');
});

test('um lote e um grupo têm teto', () => {
  const many = Array.from({ length: MAX_BATCH + 5 }, (_, index) => device().claim(GROUP, `pessoa-${index}`));
  const batch = merge(emptyLedger(), { claims: many });
  assert.equal(batch.ledger.entries.length, MAX_BATCH);
  assert.equal(batch.rejected.filter((item) => item.reason === 'limit').length, 5);

  const capped = merge(emptyLedger(), { claims: many.slice(0, 5) }, NOW, 3);
  assert.equal(capped.ledger.entries.length, 3);
  assert.equal(capped.rejected.filter((item) => item.reason === 'capacity').length, 2);
});

test('a sincronização é por páginas, e o cursor não repete nem pula', () => {
  let ledger = emptyLedger();
  const keys = Array.from({ length: 3 }, () => device());
  // Três lotes no **mesmo instante**: um cursor por carimbo empataria aqui.
  for (let round = 0; round < 3; round += 1) {
    ledger = merge(ledger, { claims: Array.from({ length: 150 }, (_, index) => keys[round].claim(GROUP, `n-${round}-${index}`)) }).ledger;
  }
  ledger = merge(ledger, { claims: [device().claim(FOREIGN_GROUP, 'fora')] }).ledger;

  const seen = new Set<string>();
  let after = 0;
  let pages = 0;
  do {
    const page = recordsForSync(ledger, groups, after);
    for (const claim of page.claims) {
      assert.equal(seen.has(claim.signature), false, 'um registro veio duas vezes');
      seen.add(claim.signature);
    }
    after = page.next;
    pages += 1;
  } while (after && pages < 10);
  assert.equal(seen.size, 450);
  assert.equal(pages, 3);
});

test('a decisão de login, caso a caso', () => {
  const alice = device();
  const bob = device();
  const carol = device();
  const valid = (who: { publicKey: string }) => ({ publicKey: who.publicKey, valid: true });

  const free = statusOfName(emptyLedger(), GROUP, 'alice');
  // Um aplicativo antigo entra onde ninguém reivindicou nada.
  assert.deepEqual(decideLogin(free, null), { allow: true, binding: 'none', provisional: false });
  assert.deepEqual(decideLogin(free, valid(alice)), { allow: true, binding: 'new', provisional: false });

  const bound = statusOfName(merge(emptyLedger(), { claims: [alice.claim(GROUP, 'alice')] }).ledger, GROUP, 'alice');
  assert.deepEqual(decideLogin(bound, valid(alice)), { allow: true, binding: 'existing', provisional: false });
  assert.deepEqual(decideLogin(bound, valid(bob)), { allow: false, status: 409, reason: 'claimed-by-other' });
  assert.deepEqual(decideLogin(bound, null), { allow: false, status: 426, reason: 'proof-required' });
  assert.deepEqual(decideLogin(bound, { publicKey: alice.publicKey, valid: false }), { allow: false, status: 401, reason: 'bad-proof' });

  let ledger = merge(emptyLedger(), { claims: [alice.claim(GROUP, 'tuma')] }, NOW).ledger;
  ledger = merge(ledger, { claims: [bob.claim(GROUP, 'tuma')] }, NOW + 1_000).ledger;
  const contested = statusOfName(ledger, GROUP, 'tuma');
  assert.deepEqual(decideLogin(contested, valid(alice)), { allow: true, binding: 'existing', provisional: true });
  assert.deepEqual(decideLogin(contested, valid(bob)), { allow: false, status: 409, reason: 'contested' });
  assert.deepEqual(decideLogin(contested, valid(carol)), { allow: false, status: 409, reason: 'claimed-by-other' });
});

test('a prova de login amarra grupo, nome, desafio e chave', () => {
  const alice = device();
  const nonce = 'desafio-com-tamanho-ok';
  const proof = alice.prove(GROUP, 'alice', nonce);
  assert.equal(verifyLoginProof(proof, verifier), true);
  assert.equal(verifyLoginProof({ ...proof, nonce: 'outro-desafio-qualquer' }, verifier), false);
  assert.equal(verifyLoginProof({ ...proof, name: 'bob' }, verifier), false);
  assert.equal(verifyLoginProof({ ...proof, group: FOREIGN_GROUP }, verifier), false);
  assert.equal(verifyLoginProof({ ...proof, publicKey: device().publicKey }, verifier), false);
  assert.equal(isNonce('curto'), false);
  assert.equal(isNonce('a+b/c'.repeat(5)), false, 'o desafio é base64url, sem + nem /');
});

test('cada recusa diz o que a pessoa pode fazer', () => {
  for (const message of Object.values(LOGIN_MESSAGES)) assert.ok(message.length > 30);
  assert.match(LOGIN_MESSAGES['proof-required'], /Atualize/);
  assert.match(LOGIN_MESSAGES.contested, /liberar/);
});
