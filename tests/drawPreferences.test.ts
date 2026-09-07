import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DRAW_PREFERENCES, sanitizeDrawPreferences } from '../src/lib/drawPreferences';
import { STROKE_LIFETIME_MS } from '../shared/telestration';

test('o padrão deixa o desenho ligado, com prazo normal', () => {
  assert.equal(DEFAULT_DRAW_PREFERENCES.allowDraw, true);
  assert.equal(DEFAULT_DRAW_PREFERENCES.drawLifetime, STROKE_LIFETIME_MS);
});

test('preferência corrompida no armazenamento não vira permissão nem CSS solto', () => {
  for (const lixo of [null, undefined, 'texto', 42, [], { allowDraw: 'sim', drawLifetime: 'sempre', drawColor: 'url(evil)' }]) {
    const limpo = sanitizeDrawPreferences(lixo);
    assert.equal(typeof limpo.allowDraw, 'boolean');
    assert.equal(limpo.drawLifetime, STROKE_LIFETIME_MS);
    assert.match(limpo.drawColor, /^#[0-9a-f]{6}$/i);
  }
});

test('desligar o desenho é respeitado na volta', () => {
  assert.equal(sanitizeDrawPreferences({ allowDraw: false }).allowDraw, false);
});

test('"não apagar sozinho" sobrevive a ida e volta', () => {
  assert.equal(sanitizeDrawPreferences({ drawLifetime: 0 }).drawLifetime, 0);
  assert.equal(sanitizeDrawPreferences({ drawLifetime: 15_000 }).drawLifetime, 15_000);
  assert.equal(sanitizeDrawPreferences({ drawLifetime: 7_777 }).drawLifetime, STROKE_LIFETIME_MS, 'valor inventado cai no padrão');
});

// A cor do perfil serve de padrão para cada um sair com a própria cor sem
// configurar nada.
test('a cor do perfil vira a cor do traço quando não há escolha salva', () => {
  assert.equal(sanitizeDrawPreferences({}, '#52d789').drawColor, '#52d789');
  assert.equal(sanitizeDrawPreferences({ drawColor: '#5cc8ff' }, '#52d789').drawColor, '#5cc8ff', 'a escolha vence o perfil');
  assert.match(sanitizeDrawPreferences({}, 'vermelho').drawColor, /^#[0-9a-f]{6}$/i, 'perfil inválido cai no padrão');
});
