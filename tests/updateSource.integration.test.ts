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
const fonte = require_('../desktop/update-source.cjs') as {
  fetchCatalog: (o: Record<string, unknown>) => Promise<Catalog>;
  fetchManifest: (o: Record<string, unknown>) => Promise<ReleaseManifest>;
  downloadArtifact: (o: Record<string, unknown>) => Promise<{ file: string; sha256: string; size: number }>;
  enrollDevice: (o: Record<string, unknown>) => Promise<{ token: string; deviceId: string }>;
  renewDevice: (o: Record<string, unknown>) => Promise<{ token: string }>;
  selectArtifact: (m: ReleaseManifest, k: string, a: string) => Artifact | null;
};

const chaveManifesto = generateSigningKey();
const chaveCatalogo = generateSigningKey();
const confiaveis: TrustedKey[] = [
  { ...chaveManifesto, scope: ['manifest'] },
  { ...chaveCatalogo, scope: ['catalog'] },
];

// Grande o bastante para a retomada em duas partes ser real.
const CONTEUDO = Buffer.alloc(3 * 1024 * 1024, 7);
const RESUMO = createHash('sha256').update(CONTEUDO).digest('hex');

const artefato = (): Artifact => ({
  artifactId: 'linux-x64-tar', os: 'linux', arch: 'x64', format: 'tar.gz', installKind: 'linux-managed',
  fileName: 'tumacord-0.9.9-1.tar.gz', size: CONTEUDO.length, sha256: RESUMO,
  signatureKeyId: chaveManifesto.keyId, storagePath: 'releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
});

const manifesto = (): ReleaseManifest => ({
  contract: CONTRACT_VERSION, releaseId: 'rel-0991', version: '0.9.9-1', channel: 'stable',
  commit: '0'.repeat(40), createdAt: '2026-09-12T10:00:00.000Z', artifacts: [artefato()],
});

const catalogo = (sequence = 3): Catalog => ({
  contract: CONTRACT_VERSION, sequence,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  channels: {
    stable: { entries: [{ releaseId: 'rel-0991', version: '0.9.9-1', state: 'published', publishedAt: '2026-09-12T10:00:00.000Z', manifestSha256: documentDigest(manifesto()) }] },
    test: { entries: [] },
  },
});

interface Ambiente {
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
function escutando(servidor: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    servidor.once('listening', resolve);
    servidor.once('error', reject);
  });
}

async function subir(): Promise<Ambiente> {
  const raiz = await mkdtemp(path.join(tmpdir(), 'tumacord-cliente-'));
  const estado = path.join(raiz, 'estado');
  const pacotes = path.join(raiz, 'pacotes');
  const downloads = path.join(raiz, 'downloads');
  await mkdir(path.join(pacotes, 'releases', '0.9.9-1'), { recursive: true });
  await mkdir(estado, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(pacotes, 'releases', '0.9.9-1', 'tumacord-0.9.9-1.tar.gz'), CONTEUDO);

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = estado;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = pacotes;

  const modulo = await import(`../services/updates/src/index.js?c=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await modulo.store.load();
  const servidores: Server[] = [modulo.app.listen(0, '127.0.0.1'), modulo.admin.listen(0, '127.0.0.1')];
  await Promise.all(servidores.map((servidor) => escutando(servidor)));

  const origin = `http://127.0.0.1:${(servidores[0].address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(servidores[1].address() as AddressInfo).port}`;
  const json = { 'content-type': 'application/json' };
  await fetch(`${adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify({ keys: confiaveis }) });
  await fetch(`${adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(manifesto(), [chaveManifesto])) });
  await fetch(`${adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(catalogo(), [chaveCatalogo])) });
  const convite = await (await fetch(`${adminUrl}/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'máquina de teste' }) })).json() as { invite: string };
  const inscrito = await fonte.enrollDevice({ origin, invite: convite.invite, label: 'máquina de teste' });

  return {
    origin, adminUrl, downloads, token: inscrito.token,
    encerrar: async () => {
      await Promise.all(servidores.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await rm(raiz, { recursive: true, force: true });
    },
  };
}

// ── O caminho feliz, inteiro ───────────────────────────────────────────────

test('o cliente busca catálogo, manifesto e pacote sem tocar no GitHub', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const { origin, token } = ambiente;

  const cat = await fonte.fetchCatalog({ origin, token, trustedKeys: confiaveis, acceptedSequence: 0 });
  assert.equal(cat.sequence, 3);
  assert.equal(cat.channels.stable.entries[0].version, '0.9.9-1');

  const entrada = cat.channels.stable.entries[0];
  const man = await fonte.fetchManifest({ origin, token, trustedKeys: confiaveis, releaseId: entrada.releaseId, expectedDigest: entrada.manifestSha256 });
  assert.equal(man.version, '0.9.9-1');
  assert.equal(man.commit, '0'.repeat(40));

  const pacote = fonte.selectArtifact(man, 'linux-managed', 'x64');
  assert.ok(pacote);

  const destino = path.join(ambiente.downloads, pacote.fileName);
  const baixado = await fonte.downloadArtifact({ origin, token, manifest: man, artifact: pacote, destination: destino });
  assert.equal(baixado.sha256, RESUMO);
  assert.equal(baixado.size, CONTEUDO.length);
  assert.deepEqual(await readFile(destino), CONTEUDO);
});

test('o progresso é reportado e chega ao total', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const man = manifesto();
  const avisos: { received: number; total: number }[] = [];
  await fonte.downloadArtifact({
    origin: ambiente.origin, token: ambiente.token, manifest: man, artifact: man.artifacts[0],
    destination: path.join(ambiente.downloads, 'com-progresso.tar.gz'),
    onProgress: (p: { received: number; total: number }) => avisos.push(p),
  });
  assert.ok(avisos.length >= 1);
  assert.equal(avisos.at(-1)?.received, CONTEUDO.length);
  assert.equal(avisos.at(-1)?.total, CONTEUDO.length);
});

// ── Retomada ───────────────────────────────────────────────────────────────

test('um download interrompido continua de onde parou', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const man = manifesto();
  const destino = path.join(ambiente.downloads, 'retomado.tar.gz');

  // Primeira tentativa: cancelada no meio. O parcial fica no disco.
  await assert.rejects(
    () => fonte.downloadArtifact({
      origin: ambiente.origin, token: ambiente.token, manifest: man, artifact: man.artifacts[0], destination: destino,
      shouldCancel: (() => { let vistos = 0; return () => (vistos += 1) > 2; })(),
    }),
    /cancelad/i,
  );
  const parcial = await stat(`${destino}.partial`);
  assert.ok(parcial.size > 0, 'o parcial precisa sobrar para a retomada ter o que continuar');
  assert.ok(parcial.size < CONTEUDO.length, 'e precisa estar incompleto');

  // Segunda tentativa: retoma e fecha.
  const baixado = await fonte.downloadArtifact({
    origin: ambiente.origin, token: ambiente.token, manifest: man, artifact: man.artifacts[0], destination: destino,
  });
  assert.equal(baixado.sha256, RESUMO, 'o arquivo remontado é idêntico ao original');
  assert.deepEqual(await readFile(destino), CONTEUDO);
});

// ── O que o cliente recusa ─────────────────────────────────────────────────

test('um catálogo assinado por chave desconhecida não decide nada', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const intrusa = generateSigningKey();
  await assert.rejects(
    () => fonte.fetchCatalog({ origin: ambiente.origin, token: ambiente.token, trustedKeys: [{ ...intrusa, scope: ['catalog'] }], acceptedSequence: 0 }),
    /chave que este aplicativo não conhece|não pôde ser verificado/,
  );
});

test('um catálogo mais antigo do que o já aceito é recusado', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  // O serviço publicou a sequência 3. Um cliente que já aceitou a 9 recusa.
  await assert.rejects(
    () => fonte.fetchCatalog({ origin: ambiente.origin, token: ambiente.token, trustedKeys: confiaveis, acceptedSequence: 9 }),
    /mais antiga do que a última aceita/,
  );
});

test('o serviço recusa publicar um catálogo já vencido', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const vencido: Catalog = { ...catalogo(4), expiresAt: new Date(Date.now() - 1000).toISOString() };
  const resposta = await fetch(`${ambiente.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(vencido, [chaveCatalogo])),
  });
  assert.equal(resposta.status, 409);
  assert.equal((await resposta.json() as { reason: string }).reason, 'expired');
  // E o catálogo bom continua no ar: uma publicação recusada não derruba o
  // que estava valendo.
  assert.equal((await fonte.fetchCatalog({ origin: ambiente.origin, token: ambiente.token, trustedKeys: confiaveis, acceptedSequence: 0 })).sequence, 3);
});

test('um catálogo que venceu no relógio do cliente não instala nada', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  // O catálogo é válido quando publicado e vence depois. Quem percebe é o
  // cliente, no relógio dele — e a recusa é falha segura: sem saber qual é a
  // política vigente, não se instala nada.
  const daquiADoisDias = Date.now() + 2 * 24 * 60 * 60 * 1000;
  await assert.rejects(
    () => fonte.fetchCatalog({ origin: ambiente.origin, token: ambiente.token, trustedKeys: confiaveis, acceptedSequence: 0, now: daquiADoisDias }),
    /vencida|política atual/,
  );
});

test('o manifesto que não é o que o catálogo prometeu é recusado', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  // Os dois documentos podem ser autênticos e ainda assim ser o par errado.
  await assert.rejects(
    () => fonte.fetchManifest({
      origin: ambiente.origin, token: ambiente.token, trustedKeys: confiaveis,
      releaseId: 'rel-0991', expectedDigest: 'f'.repeat(64),
    }),
    /não é o que o catálogo prometeu/,
  );
});

test('um pacote trocado no armazenamento é descartado, e o resumo é o que pega', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const man = manifesto();
  // O manifesto assinado promete um resumo; o pacote entregue é outro. O
  // tamanho bate, então só o resumo pega — que é o caso que importa.
  const enganoso = { ...man, artifacts: [{ ...man.artifacts[0], sha256: 'e'.repeat(64) }] };
  const destino = path.join(ambiente.downloads, 'trocado.tar.gz');
  await assert.rejects(
    () => fonte.downloadArtifact({ origin: ambiente.origin, token: ambiente.token, manifest: enganoso, artifact: enganoso.artifacts[0], destination: destino }),
    /não confere com o resumo publicado/,
  );
  // E o arquivo ruim não fica no disco.
  await assert.rejects(() => stat(destino));
  await assert.rejects(() => stat(`${destino}.partial`));
});

test('sem credencial não se busca nada', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  await assert.rejects(
    () => fonte.fetchCatalog({ origin: ambiente.origin, token: '', trustedKeys: confiaveis, acceptedSequence: 0 }),
    /convite|autorizado/i,
  );
});

test('uma credencial revogada para de buscar, com a razão dita', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const lista = await (await fetch(`${ambiente.adminUrl}/admin/devices`)).json() as { devices: { deviceId: string }[] };
  await fetch(`${ambiente.adminUrl}/admin/devices/${lista.devices[0].deviceId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'teste' }),
  });
  const erro = await fonte.fetchCatalog({ origin: ambiente.origin, token: ambiente.token, trustedKeys: confiaveis, acceptedSequence: 0 })
    .then(() => null, (e: Error & { reason?: string }) => e);
  assert.ok(erro);
  assert.equal(erro?.reason, 'revoked');
  assert.match(erro?.message ?? '', /revogado/);
});

test('renovar troca o token, e o antigo para de valer', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const renovado = await fonte.renewDevice({ origin: ambiente.origin, token: ambiente.token });
  assert.notEqual(renovado.token, ambiente.token);
  assert.equal((await fonte.fetchCatalog({ origin: ambiente.origin, token: renovado.token, trustedKeys: confiaveis, acceptedSequence: 0 })).sequence, 3);
  await assert.rejects(() => fonte.fetchCatalog({ origin: ambiente.origin, token: ambiente.token, trustedKeys: confiaveis, acceptedSequence: 0 }));
});

test('um convite inventado não inscreve ninguém', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  await assert.rejects(
    () => fonte.enrollDevice({ origin: ambiente.origin, invite: 'z'.repeat(64), label: 'intruso' }),
    /não é reconhecido/,
  );
});

test('uma versão retirada não é baixada, nem por quem já tinha o endereço', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const man = manifesto();
  const retirado: Catalog = {
    ...catalogo(4),
    channels: {
      stable: { entries: [{ ...catalogo().channels.stable.entries[0], state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado', at: new Date().toISOString() } }] },
      test: { entries: [] },
    },
  };
  await fetch(`${ambiente.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(retirado, [chaveCatalogo])),
  });
  await assert.rejects(
    () => fonte.downloadArtifact({
      origin: ambiente.origin, token: ambiente.token, manifest: man, artifact: man.artifacts[0],
      destination: path.join(ambiente.downloads, 'retirado.tar.gz'),
    }),
    /retirada/,
  );
});

// ── A origem não vem da rede ───────────────────────────────────────────────

test('a origem precisa ser https fora de localhost', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  // Um `http` para fora entregaria o catálogo e a credencial a quem estiver no
  // caminho — e a assinatura provaria que o documento é autêntico sem impedir
  // que ele seja o documento *antigo*.
  await assert.rejects(
    () => fonte.fetchCatalog({ origin: 'http://exemplo.invalido', token: ambiente.token, trustedKeys: confiaveis }),
    /https/,
  );
});
