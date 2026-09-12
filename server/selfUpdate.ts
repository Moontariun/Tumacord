// Atualizar o próprio servidor, pedido pelo painel.
//
// Esta é a ação mais perigosa do projeto: ela troca o código que está rodando.
// Por isso ela mora sozinha, num arquivo que faz só isso, e por isso tudo aqui
// é restritivo por padrão.
//
// ## O que mudou na 0.9.9-1, e por quê
//
// Até a 0.9.9 este arquivo buscava a lista de versões em `api.github.com` e
// rodava `scripts/update-server.sh` **de dentro do contêiner**. As duas coisas
// eram erradas por motivos diferentes:
//
//   · a lista vinha de fora da instalação, e quem decide o que roda nesta
//     máquina é o dono dela, não um serviço de terceiro;
//   · um contêiner não reconstrói a si mesmo. O script parava o serviço que o
//     estava executando, e o que acontecia depois disso dependia de sorte.
//
// Agora este arquivo é um **cliente do executor**, que roda no host, fora do
// contêiner. Ele não executa nada: pede, e lê o que está acontecendo.
//
// ## O que o frontend consegue mandar
//
// Uma etiqueta, e nada além disso. Não há caminho, branch, URL, argumento nem
// comando vindo do navegador em lugar nenhum deste arquivo. A etiqueta é
// conferida contra o formato do projeto e contra o catálogo assinado que este
// servidor acabou de ler — e conferida de novo na hora de aplicar, porque a
// lista que o painel viu pode ter envelhecido.
//
// O que segue para o executor é o `releaseId` daquela entrada, e a referência
// de git é derivada **lá**, do manifesto assinado. Nem a etiqueta atravessa.
//
// ## Quando roda
//
// Só com `TUMACORD_SELF_UPDATE=1` e com o segredo do executor configurado. O
// padrão é desligado, e é deliberado: um servidor que ganhou esta versão não
// passa a aceitar troca de código porque atualizou.

import { timingSafeEqual } from 'node:crypto';
import { request as httpRequest, type RequestOptions } from 'node:http';
import path from 'node:path';
import { TAG_PATTERN, installableTag, offeredReleases, type OfferedRelease } from '../shared/serverUpdate.js';

export interface SelfUpdateState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** A etiqueta da última tentativa. */
  tag: string;
  startedAt: string;
  finishedAt: string;
  /** As últimas etapas do trabalho, para a tela dizer o que houve. */
  log: string;
  /** O trabalho no executor, para acompanhar depois de este processo reiniciar. */
  jobId: string;
}

export interface SelfUpdateConfig {
  enabled: boolean;
  /** O socket do executor, montado dentro do contêiner. Tem precedência sobre a URL. */
  socketPath: string;
  /** Onde o executor escuta quando não há socket. Sempre no laço local do host. */
  executorUrl: string;
  /** O segredo que o executor gerou na primeira subida. */
  executorToken: string;
  /** Quanto tempo uma chamada ao executor pode demorar. */
  timeoutMs: number;
}

/** O maior corpo de resposta lido do executor. Nada que ele devolve é grande. */
const MAX_RESPONSE = 1024 * 1024;

/**
 * Por quanto tempo um trabalho terminado ainda é mostrado depois de este
 * processo nascer. Uma aplicação reinicia justamente este servidor; sem esta
 * janela, o dono abriria o painel e não veria o desfecho do que acabou de pedir.
 */
const RECENT_MS = 30 * 60_000;

/** Entre um segundo e um minuto. Um valor ilegível vira o padrão, não `NaN`. */
function deadline(value: unknown): number {
  const asked = Number(value ?? 15_000);
  if (!Number.isFinite(asked)) return 15_000;
  return Math.min(60_000, Math.max(1_000, asked));
}

export function selfUpdateConfig(env: NodeJS.ProcessEnv): SelfUpdateConfig {
  return {
    enabled: env.TUMACORD_SELF_UPDATE === '1',
    // Os endereços são de quem hospeda, não de quem clica. Eles nunca chegam
    // pelo pedido: um endereço escolhido no navegador seria escolher quem
    // decide o código que vai rodar nesta máquina.
    socketPath: (env.TUMACORD_EXECUTOR_SOCKET ?? '').trim(),
    executorUrl: (env.TUMACORD_EXECUTOR_URL ?? 'http://127.0.0.1:4302').trim().replace(/\/+$/, ''),
    executorToken: (env.TUMACORD_EXECUTOR_TOKEN ?? '').trim(),
    timeoutMs: deadline(env.TUMACORD_EXECUTOR_TIMEOUT_MS),
  };
}

/** Por que este servidor não pode se atualizar sozinho, quando não pode. */
export function unavailableReason(config: SelfUpdateConfig): string {
  if (!config.enabled) return 'A atualização pelo painel está desligada neste servidor. Quem hospeda liga com TUMACORD_SELF_UPDATE=1.';
  if (!config.executorToken) {
    return 'Falta o segredo do executor (TUMACORD_EXECUTOR_TOKEN). Ele é gerado na primeira subida do executor, '
      + 'em /var/lib/tumacord/executor/executor.token, e não é impresso no log.';
  }
  if (config.socketPath) {
    return path.isAbsolute(config.socketPath) ? '' : 'TUMACORD_EXECUTOR_SOCKET precisa ser um caminho absoluto.';
  }
  let parsed: URL;
  try { parsed = new URL(config.executorUrl); } catch { return 'TUMACORD_EXECUTOR_URL não é uma URL.'; }
  if (parsed.protocol !== 'http:') return 'TUMACORD_EXECUTOR_URL precisa ser http: o executor só escuta no laço local.';
  // O executor troca a versão do servidor. Alcançá-lo pela rede é um jeito de
  // outra pessoa trocar a sua, e nenhum segredo compensa expor isso.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    return `TUMACORD_EXECUTOR_URL aponta para ${parsed.hostname}, que não é o host local. O executor não é alcançado pela rede.`;
  }
  return '';
}

/**
 * Se quem pede é o executor.
 *
 * Ele precisa pausar a escrita antes da cópia que antecede cada aplicação, e
 * não tem — nem deve ter — uma sessão de dono: uma sessão expira em dias, e a
 * cópia pararia de funcionar sem ninguém perceber até a hora de restaurar.
 */
export function executorTokenMatches(config: SelfUpdateConfig, authorization: unknown): boolean {
  const expected = Buffer.from(config.executorToken);
  if (!expected.length) return false;
  const found = /^Bearer\s+(\S+)$/i.exec(String(authorization ?? ''));
  const offered = Buffer.from(found ? found[1] : '');
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}

/**
 * Uma chamada ao executor.
 *
 * `node:http` e não `fetch`: é ele que fala com um socket Unix. E ele não segue
 * redirecionamento, então nada leva o segredo para outro lugar.
 */
function callExecutor(
  config: SelfUpdateConfig,
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    let target: RequestOptions;
    if (config.socketPath) {
      target = { socketPath: config.socketPath, path: route };
    } else {
      const url = new URL(config.executorUrl);
      target = { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), path: route };
    }

    const call = httpRequest({
      ...target,
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${config.executorToken}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          response.destroy(new Error('resposta grande demais'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          body = text ? JSON.parse(text) as Record<string, unknown> : {};
        } catch {
          body = {};
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    call.setTimeout(config.timeoutMs, () => call.destroy(new Error('timeout')));
    call.on('error', reject);
    if (payload !== undefined) call.write(payload);
    call.end();
  });
}

/** O que dizer quando o executor não respondeu, sem repetir o erro cru. */
function unreachable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|abort/i.test(message)) return 'O executor não respondeu no prazo.';
  return 'Não consegui falar com o executor. Ele está de pé? `systemctl status tumacord-executor`.';
}

/** As etapas de um trabalho, resumidas para caber na tela. */
function summarize(job: Record<string, unknown>): string {
  const steps = Array.isArray(job.steps) ? job.steps as { name?: unknown; state?: unknown; detail?: unknown }[] : [];
  return steps
    .map((step) => {
      const mark = step.state === 'failed' ? '×' : step.state === 'ok' ? '·' : step.state === 'skipped' ? '-' : '…';
      return `${mark} ${String(step.name ?? '')}${step.detail ? `: ${String(step.detail)}` : ''}`;
    })
    .slice(-8)
    .join('\n');
}

/** Se um trabalho ainda interessa a quem abre o painel agora. */
function isRecent(job: Record<string, unknown>, now: number): boolean {
  if (job.state === 'running' || job.state === 'queued') return true;
  const finished = Date.parse(String(job.finishedAt ?? ''));
  return Number.isFinite(finished) && now - finished <= RECENT_MS;
}

/** O estado do painel, a partir de um trabalho do executor. */
function stateFromJob(job: Record<string, unknown>, previous: SelfUpdateState): SelfUpdateState {
  const input = (job.input ?? {}) as Record<string, unknown>;
  const jobState = String(job.state ?? '');
  const version = typeof input.version === 'string' ? input.version : '';
  return {
    status: jobState === 'succeeded' ? 'done' : jobState === 'failed' || jobState === 'cancelled' ? 'error' : 'running',
    tag: version ? `v${version}` : previous.tag,
    startedAt: typeof job.createdAt === 'string' ? job.createdAt : previous.startedAt,
    finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : '',
    log: [summarize(job), typeof job.error === 'string' ? job.error : ''].filter(Boolean).join('\n'),
    jobId: typeof job.id === 'string' ? job.id : previous.jobId,
  };
}

export class SelfUpdater {
  private state: SelfUpdateState = { status: 'idle', tag: '', startedAt: '', finishedAt: '', log: '', jobId: '' };

  constructor(private readonly config: SelfUpdateConfig) {}

  snapshot(): SelfUpdateState {
    return { ...this.state };
  }

  get running(): boolean {
    return this.state.status === 'running';
  }

  /**
   * As versões que este servidor pode aplicar.
   *
   * Elas vêm do catálogo assinado que o executor lê do serviço local — e não
   * de um serviço na internet.
   */
  async offers(currentVersion: string): Promise<OfferedRelease[]> {
    const { status, body } = await callExecutor(this.config, '/v1/state');
    if (status === 401) throw new Error('O executor recusou o segredo configurado (TUMACORD_EXECUTOR_TOKEN).');
    if (status !== 200) throw new Error(String(body.error ?? 'O executor não devolveu o estado.'));
    return offeredReleases(body.catalog, currentVersion);
  }

  /**
   * Lê de novo o trabalho em andamento, ou o último que terminou há pouco.
   *
   * O estado vive no executor, e não aqui: reiniciar o servidor no meio de uma
   * aplicação é o caso **esperado** — é ele que está sendo trocado. Quem abrir
   * o painel depois encontra o trabalho onde ele parou.
   */
  async refresh(now = Date.now()): Promise<SelfUpdateState> {
    if (unavailableReason(this.config)) return this.snapshot();
    try {
      let job: Record<string, unknown> | null = null;
      if (this.state.jobId) {
        const { status, body } = await callExecutor(this.config, `/v1/jobs/${encodeURIComponent(this.state.jobId)}`);
        if (status === 200) job = body;
      } else {
        const { status, body } = await callExecutor(this.config, '/v1/jobs');
        const jobs = status === 200 && Array.isArray(body.jobs) ? body.jobs as Record<string, unknown>[] : [];
        // A lista vem da mais nova para a mais antiga: a primeira aplicação
        // recente é a que trocou este processo, se alguma trocou.
        job = jobs.find((candidate) => candidate.kind === 'server-apply' && isRecent(candidate, now)) ?? null;
      }
      if (job) this.state = stateFromJob(job, this.state);
    } catch {
      // Não falar com o executor não é motivo para declarar que falhou: o
      // servidor pode estar justamente reiniciando por causa dele.
    }
    return this.snapshot();
  }

  /**
   * Aplicar uma etiqueta.
   *
   * A conferência acontece aqui, de novo, contra a lista lida agora — quem
   * chama já conferiu contra a lista que mostrou, e essa pode ter envelhecido.
   * Duas conferências da mesma coisa não é desperdício quando a segunda é a
   * que decide o que roda na máquina.
   */
  async start(tag: string, currentVersion: string): Promise<{ ok: true; release: OfferedRelease } | { ok: false; error: string }> {
    const blocked = unavailableReason(this.config);
    if (blocked) return { ok: false, error: blocked };
    if (this.running) return { ok: false, error: 'Já existe uma atualização em andamento.' };
    // A forma é conferida antes de qualquer conversa com o executor: uma
    // etiqueta malformada não gera nem uma consulta.
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) return { ok: false, error: 'Versão inválida.' };

    let chosen: OfferedRelease | null = null;
    try {
      chosen = installableTag(await this.offers(currentVersion), tag);
    } catch (error) {
      return { ok: false, error: error instanceof Error && !/ECONNREFUSED|ENOENT|EACCES|timeout/i.test(error.message) ? error.message : unreachable(error) };
    }
    if (!chosen) return { ok: false, error: 'Essa versão não está publicada no catálogo deste servidor ou está marcada como retirada.' };

    let response: { status: number; body: Record<string, unknown> };
    try {
      // Só o identificador atravessa. A referência de git é derivada no
      // executor, do manifesto assinado daquela release.
      response = await callExecutor(this.config, '/v1/apply', { method: 'POST', body: { releaseId: chosen.releaseId } });
    } catch (error) {
      return { ok: false, error: unreachable(error) };
    }
    if (response.status !== 202 && response.status !== 200) {
      return { ok: false, error: String(response.body.error ?? `O executor recusou: ${response.status}.`) };
    }

    this.state = {
      status: 'running',
      tag: chosen.tag,
      startedAt: new Date().toISOString(),
      finishedAt: '',
      log: '',
      jobId: typeof response.body.jobId === 'string' ? response.body.jobId : '',
    };
    return { ok: true, release: chosen };
  }
}
