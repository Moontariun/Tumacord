import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRemoteStream, prunePeerStreamMetadata, streamMetadataKey } from '../src/lib/streamMeta.js';

function stream(videoTracks: number): Pick<MediaStream, 'getVideoTracks'> {
  return { getVideoTracks: () => Array.from({ length: videoTracks }) as MediaStreamTrack[] };
}

test('rtc:resync preserva o metadado da live e saída definitiva o remove', () => {
  const metadata = new Map([[streamMetadataKey('peer-a', 'screen-1'), 'screen' as const]]);
  prunePeerStreamMetadata(metadata, 'peer-a', 'recovery');
  assert.equal(metadata.get('peer-a:screen-1'), 'screen', 'a reconstrução reutiliza o mesmo MediaStream.id');
  prunePeerStreamMetadata(metadata, 'peer-a', 'departure');
  assert.equal(metadata.size, 0);
});

test('uma única faixa de vídeo anunciada como live tem fallback de tela', () => {
  assert.equal(classifyRemoteStream(undefined, stream(0), { screen: true }, 0), 'audio');
  assert.equal(classifyRemoteStream(undefined, stream(1), { screen: true }, 1), 'screen');
  assert.equal(classifyRemoteStream(undefined, stream(1), { screen: true }, 2), 'camera');
  assert.equal(classifyRemoteStream('screen', stream(1), { screen: false }, 2), 'screen');
});
