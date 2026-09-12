import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTH_MESSAGES,
  type DeviceRecord,
  type InviteRecord,
  TOKEN_TTL_MS,
  authorize,
  bearerToken,
  createInvite,
  enroll,
  hashToken,
  publicDevice,
  renew,
  sanitizeLabel,
} from '../services/updates/src/devices';
import { ConcurrencyGate, MAX_RANGE_BYTES, fileSize, parseRange, planDelivery, resolveStoragePath } from '../services/updates/src/delivery';
import { StateStore, emptyCatalog, validateCatalog, withdrawEntry } from '../services/updates/src/state';
import { CONTRACT_VERSION, type ReleaseManifest, type Signed } from '../shared/distribution';

// O serviço que serve as atualizações na VPS. Aqui está a parte que decide
// **quem baixa o quê** — a que, quando erra, entrega binário privado a quem
// não devia, ou impede o grupo inteiro de se atualizar.

const now = Date.parse('2026-09-12T12:00:00.000Z');

function device(token: string, extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: 'dev-1', tokenHash: hashToken(token), label: 'Windows do Caio',
    scope: ['download'], createdAt: new Date(now).toISOString(), expiresAt: now + TOKEN_TTL_MS,
    ...extra,
  };
}

const VALID_TOKEN = 'a'.repeat(64);

// ── Autorização ────────────────────────────────────────────────────────────

test('sem credencial não há download, e a mensagem diz o que fazer', () => {
  const outcome = authorize([device(VALID_TOKEN)], '', 'download', now);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'missing');
  assert.match(AUTH_MESSAGES.missing, /convite/);
});

test('uma credencial revogada para de valer na hora', () => {
  const revoked = [device(VALID_TOKEN, { revokedAt: new Date(now - 1000).toISOString() })];
  assert.equal(authorize(revoked, VALID_TOKEN, 'download', now).ok, false);
  assert.equal(authorize(revoked, VALID_TOKEN, 'download', now).ok === false && authorize(revoked, VALID_TOKEN, 'download', now).failure, 'revoked');
});

test('vencido e revogado são distinguidos: um renova sozinho, o outro precisa do dono', () => {
  const expired = authorize([device(VALID_TOKEN, { expiresAt: now - 1 })], VALID_TOKEN, 'download', now);
  assert.equal(expired.ok === false && expired.failure, 'expired');
  assert.notEqual(AUTH_MESSAGES.expired, AUTH_MESSAGES.revoked);
  assert.match(AUTH_MESSAGES.expired, /renovar/);
  assert.match(AUTH_MESSAGES.revoked, /revogado/);
});

test('uma credencial de download não serve para outra coisa', () => {
  // Baixar não publica, não retira versão e não aplica nada no servidor.
  const withoutScope = [device(VALID_TOKEN, { scope: [] })];
  assert.equal(authorize(withoutScope, VALID_TOKEN, 'download', now).ok === false && authorize(withoutScope, VALID_TOKEN, 'download', now).failure, 'wrong-scope');
});

test('um token com forma errada é recusado antes de qualquer busca', () => {
  for (const malformed of ['curto', 'a'.repeat(200), 'com espaco '.repeat(4), 'tem/barra'.padEnd(40, 'x')]) {
    const outcome = authorize([device(VALID_TOKEN)], malformed, 'download', now);
    assert.equal(outcome.ok, false, malformed.slice(0, 12));
  }
});

test('o token do cabeçalho é lido só na forma esperada', () => {
  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('bearer abc123'), 'abc123');
  assert.equal(bearerToken('Basic abc123'), '');
  assert.equal(bearerToken('abc123'), '');
  assert.equal(bearerToken(undefined), '');
  assert.equal(bearerToken(['Bearer x']), '', 'cabeçalho repetido não vira token');
});

// ── Convites ───────────────────────────────────────────────────────────────

test('um convite vale uma vez só', () => {
  const { invite, token } = createInvite('Windows do Caio', now);
  const first = enroll([invite], token, 'Windows do Caio', now);
  assert.equal(first.ok, true);

  // O convite usado volta para a lista marcado, e não é aceito de novo.
  const used = first.ok ? first.invite : invite;
  const second = enroll([used], token, 'Outra máquina', now);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.failure, 'invite-used');
});

test('um convite vencido não inscreve ninguém', () => {
  const { invite, token } = createInvite('x', now);
  assert.equal(enroll([invite], token, 'x', invite.expiresAt).ok, false);
  assert.equal(enroll([invite], token, 'x', invite.expiresAt).ok === false && enroll([invite], token, 'x', invite.expiresAt).failure, 'invite-expired');
});

test('um convite inventado não inscreve ninguém', () => {
  const { invite } = createInvite('x', now);
  assert.equal(enroll([invite], 'b'.repeat(64), 'x', now).ok === false && enroll([invite], 'b'.repeat(64), 'x', now).failure, 'invite-unknown');
});

test('a credencial nasce com escopo de download e nada além', () => {
  const { invite, token } = createInvite('x', now);
  const outcome = enroll([invite], token, 'Máquina do Renan', now);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.device.scope, ['download']);
  assert.equal(outcome.ok && outcome.device.label, 'Máquina do Renan');
});

test('renovar exige credencial que ainda vale', () => {
  // Aceitar vencida ou revogada devolveria acesso a quem o dono acabou de tirar.
  const revoked = device(VALID_TOKEN, { revokedAt: new Date(now).toISOString() });
  assert.equal(authorize([revoked], VALID_TOKEN, 'download', now).ok, false);

  const renewed = renew(device(VALID_TOKEN), now);
  assert.notEqual(renewed.token, VALID_TOKEN, 'renovar troca o token');
  assert.equal(renewed.device.tokenHash, hashToken(renewed.token));
  assert.ok(renewed.device.expiresAt > now);
  // E o token antigo deixa de valer.
  assert.equal(authorize([renewed.device], VALID_TOKEN, 'download', now).ok, false);
});

// ── Nada de segredo vazando ────────────────────────────────────────────────

test('a lista que o dono vê não carrega hash de token', () => {
  const publicView = publicDevice(device(VALID_TOKEN));
  assert.equal('tokenHash' in publicView, false);
  assert.equal(JSON.stringify(publicView).includes(hashToken(VALID_TOKEN)), false);
  assert.equal(publicView.label, 'Windows do Caio', 'e carrega o que serve para reconhecer');
});

test('o rótulo não carrega controle para dentro do log nem do painel', () => {
  assert.equal(sanitizeLabel('Windows\r\nFALSO: tudo certo'), 'Windows FALSO: tudo certo');
  assert.equal(sanitizeLabel('x'.repeat(200)).length, 64);
  assert.equal(sanitizeLabel(42), '');
});

// ── Range e HEAD ───────────────────────────────────────────────────────────

test('sem Range, a entrega é o arquivo inteiro', () => {
  assert.deepEqual(parseRange(undefined, 1000), { kind: 'full', start: 0, end: 999, length: 1000 });
});

test('retomar do meio devolve 206 com a faixa certa', () => {
  assert.deepEqual(parseRange('bytes=500-', 1000), { kind: 'partial', start: 500, end: 999, length: 500 });
  assert.deepEqual(parseRange('bytes=0-99', 1000), { kind: 'partial', start: 0, end: 99, length: 100 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { kind: 'partial', start: 900, end: 999, length: 100 });
});

test('uma faixa impossível devolve 416, e não o arquivo inteiro', () => {
  // Entregar tudo para quem pediu um pedaço faria um cliente que retoma
  // baixar de novo do começo achando que estava continuando.
  assert.equal(parseRange('bytes=2000-', 1000).kind, 'unsatisfiable');
  assert.equal(parseRange('bytes=1000-', 1000).kind, 'unsatisfiable');
  assert.equal(parseRange('bytes=0-', 0).kind, 'unsatisfiable');
  assert.equal(planDelivery({ filePath: '/x', size: 1000, method: 'GET', rangeHeader: 'bytes=2000-', fileName: 'x.exe', sha256: 'a'.repeat(64) }).status, 416);
});

test('Range malformado não vira o arquivo inteiro em silêncio', () => {
  for (const malformed of ['bytes=', 'bytes=abc-def', 'items=0-10', 'bytes=-', 'bytes=5-3-2', 42]) {
    assert.equal(parseRange(malformed as unknown, 1000).kind, 'malformed', String(malformed));
  }
  // `bytes=5-3` é sintaticamente válido e semanticamente impossível.
  assert.equal(parseRange('bytes=5-3', 1000).kind, 'unsatisfiable');
});

test('uma faixa gigante é limitada, e o cliente pede o resto depois', () => {
  const range = parseRange('bytes=0-999999999', 10 * MAX_RANGE_BYTES);
  assert.equal(range.kind, 'partial');
  assert.equal(range.kind === 'partial' && range.length, MAX_RANGE_BYTES);
});

test('HEAD responde os mesmos cabeçalhos e nenhum corpo', () => {
  const head = planDelivery({ filePath: '/x', size: 1000, method: 'HEAD', rangeHeader: undefined, fileName: 'x.exe', sha256: 'a'.repeat(64) });
  const body = planDelivery({ filePath: '/x', size: 1000, method: 'GET', rangeHeader: undefined, fileName: 'x.exe', sha256: 'a'.repeat(64) });
  assert.equal(head.status, body.status);
  assert.deepEqual(head.headers, body.headers);
  assert.equal(head.stream, undefined);
  assert.ok(body.stream);
});

test('binário privado não entra em cache compartilhado', () => {
  const plan = planDelivery({ filePath: '/x', size: 10, method: 'GET', rangeHeader: undefined, fileName: 'x.exe', sha256: 'a'.repeat(64) });
  // Um proxy guardando isto serviria o arquivo a quem não foi autorizado.
  assert.equal(plan.headers['cache-control'], 'private, no-store');
  assert.equal(plan.headers.vary, 'Authorization');
  assert.equal(plan.headers['accept-ranges'], 'bytes');
});

test('o nome do arquivo não parte a resposta', () => {
  const plan = planDelivery({ filePath: '/x', size: 10, method: 'GET', rangeHeader: undefined, fileName: 'x.exe"\r\nX-Forjado: sim', sha256: 'a'.repeat(64) });
  const header = plan.headers['content-disposition'];
  // O que parte uma resposta HTTP é quebra de linha; o que sai das aspas é a
  // própria aspa. O resto do texto continua dentro do nome, e é inofensivo.
  assert.equal(/[\r\n]/.test(header), false, 'quebra de linha partiria a resposta');
  assert.equal(header.split('"').length, 3, 'o nome continua entre um par de aspas');
  assert.match(header, /^attachment; filename="[A-Za-z0-9._-]+"$/);
});

// ── O caminho não escapa do armazenamento ──────────────────────────────────

test('o caminho do pacote é resolvido contra a raiz, e não confiado', () => {
  const rootDir = '/var/lib/tumacord/pacotes';
  assert.equal(resolveStoragePath(rootDir, 'releases/0.9.9-1/x.exe'), path.join(rootDir, 'releases/0.9.9-1/x.exe'));
  // Um `..` pode vir codificado, vir de um documento assinado antigo, ou
  // aparecer só depois da junção. Comparar o resultado com a raiz fecha isso.
  assert.equal(resolveStoragePath(rootDir, '../../etc/passwd'), null);
  assert.equal(resolveStoragePath(rootDir, 'releases/../../../etc/passwd'), null);
  assert.equal(resolveStoragePath(rootDir, '/etc/passwd'), null);
  assert.equal(resolveStoragePath(rootDir, 'x\0.exe'), null);
  assert.equal(resolveStoragePath(rootDir, ''), null);
});

test('o tamanho vem do disco, e um arquivo ausente é ausente', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-pacotes-'));
  try {
    const file = path.join(folder, 'pacote.bin');
    await writeFile(file, Buffer.alloc(4096));
    assert.equal(await fileSize(file), 4096);
    assert.equal(await fileSize(path.join(folder, 'nao-existe')), null);
    assert.equal(await fileSize(folder), null, 'um diretório não é um pacote');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// ── Concorrência ───────────────────────────────────────────────────────────

test('há um teto de downloads simultâneos, e ele é devolvido', () => {
  // A VPS divide rede com o chat e com o TURN: sem teto, dez pessoas
  // atualizando tiram a call de todo mundo.
  const gate = new ConcurrencyGate(2);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false, 'o terceiro espera');
  gate.release();
  assert.equal(gate.tryAcquire(), true);
  // Liberar de novo não cria vaga do nada.
  gate.release(); gate.release(); gate.release(); gate.release();
  assert.equal(gate.active, 0);
});

// ── Catálogo: publicação, retirada e o número que não se reutiliza ─────────

const manifest = (releaseId: string, version: string): Signed<ReleaseManifest> => ({
  payload: { contract: CONTRACT_VERSION, releaseId, version, channel: 'stable', commit: '0'.repeat(40), createdAt: new Date(now).toISOString(), artifacts: [] },
  signatures: [{ keyId: 'k', algorithm: 'ed25519', signature: 'x' }],
});

test('a sequência precisa crescer a cada publicação', () => {
  const current = { ...emptyCatalog(now, 3600_000), sequence: 5 };
  assert.equal(validateCatalog({ ...current, sequence: 5 }, current, {}), 'sequence-not-advancing');
  assert.equal(validateCatalog({ ...current, sequence: 4 }, current, {}), 'sequence-not-advancing');
  assert.equal(validateCatalog({ ...current, sequence: 6 }, current, {}), null);
});

test('um número já publicado não volta a ser usado para outra release', () => {
  // Reaproveitar `0.9.9-1` para outra release faria metade do grupo estar numa
  // 0.9.9-1 e a outra metade noutra, com o mesmo nome.
  const manifests = { 'rel-a': manifest('rel-a', '0.9.9-1'), 'rel-b': manifest('rel-b', '0.9.9-1') };
  const current = {
    ...emptyCatalog(now, 3600_000), sequence: 1,
    channels: { stable: { entries: [{ releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  const swapped = {
    ...current, sequence: 2,
    channels: { stable: { entries: [{ releaseId: 'rel-b', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  assert.equal(validateCatalog(swapped, current, manifests), 'reused-version');
  // A mesma release com o mesmo número continua podendo ser republicada.
  assert.equal(validateCatalog({ ...current, sequence: 2 }, current, manifests), null);
});

test('não se publica entrada sem manifesto importado', () => {
  const next = {
    ...emptyCatalog(now, 3600_000), sequence: 1,
    channels: { stable: { entries: [{ releaseId: 'rel-fantasma', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  assert.equal(validateCatalog(next, null, {}), 'manifest-missing');
  assert.equal(validateCatalog(next, null, { 'rel-fantasma': manifest('rel-fantasma', '0.9.9-1') }), null);
});

test('a mesma versão duas vezes no canal é recusada', () => {
  const manifests = { 'rel-a': manifest('rel-a', '0.9.9-1') };
  const next = {
    ...emptyCatalog(now, 3600_000), sequence: 1,
    channels: {
      stable: { entries: [
        { releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' },
        { releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' },
      ] },
      test: { entries: [] },
    },
  };
  assert.equal(validateCatalog(next, null, manifests), 'duplicate-version');
});

test('retirar aumenta a sequência e marca a entrada, sem apagar nada', () => {
  const current = {
    ...emptyCatalog(now, 3600_000), sequence: 3,
    channels: { stable: { entries: [{ releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  const withdrawn = withdrawEntry(current, 'stable', 'rel-a', 'o áudio sai errado no Windows', now);
  assert.equal(withdrawn.sequence, 4);
  assert.equal(withdrawn.channels.stable.entries[0].state, 'withdrawn');
  assert.equal(withdrawn.channels.stable.entries[0].withdrawn?.reason, 'o áudio sai errado no Windows');
  assert.equal(withdrawn.channels.stable.entries.length, 1, 'a entrada continua na lista, dita');
});

// ── Estado em disco ────────────────────────────────────────────────────────

test('o estado sobrevive ao reinício do serviço', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-estado-'));
  try {
    const first = new StateStore(folder);
    await first.load();
    const pendingInvite: InviteRecord = createInvite('x', now).invite;
    await first.mutate((state) => { state.invites.push(pendingInvite); state.devices.push(device(VALID_TOKEN)); });

    const second = new StateStore(folder);
    await second.load();
    assert.equal(second.state.devices.length, 1);
    assert.equal(second.state.invites.length, 1);
    assert.equal(authorize(second.state.devices, VALID_TOKEN, 'download', now).ok, true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('gravações concorrentes não intercalam', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-estado-'));
  try {
    const store = new StateStore(folder);
    await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate((state) => {
      state.devices.push(device(`${i}`.padStart(64, 'z'), { deviceId: `dev-${i}` }));
    })));
    const reread = new StateStore(folder);
    await reread.load();
    assert.equal(reread.state.devices.length, 20, 'nenhuma gravação foi perdida nem o arquivo ficou pela metade');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
