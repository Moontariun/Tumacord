// Atualizar o próprio servidor, pedido pelo painel.
//
// Esta é a ação mais perigosa do projeto: ela troca o código que está rodando.
// Por isso ela mora sozinha, num arquivo que faz só isso, e por isso tudo aqui
// é restritivo por padrão.
//
// **O que o frontend consegue mandar.** Uma etiqueta, e nada além disso. Não
// há caminho, branch, URL, argumento nem comando vindo do navegador em lugar
// nenhum deste arquivo. A etiqueta é conferida contra o formato do projeto e
// contra a lista que este servidor acabou de buscar no GitHub — e conferida de
// novo na hora de aplicar, porque a lista que o painel viu pode ter
// envelhecido.
//
// **O que roda.** Um script fixo, que já existe no repositório e já era o
// caminho de quem atualizava à mão: `scripts/update-server.sh`. Ele é chamado
// com `execFile` e uma lista de argumentos — nunca por shell, nunca com
// interpolação. Uma etiqueta com aspas, `;` ou `$(...)` não tem para onde
// escapar, e de todo modo não passa do `TAG_PATTERN`.
//
// **Quando roda.** Só com `TUMACORD_SELF_UPDATE=1`. O padrão é desligado, e é
// deliberado: um servidor que ganhou esta versão não passa a aceitar troca de
// código porque atualizou. Quem hospeda liga isso sabendo o que é.
//
// **Uma por vez.** Duas atualizações simultâneas fariam dois `git checkout` na
// mesma pasta. O estado abaixo é o portão.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TAG_PATTERN, installableTag, offeredReleases, type OfferedRelease } from '../shared/serverUpdate.js';

export interface SelfUpdateState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** A etiqueta da última tentativa. */
  tag: string;
  startedAt: string;
  finishedAt: string;
  /** As últimas linhas do script, para a tela dizer o que houve. */
  log: string;
}

export interface SelfUpdateConfig {
  enabled: boolean;
  repository: string;
  projectRoot: string;
  /** Quanto tempo o script pode demorar antes de ser interrompido. */
  timeoutMs: number;
}

/** Entre um minuto e uma hora. Um valor ilegível vira o mínimo, não `NaN`. */
function prazo(valor: unknown): number {
  const pedido = Number(valor ?? 20 * 60_000);
  if (!Number.isFinite(pedido)) return 60_000;
  return Math.min(60 * 60_000, Math.max(60_000, pedido));
}

export function selfUpdateConfig(env: NodeJS.ProcessEnv, projectRoot: string): SelfUpdateConfig {
  return {
    enabled: env.TUMACORD_SELF_UPDATE === '1',
    // O repositório é de quem hospeda, não de quem clica. Ele nunca chega pelo
    // pedido: um repositório escolhido no navegador seria escolher de onde vem
    // o código que vai rodar nesta máquina.
    repository: (env.TUMACORD_REPO ?? 'Moontariun/Tumacord').trim(),
    projectRoot,
    timeoutMs: prazo(env.TUMACORD_SELF_UPDATE_TIMEOUT_MS),
  };
}

/** Por que este servidor não pode se atualizar sozinho, quando não pode. */
export function unavailableReason(config: SelfUpdateConfig): string {
  if (!config.enabled) return 'A atualização pelo painel está desligada neste servidor. Quem hospeda liga com TUMACORD_SELF_UPDATE=1.';
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository)) return 'O repositório configurado em TUMACORD_REPO não tem a forma dono/projeto.';
  if (!existsSync(scriptPath(config))) return 'Este servidor não tem o scripts/update-server.sh: a imagem Docker carrega só o código compilado. Para atualizar pelo painel, o servidor precisa rodar a partir do clone do repositório.';
  // O script faz `git fetch` e `git checkout`. Sem repositório ele falharia no
  // meio — depois de já ter feito o backup —, e recusar antes é melhor do que
  // parar na metade.
  if (!existsSync(path.join(config.projectRoot, '.git'))) return 'A pasta deste servidor não é um clone do repositório, e a atualização depende de `git`.';
  return '';
}

function scriptPath(config: SelfUpdateConfig): string {
  return path.join(config.projectRoot, 'scripts', 'update-server.sh');
}

// A lista do GitHub, com uma janela curta de cache. Ela é buscada **pelo
// servidor**: o navegador nunca diz de onde a lista vem.
let cache: { at: number; releases: unknown } | null = null;
const CACHE_MS = 5 * 60_000;

export async function fetchReleases(config: SelfUpdateConfig, now = Date.now()): Promise<unknown> {
  if (cache && now - cache.at < CACHE_MS) return cache.releases;
  const resposta = await fetch(`https://api.github.com/repos/${config.repository}/releases?per_page=30`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'tumacord-server' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resposta.ok) throw new Error(`O GitHub respondeu ${resposta.status}.`);
  const releases = await resposta.json() as unknown;
  cache = { at: now, releases };
  return releases;
}

/** Só para os testes: esquecer o que foi buscado. */
export function forgetReleaseCache(): void {
  cache = null;
}

export class SelfUpdater {
  private state: SelfUpdateState = { status: 'idle', tag: '', startedAt: '', finishedAt: '', log: '' };

  constructor(private readonly config: SelfUpdateConfig) {}

  snapshot(): SelfUpdateState {
    return { ...this.state };
  }

  get running(): boolean {
    return this.state.status === 'running';
  }

  async offers(currentVersion: string): Promise<OfferedRelease[]> {
    return offeredReleases(await fetchReleases(this.config), currentVersion);
  }

  /**
   * Aplicar uma etiqueta.
   *
   * A conferência acontece aqui, de novo, contra uma lista buscada agora —
   * quem chama já conferiu contra a lista que mostrou, e essa pode ter
   * envelhecido. Duas conferências da mesma coisa não é desperdício quando a
   * segunda é a que decide o que roda na máquina.
   */
  async start(tag: string, currentVersion: string): Promise<{ ok: true; release: OfferedRelease } | { ok: false; error: string }> {
    const impedimento = unavailableReason(this.config);
    if (impedimento) return { ok: false, error: impedimento };
    if (this.running) return { ok: false, error: 'Já existe uma atualização em andamento.' };
    if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) return { ok: false, error: 'Versão inválida.' };

    let escolhida: OfferedRelease | null = null;
    try { escolhida = installableTag(offeredReleases(await fetchReleases(this.config), currentVersion), tag); }
    catch (erro) { return { ok: false, error: erro instanceof Error ? erro.message : 'Não consegui falar com o GitHub.' }; }
    if (!escolhida) return { ok: false, error: 'Essa versão não está publicada ou está marcada como retirada.' };

    this.state = { status: 'running', tag: escolhida.tag, startedAt: new Date().toISOString(), finishedAt: '', log: '' };
    // Nada de shell. O argumento vai como argumento, e o script é um caminho
    // absoluto conhecido — não um nome procurado no PATH.
    execFile('/usr/bin/env', ['bash', scriptPath(this.config), escolhida.tag], {
      cwd: this.config.projectRoot,
      timeout: this.config.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TUMACORD_REPO: this.config.repository },
    }, (erro, saida, erros) => {
      const texto = `${saida ?? ''}${erros ?? ''}`.trim().split('\n').slice(-40).join('\n');
      this.state = {
        ...this.state,
        status: erro ? 'error' : 'done',
        finishedAt: new Date().toISOString(),
        log: texto || (erro ? String(erro.message) : ''),
      };
    });
    return { ok: true, release: escolhida };
  }
}
