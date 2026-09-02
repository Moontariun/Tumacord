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
    setDevices(await navigator.mediaDevices.enumerateDevices());
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
