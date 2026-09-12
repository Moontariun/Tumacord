// Os contratos da distribuição privada.
//
// O que muda na 0.9.9-1: **os aplicativos deixam de consultar o GitHub**. Nem
// para verificar, nem para baixar, nem para aplicar. O repositório continua
// privado e continua sendo onde o código mora, mas quem serve atualização para
// quem usa o Tumacord é a mesma VPS que hospeda o servidor dedicado.
//
// Isto aqui é a metade que **decide e verifica**, e ela é pura de propósito:
// nada neste arquivo fala com a rede, abre arquivo ou executa coisa nenhuma.
// A parte que erra em silêncio quando erra tem de poder ser provada sem
// serviço e sem máquina de ninguém.
//
// ## Os três documentos
//
// 1. **Manifesto de release** — o que é aquela versão e quais pacotes ela tem.
//    Um por release, assinado. Cada pacote traz tamanho, SHA-256, OS,
//    arquitetura, formato e o caminho controlado por onde é baixado.
// 2. **Catálogo** — o que está publicado agora, por canal. Um só, assinado, com
//    sequência própria e validade. É ele que retira uma versão do ar.
// 3. **Compatibilidade** — o que cada versão exige para poder ser instalada:
//    versão mínima de atualizador, protocolo e schema.
//
// ## Por que o catálogo tem sequência própria
//
// Um serviço que voltasse no tempo — por erro ou por alguém no meio do caminho
// — poderia oferecer de volta uma versão que o grupo já deixou para trás. O
// cliente guarda a maior sequência que já aceitou e recusa qualquer catálogo
// abaixo dela, antes de ler o conteúdo.
//
// A sequência **não** substitui a ordem da versão do produto. São perguntas
// diferentes: a sequência diz "este catálogo é mais recente do que aquele", e a
// versão diz "esta build é mais nova do que aquela". Publicar uma retirada
// aumenta a sequência sem oferecer nada novo — e nunca pode virar um convite
// para voltar a uma versão anterior.
//
// ## Por que a assinatura é separada do download
//
// Quem serve os bytes e quem assina o que eles são precisam ser autoridades
// diferentes. Se fossem a mesma, comprometer o servidor de download bastaria
// para entregar qualquer binário como se fosse a versão oficial. A chave
// privada de assinatura vive no ambiente de publicação; a VPS só guarda e
// serve o que já veio assinado, e não sabe assinar nada.

import { type Version, compareVersions, parseVersion, requireVersion } from './version.js';

// ── Algoritmos ──────────────────────────────────────────────────────────────
//
// Ed25519 do `node:crypto` e SHA-256. Nada inventado aqui: a única coisa
// definida por este projeto é **o que exatamente é assinado**, abaixo.

export const SIGNATURE_ALGORITHM = 'ed25519';
export const DIGEST_ALGORITHM = 'sha256';

/** A versão do contrato. Um documento de versão desconhecida é recusado. */
export const CONTRACT_VERSION = 1;

export type Channel = 'stable' | 'test';
export const CHANNELS: readonly Channel[] = ['stable', 'test'];

/** Como uma cópia foi instalada. Decide o pacote e o modo de aplicar. */
export type InstallKind = 'linux-managed' | 'linux-appimage' | 'windows-installed' | 'windows-portable' | 'server-bundle';
export const INSTALL_KINDS: readonly InstallKind[] = ['linux-managed', 'linux-appimage', 'windows-installed', 'windows-portable', 'server-bundle'];

export type Arch = 'x64' | 'arm64';

/** Um pacote de uma release: um arquivo, para um jeito de instalar. */
export interface Artifact {
  /** Identificador estável dentro da release. É por ele que o download pede. */
  artifactId: string;
  os: 'linux' | 'windows' | 'any';
  arch: Arch;
  /** `tar.gz`, `AppImage`, `exe`, `zip`. Junto com `installKind`, decide tudo. */
  format: string;
  installKind: InstallKind;
  fileName: string;
  size: number;
  sha256: string;
  /** Qual chave assinou o manifesto que descreve este pacote. */
  signatureKeyId: string;
  /**
   * O caminho **dentro do armazenamento privado**, e não uma URL.
   *
   * Guardar URL aqui deixaria um documento assinado apontar para fora: bastaria
   * publicar um manifesto com outro domínio para o aplicativo ir buscar binário
   * em qualquer lugar. O serviço monta a URL a partir deste caminho, e confere
   * que ele está dentro do armazenamento.
   */
  storagePath: string;
}

/** O que uma versão exige de quem vai instalá-la. */
export interface Compatibility {
  /** A menor versão do produto que consegue aplicar esta. */
  minUpdaterVersion?: string;
  /** Versão de protocolo entre clientes e servidores. */
  protocol?: number;
  /** Versão do schema de dados do servidor. */
  schema?: number;
  /** A menor versão de servidor que fala com este cliente, e vice-versa. */
  minServerVersion?: string;
  minClientVersion?: string;
}

/** O manifesto de uma release: o que ela é e o que ela tem. */
export interface ReleaseManifest {
  contract: number;
  releaseId: string;
  /** A versão do produto, na forma canônica. */
  version: string;
  channel: Channel;
  /** O commit exato de onde esta release saiu. */
  commit: string;
  createdAt: string;
  title?: string;
  notes?: string;
  compatibility?: Compatibility;
  /**
   * Se esta versão precisa ser instalada antes das seguintes.
   *
   * Pular versões é o normal e é o que se quer. Uma versão que converte dados
   * só a partir do formato imediatamente anterior é a exceção: pular por cima
   * dela deixaria a conversão sem entrada que ela saiba ler.
   */
  requiredStop?: { reason: string };
  artifacts: Artifact[];
}

/** O estado de uma release no catálogo. */
export type ReleaseState = 'published' | 'withdrawn';

export interface CatalogEntry {
  releaseId: string;
  version: string;
  state: ReleaseState;
  publishedAt: string;
  /** O resumo do manifesto, para o cliente saber que baixou o manifesto certo. */
  manifestSha256: string;
  withdrawn?: { reason: string; at: string };
  requiredStop?: { reason: string };
}

export interface Catalog {
  contract: number;
  /** Sequência monotônica do catálogo. Cresce a cada publicação. */
  sequence: number;
  createdAt: string;
  /** Depois disto, este catálogo não vale mais e precisa ser buscado de novo. */
  expiresAt: string;
  channels: Record<Channel, { entries: CatalogEntry[] }>;
}

/**
 * Um documento assinado.
 *
 * A assinatura cobre a **serialização canônica do payload**, definida abaixo.
 * Mais de uma assinatura é permitida de propósito: é o que torna possível
 * trocar de chave sem um instante em que ninguém consegue verificar.
 */
export interface Signed<T> {
  payload: T;
  signatures: { keyId: string; algorithm: string; signature: string }[];
}

/** Uma chave pública em que o aplicativo confia. */
export interface TrustedKey {
  keyId: string;
  algorithm: string;
  /** A chave pública em SPKI DER, base64. */
  publicKey: string;
  /** O que esta chave pode assinar. */
  scope: KeyScope[];
  notBefore?: string;
  notAfter?: string;
  revokedAt?: string;
  revokedReason?: string;
}

/**
 * O que uma chave tem direito de assinar.
 *
 * Separar as duas é o ponto: quem pode **recomendar e retirar** versões — ou
 * seja, mexer no catálogo — não precisa poder **assinar binário novo**. Uma
 * chave de catálogo comprometida consegue esconder uma versão boa; uma chave
 * de manifesto comprometida consegue entregar código. O estrago é de outra
 * ordem, e por isso as chaves são de outra ordem também.
 */
export type KeyScope = 'catalog' | 'manifest';

// ── Serialização canônica ───────────────────────────────────────────────────

/**
 * O que exatamente é assinado.
 *
 * JSON com as chaves de cada objeto em ordem de ponto de código, sem espaço
 * nenhum, em UTF-8. `undefined` não entra; a ordem dos vetores é preservada
 * porque ela é conteúdo.
 *
 * Isto precisa estar definido e ser estável: assinar "o JSON" não define nada
 * — dois `JSON.stringify` da mesma informação podem diferir na ordem das
 * chaves, e a assinatura que vale para um não vale para o outro. Quem
 * verificasse numa linguagem diferente da de quem assinou concluiria que o
 * documento foi adulterado.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('número não finito não tem forma canônica');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(',')}]`;
  if (typeof value === 'object') {
    const entradas = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      // Ordem de ponto de código, que é a que `sort()` dá para strings.
      .sort(([esquerda], [direita]) => (esquerda < direita ? -1 : esquerda > direita ? 1 : 0));
    return `{${entradas.map(([chave, item]) => `${JSON.stringify(chave)}:${canonicalize(item)}`).join(',')}}`;
  }
  throw new Error(`tipo sem forma canônica: ${typeof value}`);
}

// ── Verificação ─────────────────────────────────────────────────────────────

export type VerifyFailure =
  | 'contract-unknown'
  | 'no-signature'
  | 'unknown-key'
  | 'key-revoked'
  | 'key-not-yet-valid'
  | 'key-expired'
  | 'key-wrong-scope'
  | 'bad-signature';

export type VerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; failure: VerifyFailure; detail?: string };

/** Se uma chave pode ser usada agora, para aquele escopo. */
export function keyUsable(key: TrustedKey, scope: KeyScope, now: number): VerifyFailure | null {
  if (key.revokedAt) return 'key-revoked';
  if (!key.scope.includes(scope)) return 'key-wrong-scope';
  if (key.notBefore && Date.parse(key.notBefore) > now) return 'key-not-yet-valid';
  if (key.notAfter && Date.parse(key.notAfter) <= now) return 'key-expired';
  return null;
}

/**
 * Confere as assinaturas de um documento.
 *
 * `verifySignature` é injetado para esta metade continuar pura: quem chama
 * passa a função que sabe usar `node:crypto` ou a Web Crypto. Basta **uma**
 * assinatura válida de uma chave utilizável — é isso que permite trocar de
 * chave publicando com as duas por um tempo.
 *
 * A falha é sempre dita com o motivo. "Não verificou" e "verificou e está
 * errado" precisam ser distinguíveis: o primeiro pode ser um cliente velho
 * diante de uma chave nova, e o segundo é adulteração.
 */
export function verifySigned<T extends { contract?: number }>(
  document: Signed<T>,
  keys: readonly TrustedKey[],
  scope: KeyScope,
  verifySignature: (publicKey: string, data: string, signature: string, algorithm: string) => boolean,
  now: number = Date.now(),
): VerifyResult {
  if (!document || typeof document !== 'object' || !document.payload) return { ok: false, failure: 'no-signature' };
  const contrato = document.payload.contract;
  if (contrato !== CONTRACT_VERSION) return { ok: false, failure: 'contract-unknown', detail: String(contrato) };
  const assinaturas = Array.isArray(document.signatures) ? document.signatures : [];
  if (!assinaturas.length) return { ok: false, failure: 'no-signature' };

  const dados = canonicalize(document.payload);
  let ultimaFalha: VerifyFailure = 'unknown-key';
  let detalhe = '';
  for (const assinatura of assinaturas) {
    const chave = keys.find((candidate) => candidate.keyId === assinatura.keyId);
    if (!chave) { ultimaFalha = 'unknown-key'; detalhe = assinatura.keyId; continue; }
    const impedimento = keyUsable(chave, scope, now);
    if (impedimento) { ultimaFalha = impedimento; detalhe = chave.keyId; continue; }
    if (assinatura.algorithm !== chave.algorithm) { ultimaFalha = 'bad-signature'; detalhe = assinatura.keyId; continue; }
    if (verifySignature(chave.publicKey, dados, assinatura.signature, assinatura.algorithm)) {
      return { ok: true, keyId: chave.keyId };
    }
    ultimaFalha = 'bad-signature';
    detalhe = assinatura.keyId;
  }
  return { ok: false, failure: ultimaFalha, detail: detalhe || undefined };
}

// ── Frescor do catálogo ─────────────────────────────────────────────────────

export type CatalogFreshness = 'ok' | 'expired' | 'replayed' | 'malformed';

/**
 * Se um catálogo pode ser usado para decidir alguma coisa.
 *
 * Vencido e repetido são recusas **antes** de olhar o conteúdo. E a recusa é
 * falha segura: sem saber qual é a política vigente, não se instala nada. O
 * caminho errado seria aceitar o catálogo velho "porque é o que temos" —
 * exatamente o que alguém no meio do caminho precisaria para segurar a
 * correção que retira uma versão defeituosa.
 */
export function catalogFreshness(catalog: Catalog | null | undefined, acceptedSequence: number, now: number): CatalogFreshness {
  if (!catalog || typeof catalog !== 'object') return 'malformed';
  if (catalog.contract !== CONTRACT_VERSION) return 'malformed';
  if (!Number.isSafeInteger(catalog.sequence) || catalog.sequence < 0) return 'malformed';
  if (catalog.sequence < acceptedSequence) return 'replayed';
  const expira = Date.parse(catalog.expiresAt ?? '');
  if (!Number.isFinite(expira)) return 'malformed';
  if (expira <= now) return 'expired';
  return 'ok';
}

// ── Escolha do pacote ───────────────────────────────────────────────────────

/**
 * O pacote deste manifesto que serve para esta máquina.
 *
 * A escolha é por **OS, arquitetura e jeito de instalar**, os três, e por
 * igualdade. Nunca "o primeiro arquivo com nome parecido": um nome é uma
 * convenção que muda, e entregar um instalador do Windows para uma cópia de
 * Linux — ou um NSIS para um portable — é o tipo de erro que só aparece na
 * máquina de alguém.
 */
export function selectArtifact(manifest: ReleaseManifest, installKind: InstallKind, arch: Arch): Artifact | null {
  const candidatos = (manifest?.artifacts ?? []).filter((artifact) => artifact
    && artifact.installKind === installKind
    && artifact.arch === arch
    && artifactIsWellFormed(artifact));
  if (candidatos.length !== 1) {
    // Zero: esta versão não tem pacote para este jeito de instalar, e isso é
    // dito. Dois ou mais: o manifesto é ambíguo, e escolher um deles seria
    // adivinhar — a ambiguidade para a operação em vez de virar sorteio.
    return null;
  }
  return candidatos[0];
}

/** Se um pacote tem tudo o que é preciso para ser baixado com segurança. */
export function artifactIsWellFormed(artifact: Artifact | null | undefined): boolean {
  if (!artifact || typeof artifact !== 'object') return false;
  if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? '').toLowerCase())) return false;
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) return false;
  if (!artifact.artifactId || !artifact.fileName) return false;
  if (!INSTALL_KINDS.includes(artifact.installKind)) return false;
  // Caminho de armazenamento é relativo, sem subir de diretório e sem virar
  // URL. Um `..` aqui sairia do armazenamento privado; um `https://` mandaria
  // o aplicativo buscar binário em outro domínio.
  return isSafeStoragePath(artifact.storagePath);
}

/** Um caminho que não escapa do armazenamento privado. */
export function isSafeStoragePath(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (candidate.length > 512) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return false;
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return false;
  if (candidate.includes('\0') || candidate.includes('\\')) return false;
  return candidate.split('/').every((segmento) => segmento !== '' && segmento !== '.' && segmento !== '..' && /^[A-Za-z0-9._-]+$/.test(segmento));
}

// ── Concordância entre manifesto e pacote ───────────────────────────────────

export type MatchFailure = 'version-mismatch' | 'release-mismatch' | 'arch-mismatch' | 'format-mismatch' | 'digest-mismatch' | 'size-mismatch';

/**
 * Se o que foi baixado é o que o manifesto prometeu.
 *
 * Conferir só o resumo não basta: um pacote íntegro da arquitetura errada
 * passa no resumo e falha na máquina. Versão, release, arquitetura e formato
 * são conferidos junto, e a conferência é refeita antes de executar.
 */
export function artifactMatches(
  manifest: ReleaseManifest,
  artifact: Artifact,
  observed: { sha256?: string; size?: number; version?: string; releaseId?: string; arch?: string; format?: string },
): MatchFailure | null {
  if (observed.releaseId !== undefined && observed.releaseId !== manifest.releaseId) return 'release-mismatch';
  if (observed.version !== undefined) {
    const esperada = parseVersion(manifest.version);
    const vista = parseVersion(observed.version);
    if (!esperada || !vista || compareVersions(esperada, vista) !== 0) return 'version-mismatch';
  }
  if (observed.arch !== undefined && observed.arch !== artifact.arch) return 'arch-mismatch';
  if (observed.format !== undefined && observed.format !== artifact.format) return 'format-mismatch';
  if (observed.size !== undefined && observed.size !== artifact.size) return 'size-mismatch';
  if (observed.sha256 !== undefined && String(observed.sha256).toLowerCase() !== String(artifact.sha256).toLowerCase()) return 'digest-mismatch';
  return null;
}

// ── Ordem e elegibilidade ───────────────────────────────────────────────────

export interface EligibilityInput {
  entry: CatalogEntry;
  manifest: ReleaseManifest | undefined;
  currentVersion: Version;
  installKind: InstallKind;
  arch: Arch;
  /** Versões que esta cópia já sabia estarem quebradas quando foi compilada. */
  knownBroken?: ReadonlyMap<string, string>;
}

export type Ineligible =
  | { reason: 'not-published'; detail: string }
  | { reason: 'withdrawn'; detail: string }
  | { reason: 'known-broken'; detail: string }
  | { reason: 'not-newer'; detail: string }
  | { reason: 'manifest-missing'; detail: string }
  | { reason: 'manifest-mismatch'; detail: string }
  | { reason: 'needs-updater'; detail: string }
  | { reason: 'no-artifact'; detail: string };

/**
 * Se uma entrada do catálogo pode ser oferecida a esta cópia.
 *
 * Devolve `null` quando pode, e o motivo quando não. O motivo não é enfeite:
 * ele aparece na tela, e "não há atualização" quando existe uma que não serve
 * manda a pessoa procurar defeito no lugar errado.
 *
 * **Downgrade automático é bloqueado aqui.** Voltar para uma versão anterior é
 * uma operação legítima, mas é uma decisão de quem opera — não é algo que um
 * catálogo possa provocar sozinho.
 */
export function ineligibleReason(input: EligibilityInput): Ineligible | null {
  const { entry, manifest, currentVersion, installKind, arch } = input;
  const versao = parseVersion(entry.version);
  if (!versao) return { reason: 'not-published', detail: 'versão fora da convenção do produto' };
  if (entry.state === 'withdrawn') {
    return { reason: 'withdrawn', detail: entry.withdrawn?.reason || 'esta versão foi retirada' };
  }
  if (entry.state !== 'published') return { reason: 'not-published', detail: String(entry.state) };

  const quebrada = input.knownBroken?.get(versao.text);
  if (quebrada) return { reason: 'known-broken', detail: quebrada };

  if (compareVersions(versao, currentVersion) <= 0) {
    return { reason: 'not-newer', detail: 'esta versão não é mais nova do que a instalada' };
  }
  if (!manifest) return { reason: 'manifest-missing', detail: 'o manifesto desta versão não veio assinado' };
  if (manifest.releaseId !== entry.releaseId) return { reason: 'manifest-mismatch', detail: 'o manifesto é de outra release' };
  const doManifesto = parseVersion(manifest.version);
  if (!doManifesto || compareVersions(doManifesto, versao) !== 0) {
    return { reason: 'manifest-mismatch', detail: 'o manifesto declara outra versão' };
  }

  const minimo = manifest.compatibility?.minUpdaterVersion;
  if (minimo) {
    const exigida = parseVersion(minimo);
    if (exigida && compareVersions(currentVersion, exigida) < 0) {
      return { reason: 'needs-updater', detail: `esta versão precisa da ${exigida.text} instalada antes` };
    }
  }
  if (!selectArtifact(manifest, installKind, arch)) {
    return { reason: 'no-artifact', detail: `não há pacote para ${installKind} ${arch} nesta versão` };
  }
  return null;
}

/** A versão do produto de uma entrada, ou `null` se ela não for uma. */
export function entryVersion(entry: CatalogEntry): Version | null {
  return parseVersion(entry?.version);
}

/** Valida uma versão e devolve a forma canônica, ou lança. */
export function canonicalVersion(input: unknown): string {
  return requireVersion(input).text;
}
