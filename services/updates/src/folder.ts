// O catálogo a partir de uma pasta.
//
// ## O que isto substitui, e por quê
//
// Até a 0.12.2 publicar uma versão era: compilar, assinar um manifesto, assinar
// um catálogo, mandar os bytes, importar e promover. Seis passos, e todos eles
// na máquina de quem publica. Funciona, e é seguro — mas para um grupo de
// amigos é trabalho demais para "saiu versão nova".
//
// Aqui o serviço **olha a pasta**. Os arquivos que estiverem em
// `<armazenamento>/linux/` e `<armazenamento>/windows/` viram versões
// oferecidas, sem ninguém importar nem promover nada. Largar o arquivo por FTP
// ou `wget` é a publicação inteira.
//
// O caminho antigo continua existindo: um catálogo importado pelo
// `tumacordctl` tem precedência sobre o que a pasta diz. Quem quiser assinar
// fora da máquina continua podendo.
//
// ## A convenção de nomes
//
// Não há convenção nova: são exatamente os nomes que o `electron-builder`
// já produz.
//
//     linux/tumacord-0.13.0.tar.gz            instalação pelo script
//     linux/Tumacord-0.13.0.AppImage          AppImage
//     windows/Tumacord-0.13.0-Setup.exe       instalador
//     windows/Tumacord-0.13.0-portable.exe    portátil
//
// O que decide a versão é o **nome do arquivo**, e nada mais. Um arquivo com
// nome fora do padrão é ignorado e dito no log — em vez de virar uma versão
// com número errado, que é pior do que não aparecer.
//
// ## O que isto custa
//
// A chave que assina passa a viver **nesta máquina**, porque é ela que publica
// agora. Quem entrar no servidor passa a poder entregar um binário como
// oficial. Antes isso exigia a chave, que estava fora; agora exige o servidor.
//
// É uma troca deliberada e vale dizer o que ela NÃO muda: a assinatura continua
// protegendo o caminho entre o servidor e o aplicativo — um proxy trocado, um
// espelho, um DNS sequestrado. O que ela deixou de proteger é o próprio
// servidor contra si mesmo.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONTRACT_VERSION, type Catalog, type ReleaseManifest, type Artifact } from '../../../shared/distribution.js';
import { compareVersions, parseVersion } from '../../../shared/version.js';

/** Quanto tempo um catálogo gerado vale. Curto: ele é refeito a cada varredura. */
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * O que cada pasta contém, e como o nome de cada arquivo é lido.
 *
 * `capture` tira a versão do nome. As formas são as do `electron-builder`, e a
 * pasta faz parte da regra: um `.exe` em `linux/` não é um pacote de Linux
 * fora do lugar, é um engano — e um engano é dito, não adivinhado.
 */
const SHAPES = [
  { folder: 'linux', installKind: 'linux-managed', os: 'linux', arch: 'x64', format: 'tar.gz', capture: /^tumacord-(.+)\.tar\.gz$/ },
  { folder: 'linux', installKind: 'linux-appimage', os: 'linux', arch: 'x64', format: 'AppImage', capture: /^Tumacord-(.+)\.AppImage$/ },
  { folder: 'windows', installKind: 'windows-installed', os: 'windows', arch: 'x64', format: 'exe', capture: /^Tumacord-(.+)-Setup\.exe$/ },
  { folder: 'windows', installKind: 'windows-portable', os: 'windows', arch: 'x64', format: 'exe', capture: /^Tumacord-(.+)-portable\.exe$/ },
] as const;

export const FOLDERS = ['linux', 'windows'] as const;

export interface ScannedFile {
  version: string;
  installKind: string;
  os: string;
  arch: string;
  format: string;
  fileName: string;
  storagePath: string;
  size: number;
  sha256: string;
}

export interface ScanResult {
  files: ScannedFile[];
  /** Arquivos que não casaram com nenhuma forma, para o log dizer o motivo. */
  ignored: { file: string; reason: string }[];
}

/**
 * O resumo de um arquivo, guardado entre varreduras.
 *
 * Calcular SHA-256 de 120 MB a cada varredura torraria o disco à toa: os
 * pacotes não mudam depois de largados. A chave inclui tamanho e data de
 * modificação, então um arquivo trocado no lugar é recalculado.
 */
const digestCache = new Map<string, string>();

async function sha256Of(filePath: string, size: number, modifiedAt: number): Promise<string> {
  const key = `${filePath}:${size}:${modifiedAt}`;
  const cached = digestCache.get(key);
  if (cached) return cached;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  const digest = hash.digest('hex');
  // O cache é por arquivo, e some com o arquivo: sem o teto, uma pasta com
  // centenas de versões antigas manteria todas na memória para sempre.
  if (digestCache.size > 512) digestCache.clear();
  digestCache.set(key, digest);
  return digest;
}

/** Varre as pastas e devolve o que encontrou. Não decide nada. */
export async function scanFolders(root: string): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const ignored: { file: string; reason: string }[] = [];

  for (const folder of FOLDERS) {
    const directory = path.join(root, folder);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      // A pasta não existir é normal: um grupo que só usa Linux nunca cria
      // `windows/`.
      continue;
    }
    for (const entry of entries) {
      const shape = SHAPES.find((candidate) => candidate.folder === folder && candidate.capture.test(entry));
      if (!shape) {
        if (!entry.startsWith('.')) ignored.push({ file: `${folder}/${entry}`, reason: 'nome fora da convenção' });
        continue;
      }
      const bruto = shape.capture.exec(entry)?.[1] ?? '';
      const version = parseVersion(bruto)?.text ?? '';
      if (!version) {
        ignored.push({ file: `${folder}/${entry}`, reason: `"${bruto}" não é uma versão` });
        continue;
      }
      const filePath = path.join(directory, entry);
      let info;
      try {
        info = await stat(filePath);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size === 0) {
        ignored.push({ file: `${folder}/${entry}`, reason: 'vazio ou não é arquivo' });
        continue;
      }
      files.push({
        version,
        installKind: shape.installKind,
        os: shape.os,
        arch: shape.arch,
        format: shape.format,
        fileName: entry,
        storagePath: `${folder}/${entry}`,
        size: info.size,
        sha256: await sha256Of(filePath, info.size, info.mtimeMs),
      });
    }
  }

  return { files, ignored };
}

function releaseIdOf(version: string): string {
  return `rel_stable_${version.replace(/[^0-9A-Za-z]/g, '-')}`;
}

/**
 * Os manifestos, um por versão encontrada.
 *
 * Dois arquivos para o mesmo alvo na mesma versão **param aquela versão**, e
 * só ela: escolher entre eles seria adivinhar, e o erro apareceria na máquina
 * de quem instalou. As outras versões continuam sendo oferecidas.
 */
export function manifestsFrom(scan: ScanResult, keyId: string, now = Date.now()): { manifests: ReleaseManifest[]; conflicts: { version: string; installKind: string; files: string[] }[] } {
  const porVersao = new Map<string, ScannedFile[]>();
  for (const file of scan.files) {
    porVersao.set(file.version, [...(porVersao.get(file.version) ?? []), file]);
  }

  const manifests: ReleaseManifest[] = [];
  const conflicts: { version: string; installKind: string; files: string[] }[] = [];

  for (const [version, encontrados] of porVersao) {
    const artifacts: Artifact[] = [];
    let ambiguo = false;
    for (const shape of SHAPES) {
      const doAlvo = encontrados.filter((file) => file.installKind === shape.installKind);
      if (!doAlvo.length) continue;
      if (doAlvo.length > 1) {
        conflicts.push({ version, installKind: shape.installKind, files: doAlvo.map((file) => file.fileName).sort() });
        ambiguo = true;
        continue;
      }
      const file = doAlvo[0];
      artifacts.push({
        artifactId: `${file.installKind}-${file.arch}`,
        os: file.os as Artifact['os'],
        arch: file.arch as Artifact['arch'],
        format: file.format as Artifact['format'],
        installKind: file.installKind as Artifact['installKind'],
        fileName: file.fileName,
        size: file.size,
        sha256: file.sha256,
        signatureKeyId: keyId,
        storagePath: file.storagePath,
      });
    }
    if (ambiguo || !artifacts.length) continue;
    manifests.push({
      contract: CONTRACT_VERSION,
      releaseId: releaseIdOf(version),
      version,
      channel: 'stable',
      // Não há commit: esta versão veio de um arquivo largado numa pasta, e
      // inventar um seria pior do que dizer que não se sabe.
      commit: '',
      createdAt: new Date(now).toISOString(),
      artifacts,
    } as ReleaseManifest);
  }

  manifests.sort((left, right) => compareVersions(right.version, left.version));
  return { manifests, conflicts };
}

/**
 * O catálogo que descreve o que a pasta tem.
 *
 * **Todas** as versões entram, e não só a mais nova: é o que permite o
 * aplicativo oferecer uma versão antiga a quem pedir. Quem decide o que fazer
 * com a lista é o cliente — o catálogo só diz o que existe.
 *
 * A sequência não é o número de versões: ela precisa crescer a cada mudança e
 * nunca voltar, senão o cliente recusa o catálogo por retrocesso. Ela vem de
 * quem chama, que a guarda no estado.
 */
export function catalogFrom(manifests: ReleaseManifest[], digestOf: (manifest: ReleaseManifest) => string, sequence: number, now = Date.now()): Catalog {
  return {
    contract: CONTRACT_VERSION,
    sequence,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CATALOG_TTL_MS).toISOString(),
    channels: {
      stable: {
        entries: manifests.map((manifest) => ({
          releaseId: manifest.releaseId,
          version: manifest.version,
          state: 'published' as const,
          publishedAt: manifest.createdAt,
          manifestSha256: digestOf(manifest),
        })),
      },
      test: { entries: [] },
    },
  };
}

/**
 * Se duas varreduras encontraram a mesma coisa.
 *
 * Republicar um catálogo idêntico a cada minuto faria a sequência crescer sem
 * parar e obrigaria todo cliente a rebaixar o que já tinha aceitado. A
 * comparação é sobre o conteúdo, e não sobre a hora em que a varredura rodou.
 *
 * **O caminho entra na conta.** Ele não entrava, e isso quebrou uma instalação
 * de verdade: os pacotes foram movidos de `releases/<versão>/` para `linux/`
 * com o mesmo resumo, a comparação disse "nada mudou", e o catálogo continuou
 * apontando para caminhos que não existiam mais. O download passou a responder
 * 404 sem nenhum log de erro — porque, do ponto de vista do serviço, nada tinha
 * acontecido.
 *
 * A lição, escrita aqui para não se perder: o que o catálogo PROMETE faz parte
 * do conteúdo. Se um campo aparece no documento assinado, ele precisa aparecer
 * na comparação que decide se o documento mudou.
 */
export function sameContent(left: ReleaseManifest[], right: ReleaseManifest[]): boolean {
  const resumo = (manifests: ReleaseManifest[]) => manifests
    .map((manifest) => {
      const artefatos = manifest.artifacts
        .map((artifact) => `${artifact.artifactId}=${artifact.sha256}@${artifact.storagePath}:${artifact.fileName}:${artifact.size}`)
        .sort()
        .join(',');
      return `${manifest.version}:${artefatos}`;
    })
    .sort()
    .join('|');
  return resumo(left) === resumo(right);
}
