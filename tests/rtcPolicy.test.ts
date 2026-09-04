import assert from 'node:assert/strict';
import test from 'node:test';
import { isPolitePeer, planPeerRecovery, recoveryCooldownMs, shouldInitiateRecovery, shouldQueueIceCandidate, shouldRecoverMutedAudio, stallSignalIsTrustworthy } from '../src/lib/rtcPolicy.js';

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

test('sintoma leve tenta ICE restart antes de derrubar o enlace', () => {
  const first = planPeerRecovery({ now: 100_000, lastAttemptAt: 0, attempts: 0, connectionState: 'connected', severity: 'soft' });
  assert.deepEqual(first, { action: 'ice-restart', attempts: 1 });
  const second = planPeerRecovery({ now: 200_000, lastAttemptAt: 100_000, attempts: 1, connectionState: 'connected', severity: 'soft' });
  assert.deepEqual(second, { action: 'ice-restart', attempts: 2 });
  const third = planPeerRecovery({ now: 300_000, lastAttemptAt: 200_000, attempts: 2, connectionState: 'connected', severity: 'soft' });
  assert.deepEqual(third, { action: 'rebuild', attempts: 3 });
});

test('enlace morto e faixa que nunca chegou vão direto para a reconstrução', () => {
  assert.equal(planPeerRecovery({ now: 100_000, lastAttemptAt: 0, attempts: 0, connectionState: 'failed', severity: 'soft' }).action, 'rebuild');
  assert.equal(planPeerRecovery({ now: 100_000, lastAttemptAt: 0, attempts: 0, connectionState: 'connected', severity: 'hard' }).action, 'rebuild');
});

test('tentativas seguidas se espaçam em vez de virar um laço de tela preta', () => {
  assert.equal(planPeerRecovery({ now: 5_000, lastAttemptAt: 0, attempts: 1, connectionState: 'connected', severity: 'soft' }).action, 'wait');
  assert.equal(recoveryCooldownMs('soft', 0), 12_000);
  assert.ok(recoveryCooldownMs('soft', 3) > recoveryCooldownMs('soft', 1));
  assert.equal(recoveryCooldownMs('soft', 9), 60_000);
});

test('estatística de recuperação só vale com o enlace de pé e fora da janela de reconstrução', () => {
  assert.equal(stallSignalIsTrustworthy({ connectionState: 'connected', msSinceLastRecovery: 30_000 }), true);
  assert.equal(stallSignalIsTrustworthy({ connectionState: 'connected', msSinceLastRecovery: 3_000 }), false);
  assert.equal(stallSignalIsTrustworthy({ connectionState: 'connecting', msSinceLastRecovery: 30_000 }), false);
});
