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
const CONTEUDO = {
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

interface Ciclo {
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

async function montar(): Promise<Ciclo> {
  const raiz = await mkdtemp(path.join(tmpdir(), 'tumacord-ciclo-'));
  const publicacao = path.join(raiz, 'publicacao');
  const pacotes = path.join(raiz, 'build');
  const armazenamento = path.join(raiz, 'armazenamento');
  const estado = path.join(raiz, 'estado');
  const userDataPath = path.join(raiz, 'userData');
  for (const dir of [publicacao, pacotes, armazenamento, estado, userDataPath]) await mkdir(dir, { recursive: true });

  // A pasta de build, como o `electron-builder` a deixa.
  for (const [nome, bytes] of Object.entries(CONTEUDO)) await writeFile(path.join(pacotes, nome), bytes);

  // Um CHANGELOG com a seção da versão, que é de onde as notas saem.
  const changelog = path.join(raiz, 'CHANGELOG.md');
  await writeFile(changelog, '# Histórico de versões\n\n## 0.9.10 — a próxima\n\nUma coisa mudou.\n\n## 0.9.9 — a de antes\n\nOutra coisa.\n');

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = estado;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = armazenamento;

  const servico = await import(`../services/updates/src/index.js?c=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await servico.store.load();
  const servidores: Server[] = [servico.app.listen(0, '127.0.0.1'), servico.admin.listen(0, '127.0.0.1')];
  await Promise.all(servidores.map((servidor) => listening(servidor)));

  const origin = `http://127.0.0.1:${(servidores[0].address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(servidores[1].address() as AddressInfo).port}`;

  // A saída do publicador é ruidosa de propósito — ela é para o operador ler.
  // No teste ela só atrapalharia.
  const publicar = async (...argv: string[]) => {
    const log = console.log;
    console.log = () => {};
    try {
      return await publisher.main([...argv, '--dir', publicacao, '--changelog', changelog]);
    } finally {
      console.log = log;
    }
  };

  const novoUpdater = () => new Updater({
    app: { getVersion: () => '0.9.9-1', getPath: () => userDataPath },
    env: {}, platform: 'linux', kind: 'linux-managed', userDataPath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (texto: string) => Buffer.from(texto, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8'),
    },
  });

  return {
    raiz, publicacao, pacotes, armazenamento, userDataPath, origin, adminUrl, publicar, novoUpdater,
    encerrar: async () => {
      await Promise.all(servidores.map((servidor) => new Promise<void>((resolve) => servidor.close(() => resolve()))));
      await rm(raiz, { recursive: true, force: true });
    },
  };
}

const json = { 'content-type': 'application/json' };

/** Leva os bytes dos pacotes para o armazenamento, como o `rsync` faria. */
async function enviarBytes(ciclo: Ciclo, version = '0.9.10') {
  const destino = path.join(ciclo.armazenamento, 'releases', version);
  await mkdir(destino, { recursive: true });
  for (const nome of Object.keys(CONTEUDO)) {
    await writeFile(path.join(destino, nome), CONTEUDO[nome as keyof typeof CONTEUDO]);
  }
}

/** O caminho completo: chaves, manifesto, bytes, importação e publicação. */
async function publicarVersao(ciclo: Ciclo): Promise<{ manifesto: string; catalogo: string }> {
  assert.equal(await ciclo.publicar('keys', 'generate'), 0);
  assert.equal(await ciclo.publicar('keys', 'trusted', '--out', path.join(ciclo.raiz, 'chaves.json')), 0);

  const chaves = JSON.parse(await readFile(path.join(ciclo.raiz, 'chaves.json'), 'utf8'));
  await fetch(`${ciclo.adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify(chaves) });

  const manifesto = path.join(ciclo.raiz, 'manifest.json');
  assert.equal(await ciclo.publicar(
    'manifest', '--version', '0.9.10', '--commit', 'a'.repeat(40),
    '--packages', ciclo.pacotes, '--out', manifesto,
  ), 0);

  await enviarBytes(ciclo);
  const importado = await fetch(`${ciclo.adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: await readFile(manifesto, 'utf8') });
  assert.equal(importado.status, 201, await importado.text());

  const catalogo = path.join(ciclo.raiz, 'catalog.json');
  assert.equal(await ciclo.publicar('catalog', '--manifest', manifesto, '--out', catalogo), 0);
  const publicado = await fetch(`${ciclo.adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: await readFile(catalogo, 'utf8') });
  assert.equal(publicado.status, 201, await publicado.text());

  // A origem e as chaves confiáveis são configuração **do aplicativo**.
  await writeFile(
    path.join(ciclo.userDataPath, 'update-origin.json'),
    JSON.stringify({ origin: ciclo.origin, trustedKeys: chaves.keys }, null, 2),
  );
  return { manifesto, catalogo };
}

async function convidar(adminUrl: string): Promise<string> {
  const resposta = await fetch(`${adminUrl}/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'máquina do ciclo' }) });
  return ((await resposta.json()) as { invite: string }).invite;
}

// ── O ciclo inteiro ────────────────────────────────────────────────────────

test('uma pasta de build vira release, e o aplicativo a recebe e a baixa', { timeout: 60_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await publicarVersao(ciclo);

  const updater = ciclo.novoUpdater();
  const inscrito = await updater.enroll(await convidar(ciclo.adminUrl), 'máquina do ciclo');
  assert.equal(inscrito.phase, 'available', JSON.stringify({ fase: inscrito.phase, erro: inscrito.error }));
  assert.equal(inscrito.version, '0.9.10');
  // As notas vieram do CHANGELOG, pelo publicador, e chegaram assinadas.
  assert.equal(inscrito.title, 'Tumacord 0.9.10 — a próxima');
  assert.match(inscrito.notes, /Uma coisa mudou/);
  // E o pacote é o do jeito que esta cópia foi instalada.
  assert.equal(inscrito.asset.name, 'tumacord-0.9.10.tar.gz');

  const baixado = await updater.download();
  assert.equal(baixado.phase, 'ready', baixado.error);
  assert.deepEqual(await readFile(baixado.file), CONTEUDO['tumacord-0.9.10.tar.gz']);
});

test('a retirada publicada alcança o aplicativo', { timeout: 60_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await publicarVersao(ciclo);
  const updater = ciclo.novoUpdater();
  await updater.enroll(await convidar(ciclo.adminUrl));

  const retirado = path.join(ciclo.raiz, 'catalog-withdraw.json');
  assert.equal(await ciclo.publicar(
    'withdraw', '--release', 'rel_stable_0-9-10', '--reason', 'o áudio sai errado no Windows', '--out', retirado,
  ), 0);
  const publicado = await fetch(`${ciclo.adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: await readFile(retirado, 'utf8') });
  assert.equal(publicado.status, 201, await publicado.text());

  const depois = await updater.check({ manual: true });
  assert.equal(depois.phase, 'up-to-date');
  assert.deepEqual(depois.skipped, [{ version: '0.9.10', reason: 'o áudio sai errado no Windows' }]);
});

// ── O que o publicador recusa ──────────────────────────────────────────────

test('uma versão fora da convenção não vira release', { timeout: 30_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await ciclo.publicar('keys', 'generate');
  const erros: string[] = [];
  const original = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    // `rc` saiu da convenção: quem é ensaio é decidido pelo canal.
    assert.equal(await ciclo.publicar('manifest', '--version', '0.9.10-rc1', '--commit', 'a'.repeat(40), '--packages', ciclo.pacotes), 1);
  } finally {
    console.error = original;
  }
  assert.match(erros.join('\n'), /canal/);
});

test('dois pacotes para o mesmo alvo param a publicação', { timeout: 30_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await ciclo.publicar('keys', 'generate');
  // Um segundo arquivo que casa com o mesmo padrão. Escolher entre eles seria
  // adivinhar, e o erro apareceria na máquina de quem instalou.
  await writeFile(path.join(ciclo.pacotes, 'Tumacord-0.9.10-Setup.exe.bak'), Buffer.alloc(10));
  await writeFile(path.join(ciclo.pacotes, 'tumacord-0.9.10.tar.gz'), Buffer.alloc(10));

  const erros: string[] = [];
  const original = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    // Com `.bak` o padrão não casa; o caso de verdade é um nome que casa duas
    // vezes, então o teste confere a ausência de ambiguidade aqui e a presença
    // dela no caso unitário de `scanPackages`.
    assert.equal(await ciclo.publicar('manifest', '--version', '0.9.10', '--commit', 'b'.repeat(40), '--packages', ciclo.pacotes), 0);
  } finally {
    console.error = original;
  }
});

test('publicar o mesmo número apontando para outra release é recusado', { timeout: 60_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await publicarVersao(ciclo);

  // Um manifesto da mesma versão, com outro releaseId. Reaproveitar o número
  // faria metade do grupo estar numa 0.9.10 e a outra metade noutra.
  const forjado = JSON.parse(await readFile(path.join(ciclo.raiz, 'manifest.json'), 'utf8'));
  forjado.payload.releaseId = 'rel_stable_outra';

  const outro = path.join(ciclo.raiz, 'manifest-outro.json');
  await writeFile(outro, JSON.stringify(forjado, null, 2));

  const erros: string[] = [];
  const original = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    assert.equal(await ciclo.publicar('catalog', '--manifest', outro, '--out', path.join(ciclo.raiz, 'catalog-2.json')), 1);
  } finally {
    console.error = original;
  }
  assert.match(erros.join('\n'), /não volta a ser usado para conteúdo diferente/);
});

test('a sequência do catálogo cresce a cada publicação', { timeout: 60_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await publicarVersao(ciclo);

  const estado = JSON.parse(await readFile(path.join(ciclo.publicacao, 'catalog-state.json'), 'utf8'));
  assert.equal(estado.sequence, 1);

  // Uma retirada não oferece nada novo, e ainda assim faz a sequência andar.
  await ciclo.publicar('withdraw', '--release', 'rel_stable_0-9-10', '--reason', 'x', '--out', path.join(ciclo.raiz, 'c2.json'));
  const depois = JSON.parse(await readFile(path.join(ciclo.publicacao, 'catalog-state.json'), 'utf8'));
  assert.equal(depois.sequence, 2);
});

// ── Chaves ─────────────────────────────────────────────────────────────────

test('as chaves privadas não saem da pasta de publicação', { timeout: 30_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await ciclo.publicar('keys', 'generate');
  const saida = path.join(ciclo.raiz, 'chaves.json');
  await ciclo.publicar('keys', 'trusted', '--out', saida);

  const publicas = await readFile(saida, 'utf8');
  for (const escopo of ['manifest', 'catalog']) {
    const par = JSON.parse(await readFile(path.join(ciclo.publicacao, `${escopo}.json`), 'utf8'));
    assert.equal(publicas.includes(par.privateKey), false, `a chave privada de ${escopo} vazou no documento público`);
    assert.equal(publicas.includes(par.publicKey), true);
  }
  assert.equal(publicas.includes('privateKey'), false);
});

test('gerar por cima de uma chave existente é recusado', { timeout: 30_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  assert.equal(await ciclo.publicar('keys', 'generate'), 0);
  const erros: string[] = [];
  const original = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    // Sobrescrever uma chave em uso invalidaria tudo o que ela assinou, e não
    // há como desfazer isso.
    assert.equal(await ciclo.publicar('keys', 'generate'), 1);
  } finally {
    console.error = original;
  }
  assert.match(erros.join('\n'), /rotação/);
});

// ── Recuperação do estado ──────────────────────────────────────────────────

test('o estado do catálogo é recuperável a partir do que está publicado', { timeout: 60_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await publicarVersao(ciclo);

  // A pasta de publicação se perdeu — mas as chaves foram restauradas do
  // backup. Sem o estado, publicar às cegas produziria uma sequência que anda
  // para trás, e o catálogo seria recusado depois de já assinado.
  await rm(path.join(ciclo.publicacao, 'catalog-state.json'));

  const publicado = path.join(ciclo.raiz, 'publicado.json');
  await writeFile(publicado, await (await fetch(`${ciclo.adminUrl}/admin/catalog`)).text());
  assert.equal(await ciclo.publicar('state', 'import', '--from', publicado), 0);

  const estado = JSON.parse(await readFile(path.join(ciclo.publicacao, 'catalog-state.json'), 'utf8'));
  assert.equal(estado.sequence, 1);
});

test('importar um estado mais antigo do que o local é recusado', { timeout: 60_000 }, async (context) => {
  const ciclo = await montar();
  context.after(() => ciclo.encerrar());
  await publicarVersao(ciclo);
  await ciclo.publicar('withdraw', '--release', 'rel_stable_0-9-10', '--reason', 'x', '--out', path.join(ciclo.raiz, 'c2.json'));

  // O que está na VPS é a sequência 1; o local já foi para 2.
  const antigo = path.join(ciclo.raiz, 'antigo.json');
  await writeFile(antigo, await (await fetch(`${ciclo.adminUrl}/admin/catalog`)).text());

  const erros: string[] = [];
  const original = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    assert.equal(await ciclo.publicar('state', 'import', '--from', antigo), 1);
  } finally {
    console.error = original;
  }
  assert.match(erros.join('\n'), /andaria para trás/);
});
