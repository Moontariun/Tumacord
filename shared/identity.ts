// A identidade verificável de uma pessoa num grupo P2P.
//
// ## O problema que isto fecha
//
// No P2P cada computador tem o próprio servidor embutido, e a troca de host
// faz todo mundo autenticar de novo no servidor de quem assumiu. Até a 0.9.9 a
// conta nascia lá com a senha que chegasse primeiro: quem entrasse num host
// novo com o apelido de outra pessoa ficava com ele — e com o direito de
// editar e apagar as mensagens dela, porque no P2P a identidade de uma
// mensagem é o apelido normalizado.
//
// Senha por host não resolve: cada host só conhece a senha que recebeu. O que
// atravessa hosts é uma chave. Cada dispositivo tem um par Ed25519, e um nome
// dentro de um grupo pertence a quem assinou o claim dele.
//
// ## O que o grupo é
//
// O resumo SHA-256 da chave do convite, e não a chave: um claim viaja para
// todo participante e para o disco de cada um, e a chave abre a call. Na rede
// local sem convite o grupo é `local-network`.
//
// ## Precedência sem o relógio de ninguém
//
// Dois dispositivos que reivindicam o mesmo nome enquanto o grupo está
// dividido produzem dois claims válidos. Decidir pelo `issuedAt` assinado
// entregaria o nome a quem atrasasse o próprio relógio. Por isso a precedência
// é `firstSeenAt`, que cada host carimba ao receber e que quem reivindica não
// assina. Hosts diferentes podem chegar a titulares provisórios diferentes — e
// é por isso que a colisão fica **provisória** até uma liberação explícita, e
// não é resolvida em silêncio.
//
// ## O que é puro aqui
//
// O formato do que é assinado, a mescla e a decisão de login não falam com
// rede, disco nem chaveiro; a verificação criptográfica entra injetada. O
// servidor, o processo principal do desktop e os testes decidem igual.

export const IDENTITY_CONTRACT = 1;

/** O grupo de quem está na rede local sem convite. */
export const LOCAL_NETWORK_GROUP = 'local-network';

/** Quantos registros uma mescla aceita de uma vez, e quantos cabem numa página. */
export const MAX_BATCH = 200;

/** Quantos registros um grupo guarda, somando claims e liberações. */
export const MAX_RECORDS_PER_GROUP = 5_000;

/** Quanto adiantado um carimbo pode estar antes de ser recusado. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** Quanto tempo um desafio de login vale. */
export const NONCE_TTL_MS = 60_000;

// Cada propósito assina num domínio próprio: uma assinatura de login não pode
// ser reapresentada como claim, nem uma liberação como login.
const CLAIM_DOMAIN = 'tumacord/identity/claim/v1';
const RELEASE_DOMAIN = 'tumacord/identity/release/v1';
const LOGIN_DOMAIN = 'tumacord/identity/login/v1';

export interface IdentityClaim {
  contract: number;
  group: string;
  /** O nome normalizado, que é o que decide de quem é uma mensagem. */
  name: string;
  /** Como a pessoa escreve o próprio nome. */
  displayName: string;
  /** SPKI DER em base64. */
  publicKey: string;
  issuedAt: string;
  /** Vinculou uma conta que já existia por senha, antes desta versão. */
  legacy: boolean;
  signature: string;
}

export interface IdentityRelease {
  contract: number;
  group: string;
  name: string;
  publicKey: string;
  releasedAt: string;
  signature: string;
}

export interface LedgerEntry {
  claim: IdentityClaim;
  /** Quando **este** host o viu pela primeira vez. Não é assinado. */
  firstSeenAt: string;
  /** A ordem de chegada neste host. É o cursor da sincronização. */
  sequence: number;
}

export interface ReleaseEntry {
  release: IdentityRelease;
  firstSeenAt: string;
  sequence: number;
}

export interface IdentityLedger {
  entries: LedgerEntry[];
  /** As liberações ficam para sempre: sem elas, um claim antigo voltaria. */
  releases: ReleaseEntry[];
  /** O último número de sequência dado neste host. */
  sequence: number;
}

export interface LoginProof {
  group: string;
  name: string;
  nonce: string;
  publicKey: string;
  signature: string;
}

export type SignatureVerifier = (publicKey: string, message: string, signature: string) => boolean;

export function emptyLedger(): IdentityLedger {
  return { entries: [], releases: [], sequence: 0 };
}

/**
 * O nome como ele é comparado.
 *
 * É a regra que o servidor sempre usou — `normalizeUsername` passou a chamar
 * esta —, e ela mora aqui porque o processo principal do desktop monta a prova
 * de login com ela. Se as duas pontas normalizassem diferente, um nome com
 * acento nunca conferiria.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

/** Caractere de controle esconde o que vem depois dele numa tela ou num log. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isGroupId(value: unknown): value is string {
  return value === LOCAL_NETWORK_GROUP || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && value === value.trim() && !hasControlCharacter(value);
}

function isEncoded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 4 && value.length <= max && BASE64.test(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** JSON com as chaves em ordem: o mesmo registro produz sempre os mesmos bytes. */
function canonical(fields: Record<string, string | number | boolean>): string {
  const ordered: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(fields).sort()) ordered[key] = fields[key];
  return JSON.stringify(ordered);
}

export function claimMessage(claim: Omit<IdentityClaim, 'signature'>): string {
  return [CLAIM_DOMAIN, canonical({
    contract: claim.contract,
    group: claim.group,
    name: claim.name,
    displayName: claim.displayName,
    publicKey: claim.publicKey,
    issuedAt: claim.issuedAt,
    legacy: claim.legacy,
  })].join('\n');
}

export function releaseMessage(release: Omit<IdentityRelease, 'signature'>): string {
  return [RELEASE_DOMAIN, canonical({
    contract: release.contract,
    group: release.group,
    name: release.name,
    publicKey: release.publicKey,
    releasedAt: release.releasedAt,
  })].join('\n');
}

export function loginMessage(proof: Omit<LoginProof, 'signature'>): string {
  return [LOGIN_DOMAIN, canonical({ group: proof.group, name: proof.name, nonce: proof.nonce, publicKey: proof.publicKey })].join('\n');
}

export function claimShapeIsValid(value: unknown): value is IdentityClaim {
  if (!value || typeof value !== 'object') return false;
  const claim = value as IdentityClaim;
  return claim.contract === IDENTITY_CONTRACT && isGroupId(claim.group) && isName(claim.name) && isName(claim.displayName)
    && isEncoded(claim.publicKey, 128) && isInstant(claim.issuedAt) && typeof claim.legacy === 'boolean'
    && isEncoded(claim.signature, 128);
}

export function releaseShapeIsValid(value: unknown): value is IdentityRelease {
  if (!value || typeof value !== 'object') return false;
  const release = value as IdentityRelease;
  return release.contract === IDENTITY_CONTRACT && isGroupId(release.group) && isName(release.name)
    && isEncoded(release.publicKey, 128) && isInstant(release.releasedAt) && isEncoded(release.signature, 128);
}

export function loginProofShapeIsValid(value: unknown): value is LoginProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as LoginProof;
  return isGroupId(proof.group) && isName(proof.name) && isNonce(proof.nonce)
    && isEncoded(proof.publicKey, 128) && isEncoded(proof.signature, 128);
}

/** Uma chave malformada faz a verificação lançar; isso é "não confere", e não queda. */
function safely(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

export function verifyClaim(value: unknown, verify: SignatureVerifier): boolean {
  if (!claimShapeIsValid(value)) return false;
  const claim = value;
  return safely(() => verify(claim.publicKey, claimMessage(claim), claim.signature));
}

export function verifyRelease(value: unknown, verify: SignatureVerifier): boolean {
  if (!releaseShapeIsValid(value)) return false;
  const release = value;
  return safely(() => verify(release.publicKey, releaseMessage(release), release.signature));
}

export function verifyLoginProof(value: unknown, verify: SignatureVerifier): boolean {
  if (!loginProofShapeIsValid(value)) return false;
  const proof = value;
  return safely(() => verify(proof.publicKey, loginMessage(proof), proof.signature));
}

/** Se uma liberação assinada pela mesma chave, depois do claim, vale para ele. */
export function isReleased(claim: IdentityClaim, releases: readonly ReleaseEntry[]): boolean {
  const issued = Date.parse(claim.issuedAt);
  return releases.some(({ release }) => release.group === claim.group && release.name === claim.name
    && release.publicKey === claim.publicKey && Date.parse(release.releasedAt) >= issued);
}

function precedes(left: LedgerEntry, right: LedgerEntry): number {
  return Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt)
    || left.sequence - right.sequence
    || (left.claim.publicKey < right.claim.publicKey ? -1 : left.claim.publicKey > right.claim.publicKey ? 1 : 0);
}

export type NameStatus =
  | { state: 'free' }
  | { state: 'bound'; holder: LedgerEntry }
  | { state: 'contested'; holder: LedgerEntry; contenders: LedgerEntry[] };

export function statusOfName(ledger: IdentityLedger, group: string, name: string): NameStatus {
  const byKey = new Map<string, LedgerEntry>();
  for (const entry of ledger.entries) {
    if (entry.claim.group !== group || entry.claim.name !== name) continue;
    if (isReleased(entry.claim, ledger.releases)) continue;
    const current = byKey.get(entry.claim.publicKey);
    if (!current || precedes(entry, current) < 0) byKey.set(entry.claim.publicKey, entry);
  }
  const ordered = [...byKey.values()].sort(precedes);
  if (!ordered.length) return { state: 'free' };
  if (ordered.length === 1) return { state: 'bound', holder: ordered[0] };
  return { state: 'contested', holder: ordered[0], contenders: ordered.slice(1) };
}

export type RejectReason = 'shape' | 'group' | 'future' | 'signature' | 'released' | 'limit' | 'capacity';

export interface MergeOutcome {
  ledger: IdentityLedger;
  added: LedgerEntry[];
  released: ReleaseEntry[];
  rejected: Array<{ reason: RejectReason; name?: string }>;
}

export interface MergeOptions {
  verify: SignatureVerifier;
  /** Os grupos deste host. Um claim de outro grupo não tem o que fazer aqui. */
  acceptedGroups: ReadonlySet<string>;
  now: number;
  maxRecordsPerGroup?: number;
}

/**
 * Junta o que chegou ao que este host já sabe.
 *
 * Não altera o registro recebido: devolve outro. Quem chama decide gravar, e
 * uma falha no meio não deixa metade de um lote aplicada.
 */
export function mergeLedger(current: IdentityLedger, incoming: { claims?: unknown; releases?: unknown }, options: MergeOptions): MergeOutcome {
  const entries = [...current.entries];
  const releases = [...current.releases];
  let sequence = current.sequence;
  const added: LedgerEntry[] = [];
  const releasedNow: ReleaseEntry[] = [];
  const rejected: MergeOutcome['rejected'] = [];
  const capacity = options.maxRecordsPerGroup ?? MAX_RECORDS_PER_GROUP;
  const firstSeenAt = new Date(options.now).toISOString();

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.claim.group, (counts.get(entry.claim.group) ?? 0) + 1);
  for (const entry of releases) counts.set(entry.release.group, (counts.get(entry.release.group) ?? 0) + 1);
  const full = (group: string) => (counts.get(group) ?? 0) >= capacity;
  const occupy = (group: string) => counts.set(group, (counts.get(group) ?? 0) + 1);

  const incomingReleases = Array.isArray(incoming.releases) ? incoming.releases : [];
  const incomingClaims = Array.isArray(incoming.claims) ? incoming.claims : [];
  for (let index = MAX_BATCH; index < incomingReleases.length; index += 1) rejected.push({ reason: 'limit' });
  for (let index = MAX_BATCH; index < incomingClaims.length; index += 1) rejected.push({ reason: 'limit' });

  // Liberações primeiro: um lote que traz o claim e a liberação dele não pode
  // deixar o claim ativo por causa da ordem em que os dois vieram.
  for (const candidate of incomingReleases.slice(0, MAX_BATCH)) {
    if (!releaseShapeIsValid(candidate)) { rejected.push({ reason: 'shape' }); continue; }
    if (!options.acceptedGroups.has(candidate.group)) { rejected.push({ reason: 'group', name: candidate.name }); continue; }
    if (Date.parse(candidate.releasedAt) > options.now + CLOCK_SKEW_MS) { rejected.push({ reason: 'future', name: candidate.name }); continue; }
    if (!verifyRelease(candidate, options.verify)) { rejected.push({ reason: 'signature', name: candidate.name }); continue; }
    // Ed25519 é determinística: a mesma liberação tem sempre a mesma assinatura.
    if (releases.some((entry) => entry.release.signature === candidate.signature)) continue;
    if (full(candidate.group)) { rejected.push({ reason: 'capacity', name: candidate.name }); continue; }
    sequence += 1;
    const entry = { release: candidate, firstSeenAt, sequence };
    releases.push(entry);
    releasedNow.push(entry);
    occupy(candidate.group);
  }

  for (const candidate of incomingClaims.slice(0, MAX_BATCH)) {
    if (!claimShapeIsValid(candidate)) { rejected.push({ reason: 'shape' }); continue; }
    if (!options.acceptedGroups.has(candidate.group)) { rejected.push({ reason: 'group', name: candidate.name }); continue; }
    if (Date.parse(candidate.issuedAt) > options.now + CLOCK_SKEW_MS) { rejected.push({ reason: 'future', name: candidate.name }); continue; }
    if (!verifyClaim(candidate, options.verify)) { rejected.push({ reason: 'signature', name: candidate.name }); continue; }
    if (entries.some((entry) => entry.claim.signature === candidate.signature)) continue;
    // Um claim que a própria chave já liberou não volta por ser reapresentado.
    if (isReleased(candidate, releases)) { rejected.push({ reason: 'released', name: candidate.name }); continue; }
    // O mesmo dispositivo reivindicando de novo um nome que já é dele não
    // acrescenta nada. Sem isto, cada login deixaria mais um registro.
    if (entries.some((entry) => entry.claim.group === candidate.group && entry.claim.name === candidate.name
      && entry.claim.publicKey === candidate.publicKey && !isReleased(entry.claim, releases))) continue;
    if (full(candidate.group)) { rejected.push({ reason: 'capacity', name: candidate.name }); continue; }
    sequence += 1;
    const entry = { claim: candidate, firstSeenAt, sequence };
    entries.push(entry);
    added.push(entry);
    occupy(candidate.group);
  }

  return { ledger: { entries, releases, sequence }, added, released: releasedNow, rejected };
}

export interface SyncPage {
  claims: IdentityClaim[];
  releases: IdentityRelease[];
  /** A sequência a pedir em seguida; zero quando não há mais nada. */
  next: number;
}

/**
 * Uma página do que este host sabe, depois de um cursor.
 *
 * O cursor é a sequência de chegada **deste** host, e não um carimbo: vários
 * registros chegam no mesmo instante, e um cursor por instante repetiria ou
 * pularia os que empatam.
 */
export function recordsForSync(ledger: IdentityLedger, groups: ReadonlySet<string>, after = 0, limit = MAX_BATCH): SyncPage {
  const pending: Array<{ sequence: number; claim?: IdentityClaim; release?: IdentityRelease }> = [
    ...ledger.releases.filter((entry) => groups.has(entry.release.group) && entry.sequence > after).map((entry) => ({ sequence: entry.sequence, release: entry.release })),
    ...ledger.entries.filter((entry) => groups.has(entry.claim.group) && entry.sequence > after).map((entry) => ({ sequence: entry.sequence, claim: entry.claim })),
  ].sort((left, right) => left.sequence - right.sequence);
  const page = pending.slice(0, Math.max(1, limit));
  return {
    claims: page.flatMap((item) => (item.claim ? [item.claim] : [])),
    releases: page.flatMap((item) => (item.release ? [item.release] : [])),
    next: pending.length > page.length ? page[page.length - 1].sequence : 0,
  };
}

export type LoginRefusal = 'proof-required' | 'claimed-by-other' | 'contested' | 'bad-proof';

export type LoginDecision =
  | { allow: true; binding: 'none' | 'new' | 'existing'; provisional: boolean }
  | { allow: false; status: 401 | 409 | 426; reason: LoginRefusal };

/**
 * Se quem pede pode entrar com este nome, dado o que o host sabe dele.
 *
 * `proof` é nulo quando o cliente não mandou prova — um aplicativo anterior a
 * esta versão. Ele continua entrando com nomes que ninguém reivindicou, e é
 * recusado, com o motivo, nos que já têm dono.
 */
export function decideLogin(status: NameStatus, proof: { publicKey: string; valid: boolean } | null): LoginDecision {
  if (proof && !proof.valid) return { allow: false, status: 401, reason: 'bad-proof' };
  if (status.state === 'free') return { allow: true, binding: proof ? 'new' : 'none', provisional: false };
  if (!proof) return { allow: false, status: 426, reason: 'proof-required' };
  if (status.state === 'bound') {
    return status.holder.claim.publicKey === proof.publicKey
      ? { allow: true, binding: 'existing', provisional: false }
      : { allow: false, status: 409, reason: 'claimed-by-other' };
  }
  if (status.holder.claim.publicKey === proof.publicKey) return { allow: true, binding: 'existing', provisional: true };
  return status.contenders.some((entry) => entry.claim.publicKey === proof.publicKey)
    ? { allow: false, status: 409, reason: 'contested' }
    : { allow: false, status: 409, reason: 'claimed-by-other' };
}

export const LOGIN_MESSAGES: Record<LoginRefusal, string> = {
  'proof-required': 'Esse nome está vinculado a uma identidade neste grupo, e esta cópia do Tumacord não sabe prová-la. Atualize o aplicativo para entrar com ele.',
  'claimed-by-other': 'Esse nome pertence a outra pessoa neste grupo. Entre com outro nome.',
  contested: 'Esse nome foi reivindicado por dois dispositivos enquanto o grupo estava dividido, e o outro chegou primeiro a este host. Até um dos dois liberar o nome, entre com outro.',
  'bad-proof': 'A prova de identidade deste dispositivo não confere. Tente entrar de novo.',
};
