import { createHmac } from 'node:crypto';

// TURN: a última rede de segurança da call.
//
// O enlace direto resolve a maioria dos casos, mas existe um que nenhuma
// travessia resolve: os dois lados atrás de CGNAT com NAT simétrico e sem
// IPv6. Aí não há endereço para furar — a única saída é um terceiro que os
// dois alcancem por conexão de saída e que repasse os pacotes.
//
// Isso não abre a conversa para o servidor. O TURN encaminha datagramas
// opacos; as chaves do DTLS-SRTP são negociadas entre os dois participantes e
// nunca passam por ele. Ele sabe que dois endereços trocam bytes, e não o que
// os bytes dizem.
//
// As credenciais são temporárias, no esquema que o coturn chama de
// `use-auth-secret` (draft-uberti-behave-turn-rest-00): o servidor nunca
// guarda uma senha, apenas assina um prazo com um segredo compartilhado. Um
// código que vaze deixa de valer quando o prazo acaba.

export interface TurnCredentials {
  username: string;
  credential: string;
  expiresAt: number;
}

export interface TurnConfiguration {
  urls: string[];
  secret: string;
  ttlSeconds: number;
}

export const DEFAULT_TURN_TTL_SECONDS = 8 * 60 * 60;

export function parseTurnUrls(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^turns?:/i.test(url))
    .filter((url, index, all) => all.indexOf(url) === index)
    .slice(0, 8);
}

export function turnConfiguration(environment: NodeJS.ProcessEnv): TurnConfiguration | null {
  const urls = parseTurnUrls(environment.TURN_URLS);
  const secret = environment.TURN_SECRET?.trim() ?? '';
  // Sem as duas metades não há TURN: anunciar uma URL sem credencial faria o
  // navegador tentar, falhar na autenticação e perder tempo de ICE à toa.
  if (!urls.length || !secret) return null;
  const ttl = Number(environment.TURN_TTL_SECONDS ?? DEFAULT_TURN_TTL_SECONDS);
  return {
    urls,
    secret,
    ttlSeconds: Number.isFinite(ttl) && ttl >= 300 && ttl <= 86_400 ? Math.floor(ttl) : DEFAULT_TURN_TTL_SECONDS,
  };
}

// O usuário é `<validade>:<nome>` e a senha é o HMAC-SHA1 disso com o segredo,
// em base64. O coturn recalcula o mesmo HMAC e compara; nada é armazenado dos
// dois lados.
export function ephemeralTurnCredentials(configuration: TurnConfiguration, name: string, now = Date.now()): TurnCredentials {
  const expiresAt = Math.floor(now / 1000) + configuration.ttlSeconds;
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'tumacord';
  const username = `${expiresAt}:${safeName}`;
  return {
    username,
    credential: createHmac('sha1', configuration.secret).update(username, 'utf8').digest('base64'),
    expiresAt: expiresAt * 1000,
  };
}

export interface IceServerDescription {
  urls: string[];
  username?: string;
  credential?: string;
}

export function turnIceServers(configuration: TurnConfiguration | null, credentials: TurnCredentials | null): IceServerDescription[] {
  if (!configuration || !credentials) return [];
  // Um único bloco com todas as URLs: o ICE já testa cada uma e prefere o
  // caminho direto por prioridade de candidato. O relay só entra quando
  // nenhum par direto se forma, sem nenhuma lógica nossa no meio.
  return [{ urls: configuration.urls, username: credentials.username, credential: credentials.credential }];
}
