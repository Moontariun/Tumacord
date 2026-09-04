type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext };
type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let shared: AudioContext | null = null;
let unavailable = false;
let currentSink = '';

// O Chromium limita a quantidade de AudioContexts vivos por aba (na prática,
// seis). A versão anterior criava um por participante, mais um por live, mais
// o monitor de fala, mais os sons de feedback: em uma call com duas pessoas e
// uma transmissão o limite estourava, `new AudioContext()` passava a lançar
// dentro de um efeito do React e a árvore inteira caía — tela preta e saída da
// call. Todo o áudio de saída do app passa por este único contexto.
export function sharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || unavailable) return null;
  if (shared && shared.state !== 'closed') return shared;
  const Constructor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext;
  if (!Constructor) {
    unavailable = true;
    return null;
  }
  try {
    shared = new Constructor({ latencyHint: 'interactive' });
    if (currentSink) void (shared as SinkCapableContext).setSinkId?.(currentSink).catch(() => undefined);
  } catch {
    shared = null;
    unavailable = true;
    return null;
  }
  return shared;
}

export function resumeSharedAudio(): Promise<void> {
  const context = sharedAudioContext();
  if (!context || context.state !== 'suspended') return Promise.resolve();
  return context.resume().catch(() => undefined).then(() => undefined);
}

export function sharedAudioReady(): boolean {
  return sharedAudioContext()?.state === 'running';
}

// A saída é uma preferência única do aplicativo; roteamos o contexto inteiro em
// vez de cada elemento de mídia.
export function setSharedAudioSink(deviceId: string): void {
  const context = sharedAudioContext() as SinkCapableContext | null;
  currentSink = deviceId;
  if (!context?.setSinkId) return;
  void context.setSinkId(deviceId).catch(() => undefined);
}
