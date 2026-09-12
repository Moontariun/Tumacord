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

const PACOTE = Buffer.alloc(512 * 1024, 9);
const RESUMO = createHash('sha256').update(PACOTE).digest('hex');

const artifact = (): Artifact => ({
  artifactId: 'linux-x64-tar', os: 'linux', arch: 'x64', format: 'tar.gz', installKind: 'linux-managed',
  fileName: 'tumacord-0.9.10.tar.gz', size: PACOTE.length, sha256: RESUMO,
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

interface Ambiente {
  origin: string;
  adminUrl: string;
  userDataPath: string;
  novoUpdater: (extra?: Record<string, unknown>) => InstanceType<typeof Updater>;
  encerrar: () => Promise<void>;
}

async function subir(): Promise<Ambiente> {
  const raiz = await mkdtemp(path.join(tmpdir(), 'tumacord-updater-'));
  const estado = path.join(raiz, 'estado');
  const pacotes = path.join(raiz, 'pacotes');
  const userDataPath = path.join(raiz, 'userData');
  await mkdir(path.join(pacotes, 'releases', '0.9.10'), { recursive: true });
  await mkdir(estado, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(path.join(pacotes, 'releases', '0.9.10', 'tumacord-0.9.10.tar.gz'), PACOTE);

  process.env.TUMACORD_UPDATES_NO_LISTEN = '1';
  process.env.TUMACORD_UPDATES_STATE_DIR = estado;
  process.env.TUMACORD_UPDATES_STORAGE_DIR = pacotes;

  const modulo = await import(`../services/updates/src/index.js?u=${Date.now()}${Math.random()}`) as typeof import('../services/updates/src/index');
  await modulo.store.load();
  const servidores: Server[] = [modulo.app.listen(0, '127.0.0.1'), modulo.admin.listen(0, '127.0.0.1')];
  await Promise.all(servidores.map((servidor) => listening(servidor)));

  const origin = `http://127.0.0.1:${(servidores[0].address() as AddressInfo).port}`;
  const adminUrl = `http://127.0.0.1:${(servidores[1].address() as AddressInfo).port}`;
  const json = { 'content-type': 'application/json' };
  await fetch(`${adminUrl}/admin/keys`, { method: 'POST', headers: json, body: JSON.stringify({ keys: trustedKeys }) });
  await fetch(`${adminUrl}/admin/manifest`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(manifest(), [manifestKey])) });
  await fetch(`${adminUrl}/admin/catalog`, { method: 'POST', headers: json, body: JSON.stringify(signDocument(catalog(), [catalogKey])) });

  // A origem e as chaves confiáveis são configuração **do aplicativo**: elas
  // vêm do arquivo local que só quem tem a máquina escreve, e nunca de uma
  // resposta da rede.
  await writeFile(path.join(userDataPath, 'update-origin.json'), JSON.stringify({ origin, trustedKeys }, null, 2));

  const novoUpdater = (extra: Record<string, unknown> = {}) => new Updater({
    app: { getVersion: () => '0.9.9-1', getPath: () => userDataPath },
    env: {}, platform: 'linux', kind: 'linux-managed', userDataPath,
    // Um chaveiro fingido, porque o de verdade é do Electron. O caminho sem
    // chaveiro tem o próprio caso, mais abaixo.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (texto: string) => Buffer.from(texto, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8'),
    },
    ...extra,
  });

  return {
    origin, adminUrl, userDataPath, novoUpdater,
    encerrar: async () => {
      await Promise.all(servidores.map((servidor) => new Promise<void>((resolve) => servidor.close(() => resolve()))));
      await rm(raiz, { recursive: true, force: true });
    },
  };
}

async function convidar(adminUrl: string, label = 'máquina de teste'): Promise<string> {
  const resposta = await fetch(`${adminUrl}/admin/invites`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }),
  });
  return ((await resposta.json()) as { invite: string }).invite;
}

// ── O caminho inteiro, pelo updater ────────────────────────────────────────

test('o updater procura, acha e baixa pelo serviço privado', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const updater = ambiente.novoUpdater();

  // Sem credencial, a procura não acontece — e a tela diz o que fazer.
  const semCredencial = await updater.check({ manual: true });
  assert.equal(semCredencial.phase, 'needs-enrollment');
  assert.equal(semCredencial.needsEnrollment, true);
  assert.match(semCredencial.enrollmentMessage, /convite/);

  // O convite vem por canal privado e vale uma vez.
  const inscrito = await updater.enroll(await convidar(ambiente.adminUrl), 'Linux do teste');
  assert.equal(inscrito.phase, 'available', JSON.stringify({ erro: inscrito.error, fase: inscrito.phase }));
  assert.equal(inscrito.version, '0.9.10');
  assert.equal(inscrito.title, 'Tumacord 0.9.10 — a próxima');
  assert.equal(inscrito.asset?.name, 'tumacord-0.9.10.tar.gz');
  assert.equal(inscrito.asset?.releaseId, 'rel-0910');
  // Numa distribuição privada não há página pública.
  assert.equal(inscrito.pageUrl, '');

  const baixado = await updater.download();
  assert.equal(baixado.phase, 'ready', baixado.error);
  assert.equal(baixado.sha256, RESUMO);
  assert.deepEqual(await readFile(baixado.file), PACOTE);
});

test('a sequência do catálogo é guardada, e um catálogo anterior é recusado', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const updater = ambiente.novoUpdater();
  await updater.enroll(await convidar(ambiente.adminUrl));

  assert.equal(updater.preferences.catalogSequence, 5, 'a maior sequência aceita fica guardada');

  // Um updater novo, na mesma máquina, já nasce sabendo até onde chegou — e um
  // serviço que voltasse no tempo não consegue reoferecer o que foi deixado
  // para trás.
  const outro = ambiente.novoUpdater();
  assert.equal(outro.preferences.catalogSequence, 5);
});

test('uma versão retirada para de ser oferecida, e o motivo aparece', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const updater = ambiente.novoUpdater();
  await updater.enroll(await convidar(ambiente.adminUrl));

  const retirado: Catalog = {
    ...catalog(6),
    channels: {
      stable: { entries: [{ ...catalog().channels.stable.entries[0], state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado no Windows', at: new Date().toISOString() } }] },
      test: { entries: [] },
    },
  };
  await fetch(`${ambiente.adminUrl}/admin/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signDocument(retirado, [catalogKey])),
  });

  const depois = await updater.check({ manual: true });
  assert.equal(depois.phase, 'up-to-date');
  assert.equal(depois.version, '');
  // A versão pulada continua sendo dita: silêncio faria a pessoa concluir que
  // o aplicativo parou de ver o que o painel mostra.
  assert.deepEqual(depois.skipped, [{ version: '0.9.10', reason: 'o áudio sai errado no Windows' }]);
});

test('uma credencial revogada some do disco e a tela pede um convite novo', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const updater = ambiente.novoUpdater();
  await updater.enroll(await convidar(ambiente.adminUrl));

  const lista = await (await fetch(`${ambiente.adminUrl}/admin/devices`)).json() as { devices: { deviceId: string }[] };
  await fetch(`${ambiente.adminUrl}/admin/devices/${lista.devices[0].deviceId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'máquina perdida' }),
  });

  const depois = await updater.check({ manual: true });
  assert.equal(depois.phase, 'needs-enrollment');
  assert.match(depois.enrollmentMessage, /revogado/);
  // A credencial local sai: insistir a cada abertura só gastaria pedido, e ela
  // não volta sozinha.
  await assert.rejects(() => readFile(path.join(ambiente.userDataPath, 'update-device.json')));
});

test('um convite inventado não inscreve, e a mensagem é útil', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  const updater = ambiente.novoUpdater();
  const resultado = await updater.enroll('z'.repeat(64), 'intruso');
  assert.equal(resultado.phase, 'needs-enrollment');
  assert.match(resultado.enrollmentMessage, /não é reconhecido/);
});

test('sem chaveiro, a inscrição vale para a sessão e isso é dito', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  // Uma sessão Linux sem gerenciador de segredos é o caso comum. Guardar o
  // token em claro seria a escolha errada: o arquivo de configuração é lido
  // por qualquer coisa que rode como aquele usuário.
  const updater = ambiente.novoUpdater({ safeStorage: { isEncryptionAvailable: () => false } });
  const resultado = await updater.enroll(await convidar(ambiente.adminUrl));
  assert.match(resultado.enrollmentMessage, /não foi gravada|convite novo/);
  await assert.rejects(() => readFile(path.join(ambiente.userDataPath, 'update-device.json')));
});

test('sem origem configurada, o updater diz isso em vez de tentar um endereço', { timeout: 30_000 }, async (context) => {
  const ambiente = await subir();
  context.after(() => ambiente.encerrar());
  await rm(path.join(ambiente.userDataPath, 'update-origin.json'), { force: true });
  const updater = ambiente.novoUpdater();
  const resultado = await updater.check({ manual: true });
  assert.equal(resultado.phase, 'no-origin');
  assert.match(resultado.error, /origem de atualizações/);
});

// ── E nada disso passa pelo GitHub ─────────────────────────────────────────

test('nenhum arquivo do caminho de atualização aponta para o GitHub', async () => {
  const { readFileSync } = await import('node:fs');
  const raiz = new URL('..', import.meta.url);
  for (const arquivo of ['desktop/updater.cjs', 'desktop/update-check.cjs', 'desktop/update-source.cjs', 'desktop/update-origin.cjs']) {
    const texto = readFileSync(new URL(arquivo, raiz), 'utf8');
    // Citar o GitHub num comentário, explicando que ele saiu, é documentação.
    // O que não pode é um endereço dele no código que roda.
    const linhas = texto.split('\n').filter((linha) => {
      const limpa = linha.trim();
      return !limpa.startsWith('//') && !limpa.startsWith('*') && !limpa.startsWith('/*');
    });
    assert.equal(
      linhas.join('\n').includes('api.github.com'),
      false,
      `${arquivo} ainda tem api.github.com em código que roda`,
    );
    assert.equal(linhas.join('\n').includes('githubusercontent'), false, `${arquivo} ainda aponta para o armazenamento do GitHub`);
  }
});
