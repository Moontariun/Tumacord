import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpeakerId, visibleAudioOutputs } from '../src/hooks/useDevices.js';

test('saídas pseudo do Chromium usam o padrão real do sistema', () => {
  assert.equal(normalizeSpeakerId(''), '');
  assert.equal(normalizeSpeakerId('default'), '');
  assert.equal(normalizeSpeakerId('communications'), '');
  assert.equal(normalizeSpeakerId('alsa-output-1'), 'alsa-output-1');
});

test('lista mostra uma única opção padrão seguida apenas de saídas reais', () => {
  const outputs = visibleAudioOutputs([
    { kind: 'audiooutput', deviceId: 'default' },
    { kind: 'audiooutput', deviceId: 'communications' },
    { kind: 'audiooutput', deviceId: 'alsa-output-1' },
    { kind: 'audioinput', deviceId: 'mic-1' },
  ] as Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]);
  assert.deepEqual(outputs.map((device) => device.deviceId), ['alsa-output-1']);
});
