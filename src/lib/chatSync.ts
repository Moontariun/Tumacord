import type { Socket } from 'socket.io-client';
import type { Channel, ChatAttachment, ChatMessage, ChatSyncBundle, ProfileMedia, ReplicatedProfile } from '../../shared/types';
import { safeAttachmentName } from '../../shared/attachmentName';

const LOCAL_SERVER = 'http://127.0.0.1:3927';

function emptyBundle(): ChatSyncBundle {
  return { channels: [], messages: [], profiles: [], availableAttachmentIds: [] };
}

export async function loadLocalSyncBundle(): Promise<ChatSyncBundle> {
  if (!window.tumacordDesktop) return emptyBundle();
  try {
    const response = await fetch(`${LOCAL_SERVER}/api/local/sync`);
    if (!response.ok) return emptyBundle();
    const bundle = await response.json() as Partial<ChatSyncBundle>;
    return { channels: bundle.channels ?? [], messages: bundle.messages ?? [], profiles: bundle.profiles ?? [], availableAttachmentIds: bundle.availableAttachmentIds ?? [] };
  } catch {
    return emptyBundle();
  }
}

export async function mirrorLocally(channels: Channel[], messages: ChatMessage[], profiles: ReplicatedProfile[] = []): Promise<void> {
  if (!window.tumacordDesktop || (!channels.length && !messages.length && !profiles.length)) return;
  await fetch(`${LOCAL_SERVER}/api/local/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channels, messages, profiles, availableAttachmentIds: [] }),
  }).catch(() => undefined);
}

export async function hasLocalAttachment(id: string): Promise<boolean> {
  if (!window.tumacordDesktop) return false;
  try { return (await fetch(`${LOCAL_SERVER}/api/local/attachments/${id}`, { method: 'HEAD' })).ok; } catch { return false; }
}

export async function saveAttachmentLocally(id: string, contents: Blob): Promise<void> {
  if (!window.tumacordDesktop) return;
  const response = await fetch(`${LOCAL_SERVER}/api/local/attachments/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: contents,
  });
  if (!response.ok) throw new Error('Não consegui guardar o arquivo neste computador.');
}

async function localAttachment(id: string): Promise<Blob | null> {
  if (!window.tumacordDesktop) return null;
  try {
    const response = await fetch(`${LOCAL_SERVER}/api/local/attachments/${id}`);
    return response.ok ? response.blob() : null;
  } catch { return null; }
}

function profileMedia(profiles: readonly ReplicatedProfile[]): ProfileMedia[] {
  return [...new Map(profiles.flatMap((entry) => [entry.profile.avatar, entry.profile.banner]).filter((media): media is ProfileMedia => Boolean(media)).map((media) => [media.id, media])).values()];
}

export async function publishProfileMedia(bundle: ChatSyncBundle, serverUrl: string, token: string): Promise<void> {
  if (!window.tumacordDesktop) return;
  await Promise.all(profileMedia(bundle.profiles).map(async (media) => {
    const existing = await fetch(`${serverUrl}/api/profile/media/${media.id}`, { method: 'HEAD' }).catch(() => null);
    if (existing?.ok) return;
    const contents = await localAttachment(media.id);
    if (!contents) return;
    await fetch(`${serverUrl}/api/profile/media/${media.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': media.mimeType },
      body: contents,
    }).catch(() => undefined);
  }));
}

export async function cacheProfileMedia(bundle: ChatSyncBundle, serverUrl: string): Promise<void> {
  if (!window.tumacordDesktop) return;
  await Promise.all(profileMedia(bundle.profiles).map(async (media) => {
    if (await hasLocalAttachment(media.id)) return;
    const response = await fetch(`${serverUrl}/api/profile/media/${media.id}`).catch(() => null);
    if (!response?.ok) return;
    await saveAttachmentLocally(media.id, await response.blob()).catch(() => undefined);
  }));
}

function findPeerAttachment(socket: Socket, attachmentId: string): Promise<string | null> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      socket.off('chat:file:offer', onOffer);
      resolve(null);
    }, 2800);
    const onOffer = (payload: { requestId?: string; attachmentId?: string; url?: string }) => {
      if (payload.requestId !== requestId || payload.attachmentId !== attachmentId || typeof payload.url !== 'string') return;
      window.clearTimeout(timer);
      socket.off('chat:file:offer', onOffer);
      resolve(payload.url);
    };
    socket.on('chat:file:offer', onOffer);
    socket.emit('chat:file:find', { requestId, attachmentId });
  });
}

export async function resolveAttachment(socket: Socket | null, attachment: ChatAttachment, serverUrl: string, token: string): Promise<Blob> {
  const local = await localAttachment(attachment.id);
  if (local) return local;

  try {
    const response = await fetch(`${serverUrl}/api/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${token}` } });
    if (response.ok) return await response.blob();
  } catch { /* tenta outro participante abaixo */ }

  if (socket) {
    const peerUrl = await findPeerAttachment(socket, attachment.id);
    if (peerUrl) {
      const response = await fetch(peerUrl).catch(() => null);
      if (response?.ok) return await response.blob();
    }
  }
  throw new Error('O arquivo não está disponível. Alguém que manteve uma cópia precisa ficar online.');
}

export async function cacheAttachment(socket: Socket | null, attachment: ChatAttachment, serverUrl: string, token: string): Promise<void> {
  if (!window.tumacordDesktop || await hasLocalAttachment(attachment.id)) return;
  await saveAttachmentLocally(attachment.id, await resolveAttachment(socket, attachment, serverUrl, token));
}

async function imagePreview(file: File): Promise<string | undefined> {
  if (!file.type.startsWith('image/')) return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 256 / bitmap.width, 144 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return undefined;
    }
    context.fillStyle = '#181922';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/webp', 0.52);
  } catch { return undefined; }
}

export async function uploadAttachment(file: File, serverUrl: string, token: string): Promise<ChatAttachment> {
  if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Escolha um arquivo de até 25 MB.');
  const response = await fetch(`${serverUrl}/api/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
      'x-file-type': encodeURIComponent(file.type || 'application/octet-stream'),
    },
    body: file,
  });
  const result = await response.json() as ChatAttachment & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Não foi possível enviar o arquivo.');
  const attachment = { ...result, previewDataUrl: await imagePreview(file) };
  if (window.tumacordDesktop) await saveAttachmentLocally(attachment.id, file);
  return attachment;
}

export function downloadBlob(contents: Blob, name: string): void {
  const url = URL.createObjectURL(contents);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeAttachmentName(name);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
