// A versão do produto, e a ordem entre duas delas.
//
// Este arquivo é a **única** implementação da política de versão do Tumacord.
// O aplicativo, o servidor, o publicador, os scripts de instalação e os testes
// leem daqui — direta ou indiretamente. Até a 0.9.9 a mesma regra estava
// escrita quatro vezes (`desktop/update-check.cjs`, `shared/serverUpdate.ts`,
// `scripts/lib/escolher-versao.js` e `.py`), e quatro cópias de uma regra de
// ordenação são quatro chances de o aplicativo e o servidor discordarem sobre
// qual versão é a mais nova. As adaptações para CJS são **geradas** por
// `scripts/generate-version.mjs` a partir deste arquivo; `tests/version.test.ts`
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
  constructor(public readonly input: unknown, reason: string) {
    super(`versão inválida (${reason}): ${JSON.stringify(input)}`);
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
const FIELD = '(?:0|[1-9]\\d*)';
const FULL_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})\\.(${FIELD})(?:-([1-9]\\d*))?$`);
// `1.0` é aceito **só como entrada** e normalizado para `1.0.0`. Ele nunca é
// produzido por `formatVersion`, porque duas escritas para a mesma versão é
// exatamente o que a forma canônica existe para evitar.
const SHORT_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})(?:-([1-9]\\d*))?$`);

function rejectionReason(raw: string): string {
  if (!raw) return 'vazia';
  if (/[+]/.test(raw)) return 'metadado de build não faz parte desta convenção';
  if (/-(?:0\d*|\d*[A-Za-z])/.test(raw)) {
    return 'o sufixo é a revisão de manutenção, um inteiro positivo — alpha, beta e rc não entram: quem é ensaio é decidido pelo canal';
  }
  if (/\b0\d/.test(raw)) return 'zero à esquerda';
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
  const raw = input.trim().replace(/^v/i, '');
  const found = FULL_FORM.exec(raw) ?? SHORT_FORM.exec(raw);
  if (!found) return null;
  // `exec` devolve 1 + número de grupos. `FULL_FORM` tem quatro grupos e
  // `SHORT_FORM` tem três, então o tamanho já diz qual das duas casou.
  const short = found.length === 4;
  const major = Number(found[1]);
  const minor = Number(found[2]);
  const patch = short ? 0 : Number(found[3]);
  const revision = Number((short ? found[3] : found[4]) ?? 0);
  for (const value of [major, minor, patch, revision]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > VERSION_LIMIT) return null;
  }
  const text = revision ? `${major}.${minor}.${patch}-${revision}` : `${major}.${minor}.${patch}`;
  return { major, minor, patch, revision, text, tag: `v${text}`, tuple: [major, minor, patch, revision] };
}

/** O mesmo que `parseVersion`, mas lança em vez de devolver `null`. */
export function requireVersion(input: unknown): Version {
  const version = parseVersion(input);
  if (!version) throw new VersionError(input, typeof input === 'string' ? rejectionReason(input.trim().replace(/^v/i, '')) : 'não é texto');
  return version;
}

/** `true` quando o texto é uma versão deste projeto. */
export function isVersion(input: unknown): boolean {
  return parseVersion(input) !== null;
}

// Aceita tanto o texto quanto uma versão já lida, mas não confia na forma de
// um objeto qualquer: `{}` chegando aqui como se fosse uma versão estouraria
// com `TypeError` lá dentro, e `TypeError` não diz a quem chamou que o dado
// estava errado.
function asVersion(input: unknown): Version {
  if (typeof input === 'object' && input !== null) {
    const tuple = (input as Version).tuple;
    if (Array.isArray(tuple) && tuple.length === 4 && tuple.every((field) => Number.isSafeInteger(field))) {
      return input as Version;
    }
    throw new VersionError(input, 'objeto que não é uma versão lida');
  }
  return requireVersion(input);
}

/**
 * A ordem entre duas versões: `-1`, `0` ou `1`.
 *
 * **Lança `VersionError` para entrada malformada.** Devolver `0` diria "são a
 * mesma versão", e foi assim que uma entrada corrompida do catálogo já
 * convenceu um cliente de que ele estava em dia.
 */
export function compareVersions(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = asVersion(left);
  const b = asVersion(right);
  for (let index = 0; index < 4; index += 1) {
    if (a.tuple[index] !== b.tuple[index]) return a.tuple[index] > b.tuple[index] ? 1 : -1;
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
  const parsed: Version[] = [];
  for (const item of versions) {
    const version = parseVersion(item);
    if (version) parsed.push(version);
  }
  return parsed.sort((left, right) => compareVersions(right, left));
}
