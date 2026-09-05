import assert from 'node:assert/strict';
import test from 'node:test';
import { describeMissing, missingCapabilities, readCapabilities, supports } from '../src/lib/capabilities';

const novo = readCapabilities({ version: '0.8.1', capabilities: { turn: true, roles: true, adminChannels: true, adminUsers: true, adminAudit: true, mediaDiagnostics: true } });

test('o servidor novo declara o que sabe fazer', () => {
  assert.equal(novo.version, '0.8.1');
  assert.equal(supports(novo, 'adminChannels'), true);
  assert.deepEqual(missingCapabilities(novo, ['turn', 'roles']), []);
  assert.equal(describeMissing(novo, ['turn', 'roles']), '');
});

// Servidor anterior à 0.8.1 não responde `capabilities`. Ausência é lida como
// "não tem", que é a leitura segura.
test('servidor antigo, sem o campo, é tratado como não tendo nada disso', () => {
  const antigo = readCapabilities({ version: '0.8.0' });
  assert.equal(supports(antigo, 'adminChannels'), false);
  assert.deepEqual(missingCapabilities(antigo, ['adminChannels', 'adminUsers']), ['adminChannels', 'adminUsers']);
});

test('resposta corrompida não vira permissão', () => {
  for (const entrada of [null, undefined, 'texto', 42, { capabilities: 'sim' }, { capabilities: { turn: 'sim' } }]) {
    assert.equal(supports(readCapabilities(entrada), 'turn'), false, `entrada ${JSON.stringify(entrada)} não pode virar sim`);
  }
});

test('capability explicitamente desligada é respeitada', () => {
  const semRelay = readCapabilities({ version: '0.8.1', capabilities: { turn: false, adminChannels: true } });
  assert.equal(supports(semRelay, 'turn'), false);
  assert.equal(supports(semRelay, 'adminChannels'), true);
});

// A mensagem precisa dizer o que fazer, sem pedir para comparar versões.
test('a mensagem nomeia o que falta e o que fazer', () => {
  const antigo = readCapabilities({ version: '0.8.0' });
  const uma = describeMissing(antigo, ['adminChannels']);
  assert.match(uma, /gerenciamento de canais/);
  assert.match(uma, /0\.8\.0/);
  assert.match(uma, /Atualize o servidor/);
  const varias = describeMissing(antigo, ['adminChannels', 'adminUsers', 'adminAudit']);
  assert.match(varias, /gerenciamento de canais, gerenciamento de usuários e registro de auditoria/);
});

test('servidor sem versão informada ainda produz mensagem útil', () => {
  const mensagem = describeMissing(readCapabilities({}), ['turn']);
  assert.match(mensagem, /relay TURN/);
  assert.equal(mensagem.includes('Ele está na'), false);
});
