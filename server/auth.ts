import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export function normalizeUsername(username: string): string {
  return username.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, hash] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifySecret(provided: string, expected: string): boolean {
  const providedHash = Buffer.from(hashToken(provided), 'hex');
  const expectedHash = Buffer.from(hashToken(expected), 'hex');
  return timingSafeEqual(providedHash, expectedHash);
}

// Prova de identidade do host no enlace direto: quem tem o convite consegue
// conferir que o endereço alcançado é mesmo a call esperada, e não um servidor
// qualquer que passou a ocupar aquele IP e porta. A chave nunca sai daqui.
export function proveKey(key: string, nonce: string): string {
  return createHmac('sha256', key).update(nonce, 'utf8').digest('base64url');
}
