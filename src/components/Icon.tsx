import type { SVGProps } from 'react';
import {
  ChevronRight,
  Crown,
  Download,
  Expand,
  File,
  HardDriveDownload,
  Maximize,
  Minimize2,
  Hash,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Paperclip,
  Plus,
  ScreenShare,
  Server,
  Send,
  Settings,
  Shrink,
  Users,
  Video,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react';

export type IconName = 'hash' | 'voice' | 'mic' | 'micOff' | 'headphones' | 'camera' | 'screen' | 'settings' | 'phoneOff' | 'plus' | 'users' | 'send' | 'host' | 'close' | 'chevron' | 'maximize' | 'minimize' | 'volume' | 'volumeOff' | 'expand' | 'shrink' | 'paperclip' | 'download' | 'syncFile' | 'file' | 'server';

const icons: Record<IconName, LucideIcon> = {
  hash: Hash,
  voice: Volume2,
  mic: Mic,
  micOff: MicOff,
  headphones: Headphones,
  camera: Video,
  screen: ScreenShare,
  server: Server,
  settings: Settings,
  phoneOff: PhoneOff,
  plus: Plus,
  users: Users,
  send: Send,
  host: Crown,
  close: X,
  chevron: ChevronRight,
  maximize: Maximize,
  minimize: Minimize2,
  volume: Volume2,
  volumeOff: VolumeX,
  expand: Expand,
  shrink: Shrink,
  paperclip: Paperclip,
  download: Download,
  syncFile: HardDriveDownload,
  file: File,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const Component = icons[name];
  return <Component aria-hidden="true" strokeWidth={2} {...props} />;
}
