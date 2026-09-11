import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canModify,
  changedAt,
  deleteMessage,
  editMessage,
  isDeleted,
  revisionOf,
  supersedes,
  visibleMessages,
  winningCopy,
} from '../shared/messageSync';
import type { ChatMessage } from '../shared/types';

// O merge de antes olhava só o `id`: quem já conhecia a mensagem ignorava a que
// chegava. Isso bastava enquanto uma mensagem era imutável; com edição e
// exclusão, é o que faz a mensagem apagada voltar no primeiro pacote de
// replicação de quem ainda tinha a cópia antiga.

function mensagem(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    channelId: 'geral',
    author: { id: 'renan', username: 'Renan' },
    body: 'texto original',
    createdAt: '2026-09-11T12:00:00.000Z',
    ...extra,
  };
}

const normalize = (username: string) => username.trim().toLowerCase();

test('uma mensagem nova está na revisão zero', () => {
  assert.equal(revisionOf(mensagem()), 0);
  assert.equal(isDeleted(mensagem()), false);
  assert.equal(changedAt(mensagem()), '2026-09-11T12:00:00.000Z');
});

test('editar avança a revisão e marca quando foi', () => {
  const editada = editMessage(mensagem(), 'texto novo', '2026-09-11T12:05:00.000Z');
  assert.equal(editada.body, 'texto novo');
  assert.equal(revisionOf(editada), 1);
  assert.equal(editada.editedAt, '2026-09-11T12:05:00.000Z');
  assert.equal(isDeleted(editada), false);
});

// Apagar é apagar: a lápide fica para a mensagem não voltar, o conteúdo não.
test('apagar leva o texto e o anexo junto', () => {
  const comAnexo = mensagem({ attachment: { id: 'a1', name: 'foto.png', mimeType: 'image/png', size: 10 } });
  const apagada = deleteMessage(comAnexo, '2026-09-11T12:06:00.000Z');
  assert.equal(apagada.body, '');
  assert.equal(apagada.attachment, undefined);
  assert.equal(isDeleted(apagada), true);
  assert.equal(revisionOf(apagada), 1);
});

test('revisão maior vence a cópia antiga', () => {
  const original = mensagem();
  const apagada = deleteMessage(original, '2026-09-11T12:06:00.000Z');
  assert.equal(winningCopy(original, apagada), apagada, 'a exclusão alcança quem ainda tinha a mensagem');
  assert.equal(winningCopy(apagada, original), apagada, 'e a cópia antiga não a ressuscita');
  assert.equal(supersedes(apagada, original), false);
  assert.equal(supersedes(original, apagada), true);
});

test('entre duas edições vale a mais recente', () => {
  const primeira = editMessage(mensagem(), 'um', '2026-09-11T12:05:00.000Z');
  const segunda = editMessage(primeira, 'dois', '2026-09-11T12:07:00.000Z');
  assert.equal(winningCopy(primeira, segunda).body, 'dois');
  assert.equal(winningCopy(segunda, primeira).body, 'dois');
});

// Duas pessoas offline, uma editou e a outra apagou, e as duas voltam. Alguma
// das duas tem de vencer sempre, e o resultado não pode depender da ordem em
// que os pacotes chegaram.
test('empate de revisão e de horário é resolvido a favor de apagar', () => {
  const editada = editMessage(mensagem(), 'outro texto', '2026-09-11T12:05:00.000Z');
  const apagada = { ...deleteMessage(mensagem(), '2026-09-11T12:05:00.000Z') };
  assert.equal(isDeleted(winningCopy(editada, apagada)), true);
  assert.equal(isDeleted(winningCopy(apagada, editada)), true, 'e a ordem de chegada não muda o resultado');
});

test('a conversa mostra tudo menos as lápides', () => {
  const viva = mensagem({ id: 'm1' });
  const morta = deleteMessage(mensagem({ id: 'm2' }), '2026-09-11T12:06:00.000Z');
  assert.deepEqual(visibleMessages([viva, morta]).map((item) => item.id), ['m1']);
});

// --- quem pode mexer --------------------------------------------------------

test('no servidor dedicado quem manda na mensagem é o dono do id', () => {
  const minha = mensagem();
  assert.equal(canModify(minha, { id: 'renan', username: 'Renan' }, { p2pMode: false, normalize }), true);
  assert.equal(canModify(minha, { id: 'outro', username: 'Renan' }, { p2pMode: false, normalize }), false, 'mesmo apelido não é a mesma conta num servidor');
});

// No P2P cada host tem o próprio cadastro, e o mesmo apelido vira ids
// diferentes conforme quem hospeda. Sem isto, trocar de host tirava de você o
// direito de apagar as suas próprias mensagens.
test('no P2P a identidade é o apelido, porque o id muda com o host', () => {
  const minha = mensagem();
  assert.equal(canModify(minha, { id: 'id-do-host-novo', username: ' renan ' }, { p2pMode: true, normalize }), true);
  assert.equal(canModify(minha, { id: 'outro', username: 'Joana' }, { p2pMode: true, normalize }), false);
});
