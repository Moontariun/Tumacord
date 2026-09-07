import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanDeviceLabel, normalizeSpeakerId, preserveKnownDevices, reconcileDevicePreferences, visibleAudioInputs, visibleAudioOutputs, visibleVideoInputs } from '../src/hooks/useDevices.js';

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

// A lista de dispositivos era substituída por completo a cada `devicechange`.
// No Linux esse evento chega em rajada: o PipeWire sacode o grafo quando outro
// programa abre ou solta uma captura, e o próprio Tumacord carrega e descarrega
// módulos ao montar o barramento de áudio da live. Nessas janelas
// `enumerateDevices()` responde uma lista curta — às vezes vazia —, e o
// seletor de microfone ficava só com "Padrão do sistema" antes de voltar
// sozinho. Nenhum aparelho tinha sido tocado.
test('enumeração vazia não apaga os dispositivos que já eram conhecidos', () => {
  const conhecidos = [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'USB PnP Sound Device' },
    { kind: 'audiooutput', deviceId: 'saida-1', label: 'Fone' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam' },
  ] as MediaDeviceInfo[];
  const preservados = preserveKnownDevices(conhecidos, []);
  assert.deepEqual(visibleAudioInputs(preservados).map((device) => device.deviceId), ['mic-1']);
  assert.deepEqual(visibleAudioOutputs(preservados).map((device) => device.deviceId), ['saida-1']);
  assert.deepEqual(visibleVideoInputs(preservados).map((device) => device.deviceId), ['cam-1']);
});

test('cada tipo é julgado sozinho: só o que veio vazio é preservado', () => {
  const conhecidos = [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'USB PnP Sound Device' },
    { kind: 'audioinput', deviceId: 'mic-2', label: 'Microfone da webcam' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam' },
  ] as MediaDeviceInfo[];
  // O navegador respondeu sobre microfones — e agora só existe um. Isso é uma
  // resposta de verdade e precisa valer: o aparelho desligado some da lista.
  const proximos = [{ kind: 'audioinput', deviceId: 'mic-1', label: 'USB PnP Sound Device' }] as MediaDeviceInfo[];
  const resultado = preserveKnownDevices(conhecidos, proximos);
  assert.deepEqual(visibleAudioInputs(resultado).map((device) => device.deviceId), ['mic-1']);
  // Sobre câmeras ele não disse nada, então a que se conhecia continua lá.
  assert.deepEqual(visibleVideoInputs(resultado).map((device) => device.deviceId), ['cam-1']);
});

test('uma lista só com as entradas virtuais do Chromium conta como vazia', () => {
  const conhecidos = [{ kind: 'audioinput', deviceId: 'mic-1', label: 'USB PnP Sound Device' }] as MediaDeviceInfo[];
  const soVirtuais = [
    { kind: 'audioinput', deviceId: 'default', label: '' },
    { kind: 'audioinput', deviceId: 'communications', label: '' },
  ] as MediaDeviceInfo[];
  assert.deepEqual(visibleAudioInputs(preserveKnownDevices(conhecidos, soVirtuais)).map((device) => device.deviceId), ['mic-1']);
});

test('sem nada conhecido antes, a lista vazia continua vazia', () => {
  assert.deepEqual(preserveKnownDevices([], []), []);
});
