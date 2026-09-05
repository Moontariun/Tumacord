import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Channel, ChatAttachment, ChatMessage, ReplicatedProfile, UserProfile } from '../shared/types.js';
import { profileIsNewer } from '../shared/profileVersion.js';
import { countOwners, migrateRoles, normalizeRole, type Role } from './roles.js';

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

interface StoredData {
  users: StoredUser[];
  channels: Channel[];
  messages: ChatMessage[];
  attachments: StoredAttachment[];
  profiles: ReplicatedProfile[];
  sessions: StoredSession[];
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
  messages: [],
  attachments: [],
  profiles: [],
  sessions: [],
});

function profileKey(username: string): string {
  return username.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
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
      this.data = {
        users,
        channels: parsed.channels?.length ? parsed.channels : initialData().channels,
        messages: parsed.messages ?? [],
        attachments: [...attachments.values()],
        profiles: [...profiles.values()],
        sessions,
      };
      if (migratedLegacySessions || migratedLegacyProfiles || repairedMissingProfileMedia || !parsed.profiles || !parsed.attachments) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  get users(): readonly StoredUser[] { return this.data.users; }
  get channels(): readonly Channel[] { return this.data.channels; }
  get messages(): readonly ChatMessage[] { return this.data.messages; }
  get attachments(): readonly StoredAttachment[] { return this.data.attachments; }
  get profiles(): readonly ReplicatedProfile[] { return this.data.profiles; }
  get sessions(): readonly StoredSession[] { return this.data.sessions; }

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
    this.data.users.splice(index, 1);
    // As sessões do removido morrem junto; deixá-las vivas seria manter o
    // acesso de quem acabou de perder a conta.
    this.data.sessions = this.data.sessions.filter((session) => session.userId !== userId);
    await this.save();
    return true;
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

  async mergeMessages(messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    const known = new Set(this.data.messages.map((message) => message.id));
    const added: ChatMessage[] = [];
    for (const message of messages) {
      if (known.has(message.id)) continue;
      known.add(message.id);
      added.push(message);
      if (message.attachment) this.rememberAttachment(message.attachment);
    }
    if (!added.length) return [];
    this.data.messages.push(...added);
    this.data.messages.sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
    if (this.data.messages.length > 2000) this.data.messages.splice(0, this.data.messages.length - 2000);
    await this.save();
    return added;
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
    this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.saveChain;
  }
}
