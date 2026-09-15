import assert from 'node:assert/strict';
import test from 'node:test';
import { bestStageLayout } from '../src/lib/stageLayout.js';

test('três lives num palco largo ficam duas em cima e uma centralizada embaixo', () => {
  const layout = bestStageLayout(3, 1400, 800, 12);
  assert.equal(layout.columns, 2);
  assert.equal(layout.rows, 2);
  // Maior que os três em linha, que dariam ~458 px de largura cada.
  assert.ok(layout.tileWidth > 600, `largura ${layout.tileWidth}`);
});

test('duas lives num palco alto e estreito ficam uma sobre a outra', () => {
  const layout = bestStageLayout(2, 700, 1000, 12);
  assert.equal(layout.columns, 1);
  assert.equal(layout.rows, 2);
});

test('duas lives num palco largo ficam lado a lado', () => {
  const layout = bestStageLayout(2, 1600, 600, 12);
  assert.equal(layout.columns, 2);
  assert.equal(layout.rows, 1);
});

test('os quadros cabem no palco e mantêm a proporção de uma tela', () => {
  for (const count of [2, 3, 4, 5, 6, 7, 9]) {
    const width = 1280;
    const height = 720;
    const layout = bestStageLayout(count, width, height, 12);
    assert.ok(layout.columns * layout.rows >= count, `${count}: faltou lugar`);
    assert.ok(layout.columns * layout.tileWidth + (layout.columns - 1) * 12 <= width + 1, `${count}: estourou a largura`);
    assert.ok(layout.rows * layout.tileHeight + (layout.rows - 1) * 12 <= height + 1, `${count}: estourou a altura`);
    assert.ok(Math.abs(layout.tileWidth / layout.tileHeight - 16 / 9) < 0.02, `${count}: proporção`);
  }
});

test('palco sem tamanho ainda não produz quadro nenhum', () => {
  assert.deepEqual(bestStageLayout(3, 0, 0), { columns: 1, rows: 1, tileWidth: 0, tileHeight: 0 });
  assert.deepEqual(bestStageLayout(0, 800, 600), { columns: 1, rows: 1, tileWidth: 0, tileHeight: 0 });
});
