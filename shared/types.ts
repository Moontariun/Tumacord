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
  // O que sobrou de uma mensagem depois de editada ou apagada. A revisão é o
  // que faz a mudança vencer a cópia antiga na replicação do P2P; a regra
  // inteira está em `shared/messageSync.ts`. Ausentes numa mensagem que nunca
  // mudou, e nos clientes anteriores à 0.9.9.
  revision?: number;
  editedAt?: string;
  /** Com isto preenchido a mensagem é uma lápide: o conteúdo já saiu. */
  deletedAt?: string;
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
  /**
   * O `socketId` de quem esta pessoa está assistindo agora, ou vazio.
   *
   * Um campo só, e não uma lista de espectadores por transmissão: quem assiste
   * sabe o que assiste, e a lista de espectadores de alguém é derivada
   * filtrando a sala. Guardar as duas metades deixaria as duas divergirem —
   * alguém sai da call e some de um lado sem sumir do outro.
   *
   * Ele viaja no estado de voz que já é transmitido a todo mundo na sala, e
   * por isso não custa nem um evento novo nem uma consulta.
   */
  watching: string;
  /**
   * O recado de "já volto" desta pessoa, ou vazio quando ela está presente.
   *
   * Vazio é o estado normal, e é o que faz o cartão sumir: um campo separado
   * de "está ausente" poderia discordar do texto, e duas verdades sobre a mesma
   * coisa acabam divergindo.
   */
  away: string;
  /**
   * O nome do tema do cartão. Um nome, e nunca uma cor.
   *
   * Cor vinda da rede terminaria num atributo `style`. Aqui viaja uma etiqueta
   * que o receptor procura numa lista fechada; o que não estiver na lista cai
   * no padrão em vez de virar CSS.
   */
  awayTheme: string;
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
  categories: ChannelCategory[];
  voiceRooms: Record<string, VoiceState[]>;
  security: {
    accessKeyRequired: boolean;
    tls: boolean;
    media: 'DTLS-SRTP';
  };
  // Apenas se existe relay configurado. Segredo e credencial nunca saem daqui.
  turn: boolean;
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
