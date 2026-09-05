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
  key?: string;
  pingMs: number;
  lastSeen: number;
}

interface TumacordNetworkPreferences {
  zeroTierEnabled: boolean;
  portMapping: boolean;
  stunEnabled: boolean;
  turnEnabled: boolean;
  stunServers: string[];
}

interface TumacordDirectReport {
  grade: 'open' | 'mapped' | 'ipv6' | 'lan' | 'blocked';
  score: number;
  paths: Array<{ kind: 'lan' | 'ipv6' | 'ipv4'; host: string; port: number; via: 'interface' | 'pcp' | 'nat-pmp' | 'upnp' | 'stun' }>;
  ipv6: boolean;
  cgnat: boolean;
  natMapping: 'open' | 'endpoint-independent' | 'symmetric' | 'unknown';
  publicIpv4?: string;
  mappedPort?: number;
  mappedVia?: 'pcp' | 'nat-pmp' | 'upnp';
  key: string;
  port: number;
  checkedAt: number;
  zeroTier: string[];
}

interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null;
  requestWindow: (options?: { width?: number; height?: number; disallowReturnToOpener?: boolean; preferInitialWindowPlacement?: boolean }) => Promise<Window>;
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
  tumacordDesktop?: {
    isDesktop: true;
    getSources: () => Promise<DesktopSource[]>;
    prepareScreenAudio: () => Promise<{ ok: boolean; deviceId?: string; deviceName?: string; error?: string }>;
    stopScreenAudio: () => Promise<{ ok: boolean }>;
    discoverCalls: () => Promise<DiscoveredCall[]>;
    onCallsChanged: (listener: (calls: DiscoveredCall[]) => void) => () => void;
    setHosting: (details: null | { hostUserId: string; hostUsername: string; callId: string; callName: string; participants: number }) => Promise<void>;
    getNetworkPreferences: () => Promise<TumacordNetworkPreferences>;
    setNetworkPreferences: (patch: Partial<TumacordNetworkPreferences>) => Promise<TumacordNetworkPreferences>;
    onNetworkPreferencesChanged: (listener: (preferences: TumacordNetworkPreferences) => void) => () => void;
    directReport: (options?: { force?: boolean }) => Promise<TumacordDirectReport>;
    toggleFullscreen: () => Promise<boolean>;
    isFullscreen: () => Promise<boolean>;
    onFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
    beginMediaFullscreen: () => Promise<boolean>;
    endMediaFullscreen: () => Promise<boolean>;
    onMediaFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
  };
}
