import { useCallback, useEffect, useState } from 'react';

export interface DevicePreferences {
  microphoneId: string;
  cameraId: string;
  speakerId: string;
  noiseSuppression: boolean;
}

const KEY = 'tumacord.devices';

export function normalizeSpeakerId(value: unknown): string {
  if (typeof value !== 'string' || value === 'default' || value === 'communications') return '';
  return value;
}

export function visibleAudioOutputs<T extends Pick<MediaDeviceInfo, 'kind' | 'deviceId'>>(devices: readonly T[]): T[] {
  return devices.filter((device) => device.kind === 'audiooutput' && normalizeSpeakerId(device.deviceId) !== '');
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
    microphoneId: exists('audioinput', preferences.microphoneId) ? preferences.microphoneId : '',
    cameraId: exists('videoinput', preferences.cameraId) ? preferences.cameraId : '',
    speakerId: exists('audiooutput', preferences.speakerId) ? normalizeSpeakerId(preferences.speakerId) : '',
  };
}

function savedPreferences(): DevicePreferences {
  try {
    const saved = { microphoneId: '', cameraId: '', speakerId: '', noiseSuppression: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    return { ...saved, speakerId: normalizeSpeakerId(saved.speakerId) };
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
    const normalized = { ...next, speakerId: normalizeSpeakerId(next.speakerId) };
    setPreferencesState(normalized);
    localStorage.setItem(KEY, JSON.stringify(normalized));
  };

  return {
    devices,
    preferences,
    setPreferences,
    refresh,
    microphones: devices.filter((device) => device.kind === 'audioinput'),
    cameras: devices.filter((device) => device.kind === 'videoinput'),
    speakers: visibleAudioOutputs(devices),
  };
}
