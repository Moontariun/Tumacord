// Papéis do servidor: owner, admin, member.
//
// Até aqui não existia conceito de papel. Ser administrador era ter o nome
// igual à variável de ambiente `ADMIN_USERNAME`, comparado a cada requisição.
// Isso significa que promover alguém exigia reiniciar o contêiner, e que mudar
// a variável trocava silenciosamente quem manda no servidor.
//
// Três papéis bastam para tudo que o painel precisa. `moderator` e permissões
// por canal ficam de fora de propósito: elas só fazem sentido com permissão
// por recurso, que é outro tamanho de trabalho.
//
// A regra que sustenta o resto: **um servidor nunca pode ficar sem owner**.
// Toda operação que reduziria o número de owners a zero é recusada, venha de
// onde vier.

export type Role = 'owner' | 'admin' | 'member';

export const ROLES: readonly Role[] = ['owner', 'admin', 'member'];

export function normalizeRole(value: unknown): Role {
  return value === 'owner' || value === 'admin' ? value : 'member';
}

// `isAdmin` continua existindo para clientes antigos, que não conhecem papéis.
export function isAdministrator(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

export function canManageChannels(role: Role): boolean {
  return isAdministrator(role);
}

export function canManageUsers(role: Role): boolean {
  return isAdministrator(role);
}

// Só owner mexe em owner. Um admin que pudesse promover a owner poderia se
// promover — e aí a distinção entre os dois papéis não existiria.
export function canAssignRole(actor: Role, target: Role, next: Role): boolean {
  if (!isAdministrator(actor)) return false;
  if (target === 'owner' || next === 'owner') return actor === 'owner';
  return true;
}

export interface RoleChangeRequest {
  actorId: string;
  actorRole: Role;
  targetId: string;
  targetRole: Role;
  nextRole: Role;
  ownerCount: number;
}

export interface RoleChangeVerdict {
  allowed: boolean;
  error?: string;
}

export function planRoleChange(request: RoleChangeRequest): RoleChangeVerdict {
  if (request.targetRole === request.nextRole) return { allowed: false, error: 'Esse usuário já tem esse papel.' };
  if (!canAssignRole(request.actorRole, request.targetRole, request.nextRole)) {
    return { allowed: false, error: 'Somente o dono do servidor altera donos.' };
  }
  // Rebaixar o último owner deixaria o servidor sem ninguém capaz de
  // administrá-lo, inclusive de desfazer o próprio rebaixamento.
  if (request.targetRole === 'owner' && request.nextRole !== 'owner' && request.ownerCount <= 1) {
    return { allowed: false, error: 'O servidor precisa de pelo menos um dono. Promova outra pessoa antes.' };
  }
  return { allowed: true };
}

export interface RemovalRequest {
  actorId: string;
  actorRole: Role;
  targetId: string;
  targetRole: Role;
  ownerCount: number;
}

export function planRemoval(request: RemovalRequest): RoleChangeVerdict {
  if (!canManageUsers(request.actorRole)) return { allowed: false, error: 'Ação exclusiva da administração do servidor.' };
  if (request.targetId === request.actorId) return { allowed: false, error: 'Você não pode remover a própria conta por aqui.' };
  if (request.targetRole === 'owner' && request.actorRole !== 'owner') {
    return { allowed: false, error: 'Somente o dono do servidor remove donos.' };
  }
  if (request.targetRole === 'owner' && request.ownerCount <= 1) {
    return { allowed: false, error: 'O servidor precisa de pelo menos um dono.' };
  }
  return { allowed: true };
}

export interface RoleCarrier {
  id: string;
  normalizedUsername: string;
  role?: Role;
}

export interface RoleMigration<T extends RoleCarrier> {
  users: T[];
  changed: boolean;
  ownerId: string | null;
}

// Migração vinda da 0.8.0, onde papel não existia.
//
// A variável de ambiente vira o owner inicial e depois perde o poder: se
// alguém trocar `ADMIN_USERNAME` amanhã, o owner de ontem continua sendo o
// owner. Sem isso, mudar uma variável de ambiente sequestraria o servidor.
export function migrateRoles<T extends RoleCarrier>(users: readonly T[], adminUsername: string): RoleMigration<T> {
  const existentes = users.map((user) => ({ ...user }));
  const jaTemOwner = existentes.some((user) => user.role === 'owner');
  let changed = false;
  for (const user of existentes) {
    if (user.role === undefined) {
      user.role = 'member';
      changed = true;
    }
  }
  if (!jaTemOwner) {
    // O primeiro dono é quem a variável apontava. Se esse nome não existe
    // entre as contas, a conta mais antiga assume — um servidor sem dono não
    // teria como ganhar um.
    const escolhido = existentes.find((user) => user.normalizedUsername === adminUsername) ?? existentes[0];
    if (escolhido) {
      escolhido.role = 'owner';
      changed = true;
    }
  }
  const owner = existentes.find((user) => user.role === 'owner') ?? null;
  return { users: existentes, changed, ownerId: owner ? owner.id : null };
}

export function countOwners(users: readonly RoleCarrier[]): number {
  return users.filter((user) => user.role === 'owner').length;
}

// Quem entra em um servidor recém-criado e ainda não tem dono vira o dono.
// É o caminho normal de quem sobe o contêiner e faz a primeira conta.
export function roleForNewUser(users: readonly RoleCarrier[], normalizedUsername: string, adminUsername: string): Role {
  if (countOwners(users) === 0) return 'owner';
  return normalizedUsername === adminUsername ? 'admin' : 'member';
}
