import assert from 'node:assert/strict';
import test from 'node:test';
import { beginDraft, endDraft, extendDraft, idleDraft, settleDraft } from '../src/lib/boardDraft';
import type { BoardStroke } from '../shared/whiteboard';

// O defeito da 0.9.2, no tamanho de um teste.
//
// Relato: clicar deixava um ponto, arrastar não deixava linha. A causa não era
// o ponteiro, a coordenada nem o desenho — era o traço da mão ser esquecido no
// meio do arrasto, assim que o servidor confirmava o primeiro ponto. Numa rede
// local isso leva milissegundos.
//
// Um laço de teste apertado nunca via nada: nele a confirmação não chega no
// meio do movimento. O que reproduz é o ritmo de uma mão — e é essa ordem de
// acontecimentos que os casos abaixo percorrem.

function traco(id: string, pontos: Array<[number, number]>): BoardStroke {
  return { id, author: 'ana', authorName: 'Ana', color: '#5cc8ff', width: 4, points: pontos.map(([x, y]) => ({ x, y })), at: 1_000 };
}

test('a confirmação do primeiro ponto não encerra o traço que a mão ainda está fazendo', () => {
  let sessao = beginDraft(traco('t1', [[10, 10]]));

  // O servidor confirma o que já foi enviado, e a fila esvazia. Foi aqui que a
  // 0.9.2 jogava o traço fora.
  sessao = settleDraft(sessao, traco('t1', [[10, 10]]), 0);
  assert.ok(sessao.stroke, 'a caneta ainda está encostada: o traço não pode ser esquecido');

  // E a mão continua andando.
  sessao = extendDraft(sessao, [{ x: 20, y: 10 }, { x: 30, y: 10 }]);
  assert.equal(sessao.stroke?.points.length, 3);
  assert.deepEqual(sessao.stroke?.points.at(-1), { x: 30, y: 10 });
});

// O arrasto inteiro, no ritmo de uma mão: a cada movimento chega a confirmação
// do movimento anterior. O traço tem de terminar com todos os pontos.
test('um arrasto com confirmação entre cada movimento não perde nenhum ponto', () => {
  let sessao = beginDraft(traco('t1', [[0, 0]]));
  let confirmados = 1;
  for (let passo = 1; passo <= 12; passo += 1) {
    sessao = settleDraft(sessao, traco('t1', Array.from({ length: confirmados }, (_valor, indice) => [indice * 20, 0] as [number, number])), 0);
    sessao = extendDraft(sessao, [{ x: passo * 20, y: 0 }]);
    confirmados += 1;
  }
  assert.equal(sessao.stroke?.points.length, 13, 'o ponto do clique mais os doze do arrasto');
  assert.deepEqual(sessao.stroke?.points.at(-1), { x: 240, y: 0 });
});

test('o eco só é esquecido depois que a caneta levanta e o quadro alcança', () => {
  let sessao = beginDraft(traco('t1', [[0, 0], [10, 0]]));
  const completo = traco('t1', [[0, 0], [10, 0]]);

  // Caneta encostada: fica.
  assert.ok(settleDraft(sessao, completo, 0).stroke);

  sessao = endDraft(sessao);
  // Levantou, mas ainda há pedaço na fila: fica, senão a linha piscaria.
  assert.ok(settleDraft(sessao, completo, 2).stroke);
  // Levantou e a fila está vazia, mas o quadro ainda não alcançou: fica.
  assert.ok(settleDraft(sessao, traco('t1', [[0, 0]]), 0).stroke);
  // As três condições: o eco já não acrescenta nada.
  assert.equal(settleDraft(sessao, completo, 0).stroke, null);
});

test('sem notícia do servidor sobre o traço, o eco continua na tela', () => {
  const sessao = endDraft(beginDraft(traco('t1', [[0, 0]])));
  assert.ok(settleDraft(sessao, undefined, 0).stroke, 'traço que o servidor ainda não conhece não some da tela');
});

test('uma caneta que nunca encostou não tem o que esquecer nem o que estender', () => {
  const vazia = idleDraft();
  assert.equal(settleDraft(vazia, undefined, 0), vazia);
  assert.equal(extendDraft(vazia, [{ x: 1, y: 1 }]), vazia);
  assert.equal(endDraft(vazia).stroke, null);
});

test('começar um traço novo não arrasta o anterior junto', () => {
  const primeiro = extendDraft(beginDraft(traco('t1', [[0, 0]])), [{ x: 10, y: 0 }]);
  const segundo = beginDraft(traco('t2', [[50, 50]]));
  assert.equal(segundo.stroke?.id, 't2');
  assert.equal(segundo.stroke?.points.length, 1);
  assert.equal(primeiro.stroke?.points.length, 2, 'o anterior não foi tocado');
});
