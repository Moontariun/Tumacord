import assert from 'node:assert/strict';
import test from 'node:test';
import { isPolitePeer, shouldInitiateRecovery, shouldQueueIceCandidate, shouldRecoverMutedAudio } from '../src/lib/rtcPolicy.js';

test('cada par escolhe exatamente um lado educado para colisões de oferta', () => {
  assert.notEqual(isPolitePeer('peer-a', 'peer-b'), isPolitePeer('peer-b', 'peer-a'));
});

test('cada reconstrução escolhe um único iniciador determinístico', () => {
  assert.equal(shouldInitiateRecovery('peer-a', 'peer-b'), true);
  assert.equal(shouldInitiateRecovery('peer-b', 'peer-a'), false);
});

test('candidato ICE recebido cedo fica na fila até a descrição remota', () => {
  assert.equal(shouldQueueIceCandidate(false), true);
  assert.equal(shouldQueueIceCandidate(true), false);
});

test('recupera áudio remoto mudo sem confundir mute intencional', () => {
  assert.equal(shouldRecoverMutedAudio({ trackMuted: true, remoteMuted: false, screen: false, screenAudioExpected: false }), true);
  assert.equal(shouldRecoverMutedAudio({ trackMuted: true, remoteMuted: true, screen: false, screenAudioExpected: false }), false);
  assert.equal(shouldRecoverMutedAudio({ trackMuted: true, remoteMuted: false, screen: true, screenAudioExpected: true }), true);
  assert.equal(shouldRecoverMutedAudio({ trackMuted: true, remoteMuted: false, screen: true, screenAudioExpected: false }), false);
});
