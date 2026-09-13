// O aviso de "já volto" que aparece sobre a sua transmissão.
//
// ## O que atravessa a rede, e o que não
//
// Atravessam duas coisas: o **texto** e o **nome** de um tema. Não atravessa
// cor nenhuma.
//
// A diferença importa. Uma cor vinda da rede terminaria num atributo `style`,
// e `style` é um lugar onde não se coloca entrada de terceiro: basta um valor
// com `url(...)` ou uma propriedade inesperada para o aviso de alguém passar a
// mexer na tela de quem só estava assistindo. Com um conjunto fechado de temas,
// o que viaja é uma etiqueta que o receptor **procura numa lista** — e um tema
// desconhecido cai no padrão em vez de virar CSS.
//
// O texto atravessa porque é o recado da pessoa, e não haveria como escrevê-lo
// de outro jeito. Ele é limitado no tamanho, cortado de quebras de linha e
// renderizado como texto puro pelo React, que escapa por construção.

/** Os temas disponíveis. Fechado de propósito: ver o cabeçalho. */
export const AWAY_THEMES = ['violeta', 'verde', 'ambar', 'tomate', 'grafite'] as const;

export type AwayTheme = (typeof AWAY_THEMES)[number];

export const AWAY_THEME_LABEL: Record<AwayTheme, string> = {
  violeta: 'Violeta',
  verde: 'Verde',
  ambar: 'Âmbar',
  tomate: 'Tomate',
  grafite: 'Grafite',
};

export const DEFAULT_AWAY_MESSAGE = 'Já volto';

/**
 * O teto do recado.
 *
 * Curto de propósito: ele é desenhado grande, no meio da transmissão de alguém.
 * Um texto que não cabe em uma linha vira um bloco cobrindo o que a pessoa
 * estava mostrando — e o recado é "saí um instante", não um comunicado.
 */
export const MAX_AWAY_MESSAGE = 48;

const MESSAGE_KEY = 'tumacord.away-message';
const THEME_KEY = 'tumacord.away-theme';

/**
 * Limpa um recado, venha ele do campo de configuração ou da rede.
 *
 * Quebras de linha e espaços repetidos viram um espaço só: o cartão é de uma
 * linha, e um `\n` vindo de fora esticaria o desenho na tela de todo mundo.
 */
export function sanitizeAwayMessage(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_AWAY_MESSAGE);
}

/** Um tema conhecido, ou o padrão. Nada de fora da lista entra. */
export function sanitizeAwayTheme(theme: unknown): AwayTheme {
  return AWAY_THEMES.includes(theme as AwayTheme) ? (theme as AwayTheme) : 'violeta';
}

export function readAwayMessage(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_AWAY_MESSAGE;
  const stored = sanitizeAwayMessage(localStorage.getItem(MESSAGE_KEY));
  // Um recado apagado volta ao padrão em vez de virar um cartão em branco:
  // um cartão sem texto não avisa nada a ninguém.
  return stored || DEFAULT_AWAY_MESSAGE;
}

export function setAwayMessage(text: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(MESSAGE_KEY, sanitizeAwayMessage(text));
}

export function readAwayTheme(): AwayTheme {
  if (typeof localStorage === 'undefined') return 'violeta';
  return sanitizeAwayTheme(localStorage.getItem(THEME_KEY));
}

export function setAwayTheme(theme: AwayTheme): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, sanitizeAwayTheme(theme));
}
