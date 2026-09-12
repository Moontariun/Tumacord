import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONTRACT_VERSION, type Artifact, type Catalog, type ReleaseManifest, type TrustedKey } from '../shared/distribution';
import { documentDigest, generateSigningKey, signDocument } from '../shared/distributionCrypto';

// O `Updater` do aplicativo, falando com o serviço privado de verdade.
//
// Este é o teste da **ligação**: os casos de `updateSource.integration` provam
// que os módulos do cliente funcionam; aqui se prova que o updater — o que o
// processo principal do Electron realmente usa — passou a chamá-los, e que
// nenhum caminho dele vai ao GitHub.

const require_ = createRequire(import.meta.url);
const { Updater } = require_('../desktop/updater.cjs') as {
  Updater: new (options: Record<string, unknown>) => {
    state: () => Record<string, any>;
    check: (options?: { manual?: boolean }) => Promise<Record<string, any>>;
    download: () => Promise<Record<string, any>>;
    enroll: (invite: string, label?: string) => Promise<Record<string, any>>;
    cancel: () => Record<string, any>;
    preferences: Record<string, any>;
  };
};

const manifestKey = generateSigningKey();
const catalogKey = generateSigningKey();
const trustedKeys: TrustedKey[] = [
  { ...manifestKey, scope: ['manifest'] },
  { ...catalogKey, scope: ['catalog'] },
];

const PACKAGE_BYTES = Buffer.alloc(512 * 1024, 9);
const DIGEST = createHash('sha256').update(PACKAGE_BYTES).digest('hex');

const artifact = (): Artifact => ({
  artifactId: 'linux-x64-tar', os: 'linux', arch: 'x64', format: 'tar.gz', installKind: 'linux-managed',
  fileName: 'tumacord-0.9.10.tar.gz', size: PACKAGE_BYTES.length, sha256: DIGEST,
  signatureKeyId: manifestKey.keyId, storagePath: 'releases/0.9.10/tumacord-0.9.10.tar.gz',
});

const manifest = (): ReleaseManifest => ({
  contract: CONTRACT_VERSION, releaseId: 'rel-0910', version: '0.9.10', channel: 'stable',
  commit: 'a'.repeat(40), createdAt: '2026-09-20T10:00:00.000Z',
  title: 'Tumacord 0.9.10 — a próxima', notes: 'Uma coisa mudou.',
  artifacts: [artifact()],
});

const catalog = (sequence = 5): Catalog => ({
  contract: CONTRACT_VERSION, sequence,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  channels: {
    stable: { entries: [{ releaseId: 'rel-0910', version: '0.9.10', state: 'published', publishedAt: '2026-09-20T10:00:00.000Z', manifestSha256: documentDigest(manifest()) }] },
    test: { entries: [] },
  },
});

function listening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

interface Environment {
  origin: string;
  adminUrl: string;
  userDataPath: string;
  newUpdater: (extra?: Record<string, unknown>) => InstanceType<typeof Updater>;
  close: () => Promise<void>;
}

async function start(): Promise<Environment> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'tumacord-updater-'));
  const stateDir = path.join(rootDir, 'estado');
  const packagesDir = path.join(rootDir, 'pacotes');
  const userDataPath = path.join(rootDir, 'userData');
  await mkdir(path.join(packagesDir, 'releases', '0.9.10'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(path.join(packagesDir, 'releases', '0.9.10', 'tumacord-0.9.10.tar.gz'), PACKAGE_BYTES);

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = stateDir;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = packagesDir;

  const serviceModule = await import(`../services/updates/src/index.js?u=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await serviceModule.store.load();
  const servers: Server[] = [serviceModule.app.listen(0, '127.0.0.1'), serviceModule.admin.listen(0, '127.0.0.1')];
  await Promise.all(servers.map((serviceServer) => listening(serviceServer)));

  const origin = `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(servers[1].address() as AddressInfo).port}`;
  const json = { 'content-type': 'application/json' };
  await fetch(`${adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify({ keys: trustedKeys }) });
  await fetch(`${adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(manifest(), [manifestKey])) });
  await fetch(`${adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(catalog(), [catalogKey])) });

  // A origem e as chaves confiáveis são configuração **do aplicativo**: elas
  // vêm do arquivo local que só quem tem a máquina escreve, e nunca de uma
  // resposta da rede.
  await writeFile(path.join(userDataPath, 'update-origin.json'), JSON.stringify({ origin, trustedKeys }, null, 2));

  const newUpdater = (extra: Record<string, unknown> = {}) => new Updater({
    app: { getVersion: () => '0.9.9-1', getPath: () => userDataPath },
    env: {}, platform: 'linux', kind: 'linux-managed', userDataPath,
    // Um chaveiro fingido, porque o de verdade é do Electron. O caminho sem
    // chaveiro tem o próprio caso, mais abaixo.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8'),
    },
    ...extra,
  });

  return {
    origin, adminUrl, userDataPath, newUpdater: newUpdater,
    close: async () => {
      await Promise.all(servers.map((serviceServer) => new Promise<void>((resolve) => serviceServer.close(() => resolve()))));
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function inviteDevice(adminUrl: string, label = 'máquina de teste'): Promise<string> {
  const reply = await fetch(`${adminUrl}/admin/invites`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }),
  });
  return ((await reply.json()) as { invite: string }).invite;
}

// ── O caminho inteiro, pelo updater ────────────────────────────────────────

test('o updater procura, acha e baixa pelo serviço privado', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  const updater = environment.newUpdater();

  // Sem credencial, a procura não acontece — e a tela diz o que fazer.
  const withoutCredential = await updater.check({ manual: true });
  assert.equal(withoutCredential.phase, 'needs-enrollment');
  assert.equal(withoutCredential.needsEnrollment, true);
  assert.match(withoutCredential.enrollmentMessage, /convite/);

  // O convite vem por canal privado e vale uma vez.
  const enrolled = await updater.enroll(await inviteDevice(environment.adminUrl), 'Linux do teste');
  assert.equal(enrolled.phase, 'available', JSON.stringify({ error: enrolled.error, phase: enrolled.phase }));
  assert.equal(enrolled.version, '0.9.10');
  assert.equal(enrolled.title, 'Tumacord 0.9.10 — a próxima');
  assert.equal(enrolled.asset?.name, 'tumacord-0.9.10.tar.gz');
  assert.equal(enrolled.asset?.releaseId, 'rel-0910');
  // Numa distribuição privada não há página pública.
  assert.equal(enrolled.pageUrl, '');

  const downloaded = await updater.download();
  assert.equal(downloaded.phase, 'ready', downloaded.error);
  assert.equal(downloaded.sha256, DIGEST);
  assert.deepEqual(await readFile(downloaded.file), PACKAGE_BYTES);
});

test('a sequência do catálogo é guardada, e um catálogo anterior é recusado', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  const updater = environment.newUpdater();
  await updater.enroll(await inviteDevice(environment.adminUrl));

  assert.equal(updater.preferences.catalogSequence, 5, 'a maior sequência aceita fica guardada');

  // Um updater novo, na mesma máquina, já nasce sabendo até onde chegou — e um
  // serviço que voltasse no tempo não consegue reoferecer o que foi deixado
  // para trás.
  const other = environment.newUpdater();
  assert.equal(other.preferences.catalogSequence, 5);
});

test('uma versão retirada para de ser oferecida, e o motivo aparece', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  const updater = environment.newUpdater();
  await updater.enroll(await inviteDevice(environment.adminUrl));

  const withdrawn: Catalog = {
    ...catalog(6),
    channels: {
      stable: { entries: [{ ...catalog().channels.stable.entries[0], state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado no Windows', at: new Date().toISOString() } }] },
      test: { entries: [] },
    },
  };
  await fetch(`${environment.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(withdrawn, [catalogKey])),
  });

  const after = await updater.check({ manual: true });
  assert.equal(after.phase, 'up-to-date');
  assert.equal(after.version, '');
  // A versão pulada continua sendo dita: silêncio faria a pessoa concluir que
  // o aplicativo parou de ver o que o painel mostra.
  assert.deepEqual(after.skipped, [{ version: '0.9.10', reason: 'o áudio sai errado no Windows' }]);
});

test('uma credencial revogada some do disco e a tela pede um convite novo', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  const updater = environment.newUpdater();
  await updater.enroll(await inviteDevice(environment.adminUrl));

  const list = await (await fetch(`${environment.adminUrl}/admin/devices`)).json() as { devices: { deviceId: string }[] };
  await fetch(`${environment.adminUrl}/admin/devices/${list.devices[0].deviceId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'máquina perdida' }),
  });

  const after = await updater.check({ manual: true });
  assert.equal(after.phase, 'needs-enrollment');
  assert.match(after.enrollmentMessage, /revogado/);
  // A credencial local sai: insistir a cada abertura só gastaria pedido, e ela
  // não volta sozinha.
  await assert.rejects(() => readFile(path.join(environment.userDataPath, 'update-device.json')));
});

test('um convite inventado não inscreve, e a mensagem é útil', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  const updater = environment.newUpdater();
  const outcome = await updater.enroll('z'.repeat(64), 'intruso');
  assert.equal(outcome.phase, 'needs-enrollment');
  assert.match(outcome.enrollmentMessage, /não é reconhecido/);
});

test('sem chaveiro, a inscrição vale para a sessão e isso é dito', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  // Uma sessão Linux sem gerenciador de segredos é o caso comum. Guardar o
  // token em claro seria a escolha errada: o arquivo de configuração é lido
  // por qualquer coisa que rode como aquele usuário.
  const updater = environment.newUpdater({ safeStorage: { isEncryptionAvailable: () => false } });
  const outcome = await updater.enroll(await inviteDevice(environment.adminUrl));
  assert.match(outcome.enrollmentMessage, /não foi gravada|convite novo/);
  await assert.rejects(() => readFile(path.join(environment.userDataPath, 'update-device.json')));
});

test('sem origem configurada, o updater diz isso em vez de tentar um endereço', { timeout: 30_000 }, async (context) => {
  const environment = await start();
  context.after(() => environment.close());
  await rm(path.join(environment.userDataPath, 'update-origin.json'), { force: true });
  const updater = environment.newUpdater();
  const outcome = await updater.check({ manual: true });
  assert.equal(outcome.phase, 'no-origin');
  assert.match(outcome.error, /origem de atualizações/);
});

// ── E nada disso passa pelo GitHub ─────────────────────────────────────────

test('nenhum arquivo do caminho de atualização aponta para o GitHub', async () => {
  const { readFileSync } = await import('node:fs');
  const rootDir = new URL('..', import.meta.url);
  for (const file of ['desktop/updater.cjs', 'desktop/update-check.cjs', 'desktop/update-source.cjs', 'desktop/update-origin.cjs']) {
    const text = readFileSync(new URL(file, rootDir), 'utf8');
    // Citar o GitHub num comentário, explicando que ele saiu, é documentação.
    // O que não pode é um endereço dele no código que roda.
    const lines = text.split('\n').filter((line) => {
      const clean = line.trim();
      return !clean.startsWith('//') && !clean.startsWith('*') && !clean.startsWith('/*');
    });
    assert.equal(
      lines.join('\n').includes('api.github.com'),
      false,
      `${file} ainda tem api.github.com em código que roda`,
    );
    assert.equal(lines.join('\n').includes('githubusercontent'), false, `${file} ainda aponta para o armazenamento do GitHub`);
  }
});
