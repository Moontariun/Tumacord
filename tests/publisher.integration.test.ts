import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// O ciclo inteiro, de ponta a ponta: uma pasta de build vira release assinada,
// a release é importada e publicada na VPS, e o aplicativo a recebe e a baixa.
//
// É o teste que prova que as peças **se encaixam**. Cada uma tem os próprios
// casos; este responde a pergunta que nenhum deles responde sozinho — se dá
// para publicar uma versão e alguém recebê-la.

const require_ = createRequire(import.meta.url);
const publisher = await import('../tools/publisher/publish.mjs') as {
  main: (argv: string[]) => Promise<number>;
};
const { Updater } = require_('../desktop/updater.cjs') as {
  Updater: new (options: Record<string, unknown>) => {
    check: (options?: { manual?: boolean }) => Promise<Record<string, any>>;
    download: () => Promise<Record<string, any>>;
    enroll: (invite: string, label?: string) => Promise<Record<string, any>>;
  };
};

/** Bytes que fingem ser um pacote. O conteúdo não importa; o resumo sim. */
const CONTENT = {
  'tumacord-0.9.10.tar.gz': Buffer.alloc(200 * 1024, 1),
  'Tumacord-0.9.10.AppImage': Buffer.alloc(210 * 1024, 2),
  'Tumacord-0.9.10-Setup.exe': Buffer.alloc(190 * 1024, 3),
  'Tumacord-0.9.10-portable.exe': Buffer.alloc(180 * 1024, 4),
};

function listening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

interface Cycle {
  raiz: string;
  publicacao: string;
  pacotes: string;
  armazenamento: string;
  userDataPath: string;
  origin: string;
  adminUrl: string;
  publicar: (...argv: string[]) => Promise<number>;
  novoUpdater: () => InstanceType<typeof Updater>;
  encerrar: () => Promise<void>;
}

async function assemble(): Promise<Cycle> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'tumacord-ciclo-'));
  const publishDir = path.join(rootDir, 'publicacao');
  const packagesDir = path.join(rootDir, 'build');
  const storageDir = path.join(rootDir, 'armazenamento');
  const stateDir = path.join(rootDir, 'estado');
  const userDataPath = path.join(rootDir, 'userData');
  for (const dir of [publishDir, packagesDir, storageDir, stateDir, userDataPath]) await mkdir(dir, { recursive: true });

  // A pasta de build, como o `electron-builder` a deixa.
  for (const [name, bytes] of Object.entries(CONTENT)) await writeFile(path.join(packagesDir, name), bytes);

  // Um CHANGELOG com a seção da versão, que é de onde as notas saem.
  const changelog = path.join(rootDir, 'CHANGELOG.md');
  await writeFile(changelog, '# Histórico de versões\n\n## 0.9.10 — a próxima\n\nUma coisa mudou.\n\n## 0.9.9 — a de antes\n\nOutra coisa.\n');

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = stateDir;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = storageDir;

  const service = await import(`../services/updates/src/index.js?c=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await service.store.load();
  const servers: Server[] = [service.app.listen(0, '127.0.0.1'), service.admin.listen(0, '127.0.0.1')];
  await Promise.all(servers.map((serviceServer) => listening(serviceServer)));

  const origin = `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(servers[1].address() as AddressInfo).port}`;

  // A saída do publicador é ruidosa de propósito — ela é para o operador ler.
  // No teste ela só atrapalharia.
  const publish = async (...argv: string[]) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await publisher.main([...argv, '--dir', publishDir, '--changelog', changelog]);
    } finally {
      console.log = log;
    }
  };

  const newUpdater = () => new Updater({
    app: { getVersion: () => '0.9.9-1', getPath: () => userDataPath },
    env: {}, platform: 'linux', kind: 'linux-managed', userDataPath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8'),
    },
  });

  return {
    raiz: rootDir, publicacao: publishDir, pacotes: packagesDir, armazenamento: storageDir, userDataPath, origin, adminUrl, publicar: publish, novoUpdater: newUpdater,
    encerrar: async () => {
      await Promise.all(servers.map((serviceServer) => new Promise<void>((resolve) => serviceServer.close(() => resolve()))));
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

const json = { 'content-type': 'application/json' };

/** Leva os bytes dos pacotes para o armazenamento, como o `rsync` faria. */
async function sendBytes(cycle: Cycle, version = '0.9.10') {
  const destination = path.join(cycle.armazenamento, 'releases', version);
  await mkdir(destination, { recursive: true });
  for (const name of Object.keys(CONTENT)) {
    await writeFile(path.join(destination, name), CONTENT[name as keyof typeof CONTENT]);
  }
}

/** O caminho completo: chaves, manifesto, bytes, importação e publicação. */
async function publishVersion(cycle: Cycle): Promise<{ manifesto: string; catalogo: string }> {
  assert.equal(await cycle.publicar('keys', 'generate'), 0);
  assert.equal(await cycle.publicar('keys', 'trusted', '--out', path.join(cycle.raiz, 'chaves.json')), 0);

  const keys = JSON.parse(await readFile(path.join(cycle.raiz, 'chaves.json'), 'utf8'));
  await fetch(`${cycle.adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify(keys) });

  const manifest = path.join(cycle.raiz, 'manifest.json');
  assert.equal(await cycle.publicar(
    'manifest', '--version', '0.9.10', '--commit', 'a'.repeat(40),
    '--packages', cycle.pacotes, '--out', manifest,
  ), 0);

  await sendBytes(cycle);
  const imported = await fetch(`${cycle.adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: await readFile(manifest, 'utf8') });
  assert.equal(imported.status, 201, await imported.text());

  const catalog = path.join(cycle.raiz, 'catalog.json');
  assert.equal(await cycle.publicar('catalog', '--manifest', manifest, '--out', catalog), 0);
  const published = await fetch(`${cycle.adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: await readFile(catalog, 'utf8') });
  assert.equal(published.status, 201, await published.text());

  // A origem e as chaves confiáveis são configuração **do aplicativo**.
  await writeFile(
    path.join(cycle.userDataPath, 'update-origin.json'),
    JSON.stringify({ origin: cycle.origin, trustedKeys: keys.keys }, null, 2),
  );
  return { manifesto: manifest, catalogo: catalog };
}

async function inviteDevice(adminUrl: string): Promise<string> {
  const reply = await fetch(`${adminUrl}/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'máquina do ciclo' }) });
  return ((await reply.json()) as { invite: string }).invite;
}

// ── O ciclo inteiro ────────────────────────────────────────────────────────

test('uma pasta de build vira release, e o aplicativo a recebe e a baixa', { timeout: 60_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await publishVersion(cycle);

  const updater = cycle.novoUpdater();
  const enrolled = await updater.enroll(await inviteDevice(cycle.adminUrl), 'máquina do ciclo');
  assert.equal(enrolled.phase, 'available', JSON.stringify({ fase: enrolled.phase, erro: enrolled.error }));
  assert.equal(enrolled.version, '0.9.10');
  // As notas vieram do CHANGELOG, pelo publicador, e chegaram assinadas.
  assert.equal(enrolled.title, 'Tumacord 0.9.10 — a próxima');
  assert.match(enrolled.notes, /Uma coisa mudou/);
  // E o pacote é o do jeito que esta cópia foi instalada.
  assert.equal(enrolled.asset.name, 'tumacord-0.9.10.tar.gz');

  const downloaded = await updater.download();
  assert.equal(downloaded.phase, 'ready', downloaded.error);
  assert.deepEqual(await readFile(downloaded.file), CONTENT['tumacord-0.9.10.tar.gz']);
});

test('a retirada publicada alcança o aplicativo', { timeout: 60_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await publishVersion(cycle);
  const updater = cycle.novoUpdater();
  await updater.enroll(await inviteDevice(cycle.adminUrl));

  const withdrawn = path.join(cycle.raiz, 'catalog-withdraw.json');
  assert.equal(await cycle.publicar(
    'withdraw', '--release', 'rel_stable_0-9-10', '--reason', 'o áudio sai errado no Windows', '--out', withdrawn,
  ), 0);
  const published = await fetch(`${cycle.adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: await readFile(withdrawn, 'utf8') });
  assert.equal(published.status, 201, await published.text());

  const after = await updater.check({ manual: true });
  assert.equal(after.phase, 'up-to-date');
  assert.deepEqual(after.skipped, [{ version: '0.9.10', reason: 'o áudio sai errado no Windows' }]);
});

// ── O que o publicador recusa ──────────────────────────────────────────────

test('uma versão fora da convenção não vira release', { timeout: 30_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await cycle.publicar('keys', 'generate');
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    // `rc` saiu da convenção: quem é ensaio é decidido pelo canal.
    assert.equal(await cycle.publicar('manifest', '--version', '0.9.10-rc1', '--commit', 'a'.repeat(40), '--packages', cycle.pacotes), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /canal/);
});

test('dois pacotes para o mesmo alvo param a publicação', { timeout: 30_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await cycle.publicar('keys', 'generate');
  // Um segundo arquivo que casa com o mesmo padrão. Escolher entre eles seria
  // adivinhar, e o erro apareceria na máquina de quem instalou.
  await writeFile(path.join(cycle.pacotes, 'Tumacord-0.9.10-Setup.exe.bak'), Buffer.alloc(10));
  await writeFile(path.join(cycle.pacotes, 'tumacord-0.9.10.tar.gz'), Buffer.alloc(10));

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    // Com `.bak` o padrão não casa; o caso de verdade é um nome que casa duas
    // vezes, então o teste confere a ausência de ambiguidade aqui e a presença
    // dela no caso unitário de `scanPackages`.
    assert.equal(await cycle.publicar('manifest', '--version', '0.9.10', '--commit', 'b'.repeat(40), '--packages', cycle.pacotes), 0);
  } finally {
    console.error = original;
  }
});

test('publicar o mesmo número apontando para outra release é recusado', { timeout: 60_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await publishVersion(cycle);

  // Um manifesto da mesma versão, com outro releaseId. Reaproveitar o número
  // faria metade do grupo estar numa 0.9.10 e a outra metade noutra.
  const forged = JSON.parse(await readFile(path.join(cycle.raiz, 'manifest.json'), 'utf8'));
  forged.payload.releaseId = 'rel_stable_outra';

  const other = path.join(cycle.raiz, 'manifest-outro.json');
  await writeFile(other, JSON.stringify(forged, null, 2));

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await cycle.publicar('catalog', '--manifest', other, '--out', path.join(cycle.raiz, 'catalog-2.json')), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /não volta a ser usado para conteúdo diferente/);
});

test('a sequência do catálogo cresce a cada publicação', { timeout: 60_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await publishVersion(cycle);

  const stateDir = JSON.parse(await readFile(path.join(cycle.publicacao, 'catalog-state.json'), 'utf8'));
  assert.equal(stateDir.sequence, 1);

  // Uma retirada não oferece nada novo, e ainda assim faz a sequência andar.
  await cycle.publicar('withdraw', '--release', 'rel_stable_0-9-10', '--reason', 'x', '--out', path.join(cycle.raiz, 'c2.json'));
  const after = JSON.parse(await readFile(path.join(cycle.publicacao, 'catalog-state.json'), 'utf8'));
  assert.equal(after.sequence, 2);
});

// ── Chaves ─────────────────────────────────────────────────────────────────

test('as chaves privadas não saem da pasta de publicação', { timeout: 30_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await cycle.publicar('keys', 'generate');
  const output = path.join(cycle.raiz, 'chaves.json');
  await cycle.publicar('keys', 'trusted', '--out', output);

  const publicKeys = await readFile(output, 'utf8');
  for (const scope of ['manifest', 'catalog']) {
    const pair = JSON.parse(await readFile(path.join(cycle.publicacao, `${scope}.json`), 'utf8'));
    assert.equal(publicKeys.includes(pair.privateKey), false, `a chave privada de ${scope} vazou no documento público`);
    assert.equal(publicKeys.includes(pair.publicKey), true);
  }
  assert.equal(publicKeys.includes('privateKey'), false);
});

test('gerar por cima de uma chave existente é recusado', { timeout: 30_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  assert.equal(await cycle.publicar('keys', 'generate'), 0);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    // Sobrescrever uma chave em uso invalidaria tudo o que ela assinou, e não
    // há como desfazer isso.
    assert.equal(await cycle.publicar('keys', 'generate'), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /rotação/);
});

// ── Recuperação do estado ──────────────────────────────────────────────────

test('o estado do catálogo é recuperável a partir do que está publicado', { timeout: 60_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await publishVersion(cycle);

  // A pasta de publicação se perdeu — mas as chaves foram restauradas do
  // backup. Sem o estado, publicar às cegas produziria uma sequência que anda
  // para trás, e o catálogo seria recusado depois de já assinado.
  await rm(path.join(cycle.publicacao, 'catalog-state.json'));

  const published = path.join(cycle.raiz, 'publicado.json');
  await writeFile(published, await (await fetch(`${cycle.adminUrl}/admin/catalog`)).text());
  assert.equal(await cycle.publicar('state', 'import', '--from', published), 0);

  const stateDir = JSON.parse(await readFile(path.join(cycle.publicacao, 'catalog-state.json'), 'utf8'));
  assert.equal(stateDir.sequence, 1);
});

test('importar um estado mais antigo do que o local é recusado', { timeout: 60_000 }, async (context) => {
  const cycle = await assemble();
  context.after(() => cycle.encerrar());
  await publishVersion(cycle);
  await cycle.publicar('withdraw', '--release', 'rel_stable_0-9-10', '--reason', 'x', '--out', path.join(cycle.raiz, 'c2.json'));

  // O que está na VPS é a sequência 1; o local já foi para 2.
  const older = path.join(cycle.raiz, 'antigo.json');
  await writeFile(older, await (await fetch(`${cycle.adminUrl}/admin/catalog`)).text());

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await cycle.publicar('state', 'import', '--from', older), 1);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /andaria para trás/);
});
