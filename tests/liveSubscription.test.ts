import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type WatchIntent,
  intentAfterAnnouncement,
  intentAfterBroadcasters,
  mediaBelongsToPeer,
  pendingWatchRequests,
} from '../src/lib/liveSubscription';
import { type LocalTrack, type PeerSender, planPeerMediaSync } from '../src/lib/peerMediaSync';

// A inscrição na live, que é a parte que erra em silêncio: quando ela erra,
// ninguém vê exceção — vê uma tela preta que não volta, ou a tela de alguém
// chegando sem ter sido pedida.
//
// Todos os casos deste arquivo reprovam no código da 0.9.9.

const connected = (...ids: string[]) => new Set(ids);

// ── O defeito relatado: a live cai e só volta reabrindo o aplicativo ────────
//
// O relato foi "quando a live buga e não recebe vídeo, eu tenho que reiniciar o
// Tumacord pra voltar". O motivo é este: o pedido era emitido uma vez, no
// clique, e o consentimento morava no estado do enlace. Todo enlace refeito
// nascia sem ele — e nada reemitia o pedido. Reabrir o aplicativo funcionava
// porque era o que levava a pessoa a clicar em "Assistir" outra vez.

test('um enlace refeito faz o pedido de assistir sair de novo', () => {
  const intent: WatchIntent = { 'socket-ana': 'tela-1' };
  const sent = new Map([['socket-ana', 'tela-1']]);

  // Em regime, nada é reemitido: o outro lado já sabe.
  assert.deepEqual(pendingWatchRequests(intent, sent, connected('socket-ana')), []);

  // O enlace é reconstruído — recuperação forçada, troca de host no P2P,
  // reconexão. `createPeer` zera o que foi enviado naquela geração, porque o
  // `watchingStream` do outro lado nasceu vazio.
  sent.delete('socket-ana');
  assert.deepEqual(
    pendingWatchRequests(intent, sent, connected('socket-ana')),
    [{ peerId: 'socket-ana', streamId: 'tela-1' }],
    'sem isto a live não volta, e reabrir o aplicativo é a única saída',
  );
});

test('a intenção sobrevive à queda do enlace e é reafirmada quando ele volta', () => {
  const intent: WatchIntent = { 'socket-ana': 'tela-1' };
  // Enquanto o peer não está conectado, não há a quem pedir — e a intenção
  // não é descartada por isso.
  assert.deepEqual(pendingWatchRequests(intent, new Map(), connected()), []);
  assert.deepEqual(pendingWatchRequests(intent, new Map(), connected('socket-ana')), [
    { peerId: 'socket-ana', streamId: 'tela-1' },
  ]);
});

test('quem não pediu para assistir não recebe pedido nenhum', () => {
  assert.deepEqual(pendingWatchRequests({}, new Map(), connected('socket-ana', 'socket-bia')), []);
});

test('duas lives ao mesmo tempo não se confundem', () => {
  const intent: WatchIntent = { 'socket-ana': 'tela-ana', 'socket-bia': 'tela-bia' };
  const sent = new Map([['socket-ana', 'tela-ana']]);
  assert.deepEqual(pendingWatchRequests(intent, sent, connected('socket-ana', 'socket-bia')), [
    { peerId: 'socket-bia', streamId: 'tela-bia' },
  ]);
});

// ── Reconexão à mesma live contra live nova ────────────────────────────────

test('reconectar à mesma live restaura a intenção; uma live nova exige nova escolha', () => {
  const intent: WatchIntent = { 'socket-ana': 'tela-1' };
  assert.equal(intentAfterAnnouncement(intent, 'socket-ana', 'tela-1'), intent, 'o mesmo id não muda nada');
  assert.deepEqual(intentAfterAnnouncement(intent, 'socket-ana', 'tela-2'), {}, 'outra transmissão exige outro sim');
  // Um anúncio de quem nunca foi assistido não inventa intenção, e devolve o
  // mesmo objeto — é assim que o hook sabe que não há nada a atualizar.
  const empty: WatchIntent = {};
  assert.equal(intentAfterAnnouncement(empty, 'socket-bia', 'tela-9'), empty);
});

test('a live nova de uma pessoa não derruba a intenção sobre a de outra', () => {
  const intent: WatchIntent = { 'socket-ana': 'tela-ana', 'socket-bia': 'tela-bia' };
  assert.deepEqual(intentAfterAnnouncement(intent, 'socket-ana', 'tela-ana-2'), { 'socket-bia': 'tela-bia' });
});

test('quem parou de transmitir perde a inscrição, e a próxima live não começa assistida', () => {
  const intent: WatchIntent = { 'socket-ana': 'tela-1', 'socket-bia': 'tela-2' };
  assert.deepEqual(intentAfterBroadcasters(intent, new Set(['socket-bia'])), { 'socket-bia': 'tela-2' });
  assert.equal(intentAfterBroadcasters(intent, new Set(['socket-ana', 'socket-bia'])), intent);
  assert.deepEqual(intentAfterBroadcasters(intent, new Set()), {});
});

// ── A tela só sai para quem assinou ────────────────────────────────────────

test('a tela só pertence ao enlace de quem assinou aquela transmissão', () => {
  assert.equal(mediaBelongsToPeer('screen', 'tela-1', 'tela-1'), true);
  assert.equal(mediaBelongsToPeer('screen', 'tela-1', ''), false, 'sem inscrição, a tela não entra no enlace');
  assert.equal(mediaBelongsToPeer('screen', 'tela-2', 'tela-1'), false, 'a inscrição é daquela transmissão, não da pessoa');
  // Microfone e câmera pertencem à call e vão para quem está nela.
  assert.equal(mediaBelongsToPeer('microphone', 'voz-1', ''), true);
  assert.equal(mediaBelongsToPeer('camera', 'cam-1', ''), true);
});

// A reconciliação periódica é o caminho por onde a tela vazava. Estes dois
// casos montam o plano exatamente como o hook o monta, com e sem a condição.

const screenTrack: LocalTrack = { media: 'screen', trackId: 'tela-video', kind: 'video', streamId: 'tela-1', readyState: 'live' };
const microphoneTrack: LocalTrack = { media: 'microphone', trackId: 'voz', kind: 'audio', streamId: 'voz-1', readyState: 'live' };

function localLinkMedia(watchingStream: string): LocalTrack[] {
  return [microphoneTrack, screenTrack].filter((track) => mediaBelongsToPeer(track.media, track.streamId, watchingStream));
}

test('a reconciliação não encaixa a live num sender livre de quem não assinou', () => {
  // Um peer que tem um sender de vídeo livre — a câmera dele, desligada.
  const senders: PeerSender[] = [
    { senderId: 's0', kind: 'audio', trackId: 'voz', media: 'microphone' },
    { senderId: 's1', kind: 'video', trackId: null, media: 'camera' },
  ];

  // O que a 0.9.9 fazia: nenhuma condição de inscrição, então a tela era
  // tratada como qualquer faixa local e caía no primeiro sender de vídeo
  // livre — o da câmera de quem nunca pediu para assistir.
  const previousPlan = planPeerMediaSync([microphoneTrack, screenTrack], senders);
  assert.deepEqual(
    previousPlan.actions,
    [{ type: 'replace', senderId: 's1', trackId: 'tela-video', media: 'screen', streamId: 'tela-1' }],
    'é este o comportamento que precisa deixar de acontecer',
  );

  const plan = planPeerMediaSync(localLinkMedia(''), senders);
  assert.deepEqual(plan.actions, [], 'sem inscrição, nada da tela entra neste enlace');

  // O mesmo peer, agora inscrito: aí sim a tela tem onde entrar.
  const subscribed = planPeerMediaSync(localLinkMedia('tela-1'), senders);
  assert.equal(subscribed.actions.length, 1);
  assert.equal(subscribed.actions[0].type, 'replace');
});

test('fechar a live não é desfeito pela reconciliação dez segundos depois', () => {
  // Depois do `removeTrack`, o sender da tela fica vazio no enlace de quem
  // parou de assistir. Antes, a reconciliação o via como "sender de vídeo
  // livre" e devolvia a faixa da tela para ele.
  const senders: PeerSender[] = [
    { senderId: 's0', kind: 'audio', trackId: 'voz', media: 'microphone' },
    { senderId: 's1', kind: 'video', trackId: null, media: 'screen' },
  ];
  assert.deepEqual(planPeerMediaSync(localLinkMedia(''), senders).actions, [], 'a live fechada continua fechada');
});

test('um sender que ficou com a faixa da tela de quem não assinou é limpo', () => {
  const senders: PeerSender[] = [
    { senderId: 's0', kind: 'audio', trackId: 'voz', media: 'microphone' },
    { senderId: 's1', kind: 'video', trackId: 'tela-video', media: 'screen' },
  ];
  assert.deepEqual(planPeerMediaSync(localLinkMedia(''), senders).actions, [{ type: 'clear', senderId: 's1' }]);
});

// ── A voz e a câmera não são afetadas por nada disso ───────────────────────

test('sair da live não tira a voz nem a câmera da call', () => {
  const camera: LocalTrack = { media: 'camera', trackId: 'cam', kind: 'video', streamId: 'cam-1', readyState: 'live' };
  const local = [microphoneTrack, camera, screenTrack].filter((track) => mediaBelongsToPeer(track.media, track.streamId, ''));
  assert.deepEqual(local.map((track) => track.media), ['microphone', 'camera'], 'só a tela depende da inscrição');
});
