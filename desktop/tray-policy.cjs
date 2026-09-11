'use strict';

// O que fechar a janela significa.
//
// Até a 0.9.1 significava sair: a janela era destruída, `window-all-closed`
// chamava `app.quit()` e o ícone da bandeja ia junto. A bandeja existia e não
// servia para nada — não havia aplicativo vivo para ela trazer de volta.
//
// Agora fechar esconde. A janela continua existindo, e isso não é um detalhe:
// é ela que sustenta a call, a captura de tela e a live flutuante. Destruí-la
// e recriá-la derrubaria a sessão de mídia de quem só queria tirar a janela da
// frente.
//
// Duas saídas continuam existindo, e as duas passam por aqui: o item "Sair" do
// menu da bandeja e o reinício da atualização. As duas ligam o marcador de
// encerramento antes, e aí a janela fecha de verdade.
//
// A regra mora neste arquivo, separada do Electron, porque ela é uma decisão —
// e uma decisão se testa sem abrir janela nenhuma.

/**
 * @param {{ quitting?: boolean, platform?: string }} contexto
 * @returns {'quit'|'hide'} `quit` deixa a janela fechar; `hide` a esconde.
 */
function closeAction({ quitting = false, platform = process.platform } = {}) {
  // Pedido explícito de sair: a janela fecha, aconteça o que acontecer.
  if (quitting) return 'quit';
  // No macOS fechar a janela e manter o aplicativo no Dock é o comportamento
  // que o sistema espera, e quem reabre é o `activate`. Esconder ali criaria
  // uma janela invisível que o Dock insiste em dizer que está aberta.
  if (platform === 'darwin') return 'quit';
  return 'hide';
}

/**
 * O menu da bandeja descreve o que dá para fazer agora, e não uma lista fixa:
 * oferecer "Abrir" com a janela na frente é oferecer o que já está feito.
 *
 * @param {{ windowVisible?: boolean }} contexto
 */
function trayMenuState({ windowVisible = false } = {}) {
  return {
    open: { label: 'Abrir Tumacord', enabled: !windowVisible },
    hide: { label: 'Ocultar a janela', enabled: windowVisible },
    // Nunca desabilitado: sair precisa funcionar de qualquer estado, inclusive
    // com a janela escondida — que é justamente quando a bandeja é a única
    // porta de entrada do aplicativo.
    quit: { label: 'Sair do Tumacord', enabled: true },
  };
}

/** Clicar no ícone alterna: é o gesto que as pessoas tentam primeiro. */
function trayClickAction({ windowVisible = false } = {}) {
  return windowVisible ? 'hide' : 'show';
}

module.exports = { closeAction, trayMenuState, trayClickAction };
