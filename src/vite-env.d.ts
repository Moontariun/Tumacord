/// <reference types="vite/client" />

interface DesktopSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  appIcon?: string;
}

interface DiscoveredCall {
  hostId: string;
  hostUserId: string;
  hostUsername: string;
  callId: string;
  callName: string;
  participants: number;
  url: string;
  pingMs: number;
  lastSeen: number;
}

interface Window {
  tumacordDesktop?: {
    isDesktop: true;
    getSources: () => Promise<DesktopSource[]>;
    prepareScreenAudio: () => Promise<{ ok: boolean; deviceId?: string; deviceName?: string; error?: string }>;
    stopScreenAudio: () => Promise<{ ok: boolean }>;
    discoverCalls: () => Promise<DiscoveredCall[]>;
    onCallsChanged: (listener: (calls: DiscoveredCall[]) => void) => () => void;
    setHosting: (details: null | { hostUserId: string; hostUsername: string; callId: string; callName: string; participants: number }) => Promise<void>;
    toggleFullscreen: () => Promise<boolean>;
    isFullscreen: () => Promise<boolean>;
    onFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
    beginMediaFullscreen: () => Promise<boolean>;
    endMediaFullscreen: () => Promise<boolean>;
    onMediaFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
  };
}
