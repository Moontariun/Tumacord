// A versão do produto, e a ordem entre duas delas.
//
// Este arquivo é a **única** implementação da política de versão do Tumacord.
// O aplicativo, o servidor, o publicador, os scripts de instalação e os testes
// leem daqui — direta ou indiretamente. Até a 0.9.9 a mesma regra estava
// escrita quatro vezes (`desktop/update-check.cjs`, `shared/serverUpdate.ts`,
// `scripts/lib/escolher-versao.js` e `.py`), e quatro cópias de uma regra de
// ordenação são quatro chances de o aplicativo e o servidor discordarem sobre
// qual versão é a mais nova. As adaptações para CJS e Python são **geradas**
// por `scripts/gerar-versao.mjs` a partir deste arquivo; `tests/version.test.ts`
// falha se alguma delas divergir.
//
// ## A convenção
//
//     0.9.9 < 0.9.9-1 < 0.9.9-2 < 0.9.9-10 < 0.9.10 < 1.0.0 < 1.0.0-1
//
// Uma versão é a tupla `(major, minor, patch, revision)`. Sem sufixo, a
// revisão é zero. O sufixo `-N` é a **revisão de manutenção**: um número
// inteiro positivo que vem *depois* da versão que ele corrige. `0.9.9-1` é a
// correção da 0.9.9, não um ensaio para ela.
//
// Isto **não é SemVer**. No SemVer, `0.9.9-1` é uma pré-versão e vem *antes*
// da 0.9.9 — exatamente o contrário do que este projeto precisa. Por isso
// nenhum comparador de SemVer, e nenhuma ordenação alfabética, pode decidir
// nada neste caminho: os dois dariam a resposta errada justamente na pergunta
// que importa ("a 0.9.9-1 é mais nova que a 0.9.9?").
//
// ## O que não entra aqui
//
// `alpha`, `beta`, `rc` e `+build` **não são aceitos**. Misturá-los com a
// revisão de manutenção traria de volta a ambiguidade que a convenção existe
// para eliminar: `-1` teria de ser lido como "antes" num caso e "depois" no
// outro, e a leitura certa dependeria de adivinhar a intenção de quem marcou a
// etiqueta. Quem é público e quem é ensaio é decidido pelo **canal** — um
// campo separado e explícito do catálogo (`stable`, `test`) — e não pelo
// formato do número.
//
// ## Entrada malformada é erro
//
// Um texto que não é uma versão deste projeto não é "igual" a coisa nenhuma.
// A versão anterior de `compareVersions` devolvia `0` para lixo, e `0` quer
// dizer "são a mesma versão": um catálogo com uma entrada corrompida fazia o
// cliente concluir que já estava em dia. Aqui, comparar lixo lança
// `VersionError`, e quem chama decide o que fazer com a entrada ruim.

/** O erro de uma versão que não tem a forma que este projeto publica. */
export class VersionError extends Error {
  constructor(public readonly input: unknown, motivo: string) {
    super(`versão inválida (${motivo}): ${JSON.stringify(input)}`);
    this.name = 'VersionError';
  }
}

/**
 * O maior valor aceito em qualquer um dos quatro campos.
 *
 * O limite não é estético: a versão numérica do Windows tem quatro campos de
 * 16 bits, e `0.9.9-1` precisa virar `0.9.9.1` num formato onde 65536 não
 * cabe. Recusar aqui, na hora de ler, é melhor do que descobrir no
 * electron-builder que a etiqueta publicada não tem representação no
 * instalador — quando os binários já foram feitos.
 */
export const VERSION_LIMIT = 65535;

/** A forma de uma etiqueta publicada: `v0.9.9` ou `v0.9.9-1`. */
export const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[1-9]\d*)?$/;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Zero quando não há sufixo. Nunca negativo. */
  readonly revision: number;
  /** A forma canônica, sem `v` e sem zeros à esquerda: `0.9.9-1`. */
  readonly text: string;
  /** A forma canônica com `v`, que é como as etiquetas são publicadas. */
  readonly tag: string;
  readonly tuple: readonly [number, number, number, number];
}

// Cada campo é um número sem zero à esquerda. `01.0.0` é recusado de
// propósito: duas escritas para a mesma versão fariam `0.9.9-1` e `0.9.9-01`
// virarem etiquetas diferentes apontando para o mesmo lugar, e é assim que se
// publica conteúdo diferente sob o mesmo número sem ninguém notar.
const CAMPO = '(?:0|[1-9]\\d*)';
const COMPLETA = new RegExp(`^(${CAMPO})\\.(${CAMPO})\\.(${CAMPO})(?:-([1-9]\\d*))?$`);
// `1.0` é aceito **só como entrada** e normalizado para `1.0.0`. Ele nunca é
// produzido por `formatVersion`, porque duas escritas para a mesma versão é
// exatamente o que a forma canônica existe para evitar.
const CURTA = new RegExp(`^(${CAMPO})\\.(${CAMPO})(?:-([1-9]\\d*))?$`);

function motivoDaRecusa(bruto: string): string {
  if (!bruto) return 'vazia';
  if (/[+]/.test(bruto)) return 'metadado de build não faz parte desta convenção';
  if (/-(?:0\d*|\d*[A-Za-z])/.test(bruto)) {
    return 'o sufixo é a revisão de manutenção, um inteiro positivo — alpha, beta e rc não entram: quem é ensaio é decidido pelo canal';
  }
  if (/\b0\d/.test(bruto)) return 'zero à esquerda';
  return 'formato';
}

/**
 * Lê uma versão, ou devolve `null` se o texto não for uma.
 *
 * Aceita o `v` das etiquetas e a forma curta `1.0` como **entrada**. O que sai
 * é sempre canônico.
 */
export function parseVersion(input: unknown): Version | null {
  if (typeof input !== 'string') return null;
  const bruto = input.trim().replace(/^v/i, '');
  const m = COMPLETA.exec(bruto) ?? CURTA.exec(bruto);
  if (!m) return null;
  // `exec` devolve 1 + número de grupos. `COMPLETA` tem quatro grupos e
  // `CURTA` tem três, então o tamanho já diz qual das duas casou.
  const curta = m.length === 4;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = curta ? 0 : Number(m[3]);
  const revision = Number((curta ? m[3] : m[4]) ?? 0);
  for (const valor of [major, minor, patch, revision]) {
    if (!Number.isSafeInteger(valor) || valor < 0 || valor > VERSION_LIMIT) return null;
  }
  const text = revision ? `${major}.${minor}.${patch}-${revision}` : `${major}.${minor}.${patch}`;
  return { major, minor, patch, revision, text, tag: `v${text}`, tuple: [major, minor, patch, revision] };
}

/** O mesmo que `parseVersion`, mas lança em vez de devolver `null`. */
export function requireVersion(input: unknown): Version {
  const versao = parseVersion(input);
  if (!versao) throw new VersionError(input, typeof input === 'string' ? motivoDaRecusa(input.trim().replace(/^v/i, '')) : 'não é texto');
  return versao;
}

/** `true` quando o texto é uma versão deste projeto. */
export function isVersion(input: unknown): boolean {
  return parseVersion(input) !== null;
}

/**
 * A ordem entre duas versões: `-1`, `0` ou `1`.
 *
 * **Lança `VersionError` para entrada malformada.** Devolver `0` diria "são a
 * mesma versão", e foi assim que uma entrada corrompida do catálogo já
 * convenceu um cliente de que ele estava em dia.
 */
// Aceita tanto o texto quanto uma versão já lida, mas não confia na forma de
// um objeto qualquer: `{}` chegando aqui como se fosse uma versão estouraria
// com `TypeError` lá dentro, e `TypeError` não diz a quem chamou que o dado
// estava errado.
function comoVersao(entrada: unknown): Version {
  if (typeof entrada === 'object' && entrada !== null) {
    const tupla = (entrada as Version).tuple;
    if (Array.isArray(tupla) && tupla.length === 4 && tupla.every((campo) => Number.isSafeInteger(campo))) {
      return entrada as Version;
    }
    throw new VersionError(entrada, 'objeto que não é uma versão lida');
  }
  return requireVersion(entrada);
}

export function compareVersions(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = comoVersao(left);
  const b = comoVersao(right);
  for (let i = 0; i < 4; i += 1) {
    if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] > b.tuple[i] ? 1 : -1;
  }
  return 0;
}

/** A forma canônica de uma versão já lida. */
export function formatVersion(version: Version): string {
  return version.text;
}

/**
 * A versão numérica de quatro campos que o Windows entende.
 *
 * `0.9.9` vira `0.9.9.0` e `0.9.9-1` vira `0.9.9.1`. Sem o quarto campo, o
 * instalador da revisão teria o mesmo número da versão que ela corrige, e o
 * Windows trataria a atualização como reinstalação da mesma coisa.
 */
export function windowsVersion(input: unknown): string {
  const { major, minor, patch, revision } = requireVersion(input);
  return `${major}.${minor}.${patch}.${revision}`;
}

/** Ordena da mais nova para a mais antiga, descartando o que não for versão. */
export function sortDescending(versions: readonly unknown[]): Version[] {
  const lidas: Version[] = [];
  for (const item of versions) {
    const versao = parseVersion(item);
    if (versao) lidas.push(versao);
  }
  return lidas.sort((left, right) => compareVersions(right, left));
}
