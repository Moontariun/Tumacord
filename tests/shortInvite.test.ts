import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeInviteServer, decodeShortInvite, encodeInviteServer, encodeShortInvite } from '../shared/directLink';
import { INVITE_TOKEN_LENGTH, createInviteToken, normalizeInviteToken } from '../server/auth';

const TOKEN = '7K3P9QXM2W4V';

// O motivo de existir: o convite anterior chegava a 240 caracteres, e quase
// metade era a chave de acesso do servidor viajando em texto colável.
test('o convite curto cabe em uma linha, e é muito menor que o antigo', () => {
  const code = encodeShortInvite({ server: 'https://call.exemplo.com', token: TOKEN })!;
  assert.equal(code, 'TUMA2~call.exemplo.com~7K3P9QXM2W4V');
  assert.ok(code.length < 60, `convite com ${code.length} caracteres`);
});

test('servidor caseiro em IP e porta também cabe', () => {
  const code = encodeShortInvite({ server: 'http://200.9.155.102:4600', token: TOKEN })!;
  assert.equal(code, 'TUMA2~-200.9.155.102:4600~7K3P9QXM2W4V');
  assert.deepEqual(decodeShortInvite(code), { server: 'http://200.9.155.102:4600', token: TOKEN });
});

// O `-` é o que distingue `http` de `https` sem gastar oito caracteres.
test('o esquema sobrevive à ida e à volta, e a porta padrão não é escrita', () => {
  assert.equal(encodeInviteServer('https://call.exemplo.com:443'), 'call.exemplo.com');
  assert.equal(encodeInviteServer('http://call.exemplo.com:80'), '-call.exemplo.com');
  assert.equal(decodeInviteServer('call.exemplo.com'), 'https://call.exemplo.com');
  assert.equal(decodeInviteServer('-call.exemplo.com'), 'http://call.exemplo.com');
});

test('código adulterado, truncado ou de outro formato é recusado', () => {
  assert.equal(decodeShortInvite('TUMA2~call.exemplo.com~CURTO'), null);
  assert.equal(decodeShortInvite('TUMA1~call.exemplo.com~7K3P9QXM2W4V'), null);
  assert.equal(decodeShortInvite('TUMA2~call.exemplo.com'), null);
  assert.equal(decodeShortInvite('qualquer coisa'), null, 'texto solto não é convite');
  assert.equal(decodeShortInvite('TUMA2~call.exemplo.com/caminho~7K3P9QXM2W4V'), null, 'host com caminho não passa');
});

// Um convite é ditado ao telefone e colado com espaço em volta.
test('espaço, minúsculas e quebra de linha não invalidam o código', () => {
  const esperado = { server: 'https://call.exemplo.com', token: TOKEN };
  assert.deepEqual(decodeShortInvite('  TUMA2~call.exemplo.com~7k3p9qxm2w4v \n'), esperado);
});

test('o token evita os caracteres que se confundem ao digitar', () => {
  for (let i = 0; i < 200; i += 1) {
    const token = createInviteToken();
    assert.equal(token.length, INVITE_TOKEN_LENGTH);
    assert.doesNotMatch(token, /[ILOU01]/, `token ambíguo: ${token}`);
  }
});

test('a normalização preserva o alfabeto e descarta o resto', () => {
  assert.equal(normalizeInviteToken(' 7k3p9-qxm2w4v '), TOKEN);
  assert.equal(normalizeInviteToken('OIL01'), '', 'os excluídos não viram token');
});
