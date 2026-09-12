import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { CONTRACT_VERSION, type Catalog, type CatalogEntry, type ReleaseManifest } from '../shared/distribution';

// A decisão de qual versão oferecer é a parte que erra em silêncio quando erra:
// oferecer uma versão retirada, oferecer o pacote do jeito errado de instalar,
// ou oferecer uma versão mais velha do que a instalada. Nada disso apareceria
// numa tela — apareceria na máquina de alguém. Por isso ela vive sem rede e sem
// disco, e é testada inteira aqui.
//
// A fonte mudou na 0.9.9-1: o que entra é o catálogo assinado da distribuição
// privada, e não mais uma lista de Releases do GitHub. As entradas e os
// manifestos chegam aqui **já verificados**.

const require_ = createRequire(import.meta.url);
const {
  brokenReason,
  chooseFromCatalog,
  compareVersions,
  installKind,
  manifestsToFetch,
  parseVersion,
  releaseFor,
} = require_('../desktop/update-check.cjs') as {
  brokenReason: (version: string) => string;
  chooseFromCatalog: (input: Record<string, unknown>) => Record<string, any>;
  compareVersions: (left: unknown, right: unknown) => number;
  installKind: (input: Record<string, unknown>) => string;
  manifestsToFetch: (input: Record<string, unknown>) => { releaseId: string; version: string; manifestSha256: string }[];
  parseVersion: (text: unknown) => { text: string } | null;
  releaseFor: (manifests: unknown, version: string) => Record<string, string> | null;
};

/** Um manifesto com um pacote por jeito de instalar. */
function manifesto(version: string, extra: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const releaseId = `rel-${version.replace(/[^0-9a-z]/gi, '')}`;
  const pacote = (installKind: string, format: string, fileName: string, sha: string) => ({
    artifactId: `${installKind}-x64`, os: installKind.startsWith('windows') ? 'windows' as const : 'linux' as const,
    arch: 'x64' as const, format, installKind: installKind as never, fileName,
    size: 100_000, sha256: sha.repeat(64).slice(0, 64), signatureKeyId: 'k1',
    storagePath: `releases/${version}/${fileName}`,
  });
  return {
    contract: CONTRACT_VERSION, releaseId, version, channel: 'stable',
    commit: '0'.repeat(40), createdAt: '2026-09-10T12:00:00.000Z',
    title: `Tumacord ${version} — alguma manchete`, notes: 'Uma coisa mudou.',
    artifacts: [
      pacote('linux-managed', 'tar.gz', `tumacord-${version}.tar.gz`, 'a'),
      pacote('linux-appimage', 'AppImage', `Tumacord-${version}.AppImage`, 'b'),
      pacote('windows-installed', 'exe', `Tumacord-${version}-Setup.exe`, 'c'),
      pacote('windows-portable', 'exe', `Tumacord-${version}-portable.exe`, 'd'),
    ],
    ...extra,
  };
}

function entrada(version: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    releaseId: `rel-${version.replace(/[^0-9a-z]/gi, '')}`, version, state: 'published',
    publishedAt: '2026-09-10T12:00:00.000Z', manifestSha256: '', ...extra,
  };
}

function catalogo(entries: CatalogEntry[]): Catalog {
  return {
    contract: CONTRACT_VERSION, sequence: 1,
    createdAt: '2026-09-10T12:00:00.000Z', expiresAt: '2026-12-31T00:00:00.000Z',
    channels: { stable: { entries }, test: { entries: [] } },
  };
}

const escolher = (entries: CatalogEntry[], manifests: ReleaseManifest[], currentVersion: string, kind = 'windows-installed') =>
  chooseFromCatalog({ catalog: catalogo(entries), manifests, currentVersion, kind, arch: 'x64' });

// ── Ordem de versões ───────────────────────────────────────────────────────
//
// A numeração deste projeto já passou por 0.7.10 e 0.7.11. Comparar como texto
// diria que a 0.8.9 é mais nova que a 0.8.10, e o aplicativo pararia de
// oferecer atualização exatamente quando ela existisse.

test('0.8.10 é mais nova que 0.8.9, e a revisão vem depois da versão', () => {
  assert.equal(compareVersions('0.8.10', '0.8.9'), 1);
  assert.equal(compareVersions('v0.9.0', '0.8.10'), 1);
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  // A convenção da 0.9.9-1: o sufixo numérico é a revisão de manutenção e vem
  // *depois* da versão que ela corrige. `rc` saiu da convenção — quem é ensaio
  // é decidido pelo canal, que é um campo separado do catálogo.
  assert.equal(compareVersions('0.9.0-1', '0.9.0'), 1);
  assert.equal(parseVersion('nada disso'), null);
  assert.equal(parseVersion('0.9.0-rc1'), null);
});

// A regressão que dá nome à revisão: quem está na 0.9.9 precisa receber a
// 0.9.9-1 como atualização, e não como um passo atrás.
test('a revisão de manutenção é oferecida a quem está na versão que ela corrige', () => {
  const decisao = escolher([entrada('0.9.9-1')], [manifesto('0.9.9-1')], '0.9.9');
  assert.equal(decisao.status, 'available');
  assert.equal(decisao.version, '0.9.9-1');
  // E o contrário não vale: quem já está na revisão não recebe a 0.9.9 de volta.
  assert.equal(escolher([entrada('0.9.9')], [manifesto('0.9.9')], '0.9.9-1').status, 'up-to-date');
});

test('nunca se oferece uma versão mais antiga do que a instalada', () => {
  const decisao = escolher([entrada('0.8.7'), entrada('0.8.8')], [manifesto('0.8.7'), manifesto('0.8.8')], '0.9.0');
  assert.equal(decisao.status, 'up-to-date');
  assert.equal(decisao.version, undefined);
  // "Não é mais nova" é o caso comum e não vira linha na tela: a lista de
  // puladas existe para explicar o que **deveria** aparecer e não aparece.
  assert.deepEqual(decisao.skipped, []);
});

// ── Versões bloqueadas e retiradas ─────────────────────────────────────────

test('a 0.8.9 não é oferecida a ninguém, nem sendo a mais nova', () => {
  const decisao = escolher([entrada('0.8.9')], [manifesto('0.8.9')], '0.8.8');
  assert.equal(decisao.status, 'up-to-date');
  assert.deepEqual(decisao.skipped, [{ version: '0.8.9', reason: 'as resoluções e o FPS da transmissão saem errados' }]);
  assert.match(brokenReason('0.8.9'), /resoluções/);
  assert.equal(brokenReason('9.9.9'), '');
});

test('quem está na 0.8.9 é avisado de que a própria versão foi retirada', () => {
  const decisao = escolher([entrada('0.9.0')], [manifesto('0.9.0')], '0.8.9');
  assert.match(decisao.installedBroken, /resoluções e o FPS/);
  assert.equal(decisao.status, 'available');
  assert.equal(decisao.version, '0.9.0');
});

// A retirada agora mora **só** no catálogo assinado. Até a 0.9.9 ela era
// declarada por um comentário de HTML nas notas da Release — uma segunda
// autoridade sobre o que está retirado, e a segunda é sempre a que alguém
// consegue forjar.
test('o catálogo retira uma versão que esta cópia não conhecia', () => {
  const decisao = escolher(
    [entrada('0.9.5', { state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado', at: '' } }), entrada('0.9.1')],
    [manifesto('0.9.5'), manifesto('0.9.1')],
    '0.9.0',
  );
  assert.equal(decisao.version, '0.9.1', 'a mais nova é pulada e a anterior boa é oferecida');
  assert.deepEqual(decisao.skipped, [{ version: '0.9.5', reason: 'o áudio sai errado' }]);
});

test('quem está numa versão retirada depois de instalada é avisado', () => {
  const decisao = escolher(
    [entrada('0.9.9-1', { state: 'withdrawn', withdrawn: { reason: 'trava ao entrar na call', at: '' } })],
    [manifesto('0.9.9-1')],
    '0.9.9-1',
  );
  assert.equal(decisao.installedBroken, 'trava ao entrar na call');
  assert.equal(decisao.status, 'up-to-date');
});

test('uma entrada que não está publicada não vira oferta', () => {
  const decisao = escolher([entrada('0.9.5', { state: 'withdrawn' as never })], [manifesto('0.9.5')], '0.9.0');
  assert.equal(decisao.status, 'up-to-date');
});

// ── Pacote por jeito de instalar ───────────────────────────────────────────

test('cada tipo de instalação recebe o pacote que serve para ele', () => {
  const manifests = [manifesto('0.9.1')];
  const entries = [entrada('0.9.1')];
  assert.match(escolher(entries, manifests, '0.9.0', 'windows-installed').asset.name, /-Setup\.exe$/);
  assert.match(escolher(entries, manifests, '0.9.0', 'windows-portable').asset.name, /-portable\.exe$/);
  assert.match(escolher(entries, manifests, '0.9.0', 'linux-managed').asset.name, /\.tar\.gz$/);
  assert.match(escolher(entries, manifests, '0.9.0', 'linux-appimage').asset.name, /\.AppImage$/);
});

test('sem saber como esta cópia foi instalada, não há pacote a aplicar', () => {
  const decisao = escolher([entrada('0.9.1')], [manifesto('0.9.1')], '0.9.0', 'unknown');
  assert.equal(decisao.status, 'no-asset');
  assert.equal(decisao.asset, null);
});

test('sem pacote para este jeito de instalar, a versão é anunciada sem botão de aplicar', () => {
  const semWindows = manifesto('0.9.1');
  semWindows.artifacts = semWindows.artifacts.filter((a) => !a.installKind.startsWith('windows'));
  const decisao = escolher([entrada('0.9.1')], [semWindows], '0.9.0', 'windows-installed');
  // A diferença é dita, em vez de virar "não há atualização" — que mandaria a
  // pessoa procurar defeito no lugar errado.
  assert.equal(decisao.status, 'no-asset');
  assert.equal(decisao.version, '0.9.1', 'a versão aparece, com as notas');
  assert.equal(decisao.asset, null, 'e sem pacote, não há botão de aplicar');
  assert.match(decisao.skipped[0].reason, /windows-installed/);
});

test('o pacote carrega o que o download precisa, e nenhuma URL', () => {
  const decisao = escolher([entrada('0.9.1')], [manifesto('0.9.1')], '0.9.0');
  assert.equal(decisao.asset.releaseId, 'rel-091');
  assert.equal(decisao.asset.artifactId, 'windows-installed-x64');
  assert.match(decisao.asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(Number.isFinite(decisao.asset.size), true);
  // Uma URL num documento assinado poderia mandar o aplicativo buscar binário
  // noutro domínio. O download pede por identificador.
  assert.equal('url' in decisao.asset, false);
  assert.equal(decisao.pageUrl, '', 'numa distribuição privada não há página pública');
});

// ── Manifesto ausente ou incoerente ────────────────────────────────────────

test('uma entrada sem manifesto verificado não vira oferta, e isso é dito', () => {
  const decisao = escolher([entrada('0.9.1')], [], '0.9.0');
  assert.equal(decisao.status, 'up-to-date');
  assert.equal(decisao.skipped[0].version, '0.9.1');
  assert.match(decisao.skipped[0].reason, /manifesto/);
});

test('um manifesto que declara outra versão é recusado', () => {
  const trocado = manifesto('0.9.1');
  trocado.version = '0.9.2';
  const decisao = escolher([entrada('0.9.1')], [trocado], '0.9.0');
  assert.equal(decisao.status, 'up-to-date');
  assert.match(decisao.skipped[0].reason, /outra versão/);
});

// ── Parada obrigatória ─────────────────────────────────────────────────────

test('uma parada obrigatória entra na frente da mais nova, e a mais nova é dita', () => {
  const decisao = escolher(
    [entrada('0.9.5', { requiredStop: { reason: 'ela converte os dados do formato anterior' } }), entrada('0.9.9')],
    [manifesto('0.9.5'), manifesto('0.9.9')],
    '0.9.0',
  );
  assert.equal(decisao.version, '0.9.5');
  assert.equal(decisao.latest, '0.9.9', 'a mais nova continua sendo dita');
  assert.deepEqual(decisao.mustStop, { version: '0.9.5', reason: 'ela converte os dados do formato anterior' });
});

test('uma parada obrigatória acima da mais nova não atrapalha', () => {
  const decisao = escolher([entrada('0.9.9', { requiredStop: { reason: 'x' } })], [manifesto('0.9.9')], '0.9.0');
  assert.equal(decisao.version, '0.9.9');
  assert.equal(decisao.latest, '');
  assert.equal(decisao.mustStop, null);
});

test('uma versão que exige atualizador mais novo é dita, e não some', () => {
  const exigente = manifesto('1.0.0', { compatibility: { minUpdaterVersion: '0.9.9-1' } });
  const decisao = escolher([entrada('1.0.0')], [exigente], '0.9.8');
  assert.equal(decisao.status, 'up-to-date');
  assert.match(decisao.skipped[0].reason, /0\.9\.9-1/);
});

// ── Notas da versão instalada ──────────────────────────────────────────────

test('as notas da versão instalada saem do manifesto dela', () => {
  const instalada = releaseFor([manifesto('0.9.1')], '0.9.1');
  assert.equal(instalada?.version, '0.9.1');
  assert.equal(instalada?.title, 'Tumacord 0.9.1 — alguma manchete');
  assert.equal(instalada?.notes, 'Uma coisa mudou.');
  assert.equal(instalada?.pageUrl, '', 'não há página pública para linkar');
});

test('sem manifesto da versão instalada, não há notas inventadas', () => {
  assert.equal(releaseFor([manifesto('0.9.1')], '0.9.0'), null);
  assert.equal(releaseFor([], '0.9.1'), null);
  assert.equal(releaseFor([manifesto('0.9.1')], 'nada disso'), null);
});

// ── Estados de borda ───────────────────────────────────────────────────────

test('sem catálogo, o estado é dito e nada é oferecido', () => {
  const decisao = chooseFromCatalog({ catalog: null, manifests: [], currentVersion: '0.9.9', kind: 'linux-managed' });
  assert.equal(decisao.status, 'no-catalog');
  assert.equal(decisao.version, undefined);
});

test('uma versão instalada que não é versão é dita como tal', () => {
  const decisao = chooseFromCatalog({ catalog: catalogo([]), manifests: [], currentVersion: 'sei-la', kind: 'linux-managed' });
  assert.equal(decisao.status, 'unknown-version');
});

test('um canal vazio não é erro: é estar em dia', () => {
  assert.equal(escolher([], [], '0.9.9').status, 'up-to-date');
});

// ── Quais manifestos buscar ────────────────────────────────────────────────
//
// O catálogo lista tudo; buscar o manifesto de cada entrada seria pedir dez
// documentos para usar um.

test('só a instalada e as acima dela têm manifesto buscado', () => {
  const catalog = catalogo([entrada('0.8.9'), entrada('0.9.9'), entrada('0.9.9-1'), entrada('1.0.0')]);
  const querer = manifestsToFetch({ catalog, currentVersion: '0.9.9' });
  assert.deepEqual(querer.map((item) => item.version), ['1.0.0', '0.9.9-1', '0.9.9']);
});

test('a lista de manifestos tem teto', () => {
  const muitas = Array.from({ length: 30 }, (_, index) => entrada(`0.9.${index + 1}`));
  assert.equal(manifestsToFetch({ catalog: catalogo(muitas), currentVersion: '0.9.0' }).length, 6);
  assert.equal(manifestsToFetch({ catalog: catalogo(muitas), currentVersion: '0.9.0', limit: 2 }).length, 2);
});

test('entrada retirada não tem manifesto buscado', () => {
  const catalog = catalogo([entrada('0.9.9', { state: 'withdrawn' })]);
  assert.deepEqual(manifestsToFetch({ catalog, currentVersion: '0.9.0' }), []);
});

// ── Como esta cópia foi instalada ──────────────────────────────────────────

test('o jeito de instalar é reconhecido pelo lugar onde a cópia mora', () => {
  assert.equal(installKind({ platform: 'win32', env: {} }), 'windows-installed');
  assert.equal(installKind({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' } }), 'windows-portable');
  assert.equal(installKind({ platform: 'linux', env: { APPIMAGE: '/home/x/T.AppImage' } }), 'linux-appimage');
  assert.equal(installKind({
    platform: 'linux', env: {}, home: '/home/renan',
    resourcesPath: '/home/renan/.local/share/tumacord/versions/0.9.9-1/resources',
  }), 'linux-managed');
  // Uma cópia que não caiu em nenhum dos casos vira `unknown`, e `unknown` não
  // escreve nada em lugar nenhum.
  assert.equal(installKind({ platform: 'linux', env: {}, home: '/home/renan', resourcesPath: '/opt/outro/resources' }), 'unknown');
  assert.equal(installKind({ platform: 'darwin', env: {} }), 'unknown');
});
