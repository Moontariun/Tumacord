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
