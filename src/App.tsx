import { Component, FormEvent, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AdminOverview, Channel, ChatAttachment, ChatMessage, ChatSyncBundle, PublicUser, ServerSnapshot, UserProfile, VoiceState } from '../shared/types';
import { profileIsNewer } from '../shared/profileVersion';
import { isDeleted, visibleMessages, winningCopy } from '../shared/messageSync';
import { Icon } from './components/Icon';
import { Dropdown } from './components/Dropdown';
import { AdminPanel } from './components/AdminPanel';
import { Whiteboard } from './components/Whiteboard';
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from './components/ContextMenu';
import { ChannelSettingsModal } from './components/ChannelSettings';
import { LinkPreviews, MessageText } from './components/LinkPreview';
import { MIN_TILE_HEIGHT, bestStageLayout } from './lib/stageLayout';
import { useBoards } from './lib/boards';
import { cleanDeviceLabel, useDevices } from './hooks/useDevices';
import { UpdateButton, UpdateModal, WhatsNewModal, useUpdates } from './components/UpdatePanel';
import { qualityOptions, useVoice, type PeerHealth, type RemoteMedia, type ScreenAudioSupport, type StreamQuality } from './hooks/useVoice';
import { SCREEN_QUALITIES } from './lib/screenQuality';
import { describeOrigin, originLabel } from './lib/origin';
import { abandonSession, clearSession, defaultServerUrl, destinationOf, forgetThisDestination, suspendActive, loadSession, login, register, rememberServerKey, rememberedDestinations, resolveDestination, savedServerKey, saveSession, sessionFor, useDestination, type SavedSession } from './lib/session';
import { ATTACHMENT_SYNC_KEY, attachmentSyncEnabled, attachmentSyncVisible } from './lib/attachmentSync';
import { AWAY_SIZE_MAX, AWAY_SIZE_MIN, AWAY_THEMES, AWAY_THEME_LABEL, DEFAULT_AWAY_MESSAGE, MAX_AWAY_MESSAGE, readAwayMessage, readAwaySize, readAwayTheme, sanitizeAwayMessage, sanitizeAwaySize, sanitizeAwayTheme, setAwayMessage, setAwaySize, setAwayTheme, type AwayTheme } from './lib/away';
import { FEEDBACK_SOUNDS, SOUND_LABEL, playSound, previewSound, readDisabledSounds, readSoundEnabled, readSoundVolume, setSoundEnabledFor, setSoundPreference, setSoundVolume, unlockAudio, type FeedbackSound } from './lib/sound';
import { cacheAttachment, cacheProfileMedia, downloadBlob, formatFileSize, hasLocalAttachment, imagePreview, loadLocalSyncBundle, mirrorLocally, originFor, publishProfileMedia, resolveAttachment, uploadAttachment } from './lib/chatSync';
import { syncIdentity } from './lib/identity';
import { volumeToGain } from './lib/audioGain';
import { adoptDirectKey, buildInvite, describeGrade, inviteFormat, readDirectReport, requestShortInvite, resolveAnyInvite, type DirectReport } from './lib/directLink';
import { beginLoad, failLoad, isBusy, settle, untracked, type Tracked } from './lib/freshness';
import { copyText } from './lib/clipboard';
import { cachedTurnServers, forgetTurnServers, refreshTurnServers } from './lib/iceServers';
import { diagnoseMicrophone, formatDiagnosticReport, type LayerVerdict, type ScreenAudioDiagnostics } from './lib/mediaDiagnostics';
import { currentNetworkPreferences, loadNetworkPreferences, subscribeNetworkPreferences, updateNetworkPreferences, type NetworkPreferences } from './lib/networkPreferences';
import { describeReachability } from '../shared/directLink';
import { resumeSharedAudio, setSharedAudioSink, sharedAudioContext, sharedAudioOutput } from './lib/audioBus';
import { profileMediaUrl, updateProfile, uploadProfileMedia } from './lib/profile';
import logoUrl from '../assets/tumacord-logo.png';
import packageMetadata from '../package.json';

const APP_VERSION = packageMetadata.version;
const qualityDropdownOptions = qualityOptions.map(([value, option]) => ({ value, label: option.label }));

// Um erro dentro de um efeito derrubava a árvore inteira: a janela ficava
// preta e, ao desmontar, o hook de voz saía da call sozinho. Agora o erro para
// aqui, a sessão continua de pé e dá para tentar de novo sem relogar.
class Boundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('[tumacord]', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="surface-crash">
      <strong>{this.props.title}</strong>
      <p>Algo falhou nesta parte da interface. Sua sessão e a call continuam ativas.</p>
      <div>
        <button onClick={() => this.setState({ failed: false })}>Tentar de novo</button>
        <button className="ghost" onClick={() => window.location.reload()}>Recarregar o app</button>
      </div>
    </div>;
  }
}

function App() {
  const [session, setSession] = useState<SavedSession | null>(() => loadSession());
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  // Esta função entra nas dependências do efeito que abre o socket. Criada a
  // cada renderização, ela mudava de identidade toda vez que a sessão mudava —
  // e mudar a sessão é o que acontece ao salvar o perfil. O efeito então
  // derrubava o socket, o hook de voz perdia a conexão e a call inteira era
  // refeita porque alguém trocou o próprio avatar.
  // Sair encerra a sessão aberta; trocar apenas a fecha. As duas voltam para
  // a tela de entrada, e só uma delas custa a conta.
  const logout = useCallback(() => { clearSession(); forgetTurnServers(); setSession(null); }, []);
  const trocarDeConta = useCallback(() => { suspendActive(); forgetTurnServers(); setSession(null); }, []);
  if (!session) return <Login onLogin={setSession} />;
  return <Boundary title="O Tumacord tropeçou"><Tumacord session={session} onSessionChange={setSession} onLogout={logout} onSwitchAccount={trocarDeConta} /></Boundary>;
}

// A entrada.
//
// Ela era uma coluna só, e crescia para baixo a cada coisa nova: modo, chave,
// convite, duas caixas de "lembrar" com dois parágrafos cada, aviso de
// segurança, contas guardadas. Num monitor comum a tela terminava com barra de
// rolagem para entrar em um aplicativo de conversa.
//
// Agora são duas colunas: à esquerda quem já entrou neste computador, à
// direita o formulário. O que explicava cada campo virou dica no ponteiro — o
// texto continua disponível para quem procura e para de ocupar a tela de quem
// já sabe.
function Login({ onLogin }: { onLogin: (session: SavedSession) => void }) {
  const [serverUrl, setServerUrl] = useState(() => {
    const saved = defaultServerUrl();
    return saved.endsWith(':3927') ? 'http://127.0.0.1:4600' : saved;
  });
  const [serverKey, setServerKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectionMode, setConnectionMode] = useState<'p2p' | 'server'>(() => window.tumacordDesktop ? 'p2p' : 'server');
  const [rememberMe, setRememberMe] = useState(true);
  // Lembrar a sessão e lembrar a chave são escolhas diferentes, e as quatro
  // combinações existem: dá para querer voltar sem digitar a senha e ainda
  // assim digitar a chave toda vez, e o contrário também.
  const [rememberKey, setRememberKey] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [lembradas, setLembradas] = useState(() => rememberedDestinations().filter((entrada) => entrada.session.token));
  const [aEsquecer, setAEsquecer] = useState<{ destination: string; session: SavedSession } | null>(null);
  const isDesktop = Boolean(window.tumacordDesktop);

  // A chave guardada daquele servidor volta para o campo assim que o endereço
  // é reconhecido. Ela continua mascarada: o campo nunca mostra o que guarda.
  useEffect(() => {
    if (connectionMode !== 'server' || !serverUrl.trim()) return;
    let cancelado = false;
    void resolveDestination(serverUrl, 'server').then(({ destination }) => {
      if (cancelado) return;
      const guardada = savedServerKey(destination);
      if (!guardada) return;
      setServerKey(guardada);
      setRememberKey(true);
    }).catch(() => undefined);
    return () => { cancelado = true; };
  }, [connectionMode, serverUrl]);

  // Retomar um destino lembrado não passa por autenticação nenhuma: a sessão
  // já existe, e o que muda é qual gaveta está aberta.
  const retomar = (destination: string) => {
    const retomada = useDestination(destination);
    if (retomada) onLogin(retomada);
  };

  // Esquecer é do computador, não do servidor: a conta continua lá, e o que
  // sai daqui é a sessão e a chave guardadas nesta máquina.
  const esquecer = (destination: string) => {
    forgetThisDestination(destination);
    setLembradas((atuais) => atuais.filter((entrada) => entrada.destination !== destination));
    setAEsquecer(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    unlockAudio();
    setLoading(true);
    setError('');
    if (mode === 'register' && password !== confirmPassword) {
      setError('As senhas não conferem.');
      setLoading(false);
      playSound('error');
      return;
    }
    // Com um convite colado, entrar significa alcançar o computador de quem
    // convidou — não o servidor local. Os caminhos do convite são tentados em
    // paralelo e o primeiro que responder vira o alvo do login.
    let target = connectionMode === 'p2p' && isDesktop ? 'http://127.0.0.1:3927' : serverUrl;
    let effectiveMode = connectionMode;
    let inviteKey = '';
    let resumeCall: string | undefined;
    if (inviteCode.trim()) {
      // Os dois formatos entram por aqui. Antes só o longo era tentado, e o
      // código curto da 0.8.4 — o que o servidor emite hoje — era recusado na
      // porta como "inválido ou vencido".
      const resolved = await resolveAnyInvite(inviteCode);
      if (!resolved) {
        setError(inviteFormat(inviteCode) ? 'O convite é válido, mas não consegui alcançar a call. Peça um código novo a quem convidou.' : 'Código de convite inválido ou vencido.');
        setLoading(false);
        playSound('error');
        return;
      }
      target = resolved.url;
      inviteKey = resolved.invite.key;
      resumeCall = resolved.invite.callId;
      // Um convite de servidor de encontro troca o modo por conta própria: é
      // ele que diz onde a call se encontra, não a escolha feita na tela.
      effectiveMode = resolved.mode;
    }
    try {
      const authenticated = mode === 'register'
        ? await register(target, username, password, resumeCall, effectiveMode, rememberMe, inviteKey || serverKey)
        : await login(target, username, password, resumeCall, effectiveMode === 'server' || Boolean(inviteKey), effectiveMode, rememberMe, inviteKey || serverKey);
      if (inviteKey && effectiveMode === 'p2p') await adoptDirectKey(inviteKey);
      // A chave é guardada só se a pessoa pediu, e no destino a que ela
      // pertence: a chave de um servidor não abre outro.
      if (effectiveMode === 'server') rememberServerKey(destinationOf(authenticated), rememberKey ? serverKey : '');
      onLogin(authenticated);
      playSound('connect');
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Falha ao entrar.'); playSound('error'); }
    finally { setLoading(false); }
  };

  return <main className="login-page">
    <div className="login-glow glow-one" /><div className="login-glow glow-two" />
    <div className="login-card">
      <aside className="login-aside">
        <div className={`login-aside-main ${lembradas.length ? '' : 'is-bare'}`}>
          <div className="login-brand">
            <img className="login-logo" src={logoUrl} alt="Marca do Tumacord" />
            <div className="brand-title">Tuma<span>cord</span></div>
            <p>Conversa, voz e tela para o seu grupo.</p>
          </div>
          {/* As contas que este computador já lembra, por destino. Cada linha
              é um nome e o modo daquele destino, e mais nada: o nome do
              servidor e o "por convite" que ficavam ao lado não ajudavam a
              escolher, e o que identifica o lugar de verdade — o endereço —
              está na dica. O "x" esquece aquele destino, a sessão e a chave
              dele, depois de confirmar. */}
          {lembradas.length > 0 && <div className="saved-destinations">
            <span className="group-title"><span>Continuar em</span></span>
            {lembradas.map(({ destination, session: guardada }) => <div key={destination} className="saved-destination">
              <button type="button" onClick={() => retomar(destination)} title={`Entrar como ${guardada.user.username} ${describeOrigin(destination, guardada.serverName)} — ${guardada.serverUrl}`}>
                <SavedAvatar session={guardada} />
                <strong>{guardada.user.username}</strong>
                <em className={`origin-mode ${originLabel(destination, guardada.serverName).mode}`}>{originLabel(destination, guardada.serverName).mode === 'p2p' ? 'P2P' : 'Servidor'}</em>
              </button>
              <button type="button" className="saved-forget" onClick={() => setAEsquecer({ destination, session: guardada })} title="Esquecer esta conta neste computador" aria-label={`Esquecer ${guardada.user.username}`}><Icon name="close" /></button>
            </div>)}
          </div>}
        </div>
        <div className="login-aside-foot">
          <span className="login-secure" title="HTTPS e WSS quando o servidor está configurado para isso. Voz, câmera e tela usam WebRTC criptografado em qualquer modo."><Icon name="shield" />Conexão criptografada</span>
          <span className="app-version" title={`Versão instalada: ${APP_VERSION}`}>v{APP_VERSION}</span>
        </div>
      </aside>
      <form className="login-form" onSubmit={submit}>
        <div className="connection-mode" role="tablist" aria-label="Tipo de conexão">
          <button type="button" role="tab" aria-selected={connectionMode === 'p2p'} disabled={!isDesktop} className={connectionMode === 'p2p' ? 'selected' : ''} onClick={() => setConnectionMode('p2p')} title={isDesktop ? 'Conexão direta entre os participantes, sem servidor.' : 'Disponível no aplicativo instalado.'}><Icon name="users" />P2P</button>
          <button type="button" role="tab" aria-selected={connectionMode === 'server'} className={connectionMode === 'server' ? 'selected' : ''} onClick={() => setConnectionMode('server')} title="Entrada por servidor, com voz e vídeo diretos entre os participantes."><Icon name="server" />P2P híbrido</button>
        </div>
        {connectionMode === 'server' && <div className="field-row">
          <label>Endereço <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://tumacord.exemplo:4600" required /></label>
          <label title="A chave de acesso definida por quem hospeda o servidor.">Chave <input type="password" value={serverKey} onChange={(event) => setServerKey(event.target.value)} autoComplete="off" placeholder="Definida pelo host" /></label>
        </div>}
        <label title="Cole o código de quem já está na call: ele leva você ao lugar certo, seja P2P ou servidor.">Convite <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Opcional — TUMA2~…" /></label>
        <div className="field-row">
          <label>Usuário <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="Seu nome de usuário" required /></label>
          <label>Senha <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder="••••••••" required /></label>
        </div>
        {mode === 'register' && <label>Confirmar senha <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="Repita a senha" required /></label>}
        <div className="login-switches">
          <label title="Reabre o Tumacord nesta conta sem pedir a senha de novo."><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />Continuar conectado</label>
          {connectionMode === 'server' && <label title="A chave fica guardada neste computador, só para este servidor, e o campo continua mascarado. Desmarcar apaga a que estiver guardada."><input type="checkbox" checked={rememberKey} onChange={(event) => setRememberKey(event.target.checked)} />Lembrar a chave</label>}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="login-actions">
          <button className="primary-button" disabled={loading}>{loading ? (mode === 'register' ? 'Criando…' : 'Entrando…') : mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
          <button type="button" className="account-toggle" onClick={() => { setMode((current) => current === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'register' ? 'Já tenho uma conta' : 'Criar uma conta nova'}</button>
        </div>
      </form>
    </div>
    {aEsquecer && <ConfirmDialog
      title="Esquecer esta conta?"
      body={<>A sessão de <strong>{aEsquecer.session.user.username}</strong> {describeOrigin(aEsquecer.destination, aEsquecer.session.serverName)} sai deste computador, junto com a chave guardada. A conta continua existindo.</>}
      confirmLabel="Esquecer"
      onConfirm={() => esquecer(aEsquecer.destination)}
      onClose={() => setAEsquecer(null)}
    />}
  </main>;
}

/**
 * A foto de quem ficou guardado neste computador.
 *
 * Na tela de entrada não há sessão aberta, e o endereço relativo que o resto do
 * app usa apontaria para lugar nenhum — era por isso que a foto não aparecia
 * aqui. A busca tenta primeiro o que esta máquina já baixou, que é o único
 * caminho que funciona com o host do grupo desligado, e depois o servidor
 * daquele destino. Falhando as duas, a inicial continua valendo.
 */
function SavedAvatar({ session }: { session: SavedSession }) {
  const [image, setImage] = useState<string>();
  const avatar = session.user.profile?.avatar;
  useEffect(() => {
    if (!avatar) return setImage(undefined);
    let vivo = true;
    const candidatos = [
      ...(window.tumacordDesktop ? [`http://127.0.0.1:3927/api/local/attachments/${avatar.id}`] : []),
      profileMediaUrl(session.serverUrl, avatar) ?? '',
    ].filter(Boolean);
    void (async () => {
      for (const candidato of candidatos) {
        const chegou = await new Promise<boolean>((resolve) => {
          const teste = new Image();
          teste.onload = () => resolve(true);
          teste.onerror = () => resolve(false);
          teste.src = candidato;
        });
        if (!vivo) return;
        if (chegou) return setImage(candidato);
      }
      setImage(undefined);
    })();
    return () => { vivo = false; };
  }, [avatar, session.serverUrl]);
  // O perfil vai sem a foto de propósito: quem decide onde ela está é este
  // componente. Passando a foto junto, o `Avatar` cairia no endereço relativo
  // — que na tela de entrada aponta para lugar nenhum — e desenharia um
  // círculo vazio no lugar da inicial quando nenhum candidato responde.
  const perfil = session.user.profile;
  return <Avatar name={session.user.username} profile={perfil && { ...perfil, avatar: undefined }} imageOverride={image} />;
}

/**
 * Uma pergunta antes de algo que não volta atrás.
 *
 * Curta de propósito: título, uma frase do que sai, e os dois caminhos. Quem
 * cancela é quem chega no Enter, porque errar para o lado seguro custa um
 * clique e errar para o outro custa a conta guardada.
 */
function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="confirm-dialog" role="alertdialog" aria-modal="true">
    <h2>{title}</h2>
    <p>{body}</p>
    <div className="confirm-actions">
      <button type="button" autoFocus onClick={onClose}>Cancelar</button>
      <button type="button" className="danger" onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </div></div>;
}

/**
 * Criar um canal de texto ou de voz.
 *
 * O que o `window.prompt` não tinha: validação antes de enviar, progresso
 * enquanto o servidor responde, o erro que o servidor devolveu, cancelamento,
 * e foco/rótulos que um leitor de tela entenda.
 */
function NewChannelModal({ type, onCreate, onClose }: { type: Channel['type']; onCreate: (type: Channel['type'], name: string) => Promise<{ ok: boolean; error?: string }>; onClose: () => void }) {
  const [draftName, setChannelName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { nameInput.current?.focus(); }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [submitting, onClose]);

  const trimmed = draftName.trim();
  // As mesmas regras do servidor, aqui só para avisar antes: quem recusa de
  // verdade é ele.
  const validationMessage = trimmed.length < 1 ? 'Escreva um nome.' : trimmed.length > 32 ? 'O nome cabe em 32 caracteres.' : '';

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || validationMessage) return;
    setSubmitting(true);
    setFailure('');
    const outcome = await onCreate(type, trimmed);
    // Só fecha depois da confirmação. Fechar no clique faria um nome recusado
    // desaparecer sem explicação — e foi isso que o `prompt` fazia.
    if (outcome.ok) { onClose(); return; }
    setSubmitting(false);
    setFailure(outcome.error ?? 'Não consegui criar o canal.');
  };

  const heading = type === 'voice' ? 'Nova call' : 'Novo canal de texto';
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!submitting && event.target === event.currentTarget) onClose(); }}>
    <form className="confirm-dialog novo-canal" role="dialog" aria-modal="true" aria-labelledby="novo-canal-titulo" onSubmit={(event) => void submitForm(event)}>
      <h2 id="novo-canal-titulo">{heading}</h2>
      <label className="novo-canal-campo">
        <span>Nome</span>
        <input
          ref={nameInput}
          value={draftName}
          maxLength={32}
          disabled={submitting}
          onChange={(event) => { setChannelName(event.target.value); setFailure(''); }}
          placeholder={type === 'voice' ? 'Jogatina' : 'assuntos-gerais'}
          aria-describedby={failure || (draftName && validationMessage) ? 'novo-canal-erro' : undefined}
          aria-invalid={Boolean(failure || (draftName && validationMessage))}
        />
      </label>
      {(failure || (draftName && validationMessage)) && <p className="novo-canal-erro" id="novo-canal-erro" role="alert">{failure || validationMessage}</p>}
      <div className="confirm-actions">
        <button type="button" onClick={onClose} disabled={submitting}>Cancelar</button>
        <button type="submit" className="primary" disabled={submitting || Boolean(validationMessage)}>{submitting ? 'Criando…' : 'Criar'}</button>
      </div>
    </form>
  </div>;
}

function Tumacord({ session, onSessionChange, onLogout, onSwitchAccount }: { session: SavedSession; onSessionChange: (session: SavedSession) => void; onLogout: () => void; onSwitchAccount: () => void }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [snapshot, setSnapshot] = useState<ServerSnapshot>({ serverName: session.serverName, channels: [], onlineUsers: [], voiceRooms: {} });
  const [selectedChannelId, setSelectedChannelId] = useState('geral');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  // O arquivo escolhido fica aqui, com a prévia, e **não** sobe: quem escolhe
  // uma imagem vê o que vai mandar antes de mandar. O envio é que carrega.
  const [pendingFile, setPendingFile] = useState<{ file: File; preview?: string } | null>(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [aApagar, setAApagar] = useState<ChatMessage | null>(null);
  // A preferência guardada, como ela está no navegador. O que vale na prática
  // é `replicatesAttachments`, logo abaixo: no dedicado a resposta é sempre não.
  const [syncFiles, setSyncFiles] = useState(() => localStorage.getItem(ATTACHMENT_SYNC_KEY) === 'true');
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const update = useUpdates();
  const [adminOpen, setAdminOpen] = useState(false);
  const [memberListOpen, setMemberListOpen] = useState(true);
  // A barra da esquerda recolhida: só ícones, rostos e os botões de voz. As
  // lives ganham a largura que ela ocupava, sem sair da janela.
  const [sidebarCompact, setSidebarCompactState] = useState(() => {
    try { return localStorage.getItem('tumacord.sidebar-compact') === 'true'; } catch { return false; }
  });
  const toggleSidebarCompact = useCallback(() => setSidebarCompactState((atual) => {
    const proximo = !atual;
    try { localStorage.setItem('tumacord.sidebar-compact', String(proximo)); } catch { /* preferência só desta sessão */ }
    return proximo;
  }), []);
  // A tela cheia das lives: a janela vai para a tela cheia e a interface em
  // volta some. As lives continuam na mesma arrumação, só que maiores.
  const [immersive, setImmersive] = useState(false);
  const immersiveRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(readSoundEnabled);
  const [soundVolume, setFeedbackVolume] = useState(readSoundVolume);
  const [discoveredCalls, setDiscoveredCalls] = useState<DiscoveredCall[]>([]);
  const [networkPreferences, setNetworkPreferences] = useState<NetworkPreferences>(() => currentNetworkPreferences());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [joinInviteOpen, setJoinInviteOpen] = useState(false);
  const [profileUser, setProfileUser] = useState<PublicUser | null>(null);
  const [streamVolume, setStreamVolumeState] = useState(() => {
    const saved = Number(localStorage.getItem('tumacord.stream-volume') ?? 1);
    return Number.isFinite(saved) ? Math.max(0, Math.min(2, saved)) : 1;
  });
  const [streamMuted, setStreamMutedState] = useState(() => localStorage.getItem('tumacord.stream-muted') === 'true');
  // A escolha de áudio é feita na primeira etapa e precisa sobreviver até a
  // segunda: é ela que decide o que o seletor de tela promete em cada cartão.
  const [shareAudio, setShareAudio] = useState(true);
  const [miniLiveHidden, setMiniLiveHidden] = useState(false);
  const [voiceMenuUserId, setVoiceMenuUserId] = useState<string | null>(null);
  const [userVolumes, setUserVolumes] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('tumacord.user-volumes') ?? '{}') as Record<string, number>; } catch { return {}; }
  });
  // O silêncio de uma pessoa vale só para a voz dela. A transmissão tem o
  // próprio volume e o próprio botão de mudo.
  const [mutedUsers, setMutedUsers] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('tumacord.user-muted') ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const devices = useDevices();
  const [boardPromptOpen, setBoardPromptOpen] = useState(false);
  /** O tipo de canal que o modal de criação está pedindo, ou `null`. */
  const [creatingChannelType, setCreatingChannelType] = useState<Channel['type'] | null>(null);
  // De onde vem o que este computador guarda.
  //
  // No P2P a resposta é imediata: a chave do convite identifica o grupo, e ela
  // já está na sessão. No dedicado é preciso perguntar ao servidor quem ele é
  // — endereço e nome não servem, porque mudam e coincidem.
  const [origin, setOrigin] = useState(() => (session.connectionMode === 'server' ? '' : originFor({ connectionMode: 'p2p', inviteKey: session.inviteKey ?? session.directKey })));
  const originRef = useRef(origin);
  originRef.current = origin;
  useEffect(() => {
    if (session.connectionMode !== 'server') {
      setOrigin(originFor({ connectionMode: 'p2p', inviteKey: session.inviteKey ?? session.directKey }));
      return;
    }
    let cancelado = false;
    // Enquanto não se sabe de quem é o histórico, nada é guardado: um pote
    // errado é pior do que pote nenhum.
    setOrigin('');
    void fetch(`${session.serverUrl}/api/health`)
      .then((resposta) => resposta.json())
      .then((corpo: { installationId?: string }) => {
        if (cancelado) return;
        setOrigin(originFor({ connectionMode: 'server', installationId: corpo?.installationId, serverUrl: session.serverUrl }));
      })
      .catch(() => {
        // Servidor anterior à 0.9.5 ou fora do ar: o endereço separa menos
        // bem, mas ainda separa dois servidores diferentes.
        if (!cancelado) setOrigin(originFor({ connectionMode: 'server', serverUrl: session.serverUrl }));
      });
    return () => { cancelado = true; };
  }, [session.connectionMode, session.directKey, session.inviteKey, session.serverUrl]);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const toastTimer = useRef<number | null>(null);
  const handoffTimer = useRef<number | null>(null);
  const handoffGeneration = useRef(0);
  const resumedCall = useRef('');
  const selectedChannelRef = useRef(selectedChannelId);
  // O valor que os três caminhos de replicação consultam. Ele já tem o modo
  // embutido: no dedicado a preferência do P2P não atravessa.
  const replicatesAttachments = attachmentSyncEnabled(session.connectionMode, syncFiles);
  const showsAttachmentSync = attachmentSyncVisible(session.connectionMode);
  const syncFilesRef = useRef(replicatesAttachments);
  useEffect(() => { selectedChannelRef.current = selectedChannelId; }, [selectedChannelId]);
  useEffect(() => { syncFilesRef.current = replicatesAttachments; }, [replicatesAttachments]);

  const showToast = useCallback((text: string, sound?: FeedbackSound) => {
    setToast(text);
    playSound(sound ?? (text.toLocaleLowerCase('pt-BR').includes('falh') ? 'error' : 'notification'));
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 5000);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (handoffTimer.current) window.clearTimeout(handoffTimer.current);
    handoffGeneration.current += 1;
  }, []);

  const changeSoundPreference = useCallback((enabled: boolean) => {
    setSoundEnabled(enabled);
    setSoundPreference(enabled);
    if (enabled) playSound('notification');
  }, []);

  const changeSoundVolume = useCallback((volume: number) => {
    setFeedbackVolume(volume);
    setSoundVolume(volume);
  }, []);

  const setUserVolume = useCallback((userId: string, volume: number) => {
    setUserVolumes((current) => {
      const next = { ...current, [userId]: Math.max(0, Math.min(2, volume)) };
      localStorage.setItem('tumacord.user-volumes', JSON.stringify(next));
      return next;
    });
  }, []);

  const setUserMuted = useCallback((userId: string, muted: boolean) => {
    setMutedUsers((current) => {
      const next = { ...current };
      if (muted) next[userId] = true;
      else delete next[userId];
      localStorage.setItem('tumacord.user-muted', JSON.stringify(next));
      return next;
    });
  }, []);

  const setStreamVolume = useCallback((volume: number) => {
    const next = Math.max(0, Math.min(2, volume));
    setStreamVolumeState(next);
    localStorage.setItem('tumacord.stream-volume', String(next));
  }, []);

  const setStreamMuted = useCallback((muted: boolean) => {
    setStreamMutedState(muted);
    localStorage.setItem('tumacord.stream-muted', String(muted));
  }, []);

  // A tela cheia da janela inteira perdeu o botão na 0.9.0 e ficou só no F11.
  // Ela nunca foi a tela cheia que alguém queria numa call — essa é a do
  // quadro da live, que continua no canto de cada transmissão. Dois botões de
  // maximizar lado a lado, fazendo coisas diferentes, era a fonte da confusão.
  const toggleAppFullscreen = useCallback(async () => {
    try {
      if (window.tumacordDesktop) await window.tumacordDesktop.toggleFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      showToast('Não foi possível alternar o modo tela cheia.');
    }
  }, [showToast]);

  /**
   * A tela cheia das lives.
   *
   * O botão antigo pedia tela cheia da GRADE, e a grade continuava presa ao
   * espaço entre as barras: a janela ia para a tela cheia e as lives ficavam do
   * mesmo tamanho, cercadas pela interface. Aqui é a interface que sai de cena
   * — barras, topo e lista de membros — e o palco ocupa a tela por conta do
   * próprio layout. Nada é reposicionado à força: as lives só ganham espaço.
   */
  const setImmersiveMode = useCallback(async (on: boolean) => {
    if (on === immersiveRef.current) return;
    immersiveRef.current = on;
    setImmersive(on);
    try {
      if (on) {
        if (window.tumacordDesktop) await window.tumacordDesktop.beginMediaFullscreen();
        else if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      } else if (window.tumacordDesktop) {
        await window.tumacordDesktop.endMediaFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // Sem tela cheia do sistema o modo continua valendo dentro da janela.
    }
  }, []);
  useEffect(() => {
    const sair = () => { if (immersiveRef.current) { immersiveRef.current = false; setImmersive(false); } };
    const stopDesktop = window.tumacordDesktop?.onMediaFullscreenChanged((active) => { if (!active) sair(); });
    const onFullscreen = () => { if (!window.tumacordDesktop && !document.fullscreenElement) sair(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && immersiveRef.current) void setImmersiveMode(false); };
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('keydown', onKey);
    return () => {
      stopDesktop?.();
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('keydown', onKey);
    };
  }, [setImmersiveMode]);

  useEffect(() => {
    if (!window.tumacordDesktop || session.connectionMode === 'server') {
      setDiscoveredCalls([]);
      return;
    }
    // A leitura inicial e os avisos do processo principal correm juntos. Sem
    // esta guarda, uma leitura que demorou chegava depois de um aviso mais
    // novo e devolvia à tela uma lista de calls já vencida — ou vazia.
    let ativo = true;
    void window.tumacordDesktop.discoverCalls().then((calls) => { if (ativo) setDiscoveredCalls(calls); });
    const parar = window.tumacordDesktop.onCallsChanged((calls) => { if (ativo) setDiscoveredCalls(calls); });
    return () => { ativo = false; parar(); };
  }, [session.connectionMode]);

  useEffect(() => {
    void loadNetworkPreferences().then(setNetworkPreferences);
    return subscribeNetworkPreferences(setNetworkPreferences);
  }, []);

  // As credenciais de TURN são temporárias de propósito. Buscá-las na entrada
  // e renovar de hora em hora evita que um enlace precise do relay justamente
  // depois de a credencial vencer.
  //
  // Com o relay desligado não se busca nada: uma credencial pedida é uma
  // credencial que existe. E a que já estava em mãos é esquecida na hora, para
  // desligar valer agora e não só na próxima renovação.
  useEffect(() => {
    if (!networkPreferences.turnEnabled) {
      forgetTurnServers();
      return;
    }
    let active = true;
    const refresh = () => { if (active) void refreshTurnServers(session.serverUrl, session.token); };
    refresh();
    const timer = window.setInterval(refresh, 60 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session.serverUrl, session.token, networkPreferences.turnEnabled]);

  // Reabrir o app não pode invalidar o convite que já circulou: o servidor
  // embutido volta a aceitar a chave da call assim que a sessão é restaurada.
  useEffect(() => {
    if (session.connectionMode === 'server' || !session.directKey) return;
    void adoptDirectKey(session.directKey);
  }, [session.connectionMode, session.directKey]);

  const enterDiscoveredCall = useCallback(async (call: DiscoveredCall) => {
    if (!session.password) return onLogout();
    try {
      const key = call.key ?? '';
      onSessionChange(await login(call.url, session.user.username, session.password, call.callId, true, 'p2p', session.rememberMe ?? true, key));
      if (key) await adoptDirectKey(key);
    } catch {
      showToast('Não consegui entrar nessa call. Confira se o host ainda está online.');
    }
  }, [onLogout, onSessionChange, session.password, session.rememberMe, session.user.username, showToast]);

  // Entrar por convite: primeiro o destino, depois a autenticação.
  //
  // Antes era o contrário. O convite exigia a senha guardada e, sem ela,
  // derrubava a sessão — inclusive as contas que nada tinham a ver com aquele
  // convite. Agora o destino é resolvido primeiro: se já existe uma sessão
  // para ele, ela é reaproveitada e ninguém digita nada.
  const enterInvitedCall = useCallback(async (code: string): Promise<'entrou' | 'precisa-entrar' | 'falhou'> => {
    // O código curto (TUMA2) é o formato atual; o TUMA1 continua sendo lido
    // para não invalidar convite que já circulou.
    const resolved = await resolveAnyInvite(code);
    if (!resolved) return 'falhou';
    const { destination } = await resolveDestination(resolved.url, resolved.mode, resolved.invite.key);

    const guardada = sessionFor(destination);
    if (guardada?.token) {
      const retomada = { ...guardada, resumeChannelId: resolved.invite.callId, serverUrl: resolved.url };
      saveSession(retomada);
      useDestination(destination);
      onSessionChange(retomada);
      return 'entrou';
    }

    // Mesmo destino de agora: a sessão aberta serve, e o convite só aponta a
    // call. Isso cobre o convite que circula dentro do próprio grupo.
    if (destination === destinationOf(session) && session.token) {
      const mesma = { ...session, resumeChannelId: resolved.invite.callId, serverUrl: resolved.url };
      saveSession(mesma);
      onSessionChange(mesma);
      return 'entrou';
    }

    // Destino novo, e nenhuma conta aberta nele. Quem chama leva a pessoa para
    // a entrada sem apagar as sessões lembradas dos outros destinos — que era
    // o que acontecia antes, e por isso um convite custava todas elas.
    //
    // Todo convite resolve hoje para `mode: 'server'`: o código aponta um
    // servidor de encontro. Se usar esse caminho deve significar entrar na
    // experiência inteira do modo dedicado é outra pergunta, anotada na
    // auditoria e ainda em aberto.
    return 'precisa-entrar';
  }, [onSessionChange, session]);

  const handleHostHandoff = useCallback((host: VoiceState, channelId: string, abrupt: boolean) => {
    if (session.connectionMode === 'server') return;
    const selfWillHost = host.id === session.user.id;
    const target = selfWillHost ? 'http://127.0.0.1:3927' : host.endpoint;
    showToast(selfWillHost ? 'O host saiu. Você tem o menor ping e está assumindo a call…' : `${host.username} tem o menor ping e está assumindo como host…`, 'host');
    const delay = selfWillHost ? 0 : abrupt ? 1100 : 800;
    const generation = ++handoffGeneration.current;
    if (handoffTimer.current) window.clearTimeout(handoffTimer.current);
    handoffTimer.current = window.setTimeout(async () => {
      handoffTimer.current = null;
      if (!session.password) return onLogout();
      try {
        const migrated = await login(target, session.user.username, session.password, channelId, true, 'p2p', session.rememberMe ?? true, session.directKey ?? '');
        if (generation === handoffGeneration.current) onSessionChange(migrated);
      } catch {
        if (generation !== handoffGeneration.current) return;
        showToast('A troca automática de host falhou. Tentando localizar a call novamente…');
        onLogout();
      }
    }, delay);
  }, [onLogout, onSessionChange, session.connectionMode, session.directKey, session.password, session.rememberMe, session.user.id, session.user.username, showToast]);

  useEffect(() => {
    const next = io(session.serverUrl, { auth: { token: session.token }, transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    let recoveringPersistedSession = false;
    // Se esta conexão ainda é a conexão desta tela. A recuperação automática
    // do P2P autentica antes de saber disso, e autenticar grava.
    let vivo = true;
    // Quem chega depois não vence por chegar depois: entre duas cópias da
    // mesma mensagem vale a de revisão maior. Sem isso, um pacote de
    // replicação atrasado desfazia na tela uma edição que já tinha valido.
    const mergeVisible = (incoming: ChatMessage[]) => {
      const visible = incoming.filter((item) => item.channelId === selectedChannelRef.current);
      if (!visible.length) return;
      setMessages((current) => {
        const porId = new Map(current.map((item) => [item.id, item]));
        for (const item of visible) {
          const atual = porId.get(item.id);
          porId.set(item.id, atual ? winningCopy(atual, item) : item);
        }
        return [...porId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
    };
    const storeIncoming = (incoming: ChatMessage[]) => {
      void mirrorLocally(originRef.current, [], incoming);
      mergeVisible(incoming);
      if (syncFilesRef.current) for (const item of incoming) if (item.attachment) void cacheAttachment(next, item.attachment, session.serverUrl, session.token).catch(() => undefined);
    };
    const mirrorProfilesAfterMedia = (bundle: ChatSyncBundle) => {
      if (!bundle.profiles?.length) return;
      // O servidor local rejeita corretamente um perfil que aponte para uma
      // imagem ausente. Baixamos os arquivos antes de persistir o JSON para
      // não perder o perfil durante uma migração de host.
      void cacheProfileMedia(bundle, session.serverUrl)
        .then(() => mirrorLocally(originRef.current, [], [], bundle.profiles ?? []))
        .catch(() => undefined);
    };
    const mergeBundle = (bundle: ChatSyncBundle) => {
      void mirrorLocally(originRef.current, bundle.channels, bundle.messages);
      mirrorProfilesAfterMedia(bundle);
      mergeVisible(bundle.messages);
    };
    const pushLocalHistory = async () => {
      // A replicação existe para o P2P: se o host sai, o histórico sobrevive
      // nos outros computadores. Ela rodava em TODA conexão, e por isso entrar
      // em um servidor dedicado publicava lá as conversas antigas do P2P — que
      // o servidor então guardava e distribuía a todo mundo conectado.
      // Ninguém espera que trocar de modo publique conversa antiga.
      if (session.connectionMode === 'server') return;
      const local = await loadLocalSyncBundle(originRef.current);
      await publishProfileMedia(local, session.serverUrl, session.token);
      next.emit('chat:sync:push', local, (result: ChatSyncBundle & { ok?: boolean }) => { if (result?.ok !== false && result?.messages) mergeBundle(result); });
    };
    next.on('connect', () => {
      setConnected(true);
      void pushLocalHistory();
      // A identidade do grupo viaja à parte do chat: um host antigo não
      // responde, e isso não pode atrasar nem quebrar o histórico.
      if (session.connectionMode === 'p2p') void syncIdentity(next);
    });
    next.on('disconnect', () => setConnected(false));
    next.on('connect_error', (error) => {
      setConnected(false);
      if (session.connectionMode === 'p2p') {
        if (recoveringPersistedSession) return;
        if (!session.password) {
          clearSession();
          onLogout();
          return;
        }
        recoveringPersistedSession = true;
        void login('http://127.0.0.1:3927', session.user.username, session.password, session.resumeChannelId, true, 'p2p', session.rememberMe ?? true)
          .then((recovered) => {
            // Sair da conta enquanto a recuperação estava no ar: o que ela
            // gravou sai junto. Sem isto, a sessão que a pessoa acabou de
            // encerrar voltava para o chaveiro e reaparecia na abertura
            // seguinte — sair virava um clique sem efeito.
            if (!vivo) return abandonSession(recovered);
            showToast('Sessão local recuperada automaticamente.');
            onSessionChange(recovered);
          })
          .catch(() => {
            recoveringPersistedSession = false;
            if (error.message === 'unauthorized') {
              clearSession();
              onLogout();
            }
          });
        return;
      }
      if (error.message === 'unauthorized') { clearSession(); onLogout(); }
    });
    next.on('server:snapshot', (incoming: ServerSnapshot) => {
      setSnapshot(incoming);
      const profiles = incoming.onlineUsers.filter((user) => user.profile?.updatedAt).map((user) => ({ username: user.username, profile: user.profile! }));
      void mirrorLocally(originRef.current, incoming.channels, []);
      mirrorProfilesAfterMedia({ channels: [], messages: [], profiles, availableAttachmentIds: [] });
      const currentSession = sessionRef.current;
      const freshSelf = incoming.onlineUsers.find((user) => user.id === currentSession.user.id);
      if (freshSelf?.profile?.updatedAt && profileIsNewer(freshSelf.profile, currentSession.user.profile)) {
        const nextSession = { ...currentSession, user: freshSelf };
        sessionRef.current = nextSession;
        saveSession(nextSession);
        onSessionChange(nextSession);
      }
    });
    next.on('chat:message', (incoming: ChatMessage) => {
      storeIncoming([incoming]);
      if (incoming.author.id !== session.user.id) playSound('message');
    });
    // Editada ou apagada: para quem recebe é a mesma notícia, e o caminho é o
    // mesmo de uma mensagem nova — guardar a versão e mostrar a versão.
    next.on('chat:message:updated', (incoming: ChatMessage) => storeIncoming([incoming]));
    next.on('chat:sync:messages', (incoming: ChatMessage[]) => storeIncoming(incoming));
    next.on('chat:sync:request', () => { void pushLocalHistory(); });
    next.on('chat:file:find', async (payload: { requestId?: string; attachmentId?: string; requester?: string }) => {
      if (!payload.requestId || !payload.attachmentId || !payload.requester || !(await hasLocalAttachment(payload.attachmentId))) return;
      next.emit('chat:file:offer', payload);
    });
    setSocket(next);
    return () => {
      vivo = false;
      next.disconnect();
      setSocket(null);
      // Sem isto o indicador continuava dizendo "conectado" durante a troca de
      // host, que é justamente o momento em que não há socket nenhum.
      setConnected(false);
    };
  }, [onLogout, onSessionChange, session.connectionMode, session.password, session.rememberMe, session.resumeChannelId, session.serverUrl, session.token, session.user.id, session.user.username, showToast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F11') return;
      event.preventDefault();
      void toggleAppFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleAppFullscreen]);

  const voice = useVoice({ socket, user: session.user, preferences: devices.preferences, onError: showToast, onDevicesChanged: devices.refresh, onHostHandoff: handleHostHandoff, dynamicHosting: session.connectionMode !== 'server' });
  const visibleChannels = useMemo(() => {
    if (session.connectionMode === 'server') return snapshot.channels;
    const text = snapshot.channels.find((channel) => channel.id === 'geral' && channel.type === 'text')
      ?? snapshot.channels.find((channel) => channel.type === 'text');
    const voiceChannel = snapshot.channels.find((channel) => channel.id === 'call-geral' && channel.type === 'voice')
      ?? snapshot.channels.find((channel) => channel.type === 'voice');
    return [text, voiceChannel].filter((channel): channel is Channel => Boolean(channel));
  }, [session.connectionMode, snapshot.channels]);
  const selectedChannel = visibleChannels.find((channel) => channel.id === selectedChannelId) ?? visibleChannels[0];
  // O "já volto" existe para cobrir a SUA transmissão. Sem live, não há o que
  // cobrir: ele sai junto com ela, em vez de ficar anunciado para a sala.
  const { screenOn: transmitindo, away: recadoAtivo, setAway: definirRecado } = voice;
  useEffect(() => {
    if (!transmitindo && recadoAtivo) definirRecado('', readAwayTheme(), readAwaySize());
  }, [definirRecado, recadoAtivo, transmitindo]);
  // A mesa de desenho não depende de live nem de call: ela nasce vinculada a
  // um canal, e quem enxerga o canal enxerga a mesa. A call pode estar
  // acontecendo ao lado, e não precisa estar.
  const boards = useBoards({
    socket,
    connected,
    userId: session.user.id,
    connectionMode: session.connectionMode ?? 'p2p',
    channelId: selectedChannel?.id ?? 'geral',
    voiceChannelId: voice.channelId ?? undefined,
    serverUrl: session.serverUrl,
    onNotice: showToast,
  });
  const createBoard = useCallback(async (name: string) => {
    const criada = await boards.create(name);
    setBoardPromptOpen(false);
    if (!criada) return;
    boards.open(criada.id);
    showToast(`Mesa “${criada.name}” criada. O anúncio foi para o canal.`);
  }, [boards, showToast]);

  // Sair da call pela lista, abrir um canal de texto ou uma mesa: a tela cheia
  // das lives não tem mais o que mostrar.
  useEffect(() => {
    if (immersive && (selectedChannel?.type !== 'voice' || boards.active)) void setImmersiveMode(false);
  }, [boards.active, immersive, selectedChannel?.type, setImmersiveMode]);

  useEffect(() => {
    if (!visibleChannels.length || visibleChannels.some((channel) => channel.id === selectedChannelId)) return;
    setSelectedChannelId(visibleChannels[0].id);
  }, [selectedChannelId, visibleChannels]);

  useEffect(() => {
    const resume = session.resumeChannelId;
    // A chave inclui o host: migrar para a call de outra pessoa precisa entrar
    // de novo, mesmo que este cliente já tenha retomado uma call antes.
    const key = `${session.serverUrl}:${resume ?? ''}`;
    if (!resume || resumedCall.current === key || !connected || !visibleChannels.some((channel) => channel.id === resume)) return;
    resumedCall.current = key;
    setSelectedChannelId(resume);
    void voice.join(resume);
  }, [connected, session.resumeChannelId, session.serverUrl, visibleChannels, voice]);

  const selfVoiceState = voice.members.find((member) => member.id === session.user.id);
  useEffect(() => {
    if (!window.tumacordDesktop || session.connectionMode === 'server') return;
    if (voice.channelId && selfVoiceState?.isHost) {
      const callName = snapshot.channels.find((channel) => channel.id === voice.channelId)?.name ?? 'Call Geral';
      void window.tumacordDesktop.setHosting({ hostUserId: session.user.id, hostUsername: session.user.username, callId: voice.channelId, callName, participants: voice.members.length });
    } else {
      void window.tumacordDesktop.setHosting(null);
    }
  }, [selfVoiceState?.isHost, session.connectionMode, session.user.id, session.user.username, snapshot.channels, voice.channelId, voice.members.length]);

  useEffect(() => () => { void window.tumacordDesktop?.setHosting(null); }, []);

  useEffect(() => {
    if (!socket || selectedChannel?.type !== 'text') return;
    socket.emit('chat:history', selectedChannel.id, (history: ChatMessage[]) => {
      const sorted = [...new Map(history.map((item) => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      setMessages(sorted);
      void mirrorLocally(originRef.current, [], sorted);
      if (syncFilesRef.current) for (const item of sorted) if (item.attachment) void cacheAttachment(socket, item.attachment, session.serverUrl, session.token).catch(() => undefined);
    });
  }, [selectedChannel?.id, selectedChannel?.type, session.serverUrl, session.token, socket]);

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if ((!message.trim() && !pendingFile) || !selectedChannel || selectedChannel.type !== 'text' || attachmentUploading) return;
    const texto = message.trim();
    const escolhido = pendingFile;
    let anexo: ChatAttachment | undefined;
    if (escolhido) {
      setAttachmentUploading(true);
      try { anexo = await uploadAttachment(escolhido.file, session.serverUrl, session.token); }
      catch (error) {
        showToast(error instanceof Error ? error.message : 'Falha ao enviar o arquivo.');
        return;
      }
      finally { setAttachmentUploading(false); }
    }
    socket?.emit('chat:send', { channelId: selectedChannel.id, body: texto, attachment: anexo });
    playSound('messageSent');
    setMessage('');
    setPendingFile(null);
  };

  // Escolher não envia nada: gera a prévia local e mostra. O arquivo só sai
  // deste computador quando a pessoa aperta enviar.
  const selectAttachment = async (file: File) => {
    if (!file.size || file.size > 25 * 1024 * 1024) return showToast('Escolha um arquivo de até 25 MB.');
    setPendingFile({ file, preview: await imagePreview(file) });
  };

  const editMessageBody = (id: string, body: string) => socket?.emit('chat:edit', { id, body: body.trim() });
  const deleteMessageById = (id: string) => { socket?.emit('chat:delete', { id }); setAApagar(null); };

  const downloadAttachment = async (attachment: ChatAttachment) => {
    try {
      const contents = await resolveAttachment(socket, attachment, session.serverUrl, session.token);
      if (replicatesAttachments) await cacheAttachment(socket, attachment, session.serverUrl, session.token);
      downloadBlob(contents, attachment.name);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Falha ao baixar o arquivo.'); }
  };

  const changeFileSync = (enabled: boolean) => {
    // O controle não existe no dedicado, e a mesma regra vale aqui: um caminho
    // que ligasse a replicação por outra porta desfaria o ponto.
    if (!showsAttachmentSync) return;
    setSyncFiles(enabled);
    syncFilesRef.current = attachmentSyncEnabled(session.connectionMode, enabled);
    localStorage.setItem(ATTACHMENT_SYNC_KEY, String(enabled));
    if (syncFilesRef.current) for (const item of messages) if (item.attachment) void cacheAttachment(socket, item.attachment, session.serverUrl, session.token).catch(() => undefined);
    showToast(enabled ? 'Arquivos serão mantidos neste computador.' : 'Novos arquivos só serão baixados quando você pedir.');
  };

  const openChannel = (channel: Channel) => {
    setSelectedChannelId(channel.id);
    // Abrir um canal sai da mesa: o quadro continua inteiro do outro lado, e
    // voltar para ele é um clique. Deixar a mesa por cima do canal escolhido
    // seria mostrar uma coisa e dizer outra no topo.
    if (boards.active) boards.close();
    if (channel.type === 'voice' && voice.channelId !== channel.id) void voice.join(channel.id);
  };

  /**
   * Assistir a live de alguém a partir da lista lateral.
   *
   * Pode exigir entrar na call antes, e isso é dito no próprio botão — o texto
   * muda para "Entrar e assistir" quando é o caso. Nada é assinado antes do
   * ingresso: o pedido fica guardado e vira inscrição quando o anúncio daquela
   * transmissão chega, que é quando esta cópia sabe a qual live ele se refere.
   */
  const watchMemberLive = useCallback(async (member: VoiceState, channel: Channel) => {
    if (voice.watching[member.socketId]) {
      voice.stopWatchingLive(member.socketId);
      return;
    }
    if (voice.channelId !== channel.id) {
      try {
        await voice.join(channel.id);
      } catch {
        showToast('Não consegui entrar na call para assistir. Tente entrar pelo canal de voz.');
        return;
      }
    }
    voice.requestWatchLive(member.socketId);
  }, [showToast, voice]);

  // O `+` abre um modal, e não um `window.prompt`.
  //
  // O `prompt` do navegador não tem validação, não mostra progresso, não sabe
  // dizer um erro do servidor e não é acessível: ele bloqueia a janela inteira
  // e o que volta é uma string ou `null`. E o emit era disparado sem
  // acknowledge — um nome recusado pelo servidor sumia sem explicação, e um
  // clique repetido mandava dois pedidos.
  const requestChannelCreation = useCallback(async (type: Channel['type'], name: string): Promise<{ ok: boolean; error?: string }> => {
    if (!socket) return { ok: false, error: 'Sem conexão com o servidor. Tente de novo em instantes.' };
    return new Promise((resolve) => {
      let answered = false;
      // Sucesso só depois da confirmação. Sem prazo, um servidor que não
      // responde deixaria o modal girando para sempre.
      const deadline = window.setTimeout(() => {
        if (answered) return;
        answered = true;
        resolve({ ok: false, error: 'O servidor não respondeu. O canal pode ter sido criado — confira a lista antes de tentar de novo.' });
      }, 10_000);
      socket.emit('channel:create', { name, type }, (reply: { ok?: boolean; error?: string } | undefined) => {
        if (answered) return;
        answered = true;
        window.clearTimeout(deadline);
        if (reply?.ok) {
          showToast(type === 'voice' ? 'Call criada.' : 'Canal criado.');
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, error: reply?.error || 'Não consegui criar o canal.' });
      });
    });
  }, [showToast, socket]);

  const currentVoiceChannel = snapshot.channels.find((channel) => channel.id === voice.channelId);
  /**
   * Os membros de um canal de voz, o mais fresco que houver.
   *
   * O instantâneo do servidor é a fonte para os canais em que esta pessoa NÃO
   * está: ele é a única que existe para eles. Mas para o canal em que ela está,
   * `voice:members` é melhor por dois motivos — ele é emitido só para a sala,
   * e ele chega em todo `voice:ping`.
   *
   * O instantâneo, não: `voice:ping` atualiza a sala no servidor mas emite
   * apenas `voice:members`. Lendo só o instantâneo, o ping da tela de call
   * dependia de **outro** evento qualquer disparar um instantâneo — na prática,
   * de alguém falar. Sem ninguém falando, ele ficava em "medindo" indefinidamente.
   */
  const membrosDoCanal = (canalId: string) => (voice.channelId === canalId && voice.members.length
    ? voice.members
    : snapshot.voiceRooms[canalId] ?? []);
  const selectedMembers = selectedChannel?.type === 'voice' ? membrosDoCanal(selectedChannel.id) : [];
  const allVoiceMembers = [...new Map(Object.values(snapshot.voiceRooms).flat().map((member) => [member.id, member])).values()];
  const currentUser = snapshot.onlineUsers.find((user) => user.id === session.user.id) ?? session.user;
  const isServerAdmin = session.connectionMode === 'server' && Boolean(currentUser.isAdmin);
  // Quem vê o `+`. O dono do dedicado é administrador e entra aqui; um membro
  // comum, não. No P2P a criação de canais não existe — há uma conversa e uma
  // call, e um botão que promete outra coisa seria uma promessa falsa.
  //
  // Esconder o botão é conveniência: quem decide de verdade é o servidor, sobre
  // o papel persistido, e um cliente que chame o socket direto passa pela mesma
  // conferência.
  const canCreateChannel = isServerAdmin;
  const activeRemoteScreen = voice.remoteMedia.find((media) => media.kind === 'screen' && media.stream.getVideoTracks().some((track) => track.readyState === 'live'));
  const browsingText = selectedChannel?.type !== 'voice';
  const backgroundVoiceMedia = browsingText ? voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length === 0) : [];
  /**
   * De quem é esta mídia, mesmo antes de o peer estar completo.
   *
   * Igual ao da tela de call, e pelo mesmo motivo: existe um instante depois de
   * alguém entrar em que `media.user` ainda não chegou, e nesse instante o
   * silêncio não encontrava a quem se aplicar. O `socketId` sempre existe.
   */
  const donoDaMidia = (media: { peerId: string; user?: PublicUser }) =>
    media.user?.id ?? voice.members.find((member) => member.socketId === media.peerId)?.id;
  useEffect(() => { setMiniLiveHidden(false); }, [activeRemoteScreen?.stream.id, selectedChannelId]);
  useEffect(() => { setVoiceMenuUserId(null); }, [selectedChannelId, voice.channelId]);
  // Um único ponto troca a saída de áudio. Fazer isso por elemento de mídia
  // reiniciava a saída várias vezes seguidas e derrubava o som da call.
  useEffect(() => { setSharedAudioSink(devices.preferences.speakerId); }, [devices.preferences.speakerId]);

  /** Quem a sala diz que está sem permissão de falar: a voz dessa pessoa não toca. */
  const vozBloqueada = (media: { peerId: string }) => Boolean(voice.members.find((member) => member.socketId === media.peerId)?.speakBlocked);

  const makeCallHost = async (member: VoiceState) => {
    const resultado = await voice.setCallHost(member.socketId);
    showToast(resultado.ok ? `${member.id === session.user.id ? 'Você' : member.username} agora é host da call.` : resultado.error ?? 'Não consegui trocar o host da call.');
  };

  const disconnectFromCall = async (member: VoiceState) => {
    const resultado = await voice.disconnectMember(member.socketId);
    showToast(resultado.ok ? `${member.username} foi desconectado da call.` : resultado.error ?? 'Não consegui desconectar essa pessoa.');
  };

  /**
   * O menu do botão direito sobre alguém numa call.
   *
   * Tudo que já dava para fazer clicando está aqui junto, e a administração
   * ganha "Desconectar da call". Esconder a opção de quem não administra é só
   * conveniência: o servidor confere o papel de novo antes de tirar alguém.
   */
  const openMemberMenu = (event: React.MouseEvent, member: VoiceState, channel?: Channel) => {
    event.preventDefault();
    const self = member.id === session.user.id;
    const naMinhaCall = voice.members.some((candidate) => candidate.socketId === member.socketId);
    const items: ContextMenuEntry[] = [{ label: self ? 'Ver meu perfil' : 'Ver perfil', icon: 'users', onSelect: () => setProfileUser(member) }];
    if (!self && naMinhaCall) {
      if (!sidebarCompact) items.push({ label: 'Ajustar volume', icon: 'volume', onSelect: () => setVoiceMenuUserId(member.id) });
      items.push(mutedUsers[member.id]
        ? { label: 'Voltar a ouvir', icon: 'volume', onSelect: () => setUserMuted(member.id, false) }
        : { label: 'Silenciar para mim', icon: 'volumeOff', onSelect: () => setUserMuted(member.id, true) });
    }
    if (!self && member.screen && channel) {
      const assistindo = Boolean(voice.watching[member.socketId]);
      items.push({ label: assistindo ? 'Parar de assistir' : 'Assistir a transmissão', icon: assistindo ? 'close' : 'screen', onSelect: () => void watchMemberLive(member, channel) });
    }
    // Trocar o host é da administração, e só no P2P híbrido — onde o host é um
    // marcador da call. O servidor confere o papel de novo antes de trocar.
    if (isServerAdmin && !member.isHost) {
      items.push({ separator: true });
      items.push({ label: self ? 'Assumir como host da call' : 'Tornar host da call', icon: 'host', onSelect: () => void makeCallHost(member) });
    }
    if (isServerAdmin && !self) {
      if (member.isHost) items.push({ separator: true });
      items.push({ label: 'Desconectar da call', icon: 'leave', danger: true, hint: 'Tira a pessoa da call agora. Ela pode entrar de novo, a menos que perca a permissão no canal.', onSelect: () => void disconnectFromCall(member) });
    }
    setContextMenu({ x: event.clientX, y: event.clientY, title: member.username, items });
  };

  const openChannelMenu = (event: React.MouseEvent, channel: Channel) => {
    if (!isServerAdmin) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, title: channel.name, items: [
      { label: 'Editar canal e permissões', icon: 'settings', onSelect: () => setEditingChannelId(channel.id) },
    ] });
  };

  const editingChannel = editingChannelId ? snapshot.channels.find((channel) => channel.id === editingChannelId) : undefined;
  const bloqueado = (channel: Channel) => Boolean(channel.access && (channel.type === 'voice' ? !channel.access.connect : !channel.access.send));

  const compactSidebar = <aside className="channel-sidebar is-compact" aria-label="Canais e calls">
    <header className="server-header"><img className="compact-logo" src={logoUrl} alt="Tumacord" /></header>
    <div className="channel-scroll">
      {(['text', 'voice'] as const).map((tipo) => <div key={tipo} className="compact-group">
        {visibleChannels.filter((channel) => channel.type === tipo).map((channel) => <div key={channel.id} className="compact-channel">
          <button
            className={`compact-channel-button ${selectedChannelId === channel.id ? 'selected' : ''} ${voice.channelId === channel.id ? 'connected' : ''} ${bloqueado(channel) ? 'is-locked' : ''}`}
            onClick={() => openChannel(channel)}
            onContextMenu={(event) => openChannelMenu(event, channel)}
            title={channel.name}
            aria-label={channel.name}
          ><Icon name={channel.type === 'voice' ? 'voice' : 'hash'} />{voice.channelId === channel.id && <i />}</button>
          {channel.type === 'voice' && membrosDoCanal(channel.id).map((member) => {
            const self = member.id === session.user.id;
            const assistindo = Boolean(voice.watching[member.socketId]);
            const mudo = member.muted || Boolean(mutedUsers[member.id]);
            return <div className="compact-member" key={member.socketId}>
              <button
                className={`compact-avatar ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`}
                onClick={() => setProfileUser(member)}
                onContextMenu={(event) => openMemberMenu(event, member, channel)}
                title={`${member.username}${member.screen ? ' · transmitindo' : ''}${mudo ? ' · sem som' : ''}${member.pingMs < 9999 ? ` · ${member.pingMs} ms` : ''}`}
              >
                <Avatar name={member.username} profile={member.profile} serverUrl={session.serverUrl} small />
                {mudo && <span className="compact-badge is-muted"><Icon name="micOff" /></span>}
                {member.screen && <span className="compact-badge is-live" />}
              </button>
              {!self && member.screen && <button className={`compact-watch ${assistindo ? 'is-watching' : ''}`} onClick={() => void watchMemberLive(member, channel)} title={assistindo ? `Parar de assistir ${member.username}` : `Assistir ${member.username}`} aria-label={assistindo ? `Parar de assistir ${member.username}` : `Assistir ${member.username}`}><Icon name={assistindo ? 'close' : 'screen'} /></button>}
            </div>;
          })}
        </div>)}
      </div>)}
    </div>
    {voice.channelId && <div className="voice-status is-compact"><button onClick={voice.leave} title={`Sair de ${currentVoiceChannel?.name ?? 'call'}`} aria-label="Sair da call"><Icon name="leave" /></button></div>}
    <div className="user-panel is-compact">
      <button className="profile-summary" onClick={() => setProfileUser(session.user)} title={`${session.user.username} · ${connected ? 'online' : 'reconectando'}`}><Avatar name={session.user.username} profile={session.user.profile} serverUrl={session.serverUrl} small online /></button>
      <button className={voice.muted ? 'danger-active' : ''} onClick={() => void voice.toggleMute()} title="Microfone"><Icon name={voice.muted ? 'micOff' : 'mic'} /></button>
      <button className={voice.deafened ? 'danger-active' : ''} onClick={voice.toggleDeafen} title="Áudio"><Icon name="headphones" /></button>
      <button onClick={() => setSettingsOpen(true)} title="Configurações"><Icon name="settings" /></button>
    </div>
  </aside>;

  return <div className={`app-shell ${sidebarCompact ? 'sidebar-compact' : ''} ${immersive ? 'is-immersive' : ''}`}>
    <nav className="server-rail" aria-label="Servidor Tumacord">
      <button className="server-icon active" title="Tumacord"><span className="server-icon-art"><img src={logoUrl} alt="Tumacord" /></span></button>
    </nav>

    {sidebarCompact ? compactSidebar : <aside className="channel-sidebar">
      <header className="server-header"><span className="brand-mark">Tuma<span>cord</span></span></header>
      <div className="channel-scroll">
        {(window.tumacordDesktop || session.connectionMode === 'server') && <section className="direct-link-actions">
          <div className="group-title"><span>{session.connectionMode === 'server' ? 'Convites' : 'Enlace direto'}</span></div>
          <button className="direct-link-button" onClick={() => setInviteOpen(true)}><Icon name="users" /><span><strong>Convidar pela internet</strong><small>Gera um código com os caminhos até este computador</small></span></button>
          <button className="direct-link-button" onClick={() => setJoinInviteOpen(true)}><Icon name="server" /><span><strong>Entrar por convite</strong><small>Cole o código de quem já está na call</small></span></button>
        </section>}
        {discoveredCalls.length > 0 && <section className="network-calls"><div className="group-title"><span>Calls na rede</span><i className="live-dot" /></div>{discoveredCalls.map((call) => <button className="network-call" key={`${call.hostId}:${call.callId}`} onClick={() => void enterDiscoveredCall(call)}><div><strong>{call.callName}</strong><span>{call.hostUsername} · {call.participants} {call.participants === 1 ? 'pessoa' : 'pessoas'}</span></div><small>{call.pingMs} ms</small></button>)}</section>}
        <ChannelGroup title={session.connectionMode === 'server' ? 'Canais de texto' : 'Conversa'} onAdd={canCreateChannel ? () => setCreatingChannelType('text') : undefined}>
          {visibleChannels.filter((channel) => channel.type === 'text').map((channel) => <ChannelButton key={channel.id} channel={channel} selected={selectedChannelId === channel.id} locked={bloqueado(channel)} onClick={() => openChannel(channel)} onContextMenu={(event) => openChannelMenu(event, channel)} onEdit={isServerAdmin ? () => setEditingChannelId(channel.id) : undefined} />)}
        </ChannelGroup>
        <ChannelGroup title={session.connectionMode === 'server' ? 'Canais de voz' : 'Call do grupo'} onAdd={canCreateChannel ? () => setCreatingChannelType('voice') : undefined}>
          {visibleChannels.filter((channel) => channel.type === 'voice').map((channel) => <div key={channel.id}>
            <ChannelButton channel={channel} selected={selectedChannelId === channel.id} connected={voice.channelId === channel.id} locked={bloqueado(channel)} onClick={() => openChannel(channel)} onContextMenu={(event) => openChannelMenu(event, channel)} onEdit={isServerAdmin ? () => setEditingChannelId(channel.id) : undefined} />
            {membrosDoCanal(channel.id).map((member) => {
              const self = member.id === session.user.id;
              const canAdjustVolume = !self && voice.members.some((candidate) => candidate.id === member.id);
              const memberVolume = Math.max(0, Math.min(2, userVolumes[member.id] ?? 1));
              const assistindo = Boolean(voice.watching[member.socketId]);
              const naMesmaCall = voice.channelId === channel.id;
              // A frase inteira continua sendo dita por `aria-label` e `title`.
              // O rótulo visível encurtou porque agora divide a linha com o
              // nome; encurtar também o que um leitor de tela anuncia seria
              // trocar informação por espaço, e não é a mesma economia.
              const fraseDoBotao = assistindo
                ? `Parar de assistir a transmissão de ${member.username}`
                : naMesmaCall
                  ? `Assistir a transmissão de ${member.username}`
                  : `Entrar na call e assistir a transmissão de ${member.username}`;
              return <div className="voice-member-entry" key={member.socketId}>
                <button className={`voice-member-mini ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`} onContextMenu={(event) => openMemberMenu(event, member, channel)} onClick={() => { if (canAdjustVolume) setVoiceMenuUserId((current) => current === member.id ? null : member.id); else setProfileUser(member); }} title={canAdjustVolume ? `Ajustar volume de ${member.username}` : `Ver perfil de ${member.username}`}>
                  <Avatar name={member.username} profile={member.profile} serverUrl={session.serverUrl} small />
                  {/* Quem já está na call não precisa do ping aqui: a lista de
                      presença, à direita, é o lugar dessa informação. */}
                  <span className="voice-member-copy"><strong>{member.username}</strong>{member.screen && <small><span className="live-dot" /> AO VIVO</small>}</span>
                  <span className="voice-member-icons">{member.isHost && <Icon name="host" />}{(member.muted || mutedUsers[member.id]) && <Icon name="micOff" />}</span>
                </button>
                {/* A live se anuncia aqui, junto da pessoa, e é daqui que se
                    escolhe assistir — na mesma linha do nome, à direita, e não
                    numa linha própria embaixo: uma linha extra por quem
                    transmite empurrava o resto da lista para baixo a cada
                    transmissão que começava, e a lista é por onde se acha gente.
                    O anúncio não abre nada sozinho na área principal: quem
                    decide o que ocupa a tela é quem assiste. */}
                {!self && member.screen && <button
                  className={`voice-member-watch ${assistindo ? 'is-watching' : ''}`}
                  onClick={() => void watchMemberLive(member, channel)}
                  aria-label={fraseDoBotao}
                  title={fraseDoBotao}
                ><Icon name={assistindo ? 'close' : 'screen'} />
                  <span>{assistindo ? 'Parar' : naMesmaCall ? 'Assistir' : 'Entrar'}</span>
                </button>}
                {voiceMenuUserId === member.id && canAdjustVolume && <VoiceMemberVolume member={member} volume={memberVolume} muted={Boolean(mutedUsers[member.id])} onVolume={(volume) => setUserVolume(member.id, volume)} onMuted={(muted) => setUserMuted(member.id, muted)} onProfile={() => setProfileUser(member)} onClose={() => setVoiceMenuUserId(null)} />}
              </div>;
            })}
          </div>)}
        </ChannelGroup>
        {/* A mesa não é um canal: é uma atividade que acontece dentro de um.
            Ela fica aqui embaixo, com o botão de criar no mesmo lugar dos
            outros grupos, e entrar nela é uma escolha explícita. */}
        <ChannelGroup title="Mesas de desenho" addLabel="Criar mesa" onAdd={boards.supported === false ? undefined : () => setBoardPromptOpen(true)}>
          {/* Um botão que não pode funcionar é pior do que botão nenhum: o
              servidor anterior à 0.9.1 não conhece o pedido e nem responde a
              ele. Quem enxerga isso lê o motivo em vez de esperar. */}
          {boards.supported === false && <p className="channel-hint">Este servidor ainda não tem mesas de desenho. Elas chegaram na 0.9.1 — atualize o servidor para usar isso aqui.</p>}
          {boards.supported !== false && boards.boards.map((board) => {
            const canal = snapshot.channels.find((candidate) => candidate.id === board.channelId);
            return <button
              key={board.id}
              className={`board-entry ${boards.active?.board.id === board.id ? 'selected' : ''}`}
              onClick={() => boards.open(board.id)}
              title={`Entrar na mesa ${board.name}`}
            >
              <Icon name="board" />
              <span className="board-entry-copy">
                <strong>{board.name}</strong>
                <small>{board.createdByName} · {canal ? `#${canal.name}` : 'canal removido'}{board.locked ? ' · bloqueada' : board.status === 'closed' ? ' · encerrada' : ''}</small>
              </span>
              {board.participants > 0 && <em className="board-entry-count">{board.participants}</em>}
            </button>;
          })}
          {boards.supported !== false && !boards.boards.length && <p className="channel-hint">Nenhuma mesa por aqui. Crie uma para desenhar junto — não precisa de call nem de transmissão.</p>}
        </ChannelGroup>
      </div>
      {voice.channelId && <div className="voice-status">
        <div><strong>Voz conectada</strong><span>{currentVoiceChannel?.name}</span></div>
        <button onClick={voice.leave} title="Desconectar"><Icon name="leave" /></button>
      </div>}
      <div className="user-panel">
        <button className="profile-summary" onClick={() => setProfileUser(session.user)} title="Abrir e editar seu perfil"><Avatar name={session.user.username} profile={session.user.profile} serverUrl={session.serverUrl} online /><span className="user-copy"><strong>{session.user.username}</strong><small>{connected ? 'Online' : 'Reconectando…'}</small></span></button>
        <button className={voice.muted ? 'danger-active' : ''} onClick={() => void voice.toggleMute()} title="Microfone"><Icon name={voice.muted ? 'micOff' : 'mic'} /></button>
        <button className={voice.deafened ? 'danger-active' : ''} onClick={voice.toggleDeafen} title="Áudio"><Icon name="headphones" /></button>
        <button onClick={() => setSettingsOpen(true)} title="Configurações"><Icon name="settings" /></button>
      </div>
    </aside>}

    <section className="main-panel">
      <header className="topbar">
        <button className={`sidebar-toggle ${sidebarCompact ? 'toolbar-active' : ''}`} onClick={toggleSidebarCompact} aria-pressed={sidebarCompact} title={sidebarCompact ? 'Expandir a barra lateral' : 'Recolher a barra lateral e dar mais espaço às lives'}><Icon name="sidebar" /></button>
        <Icon name={boards.active ? 'board' : selectedChannel?.type === 'voice' ? 'voice' : 'hash'} />
        <strong>{boards.active ? boards.active.board.name : selectedChannel?.name ?? 'Tumacord'}</strong>
        {!boards.active && selectedChannel?.type === 'text' && <span className="channel-topic">Conversa do grupo.</span>}
        {boards.active && <span className="channel-topic">Mesa de desenho{voice.channelId ? ' · a call continua' : ''}</span>}
        <div className="topbar-spacer" />
        <span className={`connection-pill ${connected ? 'online' : ''}`} title={session.connectionMode === 'server' ? session.serverUrl : `Host dinâmico por enlace direto${networkPreferences.zeroTierEnabled ? ', rede local e ZeroTier' : ' e rede local'}`}><i />{connected ? (session.connectionMode === 'server' ? 'Servidor conectado' : 'P2P conectado') : 'Reconectando'}</span>
        {/* No navegador não há ponte de atualização: quem atualiza a versão
            web é o servidor, e um botão que não faz nada seria pior do que
            botão nenhum. */}
        {update.supported && <UpdateButton state={update.state} onOpen={() => setUpdateOpen(true)} />}
        {isServerAdmin && <button className="admin-toolbar-button" onClick={() => setAdminOpen(true)} title="Painel administrativo"><Icon name="shield" /></button>}
        {!boards.active && selectedChannel?.type === 'voice' && <button onClick={() => void setImmersiveMode(true)} title="Tela cheia com as lives (Esc para sair)"><Icon name="maximize" /></button>}
        <button className={memberListOpen ? 'toolbar-active' : ''} onClick={() => setMemberListOpen((value) => !value)} title="Membros"><Icon name="users" /></button>
      </header>
      <div className="content-row">
        {boards.active
          ? <Boundary title="A mesa precisou ser redesenhada"><Whiteboard session={boards.active} api={boards} currentUserId={session.user.id} connectionMode={session.connectionMode ?? 'p2p'} onNotice={showToast} onClose={boards.close} /></Boundary>
          : selectedChannel?.type === 'voice'
          ? <Boundary title="A call precisou ser redesenhada"><CallView voice={voice} channel={selectedChannel} members={selectedMembers} speakerId={devices.preferences.speakerId} userVolumes={userVolumes} streamVolume={streamVolume} setStreamVolume={setStreamVolume} streamMuted={streamMuted} setStreamMuted={setStreamMuted} mutedUsers={mutedUsers} serverUrl={session.serverUrl} onProfile={setProfileUser} onNotice={showToast} immersive={immersive} onImmersive={(on) => void setImmersiveMode(on)} onMemberMenu={(event, member) => openMemberMenu(event, member, selectedChannel)} onOpenMenu={setContextMenu} canStream={selectedChannel.access?.stream !== false} /></Boundary>
          : <ChatView channel={selectedChannel} messages={messages} message={message} setMessage={setMessage} sendMessage={(event) => void sendMessage(event)} pendingFile={pendingFile} uploading={attachmentUploading} syncFiles={replicatesAttachments} showFileSync={showsAttachmentSync} onFile={(file) => void selectAttachment(file)} onClearAttachment={() => setPendingFile(null)} onSyncFiles={changeFileSync} onDownload={downloadAttachment} serverUrl={session.serverUrl} token={session.token} me={session.user} onEdit={editMessageBody} onAskDelete={setAApagar} />}
        {memberListOpen && !boards.active && <MemberList users={snapshot.onlineUsers} voiceMembers={allVoiceMembers} currentUserId={session.user.id} serverUrl={session.serverUrl} onProfile={setProfileUser} />}
      </div>
    </section>

    {backgroundVoiceMedia.map((media) => <MediaElement key={`background:${media.peerId}:${media.stream.id}`} stream={media.stream} muted={voice.deafened || vozBloqueada(media) || Boolean(donoDaMidia(media) && mutedUsers[donoDaMidia(media)!])} volume={donoDaMidia(media) ? Math.max(0, Math.min(2, userVolumes[donoDaMidia(media)!] ?? 1)) : 1} speakerId={devices.preferences.speakerId} audioOnly remote />)}
    {browsingText && activeRemoteScreen && !miniLiveHidden && <FloatingLivePlayer media={activeRemoteScreen} speakerId={devices.preferences.speakerId} muted={voice.deafened || streamMuted} volume={streamVolume} rawVolume={streamVolume} onVolume={(volume) => { setStreamMuted(false); setStreamVolume(volume); }} onMute={() => setStreamMuted(!streamMuted)} onOpen={() => { if (voice.channelId) setSelectedChannelId(voice.channelId); }} onClose={() => setMiniLiveHidden(true)} onNotice={showToast} />}

    {updateOpen && <UpdateModal bridge={update} onClose={() => setUpdateOpen(false)} onNotice={showToast} />}
    {update.state?.installedRelease && update.state.notesSeen !== update.state.installed && <WhatsNewModal release={update.state.installedRelease} onClose={() => update.markNotesSeen(update.state?.installed ?? '')} onOpenPage={update.openPage} />}
    {settingsOpen && <SettingsModal devices={devices} quality={voice.quality} setQuality={voice.setQuality} soundEnabled={soundEnabled} setSoundEnabled={changeSoundPreference} soundVolume={soundVolume} setSoundVolume={changeSoundVolume} networkPreferences={networkPreferences} onNetworkPreferences={(patch) => { void updateNetworkPreferences(patch).then(setNetworkPreferences); }} mediaSnapshot={voice.mediaSnapshot} audioSupport={voice.screenAudioSupport} connectionMode={session.connectionMode ?? 'p2p'} onNotice={showToast} onClose={() => setSettingsOpen(false)} onLogout={onLogout} onSwitchAccount={onSwitchAccount} />}
    {inviteOpen && <InviteModal callId={voice.channelId ?? currentVoiceChannel?.id ?? 'call-geral'} callName={currentVoiceChannel?.name ?? 'Call do grupo'} hostUsername={session.user.username} server={session.connectionMode === 'server' ? session.serverUrl : undefined} serverToken={session.token} serverKey={session.directKey} onClose={() => setInviteOpen(false)} onNotice={showToast} />}
    {joinInviteOpen && <JoinInviteModal onJoin={enterInvitedCall} onNeedsLogin={() => { setJoinInviteOpen(false); onLogout(); }} onClose={() => setJoinInviteOpen(false)} onNotice={showToast} />}
    {aApagar && <ConfirmDialog
      title="Apagar esta mensagem?"
      body={<>O texto e o anexo saem para todo mundo. No modo P2P a exclusão alcança quem estiver offline assim que voltar.</>}
      confirmLabel="Apagar"
      onConfirm={() => deleteMessageById(aApagar.id)}
      onClose={() => setAApagar(null)}
    />}
    {boardPromptOpen && <NewBoardModal channelName={selectedChannel?.name ?? 'geral'} onCreate={createBoard} onClose={() => setBoardPromptOpen(false)} />}
    {creatingChannelType && canCreateChannel && <NewChannelModal type={creatingChannelType} onCreate={requestChannelCreation} onClose={() => setCreatingChannelType(null)} />}
    {adminOpen && <AdminPanel serverUrl={session.serverUrl} token={session.token} currentUserId={session.user.id} onClose={() => setAdminOpen(false)} onNotice={showToast} />}
    {voice.showShareSetup && <ShareSetupModal initialQuality={voice.quality} busy={voice.shareBusy} audioSupport={voice.screenAudioSupport} onContinue={(includeAudio, selectedQuality) => { setShareAudio(includeAudio); void voice.prepareScreenShare(includeAudio, selectedQuality); }} onClose={() => voice.setShowShareSetup(false)} />}
    {voice.showSourcePicker && <SourcePicker sources={voice.desktopSources} busy={voice.shareBusy} withAudio={shareAudio && voice.screenAudioSupport.supported !== false} onSelect={(id, kind) => void voice.shareDesktopSource(id, kind)} onBack={() => { voice.setShowSourcePicker(false); voice.setShowShareSetup(true); }} onClose={() => voice.setShowSourcePicker(false)} />}
    {profileUser && <ProfileModal user={snapshot.onlineUsers.find((candidate) => candidate.id === profileUser.id) ?? (profileUser.id === session.user.id ? session.user : profileUser)} own={profileUser.id === session.user.id} serverUrl={session.serverUrl} token={session.token} onClose={() => setProfileUser(null)} onSaved={(updated) => { const nextSession = { ...session, user: updated }; saveSession(nextSession); onSessionChange(nextSession); setProfileUser(updated); showToast('Perfil atualizado.'); }} />}
    {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
    {editingChannel && isServerAdmin && <ChannelSettingsModal channel={editingChannel} serverUrl={session.serverUrl} token={session.token} onClose={() => setEditingChannelId(null)} onNotice={showToast} />}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function ChannelGroup({ title, onAdd, addLabel = 'Criar canal', children }: { title: string; onAdd?: () => void; addLabel?: string; children: React.ReactNode }) {
  return <section className="channel-group"><div className="group-title"><span>{title}</span>{onAdd && <button onClick={onAdd} title={addLabel}><Icon name="plus" /></button>}</div>{children}</section>;
}

function ChannelButton({ channel, selected, connected, locked, onClick, onContextMenu, onEdit }: { channel: Channel; selected: boolean; connected?: boolean; locked?: boolean; onClick: () => void; onContextMenu?: (event: React.MouseEvent) => void; onEdit?: () => void }) {
  return <div className={`channel-row ${onEdit ? 'is-editable' : ''}`}>
    <button className={`channel-button ${selected ? 'selected' : ''} ${connected ? 'connected' : ''}`} onClick={onClick} onContextMenu={onContextMenu} title={locked ? (channel.type === 'voice' ? 'Você pode ver esta call, mas não entrar nela' : 'Você pode ler este canal, mas não escrever nele') : channel.topic || undefined}>
      <Icon name={channel.type === 'voice' ? 'voice' : 'hash'} /><span>{channel.name}</span>{locked && <Icon name="lock" className="channel-lock" />}{connected && <i />}
    </button>
    {/* Irmão do botão, e não filho: um botão dentro de outro não é HTML válido
        e o clique iria para os dois. */}
    {onEdit && <button className="channel-edit" onClick={onEdit} title={`Editar ${channel.name}`} aria-label={`Editar ${channel.name}`}><Icon name="settings" /></button>}
  </div>;
}

interface ChatViewProps {
  channel?: Channel;
  messages: ChatMessage[];
  message: string;
  setMessage: (text: string) => void;
  sendMessage: (event: FormEvent) => void;
  pendingFile: { file: File; preview?: string } | null;
  uploading: boolean;
  syncFiles: boolean;
  /** Se o controle de sincronizar aparece. Falso no dedicado. */
  showFileSync: boolean;
  onFile: (file: File) => void;
  onClearAttachment: () => void;
  onSyncFiles: (enabled: boolean) => void;
  onDownload: (attachment: ChatAttachment) => void;
  serverUrl: string;
  /** A sessão, para pedir as prévias de link ao servidor. */
  token: string;
  /** Quem sou eu, para saber quais mensagens são minhas de mexer. */
  me: PublicUser;
  onEdit: (id: string, body: string) => void;
  onAskDelete: (message: ChatMessage) => void;
}

function ChatView({ channel, messages, message, setMessage, sendMessage, pendingFile, uploading, syncFiles, showFileSync, onFile, onClearAttachment, onSyncFiles, onDownload, serverUrl, token, me, onEdit, onAskDelete }: ChatViewProps) {
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [editando, setEditando] = useState<{ id: string; body: string } | null>(null);
  // As lápides não aparecem. Elas existem para que a mensagem apagada não
  // volte pela replicação, e não para dizer que existiu.
  const visiveis = visibleMessages(messages);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  const salvarEdicao = () => {
    if (!editando) return;
    const corpo = editando.body.trim();
    if (corpo) onEdit(editando.id, corpo);
    setEditando(null);
  };
  return <main className="chat-view">
    <div className="message-list">
      <div className="channel-welcome"><div className="welcome-icon"><Icon name="hash" /></div><h1>Bem-vindo a #{channel?.name}</h1><p>Este é o começo do canal. Puxa uma cadeira.</p></div>
      {visiveis.map((item, index) => {
        const compact = index > 0 && visiveis[index - 1].author.id === item.author.id && new Date(item.createdAt).getTime() - new Date(visiveis[index - 1].createdAt).getTime() < 300_000;
        const minha = item.author.id === me.id || item.author.username === me.username;
        const emEdicao = editando?.id === item.id;
        return <article className={`message ${compact ? 'compact' : ''} ${emEdicao ? 'is-editing' : ''}`} key={item.id}>
          {!compact && <Avatar name={item.author.username} profile={item.author.profile} serverUrl={serverUrl} />}
          <div>
            {!compact && <div className="message-head"><strong>{item.author.username}</strong><time>{new Date(item.createdAt).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</time></div>}
            {emEdicao
              ? <div className="message-edit">
                  <input autoFocus value={editando.body} maxLength={2000} onChange={(event) => setEditando({ id: item.id, body: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); salvarEdicao(); } if (event.key === 'Escape') setEditando(null); }} />
                  <div><button type="button" onClick={salvarEdicao}>Salvar</button><button type="button" className="ghost" onClick={() => setEditando(null)}>Cancelar</button></div>
                </div>
              : item.body && <p><MessageText body={item.body} />{item.editedAt && <em title={`Editada em ${new Date(item.editedAt).toLocaleString('pt-BR')}`}>(editada)</em>}</p>}
            {!emEdicao && item.body && <LinkPreviews body={item.body} serverUrl={serverUrl} token={token} />}
            {item.attachment && <div className="message-attachment">{item.attachment.previewDataUrl ? <img src={item.attachment.previewDataUrl} alt="Prévia leve do arquivo" /> : <span className="attachment-file-icon"><Icon name="file" /></span>}<div><strong>{item.attachment.name}</strong><small>{formatFileSize(item.attachment.size)} · prévia local leve</small></div><button onClick={() => onDownload(item.attachment!)} title="Baixar arquivo"><Icon name="download" /></button></div>}
          </div>
          {minha && !emEdicao && <div className="message-actions">
            {item.body && <button type="button" onClick={() => setEditando({ id: item.id, body: item.body })} title="Editar"><Icon name="pencil" /></button>}
            <button type="button" className="danger" onClick={() => onAskDelete(item)} title="Apagar"><Icon name="trash" /></button>
          </div>}
        </article>;
      })}<div ref={bottom} />
    </div>
    <div className="chat-composer">
      {/* No dedicado quem guarda e autoriza os anexos é o servidor: a
          permanência já existe, e replicar tudo no disco de cada pessoa
          espalharia cópias de arquivos que o servidor controla por máquinas
          que ele não controla. O controle some — e, junto com ele, a
          replicação: esconder sem desligar era o defeito. */}
      {showFileSync && <label className="file-sync-toggle" title="Quando ativo, o arquivo completo fica guardado neste PC"><input type="checkbox" checked={syncFiles} onChange={(event) => onSyncFiles(event.target.checked)} /><Icon name="syncFile" /><span>Sincronizar arquivos neste PC</span></label>}
      {/* O que vai ser enviado, antes de ser enviado. O arquivo ainda está
          neste computador: fechar aqui não desfaz upload nenhum. */}
      {pendingFile && <div className="pending-attachment">
        {pendingFile.preview ? <img src={pendingFile.preview} alt="Prévia da imagem escolhida" /> : <span className="attachment-file-icon"><Icon name="file" /></span>}
        <span><strong>{pendingFile.file.name}</strong><small>{formatFileSize(pendingFile.file.size)}{uploading ? ' · enviando…' : ''}</small></span>
        <button type="button" disabled={uploading} onClick={onClearAttachment} title="Não enviar este arquivo"><Icon name="close" /></button>
      </div>}
      {channel?.access?.send === false ? <div className="chat-readonly"><Icon name="lock" /><span>Você pode ler este canal, mas a administração não liberou mensagens suas aqui.</span></div> : <form className="message-box" onSubmit={sendMessage}><input ref={fileInput} className="hidden-file-input" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} /><button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} title="Anexar arquivo"><Icon name="plus" /></button><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Conversar em #${channel?.name ?? ''}`} maxLength={2000} /><button className="send-button" aria-label="Enviar" disabled={uploading || (!message.trim() && !pendingFile)}><Icon name={uploading ? 'syncFile' : 'send'} /></button></form>}
    </div>
  </main>;
}

interface VoiceViewModel {
  /** O `socketId` desta pessoa, para saber quem assiste à transmissão dela. */
  selfSocketId: string;
  /** O recado de "já volto" desta pessoa. Vazio quer dizer presente. */
  away: string;
  setAway: (message: string, theme: string, size?: number) => void;
  /** A administração tirou desta pessoa a permissão de falar nesta call. */
  selfSpeakBlocked: boolean;
  channelId: string | null;
  members: VoiceState[];
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  remoteMedia: RemoteMedia[];
  peerHealth: Record<string, PeerHealth>;
  /** As lives anunciadas por cada peer, com o id daquela transmissão. */
  liveOffers: Record<string, string>;
  /** A qual live desta pessoa eu disse sim, por peer. */
  watching: Record<string, string>;
  watchLive: (peerId: string, streamId: string) => void;
  /** Pedir para assistir mesmo antes de o anúncio daquela live ter chegado. */
  requestWatchLive: (peerId: string, streamId?: string) => void;
  stopWatchingLive: (peerId: string) => void;
  recoverPeer: (peerId: string, reason?: string, notifyRemote?: boolean) => void;
  recoverAllPeers: () => number;
  localCamera?: MediaStream;
  localScreen?: MediaStream;
  join: (id: string) => Promise<void>;
  leave: () => void;
  toggleMute: () => Promise<void>;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  requestScreenShare: () => Promise<void>;
  quality: StreamQuality;
  setQuality: (quality: StreamQuality) => Promise<boolean>;
  user: { id: string; username: string };
}

const HIDE_OWN_SCREEN_KEY = 'tumacord.hide-own-screen';

function CallView({ voice, channel, members, speakerId, userVolumes, mutedUsers, streamVolume, setStreamVolume, streamMuted, setStreamMuted, serverUrl, onProfile, onNotice, immersive, onImmersive, onMemberMenu, onOpenMenu, canStream }: { voice: VoiceViewModel; channel: Channel; members: VoiceState[]; speakerId: string; userVolumes: Record<string, number>; mutedUsers: Record<string, boolean>; streamVolume: number; setStreamVolume: (volume: number) => void; streamMuted: boolean; setStreamMuted: (muted: boolean) => void; serverUrl: string; onProfile: (user: PublicUser) => void; onNotice: (message: string) => void; immersive: boolean; onImmersive: (on: boolean) => void; onMemberMenu: (event: React.MouseEvent, member: VoiceState) => void; onOpenMenu: (menu: ContextMenuState) => void; canStream: boolean }) {
  const [theaterMediaKey, setTheaterMediaKey] = useState<string | null>(null);
  // Ampliar outro quadro desmontava o quadro solto, e com ele ia a janela
  // flutuante junto. Quem está solto continua montado.
  const [detachedKeys, setDetachedKeys] = useState<Set<string>>(() => new Set());
  const trackDetached = useCallback((key: string, detached: boolean) => {
    setDetachedKeys((current) => {
      if (current.has(key) === detached) return current;
      const next = new Set(current);
      if (detached) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const inThisCall = voice.channelId === channel.id;
  const videoMedia = voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length > 0);
  const visibleVideoMedia = videoMedia;
  const audioMedia = voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length === 0);
  const tiles = inThisCall ? voice.members : members;
  const expectedRemoteStreams = voice.members.filter((member) => member.id !== voice.user.id && member.screen);
  // Quem está transmitindo e ainda não recebeu um "sim" desta pessoa. A mídia
  // não chega enquanto isso: a inscrição controla o recebimento, e não um
  // elemento de vídeo escondido.
  const semMidia = expectedRemoteStreams.filter((member) => !videoMedia.some((media) => media.kind === 'screen' && (media.user?.id === member.id || media.peerId === member.socketId)));
  // "Ainda não chegou" só faz sentido para quem pediu para assistir.
  const missingStreams = semMidia.filter((member) => Boolean(voice.watching[member.socketId]));
  const watchingLive = visibleVideoMedia.some((media) => media.kind === 'screen');
  const volumeFor = (userId?: string) => userId ? Math.max(0, Math.min(2, userVolumes[userId] ?? 1)) : 1;
  /**
   * Quem é o dono desta mídia, mesmo antes de o peer estar completo.
   *
   * `media.user` é preenchido a partir do membro da sala **ou** do que veio na
   * oferta, e existe um instante — logo depois de alguém entrar — em que
   * nenhum dos dois chegou ainda. Nesse instante `media.user` é indefinido, o
   * silêncio não encontrava a quem se aplicar, e a pessoa voltava a ser ouvida
   * até algo forçar um novo cálculo. Era este o furo de "mutar não mantém
   * quando a pessoa sai e entra de novo".
   *
   * O `socketId` sempre existe, então a sala serve de rede de segurança.
   */
  const ownerOf = (media: { peerId: string; user?: PublicUser }) =>
    media.user?.id ?? members.find((member) => member.socketId === media.peerId)?.id;
  /** O membro da sala por trás de um peer, para ler o recado dele. */
  const memberOf = (peerId: string) => members.find((member) => member.socketId === peerId);
  /** O tema do MEU cartão vem da minha configuração, e não da rede. */
  const awayTheme = readAwayTheme();
  const mutedFor = (media: { peerId: string; user?: PublicUser }) => {
    const userId = ownerOf(media);
    return Boolean(userId && mutedUsers[userId]);
  };
  /** A voz de quem a administração emudeceu não toca, nem se o cliente dela insistir. */
  const speakBlockedFor = (media: { peerId: string }) => Boolean(memberOf(media.peerId)?.speakBlocked);

  // Ver a própria live é opcional. Ela continua no ar para quem assiste; o que
  // some é o quadro na SUA tela — que não mostra nada que você não esteja vendo
  // no monitor, e rouba espaço das lives dos outros. A escolha fica guardada.
  const [hideOwnScreen, setHideOwnScreenState] = useState(() => {
    try { return localStorage.getItem(HIDE_OWN_SCREEN_KEY) === 'true'; } catch { return false; }
  });
  const setHideOwnScreen = useCallback((hidden: boolean) => {
    setHideOwnScreenState(hidden);
    try { localStorage.setItem(HIDE_OWN_SCREEN_KEY, String(hidden)); } catch { /* vale só nesta sessão */ }
    if (hidden) setTheaterMediaKey((atual) => (atual === 'local-screen' ? null : atual));
  }, []);
  const ownScreenVisible = Boolean(voice.localScreen) && !hideOwnScreen;

  /**
   * Os espectadores de cada transmissão, indexados por quem transmite.
   *
   * Derivado da sala, e não guardado à parte: cada pessoa declara o que está
   * assistindo no próprio estado de voz, e a lista de espectadores é o inverso
   * disso. Duas metades guardadas separadamente divergiriam — alguém sai da
   * call e some de um lado sem sumir do outro.
   */
  const watchersByStreamer = useMemo(() => {
    const porTransmissor = new Map<string, VoiceState[]>();
    for (const member of members) {
      if (!member.watching) continue;
      const lista = porTransmissor.get(member.watching) ?? [];
      lista.push(member);
      porTransmissor.set(member.watching, lista);
    }
    return porTransmissor;
  }, [members]);

  const myWatchers = useMemo(
    () => (voice.selfSocketId ? watchersByStreamer.get(voice.selfSocketId) ?? [] : []),
    [voice.selfSocketId, watchersByStreamer],
  );

  // O som de alguém abrir ou fechar a sua live.
  //
  // Compara com o conjunto anterior em vez de reagir ao tamanho: duas pessoas
  // trocando de lugar no mesmo instante manteriam a contagem igual, e as duas
  // mudanças passariam em silêncio.
  const previousWatchers = useRef<Set<string> | null>(null);
  useEffect(() => {
    const agora = new Set(myWatchers.map((watcher) => watcher.socketId));
    const antes = previousWatchers.current;
    previousWatchers.current = agora;
    // A primeira leitura não toca nada: quem já estava assistindo quando esta
    // tela abriu não "acabou de entrar".
    if (!antes) return;
    if (!voice.screenOn) return;
    for (const socketId of agora) if (!antes.has(socketId)) playSound('viewerJoin');
    for (const socketId of antes) if (!agora.has(socketId)) playSound('viewerLeave');
  }, [myWatchers, voice.screenOn]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement) setTheaterMediaKey(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (!theaterMediaKey) return;
    const validKeys = new Set([
      ...(voice.localScreen ? ['local-screen'] : []),
      ...(voice.localCamera ? ['local-camera'] : []),
      ...visibleVideoMedia.map((media) => `${media.peerId}:${media.stream.id}`),
    ]);
    if (!validKeys.has(theaterMediaKey)) setTheaterMediaKey(null);
  }, [theaterMediaKey, visibleVideoMedia, voice.localCamera, voice.localScreen]);
  const showMedia = (key: string) => detachedKeys.has(key) || !theaterMediaKey || theaterMediaKey === key;
  // Uma live anunciada e não assistida não ocupa lugar nenhum na grade: ela
  // não é um quadro, não é um espaço reservado e não muda a disposição do que
  // já está na tela. Ela existe como um aviso ao lado da pessoa, na lista.
  const videoCount = (ownScreenVisible ? 1 : 0) + (voice.localCamera ? 1 : 0) + visibleVideoMedia.length + missingStreams.length;

  // O tamanho real do palco, para a arrumação orgânica das lives.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const style = window.getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setStageBox((atual) => (Math.abs(atual.width - width) < 1 && Math.abs(atual.height - height) < 1 ? atual : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Duas ou mais lives: cada quadro no maior tamanho que o palco permite, na
  // proporção de uma tela, com a última linha centralizada. Se nem assim os
  // quadros ficarem legíveis, eles mantêm um tamanho mínimo e o palco rola.
  const organic = videoCount > 1 && !theaterMediaKey;
  const layout = organic ? bestStageLayout(videoCount, stageBox.width, stageBox.height, 12) : null;
  const scrolls = Boolean(layout && layout.tileHeight > 0 && layout.tileHeight < MIN_TILE_HEIGHT);
  let tileBox: { width: number; height: number } | null = null;
  if (layout && layout.tileWidth > 0) {
    if (scrolls) {
      const colunas = Math.max(1, Math.floor((stageBox.width + 12) / ((MIN_TILE_HEIGHT * 16) / 9 + 12)));
      const largura = Math.floor((stageBox.width - 12 * (colunas - 1)) / colunas);
      tileBox = { width: largura, height: Math.floor((largura * 9) / 16) };
    } else {
      tileBox = { width: layout.tileWidth, height: layout.tileHeight };
    }
  }
  const stageStyle = tileBox ? ({ '--tile-w': `${tileBox.width}px`, '--tile-h': `${tileBox.height}px` } as React.CSSProperties) : undefined;

  // Na tela cheia a barra da call some com o mouse parado, como os controles
  // de cada live: ela cobriria justamente a parte de baixo das lives.
  const [dockVisible, setDockVisible] = useState(true);
  const dockTimer = useRef<number | null>(null);
  const revealDock = useCallback(() => {
    setDockVisible(true);
    if (dockTimer.current) window.clearTimeout(dockTimer.current);
    dockTimer.current = window.setTimeout(() => setDockVisible(false), 2_600);
  }, []);
  useEffect(() => {
    if (immersive) revealDock();
    else {
      if (dockTimer.current) window.clearTimeout(dockTimer.current);
      setDockVisible(true);
    }
  }, [immersive, revealDock]);
  useEffect(() => () => { if (dockTimer.current) window.clearTimeout(dockTimer.current); }, []);

  const liveMenuFor = (media: RemoteMedia): ContextMenuEntry[] => {
    const dono = memberOf(media.peerId);
    const itens: ContextMenuEntry[] = [];
    if (media.kind === 'screen') {
      itens.push(streamMuted
        ? { label: 'Ouvir o áudio das lives', icon: 'volume', onSelect: () => setStreamMuted(false) }
        : { label: 'Silenciar o áudio das lives', icon: 'volumeOff', onSelect: () => setStreamMuted(true) });
    }
    if (dono) itens.push({ label: `Ver perfil de ${dono.username}`, icon: 'users', onSelect: () => onProfile(dono) });
    if (media.kind === 'screen') {
      itens.push({ separator: true });
      itens.push({ label: 'Parar de assistir', icon: 'close', danger: true, onSelect: () => { setTheaterMediaKey(null); voice.stopWatchingLive(media.peerId); } });
    }
    return itens;
  };

  return <main className={`call-view ${immersive ? 'is-immersive' : ''} ${immersive && dockVisible ? 'mostra-dock' : ''}`} onPointerMove={immersive ? revealDock : undefined}>
    <div ref={stageRef} style={stageStyle} className={`stage-grid ${organic ? `layout-organic ${scrolls ? 'is-scroll' : ''}` : `count-${Math.min(4, videoCount)}`} ${theaterMediaKey ? 'focused-live' : ''}`}>
      {ownScreenVisible && showMedia('local-screen') && <VideoTile mediaKey="local-screen" stream={voice.localScreen!} label={voice.user.username} muted screen theater={theaterMediaKey === 'local-screen'} onTheater={setTheaterMediaKey} watchers={myWatchers} ownStream away={voice.away} awayTheme={awayTheme} awaySize={readAwaySize()} awayWho={voice.user.username} serverUrl={serverUrl} onOpenMenu={onOpenMenu} menuItems={[{ label: 'Ocultar minha transmissão', icon: 'eyeOff', hint: 'A live continua no ar para quem assiste; só o quadro sai da sua tela.', onSelect: () => setHideOwnScreen(true) }]} />}
      {voice.localCamera && showMedia('local-camera') && <VideoTile mediaKey="local-camera" stream={voice.localCamera} label={`${voice.user.username} · você`} muted theater={theaterMediaKey === 'local-camera'} onTheater={setTheaterMediaKey} onOpenMenu={onOpenMenu} />}
      {visibleVideoMedia.map((media) => { const mediaKey = `${media.peerId}:${media.stream.id}`; const screen = media.kind === 'screen'; return showMedia(mediaKey) && <VideoTile key={mediaKey} mediaKey={mediaKey} stream={media.stream} label={media.user?.username ?? memberOf(media.peerId)?.username ?? 'Amigo'} muted={screen ? voice.deafened || streamMuted || mutedFor(media) : voice.deafened || mutedFor(media) || speakBlockedFor(media)} volume={screen ? streamVolume : volumeFor(media.user?.id)} speakerId={speakerId} screen={screen} remote theater={theaterMediaKey === mediaKey} onTheater={setTheaterMediaKey} onDetached={trackDetached} onNotice={onNotice} onClose={screen ? () => { setTheaterMediaKey(null); voice.stopWatchingLive(media.peerId); } : undefined} volumeControl={screen ? { volume: streamVolume, muted: streamMuted, onVolume: setStreamVolume, onMuted: setStreamMuted } : undefined} watchers={screen ? watchersByStreamer.get(media.peerId) ?? [] : []} away={memberOf(media.peerId)?.away ?? ''} awayTheme={memberOf(media.peerId)?.awayTheme ?? 'violeta'} awaySize={memberOf(media.peerId)?.awaySize} awayWho={media.user?.username ?? ''} serverUrl={serverUrl} onOpenMenu={onOpenMenu} menuItems={liveMenuFor(media)} />; })}
      {/* Uma live que começou não começa a tocar sozinha, e também não abre
          um cartão no meio da tela para avisar que existe. Ela se anuncia
          junto da pessoa, na lista da esquerda, e é de lá que se escolhe
          assistir. */}
      {!theaterMediaKey && missingStreams.map((member) => <div className="stream-recovery-card" key={`missing-${member.id}`}><span className="live-dot" /><strong>{member.username} está AO VIVO</strong><p>A transmissão está se reconectando automaticamente.</p><small>{voice.peerHealth[member.socketId] === 'recovering' ? 'Recuperando conexão…' : 'Aguardando a faixa de vídeo…'}</small><button onClick={() => voice.recoverPeer(member.socketId, 'tentativa manual da interface', true)}>Tentar agora</button></div>)}
      {!visibleVideoMedia.length && !missingStreams.length && !voice.localCamera && !ownScreenVisible && <div className="audio-stage">
        {tiles.length ? tiles.map((member) => <ParticipantTile key={member.socketId} member={member} serverUrl={serverUrl} onProfile={onProfile} onContextMenu={(event) => onMemberMenu(event, member)} />) : <div className="empty-call"><img src={logoUrl} alt="" /><h2>A call está quietinha</h2><p>Entre e seja o host. Quem chegar depois conecta direto com você.</p></div>}
      </div>}
    </div>
    {immersive && <button className="immersive-exit" onClick={() => onImmersive(false)} title="Sair da tela cheia (Esc)"><Icon name="minimize" /><span>Sair da tela cheia</span></button>}
    {audioMedia.map((media) => <MediaElement key={`${media.peerId}:${media.stream.id}`} stream={media.stream} muted={voice.deafened || mutedFor(media) || speakBlockedFor(media)} volume={volumeFor(media.user?.id)} speakerId={speakerId} audioOnly remote />)}
    <footer className={`call-dock ${inThisCall ? '' : 'is-idle'}`}>
      {!inThisCall ? <button className="join-call" onClick={() => void voice.join(channel.id)}><Icon name="voice" /> Entrar na call</button> : <>
        <div className="dock-side start">
          {voice.screenOn && <div className="dock-field">
            <span className="dock-label">Qualidade</span>
            <Dropdown label="Qualidade da transmissão ao vivo" value={voice.quality} options={qualityDropdownOptions} onChange={(next) => { void voice.setQuality(next as StreamQuality).then((applied) => { if (applied) onNotice(`Live ajustada para ${SCREEN_QUALITIES[next as StreamQuality]?.label ?? next}.`); }); }} />
          </div>}
          {/* A própria live escondida: continua no ar, e o selo de quem assiste
              vem para cá, para ninguém falar sozinho sem saber. */}
          {voice.screenOn && hideOwnScreen && <button type="button" className="dock-field own-live-hidden" onClick={() => setHideOwnScreen(false)} title={`Sua transmissão continua no ar${myWatchers.length ? ` para ${myWatchers.map((watcher) => watcher.username).join(', ')}` : ''}. Clique para voltar a vê-la aqui.`}>
            <Icon name="eyeOff" /><span className="dock-label">Sua live oculta</span><span className="own-live-viewers"><Icon name="eye" />{myWatchers.length}</span>
          </button>}
        </div>
        <div className="dock-controls">
          <ControlButton icon={voice.muted ? 'micOff' : 'mic'} label={voice.selfSpeakBlocked ? 'A administração não permite que você fale nesta call' : voice.muted ? 'Ativar microfone' : 'Silenciar'} active={voice.muted} danger disabled={voice.selfSpeakBlocked && voice.muted} onClick={() => void voice.toggleMute()} />
          <ControlButton icon="headphones" label={voice.deafened ? 'Ouvir de novo' : 'Ensurdecer'} active={voice.deafened} danger onClick={voice.toggleDeafen} />
          <ControlButton icon="camera" label={voice.cameraOn ? 'Parar a câmera' : 'Ligar a câmera'} active={voice.cameraOn} onClick={() => void voice.toggleCamera()} />
          <ControlButton icon="screen" label={!canStream && !voice.screenOn ? 'Você não tem permissão para transmitir nesta call' : voice.screenOn ? 'Parar a transmissão' : 'Transmitir a tela'} active={voice.screenOn} accent disabled={!canStream && !voice.screenOn} onClick={() => void voice.requestScreenShare()} />
          {/* O "já volto" cobre a sua transmissão; sem live ele não tem o que
              cobrir, e o botão só aparece enquanto você transmite. */}
          {voice.screenOn && <ControlButton
            icon="hand"
            label={voice.away ? 'Voltei' : `Avisar que você já volta (${readAwayMessage()})`}
            active={Boolean(voice.away)}
            onClick={() => voice.setAway(voice.away ? '' : readAwayMessage(), readAwayTheme(), readAwaySize())}
          />}
          {videoCount > 0 && <ControlButton icon={immersive ? 'minimize' : 'maximize'} label={immersive ? 'Sair da tela cheia (Esc)' : 'Tela cheia com as lives'} active={immersive} onClick={() => onImmersive(!immersive)} />}
          <ControlButton icon="leave" label="Sair da call" danger active onClick={voice.leave} />
        </div>
        <div className="dock-side end">
          {watchingLive && <div className={`dock-field dock-live ${streamMuted ? 'is-muted' : ''}`}>
            <button type="button" aria-pressed={streamMuted} onClick={() => setStreamMuted(!streamMuted)} title={streamMuted ? 'Ativar o áudio da live' : 'Silenciar o áudio da live'}><Icon name={streamMuted ? 'volumeOff' : 'volume'} /></button>
            <span className="dock-label">Live</span>
            <input type="range" min="0" max="2" step="0.01" value={streamMuted ? 0 : streamVolume} onChange={(event) => { setStreamMuted(false); setStreamVolume(Number(event.target.value)); }} aria-label="Volume da live (até 200%)" />
            <output>{streamMuted ? 0 : Math.round(streamVolume * 100)}%</output>
          </div>}
        </div>
      </>}
    </footer>
  </main>;
}

function FloatingLivePlayer({ media, speakerId, muted, volume, rawVolume, onVolume, onMute, onOpen, onClose, onNotice }: { media: RemoteMedia; speakerId: string; muted: boolean; volume: number; rawVolume: number; onVolume: (volume: number) => void; onMute: () => void; onOpen: () => void; onClose: () => void; onNotice: (message: string) => void }) {
  const frame = useRef<HTMLElement>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const detachedLive = useDetachedLive(mediaRef, `${media.user?.username ?? 'Tumacord'} · AO VIVO`, 'tumacord-live-mini');
  const drag = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, input')) return;
    const bounds = frame.current?.getBoundingClientRect();
    if (!bounds) return;
    drag.current = { offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || !frame.current) return;
    const bounds = frame.current.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, event.clientX - drag.current.offsetX)),
      y: Math.max(8, Math.min(window.innerHeight - bounds.height - 8, event.clientY - drag.current.offsetY)),
    });
  };
  const endDrag = () => { drag.current = null; };
  return <aside ref={frame} className="floating-live" style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}>
    <header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <span><i className="live-dot" /><strong>{media.user?.username ?? 'Live da call'}</strong><small>AO VIVO · arraste para mover</small></span>
      <button onClick={onClose} title="Fechar miniatura"><Icon name="close" /></button>
    </header>
    <button className="floating-live-video" onDoubleClick={onOpen} title="Clique duas vezes para voltar à call"><MediaElement stream={media.stream} muted={muted} volume={volume} speakerId={speakerId} remote mediaRef={mediaRef} /></button>
    <footer>
      <button className={muted ? 'is-muted' : ''} aria-pressed={muted} onClick={onMute} title={muted ? 'Ativar áudio da live' : 'Mutar áudio da live'}><Icon name={muted ? 'volumeOff' : 'volume'} /></button>
      <input type="range" min="0" max="2" step="0.01" value={muted ? 0 : rawVolume} onChange={(event) => onVolume(Number(event.target.value))} aria-label="Volume da mini-live" />
      <output>{muted ? 0 : Math.round(rawVolume * 100)}%</output>
      {detachedLive.supported && <button className="floating-live-detach" onClick={() => void detachedLive.toggle().then((ok) => { if (!ok) onNotice('Não consegui soltar a live em uma janela separada neste sistema.'); })} title={detachedLive.detached ? 'Trazer a live de volta' : 'Soltar sobre os outros apps'}><Icon name={detachedLive.detached ? 'popIn' : 'popOut'} /></button>}
      <button className="floating-live-open" onClick={onOpen}><Icon name="voice" /> Voltar à call</button>
    </footer>
  </aside>;
}

// A live solta precisa ficar acima dos outros aplicativos com o Tumacord
// minimizado. Tentamos, em ordem: a janela de documento do Chromium, uma
// janela nomeada aberta pelo próprio app (que o processo principal do Electron
// promove a "sempre visível") e, por último, o picture-in-picture de vídeo —
// esse último escurece a imagem com a barra de controles do navegador, então
// fica mesmo como último recurso.
function useDetachedLive(mediaRef: React.RefObject<HTMLVideoElement | null>, title: string, windowName: string) {
  const [detached, setDetached] = useState(false);
  const detachedWindow = useRef<Window | null>(null);
  const home = useRef<{ parent: Node; next: ChildNode | null } | null>(null);
  const fallbackHost = useRef<HTMLElement | null>(null);
  const supported = typeof window !== 'undefined';

  const bringBack = useCallback(() => {
    const video = mediaRef.current;
    const origin = home.current;
    // O quadro pode ter sido remontado enquanto a janela estava aberta (uma
    // reconstrução de enlace troca o MediaStream). Aí o destino antigo não
    // existe mais e o vídeo precisa voltar para o quadro que está em tela.
    const fallback = fallbackHost.current;
    if (video && origin?.parent.isConnected) origin.parent.insertBefore(video, origin.next);
    else if (video && fallback?.isConnected) fallback.prepend(video);
    home.current = null;
    detachedWindow.current = null;
    setDetached(false);
  }, [mediaRef]);

  useEffect(() => {
    const video = mediaRef.current;
    if (!video) return;
    const enter = () => setDetached(true);
    const leave = () => setDetached(false);
    video.addEventListener('enterpictureinpicture', enter);
    video.addEventListener('leavepictureinpicture', leave);
    return () => {
      video.removeEventListener('enterpictureinpicture', enter);
      video.removeEventListener('leavepictureinpicture', leave);
    };
  }, [mediaRef]);

  const bringBackRef = useRef(bringBack);
  bringBackRef.current = bringBack;
  useEffect(() => () => {
    const opened = detachedWindow.current;
    if (opened) {
      bringBackRef.current();
      opened.close();
    } else if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined);
    }
  }, []);

  const dressWindow = (opened: Window, video: HTMLVideoElement) => {
    home.current = { parent: video.parentNode!, next: video.nextSibling };
    fallbackHost.current = video.parentElement;
    opened.document.title = title;
    const style = opened.document.createElement('style');
    style.textContent = [
      'html,body{margin:0;height:100%;background:#06070b;overflow:hidden}',
      'video{display:block;width:100%;height:100%;object-fit:contain;background:#06070b}',
    ].join('');
    opened.document.head.append(style);
    opened.document.body.append(video);
    opened.addEventListener('pagehide', () => bringBackRef.current(), { once: true });
    detachedWindow.current = opened;
    setDetached(true);
  };

  const toggle = async () => {
    const video = mediaRef.current;
    if (!video) return false;
    if (detachedWindow.current) {
      const opened = detachedWindow.current;
      bringBack();
      opened.close();
      return true;
    }
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture().catch(() => undefined);
      return true;
    }
    // No aplicativo instalado a janela nomeada vem primeiro: ela é uma janela
    // do Electron de verdade, e só ela aceita o alfinete de ficar acima dos
    // outros programas. Ela roda no mesmo processo e na mesma origem, então o
    // vídeo apenas muda de documento e continua tocando.
    const openNamedWindow = () => {
      try {
        // Nome próprio por mídia: com um nome só, soltar a câmera reaproveitava
        // a janela da tela e o primeiro vídeo sumia.
        const opened = window.open('', windowName, 'width=960,height=540');
        if (opened?.document) {
          dressWindow(opened, video);
          return true;
        }
        opened?.close();
      } catch { /* sem janela nomeada neste host */ }
      return false;
    };
    const factory = window.documentPictureInPicture;
    if (window.tumacordDesktop && openNamedWindow()) return true;
    if (factory?.requestWindow) {
      try {
        dressWindow(await factory.requestWindow({ width: 960, height: 540 }), video);
        return true;
      } catch { /* segue para a janela nomeada */ }
    }
    if (openNamedWindow()) return true;
    if (document.pictureInPictureEnabled) {
      try {
        await video.requestPictureInPicture();
        return true;
      } catch { /* sem caminho disponível */ }
    }
    return false;
  };
  return { detached, supported, toggle };
}

function ControlButton({ icon, label, active, danger, accent, disabled, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; active?: boolean; danger?: boolean; accent?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={`call-control ${active ? 'active' : ''} ${danger ? 'danger' : ''} ${accent ? 'accent' : ''}`} onClick={onClick} disabled={disabled} title={label} aria-label={label}><Icon name={icon} /></button>;
}

function ParticipantTile({ member, serverUrl, onProfile, onContextMenu }: { member: VoiceState; serverUrl: string; onProfile: (user: PublicUser) => void; onContextMenu?: (event: React.MouseEvent) => void }) {
  return <button className={`participant-tile ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`} onClick={() => onProfile(member)} onContextMenu={onContextMenu}><Avatar name={member.username} profile={member.profile} serverUrl={serverUrl} large /><strong>{member.username}</strong>{member.screen && <span className="streaming-label"><span className="live-dot" /> AO VIVO</span>}<span className="tile-ping">{member.pingMs < 9999 ? `${member.pingMs} ms` : 'medindo…'}</span><div className="participant-badges">{member.isHost && <span className="host-badge"><Icon name="host" /> Host</span>}{member.muted && <span className="muted-badge"><Icon name="micOff" /></span>}</div></button>;
}


/**
 * O volume de uma live, quando o quadro pode mudá-lo.
 *
 * Em tela cheia não há barra lateral nem dock: o quadro passa a ser a
 * interface inteira, e sem isto a única forma de baixar o volume de uma
 * transmissão alta era sair da tela cheia.
 */
interface TileVolume {
  volume: number;
  muted: boolean;
  onVolume: (volume: number) => void;
  onMuted: (muted: boolean) => void;
}

function VideoTile({ mediaKey, stream, label, muted, volume = 1, speakerId, screen, remote, theater = false, onTheater, onClose, onDetached, onNotice, volumeControl, watchers = [], ownStream = false, away = '', awayTheme = 'violeta', awaySize, awayWho = '', serverUrl = '', onOpenMenu, menuItems }: { mediaKey: string; stream: MediaStream; label: string; muted: boolean; volume?: number; speakerId?: string; screen?: boolean; remote?: boolean; theater?: boolean; onTheater?: (key: string | null) => void; onClose?: () => void; onDetached?: (key: string, detached: boolean) => void; onNotice?: (message: string) => void; volumeControl?: TileVolume; watchers?: VoiceState[]; ownStream?: boolean; away?: string; awayTheme?: string; awaySize?: number; awayWho?: string; serverUrl?: string; onOpenMenu?: (menu: ContextMenuState) => void; menuItems?: ContextMenuEntry[] }) {
  const tileRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const detachedLive = useDetachedLive(mediaRef, label, `tumacord-live-${mediaKey.replace(/[^a-zA-Z0-9]/g, '')}`);
  const canDetach = Boolean(remote && detachedLive.supported);
  const [fullscreen, setFullscreen] = useState(false);
  // Os controles só aparecem quando o mouse passa, e somem sozinhos depois.
  //
  // Uma barra fixa sobre a transmissão come a parte de baixo da imagem o tempo
  // todo — e é justamente ali que costuma estar o que se quer ver. Some por
  // inatividade, e não ao sair do quadro: quem está com o ponteiro parado sobre
  // a live está assistindo, não mexendo nos botões.
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2_600);
  }, []);
  useEffect(() => () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); }, []);
  const fullscreenRef = useRef(false);
  fullscreenRef.current = fullscreen;
  const toggleFullscreen = async () => {
    if (fullscreen) {
      if (window.tumacordDesktop) await window.tumacordDesktop.endMediaFullscreen().catch(() => false);
      else if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setFullscreen(false);
      return;
    }
    setFullscreen(true);
    if (window.tumacordDesktop) await window.tumacordDesktop.beginMediaFullscreen().catch(() => false);
    else await tileRef.current?.requestFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    const onFullscreenChange = () => { if (document.fullscreenElement !== tileRef.current) setFullscreen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && fullscreen) void toggleFullscreen(); };
    const stopDesktopListener = window.tumacordDesktop?.onMediaFullscreenChanged((active) => { if (!active) setFullscreen(false); });
    if (!window.tumacordDesktop) document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('fullscreenchange', onFullscreenChange); window.removeEventListener('keydown', onKeyDown); stopDesktopListener?.(); };
  }, [fullscreen]);
  useEffect(() => () => {
    if (!fullscreenRef.current) return;
    if (window.tumacordDesktop) void window.tumacordDesktop.endMediaFullscreen().catch(() => false);
    else if (document.fullscreenElement === tileRef.current) void document.exitFullscreen().catch(() => undefined);
  }, []);
  const closeTile = async () => {
    if (fullscreenRef.current) await toggleFullscreen();
    onClose?.();
  };
  useEffect(() => {
    onDetached?.(mediaKey, detachedLive.detached);
    return () => onDetached?.(mediaKey, false);
  }, [detachedLive.detached, mediaKey, onDetached]);
  const toggleDetached = async () => {
    if (fullscreenRef.current) await toggleFullscreen();
    if (!await detachedLive.toggle()) onNotice?.('Não consegui soltar a live em uma janela separada neste sistema.');
  };
  // Na tela cheia real o modo teatro não muda nada, então o duplo clique e o
  // botão ficam fora de ação em vez de responderem sem efeito.
  const toggleTheater = () => { if (!fullscreen) onTheater?.(theater ? null : mediaKey); };
  const onTileDoubleClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('.video-actions')) return;
    toggleTheater();
  };
  // O botão direito junta os controles do quadro — que só aparecem com o
  // mouse em movimento — e o que quem monta o quadro acrescenta: ocultar a
  // própria live, silenciar, parar de assistir.
  const openMenu = (event: React.MouseEvent) => {
    if (!onOpenMenu) return;
    event.preventDefault();
    const items: ContextMenuEntry[] = [
      ...(fullscreen || !onTheater ? [] : [{ label: theater ? 'Voltar à grade' : 'Ampliar dentro do app', icon: theater ? 'shrink' : 'expand', onSelect: toggleTheater } as ContextMenuEntry]),
      { label: fullscreen ? 'Sair da tela cheia' : 'Tela cheia só desta live', icon: fullscreen ? 'minimize' : 'maximize', onSelect: () => void toggleFullscreen() } as ContextMenuEntry,
      ...(canDetach ? [{ label: detachedLive.detached ? 'Trazer de volta para o app' : 'Soltar em janela flutuante', icon: detachedLive.detached ? 'popIn' : 'popOut', onSelect: () => void toggleDetached() } as ContextMenuEntry] : []),
      ...(menuItems?.length ? [{ separator: true } as ContextMenuEntry, ...menuItems] : []),
    ];
    onOpenMenu({ x: event.clientX, y: event.clientY, title: label, items });
  };
  return <div
    ref={tileRef}
    onDoubleClick={onTileDoubleClick}
    onContextMenu={openMenu}
    onPointerMove={revealControls}
    onPointerEnter={revealControls}
    // O foco por teclado também revela: quem navega com Tab precisa ver onde
    // chegou, e um controle visível só ao mouse é um controle que não existe
    // para quem não usa mouse.
    onFocusCapture={revealControls}
    onPointerLeave={() => setControlsVisible(false)}
    className={`video-tile ${screen ? 'screen' : ''} ${theater ? 'is-theater' : ''} ${fullscreen ? 'is-fullscreen' : ''} ${detachedLive.detached ? 'is-detached' : ''} ${controlsVisible ? 'mostra-controles' : ''}`}
  ><MediaElement stream={stream} muted={muted} volume={volume} speakerId={speakerId} remote={remote} mediaRef={mediaRef} />{detachedLive.detached && <div className="detached-live-note"><Icon name="popOut" /><strong>Em uma janela flutuante</strong><small>Ela fica sobre os outros aplicativos, mesmo com o Tumacord minimizado.</small></div>}<AwayCard message={away} theme={awayTheme} size={awaySize} who={awayWho} /><span className="video-label">{screen && <i className="live-dot" />}{label}</span>{screen && <StreamViewers watchers={watchers} self={ownStream} serverUrl={serverUrl} />}<div className="video-actions">{volumeControl && fullscreen && <TileVolumeButton control={volumeControl} />}{onClose && <button onClick={() => void closeTile()} title="Sair desta live sem sair da call"><Icon name="close" /></button>}{canDetach && <button onClick={() => void toggleDetached()} title={detachedLive.detached ? 'Trazer de volta para o app' : 'Soltar em uma janela flutuante sobre os outros apps'}><Icon name={detachedLive.detached ? 'popIn' : 'popOut'} /></button>}<button onClick={toggleTheater} disabled={fullscreen} title={fullscreen ? 'Saia da tela cheia para usar a grade' : theater ? 'Voltar à grade (ou clique duas vezes)' : 'Ampliar dentro do app (ou clique duas vezes)'}><Icon name={theater ? 'shrink' : 'expand'} /></button><button onClick={() => void toggleFullscreen()} title={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia real'}><Icon name={fullscreen ? 'minimize' : 'maximize'} /></button></div></div>;
}

/**
 * O botão de volume do quadro: só o ícone, e a barra aparece ao passar o mouse.
 *
 * A barra fica escondida porque o quadro é a imagem — uma barra permanente
 * sobre a live rouba a área que a pessoa abriu em tela cheia justamente para
 * ganhar. Ela vem no hover e também no foco, para quem navega pelo teclado
 * conseguir chegar nela.
 */
function TileVolumeButton({ control }: { control: TileVolume }) {
  const percent = Math.round(control.volume * 100);
  return <div className="tile-volume">
    <button
      className={control.muted ? 'is-muted' : ''}
      onClick={() => control.onMuted(!control.muted)}
      title={control.muted ? 'Ouvir esta live de novo' : `Silenciar esta live (${percent}%)`}
      aria-label={control.muted ? 'Ouvir esta live de novo' : 'Silenciar esta live'}
    ><Icon name={control.muted ? 'volumeOff' : 'volume'} /></button>
    <div className="tile-volume-slider">
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={control.muted ? 0 : percent}
        aria-label={`Volume desta live: ${percent}%`}
        onChange={(event) => {
          const nextVolume = Number(event.target.value) / 100;
          // Mexer na barra com a live muda é o jeito mais natural de pedir
          // para voltar a ouvir: silenciar de novo é um clique no ícone.
          if (control.muted && nextVolume > 0) control.onMuted(false);
          control.onVolume(nextVolume);
        }}
      />
      <small>{control.muted ? 'mudo' : `${percent}%`}</small>
    </div>
  </div>;
}

/**
 * Como o seu "já volto" fica.
 *
 * A prévia é do tamanho real do cartão, e não uma amostra de cor: o que se está
 * escolhendo é como o recado vai aparecer sobre a sua transmissão, na tela dos
 * outros, e uma bolinha colorida não responde essa pergunta.
 *
 * O que é guardado aqui é preferência desta máquina. Ele só atravessa a rede
 * quando você aperta o botão na call — e o que atravessa é o texto e o NOME do
 * tema, nunca uma cor.
 */
function AwaySettings() {
  const [message, setMessage] = useState(readAwayMessage);
  const [theme, setTheme] = useState<AwayTheme>(readAwayTheme);
  const [size, setSize] = useState(readAwaySize);
  const aplicar = (texto: string) => {
    setMessage(texto);
    setAwayMessage(texto);
  };
  return <div className="away-settings">
    <div className="setting-label"><span className="setting-title">Aviso de &ldquo;já volto&rdquo;<small>Aparece sobre a sua transmissão quando você aperta o botão da mãozinha na call. O botão só existe enquanto você transmite.</small></span></div>
    <label className="away-field">
      <span>Texto</span>
      <input
        type="text"
        value={message}
        maxLength={MAX_AWAY_MESSAGE}
        placeholder={DEFAULT_AWAY_MESSAGE}
        onChange={(event) => aplicar(event.target.value)}
        onBlur={() => { if (!sanitizeAwayMessage(message)) aplicar(DEFAULT_AWAY_MESSAGE); }}
        aria-label="Texto do aviso de já volto"
      />
      <small>{message.length}/{MAX_AWAY_MESSAGE}</small>
    </label>
    <div className="away-themes" role="group" aria-label="Cor do aviso">
      {AWAY_THEMES.map((nome) => <button
        key={nome}
        type="button"
        className={`away-swatch tema-${nome} ${theme === nome ? 'is-chosen' : ''}`}
        aria-pressed={theme === nome}
        title={AWAY_THEME_LABEL[nome]}
        onClick={() => { setTheme(nome); setAwayTheme(nome); }}
      ><span>{AWAY_THEME_LABEL[nome]}</span></button>)}
    </div>
    <label className="away-size">
      <span>Tamanho do texto</span>
      <input
        type="range"
        min={AWAY_SIZE_MIN}
        max={AWAY_SIZE_MAX}
        step={10}
        value={size}
        onChange={(event) => { const proximo = sanitizeAwaySize(Number(event.target.value)); setSize(proximo); setAwaySize(proximo); }}
        aria-label="Tamanho do texto do aviso de já volto"
      />
      <output>{size}%</output>
    </label>
    <div className="away-preview">
      <AwayCard message={message || DEFAULT_AWAY_MESSAGE} theme={theme} size={size} who="sua tela" />
    </div>
  </div>;
}

/**
 * O cartão de "já volto", sobre a transmissão de quem saiu um instante.
 *
 * Ele cobre a imagem de propósito — é esse o recado. Uma tarja discreta num
 * canto seria lida como enfeite, e quem chegasse depois continuaria esperando
 * a pessoa responder.
 *
 * O tema vem como **nome** e é procurado numa lista fechada antes de virar
 * classe. Um tema desconhecido — de uma versão mais nova, ou de um cliente
 * alterado — cai no padrão em vez de virar CSS.
 */
function AwayCard({ message, theme, size, who }: { message: string; theme: string; size?: number; who: string }) {
  const recado = sanitizeAwayMessage(message);
  if (!recado) return null;
  // O tamanho chega da rede como número e é preso na faixa antes de virar
  // estilo: fora dela vira o limite mais próximo, nunca uma fonte gigante.
  return <div className={`away-card tema-${sanitizeAwayTheme(theme)}`} role="status" style={{ '--away-scale': sanitizeAwaySize(size) / 100 } as React.CSSProperties}>
    <Icon name="hand" />
    <strong>{recado}</strong>
    <small>{who}</small>
  </div>;
}

/**
 * Quem está vendo esta transmissão.
 *
 * Compacto de propósito: um selo no canto com as iniciais de até três pessoas e
 * um "+N" para o resto. Uma lista com nomes por extenso sobre a imagem tiraria
 * da live justamente o espaço que se quer ver — e a pergunta que este selo
 * responde é "alguém está vendo?", não "quem exatamente", que o `title`
 * responde para quem passar o mouse.
 *
 * Ele aparece em TODAS as transmissões, e não só na sua: numa call em que três
 * pessoas transmitem, saber que ninguém está na sua e todo mundo está na do
 * lado é a informação que faz alguém parar de falar sozinho.
 */
function StreamViewers({ watchers, self, serverUrl }: { watchers: VoiceState[]; self: boolean; serverUrl: string }) {
  if (!watchers.length) {
    // "Ninguém ainda" só é dito na SUA transmissão. Na dos outros seria uma
    // plateia vazia anunciada para todo mundo, e ninguém precisa disso.
    return self ? <div className="stream-viewers is-empty" title="Ninguém está vendo sua transmissão ainda"><Icon name="eye" /><span>0</span></div> : null;
  }
  const nomes = watchers.map((watcher) => watcher.username);
  return <div
    className="stream-viewers"
    title={`${nomes.length === 1 ? 'Vendo agora' : `${nomes.length} vendo agora`}: ${nomes.join(', ')}`}
  >
    <Icon name="eye" />
    <div className="stream-viewers-faces">
      {/* A foto de perfil, e a inicial só quando não há foto — é o que o
          próprio `Avatar` já resolve, e reusá-lo mantém a mesma cor de fundo
          por pessoa em toda a interface. */}
      {watchers.slice(0, 3).map((watcher) => (
        <Avatar key={watcher.socketId} name={watcher.username} profile={watcher.profile} serverUrl={serverUrl} small />
      ))}
    </div>
    <span>{watchers.length > 3 ? `+${watchers.length - 3}` : watchers.length}</span>
  </div>;
}

/**
 * Cada efeito sonoro, com interruptor próprio e prévia.
 *
 * O interruptor geral continua acima e vale por cima de todos: desligá-lo cala
 * o aplicativo sem apagar as escolhas individuais de quem depois ligá-lo de
 * volta.
 *
 * O botão de ouvir toca mesmo com o efeito desligado, de propósito — é ouvindo
 * que se decide se ele merece voltar.
 */
function SoundGallery({ enabled }: { enabled: boolean }) {
  const [disabled, setDisabled] = useState<Set<FeedbackSound>>(readDisabledSounds);
  const toggle = (nome: FeedbackSound) => {
    const ligado = disabled.has(nome);
    setSoundEnabledFor(nome, ligado);
    setDisabled(readDisabledSounds());
    if (ligado) previewSound(nome);
  };
  return <div className="sound-gallery">
    {FEEDBACK_SOUNDS.map((nome) => {
      const ligado = !disabled.has(nome);
      return <div key={nome} className={`sound-item ${ligado ? '' : 'is-off'}`}>
        <label title={ligado ? `Desligar: ${SOUND_LABEL[nome]}` : `Ligar: ${SOUND_LABEL[nome]}`}>
          <input type="checkbox" checked={ligado} disabled={!enabled} onChange={() => toggle(nome)} />
          <span>{SOUND_LABEL[nome]}</span>
        </label>
        <button
          type="button"
          className="sound-preview"
          disabled={!enabled}
          onClick={() => previewSound(nome)}
          title={`Ouvir: ${SOUND_LABEL[nome]}`}
          aria-label={`Ouvir ${SOUND_LABEL[nome]}`}
        ><Icon name="volume" /></button>
      </div>;
    })}
  </div>;
}

function MediaElement({ stream, muted, volume = 1, speakerId, audioOnly, remote, mediaRef }: { stream: MediaStream; muted: boolean; volume?: number; speakerId?: string; audioOnly?: boolean; remote?: boolean; mediaRef?: React.RefObject<HTMLVideoElement | null> }) {
  const ref = useRef<HTMLMediaElement>(null);
  const [trackRevision, setTrackRevision] = useState(0);
  const playback = useRef({ muted, volume, remote });
  const syncPlayback = useRef<() => void>(() => undefined);
  playback.current = { muted, volume, remote };
  // Efeitos de filho rodam antes dos do pai, então quem renderiza o vídeo já
  // encontra o elemento pronto para soltar em janela flutuante.
  useEffect(() => {
    if (!mediaRef) return;
    mediaRef.current = ref.current as HTMLVideoElement | null;
    return () => { mediaRef.current = null; };
  }, [mediaRef]);
  useEffect(() => {
    const refreshTracks = () => setTrackRevision((revision) => revision + 1);
    stream.addEventListener('addtrack', refreshTracks);
    stream.addEventListener('removetrack', refreshTracks);
    return () => {
      stream.removeEventListener('addtrack', refreshTracks);
      stream.removeEventListener('removetrack', refreshTracks);
    };
  }, [stream]);
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    media.srcObject = stream;
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      media.muted = true;
      void media.play().catch(() => undefined);
      return () => { media.srcObject = null; };
    }
    // Silenciar a faixa recebida é o único ponto que nenhum caminho de
    // reprodução consegue contornar: vale para o grafo, para o elemento HTML e
    // para a miniatura. Faixas locais nunca entram aqui — desligá-las tiraria
    // o áudio de quem assiste.
    const applyTrackGate = (silent: boolean) => {
      if (!playback.current.remote) return;
      for (const track of audioTracks) track.enabled = !silent;
    };
    const context = sharedAudioContext();
    const output = sharedAudioOutput();
    const applyDirect = () => {
      const current = playback.current;
      media.muted = current.muted;
      media.volume = Math.max(0, Math.min(1, current.volume));
      applyTrackGate(current.muted);
      void media.play().catch(() => undefined);
    };
    if (!context || !output) {
      syncPlayback.current = applyDirect;
      // O silêncio de uma pessoa é escrito na faixa recebida (`track.enabled`),
      // e a faixa é um objeto compartilhado: uma renegociação, um `unmute` do
      // navegador ou outro elemento de mídia soltando a mesma faixa devolvem o
      // som sem que nada aqui perceba. O caminho do grafo de áudio já tinha
      // quem reaplicasse — o `watchdog` de quatro segundos e o `unmute` das
      // faixas —, e este não tinha ninguém: aplicava uma vez e nunca mais.
      //
      // É o suspeito do relato de que mutar alguém não vale quando a pessoa
      // entra na call depois, e que só desmutar e mutar de novo resolve.
      const reapplyTimer = window.setInterval(applyDirect, 4_000);
      for (const track of audioTracks) track.addEventListener('unmute', applyDirect);
      applyDirect();
      return () => {
        window.clearInterval(reapplyTimer);
        for (const track of audioTracks) track.removeEventListener('unmute', applyDirect);
        syncPlayback.current = () => undefined;
        // A faixa volta a tocar só se esta pessoa NÃO estiver silenciada.
        //
        // A faixa é um objeto compartilhado: reabri-la sempre devolvia o som de
        // alguém que continua mudo, porque o próximo elemento montado sobre ela
        // a herdava ligada e só a fechava de novo no próximo ciclo. Era o que
        // fazia o silêncio "não pegar" quando a pessoa saía e voltava.
        applyTrackGate(playback.current.muted);
        media.srcObject = null;
      };
    }
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = 0;
    // O limitador agora vive no fim da mistura, no barramento compartilhado:
    // um por faixa achatava o volume individual antes de ele chegar à saída.
    source.connect(gain).connect(output);
    const apply = () => {
      const current = playback.current;
      const running = context.state === 'running';
      // O elemento HTML só existe para o Chromium continuar puxando a faixa
      // remota; enquanto o grafo toca, ele fica sempre mudo.
      media.muted = current.muted || running;
      media.volume = running ? 1 : Math.max(0, Math.min(1, current.volume));
      applyTrackGate(current.muted);
      void media.play().catch(() => undefined);
      const target = current.muted ? 0 : volumeToGain(current.volume);
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(target, now, 0.015);
      // setTargetAtTime só tende a zero. O valor exato logo depois da rampa
      // garante silêncio de verdade ao mutar a live.
      if (!target) gain.gain.setValueAtTime(0, now + 0.2);
    };
    syncPlayback.current = apply;
    const resume = () => {
      if (context.state === 'suspended') void resumeSharedAudio().then(apply);
      else apply();
    };
    context.addEventListener('statechange', apply);
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    document.addEventListener('visibilitychange', resume);
    for (const track of audioTracks) track.addEventListener('unmute', resume);
    const watchdog = window.setInterval(resume, 4_000);
    resume();
    return () => {
      window.clearInterval(watchdog);
      context.removeEventListener('statechange', apply);
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      document.removeEventListener('visibilitychange', resume);
      for (const track of audioTracks) track.removeEventListener('unmute', resume);
      source.disconnect(); gain.disconnect();
      syncPlayback.current = () => undefined;
      // Mesmo motivo do outro caminho: quem está mudo continua mudo.
      applyTrackGate(playback.current.muted);
      media.srcObject = null;
    };
  }, [stream, trackRevision]);
  useEffect(() => {
    syncPlayback.current();
  }, [muted, speakerId, stream, volume]);
  return audioOnly ? <audio ref={ref as React.RefObject<HTMLAudioElement>} autoPlay /> : <video ref={ref as React.RefObject<HTMLVideoElement>} autoPlay playsInline />;
}

function VoiceMemberVolume({ member, volume, muted, onVolume, onMuted, onProfile, onClose }: { member: VoiceState; volume: number; muted: boolean; onVolume: (volume: number) => void; onMuted: (muted: boolean) => void; onProfile: () => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // O botão que abre o painel fica no mesmo bloco: tratar o bloco inteiro
    // como "dentro" evita fechar e reabrir no mesmo clique.
    // Flutuando, ele pode nascer fora da parte visível da barra — perto do fim
    // da lista, ou com a janela baixa. Trazê-lo para dentro é o que evita um
    // painel que abriu e que ninguém vê.
    root.current?.scrollIntoView({ block: 'nearest' });
    const entry = root.current?.closest('.voice-member-entry') ?? root.current;
    const onPointerDown = (event: PointerEvent) => {
      if (entry?.contains(event.target as Node)) return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return <div className="voice-volume-popover" ref={root}>
    <header><div><strong>{member.username}</strong><small>{member.pingMs < 9999 ? `${member.pingMs} ms` : 'Na chamada'}</small></div><button onClick={onClose} title="Fechar"><Icon name="close" /></button></header>
    <label><span><Icon name={muted || volume === 0 ? 'volumeOff' : 'volume'} /> Volume da voz</span><output>{muted ? 0 : Math.round(volume * 100)}%</output><input type="range" min="0" max="2" step="0.01" value={muted ? 0 : volume} disabled={muted} onChange={(event) => onVolume(Number(event.target.value))} aria-label={`Volume da voz de ${member.username}`} /></label>
    <button className={`voice-volume-mute ${muted ? 'is-muted' : ''}`} aria-pressed={muted} onClick={() => onMuted(!muted)} title={muted ? `Voltar a ouvir ${member.username} — só para você` : `Silenciar ${member.username} para você: a voz e o áudio da transmissão dela. Ninguém mais é afetado.`}>
      <Icon name={muted ? 'micOff' : 'mic'} />
      <span>{muted ? 'Ouvir' : 'Silenciar'}</span>
    </button>
    <button className="voice-volume-profile" onClick={onProfile}>Ver perfil</button>
  </div>;
}

function MemberList({ users, voiceMembers, currentUserId, serverUrl, onProfile }: { users: PublicUser[]; voiceMembers: VoiceState[]; currentUserId: string; serverUrl: string; onProfile: (user: PublicUser) => void }) {
  const voiceByUser = useMemo(() => new Map(voiceMembers.map((member) => [member.id, member])), [voiceMembers]);
  const people = useMemo(() => [...users].sort((left, right) => Number(right.id === currentUserId) - Number(left.id === currentUserId) || left.username.localeCompare(right.username, 'pt-BR')), [currentUserId, users]);
  return <aside className="member-list">
    <header><h3>Online</h3><span title={`${users.length} ${users.length === 1 ? 'pessoa online' : 'pessoas online'}`}>{users.length}</span></header>
    <div className="member-list-scroll">
      {people.map((user) => {
        const voice = voiceByUser.get(user.id);
        // Quem está falando aparece na barra da esquerda, junto da call. Aqui
        // é só presença, e nada pisca.
        return <button className="member-row" key={user.id} onClick={() => onProfile(user)} title={`Ver perfil de ${user.username}`}>
          <Avatar name={user.username} profile={user.profile} serverUrl={serverUrl} small online />
          <span className="member-name">{user.username}{user.id === currentUserId && <em>você</em>}</span>
          {voice && voice.pingMs < 9999 && <span className="member-ping">{voice.pingMs} ms</span>}
          {voice?.screen && <i className="live-dot" title="Transmitindo agora" />}
        </button>;
      })}
      {!users.length && <div className="member-list-empty"><Icon name="users" /><strong>Ninguém por aqui</strong><span>Seus amigos aparecem quando entram.</span></div>}
    </div>
  </aside>;
}


function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}min`;
  return `${Math.max(0, minutes)}min`;
}

function ProfileModal({ user, own, serverUrl, token, onClose, onSaved }: { user: PublicUser; own: boolean; serverUrl: string; token: string; onClose: () => void; onSaved: (user: PublicUser) => void }) {
  const initial = user.profile ?? { bio: '', accentColor: '#ff5c5c' };
  const [bio, setBio] = useState(initial.bio);
  const [accentColor, setAccentColor] = useState(initial.accentColor);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [bannerRemoved, setBannerRemoved] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState(() => profileMediaUrl(serverUrl, initial.avatar));
  const [bannerPreview, setBannerPreview] = useState(() => profileMediaUrl(serverUrl, initial.banner));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const localPreviewUrls = useRef<{ avatar?: string; banner?: string }>({});
  useEffect(() => () => {
    if (localPreviewUrls.current.avatar) URL.revokeObjectURL(localPreviewUrls.current.avatar);
    if (localPreviewUrls.current.banner) URL.revokeObjectURL(localPreviewUrls.current.banner);
  }, []);
  const chooseImage = (file: File | undefined, kind: 'avatar' | 'banner') => {
    if (!file) return;
    if (!/^image\/(?:gif|png|jpeg|webp)$/.test(file.type) || file.size > 6 * 1024 * 1024) {
      setError('Use GIF, PNG, JPG ou WebP de até 6 MB.');
      return;
    }
    const preview = URL.createObjectURL(file);
    if (localPreviewUrls.current[kind]) URL.revokeObjectURL(localPreviewUrls.current[kind]!);
    localPreviewUrls.current[kind] = preview;
    if (kind === 'avatar') { setAvatarFile(file); setAvatarPreview(preview); setAvatarRemoved(false); }
    else { setBannerFile(file); setBannerPreview(preview); setBannerRemoved(false); }
    setError('');
  };
  const save = async () => {
    setSaving(true); setError('');
    try {
      let avatar = avatarRemoved ? undefined : initial.avatar;
      let banner = bannerRemoved ? undefined : initial.banner;
      if (avatarFile) avatar = await uploadProfileMedia(avatarFile, serverUrl, token);
      if (bannerFile) banner = await uploadProfileMedia(bannerFile, serverUrl, token);
      const profile: UserProfile = { bio: bio.trim(), accentColor, ...(avatar ? { avatar } : {}), ...(banner ? { banner } : {}) };
      onSaved(await updateProfile(profile, serverUrl, token));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível salvar o perfil.'); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop profile-backdrop" onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}><div className="profile-card" style={{ '--profile-accent': accentColor } as React.CSSProperties}>
    <button className="modal-close" disabled={saving} onClick={onClose} title="Fechar"><Icon name="close" /></button>
    <div className="profile-banner" style={bannerPreview ? { backgroundImage: `url(${bannerPreview})` } : undefined}>{own && <label className="profile-media-edit"><Icon name="paperclip" /> Alterar banner<input type="file" accept="image/gif,image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0], 'banner')} /></label>}</div>
    <div className="profile-avatar-wrap"><Avatar name={user.username} profile={{ ...initial, avatar: avatarRemoved ? undefined : initial.avatar }} serverUrl={serverUrl} large imageOverride={avatarPreview} />{own && <label className="avatar-edit" title="Alterar avatar"><Icon name="paperclip" /><input type="file" accept="image/gif,image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0], 'avatar')} /></label>}</div>
    <section className="profile-body"><h2>{user.username}</h2>{own ? <>
      <label className="profile-field">Descrição<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={190} placeholder="Conte algo sobre você…" /><small>{bio.length}/190</small></label>
      <label className="profile-color">Cor do perfil <input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
      <div className="profile-remove-row">{(avatarPreview || initial.avatar) && <button onClick={() => { if (localPreviewUrls.current.avatar) URL.revokeObjectURL(localPreviewUrls.current.avatar); localPreviewUrls.current.avatar = undefined; setAvatarRemoved(true); setAvatarFile(null); setAvatarPreview(undefined); }}>Remover avatar</button>}{(bannerPreview || initial.banner) && <button onClick={() => { if (localPreviewUrls.current.banner) URL.revokeObjectURL(localPreviewUrls.current.banner); localPreviewUrls.current.banner = undefined; setBannerRemoved(true); setBannerFile(null); setBannerPreview(undefined); }}>Remover banner</button>}</div>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button profile-save" disabled={saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar perfil'}</button>
    </> : <p className="profile-bio">{initial.bio || 'Este usuário ainda não escreveu uma descrição.'}</p>}</section>
  </div></div>;
}

// O texto muda com o mecanismo real do sistema, mas nunca cita o mecanismo: o
// que interessa a quem lê é o que entra e o que fica de fora.
function screenAudioExplanation(support: ScreenAudioSupport): string {
  if (support.mode === 'stream' && support.supported === false) {
    return 'Nesta versão do Windows, o áudio da aplicação não pode ser isolado com segurança. As transmissões continuam sem áudio, e nada da call vaza para quem assiste.';
  }
  if (support.mode === 'stream') {
    return 'Ao transmitir uma janela, só o som daquela aplicação entra na live. Ao transmitir um monitor inteiro, entra o som do sistema — menos o Tumacord, o Discord e os processos de áudio deles, que ficam sempre de fora para a call não voltar pela transmissão.';
  }
  return 'Ao marcar áudio, jogos, navegador e outros aplicativos entram na live; Tumacord, Discord e a voz da call ficam de fora automaticamente, inclusive na tela inteira.';
}

function SettingsModal({ devices, quality, setQuality, soundEnabled, setSoundEnabled, soundVolume, setSoundVolume: updateSoundVolume, networkPreferences, onNetworkPreferences, mediaSnapshot, audioSupport, connectionMode, onNotice, onClose, onLogout, onSwitchAccount }: { devices: ReturnType<typeof useDevices>; quality: StreamQuality; setQuality: (quality: StreamQuality) => void | Promise<boolean>; soundEnabled: boolean; setSoundEnabled: (enabled: boolean) => void; soundVolume: number; setSoundVolume: (volume: number) => void; networkPreferences: NetworkPreferences; onNetworkPreferences: (patch: Partial<NetworkPreferences>) => void; mediaSnapshot: ReturnType<typeof useVoice>['mediaSnapshot']; audioSupport: ScreenAudioSupport; connectionMode: 'p2p' | 'server'; onSwitchAccount: () => void; onNotice: (message: string) => void; onClose: () => void; onLogout: () => void }) {
  const [tab, setTab] = useState<'media' | 'network' | 'diagnostics'>('media');
  function update<K extends keyof typeof devices.preferences>(key: K, value: (typeof devices.preferences)[K]): void {
    devices.setPreferences({ ...devices.preferences, [key]: value });
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal">
    <aside><h2>Configurações</h2><button className={tab === 'media' ? 'selected' : ''} onClick={() => setTab('media')}>Voz e vídeo</button><button className={tab === 'network' ? 'selected' : ''} onClick={() => setTab('network')}>Rede e conexão</button><button className={tab === 'diagnostics' ? 'selected' : ''} onClick={() => setTab('diagnostics')}>Diagnóstico</button><button onClick={onSwitchAccount} title="Volta para a entrada mantendo esta conta guardada">Trocar de conta</button><button onClick={onLogout} title="Encerra esta sessão; as outras contas guardadas continuam">Sair da conta</button><span className="settings-version">Tumacord v{APP_VERSION}</span></aside>
    {tab === 'network' && <NetworkSettings preferences={networkPreferences} onChange={onNetworkPreferences} onClose={onClose} />}
    {tab === 'diagnostics' && <MediaDiagnostics snapshot={mediaSnapshot} preferences={networkPreferences} connectionMode={connectionMode} onNotice={onNotice} onClose={onClose} />}
    {tab === 'media' && <section><button className="modal-close" onClick={onClose}><Icon name="close" /></button><h1>Voz e vídeo</h1><p className="settings-intro">O Tumacord processa a voz localmente em 48 kHz com cancelamento de eco, filtro neural GTCRN, corte de ruído grave e compressor de voz.</p>
      <DeviceSelect label="Microfone" hint="As entradas duplicadas do Chromium ficam de fora da lista." value={devices.preferences.microphoneId} devices={devices.microphones} onChange={(value) => update('microphoneId', value)} />
      <DeviceSelect label="Saída de áudio" value={devices.preferences.speakerId} devices={devices.speakers} onChange={(value) => update('speakerId', value)} />
      <DeviceSelect label="Câmera" value={devices.preferences.cameraId} devices={devices.cameras} onChange={(value) => update('cameraId', value)} />
      <label className="sound-toggle"><input type="checkbox" checked={devices.preferences.noiseSuppression} onChange={(event) => update('noiseSuppression', event.target.checked)} /><span><strong>Supressão neural de ruído</strong><small>GTCRN em WebAssembly para reduzir teclado, ventilador e ruído ambiente sem enviar seu áudio para nenhum serviço.</small></span></label>
      <div className="setting-label"><span className="setting-title">Qualidade da transmissão<small>Vale para a próxima live e para a que já estiver no ar.</small></span><Dropdown label="Qualidade da transmissão" value={quality} options={qualityDropdownOptions} onChange={(next) => { void setQuality(next as StreamQuality); }} /></div>
      <AwaySettings />
      <label className="sound-toggle" title="Entrada, saída, mensagens, microfone, transmissão e troca de host."><input type="checkbox" checked={soundEnabled} onChange={(event) => setSoundEnabled(event.target.checked)} /><span><strong>Sons de feedback</strong></span></label>
      <label className="feedback-volume"><span>Volume dos feedbacks</span><input type="range" min="0.2" max="1" step="0.05" value={soundVolume} disabled={!soundEnabled} onChange={(event) => updateSoundVolume(Number(event.target.value))} onMouseUp={() => playSound('notification')} /><output>{Math.round(soundVolume * 100)}%</output></label>
      {/* Ligar e desligar cada um, e ouvir antes de decidir. Descrever um som
          em uma frase não funciona: quem quer saber como é precisa poder
          tocar — inclusive um que esteja desligado. */}
      <SoundGallery enabled={soundEnabled} />
      {/* No Linux o mecanismo é problema do aplicativo: a nota não diz nada
          que ajude quem vai transmitir, e foi pedida para sair. */}
      {window.tumacordDesktop?.platform !== 'linux' && <div className="quality-note"><strong>Áudio da transmissão</strong><span>{screenAudioExplanation(audioSupport)}</span></div>}
    </section>}
  </div></div>;
}

// A sondagem fala com STUN e com o roteador: ela demora, e sob carga pode
// falhar. Quando isso acontecia, o relatório virava `null` e a tela dizia que
// a verificação "está disponível apenas no aplicativo instalado" — dentro do
// aplicativo instalado. Os fatos medidos sumiam e voltavam junto.
//
// Agora o último relatório bem-sucedido continua em tela enquanto o novo não
// chega, e uma falha aparece como o que é: uma medição que não deu certo.

// Desenho sobre a transmissão.
//
// Duas das três chaves são de quem transmite, e é por isso que elas ficam
// juntas: é a mesma tela, é a mesma decisão. Desligar a primeira faz o lápis
// sumir para quem assiste e faz o servidor recusar traço — esconder o botão
// seria conveniência, não permissão.
// Desenhar virou duas coisas diferentes, e a tela precisa dizer isso.
//
function NetworkSettings({ preferences, onChange, onClose }: { preferences: NetworkPreferences; onChange: (patch: Partial<NetworkPreferences>) => void; onClose: () => void }) {
  const [alcance, setAlcance] = useState<Tracked<DirectReport>>(() => untracked<DirectReport>());
  const montado = useRef(true);
  const geracao = useRef(0);
  useEffect(() => { montado.current = true; return () => { montado.current = false; }; }, []);
  const semDesktop = !window.tumacordDesktop;
  const check = useCallback(async (force: boolean) => {
    const pedido = ++geracao.current;
    setAlcance((estado) => beginLoad(estado, pedido));
    const relatorio = await readDirectReport({ force });
    if (!montado.current || pedido !== geracao.current) return;
    if (relatorio) setAlcance((estado) => settle(estado, pedido, relatorio));
    else setAlcance((estado) => failLoad(estado, pedido, window.tumacordDesktop
      ? 'A verificação não respondeu desta vez. Os dados abaixo são da última medição.'
      : 'A verificação de rede está disponível apenas no aplicativo instalado.'));
  }, []);
  useEffect(() => { void check(false); }, [check]);
  const report = alcance.value;
  const checking = isBusy(alcance);
  return <section><button className="modal-close" onClick={onClose}><Icon name="close" /></button><h1>Rede e conexão</h1>
    <p className="settings-intro">A call vai direto de computador para computador. O Tumacord procura sozinho o melhor caminho: rede local, IPv6 e, quando o roteador deixa, uma porta aberta para o IPv4. A mídia continua cifrada de ponta a ponta por DTLS-SRTP.</p>
    <div className="reachability-card">
      <div className="reachability-head"><strong>{report ? `Alcance: ${describeGrade(report.grade)}` : checking ? 'Verificando os caminhos…' : semDesktop ? 'Verificação indisponível' : 'Alcance ainda não medido'}</strong><button disabled={checking} onClick={() => void check(true)}>{checking ? 'Verificando…' : 'Testar de novo'}</button></div>
      <span>{report
        ? describeReachability({ grade: report.grade, paths: report.paths, ipv6: report.ipv6, cgnat: report.cgnat, natMapping: report.natMapping, mappedVia: report.mappedVia })
        : checking ? 'Consultando STUN e o roteador; leva alguns segundos.' : alcance.error}</span>
      {report && alcance.status === 'stale' && <span className="reachability-stale">{alcance.error}</span>}
      {report && <ul className="reachability-facts">
        <li><span>IPv6</span><strong>{report.ipv6 ? 'disponível' : 'ausente'}</strong></li>
        <li><span>CGNAT</span><strong>{report.cgnat ? 'sim' : 'não'}</strong></li>
        <li><span>NAT</span><strong>{report.natMapping === 'endpoint-independent' ? 'atravessável' : report.natMapping === 'symmetric' ? 'simétrico' : 'não medido'}</strong></li>
        {report.mappedPort ? <li><span>Porta aberta</span><strong>{report.mappedPort} · {report.mappedVia}</strong></li> : null}
      </ul>}
    </div>
    <label className="sound-toggle"><input type="checkbox" checked={preferences.stunEnabled} onChange={(event) => onChange({ stunEnabled: event.target.checked })} /><span><strong>Travessia de NAT por STUN</strong><small>Descobre o endereço público para a call furar o NAT — inclusive boa parte do CGNAT. Sem isso, só funciona na mesma rede. Os servidores STUN veem apenas o endereço, nunca a conversa.</small></span></label>
    <label className="sound-toggle"><input type="checkbox" checked={preferences.portMapping} onChange={(event) => onChange({ portMapping: event.target.checked })} /><span><strong>Abrir porta no roteador</strong><small>Pede uma porta por PCP, NAT-PMP ou UPnP enquanto o Tumacord estiver aberto, e devolve ao fechar.</small></span></label>
    <label className="sound-toggle"><input type="checkbox" checked={preferences.zeroTierEnabled} onChange={(event) => onChange({ zeroTierEnabled: event.target.checked })} /><span><strong>Usar a rede ZeroTier</strong><small>Desligado, o adaptador do ZeroTier fica fora da descoberta e da call. Ligue se o grupo já usa uma rede ZeroTier ou se o enlace direto não alcançar ninguém.</small></span></label>
    {preferences.zeroTierEnabled && <div className="quality-note"><strong>ZeroTier ligado</strong><span>{report?.zeroTier.length ? `Endereços vistos: ${report.zeroTier.join(', ')}.` : 'Nenhum adaptador ZeroTier encontrado neste computador. Instale e entre na rede para usá-lo.'}</span></div>}
    <label className="sound-toggle"><input type="checkbox" checked={preferences.turnEnabled} onChange={(event) => onChange({ turnEnabled: event.target.checked })} /><span><strong>Usar o relay do servidor (TURN)</strong><small>Último recurso, desligado por padrão. Ligue se a call não fechar de jeito nenhum — os dois lados em CGNAT simétrico, sem IPv6. Ligado, ele só entra quando nenhum caminho direto se forma, e sai de cena se um aparecer depois; o ICE sempre prefere o direto. Enquanto estiver em uso, sua mídia passa pela máquina do servidor, cifrada de ponta a ponta e gastando banda dela.</small></span></label>
    {preferences.turnEnabled && <div className="quality-note"><strong>Relay ligado</strong><span>O servidor só entrega credencial de relay se tiver um configurado. Sem relay do outro lado, isto não muda nada e a call continua tentando todo caminho direto.</span></div>}
    <div className="quality-note"><strong>Quando nada alcança</strong><span>Se este computador ficar sem caminho de entrada, quem tiver IPv6 ou porta aberta assume a call automaticamente. Com todos sem saída, ligar o ZeroTier ou o relay acima resolve.</span></div>
  </section>;
}

const LAYER_LABEL: Record<string, string> = {
  capture: 'Captura', processing: 'Processamento', track: 'Faixa',
  sender: 'Envio', peer: 'Enlace', remote: 'Recepção',
};
const STATUS_LABEL: Record<string, string> = { ok: 'ok', broken: 'falha', unknown: 'sem medida', idle: 'inativo' };

function MediaDiagnostics({ snapshot, preferences, connectionMode, onNotice, onClose }: { snapshot: ReturnType<typeof useVoice>['mediaSnapshot']; preferences: NetworkPreferences; connectionMode: 'p2p' | 'server'; onNotice: (message: string) => void; onClose: () => void }) {
  const [estado, setEstado] = useState(() => snapshot());
  const [audioDaLive, setAudioDaLive] = useState<ScreenAudioDiagnostics | null>(null);
  const relatorio = useRef<HTMLTextAreaElement>(null);
  // Uma leitura por segundo: o suficiente para acompanhar uma falha aparecer,
  // sem transformar o painel em custo de CPU durante a call.
  useEffect(() => {
    const timer = window.setInterval(() => setEstado(snapshot()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot]);
  // O áudio da transmissão vive no processo principal, e o relatório dele muda
  // devagar: contadores de amortecedor e lista de aplicações. Três segundos
  // bastam e evitam uma ida ao IPC por segundo com o painel aberto.
  useEffect(() => {
    let cancelado = false;
    const ler = () => {
      void window.tumacordDesktop?.screenAudioDiagnostics?.()
        .then((detalhes) => { if (!cancelado) setAudioDaLive((detalhes ?? null) as ScreenAudioDiagnostics | null); })
        .catch(() => undefined);
    };
    ler();
    const timer = window.setInterval(ler, 3_000);
    return () => { cancelado = true; window.clearInterval(timer); };
  }, []);
  const camadas: LayerVerdict[] = diagnoseMicrophone(estado);
  const contexto = {
    version: APP_VERSION,
    connectionMode,
    stunConfigured: preferences.stunEnabled && preferences.stunServers.length > 0,
    turnConfigured: preferences.turnEnabled && cachedTurnServers().length > 0,
    paths: estado.paths,
    screenAudio: audioDaLive,
  };
  const texto = formatDiagnosticReport(estado, contexto);
  return <section><button className="modal-close" onClick={onClose}><Icon name="close" /></button><h1>Diagnóstico</h1>
    <p className="settings-intro">Onde o áudio está parando, camada por camada. “Sem medida” não é falha: é ausência de informação — sala silenciosa e captura morta são coisas diferentes.</p>
    <ul className="diagnostic-layers">
      {camadas.map((camada) => <li key={camada.layer} className={`diagnostic-${camada.status}`}>
        <span className="diagnostic-layer">{LAYER_LABEL[camada.layer] ?? camada.layer}</span>
        <strong>{STATUS_LABEL[camada.status] ?? camada.status}</strong>
        <small>{camada.detail}</small>
      </li>)}
    </ul>
    <div className="reachability-card">
      <div className="reachability-head"><strong>Enlaces</strong><span>{estado.peers.length}</span></div>
      {!estado.peers.length && <span>Ninguém mais na call.</span>}
      {estado.paths.map(({ peerId, path }) => <span key={peerId}>
        {path ? `${path.relayed ? 'pelo relay TURN' : path.local === 'host' ? 'direto, sem NAT' : 'direto, furando o NAT'} · ${path.family} · ${path.protocol.toUpperCase()}${path.roundTripMs === undefined ? '' : ` · ${path.roundTripMs} ms`}` : 'caminho ainda não escolhido'}
      </span>)}
    </div>
    <textarea ref={relatorio} className="invite-code" readOnly rows={10} value={texto} onFocus={(event) => event.currentTarget.select()} />
    <button className="primary-button" onClick={() => { void copyText(texto, relatorio.current).then((copiado) => onNotice(copiado ? 'Diagnóstico copiado.' : 'Não consegui copiar; o texto ficou selecionado, use Ctrl+C.')); }}>Copiar diagnóstico</button>
    <small className="invite-hint">O texto acima não carrega token, chave, credencial de TURN nem endereço IP — pode ser colado em uma conversa.</small>
  </section>;
}

function InviteModal({ callId, callName, hostUsername, server, serverToken, serverKey, onClose, onNotice }: { callId: string; callName: string; hostUsername: string; server?: string; serverToken?: string; serverKey?: string; onClose: () => void; onNotice: (message: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const codeField = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    let active = true;
    // O código curto é emitido pelo servidor. Sem servidor não há convite, e
    // sem sessão não há como pedir; nos dois casos o texto abaixo explica.
    const pedido = server && serverToken
      ? requestShortInvite(server, serverToken, { callId, callName })
      : Promise.resolve(null);
    void pedido.then((curto) => {
      if (!active) return;
      // Se o servidor for anterior à 0.8.4 ele não conhece `/api/invite`;
      // o formato longo continua servindo como reserva.
      setCode(curto ?? buildInvite({ callId, callName, hostUsername, server, key: serverKey }));
      setLoading(false);
    });
    return () => { active = false; };
  }, [callId, callName, hostUsername, server, serverToken, serverKey]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="invite-modal">
    <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Convite</span>
    <h2>Convidar pela internet</h2>
    <p>O código aponta o servidor da call e vale por 12 horas. Nenhum endereço da sua máquina vai junto, e quem receber chega por conexão de saída — atravessa CGNAT sem abrir porta nenhuma.</p>
    {loading && <p className="invite-status">Pedindo um código ao servidor…</p>}
    {!loading && !code && <p className="invite-status">{server
      ? 'O servidor não emitiu o convite. Se ele for anterior à 0.8.4, atualize-o; se você acabou de entrar, tente de novo.'
      : 'Convidar pela internet exige um servidor. Entre em P2P híbrido e gere o convite de lá; no modo P2P, as calls só aparecem para quem está na mesma rede.'}</p>}
    {code && <>
      <textarea className="invite-code" readOnly value={code} rows={2} onFocus={(event) => event.currentTarget.select()} ref={(field) => { codeField.current = field; }} />
      <button className="primary-button" onClick={() => { void copyText(code, codeField.current).then((copied) => onNotice(copied ? 'Convite copiado.' : 'Não consegui copiar; o texto ficou selecionado, use Ctrl+C.')); }}>Copiar convite</button>
      <small className="invite-hint">Quem receber cola em “Entrar por convite” ou no campo de convite da tela de entrada. Não precisa de porta aberta, UPnP nem IPv6.</small>
    </>}
  </div></div>;
}

function JoinInviteModal({ onJoin, onNeedsLogin, onClose, onNotice }: { onJoin: (code: string) => Promise<'entrou' | 'precisa-entrar' | 'falhou'>; onNeedsLogin: () => void; onClose: () => void; onNotice: (message: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [precisaEntrar, setPrecisaEntrar] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    setPrecisaEntrar(false);
    // A conferência local só olha o formato. Reconhecer apenas o `TUMA1` aqui
    // era o que fazia o convite curto da 0.8.4 — o único que o servidor emite —
    // ser recusado sem nunca chegar a ser tentado.
    if (!inviteFormat(code)) {
      setError('Código inválido ou vencido. Peça um convite novo ao host.');
      setBusy(false);
      return;
    }
    const resultado = await onJoin(code);
    setBusy(false);
    if (resultado === 'falhou') return setError('O convite é válido, mas nenhum dos caminhos respondeu. O host pode ter fechado o app ou trocado de rede.');
    if (resultado === 'precisa-entrar') return setPrecisaEntrar(true);
    onNotice('Entrando na call pelo convite…');
    onClose();
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><div className="invite-modal">
    <button className="modal-close" disabled={busy} onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Enlace direto</span>
    <h2>Entrar por convite</h2>
    <p>Cole o código que você recebeu. Os caminhos são tentados em paralelo e o primeiro que responder é usado.</p>
    <textarea className="invite-code" value={code} rows={4} spellCheck={false} placeholder="TUMA2~…" onChange={(event) => setCode(event.target.value)} />
    {error && <p className="invite-status error">{error}</p>}
    {precisaEntrar && <div className="quality-note">
      <strong>Este convite é de um lugar onde você ainda não entrou</strong>
      <span>Você precisa entrar com uma conta desse servidor. <strong>As contas que você já tem guardadas continuam guardadas</strong> — nenhuma delas é apagada por causa disto, e você volta para qualquer uma pela tela de entrada.</span>
    </div>}
    {precisaEntrar
      ? <button className="primary-button" onClick={onNeedsLogin}>Ir para a entrada</button>
      : <button className="primary-button" disabled={busy || !code.trim()} onClick={() => void submit()}>{busy ? 'Procurando o host…' : 'Entrar na call'}</button>}
  </div></div>;
}

// Criar mesa pede duas coisas: um nome e nada mais. O quadro nasce em branco,
// vinculado ao canal aberto, e o anúncio sai na hora para quem enxerga esse
// canal — entrar continua sendo escolha de cada pessoa.
function NewBoardModal({ channelName, onCreate, onClose }: { channelName: string; onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await onCreate(name.trim());
    setBusy(false);
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><form className="invite-modal" onSubmit={(event) => void submit(event)}>
    <button type="button" className="modal-close" disabled={busy} onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Mesa de desenho</span>
    <h2>Criar mesa</h2>
    <p>Um quadro em branco para o grupo desenhar junto, dentro do app. Ele fica em <strong>#{channelName}</strong>, e quem enxerga esse canal pode entrar. Não precisa de call nem de transmissão.</p>
    <label className="invite-field">Nome da mesa <input value={name} onChange={(event) => setName(event.target.value)} maxLength={48} autoFocus placeholder="Plano da base" /></label>
    <button className="primary-button" disabled={busy}>{busy ? 'Criando…' : 'Criar mesa'}</button>
  </form></div>;
}

function DeviceSelect({ label, hint, value, devices, onChange }: { label: string; hint?: string; value: string; devices: MediaDeviceInfo[]; onChange: (value: string) => void }) {
  const options = [
    { value: '', label: 'Padrão do sistema' },
    ...devices.map((device, index) => ({ value: device.deviceId, label: cleanDeviceLabel(device.label) || `${label} ${index + 1}` })),
  ];
  return <div className="setting-label"><span className="setting-title">{label}{hint && <small>{hint}</small>}</span><Dropdown label={label} value={value} options={options} onChange={onChange} /></div>;
}

// O que a pessoa precisa saber antes de marcar a caixa: o que entra na live e
// o que fica de fora. Nada de WASAPI ou PipeWire aqui — o mecanismo é problema
// do aplicativo, não de quem vai transmitir.
function shareAudioSummary(support: ScreenAudioSupport): { title: string; detail: string; blocked: boolean } {
  // Desde a 0.13.5 o Linux também entrega o áudio por `stream`, mas o que ele
  // captura continua sendo o de sempre: tudo que não é call.
  if (window.tumacordDesktop?.platform === 'linux') {
    return { title: 'Compartilhar áudio', detail: 'Inclui o som do sistema, mantendo Tumacord e Discord fora da live.', blocked: false };
  }
  if (support.supported === false && support.mode === 'stream') {
    return {
      title: 'Áudio indisponível nesta versão do Windows',
      detail: 'Nesta versão do Windows, o áudio da aplicação não pode ser isolado com segurança. A transmissão continuará sem áudio.',
      blocked: true,
    };
  }
  if (support.mode === 'stream') {
    return {
      title: 'Compartilhar áudio',
      detail: 'Uma janela leva só o som da própria aplicação; a tela inteira leva o som do sistema, sem Tumacord nem apps de chamada.',
      blocked: false,
    };
  }
  return {
    title: 'Compartilhar áudio',
    detail: 'Inclui o som do sistema, mantendo Tumacord e Discord fora da live.',
    blocked: false,
  };
}

function ShareSetupModal({ initialQuality, busy, audioSupport, onContinue, onClose }: { initialQuality: StreamQuality; busy: boolean; audioSupport: ScreenAudioSupport; onContinue: (includeAudio: boolean, quality: StreamQuality) => void; onClose: () => void }) {
  const audio = shareAudioSummary(audioSupport);
  const [includeAudio, setIncludeAudio] = useState(!audio.blocked);
  const [selectedQuality, setSelectedQuality] = useState<StreamQuality>(initialQuality);
  const wantsAudio = includeAudio && !audio.blocked;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><div className="share-setup"><button className="modal-close" disabled={busy} onClick={onClose}><Icon name="close" /></button><span className="modal-eyebrow">Nova transmissão</span><h2>Como você quer transmitir?</h2><p>Defina a qualidade e o áudio primeiro. A tela ou janela será escolhida uma única vez na próxima etapa.</p><div className="quality-cards">{qualityOptions.map(([value, option]) => <button key={value} disabled={busy} className={selectedQuality === value ? 'selected' : ''} onClick={() => setSelectedQuality(value)}><Icon name="screen" /><span><strong>{option.label.split(' · ')[0]}</strong><small>{option.label.split(' · ')[1] ?? 'Qualidade original'}</small></span></button>)}</div><label className="share-audio-card"><input type="checkbox" disabled={busy || audio.blocked} checked={wantsAudio} onChange={(event) => setIncludeAudio(event.target.checked)} /><span><strong>{audio.title}</strong><small>{audio.detail}</small></span></label><button className="primary-button share-continue" disabled={busy} onClick={() => onContinue(wantsAudio, selectedQuality)}>{busy ? 'Abrindo o seletor…' : 'Continuar para escolher a tela'} {!busy && <Icon name="chevron" />}</button></div></div>;
}

function SourcePicker({ sources, busy, withAudio, onSelect, onBack, onClose }: { sources: DesktopSource[]; busy: boolean; withAudio: boolean; onSelect: (id: string, kind: DesktopSource['kind']) => void; onBack: () => void; onClose: () => void }) {
  const audioNote = (kind: DesktopSource['kind']) => (kind === 'window' ? 'Áudio: somente desta aplicação' : 'Áudio: sistema, excluindo apps de chamada');
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><div className="source-picker"><header><div><span className="modal-eyebrow">Nova transmissão</span><h2>Escolha uma tela ou janela</h2><p>Um clique inicia a transmissão; os demais cartões ficam bloqueados enquanto a captura abre.</p></div><div className="source-header-actions"><button disabled={busy} onClick={onBack}>Voltar</button><button className="icon-button" disabled={busy} onClick={onClose}><Icon name="close" /></button></div></header><div className="source-grid">{sources.map((source) => <button key={source.id} disabled={busy} onClick={() => onSelect(source.id, source.kind)}><span className="source-thumbnail"><img src={source.thumbnail} alt="" />{source.kind === 'screen' && <small>TELA INTEIRA</small>}</span><strong>{source.name}</strong>{withAudio && <small className="source-audio">{audioNote(source.kind)}</small>}</button>)}</div></div></div>;
}

function Avatar({ name, profile, serverUrl = '', small, large, online, imageOverride }: { name: string; profile?: UserProfile; serverUrl?: string; small?: boolean; large?: boolean; online?: boolean; imageOverride?: string }) {
  const hue = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  const image = imageOverride ?? profileMediaUrl(serverUrl, profile?.avatar);
  return <span className={`avatar ${small ? 'small' : ''} ${large ? 'large' : ''} ${image ? 'has-image' : ''}`} style={{ '--avatar-hue': hue, '--avatar-accent': profile?.accentColor ?? '#ff5c5c', ...(image ? { backgroundImage: `url(${image})` } : {}) } as React.CSSProperties}>{!image && name.slice(0, 1).toUpperCase()}{online && <i />}</span>;
}

export default App;
