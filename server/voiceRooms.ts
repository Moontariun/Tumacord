import type { PublicUser, VoiceState } from '../shared/types.js';

export interface ParticipantInput extends PublicUser {
  socketId: string;
  endpoint: string;
}

interface InternalParticipant extends VoiceState {
  joinedAt: number;
}

export class VoiceRooms {
  private readonly rooms = new Map<string, Map<string, InternalParticipant>>();
  private sequence = 0;

  join(channelId: string, participant: ParticipantInput): VoiceState[] {
    this.leaveEverywhere(participant.socketId);
    const room = this.rooms.get(channelId) ?? new Map<string, InternalParticipant>();
    room.set(participant.socketId, {
      ...participant,
      joinedAt: this.sequence++,
      isHost: room.size === 0,
      pingMs: 9999,
      muted: false,
      speaking: false,
      deafened: false,
      camera: false,
      screen: false,
    });
    this.rooms.set(channelId, room);
    return this.members(channelId);
  }

  leave(channelId: string, socketId: string): VoiceState[] {
    const room = this.rooms.get(channelId);
    if (!room) return [];
    const leavingWasHost = room.get(socketId)?.isHost ?? false;
    room.delete(socketId);
    if (leavingWasHost && room.size) {
      const nextHost = [...room.values()].sort((a, b) => (a.pingMs - b.pingMs) || (a.joinedAt - b.joinedAt) || a.id.localeCompare(b.id))[0];
      nextHost.isHost = true;
    }
    if (!room.size) this.rooms.delete(channelId);
    return this.members(channelId);
  }

  leaveEverywhere(socketId: string): string[] {
    const changed: string[] = [];
    for (const channelId of this.rooms.keys()) {
      if (this.rooms.get(channelId)?.has(socketId)) {
        this.leave(channelId, socketId);
        changed.push(channelId);
      }
    }
    return changed;
  }

  update(channelId: string, socketId: string, patch: Partial<Pick<VoiceState, 'muted' | 'speaking' | 'deafened' | 'camera' | 'screen'>>): VoiceState[] {
    const participant = this.rooms.get(channelId)?.get(socketId);
    if (participant) Object.assign(participant, patch);
    return this.members(channelId);
  }

  updatePing(channelId: string, socketId: string, pingMs: number): VoiceState[] {
    const participant = this.rooms.get(channelId)?.get(socketId);
    if (participant) participant.pingMs = Math.max(0, Math.min(9999, Math.round(pingMs)));
    return this.members(channelId);
  }

  updateUser(user: PublicUser): string[] {
    const changed: string[] = [];
    for (const [channelId, room] of this.rooms) {
      let touched = false;
      for (const participant of room.values()) {
        if (participant.id !== user.id) continue;
        participant.username = user.username;
        participant.profile = user.profile;
        touched = true;
      }
      if (touched) changed.push(channelId);
    }
    return changed;
  }

  members(channelId: string): VoiceState[] {
    return [...(this.rooms.get(channelId)?.values() ?? [])]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(({ joinedAt: _joinedAt, ...member }) => member);
  }

  snapshot(): Record<string, VoiceState[]> {
    return Object.fromEntries([...this.rooms.keys()].map((channelId) => [channelId, this.members(channelId)]));
  }

  roomOf(socketId: string): string | undefined {
    return [...this.rooms].find(([, participants]) => participants.has(socketId))?.[0];
  }
}
