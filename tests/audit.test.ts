import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAudit, createAuditEntry, MAX_AUDIT_ENTRIES, MAX_DETAIL, redactDetail, type AuditEntry } from '../server/audit';

// Uma sequência longa e contínua é tratada como possível segredo, mesmo que
// não seja: prefere-se apagar demais a deixar passar.
test('sequência longa e contínua é tratada como segredo, por precaução', () => {
  assert.equal(redactDetail('d'.repeat(400)), '[removido]');
});

test('a entrada registra quem, o quê, em quê e com que resultado', () => {
  const entrada = createAuditEntry({ id: '1', actorId: 'u1', actorUsername: 'Renan', action: 'channel.delete', target: '#teste', at: new Date('2026-09-05T12:00:00Z') });
  assert.deepEqual(entrada, { id: '1', at: '2026-09-05T12:00:00.000Z', actorId: 'u1', actorUsername: 'Renan', action: 'channel.delete', target: '#teste', result: 'ok' });
});

// A redação não é confiada à disciplina de quem escreve a chamada.
test('o que parece segredo é cortado antes de ser guardado', () => {
  assert.equal(redactDetail('authorization: Bearer abc123def456'), 'authorization: [removido]');
  assert.equal(redactDetail('convite TUMA1.eyJhbGciOi.0ed4dbf enviado'), 'convite [removido] enviado');
  assert.equal(redactDetail('senha=minha-senha-secreta'), '[removido]');
  assert.equal(redactDetail('token: abc'), '[removido]');
  assert.match(redactDetail('chave ' + 'a'.repeat(64)) ?? '', /\[removido\]/);
});

test('detalhe vazio ou não textual simplesmente não entra', () => {
  assert.equal(redactDetail(''), undefined);
  assert.equal(redactDetail('   '), undefined);
  assert.equal(redactDetail(undefined), undefined);
  assert.equal(redactDetail(42), undefined);
  assert.equal(createAuditEntry({ id: '1', actorId: 'u', actorUsername: 'x', action: 'a', detail: '' }).detail, undefined);
});

test('campos longos são truncados em vez de inflar o registro', () => {
  // O detalhe usa palavras separadas de propósito: uma sequência longa e
  // contínua seria cortada antes pela redação, que a trata como possível
  // segredo — e aí este teste mediria a redação, não o truncamento.
  const entrada = createAuditEntry({ id: '1', actorId: 'u', actorUsername: 'n'.repeat(80), action: 'a'.repeat(80), target: 't'.repeat(200), detail: 'canal renomeado '.repeat(30) });
  assert.equal(entrada.actorUsername.length, 24);
  assert.equal(entrada.action.length, 48);
  assert.equal(entrada.target?.length, 80);
  assert.equal(entrada.detail?.length, MAX_DETAIL);
  assert.match(entrada.detail ?? '', /^canal renomeado/, 'o começo do detalhe sobrevive');
});

// O registro é uma janela, não um arquivo eterno dentro do mesmo JSON das
// mensagens.
test('o registro guarda os mais recentes primeiro e não cresce sem limite', () => {
  let registro: AuditEntry[] = [];
  for (let i = 0; i < MAX_AUDIT_ENTRIES + 40; i += 1) {
    registro = appendAudit(registro, createAuditEntry({ id: String(i), actorId: 'u', actorUsername: 'x', action: 'acao' }));
  }
  assert.equal(registro.length, MAX_AUDIT_ENTRIES);
  assert.equal(registro[0].id, String(MAX_AUDIT_ENTRIES + 39), 'o mais recente fica no topo');
});

test('resultado negado é registrado como tal, não omitido', () => {
  const negado = createAuditEntry({ id: '1', actorId: 'u', actorUsername: 'x', action: 'user.role', result: 'denied', detail: 'admin não promove a dono' });
  assert.equal(negado.result, 'denied');
  assert.match(negado.detail ?? '', /não promove/);
});
