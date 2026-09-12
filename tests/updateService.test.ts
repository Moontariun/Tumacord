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

const agora = Date.parse('2026-09-12T12:00:00.000Z');

function dispositivo(token: string, extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: 'dev-1', tokenHash: hashToken(token), label: 'Windows do Caio',
    scope: ['download'], createdAt: new Date(agora).toISOString(), expiresAt: agora + TOKEN_TTL_MS,
    ...extra,
  };
}

const TOKEN_BOM = 'a'.repeat(64);

// ── Autorização ────────────────────────────────────────────────────────────

test('sem credencial não há download, e a mensagem diz o que fazer', () => {
  const resultado = authorize([dispositivo(TOKEN_BOM)], '', 'download', agora);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.ok === false && resultado.failure, 'missing');
  assert.match(AUTH_MESSAGES.missing, /convite/);
});

test('uma credencial revogada para de valer na hora', () => {
  const revogado = [dispositivo(TOKEN_BOM, { revokedAt: new Date(agora - 1000).toISOString() })];
  assert.equal(authorize(revogado, TOKEN_BOM, 'download', agora).ok, false);
  assert.equal(authorize(revogado, TOKEN_BOM, 'download', agora).ok === false && authorize(revogado, TOKEN_BOM, 'download', agora).failure, 'revoked');
});

test('vencido e revogado são distinguidos: um renova sozinho, o outro precisa do dono', () => {
  const vencido = authorize([dispositivo(TOKEN_BOM, { expiresAt: agora - 1 })], TOKEN_BOM, 'download', agora);
  assert.equal(vencido.ok === false && vencido.failure, 'expired');
  assert.notEqual(AUTH_MESSAGES.expired, AUTH_MESSAGES.revoked);
  assert.match(AUTH_MESSAGES.expired, /renovar/);
  assert.match(AUTH_MESSAGES.revoked, /revogado/);
});

test('uma credencial de download não serve para outra coisa', () => {
  // Baixar não publica, não retira versão e não aplica nada no servidor.
  const semEscopo = [dispositivo(TOKEN_BOM, { scope: [] })];
  assert.equal(authorize(semEscopo, TOKEN_BOM, 'download', agora).ok === false && authorize(semEscopo, TOKEN_BOM, 'download', agora).failure, 'wrong-scope');
});

test('um token com forma errada é recusado antes de qualquer busca', () => {
  for (const torto of ['curto', 'a'.repeat(200), 'com espaco '.repeat(4), 'tem/barra'.padEnd(40, 'x')]) {
    const resultado = authorize([dispositivo(TOKEN_BOM)], torto, 'download', agora);
    assert.equal(resultado.ok, false, torto.slice(0, 12));
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
  const { invite, token } = createInvite('Windows do Caio', agora);
  const primeiro = enroll([invite], token, 'Windows do Caio', agora);
  assert.equal(primeiro.ok, true);

  // O convite usado volta para a lista marcado, e não é aceito de novo.
  const usado = primeiro.ok ? primeiro.invite : invite;
  const segundo = enroll([usado], token, 'Outra máquina', agora);
  assert.equal(segundo.ok, false);
  assert.equal(segundo.ok === false && segundo.failure, 'invite-used');
});

test('um convite vencido não inscreve ninguém', () => {
  const { invite, token } = createInvite('x', agora);
  assert.equal(enroll([invite], token, 'x', invite.expiresAt).ok, false);
  assert.equal(enroll([invite], token, 'x', invite.expiresAt).ok === false && enroll([invite], token, 'x', invite.expiresAt).failure, 'invite-expired');
});

test('um convite inventado não inscreve ninguém', () => {
  const { invite } = createInvite('x', agora);
  assert.equal(enroll([invite], 'b'.repeat(64), 'x', agora).ok === false && enroll([invite], 'b'.repeat(64), 'x', agora).failure, 'invite-unknown');
});

test('a credencial nasce com escopo de download e nada além', () => {
  const { invite, token } = createInvite('x', agora);
  const resultado = enroll([invite], token, 'Máquina do Renan', agora);
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.ok && resultado.device.scope, ['download']);
  assert.equal(resultado.ok && resultado.device.label, 'Máquina do Renan');
});

test('renovar exige credencial que ainda vale', () => {
  // Aceitar vencida ou revogada devolveria acesso a quem o dono acabou de tirar.
  const revogado = dispositivo(TOKEN_BOM, { revokedAt: new Date(agora).toISOString() });
  assert.equal(authorize([revogado], TOKEN_BOM, 'download', agora).ok, false);

  const renovado = renew(dispositivo(TOKEN_BOM), agora);
  assert.notEqual(renovado.token, TOKEN_BOM, 'renovar troca o token');
  assert.equal(renovado.device.tokenHash, hashToken(renovado.token));
  assert.ok(renovado.device.expiresAt > agora);
  // E o token antigo deixa de valer.
  assert.equal(authorize([renovado.device], TOKEN_BOM, 'download', agora).ok, false);
});

// ── Nada de segredo vazando ────────────────────────────────────────────────

test('a lista que o dono vê não carrega hash de token', () => {
  const publico = publicDevice(dispositivo(TOKEN_BOM));
  assert.equal('tokenHash' in publico, false);
  assert.equal(JSON.stringify(publico).includes(hashToken(TOKEN_BOM)), false);
  assert.equal(publico.label, 'Windows do Caio', 'e carrega o que serve para reconhecer');
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
  for (const torto of ['bytes=', 'bytes=abc-def', 'items=0-10', 'bytes=-', 'bytes=5-3-2', 42]) {
    assert.equal(parseRange(torto as unknown, 1000).kind, 'malformed', String(torto));
  }
  // `bytes=5-3` é sintaticamente válido e semanticamente impossível.
  assert.equal(parseRange('bytes=5-3', 1000).kind, 'unsatisfiable');
});

test('uma faixa gigante é limitada, e o cliente pede o resto depois', () => {
  const faixa = parseRange('bytes=0-999999999', 10 * MAX_RANGE_BYTES);
  assert.equal(faixa.kind, 'partial');
  assert.equal(faixa.kind === 'partial' && faixa.length, MAX_RANGE_BYTES);
});

test('HEAD responde os mesmos cabeçalhos e nenhum corpo', () => {
  const cabeca = planDelivery({ filePath: '/x', size: 1000, method: 'HEAD', rangeHeader: undefined, fileName: 'x.exe', sha256: 'a'.repeat(64) });
  const corpo = planDelivery({ filePath: '/x', size: 1000, method: 'GET', rangeHeader: undefined, fileName: 'x.exe', sha256: 'a'.repeat(64) });
  assert.equal(cabeca.status, corpo.status);
  assert.deepEqual(cabeca.headers, corpo.headers);
  assert.equal(cabeca.stream, undefined);
  assert.ok(corpo.stream);
});

test('binário privado não entra em cache compartilhado', () => {
  const plano = planDelivery({ filePath: '/x', size: 10, method: 'GET', rangeHeader: undefined, fileName: 'x.exe', sha256: 'a'.repeat(64) });
  // Um proxy guardando isto serviria o arquivo a quem não foi autorizado.
  assert.equal(plano.headers['cache-control'], 'private, no-store');
  assert.equal(plano.headers.vary, 'Authorization');
  assert.equal(plano.headers['accept-ranges'], 'bytes');
});

test('o nome do arquivo não parte a resposta', () => {
  const plano = planDelivery({ filePath: '/x', size: 10, method: 'GET', rangeHeader: undefined, fileName: 'x.exe"\r\nX-Forjado: sim', sha256: 'a'.repeat(64) });
  const cabecalho = plano.headers['content-disposition'];
  // O que parte uma resposta HTTP é quebra de linha; o que sai das aspas é a
  // própria aspa. O resto do texto continua dentro do nome, e é inofensivo.
  assert.equal(/[\r\n]/.test(cabecalho), false, 'quebra de linha partiria a resposta');
  assert.equal(cabecalho.split('"').length, 3, 'o nome continua entre um par de aspas');
  assert.match(cabecalho, /^attachment; filename="[A-Za-z0-9._-]+"$/);
});

// ── O caminho não escapa do armazenamento ──────────────────────────────────

test('o caminho do pacote é resolvido contra a raiz, e não confiado', () => {
  const raiz = '/var/lib/tumacord/pacotes';
  assert.equal(resolveStoragePath(raiz, 'releases/0.9.9-1/x.exe'), path.join(raiz, 'releases/0.9.9-1/x.exe'));
  // Um `..` pode vir codificado, vir de um documento assinado antigo, ou
  // aparecer só depois da junção. Comparar o resultado com a raiz fecha isso.
  assert.equal(resolveStoragePath(raiz, '../../etc/passwd'), null);
  assert.equal(resolveStoragePath(raiz, 'releases/../../../etc/passwd'), null);
  assert.equal(resolveStoragePath(raiz, '/etc/passwd'), null);
  assert.equal(resolveStoragePath(raiz, 'x\0.exe'), null);
  assert.equal(resolveStoragePath(raiz, ''), null);
});

test('o tamanho vem do disco, e um arquivo ausente é ausente', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-pacotes-'));
  try {
    const arquivo = path.join(pasta, 'pacote.bin');
    await writeFile(arquivo, Buffer.alloc(4096));
    assert.equal(await fileSize(arquivo), 4096);
    assert.equal(await fileSize(path.join(pasta, 'nao-existe')), null);
    assert.equal(await fileSize(pasta), null, 'um diretório não é um pacote');
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});

// ── Concorrência ───────────────────────────────────────────────────────────

test('há um teto de downloads simultâneos, e ele é devolvido', () => {
  // A VPS divide rede com o chat e com o TURN: sem teto, dez pessoas
  // atualizando tiram a call de todo mundo.
  const portao = new ConcurrencyGate(2);
  assert.equal(portao.tryAcquire(), true);
  assert.equal(portao.tryAcquire(), true);
  assert.equal(portao.tryAcquire(), false, 'o terceiro espera');
  portao.release();
  assert.equal(portao.tryAcquire(), true);
  // Liberar de novo não cria vaga do nada.
  portao.release(); portao.release(); portao.release(); portao.release();
  assert.equal(portao.active, 0);
});

// ── Catálogo: publicação, retirada e o número que não se reutiliza ─────────

const manifesto = (releaseId: string, version: string): Signed<ReleaseManifest> => ({
  payload: { contract: CONTRACT_VERSION, releaseId, version, channel: 'stable', commit: '0'.repeat(40), createdAt: new Date(agora).toISOString(), artifacts: [] },
  signatures: [{ keyId: 'k', algorithm: 'ed25519', signature: 'x' }],
});

test('a sequência precisa crescer a cada publicação', () => {
  const atual = { ...emptyCatalog(agora, 3600_000), sequence: 5 };
  assert.equal(validateCatalog({ ...atual, sequence: 5 }, atual, {}), 'sequence-not-advancing');
  assert.equal(validateCatalog({ ...atual, sequence: 4 }, atual, {}), 'sequence-not-advancing');
  assert.equal(validateCatalog({ ...atual, sequence: 6 }, atual, {}), null);
});

test('um número já publicado não volta a ser usado para outra release', () => {
  // Reaproveitar `0.9.9-1` para outra release faria metade do grupo estar numa
  // 0.9.9-1 e a outra metade noutra, com o mesmo nome.
  const manifests = { 'rel-a': manifesto('rel-a', '0.9.9-1'), 'rel-b': manifesto('rel-b', '0.9.9-1') };
  const atual = {
    ...emptyCatalog(agora, 3600_000), sequence: 1,
    channels: { stable: { entries: [{ releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  const trocado = {
    ...atual, sequence: 2,
    channels: { stable: { entries: [{ releaseId: 'rel-b', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  assert.equal(validateCatalog(trocado, atual, manifests), 'reused-version');
  // A mesma release com o mesmo número continua podendo ser republicada.
  assert.equal(validateCatalog({ ...atual, sequence: 2 }, atual, manifests), null);
});

test('não se publica entrada sem manifesto importado', () => {
  const proximo = {
    ...emptyCatalog(agora, 3600_000), sequence: 1,
    channels: { stable: { entries: [{ releaseId: 'rel-fantasma', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  assert.equal(validateCatalog(proximo, null, {}), 'manifest-missing');
  assert.equal(validateCatalog(proximo, null, { 'rel-fantasma': manifesto('rel-fantasma', '0.9.9-1') }), null);
});

test('a mesma versão duas vezes no canal é recusada', () => {
  const manifests = { 'rel-a': manifesto('rel-a', '0.9.9-1') };
  const proximo = {
    ...emptyCatalog(agora, 3600_000), sequence: 1,
    channels: {
      stable: { entries: [
        { releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' },
        { releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' },
      ] },
      test: { entries: [] },
    },
  };
  assert.equal(validateCatalog(proximo, null, manifests), 'duplicate-version');
});

test('retirar aumenta a sequência e marca a entrada, sem apagar nada', () => {
  const atual = {
    ...emptyCatalog(agora, 3600_000), sequence: 3,
    channels: { stable: { entries: [{ releaseId: 'rel-a', version: '0.9.9-1', state: 'published' as const, publishedAt: '', manifestSha256: '' }] }, test: { entries: [] } },
  };
  const retirado = withdrawEntry(atual, 'stable', 'rel-a', 'o áudio sai errado no Windows', agora);
  assert.equal(retirado.sequence, 4);
  assert.equal(retirado.channels.stable.entries[0].state, 'withdrawn');
  assert.equal(retirado.channels.stable.entries[0].withdrawn?.reason, 'o áudio sai errado no Windows');
  assert.equal(retirado.channels.stable.entries.length, 1, 'a entrada continua na lista, dita');
});

// ── Estado em disco ────────────────────────────────────────────────────────

test('o estado sobrevive ao reinício do serviço', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-estado-'));
  try {
    const primeiro = new StateStore(pasta);
    await primeiro.load();
    const convite: InviteRecord = createInvite('x', agora).invite;
    await primeiro.mutate((state) => { state.invites.push(convite); state.devices.push(dispositivo(TOKEN_BOM)); });

    const segundo = new StateStore(pasta);
    await segundo.load();
    assert.equal(segundo.state.devices.length, 1);
    assert.equal(segundo.state.invites.length, 1);
    assert.equal(authorize(segundo.state.devices, TOKEN_BOM, 'download', agora).ok, true);
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});

test('gravações concorrentes não intercalam', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'tumacord-estado-'));
  try {
    const store = new StateStore(pasta);
    await store.load();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate((state) => {
      state.devices.push(dispositivo(`${i}`.padStart(64, 'z'), { deviceId: `dev-${i}` }));
    })));
    const relido = new StateStore(pasta);
    await relido.load();
    assert.equal(relido.state.devices.length, 20, 'nenhuma gravação foi perdida nem o arquivo ficou pela metade');
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});
