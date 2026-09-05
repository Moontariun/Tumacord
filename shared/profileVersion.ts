import type { UserProfile } from './types.js';

export function profileRevisionKey(profile: UserProfile | undefined): string {
  if (!profile) return '';
  return JSON.stringify({
    bio: profile.bio,
    accentColor: profile.accentColor,
    avatar: profile.avatar ? { id: profile.avatar.id, mimeType: profile.avatar.mimeType } : null,
    banner: profile.banner ? { id: profile.banner.id, mimeType: profile.banner.mimeType } : null,
    updatedAt: profile.updatedAt ?? '',
  });
}

export function profileIsNewer(incoming: UserProfile | undefined, current: UserProfile | undefined): boolean {
  const incomingTime = incoming?.updatedAt ? Date.parse(incoming.updatedAt) : 0;
  const currentTime = current?.updatedAt ? Date.parse(current.updatedAt) : 0;
  const safeIncomingTime = Number.isFinite(incomingTime) ? incomingTime : 0;
  const safeCurrentTime = Number.isFinite(currentTime) ? currentTime : 0;
  if (safeIncomingTime !== safeCurrentTime) return safeIncomingTime > safeCurrentTime;
  return profileRevisionKey(incoming) > profileRevisionKey(current);
}
