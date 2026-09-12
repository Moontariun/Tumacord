import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { freePort } from './freePort';

// A identidade P2P contra um host de verdade, com dispositivos de verdade.
//
// O defeito que isto fecha: na troca de host, a conta nascia no servidor novo
// com a senha de quem chegasse primeiro. Aqui um segundo dispositivo tenta o
// nome de outro — com a senha certa, inclusive — e não entra.

const require = createRequire(import.meta.url);
const { IdentityKey } = require('../desktop/identity-key.cjs');

const INVITE_KEY = 'chave-do-convite-do-grupo-de-teste-0123456789';

type Device = InstanceType<typeof IdentityKey>;
type Reply = { status: number; body: Record<string, unknown> };

function keyring() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`cifrado:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cifrado:'.length),
  };
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`O host encerrou antes do teste (${child.exitCode}).`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Ainda subindo.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('O host não subiu a tempo.');
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function startGroupHost(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-identidade-p2p-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      SERVER_ACCESS_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
      TUMACORD_P2P_MODE: '1', TUMACORD_SERVE_WEB: '0', TUMACORD_DIRECT_KEY: INVITE_KEY,
    },
    stdio: 'ignore',
  });
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child);
  return { url, sockets };
}

async function newDevice(t: { after: (fn: () => unknown) => void }): Promise<Device> {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-dispositivo-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const device = new IdentityKey({ userDataPath: folder, safeStorage: keyring() });
  device.load();
  return device;
}

async function post(url: string, route: string, body: unknown): Promise<Reply> {
  const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** O que o aplicativo novo faz: desafio, prova, e o claim só quando o nome está livre. */
async function loginAs(url: string, device: Device, username: string, password: string, inviteKey = INVITE_KEY): Promise<Reply> {
  const challenge = await post(url, '/api/auth/challenge', { username, serverKey: inviteKey });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  const proof = device.proveLogin({ inviteKey, name: username, nonce: challenge.body.nonce });
  const claim = challenge.body.nameState === 'free'
    ? device.claim({ inviteKey, name: username, displayName: username, legacy: challenge.body.accountExists === true })
    : undefined;
  return post(url, '/api/auth/login', { username, password, allowCreate: true, serverKey: inviteKey, identity: claim ? { proof, claim } : { proof } });
}

/** O que um aplicativo anterior a esta versão faz: só nome e senha. */
function legacyLogin(url: string, username: string, password: string): Promise<Reply> {
  return post(url, '/api/auth/login', { username, password, allowCreate: true, serverKey: INVITE_KEY });
}

async function connect(url: string, token: string, sockets: Socket[]): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(socket);
  if (!socket.connected) await once(socket, 'connect');
  return socket;
}

test('o primeiro dispositivo fica com o nome, e outro não entra com ele nem sabendo a senha', { timeout: 30_000 }, async (t) => {
  const { url } = await startGroupHost(t);
  const alice = await newDevice(t);
  const intruder = await newDevice(t);

  const first = await loginAs(url, alice, 'Alice', 'senha-da-alice');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.identity, 'bound');

  const stolen = await loginAs(url, intruder, 'Alice', 'senha-da-alice');
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.identityRefusal, 'claimed-by-other');

  // Acento e caixa não mudam de quem o nome é.
  assert.equal((await loginAs(url, intruder, 'ALICE', 'outra-senha')).status, 409);
  assert.equal((await loginAs(url, alice, 'alice', 'senha-da-alice')).status, 200);

  const health = await (await fetch(`${url}/api/health`)).json() as { capabilities: Record<string, boolean> };
  assert.equal(health.capabilities.identityClaims, true);
});

test('um aplicativo antigo segue entrando com nome livre, e é recusado no nome reivindicado', { timeout: 30_000 }, async (t) => {
  const { url } = await startGroupHost(t);
  const alice = await newDevice(t);
  assert.equal((await loginAs(url, alice, 'Alice', 'senha-da-alice')).status, 200);

  assert.equal((await legacyLogin(url, 'Carol', 'senha-da-carol')).status, 200, 'nome livre continua funcionando sem prova');

  const refused = await legacyLogin(url, 'Alice', 'senha-da-alice');
  assert.equal(refused.status, 426);
  assert.equal(refused.body.identityRefusal, 'proof-required');
  assert.match(String(refused.body.error), /Atualize/);
});

test('o desafio vale uma vez, e só para o nome em que nasceu', { timeout: 30_000 }, async (t) => {
  const { url } = await startGroupHost(t);
  const alice = await newDevice(t);

  const challenge = await post(url, '/api/auth/challenge', { username: 'Alice', serverKey: INVITE_KEY });
  const proof = alice.proveLogin({ inviteKey: INVITE_KEY, name: 'Alice', nonce: challenge.body.nonce });
  const claim = alice.claim({ inviteKey: INVITE_KEY, name: 'Alice' });
  const body = { username: 'Alice', password: 'senha-da-alice', allowCreate: true, serverKey: INVITE_KEY, identity: { proof, claim } };
  assert.equal((await post(url, '/api/auth/login', body)).status, 200);

  const replay = await post(url, '/api/auth/login', body);
  assert.equal(replay.status, 401, 'a mesma prova entrou duas vezes');
  assert.equal(replay.body.identityRefusal, 'bad-proof');

  const forBob = await post(url, '/api/auth/challenge', { username: 'Bob', serverKey: INVITE_KEY });
  const wrongName = alice.proveLogin({ inviteKey: INVITE_KEY, name: 'Alice', nonce: forBob.body.nonce });
  assert.equal((await post(url, '/api/auth/login', { username: 'Alice', password: 'senha-da-alice', serverKey: INVITE_KEY, identity: { proof: wrongName } })).status, 401);
});

test('uma conta criada aqui antes do claim chegar não tranca o dono do nome para fora', { timeout: 30_000 }, async (t) => {
  const { url, sockets } = await startGroupHost(t);
  const dave = await newDevice(t);

  // Alguém chega a este host primeiro, com um aplicativo que não prova nada.
  const squatter = await legacyLogin(url, 'Dave', 'senha-de-quem-chegou-antes');
  assert.equal(squatter.status, 200);

  // O claim do Dave de verdade chega pela sincronização, vindo de outro host.
  const socket = await connect(url, String(squatter.body.token), sockets);
  const pushed = await socket.timeout(5_000).emitWithAck('identity:push', { claims: [dave.claim({ inviteKey: INVITE_KEY, name: 'Dave' })] });
  assert.equal(pushed.added, 1);

  const owner = await loginAs(url, dave, 'Dave', 'senha-do-dave');
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.identity, 'bound');
  assert.equal((await legacyLogin(url, 'Dave', 'senha-de-quem-chegou-antes')).status, 426);
});

test('numa disputa entra quem este host viu primeiro, provisório, até alguém liberar', { timeout: 30_000 }, async (t) => {
  const { url, sockets } = await startGroupHost(t);
  const erinHere = await newDevice(t);
  const erinElsewhere = await newDevice(t);

  const first = await loginAs(url, erinHere, 'Erin', 'senha-daqui');
  assert.equal(first.status, 200);
  const socket = await connect(url, String(first.body.token), sockets);

  // O grupo esteve dividido: o outro dispositivo reivindicou o mesmo nome lá.
  const merged = await socket.timeout(5_000).emitWithAck('identity:push', { claims: [erinElsewhere.claim({ inviteKey: INVITE_KEY, name: 'Erin' })] });
  assert.equal(merged.added, 1);

  const contender = await loginAs(url, erinElsewhere, 'Erin', 'senha-de-la');
  assert.equal(contender.status, 409);
  assert.equal(contender.body.identityRefusal, 'contested');

  const holder = await loginAs(url, erinHere, 'Erin', 'senha-daqui');
  assert.equal(holder.status, 200);
  assert.equal(holder.body.identity, 'provisional', 'a disputa não pode ser resolvida em silêncio');

  // A reconciliação é explícita: quem estava aqui libera o nome.
  const released = await socket.timeout(5_000).emitWithAck('identity:push', { releases: [erinHere.release({ inviteKey: INVITE_KEY, name: 'Erin' })] });
  assert.equal(released.released, 1);

  const resolved = await loginAs(url, erinElsewhere, 'Erin', 'senha-de-la');
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.identity, 'bound');
});

test('o que é de outro grupo não entra, e o registro sai em páginas pelo socket e pela rota local', { timeout: 30_000 }, async (t) => {
  const { url, sockets } = await startGroupHost(t);
  const frank = await newDevice(t);
  const login = await loginAs(url, frank, 'Frank', 'senha-do-frank');
  const socket = await connect(url, String(login.body.token), sockets);

  const foreign = await socket.timeout(5_000).emitWithAck('identity:push', { claims: [frank.claim({ inviteKey: 'chave-de-outro-grupo-qualquer', name: 'Frank' })] });
  assert.equal(foreign.added, 0);
  assert.equal(foreign.rejected, 1);

  const page = await socket.timeout(5_000).emitWithAck('identity:records', { after: 0 });
  assert.equal(page.ok, true);
  assert.deepEqual(page.claims.map((claim: { name: string }) => claim.name), ['frank']);
  assert.equal(page.next, 0);

  const local = await (await fetch(`${url}/api/local/identity?after=0`)).json() as { claims: Array<{ name: string }> };
  assert.deepEqual(local.claims.map((claim) => claim.name), ['frank']);
});
