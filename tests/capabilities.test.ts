import assert from 'node:assert/strict';
import test from 'node:test';
import { describeMissing, mergeCapabilities, missingCapabilities, readCapabilities, supports } from '../src/lib/capabilities';

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

// O bug: `/api/health` que não responde produzia exatamente o mesmo objeto de
// um servidor da 0.8.0 — nenhuma capability. O painel então trocava a tela
// inteira por "este servidor ainda não tem gerenciamento de canais", no meio
// de uma sessão em que a pessoa acabara de usar o painel. Sob carga alta isso
// acontecia e se desfazia sozinho, que é a forma "some e volta".
test('consulta que falhou não é a mesma coisa que servidor sem o recurso', () => {
  const semResposta = readCapabilities(null);
  assert.equal(semResposta.status, 'unknown');
  assert.deepEqual(missingCapabilities(semResposta, ['adminChannels', 'adminUsers', 'adminAudit']), []);
  assert.equal(describeMissing(semResposta, ['adminChannels', 'adminUsers', 'adminAudit']), '');
});

test('servidor que respondeu continua podendo ser declarado incompleto', () => {
  const respondeu = readCapabilities({ version: '0.8.0' });
  assert.equal(respondeu.status, 'known');
  assert.match(describeMissing(respondeu, ['adminChannels']), /gerenciamento de canais/);
});

test('o que o servidor já disse saber fazer sobrevive a uma consulta perdida', () => {
  const conhecido = readCapabilities({ version: '0.8.4', capabilities: { adminChannels: true, adminUsers: true, adminAudit: true } });
  const depoisDaFalha = mergeCapabilities(conhecido, readCapabilities(null));
  assert.equal(supports(depoisDaFalha, 'adminChannels'), true);
  assert.equal(depoisDaFalha.version, '0.8.4');
  // E uma resposta de verdade continua mandando, inclusive para tirar algo.
  const rebaixado = mergeCapabilities(conhecido, readCapabilities({ version: '0.8.0' }));
  assert.equal(supports(rebaixado, 'adminChannels'), false);
});

test('sem nunca ter respondido, a falha não inventa conhecimento', () => {
  const nada = mergeCapabilities(null, readCapabilities(undefined));
  assert.equal(nada.status, 'unknown');
  assert.equal(supports(nada, 'turn'), false);
});
