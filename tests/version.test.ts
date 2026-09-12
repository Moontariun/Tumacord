import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TAG_PATTERN,
  VERSION_LIMIT,
  VersionError,
  compareVersions,
  formatVersion,
  isVersion,
  parseVersion,
  requireVersion,
  sortDescending,
  windowsVersion,
} from '../shared/version';

// A política de versão do produto, provada nos vetores que ela existe para
// resolver. O que está aqui não é decoração: a ordenação errada faz o
// aplicativo recusar a correção que ele deveria instalar, e faz o servidor
// oferecer um passo atrás como se fosse um passo à frente.

// O vetor canônico do requisito. É a frase inteira da convenção, em ordem.
const ORDEM = ['0.9.9', '0.9.9-1', '0.9.9-2', '0.9.9-10', '0.9.10', '1.0.0', '1.0.0-1'];

test('a ordem da convenção vale por inteiro, e em todos os pares', () => {
  for (let i = 0; i < ORDEM.length - 1; i += 1) {
    assert.equal(compareVersions(ORDEM[i], ORDEM[i + 1]), -1, `${ORDEM[i]} deveria vir antes de ${ORDEM[i + 1]}`);
    assert.equal(compareVersions(ORDEM[i + 1], ORDEM[i]), 1, `${ORDEM[i + 1]} deveria vir depois de ${ORDEM[i]}`);
  }
  // Não só entre vizinhos: qualquer par mais distante também.
  for (let i = 0; i < ORDEM.length; i += 1) {
    for (let j = 0; j < ORDEM.length; j += 1) {
      const esperado = i === j ? 0 : i < j ? -1 : 1;
      assert.equal(compareVersions(ORDEM[i], ORDEM[j]), esperado, `${ORDEM[i]} vs ${ORDEM[j]}`);
    }
  }
});

// A regressão que dá nome à revisão: com ordenação de SemVer ou alfabética,
// 0.9.9-1 fica *abaixo* de 0.9.9, e quem está na 0.9.9 nunca recebe a correção.
test('0.9.9-1 é a versão seguinte à 0.9.9, não uma pré-versão dela', () => {
  assert.equal(compareVersions('0.9.9-1', '0.9.9'), 1);
  assert.equal(parseVersion('0.9.9-1')?.revision, 1);
  assert.equal(parseVersion('0.9.9')?.revision, 0, 'sem sufixo, a revisão é zero');
});

// A outra regressão clássica: comparar "0.8.10" com "0.8.9" como texto diz que
// a 0.8.9 é maior. Esta numeração já passou por 0.7.10 e 0.7.11.
test('a comparação é numérica campo a campo, não textual', () => {
  assert.equal(compareVersions('0.8.10', '0.8.9'), 1);
  assert.equal(compareVersions('0.9.9-10', '0.9.9-9'), 1);
  assert.equal(compareVersions('0.9.9-2', '0.9.9-10'), -1);
});

test('a tupla é (major, minor, patch, revision)', () => {
  assert.deepEqual(parseVersion('1.2.3-4')?.tuple, [1, 2, 3, 4]);
  assert.deepEqual(parseVersion('1.2.3')?.tuple, [1, 2, 3, 0]);
});

test('o `v` das etiquetas é aceito na entrada e a forma canônica não o tem', () => {
  assert.equal(parseVersion('v0.9.9-1')?.text, '0.9.9-1');
  assert.equal(parseVersion('V0.9.9')?.text, '0.9.9');
  assert.equal(parseVersion('  v1.0.0  ')?.text, '1.0.0', 'espaço em volta não é erro');
  assert.equal(parseVersion('v0.9.9-1')?.tag, 'v0.9.9-1');
  assert.equal(compareVersions('v0.9.9-1', '0.9.9'), 1, 'com e sem `v` são a mesma versão');
});

// `1.0` existe porque gente escreve `1.0` — em um prompt, num campo, num
// script. Ele é normalizado na entrada e nunca sai assim.
test('`1.0` é alias de entrada e sai normalizado como 1.0.0', () => {
  assert.equal(parseVersion('1.0')?.text, '1.0.0');
  assert.equal(parseVersion('v1.0')?.text, '1.0.0');
  assert.equal(parseVersion('1.0-2')?.text, '1.0.0-2', 'a revisão sobrevive ao alias');
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(formatVersion(requireVersion('1.0')), '1.0.0');
});

test('a forma canônica não tem zeros à esquerda, e zero à esquerda é recusado', () => {
  assert.equal(parseVersion('01.0.0'), null);
  assert.equal(parseVersion('0.09.9'), null);
  assert.equal(parseVersion('0.9.9-01'), null, 'duas escritas para a mesma revisão seriam duas etiquetas para o mesmo lugar');
});

// A regra que separa esta convenção do SemVer. Misturar as duas traria de
// volta a ambiguidade que ela existe para eliminar.
test('alpha, beta, rc e +build não fazem parte da convenção', () => {
  for (const recusada of ['0.9.9-rc1', '0.9.9-alpha', '0.9.9-beta.1', '1.0.0+build7', '0.9.9-1+abc']) {
    assert.equal(parseVersion(recusada), null, `${recusada} deveria ser recusada`);
    assert.throws(() => requireVersion(recusada), VersionError);
  }
  // E o motivo é dito, porque ele vira mensagem de erro para quem publica.
  assert.match(
    (() => { try { requireVersion('0.9.9-rc1'); return ''; } catch (erro) { return (erro as Error).message; } })(),
    /canal/,
    'a mensagem precisa dizer que quem é ensaio é decidido pelo canal',
  );
});

test('a revisão é um inteiro positivo; `-0` não é escrita de "sem revisão"', () => {
  assert.equal(parseVersion('0.9.9-0'), null);
  assert.equal(parseVersion('0.9.9-'), null);
  assert.equal(parseVersion('0.9.9-1')?.revision, 1);
});

// Entrada malformada é erro, e não "são a mesma versão". Devolver 0 para lixo
// fazia uma entrada corrompida do catálogo convencer o cliente de que ele já
// estava em dia.
test('comparar com lixo lança, em vez de dizer que são iguais', () => {
  for (const lixo of ['', 'nao-e-versao', 'v', '1', '1.2.3.4', null, undefined, 42, {}, []]) {
    assert.throws(() => compareVersions('0.9.9', lixo as unknown), VersionError, `comparar com ${JSON.stringify(lixo)}`);
    assert.throws(() => compareVersions(lixo as unknown, '0.9.9'), VersionError);
  }
  assert.equal(isVersion('0.9.9-1'), true);
  assert.equal(isVersion('0.9.9-rc1'), false);
});

test('os limites numéricos são explícitos, e o que passa deles é recusado', () => {
  assert.equal(VERSION_LIMIT, 65535, 'o limite é o do campo de 16 bits da versão numérica do Windows');
  assert.equal(parseVersion(`0.0.0-${VERSION_LIMIT}`)?.revision, VERSION_LIMIT);
  assert.equal(parseVersion(`${VERSION_LIMIT}.0.0`)?.major, VERSION_LIMIT);
  assert.equal(parseVersion(`${VERSION_LIMIT + 1}.0.0`), null);
  assert.equal(parseVersion(`0.9.9-${VERSION_LIMIT + 1}`), null);
  assert.equal(parseVersion('99999999999999999999.0.0'), null);
});

// A versão numérica do Windows precisa distinguir 0.9.9 de 0.9.9-1. Sem o
// quarto campo, o instalador da revisão teria o número da versão que corrige, e
// o Windows trataria a atualização como reinstalação da mesma coisa.
test('a versão numérica do Windows distingue a revisão', () => {
  assert.equal(windowsVersion('0.9.9'), '0.9.9.0');
  assert.equal(windowsVersion('0.9.9-1'), '0.9.9.1');
  assert.equal(windowsVersion('v0.9.9-10'), '0.9.9.10');
  assert.notEqual(windowsVersion('0.9.9'), windowsVersion('0.9.9-1'));
  assert.throws(() => windowsVersion('0.9.9-rc1'), VersionError);
});

test('a etiqueta publicada tem a forma da convenção, e só ela', () => {
  for (const boa of ['v0.9.9', 'v0.9.9-1', 'v1.0.0', 'v0.9.9-10']) assert.equal(TAG_PATTERN.test(boa), true, boa);
  for (const ruim of ['0.9.9', 'v0.9.9-rc1', 'v0.9.9-0', 'v01.0.0', 'v1.0', 'v0.9.9+build']) {
    assert.equal(TAG_PATTERN.test(ruim), false, `${ruim} não é etiqueta publicável`);
  }
});

test('a ordenação decrescente descarta o que não for versão, sem lançar', () => {
  assert.deepEqual(
    sortDescending(['0.9.9', 'lixo', '0.9.9-2', null, '0.10.0', '0.9.9-1']).map((v) => v.text),
    ['0.10.0', '0.9.9-2', '0.9.9-1', '0.9.9'],
  );
});

// ── A adaptação gerada ───────────────────────────────────────────────────────
//
// O processo principal do Electron carrega `desktop/*.cjs` sem bundler, então
// a política precisa existir também em CJS. Ela é **gerada**; estes dois
// testes são o que impede a segunda cópia de virar uma segunda regra.

test('a adaptação CJS está em dia com shared/version.ts', async () => {
  const { gerar } = await import('../scripts/gerar-versao.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(
    readFileSync(new URL('../desktop/version.generated.cjs', import.meta.url), 'utf8'),
    gerar(),
    'rode `node scripts/gerar-versao.mjs` — a fonte é shared/version.ts, não o arquivo gerado',
  );
});

test('a adaptação CJS decide igual à fonte, nos mesmos vetores', async () => {
  const { createRequire } = await import('node:module');
  const cjs = createRequire(import.meta.url)('../desktop/version.generated.cjs');
  for (let i = 0; i < ORDEM.length; i += 1) {
    for (let j = 0; j < ORDEM.length; j += 1) {
      assert.equal(
        cjs.compareVersions(ORDEM[i], ORDEM[j]),
        compareVersions(ORDEM[i], ORDEM[j]),
        `${ORDEM[i]} vs ${ORDEM[j]} decidido diferente em CJS`,
      );
    }
  }
  assert.equal(cjs.windowsVersion('0.9.9-1'), windowsVersion('0.9.9-1'));
  assert.equal(cjs.parseVersion('0.9.9-rc1'), null);
  assert.throws(() => cjs.compareVersions('lixo', '0.9.9'), /VersionError|versão inválida/);
});

// ── A versão numérica do Windows, provada contra o electron-builder real ─────
//
// Este é o teste que impede o defeito voltar sem ninguém notar. Com
// `version` = `0.9.9-1`, o electron-builder sozinho produz `0.9.9.0` — o
// **mesmo número** da 0.9.9 —, porque ele lê `parseInt("9-1")` como 9 e
// preenche o quarto campo com o número de build. O `buildNumber` derivado pelo
// `scripts/gerar-versao.mjs` é o que põe a revisão no lugar certo.
//
// Um teste com processo simulado não provaria nada aqui: quem decide o número
// é a biblioteca, e é ela que precisa ser perguntada.

test('o electron-builder produz uma versão numérica diferente para a revisão', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { AppInfo } = require('app-builder-lib/out/appInfo.js');
  const { camposDoPacote } = await import('../scripts/gerar-versao.mjs');

  const numero = (version: string) => {
    const app = new AppInfo({ metadata: { version, name: 'tumacord' }, config: { ...camposDoPacote(version) }, framework: {} }, null);
    return { numerica: app.getVersionInWeirdWindowsForm(), arquivo: app.buildVersion, produto: app.version };
  };

  // O defeito, em uma linha: sem os campos derivados, os dois dão `0.9.9.0`.
  const semDerivar = new AppInfo({ metadata: { version: '0.9.9-1', name: 'tumacord' }, config: {}, framework: {} }, null);
  assert.equal(semDerivar.getVersionInWeirdWindowsForm(), '0.9.9.0', 'é este o comportamento que precisa ser corrigido');

  assert.equal(numero('0.9.9').numerica, '0.9.9.0');
  assert.equal(numero('0.9.9-1').numerica, '0.9.9.1');
  assert.equal(numero('0.9.9-10').numerica, '0.9.9.10');
  assert.notEqual(numero('0.9.9').numerica, numero('0.9.9-1').numerica, 'a revisão não pode ter o número da versão que ela corrige');

  // E a versão numérica é exatamente a que a implementação única calcula.
  for (const versao of ['0.9.9', '0.9.9-1', '0.9.9-10', '1.0.0', '1.0.0-2']) {
    assert.equal(numero(versao).numerica, windowsVersion(versao), versao);
  }

  // A versão textual do produto não é contaminada pelo número de build:
  // `0.9.9-1.1` apareceria como FileVersion no instalador.
  assert.equal(numero('0.9.9-1').arquivo, '0.9.9-1');
  assert.equal(numero('0.9.9-1').produto, '0.9.9-1');
});

test('o package.json declara a versão do produto e os campos derivados dela', async () => {
  const { createRequire } = await import('node:module');
  const pkg = createRequire(import.meta.url)('../package.json');
  const { camposDoPacote } = await import('../scripts/gerar-versao.mjs');
  assert.equal(pkg.version, '0.9.9-1', 'esta é a revisão que a branch entrega');
  assert.equal(isVersion(pkg.version), true, 'a versão publicada precisa caber na convenção');
  assert.deepEqual({ buildNumber: pkg.build.buildNumber, buildVersion: pkg.build.buildVersion }, camposDoPacote(pkg.version));
});
