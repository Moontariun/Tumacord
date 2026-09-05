import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAssignRole,
  canManageChannels,
  countOwners,
  isAdministrator,
  migrateRoles,
  normalizeRole,
  planRemoval,
  planRoleChange,
  roleForNewUser,
  type Role,
  type RoleCarrier,
} from '../server/roles';

const conta = (id: string, nome: string, role?: Role): RoleCarrier => ({ id, normalizedUsername: nome, role });

test('papel desconhecido cai em member, nunca em administrador', () => {
  assert.equal(normalizeRole('owner'), 'owner');
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('member'), 'member');
  assert.equal(normalizeRole('superadmin'), 'member');
  assert.equal(normalizeRole(undefined), 'member');
  assert.equal(normalizeRole(null), 'member');
  assert.equal(normalizeRole(1), 'member');
});

test('owner e admin administram; member não', () => {
  assert.equal(isAdministrator('owner'), true);
  assert.equal(isAdministrator('admin'), true);
  assert.equal(isAdministrator('member'), false);
  assert.equal(canManageChannels('member'), false);
});

// Se um admin pudesse promover a owner, ele poderia se promover — e a
// distinção entre os dois papéis deixaria de existir.
test('só owner mexe em owner', () => {
  assert.equal(canAssignRole('owner', 'member', 'admin'), true);
  assert.equal(canAssignRole('owner', 'admin', 'owner'), true);
  assert.equal(canAssignRole('owner', 'owner', 'member'), true);
  assert.equal(canAssignRole('admin', 'member', 'admin'), true);
  assert.equal(canAssignRole('admin', 'member', 'owner'), false, 'admin não promove a owner');
  assert.equal(canAssignRole('admin', 'owner', 'admin'), false, 'admin não rebaixa owner');
  assert.equal(canAssignRole('member', 'member', 'admin'), false);
});

// A regra que sustenta o resto: o servidor nunca fica sem dono.
test('o último owner não pode ser rebaixado, nem por ele mesmo', () => {
  const sozinho = { actorId: 'a', actorRole: 'owner' as Role, targetId: 'a', targetRole: 'owner' as Role, nextRole: 'admin' as Role, ownerCount: 1 };
  assert.equal(planRoleChange(sozinho).allowed, false);
  assert.match(planRoleChange(sozinho).error ?? '', /pelo menos um dono/);
  assert.equal(planRoleChange({ ...sozinho, ownerCount: 2 }).allowed, true, 'com dois donos, um pode sair');
});

test('promover não esbarra na proteção do último dono', () => {
  assert.equal(planRoleChange({ actorId: 'a', actorRole: 'owner', targetId: 'b', targetRole: 'member', nextRole: 'owner', ownerCount: 1 }).allowed, true);
});

test('atribuir o papel que a pessoa já tem é recusado em vez de virar ruído', () => {
  const verdito = planRoleChange({ actorId: 'a', actorRole: 'owner', targetId: 'b', targetRole: 'admin', nextRole: 'admin', ownerCount: 1 });
  assert.equal(verdito.allowed, false);
  assert.match(verdito.error ?? '', /já tem esse papel/);
});

test('remover conta respeita as mesmas proteções', () => {
  assert.equal(planRemoval({ actorId: 'a', actorRole: 'member', targetId: 'b', targetRole: 'member', ownerCount: 1 }).allowed, false);
  assert.equal(planRemoval({ actorId: 'a', actorRole: 'admin', targetId: 'a', targetRole: 'admin', ownerCount: 1 }).allowed, false, 'não se remove por aqui');
  assert.equal(planRemoval({ actorId: 'a', actorRole: 'admin', targetId: 'b', targetRole: 'owner', ownerCount: 2 }).allowed, false, 'admin não remove owner');
  assert.equal(planRemoval({ actorId: 'a', actorRole: 'owner', targetId: 'b', targetRole: 'owner', ownerCount: 1 }).allowed, false, 'último owner não sai');
  assert.equal(planRemoval({ actorId: 'a', actorRole: 'owner', targetId: 'b', targetRole: 'owner', ownerCount: 2 }).allowed, true);
  assert.equal(planRemoval({ actorId: 'a', actorRole: 'admin', targetId: 'b', targetRole: 'member', ownerCount: 1 }).allowed, true);
});

// Migração vinda da 0.8.0, onde papel não existia.
test('a variável de ambiente vira o dono inicial, e todo o resto vira member', () => {
  const migrado = migrateRoles([conta('1', 'renan'), conta('2', 'fulano'), conta('3', 'ciclana')], 'renan');
  assert.equal(migrado.changed, true);
  assert.equal(migrado.ownerId, '1');
  assert.deepEqual(migrado.users.map((u) => u.role), ['owner', 'member', 'member']);
});

// Sem isso, trocar uma variável de ambiente sequestraria o servidor.
test('depois de migrado, mudar a variável não troca o dono', () => {
  const primeiro = migrateRoles([conta('1', 'renan'), conta('2', 'fulano')], 'renan');
  const segundo = migrateRoles(primeiro.users, 'fulano');
  assert.equal(segundo.ownerId, '1', 'o dono continua sendo quem já era');
  assert.equal(segundo.changed, false, 'nada a migrar na segunda passada');
  assert.equal(segundo.users.find((u) => u.id === '2')?.role, 'member');
});

test('nome da variável que não existe entre as contas não deixa o servidor sem dono', () => {
  const migrado = migrateRoles([conta('1', 'fulano'), conta('2', 'ciclana')], 'ninguem');
  assert.equal(migrado.ownerId, '1', 'a conta mais antiga assume');
  assert.equal(countOwners(migrado.users), 1);
});

test('servidor sem conta nenhuma migra sem quebrar', () => {
  const migrado = migrateRoles([], 'renan');
  assert.deepEqual(migrado.users, []);
  assert.equal(migrado.ownerId, null);
});

test('a migração não altera os objetos originais', () => {
  const original = [conta('1', 'renan')];
  migrateRoles(original, 'renan');
  assert.equal(original[0].role, undefined, 'a lista de entrada fica intacta');
});

test('quem cria a primeira conta de um servidor vazio vira o dono', () => {
  assert.equal(roleForNewUser([], 'qualquer', 'renan'), 'owner');
  assert.equal(roleForNewUser([conta('1', 'renan', 'owner')], 'fulano', 'renan'), 'member');
  assert.equal(roleForNewUser([conta('1', 'outro', 'owner')], 'renan', 'renan'), 'admin', 'o nome da variável ainda entra como admin');
});

test('a contagem de donos enxerga só quem é dono', () => {
  assert.equal(countOwners([conta('1', 'a', 'owner'), conta('2', 'b', 'admin'), conta('3', 'c'), conta('4', 'd', 'owner')]), 2);
  assert.equal(countOwners([]), 0);
});
