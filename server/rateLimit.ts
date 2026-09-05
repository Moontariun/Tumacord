// Limite de tentativas de autenticação.
//
// Medido no servidor atual: doze senhas erradas seguidas levaram 595 ms e
// nenhuma delas encontrou barreira. A chave de acesso segura um estranho na
// porta, mas ela é a mesma para o grupo inteiro — quem já a tem pode tentar a
// senha dos outros sem limite nenhum.
//
// A contagem é por par (usuário, origem): limitar só por IP deixaria um NAT
// compartilhado punir inocentes, e limitar só por usuário permitiria distribuir
// as tentativas entre várias máquinas.
//
// Estado em memória, de propósito: reiniciar o servidor limpa a contagem, e
// isso é aceitável para o que se defende aqui. Persistir traria um arquivo a
// mais para manter consistente sem ganho proporcional.

export interface AttemptOutcome {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export const FREE_ATTEMPTS = 5;
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 5 * 60_000;
export const ATTEMPT_WINDOW_MS = 15 * 60_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 5_000) {}

  private key(identity: string, origin: string): string {
    return `${identity.toLowerCase()}|${origin}`;
  }

  // Um bloqueio que cresce sozinho: cinco tentativas livres, depois o dobro do
  // tempo a cada erro, com teto. Quem digitou errado espera segundos; quem
  // está varrendo senhas espera minutos por tentativa.
  check(identity: string, origin: string, now = Date.now()): AttemptOutcome {
    const entry = this.entries.get(this.key(identity, origin));
    if (!entry) return { allowed: true, retryAfterMs: 0, remaining: FREE_ATTEMPTS };
    if (now - entry.lastFailureAt > ATTEMPT_WINDOW_MS) return { allowed: true, retryAfterMs: 0, remaining: FREE_ATTEMPTS };
    if (entry.blockedUntil > now) return { allowed: false, retryAfterMs: entry.blockedUntil - now, remaining: 0 };
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, FREE_ATTEMPTS - entry.failures) };
  }

  fail(identity: string, origin: string, now = Date.now()): AttemptOutcome {
    const key = this.key(identity, origin);
    const previous = this.entries.get(key);
    const stale = previous && now - previous.lastFailureAt > ATTEMPT_WINDOW_MS;
    const failures = (stale || !previous ? 0 : previous.failures) + 1;
    const excess = failures - FREE_ATTEMPTS;
    const delay = excess <= 0 ? 0 : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** (excess - 1)));
    this.entries.set(key, { failures, blockedUntil: now + delay, lastFailureAt: now });
    this.prune(now);
    return { allowed: delay === 0, retryAfterMs: delay, remaining: Math.max(0, FREE_ATTEMPTS - failures) };
  }

  // Acertar a senha zera a contagem: o objetivo é atrapalhar quem chuta, não
  // quem errou uma vez e lembrou depois.
  succeed(identity: string, origin: string): void {
    this.entries.delete(this.key(identity, origin));
  }

  private prune(now: number): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastFailureAt > ATTEMPT_WINDOW_MS) this.entries.delete(key);
    }
    // Ainda cheio depois da limpeza: descarta as entradas mais antigas para o
    // mapa não virar um vetor de memória.
    if (this.entries.size <= this.maxEntries) return;
    const ordered = [...this.entries].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt);
    for (const [key] of ordered.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
