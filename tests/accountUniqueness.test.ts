import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

async function withStore(body: (store: JsonStore) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    const store = new JsonStore(folder);
    await store.load();
    await body(store);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

let counter = 0;
function account(username: string, extra: Partial<StoredUser> = {}): StoredUser {
  counter += 1;
  return {
    id: `user-${counter}`,
    username,
    normalizedUsername: normalizeUsername(username),
    passwordHash: `hash-de-${username}-${counter}`,
    createdAt: new Date(1_700_000_000_000 + counter * 1_000).toISOString(),
    ...extra,
  };
}

// ── A corrida ──────────────────────────────────────────────────────────────

test('seis pedidos simultâneos do mesmo nome produzem uma conta, não seis', async () => {
  await withStore(async (store) => {
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => store.createUser(account('Renan'))),
    );
    const created = outcomes.filter((outcome) => outcome.created);
    assert.equal(created.length, 1, 'exatamente um pedido cria a conta');
    assert.equal(store.users.length, 1);
    assert.equal(store.users.filter((user) => user.normalizedUsername === 'renan').length, 1);
    // Os outros cinco recebem a conta que existe, e não um erro genérico:
    // é isso que deixa o login seguir para a conferência de senha dela.
    for (const refused of outcomes.filter((outcome) => !outcome.created)) {
      assert.equal(refused.conflict, 'user');
      assert.equal(refused.existing?.id, created[0].user.id);
    }
  });
});

test('a corrida também é vencida quando os nomes diferem só na escrita', async () => {
  await withStore(async (store) => {
    const names = ['Renan', 'renan', 'RENAN', '  Renan  ', 'ReNaN'];
    const outcomes = await Promise.all(names.map((name) => store.createUser(account(name))));
    assert.equal(outcomes.filter((outcome) => outcome.created).length, 1);
    assert.equal(store.users.length, 1);
  });
});

test('NFKC, espaço em volta e caixa levam ao mesmo nome', () => {
  const variants = ['Renan', 'renan', 'RENAN', ' Renan ', 'Ｒｅｎａｎ'];
  const normalized = new Set(variants.map(normalizeUsername));
  assert.equal(normalized.size, 1, `estas formas deveriam ser o mesmo nome: ${[...normalized].join(', ')}`);
  assert.equal([...normalized][0], 'renan');
});

// ── Nome existente com senha diferente ─────────────────────────────────────

test('um nome que já existe não vira conta nova, nem troca a senha de ninguém', async () => {
  await withStore(async (store) => {
    const firstAccount = await store.createUser(account('Renan', { passwordHash: 'a-senha-certa' }));
    assert.equal(firstAccount.created, true);

    const secondAccount = await store.createUser(account('renan', { passwordHash: 'outra-senha' }));
    assert.equal(secondAccount.created, false);
    assert.equal(store.users.length, 1);
    assert.equal(store.users[0].passwordHash, 'a-senha-certa', 'a senha da conta que existe não foi tocada');
    assert.equal(store.users[0].id, firstAccount.created ? firstAccount.user.id : '', 'o id da conta é preservado');
  });
});

// ── Reserva de nome ────────────────────────────────────────────────────────

test('o nome de uma conta removida não volta a ficar livre', async () => {
  await withStore(async (store) => {
    const createdAccount = await store.createUser(account('Renan'));
    assert.equal(createdAccount.created, true);
    const originalId = createdAccount.created ? createdAccount.user.id : '';

    assert.equal(await store.removeUser(originalId), true);
    assert.equal(store.users.length, 0);

    const reservation = store.reservationFor('renan');
    assert.ok(reservation, 'a reserva sobrevive à remoção');
    assert.equal(reservation.userId, originalId, 'o id fica guardado para uma recuperação autorizada');
    assert.ok(reservation.releasedAt, 'a reserva registra quando a conta saiu');

    const attempt = await store.createUser(account('renan'));
    assert.equal(attempt.created, false);
    assert.equal(attempt.created === false && attempt.conflict, 'reservation');
    assert.equal(store.users.length, 0, 'ninguém herda a identidade de quem saiu');
  });
});

test('a reserva sobrevive ao reinício do servidor', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    const first = new JsonStore(folder);
    await first.load();
    const createdAccount = await first.createUser(account('Renan'));
    await first.removeUser(createdAccount.created ? createdAccount.user.id : '');

    const second = new JsonStore(folder);
    await second.load();
    assert.ok(second.reservationFor('renan'), 'a reserva foi gravada e lida de volta');
    assert.equal((await second.createUser(account('renan'))).created, false);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('as reservas nascem das contas que já existiam, na primeira subida', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    // Um arquivo anterior à 0.9.9-1: contas, nenhuma reserva.
    const legacy = new JsonStore(folder);
    await legacy.load();
    await legacy.addUser(account('Renan'));
    await legacy.addUser(account('Caio'));

    const migrated = new JsonStore(folder);
    await migrated.load();
    assert.deepEqual(
      [...migrated.usernameReservations].map((reservation) => reservation.normalizedUsername).sort(),
      ['caio', 'renan'],
      'o histórico que existe é o das contas que existem',
    );
    // E uma conta viva continua ocupando o nome pelo caminho normal.
    assert.equal((await migrated.createUser(account('renan'))).created, false);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// ── Duplicatas legadas: detectar, não decidir ──────────────────────────────

test('duplicatas já gravadas são detectadas e ditas, sem escolher uma vencedora', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-contas-'));
  try {
    const legacy = new JsonStore(folder);
    await legacy.load();
    // O estrago da corrida: três contas com o mesmo nome.
    await legacy.addUser(account('Renan'));
    await legacy.addUser(account('renan'));
    await legacy.addUser(account('RENAN'));
    await legacy.addUser(account('Caio'));

    const migrated = new JsonStore(folder);
    await migrated.load();
    assert.equal(migrated.users.length, 4, 'nenhuma conta é descartada por conta própria');
    assert.equal(migrated.duplicateUsernameReport.length, 1);
    assert.equal(migrated.duplicateUsernameReport[0].normalizedUsername, 'renan');
    assert.equal(migrated.duplicateUsernameReport[0].accounts.length, 3);
    // A ordem é a de criação, que é a informação que o dono usa para decidir.
    const created = migrated.duplicateUsernameReport[0].accounts.map((c) => c.createdAt);
    assert.deepEqual(created, [...created].sort());
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('o relatório de duplicatas não carrega hash nem senha', () => {
  const groups = duplicateUsernames([
    account('Renan', { passwordHash: 'segredo-um' }),
    account('renan', { passwordHash: 'segredo-dois' }),
  ]);
  const text = JSON.stringify(groups);
  assert.equal(text.includes('segredo-um'), false);
  assert.equal(text.includes('segredo-dois'), false);
  assert.equal(text.includes('passwordHash'), false);
  // E carrega o que serve para decidir.
  assert.deepEqual(Object.keys(groups[0].accounts[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'role', 'username']);
});

test('sem duplicata, o relatório é vazio', () => {
  assert.deepEqual(duplicateUsernames([account('Renan'), account('Caio')]), []);
});

// ── Falha de gravação não deixa meia conta viva ────────────────────────────

test('uma falha ao gravar desfaz a conta em memória', async () => {
  await withStore(async (store) => {
    const original = (store as unknown as { save: () => Promise<void> }).save;
    (store as unknown as { save: () => Promise<void> }).save = async () => { throw new Error('disco cheio'); };
    await assert.rejects(() => store.createUser(account('Renan')), /disco cheio/);
    (store as unknown as { save: () => Promise<void> }).save = original;

    assert.equal(store.users.length, 0, 'uma conta viva só na memória some no próximo reinício');
    assert.equal(store.reservationFor('renan'), undefined, 'e o nome não fica reservado por uma conta que não existe');
    // E o nome continua disponível de verdade.
    assert.equal((await store.createUser(account('Renan'))).created, true);
  });
});

// ── Pausa de escrita, para o backup capturar um ponto ──────────────────────
//
// Um `tar` do volume enquanto o servidor grava pode capturar o JSON entre o
// `write` e o `rename`. A falha não aparece na hora: ela aparece na
// restauração, quando já não há de onde tirar outra cópia.

test('pausar espera o que estava pendente e segura o que vem depois', async () => {
  await withStore(async (store) => {
    await store.createUser(account('Antes'));

    await store.pauseWrites(60_000);
    assert.equal(store.writesPaused, true);

    // O disco já está em dia quando `pauseWrites` volta: é essa espera que dá
    // o ponto consistente.
    const persisted = JSON.parse(await readFile(path.join((store as unknown as { file: string }).file), 'utf8')) as { users: { username: string }[] };
    assert.deepEqual(persisted.users.map((u) => u.username), ['Antes']);

    // Uma conta criada agora muda a memória e fica esperando o disco.
    let persistedAt = false;
    const pending = store.createUser(account('Durante')).then(() => { persistedAt = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(persistedAt, false, 'a gravação esperou a pausa');
    assert.equal(store.users.length, 2, 'mas a memória já tem a conta');

    const during = JSON.parse(await readFile((store as unknown as { file: string }).file, 'utf8')) as { users: unknown[] };
    assert.equal(during.users.length, 1, 'o disco fica parado enquanto o backup lê');

    store.resumeWrites();
    await pending;
    assert.equal(persistedAt, true);
    const after = JSON.parse(await readFile((store as unknown as { file: string }).file, 'utf8')) as { users: { username: string }[] };
    assert.deepEqual(after.users.map((u) => u.username), ['Antes', 'Durante'], 'nada foi perdido na pausa');
  });
});

test('a pausa se solta sozinha se o backup morrer no meio', async () => {
  await withStore(async (store) => {
    // Sem isto, um backup interrompido deixaria o servidor sem gravar para
    // sempre — e o estrago apareceria só no próximo reinício.
    await store.pauseWrites(40);
    assert.equal(store.writesPaused, true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(store.writesPaused, false);
    await store.createUser(account('Depois'));
    const persisted = JSON.parse(await readFile((store as unknown as { file: string }).file, 'utf8')) as { users: unknown[] };
    assert.equal(persisted.users.length, 1);
  });
});

test('pausar duas vezes não trava a segunda', async () => {
  await withStore(async (store) => {
    await store.pauseWrites(60_000);
    await store.pauseWrites(60_000);
    store.resumeWrites();
    assert.equal(store.writesPaused, false);
    // E liberar sem pausa não quebra nada.
    store.resumeWrites();
    await store.createUser(account('Fim'));
    assert.equal(store.users.length, 1);
  });
});
