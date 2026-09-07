import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_ABSENCE_GRACE_MS, cleanDeviceLabel, normalizeSpeakerId, preserveKnownDevices, reconcileDevicePreferences, visibleAudioInputs, visibleAudioOutputs, visibleVideoInputs } from '../src/hooks/useDevices.js';

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
  const preservados = preserveKnownDevices(conhecidos, []).devices;
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
  const resultado = preserveKnownDevices(conhecidos, proximos).devices;
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
  assert.deepEqual(visibleAudioInputs(preserveKnownDevices(conhecidos, soVirtuais).devices).map((device) => device.deviceId), ['mic-1']);
});

test('sem nada conhecido antes, a lista vazia continua vazia', () => {
  assert.deepEqual(preserveKnownDevices([], []).devices, []);
});

// O outro lado da moeda, e a razão de a preservação ser uma janela e não uma
// memória: quem tem um único microfone e o desconecta produz uma enumeração
// vazia que está CERTA. Preservar para sempre deixava um aparelho fantasma no
// seletor — escolhê-lo falhava e caía no padrão do sistema. Trocar um defeito
// por outro.
test('aparelho realmente removido some quando a janela de preservação vence', () => {
  const conhecidos = [{ kind: 'audioinput', deviceId: 'mic-usb', label: 'USB PnP Sound Device' }] as MediaDeviceInfo[];
  const inicio = 1_000_000;

  // Logo depois de sumir, ainda é a sacudida do grafo: o aparelho fica.
  const durante = preserveKnownDevices(conhecidos, [], {}, inicio);
  assert.deepEqual(visibleAudioInputs(durante.devices).map((d) => d.deviceId), ['mic-usb']);
  assert.equal(typeof durante.recheckInMs, 'number', 'quem resgata precisa pedir para ser reexaminado');

  // A meio caminho, idem — e a marca de quando o vazio começou não se move.
  const meio = preserveKnownDevices(durante.devices, [], durante.absence, inicio + DEVICE_ABSENCE_GRACE_MS / 2);
  assert.deepEqual(visibleAudioInputs(meio.devices).map((d) => d.deviceId), ['mic-usb']);
  assert.equal(meio.absence.audioinput, inicio);

  // Passada a janela, o vazio é a verdade.
  const depois = preserveKnownDevices(meio.devices, [], meio.absence, inicio + DEVICE_ABSENCE_GRACE_MS + 1);
  assert.deepEqual(visibleAudioInputs(depois.devices), []);
  assert.equal(depois.recheckInMs, undefined, 'sem resgate não há o que reexaminar');

  // E não volta sozinho depois disso.
  const bemDepois = preserveKnownDevices(depois.devices, [], depois.absence, inicio + 60 * 60_000);
  assert.deepEqual(visibleAudioInputs(bemDepois.devices), []);
});

test('o relógio da janela zera quando o aparelho reaparece', () => {
  const conhecidos = [{ kind: 'videoinput', deviceId: 'cam', label: 'Webcam' }] as MediaDeviceInfo[];
  const inicio = 2_000_000;
  const sumiu = preserveKnownDevices(conhecidos, [], {}, inicio);
  assert.equal(sumiu.absence.videoinput, inicio);

  const voltou = preserveKnownDevices(sumiu.devices, conhecidos, sumiu.absence, inicio + 1_000);
  assert.equal(voltou.absence.videoinput, undefined, 'tipo que respondeu não está vazio');

  // Some de novo bem depois: a janela recomeça, não herda o vazio antigo.
  const sumiuOutraVez = preserveKnownDevices(voltou.devices, [], voltou.absence, inicio + 100_000);
  assert.deepEqual(visibleVideoInputs(sumiuOutraVez.devices).map((d) => d.deviceId), ['cam']);
});

// Cada tipo tem a própria janela: a câmera sumir não pode encurtar a do
// microfone, nem o contrário.
test('as janelas de cada tipo correm em separado', () => {
  const conhecidos = [
    { kind: 'audioinput', deviceId: 'mic', label: 'Microfone' },
    { kind: 'videoinput', deviceId: 'cam', label: 'Webcam' },
  ] as MediaDeviceInfo[];
  const t = 3_000_000;
  // O microfone some primeiro.
  const soCamera = [conhecidos[1]];
  let estado = preserveKnownDevices(conhecidos, soCamera, {}, t);
  assert.equal(estado.absence.audioinput, t);
  assert.equal(estado.absence.videoinput, undefined);

  // A câmera some bem depois, quando a janela do microfone já venceu.
  estado = preserveKnownDevices(estado.devices, [], estado.absence, t + DEVICE_ABSENCE_GRACE_MS + 1);
  assert.deepEqual(visibleAudioInputs(estado.devices), [], 'o microfone já tinha vencido o prazo');
  assert.deepEqual(visibleVideoInputs(estado.devices).map((d) => d.deviceId), ['cam'], 'a câmera acabou de sumir');
});
