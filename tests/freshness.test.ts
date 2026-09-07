import assert from 'node:assert/strict';
import test from 'node:test';
import { beginLoad, failLoad, isBlank, isBusy, settle, untracked, type Tracked } from '../src/lib/freshness';

// Este arquivo guarda a regra que o bug da interface sob carga violava:
// atraso, timeout e resposta fora de ordem não podem apagar um estado válido.

test('sem ninguém ter perguntado, o estado é desconhecido — não é "não tem"', () => {
  const inicial = untracked<string[]>();
  assert.equal(inicial.status, 'unknown');
  assert.equal(inicial.value, null);
  assert.equal(isBusy(inicial), false);
  assert.equal(isBlank(inicial), true);
});

test('a primeira consulta carrega; a segunda atualiza sem apagar o que está em tela', () => {
  const carregando = beginLoad(untracked<string[]>());
  assert.equal(carregando.status, 'loading');
  assert.equal(isBlank(carregando), true);

  const pronto = settle(carregando, carregando.request, ['geral', 'memes']);
  assert.equal(pronto.status, 'ready');
  assert.deepEqual(pronto.value, ['geral', 'memes']);

  const atualizando = beginLoad(pronto);
  assert.equal(atualizando.status, 'refreshing');
  // A lista continua onde estava: é isto que impede o painel de piscar a cada
  // ação administrativa, que recarrega tudo.
  assert.deepEqual(atualizando.value, ['geral', 'memes']);
  assert.equal(isBlank(atualizando), false);
});

// O caso descrito no relato: pedido A começa, pedido B começa, B termina e
// grava o certo, A termina atrasado. A não pode vencer.
test('resposta antiga não sobrescreve resposta nova', () => {
  const inicial = untracked<string>();
  const pedidoA = beginLoad(inicial);
  const pedidoB = beginLoad(pedidoA);
  assert.notEqual(pedidoA.request, pedidoB.request);

  const depoisDeB = settle(pedidoB, pedidoB.request, 'valor novo');
  assert.equal(depoisDeB.value, 'valor novo');

  const comAAtrasado = settle(depoisDeB, pedidoA.request, 'valor velho');
  assert.equal(comAAtrasado.value, 'valor novo');
  assert.equal(comAAtrasado, depoisDeB, 'o estado nem sequer precisa ser recriado');
});

test('falha antiga também não derruba resposta nova', () => {
  const pedidoA = beginLoad(untracked<string>());
  const pedidoB = beginLoad(pedidoA);
  const pronto = settle(pedidoB, pedidoB.request, 'valor novo');
  const comFalhaAtrasada = failLoad(pronto, pedidoA.request, 'tempo esgotado');
  assert.equal(comFalhaAtrasada.status, 'ready');
  assert.equal(comFalhaAtrasada.value, 'valor novo');
  assert.equal(comFalhaAtrasada.error, '');
});

// Um timeout diz que a resposta demorou. Não diz que o outro lado deixou de
// ter aquilo — e era exatamente essa confusão que fazia os controles sumirem.
test('falha com valor em mãos vira "envelhecido", e o valor fica', () => {
  const pronto = settle(beginLoad(untracked<number>()), 1, 42);
  const emVoo = beginLoad(pronto);
  const falhou = failLoad(emVoo, emVoo.request, 'não consegui falar com o servidor');
  assert.equal(falhou.status, 'stale');
  assert.equal(falhou.value, 42);
  assert.equal(falhou.error, 'não consegui falar com o servidor');
  assert.equal(isBlank(falhou), false, 'com valor em mãos a tela não vira "carregando"');
});

test('falha sem nada em mãos é falha mesmo, e para de dizer que está carregando', () => {
  const emVoo = beginLoad(untracked<number>());
  const falhou = failLoad(emVoo, emVoo.request, 'servidor fora do ar');
  assert.equal(falhou.status, 'failed');
  assert.equal(falhou.value, null);
  assert.equal(isBusy(falhou), false);
  assert.equal(isBlank(falhou), false, 'sem isso a tela ficaria em "carregando" para sempre');
});

// Uma recuperação depois da falha volta ao estado normal, sem resíduo do erro.
test('depois de falhar, uma resposta boa limpa o aviso', () => {
  const falhou = failLoad(beginLoad(untracked<string>()), 1, 'tempo esgotado');
  const novaTentativa = beginLoad(falhou);
  const recuperado = settle(novaTentativa, novaTentativa.request, 'ok');
  assert.equal(recuperado.status, 'ready');
  assert.equal(recuperado.error, '');
  assert.equal(recuperado.value, 'ok');
});

// Um congestionamento que embaralha dez respostas continua terminando na
// última pergunta feita, e nunca em uma anterior.
test('com dez respostas embaralhadas, vence a última pergunta', () => {
  let estado: Tracked<number> = untracked<number>();
  const pedidos: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    estado = beginLoad(estado);
    pedidos.push(estado.request);
  }
  const embaralhados = [...pedidos].sort(() => 0.5 - Math.random());
  for (const pedido of embaralhados) estado = settle(estado, pedido, pedido);
  assert.equal(estado.value, pedidos.at(-1));
});
