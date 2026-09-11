// O traço que a mão está fazendo agora.
//
// Ele parece uma coisa só e são duas, e confundi-las custou o traço inteiro na
// 0.9.2:
//
// 1. **o traço da mão** — nasce quando a caneta encosta, cresce a cada
//    movimento e só termina quando a caneta levanta. É dele que saem os
//    pedaços enviados;
// 2. **o eco local** — o mesmo traço desenhado na tela enquanto a confirmação
//    não volta, para a linha sair da mão sem esperar a rede.
//
// Na 0.9.2 os dois moravam na mesma referência, e o eco era apagado assim que
// o quadro confirmado alcançava o que já tinha sido enviado. Numa rede local
// isso acontece em milissegundos — no meio do arrasto. A partir dali cada
// movimento encontrava a referência vazia e desistia em silêncio: o que ficava
// na mesa era o ponto do clique, e mais nada. Um laço de teste apertado não
// via nada disso, porque nele a confirmação nunca chega no meio.
//
// A regra que separa as duas coisas é curta, e mora aqui para poder ser
// provada sem tela, sem socket e sem servidor: **enquanto a caneta estiver
// encostada, nada esquece o traço.**

import type { BoardPoint, BoardStroke } from '../../shared/whiteboard';

export interface DraftSession {
  /** O traço da mão. `null` quando a caneta não está encostada em nada. */
  stroke: BoardStroke | null;
  /** A caneta ainda está encostada. */
  drawing: boolean;
}

export const idleDraft = (): DraftSession => ({ stroke: null, drawing: false });

/** A caneta encostou: começa um traço novo e descarta qualquer eco pendente. */
export function beginDraft(stroke: BoardStroke): DraftSession {
  return { stroke, drawing: true };
}

// A mão andou. Os pontos entram no traço mesmo que o eco já tenha sido
// desenhado e confirmado — é exatamente este o caso que se perdia.
export function extendDraft(session: DraftSession, points: readonly BoardPoint[]): DraftSession {
  if (!session.stroke || !points.length) return session;
  return { ...session, stroke: { ...session.stroke, points: [...session.stroke.points, ...points] } };
}

// A caneta levantou. O traço continua existindo para o eco não piscar entre o
// fim do movimento e a confirmação do último pedaço; o que muda é que a partir
// de agora ele pode ser esquecido.
export function endDraft(session: DraftSession): DraftSession {
  return { ...session, drawing: false };
}

/**
 * O eco pode ser esquecido?
 *
 * Só quando as três coisas valem ao mesmo tempo: a caneta levantou, não há
 * pedaço esperando para ser enviado, e o quadro confirmado já contém o traço
 * inteiro. Faltando qualquer uma, o eco fica — desenhar duas vezes a mesma
 * linha é invisível, e apagá-la cedo demais é perder o traço.
 */
export function settleDraft(session: DraftSession, confirmed: BoardStroke | undefined, queued: number): DraftSession {
  if (!session.stroke) return session;
  if (session.drawing) return session;
  if (queued > 0) return session;
  if (!confirmed) return session;
  return confirmed.points.length >= session.stroke.points.length ? idleDraft() : session;
}
