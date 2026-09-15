// A mesma pergunta, duas respostas.
//
// "Prepare o áudio da transmissão" significa coisas diferentes em cada
// sistema: no Linux, montar um barramento no PipeWire e devolver o nome de uma
// entrada que o `getUserMedia` sabe abrir; no Windows, ligar a captura por
// processo e devolver PCM por um canal próprio. O restante do aplicativo não
// deveria precisar saber disso — ele pede a preparação e recebe um resultado
// que diz de que jeito a faixa vai nascer.
//
// O campo que carrega essa diferença é `mode`:
//
//   'device'  há uma entrada de áudio para abrir por `deviceName` (Linux antigo)
//   'stream'  o PCM chega pelo canal do processo principal (Windows e Linux)
//
// A implementação do Linux não é tocada. Ela já resolve o problema no sistema
// dela, e trocá-la por algo "uniforme" só tornaria as duas piores.

const { ScreenAudioRouter } = require('./audio-router.cjs');
const { PipewireStreamCapture } = require('./pipewire-capture.cjs');
const { WindowsScreenAudioRouter } = require('./windows-audio-router.cjs');

// No Linux há dois caminhos, e o preferido não cria dispositivo nenhum.
//
// Desde a 0.13.5 o áudio da live é um fluxo de gravação (`pw-record`) cujo PCM
// chega pelo mesmo canal do Windows — por isso o modo passa a ser `stream`. O
// barramento antigo, com um alto-falante e um microfone virtuais visíveis no
// sistema, continua existindo para o PipeWire anterior à 1.0, que não tem o
// `pw-record --raw`. Um PipeWire assim recebe exatamente o que recebia antes.
class LinuxScreenAudioBridge {
  constructor(options = {}) {
    this.router = options.router ?? new ScreenAudioRouter(options);
    // Com um roteador injetado — os testes — a ponte faz só o caminho antigo,
    // a menos que uma captura também seja injetada.
    this.capture = options.capture ?? (options.router ? null : new PipewireStreamCapture(options));
    this.useCapture = null;
  }

  async available() {
    if (this.capture && await this.capture.available().catch(() => false)) {
      this.useCapture = true;
      return true;
    }
    this.useCapture = false;
    return this.router.available();
  }

  // O que é capturado não depende da fonte escolhida: tudo que não é call
  // entra, seja um monitor ou uma janela. O pedido é ignorado de propósito.
  async prepare() {
    // Sem captura (os testes injetam só o roteador) não há o que sondar: a
    // ponte vai direto ao barramento, exatamente como antes da 0.13.5.
    if (this.useCapture === null && this.capture) await this.available();
    if (this.useCapture) {
      const captured = await this.capture.prepare();
      if (captured.ok) return { ...captured, mode: 'stream', isolation: 'bus' };
      // A captura falhou neste sistema: o barramento antigo é melhor do que
      // uma live sem som.
      this.useCapture = false;
    }
    const result = await this.router.prepare();
    return result.ok ? { ...result, mode: 'device', isolation: 'bus' } : result;
  }

  async stop() {
    await this.capture?.stop().catch(() => undefined);
    return this.router.stop();
  }

  async reset() {
    await this.capture?.reset().catch(() => undefined);
    return this.router.reset();
  }

  capabilities() {
    return { mode: this.useCapture ? 'stream' : 'device', supported: null, isolation: 'bus' };
  }

  diagnostics() {
    if (this.useCapture && this.capture) return this.capture.diagnostics();
    return {
      platform: 'linux',
      mechanism: 'pipewire-bus',
      active: Boolean(this.router.active),
      isolation: 'bus',
      links: this.router.links?.size ?? 0,
    };
  }
}

// Sistemas sem caminho próprio (macOS, BSD) recusam de forma explícita em vez
// de deixar o renderer descobrir sozinho por uma exceção.
class UnsupportedScreenAudioBridge {
  available() {
    return Promise.resolve(false);
  }

  prepare() {
    return Promise.resolve({ ok: false, code: 'unsupported', error: 'A captura de áudio da transmissão não está disponível neste sistema.' });
  }

  stop() {
    return Promise.resolve({ ok: true });
  }

  reset() {
    return Promise.resolve({ ok: true });
  }

  capabilities() {
    return { mode: 'none', supported: false, isolation: '' };
  }

  diagnostics() {
    return { platform: process.platform, mechanism: 'none', active: false };
  }
}

function createScreenAudioRouter(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') return new LinuxScreenAudioBridge(options);
  if (platform === 'win32') return new WindowsScreenAudioRouter(options);
  return new UnsupportedScreenAudioBridge();
}

module.exports = { createScreenAudioRouter, LinuxScreenAudioBridge, UnsupportedScreenAudioBridge };
