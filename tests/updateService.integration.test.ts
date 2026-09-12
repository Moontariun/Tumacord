import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import { freePort } from './freePort';
import { CONTRACT_VERSION, type Artifact, type Catalog, type ReleaseManifest, type TrustedKey } from '../shared/distribution';
import { generateSigningKey, signDocument } from '../shared/distributionCrypto';

// O serviço inteiro, de pé, respondendo HTTP. O que os casos unitários provam
// em separado — autorização, faixa, caminho — aqui é exercido pela porta por
// onde o aplicativo entra de verdade.
//
// O que este arquivo garante e um teste unitário não garantiria: que a
// autorização está **ligada** em cada rota. Uma função de autorização perfeita
// que ninguém chamou numa rota é uma rota aberta.

interface Servico {
  url: string;
  adminUrl: string;
  encerrar: () => Promise<void>;
  pacotes: string;
}

async function subir(): Promise<Servico> {
  const raiz = await mkdtemp(path.join(tmpdir(), 'tumacord-updates-'));
  const estado = path.join(raiz, 'estado');
  const pacotes = path.join(raiz, 'pacotes');
  await mkdir(estado, { recursive: true });
  await mkdir(pacotes, { recursive: true });

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = estado;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = pacotes;
  process.env.TUMACORD_UPDATES_MAX_DOWNLOADS = '4';

  // Import dinâmico para o módulo ler o ambiente já preparado. Cache-buster
  // para cada teste ter o próprio estado.
  const modulo = await import(`../services/atualizacoes/src/index.js?t=${Date.now()}${Math.random()}`) as typeof import('../services/atualizacoes/src/index');
  await modulo.store.load();

  const porta = await freePort();
  const portaAdmin = await freePort();
  const servidores: Server[] = [
    modulo.app.listen(porta, '127.0.0.1'),
    modulo.admin.listen(portaAdmin, '127.0.0.1'),
  ];
  await Promise.all(servidores.map((servidor) => new Promise<void>((resolve) => servidor.once('listening', resolve))));

  return {
    url: `http://127.0.0.1:${porta}`,
    adminUrl: `http://127.0.0.1:${portaAdmin}`,
    pacotes,
    encerrar: async () => {
      await Promise.all(servidores.map((servidor) => new Promise<void>((resolve) => servidor.close(() => resolve()))));
      await rm(raiz, { recursive: true, force: true });
    },
  };
}

const chaveManifesto = generateSigningKey();
const chaveCatalogo = generateSigningKey();
const confiaveis: TrustedKey[] = [
  { ...chaveManifesto, scope: ['manifest'] },
  { ...chaveCatalogo, scope: ['catalog'] },
];

const CONTEUDO = Buffer.from('conteudo do pacote do tumacord'.repeat(64));
const RESUMO = createHash('sha256').update(CONTEUDO).digest('hex');

function artefato(): Artifact {
  return {
    artifactId: 'linux-x64-tar', os: 'linux', arch: 'x64', format: 'tar.gz', installKind: 'linux-managed',
    fileName: 'tumacord-0.9.9-1.tar.gz', size: CONTEUDO.length, sha256: RESUMO,
    signatureKeyId: chaveManifesto.keyId, storagePath: 'releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
  };
}

function manifesto(): ReleaseManifest {
  return {
    contract: CONTRACT_VERSION, releaseId: 'rel-0991', version: '0.9.9-1', channel: 'stable',
    commit: '0'.repeat(40), createdAt: '2026-09-12T10:00:00.000Z', artifacts: [artefato()],
  };
}

function catalogo(sequence = 1): Catalog {
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
async function preparar(servico: Servico): Promise<{ token: string }> {
  await mkdir(path.join(servico.pacotes, 'releases', '0.9.9-1'), { recursive: true });
  await writeFile(path.join(servico.pacotes, 'releases', '0.9.9-1', 'tumacord-0.9.9-1.tar.gz'), CONTEUDO);

  const json = { 'content-type': 'application/json' };
  await fetch(`${servico.adminUrl}/admin/chaves`, { method: 'POST', headers: json, body: JSON.stringify({ keys: confiaveis }) });
  await fetch(`${servico.adminUrl}/admin/manifesto`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(manifesto(), [chaveManifesto])) });
  await fetch(`${servico.adminUrl}/admin/catalogo`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(catalogo(), [chaveCatalogo])) });

  const convite = await (await fetch(`${servico.adminUrl}/admin/convites`, { method: 'POST', headers: json, body: JSON.stringify({ rotulo: 'Linux do Renan' }) })).json() as { convite: string };
  const inscrito = await (await fetch(`${servico.url}/v1/dispositivos/inscrever`, { method: 'POST', headers: json, body: JSON.stringify({ convite: convite.convite, rotulo: 'Linux do Renan' }) })).json() as { token: string };
  return { token: inscrito.token };
}

const baixar = (url: string, token: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });

// ── Nenhuma rota de conteúdo é anônima ─────────────────────────────────────

test('nenhuma rota de conteúdo responde sem credencial', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  await preparar(servico);

  // Uma função de autorização perfeita que ninguém chamou numa rota é uma rota
  // aberta. Cada uma é perguntada aqui.
  for (const caminho of ['/v1/catalogo', '/v1/releases/rel-0991/manifesto', '/v1/artefatos/rel-0991/linux-x64-tar']) {
    const resposta = await fetch(`${servico.url}${caminho}`);
    assert.equal(resposta.status, 401, caminho);
    const corpo = await resposta.json() as { error: string; reason: string };
    assert.equal(corpo.reason, 'missing');
    assert.match(corpo.error, /convite/, 'a mensagem diz o que fazer, em português');
  }
});

test('HEAD e Range passam pela mesma autorização do GET', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  await preparar(servico);
  const alvo = `${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`;

  // Um HEAD anônimo revelaria tamanho e existência; um Range anônimo seria o
  // download inteiro em pedaços.
  assert.equal((await fetch(alvo, { method: 'HEAD' })).status, 401);
  assert.equal((await fetch(alvo, { headers: { range: 'bytes=0-10' } })).status, 401);
});

test('não há listagem de diretório nem caminho estático para os pacotes', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);

  // O segundo caminho para o mesmo conteúdo é sempre o que ninguém lembra de
  // proteger. Aqui não existe segundo caminho.
  for (const caminho of [
    '/pacotes/releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
    '/releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
    '/v1/artefatos/',
    '/v1/artefatos',
    '/',
  ]) {
    const resposta = await baixar(`${servico.url}${caminho}`, token);
    assert.equal(resposta.status, 404, caminho);
  }
});

// ── Download, retomada e limites ───────────────────────────────────────────

test('o pacote é entregue inteiro e confere com o resumo do manifesto', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);

  const resposta = await baixar(`${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`, token);
  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('accept-ranges'), 'bytes');
  assert.equal(resposta.headers.get('cache-control'), 'private, no-store');
  assert.equal(resposta.headers.get('vary'), 'Authorization');
  const bytes = Buffer.from(await resposta.arrayBuffer());
  assert.equal(bytes.length, CONTEUDO.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), RESUMO);
});

test('a retomada continua de onde parou, e os pedaços remontam o arquivo', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);
  const alvo = `${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`;

  const cabeca = await baixar(alvo, token, { method: 'HEAD' });
  assert.equal(cabeca.status, 200);
  const tamanho = Number(cabeca.headers.get('content-length'));
  assert.equal(tamanho, CONTEUDO.length);
  assert.equal((await cabeca.arrayBuffer()).byteLength, 0, 'HEAD não traz corpo');

  const corte = Math.floor(tamanho / 3);
  const primeiro = await baixar(alvo, token, { headers: { range: `bytes=0-${corte - 1}` } });
  const segundo = await baixar(alvo, token, { headers: { range: `bytes=${corte}-` } });
  assert.equal(primeiro.status, 206);
  assert.equal(segundo.status, 206);
  assert.equal(primeiro.headers.get('content-range'), `bytes 0-${corte - 1}/${tamanho}`);

  const remontado = Buffer.concat([Buffer.from(await primeiro.arrayBuffer()), Buffer.from(await segundo.arrayBuffer())]);
  assert.equal(createHash('sha256').update(remontado).digest('hex'), RESUMO, 'os pedaços remontam o arquivo original');
});

test('uma faixa impossível devolve 416, e não o arquivo inteiro', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);
  const resposta = await baixar(`${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`, token, { headers: { range: 'bytes=99999999-' } });
  assert.equal(resposta.status, 416);
  assert.equal((await resposta.arrayBuffer()).byteLength, 0);
});

// ── Revogação alcança quem já estava baixando ──────────────────────────────

test('uma credencial revogada para de baixar na hora', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);
  const alvo = `${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`;

  assert.equal((await baixar(alvo, token)).status, 200);

  const lista = await (await fetch(`${servico.adminUrl}/admin/dispositivos`)).json() as { devices: { deviceId: string }[] };
  assert.equal(lista.devices.length, 1);
  // E a lista do dono não carrega hash nenhum.
  assert.equal(JSON.stringify(lista).includes('tokenHash'), false);

  await fetch(`${servico.adminUrl}/admin/dispositivos/${lista.devices[0].deviceId}/revogar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ motivo: 'máquina perdida' }),
  });

  const depois = await baixar(alvo, token);
  assert.equal(depois.status, 403);
  assert.equal((await depois.json() as { reason: string }).reason, 'revoked');
  // O catálogo também para: a revogação não é só do download.
  assert.equal((await baixar(`${servico.url}/v1/catalogo`, token)).status, 403);
});

test('renovar troca o token, e o antigo deixa de valer', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);

  const renovado = await (await baixar(`${servico.url}/v1/dispositivos/renovar`, token, { method: 'POST' })).json() as { token: string };
  assert.notEqual(renovado.token, token);
  assert.equal((await baixar(`${servico.url}/v1/catalogo`, renovado.token)).status, 200);
  assert.equal((await baixar(`${servico.url}/v1/catalogo`, token)).status, 401, 'o token trocado não vale mais');
});

// ── Uma versão retirada não é baixada de novo ──────────────────────────────

test('retirar uma versão impede o download, inclusive de quem já tinha a URL', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);
  const alvo = `${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`;
  assert.equal((await baixar(alvo, token)).status, 200);

  const retirado: Catalog = {
    ...catalogo(2),
    channels: {
      stable: { entries: [{ releaseId: 'rel-0991', version: '0.9.9-1', state: 'withdrawn', publishedAt: '2026-09-12T10:00:00.000Z', manifestSha256: '', withdrawn: { reason: 'o áudio sai errado', at: new Date().toISOString() } }] },
      test: { entries: [] },
    },
  };
  const publicado = await fetch(`${servico.adminUrl}/admin/catalogo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(retirado, [chaveCatalogo])),
  });
  assert.equal(publicado.status, 201);

  const depois = await baixar(alvo, token);
  assert.equal(depois.status, 410, 'a retirada precisa alcançar as máquinas que já estavam na rua');
  assert.equal((await depois.json() as { reason: string }).reason, 'withdrawn');
});

// ── O que a administração recusa ───────────────────────────────────────────

test('um manifesto sem assinatura confiável não entra', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  await preparar(servico);
  const intrusa = generateSigningKey();

  const resposta = await fetch(`${servico.adminUrl}/admin/manifesto`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signDocument({ ...manifesto(), releaseId: 'rel-falso' }, [intrusa])),
  });
  assert.equal(resposta.status, 400);
  assert.equal((await resposta.json() as { reason: string }).reason, 'unknown-key');
  // E a release falsa não passa a existir.
  const { token } = await preparar(servico);
  assert.equal((await baixar(`${servico.url}/v1/releases/rel-falso/manifesto`, token)).status, 404);
});

test('um catálogo repetido não volta no tempo', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  await preparar(servico);

  const antigo = await fetch(`${servico.adminUrl}/admin/catalogo`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signDocument(catalogo(1), [chaveCatalogo])),
  });
  assert.equal(antigo.status, 409);
  assert.equal((await antigo.json() as { reason: string }).reason, 'sequence-not-advancing');
});

test('quem assina catálogo não consegue publicar manifesto, e vice-versa', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  await preparar(servico);
  const json = { 'content-type': 'application/json' };

  const trocado = await fetch(`${servico.adminUrl}/admin/manifesto`, {
    method: 'POST', headers: json, body: JSON.stringify(signDocument(manifesto(), [chaveCatalogo])),
  });
  assert.equal(trocado.status, 400);
  assert.equal((await trocado.json() as { reason: string }).reason, 'key-wrong-scope');

  const inverso = await fetch(`${servico.adminUrl}/admin/catalogo`, {
    method: 'POST', headers: json, body: JSON.stringify(signDocument(catalogo(2), [chaveManifesto])),
  });
  assert.equal(inverso.status, 400);
  assert.equal((await inverso.json() as { reason: string }).reason, 'key-wrong-scope');
});

// ── O serviço não devolve credencial em lugar nenhum ───────────────────────

test('nenhuma resposta devolve token, convite ou hash', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);

  for (const caminho of ['/v1/catalogo', '/v1/releases/rel-0991/manifesto', '/v1/chaves', '/v1/saude']) {
    const texto = await (await baixar(`${servico.url}${caminho}`, token)).text();
    assert.equal(texto.includes(token), false, `${caminho} devolveu o token`);
    assert.equal(/tokenHash/i.test(texto), false, `${caminho} devolveu hash`);
  }
  // E o cabeçalho de download não carrega a credencial de volta.
  const download = await baixar(`${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`, token, { method: 'HEAD' });
  for (const [, valor] of download.headers) assert.equal(String(valor).includes(token), false);
  // Nem há redirect: uma redireção levaria o `Authorization` para outro lugar.
  assert.equal(download.redirected, false);
  assert.equal(download.status, 200);
});

test('o método errado é recusado sem abrir o arquivo', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);
  const resposta = await baixar(`${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`, token, { method: 'DELETE' });
  assert.equal(resposta.status, 405);
  assert.equal(resposta.headers.get('allow'), 'GET, HEAD');
});

test('o pacote em disco que não confere com o manifesto não é servido', { timeout: 20_000 }, async (context) => {
  const servico = await subir();
  context.after(() => servico.encerrar());
  const { token } = await preparar(servico);

  // Alguém trocou o arquivo no armazenamento. Servir assim entregaria bytes
  // que ninguém assinou.
  await writeFile(path.join(servico.pacotes, 'releases', '0.9.9-1', 'tumacord-0.9.9-1.tar.gz'), Buffer.from('outro conteudo'));
  const resposta = await baixar(`${servico.url}/v1/artefatos/rel-0991/linux-x64-tar`, token);
  assert.equal(resposta.status, 409);
  assert.equal((await resposta.json() as { reason: string }).reason, 'size-mismatch');
});
