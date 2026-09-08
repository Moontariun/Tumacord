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
    platform: string;
    isDesktop: true;
    getSources: () => Promise<DesktopSource[]>;
    // `mode` diz de que jeito a faixa vai nascer: `device` significa que há
    // uma entrada de áudio para abrir por `deviceName` (o barramento do
    // PipeWire, no Linux); `stream` significa que o PCM chega pela porta de
    // mensagens que o processo principal envia (Windows).
    prepareScreenAudio: (request?: { sourceId?: string }) => Promise<{
      ok: boolean;
      mode?: 'device' | 'stream';
      isolation?: 'process' | 'system' | 'bus';
      deviceId?: string;
      deviceName?: string;
      sources?: number;
      excluded?: number;
      code?: string;
      error?: string;
    }>;
    stopScreenAudio: () => Promise<{ ok: boolean }>;
    requestScreenAudioPort?: () => Promise<boolean>;
    screenAudioCapabilities?: () => Promise<{ mode: string; supported: boolean | null; build?: number; reason?: string; isolation?: string }>;
    screenAudioDiagnostics?: () => Promise<Record<string, unknown>>;
    discoverCalls: () => Promise<DiscoveredCall[]>;
    onCallsChanged: (listener: (calls: DiscoveredCall[]) => void) => () => void;
    setHosting: (details: null | { hostUserId: string; hostUsername: string; callId: string; callName: string; participants: number }) => Promise<void>;
    drawOverlay: (payload: null | { sourceId: string; sourceKind: 'screen' | 'window'; lifetime: number; strokes: Array<{ color: string; at: number; points: Array<{ x: number; y: number }> }> }) => Promise<boolean>;
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
