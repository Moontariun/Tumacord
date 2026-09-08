// Preferências do desenho sobre a transmissão.
//
// Duas delas são de quem transmite e viajam no estado de voz, porque valem
// para todo mundo que estiver assistindo àquela tela: se pode desenhar, e por
// quanto tempo o traço fica. A terceira é de quem desenha e não sai daqui: a
// cor do próprio traço.
//
// O padrão da cor é a cor de destaque do perfil, que a pessoa já escolheu uma
// vez. Assim cada um aparece com a própria cor sem precisar configurar nada, e
// dá para saber quem apontou o quê sem legenda.

import { DRAW_COLORS, STROKE_LIFETIME_MS, isDrawColor, parseDrawLifetime } from '../../shared/telestration';

export interface DrawPreferences {
  /** Quem assiste pode desenhar na minha transmissão. */
  allowDraw: boolean;
  /** Quanto tempo o traço fica na minha transmissão. `0` não apaga sozinho. */
  drawLifetime: number;
  /** Cor do meu traço quando eu desenho na transmissão dos outros. */
  drawColor: string;
  /**
   * Mostrar o traço também POR CIMA da área de trabalho, fora do Tumacord.
   *
   * Ligado, uma janela sobreposta cobre o monitor compartilhado. No Windows ela
   * se comporta: `setContentProtection` a tira da própria captura e ela não
   * disputa o teclado. No KDE/Wayland, não: medindo nesta máquina, mapear
   * ESSA janela — em todas as combinações que testei, com `focusable: false`,
   * `type` de notificação, com e sem `alwaysOnTop` — tira o foco de teclado de
   * quem estava digitando e não devolve para ninguém. Quem estiver jogando
   * perde o controle do jogo no momento exato em que alguém aponta algo na
   * live. Por isso ela nasce desligada no Linux.
   *
   * Desligada, o desenho continua inteiro: aparece dentro do Tumacord para
   * quem transmite e dentro do vídeo para quem assiste. O que não aparece é a
   * cópia sobre a área de trabalho.
   */
  desktopOverlay: boolean;
}

const KEY = 'tumacord.drawing';

// O padrão depende da plataforma porque o defeito depende da plataforma. Fora
// do aplicativo instalado não existe sobreposição nenhuma, e o valor não é
// usado.
export function defaultDesktopOverlay(platform = typeof window === 'undefined' ? '' : window.tumacordDesktop?.platform ?? ''): boolean {
  return platform === 'win32';
}

export const DEFAULT_DRAW_PREFERENCES: DrawPreferences = {
  allowDraw: true,
  drawLifetime: STROKE_LIFETIME_MS,
  drawColor: DRAW_COLORS[0],
  desktopOverlay: false,
};

export function sanitizeDrawPreferences(input: unknown, fallbackColor?: string, platform?: string): DrawPreferences {
  const bruto = (input ?? {}) as Partial<DrawPreferences>;
  const cor = isDrawColor(bruto.drawColor) ? bruto.drawColor as string
    : isDrawColor(fallbackColor) ? fallbackColor as string
    : DEFAULT_DRAW_PREFERENCES.drawColor;
  return {
    allowDraw: typeof bruto.allowDraw === 'boolean' ? bruto.allowDraw : DEFAULT_DRAW_PREFERENCES.allowDraw,
    drawLifetime: parseDrawLifetime(bruto.drawLifetime),
    drawColor: cor,
    desktopOverlay: typeof bruto.desktopOverlay === 'boolean' ? bruto.desktopOverlay : defaultDesktopOverlay(platform),
  };
}

export function readDrawPreferences(fallbackColor?: string): DrawPreferences {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeDrawPreferences(raw ? JSON.parse(raw) : null, fallbackColor);
  } catch {
    return sanitizeDrawPreferences(null, fallbackColor);
  }
}

export function writeDrawPreferences(preferences: DrawPreferences): DrawPreferences {
  const limpo = sanitizeDrawPreferences(preferences);
  try { localStorage.setItem(KEY, JSON.stringify(limpo)); }
  catch { /* armazenamento indisponível; a escolha vale nesta sessão */ }
  return limpo;
}
