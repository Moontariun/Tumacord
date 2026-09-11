import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// A decisão de qual versão oferecer é a parte que erra em silêncio quando erra:
// oferecer uma versão quebrada, oferecer o arquivo do jeito errado de instalar,
// ou oferecer uma versão mais velha do que a instalada. Nada disso apareceria
// numa tela — apareceria na máquina de alguém. Por isso ela vive sem rede e sem
// disco, e é testada inteira aqui.

const require = createRequire(import.meta.url);
const { assetFor, brokenReason, chooseUpdate, compareVersions, installKind, parseVersion, releaseFor } = require('../desktop/update-check.cjs') as {
  assetFor: (kind: string, assets: unknown, version?: string) => { name: string; url: string; size: number; digest: string } | null;
  brokenReason: (version: string, body?: string) => string;
  chooseUpdate: (input: Record<string, unknown>) => Record<string, any>;
  compareVersions: (left: unknown, right: unknown) => number;
  installKind: (input: Record<string, unknown>) => string;
  parseVersion: (text: unknown) => { text: string } | null;
  releaseFor: (releases: unknown, version: string) => Record<string, string> | null;
};

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Tumacord ${tag.replace(/^v/, '')} — alguma manchete`,
  body: 'Uma coisa mudou.',
  html_url: `https://github.com/Moontariun/Tumacord/releases/tag/${tag}`,
  published_at: '2026-09-10T12:00:00Z',
  assets: [
    { name: `Tumacord-${tag.replace(/^v/, '')}-Setup.exe`, browser_download_url: 'https://github.com/x/y/releases/download/a/Setup.exe', size: 100, digest: 'sha256:' + 'a'.repeat(64), state: 'uploaded' },
    { name: `Tumacord-${tag.replace(/^v/, '')}-portable.exe`, browser_download_url: 'https://github.com/x/y/releases/download/a/portable.exe', size: 90, state: 'uploaded' },
    { name: `tumacord-${tag.replace(/^v/, '')}.tar.gz`, browser_download_url: 'https://github.com/x/y/releases/download/a/linux.tar.gz', size: 80, state: 'uploaded' },
    { name: `Tumacord-${tag.replace(/^v/, '')}.AppImage`, browser_download_url: 'https://github.com/x/y/releases/download/a/linux.AppImage', size: 120, state: 'uploaded' },
  ],
  ...extra,
});

// A numeração deste projeto já passou por 0.7.10 e 0.7.11. Comparar como texto
// diria que a 0.8.9 é mais nova que a 0.8.10, e o aplicativo pararia de
// oferecer atualização exatamente quando ela existisse.
test('0.8.10 é mais nova que 0.8.9, e a pré-versão vem antes da final', () => {
  assert.equal(compareVersions('0.8.10', '0.8.9'), 1);
  assert.equal(compareVersions('v0.9.0', '0.8.10'), 1);
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('0.9.0-rc1', '0.9.0'), -1);
  assert.equal(parseVersion('nada disso'), null);
});

test('a 0.8.9 não é oferecida a ninguém, nem sendo a mais nova', () => {
  const decisao = chooseUpdate({ releases: [release('v0.8.9')], currentVersion: '0.8.8', kind: 'windows-installed' });
  assert.equal(decisao.status, 'up-to-date');
  assert.deepEqual(decisao.skipped, [{ version: '0.8.9', reason: 'as resoluções e o FPS da transmissão saem errados' }]);
});

// O marcador no corpo da Release é o que faz uma versão futura ser retirada
// sem depender de uma lista embutida em cada cópia instalada.
test('o marcador nas notas retira uma versão que esta cópia não conhecia', () => {
  const quebrada = release('v0.9.5', { body: 'Notas.\n<!-- tumacord:versao-quebrada -->\n' });
  const decisao = chooseUpdate({ releases: [quebrada, release('v0.9.1')], currentVersion: '0.9.0', kind: 'windows-installed' });
  assert.equal(decisao.version, '0.9.1', 'a mais nova é pulada e a anterior boa é oferecida');
  assert.equal(decisao.skipped[0].version, '0.9.5');
  assert.match(brokenReason('9.9.9', '<!--tumacord:versao-quebrada-->'), /se declara quebrada/);
  assert.equal(brokenReason('9.9.9', 'notas normais'), '');
});

test('quem está na 0.8.9 é avisado de que a própria versão foi retirada', () => {
  const decisao = chooseUpdate({ releases: [release('v0.9.0')], currentVersion: '0.8.9', kind: 'linux-managed' });
  assert.match(decisao.installedBroken, /resoluções e o FPS/);
  assert.equal(decisao.status, 'available');
  assert.equal(decisao.version, '0.9.0');
});

test('nunca se oferece uma versão mais antiga do que a instalada', () => {
  const decisao = chooseUpdate({ releases: [release('v0.8.7'), release('v0.8.8')], currentVersion: '0.9.0', kind: 'windows-installed' });
  assert.equal(decisao.status, 'up-to-date');
  assert.equal(decisao.version, undefined);
});

test('pré-versão só entra quando alguém pede', () => {
  const releases = [release('v0.9.1-rc1', { prerelease: true })];
  assert.equal(chooseUpdate({ releases, currentVersion: '0.9.0', kind: 'windows-installed' }).status, 'up-to-date');
  assert.equal(chooseUpdate({ releases, currentVersion: '0.9.0', kind: 'windows-installed', allowPrerelease: true }).version, '0.9.1-rc1');
});

test('rascunho não existe para quem está esperando uma versão', () => {
  const decisao = chooseUpdate({ releases: [release('v0.9.9', { draft: true })], currentVersion: '0.9.0', kind: 'windows-installed' });
  assert.equal(decisao.status, 'up-to-date');
});

// Cada jeito de instalar tem o próprio arquivo. Escolher errado aqui seria
// entregar um instalador do Windows para uma cópia do Linux.
test('cada tipo de instalação recebe o arquivo que serve para ele', () => {
  const assets = release('v0.9.1').assets;
  assert.match(assetFor('windows-installed', assets, '0.9.1')!.name, /-Setup\.exe$/);
  assert.match(assetFor('windows-portable', assets, '0.9.1')!.name, /-portable\.exe$/);
  assert.match(assetFor('linux-managed', assets, '0.9.1')!.name, /\.tar\.gz$/);
  assert.match(assetFor('linux-appimage', assets, '0.9.1')!.name, /\.AppImage$/);
  assert.equal(assetFor('unknown', assets, '0.9.1'), null, 'sem saber como esta cópia foi instalada, não há arquivo a aplicar');
});

// Um arquivo ainda subindo pelo CI aparece na API antes de existir por inteiro.
test('arquivo que ainda está sendo enviado não é oferecido', () => {
  const assets = [{ name: 'Tumacord-0.9.1-Setup.exe', browser_download_url: 'https://github.com/x', size: 10, state: 'uploading' }];
  assert.equal(assetFor('windows-installed', assets, '0.9.1'), null);
});

test('sem arquivo para este jeito de instalar, a versão é anunciada sem botão de aplicar', () => {
  const semArquivos = release('v0.9.1', { assets: [] });
  const decisao = chooseUpdate({ releases: [semArquivos], currentVersion: '0.9.0', kind: 'linux-appimage' });
  assert.equal(decisao.status, 'no-asset');
  assert.equal(decisao.asset, null);
  assert.match(decisao.pageUrl, /releases\/tag\/v0\.9\.1$/, 'a página da versão continua sendo oferecida');
});

test('o jeito da instalação sai de onde a cópia mora, não de um palpite', () => {
  assert.equal(installKind({ platform: 'win32', env: {} }), 'windows-installed');
  assert.equal(installKind({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Tumacord.exe' } }), 'windows-portable');
  assert.equal(installKind({ platform: 'linux', env: { APPIMAGE: '/home/eu/Tumacord.AppImage' } }), 'linux-appimage');
  assert.equal(installKind({
    platform: 'linux',
    env: {},
    home: '/home/eu',
    resourcesPath: '/home/eu/.local/share/tumacord/versions/0.9.0-abc/resources',
  }), 'linux-managed');
  assert.equal(installKind({ platform: 'linux', env: {}, home: '/home/eu', resourcesPath: '/opt/tumacord/resources' }), 'unknown');
  assert.equal(installKind({ platform: 'darwin', env: {} }), 'unknown');
});

// O "o que mudou" mostrado depois de atualizar é o texto da própria página de
// Releases. Ele é da versão instalada, não da que está sendo oferecida.
test('as notas da versão instalada saem da Release dela', () => {
  const releases = [release('v0.9.1'), release('v0.9.0', { body: 'O que mudou na 0.9.0.' })];
  const notas = releaseFor(releases, '0.9.0');
  assert.equal(notas?.version, '0.9.0');
  assert.equal(notas?.notes, 'O que mudou na 0.9.0.');
  assert.equal(releaseFor(releases, '0.7.0'), null, 'sem Release daquela versão, não há o que mostrar');
  assert.equal(chooseUpdate({ releases, currentVersion: '0.9.0', kind: 'windows-installed' }).installedRelease.version, '0.9.0');
});

// O marcador de versão quebrada é um comentário de HTML: ele não aparece para
// quem lê a página, e não pode aparecer para quem lê a tela.
test('o comentário de marcação não vaza para o texto mostrado', () => {
  const notas = releaseFor([release('v0.9.0', { body: 'Linha um.\n<!-- tumacord:versao-quebrada -->\nLinha dois.' })], '0.9.0');
  assert.ok(!notas?.notes.includes('tumacord:versao-quebrada'));
  assert.match(notas!.notes, /Linha um[\s\S]*Linha dois/);
});

test('uma resposta estranha da API não vira decisão', () => {
  for (const releases of [null, 'texto', 42, [null, {}, { tag_name: 'sem versão' }]]) {
    const decisao = chooseUpdate({ releases, currentVersion: '0.9.0', kind: 'windows-installed' });
    assert.equal(decisao.status, 'up-to-date');
  }
  assert.equal(chooseUpdate({ releases: [release('v0.9.1')], currentVersion: 'sei lá', kind: 'windows-installed' }).status, 'unknown-version');
});

// Pular versões é o normal e é o que se quer: quem está na 0.9.1 e encontra a
// 0.9.9 instala a 0.9.9 direto, sem sete instalações no caminho.
test('quem está muito atrás recebe direto a versão mais nova', () => {
  const decisao = chooseUpdate({
    releases: [release('v0.9.2'), release('v0.9.5'), release('v0.9.9')],
    currentVersion: '0.9.1',
    kind: 'linux-managed',
  });
  assert.equal(decisao.version, '0.9.9');
  assert.equal(decisao.mustStop, null);
  assert.equal(decisao.latest, '');
});

// Às vezes não dá pular: uma versão que converte dados só a partir do formato
// imediatamente anterior precisa ser instalada antes das seguintes.
test('uma parada obrigatória no caminho é oferecida antes da mais nova', () => {
  const parada = release('v0.9.5', { body: 'Muda o formato.\n<!-- tumacord:parada-obrigatoria -->' });
  const decisao = chooseUpdate({
    releases: [release('v0.9.2'), parada, release('v0.9.9')],
    currentVersion: '0.9.1',
    kind: 'linux-managed',
  });
  assert.equal(decisao.version, '0.9.5', 'passa pela parada primeiro');
  assert.equal(decisao.latest, '0.9.9', 'e a mais nova continua sendo dita');
  assert.match(decisao.mustStop?.reason ?? '', /antes das seguintes/);
});

test('a parada já passada não segura mais ninguém', () => {
  const parada = release('v0.9.5', { body: '<!-- tumacord:parada-obrigatoria -->' });
  const decisao = chooseUpdate({
    releases: [parada, release('v0.9.9')],
    currentVersion: '0.9.5',
    kind: 'linux-managed',
  });
  assert.equal(decisao.version, '0.9.9');
  assert.equal(decisao.mustStop, null);
});

test('entre duas paradas, a mais próxima vem primeiro', () => {
  const decisao = chooseUpdate({
    releases: [
      release('v0.9.3', { body: '<!-- tumacord:parada-obrigatoria -->' }),
      release('v0.9.7', { body: '<!-- tumacord:parada-obrigatoria -->' }),
      release('v0.9.9'),
    ],
    currentVersion: '0.9.1',
    kind: 'linux-managed',
  });
  assert.equal(decisao.version, '0.9.3');
  assert.equal(decisao.latest, '0.9.9');
});

// Uma parada quebrada não pode prender ninguém num degrau que não deve ser
// instalado: ela é pulada como qualquer versão quebrada.
test('parada obrigatória que também está quebrada não prende ninguém', () => {
  const decisao = chooseUpdate({
    releases: [
      release('v0.9.5', { body: '<!-- tumacord:parada-obrigatoria -->\n<!-- tumacord:versao-quebrada -->' }),
      release('v0.9.9'),
    ],
    currentVersion: '0.9.1',
    kind: 'linux-managed',
  });
  assert.equal(decisao.version, '0.9.9');
  assert.equal(decisao.skipped[0]?.version, '0.9.5');
});

// O marcador do resumo precisa sobreviver até a interface: é por ele que o
// aplicativo sabe qual pedaço mostrar. Os outros comentários somem.
test('o resumo chega ao aplicativo, e os outros comentários não', () => {
  const corpo = ['<!-- tumacord:resumo -->', 'Uma linha curta.', '<!-- /tumacord:resumo -->', '', '<!-- recado interno -->', 'Detalhe técnico.'].join('\n');
  const decisao = chooseUpdate({ releases: [release('v0.9.9', { body: corpo })], currentVersion: '0.9.1', kind: 'linux-managed' });
  assert.match(decisao.notes ?? '', /tumacord:resumo/);
  assert.equal(/recado interno/.test(decisao.notes ?? ''), false);
});
