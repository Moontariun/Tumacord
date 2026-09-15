// Endereços dentro de uma mensagem.
//
// O texto continua sendo texto: o que sai daqui são pedaços, e quem desenha um
// pedaço de link é um `<a>` do React — que escapa o conteúdo por construção. Um
// `innerHTML` com os links montados à mão seria o caminho mais curto até
// alguém mandar uma mensagem que executa código na tela de todo mundo.

export interface TextPart {
  kind: 'text' | 'link';
  text: string;
  /** O endereço que o link abre. Sempre http ou https. */
  href?: string;
}

// Pontuação no fim quase nunca faz parte do endereço: "olha isso: https://x.com."
const TRAILING = /[.,;:!?'"»”’]+$/;

function trimLink(raw: string): string {
  let link = raw.replace(TRAILING, '');
  // Um parêntese de fechamento só é do link se ele abriu um dentro dele, como
  // na Wikipédia: `https://pt.wikipedia.org/wiki/Café_(bebida)`.
  while (link.endsWith(')') && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) {
    link = link.slice(0, -1).replace(TRAILING, '');
  }
  return link;
}

export function splitLinks(body: string): TextPart[] {
  const parts: TextPart[] = [];
  if (!body) return parts;
  // Uma expressão nova por chamada: nada de `lastIndex` compartilhado.
  const pattern = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    const text = trimLink(match[0]);
    if (!text || text.length < 5) continue;
    const href = /^www\./i.test(text) ? `https://${text}` : text;
    try {
      const url = new URL(href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (start > cursor) parts.push({ kind: 'text', text: body.slice(cursor, start) });
    parts.push({ kind: 'link', text, href });
    cursor = start + text.length;
  }
  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) });
  return parts;
}

/** Os primeiros endereços distintos de uma mensagem, para as prévias. */
export function previewableLinks(body: string, max = 2): string[] {
  const vistos: string[] = [];
  for (const part of splitLinks(body)) {
    if (part.kind !== 'link' || !part.href || vistos.includes(part.href)) continue;
    vistos.push(part.href);
    if (vistos.length >= max) break;
  }
  return vistos;
}
