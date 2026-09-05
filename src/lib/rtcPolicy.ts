export function isPolitePeer(selfId: string, remoteId: string): boolean {
  return selfId.localeCompare(remoteId) > 0;
}

export function shouldInitiateRecovery(selfId: string, remoteId: string): boolean {
  return selfId.localeCompare(remoteId) < 0;
}

export function shouldQueueIceCandidate(hasRemoteDescription: boolean): boolean {
  return !hasRemoteDescription;
}

export function shouldRecoverMutedAudio(input: {
  trackMuted: boolean;
  remoteMuted: boolean;
  screen: boolean;
  screenAudioExpected: boolean;
}): boolean {
  if (!input.trackMuted) return false;
  return input.screen ? input.screenAudioExpected : !input.remoteMuted;
}

export type RecoverySeverity = 'soft' | 'hard';
export type RecoveryAction = 'wait' | 'ice-restart' | 'rebuild';

export interface RecoveryPlanInput {
  now: number;
  lastAttemptAt: number;
  attempts: number;
  connectionState: string;
  severity: RecoverySeverity;
}

export interface RecoveryPlan {
  action: RecoveryAction;
  attempts: number;
}

export const RECOVERY_GRACE_MS = 12_000;

// Derrubar a RTCPeerConnection é o remédio mais caro que existe: o receptor
// perde o decodificador (tela preta), a renegociação leva segundos e, enquanto
// isso, os detectores de "sem tráfego" disparam de novo. A escada abaixo tenta
// sempre a opção barata primeiro e espaça as tentativas seguintes.
export function recoveryCooldownMs(severity: RecoverySeverity, attempts: number): number {
  const base = severity === 'hard' ? 3_000 : 12_000;
  const ceiling = severity === 'hard' ? 30_000 : 60_000;
  return Math.min(ceiling, base * (2 ** Math.max(0, Math.min(4, attempts))));
}

export function planPeerRecovery(input: RecoveryPlanInput): RecoveryPlan {
  const dead = input.connectionState === 'failed' || input.connectionState === 'closed';
  const severity: RecoverySeverity = dead ? 'hard' : input.severity;
  if (input.now - input.lastAttemptAt < recoveryCooldownMs(severity, input.attempts)) {
    return { action: 'wait', attempts: input.attempts };
  }
  const attempts = Math.min(6, input.attempts + 1);
  // "hard" é reservado para sintomas que um ICE restart não resolve — enlace
  // morto ou faixa anunciada que nunca chegou. Todo o resto ganha duas
  // tentativas baratas antes de derrubar a conexão.
  if (dead || severity === 'hard' || input.attempts >= 2) return { action: 'rebuild', attempts };
  return { action: 'ice-restart', attempts };
}

// Estatística de "sem tráfego" só vale quando o enlace está realmente de pé e
// já passou da janela em que a última reconstrução ainda estava renegociando.
export function stallSignalIsTrustworthy(input: { connectionState: string; msSinceLastRecovery: number; graceMs?: number }): boolean {
  return input.connectionState === 'connected' && input.msSinceLastRecovery >= (input.graceMs ?? RECOVERY_GRACE_MS);
}


// `ignoreOffer` marca que estamos descartando uma oferta perdida em uma
// colisão — e, com ela, os candidatos ICE daquela geração. Ele vale enquanto
// a negociação está em curso e precisa cair quando ela termina.
//
// Sem esse desarme o sinalizador fica travado: bastava uma colisão sem
// resposta — o outro lado saiu no meio, ou a resposta chegou fora do estado
// esperado — para TODO candidato ICE seguinte daquele enlace ser descartado.
// O enlace então podia ficar em "connected" sem mídia nenhuma, que é o pior
// sintoma possível: a interface diz que está tudo bem.
export function shouldClearIgnoredOffer(signalingState: string): boolean {
  return signalingState === 'stable';
}
