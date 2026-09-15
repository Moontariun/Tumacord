// A prévia de um link colado no chat: título, descrição e imagem.
//
// Quem busca é o servidor, e não o aplicativo, por duas razões. O navegador não
// lê uma página de outro domínio (CORS), e buscar do lado de quem lê entregaria
// o IP de cada pessoa do grupo ao site do link — basta alguém colar um endereço
// que registre visitas. Aqui a página vê o servidor, uma vez, e a imagem chega
// ao aplicativo já embutida.
//
// ## O cuidado que torna isto seguro
//
// Um servidor que busca qualquer endereço que lhe pedem é uma porta para dentro
// da rede dele: `http://127.0.0.1:4301/admin/...`, o painel do roteador, o
// endpoint de metadados da nuvem. Por isso:
//
// - só http e https, só nas portas 80 e 443, sem usuário e senha no endereço;
// - o endereço é conferido DEPOIS da resolução de nome, na hora de conectar —
//   conferir o nome antes e deixar o sistema resolver de novo depois abriria a
//   brecha do DNS que muda de resposta entre as duas consultas;
// - redirecionamentos são seguidos à mão, e cada salto passa pela mesma
//   conferência;
// - tempo e tamanho têm teto, e a resposta é guardada por meia hora.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** A imagem já embutida (`data:`), para o aplicativo não ir buscar fora. */
  image?: string;
}

const MAX_HTML_BYTES = 768 * 1024;
const MAX_IMAGE_BYTES = 700 * 1024;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 4;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_LIMIT = 400;
const USER_AGENT = 'Mozilla/5.0 (compatible; TumacordLinkPreview/1.0; +https://github.com/Moontariun/Tumacord)';

// --- endereços ---------------------------------------------------------------

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function publicIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, metadados de nuvem
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  if (a >= 224) return false; // multicast e reservado
  return true;
}

/** Se um IP literal é alcançável na internet pública, e só nela. */
export function isPublicAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = isIP(clean);
  if (family === 4) return publicIpv4(clean);
  if (family !== 6) return false;
  // IPv4 dentro de IPv6 (`::ffff:127.0.0.1`) é o IPv4 de dentro.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
  if (mapped) return publicIpv4(mapped[1]);
  if (clean === '::' || clean === '::1') return false;
  const first = parseInt(clean.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7, único local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10, link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (clean.startsWith('2001:db8:') || clean.startsWith('64:ff9b:')) return false;
  return true;
}

/** O endereço aceito para buscar, ou `null`. */
export function normalizePreviewUrl(input: unknown): URL | null {
  if (typeof input !== 'string' || input.length > 2_048) return null;
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (isIP(host.replace(/^\[|\]$/g, '')) && !isPublicAddress(host)) return null;
  url.hash = '';
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Resolve o nome e recusa a conexão se QUALQUER resposta for interna. */
function safeLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...(options as Record<string, unknown>), all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((entry) => !isPublicAddress(entry.address))) {
      const refused = Object.assign(new Error('Endereço interno recusado.'), { code: 'EADDRNOTPUBLIC' });
      return callback(refused, '');
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

// --- busca -------------------------------------------------------------------

interface Fetched {
  url: URL;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

function decompress(stream: Readable, encoding: string | undefined): Readable {
  const tipo = String(encoding ?? '').toLowerCase();
  if (tipo === 'gzip' || tipo === 'x-gzip') return stream.pipe(zlib.createGunzip());
  if (tipo === 'deflate') return stream.pipe(zlib.createInflate());
  if (tipo === 'br') return stream.pipe(zlib.createBrotliDecompress());
  return stream;
}

function requestOnce(url: URL, accept: string, maxBytes: number): Promise<{ status: number; location?: string; fetched?: Fetched }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.6', 'accept-encoding': 'gzip, deflate, br' },
      lookup: safeLookup as never,
      timeout: TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        return resolve({ status, location: response.headers.location });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return resolve({ status });
      }
      const pedacos: Buffer[] = [];
      let total = 0;
      let truncated = false;
      const body = decompress(response, response.headers['content-encoding']);
      const finish = () => resolve({ status, fetched: { url, contentType: String(response.headers['content-type'] ?? ''), body: Buffer.concat(pedacos), truncated } });
      body.on('data', (chunk: Buffer) => {
        if (truncated) return;
        total += chunk.length;
        if (total > maxBytes) {
          truncated = true;
          pedacos.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
          request.destroy();
          finish();
          return;
        }
        pedacos.push(chunk);
      });
      body.on('end', () => { if (!truncated) finish(); });
      body.on('error', (error) => { if (!truncated) reject(error); });
    });
    request.on('timeout', () => request.destroy(new Error('A página demorou demais para responder.')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchLimited(start: URL, accept: string, maxBytes: number): Promise<Fetched | null> {
  let current = start;
  for (let salto = 0; salto <= MAX_REDIRECTS; salto += 1) {
    const result = await requestOnce(current, accept, maxBytes);
    if (result.fetched) return result.fetched;
    if (!result.location) return null;
    const next = normalizePreviewUrl(new URL(result.location, current).href);
    if (!next) return null;
    current = next;
  }
  return null;
}

// --- leitura da página -------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (inteiro, codigo: string) => {
    if (codigo[0] === '#') {
      const numero = codigo[1] === 'x' || codigo[1] === 'X' ? parseInt(codigo.slice(2), 16) : parseInt(codigo.slice(1), 10);
      return Number.isFinite(numero) && numero > 0 && numero < 0x110000 ? String.fromCodePoint(numero) : inteiro;
    }
    return ENTITIES[codigo.toLowerCase()] ?? inteiro;
  });
}

function clean(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const limpo = decodeEntities(text).replace(/\s+/g, ' ').trim();
  if (!limpo) return undefined;
  return limpo.length > max ? `${limpo.slice(0, max - 1).trimEnd()}…` : limpo;
}

function attributesOf(tag: string): Record<string, string> {
  const atributos: Record<string, string> = {};
  // Uma expressão nova a cada chamada: `lastIndex` de uma RegExp global
  // compartilhada é o tipo de coisa que já travou este projeto uma vez.
  const padrao = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of tag.matchAll(padrao)) atributos[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  return atributos;
}

export interface PageMeta {
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
}

/** Lê os metadados de uma página HTML. Puro, para ser testado sem rede. */
export function parsePreviewHtml(html: string, pageUrl: URL): PageMeta {
  const head = html.slice(0, MAX_HTML_BYTES);
  const meta = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const atributos = attributesOf(match[0]);
    const chave = (atributos.property ?? atributos.name ?? atributos.itemprop ?? '').toLowerCase();
    if (chave && atributos.content !== undefined && !meta.has(chave)) meta.set(chave, atributos.content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  let imageUrl: string | undefined;
  const bruta = meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src');
  if (bruta) {
    try {
      const resolvida = new URL(decodeEntities(bruta.trim()), pageUrl);
      if (resolvida.protocol === 'https:' || resolvida.protocol === 'http:') imageUrl = resolvida.href;
    } catch { /* imagem com endereço torto fica de fora */ }
  }
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 160),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 300),
    siteName: clean(meta.get('og:site_name') ?? meta.get('application-name'), 60) ?? pageUrl.hostname.replace(/^www\./, ''),
    imageUrl,
  };
}

function charsetOf(contentType: string): string {
  return /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, '').toLowerCase() || 'utf-8';
}

function decodeBody(body: Buffer, contentType: string): string {
  try { return new TextDecoder(charsetOf(contentType)).decode(body); } catch { return body.toString('utf8'); }
}

const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp)\b/i;

async function embedImage(address: string | undefined): Promise<string | undefined> {
  const url = normalizePreviewUrl(address);
  if (!url) return undefined;
  const imagem = await fetchLimited(url, 'image/webp,image/png,image/jpeg,image/gif;q=0.9', MAX_IMAGE_BYTES + 1).catch(() => null);
  if (!imagem || imagem.truncated || !IMAGE_TYPE.test(imagem.contentType) || !imagem.body.length) return undefined;
  return `data:${imagem.contentType.split(';')[0].trim().toLowerCase()};base64,${imagem.body.toString('base64')}`;
}

function youtubeVideo(url: URL): boolean {
  const host = url.hostname.replace(/^www\.|^m\./, '');
  return host === 'youtu.be' || ((host === 'youtube.com' || host === 'music.youtube.com') && (url.pathname === '/watch' || url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/live/')));
}

// O YouTube responde a um servidor com a tela de consentimento, sem metadado
// nenhum. O oEmbed dele é público, feito para isto, e devolve título, canal e
// miniatura.
async function youtubePreview(url: URL): Promise<LinkPreviewData | null> {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('url', url.href);
  const resposta = await fetchLimited(endpoint, 'application/json', 64 * 1024).catch(() => null);
  if (!resposta) return null;
  try {
    const corpo = JSON.parse(resposta.body.toString('utf8')) as { title?: string; author_name?: string; thumbnail_url?: string };
    return { url: url.href, siteName: 'YouTube', title: clean(corpo.title, 160), description: clean(corpo.author_name, 120), image: await embedImage(corpo.thumbnail_url) };
  } catch {
    return null;
  }
}

async function buildPreview(url: URL): Promise<LinkPreviewData | null> {
  if (youtubeVideo(url)) {
    const video = await youtubePreview(url);
    if (video) return video;
  }
  const pagina = await fetchLimited(url, 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', MAX_HTML_BYTES);
  if (!pagina) return null;
  // Link direto para uma imagem: a prévia é a própria imagem.
  if (IMAGE_TYPE.test(pagina.contentType)) {
    if (pagina.truncated) return null;
    const nome = decodeURIComponent(pagina.url.pathname.split('/').pop() || '') || pagina.url.hostname;
    return { url: url.href, title: clean(nome, 120), siteName: pagina.url.hostname.replace(/^www\./, ''), image: `data:${pagina.contentType.split(';')[0].trim().toLowerCase()};base64,${pagina.body.toString('base64')}` };
  }
  if (!/html|xml/i.test(pagina.contentType)) return null;
  const dados = parsePreviewHtml(decodeBody(pagina.body, pagina.contentType), pagina.url);
  if (!dados.title && !dados.description && !dados.imageUrl) return null;
  return { url: url.href, title: dados.title, description: dados.description, siteName: dados.siteName, image: await embedImage(dados.imageUrl) };
}

export class LinkPreviewer {
  private readonly cache = new Map<string, { at: number; value: Promise<LinkPreviewData | null> }>();

  constructor(private readonly build: (url: URL) => Promise<LinkPreviewData | null> = buildPreview) {}

  preview(input: unknown, now = Date.now()): Promise<LinkPreviewData | null> {
    const url = normalizePreviewUrl(input);
    if (!url) return Promise.resolve(null);
    const chave = url.href;
    const guardada = this.cache.get(chave);
    if (guardada && now - guardada.at < CACHE_TTL_MS) return guardada.value;
    // A promessa é guardada, e não o resultado: cinco pessoas abrindo o mesmo
    // canal ao mesmo tempo fazem uma busca só.
    const value = this.build(url).catch(() => null);
    this.cache.set(chave, { at: now, value });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }
}
