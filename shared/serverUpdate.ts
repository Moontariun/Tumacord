// Quais versões o painel pode oferecer para este servidor, e qual delas pode
// mesmo ser aplicada.
//
// Isto é a metade que decide, e ela é pura de propósito: nada aqui fala com a
// rede nem executa coisa nenhuma. É a mesma separação de `update-check.cjs`,
// que decide a atualização do aplicativo — e pelo mesmo motivo: a parte que
// erra em silêncio quando erra tem de poder ser provada sem máquina de
// ninguém.
//
// ## De onde a lista vem agora
//
// Do **catálogo assinado** que o serviço de atualizações desta VPS publica, e
// não do GitHub. Até a 0.9.9 o servidor buscava `api.github.com` para montar
// esta lista: a distribuição passou a ser privada, e uma lista vinda de fora
// decidiria o que roda na máquina a partir de um lugar que não é o dono.
//
// O motivo de uma versão estar retirada também mudou de lugar pelo mesmo
// argumento. Ele era um marcador escondido no corpo das notas da Release;
// agora é o campo `withdrawn` do catálogo, que é assinado e que o dono
// controla.
//
// ## A regra de segurança que sustenta o resto
//
// **O frontend não escolhe nada além de uma etiqueta**, e a etiqueta só vale
// se estiver na lista que o próprio servidor acabou de ler do catálogo. Um
// nome de branch, um caminho, uma URL ou um comando vindos do navegador não
// são aceitos em lugar nenhum deste caminho. `installableTag` é onde essa
// conferência acontece, e ela é feita de novo na hora de aplicar — a lista
// mostrada pode ter envelhecido.

// A política de versão vem de `shared/version.ts`, que é a implementação
// única do projeto. Até a 0.9.9 esta metade tinha a própria cópia da regra de
// ordenação, e a cópia divergiu da do aplicativo: `0.9.9-1` era lida como
// pré-versão aqui e o painel a oferecia *abaixo* da 0.9.9.
export { TAG_PATTERN, compareVersions, parseVersion } from './version.js';
import { TAG_PATTERN, type Version, compareVersions, parseVersion } from './version.js';

/** Uma entrada do catálogo, como o serviço de atualizações a publica. */
export interface CatalogEntryInput {
  releaseId?: unknown;
  version?: unknown;
  state?: unknown;
  publishedAt?: unknown;
  requiredStop?: unknown;
  withdrawn?: { reason?: unknown } | unknown;
}

export interface OfferedRelease {
  /** O identificador exato com que o executor a aplica. */
  releaseId: string;
  /** A etiqueta como o repositório a publica: `v0.9.9`. */
  tag: string;
  /** A mesma coisa sem o `v`, que é como o `package.json` a escreve. */
  version: string;
  publishedAt: string;
  /** O canal de onde ela veio. Campo explícito, e não sufixo da versão. */
  channel: string;
  /** O motivo de não dever ser instalada, quando há um. Vazio quando pode. */
  broken: string;
  /** O aviso de parada obrigatória que a release declara, quando declara. */
  requiredStop: string;
  /** Se é exatamente a versão que este servidor está rodando agora. */
  current: boolean;
  /**
   * Se é mais nova que a que está rodando.
   *
   * A lista traz tudo de propósito — voltar para uma versão anterior é um
   * caminho legítimo quando algo quebrou. Mas **oferecer** isso por padrão
   * seria sugerir um passo atrás a quem só abriu a tela, então é este campo
   * que separa a escolha padrão do resto da lista.
   */
  newer: boolean;
}

/** O texto de uma retirada, seja ela qual for a forma do campo. */
function withdrawalReason(entry: CatalogEntryInput): string {
  if (entry.state !== 'withdrawn') return '';
  const withdrawn = entry.withdrawn as { reason?: unknown } | undefined;
  const reason = typeof withdrawn?.reason === 'string' ? withdrawn.reason.trim() : '';
  return reason || 'retirada pelo dono da instalação';
}

/**
 * A lista que o painel mostra: da mais nova para a mais antiga.
 *
 * Versões retiradas continuam na lista, e ditas. Escondê-las faria o catálogo
 * ter uma versão que o painel não mostra, sem explicação — e quem fosse
 * conferir concluiria que o painel está atrasado. Elas aparecem, com o motivo,
 * e não são aplicáveis.
 */
export function offeredReleases(catalog: unknown, currentVersion: string): OfferedRelease[] {
  const running: Version | null = parseVersion(currentVersion);
  // O catálogo chega assinado; quem chama pode passar o documento inteiro ou
  // só o conteúdo. Aceitar os dois evita que uma camada desembrulhe errado e o
  // painel fique vazio sem dizer por quê.
  const payload = (catalog as { payload?: unknown })?.payload ?? catalog;
  const channels = (payload as { channels?: Record<string, { entries?: unknown }> })?.channels ?? {};

  const list: OfferedRelease[] = [];
  for (const [channel, content] of Object.entries(channels)) {
    for (const entry of Array.isArray(content?.entries) ? content.entries as CatalogEntryInput[] : []) {
      if (!entry) continue;
      const version = parseVersion(entry.version);
      if (!version) continue;
      if (typeof entry.releaseId !== 'string' || !entry.releaseId) continue;
      list.push({
        releaseId: entry.releaseId,
        tag: `v${version.text}`,
        version: version.text,
        publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : '',
        channel,
        broken: withdrawalReason(entry),
        requiredStop: typeof entry.requiredStop === 'string' ? entry.requiredStop : '',
        current: Boolean(running) && compareVersions(version, running as Version) === 0,
        newer: Boolean(running) && compareVersions(version, running as Version) > 0,
      });
    }
  }
  list.sort((left, right) => compareVersions(right.version, left.version));
  return list;
}

/**
 * O que a tela deve vir marcando.
 *
 * A mais nova que ainda não está instalada. Não havendo nenhuma, a que está
 * rodando — assim o botão nasce desabilitado dizendo que já está em dia, em vez
 * de sugerir a versão anterior, que é o que "a primeira da lista que não é a
 * atual" fazia.
 */
export function defaultChoice(offered: readonly OfferedRelease[]): string {
  const above = offered.find((release) => release.newer && !release.broken);
  if (above) return above.tag;
  return offered.find((release) => release.current)?.tag ?? '';
}

/**
 * A etiqueta pedida, se ela puder ser aplicada.
 *
 * Três recusas, nesta ordem: o que não tem a forma de uma etiqueta deste
 * projeto, o que não está na lista que o servidor acabou de ler, e o que está
 * marcado como retirado. Nenhuma delas depende de o painel ter escondido um
 * botão — quem escolhe o que entra na máquina é este servidor.
 */
export function installableTag(offered: readonly OfferedRelease[], tag: unknown): OfferedRelease | null {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) return null;
  const found = offered.find((release) => release.tag === tag);
  if (!found || found.broken) return null;
  return found;
}
