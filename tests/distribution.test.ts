import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_VERSION,
  type Artifact,
  type Catalog,
  type CatalogEntry,
  type ReleaseManifest,
  type TrustedKey,
  artifactMatches,
  canonicalize,
  catalogFreshness,
  ineligibleReason,
  isSafeStoragePath,
  keyUsable,
  selectArtifact,
  verifySigned,
} from '../shared/distribution';
import { documentDigest, generateSigningKey, signDocument, verifySignature } from '../shared/distributionCrypto';
import { requireVersion } from '../shared/version';

// Os contratos da distribuição privada: o que é assinado, o que é aceito, e o
// que é recusado. Esta é a parte que erra em silêncio quando erra — uma
// verificação frouxa aqui não aparece numa tela, aparece como código
// executando na máquina de alguém.

const chaveManifesto = generateSigningKey();
const chaveCatalogo = generateSigningKey();

const confiaveis: TrustedKey[] = [
  { ...chaveManifesto, scope: ['manifest'] },
  { ...chaveCatalogo, scope: ['catalog'] },
];

const pacoteWindows: Artifact = {
  artifactId: 'win-x64-nsis',
  os: 'windows', arch: 'x64', format: 'exe', installKind: 'windows-installed',
  fileName: 'Tumacord-0.9.9-1-Setup.exe',
  size: 120_000_000,
  sha256: 'a'.repeat(64),
  signatureKeyId: chaveManifesto.keyId,
  storagePath: 'releases/0.9.9-1/Tumacord-0.9.9-1-Setup.exe',
};

const pacoteLinux: Artifact = {
  ...pacoteWindows,
  artifactId: 'linux-x64-tar',
  os: 'linux', format: 'tar.gz', installKind: 'linux-managed',
  fileName: 'tumacord-0.9.9-1.tar.gz',
  sha256: 'b'.repeat(64),
  storagePath: 'releases/0.9.9-1/tumacord-0.9.9-1.tar.gz',
};

const manifesto: ReleaseManifest = {
  contract: CONTRACT_VERSION,
  releaseId: 'rel-0991',
  version: '0.9.9-1',
  channel: 'stable',
  commit: '0'.repeat(40),
  createdAt: '2026-09-12T10:00:00.000Z',
  artifacts: [pacoteWindows, pacoteLinux],
};

function entrada(extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    releaseId: 'rel-0991', version: '0.9.9-1', state: 'published',
    publishedAt: '2026-09-12T10:00:00.000Z',
    manifestSha256: documentDigest(manifesto),
    ...extra,
  };
}

// ── A forma canônica ───────────────────────────────────────────────────────
//
// Assinar "o JSON" não define nada: dois `JSON.stringify` da mesma informação
// podem diferir na ordem das chaves, e quem verificasse numa linguagem
// diferente da de quem assinou concluiria que o documento foi adulterado.

test('a ordem das chaves não muda a forma canônica', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('a ordem dos vetores é preservada, porque ela é conteúdo', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('`undefined` não entra, e não finito não tem forma canônica', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  assert.throws(() => canonicalize({ a: Number.NaN }), /não finito/);
  assert.throws(() => canonicalize({ a: Number.POSITIVE_INFINITY }), /não finito/);
});

test('o texto é escapado como JSON, e acento sobrevive', () => {
  assert.equal(canonicalize({ a: 'ção "x"' }), '{"a":"ção \\"x\\""}');
});

// ── Assinatura ─────────────────────────────────────────────────────────────

test('um manifesto assinado é aceito, e o mesmo manifesto mexido não é', () => {
  const documento = signDocument(manifesto, [chaveManifesto]);
  assert.deepEqual(verifySigned(documento, confiaveis, 'manifest', verifySignature), { ok: true, keyId: chaveManifesto.keyId });

  // Um byte do resumo trocado: o pacote passaria a ser outro arquivo.
  const adulterado = { ...documento, payload: { ...manifesto, artifacts: [{ ...pacoteWindows, sha256: 'c'.repeat(64) }, pacoteLinux] } };
  assert.deepEqual(verifySigned(adulterado, confiaveis, 'manifest', verifySignature), { ok: false, failure: 'bad-signature', detail: chaveManifesto.keyId });
});

test('quem pode mexer no catálogo não pode assinar binário novo', () => {
  // O ponto da separação: uma chave de catálogo comprometida esconde uma
  // versão boa; uma de manifesto entrega código. Não é o mesmo estrago.
  const comCatalogo = signDocument(manifesto, [chaveCatalogo]);
  const resultado = verifySigned(comCatalogo, confiaveis, 'manifest', verifySignature);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.ok === false && resultado.failure, 'key-wrong-scope');
});

test('uma chave desconhecida não vale, mesmo com assinatura correta', () => {
  const intrusa = generateSigningKey();
  const documento = signDocument(manifesto, [intrusa]);
  const resultado = verifySigned(documento, confiaveis, 'manifest', verifySignature);
  assert.equal(resultado.ok === false && resultado.failure, 'unknown-key');
});

test('um documento sem assinatura nenhuma é recusado', () => {
  assert.equal(verifySigned({ payload: manifesto, signatures: [] }, confiaveis, 'manifest', verifySignature).ok, false);
});

test('contrato desconhecido é recusado antes de qualquer verificação', () => {
  const futuro = signDocument({ ...manifesto, contract: 99 }, [chaveManifesto]);
  const resultado = verifySigned(futuro, confiaveis, 'manifest', verifySignature);
  assert.equal(resultado.ok === false && resultado.failure, 'contract-unknown');
});

// Rotação: durante a troca, o mesmo documento sai assinado pelas duas chaves,
// e ninguém fica sem conseguir verificar.
test('duas assinaturas permitem trocar de chave sem ninguém ficar de fora', () => {
  const nova = generateSigningKey();
  const documento = signDocument(manifesto, [chaveManifesto, nova]);

  // Quem ainda só conhece a chave velha verifica.
  assert.equal(verifySigned(documento, confiaveis, 'manifest', verifySignature).ok, true);
  // Quem já só conhece a nova também.
  assert.equal(verifySigned(documento, [{ ...nova, scope: ['manifest'] }], 'manifest', verifySignature).ok, true);
});

test('uma chave revogada para de valer, e o motivo é dito', () => {
  const revogada: TrustedKey[] = [{ ...chaveManifesto, scope: ['manifest'], revokedAt: '2026-09-01T00:00:00.000Z', revokedReason: 'saiu da máquina de publicação' }];
  const documento = signDocument(manifesto, [chaveManifesto]);
  assert.equal(verifySigned(documento, revogada, 'manifest', verifySignature).ok === false && verifySigned(documento, revogada, 'manifest', verifySignature).failure, 'key-revoked');
});

test('uma chave fora da validade não assina nem verifica', () => {
  const agora = Date.parse('2026-09-12T00:00:00.000Z');
  assert.equal(keyUsable({ ...chaveManifesto, scope: ['manifest'], notBefore: '2026-10-01T00:00:00.000Z' }, 'manifest', agora), 'key-not-yet-valid');
  assert.equal(keyUsable({ ...chaveManifesto, scope: ['manifest'], notAfter: '2026-01-01T00:00:00.000Z' }, 'manifest', agora), 'key-expired');
  assert.equal(keyUsable({ ...chaveManifesto, scope: ['manifest'] }, 'manifest', agora), null);
});

// ── Frescor do catálogo ────────────────────────────────────────────────────

function catalogo(extra: Partial<Catalog> = {}): Catalog {
  return {
    contract: CONTRACT_VERSION,
    sequence: 7,
    createdAt: '2026-09-12T10:00:00.000Z',
    expiresAt: '2026-09-13T10:00:00.000Z',
    channels: { stable: { entries: [entrada()] }, test: { entries: [] } },
    ...extra,
  };
}

const agora = Date.parse('2026-09-12T12:00:00.000Z');

test('um catálogo vencido não decide nada', () => {
  assert.equal(catalogFreshness(catalogo(), 0, agora), 'ok');
  assert.equal(catalogFreshness(catalogo({ expiresAt: '2026-09-12T11:00:00.000Z' }), 0, agora), 'expired');
});

test('um catálogo repetido é recusado antes de ler o conteúdo', () => {
  // O ataque: devolver um catálogo antigo para segurar a retirada de uma
  // versão defeituosa, ou para reoferecer uma que o grupo deixou para trás.
  assert.equal(catalogFreshness(catalogo({ sequence: 6 }), 7, agora), 'replayed');
  assert.equal(catalogFreshness(catalogo({ sequence: 7 }), 7, agora), 'ok', 'o mesmo catálogo continua valendo');
  assert.equal(catalogFreshness(catalogo({ sequence: 8 }), 7, agora), 'ok');
});

test('catálogo torto é recusado, e não tratado como vazio', () => {
  assert.equal(catalogFreshness(null, 0, agora), 'malformed');
  assert.equal(catalogFreshness(catalogo({ contract: 99 }), 0, agora), 'malformed');
  assert.equal(catalogFreshness(catalogo({ sequence: -1 }), 0, agora), 'malformed');
  assert.equal(catalogFreshness(catalogo({ expiresAt: 'ontem' }), 0, agora), 'malformed');
});

// A sequência do catálogo não é a ordem da versão do produto.
test('aumentar a sequência para retirar uma versão não oferece downgrade', () => {
  const retirado = catalogo({
    sequence: 8,
    channels: {
      stable: { entries: [entrada({ state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado', at: '2026-09-12T11:00:00.000Z' } })] },
      test: { entries: [] },
    },
  });
  assert.equal(catalogFreshness(retirado, 7, agora), 'ok');
  const motivo = ineligibleReason({
    entry: retirado.channels.stable.entries[0], manifest: manifesto,
    currentVersion: requireVersion('0.9.9-1'), installKind: 'windows-installed', arch: 'x64',
  });
  assert.equal(motivo?.reason, 'withdrawn');
});

// ── Escolha de pacote ──────────────────────────────────────────────────────

test('o pacote é escolhido por OS, arquitetura e jeito de instalar, os três', () => {
  assert.equal(selectArtifact(manifesto, 'windows-installed', 'x64')?.artifactId, 'win-x64-nsis');
  assert.equal(selectArtifact(manifesto, 'linux-managed', 'x64')?.artifactId, 'linux-x64-tar');
  // Um portable não recebe o instalador NSIS por engano.
  assert.equal(selectArtifact(manifesto, 'windows-portable', 'x64'), null);
  assert.equal(selectArtifact(manifesto, 'windows-installed', 'arm64'), null);
});

test('um manifesto ambíguo não vira sorteio', () => {
  const duplicado = { ...manifesto, artifacts: [pacoteWindows, { ...pacoteWindows, artifactId: 'outro', fileName: 'outro.exe' }] };
  assert.equal(selectArtifact(duplicado, 'windows-installed', 'x64'), null, 'dois pacotes para o mesmo alvo param a escolha');
});

test('pacote sem resumo, sem tamanho ou com caminho torto é tratado como inexistente', () => {
  for (const quebrado of [
    { ...pacoteWindows, sha256: 'nao-e-hash' },
    { ...pacoteWindows, sha256: 'A'.repeat(63) },
    { ...pacoteWindows, size: 0 },
    { ...pacoteWindows, size: -1 },
    { ...pacoteWindows, storagePath: '../../etc/passwd' },
    { ...pacoteWindows, storagePath: 'https://outro-dominio/x.exe' },
    { ...pacoteWindows, storagePath: '/absoluto/x.exe' },
  ]) {
    assert.equal(selectArtifact({ ...manifesto, artifacts: [quebrado] }, 'windows-installed', 'x64'), null, JSON.stringify(quebrado.storagePath ?? quebrado.sha256));
  }
});

test('o caminho de armazenamento não escapa nem vira URL', () => {
  assert.equal(isSafeStoragePath('releases/0.9.9-1/arquivo.exe'), true);
  assert.equal(isSafeStoragePath('../fora.exe'), false);
  assert.equal(isSafeStoragePath('releases/../../fora.exe'), false);
  assert.equal(isSafeStoragePath('/etc/passwd'), false);
  assert.equal(isSafeStoragePath('https://exemplo/x'), false);
  assert.equal(isSafeStoragePath('file:///x'), false);
  assert.equal(isSafeStoragePath('releases\\windows\\x.exe'), false);
  assert.equal(isSafeStoragePath('releases//x.exe'), false);
  assert.equal(isSafeStoragePath('releases/./x.exe'), false);
  assert.equal(isSafeStoragePath(''), false);
  assert.equal(isSafeStoragePath(null), false);
});

// ── Manifesto e pacote precisam concordar ──────────────────────────────────

test('conferir só o resumo não basta: versão, arquitetura e formato também', () => {
  assert.equal(artifactMatches(manifesto, pacoteWindows, { sha256: 'a'.repeat(64), size: 120_000_000, version: '0.9.9-1', releaseId: 'rel-0991', arch: 'x64', format: 'exe' }), null);
  assert.equal(artifactMatches(manifesto, pacoteWindows, { version: '0.9.9' }), 'version-mismatch');
  assert.equal(artifactMatches(manifesto, pacoteWindows, { releaseId: 'outra' }), 'release-mismatch');
  assert.equal(artifactMatches(manifesto, pacoteWindows, { arch: 'arm64' }), 'arch-mismatch');
  assert.equal(artifactMatches(manifesto, pacoteWindows, { format: 'zip' }), 'format-mismatch');
  assert.equal(artifactMatches(manifesto, pacoteWindows, { size: 10 }), 'size-mismatch');
  assert.equal(artifactMatches(manifesto, pacoteWindows, { sha256: 'd'.repeat(64) }), 'digest-mismatch');
  // Maiúscula no hexadecimal é o mesmo resumo.
  assert.equal(artifactMatches(manifesto, pacoteWindows, { sha256: 'A'.repeat(64) }), null);
  // `0.9.9-1` e `v0.9.9-1` são a mesma versão.
  assert.equal(artifactMatches(manifesto, pacoteWindows, { version: 'v0.9.9-1' }), null);
});

// ── Elegibilidade ──────────────────────────────────────────────────────────

const base = { manifest: manifesto, installKind: 'windows-installed' as const, arch: 'x64' as const };

test('a revisão é oferecida a quem está na versão que ela corrige', () => {
  assert.equal(ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.9') }), null);
});

test('downgrade automático é bloqueado, e dito', () => {
  const motivo = ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.10') });
  assert.equal(motivo?.reason, 'not-newer');
  // E estar na mesma versão também não é atualização.
  assert.equal(ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.9-1') })?.reason, 'not-newer');
});

test('a 0.8.9 retirada continua bloqueada por esta cópia', () => {
  const conhecidas = new Map([['0.8.9', 'as resoluções e o FPS da transmissão saem errados']]);
  const motivo = ineligibleReason({
    ...base,
    entry: entrada({ releaseId: 'rel-089', version: '0.8.9' }),
    currentVersion: requireVersion('0.8.8'),
    manifest: { ...manifesto, releaseId: 'rel-089', version: '0.8.9' },
    knownBroken: conhecidas,
  });
  assert.equal(motivo?.reason, 'known-broken');
  assert.match(motivo?.detail ?? '', /resoluções/);
});

test('um manifesto de outra release ou de outra versão não vale', () => {
  assert.equal(ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.9'), manifest: { ...manifesto, releaseId: 'outra' } })?.reason, 'manifest-mismatch');
  assert.equal(ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.9'), manifest: { ...manifesto, version: '0.9.9-2' } })?.reason, 'manifest-mismatch');
  assert.equal(ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.9'), manifest: undefined })?.reason, 'manifest-missing');
});

test('uma versão que exige atualizador mais novo é dita, e não some', () => {
  const motivo = ineligibleReason({
    ...base,
    entry: entrada({ releaseId: 'rel-1', version: '1.0.0' }),
    currentVersion: requireVersion('0.9.8'),
    manifest: { ...manifesto, releaseId: 'rel-1', version: '1.0.0', compatibility: { minUpdaterVersion: '0.9.9-1' } },
  });
  assert.equal(motivo?.reason, 'needs-updater');
  assert.match(motivo?.detail ?? '', /0\.9\.9-1/);
});

test('sem pacote para este jeito de instalar, a diferença é dita', () => {
  const motivo = ineligibleReason({ ...base, installKind: 'windows-portable', entry: entrada(), currentVersion: requireVersion('0.9.9') });
  assert.equal(motivo?.reason, 'no-artifact');
  assert.match(motivo?.detail ?? '', /windows-portable/);
});

test('cada recusa tem motivo próprio: "não há atualização" não pode cobrir tudo', () => {
  const motivos = new Set([
    ineligibleReason({ ...base, entry: entrada({ state: 'withdrawn', withdrawn: { reason: 'x', at: '' } }), currentVersion: requireVersion('0.9.9') })?.reason,
    ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.10') })?.reason,
    ineligibleReason({ ...base, entry: entrada(), currentVersion: requireVersion('0.9.9'), manifest: undefined })?.reason,
    ineligibleReason({ ...base, installKind: 'windows-portable', entry: entrada(), currentVersion: requireVersion('0.9.9') })?.reason,
  ]);
  assert.equal(motivos.size, 4);
});
