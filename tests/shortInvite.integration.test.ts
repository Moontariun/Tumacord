import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeShortInvite, encodeShortInvite } from '../shared/directLink';
import { freePort } from './freePort';

const CHAVE = 'turma-secreta';

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3_000); });
}

// O convite curto só vale se o servidor de verdade emitir e reconhecer. O
// formato é testado em `shortInvite.test.ts`; aqui é o fluxo inteiro.
test('o servidor emite um convite curto que serve de chave de acesso', async (context) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-convite-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      SERVER_ACCESS_KEY: CHAVE, ADMIN_USERNAME: 'Moontariun',
      TLS_CERT_FILE: '', TLS_KEY_FILE: '', TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0',
    },
    stdio: 'ignore',
  });
  context.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);

  const entrar = (body: Record<string, unknown>) => fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const login = await entrar({ username: 'Moontariun', password: 'senha-do-host', allowCreate: true, serverKey: CHAVE });
  assert.equal(login.status, 200);
  const { token: sessao } = await login.json() as { token: string };

  // Emitir exige sessão: convidar é ato de quem já entrou.
  const semSessao = await fetch(`${url}/api/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'call-geral' }),
  });
  assert.equal(semSessao.status, 401, 'quem não entrou não convida');

  const emitido = await fetch(`${url}/api/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessao}` },
    body: JSON.stringify({ callId: 'call-geral', callName: 'Call do grupo' }),
  });
  assert.equal(emitido.status, 200);
  const { token: convite } = await emitido.json() as { token: string };
  assert.equal(convite.length, 12);

  // O código que a pessoa cola.
  const codigo = encodeShortInvite({ server: url, token: convite })!;
  assert.ok(codigo.length < 60, `convite com ${codigo.length} caracteres`);
  assert.deepEqual(decodeShortInvite(codigo)?.token, convite);

  // Consultar diz de que call se trata, sem exigir nada.
  const consulta = await fetch(`${url}/api/invite/${convite}`);
  assert.equal(consulta.status, 200);
  assert.deepEqual(await consulta.json() as Record<string, unknown>, {
    callId: 'call-geral', callName: 'Call do grupo', hostUsername: 'Moontariun',
    expiresAt: (await (await fetch(`${url}/api/invite/${convite}`)).json() as { expiresAt: number }).expiresAt,
  });

  // E o convite vale como chave de acesso: é isso que tira a chave do servidor
  // de dentro do código.
  const semNada = await entrar({ username: 'Convidado', password: 'senha-do-convidado', allowCreate: true });
  assert.equal(semNada.status, 403, 'sem chave nenhuma não entra');

  const comConvite = await entrar({ username: 'Convidado', password: 'senha-do-convidado', allowCreate: true, serverKey: convite });
  assert.equal(comConvite.status, 200, 'o convite abre a porta que a chave do servidor abriria');

  const inventado = await entrar({ username: 'Intruso', password: 'senha-do-intruso', allowCreate: true, serverKey: 'ZZZZZZZZZZZZ' });
  assert.equal(inventado.status, 403, 'um código inventado não vale');
  assert.equal((await fetch(`${url}/api/invite/ZZZZZZZZZZZZ`)).status, 404);
});
