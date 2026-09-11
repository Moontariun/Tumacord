// O que acontece com uma mensagem depois de enviada.
//
// Editar e apagar são as duas coisas que uma mensagem ainda pode sofrer, e as
// duas precisam atravessar a replicação do P2P — onde não há um servidor que
// decida, e sim várias cópias que se encontram quando o host troca de máquina.
//
// O merge de antes olhava só o `id`: **quem já conhecia a mensagem ignorava a
// que chegava**. Isso bastava enquanto uma mensagem era imutável. Com edição e
// exclusão ele vira o pior comportamento possível: quem apagou vê a mensagem
// voltar no primeiro `chat:sync:push` de alguém que ainda tinha a cópia antiga,
// e uma edição nunca alcança quem já tinha lido o original.
//
// A regra mínima que converge é uma revisão por mensagem: **quem tem mais
// revisão vence**. Apagar é uma revisão como qualquer outra, e é por isso que
// ela tem prioridade de verdade — não por ser tratada à parte, mas por ser
// sempre mais nova do que a cópia que alguém guardou.
//
// A lápide fica no lugar do conteúdo, e isso não é detalhe. Sem ela não há como
// distinguir "esta mensagem foi apagada" de "esta mensagem eu ainda não
// recebi", e é a segunda leitura que ressuscita o que alguém apagou. O que a
// lápide **não** guarda é o texto nem o anexo: apagar é apagar.

import type { ChatMessage } from './types.js';

export const MAX_MESSAGE_BODY = 2000;

/** Quantas vezes esta mensagem mudou. Quem não declara está na primeira. */
export function revisionOf(message: Pick<ChatMessage, 'revision'>): number {
  const valor = message.revision;
  return Number.isInteger(valor) && (valor as number) > 0 ? (valor as number) : 0;
}

export function isDeleted(message: Pick<ChatMessage, 'deletedAt'>): boolean {
  return typeof message.deletedAt === 'string' && message.deletedAt.length > 0;
}

/** Quando esta cópia mudou pela última vez; o envio, se nunca mudou. */
export function changedAt(message: ChatMessage): string {
  return message.deletedAt ?? message.editedAt ?? message.createdAt;
}

export function editMessage(message: ChatMessage, body: string, at: string): ChatMessage {
  return { ...message, body: body.slice(0, MAX_MESSAGE_BODY), revision: revisionOf(message) + 1, editedAt: at };
}

/**
 * Apagar deixa a lápide e leva o conteúdo junto.
 *
 * O corpo e o anexo saem aqui, não na hora de mostrar: uma mensagem apagada que
 * continuasse carregando o texto estaria apagada só na interface, e a próxima
 * réplica a levaria inteira para o disco de outra pessoa.
 */
export function deleteMessage(message: ChatMessage, at: string): ChatMessage {
  const { attachment: _anexo, ...resto } = message;
  return { ...resto, body: '', revision: revisionOf(message) + 1, deletedAt: at };
}

/**
 * Qual das duas cópias da mesma mensagem vale.
 *
 * Revisão primeiro. Empatando, a que mudou mais tarde; empatando de novo, a
 * apagada — um "apagar" que perde um empate é um "apagar" que não aconteceu.
 */
export function winningCopy(current: ChatMessage, incoming: ChatMessage): ChatMessage {
  const revisaoAtual = revisionOf(current);
  const revisaoNova = revisionOf(incoming);
  if (revisaoNova !== revisaoAtual) return revisaoNova > revisaoAtual ? incoming : current;
  const mudancaAtual = changedAt(current);
  const mudancaNova = changedAt(incoming);
  if (mudancaNova !== mudancaAtual) return mudancaNova > mudancaAtual ? incoming : current;
  if (isDeleted(incoming) !== isDeleted(current)) return isDeleted(incoming) ? incoming : current;
  return current;
}

/** Se vale a pena substituir o que já está guardado. */
export function supersedes(current: ChatMessage, incoming: ChatMessage): boolean {
  return winningCopy(current, incoming) !== current;
}

/** O que a conversa mostra: tudo menos as lápides. */
export function visibleMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !isDeleted(message));
}

/**
 * Quem pode mexer em uma mensagem.
 *
 * No servidor dedicado a conta é uma só e o `id` basta. No P2P cada host tem o
 * próprio cadastro, e o mesmo apelido vira ids diferentes conforme quem está
 * hospedando — é por isso que lá a identidade é o apelido normalizado, a mesma
 * que já decide de quem é um perfil replicado. Sem isso, trocar de host tirava
 * de você o direito de apagar as suas próprias mensagens.
 */
export function canModify(
  message: Pick<ChatMessage, 'author'>,
  actor: { id: string; username: string },
  options: { p2pMode: boolean; normalize: (username: string) => string },
): boolean {
  if (message.author.id === actor.id) return true;
  return options.p2pMode && options.normalize(message.author.username) === options.normalize(actor.username);
}
