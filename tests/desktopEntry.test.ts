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

// Os caracteres que quebram uma URL de arquivo montada à mão. Cada um deles
// vira outra coisa quando o navegador normaliza, e é a comparação de
// `will-navigate` que paga: ela guarda o texto original e passa a recusar a
// navegação do próprio aplicativo.
test('caminhos difíceis sobrevivem à ida e à volta por pathToFileURL', () => {
  const casos = [
    'C:\\Program Files\\Tumacord\\dist-web\\index.html',
    'C:\\Users\\João Antônio\\AppData\\Local\\Tumacord\\index.html',
    '/home/eu/Meus Documentos/Tumacord/dist-web/index.html',
    '/home/eu/Área de Trabalho/Tumacord/index.html',
    '/home/eu/pasta#1/index.html',
    '/home/eu/100% teste/index.html',
    '/home/eu/Tumacord (cópia)/index.html',
    '/home/eu/a+b&c/index.html',
  ];
  for (const caminho of casos) {
    const correto = pathToFileURL(caminho).href;
    assert.equal(new URL(correto).href, correto, `${caminho}: o endereço precisa já nascer normalizado`);
    // E precisa continuar apontando para o mesmo arquivo — normalizar não pode
    // ser trocar de caminho. Só faz sentido conferir no formato deste sistema.
    if (caminho.startsWith('/')) assert.equal(fileURLToPath(correto), caminho, `${caminho}: perdeu o caminho de volta`);
  }
});

// A concatenação erra de duas formas diferentes, e a segunda é a pior.
//
// Com espaço ou acento, o texto guardado deixa de bater com o que o navegador
// devolve, e a guarda de navegação recusa a recarga do próprio aplicativo.
//
// Com `#`, o texto até bate — e mesmo assim está errado: tudo depois do `#`
// vira fragmento, e o endereço passa a apontar para OUTRO arquivo. O aplicativo
// simplesmente não carregaria. É por isso que o teste pergunta para qual
// arquivo o endereço aponta, e não se as duas strings são iguais.
test('a concatenação erra o arquivo ou erra a comparação; pathToFileURL não erra nenhum', () => {
  for (const caminho of [
    '/home/eu/Meus Documentos/x/index.html',
    '/home/eu/pasta#1/index.html',
    '/home/eu/100% teste/index.html',
    '/home/eu/Área de Trabalho/index.html',
    '/home/eu/Tumacord (cópia)/index.html',
  ]) {
    const concatenado = `file://${caminho}`;
    const normalizado = new URL(concatenado).href;
    let apontaPara: string | null = null;
    try { apontaPara = fileURLToPath(normalizado); } catch { apontaPara = null; }
    const erraOArquivo = apontaPara !== caminho;
    const erraAComparacao = normalizado !== concatenado;
    assert.ok(erraOArquivo || erraAComparacao, `${caminho}: a concatenação deveria falhar de alguma das duas formas`);

    const correto = pathToFileURL(caminho).href;
    assert.equal(fileURLToPath(correto), caminho, `${caminho}: pathToFileURL precisa apontar para o mesmo arquivo`);
    assert.equal(new URL(correto).href, correto, `${caminho}: e precisa bater com o que o navegador devolve`);
  }
});

// O `#` merece o seu próprio caso: é o único em que a concatenação parece
// certa e não é.
test('um # no caminho fazia a concatenação apontar para outro arquivo', () => {
  const caminho = '/home/eu/pasta#1/index.html';
  const concatenado = `file://${caminho}`;
  assert.equal(new URL(concatenado).href, concatenado, 'as strings batem…');
  assert.equal(fileURLToPath(concatenado), '/home/eu/pasta', '…e mesmo assim o endereço aponta para outro lugar');
  assert.equal(fileURLToPath(pathToFileURL(caminho).href), caminho, 'pathToFileURL escapa o # e mantém o arquivo');
});

// A correção liberou exatamente um endereço: o do próprio aplicativo. Tudo o
// mais continua recusado — soltar a comparação seria abrir o Electron para
// navegação externa.
test('a guarda de navegação continua recusando qualquer endereço que não seja o do app', () => {
  const target = pathToFileURL('/opt/tumacord/dist-web/index.html').href;
  // É esta a comparação que `will-navigate` faz em produção.
  const confiavel = (destino: string) => destino === target;

  assert.equal(confiavel(target), true, 'a recarga do próprio app precisa passar');
  for (const hostil of [
    'https://exemplo.invalido/phishing',
    'http://127.0.0.1:3927/api/health',
    'file:///etc/passwd',
    'file:///opt/tumacord/dist-web/../../../etc/passwd',
    `${target}?x=1`,
    `${target}#/rota`,
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
  ]) {
    assert.equal(confiavel(hostil), false, `${hostil} não pode ser tratado como o app`);
  }
});

// E a comparação de produção não pode ter virado a de desenvolvimento, que é
// por origem — em `file:` a origem é `null` para todo mundo, e comparar por
// ela deixaria qualquer arquivo do disco passar.
test('produção compara o endereço inteiro, não a origem', () => {
  assert.match(main, /const trusted = isDevelopment \? destinationUrl\.origin === trustedOrigin : destination === target;/);
  assert.equal(new URL(pathToFileURL('/opt/a/index.html').href).origin, new URL(pathToFileURL('/etc/passwd').href).origin,
    'dois arquivos quaisquer têm a mesma origem: por isso produção não pode comparar origem');
});
