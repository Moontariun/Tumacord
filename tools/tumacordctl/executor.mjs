#!/usr/bin/env node
// O executor de atualizações do servidor dedicado.
//
// ## Por que ele existe fora do contêiner
//
// Quem para, recria e sobe o `tumacord-server` precisa estar **fora** do
// processo que vai reiniciar. Um contêiner não reconstrói a si mesmo, e montar
// o socket do Docker dentro dele para tentar seria entregar a máquina inteira a
// quem comprometesse o chat: com esse socket, qualquer um sobe um contêiner
// privilegiado com o disco do host montado.
//
// ## O que ele aceita, e o que ele recusa por construção
//
// A superfície é **estruturada**: um identificador de release e, no máximo, um
// canal. Nunca um comando, uma URL, um caminho ou uma referência de git vinda
// de quem pede — a referência é **derivada** do manifesto assinado daquela
// release. Aceitar a referência do chamador seria aceitar um alvo arbitrário
// com uma etapa de verificação a menos, e é exatamente o que a derivação
// elimina.
//
// Ele não oferece shell. Não há rota que receba `command`, `path` ou `url`.
//
// ## Onde ele escuta
//
// Na VPS, num **socket Unix** (`TUMACORD_EXECUTOR_SOCKET`). O chat roda num
// contêiner, e o 127.0.0.1 de dentro dele é o próprio contêiner, não o host:
// alcançar uma porta do host exigiria o executor escutar numa interface de
// rede. Um socket não é alcançável pela rede por construção.
//
// Sem socket, ele escuta numa porta — e só no laço local, para quem roda o
// servidor direto no host. Um executor alcançável da internet é um jeito de
// trocar a versão do servidor de outra pessoa, e nenhuma autenticação compensa
// expor isso: um host que não seja de laço local é **recusado na subida**, e
// não avisado no log.

import { createServer } from 'node:http';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { chooseInstallation, discoverInstallations } from './lib/discovery.mjs';
import { preflight } from './lib/preflight.mjs';
import { JobStore, sanitizeLog } from './lib/jobs.mjs';
import { planApply, planRollback, releaseIsApproved, validateRef } from './lib/deploy.mjs';
import { previousDeployment, runApply, runBackup, runRollback } from './lib/operations.mjs';

/** Endereços em que o executor aceita escutar. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** O maior corpo que uma requisição pode ter. Nada aqui é grande. */
const MAX_BODY = 16 * 1024;

/**
 * Até onde vale a pena ler para poder **responder** que é grande demais.
 *
 * Passar disso derruba a conexão sem resposta: um corpo dessa ordem já não é
 * engano de quem chama, e ler tudo para ser educado é o que transforma o
 * executor num jeito barato de ocupar a memória da máquina.
 */
const HARD_LIMIT = 1024 * 1024;

/** As configurações, todas do ambiente, nenhuma da rede. */
export function settings(env = process.env) {
  return {
    host: env.TUMACORD_EXECUTOR_HOST || '127.0.0.1',
    port: Number(env.TUMACORD_EXECUTOR_PORT || 4302),
    project: env.TUMACORD_PROJETO || '',
    stateDir: path.resolve(env.TUMACORD_EXECUTOR_STATE || '/var/lib/tumacord/executor'),
    updatesAdmin: env.TUMACORD_UPDATES_ADMIN || 'http://127.0.0.1:4301',
    socket: env.TUMACORD_EXECUTOR_SOCKET || '',
    // A cópia que antecede cada aplicação vai para cá. Vazio desliga a
    // aplicação pelo painel, e não a cópia: aplicar sem copiar não é opção.
    backupDir: env.TUMACORD_BACKUP_DIR ?? '/var/lib/tumacord/backups',
  };
}

/**
 * Por que o socket não pode morar onde está pedido, quando não pode.
 *
 * O diretório do socket é montado dentro do contêiner do chat. Se ele for o do
 * estado — ou estiver acima ou abaixo dele —, o contêiner passa a enxergar os
 * trabalhos, o registro do deployment e o arquivo do segredo. A recusa é na
 * subida, e não um aviso no log.
 */
export function socketPlacementError(socketPath, stateDir) {
  if (!path.isAbsolute(socketPath)) return 'TUMACORD_EXECUTOR_SOCKET precisa ser um caminho absoluto.';
  const directory = path.dirname(path.resolve(socketPath));
  const state = path.resolve(stateDir);
  if (directory === state || directory.startsWith(`${state}${path.sep}`) || state.startsWith(`${directory}${path.sep}`)) {
    return `O socket (${socketPath}) está no mesmo ramo do estado (${state}). O diretório do socket é montado no contêiner do chat, `
      + 'e o estado guarda o segredo e o registro dos deployments. Use outro diretório, como /var/lib/tumacord/run.';
  }
  return '';
}

/** Deixa o caminho do socket pronto, sem apagar o que não é um socket. */
async function prepareSocket(socketPath) {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o755 });
  let info = null;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!info) return;
  if (!info.isSocket()) {
    throw new Error(`${socketPath} existe e não é um socket. Não apago o que não fui eu que criei.`);
  }
  // Um socket que ficou de uma subida anterior que morreu sem limpar.
  await rm(socketPath);
}

/**
 * O segredo que o painel do dono usa para falar com o executor.
 *
 * No host ele mora num arquivo `0600` do usuário do executor. Do lado do chat
 * ele entra pelo `.env`, como as outras chaves da instalação —
 * `TUMACORD_SERVER_ACCESS_KEY` e `TUMACORD_TURN_SECRET` já moram lá, com a
 * mesma exposição a quem tem acesso ao Docker desta máquina.
 *
 * Ele é gerado na primeira subida e **nunca impresso**. Quem precisa dele o lê
 * do arquivo; um segredo impresso no log vai parar no relato de problema.
 */
export async function loadSecret(stateDir) {
  const file = path.join(stateDir, 'executor.token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing.length >= 32) return { secret: existing, file, created: false };
  } catch { /* não existe ainda */ }
  const secret = randomBytes(32).toString('base64url');
  await writeFile(file, `${secret}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { secret, file, created: true };
}

/** Comparação que não vaza o segredo pelo tempo que leva para falhar. */
export function secretMatches(offered, expected) {
  const left = Buffer.from(String(offered ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  if (!right.length) return false;
  if (left.length !== right.length) {
    // Ainda assim compara, para o tempo não denunciar o tamanho certo.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** O portador oferecido, se houver um. */
export function bearer(header) {
  const found = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
  return found ? found[1] : '';
}

/**
 * A instalação que este executor opera.
 *
 * O projeto vem do ambiente, e não do pedido. Um executor que aceitasse o
 * projeto pela rede deixaria o painel de uma instalação operar a outra.
 */
async function installationOf(config) {
  const discovery = await discoverInstallations();
  if (!discovery.ok) return { ok: false, error: discovery.error };
  const choice = chooseInstallation(discovery.installations, config.project);
  if (!choice.ok) return { ok: false, error: choice.error };
  return { ok: true, installation: choice.installation };
}

/** Lê o catálogo publicado, do lado administrativo do serviço local. */
async function adminGet(config, route) {
  const response = await fetch(`${config.updatesAdmin}${route}`);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

/**
 * A referência de git de uma release, derivada do manifesto assinado.
 *
 * É esta derivação que faz o executor não precisar de um alvo vindo de fora.
 * O manifesto declara o commit de onde a release saiu; é ele que será
 * aplicado, e ele ainda passa pela mesma validação de formato.
 */
export async function refForRelease(config, releaseId) {
  const { status, body } = await adminGet(config, `/admin/releases/${encodeURIComponent(releaseId)}/manifest`);
  if (status !== 200 || !body?.payload) {
    return { ok: false, error: `Não há manifesto importado para ${releaseId}; ela não é aplicável.` };
  }
  const validated = validateRef(body.payload.commit);
  if (!validated.ok) {
    return { ok: false, error: `O manifesto de ${releaseId} declara um commit que não é aplicável: ${validated.error}` };
  }
  return { ok: true, ref: validated.ref, version: body.payload.version };
}

/** O corpo de uma requisição, com limite. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversize = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Passou do limite: o que vem depois é descartado em vez de guardado,
        // para o excesso não custar memória enquanto a conexão termina.
        oversize = true;
        chunks.length = 0;
        if (size > HARD_LIMIT) { request.destroy(); reject(new Error('corpo grande demais')); }
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (oversize) return reject(new Error('corpo grande demais'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('o corpo não é JSON')); }
    });
  });
}

/** Um identificador de release aceitável. Formato fechado, e não "qualquer texto". */
export function validReleaseId(candidate) {
  return typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(candidate);
}

export function createExecutor(config, { store, execute } = {}) {
  const jobs = store ?? new JobStore(config.stateDir);
  let secret = '';

  /** Toca o trabalho em segundo plano e devolve o id na hora. */
  const start = async (kind, key, input, work) => {
    const lock = jobs.acquireLock({ owner: kind });
    if (!lock.ok) return { ok: false, status: 409, error: lock.error, reason: lock.reason };

    let created;
    try {
      created = await jobs.create({ kind, key, input });
    } catch (error) {
      await jobs.releaseLock();
      return { ok: false, status: 500, error: String(error?.message ?? error) };
    }
    if (!created.created && created.job.state === 'succeeded') {
      await jobs.releaseLock();
      // O mesmo pedido, repetido, não vira um segundo deploy.
      return { ok: true, status: 200, job: created.job, repeated: true };
    }

    // O trabalho continua depois da resposta. É por isso que ele tem estado em
    // disco: quem perguntar depois — inclusive outro processo — encontra.
    work(created.job).finally(() => jobs.releaseLock());
    return { ok: true, status: 202, job: created.job };
  };

  const routes = {
    'GET /health': async () => ({ status: 200, body: { ok: true, servico: 'tumacord-executor' } }),

    'GET /v1/state': async () => {
      const found = await installationOf(config);
      if (!found.ok) return { status: 503, body: { error: found.error } };
      const catalog = await adminGet(config, '/admin/catalog');
      const registered = await previousDeployment(config.stateDir);
      const running = (await jobs.list()).find((job) => job.state === 'running' || job.state === 'queued') ?? null;
      const checks = await preflight(found.installation);
      return {
        status: 200,
        body: {
          project: found.installation.project,
          catalog: catalog.body?.payload
            ? { sequence: catalog.body.payload.sequence, channels: catalog.body.payload.channels }
            : null,
          previous: registered.ok ? { ref: registered.previous.ref, commit: registered.previous.commit } : null,
          running: running ? { id: running.id, kind: running.kind, state: running.state } : null,
          preflight: { level: checks.level, checks: checks.checks },
        },
      };
    },

    'GET /v1/jobs': async () => ({ status: 200, body: { jobs: (await jobs.list()).slice(0, 50) } }),

    'POST /v1/apply': async (body) => {
      if (!validReleaseId(body.releaseId)) {
        return { status: 400, body: { error: 'Informe `releaseId`: um identificador de release publicada.' } };
      }
      if (!config.backupDir) {
        // Antes de qualquer conferência: sem destino de cópia, nada do resto
        // importa, e quem pediu precisa saber disso primeiro.
        return { status: 409, body: { error: 'Este executor não tem destino de cópia (TUMACORD_BACKUP_DIR). Pelo painel, a aplicação não acontece sem cópia antes.' } };
      }
      const channel = body.channel === 'test' ? 'test' : 'stable';
      const found = await installationOf(config);
      if (!found.ok) return { status: 503, body: { error: found.error } };

      const catalog = await adminGet(config, '/admin/catalog');
      if (catalog.status !== 200 || !catalog.body) {
        return { status: 503, body: { error: 'Não consegui ler o catálogo publicado para conferir a release.' } };
      }
      const approved = releaseIsApproved(catalog.body, { releaseId: body.releaseId, channel });
      if (!approved.ok) return { status: 409, body: { error: approved.error } };

      // A referência vem do manifesto assinado, e não do pedido.
      const derived = await refForRelease(config, body.releaseId);
      if (!derived.ok) return { status: 409, body: { error: derived.error } };
      if (derived.version !== approved.entry.version) {
        return {
          status: 409,
          body: { error: `O catálogo diz ${approved.entry.version} e o manifesto diz ${derived.version}. Nada é aplicado com os dois discordando.` },
        };
      }

      const plan = planApply({ installation: found.installation, ref: derived.ref, releaseId: body.releaseId, version: derived.version });
      if (body.dryRun) return { status: 200, body: { plan } };

      const started = await start(
        'server-apply',
        `apply:${body.releaseId}:${derived.ref}`,
        { releaseId: body.releaseId, ref: derived.ref, version: derived.version, project: plan.project },
        (job) => runApply({
          installation: found.installation,
          releaseId: body.releaseId,
          ref: derived.ref,
          version: derived.version,
          store: jobs,
          job,
          stateDirectory: config.stateDir,
          // O servidor aceita este segredo para pausar a escrita. Uma sessão de
          // dono expira em dias, e a cópia pararia de funcionar sem aviso.
          backup: { outputDir: config.backupDir, token: secret },
          execute,
        }),
      );
      return started.ok
        ? { status: started.status, body: { jobId: started.job.id, plan, repeated: started.repeated ?? false } }
        : { status: started.status, body: { error: started.error, reason: started.reason } };
    },

    'POST /v1/rollback': async (body) => {
      const found = await installationOf(config);
      if (!found.ok) return { status: 503, body: { error: found.error } };
      const registered = await previousDeployment(config.stateDir);
      if (!registered.ok) return { status: 409, body: { error: registered.error } };

      const plan = planRollback({ installation: found.installation, previous: registered.previous });
      if (body.dryRun) return { status: 200, body: { plan } };

      const started = await start(
        'server-rollback',
        `rollback:${plan.to}`,
        { to: plan.to, project: plan.project },
        (job) => runRollback({ installation: found.installation, previous: registered.previous, store: jobs, job, execute }),
      );
      return started.ok
        ? { status: started.status, body: { jobId: started.job.id, plan } }
        : { status: started.status, body: { error: started.error, reason: started.reason } };
    },

    'POST /v1/backup': async () => {
      if (!config.backupDir) {
        return { status: 501, body: { error: 'Este executor não tem destino de cópia configurado (TUMACORD_BACKUP_DIR). A cópia é feita pela linha de comando.' } };
      }
      const found = await installationOf(config);
      if (!found.ok) return { status: 503, body: { error: found.error } };

      const started = await start(
        'backup',
        `backup:${Date.now()}`,
        { project: found.installation.project },
        async (job) => {
          let current = job;
          const result = await runBackup({
            installation: found.installation,
            outputDir: config.backupDir,
            token: secret,
            execute,
            report: async () => { /* o andamento vai para as etapas abaixo */ },
          });
          current = await jobs.step(current, { name: 'archive', state: result.ok ? 'ok' : 'failed', detail: result.ok ? result.archive : result.error });
          await jobs.finish(current, result.ok
            ? { state: 'succeeded', result: { archive: result.archive, sha256: result.sha256 } }
            : { state: 'failed', error: result.error });
        },
      );
      return started.ok
        ? { status: started.status, body: { jobId: started.job.id } }
        : { status: started.status, body: { error: started.error, reason: started.reason } };
    },
  };

  const handler = async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };

    let url;
    try {
      url = new URL(request.url, 'http://executor.local');
    } catch {
      return send(400, { error: 'Caminho inválido.' });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return send(200, { ok: true, servico: 'tumacord-executor' });
    }

    if (!secretMatches(bearer(request.headers.authorization), secret)) {
      // Sem detalhe: dizer *por que* falhou ajuda quem está tentando adivinhar.
      return send(401, { error: 'Não autorizado.' });
    }

    // Um trabalho específico, pelo id.
    const singleJob = /^\/v1\/jobs\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
    if (singleJob && request.method === 'GET') {
      const job = await jobs.read(singleJob[1]);
      return job ? send(200, job) : send(404, { error: 'Não há esse trabalho.' });
    }

    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) return send(404, { error: 'Não há nada neste caminho.' });

    let body = {};
    if (request.method !== 'GET') {
      try {
        body = await readBody(request);
      } catch (error) {
        const message = String(error?.message ?? error);
        return send(message.includes('grande demais') ? 413 : 400, { error: message });
      }
    }

    try {
      const result = await route(body);
      return send(result.status, result.body);
    } catch (error) {
      // O detalhe é sanitizado: ele passa por log, painel e relato.
      return send(500, { error: sanitizeLog(String(error?.message ?? error)) });
    }
  };

  const server = createServer(handler);
  return {
    server,
    jobs,
    setSecret(value) { secret = value; },
    async listen() {
      // As duas recusas vêm antes de qualquer arquivo ser criado.
      if (config.socket) {
        const misplaced = socketPlacementError(config.socket, config.stateDir);
        if (misplaced) throw new Error(misplaced);
      } else if (!LOOPBACK.has(config.host)) {
        throw new Error(
          `TUMACORD_EXECUTOR_HOST=${config.host} não é de laço local. O executor troca a versão do servidor; `
          + 'alcançá-lo pela internet é um jeito de alguém trocar a sua. Publique o painel pelo proxy, e não isto.',
        );
      }

      await jobs.init();
      const loaded = await loadSecret(config.stateDir);
      secret = loaded.secret;

      if (config.socket) {
        await prepareSocket(config.socket);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(config.socket, resolve);
        });
        // Quem conecta é o chat, de dentro do contêiner, com outro uid. Alinhar
        // uid entre host e contêiner é frágil; a barreira é o segredo, e o
        // socket continua fora do alcance da rede.
        await chmod(config.socket, 0o666);
        return loaded;
      }

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      return loaded;
    },
  };
}

/** A subida, quando este arquivo é o programa. */
async function boot() {
  const config = settings();
  const executor = createExecutor(config);
  const loaded = await executor.listen();
  console.log(config.socket ? `executor do Tumacord em ${config.socket}` : `executor do Tumacord em http://${config.host}:${config.port}`);
  console.log(`projeto: ${config.project || '(único desta máquina)'}`);
  console.log(`estado:  ${config.stateDir}`);
  // O segredo nunca é impresso: só onde ele está.
  console.log(loaded.created
    ? `segredo: gerado agora em ${loaded.file} (0600). Configure-o no painel do dono; ele não é impresso aqui.`
    : `segredo: ${loaded.file}`);

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // Um trabalho em andamento continua até terminar: o estado em disco é o
      // que permite retomar a leitura depois, mas interromper um `build` no
      // meio deixaria o serviço parado sem ninguém para subi-lo.
      console.log(`\n${signal}: parando de aceitar pedidos.`);
      executor.server.close(() => process.exit(0));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  boot().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
