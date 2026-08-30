import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, normalizeUsername, verifyPassword } from '../server/auth.js';

test('normaliza o nome sem perder acentos', () => {
  assert.equal(normalizeUsername('  TÓmAté_42 '), 'tómAté_42'.toLocaleLowerCase('pt-BR'));
});

test('senha é armazenada com scrypt e validada', async () => {
  const hash = await hashPassword('amizade123');
  assert.notEqual(hash, 'amizade123');
  assert.equal(await verifyPassword('amizade123', hash), true);
  assert.equal(await verifyPassword('errada', hash), false);
});
