// Orçamento da captura de tela.
//
// A qualidade escolhida deixou de ser só um teto de encoder: ela agora é o
// teto pedido à própria captura. Mas pedir não é conseguir. `applyConstraints`
// pode não existir, pode ser rejeitado, pode ser aceito e não mudar nada, e a
// fonte pode ser menor do que o perfil. Este módulo separa as quatro coisas e
// guarda o suficiente para nunca ficar repetindo um pedido que já se sabe
// inútil — sem jamais pedir a seleção de tela de novo, porque a sessão do
// portal precisa continuar a mesma.
//
// Tudo aqui é função pura sobre um retrato do estado. O que fala com o
// navegador é `useVoice`; o que decide é este arquivo, que dá para testar.

import { captureEnvelopeFor, type ScreenQualityConfig, type StreamQuality } from './screenQuality';

export interface CaptureSettingsLike {
  width?: number;
  height?: number;
  frameRate?: number;
}

export type CaptureOutcome =
  /** A captura passou a caber no perfil pedido. */
  | 'matched'
  /** Diminuiu, mas não até o pedido. Economia parcial, e é o que se anuncia. */
  | 'reduced'
  /** O navegador aceitou e nada mudou: este perfil não controla a captura. */
  | 'ignored'
  /** Sem `getSettings` utilizável dos dois lados. Desconhecido é desconhecido. */
  | 'unknown';

export interface CaptureSession {
  /** Maior quadro já visto nesta sessão de captura: o teto real da fonte. */
  sourceWidth: number;
  sourceHeight: number;
  sourceFrameRate: number;
  /** Último perfil cujas constraints o navegador aplicou de verdade. */
  appliedQuality: StreamQuality | null;
  /** Pedidos aceitos que não mudaram nada. Chave `perfil@fps`, porque o
   *  orçamento de FPS pode mudar sozinho sem o perfil mudar. Não se repete. */
  ignored: string[];
  /** Rejeições seguidas de `applyConstraints`. */
  failures: number;
  lastAttemptAt: number;
  lastAttemptKey: string | null;
  /** Falso quando o caminho não existe ou desistiu de vez nesta captura. */
  supported: boolean;
}

// Uma nova tentativa por perfil a cada cinco segundos basta: a pessoa pode
// trocar a qualidade três vezes em dez segundos e nada disso vira uma rajada
// de reconfiguração de captura.
export const CAPTURE_RETRY_MS = 5_000;
// Três rejeições seguidas e este caminho está fechado para esta captura. O
// perfil continua valendo no encoder, que é o que a 0.8.8 já fazia.
export const CAPTURE_FAILURE_LIMIT = 3;

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function initialCaptureSession(settings?: CaptureSettingsLike | null, supported = true): CaptureSession {
  return {
    sourceWidth: positive(settings?.width),
    sourceHeight: positive(settings?.height),
    sourceFrameRate: positive(settings?.frameRate),
    appliedQuality: null,
    ignored: [],
    failures: 0,
    lastAttemptAt: 0,
    lastAttemptKey: null,
    supported,
  };
}

// O teto da fonte só sobe. Reduzir a captura para 720p não pode ensinar ao
// aplicativo que a fonte "só dá 720p": seria como pedir um perfil melhor
// depois e receber a recusa que nós mesmos fabricamos.
export function observeCaptureSettings(session: CaptureSession, settings?: CaptureSettingsLike | null): CaptureSession {
  const width = positive(settings?.width);
  const height = positive(settings?.height);
  const frameRate = positive(settings?.frameRate);
  if (!width && !height && !frameRate) return session;
  return {
    ...session,
    sourceWidth: Math.max(session.sourceWidth, width),
    sourceHeight: Math.max(session.sourceHeight, height),
    sourceFrameRate: Math.max(session.sourceFrameRate, frameRate),
  };
}

// O que faz sentido pedir: o perfil, limitado pelo que a fonte já provou
// entregar. Pedir 1440p de uma fonte que nunca passou de 1080p não é errado,
// mas é ruído — e o resultado seria classificado como "ignorado", envenenando
// o perfil para sempre.
export function effectiveEnvelope(session: CaptureSession, quality: StreamQuality, fpsBudget?: number): ScreenQualityConfig {
  const envelope = captureEnvelopeFor(quality);
  // O orçamento de FPS entra aqui, e não só no encoder: um quadro que não é
  // capturado não é convertido, não é copiado da GPU e não é codificado. É a
  // única parte do custo que some de verdade sob pressão.
  const frameRate = fpsBudget && fpsBudget > 0 ? Math.min(envelope.frameRate, Math.round(fpsBudget)) : envelope.frameRate;
  return {
    ...envelope,
    width: session.sourceWidth ? Math.min(envelope.width, session.sourceWidth) : envelope.width,
    height: session.sourceHeight ? Math.min(envelope.height, session.sourceHeight) : envelope.height,
    frameRate: session.sourceFrameRate ? Math.min(frameRate, session.sourceFrameRate) : frameRate,
  };
}

export function captureRequestKey(quality: StreamQuality, envelope: ScreenQualityConfig): string {
  return `${quality}@${envelope.width}x${envelope.height}@${envelope.frameRate}`;
}

// Bem ABAIXO do pedido. Existe porque um envelope é um teto, e um teto sozinho
// não sabe voltar a subir: depois de reduzir para 720p, um pedido de 1080p
// "cabe" trivialmente na captura de 720p e nada aconteceria. O teto já vem
// limitado pelo que a fonte provou entregar, então isto nunca pede o
// impossível — uma janela de 1280 px de largura não vira um pedido de 1920.
export function belowEnvelope(settings: CaptureSettingsLike | null | undefined, envelope: ScreenQualityConfig): boolean {
  const width = positive(settings?.width);
  const height = positive(settings?.height);
  const frameRate = positive(settings?.frameRate);
  if (!width && !height && !frameRate) return false;
  if (width && width < envelope.width * 0.95) return true;
  if (height && height < envelope.height * 0.95) return true;
  return Boolean(frameRate && frameRate < envelope.frameRate - 1);
}

// No teto pedido: nem acima, nem visivelmente abaixo.
export function atEnvelope(settings: CaptureSettingsLike | null | undefined, envelope: ScreenQualityConfig): boolean {
  return fitsEnvelope(settings, envelope) && !belowEnvelope(settings, envelope);
}

export function fitsEnvelope(settings: CaptureSettingsLike | null | undefined, envelope: ScreenQualityConfig): boolean {
  const width = positive(settings?.width);
  const height = positive(settings?.height);
  const frameRate = positive(settings?.frameRate);
  if (!width && !height && !frameRate) return false;
  if (width && width > envelope.width) return false;
  if (height && height > envelope.height) return false;
  // A taxa relatada costuma ser o teto negociado, e um quadro de folga evita
  // reconfigurar a captura por causa de 60 contra 59,94.
  if (frameRate && frameRate > envelope.frameRate + 1) return false;
  return true;
}

export interface CapturePlan {
  apply: boolean;
  constraints?: MediaTrackConstraints;
  envelope: ScreenQualityConfig;
  /** Identidade do pedido: perfil e tamanho/FPS realmente solicitados. */
  key: string;
  reason: 'unsupported' | 'already-fits' | 'known-ignored' | 'cooling-down' | 'apply';
}

export function planCaptureConstraints(input: {
  session: CaptureSession;
  quality: StreamQuality;
  settings?: CaptureSettingsLike | null;
  now: number;
  fpsBudget?: number;
}): CapturePlan {
  const envelope = effectiveEnvelope(input.session, input.quality, input.fpsBudget);
  const key = captureRequestKey(input.quality, envelope);
  if (!input.session.supported) return { apply: false, envelope, key, reason: 'unsupported' };
  if (atEnvelope(input.settings, envelope)) return { apply: false, envelope, key, reason: 'already-fits' };
  if (input.session.ignored.includes(key)) return { apply: false, envelope, key, reason: 'known-ignored' };
  if (input.session.lastAttemptKey === key && input.now - input.session.lastAttemptAt < CAPTURE_RETRY_MS) {
    return { apply: false, envelope, key, reason: 'cooling-down' };
  }
  return {
    apply: true,
    envelope,
    key,
    reason: 'apply',
    constraints: {
      width: { ideal: envelope.width, max: envelope.width },
      height: { ideal: envelope.height, max: envelope.height },
      frameRate: { ideal: envelope.frameRate, max: envelope.frameRate },
    },
  };
}

export function classifyCaptureOutcome(envelope: ScreenQualityConfig, before: CaptureSettingsLike | null | undefined, after: CaptureSettingsLike | null | undefined): CaptureOutcome {
  const afterWidth = positive(after?.width);
  const afterHeight = positive(after?.height);
  const afterRate = positive(after?.frameRate);
  if (!afterWidth && !afterHeight && !afterRate) return 'unknown';
  if (atEnvelope(after, envelope)) return 'matched';
  const beforeWidth = positive(before?.width);
  const beforeHeight = positive(before?.height);
  const beforeRate = positive(before?.frameRate);
  const shrank = (beforeWidth && afterWidth && afterWidth < beforeWidth)
    || (beforeHeight && afterHeight && afterHeight < beforeHeight)
    || (beforeRate && afterRate && afterRate < beforeRate - 1);
  return shrank ? 'reduced' : 'ignored';
}

export function recordCaptureAttempt(session: CaptureSession, input: {
  quality: StreamQuality;
  key: string;
  ok: boolean;
  outcome: CaptureOutcome;
  settings?: CaptureSettingsLike | null;
  now: number;
}): CaptureSession {
  const base: CaptureSession = { ...session, lastAttemptAt: input.now, lastAttemptKey: input.key };
  if (!input.ok) {
    const failures = session.failures + 1;
    return { ...base, failures, supported: failures < CAPTURE_FAILURE_LIMIT };
  }
  const next: CaptureSession = { ...base, failures: 0 };
  if (input.outcome === 'ignored') {
    return { ...next, ignored: next.ignored.includes(input.key) ? next.ignored : [...next.ignored, input.key] };
  }
  if (input.outcome === 'unknown') return next;
  // O teto da fonte continua sendo o maior quadro já visto; uma redução
  // aplicada não o reescreve.
  return { ...observeCaptureSettings(next, input.settings), appliedQuality: input.quality };
}

// A frase que a interface e o relatório usam. Ela não pode dizer "economia
// total" quando a captura continuou grande: é exatamente a mentira que a
// 0.8.8 contava ao anunciar 720p enquanto capturava 1440p60.
export function describeCaptureBudget(quality: StreamQuality, envelope: ScreenQualityConfig, settings?: CaptureSettingsLike | null): string {
  const width = positive(settings?.width);
  const height = positive(settings?.height);
  const frameRate = positive(settings?.frameRate);
  const pedido = `${envelope.width}×${envelope.height} · ${envelope.frameRate} FPS`;
  if (!width && !height && !frameRate) return `perfil ${quality}: captura pedida ${pedido}; efetiva desconhecida`;
  const efetiva = `${width || '?'}×${height || '?'}${frameRate ? ` · ${Math.round(frameRate)} FPS` : ' · FPS desconhecido'}`;
  if (fitsEnvelope(settings, envelope)) return `perfil ${quality}: captura ${efetiva} (dentro do pedido ${pedido})`;
  return `perfil ${quality}: captura ${efetiva} acima do pedido ${pedido}; o encoder ainda reduz o restante`;
}
