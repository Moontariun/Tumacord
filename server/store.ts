import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Channel, ChatAttachment, ChatMessage, ReplicatedProfile, UserProfile } from '../shared/types.js';
import { profileIsNewer } from '../shared/profileVersion.js';
import { supersedes } from '../shared/messageSync.js';
import { countOwners, migrateRoles, normalizeRole, type Role } from './roles.js';
import { applyOrder, detachCategory, nextPosition, normalizePositions, type CategoryRecord, type ChannelRecord } from './channels.js';
import { appendAudit, type AuditEntry } from './audit.js';
import type { StoredBoard } from './whiteboards.js';
import { claimShapeIsValid, emptyLedger, mergeLedger, releaseShapeIsValid, type IdentityLedger, type MergeOptions, type MergeOutcome } from '../shared/identity.js';

export interface StoredUser {
  id: string;
  username: string;
  normalizedUsername: string;
  passwordHash: string;
  createdAt: string;
  profile?: UserProfile;
  // Ausente nas contas vindas da 0.8.0. A migração de papéis preenche na
  // primeira subida e a partir daí o valor é o que manda — não a variável de
  // ambiente.
  role?: Role;
  lastSeenAt?: string;
}

export interface StoredSession {
  tokenHash?: string;
  /** Compatibilidade de leitura com sessões gravadas antes da versão 0.3. */
  token?: string;
  userId: string;
  expiresAt: number;
}

// Convite emitido pelo servidor. O que viaja no código é um token curto; aqui
// fica só o hash dele, pela mesma razão das sessões: um vazamento do arquivo
// não pode virar um convite utilizável.
export interface StoredInvite {
  tokenHash: string;
  callId: string;
  callName: string;
  hostUsername: string;
  createdBy: string;
  expiresAt: number;
}

/**
 * Um nome que já pertenceu a alguém neste servidor.
 *
 * A reserva sobrevive à remoção da conta de propósito. Sem ela, apagar uma
 * conta liberava o nome para qualquer pessoa: quem chegasse depois herdaria a
 * identidade de quem saiu — as menções antigas, o que os outros lembram do
 * nome, a confiança que ele carrega. O `userId` é preservado para uma
 * recuperação autorizada devolver a mesma conta, e não uma conta nova com o
 * mesmo nome.
 *
 * A reserva **não é autenticação**: ela só diz que o nome está tomado. Quem
 * quiser reaver precisa de um procedimento do dono, auditado, e não de
 * informar uma senha nova.
 */
export interface UsernameReservation {
  normalizedUsername: string;
  /** Como o nome foi escrito quando reservado, para a interface mostrá-lo. */
  username: string;
  /** A conta que o teve. Preservado para a recuperação autorizada. */
  userId: string;
  createdAt: string;
  /** Quando a conta foi removida. Ausente enquanto ela existe. */
  releasedAt?: string;
}

interface StoredData {
  users: StoredUser[];
  channels: Channel[];
  categories: CategoryRecord[];
  messages: ChatMessage[];
  attachments: StoredAttachment[];
  profiles: ReplicatedProfile[];
  sessions: StoredSession[];
  invites: StoredInvite[];
  auditLog: AuditEntry[];
  // Mesas de desenho do servidor dedicado. Ausente nos arquivos anteriores à
  // 0.9.1, e ausência é lista vazia — carregar sem elas precisa continuar
  // funcionando.
  boards: StoredBoard[];
  /** Ids de mesas excluídas. É o que impede uma delas de voltar do nada. */
  deletedBoards: string[];
  // Identidade estável desta instalação. Nome de servidor, apelido e o literal
  // "p2p" não delimitam origem: dois servidores podem se chamar igual, e um
  // apelido muda. Este id nasce na primeira subida e não muda mais.
  installationId?: string;
  // O cache local, separado por origem.
  //
  // Ele era o mesmo armazenamento que o servidor embutido usa para hospedar:
  // a conversa de um servidor dedicado era espelhada aqui e passava a ser
  // servida — e republicada — como se fosse do grupo P2P desta máquina. São
  // duas responsabilidades diferentes que moravam no mesmo lugar.
  mirrors?: Record<string, MirroredHistory>;
  // Até onde vai o histórico anterior à separação. O que veio antes está
  // misturado e não dá para saber de onde: ele não é apagado nem publicado.
  legacyHistoryUntil?: string;
  // Nomes já usados neste servidor, inclusive os de contas removidas.
  // Ausente nos arquivos anteriores à 0.9.9-1: a primeira subida preenche a
  // partir das contas que existem, que é o histórico que de fato existe. Um
  // nome apagado antes disso não deixou registro e não é possível reconstruí-lo.
  usernameReservations?: UsernameReservation[];
  // Os claims de nome do P2P e as liberações deles. Ausente nos arquivos
  // anteriores à 0.9.9-1, e ausência é registro vazio.
  identityLedger?: IdentityLedger;
}

export interface MirroredHistory {
  channels: Channel[];
  messages: ChatMessage[];
  profiles: ReplicatedProfile[];
  updatedAt: string;
}

type StoredAttachment = Pick<ChatAttachment, 'id' | 'name' | 'mimeType' | 'size'>;

const initialData = (): StoredData => ({
  users: [],
  channels: [
    { id: 'geral', name: 'geral', type: 'text' },
    { id: 'memes', name: 'memes', type: 'text' },
    { id: 'call-geral', name: 'Call Geral', type: 'voice' },
    { id: 'jogos', name: 'Jogos', type: 'voice' },
  ],
  categories: [],
  messages: [],
  attachments: [],
  profiles: [],
  sessions: [],
  invites: [],
  auditLog: [],
  boards: [],
  deletedBoards: [],
  mirrors: {},
  usernameReservations: [],
  identityLedger: emptyLedger(),
});

/**
 * O registro de identidade como ele está no disco, sem confiar nele.
 *
 * Um registro que não tem a forma de claim é descartado na carga, e não derruba
 * a subida: o que sobra continua valendo, e o que era legítimo volta pela
 * sincronização. A assinatura não é conferida de novo aqui — ela foi conferida
 * na entrada, e o arquivo é gravado com permissão 0600.
 */
function ledgerFromDisk(value: unknown): IdentityLedger {
  const raw = (value ?? {}) as Partial<IdentityLedger>;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.filter((entry) => entry && claimShapeIsValid(entry.claim) && typeof entry.firstSeenAt === 'string' && Number.isSafeInteger(entry.sequence))
    : [];
  const releases = Array.isArray(raw.releases)
    ? raw.releases.filter((entry) => entry && releaseShapeIsValid(entry.release) && typeof entry.firstSeenAt === 'string' && Number.isSafeInteger(entry.sequence))
    : [];
  let highest = 0;
  for (const entry of [...entries, ...releases]) highest = Math.max(highest, entry.sequence);
  // A sequência nunca anda para trás: um cursor já entregue a um cliente não
  // pode passar a apontar para outro registro.
  const sequence = Number.isSafeInteger(raw.sequence) && (raw.sequence as number) >= highest ? raw.sequence as number : highest;
  return { entries, releases, sequence };
}

function profileKey(username: string): string {
  return username.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

/** Um nome que aparece em mais de uma conta, e as contas que o carregam. */
export interface DuplicateUsernameGroup {
  normalizedUsername: string;
  /** Só o que o dono precisa para decidir. **Nunca** hash nem senha. */
  accounts: { id: string; username: string; createdAt: string; role?: Role; lastSeenAt?: string }[];
}

/**
 * As contas que dividem o mesmo nome normalizado.
 *
 * Isto é diagnóstico, não conserto: qual conta fica é decisão de quem
 * administra, porque envolve mensagens, papéis e vínculos de pessoas
 * diferentes. O relatório sai sem hash e sem senha — ele é para ser lido, e
 * pode acabar colado em algum lugar.
 */
export function duplicateUsernames(users: readonly StoredUser[]): DuplicateUsernameGroup[] {
  const byName = new Map<string, StoredUser[]>();
  for (const user of users) {
    const nameKey = user.normalizedUsername;
    const group = byName.get(nameKey);
    if (group) group.push(user);
    else byName.set(nameKey, [user]);
  }
  const duplicates: DuplicateUsernameGroup[] = [];
  for (const [normalizedUsername, group] of byName) {
    if (group.length < 2) continue;
    duplicates.push({
      normalizedUsername,
      accounts: group
        .map((user) => ({ id: user.id, username: user.username, createdAt: user.createdAt, role: user.role, lastSeenAt: user.lastSeenAt }))
        .sort((leftGroup, rightGroup) => leftGroup.createdAt.localeCompare(rightGroup.createdAt)),
    });
  }
  return duplicates.sort((leftGroup, rightGroup) => leftGroup.normalizedUsername.localeCompare(rightGroup.normalizedUsername));
}

export class JsonStore {
  private data: StoredData = initialData();
  private saveChain = Promise.resolve();
  private readonly file: string;
  private readonly attachmentsDirectory: string;

  constructor(dataDirectory: string) {
    this.file = path.resolve(dataDirectory, 'tumacord.json');
    this.attachmentsDirectory = path.resolve(dataDirectory, 'attachments');
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await mkdir(this.attachmentsDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoredData>;
      let migratedInstallation = false;
      let migratedLegacySessions = false;
      const sessions = (parsed.sessions ?? []).flatMap((session) => {
        if (session.tokenHash) return [session];
        if (!session.token) return [];
        migratedLegacySessions = true;
        return [{ tokenHash: createHash('sha256').update(session.token, 'utf8').digest('hex'), userId: session.userId, expiresAt: session.expiresAt }];
      });
      const users = parsed.users ?? [];
      let migratedLegacyProfiles = false;
      let repairedMissingProfileMedia = false;
      for (const user of users) {
        if (!user.profile) continue;
        if (!user.profile.updatedAt) {
          user.profile.updatedAt = user.createdAt || new Date(0).toISOString();
          migratedLegacyProfiles = true;
        }
        const repaired = await this.withExistingProfileMedia(user.profile);
        user.profile = repaired.profile;
        repairedMissingProfileMedia ||= repaired.changed;
      }
      const profiles = new Map<string, ReplicatedProfile>();
      for (const entry of [...(parsed.profiles ?? []), ...users.filter((user) => user.profile).map((user) => ({ username: user.username, profile: user.profile! }))]) {
        const repaired = await this.withExistingProfileMedia(entry.profile);
        repairedMissingProfileMedia ||= repaired.changed;
        const safeEntry = { ...entry, profile: repaired.profile };
        const key = profileKey(entry.username);
        const current = profiles.get(key);
        if (!current || profileIsNewer(safeEntry.profile, current.profile)) profiles.set(key, safeEntry);
      }
      const attachments = new Map<string, StoredAttachment>();
      for (const attachment of parsed.attachments ?? []) attachments.set(attachment.id, attachment);
      for (const message of parsed.messages ?? []) {
        if (!message.attachment) continue;
        attachments.set(message.attachment.id, this.storedAttachment(message.attachment));
      }
      // Canais vindos da 0.8.0 não têm posição. Atribuí-la aqui é o que
      // permite reordenar depois sem que a lista fique dependendo da ordem de
      // inserção no arquivo.
      const canaisBrutos = parsed.channels?.length ? parsed.channels : initialData().channels;
      const precisaPosicionar = canaisBrutos.some((channel) => (channel as Channel).position === undefined);
      const channels = precisaPosicionar ? normalizePositions(canaisBrutos as ChannelRecord[]) as Channel[] : canaisBrutos;
      this.data = {
        users,
        channels,
        categories: parsed.categories ?? [],
        invites: parsed.invites ?? [],
        messages: parsed.messages ?? [],
        attachments: [...attachments.values()],
        profiles: [...profiles.values()],
        sessions,
        auditLog: parsed.auditLog ?? [],
        boards: parsed.boards ?? [],
        deletedBoards: parsed.deletedBoards ?? [],
        installationId: parsed.installationId,
        mirrors: parsed.mirrors ?? {},
        legacyHistoryUntil: parsed.legacyHistoryUntil,
        usernameReservations: parsed.usernameReservations ?? [],
        identityLedger: ledgerFromDisk(parsed.identityLedger),
      };
      // As reservas nascem do histórico que de fato existe: as contas que
      // estão aqui. Um nome apagado antes desta versão não deixou registro, e
      // prometer reconstruí-lo seria inventar histórico.
      const migratedReservations = this.seedReservations();
      // Duplicatas de nome vindas da corrida que esta versão corrige são
      // **detectadas** e ditas, e nada é decidido por conta própria. Escolher
      // "a última senha" ou descartar a conta mais nova apagaria a conta de
      // alguém em silêncio.
      this.duplicateUsernameReport = duplicateUsernames(this.data.users);
      // A instalação ganha identidade na primeira subida, e a linha de corte
      // do histórico antigo é traçada junto: daqui em diante o que chegar tem
      // origem conhecida, e o que já estava aqui fica marcado como anterior.
      if (!this.data.installationId) {
        this.data.installationId = randomUUID();
        migratedInstallation = true;
      }
      if (this.data.legacyHistoryUntil === undefined) {
        const ultima = this.data.messages.at(-1)?.createdAt ?? '';
        this.data.legacyHistoryUntil = ultima;
        migratedInstallation = true;
      }
      if (migratedInstallation || migratedLegacySessions || migratedLegacyProfiles || repairedMissingProfileMedia || precisaPosicionar || migratedReservations || !parsed.profiles || !parsed.attachments) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Instalação nova: identidade agora, e nenhum histórico anterior.
      this.data.installationId = randomUUID();
      this.data.legacyHistoryUntil = '';
      await this.save();
    }
  }

  get users(): readonly StoredUser[] { return this.data.users; }
  get channels(): readonly Channel[] { return this.data.channels; }
  get messages(): readonly ChatMessage[] { return this.data.messages; }
  get attachments(): readonly StoredAttachment[] { return this.data.attachments; }
  get profiles(): readonly ReplicatedProfile[] { return this.data.profiles; }
  get sessions(): readonly StoredSession[] { return this.data.sessions; }
  get identityLedger(): IdentityLedger { return this.data.identityLedger ?? emptyLedger(); }

  /**
   * Junta claims e liberações ao registro, e grava se algo entrou.
   *
   * A mescla não devolve o laço de eventos no meio: dois logins simultâneos
   * pelo mesmo nome livre entram em ordem de sequência, e é essa ordem que
   * decide quem ficou com o nome neste host.
   */
  async mergeIdentity(incoming: { claims?: unknown; releases?: unknown }, options: MergeOptions): Promise<MergeOutcome> {
    const outcome = mergeLedger(this.identityLedger, incoming, options);
    if (outcome.added.length || outcome.released.length) {
      this.data.identityLedger = outcome.ledger;
      await this.save();
    }
    return outcome;
  }

  /**
   * Troca o hash de senha de uma conta deste host.
   *
   * Só é chamada quando uma prova de identidade confere com o dono do nome. No
   * P2P a senha é de cada host, e uma conta criada aqui por outra pessoa antes
   * de o claim chegar não pode trancar para fora a quem o nome pertence.
   */
  async replacePasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user) return false;
    user.passwordHash = passwordHash;
    await this.save();
    return true;
  }

  /**
   * Duplicatas de nome encontradas na carga, para o dono resolver.
   *
   * Vazio quando não há. Nenhuma delas é resolvida automaticamente: a decisão
   * de qual conta fica é de quem administra, e envolve dados de pessoas.
   */
  duplicateUsernameReport: DuplicateUsernameGroup[] = [];

  /**
   * Garante uma reserva para cada nome que existe agora.
   *
   * Devolve `true` se algo mudou, para a carga saber que precisa gravar.
   */
  private seedReservations(): boolean {
    const existingNames = new Set(this.usernameReservations.map((reservation) => reservation.normalizedUsername));
    let reservationsChanged = false;
    for (const user of this.data.users) {
      if (existingNames.has(user.normalizedUsername)) continue;
      existingNames.add(user.normalizedUsername);
      this.data.usernameReservations!.push({
        normalizedUsername: user.normalizedUsername,
        username: user.username,
        userId: user.id,
        createdAt: user.createdAt || new Date(0).toISOString(),
      });
      reservationsChanged = true;
    }
    return reservationsChanged;
  }

  /** As reservas de nome deste servidor. Ausência é lista vazia. */
  get usernameReservations(): readonly UsernameReservation[] {
    return this.data.usernameReservations ?? (this.data.usernameReservations = []);
  }

  /** A reserva de um nome, se ele já pertenceu a alguém aqui. */
  reservationFor(normalizedUsername: string): UsernameReservation | undefined {
    return this.usernameReservations.find((candidate) => candidate.normalizedUsername === normalizedUsername);
  }

  /**
   * Cria uma conta, ou diz quem já tem aquele nome.
   *
   * **A conferência e a inserção acontecem sem `await` no meio**, e é isso que
   * dá a garantia. Até a 0.9.9 a unicidade era conferida na rota, antes de
   * `hashPassword` — que é assíncrono e devolve o laço de eventos. Seis
   * pedidos simultâneos do mesmo nome passavam todos pela conferência antes de
   * qualquer um chegar à inserção, e o resultado eram seis contas com o mesmo
   * nome. A reprodução está em `tests/accountUniqueness.test.ts`.
   *
   * A conta só é aceita se o nome não estiver em uso **e** não estiver
   * reservado por uma conta anterior. O `save` vem depois, e uma falha de
   * gravação desfaz a inserção: metade de uma conta na memória e nada no disco
   * é pior do que nenhuma conta.
   */
  async createUser(user: StoredUser): Promise<{ created: true; user: StoredUser } | { created: false; conflict: 'user' | 'reservation'; existing?: StoredUser }> {
    const existing = this.data.users.find((candidate) => candidate.normalizedUsername === user.normalizedUsername);
    if (existing) return { created: false, conflict: 'user', existing };
    const reserved = this.reservationFor(user.normalizedUsername);
    if (reserved) return { created: false, conflict: 'reservation' };

    const replicated = this.profileForUsername(user.username);
    if (replicated && profileIsNewer(replicated, user.profile)) user.profile = replicated;
    this.data.users.push(user);
    this.usernameReservations;
    this.data.usernameReservations!.push({
      normalizedUsername: user.normalizedUsername,
      username: user.username,
      userId: user.id,
      createdAt: user.createdAt,
    });
    try {
      await this.save();
    } catch (failure) {
      // A gravação falhou: a memória volta ao que era. Deixar a conta viva só
      // aqui faria o servidor aceitar um login que some no próximo reinício.
      const userIndex = this.data.users.indexOf(user);
      if (userIndex >= 0) this.data.users.splice(userIndex, 1);
      const reservation = this.data.usernameReservations!.findIndex((candidate) => candidate.userId === user.id);
      if (reservation >= 0) this.data.usernameReservations!.splice(reservation, 1);
      throw failure;
    }
    return { created: true, user };
  }

  /**
   * @deprecated Use `createUser`, que garante a unicidade. Mantido só para os
   * caminhos de migração/importação, que já conferiram o nome antes.
   */
  async addUser(user: StoredUser): Promise<void> {
    const replicated = this.profileForUsername(user.username);
    if (replicated && profileIsNewer(replicated, user.profile)) user.profile = replicated;
    this.data.users.push(user);
    await this.save();
  }

  async addSession(session: StoredSession): Promise<void> {
    const sessionKey = session.tokenHash ?? session.token;
    this.data.sessions = this.data.sessions.filter((candidate) => (candidate.tokenHash ?? candidate.token) !== sessionKey && candidate.expiresAt > Date.now());
    this.data.sessions.push(session);
    if (this.data.sessions.length > 500) this.data.sessions.splice(0, this.data.sessions.length - 500);
    await this.save();
  }

  get invites(): StoredInvite[] {
    // Arquivos gravados antes da 0.8.4 não têm a lista; ausência é lista vazia.
    return this.data.invites ?? (this.data.invites = []);
  }

  async addInvite(invite: StoredInvite): Promise<void> {
    const now = Date.now();
    this.data.invites = this.invites.filter((candidate) => candidate.tokenHash !== invite.tokenHash && candidate.expiresAt > now);
    this.data.invites.push(invite);
    // Teto para o arquivo não crescer sem limite se alguém gerar convites em
    // laço; os mais antigos saem primeiro.
    if (this.data.invites.length > 200) this.data.invites.splice(0, this.data.invites.length - 200);
    await this.save();
  }

  inviteForHash(tokenHash: string, now = Date.now()): StoredInvite | undefined {
    return this.invites.find((candidate) => candidate.tokenHash === tokenHash && candidate.expiresAt > now);
  }

  async removeSession(tokenHash: string): Promise<void> {
    const next = this.data.sessions.filter((candidate) => {
      const candidateHash = candidate.tokenHash ?? (candidate.token ? createHash('sha256').update(candidate.token, 'utf8').digest('hex') : '');
      return candidateHash !== tokenHash;
    });
    if (next.length === this.data.sessions.length) return;
    this.data.sessions = next;
    await this.save();
  }

  async pruneSessions(now = Date.now()): Promise<void> {
    const next = this.data.sessions.filter((candidate) => candidate.expiresAt > now);
    if (next.length === this.data.sessions.length) return;
    this.data.sessions = next;
    await this.save();
  }

  async updateUserProfile(userId: string, profile: UserProfile): Promise<StoredUser | undefined> {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user) return undefined;
    user.profile = profile;
    const key = profileKey(user.username);
    const index = this.data.profiles.findIndex((entry) => profileKey(entry.username) === key);
    const replicated = { username: user.username, profile };
    if (index < 0) this.data.profiles.push(replicated);
    else this.data.profiles[index] = replicated;
    await this.save();
    return user;
  }

  // Migração de papéis vinda da 0.8.0. Roda na subida, grava só se algo mudou,
  // e nunca reescreve um dono já definido — trocar `ADMIN_USERNAME` depois não
  // pode sequestrar o servidor.
  async migrateUserRoles(adminUsername: string): Promise<{ changed: boolean; ownerId: string | null }> {
    const resultado = migrateRoles(this.data.users, adminUsername);
    if (resultado.changed) {
      for (const migrado of resultado.users) {
        const atual = this.data.users.find((candidate) => candidate.id === migrado.id);
        if (atual) atual.role = migrado.role;
      }
      await this.save();
    }
    return { changed: resultado.changed, ownerId: resultado.ownerId };
  }

  roleOf(userId: string): Role {
    return normalizeRole(this.data.users.find((candidate) => candidate.id === userId)?.role);
  }

  get ownerCount(): number {
    return countOwners(this.data.users);
  }

  async setUserRole(userId: string, role: Role): Promise<StoredUser | undefined> {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user) return undefined;
    user.role = role;
    await this.save();
    return user;
  }

  async touchUser(userId: string): Promise<void> {
    const user = this.data.users.find((candidate) => candidate.id === userId);
    if (!user) return;
    const agora = new Date().toISOString();
    // Um carimbo por minuto basta para "último acesso" e evita gravar o
    // arquivo inteiro a cada requisição.
    if (user.lastSeenAt && agora.slice(0, 16) === user.lastSeenAt.slice(0, 16)) return;
    user.lastSeenAt = agora;
    await this.save();
  }

  async removeUser(userId: string): Promise<boolean> {
    const index = this.data.users.findIndex((candidate) => candidate.id === userId);
    if (index < 0) return false;
    const [removed] = this.data.users.splice(index, 1);
    // As sessões do removido morrem junto; deixá-las vivas seria manter o
    // acesso de quem acabou de perder a conta.
    this.data.sessions = this.data.sessions.filter((session) => session.userId !== userId);
    // O nome **não** volta a ficar livre. Quem chegasse depois herdaria a
    // identidade de quem saiu: as menções antigas, o que os outros lembram do
    // nome. A reserva guarda o `userId` para uma recuperação autorizada
    // devolver a mesma conta, e não uma conta nova com o mesmo nome.
    this.usernameReservations;
    const reservation = this.data.usernameReservations!.find((candidate) => candidate.normalizedUsername === removed.normalizedUsername);
    if (reservation) reservation.releasedAt = new Date().toISOString();
    else {
      this.data.usernameReservations!.push({
        normalizedUsername: removed.normalizedUsername,
        username: removed.username,
        userId: removed.id,
        createdAt: removed.createdAt,
        releasedAt: new Date().toISOString(),
      });
    }
    await this.save();
    return true;
  }

  get categories(): readonly CategoryRecord[] { return this.data.categories; }
  get auditLog(): readonly AuditEntry[] { return this.data.auditLog; }
  get boards(): readonly StoredBoard[] { return this.data.boards ?? (this.data.boards = []); }
  get deletedBoards(): readonly string[] { return this.data.deletedBoards ?? (this.data.deletedBoards = []); }
  get installationId(): string { return this.data.installationId ?? ''; }
  /** Vazio quando não há histórico anterior à separação por origem. */
  get legacyHistoryUntil(): string { return this.data.legacyHistoryUntil ?? ''; }

  /**
   * O cache de uma origem. Ele não é servido a ninguém: é o que este
   * computador viu naquele servidor ou naquele grupo, e só volta para lá.
   */
  mirrorFor(origin: string): MirroredHistory {
    const mirrors = this.data.mirrors ?? (this.data.mirrors = {});
    return mirrors[origin] ?? { channels: [], messages: [], profiles: [], updatedAt: '' };
  }

  async mergeMirror(origin: string, incoming: { channels?: readonly Channel[]; messages?: readonly ChatMessage[]; profiles?: readonly ReplicatedProfile[] }): Promise<void> {
    const mirrors = this.data.mirrors ?? (this.data.mirrors = {});
    const atual = this.mirrorFor(origin);
    const canais = new Map(atual.channels.map((channel) => [channel.id, channel]));
    for (const channel of incoming.channels ?? []) canais.set(channel.id, channel);
    const mensagens = new Map(atual.messages.map((message) => [message.id, message]));
    for (const message of incoming.messages ?? []) {
      // A cópia espelhada segue a mesma regra do histórico: revisão maior
      // vence. Sem isto, um espelho antigo desfazia no disco uma exclusão que
      // já tinha valido — e era desse disco que a próxima replicação saía.
      const guardada = mensagens.get(message.id);
      if (!guardada || supersedes(guardada, message)) mensagens.set(message.id, message);
    }
    const perfis = new Map(atual.profiles.map((entry) => [profileKey(entry.username), entry]));
    for (const entry of incoming.profiles ?? []) {
      const chave = profileKey(entry.username);
      const anterior = perfis.get(chave);
      if (!anterior || profileIsNewer(entry.profile, anterior.profile)) perfis.set(chave, entry);
    }
    const ordenadas = [...mensagens.values()].sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
    mirrors[origin] = {
      channels: [...canais.values()],
      // O mesmo teto do histórico do servidor: o cache de uma origem não pode
      // crescer sem fim só porque ninguém o apaga.
      messages: ordenadas.slice(-2000),
      profiles: [...perfis.values()],
      updatedAt: new Date().toISOString(),
    };
    // Um teto de origens também: quem visita muitos servidores não devia ver
    // este arquivo crescer para sempre. A menos usada sai primeiro.
    const origens = Object.entries(mirrors);
    if (origens.length > 24) {
      const [maisAntiga] = origens.sort((a, b) => (a[1].updatedAt || '').localeCompare(b[1].updatedAt || ''));
      if (maisAntiga && maisAntiga[0] !== origin) delete mirrors[maisAntiga[0]];
    }
    await this.save();
  }

  // As mesas vão para o disco inteiras, e não por operação: o arquivo já é
  // reescrito por completo a cada gravação, e um caminho incremental aqui só
  // criaria uma segunda verdade para manter em dia. Quem chama debounce a
  // gravação — desenhar produz operações a poucos milissegundos de distância.
  async saveBoards(boards: readonly StoredBoard[], deleted?: readonly string[]): Promise<void> {
    this.data.boards = [...boards];
    if (deleted) this.data.deletedBoards = [...deleted];
    await this.save();
  }

  async createChannel(channel: Omit<Channel, 'position'>): Promise<Channel> {
    const criado = { ...channel, position: nextPosition(this.data.channels) } as Channel;
    this.data.channels.push(criado);
    await this.save();
    return criado;
  }

  async updateChannel(id: string, patch: Partial<Channel>): Promise<Channel | undefined> {
    const channel = this.data.channels.find((candidate) => candidate.id === id);
    if (!channel) return undefined;
    Object.assign(channel, patch);
    // Campos opcionais apagados de verdade, e não guardados como `undefined`:
    // um `undefined` sobrevive ao JSON como chave ausente, mas confunde quem
    // lê o objeto em memória.
    for (const chave of ['topic', 'userLimit', 'categoryId'] as const) {
      if (patch[chave] === undefined && chave in patch) delete channel[chave];
    }
    await this.save();
    return channel;
  }

  async deleteChannel(id: string): Promise<boolean> {
    const index = this.data.channels.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.data.channels.splice(index, 1);
    // As mensagens do canal apagado saem junto: mantê-las órfãs ocuparia
    // espaço e reapareceria se alguém recriasse um canal com o mesmo id.
    this.data.messages = this.data.messages.filter((message) => message.channelId !== id);
    await this.save();
    return true;
  }

  async setChannelOrder(orderedIds: readonly string[]): Promise<readonly Channel[]> {
    this.data.channels = applyOrder(this.data.channels as ChannelRecord[], orderedIds) as Channel[];
    await this.save();
    return this.data.channels;
  }

  async createCategory(category: Omit<CategoryRecord, 'position'>): Promise<CategoryRecord> {
    const criada = { ...category, position: nextPosition(this.data.categories) };
    this.data.categories.push(criada);
    await this.save();
    return criada;
  }

  async updateCategory(id: string, patch: Partial<CategoryRecord>): Promise<CategoryRecord | undefined> {
    const category = this.data.categories.find((candidate) => candidate.id === id);
    if (!category) return undefined;
    Object.assign(category, patch);
    await this.save();
    return category;
  }

  async deleteCategory(id: string): Promise<boolean> {
    const index = this.data.categories.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.data.categories.splice(index, 1);
    // Apagar categoria não apaga canal: eles voltam para "sem categoria".
    this.data.channels = detachCategory(this.data.channels as ChannelRecord[], id) as Channel[];
    await this.save();
    return true;
  }

  async setCategoryOrder(orderedIds: readonly string[]): Promise<readonly CategoryRecord[]> {
    this.data.categories = applyOrder(this.data.categories, orderedIds);
    await this.save();
    return this.data.categories;
  }

  async recordAudit(entry: AuditEntry): Promise<void> {
    this.data.auditLog = appendAudit(this.data.auditLog, entry);
    await this.save();
  }

  profileForUsername(username: string): UserProfile | undefined {
    return this.data.profiles.find((entry) => profileKey(entry.username) === profileKey(username))?.profile;
  }

  async mergeProfiles(profiles: readonly ReplicatedProfile[]): Promise<ReplicatedProfile[]> {
    const changed: ReplicatedProfile[] = [];
    for (const incoming of profiles) {
      if (!(await this.profileMediaExists(incoming.profile))) continue;
      const key = profileKey(incoming.username);
      const index = this.data.profiles.findIndex((entry) => profileKey(entry.username) === key);
      const current = index < 0 ? undefined : this.data.profiles[index];
      if (current && !profileIsNewer(incoming.profile, current.profile)) continue;
      const next = { username: incoming.username.trim(), profile: incoming.profile };
      if (index < 0) this.data.profiles.push(next);
      else this.data.profiles[index] = next;
      for (const user of this.data.users) if (profileKey(user.username) === key) user.profile = incoming.profile;
      changed.push(next);
    }
    if (changed.length) await this.save();
    return changed;
  }

  async addChannel(channel: Channel): Promise<void> {
    if (this.data.channels.some((candidate) => candidate.id === channel.id)) return;
    this.data.channels.push(channel);
    await this.save();
  }

  async addMessage(message: ChatMessage): Promise<void> {
    if (this.data.messages.some((candidate) => candidate.id === message.id)) return;
    this.data.messages.push(message);
    if (message.attachment) this.rememberAttachment(message.attachment);
    this.data.messages.sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
    if (this.data.messages.length > 2000) this.data.messages.splice(0, this.data.messages.length - 2000);
    await this.save();
  }

  async mergeChannels(channels: readonly Channel[]): Promise<Channel[]> {
    const known = new Set(this.data.channels.map((channel) => channel.id));
    const added: Channel[] = [];
    for (const channel of channels) {
      if (known.has(channel.id)) continue;
      known.add(channel.id);
      added.push(channel);
    }
    if (!added.length) return [];
    this.data.channels.push(...added);
    await this.save();
    return added;
  }

  /** Trocar uma mensagem pela versão editada ou pela lápide dela. */
  async replaceMessage(message: ChatMessage): Promise<void> {
    const indice = this.data.messages.findIndex((candidate) => candidate.id === message.id);
    if (indice < 0) return;
    this.data.messages[indice] = message;
    await this.save();
  }

  /**
   * Mesclar o que chegou da replicação.
   *
   * Antes isto olhava só o `id`: quem já conhecia a mensagem ignorava a que
   * chegava. Com edição e exclusão essa regra vira o pior comportamento
   * possível — quem apagou vê a mensagem voltar no primeiro pacote de quem
   * ainda tinha a cópia antiga. Agora uma revisão maior substitui a menor, e é
   * isso que dá prioridade de verdade a apagar e editar.
   *
   * O retorno leva as novas **e** as substituídas, porque para quem está com a
   * tela aberta as duas são a mesma notícia: fique com esta versão.
   */
  async mergeMessages(messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    const porId = new Map(this.data.messages.map((message) => [message.id, message]));
    const added: ChatMessage[] = [];
    const changed: ChatMessage[] = [];
    for (const message of messages) {
      const atual = porId.get(message.id);
      if (!atual) {
        porId.set(message.id, message);
        added.push(message);
        if (message.attachment) this.rememberAttachment(message.attachment);
        continue;
      }
      if (!supersedes(atual, message)) continue;
      porId.set(message.id, message);
      changed.push(message);
      if (message.attachment) this.rememberAttachment(message.attachment);
    }
    if (!added.length && !changed.length) return [];
    for (const message of changed) {
      const indice = this.data.messages.findIndex((candidate) => candidate.id === message.id);
      if (indice >= 0) this.data.messages[indice] = message;
    }
    this.data.messages.push(...added);
    this.data.messages.sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
    if (this.data.messages.length > 2000) this.data.messages.splice(0, this.data.messages.length - 2000);
    await this.save();
    return [...added, ...changed];
  }

  async saveAttachment(id: string, contents: Buffer, metadata?: ChatAttachment): Promise<void> {
    const target = this.attachmentPath(id);
    const temporary = `${target}.next`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, target);
    if (metadata) {
      this.rememberAttachment({ ...metadata, id, size: contents.length });
      await this.save();
    }
  }

  attachmentForId(id: string): StoredAttachment | undefined {
    return this.data.attachments.find((attachment) => attachment.id === id);
  }

  async hasAttachment(id: string): Promise<boolean> {
    try {
      await access(this.attachmentPath(id));
      return true;
    } catch {
      return false;
    }
  }

  readAttachment(id: string): Promise<Buffer> {
    return readFile(this.attachmentPath(id));
  }

  async availableAttachmentIds(): Promise<string[]> {
    return (await readdir(this.attachmentsDirectory).catch(() => [])).filter((name) => /^[0-9a-f-]{36}$/i.test(name));
  }

  private attachmentPath(id: string): string {
    return path.join(this.attachmentsDirectory, id);
  }

  private storedAttachment(attachment: ChatAttachment): StoredAttachment {
    return {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  }

  private rememberAttachment(attachment: ChatAttachment): void {
    const stored = this.storedAttachment(attachment);
    const index = this.data.attachments.findIndex((candidate) => candidate.id === stored.id);
    if (index < 0) this.data.attachments.push(stored);
    else this.data.attachments[index] = stored;
  }

  private async profileMediaExists(profile: UserProfile): Promise<boolean> {
    const media = [profile.avatar, profile.banner].filter((entry): entry is NonNullable<UserProfile['avatar']> => Boolean(entry));
    return (await Promise.all(media.map((entry) => this.hasAttachment(entry.id)))).every(Boolean);
  }

  private async withExistingProfileMedia(profile: UserProfile): Promise<{ profile: UserProfile; changed: boolean }> {
    const [avatarExists, bannerExists] = await Promise.all([
      profile.avatar ? this.hasAttachment(profile.avatar.id) : Promise.resolve(false),
      profile.banner ? this.hasAttachment(profile.banner.id) : Promise.resolve(false),
    ]);
    const changed = Boolean((profile.avatar && !avatarExists) || (profile.banner && !bannerExists));
    if (!changed) return { profile, changed: false };
    const { avatar: _avatar, banner: _banner, ...rest } = profile;
    return {
      profile: {
        ...rest,
        ...(avatarExists && profile.avatar ? { avatar: profile.avatar } : {}),
        ...(bannerExists && profile.banner ? { banner: profile.banner } : {}),
      },
      changed: true,
    };
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    const temporary = `${this.file}.next`;
    // Uma falha transitória (disco desmontado, diretório recriado, etc.) não
    // pode envenenar a fila: o próximo snapshot completo ainda precisa ter a
    // chance de persistir o estado atual.
    //
    // A pausa entra **antes** da gravação e depois do snapshot: quem chamou já
    // mudou a memória e recebe a promessa de que isso chega ao disco. Bloquear
    // aqui segura a gravação sem perder a mudança.
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      if (this.writeGate) await this.writeGate;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.saveChain;
  }

  // ── Pausa de escrita, para o backup ────────────────────────────────────────
  //
  // Um `tar` do volume enquanto o servidor grava pode capturar o JSON entre o
  // `write` e o `rename`, ou o estado de um instante com os anexos de outro.
  // Nenhuma dessas falhas aparece na hora: elas aparecem na restauração, meses
  // depois, quando já não há de onde tirar outra cópia.
  //
  // Pausar aqui é o que torna a cópia um ponto: as gravações pendentes
  // terminam, as novas esperam, e o disco fica parado enquanto o backup lê.

  private writeGate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  private gateTimer: NodeJS.Timeout | null = null;

  /** Se a escrita está pausada agora. */
  get writesPaused(): boolean { return this.writeGate !== null; }

  /**
   * Descarrega o que está pendente e segura as gravações seguintes.
   *
   * Volta só depois de o disco estar em dia — é essa espera que dá o ponto
   * consistente. O `timeoutMs` é uma rede de segurança: um backup que morreu
   * no meio não pode deixar o servidor sem gravar para sempre.
   */
  async pauseWrites(timeoutMs = 5 * 60 * 1000): Promise<void> {
    if (this.writeGate) return;
    this.writeGate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
    // As gravações que já estavam na fila entraram antes do portão e terminam.
    await this.saveChain.catch(() => undefined);
    this.gateTimer = setTimeout(() => this.resumeWrites(), timeoutMs);
    // `unref` para o processo poder encerrar mesmo com a pausa pendurada.
    this.gateTimer.unref?.();
  }

  /** Libera as gravações que esperavam. */
  resumeWrites(): void {
    if (this.gateTimer) { clearTimeout(this.gateTimer); this.gateTimer = null; }
    const releaseWrites = this.releaseGate;
    this.writeGate = null;
    this.releaseGate = null;
    releaseWrites?.();
  }
}
