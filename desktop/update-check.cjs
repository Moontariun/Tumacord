// Que versão oferecer, e se há alguma.
//
// Este arquivo não fala com a rede nem toca em disco: ele recebe o catálogo e
// os manifestos **já verificados** — a assinatura é conferida antes, em
// `update-source.cjs` — e devolve uma decisão. Assim a parte que decide, a que
// erra em silêncio quando erra, pode ser provada inteira sem serviço e sem
// máquina de ninguém.
//
// A fonte mudou na 0.9.9-1: o que entra aqui são as entradas do catálogo
// assinado da distribuição privada, e não mais uma lista de Releases do
// GitHub. Com isso, a retirada de uma versão passou a morar **só** nesse
// catálogo. Antes ela era declarada por um comentário de HTML nas notas da
// Release — uma segunda autoridade sobre o que está retirado, e a segunda
// autoridade é sempre a que alguém consegue forjar.
//
// As regras que moram aqui:
//
//   1. só sobe. Uma versão mais antiga que a instalada nunca é oferecida, e
//      voltar atrás é operação de quem opera — não algo que um catálogo possa
//      provocar sozinho;
//   2. versão retirada não é oferecida, nem sendo a mais nova;
//   3. sem pacote para o jeito que esta cópia foi instalada, não há botão de
//      aplicar — e a diferença é dita, em vez de virar "não há atualização";
//   4. o que é pulado continua sendo listado, com o motivo. Silêncio faria a
//      pessoa concluir que o aplicativo parou de ver o que o painel mostra.

const {
  ineligibleReason,
  selectArtifact,
} = require('./distribution.generated.cjs');
const { compareVersions, parseVersion } = require('./version.generated.cjs');

// Versões que não devem ser instaladas por ninguém, com o motivo em português
// porque ele aparece na tela.
//
// A lista embutida resolve o passado: uma versão que já estava quebrada quando
// esta cópia foi compilada. O futuro é resolvido pelo catálogo assinado, que
// esta lista, por definição, não conhece.
const BROKEN_VERSIONS = new Map([
  ['0.8.9', 'as resoluções e o FPS da transmissão saem errados'],
]);

// Como esta cópia foi instalada. Cada jeito atualiza de um jeito, e chutar
// errado aqui significaria escrever no lugar errado da máquina de alguém.
const INSTALL_KINDS = ['linux-managed', 'linux-appimage', 'windows-installed', 'windows-portable', 'unknown'];

function brokenReason(version) {
  return BROKEN_VERSIONS.get(typeof version === 'string' ? version.replace(/^v/i, '') : '') ?? '';
}

/**
 * O caminho da instalação é o que decide o pacote e o modo de aplicar.
 *
 * `APPIMAGE` e `PORTABLE_EXECUTABLE_FILE` são postos pelos próprios formatos.
 * A instalação do `install-linux.sh` é reconhecida pelo lugar onde ela mora:
 * cada build fica em uma pasta imutável sob `versions/` e só o atalho
 * `current` é trocado. Nada disso é adivinhado a partir do sistema: uma cópia
 * que não caiu em nenhum dos casos vira `unknown`, e `unknown` não escreve
 * nada em lugar nenhum.
 */
function installKind({ platform, env = {}, resourcesPath = '', home = '' } = {}) {
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'windows-portable' : 'windows-installed';
  if (platform !== 'linux') return 'unknown';
  if (env.APPIMAGE) return 'linux-appimage';
  const dataHome = env.XDG_DATA_HOME || (home ? `${home}/.local/share` : '');
  if (dataHome && resourcesPath.startsWith(`${dataHome}/tumacord/versions/`)) return 'linux-managed';
  return 'unknown';
}

/** Os manifestos verificados, por release. */
function manifestMap(manifests) {
  const map = new Map();
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (manifest && typeof manifest.releaseId === 'string') map.set(manifest.releaseId, manifest);
  }
  return map;
}

/**
 * O texto que a tela mostra de uma versão.
 *
 * Ele vem do manifesto assinado e é exibido como texto puro: nada dele é
 * interpretado como HTML, porque é texto que atravessou a rede.
 */
function summarize(manifest) {
  return {
    title: String(manifest?.title ?? '').trim(),
    notes: String(manifest?.notes ?? '').replace(/\r\n/g, '\n').trim(),
  };
}

/**
 * As notas da versão que está instalada agora.
 *
 * É o que a tela de "o que mudou" mostra uma vez depois de cada atualização —
 * inclusive quando a atualização foi feita por fora, pelo script de instalação
 * ou trocando o arquivo à mão.
 */
function releaseFor(manifests, version) {
  const target = parseVersion(version);
  if (!target) return null;
  for (const manifest of manifestMap(manifests).values()) {
    const found = parseVersion(manifest.version);
    if (!found || compareVersions(found, target) !== 0) continue;
    const { title, notes } = summarize(manifest);
    if (!notes && !title) return null;
    return { version: found.text, title, notes, pageUrl: '', publishedAt: String(manifest.createdAt ?? '') };
  }
  return null;
}

/** O pacote, na forma que o download e a interface consomem. */
function assetFrom(manifest, artifact) {
  return {
    // A interface mostra estes dois.
    name: artifact.fileName,
    size: artifact.size,
    // O download pede por identificador, e não por URL: um documento assinado
    // que carregasse URL poderia mandar o aplicativo buscar binário noutro
    // domínio.
    releaseId: manifest.releaseId,
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    installKind: artifact.installKind,
    arch: artifact.arch,
    format: artifact.format,
  };
}

/**
 * A decisão, a partir do catálogo assinado.
 *
 * `catalog` e `manifests` já passaram pela verificação de assinatura e de
 * frescor. Aqui é só a escolha — e ela é pura, para poder ser provada.
 */
function chooseFromCatalog({
  catalog,
  manifests,
  currentVersion,
  kind = 'unknown',
  arch = 'x64',
  channel = 'stable',
} = {}) {
  const current = parseVersion(currentVersion);
  const byRelease = manifestMap(manifests);
  const base = {
    installed: current?.text ?? String(currentVersion ?? ''),
    installedBroken: current ? brokenReason(current.text) : '',
    installedRelease: releaseFor(manifests, currentVersion),
    kind,
    channel,
    skipped: [],
    latest: '',
    mustStop: null,
    pageUrl: '',
  };
  if (!current) return { ...base, status: 'unknown-version' };
  if (!catalog || typeof catalog !== 'object') return { ...base, status: 'no-catalog' };

  const entries = catalog.channels?.[channel]?.entries;
  if (!Array.isArray(entries) || !entries.length) return { ...base, status: 'up-to-date' };

  // A versão instalada pode ter sido retirada **depois** de instalada. Quem
  // está nela precisa saber — e é por isso que a retirada aparece mesmo quando
  // não há para onde ir.
  for (const entry of entries) {
    if (entry?.state !== 'withdrawn') continue;
    const version = parseVersion(entry.version);
    if (version && compareVersions(version, current) === 0) {
      base.installedBroken = entry.withdrawn?.reason || 'esta versão foi retirada';
    }
  }

  const skipped = [];
  let best = null;
  let stop = null;
  // A mais nova que **existe** e seria oferecida, se houvesse pacote para o
  // jeito que esta cópia foi instalada. Ela é guardada à parte para a tela
  // poder dizer "há uma versão nova, mas não há pacote para o seu formato" em
  // vez de "não há atualização" — que mandaria a pessoa procurar defeito no
  // lugar errado.
  let withoutArtifact = null;

  for (const entry of entries) {
    if (!entry || typeof entry.releaseId !== 'string') continue;
    const version = parseVersion(entry.version);
    if (!version) continue;

    const manifest = byRelease.get(entry.releaseId);
    const blocker = ineligibleReason({
      entry,
      manifest,
      currentVersion: current,
      installKind: kind,
      arch,
      knownBroken: BROKEN_VERSIONS,
    });

    if (blocker) {
      // "Não é mais nova" é o caso comum e não merece linha na tela: a lista
      // de puladas existe para explicar o que **deveria** aparecer e não
      // aparece.
      if (blocker.reason !== 'not-newer') skipped.push({ version: version.text, reason: blocker.detail });
      if (blocker.reason === 'no-artifact' && (!withoutArtifact || compareVersions(version, withoutArtifact.version) > 0)) {
        withoutArtifact = { version, entry, manifest };
      }
      continue;
    }

    if (!best || compareVersions(version, best.version) > 0) best = { version, entry, manifest };
    // Uma parada obrigatória entre onde esta cópia está e a mais nova precisa
    // vir primeiro: uma versão que converte dados só a partir do formato
    // imediatamente anterior fica sem entrada que saiba ler se for pulada.
    if (entry.requiredStop && (!stop || compareVersions(version, stop.version) < 0)) {
      stop = {
        version,
        entry,
        manifest,
        reason: entry.requiredStop.reason || 'esta versão precisa ser instalada antes das seguintes',
      };
    }
  }

  skipped.sort((left, right) => compareVersions(right.version, left.version));
  if (!best) {
    // Sem nada aplicável, mas com uma versão nova que só não tem pacote para
    // este formato: a diferença é dita, com a versão e as notas, e sem botão
    // de aplicar.
    if (withoutArtifact) {
      const { title, notes } = summarize(withoutArtifact.manifest);
      return {
        ...base,
        status: 'no-asset',
        version: withoutArtifact.version.text,
        title,
        notes,
        publishedAt: String(withoutArtifact.entry.publishedAt ?? withoutArtifact.manifest.createdAt ?? ''),
        asset: null,
        skipped,
      };
    }
    return { ...base, status: 'up-to-date', skipped };
  }

  const passFirst = stop && compareVersions(stop.version, best.version) < 0 ? stop : null;
  const target = passFirst ?? best;
  const artifact = selectArtifact(target.manifest, kind, arch);
  const { title, notes } = summarize(target.manifest);

  return {
    ...base,
    status: artifact ? 'available' : 'no-asset',
    version: target.version.text,
    title,
    notes,
    publishedAt: String(target.entry.publishedAt ?? target.manifest.createdAt ?? ''),
    asset: artifact ? assetFrom(target.manifest, artifact) : null,
    // A mais nova disponível, quando ela não é a oferecida agora.
    latest: passFirst ? best.version.text : '',
    mustStop: passFirst ? { version: passFirst.version.text, reason: passFirst.reason } : null,
    skipped,
  };
}

/**
 * Qual release precisa ter o manifesto buscado.
 *
 * O catálogo lista tudo; buscar o manifesto de cada entrada seria pedir dez
 * documentos para usar um. Aqui saem só as candidatas — a instalada, para as
 * notas de "o que mudou", e as que estão acima dela — na ordem da mais nova
 * para a mais antiga.
 */
function manifestsToFetch({ catalog, currentVersion, channel = 'stable', limit = 6, includeOlder = false } = {}) {
  const current = parseVersion(currentVersion);
  const entries = catalog?.channels?.[channel]?.entries;
  if (!Array.isArray(entries)) return [];
  const wanted = [];
  for (const entry of entries) {
    if (!entry || typeof entry.releaseId !== 'string' || entry.state !== 'published') continue;
    const version = parseVersion(entry.version);
    if (!version) continue;
    // A instalada entra pelas notas; as acima dela, porque podem ser a oferta.
    //
    // `includeOlder` traz também as abaixo, e existe para quem ligou "mostrar
    // versões antigas": sem o manifesto delas não há como saber se há pacote
    // para aquela máquina, e uma lista que oferece o que não dá para instalar
    // é pior do que não listar.
    if (!includeOlder && current && compareVersions(version, current) < 0) continue;
    wanted.push({ releaseId: entry.releaseId, version: version.text, manifestSha256: String(entry.manifestSha256 ?? '') });
  }
  wanted.sort((left, right) => compareVersions(right.version, left.version));
  // O teto sobe junto: com as antigas na conta, seis documentos não cobrem nem
  // um histórico curto.
  return wanted.slice(0, Math.max(1, includeOlder ? Math.max(limit, 24) : limit));
}

/**
 * Toda versão do catálogo, com o pacote que serve para esta máquina.
 *
 * É o que a lista de "versões antigas" mostra. Ela é derivada dos manifestos já
 * buscados — nada de rede a mais — e diz, por versão, se há arquivo para o jeito
 * que esta cópia foi instalada. Uma versão sem pacote aparece assim mesmo, e
 * desabilitada: some-la faria a pessoa procurar o que ela está vendo na
 * página de versões e não achar aqui.
 */
function versionsFromCatalog({ catalog, manifests, currentVersion, kind = 'unknown', arch = 'x64', channel = 'stable' } = {}) {
  const entries = catalog?.channels?.[channel]?.entries;
  if (!Array.isArray(entries)) return [];
  const porRelease = new Map();
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (manifest?.releaseId) porRelease.set(manifest.releaseId, manifest);
  }
  const current = parseVersion(currentVersion);
  const lista = [];
  for (const entry of entries) {
    const version = parseVersion(entry?.version);
    if (!version || entry.state !== 'published') continue;
    const manifest = porRelease.get(entry.releaseId);
    const artifact = manifest ? selectArtifact(manifest, kind, arch) : null;
    lista.push({
      version: version.text,
      releaseId: entry.releaseId,
      publishedAt: String(entry.publishedAt ?? ''),
      installed: Boolean(current) && compareVersions(version, current) === 0,
      older: Boolean(current) && compareVersions(version, current) < 0,
      size: artifact?.size ?? 0,
      // Sem manifesto buscado não dá para afirmar que há pacote; dizer que não
      // há seria mentir para quem só não pediu as antigas ainda.
      canApply: Boolean(artifact),
      unknownArtifact: !manifest,
    });
  }
  lista.sort((left, right) => compareVersions(right.version, left.version));
  return lista;
}

module.exports = {
  BROKEN_VERSIONS,
  versionsFromCatalog,
  INSTALL_KINDS,
  assetFrom,
  brokenReason,
  chooseFromCatalog,
  compareVersions,
  installKind,
  manifestsToFetch,
  parseVersion,
  releaseFor,
  summarize,
};
