import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONTRACT_VERSION, type Artifact, type Catalog, type ReleaseManifest, type TrustedKey } from '../shared/distribution';
import { generateSigningKey, signDocument } from '../shared/distributionCrypto';

// O serviço inteiro, de pé, respondendo HTTP. O que os casos unitários provam
// em separado — autorização, faixa, caminho — aqui é exercido pela porta por
// onde o aplicativo entra de verdade.
//
// O que este arquivo garante e um teste unitário não garantiria: que a
// autorização está **ligada** em cada rota. Uma função de autorização perfeita
// que ninguém chamou numa rota é uma rota aberta.

interface ServiceHandle {
  url: string;
  adminUrl: string;
  encerrar: () => Promise<void>;
  pacotes: string;
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

async function start(): Promise<ServiceHandle> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'tumacord-updates-'));
  const stateDir = path.join(rootDir, 'estado');
  const packagesDir = path.join(rootDir, 'pacotes');
  await mkdir(stateDir, { recursive: true });
  await mkdir(packagesDir, { recursive: true });

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = stateDir;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = packagesDir;
  process.env.TUMACORD_UPDATES_MAX_DOWNLOADS = '4';

  // Import dinâmico para o módulo ler o ambiente já preparado. Cache-buster
  // para cada teste ter o próprio estado.
  const serviceModule = await import(`../services/updates/src/index.js?t=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await serviceModule.store.load();

  const servers: Server[] = [
    serviceModule.app.listen(0, '127.0.0.1'),
    serviceModule.admin.listen(0, '127.0.0.1'),
  ];
  await Promise.all(servers.map((serviceServer) => listening(serviceServer)));

  return {
    url: `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}`,
    adminUrl: `http://127.0.0.1:${(servers[1].address() as AddressInfo).port}`,
    pacotes: packagesDir,
    encerrar: async () => {
      await Promise.all(servers.map((serviceServer) => new Promise<void>((resolve) => serviceServer.close(() => resolve()))));
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

const manifestKey = generateSigningKey();
const catalogKey = generateSigningKey();
const trusted: TrustedKey[] = [
  { ...manifestKey, scope: ['manifest'] },
  { ...catalogKey, scope: ['catalog'] },
];

const CONTENT = Buffer.from('conteudo do pacote do tumacord'.repeat(64));
const DIGEST = createHash('sha256').update(CONTENT).digest('hex');

function artifact(): Artifact {
  return {
    artifactId: 'linux-x64-tar', os: 'linux', arch: 'x64', format: 'tar.gz', installKind: 'linux-managed',
    fileName: 'tumacord-0.9.9-1.tar.gz', size: CONTENT.length, sha256: DIGEST,
    signatureKeyId: manifestKey.keyId, storagePath: 'releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
  };
}

function manifest(): ReleaseManifest {
  return {
    contract: CONTRACT_VERSION, releaseId: 'rel-0991', version: '0.9.9-1', channel: 'stable',
    commit: '0'.repeat(40), createdAt: '2026-09-12T10:00:00.000Z', artifacts: [artifact()],
  };
}

function catalog(sequence = 1): Catalog {
  return {
    contract: CONTRACT_VERSION, sequence,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channels: {
      stable: { entries: [{ releaseId: 'rel-0991', version: '0.9.9-1', state: 'published', publishedAt: '2026-09-12T10:00:00.000Z', manifestSha256: '' }] },
      test: { entries: [] },
    },
  };
}

/** Deixa o serviço no estado de um servidor já publicado, com um dispositivo. */
async function prepare(service: ServiceHandle): Promise<{ token: string }> {
  await mkdir(path.join(service.pacotes, 'releases', '0.9.9-1'), { recursive: true });
  await writeFile(path.join(service.pacotes, 'releases', '0.9.9-1', 'tumacord-0.9.9-1.tar.gz'), CONTENT);

  const json = { 'content-type': 'application/json' };
  await fetch(`${service.adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify({ keys: trusted }) });
  await fetch(`${service.adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(manifest(), [manifestKey])) });
  await fetch(`${service.adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(catalog(), [catalogKey])) });

  const invite = await (await fetch(`${service.adminUrl}/admin/invites`, { method: 'POST', headers: json, body: JSON.stringify({ label: 'Linux do Renan' }) })).json() as { invite: string };
  const enrolled = await (await fetch(`${service.url}/v1/devices/enroll`, { method: 'POST', headers: json, body: JSON.stringify({ invite: invite.invite, label: 'Linux do Renan' }) })).json() as { token: string };
  return { token: enrolled.token };
}

const fetchArtifact = (url: string, token: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });

// ── Nenhuma rota de conteúdo é anônima ─────────────────────────────────────

test('nenhuma rota de conteúdo responde sem credencial', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  await prepare(service);

  // Uma função de autorização perfeita que ninguém chamou numa rota é uma rota
  // aberta. Cada uma é perguntada aqui.
  for (const route of ['/v1/catalog', '/v1/releases/rel-0991/manifest', '/v1/artifacts/rel-0991/linux-x64-tar']) {
    const reply = await fetch(`${service.url}${route}`);
    assert.equal(reply.status, 401, route);
    const body = await reply.json() as { error: string; reason: string };
    assert.equal(body.reason, 'missing');
    assert.match(body.error, /convite/, 'a mensagem diz o que fazer, em português');
  }
});

test('HEAD e Range passam pela mesma autorização do GET', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  await prepare(service);
  const target = `${service.url}/v1/artifacts/rel-0991/linux-x64-tar`;

  // Um HEAD anônimo revelaria tamanho e existência; um Range anônimo seria o
  // download inteiro em pedaços.
  assert.equal((await fetch(target, { method: 'HEAD' })).status, 401);
  assert.equal((await fetch(target, { headers: { range: 'bytes=0-10' } })).status, 401);
});

test('não há listagem de diretório nem caminho estático para os pacotes', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);

  // O segundo caminho para o mesmo conteúdo é sempre o que ninguém lembra de
  // proteger. Aqui não existe segundo caminho.
  for (const route of [
    '/pacotes/releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
    '/releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
    '/v1/artifacts/',
    '/v1/artifacts',
    '/',
  ]) {
    const reply = await fetchArtifact(`${service.url}${route}`, token);
    assert.equal(reply.status, 404, route);
  }
});

// ── Download, retomada e limites ───────────────────────────────────────────

test('o pacote é entregue inteiro e confere com o resumo do manifesto', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);

  const reply = await fetchArtifact(`${service.url}/v1/artifacts/rel-0991/linux-x64-tar`, token);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('accept-ranges'), 'bytes');
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  assert.equal(reply.headers.get('vary'), 'Authorization');
  const bytes = Buffer.from(await reply.arrayBuffer());
  assert.equal(bytes.length, CONTENT.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), DIGEST);
});

test('a retomada continua de onde parou, e os pedaços remontam o arquivo', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);
  const target = `${service.url}/v1/artifacts/rel-0991/linux-x64-tar`;

  const head = await fetchArtifact(target, token, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const size = Number(head.headers.get('content-length'));
  assert.equal(size, CONTENT.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD não traz corpo');

  const cut = Math.floor(size / 3);
  const first = await fetchArtifact(target, token, { headers: { range: `bytes=0-${cut - 1}` } });
  const second = await fetchArtifact(target, token, { headers: { range: `bytes=${cut}-` } });
  assert.equal(first.status, 206);
  assert.equal(second.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 0-${cut - 1}/${size}`);

  const reassembled = Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await second.arrayBuffer())]);
  assert.equal(createHash('sha256').update(reassembled).digest('hex'), DIGEST, 'os pedaços remontam o arquivo original');
});

test('uma faixa impossível devolve 416, e não o arquivo inteiro', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);
  const reply = await fetchArtifact(`${service.url}/v1/artifacts/rel-0991/linux-x64-tar`, token, { headers: { range: 'bytes=99999999-' } });
  assert.equal(reply.status, 416);
  assert.equal((await reply.arrayBuffer()).byteLength, 0);
});

// ── Revogação alcança quem já estava baixando ──────────────────────────────

test('uma credencial revogada para de baixar na hora', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);
  const target = `${service.url}/v1/artifacts/rel-0991/linux-x64-tar`;

  assert.equal((await fetchArtifact(target, token)).status, 200);

  const list = await (await fetch(`${service.adminUrl}/admin/devices`)).json() as { devices: { deviceId: string }[] };
  assert.equal(list.devices.length, 1);
  // E a lista do dono não carrega hash nenhum.
  assert.equal(JSON.stringify(list).includes('tokenHash'), false);

  await fetch(`${service.adminUrl}/admin/devices/${list.devices[0].deviceId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'máquina perdida' }),
  });

  const after = await fetchArtifact(target, token);
  assert.equal(after.status, 403);
  assert.equal((await after.json() as { reason: string }).reason, 'revoked');
  // O catálogo também para: a revogação não é só do download.
  assert.equal((await fetchArtifact(`${service.url}/v1/catalog`, token)).status, 403);
});

test('renovar troca o token, e o antigo deixa de valer', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);

  const renewed = await (await fetchArtifact(`${service.url}/v1/devices/renew`, token, { method: 'POST' })).json() as { token: string };
  assert.notEqual(renewed.token, token);
  assert.equal((await fetchArtifact(`${service.url}/v1/catalog`, renewed.token)).status, 200);
  assert.equal((await fetchArtifact(`${service.url}/v1/catalog`, token)).status, 401, 'o token trocado não vale mais');
});

// ── Uma versão retirada não é baixada de novo ──────────────────────────────

test('retirar uma versão impede o download, inclusive de quem já tinha a URL', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);
  const target = `${service.url}/v1/artifacts/rel-0991/linux-x64-tar`;
  assert.equal((await fetchArtifact(target, token)).status, 200);

  const withdrawn: Catalog = {
    ...catalog(2),
    channels: {
      stable: { entries: [{ releaseId: 'rel-0991', version: '0.9.9-1', state: 'withdrawn', publishedAt: '2026-09-12T10:00:00.000Z', manifestSha256: '', withdrawn: { reason: 'o áudio sai errado', at: new Date().toISOString() } }] },
      test: { entries: [] },
    },
  };
  const published = await fetch(`${service.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(withdrawn, [catalogKey])),
  });
  assert.equal(published.status, 201);

  const after = await fetchArtifact(target, token);
  assert.equal(after.status, 410, 'a retirada precisa alcançar as máquinas que já estavam na rua');
  assert.equal((await after.json() as { reason: string }).reason, 'withdrawn');
});

// ── O que a administração recusa ───────────────────────────────────────────

test('um manifesto sem assinatura confiável não entra', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  await prepare(service);
  const intruder = generateSigningKey();

  const reply = await fetch(`${service.adminUrl}/admin/manifest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signDocument({ ...manifest(), releaseId: 'rel-falso' }, [intruder])),
  });
  assert.equal(reply.status, 400);
  assert.equal((await reply.json() as { reason: string }).reason, 'unknown-key');
  // E a release falsa não passa a existir.
  const { token } = await prepare(service);
  assert.equal((await fetchArtifact(`${service.url}/v1/releases/rel-falso/manifesto`, token)).status, 404);
});

test('um catálogo repetido não volta no tempo', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  await prepare(service);

  const older = await fetch(`${service.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signDocument(catalog(1), [catalogKey])),
  });
  assert.equal(older.status, 409);
  assert.equal((await older.json() as { reason: string }).reason, 'sequence-not-advancing');
});

test('quem assina catálogo não consegue publicar manifesto, e vice-versa', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  await prepare(service);
  const json = { 'content-type': 'application/json' };

  const swapped = await fetch(`${service.adminUrl}/admin/manifest`, {
    method: 'POST', headers: json, body: JSON.stringify(signDocument(manifest(), [catalogKey])),
  });
  assert.equal(swapped.status, 400);
  assert.equal((await swapped.json() as { reason: string }).reason, 'key-wrong-scope');

  const reversed = await fetch(`${service.adminUrl}/admin/catalog`, {
    method: 'POST', headers: json, body: JSON.stringify(signDocument(catalog(2), [manifestKey])),
  });
  assert.equal(reversed.status, 400);
  assert.equal((await reversed.json() as { reason: string }).reason, 'key-wrong-scope');
});

// ── O serviço não devolve credencial em lugar nenhum ───────────────────────

test('nenhuma resposta devolve token, convite ou hash', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);

  for (const route of ['/v1/catalog', '/v1/releases/rel-0991/manifest', '/v1/keys', '/v1/health']) {
    const text = await (await fetchArtifact(`${service.url}${route}`, token)).text();
    assert.equal(text.includes(token), false, `${route} devolveu o token`);
    assert.equal(/tokenHash/i.test(text), false, `${route} devolveu hash`);
  }
  // E o cabeçalho de download não carrega a credencial de volta.
  const download = await fetchArtifact(`${service.url}/v1/artifacts/rel-0991/linux-x64-tar`, token, { method: 'HEAD' });
  for (const [, value] of download.headers) assert.equal(String(value).includes(token), false);
  // Nem há redirect: uma redireção levaria o `Authorization` para outro lugar.
  assert.equal(download.redirected, false);
  assert.equal(download.status, 200);
});

test('o método errado é recusado sem abrir o arquivo', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);
  const reply = await fetchArtifact(`${service.url}/v1/artifacts/rel-0991/linux-x64-tar`, token, { method: 'DELETE' });
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.get('allow'), 'GET, HEAD');
});

test('o pacote em disco que não confere com o manifesto não é servido', { timeout: 20_000 }, async (context) => {
  const service = await start();
  context.after(() => service.encerrar());
  const { token } = await prepare(service);

  // Alguém trocou o arquivo no armazenamento. Servir assim entregaria bytes
  // que ninguém assinou.
  await writeFile(path.join(service.pacotes, 'releases', '0.9.9-1', 'tumacord-0.9.9-1.tar.gz'), Buffer.from('outro conteudo'));
  const reply = await fetchArtifact(`${service.url}/v1/artifacts/rel-0991/linux-x64-tar`, token);
  assert.equal(reply.status, 409);
  assert.equal((await reply.json() as { reason: string }).reason, 'size-mismatch');
});
