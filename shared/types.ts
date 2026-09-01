export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
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
}

export interface PublicUser {
  id: string;
  username: string;
  profile?: UserProfile;
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
  availableAttachmentIds: string[];
}

export interface VoiceState extends PublicUser {
  socketId: string;
  endpoint: string;
  isHost: boolean;
  pingMs: number;
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
  pingMs: number;
  lastSeen: number;
}
