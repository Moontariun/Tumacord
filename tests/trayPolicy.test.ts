import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Fechar a janela deixou de ser sair do aplicativo. A regra é curta e vale a
// pena prová-la separada do Electron: o defeito que ela corrige — a bandeja
// morrer junto com a janela — não aparece em nenhum teste de interface, só na
// hora em que alguém fecha a janela achando que o Tumacord continua ali.

const require = createRequire(import.meta.url);
const { closeAction, trayMenuState, trayClickAction } = require('../desktop/tray-policy.cjs') as {
  closeAction: (contexto: { quitting?: boolean; platform?: string }) => 'quit' | 'hide';
  trayMenuState: (contexto: { windowVisible?: boolean }) => Record<'open' | 'hide' | 'quit', { label: string; enabled: boolean }>;
  trayClickAction: (contexto: { windowVisible?: boolean }) => 'hide' | 'show';
};

test('fechar a janela esconde, em vez de encerrar o aplicativo', () => {
  assert.equal(closeAction({ quitting: false, platform: 'linux' }), 'hide');
  assert.equal(closeAction({ quitting: false, platform: 'win32' }), 'hide');
});

// Sair precisa continuar possível, e por dois caminhos: o item do menu da
// bandeja e o reinício da atualização. Os dois ligam o marcador antes.
test('com o encerramento pedido, a janela fecha de verdade', () => {
  assert.equal(closeAction({ quitting: true, platform: 'linux' }), 'quit');
  assert.equal(closeAction({ quitting: true, platform: 'win32' }), 'quit');
  assert.equal(closeAction({ quitting: true, platform: 'darwin' }), 'quit');
});

// No macOS, esconder criaria uma janela invisível que o Dock insiste em dizer
// que está aberta. Ali fechar é fechar, e quem reabre é o `activate`.
test('no macOS fechar a janela continua fechando a janela', () => {
  assert.equal(closeAction({ quitting: false, platform: 'darwin' }), 'quit');
});

test('o menu da bandeja oferece o que faz sentido agora', () => {
  const escondida = trayMenuState({ windowVisible: false });
  assert.equal(escondida.open.enabled, true, 'com a janela escondida, abrir é o que resta');
  assert.equal(escondida.hide.enabled, false);

  const visivel = trayMenuState({ windowVisible: true });
  assert.equal(visivel.open.enabled, false, 'oferecer "abrir" com a janela na frente é oferecer o que já está feito');
  assert.equal(visivel.hide.enabled, true);
});

// Com a janela escondida, a bandeja é a única porta de entrada do aplicativo —
// e a única saída. Um "Sair" desabilitado ali deixaria o Tumacord sem como ser
// fechado a não ser matando o processo.
test('sair nunca fica desabilitado', () => {
  for (const visivel of [true, false]) assert.equal(trayMenuState({ windowVisible: visivel }).quit.enabled, true);
});

test('o clique no ícone alterna entre mostrar e esconder', () => {
  assert.equal(trayClickAction({ windowVisible: false }), 'show');
  assert.equal(trayClickAction({ windowVisible: true }), 'hide');
});
