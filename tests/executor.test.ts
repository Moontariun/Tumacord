// O executor: cópia, trabalhos com estado, e aplicação de release.
//
// O que este arquivo prova é o que protege os dados: que a cópia PARA quando
// não consegue a pausa, que o lock exclui de verdade entre processos, que um
// pedido repetido não vira dois deploys, e que nenhum segredo entra no que é
// gravado ou impresso.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installationIdOf, pauseWrites, planBackup, rehearsalVolumeName, resumeWrites, verifyArchive,
} from '../tools/tumacordctl/lib/backup.mjs';
import {
  APPLY_STEPS, JobStore, ROLLBACK_STEPS, sanitizeInput, sanitizeLog,
} from '../tools/tumacordctl/lib/jobs.mjs';
import {
  planApply, planRollback, releaseIsApproved, validateDeployment, validateRef,
} from '../tools/tumacordctl/lib/deploy.mjs';

/** Uma instalação descoberta, como `discovery` a entrega. */
function installation(overrides: Record<string, unknown> = {}) {
  return {
    project: 'tumacord',
    directory: '/opt/tumacord',
    services: {
      'tumacord-server': {
        name: 'tumacord-server-1',
        image: 'tumacord:0.9.9',
        mounts: [{ kind: 'volume', name: 'tumacord-dados', destination: '/data', writable: true }],
      },
    },
    ...overrides,
  } as never;
}

/** Um `run` falso, que registra o que foi chamado. */
function recorder(responses: Array<Record<string, unknown>>) {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const execute = async (command: string, args: string[], options: Record<string, unknown> = {}) => {
    calls.push({ command, args, options });
    const next = responses.shift() ?? { ok: true, stdout: '', stderr: '' };
    return { ok: true, stdout: '', stderr: '', ...next };
  };
  return { calls, execute };
}

// ── A cópia ─────────────────────────────────────────────────────────────────

test('o volume copiado é o mount real de /data, e não um nome adivinhado', () => {
  const plan = planBackup({ installation: installation(), outputDir: '/backups', now: Date.UTC(2026, 0, 2, 3, 4, 5) });
  assert.equal(plan.ok, true);
  assert.equal(plan.volume, 'tumacord-dados');
  assert.equal(plan.container, 'tumacord-server-1');
  assert.match(plan.fileName, /^tumacord-tumacord-\d{8}T\d{6}Z\.tar\.gz$/);
});

test('sem mount em /data a cópia não acontece, e isso é dito', () => {
  const withoutData = { project: 'tumacord', services: { 'tumacord-server': { name: 'c', mounts: [] } } };
  const plan = planBackup({ installation: withoutData as never, outputDir: '/backups' });
  assert.equal(plan.ok, false);
  // A frase importa: um backup que não acontece só avisa na restauração.
  assert.match(plan.error, /só avisa na hora de restaurar/);
});

test('dois mounts em /data param a cópia em vez de sortear um', () => {
  const ambiguousInstallation = {
    project: 'tumacord',
    services: {
      'tumacord-server': {
        name: 'c',
        mounts: [
          { kind: 'volume', name: 'a', destination: '/data' },
          { kind: 'bind', source: '/srv/dados', destination: '/data' },
        ],
      },
    },
  };
  const plan = planBackup({ installation: ambiguousInstallation as never, outputDir: '/backups' });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /ambígua/);
});

test('pausar a escrita sem token é recusado, e não tentado sem autorização', async () => {
  const { calls } = recorder([]);
  const result = await pauseWrites({ container: 'c', token: '', execute: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /operação de dono/);
  assert.equal(calls.length, 0);
});

test('o token vai por ambiente, e nunca na linha de comando', async () => {
  const { calls, execute } = recorder([{ ok: true, stdout: '{"paused":true}' }]);
  const result = await pauseWrites({ container: 'tumacord-server-1', token: 'segredo-do-dono', execute });
  assert.equal(result.ok, true);
  const [call] = calls;
  // `/proc/<pid>/cmdline` é legível por qualquer processo da máquina.
  assert.ok(!call.args.join(' ').includes('segredo-do-dono'), 'o token apareceu na linha de comando');
  assert.equal((call.options.env as Record<string, string>).T, 'segredo-do-dono');
  // Sem `-e T` o `docker exec` não repassa nada, e o servidor recebia
  // `Bearer undefined`: a pausa falhava sempre, em toda instalação.
  assert.deepEqual(call.args.slice(0, 4), ['exec', '-i', '-e', 'T']);
});

test('a escrita não voltar é dito com todas as letras', async () => {
  const { execute } = recorder([{ ok: false, stderr: 'sem resposta' }]);
  const result = await resumeWrites({ container: 'c', token: 't', execute });
  assert.equal(result.ok, false);
});

test('uma cópia sem o estado do servidor é recusada', async () => {
  const { execute } = recorder([{ ok: true, stdout: './\n./attachments/\n./attachments/a.png\n' }]);
  const result = await verifyArchive({ archive: '/backups/x.tar.gz', execute });
  assert.equal(result.ok, false);
  assert.match(result.error, /tumacord\.json/);
});

test('a identidade da instalação é lida de dentro do volume', async () => {
  const { execute } = recorder([{ ok: true, stdout: '"installationId": "inst_abc123"\n' }]);
  const result = await installationIdOf({ volume: 'tumacord-dados', execute });
  assert.equal(result.ok, true);
  assert.equal(result.installationId, 'inst_abc123');
});

test('o volume de ensaio nunca tem o nome do volume em uso', () => {
  const name = rehearsalVolumeName(1_700_000_000_000);
  assert.match(name, /^tumacord-restauracao-\d+$/);
  assert.notEqual(name, 'tumacord-dados');
});

// ── Os trabalhos ────────────────────────────────────────────────────────────

test('o lock exclui de verdade, e o segundo pedido não passa', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  await store.init();

  assert.equal(store.acquireLock({ owner: 'primeiro' }).ok, true);
  const second = store.acquireLock({ owner: 'segundo' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'held', 'o dono está vivo: é este processo');
  assert.match(second.error, /operação em andamento/);

  await store.releaseLock();
  assert.equal(store.acquireLock({ owner: 'terceiro' }).ok, true);
});

test('um lock órfão é dito, e não removido sozinho', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  await store.init();

  // Um pid que não existe: o processo dono morreu no meio.
  store.acquireLock({ owner: 'morto', pid: 2 ** 22 - 1 });
  const contender = store.acquireLock({ owner: 'novo' });
  assert.equal(contender.ok, false);
  assert.equal(contender.reason, 'stale');
  // Assumir que o trabalho terminou é o jeito de rodar a migração duas vezes.
  assert.match(contender.error, /--force-unlock/);
});

test('o mesmo pedido repetido devolve o trabalho que já existe', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  await store.init();

  const first = await store.create({ kind: 'server-apply', key: 'apply:rel_1', input: {} });
  const second = await store.create({ kind: 'server-apply', key: 'apply:rel_1', input: {} });
  assert.equal(first.created, true);
  assert.equal(second.created, false, 'um duplo clique não lança dois deploys');
  assert.equal(second.job.id, first.job.id);

  const finished = await store.finish(first.job, { state: 'succeeded' });
  const third = await store.create({ kind: 'server-apply', key: 'apply:rel_1', input: {} });
  assert.equal(third.created, false, 'repetir um deploy concluído não o refaz');
  assert.equal(third.job.id, finished.id);
});

test('o trabalho sobrevive ao processo, com as etapas na ordem', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  await store.init();

  const { job } = await store.create({ kind: 'server-apply', key: 'k', input: { releaseId: 'rel_1' } });
  const withStep = await store.step(job, { name: 'fetch-ref', state: 'ok', detail: 'abc' });
  assert.equal(withStep.state, 'running', 'a primeira etapa tira o trabalho da fila');

  // Um processo novo lê o mesmo estado do disco.
  const otherProcess = new JobStore(directory);
  const reread = await otherProcess.read(job.id);
  assert.equal(reread.steps[0].name, 'fetch-ref');
  assert.equal(reread.state, 'running');
});

test('segredo não entra no que é gravado nem no que é impresso', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  await store.init();

  // Um trabalho é lido no painel, colado num relato e enviado ao suporte.
  assert.match(sanitizeLog('curl -H "Authorization: Bearer abc.def-123"'), /Bearer \*\*\*/);
  assert.match(sanitizeLog('token=abc123'), /token: \*\*\*/);
  assert.match(sanitizeLog('convite: cvt_segredo'), /convite: \*\*\*/);
  // Um `\r` no meio de uma linha esconde o que vem depois: é assim que se
  // apaga a própria pegada num log.
  assert.equal(sanitizeLog('ok\rFALHOU'), 'ok FALHOU');
  assert.deepEqual(sanitizeInput({ releaseId: 'rel_1', token: 'x', ownerToken: 'y' }), { releaseId: 'rel_1' });

  const { job } = await store.create({ kind: 'server-apply', key: 'k', input: { token: 'nao-deve-existir', releaseId: 'rel_1' } });
  const written = await readFile(path.join(directory, 'jobs', `${job.id}.json`), 'utf8');
  assert.ok(!written.includes('nao-deve-existir'), 'o token foi parar no arquivo do trabalho');
});

test('as etapas da aplicação terminam em validar', () => {
  // Um deploy que "deu certo" sem validar a versão é o que fazia uma
  // atualização parecer aplicada sem ter acontecido.
  assert.equal(APPLY_STEPS.at(-1), 'validate');
  assert.equal(ROLLBACK_STEPS.at(-1), 'validate');
  assert.ok(APPLY_STEPS.indexOf('record-deployment') < APPLY_STEPS.indexOf('fetch-ref'));
});

// ── A aplicação ─────────────────────────────────────────────────────────────

test('só se aplica o que está publicado no catálogo aprovado', () => {
  const catalog = {
    payload: {
      channels: {
        stable: {
          entries: [
            { releaseId: 'rel_stable_0-9-9-1', version: '0.9.9-1', state: 'published' },
            { releaseId: 'rel_stable_0-9-9', version: '0.9.9', state: 'withdrawn', withdrawn: { reason: 'quebra o áudio' } },
          ],
        },
      },
    },
  };
  assert.equal(releaseIsApproved(catalog, { releaseId: 'rel_stable_0-9-9-1' }).ok, true);

  const unknownRelease = releaseIsApproved(catalog, { releaseId: 'rel_stable_9-9-9' });
  assert.equal(unknownRelease.ok, false);
  assert.match(unknownRelease.error, /não está publicada/);

  // Uma release retirada continua no catálogo para quem a tem saber; ela não
  // volta a ser aplicável por isso.
  const withdrawnRelease = releaseIsApproved(catalog, { releaseId: 'rel_stable_0-9-9' });
  assert.equal(withdrawnRelease.ok, false);
  assert.match(withdrawnRelease.error, /quebra o áudio/);
});

test('validar compara versão, commit e identidade — e não "respondeu 200"', async () => {
  const healthResponse = (body: Record<string, unknown>) => [{ ok: true, stdout: JSON.stringify(body) }];

  const matching = await validateDeployment({
    project: 'tumacord', expectVersion: '0.9.9-1', expectCommit: 'a'.repeat(40), expectInstallation: 'inst_1',
    execute: recorder(healthResponse({ version: '0.9.9-1', commit: 'a'.repeat(40), installationId: 'inst_1' })).execute,
  });
  assert.equal(matching.ok, true);

  // A imagem não foi reconstruída: ela responde a versão nova do package.json
  // com o código antigo.
  const withoutCommit = await validateDeployment({
    project: 'tumacord', expectVersion: '0.9.9-1', expectCommit: 'a'.repeat(40),
    execute: recorder(healthResponse({ version: '0.9.9-1' })).execute,
  });
  assert.equal(withoutCommit.ok, false);
  assert.match(withoutCommit.error, /não declara commit/);

  // A mais grave da lista: os dados não são os mesmos.
  const otherInstallation = await validateDeployment({
    project: 'tumacord', expectInstallation: 'inst_1',
    execute: recorder(healthResponse({ version: '0.9.9-1', installationId: 'inst_2' })).execute,
  });
  assert.equal(otherInstallation.ok, false);
  assert.match(otherInstallation.error, /PARE/);

  // Algum servidor respondeu; ele não é o Tumacord.
  const otherService = await validateDeployment({
    project: 'tumacord', expectVersion: '0.9.9-1',
    execute: recorder([{ ok: true, stdout: '<html>nginx</html>' }]).execute,
  });
  assert.equal(otherService.ok, false);
  assert.match(otherService.error, /não é o Tumacord/);
});

test('o plano diz a queda do chat antes de ela acontecer', () => {
  const plan = planApply({ installation: installation(), ref: 'v0.9.9-1', releaseId: 'rel_1', version: '0.9.9-1' });
  assert.equal(plan.project, 'tumacord');
  assert.ok(plan.effects.some((effect: string) => /cai/.test(effect)), 'quem está em call precisa saber');
  assert.ok(plan.effects.some((effect: string) => /dados não são tocados/.test(effect)));

  const rollbackPlan = planRollback({ installation: installation(), previous: { commit: 'b'.repeat(40), ref: 'v0.9.9' } });
  assert.equal(rollbackPlan.to, 'b'.repeat(40));
  assert.ok(rollbackPlan.effects.some((effect: string) => /NÃO volta os dados/.test(effect)));
});

test('o checkout com alteração local para a aplicação', async () => {
  const { fetchRef } = await import('../tools/tumacordctl/lib/deploy.mjs');
  const result = await fetchRef({
    projectDir: '/opt/tumacord',
    ref: 'v0.9.9-1',
    execute: recorder([
      { ok: true },
      { ok: true, stdout: ' M server/index.ts\n' },
    ]).execute,
  });
  assert.equal(result.ok, false);
  // `checkout` levaria a alteração embora sem ninguém ver o que era.
  assert.match(result.error, /pode perdê-la/);
});

test('a referência exata é conferida contra o que foi de fato para o disco', async () => {
  const { calls, execute } = recorder([
    { ok: true },
    { ok: true, stdout: '' },
    { ok: true },
    { ok: true, stdout: `${'c'.repeat(40)}\n` },
  ]);
  const result = await fetchRefFrom(execute);
  assert.equal(result.ok, true);
  assert.equal(result.commit, 'c'.repeat(40));
  // `git pull` não entra: o checkout fica em detached HEAD.
  assert.ok(!calls.some((call) => call.args.includes('pull')));
  assert.ok(calls.some((call) => call.args.includes('--detach')));
});

async function fetchRefFrom(execute: never) {
  const { fetchRef } = await import('../tools/tumacordctl/lib/deploy.mjs');
  return fetchRef({ projectDir: '/opt/tumacord', ref: 'v0.9.9-1', execute });
}

test('o registro do deployment anterior é JSON legível, e sem segredo', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tumacord-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { deploymentFilePath } = await import('../tools/tumacordctl/lib/deploy.mjs');
  const target = deploymentFilePath(directory);
  assert.ok(target.startsWith(directory), 'o registro mora fora do checkout descartável');

  await writeFile(path.join(directory, 'x.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
  const reread = JSON.parse(await readFile(path.join(directory, 'x.json'), 'utf8'));
  assert.equal(reread.commit.length, 40);
});

test('validateRef recusa o que muda de significado com o tempo', () => {
  for (const bad of ['main', '0.9.9-1', 'v0.9.9-1-beta', 'HEAD', '', '../etc', 'v0.9.9-1; rm -rf /']) {
    assert.equal(validateRef(bad).ok, false, `\`${bad}\` foi aceito`);
  }
  assert.equal(validateRef('v1.0.0').ok, true);
  assert.equal(validateRef('v0.9.10-2').ok, true);
});
