import assert from 'node:assert/strict';
import { createPublicKey, verify as verifyBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LOCAL_NETWORK_GROUP, verifyClaim, verifyLoginProof, verifyRelease, type SignatureVerifier } from '../shared/identity';

// A chave de identidade do dispositivo, no processo principal.
//
// O que ela não pode fazer é tão importante quanto o que ela faz: trocar de
// chave sozinha, assinar texto qualquer, ou deixar a chave privada à vista da
// interface.

const require = createRequire(import.meta.url);
const { FILE_NAME, IdentityKey, groupIdFor } = require('../desktop/identity-key.cjs');

const verifier: SignatureVerifier = (publicKey, message, signature) => {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  return verifyBytes(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
};

/** Um chaveiro de mentira que deixa claro, no arquivo, que passou por ele. */
function keyring(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`cifrado:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('cifrado:')) throw new Error('não foi este chaveiro');
      return text.slice('cifrado:'.length);
    },
  };
}

async function folder(t: { after: (fn: () => unknown) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-identidade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a chave nasce uma vez, pelo chaveiro, e continua a mesma depois de reiniciar', async (t) => {
  const userDataPath = await folder(t);
  const first = new IdentityKey({ userDataPath, safeStorage: keyring() });
  assert.equal(first.load().status, 'ready');
  assert.equal(first.protection, 'keyring');

  const again = new IdentityKey({ userDataPath, safeStorage: keyring() });
  again.load();
  assert.equal(again.publicKey, first.publicKey, 'reiniciar trocou a identidade');

  const stored = JSON.parse(await readFile(path.join(userDataPath, FILE_NAME), 'utf8'));
  assert.equal(stored.protection, 'keyring');
  assert.ok(Buffer.from(stored.key, 'base64').toString('utf8').startsWith('cifrado:'), 'a chave não passou pelo chaveiro');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(userDataPath, FILE_NAME))).mode & 0o777, 0o600);
});

test('sem chaveiro, a chave fica no arquivo protegido, e isso é dito', async (t) => {
  const userDataPath = await folder(t);
  const key = new IdentityKey({ userDataPath, safeStorage: keyring(false) });
  const description = key.load();
  assert.equal(description.status, 'ready');
  assert.equal(description.protection, 'file');
  assert.match(description.message, /permissão do arquivo/);
});

test('uma chave guardada pelo chaveiro não é trocada quando o chaveiro some', async (t) => {
  const userDataPath = await folder(t);
  new IdentityKey({ userDataPath, safeStorage: keyring() }).load();
  const before = await readFile(path.join(userDataPath, FILE_NAME), 'utf8');

  const locked = new IdentityKey({ userDataPath, safeStorage: keyring(false) });
  assert.equal(locked.load().status, 'locked');
  assert.equal(locked.publicKey, '');
  assert.throws(() => locked.proveLogin({ inviteKey: 'k', name: 'alice', nonce: 'desafio-com-tamanho-ok' }), /chaveiro/);
  assert.equal(await readFile(path.join(userDataPath, FILE_NAME), 'utf8'), before, 'o arquivo foi trocado');
});

test('um arquivo ilegível não é sobrescrito', async (t) => {
  const userDataPath = await folder(t);
  await writeFile(path.join(userDataPath, FILE_NAME), 'isto não é json');
  const key = new IdentityKey({ userDataPath, safeStorage: keyring() });
  assert.equal(key.load().status, 'corrupt');
  assert.equal(await readFile(path.join(userDataPath, FILE_NAME), 'utf8'), 'isto não é json');
});

test('o que ela assina, o servidor confere', async (t) => {
  const userDataPath = await folder(t);
  const key = new IdentityKey({ userDataPath, safeStorage: keyring(), now: () => Date.parse('2026-09-12T10:00:00.000Z') });
  key.load();

  const proof = key.proveLogin({ inviteKey: 'chave-do-convite', name: 'alice', nonce: 'desafio-com-tamanho-ok' });
  assert.equal(verifyLoginProof(proof, verifier), true);
  assert.equal(proof.group, groupIdFor('chave-do-convite'));
  // O nome sai normalizado como o servidor normaliza: acento e caixa não mudam de quem ele é.
  assert.equal(key.proveLogin({ inviteKey: 'k', name: '  Álice ', nonce: 'desafio-com-tamanho-ok' }).name, 'álice');

  const claim = key.claim({ inviteKey: 'chave-do-convite', name: 'alice', displayName: 'Alice' });
  assert.equal(verifyClaim(claim, verifier), true);
  assert.equal(claim.issuedAt, '2026-09-12T10:00:00.000Z');
  assert.equal(claim.legacy, false);

  assert.equal(verifyRelease(key.release({ inviteKey: 'chave-do-convite', name: 'alice' }), verifier), true);
});

test('ela não assina o que não tem forma, e não oferece assinatura de texto qualquer', async (t) => {
  const userDataPath = await folder(t);
  const key = new IdentityKey({ userDataPath, safeStorage: keyring() });
  key.load();
  assert.throws(() => key.proveLogin({ inviteKey: 'k', name: 'alice', nonce: 'curto' }), /Nada foi assinado/);
  assert.throws(() => key.claim({ inviteKey: 'k', name: `ali${String.fromCharCode(10)}ce` }), /Nada foi assinado/);
  assert.throws(() => key.claim({ inviteKey: 'k', name: 'x'.repeat(65) }), /Nada foi assinado/);
  // Um oráculo de assinatura é exatamente o que este arquivo existe para não ser.
  assert.equal(typeof (key as Record<string, unknown>).sign, 'undefined');
  assert.equal(typeof (key as Record<string, unknown>).signText, 'undefined');
  assert.equal(JSON.stringify(key.describe()).includes('BEGIN'), false);
  assert.deepEqual(Object.keys(key.describe()).sort(), ['message', 'protection', 'publicKey', 'status']);
});

test('o grupo é o resumo da chave do convite, e não a chave', () => {
  const group = groupIdFor('chave-secreta-do-convite');
  assert.match(group, /^[0-9a-f]{64}$/);
  assert.equal(group.includes('chave'), false);
  assert.equal(groupIdFor(''), LOCAL_NETWORK_GROUP);
  assert.equal(groupIdFor(undefined), LOCAL_NETWORK_GROUP);
});
