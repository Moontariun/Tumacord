// Estado real das janelas, decidido no processo principal.
//
// O aplicativo nasce com `disable-backgrounding-occluded-windows`,
// `disable-renderer-backgrounding` e `backgroundThrottling: false`. Isso existe
// por um bom motivo — sem essas três, minimizar o Tumacord com a live em uma
// janela flutuante estrangulava timers e mídia. O preço é que o renderer perde
// a noção de estar escondido: `document.hidden` continua falso e
// `visibilityState` continua "visible" com a janela minimizada.
//
// Por isso quem sabe é o processo principal, que pergunta ao compositor. E por
// isso o sinal tem três estados, não dois: parar de pintar prévia e animação
// não é a mesma coisa que parar de transmitir.
//
//   active      janela em primeiro plano: tudo pinta
//   background  visível mas sem foco: prévia continua, enfeite para
//   hidden      minimizada ou escondida: nada de prévia nem enfeite
//
// Em nenhum dos três o áudio, o transporte, a captura ou a janela solta da
// live param. `detachedVisible` é justamente o que garante isso: a janela
// flutuante vive no mesmo processo de renderização, então esconder a principal
// não pode desligar a pintura do vídeo que está nela.

function windowSnapshot(window) {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  if (!window || safe(() => window.isDestroyed(), true)) return null;
  return {
    minimized: safe(() => window.isMinimized(), false),
    visible: safe(() => window.isVisible(), true),
    focused: safe(() => window.isFocused(), false),
  };
}

function presentationState({ main, detached = [] } = {}) {
  const detachedVisible = detached.some((entry) => entry && entry.visible && !entry.minimized);
  if (!main) return { mode: 'hidden', paintPreviews: false, paintEffects: false, detachedVisible };
  if (main.minimized || !main.visible) {
    return { mode: 'hidden', paintPreviews: false, paintEffects: false, detachedVisible };
  }
  if (!main.focused) {
    return { mode: 'background', paintPreviews: true, paintEffects: false, detachedVisible };
  }
  return { mode: 'active', paintPreviews: true, paintEffects: true, detachedVisible };
}

function sameState(left, right) {
  if (!left || !right) return false;
  return left.mode === right.mode
    && left.paintPreviews === right.paintPreviews
    && left.paintEffects === right.paintEffects
    && left.detachedVisible === right.detachedVisible;
}

// Um observador por janela principal. Ele só fala quando o estado muda: uma
// mensagem de IPC por movimento de mouse seria trabalho novo justamente no
// caminho que estamos tentando aliviar.
class WindowActivity {
  constructor(options = {}) {
    this.send = options.send ?? (() => undefined);
    this.readDetached = options.readDetached ?? (() => []);
    this.snapshot = options.snapshot ?? windowSnapshot;
    this.main = null;
    this.last = null;
    this.listeners = [];
  }

  watch(window) {
    this.unwatch();
    this.main = window;
    if (!window || typeof window.on !== 'function') return;
    const events = ['show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'];
    for (const event of events) {
      const handler = () => this.publish();
      window.on(event, handler);
      this.listeners.push([event, handler]);
    }
    this.publish(true);
  }

  // Uma janela solta que aparece ou some muda o que a principal pode parar de
  // pintar: quem chama é o processo principal, ao criar ou fechar a live solta.
  refresh() {
    this.publish();
  }

  unwatch() {
    const window = this.main;
    if (window && typeof window.removeListener === 'function') {
      for (const [event, handler] of this.listeners) {
        try { window.removeListener(event, handler); } catch { /* janela já foi */ }
      }
    }
    this.listeners = [];
    this.main = null;
    this.last = null;
  }

  current() {
    return presentationState({
      main: this.snapshot(this.main),
      detached: this.readDetached().map((entry) => this.snapshot(entry)).filter(Boolean),
    });
  }

  publish(force = false) {
    const next = this.current();
    if (!force && sameState(this.last, next)) return next;
    this.last = next;
    try { this.send(next); } catch { /* renderer já foi embora */ }
    return next;
  }
}

module.exports = { WindowActivity, presentationState, sameState, windowSnapshot };
