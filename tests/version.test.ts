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
// aplicativo recusar a atualização que ele deveria instalar, e faz o servidor
// oferecer um passo atrás como se fosse um passo à frente.
//
// Desde a 0.10.0 a política é SemVer 2.0.0. O vetor abaixo é o da própria
// especificação, com o começo da história deste projeto na frente.

const ORDER = [
  '0.9.9',
  '0.9.10',
  '0.10.0',
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-beta',
  '1.0.0-beta.2',
  '1.0.0-beta.11',
  '1.0.0-rc.1',
  '1.0.0',
  '1.0.1',
];

test('a ordem do SemVer vale por inteiro, e em todos os pares', () => {
  for (let i = 0; i < ORDER.length - 1; i += 1) {
    assert.equal(compareVersions(ORDER[i], ORDER[i + 1]), -1, `${ORDER[i]} deveria vir antes de ${ORDER[i + 1]}`);
    assert.equal(compareVersions(ORDER[i + 1], ORDER[i]), 1, `${ORDER[i + 1]} deveria vir depois de ${ORDER[i]}`);
  }
  // Não só entre vizinhos: qualquer par mais distante também.
  for (let i = 0; i < ORDER.length; i += 1) {
    for (let j = 0; j < ORDER.length; j += 1) {
      const expected = i === j ? 0 : i < j ? -1 : 1;
      assert.equal(compareVersions(ORDER[i], ORDER[j]), expected, `${ORDER[i]} vs ${ORDER[j]}`);
    }
  }
});

// A troca de convenção da 0.10.0, e a única pergunta que decide se ela deixa
// alguém para trás.
//
// Sob a convenção antiga, `0.9.9-1` era a correção da 0.9.9 e vinha DEPOIS
// dela. Sob SemVer, é uma pré-versão e vem ANTES. As cópias instaladas em campo
// hoje estão na 0.9.9-1 e leem pela regra antiga; as novas leem por esta. A
// migração só é segura porque `0.10.0` é maior que `0.9.9-1` nas duas leituras
// — e é isso que este teste fixa.
test('a 0.10.0 alcança quem está na 0.9.9-1, nas duas leituras da regra', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9-1'), 1, 'pela regra nova');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  // A inversão é real, e é o preço declarado da troca.
  assert.equal(compareVersions('0.9.9-1', '0.9.9'), -1, 'sob SemVer o sufixo é pré-versão, e vem antes');
  // A correção de uma 0.9.9 agora se chama 0.9.10, e ordena certo sem convenção.
  assert.equal(compareVersions('0.9.10', '0.9.9'), 1);
});

// A regressão clássica: comparar "0.8.10" com "0.8.9" como texto diz que a
// 0.8.9 é maior. Esta numeração já passou por 0.7.10 e 0.7.11.
test('a comparação é numérica campo a campo, não textual', () => {
  assert.equal(compareVersions('0.8.10', '0.8.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  // E dentro da pré-versão, um identificador numérico compara como número.
  assert.equal(compareVersions('1.0.0-beta.11', '1.0.0-beta.2'), 1);
});

test('uma versão final vem depois de qualquer pré-versão do mesmo número', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(parseVersion('1.0.0')?.isPrerelease, false);
  assert.equal(parseVersion('1.0.0-rc.1')?.isPrerelease, true);
  // Quem acabou primeiro vem antes: um prefixo é menor que o que o estende.
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
});

test('um identificador numérico vale menos que um alfanumérico', () => {
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
});

test('a tupla é (major, minor, patch), e a pré-versão fica fora dela', () => {
  assert.deepEqual(parseVersion('1.2.3-rc.1')?.tuple, [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3')?.tuple, [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3-rc.1')?.prerelease, ['rc', 1]);
  assert.deepEqual(parseVersion('1.2.3')?.prerelease, []);
});

// Por especificação, o metadado de build não participa da ordem. Tratá-lo como
// diferença faria o cliente reinstalar o que já tem a cada build nova.
test('o metadado de build é preservado no texto e ignorado na ordem', () => {
  assert.equal(parseVersion('1.2.3+abc.1')?.build, 'abc.1');
  assert.equal(parseVersion('1.2.3+abc.1')?.text, '1.2.3+abc.1');
  assert.equal(compareVersions('1.2.3+abc', '1.2.3+def'), 0);
  assert.equal(compareVersions('1.2.3+abc', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3-rc.1+abc', '1.2.3-rc.1'), 0);
});

test('o `v` das etiquetas é aceito na entrada e a forma canônica não o tem', () => {
  assert.equal(parseVersion('v1.0.0-rc.1')?.text, '1.0.0-rc.1');
  assert.equal(parseVersion('V0.10.0')?.text, '0.10.0');
  assert.equal(parseVersion('  v1.0.0  ')?.text, '1.0.0', 'espaço em volta não é erro');
  assert.equal(parseVersion('v1.0.0-rc.1')?.tag, 'v1.0.0-rc.1');
  assert.equal(compareVersions('v0.10.0', '0.10.0'), 0, 'com e sem `v` são a mesma versão');
});

// `1.0` existe porque gente escreve `1.0` — em um prompt, num campo, num
// script. Ele é normalizado na entrada e nunca sai assim.
test('`1.0` é alias de entrada e sai normalizado como 1.0.0', () => {
  assert.equal(parseVersion('1.0')?.text, '1.0.0');
  assert.equal(parseVersion('v1.0')?.text, '1.0.0');
  assert.equal(parseVersion('1.0-rc.1')?.text, '1.0.0-rc.1', 'a pré-versão sobrevive ao alias');
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(formatVersion(requireVersion('1.0')), '1.0.0');
});

test('a forma canônica não tem zeros à esquerda, e zero à esquerda é recusado', () => {
  assert.equal(parseVersion('01.0.0'), null);
  assert.equal(parseVersion('0.09.9'), null);
  // Vale também dentro da pré-versão: `rc.01` e `rc.1` seriam duas etiquetas
  // para o mesmo lugar, e é assim que se publica conteúdo diferente sob o
  // mesmo número sem ninguém notar.
  assert.equal(parseVersion('1.0.0-rc.01'), null);
});

// O que a convenção anterior recusava e esta aceita. A troca é o objetivo da
// 0.10.0, e o teste diz isso em vez de deixar subentendido.
test('alpha, beta, rc e +build passaram a fazer parte da convenção', () => {
  for (const accepted of ['1.0.0-rc1', '1.0.0-alpha', '1.0.0-beta.1', '1.0.0+build7', '1.0.0-rc.1+abc']) {
    assert.notEqual(parseVersion(accepted), null, `${accepted} deveria ser aceita`);
    assert.equal(isVersion(accepted), true);
  }
});

// Pré-versão diz o que o NÚMERO é; canal diz para QUEM ele é oferecido. São
// perguntas separadas, e continuam em campos separados.
test('uma pré-versão é reconhecível, para o canal poder decidir sozinho', () => {
  assert.equal(requireVersion('1.0.0-rc.1').isPrerelease, true);
  assert.equal(requireVersion('1.0.0').isPrerelease, false);
  assert.equal(requireVersion('1.0.0+build').isPrerelease, false, 'metadado de build não é pré-versão');
});

test('uma pré-versão vazia ou um `+` sem nada não são versões', () => {
  assert.equal(parseVersion('1.0.0-'), null);
  assert.equal(parseVersion('1.0.0+'), null);
  assert.equal(parseVersion('1.0.0-.1'), null);
});

// Entrada malformada é erro, e não "são a mesma versão". Devolver 0 para lixo
// fazia uma entrada corrompida do catálogo convencer o cliente de que ele já
// estava em dia.
test('comparar com lixo lança, em vez de dizer que são iguais', () => {
  for (const garbage of ['', 'nao-e-versao', 'v', '1', '1.2.3.4', null, undefined, 42, {}, []]) {
    assert.throws(() => compareVersions('1.0.0', garbage as unknown), VersionError, `comparar com ${JSON.stringify(garbage)}`);
    assert.throws(() => compareVersions(garbage as unknown, '1.0.0'), VersionError);
  }
  assert.equal(isVersion('0.10.0'), true);
  assert.equal(isVersion('nao-e-versao'), false);
});

test('os limites numéricos são explícitos, e o que passa deles é recusado', () => {
  assert.equal(VERSION_LIMIT, 65535, 'o limite é o do campo de 16 bits da versão numérica do Windows');
  assert.equal(parseVersion(`${VERSION_LIMIT}.0.0`)?.major, VERSION_LIMIT);
  assert.equal(parseVersion(`${VERSION_LIMIT + 1}.0.0`), null);
  assert.equal(parseVersion('99999999999999999999.0.0'), null);
});

// Sob SemVer o quarto campo do Windows não desempata nada: duas versões
// publicáveis nunca compartilham `major.minor.patch`. O que ele não consegue
// representar é pré-versão, e isso é recusado em vez de virar um número que
// ordena errado no instalador.
test('a versão numérica do Windows é sempre .0, e recusa pré-versão', () => {
  assert.equal(windowsVersion('0.10.0'), '0.10.0.0');
  assert.equal(windowsVersion('v1.2.3'), '1.2.3.0');
  assert.notEqual(windowsVersion('1.2.3'), windowsVersion('1.2.4'));
  assert.throws(() => windowsVersion('1.0.0-rc.1'), VersionError);
  assert.match(
    (() => { try { windowsVersion('1.0.0-rc.1'); return ''; } catch (failure) { return (failure as Error).message; } })(),
    /pré-versão/,
    'o motivo precisa aparecer para quem publica',
  );
});

test('a etiqueta publicada tem a forma da convenção, e só ela', () => {
  for (const good of ['v0.10.0', 'v1.0.0', 'v1.0.0-rc.1', 'v1.0.0+build7', 'v1.0.0-rc.1+abc']) {
    assert.equal(TAG_PATTERN.test(good), true, good);
  }
  for (const bad of ['0.10.0', 'v01.0.0', 'v1.0', 'v1.0.0-', 'v1.0.0-rc.01', 'v1.2.3.4']) {
    assert.equal(TAG_PATTERN.test(bad), false, `${bad} não é etiqueta publicável`);
  }
});

test('a ordenação decrescente descarta o que não for versão, sem lançar', () => {
  assert.deepEqual(
    sortDescending(['0.9.9', 'lixo', '1.0.0-rc.1', null, '0.10.0', '1.0.0']).map((v) => v.text),
    ['1.0.0', '1.0.0-rc.1', '0.10.0', '0.9.9'],
  );
});

// ── A adaptação gerada ───────────────────────────────────────────────────────
//
// O processo principal do Electron carrega `desktop/*.cjs` sem bundler, então
// a política precisa existir também em CJS. Ela é **gerada**; estes dois
// testes são o que impede a segunda cópia de virar uma segunda regra.

test('a adaptação CJS está em dia com shared/version.ts', async () => {
  const { generate } = await import('../scripts/generate-version.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(
    readFileSync(new URL('../desktop/version.generated.cjs', import.meta.url), 'utf8'),
    generate(),
    'rode `node scripts/generate-version.mjs` — a fonte é shared/version.ts, não o arquivo gerado',
  );
});

test('a adaptação CJS decide igual à fonte, nos mesmos vetores', async () => {
  const { createRequire } = await import('node:module');
  const cjs = createRequire(import.meta.url)('../desktop/version.generated.cjs');
  for (let i = 0; i < ORDER.length; i += 1) {
    for (let j = 0; j < ORDER.length; j += 1) {
      assert.equal(
        cjs.compareVersions(ORDER[i], ORDER[j]),
        compareVersions(ORDER[i], ORDER[j]),
        `${ORDER[i]} vs ${ORDER[j]} decidido diferente em CJS`,
      );
    }
  }
  assert.equal(cjs.windowsVersion('0.10.0'), windowsVersion('0.10.0'));
  assert.equal(cjs.parseVersion('1.0.0-rc.1')?.isPrerelease, true);
  assert.throws(() => cjs.compareVersions('lixo', '1.0.0'), /VersionError|versão inválida/);
});

// ── A versão numérica do Windows, provada contra o electron-builder real ─────
//
// Quem decide o número do instalador é a biblioteca, e é ela que precisa ser
// perguntada — um teste com processo simulado não provaria nada aqui.
//
// Sob SemVer o antigo defeito (0.9.9 e 0.9.9-1 com o mesmo número) some para
// versões finais, porque duas delas nunca compartilham `major.minor.patch`. O
// que sobra é a pré-versão, que colide com a final do mesmo número — e é por
// isso que ela é recusada antes de qualquer binário existir.

test('o electron-builder concorda com a versão numérica da implementação única', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { AppInfo } = require('app-builder-lib/out/appInfo.js');
  const { packageFields } = await import('../scripts/generate-version.mjs');

  const numeric = (version: string) => {
    const app = new AppInfo({ metadata: { version, name: 'tumacord' }, config: { ...packageFields(version) }, framework: {} }, null);
    return { windowsForm: app.getVersionInWeirdWindowsForm(), fileVersion: app.buildVersion, productVersion: app.version };
  };

  for (const parsedVersion of ['0.9.9', '0.10.0', '1.0.0', '1.2.3']) {
    assert.equal(numeric(parsedVersion).windowsForm, windowsVersion(parsedVersion), parsedVersion);
  }
  assert.notEqual(numeric('0.10.0').windowsForm, numeric('0.10.1').windowsForm);

  // A colisão que justifica a recusa: para o electron-builder sozinho, a rc e a
  // final do mesmo número são o mesmo instalador.
  const rc = new AppInfo({ metadata: { version: '1.0.0-rc.1', name: 'tumacord' }, config: {}, framework: {} }, null);
  const final = new AppInfo({ metadata: { version: '1.0.0', name: 'tumacord' }, config: {}, framework: {} }, null);
  assert.equal(rc.getVersionInWeirdWindowsForm(), final.getVersionInWeirdWindowsForm(), 'é esta colisão que a recusa evita');
  assert.throws(() => packageFields('1.0.0-rc.1'), /pré-versão/);

  // A versão textual do produto não é contaminada pelo número de build.
  assert.equal(numeric('0.10.0').fileVersion, '0.10.0');
  assert.equal(numeric('0.10.0').productVersion, '0.10.0');
});

test('o package.json declara a versão do produto e os campos derivados dela', async () => {
  const { createRequire } = await import('node:module');
  const pkg = createRequire(import.meta.url)('../package.json');
  const { packageFields } = await import('../scripts/generate-version.mjs');
  assert.equal(pkg.version, '0.10.0', 'esta é a versão que a branch entrega');
  assert.equal(isVersion(pkg.version), true, 'a versão publicada precisa caber na convenção');
  assert.deepEqual({ buildNumber: pkg.build.buildNumber, buildVersion: pkg.build.buildVersion }, packageFields(pkg.version));
});
