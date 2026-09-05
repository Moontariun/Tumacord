import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do teste (${child.exitCode}).`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Ainda subindo.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Servidor não iniciou a tempo.');
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function proofFor(key: string, nonce: string): string {
  return createHmac('sha256', key).update(nonce, 'utf8').digest('base64url');
}

const DIRECT_KEY = 'chave-de-convite-para-o-teste-de-integracao';

test('o host prova a própria identidade e adota a chave da call', { timeout: 25_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-direct-'));
  const port = 31_000 + Math.floor(Math.random() * 9_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '1',
      TUMACORD_SERVE_WEB: '0',
      TUMACORD_DIRECT_KEY: DIRECT_KEY,
      SERVER_ACCESS_KEY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  context.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);

  const nonce = 'nonce-de-teste-1';
  const hello = await (await fetch(`${url}/api/direct/hello?nonce=${nonce}`)).json() as { ok: boolean; requiresKey: boolean; proofs: string[]; mode: string };
  assert.equal(hello.ok, true);
  assert.equal(hello.mode, 'p2p');
  assert.equal(hello.requiresKey, true);
  assert.deepEqual(hello.proofs, [proofFor(DIRECT_KEY, nonce)], 'a prova precisa bater com o HMAC da chave do convite');

  const withoutNonce = await (await fetch(`${url}/api/direct/hello`)).json() as { proofs: string[] };
  assert.deepEqual(withoutNonce.proofs, [], 'sem nonce não há o que provar, e nada é revelado');

  // A chave é da call, não da máquina: quem entra pelo convite de outra pessoa
  // passa a aceitar aquele código aqui também, senão a troca de host deixaria
  // o convite que já circulou sem valor.
  const adopted = 'outra-chave-de-call-com-tamanho-suficiente';
  const adoption = await fetch(`${url}/api/direct/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: adopted }) });
  assert.equal(adoption.status, 200);
  assert.equal((await adoption.json() as { accepted: number }).accepted, 2);

  const afterAdoption = await (await fetch(`${url}/api/direct/hello?nonce=${nonce}`)).json() as { proofs: string[] };
  assert.deepEqual(afterAdoption.proofs.sort(), [proofFor(DIRECT_KEY, nonce), proofFor(adopted, nonce)].sort());

  const repeated = await fetch(`${url}/api/direct/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: adopted }) });
  assert.equal((await repeated.json() as { accepted: number }).accepted, 2, 'adotar a mesma chave duas vezes não duplica nada');

  const rejected = await fetch(`${url}/api/direct/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'curta' }) });
  assert.equal(rejected.status, 400);

  // Endereço da própria máquina continua entrando sem apresentar convite: é o
  // mesmo nível de confiança da descoberta por broadcast na rede local.
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Vizinho', password: 'senha-local', allowCreate: true }),
  });
  assert.equal(login.status, 200, 'a rede local não pode passar a exigir código de convite');
  const session = await login.json() as { token: string };
  const attachment = await fetch(`${url}/api/attachments/00000000-0000-4000-8000-000000000000`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(attachment.status, 404, 'a sessão atravessa a proteção do enlace direto; o arquivo é que não existe');
});

test('sem chave de enlace direto o servidor não passa a exigir convite de ninguém', { timeout: 25_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-direct-open-'));
  const port = 31_000 + Math.floor(Math.random() * 9_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '1',
      TUMACORD_SERVE_WEB: '0',
      TUMACORD_DIRECT_KEY: '',
      SERVER_ACCESS_KEY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  context.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);

  const hello = await (await fetch(`${url}/api/direct/hello?nonce=x`)).json() as { requiresKey: boolean; proofs: string[] };
  assert.deepEqual({ requiresKey: hello.requiresKey, proofs: hello.proofs }, { requiresKey: false, proofs: [] });
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Sem Chave', password: 'senha-local', allowCreate: true }),
  });
  assert.equal(login.status, 200);
});

test('a porta em `::` atende IPv4 e IPv6 na mesma escuta', { timeout: 25_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-direct-dual-'));
  const port = 31_000 + Math.floor(Math.random() * 9_000);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '::',
      PORT: String(port),
      DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '1',
      TUMACORD_SERVE_WEB: '0',
      TUMACORD_DIRECT_KEY: DIRECT_KEY,
      SERVER_ACCESS_KEY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  context.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  // Escutar em `::` é o que abre a entrada por IPv6 sem ZeroTier; a checagem
  // por IPv4 confirma que isso não custou a compatibilidade de sempre.
  await waitForServer(`http://127.0.0.1:${port}`, child);
  const overIpv6 = await fetch(`http://[::1]:${port}/api/health`);
  assert.equal(overIpv6.ok, true);
  assert.equal((await overIpv6.json() as { mode: string }).mode, 'p2p');
});


test('o servidor entrega credenciais de TURN temporárias, e só a quem tem sessão', { timeout: 25_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-turn-'));
  const port = 31_000 + Math.floor(Math.random() * 9_000);
  const url = `http://127.0.0.1:${port}`;
  const secret = 'segredo-do-coturn-para-o-teste';
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '0',
      TUMACORD_SERVE_WEB: '0',
      TUMACORD_DIRECT_KEY: '',
      SERVER_ACCESS_KEY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
      TURN_URLS: 'turn:relay.exemplo:3478,turns:relay.exemplo:5349',
      TURN_SECRET: secret,
      TURN_TTL_SECONDS: '3600',
    },
    stdio: 'ignore',
  });
  context.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);

  const health = await (await fetch(`${url}/api/health`)).json() as { turn: boolean };
  assert.equal(health.turn, true, 'a saúde precisa dizer que existe relay, para o diagnóstico não mentir');

  const semSessao = await fetch(`${url}/api/turn`);
  assert.equal(semSessao.status, 401, 'um relay aberto seria usado por qualquer um que passasse na frente');

  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Renan', password: 'senha-local', allowCreate: true }),
  });
  const session = await login.json() as { token: string };
  const resposta = await fetch(`${url}/api/turn`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json() as { iceServers: Array<{ urls: string[]; username: string; credential: string }>; expiresAt: number };
  assert.equal(corpo.iceServers.length, 1);
  assert.deepEqual(corpo.iceServers[0].urls, ['turn:relay.exemplo:3478', 'turns:relay.exemplo:5349']);

  // A credencial precisa ser exatamente o que o coturn vai recalcular do outro
  // lado, senão o relay recusa a alocação e a call cai sem explicação.
  const [validade] = corpo.iceServers[0].username.split(':');
  assert.equal(corpo.iceServers[0].credential, createHmac('sha1', secret).update(corpo.iceServers[0].username, 'utf8').digest('base64'));
  assert.ok(Number(validade) * 1000 > Date.now(), 'a credencial não pode nascer vencida');
  assert.ok(Number(validade) * 1000 <= Date.now() + 3_600_000 + 5_000);
  assert.equal(corpo.expiresAt, Number(validade) * 1000);
});

test('sem TURN configurado o servidor responde uma lista vazia, sem inventar relay', { timeout: 25_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-noturn-'));
  const port = 31_000 + Math.floor(Math.random() * 9_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '1',
      TUMACORD_SERVE_WEB: '0',
      TUMACORD_DIRECT_KEY: '',
      SERVER_ACCESS_KEY: '',
      TLS_CERT_FILE: '',
      TLS_KEY_FILE: '',
      TURN_URLS: '',
      TURN_SECRET: '',
    },
    stdio: 'ignore',
  });
  context.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);
  assert.equal((await (await fetch(`${url}/api/health`)).json() as { turn: boolean }).turn, false);
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Renan', password: 'senha-local', allowCreate: true }),
  });
  const session = await login.json() as { token: string };
  const corpo = await (await fetch(`${url}/api/turn`, { headers: { authorization: `Bearer ${session.token}` } })).json() as { iceServers: unknown[] };
  assert.deepEqual(corpo.iceServers, []);
});
