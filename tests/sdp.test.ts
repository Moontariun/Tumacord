import assert from 'node:assert/strict';
import test from 'node:test';
import { applyVideoBitrateHints } from '../src/lib/sdp.js';

const hints = { startKbps: 5_600, minKbps: 2_000, maxKbps: 8_000 };

const sdp = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98',
  'c=IN IP4 0.0.0.0',
  'b=AS:600',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=fmtp:98 profile-id=0',
].join('\r\n');

test('a seção de vídeo recebe piso, teto e ponto de partida de bitrate', () => {
  const tuned = applyVideoBitrateHints(sdp, hints).split('\r\n');
  assert.ok(tuned.includes('b=AS:8000'));
  assert.ok(tuned.includes('b=TIAS:8000000'));
  assert.equal(tuned.filter((line) => line.startsWith('b=AS:')).length, 1);
  assert.ok(tuned.includes('a=fmtp:98 profile-id=0;x-google-start-bitrate=5600;x-google-min-bitrate=2000;x-google-max-bitrate=8000'));
  assert.ok(tuned.includes('a=fmtp:96 x-google-start-bitrate=5600;x-google-min-bitrate=2000;x-google-max-bitrate=8000'));
});

test('o áudio e a redundância rtx ficam intactos', () => {
  const tuned = applyVideoBitrateHints(sdp, hints).split('\r\n');
  assert.ok(tuned.includes('a=fmtp:111 minptime=10;useinbandfec=1'));
  assert.ok(tuned.includes('a=fmtp:97 apt=96'));
  assert.equal(tuned.filter((line) => line.startsWith('a=fmtp:97')).length, 1);
});

test('reaplicar as dicas não acumula parâmetros repetidos', () => {
  const once = applyVideoBitrateHints(sdp, hints);
  const twice = applyVideoBitrateHints(once, hints);
  assert.equal(once, twice);
});

test('uma sessão sem vídeo passa sem alteração', () => {
  const audioOnly = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2';
  assert.equal(applyVideoBitrateHints(audioOnly, hints), audioOnly);
});
