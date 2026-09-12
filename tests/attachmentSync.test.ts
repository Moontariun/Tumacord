import assert from 'node:assert/strict';
import test from 'node:test';
import { ATTACHMENT_SYNC_KEY, attachmentSyncEnabled, attachmentSyncVisible } from '../src/lib/attachmentSync';

// "Sincronizar arquivos neste PC" existe para o P2P, onde não há servidor
// guardando nada. No dedicado a pergunta não existe: o servidor guarda e
// autoriza, e replicar tudo no disco de cada pessoa espalha cópias de arquivos
// que ele controla por máquinas que ele não controla.
//
// O defeito era a preferência ser global. Quem ligasse a opção no P2P — e é lá
// que ela aparece — levava essa escolha para dentro do dedicado sem saber.

test('a preferência guardada no P2P não atravessa para o dedicado', () => {
  // O caso exato do defeito: preferência ligada, modo dedicado.
  assert.equal(attachmentSyncEnabled('server', true), false);
  assert.equal(attachmentSyncEnabled('p2p', true), true);
});

test('no dedicado a resposta é não, qualquer que seja a preferência', () => {
  for (const preference of [true, false]) {
    assert.equal(attachmentSyncEnabled('server', preference), false, `preferência ${preference}`);
  }
});

test('modo desconhecido não replica', () => {
  // Errar para o lado de guardar espalharia arquivos de um servidor por
  // máquinas que ele não controla; errar para este lado só faz o download
  // continuar sendo manual, que é reversível.
  assert.equal(attachmentSyncEnabled(undefined, true), false);
});

test('o controle aparece onde a escolha existe, e só lá', () => {
  assert.equal(attachmentSyncVisible('p2p'), true);
  assert.equal(attachmentSyncVisible('server'), false);
  assert.equal(attachmentSyncVisible(undefined), false);
});

// Esconder o controle e continuar replicando era o defeito, e não a correção:
// quem tivesse a preferência ligada não teria nem como desligá-la.
test('esconder o controle e desligar a replicação são a mesma regra', () => {
  for (const mode of ['p2p', 'server', undefined] as const) {
    const visible = attachmentSyncVisible(mode);
    const replicating = attachmentSyncEnabled(mode, true);
    assert.equal(
      replicating && !visible,
      false,
      `em ${mode ?? 'modo desconhecido'} a replicação estaria ligada com o controle escondido`,
    );
  }
});

test('a chave do navegador é preservada, para a escolha do P2P não se perder', () => {
  assert.equal(ATTACHMENT_SYNC_KEY, 'tumacord.sync-files');
});
