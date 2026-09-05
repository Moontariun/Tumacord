import type { StreamMeta, VoiceState } from '../../shared/types';

export type RemoteMediaKind = StreamMeta['kind'] | 'audio';

export function streamMetadataKey(peerId: string, streamId: string): string {
  return `${peerId}:${streamId}`;
}

export function prunePeerStreamMetadata(metadata: Map<string, StreamMeta['kind']>, peerId: string, lifecycle: 'recovery' | 'departure'): void {
  // addTrack reutiliza o mesmo MediaStream (e, portanto, o mesmo stream.id)
  // quando apenas a RTCPeerConnection é reconstruída. Apagar esse metadado
  // durante rtc:resync cria uma corrida em que uma tela passa por câmera.
  if (lifecycle === 'recovery') return;
  for (const key of metadata.keys()) if (key.startsWith(`${peerId}:`)) metadata.delete(key);
}

export function classifyRemoteStream(
  metadataKind: StreamMeta['kind'] | undefined,
  stream: Pick<MediaStream, 'getVideoTracks'>,
  member: Pick<VoiceState, 'screen'> | undefined,
  liveVideoStreamCount: number,
): RemoteMediaKind {
  if (metadataKind) return metadataKind;
  if (!stream.getVideoTracks().length) return 'audio';
  // Fallback seguro para a chegada fora de ordem do metadado. Quando câmera e
  // tela coexistem, não adivinhamos: o rtc:stream-meta fará a classificação.
  if (member?.screen && liveVideoStreamCount === 1) return 'screen';
  return 'camera';
}
