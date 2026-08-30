import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isCallAudio } = require('../desktop/audio-router.cjs') as { isCallAudio: (input: unknown) => boolean };

test('mantém Discord fora do barramento da transmissão', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'WEBRTC VoiceEngine', 'application.process.binary': 'Discord' } }), true);
});

test('mantém o próprio Tumacord fora do barramento da transmissão', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'Tumacord', 'application.id': 'br.com.tumacord.app' } }), true);
});

test('inclui jogos e aplicativos comuns no áudio da tela', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'FMOD Audio', 'application.process.binary': 'game' } }), false);
});
