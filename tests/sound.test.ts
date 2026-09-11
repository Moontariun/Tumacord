import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Os sons são sintetizados com a Web Audio API, que não existe no Node: o que
// dá para provar aqui é a receita, não o som. O som foi medido no aplicativo
// de verdade, e os números estão em `docs/QA.md`.
//
// Mesmo assim vale provar a receita, porque os defeitos que ela teve eram
// todos visíveis no texto: um evento sem som, um nome sem rótulo, um ganho que
// deixaria um aviso 25 vezes mais baixo que os outros.

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = readFileSync(path.join(raiz, 'src', 'lib', 'sound.ts'), 'utf8');

function nomes(bloco: string): string[] {
  const trecho = fonte.slice(fonte.indexOf(bloco));
  const fim = trecho.indexOf('\n};');
  return [...trecho.slice(0, fim).matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((achado) => achado[1]);
}

const eventos = nomes('const RECIPES: Record<FeedbackSound, Recipe> = {');
const rotulos = nomes('export const SOUND_LABEL: Record<FeedbackSound, string> = {');

test('todo evento tem receita e rótulo, e nenhum sobra', () => {
  assert.ok(eventos.length >= 16, `são ${eventos.length} eventos; a paleta não pode encolher sem querer`);
  assert.deepEqual([...eventos].sort(), [...rotulos].sort(), 'um som sem rótulo não aparece na lista de ouvir');
});

test('silenciar e ensurdecer são eventos diferentes', () => {
  // Eles tocavam o mesmo par de notas até a 0.9.9, e a pessoa não tinha como
  // saber qual dos dois tinha acontecido.
  for (const evento of ['mute', 'unmute', 'deafen', 'undeafen']) {
    assert.ok(eventos.includes(evento), `falta ${evento}`);
  }
});

test('entrar na call e alguém entrando são eventos diferentes', () => {
  for (const evento of ['callJoin', 'callLeave', 'peerJoin', 'peerLeave']) {
    assert.ok(eventos.includes(evento), `falta ${evento}`);
  }
});

test('nenhuma nota pede ganho fora da faixa que o motor aceita', () => {
  const ganhos = [...fonte.matchAll(/gain: ([\d.]+)/g)].map((achado) => Number(achado[1]));
  assert.ok(ganhos.length > 20, 'as receitas precisam declarar ganho por nota');
  for (const ganho of ganhos) assert.ok(ganho > 0 && ganho <= 1, `ganho fora da faixa: ${ganho}`);
});

test('nenhum som passa de um segundo e meio até a última nota', () => {
  // Um feedback que dura mais que isso atropela o próximo e atrapalha quem
  // está numa call.
  const trechos = [...fonte.matchAll(/at: ([\d.]+), length: ([\d.]+)/g)];
  assert.ok(trechos.length > 20);
  for (const [, at, length] of trechos) {
    assert.ok(Number(at) + Number(length) <= 1.5, `nota terminando em ${Number(at) + Number(length)}s`);
  }
});

test('a cauda de reverberação é curta o bastante para não pisar na conversa', () => {
  const duracao = /const duracao = ([\d.]+);/.exec(fonte)?.[1];
  assert.ok(duracao && Number(duracao) <= 1.2, `a sala tem ${duracao}s`);
});
