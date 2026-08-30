import { useCallback, useEffect, useState } from 'react';

export interface DevicePreferences {
  microphoneId: string;
  cameraId: string;
  speakerId: string;
  noiseSuppression: boolean;
}

const KEY = 'tumacord.devices';

function savedPreferences(): DevicePreferences {
  try {
    return { microphoneId: '', cameraId: '', speakerId: '', noiseSuppression: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
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
    setPreferencesState(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  };

  return {
    devices,
    preferences,
    setPreferences,
    refresh,
    microphones: devices.filter((device) => device.kind === 'audioinput'),
    cameras: devices.filter((device) => device.kind === 'videoinput'),
    speakers: devices.filter((device) => device.kind === 'audiooutput'),
  };
}
