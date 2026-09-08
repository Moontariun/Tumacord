import { useEffect, useSyncExternalStore } from 'react';
import { PaintMonitor, initialPresentationState, observePaint, paintFps, type PresentationState } from '../lib/presentationHealth';

// O que a interface pode parar de fazer agora, e por quê.
//
// Três coisas separadas moram aqui:
//
// **Estado real da janela.** Vem do processo principal, porque o renderer não
// sabe: o aplicativo desliga o estrangulamento de segundo plano de propósito,
// e por isso `document.hidden` continua falso com a janela minimizada. Sem
// esse sinal, "parar de pintar quando ninguém está olhando" simplesmente não
// funcionava neste aplicativo.
//
// **Vigia da apresentação.** Mede a cadência de pintura da própria janela e
// avisa o processo principal quando ela para com a janela em primeiro plano —
// a falha que a recuperação da 0.8.8 não via, porque esperava o processo GPU
// morrer.
//
// **Modo econômico.** Ligado pelo degrau `reduce-effects` da escada de
// recuperação. Ele tira enfeite, não função.
//
// O que NUNCA para por causa de nada disto: áudio, transporte WebRTC, captura
// da live e a janela solta visível. `detachedVisible` existe exatamente para o
// último caso — a janela flutuante vive no mesmo processo de renderização, e
// esconder a principal não pode apagar o vídeo que está nela.

export interface PresentationSignal {
  mode: 'active' | 'background' | 'hidden';
  paintPreviews: boolean;
  paintEffects: boolean;
  detachedVisible: boolean;
  reduceEffects: boolean;
}

const DEFAULT_SIGNAL: PresentationSignal = {
  mode: 'active',
  paintPreviews: true,
  paintEffects: true,
  detachedVisible: false,
  reduceEffects: false,
};

let signal: PresentationSignal = DEFAULT_SIGNAL;
const listeners = new Set<() => void>();

function publish(next: PresentationSignal): void {
  if (next.mode === signal.mode
    && next.paintPreviews === signal.paintPreviews
    && next.paintEffects === signal.paintEffects
    && next.detachedVisible === signal.detachedVisible
    && next.reduceEffects === signal.reduceEffects) return;
  signal = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function presentationSignal(): PresentationSignal {
  return signal;
}

export function usePresentation(): PresentationSignal {
  return useSyncExternalStore(subscribe, presentationSignal, () => DEFAULT_SIGNAL);
}

// Deve pintar prévia/animação agora? A janela solta visível conta como motivo
// para continuar pintando, mesmo com a principal escondida.
export function shouldPaintPreviews(current: PresentationSignal = signal): boolean {
  return current.paintPreviews || current.detachedVisible;
}

export function shouldAnimate(current: PresentationSignal = signal): boolean {
  return current.paintEffects && !current.reduceEffects;
}

const PAINT_WINDOW_MS = 2_000;

// Um único instalador por aplicativo. Ele liga o sinal do processo principal e
// o vigia de cadência, e desfaz tudo ao sair.
export function usePresentationWatch(): PresentationSignal {
  const current = usePresentation();
  useEffect(() => {
    const bridge = window.tumacordDesktop;
    // No navegador não existe processo principal para perguntar. Ali o
    // Chromium não desliga o estrangulamento, e `visibilitychange` volta a ser
    // um sinal honesto.
    if (!bridge?.onWindowActivity) {
      const apply = () => publish({
        ...signal,
        mode: document.hidden ? 'hidden' : document.hasFocus() ? 'active' : 'background',
        paintPreviews: !document.hidden,
        paintEffects: !document.hidden && document.hasFocus(),
      });
      apply();
      document.addEventListener('visibilitychange', apply);
      window.addEventListener('focus', apply);
      window.addEventListener('blur', apply);
      return () => {
        document.removeEventListener('visibilitychange', apply);
        window.removeEventListener('focus', apply);
        window.removeEventListener('blur', apply);
      };
    }
    const stopActivity = bridge.onWindowActivity((state) => publish({ ...signal, ...state }));
    const stopReduce = bridge.onReduceEffects?.((enabled) => publish({ ...signal, reduceEffects: enabled }));
    return () => {
      stopActivity();
      stopReduce?.();
    };
  }, []);

  useEffect(() => {
    const bridge = window.tumacordDesktop;
    const monitor = new PaintMonitor();
    let state: PresentationState = initialPresentationState();
    monitor.start();
    const timer = window.setInterval(() => {
      const sample = monitor.take();
      const decision = observePaint(state, sample, presentationSignal().mode === 'active');
      state = { badWindows: decision.badWindows, goodWindows: decision.goodWindows, faulted: decision.faulted };
      if (!decision.report) return;
      // Uma vez por falha confirmada. Um evento por amostra ruim viraria uma
      // tempestade de IPC exatamente quando a máquina está apertada.
      void bridge?.reportPresentationFault?.({
        verdict: decision.verdict,
        paintFps: paintFps(sample),
        longestGapMs: sample.longestGapMs,
      }).catch(() => undefined);
      console.warn('[grafico] apresentação degradada', decision.detail);
    }, PAINT_WINDOW_MS);
    return () => {
      window.clearInterval(timer);
      monitor.stop();
    };
  }, []);

  return current;
}
