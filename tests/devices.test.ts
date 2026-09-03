import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpeakerId, reconcileDevicePreferences, visibleAudioOutputs } from '../src/hooks/useDevices.js';

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

test('dispositivo removido volta ao padrão e preserva os que ainda existem', () => {
  const preferences = reconcileDevicePreferences({
    microphoneId: 'mic-removido',
    cameraId: 'camera-ok',
    speakerId: 'saida-removida',
    noiseSuppression: true,
  }, [
    { kind: 'audioinput', deviceId: 'mic-novo', label: 'Microfone novo' },
    { kind: 'videoinput', deviceId: 'camera-ok', label: 'Câmera conectada' },
    { kind: 'audiooutput', deviceId: 'saida-nova', label: 'Saída nova' },
  ] as Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]);
  assert.deepEqual(preferences, { microphoneId: '', cameraId: 'camera-ok', speakerId: '', noiseSuppression: true });
});

test('enumeração limitada antes da permissão não apaga dispositivos salvos ao relogar', () => {
  const preferences = { microphoneId: 'mic-salvo', cameraId: 'camera-salva', speakerId: '', noiseSuppression: true };
  assert.deepEqual(reconcileDevicePreferences(preferences, [
    { kind: 'audioinput', deviceId: 'default', label: '' },
    { kind: 'videoinput', deviceId: '', label: '' },
  ]), preferences);
});
