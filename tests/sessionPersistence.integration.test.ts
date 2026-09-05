import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { freePort } from './freePort';

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do teste (${child.exitCode}).`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // O bundle TypeScript e o arquivo local ainda estão iniciando.
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

function openSocket(url: string, token: string): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Tempo esgotado abrindo socket autenticado.'));
    }, 3_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
}

test('login persistente sobrevive ao reinício do servidor dedicado', { timeout: 20_000 }, async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'tumacord-session-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const startServer = async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDirectory, SERVER_NAME: 'Tumacord Session QA' },
      stdio: 'ignore',
    });
    await waitForServer(url, child);
    return child;
  };
  context.after(async () => {
    if (child) await stopServer(child);
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const firstServer = await startServer();
  const registration = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Persistent QA', password: 'qa-persistent-password' }),
  });
  assert.equal(registration.status, 201);
  const { token } = await registration.json() as { token: string };
  const beforeRestart = await openSocket(url, token);
  beforeRestart.disconnect();

  await stopServer(firstServer);
  const secondServer = await startServer();
  const afterRestart = await openSocket(url, token);
  assert.equal(afterRestart.connected, true, 'o mesmo token deve autenticar depois do restart');
  afterRestart.disconnect();
  await stopServer(secondServer);
  child = undefined;
});
