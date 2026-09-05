import { useCallback, useEffect, useState } from 'react';

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

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const nextDevices = await navigator.mediaDevices.enumerateDevices();
      setDevices(nextDevices);
      setPreferencesState((current) => {
        const next = reconcileDevicePreferences(current, nextDevices);
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

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
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
