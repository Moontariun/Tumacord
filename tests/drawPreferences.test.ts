import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DRAW_PREFERENCES, defaultDesktopOverlay, sanitizeDrawPreferences } from '../src/lib/drawPreferences';
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

// A sobreposição sobre a área de trabalho passou a ser opcional na 0.8.9.
// Medindo no KDE/Wayland, mapear aquela janela tira o foco de teclado de quem
// estava digitando — e não devolve para ninguém. Quem estiver jogando perde o
// controle do jogo no momento em que alguém aponta algo na live.
test('a sobreposição sobre a área de trabalho nasce desligada no Linux e ligada no Windows', () => {
  assert.equal(defaultDesktopOverlay('linux'), false);
  assert.equal(defaultDesktopOverlay('win32'), true);
  assert.equal(defaultDesktopOverlay(''), false, 'sem aplicativo instalado não existe sobreposição');
  assert.equal(sanitizeDrawPreferences(null, undefined, 'linux').desktopOverlay, false);
  assert.equal(sanitizeDrawPreferences(null, undefined, 'win32').desktopOverlay, true);
});

test('quem ligou a sobreposição continua com ela ligada, em qualquer sistema', () => {
  assert.equal(sanitizeDrawPreferences({ desktopOverlay: true }, undefined, 'linux').desktopOverlay, true);
  assert.equal(sanitizeDrawPreferences({ desktopOverlay: false }, undefined, 'win32').desktopOverlay, false);
  // Valor inválido cai no padrão da plataforma, não em "ligado".
  assert.equal(sanitizeDrawPreferences({ desktopOverlay: 'sim' }, undefined, 'linux').desktopOverlay, false);
});

test('desligar a sobreposição não desliga o desenho', () => {
  const preferencias = sanitizeDrawPreferences({ allowDraw: true, desktopOverlay: false }, undefined, 'linux');
  assert.equal(preferencias.allowDraw, true, 'o traço continua aparecendo no app e no vídeo de quem assiste');
  assert.equal(preferencias.desktopOverlay, false);
});
