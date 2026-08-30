import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { activePipewireLinks, isCallAudio } = require('../desktop/audio-router.cjs') as {
  activePipewireLinks: (graph: unknown[]) => Set<string>;
  isCallAudio: (input: unknown) => boolean;
};

test('mantém Discord fora do barramento da transmissão', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'WEBRTC VoiceEngine', 'application.process.binary': 'Discord' } }), true);
});

test('mantém o próprio Tumacord fora do barramento da transmissão', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'Tumacord', 'application.id': 'br.com.tumacord.app' } }), true);
});

test('inclui jogos e aplicativos comuns no áudio da tela', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'FMOD Audio', 'application.process.binary': 'game' } }), false);
});

test('usa os links ativos do grafo PipeWire em vez de confiar em cache antigo', () => {
  const links = activePipewireLinks([
    { type: 'PipeWire:Interface:Port', id: 10 },
    { type: 'PipeWire:Interface:Link', info: { props: { 'link.output.port': 42, 'link.input.port': 77 } } },
  ]);
  assert.deepEqual([...links], ['42:77']);
  assert.equal(links.has('12:77'), false);
});
