import assert from 'node:assert/strict';
import test from 'node:test';
import { safeAttachmentName } from '../shared/attachmentName.js';

test('nome de anexo preserva acentos sem permitir caminho ou controles', () => {
  assert.equal(safeAttachmentName('../ pasta\\relatório QA #1.txt'), 'relatório QA #1.txt');
  assert.equal(safeAttachmentName('foto\u0000.png'), 'foto.png');
  assert.equal(safeAttachmentName('../../'), 'arquivo');
});

test('nome reservado do Windows não é entregue diretamente ao download', () => {
  assert.equal(safeAttachmentName('CON.txt'), '_CON.txt');
  assert.equal(safeAttachmentName('normal.webp'), 'normal.webp');
});
