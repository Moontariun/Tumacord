// O processador que transforma o PCM do Windows em uma faixa de áudio.
//
// O código vive aqui como texto porque é isso que um `AudioWorklet` aceita:
// um módulo carregado por URL, avaliado em outra thread, sem acesso ao bundle
// do aplicativo. Guardá-lo como texto tem uma vantagem que compensa a
// estranheza — o teste avalia exatamente esta string, então o que roda na
// thread de áudio e o que é testado são o mesmo código, não duas cópias.
//
// O que ele resolve:
//
//   amortecimento  o WASAPI entrega blocos de 10 ms; o `AudioWorklet` pede
//                  quantos de 128 amostras. Sem um anel entre os dois, cada
//                  descompasso vira um estalo;
//   deriva         o relógio do motor de áudio do Windows e o do `AudioContext`
//                  não são o mesmo. Sem correção, a latência cresce ou o anel
//                  esvazia depois de alguns minutos de live;
//   estouro        a mistura nativa soma as aplicações em float sem limite,
//                  porque float aguenta. Quem precisa caber em ±1 é a faixa
//                  que sai daqui, e é aqui que o limitador age;
//   memória        o anel tem tamanho fechado. Uma live de três horas com o
//                  renderizador ocupado não pode crescer sem teto.

export const SCREEN_AUDIO_WORKLET_NAME = 'tumacord-screen-audio';

export const SCREEN_AUDIO_WORKLET_SOURCE = `
class TumacordScreenAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    this.channels = 2;
    // 500 ms de anel: o suficiente para atravessar uma pausa do renderizador
    // sem virar latência permanente, porque a correção de deriva devolve o
    // atraso assim que ele passa do alvo.
    this.capacity = settings.capacity || 24000;
    this.target = settings.target || 1440;
    this.ceiling = settings.ceiling || this.target * 4;
    this.threshold = settings.threshold || 0.891;
    this.attack = settings.attack || 0.3;
    this.release = settings.release || 0.0008;
    this.ratio = (settings.sourceRate || 48000) / (settings.contextRate || sampleRate);
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.filled = 0;
    this.position = 0;
    this.gain = 1;
    this.started = false;
    this.underruns = 0;
    this.overruns = 0;
    this.drifts = 0;
    this.reported = 0;
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(payload) {
    if (payload === 'flush') {
      this.read = 0;
      this.write = 0;
      this.filled = 0;
      this.position = 0;
      this.started = false;
      return;
    }
    if (!payload || !(payload instanceof ArrayBuffer)) return;
    const samples = new Float32Array(payload);
    const frames = Math.floor(samples.length / this.channels);
    for (let frame = 0; frame < frames; frame += 1) {
      if (this.filled === this.capacity) {
        // Descartar o quadro mais antigo mantém a memória fechada e a latência
        // limitada. Guardar mais só adiaria o problema.
        this.read = (this.read + 1) % this.capacity;
        this.filled -= 1;
        this.overruns += 1;
      }
      this.left[this.write] = samples[frame * this.channels];
      this.right[this.write] = samples[frame * this.channels + 1];
      this.write = (this.write + 1) % this.capacity;
      this.filled += 1;
    }
  }

  advance(frames) {
    const step = Math.min(frames, this.filled);
    this.read = (this.read + step) % this.capacity;
    this.filled -= step;
    return step;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const blockSize = output[0].length;

    if (!this.started) {
      // Começar com o anel vazio produz um engasgo logo no primeiro segundo da
      // live. Esperar o alvo é o que dá ao amortecedor algo para gastar.
      if (this.filled < this.target) {
        output[0].fill(0);
        output[1].fill(0);
        return true;
      }
      this.started = true;
      this.position = 0;
    }

    // Deriva de relógio: o motor de áudio do Windows entrega um pouco mais do
    // que o contexto consome (ou o contrário). Devolver o excesso de uma vez
    // faz um pulo curto; deixar crescer faz o áudio atrasar do vídeo.
    if (this.filled > this.ceiling) {
      this.advance(this.filled - this.target);
      this.drifts += 1;
    }

    let silent = true;
    for (let index = 0; index < blockSize; index += 1) {
      let leftSample = 0;
      let rightSample = 0;
      if (this.filled >= 2) {
        const next = (this.read + 1) % this.capacity;
        const fraction = this.position;
        leftSample = this.left[this.read] + (this.left[next] - this.left[this.read]) * fraction;
        rightSample = this.right[this.read] + (this.right[next] - this.right[this.read]) * fraction;
        silent = false;
        this.position += this.ratio;
        while (this.position >= 1 && this.filled >= 2) {
          this.position -= 1;
          this.advance(1);
        }
      }
      const peak = Math.abs(leftSample) > Math.abs(rightSample) ? Math.abs(leftSample) : Math.abs(rightSample);
      const wanted = peak > this.threshold ? this.threshold / peak : 1;
      this.gain += (wanted - this.gain) * (wanted < this.gain ? this.attack : this.release);
      let leftOut = leftSample * this.gain;
      let rightOut = rightSample * this.gain;
      // A garantia dura: nem o transiente mais curto sai fora de ±1, porque o
      // que estoura aqui vira distorção no Opus para quem assiste.
      if (leftOut > 1) leftOut = 1; else if (leftOut < -1) leftOut = -1;
      if (rightOut > 1) rightOut = 1; else if (rightOut < -1) rightOut = -1;
      output[0][index] = leftOut;
      output[1][index] = rightOut;
    }
    if (silent && this.filled < 2) this.underruns += 1;

    this.reported += blockSize;
    if (this.reported >= 48000) {
      this.reported = 0;
      this.port.postMessage({
        buffered: this.filled,
        underruns: this.underruns,
        overruns: this.overruns,
        drifts: this.drifts,
      });
    }
    return true;
  }
}

registerProcessor('${SCREEN_AUDIO_WORKLET_NAME}', TumacordScreenAudio);
`;
