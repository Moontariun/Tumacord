// A identidade de um destino.
//
// Duas coisas precisam saber separar um lugar do outro: o que este computador
// guarda (histórico, anexos, perfis) e o que ele lembra (sessão, chave). As
// duas usam esta função, e de propósito — se elas divergissem, a conversa de
// um servidor poderia ficar guardada sob uma identidade e a credencial dele
// sob outra.
//
// O que **não** serve como identidade, e o projeto já aprendeu isso:
//
// - **nome do servidor**, porque dois podem se chamar "Tumacord";
// - **apelido**, porque muda;
// - **o literal "p2p"**, porque todo grupo P2P cairia no mesmo lugar;
// - **endereço**, porque um servidor muda de casa e um IP é reaproveitado.
//
// O dedicado declara um `installationId` que nasce na primeira subida e não
// muda mais. O grupo P2P é identificado pela chave do convite, que é o que
// continua igual quando o host troca de máquina — o host é quem hospeda agora,
// não é o grupo.

export interface DestinationInput {
  connectionMode?: 'p2p' | 'server';
  /** Identidade declarada pelo servidor dedicado em `/api/health`. */
  installationId?: string;
  serverUrl?: string;
  /** Chave do convite do grupo, no P2P. */
  inviteKey?: string;
}

export function originFor(input: DestinationInput): string {
  if (input.connectionMode === 'server') {
    const identidade = (input.installationId ?? '').trim();
    // Sem identidade declarada — servidor anterior à 0.9.5 —, o endereço é o
    // que resta. Ele separa pior (muda quando o servidor muda de casa) e ainda
    // assim separa dois servidores diferentes, que é o que importa aqui.
    return identidade ? `servidor:${identidade}` : `endereco:${(input.serverUrl ?? '').trim().toLowerCase().replace(/\/$/, '')}`;
  }
  const chave = (input.inviteKey ?? '').trim();
  return chave ? `grupo:${chave.slice(0, 64)}` : 'grupo:rede-local';
}

/** Como o destino se apresenta para quem está escolhendo entre eles. */
export function describeOrigin(origin: string, serverName = ''): string {
  if (origin === 'grupo:rede-local') return 'Grupo na rede local';
  if (origin.startsWith('grupo:')) return serverName ? `Grupo de ${serverName}` : 'Grupo por convite';
  return serverName || 'Servidor dedicado';
}
