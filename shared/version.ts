// A versão do produto, e a ordem entre duas delas.
//
// Este arquivo é a **única** implementação da política de versão do Tumacord.
// O aplicativo, o servidor, o publicador, os scripts de instalação e os testes
// leem daqui — direta ou indiretamente. As adaptações para CJS são **geradas**
// por `scripts/generate-version.mjs` a partir deste arquivo;
// `tests/version.test.ts` falha se alguma delas divergir.
//
// ## A convenção: SemVer 2.0.0
//
//     1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-rc.1 < 1.0.0 < 1.0.1
//
// `MAJOR.MINOR.PATCH`, com pré-versão opcional depois de `-` e metadado de
// build opcional depois de `+`. É a especificação pública, sem dialeto: quem
// chega ao projeto já sabe ler, e qualquer ferramenta de fora concorda com a
// ordem que sai daqui.
//
// ## O que mudou na 0.10.0, e o que isso custou
//
// Até a 0.9.9-2 este projeto usava uma convenção própria em que o sufixo `-N`
// era a **revisão de manutenção** e vinha *depois* da versão que ele corrigia:
// `0.9.9-1` era a correção da 0.9.9. Sob SemVer isso se inverte — `0.9.9-1`
// passa a ser uma pré-versão da 0.9.9, e portanto **anterior** a ela.
//
// A troca é deliberada e não deixa ninguém para trás, por um motivo aritmético:
// `0.10.0` é maior que `0.9.9-1` nas **duas** leituras. Quem está na 0.9.9-1
// hoje recebe a 0.10.0 sem depender de qual das duas regras a cópia instalada
// usa. A inversão só passaria a machucar se uma versão nova voltasse a usar
// `-N` para dizer "depois" — e é por isso que ela não existe mais aqui.
//
// **Uma correção de 0.9.9 agora se chama 0.9.10**, e não 0.9.9-1. É a forma
// SemVer de dizer a mesma coisa, e ela ordena certo sem convenção nenhuma.
//
// ## Pré-versão e canal continuam sendo coisas diferentes
//
// Uma pré-versão (`1.0.0-rc.1`) diz o que o **número** é. O canal (`stable`,
// `test`) diz para **quem** ela é oferecida. São perguntas separadas e
// continuam em campos separados: publicar `1.0.0-rc.1` no canal estável é
// possível, é quase sempre um engano, e por isso o publicador exige que quem
// faça isso diga que quer.
//
// ## Entrada malformada é erro
//
// Um texto que não é uma versão não é "igual" a coisa nenhuma. Uma versão
// anterior de `compareVersions` devolvia `0` para lixo, e `0` quer dizer "são a
// mesma versão": um catálogo com uma entrada corrompida fazia o cliente
// concluir que já estava em dia. Aqui, comparar lixo lança `VersionError`, e
// quem chama decide o que fazer com a entrada ruim.

/** O erro de uma versão que não tem a forma que este projeto publica. */
export class VersionError extends Error {
  constructor(public readonly input: unknown, reason: string) {
    super(`versão inválida (${reason}): ${JSON.stringify(input)}`);
    this.name = 'VersionError';
  }
}

/**
 * O maior valor aceito em `major`, `minor` e `patch`.
 *
 * O limite não é estético: a versão numérica do Windows tem quatro campos de
 * 16 bits, e uma versão que não cabe lá não tem representação no instalador.
 * Recusar aqui, na hora de ler, é melhor do que descobrir isso no
 * electron-builder quando os binários já foram feitos.
 */
export const VERSION_LIMIT = 65535;

// Um identificador de pré-versão: alfanumérico com hífen, ou um número sem
// zero à esquerda. `1.0.0-01` é recusado porque `01` e `1` seriam etiquetas
// diferentes apontando para a mesma coisa — é assim que se publica conteúdo
// diferente sob o mesmo número sem ninguém notar.
const NUMERIC_ID = '0|[1-9]\\d*';
const ALPHANUM_ID = '\\d*[A-Za-z-][0-9A-Za-z-]*';
const PRE_ID = `(?:${NUMERIC_ID}|${ALPHANUM_ID})`;
const PRERELEASE = `(?:${PRE_ID})(?:\\.(?:${PRE_ID}))*`;
const BUILD = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const FIELD = '(?:0|[1-9]\\d*)';

/** A forma de uma etiqueta publicada: `v1.2.3`, `v1.2.3-rc.1`, `v1.2.3+abc`. */
export const TAG_PATTERN = new RegExp(`^v${FIELD}\\.${FIELD}\\.${FIELD}(?:-${PRERELEASE})?(?:\\+${BUILD})?$`);

const FULL_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})\\.(${FIELD})(?:-(${PRERELEASE}))?(?:\\+(${BUILD}))?$`);
// `1.0` é aceito **só como entrada** e normalizado para `1.0.0`. Ele nunca é
// produzido por `formatVersion`: duas escritas para a mesma versão é
// exatamente o que a forma canônica existe para evitar.
const SHORT_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})(?:-(${PRERELEASE}))?(?:\\+(${BUILD}))?$`);

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /**
   * Os identificadores de pré-versão, já separados por ponto. Vazio quando a
   * versão é final — e é o vazio que a faz vir **depois** das pré-versões do
   * mesmo `major.minor.patch`.
   */
  readonly prerelease: readonly (string | number)[];
  /** O metadado de build, sem o `+`. Não participa da ordem, por especificação. */
  readonly build: string;
  /** `true` quando há pré-versão. */
  readonly isPrerelease: boolean;
  /** A forma canônica, sem `v`: `1.2.3-rc.1`. Inclui o `+build` quando existe. */
  readonly text: string;
  /** A forma canônica com `v`, que é como as etiquetas são publicadas. */
  readonly tag: string;
  /** `(major, minor, patch)`. A pré-versão não cabe numa tupla numérica. */
  readonly tuple: readonly [number, number, number];
}

function rejectionReason(raw: string): string {
  if (!raw) return 'vazia';
  if (/-(?:0\d)/.test(raw)) return 'zero à esquerda num identificador de pré-versão';
  if (/^\d+\.\d+\.\d+-$/.test(raw)) return 'pré-versão vazia depois do hífen';
  if (/\+$/.test(raw)) return 'metadado de build vazio depois do `+`';
  if (/\b0\d/.test(raw)) return 'zero à esquerda';
  return 'formato';
}

// Um identificador só de dígitos é comparado como número; qualquer outro, como
// texto. Guardar já convertido evita que a comparação tenha de adivinhar duas
// vezes, e deixa a diferença visível a quem inspeciona uma versão lida.
function readIdentifiers(raw: string | undefined): (string | number)[] {
  if (!raw) return [];
  return raw.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
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
  // `FULL_FORM` tem cinco grupos e `SHORT_FORM` tem quatro, então o tamanho do
  // resultado já diz qual das duas casou.
  const short = found.length === 5;
  const major = Number(found[1]);
  const minor = Number(found[2]);
  const patch = short ? 0 : Number(found[3]);
  const prerelease = readIdentifiers(short ? found[3] : found[4]);
  const build = (short ? found[4] : found[5]) ?? '';
  for (const value of [major, minor, patch]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > VERSION_LIMIT) return null;
  }
  const core = `${major}.${minor}.${patch}`;
  const text = `${core}${prerelease.length ? `-${prerelease.join('.')}` : ''}${build ? `+${build}` : ''}`;
  return {
    major, minor, patch, prerelease, build,
    isPrerelease: prerelease.length > 0,
    text,
    tag: `v${text}`,
    tuple: [major, minor, patch],
  };
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
    const candidate = input as Version;
    const tuple = candidate.tuple;
    if (Array.isArray(tuple) && tuple.length === 3 && tuple.every((field) => Number.isSafeInteger(field)) && Array.isArray(candidate.prerelease)) {
      return candidate;
    }
    throw new VersionError(input, 'objeto que não é uma versão lida');
  }
  return requireVersion(input);
}

// A ordem entre dois identificadores de pré-versão, na regra do SemVer:
// numérico vale menos que alfanumérico; numérico compara como número;
// alfanumérico compara como texto ASCII.
function compareIdentifiers(left: string | number, right: string | number): -1 | 0 | 1 {
  const leftNumeric = typeof left === 'number';
  const rightNumeric = typeof right === 'number';
  if (leftNumeric && rightNumeric) return left === right ? 0 : (left as number) > (right as number) ? 1 : -1;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : String(left) > String(right) ? 1 : -1;
}

/**
 * A ordem entre duas versões: `-1`, `0` ou `1`.
 *
 * **Lança `VersionError` para entrada malformada.** Devolver `0` diria "são a
 * mesma versão", e foi assim que uma entrada corrompida do catálogo já
 * convenceu um cliente de que ele estava em dia.
 *
 * O metadado de build é ignorado, por especificação: `1.0.0+a` e `1.0.0+b` são
 * a mesma versão, e tratá-los como diferentes faria o cliente reinstalar o que
 * já tem.
 */
export function compareVersions(left: unknown, right: unknown): -1 | 0 | 1 {
  const a = asVersion(left);
  const b = asVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.tuple[index] !== b.tuple[index]) return a.tuple[index] > b.tuple[index] ? 1 : -1;
  }
  // Uma versão final vem depois de qualquer pré-versão do mesmo número. É a
  // regra que inverte o sentido do `-N` em relação à convenção antiga.
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const limit = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    // Quem acabou primeiro vem antes: `1.0.0-alpha` < `1.0.0-alpha.1`.
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const ordem = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (ordem !== 0) return ordem;
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
 * `1.2.3` vira `1.2.3.0`. O quarto campo existe porque o formato do Windows o
 * exige, e é sempre zero: sob SemVer, duas versões publicáveis nunca têm o
 * mesmo `major.minor.patch`.
 *
 * **Uma pré-versão é recusada.** `1.2.3-rc.1` teria de virar um número *menor*
 * que `1.2.3.0`, e não existe número menor com quatro campos não negativos
 * terminando em zero. Produzir `1.2.3.0` para os dois faria o Windows tratar a
 * troca da rc pela final como reinstalação da mesma coisa — que é o defeito
 * que a numeração de quatro campos existe para evitar. Pré-versão de Windows
 * se distribui como portátil, ou não se distribui.
 */
export function windowsVersion(input: unknown): string {
  const { major, minor, patch, isPrerelease, text } = requireVersion(input);
  if (isPrerelease) {
    throw new VersionError(input, `uma pré-versão não tem número de Windows: ${text} não pode ser ordenada contra ${major}.${minor}.${patch} em quatro campos`);
  }
  return `${major}.${minor}.${patch}.0`;
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
