// A metade que assina e verifica de verdade.
//
// Separada de `distribution.ts` porque aquela é pura e esta toca em
// `node:crypto`. A separação não é estética: a decisão sobre o que é válido
// precisa poder ser testada sem chave, sem arquivo e sem serviço — e a
// operação de chave precisa ser um lugar só, pequeno o bastante para ser lido
// inteiro por alguém que esteja conferindo.
//
// Nada aqui é criptografia inventada: Ed25519 e SHA-256 do próprio Node. O que
// este projeto define é **o que exatamente é assinado**, e isso mora em
// `canonicalize`, do outro arquivo.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { SIGNATURE_ALGORITHM, type Signed, canonicalize } from './distribution.js';

/** Um par de chaves de publicação, nas formas em que são guardadas. */
export interface KeyPair {
  keyId: string;
  algorithm: string;
  /** SPKI DER em base64. É esta forma que vai embutida no aplicativo. */
  publicKey: string;
  /** PKCS#8 DER em base64. **Nunca** sai do ambiente de publicação. */
  privateKey: string;
}

/**
 * O identificador de uma chave: o SHA-256 da chave pública.
 *
 * Derivar o id da própria chave impede duas coisas. Uma chave nova não pode se
 * apresentar com o id de uma antiga, porque o id não é escolhido; e duas
 * cópias da mesma chave sempre têm o mesmo id, o que torna a rotação
 * verificável — dá para dizer se a chave publicada é a mesma sem comparar
 * bytes à mão.
 */
export function keyIdFor(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32);
}

export function generateSigningKey(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    keyId: keyIdFor(spki),
    algorithm: SIGNATURE_ALGORITHM,
    publicKey: spki,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/**
 * Verifica uma assinatura.
 *
 * Devolve `false` para qualquer entrada malformada em vez de lançar: esta
 * função recebe dados que vieram da rede, e uma chave torta não pode
 * interromper a verificação das outras assinaturas do mesmo documento.
 */
export function verifySignature(publicKeyBase64: string, data: string, signatureBase64: string, algorithm: string = SIGNATURE_ALGORITHM): boolean {
  if (algorithm !== SIGNATURE_ALGORITHM) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** Assina a forma canônica de um payload. */
export function signPayload(privateKeyBase64: string, payload: unknown): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(canonicalize(payload), 'utf8'), key).toString('base64');
}

/**
 * Embrulha um payload com uma ou mais assinaturas.
 *
 * Mais de uma existe para a rotação de chave: durante a troca, o mesmo
 * documento sai assinado pela chave velha e pela nova, e nenhum cliente fica
 * sem conseguir verificar — nem o que ainda não conhece a nova, nem o que já
 * não aceita a velha.
 */
export function signDocument<T>(payload: T, keys: readonly Pick<KeyPair, 'keyId' | 'algorithm' | 'privateKey'>[]): Signed<T> {
  if (!keys.length) throw new Error('um documento sem assinatura não é publicável');
  return {
    payload,
    signatures: keys.map((key) => ({
      keyId: key.keyId,
      algorithm: key.algorithm || SIGNATURE_ALGORITHM,
      signature: signPayload(key.privateKey, payload),
    })),
  };
}

/** O SHA-256 de um conteúdo, em hexadecimal minúsculo. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** O SHA-256 da forma canônica de um documento. */
export function documentDigest(payload: unknown): string {
  return sha256(canonicalize(payload));
}
