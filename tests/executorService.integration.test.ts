// O executor, subido de verdade num socket.
//
// O que precisa ser provado aqui é a superfície: que nada de arbitrário entra,
// que sem o segredo nada sai, que ele se recusa a escutar fora do laço local, e
// que um pedido repetido não vira um segundo deploy.

import assert from 'node:assert/strict';
import { statSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobStore } from '../tools/tumacordctl/lib/jobs.mjs';
import {
  bearer, createExecutor, loadSecret, secretMatches, settings, socketPlacementError, validReleaseId,
} from '../tools/tumacordctl/executor.mjs';

/** Sobe o executor num diretório de estado descartável. */
async function startExecutor(t: { after: (fn: () => unknown) => void }, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-executor-'));
  const config = {
    ...settings({} as never),
    host: '127.0.0.1',
    // Porta zero: o sistema escolhe uma livre, e não há corrida com outro teste.
    port: 0,
    stateDir: directory,
    ...overrides,
  };
  const executor = createExecutor(config, { store: new JobStore(directory) });
  const loaded = await executor.listen();
  const { port } = executor.server.address() as { port: number };
  t.after(async () => {
    await new Promise((resolve) => executor.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { executor, config, secret: loaded.secret, base: `http://127.0.0.1:${port}` };
}

async function requestJson(base: string, route: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

test('sem o segredo nada sai, e o motivo não é detalhado', async (t) => {
  const { base, secret } = await startExecutor(t);

  const anonymous = await requestJson(base, '/v1/state');
  assert.equal(anonymous.status, 401);
  // Dizer *por que* falhou ajudaria quem está adivinhando.
  assert.equal(anonymous.body.error, 'Não autorizado.');

  const wrongSecret = await requestJson(base, '/v1/jobs', { headers: { authorization: 'Bearer nao-e-o-segredo' } });
  assert.equal(wrongSecret.status, 401);

  const authorized = await requestJson(base, '/v1/jobs', { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body.jobs, []);
});

test('a saúde responde sem segredo, e não conta nada sobre a instalação', async (t) => {
  const { base } = await startExecutor(t);
  const { status, body } = await requestJson(base, '/health');
  assert.equal(status, 200);
  // Só o suficiente para o systemd e o proxy saberem que ele está de pé.
  assert.deepEqual(body, { ok: true, servico: 'tumacord-executor' });
});

test('o executor recusa escutar fora do laço local', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-executor-'));
  const executor = createExecutor(
    { ...settings({} as never), host: '0.0.0.0', port: 0, stateDir: directory },
    { store: new JobStore(directory) },
  );
  // Alcançá-lo pela internet é um jeito de alguém trocar a versão do servidor.
  await assert.rejects(() => executor.listen(), /laço local/);
  await rm(directory, { recursive: true, force: true });
});

test('não há rota que aceite comando, caminho ou URL', async (t) => {
  const { base, secret } = await startExecutor(t);
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };

  for (const unknownRoute of ['/v1/exec', '/v1/shell', '/v1/run', '/v1/fetch', '/v1/artifacts']) {
    const { status } = await requestJson(base, unknownRoute, { method: 'POST', headers, body: '{}' });
    assert.equal(status, 404, `${unknownRoute} respondeu algo`);
  }

  // E o que existe recusa um identificador que não é um identificador.
  for (const bad of ['../../etc/passwd', 'rel 1; rm -rf /', 'http://exemplo/x', '', 'x'.repeat(200)]) {
    assert.equal(validReleaseId(bad), false, `\`${bad}\` foi aceito como releaseId`);
  }
  assert.equal(validReleaseId('rel_stable_0-9-9-1'), true);
});

test('aplicar sem releaseId é recusado antes de qualquer efeito', async (t) => {
  const { base, secret } = await startExecutor(t);
  const { status, body } = await requestJson(base, '/v1/apply', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', releaseId: '../x' }),
  });
  assert.equal(status, 400);
  assert.match(String(body.error), /releaseId/);
});

test('um corpo grande demais não é lido inteiro', async (t) => {
  const { base, secret } = await startExecutor(t);
  const { status } = await requestJson(base, '/v1/apply', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ releaseId: 'rel_1', lixo: 'x'.repeat(64 * 1024) }),
  });
  assert.equal(status, 413);
});

test('o segredo é gerado uma vez, com permissão restrita, e não muda na subida seguinte', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-executor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = await loadSecret(directory);
  assert.equal(first.created, true);
  assert.ok(first.secret.length >= 32);

  const { statSync } = await import('node:fs');
  // 0600: o ambiente de um processo é legível por quem lê /proc; um arquivo
  // com dono e permissão não é.
  assert.equal(statSync(first.file).mode & 0o777, 0o600);

  const second = await loadSecret(directory);
  assert.equal(second.created, false);
  assert.equal(second.secret, first.secret, 'reiniciar o executor não pode derrubar o painel');
});

test('a comparação do segredo não depende do conteúdo para terminar', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('ab', 'abc'), false);
  assert.equal(secretMatches('', ''), false, 'sem segredo configurado nada passa');
  assert.equal(secretMatches(undefined, 'abc'), false);
});

test('o portador é lido do cabeçalho, e só nesse formato', () => {
  assert.equal(bearer('Bearer abc123'), 'abc123');
  assert.equal(bearer('bearer abc123'), 'abc123');
  assert.equal(bearer('Basic abc123'), '');
  assert.equal(bearer(''), '');
  assert.equal(bearer('Bearer a b'), '', 'nada de espaço no meio do token');
});

test('as configurações vêm do ambiente, e o padrão escuta só no laço local', () => {
  const defaults = settings({} as never);
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 4302);
  assert.equal(defaults.updatesAdmin, 'http://127.0.0.1:4301');
  assert.equal(defaults.socket, '', 'sem socket configurado, porta no laço local');
  assert.equal(defaults.backupDir, '/var/lib/tumacord/backups', 'aplicar sem copiar não é o padrão');

  const custom = settings({ TUMACORD_EXECUTOR_PORT: '5000', TUMACORD_PROJETO: 'homologacao' } as never);
  assert.equal(custom.port, 5000);
  assert.equal(custom.project, 'homologacao');
});

test('sem destino de cópia, o painel não aplica nada', async (t) => {
  // Voltar o código não volta os dados. A recusa vem antes de qualquer
  // conferência, para quem pediu saber disso primeiro.
  const { base, secret } = await startExecutor(t, { backupDir: '' });
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };

  const applyResponse = await requestJson(base, '/v1/apply', { method: 'POST', headers, body: JSON.stringify({ releaseId: 'rel_stable_0-9-9-1' }) });
  assert.equal(applyResponse.status, 409);
  assert.match(String(applyResponse.body.error), /sem cópia/);

  const backupResponse = await requestJson(base, '/v1/backup', { method: 'POST', headers, body: '{}' });
  assert.equal(backupResponse.status, 501);
  assert.match(String(backupResponse.body.error), /TUMACORD_BACKUP_DIR/);
});

// ── O socket ────────────────────────────────────────────────────────────────

function requestOverSocket(socketPath: string, route: string, token = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path: route, headers: token ? { authorization: `Bearer ${token}` } : {} }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    call.on('error', reject);
    call.end();
  });
}

test('pelo socket, o segredo continua sendo exigido', async (t) => {
  const stateFolder = await mkdtemp(path.join(tmpdir(), 'tumacord-executor-'));
  const run = await mkdtemp(path.join(tmpdir(), 'tumacord-run-'));
  const socket = path.join(run, 'executor.sock');
  const executor = createExecutor({ ...settings({} as never), socket, stateDir: stateFolder }, { store: new JobStore(stateFolder) });
  const loaded = await executor.listen();
  t.after(async () => {
    await new Promise((resolve) => executor.server.close(resolve));
    await rm(stateFolder, { recursive: true, force: true });
    await rm(run, { recursive: true, force: true });
  });

  assert.ok(statSync(socket).isSocket());
  // O contêiner conecta com outro uid; a barreira é o segredo, e não a
  // permissão do arquivo.
  assert.equal(statSync(socket).mode & 0o777, 0o666);
  assert.equal((await requestOverSocket(socket, '/v1/jobs')).status, 401);
  assert.equal((await requestOverSocket(socket, '/v1/jobs', loaded.secret)).status, 200);
  assert.equal((await requestOverSocket(socket, '/health')).status, 200);
});

test('o socket não mora no mesmo ramo do segredo', async () => {
  // O diretório do socket é montado dentro do contêiner do chat.
  assert.match(socketPlacementError('/var/lib/tumacord/executor/executor.sock', '/var/lib/tumacord/executor'), /mesmo ramo/);
  assert.match(socketPlacementError('/var/lib/tumacord/executor/run/executor.sock', '/var/lib/tumacord/executor'), /mesmo ramo/);
  // Montar o pai do estado também entrega o estado.
  assert.match(socketPlacementError('/var/lib/tumacord/executor.sock', '/var/lib/tumacord/executor'), /mesmo ramo/);
  assert.match(socketPlacementError('run/executor.sock', '/var/lib/tumacord/executor'), /absoluto/);
  assert.equal(socketPlacementError('/var/lib/tumacord/run/executor.sock', '/var/lib/tumacord/executor'), '');

  // E a recusa vem antes de qualquer arquivo ser criado.
  const stateFolder = await mkdtemp(path.join(tmpdir(), 'tumacord-executor-'));
  try {
    const executor = createExecutor(
      { ...settings({} as never), socket: path.join(stateFolder, 'executor.sock'), stateDir: stateFolder },
      { store: new JobStore(stateFolder) },
    );
    await assert.rejects(() => executor.listen(), /mesmo ramo/);
    assert.equal(existsSync(path.join(stateFolder, 'executor.token')), false, 'o segredo foi gerado antes da recusa');
  } finally {
    await rm(stateFolder, { recursive: true, force: true });
  }
});

test('o executor não apaga, no lugar do socket, o que não é um socket', async (t) => {
  const stateFolder = await mkdtemp(path.join(tmpdir(), 'tumacord-executor-'));
  const run = await mkdtemp(path.join(tmpdir(), 'tumacord-run-'));
  t.after(async () => {
    await rm(stateFolder, { recursive: true, force: true });
    await rm(run, { recursive: true, force: true });
  });
  const socket = path.join(run, 'executor.sock');
  writeFileSync(socket, 'um arquivo de alguém');

  const executor = createExecutor({ ...settings({} as never), socket, stateDir: stateFolder }, { store: new JobStore(stateFolder) });
  await assert.rejects(() => executor.listen(), /não é um socket/);
  assert.equal(statSync(socket).isFile(), true, 'o arquivo continua lá');
});
