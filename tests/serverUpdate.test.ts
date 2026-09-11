import assert from 'node:assert/strict';
import test from 'node:test';
import { TAG_PATTERN, compareVersions, defaultChoice, installableTag, offeredReleases, parseVersion } from '../shared/serverUpdate';

// A metade que decide quais versões o painel do servidor pode oferecer.
//
// A regra de segurança que este arquivo sustenta: o navegador manda uma
// etiqueta, e só vale a etiqueta que estiver na lista que o próprio servidor
// buscou. Tudo o que não passa por `installableTag` não chega ao disco.

const releases = [
  { tag_name: 'v0.9.9', published_at: '2026-09-12T10:00:00Z', html_url: 'https://exemplo/0.9.9' },
  { tag_name: 'v0.9.8', published_at: '2026-09-11T10:00:00Z', html_url: 'https://exemplo/0.9.8' },
  { tag_name: 'v0.9.0-rc1', published_at: '2026-09-01T10:00:00Z', prerelease: true },
  { tag_name: 'v0.8.10', published_at: '2026-08-20T10:00:00Z' },
  { tag_name: 'v0.8.9', published_at: '2026-08-10T10:00:00Z' },
  { tag_name: 'rascunho', draft: true },
  { tag_name: 'nao-e-versao' },
];

test('0.8.10 é maior que 0.8.9, e a lista vem da mais nova para a mais antiga', () => {
  assert.equal(compareVersions('0.8.10', '0.8.9'), 1, 'a comparação textual diria o contrário');
  assert.deepEqual(offeredReleases(releases, '0.9.8').map((entrada) => entrada.tag),
    ['v0.9.9', 'v0.9.8', 'v0.9.0-rc1', 'v0.8.10', 'v0.8.9']);
});

test('rascunho e o que não é versão ficam de fora', () => {
  const lista = offeredReleases(releases, '0.9.8');
  assert.equal(lista.some((entrada) => entrada.tag.includes('rascunho')), false);
  assert.equal(lista.some((entrada) => entrada.tag.includes('nao-e-versao')), false);
});

test('a versão em uso é apontada como tal', () => {
  const lista = offeredReleases(releases, '0.9.8');
  assert.deepEqual(lista.filter((entrada) => entrada.current).map((entrada) => entrada.tag), ['v0.9.8']);
});

// Esconder a versão quebrada faria a página do GitHub mostrar uma coisa e o
// painel outra, sem explicação. Ela aparece, com o motivo, e não é aplicável.
test('uma versão retirada continua na lista, dita, e não pode ser aplicada', () => {
  const lista = offeredReleases(releases, '0.9.8');
  const quebrada = lista.find((entrada) => entrada.tag === 'v0.8.9');
  assert.ok(quebrada?.broken, 'a 0.8.9 é a que já estava quebrada quando esta cópia foi compilada');
  assert.equal(installableTag(lista, 'v0.8.9'), null);
});

test('o marcador nas notas retira uma versão publicada depois desta cópia', () => {
  const lista = offeredReleases([{ tag_name: 'v1.2.3', body: 'texto\n<!-- tumacord:versao-quebrada -->\nmais texto' }], '0.9.8');
  assert.ok(lista[0].broken);
  assert.equal(installableTag(lista, 'v1.2.3'), null);
});

// --- o que o navegador não consegue fazer -----------------------------------

test('só a forma de etiqueta deste projeto é aceita', () => {
  const lista = offeredReleases(releases, '0.9.8');
  for (const tentativa of [
    'main',
    'release/entrada-e-contas-v0.9.8',
    'v0.9.9; rm -rf /',
    'v0.9.9 && curl http://exemplo',
    '$(curl http://exemplo)',
    '../../etc/passwd',
    'v0.9.9\n',
    'V0.9.9',
    'v0.9',
    '',
  ]) {
    assert.equal(TAG_PATTERN.test(tentativa), false, `${JSON.stringify(tentativa)} não tem a forma de uma etiqueta`);
    assert.equal(installableTag(lista, tentativa), null, `${JSON.stringify(tentativa)} não pode ser aplicado`);
  }
});

test('uma etiqueta bem formada que não está publicada também é recusada', () => {
  const lista = offeredReleases(releases, '0.9.8');
  assert.equal(installableTag(lista, 'v9.9.9'), null, 'o servidor só aplica o que ele mesmo viu publicado');
  assert.equal(installableTag(lista, 'v0.9.9')?.tag, 'v0.9.9');
});

test('nada que não seja texto atravessa', () => {
  const lista = offeredReleases(releases, '0.9.8');
  for (const tentativa of [null, undefined, 42, {}, ['v0.9.9'], { tag: 'v0.9.9' }]) {
    assert.equal(installableTag(lista, tentativa), null);
  }
});

test('uma lista que não é lista não vira oferta nenhuma', () => {
  for (const tentativa of [null, undefined, 'v0.9.9', { releases: [] }]) {
    assert.deepEqual(offeredReleases(tentativa, '0.9.8'), []);
  }
  assert.equal(parseVersion('sem versão'), null);
});

// A tela vem marcando alguma coisa, e essa escolha não pode ser um passo
// atrás: "a primeira da lista que não é a atual" oferecia a versão anterior
// quando o servidor já estava na mais nova.
test('a escolha padrão é a mais nova acima da que está rodando', () => {
  assert.equal(defaultChoice(offeredReleases(releases, '0.9.7')), 'v0.9.9');
  assert.equal(defaultChoice(offeredReleases(releases, '0.8.10')), 'v0.9.9');
});

test('já na mais nova, a escolha padrão é ela mesma — e não a anterior', () => {
  assert.equal(defaultChoice(offeredReleases(releases, '0.9.9')), 'v0.9.9');
});

test('uma versão quebrada não vira a escolha padrão', () => {
  const lista = offeredReleases([
    { tag_name: 'v2.0.0', body: '<!-- tumacord:versao-quebrada -->' },
    { tag_name: 'v1.5.0' },
  ], '1.0.0');
  assert.equal(defaultChoice(lista), 'v1.5.0');
});

test('voltar para uma versão anterior continua possível, e vem dito', () => {
  const lista = offeredReleases(releases, '0.9.9');
  const anterior = lista.find((entrada) => entrada.tag === 'v0.9.8');
  assert.equal(anterior?.newer, false);
  assert.equal(anterior?.current, false);
  assert.equal(installableTag(lista, 'v0.9.8')?.tag, 'v0.9.8', 'voltar é caminho legítimo quando algo quebrou');
});

