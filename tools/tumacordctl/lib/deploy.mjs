// Aplicar uma release ao servidor dedicado, e voltar atrás.
//
// ## Por que isto não roda dentro do contêiner
//
// Quem para, recria e sobe o `tumacord-server` precisa estar **fora** do
// processo que vai reiniciar. Um contêiner não consegue reconstruir a si
// mesmo, e montar o socket do Docker dentro dele para tentar seria entregar a
// máquina inteira a quem comprometesse o chat.
//
// ## O que entra aqui
//
// Argumentos **estruturados**: um identificador de release e uma referência
// exata de git. Nunca um comando, uma URL ou um caminho vindos do navegador —
// e nunca uma branch, que muda de significado entre o momento em que o
// operador lê e o momento em que o comando roda.
//
// A referência é validada contra o catálogo aprovado antes de qualquer coisa:
// aplicar o que não está publicado seria aplicar o que ninguém revisou.
//
// ## A ordem, e por que ela é essa
//
// Preflight, backup, registrar o deployment atual, trazer a referência,
// construir e subir, **validar**. O sucesso só é marcado depois da
// validação — e ela compara versão e commit, não "respondeu 200". Um `HTTP
// 200` diz que algum servidor respondeu; ele não diz que é o servidor certo,
// nem que é a versão que acabou de ser aplicada.

import path from 'node:path';
import { run } from './discovery.mjs';
import { APPLY_STEPS, ROLLBACK_STEPS } from './jobs.mjs';

/** O arquivo onde o deployment anterior fica registrado. */
export const DEPLOYMENT_FILE = 'deployments/previous.json';

/**
 * Se uma referência de git pode ser aplicada.
 *
 * Só etiqueta da convenção do produto ou commit completo. Uma branch é
 * recusada de propósito: "a mais recente" não é um endereço, é uma promessa
 * sobre o futuro, e o que roda precisa ser decidido agora.
 */
export function validateRef(candidate) {
  const text = String(candidate ?? '').trim();
  if (!text) return { ok: false, error: 'Informe a referência exata a aplicar: uma etiqueta `v0.9.9-1` ou um commit completo.' };
  if (/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[1-9]\d*)?$/.test(text)) return { ok: true, ref: text, kind: 'tag' };
  if (/^[0-9a-f]{40}$/i.test(text)) return { ok: true, ref: text.toLowerCase(), kind: 'commit' };
  return {
    ok: false,
    error: `\`${text}\` não é uma referência aplicável. Use uma etiqueta da convenção (v0.9.9-1) ou um commit de 40 caracteres — `
      + 'uma branch muda de significado entre o momento em que você lê e o momento em que o comando roda.',
  };
}

/**
 * Se a release pedida está publicada no catálogo aprovado.
 *
 * Esta é a conferência que impede o executor de aplicar o que ninguém
 * revisou — e ela é feita sobre o catálogo que o serviço está servindo, e não
 * sobre o que o pedido afirma.
 */
export function releaseIsApproved(catalog, { releaseId, channel = 'stable' }) {
  const entries = catalog?.payload?.channels?.[channel]?.entries ?? catalog?.channels?.[channel]?.entries ?? [];
  const entry = entries.find((candidate) => candidate.releaseId === releaseId);
  if (!entry) return { ok: false, error: `A release ${releaseId} não está publicada no canal ${channel}. Publique antes de aplicar.` };
  if (entry.state === 'withdrawn') {
    return { ok: false, error: `A release ${releaseId} foi retirada: ${entry.withdrawn?.reason || 'sem motivo registrado'}. Ela não é aplicável.` };
  }
  return { ok: true, entry };
}

/**
 * O deployment que está rodando agora.
 *
 * É ele que torna a volta atrás possível **sem adivinhar um número**. O guia
 * antigo mandava voltar para `0.8.0` no README enquanto o script voltava para
 * `0.9.6`; aqui a volta é para o que foi registrado.
 */
export async function currentDeployment({ projectDir, project, execute = run }) {
  const commit = await execute('git', ['-C', projectDir, 'rev-parse', 'HEAD']);
  const described = await execute('git', ['-C', projectDir, 'describe', '--tags', '--always', 'HEAD']);
  const image = await execute('docker', ['compose', '-p', project, 'images', '-q', 'tumacord-server'], { cwd: projectDir });
  return {
    ok: commit.ok,
    commit: commit.stdout.trim(),
    ref: described.stdout.trim(),
    image: image.stdout.trim(),
    error: commit.ok ? '' : commit.stderr.trim(),
  };
}

/**
 * Traz a referência exata, e prova que é ela que está no disco.
 *
 * `git pull` não entra aqui: o checkout fica em *detached HEAD*, e `pull` ali
 * ou falha ou traz outra coisa. E a conferência depois não é opcional — sem
 * ela, um `fetch` que falhou em silêncio deixaria a build rodando sobre o
 * código antigo com o número novo.
 */
export async function fetchRef({ projectDir, ref, execute = run }) {
  const fetched = await execute('git', ['-C', projectDir, 'fetch', '--tags', '--force', 'origin']);
  if (!fetched.ok) return { ok: false, error: `Não consegui buscar do origin: ${fetched.stderr.trim()}` };

  const dirty = await execute('git', ['-C', projectDir, 'status', '--porcelain']);
  if (dirty.stdout.trim()) {
    // O checkout deveria ser descartável. Algo mudou nele, e `checkout` pode
    // levar essa mudança embora sem ninguém ver o que era.
    return { ok: false, error: `Há alteração local no checkout:\n${dirty.stdout.trim()}\nInvestigue antes: aplicar agora pode perdê-la.` };
  }

  const checkedOut = await execute('git', ['-C', projectDir, 'checkout', '--detach', ref]);
  if (!checkedOut.ok) return { ok: false, error: `Não consegui ir para ${ref}: ${checkedOut.stderr.trim()}` };

  const head = await execute('git', ['-C', projectDir, 'rev-parse', 'HEAD']);
  return { ok: true, commit: head.stdout.trim() };
}

/** Reconstrói a imagem com o commit dentro dela, e sobe. */
export async function buildAndStart({ projectDir, project, commit, execute = run }) {
  const result = await execute('docker', [
    'compose', '-p', project, 'up', '-d', '--build',
    'tumacord-server', 'tumacord-updates',
  ], {
    cwd: projectDir,
    // O commit entra na imagem para o `/api/health` poder prová-lo. `version`
    // sozinha não prova que a atualização aconteceu: uma imagem que não foi
    // reconstruída responde a versão nova do package.json com o código antigo.
    env: { ...process.env, TUMACORD_COMMIT: commit },
  });
  return { ok: result.ok, error: result.ok ? '' : (result.stderr.trim() || result.stdout.trim()) };
}

/**
 * Valida o que subiu.
 *
 * Pelo endpoint **interno**, de dentro do contêiner: ele responde sobre este
 * contêiner, e não sobre o que o proxy resolveu encaminhar. E compara três
 * coisas — versão, commit e a identidade da instalação.
 *
 * `installationId` é a que mais importa: se ele mudou, os dados não são os
 * mesmos, e nada mais do resultado interessa.
 */
export async function validateDeployment({ projectDir, project, expectVersion, expectCommit, expectInstallation, execute = run }) {
  const result = await execute('docker', [
    'compose', '-p', project, 'exec', '-T', 'tumacord-server',
    'node', '-e', "fetch('http://127.0.0.1:4600/api/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{process.stderr.write(String(e));process.exit(1)})",
    // Sem o diretório, o compose procura o arquivo na pasta de onde o comando
    // foi chamado: a validação falha por não achar o projeto — ou acha outro.
  ], projectDir ? { cwd: projectDir } : {});
  if (!result.ok) return { ok: false, error: `O servidor não respondeu à validação: ${result.stderr.trim()}` };

  let health;
  try {
    health = JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: 'A resposta de saúde não é JSON; o serviço que respondeu não é o Tumacord.' };
  }

  const problems = [];
  if (expectVersion && health.version !== expectVersion) {
    problems.push(`a versão respondida é ${health.version}, e a aplicada deveria ser ${expectVersion}`);
  }
  if (expectCommit && health.commit && health.commit !== expectCommit) {
    problems.push(`o commit respondido é ${health.commit}, e o aplicado deveria ser ${expectCommit}`);
  }
  if (expectCommit && !health.commit) {
    problems.push('o servidor não declara commit: a imagem foi construída sem `TUMACORD_COMMIT`, e não dá para provar que ela é a nova');
  }
  if (expectInstallation && health.installationId !== expectInstallation) {
    // Esta é a mais grave da lista: os dados não são os mesmos.
    problems.push(`a identidade da instalação mudou (${expectInstallation} → ${health.installationId}). PARE: os dados não são os mesmos`);
  }
  return problems.length ? { ok: false, error: problems.join('; '), health } : { ok: true, health };
}

/**
 * O plano de uma aplicação, sem executá-la.
 *
 * Serve para o `--dry-run` e para o painel mostrar o que vai acontecer antes de
 * a pessoa confirmar. Um deploy que só se explica depois de rodar não dá a
 * ninguém a chance de dizer "esse não".
 */
export function planApply({ installation, ref, releaseId, version }) {
  const chat = installation?.services?.['tumacord-server'];
  return {
    project: installation?.project ?? '',
    directory: installation?.directory ?? '',
    container: chat?.name ?? '',
    currentImage: chat?.image ?? '',
    ref,
    releaseId,
    version,
    steps: APPLY_STEPS,
    effects: [
      'O chat fica fora do ar entre parar e subir; quem estiver em call cai.',
      'Os dados não são tocados: o volume é o mesmo, e o backup acontece antes.',
      'O deployment atual é registrado antes, e é para ele que a volta atrás vai.',
    ],
  };
}

export function planRollback({ installation, previous }) {
  return {
    project: installation?.project ?? '',
    to: previous?.commit ?? '',
    ref: previous?.ref ?? '',
    steps: ROLLBACK_STEPS,
    effects: [
      'O chat fica fora do ar entre parar e subir.',
      'Voltar o código NÃO volta os dados: se a versão nova migrou o schema, a anterior pode não saber ler o que ela escreveu.',
    ],
  };
}

/** Onde o registro do deployment anterior mora, fora do checkout descartável. */
export function deploymentFilePath(stateDir) {
  return path.join(path.resolve(stateDir), DEPLOYMENT_FILE);
}
