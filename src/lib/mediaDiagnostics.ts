// Diagnóstico por camada do caminho do microfone.
//
// "O microfone não funciona" não é um estado — são seis, e cada um pede um
// conserto diferente. Uma captura que não entrega amostra nenhuma e uma faixa
// que nunca chegou a um `RTCRtpSender` produzem exatamente o mesmo sintoma
// para quem escuta, e nenhuma pista para quem conserta.
//
//   CAPTURE     o getUserMedia entrega áudio de verdade?
//   PROCESSING  o áudio atravessa o filtro neural?
//   TRACK       a faixa final está viva e habilitada?
//   SENDER      a faixa está atribuída ao sender de cada peer?
//   PEER        esse enlace chegou a conectar?
//   REMOTE      o outro lado está recebendo?
//
// Tudo aqui é função pura sobre um retrato do estado: nada de WebRTC, nada de
// navegador. É o que permite testar o raciocínio sem uma call de verdade.

export type MediaLayer = 'capture' | 'processing' | 'track' | 'sender' | 'peer' | 'remote';
export type LayerStatus = 'ok' | 'broken' | 'unknown' | 'idle';

export interface TrackSnapshot {
  readyState: string;
  enabled: boolean;
  muted: boolean;
}

export interface PeerAudioSnapshot {
  peerId: string;
  hasAudioSender: boolean;
  senderHasTrack: boolean;
  connectionState: string;
  receivingAudio?: boolean;
}

export interface MicrophonePipelineSnapshot {
  // O que a pessoa pediu, que é diferente do que está acontecendo.
  desired: boolean;
  userMuted: boolean;
  requestedDeviceId: string;
  acquiredDeviceId: string;
  raw: TrackSnapshot | null;
  // `null` significa "não medido", que não é o mesmo que zero.
  rawLevel: number | null;
  neural: boolean;
  processedLevel: number | null;
  output: TrackSnapshot | null;
  peers: PeerAudioSnapshot[];
}

export interface LayerVerdict {
  layer: MediaLayer;
  status: LayerStatus;
  detail: string;
}

const SIGNAL_FLOOR = 0.006;

function captureVerdict(snapshot: MicrophonePipelineSnapshot): LayerVerdict {
  if (!snapshot.raw) return { layer: 'capture', status: 'broken', detail: 'nenhuma faixa foi capturada do dispositivo' };
  if (snapshot.raw.readyState !== 'live') return { layer: 'capture', status: 'broken', detail: `a faixa do dispositivo está ${snapshot.raw.readyState}` };
  if (snapshot.raw.muted) return { layer: 'capture', status: 'broken', detail: 'o sistema silenciou a fonte do microfone' };
  if (snapshot.rawLevel === null) return { layer: 'capture', status: 'unknown', detail: 'sem medidor na entrada' };
  // Energia exatamente zero é ausência de amostra; um piso baixo é sala quieta.
  if (snapshot.rawLevel === 0) return { layer: 'capture', status: 'broken', detail: 'a captura abriu mas não recebe amostra nenhuma' };
  if (snapshot.rawLevel < SIGNAL_FLOOR) return { layer: 'capture', status: 'unknown', detail: 'entrada muito baixa; pode ser só silêncio na sala' };
  return { layer: 'capture', status: 'ok', detail: `entrada com sinal (${snapshot.rawLevel.toFixed(3)})` };
}

function processingVerdict(snapshot: MicrophonePipelineSnapshot): LayerVerdict {
  if (!snapshot.neural) return { layer: 'processing', status: 'idle', detail: 'filtro neural desligado; o áudio vai direto' };
  if (snapshot.rawLevel === null || snapshot.processedLevel === null) return { layer: 'processing', status: 'unknown', detail: 'sem medidor nos dois lados do filtro' };
  if (snapshot.rawLevel < SIGNAL_FLOOR) return { layer: 'processing', status: 'unknown', detail: 'sem entrada suficiente para avaliar a saída' };
  // Entrada com sinal e saída em silêncio é o filtro travado — o caso em que
  // a faixa segue viva e só chega silêncio do outro lado.
  if (snapshot.processedLevel < 0.0015) return { layer: 'processing', status: 'broken', detail: 'o filtro neural recebe áudio e não devolve nada' };
  return { layer: 'processing', status: 'ok', detail: `saída do filtro com sinal (${snapshot.processedLevel.toFixed(3)})` };
}

function trackVerdict(snapshot: MicrophonePipelineSnapshot): LayerVerdict {
  if (!snapshot.output) return { layer: 'track', status: 'broken', detail: 'não existe faixa final para enviar' };
  if (snapshot.output.readyState !== 'live') return { layer: 'track', status: 'broken', detail: `a faixa final está ${snapshot.output.readyState}` };
  if (snapshot.userMuted) return { layer: 'track', status: 'idle', detail: 'você está com o microfone mudo' };
  if (!snapshot.output.enabled) return { layer: 'track', status: 'broken', detail: 'a faixa final está desabilitada sem você ter se mutado' };
  return { layer: 'track', status: 'ok', detail: 'faixa final viva e habilitada' };
}

function senderVerdict(snapshot: MicrophonePipelineSnapshot): LayerVerdict {
  if (!snapshot.peers.length) return { layer: 'sender', status: 'idle', detail: 'ninguém mais na call' };
  const semSender = snapshot.peers.filter((peer) => !peer.hasAudioSender);
  if (semSender.length) return { layer: 'sender', status: 'broken', detail: `${semSender.length} de ${snapshot.peers.length} enlaces sem sender de áudio` };
  const semFaixa = snapshot.peers.filter((peer) => !peer.senderHasTrack);
  if (semFaixa.length) return { layer: 'sender', status: 'broken', detail: `${semFaixa.length} de ${snapshot.peers.length} senders sem faixa atribuída` };
  return { layer: 'sender', status: 'ok', detail: `${snapshot.peers.length} enlaces com a faixa atribuída` };
}

function peerVerdict(snapshot: MicrophonePipelineSnapshot): LayerVerdict {
  if (!snapshot.peers.length) return { layer: 'peer', status: 'idle', detail: 'ninguém mais na call' };
  const conectados = snapshot.peers.filter((peer) => peer.connectionState === 'connected');
  if (!conectados.length) return { layer: 'peer', status: 'broken', detail: 'nenhum enlace chegou a conectar' };
  if (conectados.length < snapshot.peers.length) {
    return { layer: 'peer', status: 'broken', detail: `${snapshot.peers.length - conectados.length} de ${snapshot.peers.length} enlaces fora do ar` };
  }
  return { layer: 'peer', status: 'ok', detail: `${conectados.length} enlaces conectados` };
}

function remoteVerdict(snapshot: MicrophonePipelineSnapshot): LayerVerdict {
  const conhecidos = snapshot.peers.filter((peer) => peer.receivingAudio !== undefined);
  if (!conhecidos.length) return { layer: 'remote', status: 'unknown', detail: 'o outro lado não informou o que está recebendo' };
  const semAudio = conhecidos.filter((peer) => !peer.receivingAudio);
  if (semAudio.length) return { layer: 'remote', status: 'broken', detail: `${semAudio.length} de ${conhecidos.length} participantes não recebem seu áudio` };
  return { layer: 'remote', status: 'ok', detail: 'todos recebem seu áudio' };
}

export function diagnoseMicrophone(snapshot: MicrophonePipelineSnapshot): LayerVerdict[] {
  if (!snapshot.desired) {
    return [{ layer: 'capture', status: 'idle', detail: 'microfone desligado por escolha sua' }];
  }
  return [
    captureVerdict(snapshot),
    processingVerdict(snapshot),
    trackVerdict(snapshot),
    senderVerdict(snapshot),
    peerVerdict(snapshot),
    remoteVerdict(snapshot),
  ];
}

// A primeira camada quebrada é a que interessa: as de baixo quebram por
// consequência, e consertar a última seria tratar sintoma.
export function firstBrokenLayer(snapshot: MicrophonePipelineSnapshot): LayerVerdict | null {
  return diagnoseMicrophone(snapshot).find((verdict) => verdict.status === 'broken') ?? null;
}

export function describeMicrophonePipeline(snapshot: MicrophonePipelineSnapshot): string {
  const quebrada = firstBrokenLayer(snapshot);
  if (!quebrada) return snapshot.desired ? 'Nenhuma falha localizada no caminho do microfone.' : 'Microfone desligado.';
  const nomes: Record<MediaLayer, string> = {
    capture: 'Captura', processing: 'Processamento', track: 'Faixa',
    sender: 'Envio', peer: 'Enlace', remote: 'Recepção',
  };
  return `${nomes[quebrada.layer]}: ${quebrada.detail}`;
}

// O dispositivo que a preferência pediu e o que o navegador realmente abriu
// podem ser diferentes — e é isso que "Padrão do sistema" esconde.
export function deviceMismatch(snapshot: Pick<MicrophonePipelineSnapshot, 'requestedDeviceId' | 'acquiredDeviceId'>): boolean {
  if (!snapshot.requestedDeviceId) return false;
  if (!snapshot.acquiredDeviceId) return false;
  return snapshot.requestedDeviceId !== snapshot.acquiredDeviceId;
}
