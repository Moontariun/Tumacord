import assert from 'node:assert/strict';
import test from 'node:test';
import { FULL_ACCESS, hasRestrictions, resolveAccess, sanitizePermissions } from '../shared/channelPermissions.js';
import { canDisconnectFromVoice } from '../server/roles.js';

test('sem regra nenhuma, todo mundo pode tudo', () => {
  assert.deepEqual(resolveAccess({}, 'ana', false), FULL_ACCESS);
  assert.equal(hasRestrictions({}), false);
});

test('canal privado: some para todos, e aparece para quem foi liberado', () => {
  const canal = { permissions: { everyone: { view: false }, users: { beto: { view: true } } } };
  assert.equal(resolveAccess(canal, 'ana', false).view, false);
  assert.equal(resolveAccess(canal, 'beto', false).view, true);
  assert.equal(hasRestrictions(canal), true);
});

test('quem não vê o canal não escreve nem entra, mesmo com essas duas permitidas', () => {
  const canal = { permissions: { users: { ana: { view: false, send: true, connect: true, speak: true } } } };
  assert.deepEqual(resolveAccess(canal, 'ana', false), { view: false, send: false, connect: false, speak: false, stream: false });
});

test('falar e transmitir dependem de poder entrar na call', () => {
  const canal = { permissions: { everyone: { connect: false } } };
  const acesso = resolveAccess(canal, 'ana', false);
  assert.equal(acesso.view, true);
  assert.equal(acesso.speak, false);
  assert.equal(acesso.stream, false);
});

test('a exceção da pessoa vence a regra de todos, nos dois sentidos', () => {
  const canal = { permissions: { everyone: { send: false }, users: { ana: { send: true }, beto: { stream: false } } } };
  assert.equal(resolveAccess(canal, 'ana', false).send, true);
  assert.equal(resolveAccess(canal, 'beto', false).send, false);
  assert.equal(resolveAccess(canal, 'beto', false).stream, false);
});

test('a administração pode tudo, qualquer que seja a regra', () => {
  const canal = { permissions: { everyone: { view: false }, users: { dona: { view: false, connect: false } } } };
  assert.deepEqual(resolveAccess(canal, 'dona', true), FULL_ACCESS);
});

test('a limpeza descarta chave desconhecida, valor que não é booleano e pessoa que não existe', () => {
  const limpo = sanitizePermissions({
    everyone: { view: false, apagar: true, send: 'sim' },
    users: { ana: { speak: false }, fantasma: { view: true }, beto: { nada: true } },
  }, new Set(['ana', 'beto']));
  assert.deepEqual(limpo, { everyone: { view: false }, users: { ana: { speak: false } } });
});

test('regras vazias somem em vez de serem guardadas', () => {
  assert.equal(sanitizePermissions({ everyone: {}, users: { ana: {} } }, new Set(['ana'])), undefined);
  assert.equal(sanitizePermissions(null, new Set()), undefined);
  assert.equal(sanitizePermissions(['view'], new Set()), undefined);
});

test('só um dono desconecta outro dono da call; membro não desconecta ninguém', () => {
  assert.equal(canDisconnectFromVoice('admin', 'member'), true);
  assert.equal(canDisconnectFromVoice('admin', 'admin'), true);
  assert.equal(canDisconnectFromVoice('admin', 'owner'), false);
  assert.equal(canDisconnectFromVoice('owner', 'owner'), true);
  assert.equal(canDisconnectFromVoice('member', 'member'), false);
});
