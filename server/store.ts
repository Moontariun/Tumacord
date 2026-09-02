import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Channel, ChatMessage, ReplicatedProfile, UserProfile } from '../shared/types.js';

export interface StoredUser {
  id: string;
  username: string;
  normalizedUsername: string;
  passwordHash: string;
  createdAt: string;
  profile?: UserProfile;
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
  profiles: ReplicatedProfile[];
  sessions: StoredSession[];
}

const initialData = (): StoredData => ({
  users: [],
  channels: [
    { id: 'geral', name: 'geral', type: 'text' },
    { id: 'memes', name: 'memes', type: 'text' },
    { id: 'call-geral', name: 'Call Geral', type: 'voice' },
    { id: 'jogos', name: 'Jogos', type: 'voice' },
  ],
  messages: [],
  profiles: [],
  sessions: [],
});

function profileKey(username: string): string {
  return username.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

function profileTime(profile: UserProfile | undefined): number {
  const value = profile?.updatedAt ? Date.parse(profile.updatedAt) : 0;
  return Number.isFinite(value) ? value : 0;
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
      for (const user of users) {
        if (!user.profile || user.profile.updatedAt) continue;
        user.profile.updatedAt = user.createdAt || new Date(0).toISOString();
        migratedLegacyProfiles = true;
      }
      const profiles = new Map<string, ReplicatedProfile>();
      for (const entry of [...(parsed.profiles ?? []), ...users.filter((user) => user.profile).map((user) => ({ username: user.username, profile: user.profile! }))]) {
        const key = profileKey(entry.username);
        const current = profiles.get(key);
        if (!current || profileTime(entry.profile) > profileTime(current.profile)) profiles.set(key, entry);
      }
      this.data = {
        users,
        channels: parsed.channels?.length ? parsed.channels : initialData().channels,
        messages: parsed.messages ?? [],
        profiles: [...profiles.values()],
        sessions,
      };
      if (migratedLegacySessions || migratedLegacyProfiles || !parsed.profiles) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  get users(): readonly StoredUser[] { return this.data.users; }
  get channels(): readonly Channel[] { return this.data.channels; }
  get messages(): readonly ChatMessage[] { return this.data.messages; }
  get profiles(): readonly ReplicatedProfile[] { return this.data.profiles; }
  get sessions(): readonly StoredSession[] { return this.data.sessions; }

  async addUser(user: StoredUser): Promise<void> {
    const replicated = this.profileForUsername(user.username);
    if (replicated && profileTime(replicated) > profileTime(user.profile)) user.profile = replicated;
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

  profileForUsername(username: string): UserProfile | undefined {
    return this.data.profiles.find((entry) => profileKey(entry.username) === profileKey(username))?.profile;
  }

  async mergeProfiles(profiles: readonly ReplicatedProfile[]): Promise<ReplicatedProfile[]> {
    const changed: ReplicatedProfile[] = [];
    for (const incoming of profiles) {
      const key = profileKey(incoming.username);
      const index = this.data.profiles.findIndex((entry) => profileKey(entry.username) === key);
      const current = index < 0 ? undefined : this.data.profiles[index];
      if (current && profileTime(incoming.profile) <= profileTime(current.profile)) continue;
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
    this.data.messages.sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
    if (this.data.messages.length > 2000) this.data.messages.splice(0, this.data.messages.length - 2000);
    await this.save();
  }

  async mergeChannels(channels: readonly Channel[]): Promise<Channel[]> {
    const added = channels.filter((channel) => !this.data.channels.some((candidate) => candidate.id === channel.id));
    if (!added.length) return [];
    this.data.channels.push(...added);
    await this.save();
    return added;
  }

  async mergeMessages(messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
    const known = new Set(this.data.messages.map((message) => message.id));
    const added = messages.filter((message) => !known.has(message.id));
    if (!added.length) return [];
    this.data.messages.push(...added);
    this.data.messages.sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id));
    if (this.data.messages.length > 2000) this.data.messages.splice(0, this.data.messages.length - 2000);
    await this.save();
    return added;
  }

  async saveAttachment(id: string, contents: Buffer): Promise<void> {
    const target = this.attachmentPath(id);
    const temporary = `${target}.next`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, target);
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

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    const temporary = `${this.file}.next`;
    this.saveChain = this.saveChain.then(async () => {
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.saveChain;
  }
}
