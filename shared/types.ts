export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  // Todos opcionais: instalações vindas da 0.8.0 não os têm, e carregar sem
  // eles precisa continuar funcionando.
  categoryId?: string;
  position?: number;
  topic?: string;
  userLimit?: number;
}

export interface ChannelCategory {
  id: string;
  name: string;
  position?: number;
}

export interface ProfileMedia {
  id: string;
  mimeType: string;
}

export interface UserProfile {
  bio: string;
  accentColor: string;
  avatar?: ProfileMedia;
  banner?: ProfileMedia;
  updatedAt?: string;
}

export interface ReplicatedProfile {
  username: string;
  profile: UserProfile;
}

export type ServerRole = 'owner' | 'admin' | 'member';

export interface PublicUser {
  id: string;
  username: string;
  profile?: UserProfile;
  // `isAdmin` continua derivado do papel, para clientes anteriores à 0.8.1
  // que não conhecem `role` seguirem funcionando.
  isAdmin?: boolean;
  role?: ServerRole;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  previewDataUrl?: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  author: PublicUser;
  body: string;
  createdAt: string;
  attachment?: ChatAttachment;
}

export interface ChatSyncBundle {
  channels: Channel[];
  messages: ChatMessage[];
  profiles: ReplicatedProfile[];
  availableAttachmentIds: string[];
}

export interface VoiceState extends PublicUser {
  socketId: string;
  endpoint: string;
  isHost: boolean;
  pingMs: number;
  // Nota de 0 a 100 de quão alcançável este participante é de fora da rede
  // local. Ela decide quem assume a call quando o host sai.
  reachability?: number;
  muted: boolean;
  speaking: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  screenAudio: boolean;
}

export interface ServerSnapshot {
  serverName: string;
  channels: Channel[];
  onlineUsers: PublicUser[];
  voiceRooms: Record<string, VoiceState[]>;
}

export interface AdminOverview {
  serverName: string;
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  onlineUsers: PublicUser[];
  channels: Channel[];
  voiceRooms: Record<string, VoiceState[]>;
  security: {
    accessKeyRequired: boolean;
    tls: boolean;
    media: 'DTLS-SRTP';
  };
}

export interface StreamMeta {
  streamId: string;
  kind: 'camera' | 'screen';
}

export interface SessionResponse {
  token: string;
  user: PublicUser;
  serverName: string;
  created: boolean;
}

export interface DiscoveredCall {
  hostId: string;
  hostUserId: string;
  hostUsername: string;
  callId: string;
  callName: string;
  participants: number;
  url: string;
  // Chave do enlace direto anunciada pelo host na própria rede: entrar por uma
  // call vista aqui continua sendo um clique, sem colar convite.
  key?: string;
  pingMs: number;
  lastSeen: number;
}
