// A inscrição numa live: quem quis assistir o quê, e o que ainda precisa ser
// pedido.
//
// Isto existe separado do hook de voz porque é a parte que erra em silêncio.
// Quando ela erra, ninguém vê uma exceção: vê uma tela preta que não volta, ou
// — pior — vê a tela de alguém chegando sem ter pedido.
//
// ## O defeito que esta camada corrige
//
// Até a 0.9.9 o `rtc:watch` era emitido **uma vez**, no clique em "Assistir".
// Do lado de quem transmite, o consentimento morava no estado do enlace
// (`watchingStream`), e todo enlace refeito nasce com esse campo vazio:
// recuperação forçada, troca de host no P2P, reconexão. A partir daí a tela
// deixava de ser anexada e nada reemitia o pedido.
//
// O resultado era um ciclo que se alimentava: sem faixa de vídeo, o detector
// de travamento pedia outra recuperação vinte segundos depois; a recuperação
// refazia o enlace; o enlace nascia sem inscrição. Reabrir o aplicativo era a
// única saída, porque só isso levava a pessoa a clicar em "Assistir" de novo.
// No P2P batia mais porque a troca de host reconstrói todos os enlaces.
//
// A correção é separar **intenção** de **inscrição**. A intenção é da pessoa e
// sobrevive ao enlace; a inscrição é o que o outro lado sabe, e é reafirmada
// sempre que o enlace pode tê-la perdido.

/** A qual transmissão esta pessoa disse sim, por peer. */
export type WatchIntent = Readonly<Record<string, string>>;

export interface WatchRequest {
  peerId: string;
  streamId: string;
}

/**
 * Os pedidos que ainda precisam sair.
 *
 * `sent` é o que já foi pedido na geração atual de cada enlace — ele é zerado
 * quando o enlace é reconstruído, e é isso que faz o pedido sair de novo. Um
 * peer que não está mais conectado não recebe pedido: a intenção continua
 * guardada e será reafirmada quando o enlace voltar.
 */
export function pendingWatchRequests(
  intent: WatchIntent,
  sent: ReadonlyMap<string, string>,
  connectedPeers: ReadonlySet<string>,
): WatchRequest[] {
  const pedidos: WatchRequest[] = [];
  for (const [peerId, streamId] of Object.entries(intent)) {
    if (!streamId || !connectedPeers.has(peerId)) continue;
    if (sent.get(peerId) === streamId) continue;
    pedidos.push({ peerId, streamId });
  }
  return pedidos;
}

/**
 * A intenção depois de um anúncio de transmissão.
 *
 * Reconectar à **mesma** live restaura a intenção válida: o anúncio traz o
 * mesmo id e nada muda. Uma live **nova** da mesma pessoa traz outro id, e
 * exige uma escolha nova — ninguém consente com uma tela que ainda não
 * existia quando disse sim.
 */
export function intentAfterAnnouncement(intent: WatchIntent, peerId: string, announcedStreamId: string): WatchIntent {
  const atual = intent[peerId];
  if (!atual || !announcedStreamId || atual === announcedStreamId) return intent;
  const proximo = { ...intent };
  delete proximo[peerId];
  return proximo;
}

/**
 * A intenção depois da lista de quem está transmitindo.
 *
 * Quem parou de transmitir deixa de ter inscrição. Sem isso o "sim" ficaria
 * pendurado e a próxima live daquela pessoa começaria já assistida.
 */
export function intentAfterBroadcasters(intent: WatchIntent, broadcasting: ReadonlySet<string>): WatchIntent {
  const orfas = Object.keys(intent).filter((peerId) => !broadcasting.has(peerId));
  if (!orfas.length) return intent;
  const proximo = { ...intent };
  for (const peerId of orfas) delete proximo[peerId];
  return proximo;
}

/**
 * Se as faixas de uma mídia local pertencem ao enlace de um peer.
 *
 * A tela é a única mídia condicionada: ela só entra no enlace de quem assinou
 * **aquela** transmissão. Microfone e câmera pertencem à call e vão para todo
 * mundo que está nela.
 *
 * Sem esta condição, a reconciliação periódica tratava a live como qualquer
 * outra faixa local — encaixava a tela em qualquer sender de vídeo livre do
 * peer, inclusive o de quem nunca pediu para assistir, e dez segundos depois
 * de alguém fechar a live devolvia a faixa ao sender esvaziado, desfazendo em
 * silêncio o "parar de assistir".
 */
export function mediaBelongsToPeer(media: string, streamId: string, watchingStream: string): boolean {
  if (media !== 'screen') return true;
  return Boolean(watchingStream) && watchingStream === streamId;
}
