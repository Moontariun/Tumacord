import assert from 'node:assert/strict';
import test from 'node:test';
import { applySyncPlan, peerMediaIsSynced, planPeerMediaSync, type LocalTrack, type PeerSender } from '../src/lib/peerMediaSync';

const mic = (id = 'mic-1', readyState = 'live'): LocalTrack => ({ media: 'microphone', trackId: id, kind: 'audio', streamId: 'stream-mic', readyState });
const tela = (id = 'tela-1', readyState = 'live'): LocalTrack => ({ media: 'screen', trackId: id, kind: 'video', streamId: 'stream-tela', readyState });
const telaAudio = (id = 'tela-audio-1', readyState = 'live'): LocalTrack => ({ media: 'screen', trackId: id, kind: 'audio', streamId: 'stream-tela', readyState });
const camera = (id = 'cam-1', readyState = 'live'): LocalTrack => ({ media: 'camera', trackId: id, kind: 'video', streamId: 'stream-cam', readyState });

test('enlace novo recebe tudo que existe agora, sem precisar ter visto os eventos', () => {
  const plano = planPeerMediaSync([mic(), tela(), telaAudio()], []);
  assert.deepEqual(plano.actions.map((a) => a.type), ['add', 'add', 'add']);
  assert.equal(plano.needsNegotiation, true);
});

test('faixa já encerrada não é enviada para o enlace novo', () => {
  const plano = planPeerMediaSync([mic(), tela('tela-1', 'ended')], []);
  assert.deepEqual(plano.actions.map((a) => 'trackId' in a && a.trackId), ['mic-1']);
});

test('o que já está no lugar não gera ação nenhuma', () => {
  const senders: PeerSender[] = [{ senderId: 's1', kind: 'audio', trackId: 'mic-1' }];
  assert.deepEqual(planPeerMediaSync([mic()], senders), { actions: [], needsNegotiation: false });
  assert.equal(peerMediaIsSynced([mic()], senders), true);
});

// O ponto do módulo: cinco ciclos precisam se comportar igual ao primeiro.
test('start → stop → start → stop → start mantém o enlace coerente e sem acumular senders', () => {
  let senders: PeerSender[] = [{ senderId: 's-mic', kind: 'audio', trackId: 'mic-1' }];
  const historico: number[] = [];

  for (let ciclo = 1; ciclo <= 5; ciclo += 1) {
    // start: a captura sempre produz uma MediaStreamTrack NOVA.
    const ligada = [mic(), tela(`tela-${ciclo}`)];
    const inicio = planPeerMediaSync(ligada, senders);
    senders = applySyncPlan(senders, inicio, ligada);
    assert.equal(peerMediaIsSynced(ligada, senders), true, `ciclo ${ciclo}: live não ficou coerente`);
    assert.equal(senders.filter((s) => s.kind === 'video' && s.trackId).length, 1, `ciclo ${ciclo}: mais de um vídeo ativo`);

    // stop: a faixa termina e some do estado local.
    const parada = [mic()];
    const fim = planPeerMediaSync(parada, senders);
    senders = applySyncPlan(senders, fim, parada);
    assert.equal(peerMediaIsSynced(parada, senders), true, `ciclo ${ciclo}: parada não ficou coerente`);
    assert.equal(senders.every((s) => s.kind !== 'video' || s.trackId === null), true, `ciclo ${ciclo}: sobrou faixa de vídeo`);
    historico.push(senders.length);
  }

  assert.equal(new Set(historico).size, 1, `o número de senders cresceu ao longo dos ciclos: ${historico.join(', ')}`);
  assert.equal(senders.filter((s) => s.kind === 'video').length, 1, 'o sender de vídeo deve ser reaproveitado, não recriado');
});

test('o segundo start reaproveita o sender livre em vez de criar outro', () => {
  const senders: PeerSender[] = [
    { senderId: 's-mic', kind: 'audio', trackId: 'mic-1' },
    { senderId: 's-tela', kind: 'video', trackId: null },
  ];
  const plano = planPeerMediaSync([mic(), tela('tela-2')], senders);
  assert.deepEqual(plano.actions, [{ type: 'replace', senderId: 's-tela', trackId: 'tela-2', media: 'screen', streamId: 'stream-tela' }]);
  assert.equal(plano.needsNegotiation, false, 'trocar a faixa de um sender existente não muda o SDP');
});

test('sender preso a faixa encerrada é reaproveitado, não deixado como zumbi', () => {
  const senders: PeerSender[] = [{ senderId: 's-tela', kind: 'video', trackId: 'tela-1', trackEnded: true }];
  const plano = planPeerMediaSync([tela('tela-2')], senders);
  assert.deepEqual(plano.actions, [{ type: 'replace', senderId: 's-tela', trackId: 'tela-2', media: 'screen', streamId: 'stream-tela' }]);
});

test('parar a live limpa o sender em vez de deixar uma trilha morta no outro lado', () => {
  const senders: PeerSender[] = [
    { senderId: 's-mic', kind: 'audio', trackId: 'mic-1' },
    { senderId: 's-tela', kind: 'video', trackId: 'tela-1' },
  ];
  const plano = planPeerMediaSync([mic()], senders);
  assert.deepEqual(plano.actions, [{ type: 'clear', senderId: 's-tela' }]);
  assert.equal(plano.needsNegotiation, true);
});

test('live com áudio e depois sem áudio não deixa sender de áudio órfão', () => {
  let senders: PeerSender[] = [{ senderId: 's-mic', kind: 'audio', trackId: 'mic-1' }];
  const comAudio = [mic(), tela(), telaAudio()];
  senders = applySyncPlan(senders, planPeerMediaSync(comAudio, senders), comAudio);
  assert.equal(senders.filter((s) => s.kind === 'audio' && s.trackId).length, 2);

  const semAudio = [mic(), tela('tela-2')];
  senders = applySyncPlan(senders, planPeerMediaSync(semAudio, senders), semAudio);
  assert.equal(peerMediaIsSynced(semAudio, senders), true);
  assert.equal(senders.filter((s) => s.kind === 'audio' && s.trackId).length, 1, 'o áudio da live saiu, o do microfone fica');

  // E o ciclo seguinte com áudio reaproveita aquele sender vazio.
  const denovo = [mic(), tela('tela-3'), telaAudio('tela-audio-3')];
  const plano = planPeerMediaSync(denovo, senders);
  assert.equal(plano.actions.filter((a) => a.type === 'add').length, 0, 'nada precisa ser criado: os dois senders existem');
});

test('trocar de microfone reaproveita o sender de áudio existente', () => {
  const senders: PeerSender[] = [{ senderId: 's-mic', kind: 'audio', media: 'microphone', trackId: 'mic-antigo' }];
  const plano = planPeerMediaSync([mic('mic-novo')], senders);
  assert.deepEqual(plano.actions, [
    { type: 'replace', senderId: 's-mic', trackId: 'mic-novo', media: 'microphone', streamId: 'stream-mic' },
  ]);
  assert.equal(plano.needsNegotiation, false, 'trocar de microfone não deveria custar renegociação');
});

test('trocar o microfone não rouba o sender do áudio da live', () => {
  const senders: PeerSender[] = [
    { senderId: 's-mic', kind: 'audio', media: 'microphone', trackId: 'mic-antigo' },
    { senderId: 's-tela-audio', kind: 'audio', media: 'screen', trackId: 'tela-audio-1' },
  ];
  const plano = planPeerMediaSync([mic('mic-novo'), telaAudio()], senders);
  assert.deepEqual(plano.actions, [
    { type: 'replace', senderId: 's-mic', trackId: 'mic-novo', media: 'microphone', streamId: 'stream-mic' },
  ]);
});

test('câmera e live não disputam o mesmo sender de vídeo', () => {
  let senders: PeerSender[] = [];
  const comCamera = [mic(), camera()];
  senders = applySyncPlan(senders, planPeerMediaSync(comCamera, senders), comCamera);
  const comAmbos = [mic(), camera(), tela()];
  senders = applySyncPlan(senders, planPeerMediaSync(comAmbos, senders), comAmbos);
  assert.equal(senders.filter((s) => s.kind === 'video' && s.trackId).length, 2);
  assert.equal(peerMediaIsSynced(comAmbos, senders), true);
});

test('peer que entra no meio da live recebe o estado atual em uma passada', () => {
  const durante = [mic(), tela(), telaAudio()];
  const senders = applySyncPlan([], planPeerMediaSync(durante, []), durante);
  assert.equal(peerMediaIsSynced(durante, senders), true);
  assert.equal(senders.length, 3);
});

test('reconstruir o enlace do zero chega ao mesmo lugar que o incremental', () => {
  const estado = [mic(), tela(), telaAudio()];
  let incremental: PeerSender[] = [];
  incremental = applySyncPlan(incremental, planPeerMediaSync([mic()], incremental), [mic()]);
  incremental = applySyncPlan(incremental, planPeerMediaSync(estado, incremental), estado);
  const doZero = applySyncPlan([], planPeerMediaSync(estado, []), estado);
  const chaves = (lista: PeerSender[]) => lista.map((s) => `${s.kind}:${s.trackId}`).sort();
  assert.deepEqual(chaves(incremental), chaves(doZero));
});

test('sem mídia local nenhuma, todo sender ocupado é limpo', () => {
  const senders: PeerSender[] = [
    { senderId: 's-mic', kind: 'audio', trackId: 'mic-1' },
    { senderId: 's-tela', kind: 'video', trackId: 'tela-1' },
  ];
  const plano = planPeerMediaSync([], senders);
  assert.deepEqual(plano.actions.map((a) => a.type), ['clear', 'clear']);
});
