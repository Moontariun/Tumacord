// Se os anexos ficam guardados neste computador.
//
// "Sincronizar arquivos neste PC" existe para o P2P, e só faz sentido lá: no
// P2P não há servidor guardando nada, então um arquivo que ninguém replicou
// some quando quem o enviou fecha o aplicativo. Guardar uma cópia local é o
// que dá permanência ao anexo.
//
// No dedicado a pergunta não existe: o servidor é quem guarda e quem autoriza.
// Replicar tudo no disco de cada pessoa não dá permanência a nada — ela já
// existe — e espalha cópias de arquivos que o servidor controla por máquinas
// que ele não controla.
//
// ## O defeito
//
// A preferência era global: uma chave só, gravada no navegador. Quem tivesse
// ligado a opção no P2P — e é lá que ela aparece — carregava essa escolha para
// dentro do dedicado sem saber. Esconder o controle não resolvia: os três
// caminhos que replicam (histórico que chega, mensagem que chega, arquivo que
// se envia) liam a preferência direto, e continuavam copiando com o controle
// escondido.
//
// Aqui a decisão é uma função só, e ela recebe o modo. Esconder o controle
// passou a ser consequência da mesma regra, e não uma segunda regra.

export type ConnectionMode = 'p2p' | 'server';

/** A chave do navegador. Continua sendo a mesma: a escolha do P2P é preservada. */
export const ATTACHMENT_SYNC_KEY = 'tumacord.sync-files';

/**
 * Se a replicação automática de anexos vale agora.
 *
 * **Todo** caminho que copia anexo passa por aqui — histórico, chegada e
 * envio. No dedicado a resposta é sempre não, qualquer que seja a preferência
 * guardada.
 */
export function attachmentSyncEnabled(mode: ConnectionMode | undefined, preference: boolean): boolean {
  // Modo desconhecido não replica. Errar para o lado de guardar espalharia
  // cópias de arquivos de um servidor por máquinas que ele não controla;
  // errar para este lado só faz o download continuar sendo manual.
  if (mode !== 'p2p') return false;
  return preference === true;
}

/**
 * Se o controle aparece.
 *
 * Mesma regra da replicação: o controle existe onde a escolha existe. Um
 * controle escondido cujo valor continua valendo é pior do que um controle
 * visível, porque ninguém consegue desligá-lo.
 */
export function attachmentSyncVisible(mode: ConnectionMode | undefined): boolean {
  return mode === 'p2p';
}
