// A ponte entre o PCM nativo do Windows e uma `MediaStreamTrack` comum.
//
// O objetivo é que nada depois daqui saiba de onde veio o áudio. O que sai é
// uma faixa de áudio igual à que o Linux produz a partir do barramento do
// PipeWire, e igual à que qualquer `getUserMedia` produziria — o outro lado da
// call recebe uma faixa WebRTC normal e não faz ideia de que houve um helper
// nativo no caminho.
//
// Um cuidado que é a razão de tudo isto existir: o contexto criado aqui nunca
// se conecta a `context.destination`. Reproduzir localmente o áudio da própria
// live criaria um caminho de retorno — o som sairia pelas caixas, e a captura
// por processo do Tumacord... não o pegaria, porque o Tumacord está excluído.
// Mas o cancelamento de eco do microfone pegaria, e a live voltaria pela voz.

import { SCREEN_AUDIO_WORKLET_NAME, SCREEN_AUDIO_WORKLET_SOURCE } from './screenAudioWorklet';

const SCREEN_AUDIO_PORT = 'tumacord:screen-audio-port';
const SOURCE_RATE = 48_000;

export interface ScreenAudioStreamStats {
  buffered: number;
  underruns: number;
  overruns: number;
  drifts: number;
}

export interface ScreenAudioStream {
  stream: MediaStream;
  stats: () => ScreenAudioStreamStats;
  close: () => Promise<void>;
}

type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext };

let pendingPort: MessagePort | null = null;
const portWaiters: Array<(port: MessagePort) => void> = [];
let listening = false;

// A porta chega do preload por `window.postMessage` — é o único jeito de uma
// `MessagePort` atravessar o isolamento de contexto. Ela pode chegar antes de
// alguém pedir, por isso a última fica guardada.
function listenForPort(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.data !== SCREEN_AUDIO_PORT) return;
    const port = event.ports?.[0];
    if (!port) return;
    const waiter = portWaiters.shift();
    if (waiter) {
      waiter(port);
      return;
    }
    pendingPort?.close();
    pendingPort = port;
  });
}

function takePort(timeoutMs: number): Promise<MessagePort> {
  listenForPort();
  if (pendingPort) {
    const port = pendingPort;
    pendingPort = null;
    return Promise.resolve(port);
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const index = portWaiters.indexOf(deliver);
      if (index >= 0) portWaiters.splice(index, 1);
      reject(new Error('O canal de áudio da transmissão não abriu.'));
    }, timeoutMs);
    const deliver = (port: MessagePort) => {
      window.clearTimeout(timer);
      resolve(port);
    };
    portWaiters.push(deliver);
  });
}

// A porta anterior precisa ser descartada antes de uma live nova: se ela ficar
// viva, o PCM de duas transmissões chega ao mesmo lugar.
export function discardPendingScreenAudioPort(): void {
  pendingPort?.close();
  pendingPort = null;
}

export function primeScreenAudioBridge(): void {
  listenForPort();
}

let workletUrl = '';

function workletModuleUrl(): string {
  if (workletUrl) return workletUrl;
  const blob = new Blob([SCREEN_AUDIO_WORKLET_SOURCE], { type: 'text/javascript' });
  workletUrl = URL.createObjectURL(blob);
  return workletUrl;
}

export async function openScreenAudioStream({ timeoutMs = 8_000 }: { timeoutMs?: number } = {}): Promise<ScreenAudioStream> {
  const Constructor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext;
  if (!Constructor) throw new Error('Este navegador não expõe AudioContext.');
  // A escuta precisa estar de pé antes do pedido: o processo principal envia a
  // porta assim que responde, e uma porta enviada sem ouvinte se perderia.
  listenForPort();
  discardPendingScreenAudioPort();
  const granted = await window.tumacordDesktop?.requestScreenAudioPort?.();
  if (granted === false) throw new Error('A captura de áudio da transmissão não está ativa.');
  const port = await takePort(timeoutMs);
  // Um contexto próprio, a 48 kHz, separado do barramento de saída do
  // aplicativo: o áudio da live não passa por nada que toque nas caixas.
  const context = new Constructor({ sampleRate: SOURCE_RATE, latencyHint: 'interactive' });
  let stats: ScreenAudioStreamStats = { buffered: 0, underruns: 0, overruns: 0, drifts: 0 };
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    try { port.onmessage = null; } catch { /* já fechada */ }
    try { port.close(); } catch { /* já fechada */ }
    try { await context.close(); } catch { /* já encerrado */ }
  };

  try {
    await context.audioWorklet.addModule(workletModuleUrl());
    const node = new AudioWorkletNode(context, SCREEN_AUDIO_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sourceRate: SOURCE_RATE, contextRate: context.sampleRate },
    });
    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as Partial<ScreenAudioStreamStats> | undefined;
      if (!data || typeof data.buffered !== 'number') return;
      stats = {
        buffered: data.buffered ?? 0,
        underruns: data.underruns ?? 0,
        overruns: data.overruns ?? 0,
        drifts: data.drifts ?? 0,
      };
    };
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    node.connect(destination);
    port.onmessage = (event: MessageEvent) => {
      const block = event.data as Uint8Array | undefined;
      if (!block || !ArrayBuffer.isView(block)) return;
      // `slice` sobre a fatia recebida entrega um ArrayBuffer independente,
      // que a thread de áudio pode receber por transferência em vez de cópia.
      const buffer = block.byteOffset === 0 && block.byteLength === block.buffer.byteLength
        ? block.buffer
        : block.buffer.slice(block.byteOffset, block.byteOffset + block.byteLength);
      node.port.postMessage(buffer, [buffer]);
    };
    port.start();
    // Um contexto criado sem gesto do usuário nasce suspenso em alguns
    // cenários; sem retomar, a faixa sai muda e nada indica o porquê.
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('A faixa de áudio da transmissão não foi criada.');
    track.contentHint = 'music';
    return {
      stream: destination.stream,
      stats: () => stats,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
