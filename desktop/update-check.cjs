// Que versão oferecer, e se há alguma.
//
// Este arquivo não fala com a rede nem toca em disco: ele recebe a lista de
// Releases já baixada e devolve uma decisão. Assim a parte que decide — a que
// erra em silêncio quando erra — pode ser testada inteira, sem GitHub e sem
// máquina de ninguém.
//
// Três regras moram aqui:
//   1. só sobe. Uma Release mais antiga que a instalada nunca é oferecida;
//   2. versão marcada como quebrada não é oferecida, nem que seja a mais nova;
//   3. sem arquivo para o jeito que esta cópia foi instalada, não há botão de
//      aplicar — há um link para a página da Release, e a diferença é dita.

// Versões que não devem ser instaladas por ninguém, com o motivo em português
// porque ele aparece na tela.
//
// A lista embutida resolve o passado: uma versão que já estava quebrada quando
// esta cópia foi compilada. O futuro é resolvido pelo marcador no corpo da
// Release (abaixo), que continua valendo para versões lançadas depois desta —
// a lista embutida, por definição, não as conhece.
const BROKEN_VERSIONS = new Map([
  ['0.8.9', 'as resoluções e o FPS da transmissão saem errados'],
]);

// Marcador invisível no texto da Release. As notas de cada Release saem do
// CHANGELOG, então marcar a versão como quebrada no CHANGELOG e republicar as
// notas é o que faz todo aplicativo instalado parar de oferecê-la. Um
// comentário de HTML não aparece no Markdown renderizado: quem lê a página vê
// o aviso escrito por extenso, e o aplicativo vê a marca.
const BROKEN_MARKER = /<!--\s*tumacord:versao-quebrada\s*-->/i;

// Paradas obrigatórias.
//
// Pular versões é o normal e é o que se quer: quem está na 0.9.1 e encontra a
// 0.9.9 instala a 0.9.9 direto, sem passar por sete instalações no caminho.
//
// Às vezes não dá. Uma versão que converte dados só a partir do formato
// imediatamente anterior é o caso clássico: pular por cima dela deixaria a
// conversão sem entrada que ela saiba ler. Essa versão se declara uma parada
// obrigatória, e quem está abaixo dela passa por ela antes de seguir.
//
// A declaração é a mesma mecânica da versão quebrada: um marcador no corpo da
// Release, que sai do CHANGELOG. Ele não aparece na página renderizada, e vale
// para versões lançadas depois desta — a lista embutida, por definição, não
// conhece o futuro.
const REQUIRED_STOPS = new Map([]);
const REQUIRED_MARKER = /<!--\s*tumacord:parada-obrigatoria\s*-->/i;

// Como esta cópia foi instalada. Cada jeito atualiza de um jeito, e chutar
// errado aqui significaria escrever no lugar errado da máquina de alguém.
const INSTALL_KINDS = ['linux-managed', 'linux-appimage', 'windows-installed', 'windows-portable', 'unknown'];

// A política de versão do produto vem de `shared/version.ts`, pela adaptação
// gerada — é a mesma implementação que o servidor, o publicador e os scripts
// usam. Até a 0.9.9 esta cópia era escrita à mão aqui, e ela divergia: lia
// `0.9.9-1` como pré-versão e a punha *abaixo* da 0.9.9, de modo que quem
// estava na 0.9.9 nunca era oferecido a correção dela.
//
// `compareVersions` **lança** para entrada malformada. Quem chama já filtra
// com `parseVersion` antes; a exceção existe para que uma entrada corrompida
// não seja lida como "é a mesma versão, está tudo em dia".
const { compareVersions, parseVersion } = require('./version.generated.cjs');

function requiredStopReason(version, body) {
  const known = REQUIRED_STOPS.get(typeof version === 'string' ? version.replace(/^v/i, '') : '');
  if (known) return known;
  if (typeof body === 'string' && REQUIRED_MARKER.test(body)) return 'esta versão precisa ser instalada antes das seguintes';
  return '';
}

function brokenReason(version, body) {
  const known = BROKEN_VERSIONS.get(typeof version === 'string' ? version.replace(/^v/i, '') : '');
  if (known) return known;
  if (typeof body === 'string' && BROKEN_MARKER.test(body)) return 'a própria versão se declara quebrada nas notas de lançamento';
  return '';
}

// O caminho da instalação é o que decide o arquivo e o modo de aplicar.
//
// `APPIMAGE` e `PORTABLE_EXECUTABLE_FILE` são postos pelos próprios formatos.
// A instalação do `install-linux.sh` é reconhecida pelo lugar onde ela mora:
// cada build fica em uma pasta imutável sob `versions/` e só o atalho
// `current` é trocado. Nada disso é adivinhado a partir do sistema: uma cópia
// que não caiu em nenhum dos casos vira `unknown`, e `unknown` não escreve
// nada em lugar nenhum.
function installKind({ platform, env = {}, resourcesPath = '', home = '' } = {}) {
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'windows-portable' : 'windows-installed';
  if (platform !== 'linux') return 'unknown';
  if (env.APPIMAGE) return 'linux-appimage';
  const dataHome = env.XDG_DATA_HOME || (home ? `${home}/.local/share` : '');
  if (dataHome && resourcesPath.startsWith(`${dataHome}/tumacord/versions/`)) return 'linux-managed';
  return 'unknown';
}

// Qual arquivo da Release serve para este jeito de instalação. O nome do
// arquivo é dado pelo `electron-builder` e está fixado no `package.json`
// (`artifactName`), mas a busca é por forma, não por nome exato: uma build que
// ganhe sufixo de arquitetura continua sendo reconhecida.
const ASSET_PATTERNS = {
  'linux-managed': /^tumacord-.*\.tar\.gz$/i,
  'linux-appimage': /\.AppImage$/i,
  'windows-installed': /-Setup\.exe$/i,
  'windows-portable': /-portable\.exe$/i,
  unknown: null,
};

function assetFor(kind, assets, version) {
  const pattern = ASSET_PATTERNS[kind];
  if (!pattern) return null;
  const candidates = (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset && typeof asset.name === 'string' && pattern.test(asset.name))
    // Um arquivo ainda sendo enviado pelo CI aparece na API antes de existir
    // por inteiro. Baixá-lo daria um download truncado com cara de corrupção.
    .filter((asset) => !asset.state || asset.state === 'uploaded');
  if (!candidates.length) return null;
  const exact = version ? candidates.find((asset) => asset.name.includes(version)) : null;
  const chosen = exact ?? candidates[0];
  return {
    name: chosen.name,
    url: typeof chosen.browser_download_url === 'string' ? chosen.browser_download_url : '',
    size: Number.isFinite(chosen.size) ? Number(chosen.size) : 0,
    // A API entrega o resumo no formato `sha256:<hex>` quando o tem. Ele não
    // protege contra o GitHub — vem do mesmo lugar que o arquivo —, mas pega
    // download truncado e arquivo trocado no caminho, que é o que acontece.
    digest: typeof chosen.digest === 'string' ? chosen.digest : '',
  };
}

// O título da Release já resume a versão ("Tumacord 0.8.10 — …"). O corpo é
// Markdown do CHANGELOG e é mostrado como texto puro na interface: nada dele é
// interpretado como HTML, porque é texto que veio da rede.
function summarize(release) {
  const title = typeof release?.name === 'string' && release.name.trim() ? release.name.trim() : '';
  const body = typeof release?.body === 'string' ? release.body : '';
  const notes = body
    // Os comentários saem — eles são recado para quem escreve o CHANGELOG e
    // apareceriam como texto cru na tela. Os do resumo ficam: é por eles que a
    // interface sabe qual pedaço mostrar para quem só quer saber o que mudou.
    // Sem esta exceção o marcador sumia aqui e o aplicativo caía no texto
    // inteiro, que é justamente o que ele deixou de mostrar.
    .replace(/<!--(?!\s*\/?\s*tumacord:resumo\s*-->)[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return { title, notes };
}

// As notas da versão que está instalada agora.
//
// É o que a tela de "o que mudou" mostra uma vez depois de cada atualização —
// e ela mostra exatamente o que está na página de Releases do GitHub, que é
// onde o CHANGELOG desta versão foi publicado. Nada é reescrito aqui: quem
// leu a página e quem leu a tela leram a mesma coisa.
function releaseFor(releases, version) {
  const alvo = parseVersion(version);
  if (!alvo) return null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue;
    const encontrada = parseVersion(release.tag_name ?? release.name);
    if (!encontrada || compareVersions(encontrada, alvo) !== 0) continue;
    const { title, notes } = summarize(release);
    if (!notes && !title) return null;
    return {
      version: encontrada.text,
      title,
      notes,
      pageUrl: typeof release.html_url === 'string' ? release.html_url : '',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    };
  }
  return null;
}

function chooseUpdate({ releases, currentVersion, kind = 'unknown', allowPrerelease = false } = {}) {
  const current = parseVersion(currentVersion);
  const currentBroken = current ? brokenReason(current.text, '') : '';
  const base = {
    installed: current?.text ?? String(currentVersion ?? ''),
    installedBroken: currentBroken,
    installedRelease: releaseFor(releases, currentVersion),
    kind,
    skipped: [],
  };
  if (!current) return { ...base, status: 'unknown-version' };

  const skipped = [];
  let best = null;
  // A parada obrigatória mais próxima acima da versão instalada. Se houver uma
  // entre onde esta cópia está e a mais nova, é por ela que se passa primeiro.
  let stop = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue;
    const version = parseVersion(release.tag_name ?? release.name);
    if (!version) continue;
    if (compareVersions(version, current) <= 0) continue;
    if (release.prerelease && !allowPrerelease) continue;
    const reason = brokenReason(version.text, release.body);
    if (reason) {
      skipped.push({ version: version.text, reason });
      continue;
    }
    if (!best || compareVersions(version, best.version) > 0) best = { version, release };
    const parada = requiredStopReason(version.text, release.body);
    if (parada && (!stop || compareVersions(version, stop.version) < 0)) stop = { version, release, reason: parada };
  }

  // Uma versão pulada por estar quebrada continua sendo dita: é assim que
  // alguém entende por que a página do GitHub mostra 0.8.9 e o aplicativo
  // oferece outra coisa — ou coisa nenhuma.
  skipped.sort((left, right) => compareVersions(right.version, left.version));
  if (!best) return { ...base, status: 'up-to-date', skipped };

  // Por padrão, a mais nova. Com uma parada obrigatória no caminho, ela vem
  // primeiro — e a mais nova continua sendo dita, para ninguém achar que o
  // aplicativo deixou de ver o que a página do GitHub mostra.
  const passaAntes = stop && compareVersions(stop.version, best.version) < 0 ? stop : null;
  const alvo = passaAntes ?? best;
  const asset = assetFor(kind, alvo.release.assets, alvo.version.text);
  const { title, notes } = summarize(alvo.release);
  return {
    ...base,
    status: asset ? 'available' : 'no-asset',
    version: alvo.version.text,
    title,
    notes,
    publishedAt: typeof alvo.release.published_at === 'string' ? alvo.release.published_at : '',
    pageUrl: typeof alvo.release.html_url === 'string' ? alvo.release.html_url : '',
    asset,
    // A mais nova disponível, quando ela não é a oferecida agora.
    latest: passaAntes ? best.version.text : '',
    mustStop: passaAntes ? { version: passaAntes.version.text, reason: passaAntes.reason } : null,
    skipped,
  };
}

module.exports = {
  BROKEN_MARKER,
  BROKEN_VERSIONS,
  REQUIRED_MARKER,
  REQUIRED_STOPS,
  INSTALL_KINDS,
  assetFor,
  brokenReason,
  releaseFor,
  chooseUpdate,
  compareVersions,
  installKind,
  parseVersion,
};
