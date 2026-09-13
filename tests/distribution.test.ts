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

const manifestKey = generateSigningKey();
const catalogKey = generateSigningKey();

const trusted: TrustedKey[] = [
  { ...manifestKey, scope: ['manifest'] },
  { ...catalogKey, scope: ['catalog'] },
];

const windowsArtifact: Artifact = {
  artifactId: 'win-x64-nsis',
  os: 'windows', arch: 'x64', format: 'exe', installKind: 'windows-installed',
  fileName: 'Tumacord-0.9.10-Setup.exe',
  size: 120_000_000,
  sha256: 'a'.repeat(64),
  signatureKeyId: manifestKey.keyId,
  storagePath: 'releases/0.9.10/Tumacord-0.9.10-Setup.exe',
};

const linuxArtifact: Artifact = {
  ...windowsArtifact,
  artifactId: 'linux-x64-tar',
  os: 'linux', format: 'tar.gz', installKind: 'linux-managed',
  fileName: 'tumacord-0.9.10.tar.gz',
  sha256: 'b'.repeat(64),
  storagePath: 'releases/0.9.10/tumacord-0.9.10.tar.gz',
};

const manifest: ReleaseManifest = {
  contract: CONTRACT_VERSION,
  releaseId: 'rel-0910',
  version: '0.9.10',
  channel: 'stable',
  commit: '0'.repeat(40),
  createdAt: '2026-09-12T10:00:00.000Z',
  artifacts: [windowsArtifact, linuxArtifact],
};

function entry(extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    releaseId: 'rel-0910', version: '0.9.10', state: 'published',
    publishedAt: '2026-09-12T10:00:00.000Z',
    manifestSha256: documentDigest(manifest),
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
  const signedDocument = signDocument(manifest, [manifestKey]);
  assert.deepEqual(verifySigned(signedDocument, trusted, 'manifest', verifySignature), { ok: true, keyId: manifestKey.keyId });

  // Um byte do resumo trocado: o pacote passaria a ser outro arquivo.
  const tampered = { ...signedDocument, payload: { ...manifest, artifacts: [{ ...windowsArtifact, sha256: 'c'.repeat(64) }, linuxArtifact] } };
  assert.deepEqual(verifySigned(tampered, trusted, 'manifest', verifySignature), { ok: false, failure: 'bad-signature', detail: manifestKey.keyId });
});

test('quem pode mexer no catálogo não pode assinar binário novo', () => {
  // O ponto da separação: uma chave de catálogo comprometida esconde uma
  // versão boa; uma de manifesto entrega código. Não é o mesmo estrago.
  const withCatalog = signDocument(manifest, [catalogKey]);
  const outcome = verifySigned(withCatalog, trusted, 'manifest', verifySignature);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.failure, 'key-wrong-scope');
});

test('uma chave desconhecida não vale, mesmo com assinatura correta', () => {
  const intruder = generateSigningKey();
  const signedDocument = signDocument(manifest, [intruder]);
  const outcome = verifySigned(signedDocument, trusted, 'manifest', verifySignature);
  assert.equal(outcome.ok === false && outcome.failure, 'unknown-key');
});

test('um documento sem assinatura nenhuma é recusado', () => {
  assert.equal(verifySigned({ payload: manifest, signatures: [] }, trusted, 'manifest', verifySignature).ok, false);
});

test('contrato desconhecido é recusado antes de qualquer verificação', () => {
  const future = signDocument({ ...manifest, contract: 99 }, [manifestKey]);
  const outcome = verifySigned(future, trusted, 'manifest', verifySignature);
  assert.equal(outcome.ok === false && outcome.failure, 'contract-unknown');
});

// Rotação: durante a troca, o mesmo documento sai assinado pelas duas chaves,
// e ninguém fica sem conseguir verificar.
test('duas assinaturas permitem trocar de chave sem ninguém ficar de fora', () => {
  const rotated = generateSigningKey();
  const signedDocument = signDocument(manifest, [manifestKey, rotated]);

  // Quem ainda só conhece a chave velha verifica.
  assert.equal(verifySigned(signedDocument, trusted, 'manifest', verifySignature).ok, true);
  // Quem já só conhece a nova também.
  assert.equal(verifySigned(signedDocument, [{ ...rotated, scope: ['manifest'] }], 'manifest', verifySignature).ok, true);
});

test('uma chave revogada para de valer, e o motivo é dito', () => {
  const revoked: TrustedKey[] = [{ ...manifestKey, scope: ['manifest'], revokedAt: '2026-09-01T00:00:00.000Z', revokedReason: 'saiu da máquina de publicação' }];
  const signedDocument = signDocument(manifest, [manifestKey]);
  assert.equal(verifySigned(signedDocument, revoked, 'manifest', verifySignature).ok === false && verifySigned(signedDocument, revoked, 'manifest', verifySignature).failure, 'key-revoked');
});

test('uma chave fora da validade não assina nem verifica', () => {
  const now = Date.parse('2026-09-12T00:00:00.000Z');
  assert.equal(keyUsable({ ...manifestKey, scope: ['manifest'], notBefore: '2026-10-01T00:00:00.000Z' }, 'manifest', now), 'key-not-yet-valid');
  assert.equal(keyUsable({ ...manifestKey, scope: ['manifest'], notAfter: '2026-01-01T00:00:00.000Z' }, 'manifest', now), 'key-expired');
  assert.equal(keyUsable({ ...manifestKey, scope: ['manifest'] }, 'manifest', now), null);
});

// ── Frescor do catálogo ────────────────────────────────────────────────────

function catalog(extra: Partial<Catalog> = {}): Catalog {
  return {
    contract: CONTRACT_VERSION,
    sequence: 7,
    createdAt: '2026-09-12T10:00:00.000Z',
    expiresAt: '2026-09-13T10:00:00.000Z',
    channels: { stable: { entries: [entry()] }, test: { entries: [] } },
    ...extra,
  };
}

const now = Date.parse('2026-09-12T12:00:00.000Z');

test('um catálogo vencido não decide nada', () => {
  assert.equal(catalogFreshness(catalog(), 0, now), 'ok');
  assert.equal(catalogFreshness(catalog({ expiresAt: '2026-09-12T11:00:00.000Z' }), 0, now), 'expired');
});

test('um catálogo repetido é recusado antes de ler o conteúdo', () => {
  // O ataque: devolver um catálogo antigo para segurar a retirada de uma
  // versão defeituosa, ou para reoferecer uma que o grupo deixou para trás.
  assert.equal(catalogFreshness(catalog({ sequence: 6 }), 7, now), 'replayed');
  assert.equal(catalogFreshness(catalog({ sequence: 7 }), 7, now), 'ok', 'o mesmo catálogo continua valendo');
  assert.equal(catalogFreshness(catalog({ sequence: 8 }), 7, now), 'ok');
});

test('catálogo torto é recusado, e não tratado como vazio', () => {
  assert.equal(catalogFreshness(null, 0, now), 'malformed');
  assert.equal(catalogFreshness(catalog({ contract: 99 }), 0, now), 'malformed');
  assert.equal(catalogFreshness(catalog({ sequence: -1 }), 0, now), 'malformed');
  assert.equal(catalogFreshness(catalog({ expiresAt: 'ontem' }), 0, now), 'malformed');
});

// A sequência do catálogo não é a ordem da versão do produto.
test('aumentar a sequência para retirar uma versão não oferece downgrade', () => {
  const withdrawn = catalog({
    sequence: 8,
    channels: {
      stable: { entries: [entry({ state: 'withdrawn', withdrawn: { reason: 'o áudio sai errado', at: '2026-09-12T11:00:00.000Z' } })] },
      test: { entries: [] },
    },
  });
  assert.equal(catalogFreshness(withdrawn, 7, now), 'ok');
  const reason = ineligibleReason({
    entry: withdrawn.channels.stable.entries[0], manifest: manifest,
    currentVersion: requireVersion('0.9.10'), installKind: 'windows-installed', arch: 'x64',
  });
  assert.equal(reason?.reason, 'withdrawn');
});

// ── Escolha de pacote ──────────────────────────────────────────────────────

test('o pacote é escolhido por OS, arquitetura e jeito de instalar, os três', () => {
  assert.equal(selectArtifact(manifest, 'windows-installed', 'x64')?.artifactId, 'win-x64-nsis');
  assert.equal(selectArtifact(manifest, 'linux-managed', 'x64')?.artifactId, 'linux-x64-tar');
  // Um portable não recebe o instalador NSIS por engano.
  assert.equal(selectArtifact(manifest, 'windows-portable', 'x64'), null);
  assert.equal(selectArtifact(manifest, 'windows-installed', 'arm64'), null);
});

test('um manifesto ambíguo não vira sorteio', () => {
  const duplicated = { ...manifest, artifacts: [windowsArtifact, { ...windowsArtifact, artifactId: 'outro', fileName: 'outro.exe' }] };
  assert.equal(selectArtifact(duplicated, 'windows-installed', 'x64'), null, 'dois pacotes para o mesmo alvo param a escolha');
});

test('pacote sem resumo, sem tamanho ou com caminho torto é tratado como inexistente', () => {
  for (const broken of [
    { ...windowsArtifact, sha256: 'nao-e-hash' },
    { ...windowsArtifact, sha256: 'A'.repeat(63) },
    { ...windowsArtifact, size: 0 },
    { ...windowsArtifact, size: -1 },
    { ...windowsArtifact, storagePath: '../../etc/passwd' },
    { ...windowsArtifact, storagePath: 'https://outro-dominio/x.exe' },
    { ...windowsArtifact, storagePath: '/absoluto/x.exe' },
  ]) {
    assert.equal(selectArtifact({ ...manifest, artifacts: [broken] }, 'windows-installed', 'x64'), null, JSON.stringify(broken.storagePath ?? broken.sha256));
  }
});

test('o caminho de armazenamento não escapa nem vira URL', () => {
  assert.equal(isSafeStoragePath('releases/0.9.10/arquivo.exe'), true);
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
  assert.equal(artifactMatches(manifest, windowsArtifact, { sha256: 'a'.repeat(64), size: 120_000_000, version: '0.9.10', releaseId: 'rel-0910', arch: 'x64', format: 'exe' }), null);
  assert.equal(artifactMatches(manifest, windowsArtifact, { version: '0.9.9' }), 'version-mismatch');
  assert.equal(artifactMatches(manifest, windowsArtifact, { releaseId: 'outra' }), 'release-mismatch');
  assert.equal(artifactMatches(manifest, windowsArtifact, { arch: 'arm64' }), 'arch-mismatch');
  assert.equal(artifactMatches(manifest, windowsArtifact, { format: 'zip' }), 'format-mismatch');
  assert.equal(artifactMatches(manifest, windowsArtifact, { size: 10 }), 'size-mismatch');
  assert.equal(artifactMatches(manifest, windowsArtifact, { sha256: 'd'.repeat(64) }), 'digest-mismatch');
  // Maiúscula no hexadecimal é o mesmo resumo.
  assert.equal(artifactMatches(manifest, windowsArtifact, { sha256: 'A'.repeat(64) }), null);
  // `0.9.10` e `v0.9.10` são a mesma versão.
  assert.equal(artifactMatches(manifest, windowsArtifact, { version: 'v0.9.10' }), null);
});

// ── Elegibilidade ──────────────────────────────────────────────────────────

const base = { manifest: manifest, installKind: 'windows-installed' as const, arch: 'x64' as const };

test('a correção é oferecida a quem está na versão que ela corrige', () => {
  assert.equal(ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.9') }), null);
});

test('downgrade automático é bloqueado, e dito', () => {
  const reason = ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.11') });
  assert.equal(reason?.reason, 'not-newer');
  // E estar na mesma versão também não é atualização.
  assert.equal(ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.10') })?.reason, 'not-newer');
  // Sob SemVer, uma pré-versão do mesmo número está ABAIXO da final: quem já
  // está na 0.9.10 não recebe a 0.9.10-rc.1 como se fosse novidade.
  assert.equal(ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.10') })?.reason, 'not-newer');
});

test('a 0.8.9 retirada continua bloqueada por esta cópia', () => {
  const known = new Map([['0.8.9', 'as resoluções e o FPS da transmissão saem errados']]);
  const reason = ineligibleReason({
    ...base,
    entry: entry({ releaseId: 'rel-089', version: '0.8.9' }),
    currentVersion: requireVersion('0.8.8'),
    manifest: { ...manifest, releaseId: 'rel-089', version: '0.8.9' },
    knownBroken: known,
  });
  assert.equal(reason?.reason, 'known-broken');
  assert.match(reason?.detail ?? '', /resoluções/);
});

test('um manifesto de outra release ou de outra versão não vale', () => {
  assert.equal(ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.9'), manifest: { ...manifest, releaseId: 'outra' } })?.reason, 'manifest-mismatch');
  assert.equal(ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.9'), manifest: { ...manifest, version: '0.9.9-2' } })?.reason, 'manifest-mismatch');
  assert.equal(ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.9'), manifest: undefined })?.reason, 'manifest-missing');
});

test('uma versão que exige atualizador mais novo é dita, e não some', () => {
  const reason = ineligibleReason({
    ...base,
    entry: entry({ releaseId: 'rel-1', version: '1.0.0' }),
    currentVersion: requireVersion('0.9.8'),
    manifest: { ...manifest, releaseId: 'rel-1', version: '1.0.0', compatibility: { minUpdaterVersion: '0.9.10' } },
  });
  assert.equal(reason?.reason, 'needs-updater');
  assert.match(reason?.detail ?? '', /0\.9\.10/);
});

test('sem pacote para este jeito de instalar, a diferença é dita', () => {
  const reason = ineligibleReason({ ...base, installKind: 'windows-portable', entry: entry(), currentVersion: requireVersion('0.9.9') });
  assert.equal(reason?.reason, 'no-artifact');
  assert.match(reason?.detail ?? '', /windows-portable/);
});

test('cada recusa tem motivo próprio: "não há atualização" não pode cobrir tudo', () => {
  const reasons = new Set([
    ineligibleReason({ ...base, entry: entry({ state: 'withdrawn', withdrawn: { reason: 'x', at: '' } }), currentVersion: requireVersion('0.9.9') })?.reason,
    ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.10') })?.reason,
    ineligibleReason({ ...base, entry: entry(), currentVersion: requireVersion('0.9.9'), manifest: undefined })?.reason,
    ineligibleReason({ ...base, installKind: 'windows-portable', entry: entry(), currentVersion: requireVersion('0.9.9') })?.reason,
  ]);
  assert.equal(reasons.size, 4);
});
