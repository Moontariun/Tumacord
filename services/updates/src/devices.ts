// Quem pode baixar uma atualização.
//
// ## Por que não é a sessão do chat
//
// O serviço de atualização precisa funcionar **enquanto o dedicado está
// reiniciando** — que é exatamente o momento de uma atualização. Se a
// autorização de download dependesse da sessão do chat, atualizar o servidor
// derrubaria a capacidade de atualizar o servidor.
//
// E há a outra metade: o cliente atualiza na tela de login e em P2P, sem estar
// conectado a dedicado nenhum. Uma pessoa que nunca entrou no chat precisa
// conseguir se manter em dia.
//
// ## Por que não é um segredo embutido
//
// Um segredo global dentro do executável não é autorização: ele é o mesmo para
// todo mundo, vaza no primeiro `strings` e não pode ser revogado sem trocar o
// executável de todos. O cadastro inicial exige um **convite**, obtido por
// canal privado, que vale uma vez e tem prazo.
//
// ## Escopo
//
// Uma credencial de download **só baixa**. Ela não publica, não retira versão
// e não aplica nada no servidor. Administrar o catálogo é outra autorização,
// por outro caminho, e não é uma promoção do usuário do chat.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Quanto tempo um convite vale. Curto: ele viaja por fora. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** Quanto tempo uma credencial de download vale antes de precisar renovar. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type DeviceScope = 'download';

export interface DeviceRecord {
  deviceId: string;
  /** Só o hash. Um vazamento do arquivo não pode virar credencial usável. */
  tokenHash: string;
  /** Nome que o dono reconhece na lista: "Windows do Caio". */
  label: string;
  scope: DeviceScope[];
  createdAt: string;
  expiresAt: number;
  lastSeenAt?: string;
  revokedAt?: string;
  revokedReason?: string;
}

export interface InviteRecord {
  /** Só o hash, pelo mesmo motivo. */
  tokenHash: string;
  label: string;
  createdAt: string;
  expiresAt: number;
  usedAt?: string;
  usedByDeviceId?: string;
}

export type AuthFailure = 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'wrong-scope';

export type AuthResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; failure: AuthFailure };

/** Mensagens úteis, e não "não autorizado" para tudo. */
export const AUTH_MESSAGES: Record<AuthFailure, string> = {
  missing: 'Este dispositivo ainda não foi autorizado a baixar atualizações. Peça um convite ao dono do servidor.',
  malformed: 'A credencial deste dispositivo está corrompida. Peça um convite novo ao dono do servidor.',
  unknown: 'Esta credencial não é reconhecida. Ela pode ter sido removida; peça um convite novo ao dono do servidor.',
  revoked: 'O acesso deste dispositivo foi revogado pelo dono do servidor.',
  expired: 'A credencial deste dispositivo venceu. O aplicativo vai tentar renovar sozinho; se não conseguir, peça um convite novo.',
  'wrong-scope': 'Esta credencial não tem permissão para esta operação.',
};

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compara dois hashes em tempo constante.
 *
 * Comparar com `===` vaza, pelo tempo, quantos caracteres iniciais coincidem —
 * o bastante para descobrir um token um caractere por vez.
 */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateToken(): string {
  return randomBytes(48).toString('base64url');
}

/** O token de um cabeçalho `Authorization: Bearer …`, ou vazio. */
export function bearerToken(header: unknown): string {
  if (typeof header !== 'string') return '';
  const found = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return found?.[1] ?? '';
}

/**
 * Autoriza um pedido de download.
 *
 * A busca é pelo hash do token apresentado, e não por um id que o cliente
 * mande junto: mandar o id deixaria o servidor escolher qual registro comparar,
 * e comparar o registro que o atacante escolheu é metade do caminho.
 */
export function authorize(devices: readonly DeviceRecord[], token: string, scope: DeviceScope, now: number): AuthResult {
  if (!token) return { ok: false, failure: 'missing' };
  if (!TOKEN_PATTERN.test(token)) return { ok: false, failure: 'malformed' };
  const hash = hashToken(token);
  const found = devices.find((device) => hashesMatch(device.tokenHash, hash));
  if (!found) return { ok: false, failure: 'unknown' };
  if (found.revokedAt) return { ok: false, failure: 'revoked' };
  if (found.expiresAt <= now) return { ok: false, failure: 'expired' };
  if (!found.scope.includes(scope)) return { ok: false, failure: 'wrong-scope' };
  return { ok: true, device: found };
}

export type EnrollFailure = 'invite-missing' | 'invite-malformed' | 'invite-unknown' | 'invite-used' | 'invite-expired';

export type EnrollResult =
  | { ok: true; device: DeviceRecord; token: string; invite: InviteRecord }
  | { ok: false; failure: EnrollFailure };

export const ENROLL_MESSAGES: Record<EnrollFailure, string> = {
  'invite-missing': 'Informe o convite recebido do dono do servidor.',
  'invite-malformed': 'Esse convite não tem o formato esperado. Confira se ele foi copiado por inteiro.',
  'invite-unknown': 'Esse convite não é reconhecido.',
  'invite-used': 'Esse convite já foi usado. Peça outro ao dono do servidor.',
  'invite-expired': 'Esse convite venceu. Peça outro ao dono do servidor.',
};

/**
 * Troca um convite por uma credencial de dispositivo.
 *
 * O convite vale **uma vez**. Um convite reutilizável seria um segredo
 * compartilhado com outro nome: quem o repassasse daria acesso a todo mundo
 * que o recebesse, e revogar um dispositivo não tiraria o acesso dos outros.
 */
export function enroll(
  invites: readonly InviteRecord[],
  inviteToken: string,
  label: string,
  now: number,
  makeId: () => string = () => randomBytes(12).toString('hex'),
  makeToken: () => string = generateToken,
): EnrollResult {
  if (!inviteToken) return { ok: false, failure: 'invite-missing' };
  if (!TOKEN_PATTERN.test(inviteToken)) return { ok: false, failure: 'invite-malformed' };
  const hash = hashToken(inviteToken);
  const invite = invites.find((candidate) => hashesMatch(candidate.tokenHash, hash));
  if (!invite) return { ok: false, failure: 'invite-unknown' };
  if (invite.usedAt) return { ok: false, failure: 'invite-used' };
  if (invite.expiresAt <= now) return { ok: false, failure: 'invite-expired' };

  const token = makeToken();
  const device: DeviceRecord = {
    deviceId: makeId(),
    tokenHash: hashToken(token),
    label: sanitizeLabel(label) || invite.label || 'dispositivo',
    scope: ['download'],
    createdAt: new Date(now).toISOString(),
    expiresAt: now + TOKEN_TTL_MS,
  };
  return { ok: true, device, token, invite: { ...invite, usedAt: new Date(now).toISOString(), usedByDeviceId: device.deviceId } };
}

/**
 * Renova uma credencial que ainda vale.
 *
 * Renovar exige a credencial atual válida: uma renovação que aceitasse
 * credencial vencida ou revogada devolveria acesso a quem o dono acabou de
 * tirar. Quem perdeu o prazo passa por um convite novo, e isso é dito.
 */
export function renew(device: DeviceRecord, now: number, makeToken: () => string = generateToken): { device: DeviceRecord; token: string } {
  const token = makeToken();
  return {
    device: { ...device, tokenHash: hashToken(token), expiresAt: now + TOKEN_TTL_MS, lastSeenAt: new Date(now).toISOString() },
    token,
  };
}

/** O rótulo que aparece na lista do dono, sem controle e sem exagero. */
export function sanitizeLabel(label: unknown): string {
  if (typeof label !== 'string') return '';
  // Caracteres de controle saem: este rótulo vai para um painel e para um log,
  // e um `\r` no meio de uma linha de log esconde o que vem depois dela.
  return label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
}

/** Um convite novo, para o dono passar por canal privado. */
export function createInvite(label: string, now: number, makeToken: () => string = generateToken): { invite: InviteRecord; token: string } {
  const token = makeToken();
  return {
    invite: {
      tokenHash: hashToken(token),
      label: sanitizeLabel(label) || 'dispositivo',
      createdAt: new Date(now).toISOString(),
      expiresAt: now + INVITE_TTL_MS,
    },
    token,
  };
}

/**
 * O que a lista do dono mostra.
 *
 * Sem hash nenhum: esta lista aparece num painel e pode acabar num print.
 */
export function publicDevice(device: DeviceRecord): Omit<DeviceRecord, 'tokenHash'> {
  const { tokenHash: _hidden, ...rest } = device;
  return rest;
}
