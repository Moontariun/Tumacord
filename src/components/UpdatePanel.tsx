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
// Até a 0.12.0 esta tela também mostrava "também dá para atualizar como sempre",
// com o comando de instalação e um link para a página de Releases do GitHub.
// Isso saiu: os aplicativos não buscam mais nada no GitHub, o repositório pode
// ser privado, e o comando ali compilava do código-fonte — um caminho que
// contradiz o que o resto da tela faz. Oferecer uma saída que não é mais a
// saída manda a pessoa para o lugar errado justamente quando ela está com
// problema.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { playSound } from '../lib/sound';
import { describePublished, formatBytes, readReleaseHighlights } from '../lib/releaseNotes';

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
  setShowOlder: (showOlder: boolean) => void;
  chooseVersion: (version: string) => void;
  /** Troca o convite do dono por uma credencial deste dispositivo. */
  enroll: (invite: string, label?: string) => Promise<void>;
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
  // A versão que já teve som. Sem isto, toda mudança de estado da mesma
  // atualização — baixando, baixada, aplicando — tocaria de novo.
  const anunciada = useRef('');
  useEffect(() => {
    if (!bridge) return;
    let ativo = true;
    const parar = bridge.onChanged((novo) => {
      if (!ativo) return;
      avisado.current = true;
      const oferecida = novo?.phase === 'available' ? novo.version : '';
      if (oferecida && anunciada.current !== oferecida) {
        anunciada.current = oferecida;
        playSound('update');
      }
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
    setShowOlder: (showOlder: boolean) => acao(bridge ? () => bridge.setShowOlder(showOlder) : undefined),
    chooseVersion: (version: string) => acao(bridge ? () => bridge.chooseVersion(version) : undefined),
    // Esta devolve a promessa: a tela de inscrição desabilita o botão enquanto
    // o pedido corre, e precisa saber quando ele termina.
    enroll: async (invite: string, label?: string) => {
      if (!bridge) return;
      const nextState = await bridge.enroll(invite, label ?? '').catch(() => null);
      if (nextState) { avisado.current = true; setState(nextState); }
    },
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
/**
 * Trocar o convite do dono por uma credencial deste dispositivo.
 *
 * O convite vem por canal privado e vale uma vez. Ele não é um segredo global
 * embutido no executável: aquele seria o mesmo para todo mundo, vazaria no
 * primeiro `strings` e não poderia ser revogado sem trocar o executável de
 * todos.
 */
function EnrollDevice({ message, onEnroll }: { message: string; onEnroll: (invite: string, label?: string) => Promise<unknown> }) {
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = inviteCode.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onEnroll(trimmed, '');
      // O resultado — deu certo ou não — chega pelo estado do atualizador, que
      // é a mesma fonte que o resto deste painel lê.
      setInviteCode('');
    } finally {
      setSubmitting(false);
    }
  };

  return <form className="quality-note update-enroll" onSubmit={(event) => void submit(event)}>
    <strong>Este dispositivo ainda não pode baixar atualizações</strong>
    <span>{message || 'Peça um convite ao dono do servidor e cole aqui. Ele vale uma vez.'}</span>
    <label className="update-enroll-field">
      <span>Convite</span>
      <input
        value={inviteCode}
        onChange={(event) => setInviteCode(event.target.value)}
        placeholder="cole aqui o convite recebido"
        autoComplete="off"
        spellCheck={false}
        disabled={submitting}
      />
    </label>
    <button className="primary-button" type="submit" disabled={submitting || !inviteCode.trim()}>
      {submitting ? 'Autorizando…' : 'Autorizar este dispositivo'}
    </button>
  </form>;
}

// O que chega no manifesto assinado é o Markdown do CHANGELOG. Mostrá-lo cru deixaria
// `**assim**` na tela; interpretá-lo como HTML seria confiar em texto que veio
// da rede, e isso não. O meio-termo é ler os blocos e desenhá-los com os
// elementos daqui — nada do que chega vira tag.
function ReleaseNotes({ markdown }: { markdown: string }) {
  // O aplicativo mostra o resumo da versão. O texto inteiro — o porquê de cada
  // decisão, o que estava errado antes — é escrito para quem lê o repositório,
  // e continua inteiro na página da versão.
  const { blocks } = readReleaseHighlights(markdown);
  if (!blocks.length) return <div className="release-notes"><p>Esta versão foi publicada sem notas.</p></div>;
  return <div className="release-notes">
    {blocks.map((bloco, indice) => bloco.kind === 'heading'
      ? <strong key={indice}>{bloco.text}</strong>
      : <p key={indice} className={bloco.kind === 'item' ? 'note-item' : bloco.kind === 'quote' ? 'note-quote' : undefined}>{bloco.text}</p>)}
  </div>;
}

/**
 * As versões que o servidor oferece, para quem quiser voltar atrás.
 *
 * Desligada por padrão. A pergunta normal é "tem versão nova?", e uma lista de
 * tudo o que já existiu na frente de quem só quer atualizar é ruído — além de
 * custar um documento por versão a cada consulta.
 *
 * Ligada, ela lista tudo o que está na pasta do servidor, marca a instalada e
 * desabilita o que não tem pacote para este jeito de instalação. Uma versão sem
 * pacote continua aparecendo: escondê-la faria a pessoa procurar no servidor o
 * que ela está vendo lá e não achar aqui.
 */
function VersionList({ state, onChoose, onToggle }: { state: TumacordUpdateState; onChoose: (version: string) => void; onToggle: (showOlder: boolean) => void }) {
  const versoes = state.versions ?? [];
  return <div className="update-versions">
    <label className="sound-toggle update-toggle">
      <input type="checkbox" checked={state.showOlder} onChange={(event) => onToggle(event.target.checked)} />
      <span><strong>Mostrar versões antigas</strong><small>Lista tudo o que o servidor oferece e deixa instalar uma versão anterior. Voltar de versão é sempre uma escolha sua — a procura automática nunca oferece isso.</small></span>
    </label>
    {state.showOlder && (versoes.length
      ? <ul className="update-version-list">
        {versoes.map((item) => <li key={item.releaseId} className={item.installed ? 'is-installed' : ''}>
          <span className="update-version-name">
            {item.version}
            {item.installed && <em>instalada</em>}
            {item.older && !item.installed && <em className="is-older">anterior</em>}
          </span>
          <span className="update-version-size">{item.size ? formatBytes(item.size) : ''}</span>
          <button
            type="button"
            className="ghost"
            disabled={item.installed || !item.canApply}
            onClick={() => onChoose(item.version)}
            title={item.installed
              ? 'É a versão que está rodando agora'
              : item.canApply
                ? `Preparar a ${item.version} para instalar`
                : 'Esta versão não tem pacote para o jeito que o Tumacord foi instalado aqui'}
          >{item.installed ? 'Em uso' : item.canApply ? 'Escolher' : 'Sem pacote'}</button>
        </li>)}
      </ul>
      : <p className="update-versions-empty">O servidor não está oferecendo nenhuma versão agora.</p>)}
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

    {state.phase === 'checking' && <p className="invite-status">Procurando uma versão nova…</p>}
    {state.phase === 'up-to-date' && <p className="invite-status">Você está na versão mais nova publicada.</p>}

    {/* Sem origem configurada não há o que procurar — e tentar um endereço
        adivinhado seria pior do que não tentar. */}
    {state.phase === 'no-origin' && <div className="quality-note">
      <strong>Este Tumacord não sabe onde procurar atualização</strong>
      <span>{state.enrollmentMessage || 'Peça ao dono do servidor o endereço das atualizações e um convite para este dispositivo.'}</span>
    </div>}

    {state.phase === 'needs-enrollment' && <EnrollDevice
      message={state.enrollmentMessage}
      onEnroll={bridge.enroll}
    />}

    {/* Pular versões é o normal: quem está muito atrás instala direto a mais
        nova. Quando não dá, a versão que exige passagem diz isso. */}
    {state.mustStop && <div className="quality-note">
      <strong>Esta versão precisa ser instalada antes das seguintes</strong>
      <span>A {state.latest || 'mais nova'} já existe, e o caminho até ela passa por aqui: {state.mustStop.reason}. Depois de aplicar esta, procure de novo para seguir.</span>
    </div>}
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
      A {state.version} não publicou pacote para uma cópia {KIND_LABELS[state.kind]}, então não há o que aplicar por aqui. O caminho é o de sempre, logo abaixo.
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
      {/* Procurar continua disponível com uma versão já encontrada: enquanto
          ninguém aplica, outra pode sair — e é ela que interessa. O botão só
          some enquanto algo está acontecendo, que é quando ele não teria o que
          fazer. */}
      {state.phase !== 'checking' && state.phase !== 'downloading' && state.phase !== 'applying' && state.phase !== 'applied' && <button className="ghost" onClick={bridge.check}><Icon name="refresh" /> Procurar de novo</button>}
    </div>

    <VersionList state={state} onChoose={bridge.chooseVersion} onToggle={bridge.setShowOlder} />

    <label className="sound-toggle update-toggle">
      <input type="checkbox" checked={state.enabled} onChange={(event) => bridge.setEnabled(event.target.checked)} />
      <span><strong>Procurar uma versão nova ao abrir</strong><small>Uma consulta ao servidor de atualizações do grupo quando o aplicativo inicia. Nada seu é enviado, e desligar aqui deixa a procura só no botão acima.</small></span>
    </label>
  </div></div>;
}

// O que mudou, uma vez por versão.
//
// Ela aparece na primeira abertura depois de uma atualização — não importa se
// a atualização veio pelo botão, pelo comando de instalação ou por alguém
// trocando o arquivo à mão. O texto é o do manifesto assinado da versão, que é
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
    </div>
  </div></div>;
}
