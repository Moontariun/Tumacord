// A chave de identidade deste dispositivo, para o P2P.
//
// ## Onde ela mora
//
// No processo principal, e nunca no renderer. A interface pede assinaturas por
// IPC, e só de três coisas com forma fechada — um claim, uma liberação, uma
// prova de login —, montadas **aqui** a partir de campos validados. Um canal
// que assinasse texto qualquer vindo da página seria um oráculo: qualquer
// script que rodasse na janela assinaria, em nome da pessoa, o que quisesse.
//
// ## Como ela é guardada
//
// Com `safeStorage`, o chaveiro do sistema, quando ele existe. Sem chaveiro —
// um Linux sem serviço de segredos — ela é gravada com permissão 0600, e isso é
// **dito** em `protection`. A alternativa, uma chave só de sessão, faria a
// pessoa perder o próprio nome nos grupos a cada reinício, que é pior do que
// uma chave protegida só pela permissão do arquivo.
//
// ## O que ela nunca faz sozinha
//
// Trocar de chave. Um arquivo ilegível, ou um chaveiro que não abre hoje, deixa
// a identidade indisponível e diz por quê. Gerar outra por cima seria entregar
// à pessoa um dispositivo que não é mais dono do nome dela, sem aviso.

const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  IDENTITY_CONTRACT, LOCAL_NETWORK_GROUP, claimMessage, claimShapeIsValid, loginMessage,
  loginProofShapeIsValid, normalizeName, releaseMessage, releaseShapeIsValid,
} = require('./identity.generated.cjs');

const FILE_NAME = 'identity-key.json';
const FILE_VERSION = 1;
/** Uma assinatura de mentira, com a forma certa, para validar antes de assinar. */
const PLACEHOLDER_SIGNATURE = 'AAAA';

const MESSAGES = {
  corrupt: 'O arquivo da identidade deste dispositivo está ilegível. Ele não foi sobrescrito: trocá-lo significaria perder o nome nos grupos em que ele foi reivindicado.',
  locked: 'A identidade deste dispositivo está no chaveiro do sistema, e o chaveiro não abriu agora. Nada foi trocado: desbloqueie o chaveiro e reinicie o Tumacord.',
  fileProtection: 'Sem chaveiro do sistema, a identidade deste dispositivo está protegida só pela permissão do arquivo.',
  unavailable: 'A identidade deste dispositivo não está disponível.',
  malformed: 'O pedido de assinatura está fora do formato. Nada foi assinado.',
};

/** O grupo de um convite: o resumo da chave, e nunca a chave. */
function groupIdFor(inviteKey) {
  const key = String(inviteKey ?? '').trim();
  return key ? createHash('sha256').update(key, 'utf8').digest('hex') : LOCAL_NETWORK_GROUP;
}

function readStored(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return error && error.code === 'ENOENT' ? { state: 'missing' } : { state: 'corrupt' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === FILE_VERSION && (parsed.protection === 'keyring' || parsed.protection === 'file') && typeof parsed.key === 'string') {
      return { state: 'present', stored: parsed };
    }
  } catch {
    // Cai no ilegível logo abaixo.
  }
  return { state: 'corrupt' };
}

function writeAtomically(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.next`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // O Windows ignora o modo; lá quem protege é a pasta do usuário.
  }
}

class IdentityKey {
  #privateKey = null;

  constructor({ userDataPath, safeStorage = null, now = () => Date.now() } = {}) {
    if (!userDataPath) throw new Error('IdentityKey precisa da pasta de dados do usuário.');
    this.filePath = path.join(userDataPath, FILE_NAME);
    this.safeStorage = safeStorage;
    this.now = now;
    this.publicKey = '';
    this.status = 'unloaded';
    this.protection = '';
    this.message = '';
  }

  #keyringAvailable() {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  #adopt(privateKey) {
    this.#privateKey = privateKey;
    this.publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  }

  #unavailable(status, message) {
    this.#privateKey = null;
    this.publicKey = '';
    this.status = status;
    this.message = message;
    return this.describe();
  }

  load() {
    const found = readStored(this.filePath);
    if (found.state === 'missing') return this.#create();
    if (found.state !== 'present') return this.#unavailable('corrupt', MESSAGES.corrupt);

    const { stored } = found;
    let pkcs8 = stored.key;
    if (stored.protection === 'keyring') {
      if (!this.#keyringAvailable()) return this.#unavailable('locked', MESSAGES.locked);
      try {
        pkcs8 = this.safeStorage.decryptString(Buffer.from(stored.key, 'base64'));
      } catch {
        return this.#unavailable('locked', MESSAGES.locked);
      }
    }
    try {
      this.#adopt(createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' }));
    } catch {
      return this.#unavailable('corrupt', MESSAGES.corrupt);
    }
    this.protection = stored.protection;
    this.status = 'ready';
    this.message = stored.protection === 'file' ? MESSAGES.fileProtection : '';
    return this.describe();
  }

  #create() {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const keyring = this.#keyringAvailable();
    const key = keyring ? this.safeStorage.encryptString(pkcs8).toString('base64') : pkcs8;
    writeAtomically(this.filePath, `${JSON.stringify({ version: FILE_VERSION, protection: keyring ? 'keyring' : 'file', key }, null, 2)}\n`);
    this.#adopt(privateKey);
    this.protection = keyring ? 'keyring' : 'file';
    this.status = 'ready';
    this.message = keyring ? '' : MESSAGES.fileProtection;
    return this.describe();
  }

  /** O que a interface pode saber: nada que assine. */
  describe() {
    return { status: this.status, protection: this.protection, publicKey: this.publicKey, message: this.message };
  }

  #sign(unsigned, messageOf, shapeIsValid) {
    if (this.status !== 'ready' || !this.#privateKey) throw new Error(this.message || MESSAGES.unavailable);
    // A forma é conferida **antes** de assinar: um pedido torto não sai daqui
    // com a assinatura deste dispositivo, nem para ser descartado depois.
    if (!shapeIsValid({ ...unsigned, signature: PLACEHOLDER_SIGNATURE })) throw new Error(MESSAGES.malformed);
    const signature = sign(null, Buffer.from(messageOf(unsigned), 'utf8'), this.#privateKey).toString('base64');
    return { ...unsigned, signature };
  }

  proveLogin({ inviteKey, name, nonce } = {}) {
    return this.#sign(
      { group: groupIdFor(inviteKey), name: normalizeName(String(name ?? '')), nonce: String(nonce ?? ''), publicKey: this.publicKey },
      loginMessage,
      loginProofShapeIsValid,
    );
  }

  claim({ inviteKey, name, displayName, legacy = false } = {}) {
    return this.#sign(
      {
        contract: IDENTITY_CONTRACT,
        group: groupIdFor(inviteKey),
        name: normalizeName(String(name ?? '')),
        displayName: String(displayName ?? name ?? '').trim(),
        publicKey: this.publicKey,
        issuedAt: new Date(this.now()).toISOString(),
        legacy: legacy === true,
      },
      claimMessage,
      claimShapeIsValid,
    );
  }

  release({ inviteKey, name } = {}) {
    return this.#sign(
      {
        contract: IDENTITY_CONTRACT,
        group: groupIdFor(inviteKey),
        name: normalizeName(String(name ?? '')),
        publicKey: this.publicKey,
        releasedAt: new Date(this.now()).toISOString(),
      },
      releaseMessage,
      releaseShapeIsValid,
    );
  }
}

module.exports = { FILE_NAME, IdentityKey, MESSAGES, groupIdFor };
