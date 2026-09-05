import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOrder,
  buildChannelTree,
  canChangeChannelType,
  canDeleteChannel,
  detachCategory,
  MAX_CHANNEL_NAME,
  MAX_TOPIC,
  MAX_USER_LIMIT,
  nextPosition,
  normalizePositions,
  slugify,
  validateCategoryName,
  validateChannelName,
  validateTopic,
  validateUserLimit,
  type CategoryRecord,
  type ChannelRecord,
} from '../server/channels';

const canal = (id: string, patch: Partial<ChannelRecord> = {}): ChannelRecord => ({ id, name: id, type: 'text', ...patch });

test('nome de canal aceita o que uma pessoa digita e recusa o resto', () => {
  assert.equal(validateChannelName('  geral  ').value, 'geral');
  assert.equal(validateChannelName('bate   papo').value, 'bate papo', 'espaços repetidos viram um só');
  assert.equal(validateChannelName('programação').value, 'programação');
  assert.equal(validateChannelName('sala-1_teste.old').ok, true);
  assert.equal(validateChannelName('').ok, false);
  assert.equal(validateChannelName('   ').ok, false);
  assert.equal(validateChannelName(42).ok, false);
  assert.equal(validateChannelName('a'.repeat(MAX_CHANNEL_NAME + 1)).ok, false);
  assert.equal(validateChannelName('<script>').ok, false);
  assert.equal(validateChannelName('canal/../etc').ok, false);
});

test('a mensagem de erro da categoria fala de categoria, não de canal', () => {
  assert.match(validateCategoryName('').error ?? '', /categoria/);
  assert.equal(validateCategoryName('Administração').value, 'Administração');
});

test('tópico é opcional e limitado', () => {
  assert.deepEqual(validateTopic(undefined), { ok: true, value: '' });
  assert.deepEqual(validateTopic(null), { ok: true, value: '' });
  assert.equal(validateTopic('  conversa do grupo  ').value, 'conversa do grupo');
  assert.equal(validateTopic('a'.repeat(MAX_TOPIC + 1)).ok, false);
  assert.equal(validateTopic(7).ok, false);
});

// Zero significa "sem limite", que é diferente de "ninguém entra".
test('limite de pessoas só vale em voz, e zero é ausência de limite', () => {
  assert.deepEqual(validateUserLimit(undefined, 'voice'), { ok: true, value: undefined });
  assert.deepEqual(validateUserLimit(0, 'voice'), { ok: true, value: undefined });
  assert.deepEqual(validateUserLimit(8, 'voice'), { ok: true, value: 8 });
  assert.equal(validateUserLimit(8, 'text').ok, false, 'canal de texto não tem limite de pessoas');
  assert.equal(validateUserLimit(-1, 'voice').ok, false);
  assert.equal(validateUserLimit(MAX_USER_LIMIT + 1, 'voice').ok, false);
  assert.equal(validateUserLimit(2.5, 'voice').ok, false);
});

test('o identificador sai do nome sem acento nem símbolo', () => {
  assert.equal(slugify('Programação'), 'programacao');
  assert.equal(slugify('  Bate Papo  '), 'bate-papo');
  assert.equal(slugify('!!!'), '');
});

// Converter uma conversa em sala de voz perderia as mensagens.
test('trocar o tipo é recusado com explicação quando há conteúdo ou gente', () => {
  const alvo = canal('geral');
  assert.equal(canChangeChannelType(alvo, false, false).ok, true);
  assert.match(canChangeChannelType(alvo, true, false).error ?? '', /já tem mensagens/);
  assert.match(canChangeChannelType(alvo, false, true).error ?? '', /gente nesta call/);
});

test('posições são esparsas, para inserir sem reescrever a lista inteira', () => {
  assert.equal(nextPosition([]), 100);
  assert.equal(nextPosition([{ position: 100 }, { position: 300 }]), 400);
  const normalizados = normalizePositions([canal('c', { position: 500 }), canal('a', { position: 100 }), canal('b', { position: 300 })]);
  assert.deepEqual(normalizados.map((c) => c.id), ['a', 'b', 'c']);
  assert.deepEqual(normalizados.map((c) => c.position), [100, 200, 300]);
});

test('canal sem posição entra na ordem em que apareceu', () => {
  const normalizados = normalizePositions([canal('a'), canal('b'), canal('c')]);
  assert.deepEqual(normalizados.map((c) => c.id), ['a', 'b', 'c']);
});

test('reordenar respeita a ordem pedida', () => {
  const canais = [canal('a', { position: 100 }), canal('b', { position: 200 }), canal('c', { position: 300 })];
  assert.deepEqual(applyOrder(canais, ['c', 'a', 'b']).map((c) => c.id), ['c', 'a', 'b']);
});

// Dois administradores arrastando ao mesmo tempo produzem uma ordem
// inesperada, nunca um canal sumido.
test('ids desconhecidos são ignorados e os omitidos vão para o fim, sem perder nada', () => {
  const canais = [canal('a', { position: 100 }), canal('b', { position: 200 }), canal('c', { position: 300 })];
  const resultado = applyOrder(canais, ['c', 'fantasma', 'c']);
  assert.deepEqual(resultado.map((c) => c.id), ['c', 'a', 'b']);
  assert.equal(resultado.length, 3, 'nenhum canal pode desaparecer em uma reordenação');
});

test('a árvore agrupa por categoria e ordena os dois níveis', () => {
  const categorias: CategoryRecord[] = [{ id: 'voz', name: 'VOZ', position: 200 }, { id: 'geral', name: 'GERAL', position: 100 }];
  const canais = [
    canal('memes', { categoryId: 'geral', position: 200 }),
    canal('geral', { categoryId: 'geral', position: 100 }),
    canal('jogos', { categoryId: 'voz', type: 'voice', position: 100 }),
    canal('solto', { position: 900 }),
  ];
  const arvore = buildChannelTree(canais, categorias);
  assert.deepEqual(arvore.categories.map((c) => c.id), ['geral', 'voz']);
  assert.deepEqual(arvore.categories[0].channels.map((c) => c.id), ['geral', 'memes']);
  assert.deepEqual(arvore.uncategorized.map((c) => c.id), ['solto']);
});

// Perder um canal porque a categoria foi apagada seria perder conversa.
test('canal de categoria inexistente cai em sem-categoria, não some', () => {
  const arvore = buildChannelTree([canal('orfao', { categoryId: 'apagada' })], []);
  assert.deepEqual(arvore.uncategorized.map((c) => c.id), ['orfao']);
});

test('apagar categoria solta os canais dela sem apagá-los', () => {
  const canais = [canal('a', { categoryId: 'x' }), canal('b', { categoryId: 'y' })];
  const depois = detachCategory(canais, 'x');
  assert.equal(depois.length, 2);
  assert.equal(depois[0].categoryId, undefined);
  assert.equal(depois[1].categoryId, 'y');
});

// Sem canal de texto o grupo fica sem lugar para conversar e sem como recriar
// um pela interface normal.
test('o último canal de texto não pode ser apagado', () => {
  const canais = [canal('geral'), canal('jogos', { type: 'voice' })];
  assert.equal(canDeleteChannel(canais, 'geral').ok, false);
  assert.match(canDeleteChannel(canais, 'geral').error ?? '', /último canal de texto/);
  assert.equal(canDeleteChannel(canais, 'jogos').ok, true, 'o último canal de voz pode sair');
  assert.equal(canDeleteChannel([...canais, canal('memes')], 'geral').ok, true);
  assert.equal(canDeleteChannel(canais, 'inexistente').ok, false);
});
