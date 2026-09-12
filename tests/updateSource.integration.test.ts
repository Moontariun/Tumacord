import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONTRACT_VERSION, type Artifact, type Catalog, type ReleaseManifest, type TrustedKey } from '../shared/distribution';
import { documentDigest, generateSigningKey, signDocument } from '../shared/distributionCrypto';

// O cliente falando com o serviço privado, pela rede, dos dois lados de
// verdade. Um teste com `fetch` simulado provaria que o código chama as
// funções certas; não provaria que o aplicativo consegue baixar uma
// atualização — que é a pergunta.
//
// **Nenhum caminho deste arquivo toca o GitHub.**

const require_ = createRequire(import.meta.url);
const sourceModule = require_('../desktop/update-source.cjs') as {
  fetchCatalog: (o: Record<string, unknown>) => Promise<Catalog>;
  fetchManifest: (o: Record<string, unknown>) => Promise<ReleaseManifest>;
  downloadArtifact: (o: Record<string, unknown>) => Promise<{ file: string; sha256: string; size: number }>;
  enrollDevice: (o: Record<string, unknown>) => Promise<{ token: string; deviceId: string }>;
  renewDevice: (o: Record<string, unknown>) => Promise<{ token: string }>;
  selectArtifact: (m: ReleaseManifest, k: string, a: string) => Artifact | null;
};

const manifestKey = generateSigningKey();
const catalogKey = generateSigningKey();
const trusted: TrustedKey[] = [
  { ...manifestKey, scope: ['manifest'] },
  { ...catalogKey, scope: ['catalog'] },
];

// Grande o bastante para a retomada em duas partes ser real.
const CONTENT = Buffer.alloc(3 * 1024 * 1024, 7);
const DIGEST = createHash('sha256').update(CONTENT).digest('hex');

const artifact = (): Artifact => ({
  artifactId: 'linux-x64-tar', os: 'linux', arch: 'x64', format: 'tar.gz', installKind: 'linux-managed',
  fileName: 'tumacord-0.9.9-1.tar.gz', size: CONTENT.length, sha256: DIGEST,
  signatureKeyId: manifestKey.keyId, storagePath: 'releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
});

const manifest = (): ReleaseManifest => ({
  contract: CONTRACT_VERSION, releaseId: 'rel-0991', version: '0.9.9-1', channel: 'stable',
  commit: '0'.repeat(40), createdAt: '2026-09-12T10:00:00.000Z', artifacts: [artifact()],
});

const catalog = (sequence = 3): Catalog => ({
  contract: CONTRACT_VERSION, sequence,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  channels: {
    stable: { entries: [{ releaseId: 'rel-0991', version: '0.9.9-1', state: 'published', publishedAt: '2026-09-12T10:00:00.000Z', manifestSha256: documentDigest(manifest()) }] },
    test: { entries: [] },
  },
});

interface Environment {
  origin: string;
  adminUrl: string;
  token: string;
  downloads: string;
  encerrar: () => Promise<void>;
}

/**
 * Espera o servidor subir — e **falha** quando ele não sobe.
 *
 * Ouvir só `listening` deixa um erro de `listen` sem desfecho: a promessa
 * nunca resolve, o teste nunca termina, e a suíte inteira fica pendurada sem
 * dizer por quê. Foi o que aconteceu quando as portas eram escolhidas antes
 * do `listen`: sob concorrência, outro teste ocupava a porta nesse meio.
 */
function listening(serviceServer: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    serviceServer.once('listening', resolve);
    serviceServer.once('error', reject);
  });
}

async function start(): Promise<Environment> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'tumacord-cliente-'));
  const stateDir = path.join(rootDir, 'estado');
  const packagesDir = path.join(rootDir, 'pacotes');
  const downloads = path.join(rootDir, 'downloads');
  await mkdir(path.join(packagesDir, 'releases', '0.9.9-1'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(packagesDir, 'releases', '0.9.9-1', 'tumacord-0.9.9-1.tar.gz'), CONTENT);

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = stateDir;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = packagesDir;

  const serviceModule = await import(`../services/updates/src/index.js?c=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await serviceModule.store.load();
  const servers: Server[] = [serviceModule.app.listen(0, '127.0.0.1'), serviceModule.admin.listen(0, '127.0.0.1')];
  await Promise.all(servers.map((serviceServer) => listening(serviceServer)));

  const origin = `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(servers[1].address() as AddressInfo).port}`;
  const json = { 'content-type': 'application/json' };
  await fetch(`${adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify({ keys: trusted }) });
  await fetch(`${adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(manifest(), [manifestKey])) });
  await fetch(`${adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(catalog(), [catalogKey])) });
  const invite = await (await fetch(`${adminUrl}/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'máquina de teste' }) })).json() as { invite: string };
  const enrolled = await sourceModule.enrollDevice({ origin, invite: invite.invite, label: 'máquina de teste' });

  return {
    origin, adminUrl, downloads, token: enrolled.token,
    encerrar: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

// ── O caminho feliz, inteiro ───────────────────────────────────────────────

test('o cliente busca catálogo, manifesto e pacote sem tocar no GitHub', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const { origin, token } = environment;

  const catalogDoc = await sourceModule.fetchCatalog({ origin, token, trustedKeys: trusted, acceptedSequence: 0 });
  assert.equal(catalogDoc.sequence, 3);
  assert.equal(catalogDoc.channels.stable.entries[0].version, '0.9.9-1');

  const entry = catalogDoc.channels.stable.entries[0];
  const manifestDoc = await sourceModule.fetchManifest({ origin, token, trustedKeys: trusted, releaseId: entry.releaseId, expectedDigest: entry.manifestSha256 });
  assert.equal(manifestDoc.version, '0.9.9-1');
  assert.equal(manifestDoc.commit, '0'.repeat(40));

  const chosenArtifact = sourceModule.selectArtifact(manifestDoc, 'linux-managed', 'x64');
  assert.ok(chosenArtifact);

  const destination = path.join(environment.downloads, chosenArtifact.fileName);
  const downloaded = await sourceModule.downloadArtifact({ origin, token, manifest: manifestDoc, artifact: chosenArtifact, destination: destination });
  assert.equal(downloaded.sha256, DIGEST);
  assert.equal(downloaded.size, CONTENT.length);
  assert.deepEqual(await readFile(destination), CONTENT);
});

test('o progresso é reportado e chega ao total', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const manifestDoc = manifest();
  const progressReports: { received: number; total: number }[] = [];
  await sourceModule.downloadArtifact({
    origin: environment.origin, token: environment.token, manifest: manifestDoc, artifact: manifestDoc.artifacts[0],
    destination: path.join(environment.downloads, 'com-progresso.tar.gz'),
    onProgress: (p: { received: number; total: number }) => progressReports.push(p),
  });
  assert.ok(progressReports.length >= 1);
  assert.equal(progressReports.at(-1)?.received, CONTENT.length);
  assert.equal(progressReports.at(-1)?.total, CONTENT.length);
});

// ── Retomada ───────────────────────────────────────────────────────────────

test('um download interrompido continua de onde parou', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const manifestDoc = manifest();
  const destination = path.join(environment.downloads, 'retomado.tar.gz');

  // Primeira tentativa: cancelada no meio. O parcial fica no disco.
  await assert.rejects(
    () => sourceModule.downloadArtifact({
      origin: environment.origin, token: environment.token, manifest: manifestDoc, artifact: manifestDoc.artifacts[0], destination: destination,
      shouldCancel: (() => { let seen = 0; return () => (seen += 1) > 2; })(),
    }),
    /cancelad/i,
  );
  const partial = await stat(`${destination}.partial`);
  assert.ok(partial.size > 0, 'o parcial precisa sobrar para a retomada ter o que continuar');
  assert.ok(partial.size < CONTENT.length, 'e precisa estar incompleto');

  // Segunda tentativa: retoma e fecha.
  const downloaded = await sourceModule.downloadArtifact({
    origin: environment.origin, token: environment.token, manifest: manifestDoc, artifact: manifestDoc.artifacts[0], destination: destination,
  });
  assert.equal(downloaded.sha256, DIGEST, 'o arquivo remontado é idêntico ao original');
  assert.deepEqual(await readFile(destination), CONTENT);
});

// ── O que o cliente recusa ─────────────────────────────────────────────────

test('um catálogo assinado por chave desconhecida não decide nada', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const intruder = generateSigningKey();
  await assert.rejects(
    () => sourceModule.fetchCatalog({ origin: environment.origin, token: environment.token, trustedKeys: [{ ...intruder, scope: ['catalog'] }], acceptedSequence: 0 }),
    /chave que este aplicativo não conhece|não pôde ser verificado/,
  );
});

test('um catálogo mais antigo do que o já aceito é recusado', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  // O serviço publicou a sequência 3. Um cliente que já aceitou a 9 recusa.
  await assert.rejects(
    () => sourceModule.fetchCatalog({ origin: environment.origin, token: environment.token, trustedKeys: trusted, acceptedSequence: 9 }),
    /mais antiga do que a última aceita/,
  );
});

test('o serviço recusa publicar um catálogo já vencido', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const expired: Catalog = { ...catalog(4), expiresAt: new Date(Date.now() - 1000).toISOString() };
  const reply = await fetch(`${environment.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(expired, [catalogKey])),
  });
  assert.equal(reply.status, 409);
  assert.equal((await reply.json() as { reason: string }).reason, 'expired');
  // E o catálogo bom continua no ar: uma publicação recusada não derruba o
  // que estava valendo.
  assert.equal((await sourceModule.fetchCatalog({ origin: environment.origin, token: environment.token, trustedKeys: trusted, acceptedSequence: 0 })).sequence, 3);
});

test('um catálogo que venceu no relógio do cliente não instala nada', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  // O catálogo é válido quando publicado e vence depois. Quem percebe é o
  // cliente, no relógio dele — e a recusa é falha segura: sem saber qual é a
  // política vigente, não se instala nada.
  const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;
  await assert.rejects(
    () => sourceModule.fetchCatalog({ origin: environment.origin, token: environment.token, trustedKeys: trusted, acceptedSequence: 0, now: twoDaysLater }),
    /vencida|política atual/,
  );
});

test('o manifesto que não é o que o catálogo prometeu é recusado', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  // Os dois documentos podem ser autênticos e ainda assim ser o par errado.
  await assert.rejects(
    () => sourceModule.fetchManifest({
      origin: environment.origin, token: environment.token, trustedKeys: trusted,
      releaseId: 'rel-0991', expectedDigest: 'f'.repeat(64),
    }),
    /não é o que o catálogo prometeu/,
  );
});

test('um pacote trocado no armazenamento é descartado, e o resumo é o que pega', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const manifestDoc = manifest();
  // O manifesto assinado promete um resumo; o pacote entregue é outro. O
  // tamanho bate, então só o resumo pega — que é o caso que importa.
  const misleading = { ...manifestDoc, artifacts: [{ ...manifestDoc.artifacts[0], sha256: 'e'.repeat(64) }] };
  const destination = path.join(environment.downloads, 'trocado.tar.gz');
  await assert.rejects(
    () => sourceModule.downloadArtifact({ origin: environment.origin, token: environment.token, manifest: misleading, artifact: misleading.artifacts[0], destination: destination }),
    /não confere com o resumo publicado/,
  );
  // E o arquivo ruim não fica no disco.
  await assert.rejects(() => stat(destination));
  await assert.rejects(() => stat(`${destination}.partial`));
});

test('sem credencial não se busca nada', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  await assert.rejects(
    () => sourceModule.fetchCatalog({ origin: environment.origin, token: '', trustedKeys: trusted, acceptedSequence: 0 }),
    /convite|autorizado/i,
  );
});

test('uma credencial revogada para de buscar, com a razão dita', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const list = await (await fetch(`${environment.adminUrl}/admin/devices`)).json() as { devices: { deviceId: string }[] };
  await fetch(`${environment.adminUrl}/admin/devices/${list.devices[0].deviceId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'teste' }),
  });
  const failure = await sourceModule.fetchCatalog({ origin: environment.origin, token: environment.token, trustedKeys: trusted, acceptedSequence: 0 })
    .then(() => null, (e: Error & { reason?: string }) => e);
  assert.ok(failure);
  assert.equal(failure?.reason, 'revoked');
  assert.match(failure?.message ?? '', /revogado/);
});

test('renovar troca o token, e o antigo para de valer', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const renewed = await sourceModule.renewDevice({ origin: environment.origin, token: environment.token });
  assert.notEqual(renewed.token, environment.token);
  assert.equal((await sourceModule.fetchCatalog({ origin: environment.origin, token: renewed.token, trustedKeys: trusted, acceptedSequence: 0 })).sequence, 3);
  await assert.rejects(() => sourceModule.fetchCatalog({ origin: environment.origin, token: environment.token, trustedKeys: trusted, acceptedSequence: 0 }));
});

test('um convite inventado não inscreve ninguém', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  await assert.rejects(
    () => sourceModule.enrollDevice({ origin: environment.origin, invite: 'z'.repeat(64), label: 'intruso' }),
    /não é reconhecido/,
  );
});

test('uma versão retirada não é baixada, nem por quem já tinha o endereço', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  const manifestDoc = manifest();
  const withdrawn: Catalog = {
    ...catalog(4),
    channels: {
      stable: { entries: [{ ...catalog().channels.stable.entries[0], state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado', at: new Date().toISOString() } }] },
      test: { entries: [] },
    },
  };
  await fetch(`${environment.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(withdrawn, [catalogKey])),
  });
  await assert.rejects(
    () => sourceModule.downloadArtifact({
      origin: environment.origin, token: environment.token, manifest: manifestDoc, artifact: manifestDoc.artifacts[0],
      destination: path.join(environment.downloads, 'retirado.tar.gz'),
    }),
    /retirada/,
  );
});

// ── A origem não vem da rede ───────────────────────────────────────────────

test('a origem precisa ser https fora de localhost', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.encerrar());
  // Um `http` para fora entregaria o catálogo e a credencial a quem estiver no
  // caminho — e a assinatura provaria que o documento é autêntico sem impedir
  // que ele seja o documento *antigo*.
  await assert.rejects(
    () => sourceModule.fetchCatalog({ origin: 'http://exemplo.invalido', token: environment.token, trustedKeys: trusted }),
    /https/,
  );
});
