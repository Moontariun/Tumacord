// Os sons do aplicativo.
//
// Tudo aqui é sintetizado na hora, sem arquivo de áudio: o Tumacord não
// embarca som de ninguém, e um `.wav` por evento seria peso de download e uma
// licença para cada um. O que mudou nesta versão é **como** se sintetiza.
//
// A versão anterior era um oscilador por nota ligado direto a um ganho. Isso
// toca a nota certa e soa como bipe, e o motivo é conhecido:
//
//   - **uma senoide não tem timbre.** Instrumento é parcial: um fundamental
//     com harmônicos mais fracos em cima. Sem eles não há cor, só frequência;
//   - **sem ataque não há percussão.** O que faz um som parecer um objeto
//     batendo é o barulho dos primeiros milissegundos, não a nota;
//   - **sem cauda o som morre na parede.** Uma reverberação curta é o que dá a
//     impressão de que aquilo aconteceu em algum lugar;
//   - **envelope quadrado estala.** A subida e a descida precisam de curva, ou
//     o alto-falante entrega o clique junto.
//
// Então cada nota aqui é uma pequena pilha de parciais levemente desafinados
// entre si, passando por um filtro que fecha conforme a nota decai — é esse
// fechamento que separa "macio" de "estridente" —, com um sopro de ruído no
// ataque para os sons percussivos e um envio para uma cauda de reverberação
// gerada por código. No fim de tudo há um compressor suave, que existe para
// que nenhum evento fique mais alto que os outros.
//
// A paleta também cresceu, porque havia coisas diferentes soando igual:
// silenciar o microfone e ensurdecer tocavam o mesmo par de notas, e alguém
// entrando na call soava idêntico a você entrando nela.

import { resumeSharedAudio, sharedAudioContext, sharedAudioOutput } from './audioBus';

const SOUND_KEY = 'tumacord.sound-feedback';
const SOUND_VOLUME_KEY = 'tumacord.sound-volume';

export type FeedbackSound =
  | 'connect' | 'callJoin' | 'callLeave' | 'peerJoin' | 'peerLeave'
  | 'message' | 'messageSent' | 'notification' | 'error'
  | 'mute' | 'unmute' | 'deafen' | 'undeafen'
  | 'streamStart' | 'streamStop' | 'host' | 'update'
  | 'viewerJoin' | 'viewerLeave';

/**
 * O timbre de uma nota, como receita de parciais.
 *
 * Cada entrada é `[múltiplo da frequência, ganho relativo, onda]`. O primeiro
 * múltiplo não precisa ser 1 — em `glass` o segundo parcial é 2,01 de
 * propósito: harmônico exato soa eletrônico, e essa imperfeição é o que faz
 * lembrar metal de verdade.
 */
type Partial = [number, number, OscillatorType];

const TIMBRES: Record<string, Partial[]> = {
  // Redondo e presente. É o timbre das confirmações — o que mais aparece.
  soft: [[1, 1, 'sine'], [2, 0.16, 'sine'], [3, 0.055, 'triangle']],
  // Metálico e claro, para o que chega de fora: mensagem, aviso, novidade.
  glass: [[1, 1, 'sine'], [2.01, 0.3, 'sine'], [3.02, 0.11, 'sine'], [5.4, 0.04, 'sine']],
  // Curto e fechado, para o que é ação sua: silenciar, enviar, apagar.
  wood: [[1, 1, 'triangle'], [1.5, 0.12, 'sine'], [2, 0.07, 'sine']],
  // Grave e cheio, para o que é grande: erro, transmissão, virar host.
  warm: [[0.5, 0.45, 'sine'], [1, 1, 'triangle'], [2, 0.1, 'sine']],
};

interface Note {
  /** Em hertz. */
  freq: number;
  /** Quando começa, em segundos desde o início do som. */
  at: number;
  /** Quanto dura, em segundos, até o fim da cauda. */
  length: number;
  gain: number;
  timbre?: keyof typeof TIMBRES;
  /** Da esquerda (-1) para a direita (1). Dá largura sem mexer no volume. */
  pan?: number;
  /** Multiplicador da frequência no fim da nota: um glissando curto. */
  bend?: number;
}

interface Recipe {
  notes: Note[];
  /** Sopro de ruído no ataque, em segundos. Zero quando não é percussivo. */
  attack?: number;
  /** Quanto vai para a cauda de reverberação, de 0 a 1. */
  space?: number;
  /** Onde o filtro do som inteiro começa a fechar. */
  tone?: number;
  /** Compensação de volume, para nenhum evento ficar mais alto que os outros. */
  trim?: number;
}

// As notas saem de uma escala só, e é de propósito: um aplicativo cujos sons
// pertencem à mesma tonalidade soa como um produto, e não como uma coleção de
// bipes. Tudo abaixo mora em ré maior.
const D4 = 293.66, E4 = 329.63, Fs4 = 369.99, G4 = 392.0, A4 = 440.0, B4 = 493.88;
const Cs5 = 554.37, D5 = 587.33, E5 = 659.25, Fs5 = 739.99, A5 = 880.0, B5 = 987.77, D6 = 1174.66;

const RECIPES: Record<FeedbackSound, Recipe> = {
  // Entrar no aplicativo: três notas subindo, com espaço. É o som mais longo
  // do conjunto porque acontece uma vez por sessão.
  connect: {
    notes: [
      { freq: D4, at: 0, length: 0.5, gain: 0.5, timbre: 'soft', pan: -0.22 },
      { freq: A4, at: 0.075, length: 0.5, gain: 0.55, timbre: 'soft', pan: 0.18 },
      { freq: Fs5, at: 0.15, length: 0.72, gain: 0.5, timbre: 'glass' },
    ],
    attack: 0.006, space: 0.42, tone: 6_200, trim: 0.72,
  },
  // Você entrou na call: quinta justa subindo, firme e curta.
  callJoin: {
    notes: [
      { freq: A4, at: 0, length: 0.26, gain: 0.6, timbre: 'soft', pan: -0.14 },
      { freq: E5, at: 0.065, length: 0.42, gain: 0.62, timbre: 'soft', pan: 0.14 },
    ],
    attack: 0.008, space: 0.26, tone: 5_400,
  },
  // Você saiu: a mesma quinta ao contrário, um tom abaixo.
  callLeave: {
    notes: [
      { freq: E5, at: 0, length: 0.22, gain: 0.5, timbre: 'soft', pan: 0.12 },
      { freq: A4, at: 0.065, length: 0.46, gain: 0.5, timbre: 'soft', pan: -0.12 },
    ],
    attack: 0.006, space: 0.28, tone: 4_400,
  },
  // Alguém chegou. Mais alto e mais leve que o seu próprio: é notícia sobre
  // outra pessoa, não sobre você.
  peerJoin: {
    notes: [
      { freq: D5, at: 0, length: 0.16, gain: 0.34, timbre: 'glass', pan: -0.2 },
      { freq: A5, at: 0.05, length: 0.3, gain: 0.32, timbre: 'glass', pan: 0.2 },
    ],
    attack: 0.004, space: 0.3, tone: 8_000, trim: 1.15,
  },
  peerLeave: {
    notes: [
      { freq: A5, at: 0, length: 0.14, gain: 0.3, timbre: 'glass', pan: 0.2 },
      { freq: D5, at: 0.05, length: 0.3, gain: 0.3, timbre: 'glass', pan: -0.2 },
    ],
    attack: 0.004, space: 0.3, tone: 7_000, trim: 1.15,
  },
  // Alguém abriu ou fechou a SUA transmissão.
  //
  // Deliberadamente mais discretos que `peerJoin`/`peerLeave`: eles tocam
  // enquanto você está apresentando alguma coisa, que é o pior momento para um
  // som chamativo. Ganho menor, cauda curta e um intervalo apertado — presente
  // o bastante para você saber, discreto o bastante para não cortar a frase.
  viewerJoin: {
    notes: [
      { freq: D5, at: 0, length: 0.1, gain: 0.16, timbre: 'glass', pan: 0.28 },
      { freq: A5, at: 0.035, length: 0.16, gain: 0.15, timbre: 'glass', pan: 0.28 },
    ],
    attack: 0.003, space: 0.16, tone: 8_400, trim: 0.85,
  },
  viewerLeave: {
    notes: [
      { freq: A5, at: 0, length: 0.09, gain: 0.15, timbre: 'glass', pan: 0.28 },
      { freq: D5, at: 0.035, length: 0.16, gain: 0.14, timbre: 'glass', pan: 0.28 },
    ],
    attack: 0.003, space: 0.16, tone: 7_400, trim: 0.85,
  },
  // Mensagem de outra pessoa: duas notas de vidro, curtas, com cauda.
  message: {
    notes: [
      { freq: B5, at: 0, length: 0.14, gain: 0.34, timbre: 'glass', pan: -0.16 },
      { freq: D6, at: 0.055, length: 0.34, gain: 0.3, timbre: 'glass', pan: 0.16 },
    ],
    attack: 0.003, space: 0.34, tone: 9_500,
  },
  // A sua: um toque só, baixo e seco. Enviar não é notícia.
  messageSent: {
    notes: [{ freq: Fs5, at: 0, length: 0.16, gain: 0.5, timbre: 'wood' }],
    attack: 0.005, space: 0.16, tone: 4_600, trim: 1.2,
  },
  notification: {
    notes: [
      { freq: Fs5, at: 0, length: 0.15, gain: 0.36, timbre: 'glass', pan: -0.14 },
      { freq: B5, at: 0.07, length: 0.38, gain: 0.34, timbre: 'glass', pan: 0.14 },
    ],
    attack: 0.004, space: 0.34, tone: 8_500,
  },
  // Erro desce e fecha. Nada de serra: uma terça menor caindo, grave, com o
  // filtro baixo — reconhecível sem ser desagradável.
  error: {
    notes: [
      { freq: G4, at: 0, length: 0.2, gain: 0.5, timbre: 'warm', pan: -0.1 },
      { freq: D4, at: 0.085, length: 0.5, gain: 0.55, timbre: 'warm', pan: 0.1, bend: 0.94 },
    ],
    attack: 0.01, space: 0.2, tone: 1_900, trim: 0.9,
  },
  // Silenciar e ensurdecer são coisas diferentes e passam a soar diferentes.
  // As duas de baixo descem; as de voltar sobem. Microfone é de madeira, ouvido
  // é macio e mais grave — a diferença se ouve sem precisar pensar.
  mute: {
    notes: [
      { freq: A4, at: 0, length: 0.1, gain: 0.4, timbre: 'wood' },
      { freq: D4, at: 0.05, length: 0.22, gain: 0.42, timbre: 'wood' },
    ],
    attack: 0.005, space: 0.12, tone: 3_000, trim: 1.25,
  },
  unmute: {
    notes: [
      { freq: D4, at: 0, length: 0.1, gain: 0.4, timbre: 'wood' },
      { freq: A4, at: 0.05, length: 0.24, gain: 0.42, timbre: 'wood' },
    ],
    attack: 0.005, space: 0.14, tone: 4_000, trim: 1.25,
  },
  deafen: {
    notes: [
      { freq: Fs4, at: 0, length: 0.13, gain: 0.42, timbre: 'soft' },
      { freq: D4, at: 0.06, length: 0.3, gain: 0.45, timbre: 'warm', bend: 0.82 },
    ],
    attack: 0.004, space: 0.14, tone: 1_600,
  },
  undeafen: {
    notes: [
      { freq: D4, at: 0, length: 0.13, gain: 0.42, timbre: 'warm', bend: 1.12 },
      { freq: Fs4, at: 0.06, length: 0.3, gain: 0.45, timbre: 'soft' },
    ],
    attack: 0.004, space: 0.18, tone: 5_000,
  },
  // Transmissão: aberta e larga, como convém a algo que ocupa a tela.
  streamStart: {
    notes: [
      { freq: D4, at: 0, length: 0.22, gain: 0.42, timbre: 'warm', pan: -0.24 },
      { freq: Fs4, at: 0.07, length: 0.26, gain: 0.44, timbre: 'soft' },
      { freq: A4, at: 0.14, length: 0.48, gain: 0.46, timbre: 'soft', pan: 0.24 },
    ],
    attack: 0.006, space: 0.38, tone: 5_600,
  },
  streamStop: {
    notes: [
      { freq: A4, at: 0, length: 0.18, gain: 0.4, timbre: 'soft', pan: 0.2 },
      { freq: D4, at: 0.075, length: 0.44, gain: 0.42, timbre: 'warm', pan: -0.2 },
    ],
    attack: 0.005, space: 0.3, tone: 3_400,
  },
  // Virar host: a nota mais afirmativa do conjunto, terminando em oitava.
  host: {
    notes: [
      { freq: D5, at: 0, length: 0.18, gain: 0.42, timbre: 'soft', pan: -0.18 },
      { freq: Fs5, at: 0.08, length: 0.22, gain: 0.44, timbre: 'soft' },
      { freq: D6, at: 0.16, length: 0.6, gain: 0.42, timbre: 'glass', pan: 0.18 },
    ],
    attack: 0.005, space: 0.44, tone: 7_600,
  },
  // Novidade disponível: discreta, sem urgência. Ela não pede nada agora.
  update: {
    notes: [
      { freq: E5, at: 0, length: 0.16, gain: 0.3, timbre: 'glass', pan: -0.12 },
      { freq: Cs5, at: 0.07, length: 0.16, gain: 0.26, timbre: 'glass' },
      { freq: B4, at: 0.14, length: 0.44, gain: 0.3, timbre: 'glass', pan: 0.12 },
    ],
    attack: 0.003, space: 0.4, tone: 8_800,
  },
};

/** Todos os sons, para a tela de configuração poder deixar ouvir cada um. */
export const FEEDBACK_SOUNDS = Object.keys(RECIPES) as FeedbackSound[];

export const SOUND_LABEL: Record<FeedbackSound, string> = {
  connect: 'Entrar no Tumacord',
  callJoin: 'Entrar na call',
  callLeave: 'Sair da call',
  peerJoin: 'Alguém entrou',
  peerLeave: 'Alguém saiu',
  message: 'Mensagem recebida',
  messageSent: 'Mensagem enviada',
  notification: 'Aviso',
  error: 'Erro',
  mute: 'Microfone mudo',
  unmute: 'Microfone aberto',
  deafen: 'Ouvido fechado',
  undeafen: 'Ouvido aberto',
  streamStart: 'Transmissão começou',
  streamStop: 'Transmissão parou',
  host: 'Virou host',
  update: 'Versão nova',
  viewerJoin: 'Alguém abriu sua live',
  viewerLeave: 'Alguém fechou sua live',
};

/**
 * Os efeitos que esta pessoa desligou, um a um.
 *
 * Guardamos os **desligados**, e não os ligados. A diferença aparece quando uma
 * versão nova acrescenta um efeito: com a lista dos ligados, ele nasceria mudo
 * para quem já usava o aplicativo e ninguém descobriria que ele existe. Com a
 * lista dos desligados, ele nasce ligado — e quem não quiser desliga.
 */
const SOUND_OFF_KEY = 'tumacord.sound-off';

export function readDisabledSounds(): Set<FeedbackSound> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(SOUND_OFF_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((name): name is FeedbackSound => typeof name === 'string' && name in RECIPES) : []);
  } catch {
    // Uma preferência ilegível não pode calar o aplicativo inteiro.
    return new Set();
  }
}

export function isSoundEnabled(sound: FeedbackSound): boolean {
  return readSoundEnabled() && !readDisabledSounds().has(sound);
}

export function setSoundEnabledFor(sound: FeedbackSound, enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  const disabled = readDisabledSounds();
  if (enabled) disabled.delete(sound);
  else disabled.add(sound);
  localStorage.setItem(SOUND_OFF_KEY, JSON.stringify([...disabled]));
}

export function readSoundEnabled(): boolean {
  return typeof localStorage === 'undefined' || localStorage.getItem(SOUND_KEY) !== 'false';
}

export function readSoundVolume(): number {
  if (typeof localStorage === 'undefined') return 0.8;
  const value = Number(localStorage.getItem(SOUND_VOLUME_KEY) ?? 0.8);
  return Number.isFinite(value) ? Math.max(0.2, Math.min(1, value)) : 0.8;
}

export function setSoundPreference(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_KEY, String(enabled));
}

export function setSoundVolume(volume: number): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_VOLUME_KEY, String(Math.max(0.2, Math.min(1, volume))));
}

export function unlockAudio(): void {
  void resumeSharedAudio();
}

// --- a cauda -----------------------------------------------------------------
//
// Uma sala pequena, gerada uma vez por contexto de áudio. São dois canais de
// ruído decaindo, com o começo atenuado: sem esse atraso inicial a cauda gruda
// no ataque e o som fica abafado em vez de espaçoso. Os dois canais são
// independentes, e é daí que vem a largura.

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>();

function roomImpulse(audio: BaseAudioContext): AudioBuffer {
  const guardado = impulses.get(audio);
  if (guardado) return guardado;
  const duracao = 0.85;
  const amostras = Math.floor(audio.sampleRate * duracao);
  const buffer = audio.createBuffer(2, amostras, audio.sampleRate);
  for (let canal = 0; canal < 2; canal += 1) {
    const dados = buffer.getChannelData(canal);
    for (let i = 0; i < amostras; i += 1) {
      const t = i / amostras;
      // Subida curta e queda exponencial: é o formato de uma sala, não de um
      // eco. O expoente alto é o que a mantém curta o bastante para não
      // atrapalhar quem está numa call enquanto o som toca.
      const envelope = Math.min(1, t * 42) * Math.pow(1 - t, 3.2);
      dados[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  impulses.set(audio, buffer);
  return buffer;
}

// Um estalo de ruído filtrado no primeiro instante da nota. É o que faz o som
// parecer uma coisa acontecendo, e não uma frequência ligando.
function noiseBurst(audio: BaseAudioContext, seconds: number): AudioBuffer {
  const amostras = Math.max(1, Math.floor(audio.sampleRate * seconds));
  const buffer = audio.createBuffer(1, amostras, audio.sampleRate);
  const dados = buffer.getChannelData(0);
  for (let i = 0; i < amostras; i += 1) {
    dados[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / amostras, 2.4);
  }
  return buffer;
}

export function playSound(sound: FeedbackSound, options: { preview?: boolean } = {}): void {
  // O interruptor geral e o do efeito. O modo `preview` pula só o segundo: a
  // tela de configuração precisa poder tocar um efeito DESLIGADO, porque é
  // ouvindo que a pessoa decide se quer ligá-lo de volta. Descrever um som em
  // uma frase não funciona.
  if (options.preview ? !readSoundEnabled() : !isSoundEnabled(sound)) return;
  const audio = sharedAudioContext();
  if (!audio) return;
  if (audio.state === 'suspended') void resumeSharedAudio();

  const recipe = RECIPES[sound];
  if (!recipe) return;
  const now = audio.currentTime + 0.01;
  const destino = sharedAudioOutput() ?? audio.destination;

  // O fim da cadeia. O compressor está aqui para que nenhum evento fique mais
  // alto que os outros — um som de aviso que estoura é um som que a pessoa
  // desliga.
  const master = audio.createGain();
  master.gain.setValueAtTime(readSoundVolume() * 0.5 * (recipe.trim ?? 1), now);
  const compressor = audio.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-20, now);
  compressor.knee.setValueAtTime(22, now);
  compressor.ratio.setValueAtTime(3.2, now);
  compressor.attack.setValueAtTime(0.004, now);
  compressor.release.setValueAtTime(0.18, now);
  master.connect(compressor).connect(destino);

  // O envio para a sala. Um passa-alta antes do convolver tira o grave da
  // cauda: é ele que embola o som quando há reverberação.
  const seco = audio.createGain();
  seco.gain.setValueAtTime(1, now);
  seco.connect(master);
  let molhado: GainNode | null = null;
  if (recipe.space) {
    const convolver = audio.createConvolver();
    convolver.buffer = roomImpulse(audio);
    const corte = audio.createBiquadFilter();
    corte.type = 'highpass';
    corte.frequency.setValueAtTime(600, now);
    molhado = audio.createGain();
    molhado.gain.setValueAtTime(recipe.space, now);
    molhado.connect(corte).connect(convolver).connect(master);
  }

  const ligar = (node: AudioNode) => {
    node.connect(seco);
    if (molhado) node.connect(molhado);
  };

  for (const nota of recipe.notes) {
    const inicio = now + nota.at;
    const fim = inicio + nota.length;
    const partials = TIMBRES[nota.timbre ?? 'soft'];

    // O filtro por nota, fechando junto com o decaimento. É esta curva que
    // separa "macio" de "estridente": um som real perde agudo enquanto some.
    const filtro = audio.createBiquadFilter();
    filtro.type = 'lowpass';
    filtro.Q.setValueAtTime(0.7, inicio);
    filtro.frequency.setValueAtTime(Math.min(18_000, (recipe.tone ?? 5_000)), inicio);
    filtro.frequency.exponentialRampToValueAtTime(Math.max(400, (recipe.tone ?? 5_000) * 0.28), fim);

    const panner = audio.createStereoPanner ? audio.createStereoPanner() : null;
    if (panner) panner.pan.setValueAtTime(nota.pan ?? 0, inicio);
    const saida = audio.createGain();
    saida.gain.setValueAtTime(nota.gain, inicio);
    if (panner) filtro.connect(panner).connect(saida);
    else filtro.connect(saida);
    ligar(saida);

    for (const [multiplo, peso, onda] of partials) {
      const oscilador = audio.createOscillator();
      const envelope = audio.createGain();
      oscilador.type = onda;
      oscilador.frequency.setValueAtTime(nota.freq * multiplo, inicio);
      if (nota.bend) oscilador.frequency.exponentialRampToValueAtTime(Math.max(20, nota.freq * multiplo * nota.bend), fim);
      // Desafinação mínima entre os parciais. É o que dá corpo: parciais
      // exatos batem em fase e soam sintéticos.
      oscilador.detune.setValueAtTime((multiplo - 1) * 3.5, inicio);

      // Ataque curto mas com curva, e queda exponencial. Sem a curva, o
      // alto-falante entrega o clique junto com a nota.
      const pico = Math.max(0.0002, peso);
      envelope.gain.setValueAtTime(0.0001, inicio);
      envelope.gain.exponentialRampToValueAtTime(pico, inicio + 0.012);
      envelope.gain.exponentialRampToValueAtTime(pico * 0.55, inicio + nota.length * 0.3);
      envelope.gain.exponentialRampToValueAtTime(0.0001, fim);

      oscilador.connect(envelope).connect(filtro);
      oscilador.start(inicio);
      oscilador.stop(fim + 0.03);
    }

    // O sopro de ruído, só na primeira nota: ele marca o começo do som, e um
    // por nota viraria chiado.
    if (recipe.attack && nota === recipe.notes[0]) {
      const fonte = audio.createBufferSource();
      fonte.buffer = noiseBurst(audio, recipe.attack);
      const banda = audio.createBiquadFilter();
      banda.type = 'bandpass';
      banda.frequency.setValueAtTime(Math.min(9_000, nota.freq * 3.2), inicio);
      banda.Q.setValueAtTime(0.9, inicio);
      const ganho = audio.createGain();
      ganho.gain.setValueAtTime(0.22, inicio);
      ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + recipe.attack);
      fonte.connect(banda).connect(ganho);
      ligar(ganho);
      fonte.start(inicio);
      fonte.stop(inicio + recipe.attack + 0.02);
    }
  }

  // Desligar depois que a cauda terminou. Ficar pendurado no grafo custa CPU
  // em um contexto que também carrega a voz da call.
  const duracao = Math.max(...recipe.notes.map((nota) => nota.at + nota.length)) + (recipe.space ? 0.95 : 0.1);
  window.setTimeout(() => { master.disconnect(); compressor.disconnect(); seco.disconnect(); molhado?.disconnect(); }, duracao * 1_000);
}

/** Toca um efeito na tela de configuração, mesmo que ele esteja desligado. */
export function previewSound(sound: FeedbackSound): void {
  playSound(sound, { preview: true });
}
