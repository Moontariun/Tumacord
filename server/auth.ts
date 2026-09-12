import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeName } from '../shared/identity.js';

const scrypt = promisify(scryptCallback);

export function normalizeUsername(username: string): string {
  // A regra mora em `shared/identity.ts`: o desktop assina a prova de login
  // com ela, e as duas pontas precisam produzir exatamente o mesmo nome.
  return normalizeName(username);
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

// Alfabeto do token de convite: sem as letras e dígitos que se confundem à
// mão (I, L, O, U, 0, 1), porque um convite é lido em voz alta e digitado
// errado. Doze caracteres deste conjunto dão ~59 bits — muito além do que o
// limitador de tentativas do login deixa alguém testar.
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INVITE_TOKEN_LENGTH = 12;

export function createInviteToken(random = randomBytes): string {
  const bytes = random(INVITE_TOKEN_LENGTH);
  let token = '';
  for (const byte of bytes) token += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  return token;
}

// O alfabeto já exclui os pares que se confundem, então não há para onde
// mapear um `O` ou um `1`: eles simplesmente não são token. Normalizar é
// só aceitar minúsculas e ignorar o que a pessoa colou junto — espaço,
// hífen, quebra de linha.
export function normalizeInviteToken(value: string): string {
  return value.trim().toUpperCase().replace(/[^2-9A-HJ-KM-NP-TV-Z]/g, '');
}
