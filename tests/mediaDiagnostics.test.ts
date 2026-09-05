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

// --- relatório copiável ---

import { formatDiagnosticReport, type DiagnosticContext } from '../src/lib/mediaDiagnostics';

const contexto: DiagnosticContext = {
  version: '0.8.1',
  connectionMode: 'server',
  stunConfigured: true,
  turnConfigured: true,
  paths: [{ peerId: 'socket-abcdef123456', path: { local: 'relay', remote: 'srflx', protocol: 'udp', family: 'IPv4', relayed: true, roundTripMs: 42 } }],
};

test('o relatório nomeia a camada quebrada e o caminho de cada enlace', () => {
  const texto = formatDiagnosticReport(retrato({
    rawLevel: 0,
    peers: [{ peerId: 'socket-abcdef123456', hasAudioSender: true, senderHasTrack: true, connectionState: 'connected' }],
  }), contexto);
  assert.match(texto, /capture\s+BROKEN/);
  assert.match(texto, /relay · IPv4 · UDP · 42 ms/);
  assert.match(texto, /^Captura:/m);
  assert.match(texto, /Tumacord 0\.8\.1 · modo servidor/);
});

// O relatório é feito para ser colado em uma conversa.
test('nada que dê acesso ou identifique aparece no relatório', () => {
  const texto = formatDiagnosticReport(retrato({
    requestedDeviceId: 'a'.repeat(64),
    acquiredDeviceId: 'b'.repeat(64),
    peers: [{ peerId: 'socket-abcdef123456', hasAudioSender: true, senderHasTrack: true, connectionState: 'connected' }],
  }), contexto);
  assert.equal(texto.includes('a'.repeat(64)), false, 'o id completo do dispositivo não sai');
  assert.equal(texto.includes('socket-abcdef123456'), false, 'o id completo do enlace não sai');
  assert.equal(/\d{1,3}(\.\d{1,3}){3}/.test(texto), false, 'nenhum endereço IPv4');
  for (const proibido of ['token', 'Bearer', 'credential', 'senha', 'password', 'secret', 'TUMA1.']) {
    assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false, `"${proibido}" não pode aparecer`);
  }
});

test('sozinho na call o relatório diz isso em vez de mostrar uma lista vazia', () => {
  assert.match(formatDiagnosticReport(retrato({ peers: [] }), { ...contexto, paths: [] }), /ninguém mais na call/);
});

test('sem TURN configurado o relatório não sugere que ele existe', () => {
  const texto = formatDiagnosticReport(retrato(), { ...contexto, turnConfigured: false, stunConfigured: false });
  assert.match(texto, /STUN desligado · TURN indisponível/);
});
