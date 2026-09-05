// O que precisa acontecer em um enlace para ele refletir a mídia local atual.
//
// Havia três laços diferentes aplicando faixas a peers — ao criar o enlace, ao
// iniciar uma captura e ao trocar o microfone —, cada um com a própria regra
// de `addTrack` contra `replaceTrack`. Três regras para a mesma pergunta é
// como um ciclo de live nasce diferente do anterior: na primeira vez o sender
// é criado, na segunda ele já existe vazio, e o caminho tomado depende de qual
// dos três laços chegou primeiro.
//
// Aqui a pergunta é feita uma vez só, e a resposta é uma lista de ações. Sem
// WebRTC no meio, dá para testar cinco ciclos de start/stop sem uma call.
//
// A regra: reaproveitar um sender livre do mesmo tipo antes de criar outro.
// `addTrack` até reaproveita um transceiver compatível, mas só quando existe
// um; alternar faixas presentes e ausentes entre ciclos acumula transceivers
// que nunca mais recebem faixa.

export type LocalMediaKind = 'microphone' | 'camera' | 'screen';
export type TrackKind = 'audio' | 'video';

export interface LocalTrack {
  media: LocalMediaKind;
  trackId: string;
  kind: TrackKind;
  streamId: string;
  readyState: string;
}

export interface PeerSender {
  senderId: string;
  kind: TrackKind;
  trackId: string | null;
  // Qual mídia local este sender carrega. Sem isso não dá para distinguir
  // "trocar o microfone" de "abrir mais uma trilha de áudio": nos dois casos
  // existe um sender de áudio ocupado, e só um deles deve ser reaproveitado.
  media?: LocalMediaKind;
  // Uma faixa encerrada ainda ocupa o sender e não produz mídia nenhuma.
  trackEnded?: boolean;
}

export type SyncAction =
  | { type: 'replace'; senderId: string; trackId: string; media: LocalMediaKind; streamId: string }
  | { type: 'add'; trackId: string; media: LocalMediaKind; streamId: string; kind: TrackKind }
  | { type: 'clear'; senderId: string };

export interface SyncPlan {
  actions: SyncAction[];
  // Só renegocia quando a topologia muda. Um `replaceTrack` em sender que já
  // existe não muda o SDP, e renegociar à toa custa um congelamento de vídeo.
  needsNegotiation: boolean;
}

function isUsable(track: LocalTrack): boolean {
  return track.readyState === 'live';
}

function senderIsFree(sender: PeerSender): boolean {
  return sender.trackId === null || sender.trackEnded === true;
}

export function planPeerMediaSync(local: readonly LocalTrack[], senders: readonly PeerSender[]): SyncPlan {
  const wanted = local.filter(isUsable);
  const liveWanted = new Set(wanted.map((track) => track.trackId));
  const actions: SyncAction[] = [];
  const claimed = new Set<string>();
  let topologyChanged = false;

  // 1. Faixas que já estão no sender certo não geram ação nenhuma.
  const alreadyAttached = new Set<string>();
  for (const track of wanted) {
    const holder = senders.find((sender) => sender.trackId === track.trackId && !sender.trackEnded);
    if (!holder) continue;
    claimed.add(holder.senderId);
    alreadyAttached.add(track.trackId);
  }

  // 2. O resto entra em um sender livre do mesmo tipo, ou em um novo.
  for (const track of wanted) {
    if (alreadyAttached.has(track.trackId)) continue;
    const free = senders.find((sender) => !claimed.has(sender.senderId) && sender.kind === track.kind && senderIsFree(sender));
    if (free) {
      claimed.add(free.senderId);
      actions.push({ type: 'replace', senderId: free.senderId, trackId: track.trackId, media: track.media, streamId: track.streamId });
      continue;
    }
    // Trocar de microfone ou de câmera substitui a faixa do mesmo papel. O
    // sender continua o mesmo, então não há renegociação — criar outro aqui
    // custaria um congelamento em cada troca de dispositivo.
    const superseded = senders.find((sender) => !claimed.has(sender.senderId)
      && sender.kind === track.kind
      && sender.media === track.media
      && sender.trackId !== null
      && !liveWanted.has(sender.trackId));
    if (superseded) {
      claimed.add(superseded.senderId);
      actions.push({ type: 'replace', senderId: superseded.senderId, trackId: track.trackId, media: track.media, streamId: track.streamId });
      continue;
    }
    actions.push({ type: 'add', trackId: track.trackId, media: track.media, streamId: track.streamId, kind: track.kind });
    topologyChanged = true;
  }

  // 3. Sender que ficou segurando uma faixa que não existe mais é limpo. Sem
  // isso o outro lado continua vendo uma trilha que nunca mais produz nada.
  const liveIds = new Set(wanted.map((track) => track.trackId));
  for (const sender of senders) {
    if (claimed.has(sender.senderId)) continue;
    if (sender.trackId === null) continue;
    if (liveIds.has(sender.trackId) && !sender.trackEnded) continue;
    actions.push({ type: 'clear', senderId: sender.senderId });
    topologyChanged = true;
  }

  return { actions, needsNegotiation: topologyChanged };
}

// Um enlace está coerente quando aplicar o plano não produziria ação alguma.
export function peerMediaIsSynced(local: readonly LocalTrack[], senders: readonly PeerSender[]): boolean {
  return planPeerMediaSync(local, senders).actions.length === 0;
}

// Aplica o plano ao retrato dos senders, para o chamador — e os testes —
// poderem verificar onde o enlace foi parar sem tocar em WebRTC.
export function applySyncPlan(senders: readonly PeerSender[], plan: SyncPlan, local: readonly LocalTrack[]): PeerSender[] {
  const next = senders.map((sender) => ({ ...sender }));
  let created = 0;
  for (const action of plan.actions) {
    if (action.type === 'clear') {
      const target = next.find((sender) => sender.senderId === action.senderId);
      if (target) { target.trackId = null; target.trackEnded = false; }
      continue;
    }
    if (action.type === 'replace') {
      const target = next.find((sender) => sender.senderId === action.senderId);
      if (target) { target.trackId = action.trackId; target.media = action.media; target.trackEnded = false; }
      continue;
    }
    created += 1;
    next.push({ senderId: `novo-${created}-${action.trackId}`, kind: action.kind, media: action.media, trackId: action.trackId, trackEnded: false });
  }
  // Faixas encerradas depois do plano continuam marcadas, para o ciclo
  // seguinte enxergar o sender como reaproveitável.
  for (const sender of next) {
    if (!sender.trackId) continue;
    const track = local.find((candidate) => candidate.trackId === sender.trackId);
    sender.trackEnded = Boolean(track && track.readyState !== 'live');
  }
  return next;
}
