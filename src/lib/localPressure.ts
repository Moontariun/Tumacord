// Congestionamento não é a mesma coisa que encoder saturado, que não é a mesma
// coisa que captura faminta, que não é a mesma coisa que a máquina não dar
// conta de PINTAR o que já chegou.
//
// Até a 0.8.8 havia dois controladores: um de bitrate, que olhava rede, e um
// de escala, que olhava tempo de encode. Os dois desciam a resolução. Nenhum
// dos dois sabia dizer que o problema era a captura entregando menos quadros
// do que se pediu, nem que o vídeo recebido estava chegando inteiro e sendo
// descartado na hora de pintar. E nenhum deles reduzia FPS: um jogo a 8 FPS
// continuava alimentando um encoder configurado para 60.
//
// Este módulo responde três perguntas separadas — de onde vem a pressão,
// quanto de FPS cabe agora, e quando dá para voltar a subir — com histerese
// nos dois sentidos. Ele nunca toca em áudio: a voz não é moeda de troca.

export type PressureSource = 'none' | 'network' | 'encode' | 'capture' | 'render';

export interface PressureSample {
  /** FPS do perfil escolhido. É o teto; nunca se sobe acima dele. */
  targetFps: number;
  /** Quantos enlaces compartilham esta máquina agora. */
  peers: number;
  rttMs?: number;
  fractionLost?: number;
  availableOutgoingBitrate?: number;
  sendingBitrate?: number;
  currentBitrate?: number;
  /** Média por quadro nesta janela, calculada por diferença. */
  averageEncodeMs?: number;
  qualityLimitationReason?: string;
  /** Quadros que a fonte entregou e quadros que o caminho de captura largou. */
  capturedFps?: number;
  framesCapturedDelta?: number;
  framesDroppedDelta?: number;
  /** Pintura local do vídeo recebido, por `getVideoPlaybackQuality`. */
  renderFramesDelta?: number;
  renderDroppedDelta?: number;
  /** Só quando medido. `undefined` continua sendo desconhecido. */
  hardwareEncode?: boolean;
}

export interface PressureState {
  source: PressureSource;
  pressureSamples: number;
  healthySamples: number;
  fpsBudget: number;
}

export interface PressureDecision extends PressureState {
  /** Mudou o teto de FPS nesta amostra. */
  changed: boolean;
  /** Por que, em uma linha, para o relatório. */
  detail: string;
}

// Degraus de FPS. Sair de 60 direto para 15 é visível demais; descer de dois em
// dois degraus sob pressão severa continua sendo previsível.
export const FPS_LADDER = [60, 48, 30, 20, 15] as const;
export const MIN_FPS = 15;

// Duas amostras (cerca de quatro segundos) para descer, oito (cerca de
// dezesseis) para subir. Subir devagar é o que impede o vaivém que faz a live
// piscar a cada engasgo do jogo.
export const PRESSURE_SAMPLES_TO_REDUCE = 2;
export const HEALTHY_SAMPLES_TO_RECOVER = 8;

export function initialPressureState(targetFps: number): PressureState {
  return { source: 'none', pressureSamples: 0, healthySamples: 0, fpsBudget: clampFps(targetFps, targetFps) };
}

export function clampFps(value: number, ceiling: number): number {
  const top = Math.max(MIN_FPS, Math.min(ceiling, FPS_LADDER[0]));
  const candidates = FPS_LADDER.filter((step) => step <= top);
  const floor = candidates.length ? candidates : [MIN_FPS];
  // O degrau mais alto que não passa do valor pedido.
  return floor.find((step) => step <= value) ?? floor[floor.length - 1];
}

export function lowerFps(current: number, ceiling: number, severe = false): number {
  const steps = FPS_LADDER.filter((step) => step <= Math.min(ceiling, FPS_LADDER[0]));
  const ladder = steps.length ? [...steps] : [MIN_FPS];
  const index = ladder.findIndex((step) => step <= current);
  const from = index < 0 ? ladder.length - 1 : index;
  return ladder[Math.min(ladder.length - 1, from + (severe ? 2 : 1))];
}

export function raiseFps(current: number, ceiling: number): number {
  const steps = FPS_LADDER.filter((step) => step <= Math.min(ceiling, FPS_LADDER[0]));
  const ladder = steps.length ? [...steps] : [MIN_FPS];
  const index = ladder.findIndex((step) => step <= current);
  const from = index < 0 ? ladder.length - 1 : index;
  return ladder[Math.max(0, from - 1)];
}

function encoderOverBudget(sample: PressureSample): boolean {
  if (sample.averageEncodeMs === undefined) return false;
  // Cada enlace da malha tem o seu encoder. Três espectadores a 10 ms por
  // quadro custam 30 ms de um orçamento de 16,7 ms — e é essa soma que
  // determina se 60 FPS cabem, não o número de um enlace isolado.
  const frameBudgetMs = 1_000 / Math.max(1, sample.targetFps);
  return sample.averageEncodeMs * Math.max(1, sample.peers) >= frameBudgetMs * 0.95;
}

function captureStarved(sample: PressureSample): boolean {
  if (sample.framesDroppedDelta !== undefined && sample.framesCapturedDelta !== undefined && sample.framesCapturedDelta > 0) {
    // Um quinto dos quadros largados antes de chegar ao encoder é a fonte
    // engasgando, não a rede.
    if (sample.framesDroppedDelta / (sample.framesCapturedDelta + sample.framesDroppedDelta) >= 0.2) return true;
  }
  if (sample.capturedFps === undefined) return false;
  return sample.capturedFps > 0 && sample.capturedFps < sample.targetFps * 0.6;
}

function renderStarved(sample: PressureSample): boolean {
  if (sample.renderDroppedDelta === undefined || sample.renderFramesDelta === undefined) return false;
  const total = sample.renderFramesDelta + sample.renderDroppedDelta;
  return total > 0 && sample.renderDroppedDelta / total >= 0.2;
}

function networkCongested(sample: PressureSample): boolean {
  if (sample.rttMs !== undefined && sample.rttMs >= 180) return true;
  if (sample.fractionLost !== undefined && sample.fractionLost >= 0.02) return true;
  // A estimativa do Chromium só diz algo enquanto realmente usamos o teto.
  const probing = sample.sendingBitrate === undefined || sample.currentBitrate === undefined
    || sample.sendingBitrate >= sample.currentBitrate * 0.5;
  return probing && sample.availableOutgoingBitrate !== undefined && sample.currentBitrate !== undefined
    && sample.availableOutgoingBitrate < sample.currentBitrate * 0.9;
}

// Qual pressão manda. A rede já tem o seu próprio controlador (bitrate); o que
// este devolve é o que exige reduzir TRABALHO local, e por isso encode,
// captura e pintura vêm antes.
export function classifyPressure(sample: PressureSample): PressureSource {
  const cpuLimited = sample.qualityLimitationReason === 'cpu';
  if (cpuLimited || encoderOverBudget(sample)) return 'encode';
  if (captureStarved(sample)) return 'capture';
  if (renderStarved(sample)) return 'render';
  if (networkCongested(sample)) return 'network';
  return 'none';
}

export function adaptLocalPressure(state: PressureState, sample: PressureSample): PressureDecision {
  const ceiling = clampFps(sample.targetFps, sample.targetFps);
  const source = classifyPressure(sample);
  // Congestionamento de rede é tratado pelo bitrate. Baixar FPS por causa dele
  // resolveria o sintoma errado e deixaria a imagem pior sem motivo.
  const local = source === 'encode' || source === 'capture' || source === 'render';
  const pressureSamples = local ? state.pressureSamples + 1 : Math.max(0, state.pressureSamples - 1);
  const healthySamples = source === 'none' ? state.healthySamples + 1 : 0;
  let fpsBudget = Math.min(state.fpsBudget, ceiling);
  let changed = fpsBudget !== state.fpsBudget;
  let detail = 'sem pressão local';

  if (local && pressureSamples >= PRESSURE_SAMPLES_TO_REDUCE && fpsBudget > MIN_FPS) {
    // Encoder estourado com quadros sendo largados é aperto severo: dois
    // degraus de uma vez, em vez de descobrir isso de novo em quatro segundos.
    const severe = source === 'encode' && captureStarved(sample);
    fpsBudget = lowerFps(fpsBudget, ceiling, severe);
    changed = true;
    detail = `pressão de ${source}: teto local caiu para ${fpsBudget} FPS`;
    return { source, pressureSamples: 0, healthySamples: 0, fpsBudget, changed, detail };
  }

  if (!local && healthySamples >= HEALTHY_SAMPLES_TO_RECOVER && fpsBudget < ceiling) {
    fpsBudget = raiseFps(fpsBudget, ceiling);
    changed = true;
    detail = `folga sustentada: teto local voltou para ${fpsBudget} FPS`;
    return { source, pressureSamples: 0, healthySamples: 0, fpsBudget, changed, detail };
  }

  if (local) detail = `pressão de ${source} observada (${pressureSamples}/${PRESSURE_SAMPLES_TO_REDUCE})`;
  else if (source === 'network') detail = 'congestionamento de rede; o bitrate cuida disso';
  return { source, pressureSamples, healthySamples, fpsBudget, changed, detail };
}
