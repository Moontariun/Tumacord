// Saúde do microfone local.
//
// Uma faixa de microfone pode parar de entregar som sem nunca terminar: o
// PipeWire troca a fonte padrão quando um nó novo aparece — a fonte virtual da
// própria live é um deles —, o dispositivo é reconectado com outro id, ou o
// Chromium marca a faixa como `muted` porque a fonte sumiu embaixo dela. Em
// todos esses casos `readyState` continua `live` e `enabled` continua `true`;
// só o outro lado percebe, e tarde.
//
// Até a 0.7.8 o aplicativo apenas avisava depois de 25 segundos e pedia para a
// pessoa trocar o dispositivo à mão. Este módulo descreve, em funções puras,
// quando vale a pena refazer a captura sozinho e quando desistir e avisar.

export interface MicrophoneIdentity {
  deviceId: string;
  groupId: string;
}

export type MicrophoneFault = 'none' | 'muted' | 'device-changed' | 'dead' | 'silent';
export type MicrophoneRecoveryAction = 'wait' | 'recapture' | 'warn';

export const MUTED_HOLD_MS = 1_200;
export const DEVICE_CHANGE_HOLD_MS = 500;
// Silêncio digital absoluto e sala silenciosa são coisas diferentes. Um
// microfone vivo sempre entrega um piso de ruído; energia exatamente zero
// significa que a captura abriu e não está recebendo amostra nenhuma — foi o
// que fazia ninguém escutar quem entrava com "Padrão do sistema". Esse caso
// não precisa de vinte e cinco segundos para ser reconhecido.
export const DEAD_HOLD_MS = 3_000;
export const SILENCE_HOLD_MS = 25_000;
export const RECAPTURE_COOLDOWN_MS = 8_000;
export const MAX_AUTOMATIC_RECAPTURES = 3;

const HOLD_FOR: Record<Exclude<MicrophoneFault, 'none'>, number> = {
  muted: MUTED_HOLD_MS,
  'device-changed': DEVICE_CHANGE_HOLD_MS,
  dead: DEAD_HOLD_MS,
  silent: SILENCE_HOLD_MS,
};

// O Chromium publica uma entrada virtual `default` que aponta para o
// dispositivo escolhido no sistema. O `groupId` dela muda quando esse
// dispositivo muda, e é esse o sinal de que "Padrão do sistema" passou a
// significar outra coisa.
export function defaultAudioInputSignature(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'groupId'>[]): string {
  const entry = devices.find((device) => device.kind === 'audioinput' && device.deviceId === 'default');
  return entry ? entry.groupId || 'default' : '';
}

export function microphoneIdentityOf(track: Pick<MediaStreamTrack, 'getSettings'> | undefined): MicrophoneIdentity {
  const settings = track?.getSettings?.() ?? {};
  return { deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : '', groupId: typeof settings.groupId === 'string' ? settings.groupId : '' };
}

// Guardar só a preferência ("" para o padrão do sistema) não bastava: era
// impossível notar que o padrão tinha virado outro aparelho. A identidade
// resolvida da faixa é o que permite comparar.
export function capturedDeviceIsGone(input: {
  preferenceId: string;
  captured: MicrophoneIdentity;
  capturedDefaultSignature: string;
  devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'groupId'>[];
}): boolean {
  const inputs = input.devices.filter((device) => device.kind === 'audioinput');
  // Antes de a permissão ser concedida a lista chega vazia ou sem ids; isso
  // não prova que o dispositivo sumiu.
  if (!inputs.length) return false;
  if (input.preferenceId) {
    return !inputs.some((device) => device.deviceId === input.preferenceId);
  }
  const signature = defaultAudioInputSignature(input.devices);
  if (!signature || !input.capturedDefaultSignature) return false;
  return signature !== input.capturedDefaultSignature;
}

export interface MicrophoneRecoveryInput {
  now: number;
  fault: MicrophoneFault;
  faultSince: number;
  lastRecaptureAt: number;
  recaptures: number;
  warned: boolean;
}

export interface MicrophoneRecoveryPlan {
  action: MicrophoneRecoveryAction;
  recaptures: number;
}

export function planMicrophoneRecovery(input: MicrophoneRecoveryInput): MicrophoneRecoveryPlan {
  if (input.fault === 'none') return { action: 'wait', recaptures: input.recaptures };
  if (input.now - input.faultSince < HOLD_FOR[input.fault]) return { action: 'wait', recaptures: input.recaptures };
  // Refazer a captura derruba e recria a faixa em todos os enlaces. Um teto e
  // um intervalo mínimo impedem que uma falha permanente — sala silenciosa,
  // microfone realmente sem sinal — vire um laço de renegociação.
  if (input.recaptures >= MAX_AUTOMATIC_RECAPTURES) {
    return { action: input.warned ? 'wait' : 'warn', recaptures: input.recaptures };
  }
  if (input.lastRecaptureAt && input.now - input.lastRecaptureAt < RECAPTURE_COOLDOWN_MS) {
    return { action: 'wait', recaptures: input.recaptures };
  }
  return { action: 'recapture', recaptures: input.recaptures + 1 };
}

export function describeMicrophoneFault(fault: MicrophoneFault): string {
  if (fault === 'muted') return 'A fonte do seu microfone foi interrompida pelo sistema.';
  if (fault === 'device-changed') return 'O microfone padrão do sistema mudou.';
  if (fault === 'dead') return 'O microfone abriu sem receber nenhuma amostra.';
  if (fault === 'silent') return 'Seu microfone está aberto mas não capta som.';
  return '';
}

// Energia exatamente zero é falha de captura; um valor baixo mas diferente de
// zero é só uma sala quieta, e trocar a captura nesse caso seria trocar por
// nada, com renegociação e tudo.
export function faultFromLevel(level: number): MicrophoneFault {
  if (level > 0.006) return 'none';
  return level === 0 ? 'dead' : 'silent';
}
