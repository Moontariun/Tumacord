// O que o servidor do outro lado sabe fazer.
//
// Comparar versão como texto responde a pergunta errada. "0.8.1" contra
// "0.8.0" diz qual é mais nova, não se aquele servidor tem painel de canais —
// e uma instalação que ficou parada, ou um fork, quebra a suposição na hora.
// Perguntar o que ele sabe fazer é a pergunta certa.
//
// Servidor anterior à 0.8.1 não responde `capabilities`. A ausência é tratada
// como "não tem", que é a leitura segura: o cliente esconde o que não
// funcionaria e diz o motivo, em vez de deixar a pessoa apertar um botão e
// receber um erro sem explicação.

export type Capability = 'turn' | 'roles' | 'adminChannels' | 'adminUsers' | 'adminAudit' | 'mediaDiagnostics';

export interface ServerCapabilities {
  version: string;
  capabilities: Partial<Record<Capability, boolean>>;
}

const NOMES: Record<Capability, string> = {
  turn: 'relay TURN',
  roles: 'papéis de servidor',
  adminChannels: 'gerenciamento de canais',
  adminUsers: 'gerenciamento de usuários',
  adminAudit: 'registro de auditoria',
  mediaDiagnostics: 'diagnóstico de mídia',
};

export function readCapabilities(health: unknown): ServerCapabilities {
  const corpo = (health ?? {}) as { version?: unknown; capabilities?: unknown };
  const bruto = (corpo.capabilities ?? {}) as Record<string, unknown>;
  const capabilities: Partial<Record<Capability, boolean>> = {};
  for (const chave of Object.keys(NOMES) as Capability[]) {
    if (typeof bruto[chave] === 'boolean') capabilities[chave] = bruto[chave] as boolean;
  }
  return { version: typeof corpo.version === 'string' ? corpo.version : '', capabilities };
}

export function supports(server: ServerCapabilities, capability: Capability): boolean {
  return server.capabilities[capability] === true;
}

export function missingCapabilities(server: ServerCapabilities, required: readonly Capability[]): Capability[] {
  return required.filter((capability) => !supports(server, capability));
}

// A mensagem diz o que falta e o que fazer, sem pedir para a pessoa comparar
// números de versão.
export function describeMissing(server: ServerCapabilities, required: readonly Capability[]): string {
  const faltando = missingCapabilities(server, required);
  if (!faltando.length) return '';
  const lista = faltando.map((capability) => NOMES[capability]);
  const nomes = lista.length === 1 ? lista[0] : `${lista.slice(0, -1).join(', ')} e ${lista.at(-1)}`;
  const versao = server.version ? ` Ele está na ${server.version}.` : '';
  return `Este servidor ainda não tem ${nomes}.${versao} Atualize o servidor para usar isso aqui.`;
}
