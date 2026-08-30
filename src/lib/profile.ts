import type { ProfileMedia, PublicUser, UserProfile } from '../../shared/types';

export function profileMediaUrl(serverUrl: string, media?: ProfileMedia): string | undefined {
  return media ? `${serverUrl.replace(/\/$/, '')}/api/profile/media/${media.id}` : undefined;
}

export async function uploadProfileMedia(file: File, serverUrl: string, token: string): Promise<ProfileMedia> {
  if (!/^image\/(?:gif|png|jpeg|webp)$/.test(file.type) || !file.size || file.size > 6 * 1024 * 1024) {
    throw new Error('Use GIF, PNG, JPG ou WebP de até 6 MB.');
  }
  const response = await fetch(`${serverUrl}/api/profile/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': file.type },
    body: file,
  });
  const result = await response.json() as ProfileMedia & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Não foi possível enviar a imagem.');
  return result;
}

export async function updateProfile(profile: UserProfile, serverUrl: string, token: string): Promise<PublicUser> {
  const response = await fetch(`${serverUrl}/api/profile`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  });
  const result = await response.json() as PublicUser & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o perfil.');
  return result;
}
