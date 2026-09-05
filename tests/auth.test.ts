import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashPassword, hashToken, normalizeUsername, verifyPassword, verifySecret } from '../server/auth.js';
import { JsonStore } from '../server/store.js';

test('normaliza o nome sem perder acentos', () => {
  assert.equal(normalizeUsername('  TÓmAté_42 '), 'tómAté_42'.toLocaleLowerCase('pt-BR'));
});

test('senha é armazenada com scrypt e validada', async () => {
  const hash = await hashPassword('amizade123');
  assert.notEqual(hash, 'amizade123');
  assert.equal(await verifyPassword('amizade123', hash), true);
  assert.equal(await verifyPassword('errada', hash), false);
});

test('chaves e tokens são comparados sem persistir o valor original', () => {
  assert.match(hashToken('sessao-secreta'), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken('sessao-secreta'), 'sessao-secreta');
  assert.equal(verifySecret('chave-da-turma', 'chave-da-turma'), true);
  assert.equal(verifySecret('chave-errada', 'chave-da-turma'), false);
});

test('sessões antigas são migradas para hash assim que o armazenamento abre', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-session-migration-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'tumacord.json'), JSON.stringify({
    users: [],
    channels: [],
    messages: [],
    sessions: [{ token: 'token-legado-legivel', userId: 'user-1', expiresAt: Date.now() + 60_000 }],
  }));
  const store = new JsonStore(directory);
  await store.load();
  const persisted = JSON.parse(await readFile(path.join(directory, 'tumacord.json'), 'utf8')) as { sessions: Array<{ token?: string; tokenHash?: string }> };
  assert.equal(persisted.sessions[0].token, undefined);
  assert.equal(persisted.sessions[0].tokenHash, hashToken('token-legado-legivel'));
});
