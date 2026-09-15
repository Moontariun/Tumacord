// Quem vê e faz o quê em cada canal.
//
// Uma regra só, usada pelo servidor para decidir e pelo aplicativo para
// desenhar. Quem decide de verdade continua sendo o servidor: esconder o
// composer de quem não pode escrever é conveniência, e um cliente alterado que
// mande a mensagem assim mesmo esbarra na mesma função, do outro lado.
//
// ## A ordem de precedência
//
// 1. administração (dono e admin) pode tudo, sempre — um canal que trancasse
//    para fora quem precisa destrancá-lo não teria conserto pela interface;
// 2. a exceção da pessoa, se houver para aquela ação;
// 3. a regra de "todos" do canal, se houver;
// 4. pode.
//
// `view` é a porta das outras: quem não vê o canal não escreve nele nem entra
// na call dele, mesmo que alguém tenha marcado essas duas como permitidas. E
// falar e transmitir dependem de poder entrar.

import type { Channel, ChannelAccess, ChannelPermissionKey, ChannelPermissions, ChannelType } from './types.js';

export const PERMISSION_KEYS: readonly ChannelPermissionKey[] = ['view', 'send', 'connect', 'speak', 'stream'];

/** As ações que fazem sentido em cada tipo de canal, na ordem da tela. */
export const PERMISSIONS_BY_TYPE: Record<ChannelType, readonly ChannelPermissionKey[]> = {
  text: ['view', 'send'],
  voice: ['view', 'connect', 'speak', 'stream'],
};

export const PERMISSION_LABEL: Record<ChannelPermissionKey, string> = {
  view: 'Ver o canal',
  send: 'Enviar mensagens',
  connect: 'Entrar na call',
  speak: 'Falar',
  stream: 'Transmitir a tela',
};

export const FULL_ACCESS: ChannelAccess = { view: true, send: true, connect: true, speak: true, stream: true };

/** Teto de exceções por canal: o arquivo de dados não é lugar para crescer sem limite. */
export const MAX_PERMISSION_OVERRIDES = 500;

export function resolveAccess(channel: Pick<Channel, 'permissions'>, userId: string, administrator: boolean): ChannelAccess {
  if (administrator) return { ...FULL_ACCESS };
  const everyone = channel.permissions?.everyone ?? {};
  const own = channel.permissions?.users?.[userId] ?? {};
  const allowed = (key: ChannelPermissionKey) => own[key] ?? everyone[key] ?? true;
  const view = allowed('view');
  const connect = view && allowed('connect');
  return {
    view,
    send: view && allowed('send'),
    connect,
    speak: connect && allowed('speak'),
    stream: connect && allowed('stream'),
  };
}

/** O canal tem alguma regra que tira algo de alguém? */
export function hasRestrictions(channel: Pick<Channel, 'permissions'>): boolean {
  const { everyone, users } = channel.permissions ?? {};
  const nega = (regra: Partial<ChannelAccess> | undefined) => Boolean(regra && Object.values(regra).some((valor) => valor === false));
  return nega(everyone) || Object.values(users ?? {}).some(nega);
}

function sanitizeRule(input: unknown): Partial<ChannelAccess> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const regra: Partial<ChannelAccess> = {};
  for (const chave of PERMISSION_KEYS) {
    const valor = (input as Record<string, unknown>)[chave];
    if (typeof valor === 'boolean') regra[chave] = valor;
  }
  return Object.keys(regra).length ? regra : undefined;
}

/**
 * Limpa as regras que chegaram pela rede.
 *
 * Só chaves conhecidas, só booleanos, só pessoas que existem neste servidor.
 * Uma regra vazia some em vez de ser guardada: "herdar tudo" é a ausência de
 * regra, e guardar `{}` faria o arquivo dizer a mesma coisa de dois jeitos.
 */
export function sanitizePermissions(input: unknown, knownUserIds: ReadonlySet<string>): ChannelPermissions | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const bruto = input as { everyone?: unknown; users?: unknown };
  const everyone = sanitizeRule(bruto.everyone);
  const users: Record<string, Partial<ChannelAccess>> = {};
  if (bruto.users && typeof bruto.users === 'object' && !Array.isArray(bruto.users)) {
    for (const [userId, regraBruta] of Object.entries(bruto.users as Record<string, unknown>)) {
      if (Object.keys(users).length >= MAX_PERMISSION_OVERRIDES) break;
      if (!knownUserIds.has(userId)) continue;
      const regra = sanitizeRule(regraBruta);
      if (regra) users[userId] = regra;
    }
  }
  if (!everyone && !Object.keys(users).length) return undefined;
  return { ...(everyone ? { everyone } : {}), ...(Object.keys(users).length ? { users } : {}) };
}
