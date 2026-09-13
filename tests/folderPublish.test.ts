import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalogFrom, manifestsFrom, sameContent, scanFolders } from '../services/updates/src/folder';
import { loadSigningKeys, publishFromFolder } from '../services/updates/src/publisher';
import { generateSigningKey, documentDigest, verifySignature } from '../shared/distributionCrypto';
import { verifySigned } from '../shared/distribution';

// A publicação por pasta: largar o arquivo é a publicação inteira.
//
// O que estes testes fixam não é a conveniência — é o que ela não pode custar.
// Um catálogo gerado errado não avisa: ele simplesmente oferece a versão
// errada, ou nenhuma, na máquina de todo mundo.

const KEYS = { manifest: generateSigningKey(), catalog: generateSigningKey() };

async function pasta(arquivos: Record<string, number>): Promise<string> {
  const raiz = await mkdtemp(path.join(tmpdir(), 'tumacord-pasta-'));
  for (const [relativo, bytes] of Object.entries(arquivos)) {
    const destino = path.join(raiz, relativo);
    await mkdir(path.dirname(destino), { recursive: true });
    await writeFile(destino, Buffer.alloc(bytes, 7));
  }
  return raiz;
}

test('os nomes que o electron-builder produz viram versões, sem convenção nova', async (context) => {
  const raiz = await pasta({
    'linux/tumacord-0.13.0.tar.gz': 2048,
    'linux/Tumacord-0.13.0.AppImage': 3072,
    'windows/Tumacord-0.13.0-Setup.exe': 4096,
    'windows/Tumacord-0.13.0-portable.exe': 5120,
  });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const scan = await scanFolders(raiz);
  assert.equal(scan.files.length, 4);
  assert.deepEqual([...new Set(scan.files.map((f) => f.version))], ['0.13.0']);
  assert.deepEqual(
    scan.files.map((f) => f.installKind).sort(),
    ['linux-appimage', 'linux-managed', 'windows-installed', 'windows-portable'],
  );
  // O caminho é relativo ao armazenamento, e nunca uma URL: guardar URL num
  // documento assinado deixaria um manifesto mandar o cliente buscar binário
  // em outro domínio.
  for (const file of scan.files) {
    assert.match(file.storagePath, /^(linux|windows)\//);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test('nome fora do padrão é ignorado e DITO, em vez de virar versão errada', async (context) => {
  const raiz = await pasta({
    'linux/tumacord-0.13.0.tar.gz': 1024,
    'linux/tumacord-final-de-verdade.tar.gz': 1024,
    'linux/leiame.txt': 10,
    'linux/tumacord-0.13.0.tar.gz.parcial': 1024,
    'windows/Tumacord-1.2.3.4-Setup.exe': 1024,
  });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const scan = await scanFolders(raiz);
  assert.deepEqual(scan.files.map((f) => f.version), ['0.13.0']);
  const ditos = scan.ignored.map((item) => item.file).sort();
  assert.deepEqual(ditos, [
    'linux/leiame.txt',
    'linux/tumacord-0.13.0.tar.gz.parcial',
    'linux/tumacord-final-de-verdade.tar.gz',
    'windows/Tumacord-1.2.3.4-Setup.exe',
  ]);
  // O motivo é dito, porque é ele que faz alguém corrigir o nome em vez de
  // ficar recarregando a tela esperando a versão aparecer.
  for (const item of scan.ignored) assert.ok(item.reason.length > 0, item.file);
});

test('um arquivo vazio não é um pacote', async (context) => {
  const raiz = await pasta({ 'linux/tumacord-0.13.0.tar.gz': 0 });
  context.after(() => rm(raiz, { recursive: true, force: true }));
  const scan = await scanFolders(raiz);
  assert.deepEqual(scan.files, []);
  assert.equal(scan.ignored[0]?.reason, 'vazio ou não é arquivo');
});

// Escolher entre dois arquivos para o mesmo alvo seria adivinhar, e o erro
// apareceria na máquina de quem instalou. Mas parar TUDO por causa de uma
// versão ambígua deixaria o grupo sem as outras.
test('dois arquivos para o mesmo alvo param só aquela versão', async (context) => {
  const raiz = await pasta({
    'linux/tumacord-0.13.0.tar.gz': 1024,
    'linux/Tumacord-0.13.0.AppImage': 1024,
    'linux/Tumacord-0.13.0.AppImage.bak': 1024,
    'linux/tumacord-0.12.2.tar.gz': 1024,
  });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const scan = await scanFolders(raiz);
  const { manifests, conflicts } = manifestsFrom(scan, KEYS.manifest.keyId);
  // `.bak` não casa com nenhuma forma, então não há conflito — e é a 0.13.0
  // inteira que continua valendo.
  assert.deepEqual(conflicts, []);
  assert.deepEqual(manifests.map((m) => m.version), ['0.13.0', '0.12.2']);
});

test('todas as versões entram no catálogo, da mais nova para a mais antiga', async (context) => {
  const raiz = await pasta({
    'linux/tumacord-0.12.2.tar.gz': 1024,
    'linux/tumacord-0.13.0.tar.gz': 1024,
    'linux/tumacord-0.9.9.tar.gz': 1024,
  });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const scan = await scanFolders(raiz);
  const { manifests } = manifestsFrom(scan, KEYS.manifest.keyId);
  const catalog = catalogFrom(manifests, (m) => documentDigest(m), 1);
  // Todas, e não só a mais nova: é o que permite oferecer uma versão antiga a
  // quem pedir.
  assert.deepEqual(catalog.channels.stable.entries.map((e) => e.version), ['0.13.0', '0.12.2', '0.9.9']);
  assert.deepEqual(catalog.channels.test.entries, []);
  for (const entry of catalog.channels.stable.entries) {
    assert.equal(entry.state, 'published');
    assert.match(entry.manifestSha256, /^[0-9a-f]{64}$/);
  }
});

test('o catálogo sai assinado e verifica contra as chaves públicas', async (context) => {
  const raiz = await pasta({ 'linux/tumacord-0.13.0.tar.gz': 1024 });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const outcome = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: 0, currentManifests: {} });
  assert.equal(outcome.changed, true);
  assert.equal(outcome.sequence, 1);

  const confiaveis = [
    { keyId: KEYS.manifest.keyId, algorithm: KEYS.manifest.algorithm, publicKey: KEYS.manifest.publicKey, scope: ['manifest'] },
    { keyId: KEYS.catalog.keyId, algorithm: KEYS.catalog.algorithm, publicKey: KEYS.catalog.publicKey, scope: ['catalog'] },
  ];
  const doCatalogo = verifySigned(outcome.catalog!, confiaveis as never, 'catalog', verifySignature);
  assert.equal(doCatalogo.ok, true, `catálogo recusado: ${JSON.stringify(doCatalogo)}`);
  for (const assinado of Object.values(outcome.manifests)) {
    const conferido = verifySigned(assinado, confiaveis as never, 'manifest', verifySignature);
    assert.equal(conferido.ok, true, `manifesto recusado: ${JSON.stringify(conferido)}`);
  }

  // O resumo que o catálogo promete é o do manifesto que ele aponta. Sem isto,
  // um serviço poderia servir o manifesto assinado de OUTRA versão — os dois
  // autênticos, e o par errado.
  const entrada = outcome.catalog!.payload.channels.stable.entries[0];
  assert.equal(entrada.manifestSha256, documentDigest(outcome.manifests[entrada.releaseId].payload));
});

// A regressão que este teste existe para impedir: republicar a cada varredura.
// A sequência cresceria sem parar, e todo cliente rebaixaria o que já tinha
// aceitado sem nada ter acontecido.
test('varrer de novo sem mudança não gasta sequência', async (context) => {
  const raiz = await pasta({ 'linux/tumacord-0.13.0.tar.gz': 1024 });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const primeira = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: 0, currentManifests: {} });
  const segunda = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: primeira.sequence, currentManifests: primeira.manifests });
  assert.equal(segunda.changed, false);
  assert.equal(segunda.sequence, primeira.sequence);
  assert.equal(segunda.catalog, null);

  // E o manifesto que não mudou mantém a assinatura que já tinha: reassinar
  // produziria bytes diferentes para o mesmo conteúdo, e o resumo prometido
  // pelo catálogo deixaria de casar.
  const [antes] = Object.values(primeira.manifests);
  const [depois] = Object.values(segunda.manifests);
  assert.deepEqual(depois, antes);
});

test('largar um arquivo novo faz a sequência crescer, e só então', async (context) => {
  const raiz = await pasta({ 'linux/tumacord-0.13.0.tar.gz': 1024 });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const primeira = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: 7, currentManifests: {} });
  assert.equal(primeira.sequence, 8);

  await writeFile(path.join(raiz, 'linux', 'tumacord-0.14.0.tar.gz'), Buffer.alloc(2048, 9));
  const segunda = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: primeira.sequence, currentManifests: primeira.manifests });
  assert.equal(segunda.changed, true);
  assert.equal(segunda.sequence, 9);
  assert.deepEqual(segunda.versions, ['0.14.0', '0.13.0']);

  // Apagar também é uma mudança: uma versão retirada da pasta some da oferta.
  await rm(path.join(raiz, 'linux', 'tumacord-0.13.0.tar.gz'));
  const terceira = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: segunda.sequence, currentManifests: segunda.manifests });
  assert.equal(terceira.changed, true);
  assert.deepEqual(terceira.versions, ['0.14.0']);
});

test('trocar o conteúdo de um arquivo, mantendo o nome, é mudança', async (context) => {
  const raiz = await pasta({ 'linux/tumacord-0.13.0.tar.gz': 1024 });
  context.after(() => rm(raiz, { recursive: true, force: true }));

  const primeira = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: 0, currentManifests: {} });
  await writeFile(path.join(raiz, 'linux', 'tumacord-0.13.0.tar.gz'), Buffer.alloc(4096, 3));
  const segunda = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: primeira.sequence, currentManifests: primeira.manifests });
  assert.equal(segunda.changed, true, 'o resumo mudou, então o catálogo precisa mudar');
});

// Pasta vazia e nenhum catálogo antes: não há o que publicar, e não publicar é
// a resposta certa. O serviço responde "ainda não há catálogo publicado", que
// diz mais a quem está montando a instalação do que um catálogo vazio — este
// último pareceria "consultei e não há versão nova", que é outra coisa.
test('pasta vazia no primeiro arranque não publica nada, e não é erro', async (context) => {
  const raiz = await pasta({});
  context.after(() => rm(raiz, { recursive: true, force: true }));
  const outcome = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: 0, currentManifests: {} });
  assert.deepEqual(outcome.versions, []);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.catalog, null);
});

// Mas esvaziar uma pasta que TINHA versões é uma mudança, e precisa chegar aos
// clientes: uma versão tirada da pasta para de ser oferecida.
test('esvaziar a pasta publica um catálogo sem nenhuma versão', async (context) => {
  const raiz = await pasta({ 'linux/tumacord-0.13.0.tar.gz': 1024 });
  context.after(() => rm(raiz, { recursive: true, force: true }));
  const cheia = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: 0, currentManifests: {} });
  await rm(path.join(raiz, 'linux', 'tumacord-0.13.0.tar.gz'));
  const vazia = await publishFromFolder({ storageDir: raiz, keys: KEYS, currentSequence: cheia.sequence, currentManifests: cheia.manifests });
  assert.equal(vazia.changed, true);
  assert.deepEqual(vazia.catalog?.payload.channels.stable.entries, []);
});

test('sem chaves na pasta, o serviço simplesmente não publica sozinho', async (context) => {
  const vazia = await mkdtemp(path.join(tmpdir(), 'tumacord-chaves-'));
  context.after(() => rm(vazia, { recursive: true, force: true }));
  assert.equal(await loadSigningKeys(vazia), null);
  assert.equal(await loadSigningKeys(''), null);
});

test('as chaves são lidas no mesmo formato que o publicador gera', async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tumacord-chaves-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(KEYS.manifest));
  await writeFile(path.join(dir, 'catalog.json'), JSON.stringify(KEYS.catalog));
  const lidas = await loadSigningKeys(dir);
  assert.equal(lidas?.manifest.keyId, KEYS.manifest.keyId);
  assert.equal(lidas?.catalog.keyId, KEYS.catalog.keyId);
});

test('a comparação de conteúdo ignora a hora e olha os resumos', () => {
  const base = { version: '1.0.0', artifacts: [{ artifactId: 'a', sha256: 'x', storagePath: 'linux/a.tar.gz', fileName: 'a.tar.gz', size: 1 }] } as never;
  const outroHorario = { version: '1.0.0', createdAt: 'outro', artifacts: [{ artifactId: 'a', sha256: 'x', storagePath: 'linux/a.tar.gz', fileName: 'a.tar.gz', size: 1 }] } as never;
  const outroResumo = { version: '1.0.0', artifacts: [{ artifactId: 'a', sha256: 'y', storagePath: 'linux/a.tar.gz', fileName: 'a.tar.gz', size: 1 }] } as never;
  assert.equal(sameContent([base], [outroHorario]), true);
  assert.equal(sameContent([base], [outroResumo]), false);
});

// A regressão que quebrou uma instalação de verdade: os pacotes mudaram de
// `releases/<versão>/` para `linux/` com o MESMO resumo. A comparação disse
// "nada mudou", o catálogo continuou prometendo o caminho antigo, e o download
// passou a responder 404 sem nenhum log de erro.
test('mover o arquivo de pasta é mudança, mesmo com o resumo igual', () => {
  const antes = { version: '1.0.0', artifacts: [{ artifactId: 'a', sha256: 'x', storagePath: 'releases/1.0.0/a.tar.gz', fileName: 'a.tar.gz', size: 1 }] } as never;
  const depois = { version: '1.0.0', artifacts: [{ artifactId: 'a', sha256: 'x', storagePath: 'linux/a.tar.gz', fileName: 'a.tar.gz', size: 1 }] } as never;
  assert.equal(sameContent([antes], [depois]), false, 'o caminho faz parte do que o catálogo promete');
});

test('renomear o arquivo mantendo o conteúdo também é mudança', () => {
  const antes = { version: '1.0.0', artifacts: [{ artifactId: 'a', sha256: 'x', storagePath: 'linux/a.tar.gz', fileName: 'a.tar.gz', size: 1 }] } as never;
  const depois = { version: '1.0.0', artifacts: [{ artifactId: 'a', sha256: 'x', storagePath: 'linux/b.tar.gz', fileName: 'b.tar.gz', size: 1 }] } as never;
  assert.equal(sameContent([antes], [depois]), false);
});
