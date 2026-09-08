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
//   'device'  há uma entrada de áudio para abrir por `deviceName` (Linux)
//   'stream'  o PCM chega pelo canal do processo principal (Windows)
//
// A implementação do Linux não é tocada. Ela já resolve o problema no sistema
// dela, e trocá-la por algo "uniforme" só tornaria as duas piores.

const { ScreenAudioRouter } = require('./audio-router.cjs');
const { WindowsScreenAudioRouter } = require('./windows-audio-router.cjs');

class LinuxScreenAudioBridge {
  constructor(options = {}) {
    this.router = options.router ?? new ScreenAudioRouter(options);
  }

  available() {
    return this.router.available();
  }

  // O barramento do PipeWire recebe tudo que não é call, independentemente de
  // a pessoa ter escolhido um monitor ou uma janela. A fonte escolhida não
  // muda o que é montado, e por isso o pedido é ignorado aqui de propósito.
  async prepare() {
    const result = await this.router.prepare();
    return result.ok ? { ...result, mode: 'device', isolation: 'bus' } : result;
  }

  stop() {
    return this.router.stop();
  }

  reset() {
    return this.router.reset();
  }

  capabilities() {
    return { mode: 'device', supported: null, isolation: 'bus' };
  }

  diagnostics() {
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
