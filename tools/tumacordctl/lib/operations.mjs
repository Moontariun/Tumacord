// As operações de verdade: copiar, aplicar, voltar atrás.
//
// ## Por que elas moram aqui e não no CLI
//
// Duas portas chegam nelas: a linha de comando, para quem tem shell na
// máquina, e o executor, para o painel do dono. Se cada porta tivesse a sua
// implementação, a operação mais perigosa do sistema teria duas versões que
// divergem — e a que ninguém olha seria a que roda quando dá errado.
//
// Aqui elas são uma só. Quem chama passa um `report` para acompanhar o
// andamento; a sequência, as conferências e a ordem são as mesmas nas duas.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { run } from './discovery.mjs';
import { preflight } from './preflight.mjs';
import {
  archiveVolume, ensureOutputDir, installationIdOf, pauseWrites,
  planBackup, resumeWrites, verifyArchive,
} from './backup.mjs';
import {
  buildAndStart, currentDeployment, deploymentFilePath, fetchRef, validateDeployment,
} from './deploy.mjs';

/** Um relator que não faz nada, para quem não quer acompanhar. */
const SILENT = () => {};

/**
 * A cópia dos dados, do começo ao fim.
 *
 * A pausa da escrita é obrigatória, e a liberação acontece **mesmo quando a
 * cópia falha**: é ela que devolve o servidor ao normal, e por isso não pode
 * depender de a cópia ter dado certo.
 */
export async function runBackup({ installation, outputDir, token, report = SILENT, execute = run, now = Date.now() }) {
  const plan = planBackup({ installation, outputDir, now });
  if (!plan.ok) return { ok: false, error: plan.error };

  await ensureOutputDir(plan.outputDir);
  report({ step: 'plan', state: 'ok', detail: `${plan.volumeKind} ${plan.volume} → ${plan.archive}` });

  const paused = await pauseWrites({ container: plan.container, token, execute });
  if (!paused.ok) {
    report({ step: 'pause', state: 'failed', detail: paused.error });
    return {
      ok: false,
      error: `${paused.error}\nBackup CANCELADO. A alternativa comprovadamente consistente é parar o contêiner e copiar; `
        + 'o procedimento está em docs/backup-restore.md.',
    };
  }
  report({ step: 'pause', state: 'ok', detail: 'escrita pausada' });

  let archived;
  try {
    archived = await archiveVolume({ volume: plan.volume, archive: plan.archive, execute });
  } finally {
    const resumed = await resumeWrites({ container: plan.container, token, execute });
    report({
      step: 'resume',
      state: resumed.ok ? 'ok' : 'failed',
      detail: resumed.ok ? 'escrita liberada' : `NÃO consegui liberar a escrita: ${resumed.error}`,
    });
  }
  if (!archived.ok) {
    report({ step: 'archive', state: 'failed', detail: archived.error });
    return { ok: false, error: archived.error };
  }

  const verified = await verifyArchive({ archive: plan.archive, execute });
  if (!verified.ok) {
    report({ step: 'verify', state: 'failed', detail: verified.error });
    return { ok: false, error: verified.error };
  }
  await writeFile(`${plan.archive}.sha256`, `${verified.sha256}  ${plan.fileName}\n`);
  report({ step: 'verify', state: 'ok', detail: `${verified.entries} entradas, ${verified.attachments} anexos` });

  return { ok: true, archive: plan.archive, sha256: verified.sha256, entries: verified.entries, attachments: verified.attachments };
}

/** O volume de dados desta instalação, quando ele é conhecível. */
function dataVolume(installation) {
  const plan = planBackup({ installation, outputDir: '/tmp' });
  return plan.ok ? plan.volume : '';
}

/**
 * Aplica uma release ao servidor dedicado.
 *
 * A ordem não é negociável: preflight, **cópia**, registrar o que está
 * rodando, trazer a referência, construir e subir, **validar**.
 *
 * `backup` é `{ outputDir, token }` ou a palavra `'skip'`. Não há terceira
 * forma: sem destino e sem dispensa explícita a aplicação para na etapa da
 * cópia, porque voltar o código não volta os dados. O sucesso só é marcado depois da
 * validação — e ela compara versão, commit e identidade da instalação, e não
 * "respondeu 200".
 */
export async function runApply({ installation, releaseId, ref, version, store, job, stateDirectory, backup, report = SILENT, execute = run }) {
  const directory = installation.directory || process.cwd();
  const project = installation.project;
  let current = job;

  const step = async (name, action) => {
    report({ step: name, state: 'running' });
    const result = await action();
    const detail = result.ok ? (result.detail ?? '') : result.error;
    current = await store.step(current, { name, state: result.ok ? 'ok' : 'failed', detail });
    report({ step: name, state: result.ok ? 'ok' : 'failed', detail });
    if (!result.ok) throw new Error(`${name}: ${result.error}`);
    return result;
  };

  try {
    const volume = dataVolume(installation);
    // Sem volume conhecido a identidade não é conferível — e conferir contra
    // uma origem vazia seria pior do que não conferir.
    const identity = volume ? await installationIdOf({ volume, execute }) : { ok: false };

    await step('preflight', async () => {
      const checks = await preflight(installation);
      return checks.level === 'fail'
        ? { ok: false, error: checks.checks.filter((check) => check.level === 'fail').map((check) => `${check.title}: ${check.detail}`).join('; ') }
        : { ok: true, detail: `nível ${checks.level}` };
    });

    if (backup === 'skip') {
      // Dispensar a cópia é decisão explícita de quem pediu, e fica no
      // registro do trabalho — é a primeira coisa que se procura quando uma
      // migração dá errado.
      current = await store.step(current, { name: 'backup', state: 'skipped', detail: 'dispensada explicitamente por quem pediu' });
      report({ step: 'backup', state: 'skipped', detail: 'dispensada explicitamente' });
    } else {
      await step('backup', async () => {
        if (!backup?.outputDir) {
          return { ok: false, error: 'não há destino para a cópia. Voltar o código não volta os dados, e sem cópia uma migração que dê errado não tem para onde voltar.' };
        }
        const copied = await runBackup({ installation, outputDir: backup.outputDir, token: backup.token, execute });
        return copied.ok ? { ok: true, detail: `${copied.archive} (${copied.sha256.slice(0, 12)})` } : { ok: false, error: copied.error };
      });
    }

    await step('record-deployment', async () => {
      const before = await currentDeployment({ projectDir: directory, project, execute });
      if (!before.ok) return { ok: false, error: before.error || 'não consegui ler o deployment atual' };
      const target = deploymentFilePath(stateDirectory);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify({ ...before, registradoEm: new Date().toISOString() }, null, 2)}\n`);
      return { ok: true, detail: `${before.ref} (${before.commit.slice(0, 12)})` };
    });

    const fetched = await step('fetch-ref', () => fetchRef({ projectDir: directory, ref, execute }));
    await step('build', () => buildAndStart({ projectDir: directory, project, commit: fetched.commit, execute }));
    const validated = await step('validate', () => validateDeployment({
      projectDir: directory,
      project,
      expectVersion: version,
      expectCommit: fetched.commit,
      expectInstallation: identity.ok ? identity.installationId : '',
      execute,
    }));

    current = await store.finish(current, { state: 'succeeded', result: { releaseId, version, commit: fetched.commit } });
    return { ok: true, job: current, commit: fetched.commit, health: validated.health };
  } catch (error) {
    const message = String(error?.message ?? error);
    current = await store.finish(current, { state: 'failed', error: message });
    return { ok: false, error: message, job: current };
  }
}

/**
 * Volta ao deployment registrado.
 *
 * Ela não refaz backup: a cópia que existe já é o ponto para onde se volta, e
 * copiar agora gravaria por cima dele o estado que se quer abandonar.
 */
export async function runRollback({ installation, previous, store, job, report = SILENT, execute = run }) {
  const directory = installation.directory || process.cwd();
  const project = installation.project;
  let current = job;

  const step = async (name, action) => {
    report({ step: name, state: 'running' });
    const result = await action();
    const detail = result.ok ? (result.detail ?? '') : result.error;
    current = await store.step(current, { name, state: result.ok ? 'ok' : 'failed', detail });
    report({ step: name, state: result.ok ? 'ok' : 'failed', detail });
    if (!result.ok) throw new Error(`${name}: ${result.error}`);
    return result;
  };

  try {
    const fetched = await step('checkout-previous', () => fetchRef({ projectDir: directory, ref: previous.commit, execute }));
    await step('build', () => buildAndStart({ projectDir: directory, project, commit: fetched.commit, execute }));
    const validated = await step('validate', () => validateDeployment({ projectDir: directory, project, expectCommit: fetched.commit, execute }));
    current = await store.finish(current, { state: 'succeeded', result: { commit: fetched.commit } });
    return { ok: true, job: current, commit: fetched.commit, health: validated.health };
  } catch (error) {
    const message = String(error?.message ?? error);
    current = await store.finish(current, { state: 'failed', error: message });
    return { ok: false, error: message, job: current };
  }
}

/** O deployment anterior registrado, ou o motivo de não haver um. */
export async function previousDeployment(stateDirectory) {
  try {
    const parsed = JSON.parse(await readFile(deploymentFilePath(stateDirectory), 'utf8'));
    if (!parsed?.commit) return { ok: false, error: 'O registro do deployment anterior não tem commit; ele não serve para voltar.' };
    return { ok: true, previous: parsed };
  } catch {
    return {
      ok: false,
      error: 'Não há deployment anterior registrado. A volta atrás é para o que foi registrado na aplicação — e não para um '
        + 'número escrito num guia. Sem registro, use o procedimento de docs/atualizacao-servidor.md.',
    };
  }
}
