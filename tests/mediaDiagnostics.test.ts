import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deviceMismatch,
  describeMicrophonePipeline,
  diagnoseMicrophone,
  firstBrokenLayer,
  type MicrophonePipelineSnapshot,
} from '../src/lib/mediaDiagnostics';

const viva = { readyState: 'live', enabled: true, muted: false };

function retrato(patch: Partial<MicrophonePipelineSnapshot> = {}): MicrophonePipelineSnapshot {
  return {
    desired: true,
    userMuted: false,
    requestedDeviceId: '',
    acquiredDeviceId: 'id-fifine',
    raw: { ...viva },
    rawLevel: 0.05,
    neural: true,
    processedLevel: 0.04,
    output: { ...viva },
    peers: [{ peerId: 'p1', hasAudioSender: true, senderHasTrack: true, connectionState: 'connected', receivingAudio: true }],
    ...patch,
  };
}

test('com tudo no lugar, nenhuma camada aparece quebrada', () => {
  assert.equal(firstBrokenLayer(retrato()), null);
  assert.deepEqual(diagnoseMicrophone(retrato()).map((v) => v.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
});

// O ponto do módulo: o mesmo sintoma vem de camadas diferentes, e cada uma
// pede um conserto diferente.
test('captura que abre sem receber amostra é apontada na camada de captura', () => {
  const quebrada = firstBrokenLayer(retrato({ rawLevel: 0, processedLevel: 0 }));
  assert.equal(quebrada?.layer, 'capture');
  assert.match(quebrada!.detail, /não recebe amostra/);
});

test('filtro neural travado é apontado no processamento, não na captura', () => {
  const quebrada = firstBrokenLayer(retrato({ rawLevel: 0.05, processedLevel: 0 }));
  assert.equal(quebrada?.layer, 'processing');
  assert.match(quebrada!.detail, /recebe áudio e não devolve/);
});

test('faixa viva que nunca chegou ao sender é apontada no envio', () => {
  const quebrada = firstBrokenLayer(retrato({
    peers: [{ peerId: 'p1', hasAudioSender: false, senderHasTrack: false, connectionState: 'connected' }],
  }));
  assert.equal(quebrada?.layer, 'sender');
});

test('sender existente mas sem faixa também é falha de envio', () => {
  const quebrada = firstBrokenLayer(retrato({
    peers: [{ peerId: 'p1', hasAudioSender: true, senderHasTrack: false, connectionState: 'connected' }],
  }));
  assert.equal(quebrada?.layer, 'sender');
  assert.match(quebrada!.detail, /sem faixa atribuída/);
});

test('enlace que não conectou é apontado na camada do peer', () => {
  const quebrada = firstBrokenLayer(retrato({
    peers: [{ peerId: 'p1', hasAudioSender: true, senderHasTrack: true, connectionState: 'failed' }],
  }));
  assert.equal(quebrada?.layer, 'peer');
});

test('tudo certo aqui e o outro lado sem receber é falha de recepção', () => {
  const quebrada = firstBrokenLayer(retrato({
    peers: [{ peerId: 'p1', hasAudioSender: true, senderHasTrack: true, connectionState: 'connected', receivingAudio: false }],
  }));
  assert.equal(quebrada?.layer, 'remote');
});

test('a primeira camada quebrada é a que vale; as de baixo quebram por consequência', () => {
  const quebrada = firstBrokenLayer(retrato({
    raw: null, rawLevel: null, output: null,
    peers: [{ peerId: 'p1', hasAudioSender: false, senderHasTrack: false, connectionState: 'failed', receivingAudio: false }],
  }));
  assert.equal(quebrada?.layer, 'capture', 'apontar a recepção aqui seria tratar sintoma');
});

test('faixa do sistema silenciada aparece como falha de captura', () => {
  assert.equal(firstBrokenLayer(retrato({ raw: { ...viva, muted: true } }))?.layer, 'capture');
  assert.equal(firstBrokenLayer(retrato({ raw: { ...viva, readyState: 'ended' } }))?.layer, 'capture');
});

test('sala quieta não é falha: fica como desconhecido, não como quebrado', () => {
  const verdicts = diagnoseMicrophone(retrato({ rawLevel: 0.001, processedLevel: 0.0009 }));
  assert.equal(verdicts[0].status, 'unknown');
  assert.equal(firstBrokenLayer(retrato({ rawLevel: 0.001, processedLevel: 0.0009 })), null);
});

test('ausência de medida não vira acusação', () => {
  assert.equal(firstBrokenLayer(retrato({ rawLevel: null, processedLevel: null })), null);
  assert.equal(diagnoseMicrophone(retrato({ rawLevel: null }))[0].status, 'unknown');
});

test('quem se mutou de propósito não aparece como defeito', () => {
  const verdicts = diagnoseMicrophone(retrato({ userMuted: true, output: { ...viva, enabled: false } }));
  assert.equal(verdicts[2].status, 'idle');
  assert.equal(firstBrokenLayer(retrato({ userMuted: true, output: { ...viva, enabled: false } })), null);
});

test('faixa desabilitada sem o usuário ter se mutado é defeito de verdade', () => {
  assert.equal(firstBrokenLayer(retrato({ userMuted: false, output: { ...viva, enabled: false } }))?.layer, 'track');
});

test('sem filtro neural a camada de processamento sai de cena', () => {
  const verdicts = diagnoseMicrophone(retrato({ neural: false, processedLevel: null }));
  assert.equal(verdicts[1].status, 'idle');
  assert.equal(firstBrokenLayer(retrato({ neural: false, processedLevel: null })), null);
});

test('sozinho na call, envio e enlace ficam ociosos em vez de quebrados', () => {
  const verdicts = diagnoseMicrophone(retrato({ peers: [] }));
  assert.deepEqual(verdicts.slice(3).map((v) => v.status), ['idle', 'idle', 'unknown']);
  assert.equal(firstBrokenLayer(retrato({ peers: [] })), null);
});

test('microfone desligado por escolha não gera diagnóstico de falha', () => {
  assert.deepEqual(diagnoseMicrophone(retrato({ desired: false })).map((v) => v.status), ['idle']);
  assert.match(describeMicrophonePipeline(retrato({ desired: false })), /desligado/);
});

test('a descrição nomeia a camada em português', () => {
  assert.match(describeMicrophonePipeline(retrato({ rawLevel: 0 })), /^Captura:/);
  assert.match(describeMicrophonePipeline(retrato({ rawLevel: 0.05, processedLevel: 0 })), /^Processamento:/);
  assert.match(describeMicrophonePipeline(retrato()), /Nenhuma falha/);
});

// "Padrão do sistema" esconde qual aparelho foi realmente aberto.
test('divergência entre o dispositivo pedido e o adquirido é detectada', () => {
  assert.equal(deviceMismatch({ requestedDeviceId: 'id-fifine', acquiredDeviceId: 'id-webcam' }), true);
  assert.equal(deviceMismatch({ requestedDeviceId: 'id-fifine', acquiredDeviceId: 'id-fifine' }), false);
  assert.equal(deviceMismatch({ requestedDeviceId: '', acquiredDeviceId: 'id-webcam' }), false, 'pedir o padrão não é divergência');
  assert.equal(deviceMismatch({ requestedDeviceId: 'id-fifine', acquiredDeviceId: '' }), false, 'sem informação não se acusa');
});
