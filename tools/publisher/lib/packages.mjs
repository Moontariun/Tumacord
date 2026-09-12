// Reconhecer os pacotes de uma release, a partir de uma pasta de build.
//
// ## A regra que este arquivo existe para impor
//
// **Nada de "o primeiro arquivo com nome parecido".** Cada jeito de instalar
// tem um padrão exato, e um arquivo que case com mais de um — ou dois arquivos
// que casem com o mesmo — **param a publicação**. Escolher entre eles seria
// adivinhar, e o erro só apareceria na máquina de quem instalou: um instalador
// do Windows entregue a uma cópia de Linux, ou um NSIS entregue a um portable.
//
// Os nomes vêm do `artifactName` do `package.json`, que é onde o
// electron-builder os fixa. Se eles mudarem lá, mudam aqui — e o teste que
// confere os dois lados reprova antes de a release sair.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * O que cada jeito de instalar espera encontrar.
 *
 * O padrão inclui a versão de propósito: uma pasta de build que ainda tenha o
 * pacote da versão anterior não pode contribuir com ele para esta release.
 */
export function patternsFor(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    { installKind: 'linux-managed', os: 'linux', arch: 'x64', format: 'tar.gz', pattern: new RegExp(`^tumacord-${escaped}\\.tar\\.gz$`) },
    { installKind: 'linux-appimage', os: 'linux', arch: 'x64', format: 'AppImage', pattern: new RegExp(`^Tumacord-${escaped}\\.AppImage$`) },
    { installKind: 'windows-installed', os: 'windows', arch: 'x64', format: 'exe', pattern: new RegExp(`^Tumacord-${escaped}-Setup\\.exe$`) },
    { installKind: 'windows-portable', os: 'windows', arch: 'x64', format: 'exe', pattern: new RegExp(`^Tumacord-${escaped}-portable\\.exe$`) },
  ];
}

export async function sha256OfFile(filePath) {
  // Lido em pedaços: um AppImage tem mais de cem megabytes, e carregá-lo
  // inteiro na memória para calcular um resumo é desperdício que cresce com o
  // tamanho da release.
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Qual arquivo serve para cada jeito de instalar, a partir de uma lista de
 * nomes.
 *
 * Separado de `scanPackages` para a regra poder ser provada sem disco — e
 * porque é aqui que mora a decisão que mais evita estrago. Os padrões de hoje
 * são exatos, então dois nomes não casam com o mesmo alvo; se algum dia um
 * deles ganhar um sufixo de arquitetura, essa garantia some, e a recusa por
 * ambiguidade é o que impede a escolha de virar sorteio.
 */
export function matchArtifacts(names, version) {
  const chosen = [];
  const missing = [];
  const ambiguous = [];
  for (const spec of patternsFor(version)) {
    const matches = names.filter((name) => spec.pattern.test(name));
    if (!matches.length) { missing.push(spec.installKind); continue; }
    if (matches.length > 1) {
      // Dois arquivos para o mesmo alvo. Escolher um seria adivinhar qual, e o
      // erro apareceria na máquina de quem instalou.
      ambiguous.push({ installKind: spec.installKind, files: matches.slice().sort() });
      continue;
    }
    chosen.push({ spec, fileName: matches[0] });
  }
  return { chosen, missing, ambiguous };
}

/**
 * Os pacotes encontrados numa pasta, para uma versão.
 *
 * Devolve `{ artifacts, missing, ambiguous }`. Quem chama decide o que fazer
 * com cada um — mas `ambiguous` nunca vira escolha automática.
 */
export async function scanPackages(directory, version) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new Error(`Não consegui ler a pasta de pacotes ${directory}: ${error?.message ?? error}`);
  }

  const { chosen, missing, ambiguous } = matchArtifacts(names, version);
  const artifacts = [];

  for (const { spec, fileName } of chosen) {
    const filePath = path.join(directory, fileName);
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) {
      ambiguous.push({ installKind: spec.installKind, files: [fileName], reason: 'arquivo vazio ou não é arquivo' });
      continue;
    }
    artifacts.push({
      artifactId: `${spec.installKind}-${spec.arch}`,
      os: spec.os,
      arch: spec.arch,
      format: spec.format,
      installKind: spec.installKind,
      fileName,
      size: info.size,
      sha256: await sha256OfFile(filePath),
      // Preenchido por quem assina: o manifesto declara qual chave o descreve.
      signatureKeyId: '',
      // Relativo ao armazenamento privado, e nunca uma URL.
      storagePath: `releases/${version}/${fileName}`,
      // Só para o publicador copiar os bytes; não entra no manifesto.
      sourcePath: filePath,
    });
  }

  return { artifacts, missing, ambiguous };
}

/** O manifesto, sem a assinatura. `sourcePath` fica de fora. */
export function buildManifest({ version, commit, channel, artifacts, title, notes, compatibility, requiredStop, createdAt, keyId, contract }) {
  return {
    contract,
    releaseId: `rel_${channel}_${version.replace(/[^0-9A-Za-z]/g, '-')}`,
    version,
    channel,
    commit,
    createdAt: createdAt ?? new Date().toISOString(),
    ...(title ? { title } : {}),
    ...(notes ? { notes } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(requiredStop ? { requiredStop } : {}),
    artifacts: artifacts.map(({ sourcePath: _ignored, ...artifact }) => ({ ...artifact, signatureKeyId: keyId })),
  };
}

/**
 * As notas de uma versão, tiradas do CHANGELOG.
 *
 * O mesmo recorte que o CI usa ao publicar: a seção da versão, até a próxima.
 * Nada é reescrito — quem lê o CHANGELOG e quem lê a tela leem a mesma coisa.
 */
export async function notesFromChangelog(changelogPath, version) {
  let text;
  try {
    text = await readFile(changelogPath, 'utf8');
  } catch {
    return { title: '', notes: '' };
  }
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line.trim() === `## ${version}`);
  if (start < 0) return { title: '', notes: '' };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  return {
    title: `Tumacord ${lines[start].replace(/^##\s*/, '').trim()}`,
    // Os comentários saem: eles são recado para quem escreve o CHANGELOG e
    // apareceriam como texto cru na tela.
    notes: body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').trim(),
  };
}
