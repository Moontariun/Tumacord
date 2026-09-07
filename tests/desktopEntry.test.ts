import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(path.join(raiz, 'desktop/main.cjs'), 'utf8');

// O processo principal monta o endereço da interface e depois compara esse
// mesmo texto com o destino de cada navegação, para recusar qualquer outro.
// Montar o endereço concatenando `file://` a um caminho de arquivo funciona no
// Linux por coincidência — o caminho já começa com `/` e completa as três
// barras. Em qualquer outro caso o navegador normaliza o endereço, o texto
// guardado deixa de bater, e a comparação passa a recusar a navegação legítima.
test('o endereço da interface é montado por pathToFileURL, não por concatenação', () => {
  assert.match(main, /pathToFileURL\(path\.join\(__dirname, '\.\.\/dist-web\/index\.html'\)\)\.href/);
  assert.equal(main.includes('`file://${path.join('), false, 'concatenar `file://` com um caminho volta a quebrar no Windows');
});

test('o caminho do Windows não sobrevive à concatenação; por pathToFileURL, sim', () => {
  const janela = 'C:\\Program Files\\Tumacord\\resources\\app.asar\\dist-web\\index.html';
  const concatenado = `file://${janela}`;
  // É isto que o navegador entrega de volta em `will-navigate`.
  assert.equal(new URL(concatenado).href, 'file:///C:/Program%20Files/Tumacord/resources/app.asar/dist-web/index.html');
  assert.notEqual(new URL(concatenado).href, concatenado, 'o texto guardado não bate com o destino real');
});

test('caminho com espaço quebra a comparação também no Linux', () => {
  const comEspaco = '/home/eu/Meus Documentos/Tumacord/dist-web/index.html';
  const concatenado = `file://${comEspaco}`;
  assert.notEqual(new URL(concatenado).href, concatenado, 'o navegador percent-encoda e a comparação deixa de bater');

  const correto = pathToFileURL(comEspaco).href;
  assert.equal(new URL(correto).href, correto, 'o endereço já nasce normalizado');
  assert.equal(fileURLToPath(correto), comEspaco, 'e continua apontando para o mesmo arquivo');
});
