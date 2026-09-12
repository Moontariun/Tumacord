// Os trabalhos do executor: aplicar uma release, voltar atrás, copiar dados.
//
// ## Por que um trabalho tem estado em disco
//
// Um deploy para o servidor que o executor precisa observar depois. Se o
// estado do trabalho vivesse na memória do processo, reiniciar o executor no
// meio — ou o painel perder o socket — faria o trabalho sumir sem desfecho: a
// pessoa não saberia se ele terminou, e a próxima tentativa repetiria uma
// migração que já rodou.
//
// Aqui cada trabalho tem id, etapas, e um estado que sobrevive ao processo.
//
// ## O lock
//
// Ele é adquirido **antes do primeiro `await`**, e é um arquivo criado com
// `wx` — a exclusividade é do sistema de arquivos, não de uma verificação
// nossa. Dois processos que tentem ao mesmo tempo: um cria, o outro recebe
// `EEXIST`. Um duplo clique não lança dois deploys, e nem dois executores.
//
// O lock guarda o PID e o instante. Um lock de um processo que morreu é
// **dito**, e não ignorado: quem opera decide se aquele trabalho terminou.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** As fases de um trabalho. Cada uma é um ponto de retomada. */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

/** Quanto tempo um lock é considerado vivo sem sinal do dono. */
export const LOCK_STALE_MS = 60 * 60 * 1000;

export class JobStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.jobsDir = path.join(this.directory, 'jobs');
    this.lockFile = path.join(this.directory, 'executor.lock');
  }

  async init() {
    await mkdir(this.jobsDir, { recursive: true });
  }

  /**
   * Toma o lock, ou diz quem o tem.
   *
   * `openSync` com `wx` falha quando o arquivo existe. Isso é o ponto: a
   * exclusão é do sistema de arquivos e vale entre processos, inclusive entre
   * o executor e alguém rodando o comando à mão.
   *
   * **Síncrono de propósito.** Um `await` entre conferir e criar abriria
   * justamente a janela que o lock existe para fechar.
   */
  acquireLock({ owner = 'tumacordctl', now = Date.now(), pid = process.pid } = {}) {
    try {
      const handle = openSync(this.lockFile, 'wx');
      closeSync(handle);
      writeFileSync(this.lockFile, `${JSON.stringify({ owner, pid, at: new Date(now).toISOString() }, null, 2)}\n`);
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: 'error', error: String(error?.message ?? error) };
      let held = {};
      try { held = JSON.parse(readFileSync(this.lockFile, 'utf8')); } catch { /* lock ilegível */ }
      const age = now - Date.parse(held.at ?? '') || 0;
      const alive = held.pid ? processIsAlive(held.pid) : false;
      return {
        ok: false,
        reason: alive ? 'held' : 'stale',
        holder: held,
        // Um lock órfão é **dito**, e não removido sozinho: o trabalho dele
        // pode ter parado no meio de uma migração, e assumir que terminou é o
        // jeito de rodar a migração duas vezes.
        error: alive
          ? `Já há uma operação em andamento (pid ${held.pid}, desde ${held.at}).`
          : `Há um lock de um processo que não existe mais (pid ${held.pid}, desde ${held.at}${Number.isFinite(age) ? `, ${Math.round(age / 60000)} min` : ''}). `
            + 'Confira se aquele trabalho terminou — `tumacordctl jobs status` — e libere com --force-unlock se for o caso.',
      };
    }
  }

  async releaseLock() {
    await rm(this.lockFile, { force: true });
  }

  /**
   * Cria um trabalho.
   *
   * `key` torna a criação **idempotente**: o mesmo pedido, repetido, devolve o
   * trabalho que já existe em vez de criar outro. Um duplo clique no painel e
   * um retry de rede são o mesmo pedido.
   */
  async create({ kind, key, input, now = Date.now() }) {
    const existing = key ? await this.findByKey(key) : null;
    if (existing) return { job: existing, created: false };
    const job = {
      id: randomUUID(),
      kind,
      key: key ?? '',
      state: 'queued',
      input: sanitizeInput(input),
      steps: [],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      error: '',
    };
    await this.write(job);
    return { job, created: true };
  }

  async findByKey(key) {
    for (const job of await this.list()) {
      if (job.key === key && (job.state === 'queued' || job.state === 'running')) return job;
      // Um trabalho que já terminou com sucesso, sob a mesma chave, também
      // responde: repetir um deploy concluído não deve refazê-lo.
      if (job.key === key && job.state === 'succeeded') return job;
    }
    return null;
  }

  async read(id) {
    try {
      return JSON.parse(await readFile(path.join(this.jobsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async list() {
    let names = [];
    try { names = await readdir(this.jobsDir); } catch { return []; }
    const jobs = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try { jobs.push(JSON.parse(await readFile(path.join(this.jobsDir, name), 'utf8'))); } catch { /* trabalho ilegível */ }
    }
    return jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  /** Grava o trabalho de forma atômica: ninguém lê meio arquivo. */
  async write(job) {
    const target = path.join(this.jobsDir, `${job.id}.json`);
    const temporary = `${target}.next`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return job;
  }

  /**
   * Registra uma etapa.
   *
   * O log é sanitizado antes de entrar: um trabalho é lido pelo painel, é
   * colado num relato, e às vezes é enviado ao suporte. Um token no meio dele
   * vaza nos três.
   */
  async step(job, { name, state, detail = '', now = Date.now() }) {
    const next = {
      ...job,
      state: state === 'failed' ? 'failed' : job.state === 'queued' ? 'running' : job.state,
      updatedAt: new Date(now).toISOString(),
      steps: [...job.steps, { name, state, detail: sanitizeLog(detail), at: new Date(now).toISOString() }],
    };
    return this.write(next);
  }

  async finish(job, { state, error = '', result = null, now = Date.now() }) {
    return this.write({
      ...job,
      state,
      error: sanitizeLog(error),
      result: result ? sanitizeInput(result) : null,
      updatedAt: new Date(now).toISOString(),
      finishedAt: new Date(now).toISOString(),
    });
  }
}

function processIsAlive(pid) {
  try {
    // Sinal 0 não envia nada: só pergunta se o processo existe e é alcançável.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Nada de segredo no que é gravado ou impresso. */
export function sanitizeLog(text) {
  return String(text ?? '')
    // Um token de portador no meio de um log vira acesso para quem lê o log.
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\b(token|convite|invite|secret|segredo|password|senha)\b\s*[:=]\s*\S+/gi, '$1: ***')
    // Caractere de controle sai: um `\r` no meio de uma linha de log esconde
    // o que vem depois dela, e é assim que se apaga a própria pegada.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 4000);
}

/** O mesmo cuidado para o que entra no trabalho. */
export function sanitizeInput(input) {
  if (!input || typeof input !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|convite|invite|secret|segredo|password|senha/i.test(key)) continue;
    clean[key] = typeof value === 'string' ? sanitizeLog(value) : value;
  }
  return clean;
}

/**
 * As etapas de uma aplicação de release, na ordem em que precisam acontecer.
 *
 * Esta lista é o contrato: cada uma precisa terminar antes da seguinte, e o
 * sucesso só é marcado depois da última. Um deploy que "deu certo" sem validar
 * a versão é o que fazia uma atualização parecer aplicada sem ter acontecido.
 */
export const APPLY_STEPS = [
  'preflight',
  'backup',
  'record-deployment',
  'fetch-ref',
  // `up -d --build` constrói, para e sobe numa operação só. Listar parar e
  // subir como etapas separadas prometia um registro que nenhum trabalho
  // produzia.
  'build',
  'validate',
];

/** As da volta atrás. Ela não refaz backup: o que existe já é o ponto. */
export const ROLLBACK_STEPS = ['checkout-previous', 'build', 'validate'];
