// Desenhar sobre a transmissão de alguém.
//
// Quem assiste rabisca em cima do vídeo; o traço aparece para quem transmite e
// para todo mundo que está vendo a mesma live. É a ferramenta de "olha aqui" —
// apontar um detalhe na tela sem precisar descrever onde ele fica.
//
// Três decisões sustentam o resto do arquivo:
//
// **Coordenadas normalizadas.** Um ponto viaja como fração de 0 a 1 do quadro
// capturado, nunca em pixels. Cada pessoa assiste em uma janela de tamanho
// diferente, com barras pretas de tamanhos diferentes, e quem transmite pode
// estar em 4K enquanto quem desenha está em uma janela de 600 px. A fração é a
// única coisa que significa o mesmo nas duas pontas.
//
// **O traço tem prazo, e o prazo é escolhido.** O padrão é sumir sozinho em
// alguns segundos: é o que se espera de um apontamento, que marca um instante
// em vez de editar a tela, e evita ter de sincronizar histórico com quem chega
// depois. Mas quem transmite pode pedir que o traço fique — para marcar um
// diagrama e conversar em cima dele. Aí o botão de limpar é o único jeito de
// tirar, e ele existe em três lugares: para o próprio autor, para quem
// transmite, e no fim da transmissão.
//
// **Quem transmite manda.** A permissão é de quem compartilha, não de quem
// assiste, e vale no servidor. Esconder o botão é conveniência.

export interface DrawPoint {
  /** Fração de 0 a 1 da largura do quadro capturado. */
  x: number;
  /** Fração de 0 a 1 da altura. */
  y: number;
}

export interface DrawStroke {
  /** Identidade do traço, para os pontos que chegam depois acharem o dono. */
  id: string;
  /** Socket de quem desenhou; usado para apagar tudo de quem sai da call. */
  author: string;
  authorName: string;
  color: string;
  points: DrawPoint[];
  /** Momento do último ponto, em ms locais de quem recebeu. */
  at: number;
}

/** O que viaja no fio. Um traço é enviado em pedaços, conforme a mão anda. */
export interface DrawMessage {
  /** Socket de quem transmite a live sendo anotada. */
  target: string;
  strokeId: string;
  color: string;
  points: DrawPoint[];
  /** Verdadeiro no último pedido do traço, quando a mão levanta. */
  done?: boolean;
  /** Apaga o que este autor desenhou nesta live. */
  clear?: boolean;
  /** Apaga tudo, de todo mundo. Só quem transmite pode pedir. */
  clearAll?: boolean;
}

/** Prazos oferecidos. `0` é o traço que não some sozinho. */
export const DRAW_LIFETIMES = [
  { value: 3_000, label: 'Rápido · 3 s' },
  { value: 6_000, label: 'Normal · 6 s' },
  { value: 15_000, label: 'Demorado · 15 s' },
  { value: 0, label: 'Não apagar sozinho' },
] as const;

// Onde o desenho funciona de verdade.
//
// A cópia do traço sobre a área de trabalho é o que dá sentido a desenhar na
// tela de alguém: quem transmite continua olhando para o jogo, não para o
// Tumacord, e é lá que o traço precisa aparecer. No Windows a janela
// sobreposta se comporta — ela não rouba foco e `setContentProtection` a tira
// da própria captura.
//
// No Linux, não. A janela sobreposta tira o foco do teclado de quem estava
// jogando e não o devolve, e o portal do PipeWire não sabe excluí-la da
// captura, então o traço volta dentro do vídeo. Uma live com desenho no Linux
// custava o controle do jogo para quem estava transmitindo.
//
// Por isso a permissão não é mais só uma preferência de quem transmite: o
// sistema de quem transmite decide primeiro. Quem está no Linux (ou no
// navegador, que não tem área de trabalho para pintar) não recebe desenho, e
// quem assiste vê o lápis desabilitado em vez de um botão que não faz nada.
export function drawSupportedOn(platform: unknown): boolean {
  return platform === 'win32';
}

export const STROKE_LIFETIME_MS = 6_000;
/** O fim da vida é gasto desaparecendo, sem nunca passar de dois segundos. */
export const STROKE_FADE_MS = 2_000;

export function isPersistent(lifetime: number): boolean {
  return lifetime === 0;
}

export function fadeFor(lifetime: number): number {
  return isPersistent(lifetime) ? 0 : Math.min(STROKE_FADE_MS, lifetime / 3);
}

// Um prazo que chega pelo fio é de outra máquina, e pode ser qualquer coisa.
// Só os valores oferecidos valem; o resto cai no padrão.
export function parseDrawLifetime(value: unknown): number {
  return DRAW_LIFETIMES.some((opcao) => opcao.value === value) ? value as number : STROKE_LIFETIME_MS;
}
/** Teto de traços guardados por live. Protege contra um cliente falante. */
export const MAX_STROKES = 64;
/** Teto de pontos por traço. Um rabisco longo é cortado, não recusado. */
export const MAX_POINTS_PER_STROKE = 600;
/** Pontos por pedido enviado. Segura a taxa sem picotar a linha. */
export const POINTS_PER_MESSAGE = 8;
/** Distância mínima entre pontos guardados, em fração do quadro. */
export const MIN_POINT_DISTANCE = 0.004;

export const DRAW_COLORS = ['#ff5c5c', '#ffd25c', '#52d789', '#5cc8ff', '#c05cff', '#ffffff'] as const;

export function isDrawColor(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// O vídeo quase nunca ocupa o elemento inteiro: `object-fit: contain` deixa
// barras em cima e embaixo, ou dos lados. Desenhar sem descontar essas barras
// desloca o traço na tela de quem recebe, e o erro cresce quanto mais
// diferentes forem as duas janelas.
export interface Viewport {
  /** Tamanho do elemento onde o vídeo é desenhado. */
  width: number;
  height: number;
  /** Tamanho real do quadro que chega pela rede. */
  frameWidth: number;
  frameHeight: number;
}

export interface FittedFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function fitFrame(viewport: Viewport): FittedFrame | null {
  const { width, height, frameWidth, frameHeight } = viewport;
  if (!(width > 0 && height > 0 && frameWidth > 0 && frameHeight > 0)) return null;
  const escala = Math.min(width / frameWidth, height / frameHeight);
  const largura = frameWidth * escala;
  const altura = frameHeight * escala;
  return { left: (width - largura) / 2, top: (height - altura) / 2, width: largura, height: altura };
}

/** Pixel do elemento → fração do quadro. Fora da imagem devolve nulo. */
export function pointFromViewport(x: number, y: number, viewport: Viewport): DrawPoint | null {
  const frame = fitFrame(viewport);
  if (!frame) return null;
  const dentro = x >= frame.left && x <= frame.left + frame.width && y >= frame.top && y <= frame.top + frame.height;
  if (!dentro) return null;
  return { x: clamp01((x - frame.left) / frame.width), y: clamp01((y - frame.top) / frame.height) };
}

/** Fração do quadro → pixel do elemento. */
export function pointToViewport(point: DrawPoint, viewport: Viewport): { x: number; y: number } | null {
  const frame = fitFrame(viewport);
  if (!frame) return null;
  return { x: frame.left + clamp01(point.x) * frame.width, y: frame.top + clamp01(point.y) * frame.height };
}

export function pointsAreFarEnough(previous: DrawPoint | undefined, next: DrawPoint, minimum = MIN_POINT_DISTANCE): boolean {
  if (!previous) return true;
  return Math.hypot(next.x - previous.x, next.y - previous.y) >= minimum;
}

/** 1 no auge, 0 quando o traço acabou de sumir. Sem prazo, sempre 1. */
export function strokeOpacity(stroke: DrawStroke, now: number, lifetime = STROKE_LIFETIME_MS): number {
  if (isPersistent(lifetime)) return 1;
  const fade = fadeFor(lifetime);
  const idade = now - stroke.at;
  if (idade <= lifetime - fade) return 1;
  if (idade >= lifetime) return 0;
  return (lifetime - idade) / fade;
}

export function sanitizePoints(input: unknown, limit = MAX_POINTS_PER_STROKE): DrawPoint[] {
  if (!Array.isArray(input)) return [];
  const pontos: DrawPoint[] = [];
  for (const bruto of input) {
    if (!bruto || typeof bruto !== 'object') continue;
    const { x, y } = bruto as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    pontos.push({ x: clamp01(x), y: clamp01(y) });
    if (pontos.length >= limit) break;
  }
  return pontos;
}

// O acervo de traços de uma live. Puro de propósito: é ele que o teste
// consegue sacudir com mil mensagens sem precisar de tela nenhuma.
export function applyDrawMessage(
  strokes: readonly DrawStroke[],
  message: DrawMessage & { author: string; authorName: string },
  now: number,
): DrawStroke[] {
  if (message.clearAll) return [];
  if (message.clear) return strokes.filter((stroke) => stroke.author !== message.author);
  const pontos = sanitizePoints(message.points);
  if (!pontos.length) return strokes as DrawStroke[];
  const cor = isDrawColor(message.color) ? message.color : DRAW_COLORS[0];
  const existente = strokes.find((stroke) => stroke.id === message.strokeId && stroke.author === message.author);
  if (existente) {
    const juntos = [...existente.points, ...pontos].slice(-MAX_POINTS_PER_STROKE);
    return strokes.map((stroke) => (stroke === existente ? { ...stroke, points: juntos, at: now } : stroke));
  }
  const novo: DrawStroke = {
    id: message.strokeId,
    author: message.author,
    authorName: message.authorName,
    color: cor,
    points: pontos,
    at: now,
  };
  // O teto derruba o traço mais velho, nunca o que está sendo desenhado agora.
  return [...strokes, novo].slice(-MAX_STROKES);
}

export function expireStrokes(strokes: readonly DrawStroke[], now: number, lifetime = STROKE_LIFETIME_MS): DrawStroke[] {
  // Sem prazo nada vence. O teto de `MAX_STROKES` continua valendo — ele é o
  // que impede a tela de virar um borrão depois de meia hora de conversa.
  if (isPersistent(lifetime)) return strokes as DrawStroke[];
  const vivos = strokes.filter((stroke) => now - stroke.at < lifetime);
  return vivos.length === strokes.length ? strokes as DrawStroke[] : vivos;
}

/** Limpar tudo de uma live: o botão de quem transmite, e o fim da captura. */
export function dropAll(): DrawStroke[] {
  return [];
}

export function dropAuthor(strokes: readonly DrawStroke[], author: string): DrawStroke[] {
  const restantes = strokes.filter((stroke) => stroke.author !== author);
  return restantes.length === strokes.length ? strokes as DrawStroke[] : restantes;
}
