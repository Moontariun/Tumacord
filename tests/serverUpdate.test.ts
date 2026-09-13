import assert from 'node:assert/strict';
import test from 'node:test';
import { TAG_PATTERN, compareVersions, defaultChoice, installableTag, offeredReleases, parseVersion } from '../shared/serverUpdate';

// A metade que decide quais versões o painel do servidor pode oferecer.
//
// A regra de segurança que este arquivo sustenta: o navegador manda uma
// etiqueta, e só vale a etiqueta que estiver no catálogo que o próprio
// servidor leu. Tudo o que não passa por `installableTag` não chega ao
// executor.

function entry(version: string, extra: Record<string, unknown> = {}) {
  return {
    releaseId: `rel_stable_${version.replace(/[^0-9A-Za-z]/g, '-')}`,
    version,
    state: 'published',
    publishedAt: '2026-09-12T10:00:00Z',
    ...extra,
  };
}

/** O catálogo como o serviço de atualizações o publica: assinado, com canais. */
const catalog = {
  payload: {
    sequence: 7,
    channels: {
      stable: {
        entries: [
          entry('0.9.9'),
          entry('0.9.8'),
          // Uma pré-versão: sob SemVer ela vem *antes* da final de mesmo número.
          entry('0.9.8-rc.1'),
          entry('0.8.10'),
          entry('0.8.9', { state: 'withdrawn', withdrawn: { reason: 'as resoluções e o FPS da transmissão saem errados' } }),
          // Desde a 0.10.0 `rc` é versão válida — o que decide quem é ensaio
          // continua sendo o canal, e este catálogo é o estável.
          { releaseId: 'rel_stable_rc', version: '0.9.0-rc1', state: 'published' },
          { releaseId: 'rel_nao_versao', version: 'nao-e-versao', state: 'published' },
          // Sem identificador o executor não teria o que aplicar.
          { version: '0.9.7', state: 'published' },
        ],
      },
    },
  },
  signature: { keyId: 'nao-importa-aqui', value: '' },
};

test('0.8.10 é maior que 0.8.9, e a lista vem da mais nova para a mais antiga', () => {
  assert.equal(compareVersions('0.8.10', '0.8.9'), 1, 'a comparação textual diria o contrário');
  assert.deepEqual(offeredReleases(catalog, '0.9.8').map((item) => item.tag),
    ['v0.9.9', 'v0.9.8', 'v0.9.8-rc.1', 'v0.9.0-rc1', 'v0.8.10', 'v0.8.9']);
});

test('o que não é versão e o que não tem identificador ficam de fora', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  assert.equal(offers.some((item) => item.releaseId === 'rel_nao_versao'), false);
  assert.equal(offers.some((item) => item.version === '0.9.7'), false, 'sem releaseId não há o que aplicar');
});

test('cada oferta carrega o identificador exato com que o executor a aplica', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  assert.equal(offers.find((item) => item.tag === 'v0.9.8-rc.1')?.releaseId, 'rel_stable_0-9-8-rc-1');
});

// O sentido do sufixo mudou na 0.10.0, e o painel precisa mostrar isso: uma
// pré-versão do mesmo número NÃO é um passo à frente. Quem está na 0.9.8 não
// pode ver a 0.9.8-rc.1 marcada como novidade.
test('uma pré-versão fica abaixo da versão final de mesmo número', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  assert.equal(offers.find((item) => item.tag === 'v0.9.8-rc.1')?.newer, false, '0.9.8-rc.1 vem antes da 0.9.8');
  assert.equal(offers.find((item) => item.tag === 'v0.9.9')?.newer, true);
  assert.equal(offers.find((item) => item.tag === 'v0.9.8')?.current, true);
});

test('a versão em uso é apontada como tal', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  assert.deepEqual(offers.filter((item) => item.current).map((item) => item.tag), ['v0.9.8']);
});

// Esconder a versão retirada faria o catálogo ter uma coisa e o painel outra,
// sem explicação. Ela aparece, com o motivo, e não é aplicável.
test('uma versão retirada continua na lista, dita, e não pode ser aplicada', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  const withdrawn = offers.find((item) => item.tag === 'v0.8.9');
  assert.equal(withdrawn?.broken, 'as resoluções e o FPS da transmissão saem errados');
  assert.equal(installableTag(offers, 'v0.8.9'), null);
});

test('uma retirada sem motivo escrito continua retirada', () => {
  const offers = offeredReleases({ channels: { stable: { entries: [entry('1.2.3', { state: 'withdrawn' })] } } }, '0.9.8');
  assert.ok(offers[0].broken, 'um motivo em branco não pode virar "pode instalar"');
  assert.equal(installableTag(offers, 'v1.2.3'), null);
});

test('o documento assinado e o conteúdo dele produzem a mesma lista', () => {
  // O executor devolve só o conteúdo; um teste com o documento inteiro prova
  // que desembrulhar numa camada a mais não deixa o painel vazio sem dizer.
  assert.deepEqual(offeredReleases(catalog, '0.9.8'), offeredReleases(catalog.payload, '0.9.8'));
});

test('o canal é um campo, e vem dito em cada oferta', () => {
  const offers = offeredReleases({
    channels: {
      stable: { entries: [entry('0.9.9-1')] },
      test: { entries: [entry('0.9.9-2', { releaseId: 'rel_test_0-9-9-2' })] },
    },
  }, '0.9.9');
  assert.equal(offers.find((item) => item.version === '0.9.9-1')?.channel, 'stable');
  assert.equal(offers.find((item) => item.version === '0.9.9-2')?.channel, 'test');
});

test('o aviso de parada obrigatória chega ao painel', () => {
  const offers = offeredReleases({ channels: { stable: { entries: [entry('1.0.0', { requiredStop: 'Passe pela 0.9.9-1 antes.' })] } } }, '0.9.8');
  assert.equal(offers[0].requiredStop, 'Passe pela 0.9.9-1 antes.');
});

// --- o que o navegador não consegue fazer -----------------------------------

test('só a forma de etiqueta deste projeto é aceita', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  for (const attempt of [
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
    assert.equal(TAG_PATTERN.test(attempt), false, `${JSON.stringify(attempt)} não tem a forma de uma etiqueta`);
    assert.equal(installableTag(offers, attempt), null, `${JSON.stringify(attempt)} não pode ser aplicado`);
  }
});

test('uma etiqueta bem formada que não está publicada também é recusada', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  assert.equal(installableTag(offers, 'v9.9.9'), null, 'o servidor só aplica o que ele mesmo viu publicado');
  assert.equal(installableTag(offers, 'v0.9.9')?.tag, 'v0.9.9');
});

test('nada que não seja texto atravessa', () => {
  const offers = offeredReleases(catalog, '0.9.8');
  for (const attempt of [null, undefined, 42, {}, ['v0.9.9'], { tag: 'v0.9.9' }]) {
    assert.equal(installableTag(offers, attempt), null);
  }
});

test('o que não é catálogo não vira oferta nenhuma', () => {
  for (const attempt of [null, undefined, 'v0.9.9', [], { channels: null }, { channels: { stable: { entries: 'x' } } }]) {
    assert.deepEqual(offeredReleases(attempt, '0.9.8'), []);
  }
  assert.equal(parseVersion('sem versão'), null);
});

// A tela vem marcando alguma coisa, e essa escolha não pode ser um passo
// atrás: "a primeira da lista que não é a atual" oferecia a versão anterior
// quando o servidor já estava na mais nova.
test('a escolha padrão é a mais nova acima da que está rodando', () => {
  assert.equal(defaultChoice(offeredReleases(catalog, '0.9.7')), 'v0.9.9');
  assert.equal(defaultChoice(offeredReleases(catalog, '0.8.10')), 'v0.9.9');
});

test('já na mais nova, a escolha padrão é ela mesma — e não a anterior', () => {
  assert.equal(defaultChoice(offeredReleases(catalog, '0.9.9')), 'v0.9.9');
});

test('uma versão retirada não vira a escolha padrão', () => {
  const offers = offeredReleases({
    channels: { stable: { entries: [entry('2.0.0', { state: 'withdrawn', withdrawn: { reason: 'quebra a call' } }), entry('1.5.0')] } },
  }, '1.0.0');
  assert.equal(defaultChoice(offers), 'v1.5.0');
});

test('voltar para uma versão anterior continua possível, e vem dito', () => {
  const offers = offeredReleases(catalog, '0.9.9');
  const previous = offers.find((item) => item.tag === 'v0.9.8');
  assert.equal(previous?.newer, false);
  assert.equal(previous?.current, false);
  assert.equal(installableTag(offers, 'v0.9.8')?.tag, 'v0.9.8', 'voltar é caminho legítimo quando algo quebrou');
});
