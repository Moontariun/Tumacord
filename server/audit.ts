// Registro de ações administrativas.
//
// Serve para responder "quem apagou o canal" sem transformar o servidor em um
// gravador. Por isso ele guarda o que foi feito e em quê — nunca o conteúdo
// da conversa, nem nada que dê acesso.
//
// A redação não é confiada à disciplina de quem escreve a chamada: tudo que
// entra passa por um filtro que corta o que parece segredo. Um campo novo
// adicionado com pressa amanhã não vaza uma chave por esquecimento.

export type AuditResult = 'ok' | 'denied' | 'error';

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorUsername: string;
  action: string;
  target?: string;
  result: AuditResult;
  detail?: string;
}

export const MAX_AUDIT_ENTRIES = 500;
export const MAX_DETAIL = 160;

const SEGREDOS = [
  /\bbearer\s+\S+/gi,
  /\bTUMA1\.[A-Za-z0-9_-]+\.[a-z0-9]+/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
  /\b(?:token|senha|password|secret|chave|key|credential)s?\s*[:=]\s*\S+/gi,
];

// Corta o que parece segredo antes de guardar. Prefere apagar demais a deixar
// passar: um detalhe truncado ainda explica a ação, uma chave vazada não tem
// volta.
export function redactDetail(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let texto = value.trim();
  for (const padrao of SEGREDOS) texto = texto.replace(padrao, '[removido]');
  return texto.slice(0, MAX_DETAIL);
}

export function createAuditEntry(input: {
  id: string;
  actorId: string;
  actorUsername: string;
  action: string;
  target?: string;
  result?: AuditResult;
  detail?: unknown;
  at?: Date;
}): AuditEntry {
  return {
    id: input.id,
    at: (input.at ?? new Date()).toISOString(),
    actorId: input.actorId,
    actorUsername: input.actorUsername.slice(0, 24),
    action: input.action.slice(0, 48),
    ...(input.target ? { target: input.target.slice(0, 80) } : {}),
    result: input.result ?? 'ok',
    ...(redactDetail(input.detail) ? { detail: redactDetail(input.detail) } : {}),
  };
}

// O registro é uma janela, não um arquivo eterno: ele não pode crescer sem
// limite dentro do mesmo JSON que guarda as mensagens.
export function appendAudit(entries: readonly AuditEntry[], entry: AuditEntry, limit = MAX_AUDIT_ENTRIES): AuditEntry[] {
  return [entry, ...entries].slice(0, limit);
}
