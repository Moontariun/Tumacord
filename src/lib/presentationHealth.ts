// A interface está PINTANDO?
//
// Esta é a pergunta que faltava na 0.8.8. O processo GPU pode estar vivo, o
// renderer respondendo, a live enviando quadros — e a janela, corrompida ou
// parada. A recuperação existente esperava o processo GPU cair duas vezes em
// dez minutos; uma janela que para de pintar com todo mundo vivo não acionava
// nada.
//
// Aqui a medida é direta: quantos quadros o `requestAnimationFrame` entregou
// na janela observada, e qual foi o maior intervalo entre dois deles. É
// também o número que separa três coisas que estavam sendo confundidas:
//
//   FPS da transmissão      quadros que o encoder produziu (vem do WebRTC)
//   cadência da interface   quadros que ESTA janela pintou (é o que está aqui)
//   apresentação do jogo    quadros que o jogo mandou ao compositor (não é
//                           nosso, e nenhum número daqui pode ser lido como
//                           se fosse)
//
// Nada disto liga ou desliga VSync. A cadência é observada como ela é; se ela
// estiver presa ao monitor, o relatório mostra isso e a pessoa decide.

export type PaintVerdict = 'healthy' | 'degraded' | 'stalled' | 'unknown';

export interface PaintSample {
  frames: number;
  elapsedMs: number;
  longestGapMs: number;
}

export const PAINT_WINDOW_MS = 2_000;
// Abaixo de cinco quadros por segundo com a janela em primeiro plano não é
// economia nem cena parada: é a apresentação travada.
export const STALLED_FPS = 5;
export const DEGRADED_FPS = 20;
// Um intervalo de mais de um segundo entre dois quadros aparece como travamento
// para quem está olhando, mesmo que a média da janela pareça aceitável.
export const STALL_GAP_MS = 1_000;

export function paintFps(sample: PaintSample): number | undefined {
  if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs <= 0) return undefined;
  return (sample.frames * 1_000) / sample.elapsedMs;
}

export function classifyPaint(sample: PaintSample, active: boolean): PaintVerdict {
  if (!active) return 'unknown';
  const fps = paintFps(sample);
  if (fps === undefined) return 'unknown';
  if (sample.longestGapMs >= STALL_GAP_MS || fps < STALLED_FPS) return 'stalled';
  if (fps < DEGRADED_FPS) return 'degraded';
  return 'healthy';
}

export interface PresentationState {
  badWindows: number;
  goodWindows: number;
  faulted: boolean;
}

export const FAULT_THRESHOLD = 2;
export const RECOVERY_THRESHOLD = 3;

export function initialPresentationState(): PresentationState {
  return { badWindows: 0, goodWindows: 0, faulted: false };
}

export interface PresentationDecision extends PresentationState {
  verdict: PaintVerdict;
  /** Vira `true` uma vez por falha, no momento em que ela é confirmada. */
  report: boolean;
  detail: string;
}

export function observePaint(state: PresentationState, sample: PaintSample, active: boolean): PresentationDecision {
  const verdict = classifyPaint(sample, active);
  if (verdict === 'unknown') {
    return { ...state, verdict, report: false, detail: 'janela fora de primeiro plano; cadência não avaliada' };
  }
  const fps = paintFps(sample);
  const legenda = `${fps === undefined ? 'cadência desconhecida' : `${fps.toFixed(1)} quadros/s`} · maior intervalo ${Math.round(sample.longestGapMs)} ms`;
  if (verdict === 'healthy') {
    const goodWindows = state.goodWindows + 1;
    const recovered = state.faulted && goodWindows >= RECOVERY_THRESHOLD;
    return {
      badWindows: 0,
      goodWindows: recovered ? 0 : goodWindows,
      faulted: recovered ? false : state.faulted,
      verdict,
      report: false,
      detail: legenda,
    };
  }
  const badWindows = state.badWindows + 1;
  const confirm = badWindows >= FAULT_THRESHOLD;
  return {
    badWindows: confirm ? 0 : badWindows,
    goodWindows: 0,
    faulted: confirm ? true : state.faulted,
    verdict,
    // Só se reporta a CONFIRMAÇÃO, e só uma vez: um evento por amostra ruim
    // viraria uma tempestade de IPC exatamente quando a máquina está apertada.
    report: confirm && !state.faulted,
    detail: legenda,
  };
}

// Coletor de cadência. Ele existe fora do React para não fazer o React
// renderizar sessenta vezes por segundo só para contar quadros — que seria
// criar o problema que ele está medindo.
export class PaintMonitor {
  private frames = 0;
  private longestGap = 0;
  private lastFrameAt = 0;
  private windowStartedAt = 0;
  private handle = 0;
  private running = false;

  constructor(private readonly schedule: (callback: (time: number) => void) => number = requestAnimationFrame.bind(globalThis),
              private readonly cancel: (handle: number) => void = cancelAnimationFrame.bind(globalThis),
              private readonly clock: () => number = () => performance.now()) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reset();
    const tick = (time: number) => {
      if (!this.running) return;
      if (this.lastFrameAt) this.longestGap = Math.max(this.longestGap, time - this.lastFrameAt);
      this.lastFrameAt = time;
      this.frames += 1;
      this.handle = this.schedule(tick);
    };
    this.handle = this.schedule(tick);
  }

  stop(): void {
    this.running = false;
    if (this.handle) this.cancel(this.handle);
    this.handle = 0;
    this.reset();
  }

  private reset(): void {
    this.frames = 0;
    this.longestGap = 0;
    this.lastFrameAt = 0;
    this.windowStartedAt = this.clock();
  }

  // Fecha a janela de medição e começa outra. O maior intervalo leva em conta
  // o tempo desde o último quadro: uma pintura que PAROU não produz amostra
  // nenhuma, e sem isso a parada ficaria invisível.
  take(): PaintSample {
    const now = this.clock();
    const elapsedMs = Math.max(1, now - this.windowStartedAt);
    const silence = this.lastFrameAt ? now - this.lastFrameAt : elapsedMs;
    const sample = { frames: this.frames, elapsedMs, longestGapMs: Math.max(this.longestGap, silence) };
    this.frames = 0;
    this.longestGap = 0;
    this.windowStartedAt = now;
    return sample;
  }
}
