import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore, duplicateUsernames, type StoredUser } from '../server/store';
import { normalizeUsername } from '../server/auth';

// A unicidade de conta, que é uma promessa sobre identidade: enquanto ela não
// vale, duas pessoas diferentes podem ser a mesma pessoa para o servidor.
//
// A reprodução da auditoria: seis pedidos simultâneos do mesmo nome
// produziram seis contas. A causa é que a conferência morava na rota, antes de
// `hashPassword` — que é assíncrono e devolve o laço de eventos —, e os seis
// passavam pela conferência antes de qualquer um chegar à inserção.

async function comStore(corpo: (store: JsonStore) => Promise<void>): Promise<void> {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    const store = new JsonStore(pasta);
    await store.load();
    await corpo(store);
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

let contador = 0;
function conta(username: string, extra: Partial<StoredUser> = {}): StoredUser {
  contador += 1;
  return {
    id: `user-${contador}`,
    username,
    normalizedUsername: normalizeUsername(username),
    passwordHash: `hash-de-${username}-${contador}`,
    createdAt: new Date(1_700_000_000_000 + contador * 1_000).toISOString(),
    ...extra,
  };
}

// ── A corrida ──────────────────────────────────────────────────────────────

test('seis pedidos simultâneos do mesmo nome produzem uma conta, não seis', async () => {
  await comStore(async (store) => {
    const resultados = await Promise.all(
      Array.from({ length: 6 }, () => store.createUser(conta('Renan'))),
    );
    const criadas = resultados.filter((resultado) => resultado.created);
    assert.equal(criadas.length, 1, 'exatamente um pedido cria a conta');
    assert.equal(store.users.length, 1);
    assert.equal(store.users.filter((user) => user.normalizedUsername === 'renan').length, 1);
    // Os outros cinco recebem a conta que existe, e não um erro genérico:
    // é isso que deixa o login seguir para a conferência de senha dela.
    for (const recusado of resultados.filter((resultado) => !resultado.created)) {
      assert.equal(recusado.conflict, 'user');
      assert.equal(recusado.existing?.id, criadas[0].user.id);
    }
  });
});

test('a corrida também é vencida quando os nomes diferem só na escrita', async () => {
  await comStore(async (store) => {
    const nomes = ['Renan', 'renan', 'RENAN', '  Renan  ', 'ReNaN'];
    const resultados = await Promise.all(nomes.map((nome) => store.createUser(conta(nome))));
    assert.equal(resultados.filter((resultado) => resultado.created).length, 1);
    assert.equal(store.users.length, 1);
  });
});

test('NFKC, espaço em volta e caixa levam ao mesmo nome', () => {
  const formas = ['Renan', 'renan', 'RENAN', ' Renan ', 'Ｒｅｎａｎ'];
  const normalizados = new Set(formas.map(normalizeUsername));
  assert.equal(normalizados.size, 1, `estas formas deveriam ser o mesmo nome: ${[...normalizados].join(', ')}`);
  assert.equal([...normalizados][0], 'renan');
});

// ── Nome existente com senha diferente ─────────────────────────────────────

test('um nome que já existe não vira conta nova, nem troca a senha de ninguém', async () => {
  await comStore(async (store) => {
    const primeira = await store.createUser(conta('Renan', { passwordHash: 'a-senha-certa' }));
    assert.equal(primeira.created, true);

    const segunda = await store.createUser(conta('renan', { passwordHash: 'outra-senha' }));
    assert.equal(segunda.created, false);
    assert.equal(store.users.length, 1);
    assert.equal(store.users[0].passwordHash, 'a-senha-certa', 'a senha da conta que existe não foi tocada');
    assert.equal(store.users[0].id, primeira.created ? primeira.user.id : '', 'o id da conta é preservado');
  });
});

// ── Reserva de nome ────────────────────────────────────────────────────────

test('o nome de uma conta removida não volta a ficar livre', async () => {
  await comStore(async (store) => {
    const criada = await store.createUser(conta('Renan'));
    assert.equal(criada.created, true);
    const idOriginal = criada.created ? criada.user.id : '';

    assert.equal(await store.removeUser(idOriginal), true);
    assert.equal(store.users.length, 0);

    const reserva = store.reservationFor('renan');
    assert.ok(reserva, 'a reserva sobrevive à remoção');
    assert.equal(reserva.userId, idOriginal, 'o id fica guardado para uma recuperação autorizada');
    assert.ok(reserva.releasedAt, 'a reserva registra quando a conta saiu');

    const tentativa = await store.createUser(conta('renan'));
    assert.equal(tentativa.created, false);
    assert.equal(tentativa.created === false && tentativa.conflict, 'reservation');
    assert.equal(store.users.length, 0, 'ninguém herda a identidade de quem saiu');
  });
});

test('a reserva sobrevive ao reinício do servidor', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    const primeiro = new JsonStore(pasta);
    await primeiro.load();
    const criada = await primeiro.createUser(conta('Renan'));
    await primeiro.removeUser(criada.created ? criada.user.id : '');

    const segundo = new JsonStore(pasta);
    await segundo.load();
    assert.ok(segundo.reservationFor('renan'), 'a reserva foi gravada e lida de volta');
    assert.equal((await segundo.createUser(conta('renan'))).created, false);
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});

test('as reservas nascem das contas que já existiam, na primeira subida', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    // Um arquivo anterior à 0.9.9-1: contas, nenhuma reserva.
    const antigo = new JsonStore(pasta);
    await antigo.load();
    await antigo.addUser(conta('Renan'));
    await antigo.addUser(conta('Caio'));

    const migrado = new JsonStore(pasta);
    await migrado.load();
    assert.deepEqual(
      [...migrado.usernameReservations].map((reserva) => reserva.normalizedUsername).sort(),
      ['caio', 'renan'],
      'o histórico que existe é o das contas que existem',
    );
    // E uma conta viva continua ocupando o nome pelo caminho normal.
    assert.equal((await migrado.createUser(conta('renan'))).created, false);
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});

// ── Duplicatas legadas: detectar, não decidir ──────────────────────────────

test('duplicatas já gravadas são detectadas e ditas, sem escolher uma vencedora', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    const antigo = new JsonStore(pasta);
    await antigo.load();
    // O estrago da corrida: três contas com o mesmo nome.
    await antigo.addUser(conta('Renan'));
    await antigo.addUser(conta('renan'));
    await antigo.addUser(conta('RENAN'));
    await antigo.addUser(conta('Caio'));

    const migrado = new JsonStore(pasta);
    await migrado.load();
    assert.equal(migrado.users.length, 4, 'nenhuma conta é descartada por conta própria');
    assert.equal(migrado.duplicateUsernameReport.length, 1);
    assert.equal(migrado.duplicateUsernameReport[0].normalizedUsername, 'renan');
    assert.equal(migrado.duplicateUsernameReport[0].accounts.length, 3);
    // A ordem é a de criação, que é a informação que o dono usa para decidir.
    const criadas = migrado.duplicateUsernameReport[0].accounts.map((c) => c.createdAt);
    assert.deepEqual(criadas, [...criadas].sort());
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});

test('o relatório de duplicatas não carrega hash nem senha', () => {
  const grupos = duplicateUsernames([
    conta('Renan', { passwordHash: 'segredo-um' }),
    conta('renan', { passwordHash: 'segredo-dois' }),
  ]);
  const texto = JSON.stringify(grupos);
  assert.equal(texto.includes('segredo-um'), false);
  assert.equal(texto.includes('segredo-dois'), false);
  assert.equal(texto.includes('passwordHash'), false);
  // E carrega o que serve para decidir.
  assert.deepEqual(Object.keys(grupos[0].accounts[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'role', 'username']);
});

test('sem duplicata, o relatório é vazio', () => {
  assert.deepEqual(duplicateUsernames([conta('Renan'), conta('Caio')]), []);
});

// ── Falha de gravação não deixa meia conta viva ────────────────────────────

test('uma falha ao gravar desfaz a conta em memória', async () => {
  await comStore(async (store) => {
    const original = (store as unknown as { save: () => Promise<void> }).save;
    (store as unknown as { save: () => Promise<void> }).save = async () => { throw new Error('disco cheio'); };
    await assert.rejects(() => store.createUser(conta('Renan')), /disco cheio/);
    (store as unknown as { save: () => Promise<void> }).save = original;

    assert.equal(store.users.length, 0, 'uma conta viva só na memória some no próximo reinício');
    assert.equal(store.reservationFor('renan'), undefined, 'e o nome não fica reservado por uma conta que não existe');
    // E o nome continua disponível de verdade.
    assert.equal((await store.createUser(conta('Renan'))).created, true);
  });
});
