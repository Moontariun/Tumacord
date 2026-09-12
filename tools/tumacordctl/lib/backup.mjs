// A cópia dos dados do dedicado, e a volta deles.
//
// ## Por que um `tar` do volume vivo não basta
//
// O servidor grava `tumacord.json` de forma coordenada **dentro do processo**.
// Isso protege contra ele se atropelar — não protege contra alguém copiar o
// arquivo no meio de uma gravação. Um `tar` do volume enquanto ele escreve
// pode capturar o JSON entre o `write` e o `rename`, ou o estado de um instante
// com os anexos de outro.
//
// Nenhuma dessas falhas aparece na hora. Elas aparecem na restauração, meses
// depois, quando já não há de onde tirar outra cópia.
//
// Por isso a cópia pede ao servidor que **pause a escrita**, copia estado e
// anexos no mesmo ponto, e libera. **Sem conseguir a pausa, o procedimento
// para.** Não continuar em silêncio é o ponto inteiro: foi assim que o guia
// antigo seguia sem backup quando não achava o volume.
//
// ## A ordem da restauração
//
// Restaura-se num **destino separado**, valida-se lá, e só então se decide
// substituir. Nunca há apagamento sobre um caminho que não foi conferido.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { dataMount, run } from './discovery.mjs';

/** A imagem usada para empacotar e desempacotar. Fixada, e não "a mais nova". */
export const TAR_IMAGE = 'alpine:3.20';

/** O arquivo que prova que a cópia tem o estado do servidor. */
export const STATE_FILE = './tumacord.json';

/**
 * O plano de uma cópia: o que copiar, para onde, e por quê parar.
 *
 * Puro de propósito — a decisão de **onde estão os dados** é a que o guia
 * antigo errava, e ela precisa poder ser provada sem Docker.
 */
export function planBackup({ installation, outputDir, now = Date.now() }) {
  const chat = installation?.services?.['tumacord-server'];
  if (!chat) {
    return { ok: false, error: 'Este projeto não tem o serviço `tumacord-server`. Confira se está no projeto certo com --project <nome>.' };
  }

  // O volume não é procurado por nome nem por expressão regular: ele é o mount
  // que o contêiner **tem** em /data.
  const mounts = (chat.mounts ?? []).filter((mount) => mount.destination === '/data');
  if (!mounts.length) {
    return {
      ok: false,
      error: 'O contêiner do chat não tem nada montado em /data. Sem saber onde os dados estão, não há backup a fazer — e um backup que não acontece só avisa na hora de restaurar.',
    };
  }
  if (mounts.length > 1) {
    return {
      ok: false,
      error: `Há ${mounts.length} mounts em /data. Descoberta ambígua para a operação: copiar qualquer um seria adivinhar.`,
    };
  }

  const mount = mounts[0];
  const source = mount.name || mount.source;
  if (!source) return { ok: false, error: 'O mount de /data não tem origem identificável.' };

  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fileName = `tumacord-${installation.project}-${stamp}.tar.gz`;
  return {
    ok: true,
    project: installation.project,
    container: chat.name,
    volume: source,
    volumeKind: mount.kind,
    outputDir: path.resolve(outputDir),
    archive: path.join(path.resolve(outputDir), fileName),
    fileName,
  };
}

/** O SHA-256 de um arquivo, lido em pedaços. */
export function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Pausa a escrita do servidor.
 *
 * É uma operação de **dono**, e não de quem tem shell na máquina: a auditoria
 * do servidor registra quem pediu. O token vem de fora — esta ferramenta nunca
 * lida com senha.
 */
export async function pauseWrites({ container, token, timeoutMs = 15 * 60_000, execute = run }) {
  if (!token) {
    return { ok: false, error: 'Pausar a escrita é uma operação de dono: rode como o usuário do executor, cujo segredo o servidor aceita, ou informe TUMACORD_OWNER_TOKEN com a sessão de um dono. Veja docs/backup-restore.md.' };
  }
  const result = await execute('docker', [
    // `-e T` sem valor copia `T` do ambiente deste processo para dentro do
    // contêiner. Sem ele o `docker exec` não repassa nada, e o pedido chegava
    // ao servidor como `Bearer undefined` — a pausa falhava sempre.
    'exec', '-i', '-e', 'T', container, 'node', '-e',
    // O corpo vai por argumento estruturado, e o token por ambiente: ele não
    // aparece na linha de comando, que é visível a qualquer processo da
    // máquina pelo `/proc`.
    `fetch('http://127.0.0.1:4600/api/admin/pause-writes',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.T},body:JSON.stringify({timeoutMs:${Number(timeoutMs)}})}).then(r=>r.text().then(t=>{process.stdout.write(t);process.exit(r.ok?0:1)})).catch(e=>{process.stderr.write(String(e));process.exit(1)})`,
  ], { env: { ...process.env, T: token } });
  if (!result.ok) {
    return { ok: false, error: `NÃO consegui pausar a escrita: ${result.stderr.trim() || result.stdout.trim() || 'sem resposta'}` };
  }
  return { ok: true, response: result.stdout.trim() };
}

/** Libera a escrita. Roda **mesmo quando a cópia falha**. */
export async function resumeWrites({ container, token, execute = run }) {
  const result = await execute('docker', [
    'exec', '-i', '-e', 'T', container, 'node', '-e',
    `fetch('http://127.0.0.1:4600/api/admin/resume-writes',{method:'POST',headers:{authorization:'Bearer '+process.env.T}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
  ], { env: { ...process.env, T: token } });
  return { ok: result.ok, error: result.ok ? '' : result.stderr.trim() };
}

/** Copia o volume para um arquivo, com o servidor parado de escrever. */
export async function archiveVolume({ volume, archive, execute = run }) {
  const outputDir = path.dirname(archive);
  const result = await execute('docker', [
    'run', '--rm',
    '-v', `${volume}:/data:ro`,
    '-v', `${outputDir}:/saida`,
    TAR_IMAGE,
    'tar', '-czf', `/saida/${path.basename(archive)}`, '-C', '/data', '.',
  ]);
  return { ok: result.ok, error: result.ok ? '' : (result.stderr.trim() || 'o empacotamento falhou') };
}

/**
 * Confere que a cópia abre e tem o que deveria.
 *
 * Sem `tumacord.json` ela não serve — e é melhor descobrir isso agora do que na
 * hora de restaurar.
 */
export async function verifyArchive({ archive, execute = run }) {
  const listing = await execute('tar', ['-tzf', archive]);
  if (!listing.ok) return { ok: false, error: 'A cópia não abre; ela não serve.' };
  const entries = listing.stdout.split('\n').filter(Boolean);
  if (!entries.includes(STATE_FILE)) {
    return { ok: false, error: `A cópia não tem ${STATE_FILE}; ela não serve. Refaça.`, entries: entries.length };
  }
  const attachments = entries.filter((entry) => entry.startsWith('./attachments/') && !entry.endsWith('/')).length;
  const info = await stat(archive);
  return { ok: true, entries: entries.length, attachments, size: info.size, sha256: await sha256OfFile(archive) };
}

/**
 * Restaura uma cópia num volume **novo**, que não é o que está em uso.
 *
 * A ordem não é negociável: valida-se no destino separado antes de qualquer
 * coisa substituir o que está em uso. Se a cópia estiver ruim, perder as duas
 * é o desfecho que isto evita.
 */
export async function restoreToNewVolume({ archive, volume, execute = run }) {
  const created = await execute('docker', ['volume', 'create', volume]);
  if (!created.ok) return { ok: false, error: `Não consegui criar o volume ${volume}: ${created.stderr.trim()}` };

  const result = await execute('docker', [
    'run', '--rm',
    '-v', `${volume}:/data`,
    '-v', `${path.dirname(archive)}:/entrada:ro`,
    TAR_IMAGE,
    'sh', '-c',
    // `set -e` com as conferências antes e depois: a cópia precisa existir, e
    // o resultado precisa ter o estado. Qualquer uma falhando interrompe.
    `set -e; test -f /entrada/${path.basename(archive)}; tar -xzf /entrada/${path.basename(archive)} -C /data; test -f /data/tumacord.json`,
  ]);
  if (!result.ok) {
    return { ok: false, error: `A restauração falhou: ${result.stderr.trim() || 'sem detalhe'}`, volume };
  }
  return { ok: true, volume };
}

/** Apaga um volume de ensaio. Só o de ensaio — nunca o que está em uso. */
export async function dropVolume({ volume, execute = run }) {
  const result = await execute('docker', ['volume', 'rm', volume]);
  return { ok: result.ok, error: result.ok ? '' : result.stderr.trim() };
}

/**
 * A identidade da instalação, lida de dentro de um volume.
 *
 * É ela que prova que a cópia é **desta** instalação. Nome, endereço e apelido
 * coincidem e mudam; este id não. Restaurar a cópia de outra instalação por
 * cima desta é o erro que mais custa, e o que este dado evita.
 */
export async function installationIdOf({ volume, execute = run }) {
  const result = await execute('docker', [
    'run', '--rm', '-v', `${volume}:/data:ro`, TAR_IMAGE,
    'sh', '-c', "grep -o '\"installationId\": *\"[^\"]*\"' /data/tumacord.json | head -1",
  ]);
  if (!result.ok) return { ok: false, error: 'Não consegui ler a identidade da instalação dentro do volume.' };
  const found = /"installationId":\s*"([^"]*)"/.exec(result.stdout);
  return found ? { ok: true, installationId: found[1] } : { ok: false, error: 'O volume não declara `installationId`.' };
}

/** Um nome de volume de ensaio, que não colide com nada em uso. */
export function rehearsalVolumeName(now = Date.now()) {
  return `tumacord-restauracao-${now}`;
}

/** Garante que a pasta de saída existe e é gravável. */
export async function ensureOutputDir(directory) {
  await mkdir(directory, { recursive: true });
  return path.resolve(directory);
}
