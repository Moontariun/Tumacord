// Publicar o que está na pasta, sem ninguém pedir.
//
// Este módulo é a metade que **decide e assina**; `folder.ts` é a que olha o
// disco. Separados porque a parte que decide pode ser testada inteira sem
// chave, sem disco e sem relógio, e é ela que erra em silêncio quando erra.
//
// ## A chave mora aqui, e isso é uma escolha
//
// Até a 0.12.2 a chave privada vivia fora do servidor, e invadir a VPS não
// permitia entregar um binário como oficial. Com a publicação automática ela
// precisa estar na máquina que publica — não existe desvio: ou alguém assina
// no momento de largar o arquivo, ou quem assina é o servidor.
//
// O que a assinatura ainda protege: o caminho entre o servidor e o aplicativo.
// Um proxy trocado, um espelho, um DNS sequestrado continuam sem conseguir
// entregar nada. O que ela deixou de proteger é o servidor contra si mesmo.
//
// ## Quando republica, e quando não
//
// Só quando o conteúdo muda. Uma varredura que encontra o mesmo de antes não
// gasta sequência: republicar a cada minuto faria o número crescer sem parar,
// e cada cliente rebaixaria o que já tinha aceitado sem nada ter acontecido.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog, ReleaseManifest, Signed } from '../../../shared/distribution.js';
import { documentDigest, signDocument, type KeyPair } from '../../../shared/distributionCrypto.js';
import { catalogFrom, manifestsFrom, sameContent, scanFolders } from './folder.js';

export interface SigningKeys {
  manifest: KeyPair;
  catalog: KeyPair;
}

/**
 * As chaves de assinatura, do disco.
 *
 * Os arquivos são os mesmos que o `publish.mjs keys generate` produz, para a
 * pasta de publicação de quem já tinha uma poder ser copiada tal como está —
 * os aplicativos instalados confiam nessas chaves, e trocá-las obrigaria todo
 * mundo a atualizar antes de conseguir atualizar.
 *
 * Devolve `null` quando não há chave. Isso não é erro: um serviço sem chave
 * simplesmente não publica sozinho, e continua servindo o catálogo que foi
 * importado de fora.
 */
export async function loadSigningKeys(directory: string): Promise<SigningKeys | null> {
  if (!directory) return null;
  try {
    const [manifest, catalog] = await Promise.all([
      readFile(path.join(directory, 'manifest.json'), 'utf8').then((raw) => JSON.parse(raw) as KeyPair),
      readFile(path.join(directory, 'catalog.json'), 'utf8').then((raw) => JSON.parse(raw) as KeyPair),
    ]);
    for (const [nome, chave] of [['manifest', manifest], ['catalog', catalog]] as const) {
      if (!chave?.keyId || !chave?.privateKey || !chave?.publicKey || !chave?.algorithm) {
        throw new Error(`a chave de ${nome} está incompleta`);
      }
    }
    return { manifest, catalog };
  } catch (causa) {
    const código = (causa as NodeJS.ErrnoException)?.code;
    // Não existir é o caso normal de quem não usa publicação automática.
    if (código === 'ENOENT') return null;
    throw causa;
  }
}

export interface PublishOutcome {
  /** `true` quando o catálogo mudou e precisa ser gravado. */
  changed: boolean;
  sequence: number;
  catalog: Signed<Catalog> | null;
  manifests: Record<string, Signed<ReleaseManifest>>;
  versions: string[];
  ignored: { file: string; reason: string }[];
  conflicts: { version: string; installKind: string; files: string[] }[];
}

/**
 * Varre a pasta e produz o catálogo assinado, se algo mudou.
 *
 * `currentSequence` e `currentManifests` vêm do estado. A sequência só cresce —
 * um catálogo com número menor do que o último que o cliente aceitou é
 * recusado por ele, e com razão: é assim que um servidor que voltou no tempo
 * reofereceria uma versão que o grupo já deixou para trás.
 */
export async function publishFromFolder(options: {
  storageDir: string;
  keys: SigningKeys;
  currentSequence: number;
  currentManifests: Record<string, Signed<ReleaseManifest>>;
  now?: number;
}): Promise<PublishOutcome> {
  const { storageDir, keys, currentSequence, currentManifests, now = Date.now() } = options;
  const scan = await scanFolders(storageDir);
  const { manifests, conflicts } = manifestsFrom(scan, keys.manifest.keyId, now);

  const anteriores = Object.values(currentManifests).map((assinado) => assinado.payload);
  // A comparação é sobre conteúdo. Sem ela, cada varredura produziria um
  // `createdAt` novo e o catálogo pareceria diferente a cada minuto.
  const igual = sameContent(anteriores, manifests);

  const assinados: Record<string, Signed<ReleaseManifest>> = {};
  for (const manifest of manifests) {
    // Um manifesto que não mudou é reaproveitado com a assinatura que já
    // tinha: reassinar produziria bytes diferentes para o mesmo conteúdo, e o
    // resumo que o catálogo promete deixaria de casar com o que o cliente
    // guardou.
    const existente = currentManifests[manifest.releaseId];
    assinados[manifest.releaseId] = existente && sameContent([existente.payload], [manifest])
      ? existente
      : signDocument(manifest, [keys.manifest]);
  }

  if (igual && Object.keys(currentManifests).length === Object.keys(assinados).length) {
    return {
      changed: false,
      sequence: currentSequence,
      catalog: null,
      manifests: assinados,
      versions: manifests.map((manifest) => manifest.version),
      ignored: scan.ignored,
      conflicts,
    };
  }

  const sequence = currentSequence + 1;
  const catalog = catalogFrom(
    manifests,
    (manifest) => documentDigest(assinados[manifest.releaseId].payload),
    sequence,
    now,
  );

  return {
    changed: true,
    sequence,
    catalog: signDocument(catalog, [keys.catalog]),
    manifests: assinados,
    versions: manifests.map((manifest) => manifest.version),
    ignored: scan.ignored,
    conflicts,
  };
}
