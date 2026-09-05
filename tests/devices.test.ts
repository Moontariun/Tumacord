import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanDeviceLabel, normalizeSpeakerId, reconcileDevicePreferences, visibleAudioInputs, visibleAudioOutputs } from '../src/hooks/useDevices.js';

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

test('entradas virtuais do Chromium não duplicam o microfone na lista', () => {
  const inputs = visibleAudioInputs([
    { kind: 'audioinput', deviceId: 'default', label: 'Padrão - Microfone (HyperX)' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Comunicações - Microfone (HyperX)' },
    { kind: 'audioinput', deviceId: 'mic-hyperx', label: 'Microfone (HyperX)' },
    { kind: 'audioinput', deviceId: 'mic-webcam', label: 'Microfone (Webcam)' },
    { kind: 'audiooutput', deviceId: 'saida-1', label: 'Saída' },
  ] as Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]);
  assert.deepEqual(inputs.map((device) => device.deviceId), ['mic-hyperx', 'mic-webcam']);
});

test('o mesmo hardware publicado por dois back-ends aparece uma única vez', () => {
  const inputs = visibleAudioInputs([
    { kind: 'audioinput', deviceId: 'alsa-mic', label: 'Microfone (HyperX)' },
    { kind: 'audioinput', deviceId: 'pipewire-mic', label: 'Microfone (HyperX)' },
  ] as Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]);
  assert.equal(inputs.length, 1);
});

test('rótulo perde o prefixo virtual mas mantém o nome do aparelho', () => {
  assert.equal(cleanDeviceLabel('Padrão - Microfone (HyperX)'), 'Microfone (HyperX)');
  assert.equal(cleanDeviceLabel('Default - Built-in Audio'), 'Built-in Audio');
  assert.equal(cleanDeviceLabel('Microfone (HyperX)'), 'Microfone (HyperX)');
});

test('microfone virtual salvo volta a ser o padrão do sistema', () => {
  assert.deepEqual(reconcileDevicePreferences(
    { microphoneId: 'default', cameraId: '', speakerId: '', noiseSuppression: true },
    [{ kind: 'audioinput', deviceId: 'default', label: 'Padrão - Microfone' }] as Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[],
  ).microphoneId, '');
});
