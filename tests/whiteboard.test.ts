import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_POINTS_PER_BOARD_STROKE,
  applyBoardOp,
  boardSnapshot,
  canManageBoard,
  compactBoardLog,
  countBoardPoints,
  documentToView,
  emptyBoardState,
  fitBoard,
  normalizeBoardName,
  recoverBoard,
  replayBoard,
  roleFor,
  roleMayDraw,
  strokeAt,
  viewToDocument,
  zoomAround,
  type BoardOp,
  type BoardOpEnvelope,
  type BoardState,
} from '../shared/whiteboard';

// Um servidor de mentirinha, com a única regra que importa: a operação aceita
// ganha o próximo número, e a recusada não ganha número nenhum. É essa
// sequência densa que faz a deduplicação e a detecção de lacuna funcionarem
// nas duas pontas com a mesma comparação.
function ordenador(manager: (author: string) => boolean = () => false) {
  let state: BoardState = emptyBoardState();
  const log: BoardOpEnvelope[] = [];
  const recusas: string[] = [];
  const enviar = (author: string, authorName: string, op: BoardOp, at = 1_000 + log.length) => {
    const envelope: BoardOpEnvelope = { id: op.id, rev: state.revision + 1, author, authorName, at, op };
    const outcome = applyBoardOp(state, envelope, { manager: manager(author) });
    if (outcome.status !== 'applied') {
      recusas.push(outcome.status === 'refused' ? outcome.error : outcome.status);
      return undefined;
    }
    state = outcome.state;
    log.push(envelope);
    return envelope;
  };
  return { enviar, log, recusas, get state() { return state; } };
}

function traco(id: string, pontos: Array<[number, number]>, extra: Partial<Extract<BoardOp, { kind: 'stroke' }>> = {}): BoardOp {
  return { id: `${id}#${extra.stroke ? 'mais' : 'inicio'}`, kind: 'stroke', stroke: id, color: '#5cc8ff', width: 4, points: pontos.map(([x, y]) => ({ x, y })), ...extra };
}

// --- coordenadas de documento ----------------------------------------------

// A mesa vale em unidades da folha, e não em pixels de janela. Duas pessoas
// com telas diferentes, uma com zoom e outra sem, precisam ver o traço no
// mesmo lugar do desenho.
test('o mesmo ponto do documento cai no mesmo lugar do desenho em janelas diferentes', () => {
  const pequena = fitBoard(800, 450);
  const grande = fitBoard(2560, 1440);
  const meio = { x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 };
  const naPequena = documentToView(meio, pequena);
  const naGrande = documentToView(meio, grande);
  assert.ok(Math.abs(naPequena.x / 800 - naGrande.x / 2560) < 1e-9);
  assert.ok(Math.abs(naPequena.y / 450 - naGrande.y / 1440) < 1e-9);
});

test('o ponteiro volta ao mesmo ponto do documento depois de ir e voltar', () => {
  const view = { scale: 2.5, offsetX: 300, offsetY: 120 };
  const documento = viewToDocument(410, 260, view);
  const tela = documentToView(documento, view);
  assert.ok(Math.abs(tela.x - 410) < 1e-9);
  assert.ok(Math.abs(tela.y - 260) < 1e-9);
});

test('o zoom no ponteiro não arrasta o ponto que está embaixo dele', () => {
  const antes = { scale: 1, offsetX: 0, offsetY: 0 };
  const ancora = viewToDocument(640, 360, antes);
  const depois = zoomAround(antes, 640, 360, 2);
  const aindaAli = viewToDocument(640, 360, depois);
  assert.ok(Math.abs(aindaAli.x - ancora.x) < 1e-6);
  assert.ok(Math.abs(aindaAli.y - ancora.y) < 1e-6);
});

test('ponto fora da folha é preso na borda, e não recusado', () => {
  const fora = viewToDocument(-500, 99_999, { scale: 1, offsetX: 0, offsetY: 0 });
  assert.deepEqual(fora, { x: 0, y: BOARD_HEIGHT });
});

// --- convergência, entrada tardia e reconexão -------------------------------

test('três pessoas desenhando ao mesmo tempo convergem para o mesmo quadro', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('t-ana', [[10, 10], [20, 20]]));
  servidor.enviar('bia', 'Bia', traco('t-bia', [[30, 30], [40, 40]]));
  servidor.enviar('caio', 'Caio', traco('t-caio', [[50, 50], [60, 60]]));
  servidor.enviar('ana', 'Ana', traco('t-ana', [[25, 25]], { stroke: 't-ana' }));

  // Cada uma aplica o mesmo log na ordem das revisões e chega no mesmo lugar.
  const quadros = ['ana', 'bia', 'caio'].map(() => replayBoard({ revision: 0, strokes: [] }, servidor.log));
  for (const quadro of quadros) assert.deepEqual(quadro, servidor.state);
  assert.equal(servidor.state.strokes.length, 3);
  assert.equal(servidor.state.strokes.find((stroke) => stroke.id === 't-ana')?.points.length, 3);
});

test('quem entra depois recebe o snapshot e as mudanças posteriores, inclusive as do carregamento', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('t1', [[10, 10]]));
  servidor.enviar('bia', 'Bia', traco('t2', [[20, 20]]));
  // O snapshot que a pessoa recebeu foi tirado aqui…
  const snapshot = boardSnapshot(servidor.state);
  // …e o desenho continuou enquanto ela carregava.
  servidor.enviar('caio', 'Caio', traco('t3', [[30, 30]]));
  servidor.enviar('ana', 'Ana', traco('t4', [[40, 40]]));

  const posteriores = servidor.log.filter((envelope) => envelope.rev > snapshot.revision);
  const quemChegou = replayBoard(snapshot, posteriores);
  assert.deepEqual(quemChegou, servidor.state);
  assert.deepEqual(quemChegou.strokes.map((stroke) => stroke.id), ['t1', 't2', 't3', 't4']);
});

test('reconectar e receber de novo o que já foi aplicado não desenha duas vezes', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('t1', [[10, 10], [11, 11]]));
  servidor.enviar('ana', 'Ana', traco('t1', [[12, 12]], { stroke: 't1' }));
  servidor.enviar('bia', 'Bia', traco('t2', [[20, 20]]));

  let cliente = replayBoard({ revision: 0, strokes: [] }, servidor.log);
  const antes = JSON.parse(JSON.stringify(cliente)) as BoardState;
  // A reentrega da reconexão traz exatamente as mesmas operações.
  for (const envelope of servidor.log) {
    const outcome = applyBoardOp(cliente, envelope);
    assert.equal(outcome.status, 'duplicate');
    if (outcome.status === 'applied') cliente = outcome.state;
  }
  assert.deepEqual(cliente, antes);
  assert.equal(countBoardPoints(cliente.strokes), 4);
});

test('a operação que salta uma revisão é reconhecida como lacuna, e não aplicada torta', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('t1', [[1, 1]]));
  servidor.enviar('ana', 'Ana', traco('t2', [[2, 2]]));
  servidor.enviar('ana', 'Ana', traco('t3', [[3, 3]]));

  let cliente = emptyBoardState();
  const primeira = applyBoardOp(cliente, servidor.log[0]);
  assert.equal(primeira.status, 'applied');
  if (primeira.status === 'applied') cliente = primeira.state;
  // A segunda se perdeu no caminho; a terceira chega sozinha.
  const salto = applyBoardOp(cliente, servidor.log[2]);
  assert.equal(salto.status, 'gap');
  assert.equal(cliente.strokes.length, 1);

  // Pedir recuperação a partir da revisão que se tem devolve o que falta.
  const recuperacao = recoverBoard({ revision: 0, strokes: [] }, servidor.log, cliente.revision);
  assert.equal(recuperacao.mode, 'ops');
  if (recuperacao.mode !== 'ops') return;
  for (const envelope of recuperacao.ops) {
    const outcome = applyBoardOp(cliente, envelope);
    if (outcome.status === 'applied') cliente = outcome.state;
  }
  assert.deepEqual(cliente, servidor.state);
});

test('quem ficou para trás do snapshot recebe o quadro inteiro em vez de uma diferença impossível', () => {
  const servidor = ordenador();
  for (let indice = 0; indice < 40; indice += 1) servidor.enviar('ana', 'Ana', traco(`t${indice}`, [[indice, indice]]));
  const compactado = compactBoardLog({ revision: 0, strokes: [] }, servidor.log, 10);
  assert.equal(compactado.compacted, true);

  const atrasado = recoverBoard(compactado.snapshot, compactado.log, 3);
  assert.equal(atrasado.mode, 'snapshot');
  if (atrasado.mode !== 'snapshot') return;
  assert.deepEqual(replayBoard(atrasado.snapshot, atrasado.ops), servidor.state);
});

// --- o que a mesa não pode fazer -------------------------------------------

// O desenho sobre a live guarda no máximo 64 traços e descarta o mais antigo.
// Numa mesa isso seria apagar o trabalho de alguém para caber o de outro.
test('passar de 64 traços não apaga os primeiros', () => {
  const servidor = ordenador();
  for (let indice = 0; indice < 150; indice += 1) {
    servidor.enviar('ana', 'Ana', traco(`t${indice}`, [[indice % 100, indice % 100]]));
  }
  assert.equal(servidor.state.strokes.length, 150);
  assert.equal(servidor.state.strokes[0].id, 't0');
  assert.equal(servidor.state.strokes[63].id, 't63');
  assert.equal(servidor.recusas.length, 0);
});

test('no teto de traços a mesa recusa o novo com mensagem, e não derruba os antigos', () => {
  const servidor = ordenador();
  for (let indice = 0; indice < 5; indice += 1) servidor.enviar('ana', 'Ana', traco(`t${indice}`, [[indice, indice]]));
  const antes = servidor.state;
  const envelope: BoardOpEnvelope = { id: 'x', rev: antes.revision + 1, author: 'ana', authorName: 'Ana', at: 9, op: traco('t-novo', [[9, 9]]) };
  const outcome = applyBoardOp(antes, envelope, { maxStrokes: 5 });
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.match(outcome.error, /limite de 5 traços/);
  assert.match(outcome.error, /nada do que já está desenhado será removido/);
  assert.equal(antes.strokes.length, 5);
  assert.equal(antes.strokes[0].id, 't0');
});

test('no teto de armazenamento a mesa recusa pontos novos, e os desenhados continuam lá', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('t1', [[1, 1], [2, 2], [3, 3]]));
  const envelope: BoardOpEnvelope = { id: 'x', rev: servidor.state.revision + 1, author: 'bia', authorName: 'Bia', at: 9, op: traco('t2', [[4, 4], [5, 5]]) };
  const outcome = applyBoardOp(servidor.state, envelope, { maxPoints: 4 });
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.match(outcome.error, /limite de armazenamento/);
  assert.equal(countBoardPoints(servidor.state.strokes), 3);
});

test('o traço que encosta no teto de pontos para de crescer sem perder o começo', () => {
  const servidor = ordenador();
  const muitos = Array.from({ length: MAX_POINTS_PER_BOARD_STROKE + 50 }, (_valor, indice) => [indice % BOARD_WIDTH, 10] as [number, number]);
  servidor.enviar('ana', 'Ana', traco('longo', muitos));
  const longo = servidor.state.strokes[0];
  assert.equal(longo.points.length, MAX_POINTS_PER_BOARD_STROKE);
  assert.deepEqual(longo.points[0], { x: 0, y: 10 });

  // Continuar o mesmo traço depois do teto não derruba nada nem falha feio.
  servidor.enviar('ana', 'Ana', traco('longo', [[500, 500]], { stroke: 'longo' }));
  assert.equal(servidor.state.strokes[0].points.length, MAX_POINTS_PER_BOARD_STROKE);
  assert.deepEqual(servidor.state.strokes[0].points[0], { x: 0, y: 10 });
});

// --- desfazer, borracha e permissão ----------------------------------------

test('desfazer não apaga o trabalho alheio', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('da-ana', [[1, 1]]));
  servidor.enviar('bia', 'Bia', traco('da-bia', [[2, 2]]));

  // A Bia tenta desfazer o traço da Ana, que por acaso nem é o último.
  const recusado = applyBoardOp(servidor.state, { id: 'u1', rev: servidor.state.revision + 1, author: 'bia', authorName: 'Bia', at: 5, op: { id: 'u1', kind: 'undo', target: 'da-ana' } });
  assert.equal(recusado.status, 'refused');
  if (recusado.status === 'refused') assert.match(recusado.error, /só para o que você mesmo desenhou/);

  // E desfazer o próprio traço funciona, mesmo com outro por cima.
  servidor.enviar('bia', 'Bia', { id: 'u2', kind: 'undo', target: 'da-bia' });
  assert.deepEqual(servidor.state.strokes.map((stroke) => stroke.id), ['da-ana']);
});

test('nem quem gerencia desfaz pelo desfazer o traço de outra pessoa', () => {
  const servidor = ordenador((author) => author === 'dona');
  servidor.enviar('ana', 'Ana', traco('da-ana', [[1, 1]]));
  servidor.enviar('dona', 'Dona', { id: 'u1', kind: 'undo', target: 'da-ana' });
  assert.equal(servidor.state.strokes.length, 1);
  assert.match(servidor.recusas[0], /só para o que você mesmo desenhou/);
});

test('a borracha apaga o traço inteiro de quem desenhou, e quem gerencia apaga o dos outros', () => {
  const servidor = ordenador((author) => author === 'dona');
  servidor.enviar('ana', 'Ana', traco('da-ana', [[1, 1], [2, 2]]));
  servidor.enviar('bia', 'Bia', traco('da-bia', [[3, 3]]));

  // A Bia não apaga o traço da Ana.
  servidor.enviar('bia', 'Bia', { id: 'e1', kind: 'erase', targets: ['da-ana'] });
  assert.equal(servidor.state.strokes.length, 2);
  assert.match(servidor.recusas[0], /só apaga os seus traços/);

  // Apaga o dela inteiro, e não um pedaço.
  servidor.enviar('bia', 'Bia', { id: 'e2', kind: 'erase', targets: ['da-bia'] });
  assert.deepEqual(servidor.state.strokes.map((stroke) => stroke.id), ['da-ana']);

  // Quem gerencia apaga o que sobrou.
  servidor.enviar('dona', 'Dona', { id: 'e3', kind: 'erase', targets: ['da-ana'] });
  assert.equal(servidor.state.strokes.length, 0);
});

test('continuar o traço de outra pessoa é recusado', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('da-ana', [[1, 1]]));
  servidor.enviar('bia', 'Bia', traco('da-ana', [[50, 50]], { stroke: 'da-ana' }));
  assert.match(servidor.recusas[0], /de outra pessoa/);
  assert.equal(servidor.state.strokes[0].points.length, 1);
});

test('limpar tudo é de quem gerencia a mesa', () => {
  const servidor = ordenador((author) => author === 'dona');
  servidor.enviar('ana', 'Ana', traco('t1', [[1, 1]]));
  servidor.enviar('ana', 'Ana', { id: 'c1', kind: 'clear' });
  assert.equal(servidor.state.strokes.length, 1);
  assert.match(servidor.recusas[0], /de quem a criou ou administra/);
  servidor.enviar('dona', 'Dona', { id: 'c2', kind: 'clear' });
  assert.equal(servidor.state.strokes.length, 0);
});

test('bloquear a mesa e revogar alguém tiram a permissão de desenhar, não a de ver', () => {
  const mesa = { createdBy: 'dona', locked: false };
  const convidada = { userId: 'ana', username: 'Ana' };
  assert.equal(roleFor(mesa, convidada, false), 'drawer');
  assert.equal(roleFor(mesa, convidada, true), 'observer');
  assert.equal(roleFor({ ...mesa, locked: true }, convidada, false), 'observer');
  // Quem gerencia continua podendo mexer na mesa que bloqueou.
  assert.equal(roleFor({ ...mesa, locked: true }, { userId: 'dona', username: 'Dona' }, false), 'manager');
  assert.equal(roleMayDraw('observer'), false);
  assert.equal(canManageBoard(mesa, { userId: 'ana', username: 'Ana', serverAdmin: true }), true);
});

// --- compactação ------------------------------------------------------------

test('compactar o histórico não apaga traço visível', () => {
  const servidor = ordenador();
  for (let indice = 0; indice < 60; indice += 1) servidor.enviar('ana', 'Ana', traco(`t${indice}`, [[indice, indice]]));
  const compactado = compactBoardLog({ revision: 0, strokes: [] }, servidor.log, 20);
  assert.equal(compactado.compacted, true);
  assert.ok(compactado.log.length < servidor.log.length);
  // O snapshot mais o que sobrou continuam dando exatamente o mesmo quadro.
  assert.deepEqual(replayBoard(compactado.snapshot, compactado.log), servidor.state);
  assert.equal(replayBoard(compactado.snapshot, compactado.log).strokes.length, 60);
});

test('compactar duas vezes seguidas continua dando o mesmo quadro', () => {
  const servidor = ordenador();
  for (let indice = 0; indice < 120; indice += 1) servidor.enviar('ana', 'Ana', traco(`t${indice}`, [[indice % 100, 5]]));
  const primeira = compactBoardLog({ revision: 0, strokes: [] }, servidor.log, 20);
  const segunda = compactBoardLog(primeira.snapshot, primeira.log, 4);
  assert.deepEqual(replayBoard(segunda.snapshot, segunda.log), servidor.state);
});

// --- detalhes de interface que moram no modelo ------------------------------

test('a borracha encontra o traço embaixo do ponteiro pela linha, e não só pelos pontos', () => {
  const servidor = ordenador();
  servidor.enviar('ana', 'Ana', traco('reta', [[100, 100], [400, 100]]));
  servidor.enviar('ana', 'Ana', traco('longe', [[100, 900]]));
  assert.equal(strokeAt(servidor.state.strokes, { x: 250, y: 103 })?.id, 'reta');
  assert.equal(strokeAt(servidor.state.strokes, { x: 250, y: 400 }), undefined);
});

test('nome de mesa vazio vira um nome, e nome enorme é cortado', () => {
  assert.equal(normalizeBoardName('   '), 'Mesa sem nome');
  assert.equal(normalizeBoardName('  Plano   da   base '), 'Plano da base');
  assert.equal(normalizeBoardName('x'.repeat(200)).length, 48);
  assert.equal(normalizeBoardName(42), 'Mesa sem nome');
});
