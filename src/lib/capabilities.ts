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
//
// "Não respondeu" é outra coisa, e por muito tempo terminava no mesmo lugar.
// Um `/api/health` que falha — servidor ocupado, rede engasgada, a máquina
// inteira sob carga — produzia um objeto com nenhuma capability, idêntico ao
// de um servidor velho. A pessoa lia "este servidor ainda não tem
// gerenciamento de canais" no meio de uma sessão em que acabara de usá-lo.
// Por isso `status`: só um servidor que respondeu pode ser dito incompleto.

export type Capability = 'turn' | 'roles' | 'adminChannels' | 'adminUsers' | 'adminAudit' | 'mediaDiagnostics';

export interface ServerCapabilities {
  version: string;
  capabilities: Partial<Record<Capability, boolean>>;
  /** `known` só quando o servidor respondeu algo interpretável. */
  status: 'known' | 'unknown';
}

export const UNKNOWN_CAPABILITIES: ServerCapabilities = { version: '', capabilities: {}, status: 'unknown' };

const NOMES: Record<Capability, string> = {
  turn: 'relay TURN',
  roles: 'papéis de servidor',
  adminChannels: 'gerenciamento de canais',
  adminUsers: 'gerenciamento de usuários',
  adminAudit: 'registro de auditoria',
  mediaDiagnostics: 'diagnóstico de mídia',
};

export function readCapabilities(health: unknown): ServerCapabilities {
  if (!health || typeof health !== 'object') return UNKNOWN_CAPABILITIES;
  const corpo = health as { version?: unknown; capabilities?: unknown };
  const bruto = (corpo.capabilities && typeof corpo.capabilities === 'object' ? corpo.capabilities : {}) as Record<string, unknown>;
  const capabilities: Partial<Record<Capability, boolean>> = {};
  for (const chave of Object.keys(NOMES) as Capability[]) {
    if (typeof bruto[chave] === 'boolean') capabilities[chave] = bruto[chave] as boolean;
  }
  return { version: typeof corpo.version === 'string' ? corpo.version : '', capabilities, status: 'known' };
}

// Uma consulta que falhou não derruba o que a anterior já tinha estabelecido.
// O que este servidor sabe fazer não muda enquanto ele é o mesmo servidor.
export function mergeCapabilities(previous: ServerCapabilities | null, next: ServerCapabilities): ServerCapabilities {
  if (next.status === 'known') return next;
  return previous?.status === 'known' ? previous : UNKNOWN_CAPABILITIES;
}

export function supports(server: ServerCapabilities, capability: Capability): boolean {
  return server.capabilities[capability] === true;
}

// Só um servidor que respondeu pode ter algo declarado como faltando. Sem
// resposta não há lista: não saber é diferente de saber que não tem.
export function missingCapabilities(server: ServerCapabilities, required: readonly Capability[]): Capability[] {
  if (server.status !== 'known') return [];
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
