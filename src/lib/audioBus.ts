type WindowWithAudio = Window & { webkitAudioContext?: typeof AudioContext };
type SinkCapableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

let shared: AudioContext | null = null;
let master: GainNode | null = null;
let unavailable = false;
let currentSink = '';
let bridge: MediaStreamAudioDestinationNode | null = null;
let bridgeElement: SinkCapableElement | null = null;

// O Chromium limita a quantidade de AudioContexts vivos por aba (na prática,
// seis). Criar um por participante, mais um por live, mais o monitor de fala,
// estourava esse limite e derrubava a árvore do React de dentro de um efeito.
// Todo o áudio de saída do aplicativo passa por este contexto único, e tudo se
// conecta ao mesmo nó mestre — é ele que troca de rota quando a pessoa escolhe
// outra saída, sem que nenhuma fonte precise ser religada.
function ensureBus(): { context: AudioContext; output: GainNode } | null {
  if (typeof window === 'undefined' || unavailable) return null;
  if (shared && shared.state !== 'closed' && master) return { context: shared, output: master };
  const Constructor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext;
  if (!Constructor) {
    unavailable = true;
    return null;
  }
  try {
    shared = new Constructor({ latencyHint: 'interactive' });
    master = shared.createGain();
    master.connect(shared.destination);
    bridge = null;
    bridgeElement = null;
    const sink = currentSink;
    currentSink = '';
    if (sink) setSharedAudioSink(sink);
  } catch {
    shared = null;
    master = null;
    unavailable = true;
    return null;
  }
  return { context: shared, output: master };
}

export function sharedAudioContext(): AudioContext | null {
  return ensureBus()?.context ?? null;
}

// Nós de reprodução se conectam aqui, nunca direto em `destination`.
export function sharedAudioOutput(): AudioNode | null {
  return ensureBus()?.output ?? null;
}

export function resumeSharedAudio(): Promise<void> {
  const context = sharedAudioContext();
  const resumeElement = () => { if (bridgeElement) void bridgeElement.play().catch(() => undefined); };
  if (!context || context.state !== 'suspended') {
    resumeElement();
    return Promise.resolve();
  }
  return context.resume().catch(() => undefined).then(resumeElement);
}

// `AudioContext.setSinkId` reinicia a saída inteira do contexto: com todo o
// áudio do aplicativo compartilhando um contexto, uma troca de dispositivo
// deixava a pessoa sem ouvir ninguém até voltar para o padrão do sistema.
// A saída escolhida passa por um elemento <audio> dedicado, que aceita
// `setSinkId` sem mexer no grafo.
export function setSharedAudioSink(deviceId: string): void {
  const bus = ensureBus();
  if (!bus || deviceId === currentSink) return;
  const previous = currentSink;
  currentSink = deviceId;
  const routeToDefault = () => {
    bus.output.disconnect();
    bus.output.connect(bus.context.destination);
    if (bridgeElement) {
      bridgeElement.pause();
      bridgeElement.srcObject = null;
    }
  };
  if (!deviceId) {
    routeToDefault();
    return;
  }
  if (!bridge) bridge = bus.context.createMediaStreamDestination();
  if (!bridgeElement) {
    bridgeElement = document.createElement('audio') as SinkCapableElement;
    bridgeElement.autoplay = true;
    bridgeElement.style.display = 'none';
    document.body.append(bridgeElement);
  }
  if (!bridgeElement.setSinkId) {
    // Sem suporte a saída dedicada, o padrão do sistema é a única rota real.
    currentSink = previous;
    return;
  }
  const target = bridge;
  const element = bridgeElement;
  void element.setSinkId(deviceId)
    .then(() => {
      if (currentSink !== deviceId) return;
      bus.output.disconnect();
      bus.output.connect(target);
      element.srcObject = target.stream;
      return element.play().catch(() => {
        // Sem reprodução no elemento não sai som nenhum: melhor voltar para a
        // saída padrão do que deixar a call muda.
        if (currentSink !== deviceId) return;
        currentSink = '';
        routeToDefault();
      });
    })
    .catch(() => {
      if (currentSink !== deviceId) return;
      currentSink = '';
      routeToDefault();
    });
}

export function sharedAudioSink(): string {
  return currentSink;
}
