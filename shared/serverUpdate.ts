// Quais versões o painel pode oferecer para este servidor, e qual delas pode
// mesmo ser aplicada.
//
// Isto é a metade que decide, e ela é pura de propósito: nada aqui fala com a
// rede nem executa coisa nenhuma. É a mesma separação de `update-check.cjs`,
// que decide a atualização do aplicativo — e pelo mesmo motivo: a parte que
// erra em silêncio quando erra tem de poder ser provada sem GitHub e sem
// máquina de ninguém.
//
// A regra de segurança que sustenta o resto: **o frontend não escolhe nada
// além de uma etiqueta**, e a etiqueta só vale se estiver na lista que o
// próprio servidor acabou de buscar. Um nome de branch, um caminho, uma URL ou
// um comando vindos do navegador não são aceitos em lugar nenhum deste
// caminho. `installableTag` é onde essa conferência acontece, e ela é feita de
// novo na hora de aplicar — a lista mostrada pode ter envelhecido.

// A política de versão vem de `shared/version.ts`, que é a implementação
// única do projeto. Até a 0.9.9 esta metade tinha a própria cópia da regra de
// ordenação, e a cópia divergiu da do aplicativo: `0.9.9-1` era lida como
// pré-versão aqui e o painel a oferecia *abaixo* da 0.9.9.
export { TAG_PATTERN, compareVersions, parseVersion } from './version.js';
import { TAG_PATTERN, type Version, compareVersions, parseVersion } from './version.js';

// O mesmo marcador invisível que o aplicativo já lê. As notas de cada Release
// saem do CHANGELOG, então marcar a versão como quebrada lá e republicar as
// notas faz todo mundo parar de oferecê-la — o servidor inclusive.
const BROKEN_MARKER = /<!--\s*tumacord:versao-quebrada\s*-->/i;
/** Versões que já estavam quebradas quando esta cópia foi compilada. */
const BROKEN_VERSIONS = new Map([
  ['0.8.9', 'as resoluções e o FPS da transmissão saem errados'],
]);

export interface ReleaseInput {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

export interface OfferedRelease {
  /** A etiqueta como o repositório a publica: `v0.9.9`. */
  tag: string;
  /** A mesma coisa sem o `v`, que é como o `package.json` a escreve. */
  version: string;
  publishedAt: string;
  pageUrl: string;
  prerelease: boolean;
  /** O motivo de não dever ser instalada, quando há um. Vazio quando pode. */
  broken: string;
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

function brokenReason(version: string, body: unknown): string {
  const embutida = BROKEN_VERSIONS.get(version);
  if (embutida) return embutida;
  return typeof body === 'string' && BROKEN_MARKER.test(body) ? 'marcada como retirada nas notas da versão' : '';
}

/**
 * A lista que o painel mostra: da mais nova para a mais antiga.
 *
 * Versões quebradas continuam na lista, e ditas. Escondê-las faria a página do
 * GitHub mostrar uma versão que o painel não mostra, sem explicação — e quem
 * fosse conferir concluiria que o painel está atrasado. Elas aparecem, com o
 * motivo, e não são aplicáveis.
 */
export function offeredReleases(releases: unknown, currentVersion: string): OfferedRelease[] {
  const atual: Version | null = parseVersion(currentVersion);
  const lista: OfferedRelease[] = [];
  for (const entrada of Array.isArray(releases) ? releases as ReleaseInput[] : []) {
    if (!entrada || entrada.draft === true) continue;
    const versao = parseVersion(entrada.tag_name ?? entrada.name);
    if (!versao) continue;
    lista.push({
      tag: `v${versao.text}`,
      version: versao.text,
      publishedAt: typeof entrada.published_at === 'string' ? entrada.published_at : '',
      pageUrl: typeof entrada.html_url === 'string' ? entrada.html_url : '',
      prerelease: entrada.prerelease === true,
      broken: brokenReason(versao.text, entrada.body),
      current: Boolean(atual) && compareVersions(versao, atual) === 0,
      newer: Boolean(atual) && compareVersions(versao, atual) > 0,
    });
  }
  lista.sort((left, right) => compareVersions(right.version, left.version));
  return lista;
}

/**
 * A etiqueta pedida, se ela puder ser aplicada.
 *
 * Três recusas, nesta ordem: o que não tem a forma de uma etiqueta deste
 * projeto, o que não está na lista que o servidor acabou de buscar, e o que
 * está marcado como quebrado. Nenhuma delas depende de o painel ter escondido
 * um botão — quem escolhe o que entra na máquina é este servidor.
 */
/**
 * O que a tela deve vir marcando.
 *
 * A mais nova que ainda não está instalada. Não havendo nenhuma, a que está
 * rodando — assim o botão nasce desabilitado dizendo que já está em dia, em vez
 * de sugerir a versão anterior, que é o que "a primeira da lista que não é a
 * atual" fazia.
 */
export function defaultChoice(offered: readonly OfferedRelease[]): string {
  const acima = offered.find((release) => release.newer && !release.broken);
  if (acima) return acima.tag;
  return offered.find((release) => release.current)?.tag ?? '';
}

export function installableTag(offered: readonly OfferedRelease[], tag: unknown): OfferedRelease | null {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) return null;
  const encontrada = offered.find((release) => release.tag === tag);
  if (!encontrada || encontrada.broken) return null;
  return encontrada;
}
