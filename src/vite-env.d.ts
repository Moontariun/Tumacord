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

// Como esta cópia foi instalada, e por isso como ela atualiza. `unknown` é o
// caso honesto: dá para avisar que existe versão nova, não dá para aplicá-la.
type TumacordInstallKind = 'linux-managed' | 'linux-appimage' | 'windows-installed' | 'windows-portable' | 'unknown';

interface TumacordUpdateState {
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'no-asset' | 'downloading' | 'ready' | 'applying' | 'applied' | 'error'
    /** Não há origem de atualizações configurada nesta cópia. */
    | 'no-origin'
    /** Há origem, e este dispositivo ainda não foi autorizado a baixar. */
    | 'needs-enrollment';
  kind: TumacordInstallKind;
  installed: string;
  /** Motivo pelo qual a versão instalada não deveria estar em uso; vazio quando ela está de pé. */
  installedBroken: string;
  /** As notas da versão instalada, como estão no manifesto assinado dela. */
  installedRelease: { version: string; title: string; notes: string; pageUrl: string; publishedAt: string } | null;
  version: string;
  title: string;
  notes: string;
  /** Vazio na distribuição privada: não há página pública de release. */
  pageUrl: string;
  publishedAt: string;
  /**
   * O pacote desta versão para esta máquina.
   *
   * Sem URL de propósito: o download pede por identificador ao serviço
   * configurado. Uma URL num documento assinado poderia mandar o aplicativo
   * buscar binário noutro domínio.
   */
  asset: { name: string; size: number; releaseId: string; artifactId: string; sha256: string; installKind: string; arch: string; format: string } | null;
  progress: { received: number; total: number };
  error: string;
  applied: { restart: 'now' | 'quit' | 'manual'; message: string; folder?: string } | null;
  file: string;
  skipped: Array<{ version: string; reason: string }>;
  /** A versão mais nova disponível, quando não é a oferecida agora. */
  latest?: string;
  /** Por que a versão oferecida não é a mais nova: ela é parada obrigatória. */
  mustStop?: { version: string; reason: string } | null;
  enabled: boolean;
  lastCheck: number;
  dismissed: string;
  /** Versão cujo "o que mudou" já foi mostrado nesta instalação. */
  notesSeen: string;
  /** De onde esta cópia aceita atualização. Vazio quando não há origem. */
  origin: string;
  /** Onde a origem foi encontrada: build, arquivo local ou ambiente. */
  originSource: string;
  /** O dispositivo autorizado a baixar, quando há um. */
  deviceId: string;
  /** Se falta trocar um convite por credencial antes de poder atualizar. */
  needsEnrollment: boolean;
  /** O que dizer sobre a autorização: o motivo, ou o aviso de que não foi gravada. */
  enrollmentMessage: string;
}

/** O que a interface pode saber da identidade deste dispositivo: nada que assine. */
interface TumacordIdentityDescription {
  status: 'unloaded' | 'ready' | 'locked' | 'corrupt';
  protection: '' | 'keyring' | 'file';
  publicKey: string;
  message: string;
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
    getNetworkPreferences: () => Promise<TumacordNetworkPreferences>;
    setNetworkPreferences: (patch: Partial<TumacordNetworkPreferences>) => Promise<TumacordNetworkPreferences>;
    onNetworkPreferencesChanged: (listener: (preferences: TumacordNetworkPreferences) => void) => () => void;
    directReport: (options?: { force?: boolean }) => Promise<TumacordDirectReport>;
    update?: {
      state: () => Promise<TumacordUpdateState>;
      check: () => Promise<TumacordUpdateState>;
      download: () => Promise<TumacordUpdateState>;
      cancel: () => Promise<TumacordUpdateState>;
      apply: () => Promise<TumacordUpdateState>;
      restart: () => Promise<boolean>;
      dismiss: (version?: string) => Promise<TumacordUpdateState>;
      markNotesSeen: (version?: string) => Promise<TumacordUpdateState>;
      setEnabled: (enabled: boolean) => Promise<TumacordUpdateState>;
      /** Troca o convite recebido do dono por uma credencial deste dispositivo. */
      enroll: (invite: string, label?: string) => Promise<TumacordUpdateState>;
      openPage: () => Promise<string>;
      onChanged: (listener: (state: TumacordUpdateState) => void) => () => void;
    };
    identity?: {
      describe: () => Promise<TumacordIdentityDescription>;
      login: (request: { inviteKey: string; username: string; nonce: string; withClaim: boolean; legacy: boolean }) => Promise<{
        proof: import('../shared/identity').LoginProof;
        claim: import('../shared/identity').IdentityClaim | null;
      }>;
      release: (request: { inviteKey: string; username: string }) => Promise<import('../shared/identity').IdentityRelease>;
    };
    toggleFullscreen: () => Promise<boolean>;
    isFullscreen: () => Promise<boolean>;
    onFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
    beginMediaFullscreen: () => Promise<boolean>;
    endMediaFullscreen: () => Promise<boolean>;
    onMediaFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
  };
}
