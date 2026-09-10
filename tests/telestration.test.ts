import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAW_LIFETIMES,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  STROKE_LIFETIME_MS,
  applyDrawMessage,
  drawSupportedOn,
  dropAuthor,
  expireStrokes,
  fadeFor,
  fitFrame,
  isPersistent,
  parseDrawLifetime,
  pointFromViewport,
  pointToViewport,
  pointsAreFarEnough,
  sanitizePoints,
  strokeOpacity,
  type DrawStroke,
} from '../shared/telestration';

const autor = { author: 'socket-a', authorName: 'Amiga' };

// --- geometria -------------------------------------------------------------

// O vídeo quase nunca ocupa o elemento inteiro. Desenhar sem descontar as
// barras pretas desloca o traço na tela de quem recebe, e o erro cresce quanto
// mais diferentes forem as duas janelas.
test('o quadro é encaixado no elemento com as barras certas', () => {
  // 16:9 dentro de um elemento 4:3 — sobram barras em cima e embaixo.
  const alto = fitFrame({ width: 800, height: 600, frameWidth: 1920, frameHeight: 1080 })!;
  assert.equal(alto.width, 800);
  assert.equal(alto.height, 450);
  assert.equal(alto.left, 0);
  assert.equal(alto.top, 75);

  // 16:9 dentro de um elemento muito largo — barras dos lados.
  const largo = fitFrame({ width: 1600, height: 400, frameWidth: 1920, frameHeight: 1080 })!;
  assert.equal(largo.height, 400);
  assert.ok(Math.abs(largo.width - 711.11) < 0.1);
  assert.ok(largo.left > 0 && largo.top === 0);
});

test('elemento ou quadro sem tamanho não produz geometria inventada', () => {
  for (const v of [
    { width: 0, height: 600, frameWidth: 1920, frameHeight: 1080 },
    { width: 800, height: 600, frameWidth: 0, frameHeight: 1080 },
    { width: 800, height: 600, frameWidth: 1920, frameHeight: 0 },
  ]) assert.equal(fitFrame(v), null);
});

// O ponto precisa significar o mesmo nas duas pontas: quem desenha em uma
// janela de 600 px e quem transmite em 4K têm de ver o traço no mesmo lugar.
test('um ponto sobrevive à viagem entre janelas de tamanhos diferentes', () => {
  const quemDesenha = { width: 800, height: 600, frameWidth: 1920, frameHeight: 1080 };
  const quemRecebe = { width: 2560, height: 1440, frameWidth: 1920, frameHeight: 1080 };

  // Centro exato da imagem em quem desenha: x = 400, y = 75 + 225 = 300.
  const ponto = pointFromViewport(400, 300, quemDesenha)!;
  assert.ok(Math.abs(ponto.x - 0.5) < 1e-9);
  assert.ok(Math.abs(ponto.y - 0.5) < 1e-9);

  const naOutraTela = pointToViewport(ponto, quemRecebe)!;
  assert.ok(Math.abs(naOutraTela.x - 1280) < 1e-9, 'o centro precisa continuar no centro');
  assert.ok(Math.abs(naOutraTela.y - 720) < 1e-9);
});

test('clique na barra preta não vira traço', () => {
  const viewport = { width: 800, height: 600, frameWidth: 1920, frameHeight: 1080 };
  assert.equal(pointFromViewport(400, 10, viewport), null, 'barra de cima');
  assert.equal(pointFromViewport(400, 590, viewport), null, 'barra de baixo');
  assert.notEqual(pointFromViewport(400, 300, viewport), null, 'dentro da imagem, sim');
});

test('um canto continua sendo o canto, sem escorregar para fora', () => {
  const viewport = { width: 800, height: 600, frameWidth: 1920, frameHeight: 1080 };
  const cantoSuperior = pointFromViewport(0, 75, viewport)!;
  assert.deepEqual(cantoSuperior, { x: 0, y: 0 });
  const cantoInferior = pointFromViewport(800, 525, viewport)!;
  assert.deepEqual(cantoInferior, { x: 1, y: 1 });
});

test('pontos colados demais são descartados para não inchar o traço', () => {
  assert.equal(pointsAreFarEnough(undefined, { x: 0.5, y: 0.5 }), true, 'o primeiro sempre entra');
  assert.equal(pointsAreFarEnough({ x: 0.5, y: 0.5 }, { x: 0.5001, y: 0.5 }), false);
  assert.equal(pointsAreFarEnough({ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 }), true);
});

// --- prazo do traço --------------------------------------------------------

test('o padrão some sozinho, e some suave em vez de piscar', () => {
  const traco: DrawStroke = { id: 's1', ...autor, color: '#ff5c5c', points: [{ x: 0.5, y: 0.5 }], at: 0 };
  assert.equal(strokeOpacity(traco, 0), 1);
  assert.equal(strokeOpacity(traco, 3_000), 1, 'ainda cheio no meio da vida');
  assert.ok(strokeOpacity(traco, 5_000) > 0 && strokeOpacity(traco, 5_000) < 1, 'desaparecendo');
  assert.equal(strokeOpacity(traco, STROKE_LIFETIME_MS), 0);
  assert.equal(strokeOpacity(traco, 60_000), 0);
});

// O que o usuário pediu: poder deixar o desenho parado na tela.
test('sem prazo, o traço não desbota nem vence', () => {
  const traco: DrawStroke = { id: 's1', ...autor, color: '#ff5c5c', points: [{ x: 0.5, y: 0.5 }], at: 0 };
  assert.equal(isPersistent(0), true);
  assert.equal(strokeOpacity(traco, 60 * 60_000, 0), 1, 'uma hora depois continua inteiro');
  assert.deepEqual(expireStrokes([traco], 60 * 60_000, 0), [traco]);
});

test('cada prazo tem o próprio desaparecimento, sempre menor que a vida', () => {
  for (const { value } of DRAW_LIFETIMES) {
    const fade = fadeFor(value);
    if (value === 0) {
      assert.equal(fade, 0);
      continue;
    }
    assert.ok(fade > 0 && fade <= value / 3 + 1e-9, `prazo ${value} com desaparecimento ${fade}`);
  }
});

test('prazo vindo do fio só vale se for um dos oferecidos', () => {
  for (const { value } of DRAW_LIFETIMES) assert.equal(parseDrawLifetime(value), value);
  for (const lixo of [null, undefined, -1, 1, 999, 'sempre', {}, Number.NaN, Infinity, 6_001]) {
    assert.equal(parseDrawLifetime(lixo), STROKE_LIFETIME_MS, `aceitou ${JSON.stringify(lixo)}`);
  }
});

test('o prazo vencido tira o traço da lista, e o não vencido fica', () => {
  const velho: DrawStroke = { id: 'v', ...autor, color: '#fff', points: [{ x: 0, y: 0 }], at: 0 };
  const novo: DrawStroke = { id: 'n', ...autor, color: '#fff', points: [{ x: 0, y: 0 }], at: 5_000 };
  assert.deepEqual(expireStrokes([velho, novo], 7_000).map((s) => s.id), ['n']);
  // Sem nada a expirar, a mesma lista volta — não adianta re-renderizar à toa.
  const lista = [novo];
  assert.equal(expireStrokes(lista, 5_100), lista);
});

// --- acervo ----------------------------------------------------------------

test('um traço chega em pedaços e vira uma linha só', () => {
  let strokes = applyDrawMessage([], { target: 't', strokeId: 's1', color: '#52d789', points: [{ x: 0.1, y: 0.1 }], ...autor }, 100);
  strokes = applyDrawMessage(strokes, { target: 't', strokeId: 's1', color: '#52d789', points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }], ...autor }, 200);
  assert.equal(strokes.length, 1);
  assert.deepEqual(strokes[0].points.map((p) => p.x), [0.1, 0.2, 0.3]);
  assert.equal(strokes[0].at, 200, 'o relógio do traço anda com o último ponto');
});

test('duas pessoas desenhando ao mesmo tempo não se misturam', () => {
  const outra = { author: 'socket-b', authorName: 'Amigo' };
  let strokes = applyDrawMessage([], { target: 't', strokeId: 's1', color: '#ff5c5c', points: [{ x: 0.1, y: 0.1 }], ...autor }, 100);
  strokes = applyDrawMessage(strokes, { target: 't', strokeId: 's1', color: '#5cc8ff', points: [{ x: 0.9, y: 0.9 }], ...outra }, 100);
  assert.equal(strokes.length, 2, 'mesmo id de traço, autores diferentes: são dois traços');
  assert.deepEqual(strokes.map((s) => s.author), ['socket-a', 'socket-b']);
});

test('cada um limpa o que é seu; quem transmite limpa tudo', () => {
  const outra = { author: 'socket-b', authorName: 'Amigo' };
  let strokes = applyDrawMessage([], { target: 't', strokeId: 'a', color: '#fff', points: [{ x: 0.1, y: 0.1 }], ...autor }, 0);
  strokes = applyDrawMessage(strokes, { target: 't', strokeId: 'b', color: '#fff', points: [{ x: 0.2, y: 0.2 }], ...outra }, 0);

  const soDoOutro = applyDrawMessage(strokes, { target: 't', strokeId: '', color: '#fff', points: [], clear: true, ...autor }, 0);
  assert.deepEqual(soDoOutro.map((s) => s.author), ['socket-b'], 'limpar o meu não apaga o dos outros');

  const nada = applyDrawMessage(strokes, { target: 't', strokeId: '', color: '#fff', points: [], clearAll: true, ...autor }, 0);
  assert.deepEqual(nada, []);
});

test('quem sai da call leva os próprios traços', () => {
  const outra = { author: 'socket-b', authorName: 'Amigo' };
  let strokes = applyDrawMessage([], { target: 't', strokeId: 'a', color: '#fff', points: [{ x: 0.1, y: 0.1 }], ...autor }, 0);
  strokes = applyDrawMessage(strokes, { target: 't', strokeId: 'b', color: '#fff', points: [{ x: 0.2, y: 0.2 }], ...outra }, 0);
  assert.deepEqual(dropAuthor(strokes, 'socket-a').map((s) => s.author), ['socket-b']);
  const iguais = dropAuthor(strokes, 'socket-c');
  assert.equal(iguais, strokes, 'sem nada a tirar, a mesma lista volta');
});

// --- limites, que é onde mora a proteção contra um cliente falante ---------

test('coordenada fora da faixa é grampeada, e lixo é descartado', () => {
  const pontos = sanitizePoints([
    { x: -3, y: 0.5 }, { x: 0.5, y: 9 }, { x: 'meio', y: 0.5 },
    { x: Number.NaN, y: 0.5 }, { x: Infinity, y: 0.5 }, null, 'ponto', { x: 0.25, y: 0.75 },
  ]);
  assert.deepEqual(pontos, [{ x: 0, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0.25, y: 0.75 }]);
  assert.deepEqual(sanitizePoints('nada'), []);
  assert.deepEqual(sanitizePoints(undefined), []);
});

test('um traço interminável é cortado, não recusado', () => {
  const muitos = Array.from({ length: MAX_POINTS_PER_STROKE * 3 }, (_, i) => ({ x: i / 10_000, y: 0.5 }));
  assert.equal(sanitizePoints(muitos).length, MAX_POINTS_PER_STROKE);

  let strokes = applyDrawMessage([], { target: 't', strokeId: 's', color: '#fff', points: muitos, ...autor }, 0);
  for (let i = 0; i < 5; i += 1) {
    strokes = applyDrawMessage(strokes, { target: 't', strokeId: 's', color: '#fff', points: muitos, ...autor }, i);
  }
  assert.equal(strokes[0].points.length, MAX_POINTS_PER_STROKE, 'o traço não cresce sem fim');
});

test('o teto de traços derruba o mais velho, nunca o que está sendo desenhado', () => {
  let strokes: DrawStroke[] = [];
  for (let i = 0; i < MAX_STROKES + 20; i += 1) {
    strokes = applyDrawMessage(strokes, { target: 't', strokeId: `s${i}`, color: '#fff', points: [{ x: 0.5, y: 0.5 }], ...autor }, i);
  }
  assert.equal(strokes.length, MAX_STROKES);
  assert.equal(strokes.at(-1)?.id, `s${MAX_STROKES + 19}`, 'o mais novo continua lá');
  assert.equal(strokes[0].id, `s20`, 'os mais velhos é que saíram');
});

// Sem prazo, o teto é a única coisa que segura a memória. Precisa segurar.
test('sem prazo, o teto ainda segura mil traços', () => {
  let strokes: DrawStroke[] = [];
  for (let i = 0; i < 1_000; i += 1) {
    strokes = applyDrawMessage(strokes, { target: 't', strokeId: `s${i}`, color: '#fff', points: [{ x: 0.5, y: 0.5 }], ...autor }, i);
    strokes = expireStrokes(strokes, i, 0);
  }
  assert.equal(strokes.length, MAX_STROKES);
});

test('cor inventada cai na cor padrão em vez de virar CSS solto', () => {
  for (const cor of ['red', 'javascript:alert(1)', '#xyzxyz', '', 42, null, 'url(evil)']) {
    const strokes = applyDrawMessage([], { target: 't', strokeId: 's', color: cor as string, points: [{ x: 0.5, y: 0.5 }], ...autor }, 0);
    assert.match(strokes[0].color, /^#[0-9a-f]{6}$/i, `aceitou a cor ${JSON.stringify(cor)}`);
  }
});

test('mensagem sem ponto nenhum não cria traço vazio', () => {
  const strokes = applyDrawMessage([], { target: 't', strokeId: 's', color: '#fff', points: [], ...autor }, 0);
  assert.deepEqual(strokes, []);
});

// A regra que a 0.9.0 acrescentou: receber desenho é do Windows. No Linux a
// janela sobreposta rouba o foco do teclado de quem está jogando e ainda volta
// dentro da captura do portal, então nem a preferência de quem transmite
// consegue ligar isso — e o servidor recusa o traço do mesmo jeito.
test('só o Windows recebe desenho sobre a transmissão', () => {
  assert.equal(drawSupportedOn('win32'), true);
  for (const sistema of ['linux', 'darwin', 'freebsd', '', undefined, null, 42, 'Win32', 'windows']) {
    assert.equal(drawSupportedOn(sistema), false, `aceitou ${JSON.stringify(sistema)}`);
  }
});
