// Atualização vista de dentro do aplicativo.
//
// O processo principal procura uma versão nova quando o Tumacord abre e para
// por aí. Tudo o que muda a máquina — baixar, aplicar, reabrir — é um clique
// daqui, e essa é a regra que dá o desenho desta tela: **nada acontece
// sozinho**. Uma atualização que se instalasse no meio de uma call custaria a
// call, e é durante a call que este aplicativo é usado.
//
// O botão vive na barra de cima e é sempre o mesmo botão: com uma versão nova
// esperando ele ganha um ponto; sem nada a fazer, ele ainda é por onde se
// procura de novo. Um botão que aparece e some seria um botão que ninguém
// aprende onde fica.
//
// O que esta tela nunca faz é esconder os outros caminhos. Continua dando para
// atualizar pelo comando de instalação ou baixando o arquivo na página de
// Releases, e os dois estão escritos aqui — inclusive quando não existe arquivo
// para o jeito que esta cópia foi instalada, que é justamente quando eles são
// a única saída.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { copyText } from '../lib/clipboard';
import { describePublished, formatBytes, readReleaseNotes } from '../lib/releaseNotes';

const REPOSITORY = 'Moontariun/Tumacord';
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

// O comando que instala uma versão específica a partir do código. É o mesmo
// caminho do README, com a tag no lugar da branch: ele continua existindo, e
// continua sendo o jeito de instalar quando o botão não serve.
export function installCommand(version: string): string {
  const alvo = version ? `v${version}` : 'main';
  return `curl -fsSL https://raw.githubusercontent.com/${REPOSITORY}/main/scripts/install-from-github.sh | bash -s -- ${alvo}`;
}

// Como esta cópia foi instalada, dito em português. Aparece quando o motivo
// importa: é o que decide qual arquivo serve e o que acontece ao aplicar.
const KIND_LABELS: Record<TumacordInstallKind, string> = {
  'linux-managed': 'instalada pelo script no Linux',
  'linux-appimage': 'AppImage no Linux',
  'windows-installed': 'instalada no Windows',
  'windows-portable': 'portátil no Windows',
  unknown: 'de origem desconhecida',
};

export interface UpdateBridge {
  state: TumacordUpdateState | null;
  supported: boolean;
  check: () => void;
  download: () => void;
  cancel: () => void;
  apply: () => void;
  restart: () => void;
  dismiss: () => void;
  setEnabled: (enabled: boolean) => void;
  openPage: () => void;
  markNotesSeen: (version: string) => void;
}

export function useUpdates(): UpdateBridge {
  const bridge = window.tumacordDesktop?.update;
  const [state, setState] = useState<TumacordUpdateState | null>(null);
  // Uma leitura inicial que demora não pode desfazer um aviso que chegou
  // primeiro: o processo principal começa a procurar antes de esta tela
  // existir, e o aviso dele é sempre mais novo do que a leitura pedida aqui.
  const avisado = useRef(false);
  useEffect(() => {
    if (!bridge) return;
    let ativo = true;
    const parar = bridge.onChanged((novo) => {
      if (!ativo) return;
      avisado.current = true;
      setState(novo);
    });
    void bridge.state().then((atual) => { if (ativo && !avisado.current) setState(atual); }).catch(() => undefined);
    return () => { ativo = false; parar(); };
  }, [bridge]);

  const acao = useCallback((executar: (() => Promise<TumacordUpdateState>) | undefined) => {
    if (!executar) return;
    void executar().then((novo) => { avisado.current = true; setState(novo); }).catch(() => undefined);
  }, []);

  return {
    state,
    supported: Boolean(bridge),
    check: () => acao(bridge?.check),
    download: () => acao(bridge?.download),
    cancel: () => acao(bridge?.cancel),
    apply: () => acao(bridge?.apply),
    restart: () => void bridge?.restart().catch(() => undefined),
    dismiss: () => acao(bridge ? () => bridge.dismiss() : undefined),
    setEnabled: (enabled: boolean) => acao(bridge ? () => bridge.setEnabled(enabled) : undefined),
    openPage: () => void bridge?.openPage().catch(() => undefined),
    markNotesSeen: (version: string) => acao(bridge ? () => bridge.markNotesSeen(version) : undefined),
  };
}

/** Se há algo que mereça o ponto no botão da barra de cima. */
export function hasUpdateNews(state: TumacordUpdateState | null): boolean {
  if (!state) return false;
  if (state.installedBroken) return true;
  if (state.phase === 'available' || state.phase === 'no-asset') return state.dismissed !== state.version;
  return ['downloading', 'ready', 'applying', 'applied'].includes(state.phase);
}

export function UpdateButton({ state, onOpen }: { state: TumacordUpdateState | null; onOpen: () => void }) {
  const novidade = hasUpdateNews(state);
  const titulo = !state ? 'Atualização'
    : state.installedBroken ? 'Esta versão foi retirada; veja a atualização'
    : state.phase === 'downloading' ? 'Baixando a atualização'
    : state.phase === 'ready' ? 'Atualização baixada, pronta para aplicar'
    : state.phase === 'available' || state.phase === 'no-asset' ? `Versão ${state.version} disponível`
    : state.phase === 'applied' ? 'Atualização aplicada; falta reabrir'
    : 'Procurar atualização';
  return <button className={`update-button ${novidade ? 'has-update' : ''}`} onClick={onOpen} title={titulo} aria-label={titulo}>
    <Icon name="update" />{novidade && <i />}
  </button>;
}

// As notas da versão em blocos legíveis.
//
// O que chega do GitHub é o Markdown do CHANGELOG. Mostrá-lo cru deixaria
// `**assim**` na tela; interpretá-lo como HTML seria confiar em texto que veio
// da rede, e isso não. O meio-termo é ler os blocos e desenhá-los com os
// elementos daqui — nada do que chega vira tag.
function ReleaseNotes({ markdown }: { markdown: string }) {
  const blocos = readReleaseNotes(markdown);
  if (!blocos.length) return <div className="release-notes"><p>Esta versão foi publicada sem notas.</p></div>;
  return <div className="release-notes">
    {blocos.map((bloco, indice) => bloco.kind === 'heading'
      ? <strong key={indice}>{bloco.text}</strong>
      : <p key={indice} className={bloco.kind === 'item' ? 'note-item' : bloco.kind === 'quote' ? 'note-quote' : undefined}>{bloco.text}</p>)}
  </div>;
}

// Os outros caminhos, sempre à vista. Quando não há arquivo para este tipo de
// instalação, eles deixam de ser alternativa e passam a ser o caminho.
function ManualPaths({ version, onNotice }: { version: string; onNotice: (message: string) => void }) {
  const comando = installCommand(version);
  return <div className="update-manual">
    <strong>Também dá para atualizar como sempre</strong>
    <p>No Linux, pelo comando de instalação — ele compila do código e troca só o atalho da versão:</p>
    <code>{comando}</code>
    <button className="ghost" onClick={() => void copyText(comando).then((ok) => onNotice(ok ? 'Comando copiado.' : 'Não consegui copiar; selecione o texto à mão.'))}>Copiar o comando</button>
    <p>No Windows, baixando o instalador ou o portátil em <span className="update-link">{RELEASES_PAGE}</span>.</p>
  </div>;
}

export function UpdateModal({ bridge, onClose, onNotice }: { bridge: UpdateBridge; onClose: () => void; onNotice: (message: string) => void }) {
  const state = bridge.state;
  // O estado chega do processo principal em milissegundos, mas um clique é
  // capaz de acontecer antes disso — e uma janela que não abre ao ser clicada
  // parece um botão quebrado.
  if (!state) {
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="invite-modal update-modal">
      <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
      <span className="modal-eyebrow">Atualização</span>
      <h2>Um instante</h2>
      <p>Lendo o que o Tumacord já sabe sobre versões novas.</p>
    </div></div>;
  }
  const progresso = state.progress.total ? Math.min(100, Math.round((state.progress.received / state.progress.total) * 100)) : 0;
  const temVersao = Boolean(state.version) && state.phase !== 'up-to-date';
  const publicada = describePublished(state.publishedAt);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="invite-modal update-modal">
    <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Atualização</span>
    <h2>{temVersao ? (state.title || `Tumacord ${state.version}`) : `Tumacord ${state.installed}`}</h2>
    <p>
      Você está na {state.installed} · cópia {KIND_LABELS[state.kind]}.
      {state.lastCheck ? ` Última procura às ${new Date(state.lastCheck).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.` : ''}
    </p>

    {state.installedBroken && <p className="invite-status error">
      Esta versão foi retirada: {state.installedBroken}. Ela continua funcionando, mas não deveria ficar — atualize quando puder.
    </p>}

    {state.phase === 'checking' && <p className="invite-status">Procurando uma versão nova no GitHub…</p>}
    {state.phase === 'up-to-date' && <p className="invite-status">Você está na versão mais nova publicada.</p>}

    {state.skipped.length > 0 && <p className="invite-status">
      {state.skipped.map((pulada) => `A ${pulada.version} existe e não é oferecida: ${pulada.reason}.`).join(' ')}
    </p>}

    {state.error && <p className="invite-status error">{state.error}</p>}

    {temVersao && <>
      {(publicada || state.asset) && <p className="update-published">
        {[publicada, state.asset?.name, state.asset?.size ? formatBytes(state.asset.size) : ''].filter(Boolean).join(' · ')}
      </p>}
      <ReleaseNotes markdown={state.notes} />
    </>}

    {state.phase === 'no-asset' && <p className="invite-status">
      A {state.version} não publicou arquivo para uma cópia {KIND_LABELS[state.kind]}, então não há o que aplicar por aqui. O caminho é o de sempre, logo abaixo.
    </p>}

    {state.phase === 'downloading' && <div className="update-progress">
      <div className="update-progress-bar"><i style={{ width: `${progresso}%` }} /></div>
      <span>{formatBytes(state.progress.received)}{state.progress.total ? ` de ${formatBytes(state.progress.total)} · ${progresso}%` : ''}</span>
    </div>}

    {state.phase === 'ready' && <p className="invite-status">
      O arquivo foi baixado e conferido. Aplicar não interrompe esta sessão: a versão nova passa a valer quando o Tumacord for reaberto.
    </p>}

    {state.phase === 'applied' && state.applied && <p className="invite-status">{state.applied.message}</p>}

    <div className="update-actions">
      {state.phase === 'available' && <>
        <button className="primary-button" onClick={bridge.download}>Baixar a {state.version}</button>
        <button className="ghost" onClick={() => { bridge.dismiss(); onClose(); }}>Agora não</button>
      </>}
      {state.phase === 'downloading' && <button className="ghost" onClick={bridge.cancel}>Cancelar o download</button>}
      {state.phase === 'ready' && <button className="primary-button" onClick={bridge.apply}>Aplicar a {state.version}</button>}
      {state.phase === 'applying' && <button className="primary-button" disabled>Aplicando…</button>}
      {state.phase === 'applied' && state.applied && <button className="primary-button" onClick={bridge.restart}>
        {state.applied.restart === 'now' ? 'Reabrir na versão nova' : state.applied.restart === 'quit' ? 'Fechar o Tumacord' : 'Abrir a pasta'}
      </button>}
      {(state.phase === 'idle' || state.phase === 'up-to-date' || state.phase === 'error' || state.phase === 'no-asset') && <button className="ghost" onClick={bridge.check}><Icon name="refresh" /> Procurar de novo</button>}
      {state.pageUrl && <button className="ghost" onClick={bridge.openPage}>Ver a versão no GitHub</button>}
    </div>

    <label className="sound-toggle update-toggle">
      <input type="checkbox" checked={state.enabled} onChange={(event) => bridge.setEnabled(event.target.checked)} />
      <span><strong>Procurar uma versão nova ao abrir</strong><small>Uma consulta às Releases públicas do projeto no GitHub quando o aplicativo inicia. Nada seu é enviado, e desligar aqui deixa a procura só no botão acima.</small></span>
    </label>

    <ManualPaths version={state.version} onNotice={onNotice} />
  </div></div>;
}

// O que mudou, uma vez por versão.
//
// Ela aparece na primeira abertura depois de uma atualização — não importa se
// a atualização veio pelo botão, pelo comando de instalação ou por alguém
// trocando o arquivo à mão. O texto é o da página de Releases do GitHub, que é
// onde o CHANGELOG desta versão foi publicado.
export function WhatsNewModal({ release, onClose, onOpenPage }: { release: NonNullable<TumacordUpdateState['installedRelease']>; onClose: () => void; onOpenPage?: () => void }) {
  const publicada = describePublished(release.publishedAt);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="invite-modal update-modal">
    <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Atualizado{publicada ? ` · ${publicada}` : ''}</span>
    <h2>{release.title || `Tumacord ${release.version}`}</h2>
    <p>Você está na {release.version}. Isto aparece uma vez a cada versão nova.</p>
    <ReleaseNotes markdown={release.notes} />
    <div className="update-actions">
      <button className="primary-button" onClick={onClose}>Entendi</button>
      {release.pageUrl && onOpenPage && <button className="ghost" onClick={onOpenPage}><Icon name="popOut" /> Ver no GitHub</button>}
    </div>
  </div></div>;
}
