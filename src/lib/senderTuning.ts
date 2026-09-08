// Comando de encoder: o que se pede e o que se conseguiu.
//
// A 0.8.8 tinha um defeito de estado aqui. Perto das linhas 1888–1896 de
// `useVoice`, `lastScaleChangeAt`, `screenBitrate` e `screenScale` eram
// escritos ANTES de `setParameters` resolver. Uma rejeição deixava o estado
// dizendo que a mudança valeu, e a decisão seguinte partia de um número que
// nunca existiu no encoder. Existia nova tentativa por `screenTuningPending`,
// mas ela não tornava o registro anterior correto.
//
// Aqui a separação é explícita: `TuneCommand` é intenção, `TuneApplied` é
// fato, e o fato só muda depois do sucesso. Duas outras regras que vêm junto:
// comando obsoleto é descartado em vez de aplicado, e a repetição tem teto.

import type { ScreenQualityConfig } from './screenQuality';

export interface TuneCommand {
  maxBitrate: number;
  /** `scaleResolutionDownBy`, entre 1 e 4. */
  scale: number;
  frameRate: number;
  /** Nos primeiros segundos a resolução é segurada para a live abrir nítida. */
  holdResolution: boolean;
}

export interface TuneApplied {
  maxBitrate?: number;
  scale: number;
  frameRate: number;
  /** Momento da última mudança que o encoder ACEITOU. */
  changedAt: number;
  /** Recusas seguidas desde a última aceitação. */
  attempts: number;
}

export const TUNE_ATTEMPT_LIMIT = 3;

export function initialTuneApplied(scale = 1, frameRate = 60): TuneApplied {
  return { scale, frameRate, changedAt: 0, attempts: 0 };
}

// Perfis de 60 FPS existem para jogo e movimento; os de 30 ou menos são
// escolhidos para ler tela, código e planilha. O par
// contentHint/degradationPreference precisa contar a mesma história, senão o
// encoder derruba a resolução e a live fica borrada.
export function screenDegradationPreference(config: ScreenQualityConfig): 'maintain-framerate' | 'maintain-resolution' {
  return config.frameRate >= 60 ? 'maintain-framerate' : 'maintain-resolution';
}

export function screenContentHint(config: ScreenQualityConfig): 'motion' | 'detail' {
  return config.frameRate >= 60 ? 'motion' : 'detail';
}

export function screenEncoding(config: ScreenQualityConfig, command: TuneCommand): { maxBitrate: number; maxFramerate: number; scaleResolutionDownBy: number; priority: string; networkPriority: string } {
  return {
    maxBitrate: command.maxBitrate,
    // Nunca acima do perfil: o orçamento local só reduz.
    maxFramerate: Math.min(config.frameRate, Math.max(1, Math.round(command.frameRate))),
    scaleResolutionDownBy: Math.min(4, Math.max(1, command.scale)),
    priority: 'high',
    networkPriority: 'high',
  };
}

export function degradationFor(config: ScreenQualityConfig, command: TuneCommand): 'maintain-framerate' | 'maintain-resolution' {
  return command.holdResolution ? 'maintain-resolution' : screenDegradationPreference(config);
}

// Um comando que esperou a vez na fila e encontrou outra intenção é lixo.
// Aplicá-lo faria o encoder ir para um perfil que ninguém mais quer, e a
// próxima amostra desfaria — que é o vaivém que faz a live piscar.
export function commandIsStale(command: TuneCommand, desired: Pick<TuneCommand, 'scale' | 'frameRate'>): boolean {
  return Math.abs(command.scale - desired.scale) >= 0.01 || Math.abs(command.frameRate - desired.frameRate) >= 1;
}

// O único lugar onde o estado aplicado muda.
export function applyTuneOutcome(applied: TuneApplied, command: TuneCommand, ok: boolean, now: number): TuneApplied {
  if (!ok) return { ...applied, attempts: applied.attempts + 1 };
  return { maxBitrate: command.maxBitrate, scale: command.scale, frameRate: command.frameRate, changedAt: now, attempts: 0 };
}

export function shouldRetry(applied: TuneApplied): boolean {
  return applied.attempts < TUNE_ATTEMPT_LIMIT;
}

// Mudou alguma coisa que valha um comando novo? Bitrate por 50 kbps em 8 Mbps
// é ruído; escala e FPS não são.
export function tuneIsNeeded(applied: TuneApplied, command: TuneCommand, extra = false): boolean {
  if (extra) return true;
  if (Math.abs(command.scale - applied.scale) >= 0.01) return true;
  if (Math.abs(command.frameRate - applied.frameRate) >= 1) return true;
  const bitrate = applied.maxBitrate;
  if (bitrate === undefined) return true;
  return Math.abs(command.maxBitrate - bitrate) >= Math.max(150_000, bitrate * 0.1);
}
