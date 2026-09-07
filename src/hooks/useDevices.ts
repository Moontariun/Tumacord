import { useCallback, useEffect, useRef, useState } from 'react';

export interface DevicePreferences {
  microphoneId: string;
  cameraId: string;
  speakerId: string;
  noiseSuppression: boolean;
}

const KEY = 'tumacord.devices';

// O Chromium publica duas entradas virtuais por dispositivo padrão: `default`
// (rotulada "Padrão - …" em pt-BR) e `communications`. Elas apontam para o
// mesmo hardware que já aparece com o id real, então manter as três na lista
// só cria as opções duplicadas de "default" e "padrão".
export function isVirtualDeviceId(value: unknown): boolean {
  return value === 'default' || value === 'communications';
}

export function normalizeDeviceId(value: unknown): string {
  if (typeof value !== 'string' || isVirtualDeviceId(value)) return '';
  return value;
}

export function normalizeSpeakerId(value: unknown): string {
  return normalizeDeviceId(value);
}

// Rótulos do Chromium chegam como "Padrão - Microfone (USB)". O prefixo só faz
// sentido nas entradas virtuais que acabaram de ser removidas.
export function cleanDeviceLabel(label: string | undefined): string {
  return (label ?? '').replace(/^\s*(padr[ãa]o|default|communications|comunica[çc][õo]es)\s*[-–—:]\s*/i, '').trim();
}

function realDevices<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'> & Partial<Pick<MediaDeviceInfo, 'label' | 'groupId'>>>(devices: readonly T[], kind: MediaDeviceKind): T[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const visible: T[] = [];
  for (const device of devices) {
    if (device.kind !== kind || !device.deviceId || isVirtualDeviceId(device.deviceId)) continue;
    if (seenIds.has(device.deviceId)) continue;
    // Alguns portais publicam o mesmo hardware duas vezes (uma pelo ALSA e
    // outra pelo PipeWire) com ids diferentes e rótulo idêntico.
    const name = cleanDeviceLabel(device.label).toLocaleLowerCase('pt-BR');
    if (name && seenNames.has(name)) continue;
    seenIds.add(device.deviceId);
    if (name) seenNames.add(name);
    visible.push(device);
  }
  return visible;
}

export function visibleAudioInputs<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'> & Partial<Pick<MediaDeviceInfo, 'label' | 'groupId'>>>(devices: readonly T[]): T[] {
  return realDevices(devices, 'audioinput');
}

export function visibleAudioOutputs<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'> & Partial<Pick<MediaDeviceInfo, 'label' | 'groupId'>>>(devices: readonly T[]): T[] {
  return realDevices(devices, 'audiooutput');
}

export function visibleVideoInputs<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'> & Partial<Pick<MediaDeviceInfo, 'label' | 'groupId'>>>(devices: readonly T[]): T[] {
  return realDevices(devices, 'videoinput');
}

// Uma enumeração vazia não é a notícia de que todos os aparelhos sumiram: é o
// navegador não contando. Ela acontece em série no Linux — o PipeWire sacode o
// grafo quando outro programa abre ou solta uma captura, e o próprio Tumacord
// carrega e descarrega módulos ao montar o barramento da live. Cada sacudida
// dispara `devicechange`, e por um instante `enumerateDevices()` responde uma
// lista curta ou vazia.
//
// Substituir a lista boa por essa lista curta é o que fazia o seletor de
// microfone, de saída e de câmera ficar só com "Padrão do sistema" por alguns
// segundos e depois voltar sozinho. Sem nenhum aparelho tendo sido tocado.
//
// A regra é conservadora de propósito: um tipo que veio vazio mantém o que já
// se sabia; um tipo que veio com pelo menos um aparelho é aceito inteiro,
// porque aí o navegador está mesmo respondendo e um aparelho desligado
// precisa sumir da lista.
//
// Mas preservar não pode ser para sempre. Quem tem um único microfone e o
// desconecta produz uma enumeração vazia que está CERTA, e a lista boa
// anterior virava um aparelho fantasma que nunca saía do seletor: escolhê-lo
// falhava e caía no padrão do sistema. Trocar um defeito por outro.
//
// Por isso a preservação é uma janela. Dentro dela, vazio é o navegador não
// contando; passada ela, vazio é a verdade. Oito segundos cobrem com folga a
// sacudida do grafo do PipeWire — que se assenta em um a três segundos, e é o
// que a montagem do barramento da live provoca — sem deixar um aparelho
// removido de verdade parado na tela tempo suficiente para alguém confiar
// nele.
const DEVICE_KINDS: readonly MediaDeviceKind[] = ['audioinput', 'audiooutput', 'videoinput'];
export const DEVICE_ABSENCE_GRACE_MS = 8_000;

/** Desde quando cada tipo vem vazio. Tipo ausente daqui não está vazio. */
export type DeviceAbsence = Partial<Record<MediaDeviceKind, number>>;

export interface PreservedDevices<T> {
  devices: T[];
  absence: DeviceAbsence;
  /** Quanto falta para a janela do tipo que vence primeiro; ausente se nada foi resgatado. */
  recheckInMs?: number;
}

export function preserveKnownDevices<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'> & Partial<Pick<MediaDeviceInfo, 'label' | 'groupId'>>>(
  previous: readonly T[],
  next: readonly T[],
  absence: DeviceAbsence = {},
  now = Date.now(),
  graceMs = DEVICE_ABSENCE_GRACE_MS,
): PreservedDevices<T> {
  const resgatados: T[] = [];
  const proxima: DeviceAbsence = {};
  let recheckInMs: number | undefined;
  for (const kind of DEVICE_KINDS) {
    if (realDevices(next, kind).length) continue;
    const vazioDesde = absence[kind] ?? now;
    proxima[kind] = vazioDesde;
    const restante = graceMs - (now - vazioDesde);
    if (restante <= 0) continue;
    const conhecidos = realDevices(previous, kind);
    if (!conhecidos.length) continue;
    resgatados.push(...conhecidos);
    recheckInMs = recheckInMs === undefined ? restante : Math.min(recheckInMs, restante);
  }
  return {
    devices: resgatados.length ? [...next, ...resgatados] : [...next],
    absence: proxima,
    ...(recheckInMs === undefined ? {} : { recheckInMs }),
  };
}

export function reconcileDevicePreferences<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'> & Partial<Pick<MediaDeviceInfo, 'label'>>>(preferences: DevicePreferences, devices: readonly T[]): DevicePreferences {
  const exists = (kind: MediaDeviceKind, id: string) => {
    if (!id || devices.some((device) => device.kind === kind && device.deviceId === id)) return true;
    // Antes da permissão, Chromium/portais podem esconder todos os IDs e
    // rótulos não padrão. Essa lista incompleta não prova que o dispositivo
    // salvo sumiu e não deve apagar a preferência durante o relogin.
    return !devices.some((device) => device.kind === kind && device.label?.trim());
  };
  return {
    ...preferences,
    microphoneId: exists('audioinput', preferences.microphoneId) ? normalizeDeviceId(preferences.microphoneId) : '',
    cameraId: exists('videoinput', preferences.cameraId) ? normalizeDeviceId(preferences.cameraId) : '',
    speakerId: exists('audiooutput', preferences.speakerId) ? normalizeDeviceId(preferences.speakerId) : '',
  };
}

function savedPreferences(): DevicePreferences {
  try {
    const saved = { microphoneId: '', cameraId: '', speakerId: '', noiseSuppression: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    return {
      ...saved,
      microphoneId: normalizeDeviceId(saved.microphoneId),
      cameraId: normalizeDeviceId(saved.cameraId),
      speakerId: normalizeDeviceId(saved.speakerId),
    };
  } catch {
    return { microphoneId: '', cameraId: '', speakerId: '', noiseSuppression: true };
  }
}

export function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [preferences, setPreferencesState] = useState<DevicePreferences>(savedPreferences);
  // `refresh` é chamado do `devicechange`, da troca de microfone e da troca de
  // câmera. Duas enumerações podem estar em voo ao mesmo tempo, e a que
  // começou antes pode terminar depois — gravando por cima da mais nova uma
  // lista já vencida. O número da consulta resolve isso.
  const consulta = useRef(0);
  // A lista publicada e a memória de quais tipos estão vindo vazios. Ficam em
  // ref porque o cálculo precisa acontecer fora do atualizador do React: um
  // atualizador tem de ser puro, e este passo escreve memória.
  const listaRef = useRef<MediaDeviceInfo[]>([]);
  const ausencia = useRef<DeviceAbsence>({});
  // `devicechange` só chega quando algo muda. Desconectar o único microfone
  // dispara um evento e mais nenhum: sem este reexame, a janela de preservação
  // venceria sem ninguém olhar e o aparelho fantasma ficaria na tela até o
  // próximo evento — que pode não vir nunca.
  const reexame = useRef<number | undefined>(undefined);
  const refreshRef = useRef<() => void>(() => undefined);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const pedido = ++consulta.current;
    try {
      const enumerados = await navigator.mediaDevices.enumerateDevices();
      if (pedido !== consulta.current) return;
      const preservado = preserveKnownDevices(listaRef.current, enumerados, ausencia.current);
      ausencia.current = preservado.absence;
      listaRef.current = preservado.devices;
      setDevices(preservado.devices);
      if (reexame.current) window.clearTimeout(reexame.current);
      reexame.current = preservado.recheckInMs === undefined
        ? undefined
        : window.setTimeout(() => { reexame.current = undefined; refreshRef.current(); }, preservado.recheckInMs + 50);
      setPreferencesState((current) => {
        const next = reconcileDevicePreferences(current, enumerados);
        if (next.microphoneId === current.microphoneId && next.cameraId === current.cameraId && next.speakerId === current.speakerId) return current;
        localStorage.setItem(KEY, JSON.stringify(next));
        return next;
      });
    } catch {
      // Alguns portais recusam enumeração enquanto outra permissão está em
      // andamento. Mantemos a última lista e tentamos novamente no próximo
      // devicechange, sem criar uma rejeição não tratada no React.
    }
  }, []);
  refreshRef.current = () => { void refresh(); };

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
      if (reexame.current) window.clearTimeout(reexame.current);
      reexame.current = undefined;
    };
  }, [refresh]);

  const setPreferences = (next: DevicePreferences) => {
    const normalized = {
      ...next,
      microphoneId: normalizeDeviceId(next.microphoneId),
      cameraId: normalizeDeviceId(next.cameraId),
      speakerId: normalizeDeviceId(next.speakerId),
    };
    setPreferencesState(normalized);
    localStorage.setItem(KEY, JSON.stringify(normalized));
  };

  return {
    devices,
    preferences,
    setPreferences,
    refresh,
    microphones: visibleAudioInputs(devices),
    cameras: visibleVideoInputs(devices),
    speakers: visibleAudioOutputs(devices),
  };
}
