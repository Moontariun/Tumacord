import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'hash' | 'voice' | 'mic' | 'micOff' | 'headphones' | 'camera' | 'screen'
  | 'settings' | 'leave' | 'plus' | 'users' | 'send' | 'host' | 'close'
  | 'chevron' | 'maximize' | 'minimize' | 'volume' | 'volumeOff' | 'expand'
  | 'shrink' | 'paperclip' | 'download' | 'syncFile' | 'file' | 'server'
  | 'shield' | 'refresh' | 'popOut' | 'popIn' | 'pin' | 'pinOff';

// Conjunto próprio, desenhado na mesma grade de 24 px, com traço de 1.8 e
// cantos arredondados. Nada de emoji na interface: cada símbolo é um SVG que
// herda a cor do botão e acompanha o peso do texto ao redor.
const SPEAKER = 'M11.2 4.6 6.6 8.6H3.4a1 1 0 0 0-1 1v4.8a1 1 0 0 0 1 1h3.2l4.6 4V4.6Z';
const MIC_BODY = 'M12 3.4a2.7 2.7 0 0 1 2.7 2.7v5.4a2.7 2.7 0 0 1-5.4 0V6.1A2.7 2.7 0 0 1 12 3.4Z';
const MIC_STAND = 'M5.8 11.3v.7a6.2 6.2 0 0 0 12.4 0v-.7M12 18.2v2.4M8.6 20.6h6.8';
// Exportado como texto porque a janela solta da live é outro documento: lá o
// botão é montado sem React e precisa do mesmo desenho.
export const PIN_PATH = 'M9.4 4.2h5.2a1.4 1.4 0 0 1 1.4 1.4v4.6c0 .7.3 1.3.9 1.7l1.3.9a1.1 1.1 0 0 1-.6 2H6.4a1.1 1.1 0 0 1-.6-2l1.3-.9c.6-.4.9-1 .9-1.7V5.6a1.4 1.4 0 0 1 1.4-1.4ZM12 14.8V20.4';
export const PIN_OFF_PATH = `${PIN_PATH}M3.6 3.6l16.8 16.8`;

const glyphs: Record<IconName, ReactNode> = {
  hash: <path d="M10.2 3.6 8.2 20.4M15.8 3.6l-2 16.8M4.4 9h15.2M3.8 15h15.2" />,
  voice: <><path d={SPEAKER} /><path d="M15.2 9.6a3.4 3.4 0 0 1 0 4.8" /><path d="M17.9 6.9a7.2 7.2 0 0 1 0 10.2" /></>,
  volume: <><path d={SPEAKER} /><path d="M15.2 9.6a3.4 3.4 0 0 1 0 4.8" /><path d="M17.9 6.9a7.2 7.2 0 0 1 0 10.2" /></>,
  volumeOff: <><path d={SPEAKER} /><path d="m15.6 9.6 5 4.8M20.6 9.6l-5 4.8" /></>,
  mic: <><path d={MIC_BODY} /><path d={MIC_STAND} /></>,
  micOff: <><path d="M14.7 6.1v-.1A2.7 2.7 0 0 0 9.4 5.3M9.3 9.6v2a2.7 2.7 0 0 0 4.2 2.2" /><path d={MIC_STAND} /><path d="m3.6 3.6 16.8 16.8" /></>,
  headphones: <><path d="M4.2 15.6v-3.4a7.8 7.8 0 0 1 15.6 0v3.4" /><rect x="2.4" y="14.2" width="4.4" height="6.4" rx="2" /><rect x="17.2" y="14.2" width="4.4" height="6.4" rx="2" /></>,
  camera: <><rect x="2.2" y="5.4" width="13.4" height="13.2" rx="2.6" /><path d="m15.6 10.4 5.5-3.2a.6.6 0 0 1 .9.5v8.6a.6.6 0 0 1-.9.5l-5.5-3.2" /></>,
  screen: <><rect x="2.4" y="4.2" width="19.2" height="12.8" rx="2.4" /><path d="M9 20.8h6M12 17v3.8" /><path d="M12 13.4V8M9.4 10.6 12 8l2.6 2.6" /></>,
  settings: <><path d="M4 6.4h9.4M18.6 6.4h1.4M4 12h4.4M13.6 12H20M4 17.6h9.4M18.6 17.6H20" /><circle cx="15.8" cy="6.4" r="2.2" /><circle cx="10.8" cy="12" r="2.2" /><circle cx="15.8" cy="17.6" r="2.2" /></>,
  leave: <><path d="M14.2 3.4H6.8a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h7.4" /><path d="M11.2 12h9.4M17.2 8.6 20.6 12l-3.4 3.4" /></>,
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  users: <><circle cx="9.2" cy="7.6" r="3.6" /><path d="M2.6 20.4v-1.3a4.4 4.4 0 0 1 4.4-4.4h4.4a4.4 4.4 0 0 1 4.4 4.4v1.3" /><path d="M16.4 4.4a3.6 3.6 0 0 1 0 6.9M18.4 14.9a4.4 4.4 0 0 1 3 4.2v1.3" /></>,
  send: <><path d="M20.8 3.2 3.4 9.6a.7.7 0 0 0 0 1.3l7 2.5 2.6 7.2a.7.7 0 0 0 1.3 0Z" /><path d="m20.8 3.2-10.4 10.2" /></>,
  host: <><path d="m3.4 8.2 4 3.2L12 5l4.6 6.4 4-3.2-1.7 9.4H5.1Z" /><path d="M5.4 20.4h13.2" /></>,
  close: <path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8" />,
  chevron: <path d="m9.4 5.4 6.6 6.6-6.6 6.6" />,
  maximize: <path d="M9.2 3.6H5.6a2 2 0 0 0-2 2v3.6M14.8 3.6h3.6a2 2 0 0 1 2 2v3.6M20.4 14.8v3.6a2 2 0 0 1-2 2h-3.6M9.2 20.4H5.6a2 2 0 0 1-2-2v-3.6" />,
  minimize: <path d="M9.2 3.6v3.6a2 2 0 0 1-2 2H3.6M14.8 3.6v3.6a2 2 0 0 0 2 2h3.6M20.4 14.8h-3.6a2 2 0 0 0-2 2v3.6M3.6 14.8h3.6a2 2 0 0 1 2 2v3.6" />,
  expand: <path d="M14.4 3.8h5.8v5.8M20.2 3.8 13.6 10.4M9.6 20.2H3.8v-5.8M3.8 20.2l6.6-6.6" />,
  shrink: <path d="M20.2 9.6h-5.8V3.8M14.4 9.6l5.8-5.8M3.8 14.4h5.8v5.8M9.6 14.4l-5.8 5.8" />,
  paperclip: <path d="M19.8 11.4 12 19.2a4.5 4.5 0 0 1-6.4-6.4l7.9-7.9a3 3 0 0 1 4.3 4.3l-7.9 7.9a1.5 1.5 0 0 1-2.2-2.2l7.3-7.3" />,
  download: <><path d="M12 3.6v10.8M8.1 10.5 12 14.4l3.9-3.9" /><path d="M4.2 16.6v2a1.8 1.8 0 0 0 1.8 1.8h12a1.8 1.8 0 0 0 1.8-1.8v-2" /></>,
  syncFile: <><path d="M12 3.2v7.6M8.8 7.6 12 10.8l3.2-3.2" /><rect x="3.2" y="13.4" width="17.6" height="7" rx="2" /><circle cx="7.2" cy="16.9" r=".9" fill="currentColor" stroke="none" /><path d="M11 16.9h6" /></>,
  file: <><path d="M13.8 3.6H7.6a2 2 0 0 0-2 2v12.8a2 2 0 0 0 2 2h8.8a2 2 0 0 0 2-2V8.2Z" /><path d="M13.8 3.6v4.6h4.6" /></>,
  server: <><rect x="3.2" y="4" width="17.6" height="7" rx="2" /><rect x="3.2" y="13" width="17.6" height="7" rx="2" /><circle cx="7.2" cy="7.5" r=".9" fill="currentColor" stroke="none" /><circle cx="7.2" cy="16.5" r=".9" fill="currentColor" stroke="none" /><path d="M11 7.5h6M11 16.5h6" /></>,
  shield: <><path d="M12 3.2 20 6v5.4c0 4.5-3.2 7.8-8 9.4-4.8-1.6-8-4.9-8-9.4V6Z" /><path d="m8.8 12 2.4 2.4 4-4.4" /></>,
  refresh: <><path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8" /><path d="M20.4 4.4v5.2h-5.2" /></>,
  popOut: <><path d="M20.4 12.4V6.2a2 2 0 0 0-2-2H5.6a2 2 0 0 0-2 2v9.2a2 2 0 0 0 2 2h5" /><rect x="12.4" y="12.6" width="9" height="7" rx="1.8" /></>,
  pin: <path d={PIN_PATH} />,
  pinOff: <path d={PIN_OFF_PATH} />,
  popIn: <><path d="M3.6 11.6v-5.4a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H12" /><rect x="2.6" y="13.4" width="9" height="7" rx="1.8" /><path d="M14.2 9.8 18.6 5.4M18.6 5.4h-3.4M18.6 5.4v3.4" /></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon={name} {...props}>{glyphs[name]}</svg>;
}
