import { Component, FormEvent, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AdminOverview, Channel, ChatAttachment, ChatMessage, ChatSyncBundle, PublicUser, ServerSnapshot, UserProfile, VoiceState } from '../shared/types';
import { profileIsNewer } from '../shared/profileVersion';
import { Icon } from './components/Icon';
import { Dropdown } from './components/Dropdown';
import { AdminPanel } from './components/AdminPanel';
import { cleanDeviceLabel, useDevices } from './hooks/useDevices';
import { qualityOptions, useVoice, type PeerHealth, type RemoteMedia, type StreamQuality } from './hooks/useVoice';
import { SCREEN_QUALITIES } from './lib/screenQuality';
import { clearSession, defaultServerUrl, loadSession, login, register, saveSession, type SavedSession } from './lib/session';
import { playSound, readSoundEnabled, readSoundVolume, setSoundPreference, setSoundVolume, unlockAudio, type FeedbackSound } from './lib/sound';
import { cacheAttachment, cacheProfileMedia, downloadBlob, formatFileSize, hasLocalAttachment, loadLocalSyncBundle, mirrorLocally, publishProfileMedia, resolveAttachment, uploadAttachment } from './lib/chatSync';
import { volumeToGain } from './lib/audioGain';
import { adoptDirectKey, buildInvite, describeGrade, readDirectReport, readInvite, resolveInvite, type DirectReport } from './lib/directLink';
import { copyText } from './lib/clipboard';
import { cachedTurnServers, forgetTurnServers, refreshTurnServers } from './lib/iceServers';
import { diagnoseMicrophone, formatDiagnosticReport, type LayerVerdict } from './lib/mediaDiagnostics';
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
  if (!session) return <Login onLogin={setSession} />;
  return <Boundary title="O Tumacord tropeçou"><Tumacord session={session} onSessionChange={setSession} onLogout={() => { clearSession(); forgetTurnServers(); setSession(null); }} /></Boundary>;
}

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
  const [inviteCode, setInviteCode] = useState('');
  const isDesktop = Boolean(window.tumacordDesktop);

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
      const resolved = await resolveInvite(inviteCode).catch(() => null);
      if (!resolved) {
        setError(readInvite(inviteCode) ? 'O convite é válido, mas não consegui alcançar a call. Peça um código novo a quem convidou.' : 'Código de convite inválido ou vencido.');
        setLoading(false);
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
      onLogin(authenticated);
      playSound('connect');
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Falha ao entrar.'); playSound('error'); }
    finally { setLoading(false); }
  };

  return <main className="login-page">
    <div className="login-glow glow-one" /><div className="login-glow glow-two" />
    <form className="login-card" onSubmit={submit}>
      <img className="login-logo" src={logoUrl} alt="Marca do Tumacord" />
      <div className="brand-title">Tuma<span>cord</span></div>
      <div className="connection-mode" role="tablist" aria-label="Tipo de conexão">
        <button type="button" disabled={!isDesktop} className={connectionMode === 'p2p' ? 'selected' : ''} onClick={() => setConnectionMode('p2p')} title={!isDesktop ? 'O modo P2P automático está disponível no aplicativo instalado.' : undefined}><Icon name="users" /><span><strong>P2P automático</strong><small>{isDesktop ? 'Enlace direto, rede local e convite' : 'Disponível no aplicativo'}</small></span></button>
        <button type="button" className={connectionMode === 'server' ? 'selected' : ''} onClick={() => setConnectionMode('server')}><Icon name="server" /><span><strong>Servidor dedicado</strong><small>Conectar por endereço</small></span></button>
      </div>
      <label className="invite-field">Código de convite <small>Opcional. Cole o código de quem já está na call: ele leva você ao lugar certo, seja P2P ou servidor.</small><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} autoComplete="off" spellCheck={false} placeholder="TUMA1.…" /></label>
      {connectionMode === 'server' && <div className="server-login-fields">
        <label>Endereço do servidor <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://tumacord.exemplo:4600" required /></label>
        <label>Chave do servidor <input type="password" value={serverKey} onChange={(event) => setServerKey(event.target.value)} autoComplete="off" placeholder="Chave definida pelo host" /></label>
        <p className="server-security-note"><Icon name="shield" /><span><strong>Conexão protegida</strong><small>HTTPS/WSS quando configurado; voz, câmera e tela usam WebRTC criptografado.</small></span></p>
      </div>}
      <label>Usuário <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="Seu nome de usuário" required /></label>
      <label>Senha <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="••••••••" required /></label>
      {mode === 'register' && <label>Confirmar senha <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="Repita a senha" required /></label>}
      <label className="remember-login"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /><span><strong>Continuar conectado</strong><small>Reabre o Tumacord nesta conta sem pedir login novamente.</small></span></label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button" disabled={loading}>{loading ? (mode === 'register' ? 'Criando…' : 'Entrando…') : mode === 'register' ? 'Criar conta' : 'Entrar no Tumacord'}</button>
      <button type="button" className="account-toggle" onClick={() => { setMode((current) => current === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'register' ? 'Já tenho uma conta' : 'Criar uma conta nova'}</button>
      <small>{connectionMode === 'p2p' ? 'Uma conversa e uma call para o grupo. Na mesma rede as calls aparecem sozinhas; fora dela, um código de convite basta — sem ZeroTier.' : 'A primeira entrada cria sua conta nesse servidor com as mesmas credenciais locais. A porta padrão é 4600.'}</small>
      <div className="app-version" title={`Versão instalada: ${APP_VERSION}`}>Tumacord v{APP_VERSION}</div>
    </form>
  </main>;
}

function Tumacord({ session, onSessionChange, onLogout }: { session: SavedSession; onSessionChange: (session: SavedSession) => void; onLogout: () => void }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [snapshot, setSnapshot] = useState<ServerSnapshot>({ serverName: session.serverName, channels: [], onlineUsers: [], voiceRooms: {} });
  const [selectedChannelId, setSelectedChannelId] = useState('geral');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<ChatAttachment | null>(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [syncFiles, setSyncFiles] = useState(() => localStorage.getItem('tumacord.sync-files') === 'true');
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [memberListOpen, setMemberListOpen] = useState(true);
  const [toast, setToast] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(readSoundEnabled);
  const [soundVolume, setFeedbackVolume] = useState(readSoundVolume);
  const [appFullscreen, setAppFullscreen] = useState(false);
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
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const toastTimer = useRef<number | null>(null);
  const handoffTimer = useRef<number | null>(null);
  const handoffGeneration = useRef(0);
  const resumedCall = useRef('');
  const selectedChannelRef = useRef(selectedChannelId);
  const syncFilesRef = useRef(syncFiles);
  useEffect(() => { selectedChannelRef.current = selectedChannelId; }, [selectedChannelId]);
  useEffect(() => { syncFilesRef.current = syncFiles; }, [syncFiles]);

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

  const toggleAppFullscreen = useCallback(async () => {
    try {
      if (window.tumacordDesktop) setAppFullscreen(await window.tumacordDesktop.toggleFullscreen());
      else if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      showToast('Não foi possível alternar o modo tela cheia.');
    }
  }, [showToast]);

  useEffect(() => {
    if (!window.tumacordDesktop || session.connectionMode === 'server') {
      setDiscoveredCalls([]);
      return;
    }
    void window.tumacordDesktop.discoverCalls().then(setDiscoveredCalls);
    return window.tumacordDesktop.onCallsChanged(setDiscoveredCalls);
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

  const enterInvitedCall = useCallback(async (code: string) => {
    if (!session.password) {
      onLogout();
      return false;
    }
    const resolved = await resolveInvite(code).catch(() => null);
    if (!resolved) return false;
    try {
      const migrated = await login(resolved.url, session.user.username, session.password, resolved.invite.callId, true, resolved.mode, session.rememberMe ?? true, resolved.invite.key);
      if (resolved.mode === 'p2p') await adoptDirectKey(resolved.invite.key);
      onSessionChange(migrated);
      return true;
    } catch {
      return false;
    }
  }, [onLogout, onSessionChange, session.password, session.rememberMe, session.user.username]);

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
    const mergeVisible = (incoming: ChatMessage[]) => {
      const visible = incoming.filter((item) => item.channelId === selectedChannelRef.current);
      if (!visible.length) return;
      setMessages((current) => [...new Map([...current, ...visible].map((item) => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    };
    const storeIncoming = (incoming: ChatMessage[]) => {
      void mirrorLocally([], incoming);
      mergeVisible(incoming);
      if (syncFilesRef.current) for (const item of incoming) if (item.attachment) void cacheAttachment(next, item.attachment, session.serverUrl, session.token).catch(() => undefined);
    };
    const mirrorProfilesAfterMedia = (bundle: ChatSyncBundle) => {
      if (!bundle.profiles?.length) return;
      // O servidor local rejeita corretamente um perfil que aponte para uma
      // imagem ausente. Baixamos os arquivos antes de persistir o JSON para
      // não perder o perfil durante uma migração de host.
      void cacheProfileMedia(bundle, session.serverUrl)
        .then(() => mirrorLocally([], [], bundle.profiles ?? []))
        .catch(() => undefined);
    };
    const mergeBundle = (bundle: ChatSyncBundle) => {
      void mirrorLocally(bundle.channels, bundle.messages);
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
      const local = await loadLocalSyncBundle();
      await publishProfileMedia(local, session.serverUrl, session.token);
      next.emit('chat:sync:push', local, (result: ChatSyncBundle & { ok?: boolean }) => { if (result?.ok !== false && result?.messages) mergeBundle(result); });
    };
    next.on('connect', () => { setConnected(true); void pushLocalHistory(); });
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
      void mirrorLocally(incoming.channels, []);
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
    next.on('chat:sync:messages', (incoming: ChatMessage[]) => storeIncoming(incoming));
    next.on('chat:sync:request', () => { void pushLocalHistory(); });
    next.on('chat:file:find', async (payload: { requestId?: string; attachmentId?: string; requester?: string }) => {
      if (!payload.requestId || !payload.attachmentId || !payload.requester || !(await hasLocalAttachment(payload.attachmentId))) return;
      next.emit('chat:file:offer', payload);
    });
    setSocket(next);
    return () => { next.disconnect(); setSocket(null); };
  }, [onLogout, onSessionChange, session.connectionMode, session.password, session.rememberMe, session.resumeChannelId, session.serverUrl, session.token, session.user.id, session.user.username, showToast]);

  useEffect(() => {
    if (!window.tumacordDesktop) {
      const update = () => setAppFullscreen(Boolean(document.fullscreenElement));
      document.addEventListener('fullscreenchange', update);
      return () => document.removeEventListener('fullscreenchange', update);
    }
    void window.tumacordDesktop.isFullscreen().then(setAppFullscreen);
    return window.tumacordDesktop.onFullscreenChanged(setAppFullscreen);
  }, []);

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
      void mirrorLocally([], sorted);
      if (syncFilesRef.current) for (const item of sorted) if (item.attachment) void cacheAttachment(socket, item.attachment, session.serverUrl, session.token).catch(() => undefined);
    });
  }, [selectedChannel?.id, selectedChannel?.type, session.serverUrl, session.token, socket]);

  const sendMessage = (event: FormEvent) => {
    event.preventDefault();
    if ((!message.trim() && !pendingAttachment) || !selectedChannel || selectedChannel.type !== 'text') return;
    socket?.emit('chat:send', { channelId: selectedChannel.id, body: message.trim(), attachment: pendingAttachment ?? undefined });
    setMessage('');
    setPendingAttachment(null);
  };

  const selectAttachment = async (file: File) => {
    setAttachmentUploading(true);
    try {
      setPendingAttachment(await uploadAttachment(file, session.serverUrl, session.token));
      showToast('Arquivo pronto para enviar.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Falha ao preparar o arquivo.');
    } finally { setAttachmentUploading(false); }
  };

  const downloadAttachment = async (attachment: ChatAttachment) => {
    try {
      const contents = await resolveAttachment(socket, attachment, session.serverUrl, session.token);
      if (syncFiles) await cacheAttachment(socket, attachment, session.serverUrl, session.token);
      downloadBlob(contents, attachment.name);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Falha ao baixar o arquivo.'); }
  };

  const changeFileSync = (enabled: boolean) => {
    setSyncFiles(enabled);
    syncFilesRef.current = enabled;
    localStorage.setItem('tumacord.sync-files', String(enabled));
    if (enabled) for (const item of messages) if (item.attachment) void cacheAttachment(socket, item.attachment, session.serverUrl, session.token).catch(() => undefined);
    showToast(enabled ? 'Arquivos serão mantidos neste computador.' : 'Novos arquivos só serão baixados quando você pedir.');
  };

  const openChannel = (channel: Channel) => {
    setSelectedChannelId(channel.id);
    if (channel.type === 'voice' && voice.channelId !== channel.id) void voice.join(channel.id);
  };

  const createChannel = (type: Channel['type']) => {
    const name = window.prompt(type === 'voice' ? 'Nome da nova call:' : 'Nome do novo canal:');
    if (name?.trim()) socket?.emit('channel:create', { name, type });
  };

  const currentVoiceChannel = snapshot.channels.find((channel) => channel.id === voice.channelId);
  const selectedMembers = selectedChannel?.type === 'voice' ? snapshot.voiceRooms[selectedChannel.id] ?? [] : [];
  const allVoiceMembers = [...new Map(Object.values(snapshot.voiceRooms).flat().map((member) => [member.id, member])).values()];
  const currentUser = snapshot.onlineUsers.find((user) => user.id === session.user.id) ?? session.user;
  const isServerAdmin = session.connectionMode === 'server' && Boolean(currentUser.isAdmin);
  const activeRemoteScreen = voice.remoteMedia.find((media) => media.kind === 'screen' && media.stream.getVideoTracks().some((track) => track.readyState === 'live'));
  const browsingText = selectedChannel?.type !== 'voice';
  const backgroundVoiceMedia = browsingText ? voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length === 0) : [];
  useEffect(() => { setMiniLiveHidden(false); }, [activeRemoteScreen?.stream.id, selectedChannelId]);
  useEffect(() => { setVoiceMenuUserId(null); }, [selectedChannelId, voice.channelId]);
  // Um único ponto troca a saída de áudio. Fazer isso por elemento de mídia
  // reiniciava a saída várias vezes seguidas e derrubava o som da call.
  useEffect(() => { setSharedAudioSink(devices.preferences.speakerId); }, [devices.preferences.speakerId]);

  return <div className="app-shell">
    <nav className="server-rail" aria-label="Servidor Tumacord">
      <button className="server-icon active" title="Tumacord"><span className="server-icon-art"><img src={logoUrl} alt="Tumacord" /></span></button>
    </nav>

    <aside className="channel-sidebar">
      <header className="server-header"><span className="brand-mark">Tuma<span>cord</span></span></header>
      <div className="channel-scroll">
        {(window.tumacordDesktop || session.connectionMode === 'server') && <section className="direct-link-actions">
          <div className="group-title"><span>{session.connectionMode === 'server' ? 'Convites' : 'Enlace direto'}</span></div>
          <button className="direct-link-button" onClick={() => setInviteOpen(true)}><Icon name="users" /><span><strong>Convidar pela internet</strong><small>Gera um código com os caminhos até este computador</small></span></button>
          <button className="direct-link-button" onClick={() => setJoinInviteOpen(true)}><Icon name="server" /><span><strong>Entrar por convite</strong><small>Cole o código de quem já está na call</small></span></button>
        </section>}
        {discoveredCalls.length > 0 && <section className="network-calls"><div className="group-title"><span>Calls na rede</span><i className="live-dot" /></div>{discoveredCalls.map((call) => <button className="network-call" key={`${call.hostId}:${call.callId}`} onClick={() => void enterDiscoveredCall(call)}><div><strong>{call.callName}</strong><span>{call.hostUsername} · {call.participants} {call.participants === 1 ? 'pessoa' : 'pessoas'}</span></div><small>{call.pingMs} ms</small></button>)}</section>}
        <ChannelGroup title={session.connectionMode === 'server' ? 'Canais de texto' : 'Conversa'} onAdd={session.connectionMode === 'server' ? () => createChannel('text') : undefined}>
          {visibleChannels.filter((channel) => channel.type === 'text').map((channel) => <ChannelButton key={channel.id} channel={channel} selected={selectedChannelId === channel.id} onClick={() => openChannel(channel)} />)}
        </ChannelGroup>
        <ChannelGroup title={session.connectionMode === 'server' ? 'Canais de voz' : 'Call do grupo'} onAdd={session.connectionMode === 'server' ? () => createChannel('voice') : undefined}>
          {visibleChannels.filter((channel) => channel.type === 'voice').map((channel) => <div key={channel.id}>
            <ChannelButton channel={channel} selected={selectedChannelId === channel.id} connected={voice.channelId === channel.id} onClick={() => openChannel(channel)} />
            {(snapshot.voiceRooms[channel.id] ?? []).map((member) => {
              const self = member.id === session.user.id;
              const canAdjustVolume = !self && voice.members.some((candidate) => candidate.id === member.id);
              const memberVolume = Math.max(0, Math.min(2, userVolumes[member.id] ?? 1));
              return <div className="voice-member-entry" key={member.socketId}>
                <button className={`voice-member-mini ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`} onClick={() => { if (canAdjustVolume) setVoiceMenuUserId((current) => current === member.id ? null : member.id); else setProfileUser(member); }} title={canAdjustVolume ? `Ajustar volume de ${member.username}` : `Ver perfil de ${member.username}`}>
                  <Avatar name={member.username} profile={member.profile} serverUrl={session.serverUrl} small />
                  {/* Quem já está na call não precisa do ping aqui: a lista de
                      presença, à direita, é o lugar dessa informação. */}
                  <span className="voice-member-copy"><strong>{member.username}</strong>{member.screen && <small><span className="live-dot" /> AO VIVO</small>}</span>
                  <span className="voice-member-icons">{member.isHost && <Icon name="host" />}{(member.muted || mutedUsers[member.id]) && <Icon name="micOff" />}</span>
                </button>
                {voiceMenuUserId === member.id && canAdjustVolume && <VoiceMemberVolume member={member} volume={memberVolume} muted={Boolean(mutedUsers[member.id])} onVolume={(volume) => setUserVolume(member.id, volume)} onMuted={(muted) => setUserMuted(member.id, muted)} onProfile={() => setProfileUser(member)} onClose={() => setVoiceMenuUserId(null)} />}
              </div>;
            })}
          </div>)}
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
    </aside>

    <section className="main-panel">
      <header className="topbar">
        <Icon name={selectedChannel?.type === 'voice' ? 'voice' : 'hash'} />
        <strong>{selectedChannel?.name ?? 'Tumacord'}</strong>
        {selectedChannel?.type === 'text' && <span className="channel-topic">Conversa do grupo.</span>}
        <div className="topbar-spacer" />
        <span className={`connection-pill ${connected ? 'online' : ''}`} title={session.connectionMode === 'server' ? session.serverUrl : `Host dinâmico por enlace direto${networkPreferences.zeroTierEnabled ? ', rede local e ZeroTier' : ' e rede local'}`}><i />{connected ? (session.connectionMode === 'server' ? 'Servidor conectado' : 'P2P conectado') : 'Reconectando'}</span>
        {isServerAdmin && <button className="admin-toolbar-button" onClick={() => setAdminOpen(true)} title="Painel administrativo"><Icon name="shield" /></button>}
        <button className={memberListOpen ? 'toolbar-active' : ''} onClick={() => setMemberListOpen((value) => !value)} title="Membros"><Icon name="users" /></button>
        <button onClick={() => void toggleAppFullscreen()} title={appFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}><Icon name={appFullscreen ? 'minimize' : 'maximize'} /></button>
      </header>
      <div className="content-row">
        {selectedChannel?.type === 'voice'
          ? <Boundary title="A call precisou ser redesenhada"><CallView voice={voice} channel={selectedChannel} members={selectedMembers} speakerId={devices.preferences.speakerId} userVolumes={userVolumes} streamVolume={streamVolume} setStreamVolume={setStreamVolume} streamMuted={streamMuted} setStreamMuted={setStreamMuted} mutedUsers={mutedUsers} serverUrl={session.serverUrl} onProfile={setProfileUser} onNotice={showToast} /></Boundary>
          : <ChatView channel={selectedChannel} messages={messages} message={message} setMessage={setMessage} sendMessage={sendMessage} pendingAttachment={pendingAttachment} uploading={attachmentUploading} syncFiles={syncFiles} onFile={selectAttachment} onClearAttachment={() => setPendingAttachment(null)} onSyncFiles={changeFileSync} onDownload={downloadAttachment} serverUrl={session.serverUrl} />}
        {memberListOpen && <MemberList users={snapshot.onlineUsers} voiceMembers={allVoiceMembers} currentUserId={session.user.id} serverUrl={session.serverUrl} onProfile={setProfileUser} />}
      </div>
    </section>

    {backgroundVoiceMedia.map((media) => <MediaElement key={`background:${media.peerId}:${media.stream.id}`} stream={media.stream} muted={voice.deafened || Boolean(media.user?.id && mutedUsers[media.user.id])} volume={media.user?.id ? Math.max(0, Math.min(2, userVolumes[media.user.id] ?? 1)) : 1} speakerId={devices.preferences.speakerId} audioOnly remote />)}
    {browsingText && activeRemoteScreen && !miniLiveHidden && <FloatingLivePlayer media={activeRemoteScreen} speakerId={devices.preferences.speakerId} muted={voice.deafened || streamMuted} volume={streamVolume} rawVolume={streamVolume} onVolume={(volume) => { setStreamMuted(false); setStreamVolume(volume); }} onMute={() => setStreamMuted(!streamMuted)} onOpen={() => { if (voice.channelId) setSelectedChannelId(voice.channelId); }} onClose={() => setMiniLiveHidden(true)} onNotice={showToast} />}

    {settingsOpen && <SettingsModal devices={devices} quality={voice.quality} setQuality={voice.setQuality} soundEnabled={soundEnabled} setSoundEnabled={changeSoundPreference} soundVolume={soundVolume} setSoundVolume={changeSoundVolume} networkPreferences={networkPreferences} onNetworkPreferences={(patch) => { void updateNetworkPreferences(patch).then(setNetworkPreferences); }} mediaSnapshot={voice.mediaSnapshot} connectionMode={session.connectionMode ?? 'p2p'} onNotice={showToast} onClose={() => setSettingsOpen(false)} onLogout={onLogout} />}
    {inviteOpen && <InviteModal callId={voice.channelId ?? currentVoiceChannel?.id ?? 'call-geral'} callName={currentVoiceChannel?.name ?? 'Call do grupo'} hostUsername={session.user.username} server={session.connectionMode === 'server' ? session.serverUrl : undefined} serverKey={session.directKey} onClose={() => setInviteOpen(false)} onNotice={showToast} />}
    {joinInviteOpen && <JoinInviteModal onJoin={enterInvitedCall} onClose={() => setJoinInviteOpen(false)} onNotice={showToast} />}
    {adminOpen && <AdminPanel serverUrl={session.serverUrl} token={session.token} currentUserId={session.user.id} onClose={() => setAdminOpen(false)} onNotice={showToast} />}
    {voice.showShareSetup && <ShareSetupModal initialQuality={voice.quality} busy={voice.shareBusy} onContinue={(includeAudio, selectedQuality) => void voice.prepareScreenShare(includeAudio, selectedQuality)} onClose={() => voice.setShowShareSetup(false)} />}
    {voice.showSourcePicker && <SourcePicker sources={voice.desktopSources} busy={voice.shareBusy} onSelect={(id, kind) => void voice.shareDesktopSource(id, kind)} onBack={() => { voice.setShowSourcePicker(false); voice.setShowShareSetup(true); }} onClose={() => voice.setShowSourcePicker(false)} />}
    {profileUser && <ProfileModal user={snapshot.onlineUsers.find((candidate) => candidate.id === profileUser.id) ?? (profileUser.id === session.user.id ? session.user : profileUser)} own={profileUser.id === session.user.id} serverUrl={session.serverUrl} token={session.token} onClose={() => setProfileUser(null)} onSaved={(updated) => { const nextSession = { ...session, user: updated }; saveSession(nextSession); onSessionChange(nextSession); setProfileUser(updated); showToast('Perfil atualizado.'); }} />}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function ChannelGroup({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) {
  return <section className="channel-group"><div className="group-title"><span>{title}</span>{onAdd && <button onClick={onAdd} title="Criar canal"><Icon name="plus" /></button>}</div>{children}</section>;
}

function ChannelButton({ channel, selected, connected, onClick }: { channel: Channel; selected: boolean; connected?: boolean; onClick: () => void }) {
  return <button className={`channel-button ${selected ? 'selected' : ''} ${connected ? 'connected' : ''}`} onClick={onClick}>
    <Icon name={channel.type === 'voice' ? 'voice' : 'hash'} /><span>{channel.name}</span>{connected && <i />}
  </button>;
}

interface ChatViewProps {
  channel?: Channel;
  messages: ChatMessage[];
  message: string;
  setMessage: (text: string) => void;
  sendMessage: (event: FormEvent) => void;
  pendingAttachment: ChatAttachment | null;
  uploading: boolean;
  syncFiles: boolean;
  onFile: (file: File) => void;
  onClearAttachment: () => void;
  onSyncFiles: (enabled: boolean) => void;
  onDownload: (attachment: ChatAttachment) => void;
  serverUrl: string;
}

function ChatView({ channel, messages, message, setMessage, sendMessage, pendingAttachment, uploading, syncFiles, onFile, onClearAttachment, onSyncFiles, onDownload, serverUrl }: ChatViewProps) {
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  return <main className="chat-view">
    <div className="message-list">
      <div className="channel-welcome"><div className="welcome-icon"><Icon name="hash" /></div><h1>Bem-vindo a #{channel?.name}</h1><p>Este é o começo do canal. Puxa uma cadeira.</p></div>
      {messages.map((item, index) => {
        const compact = index > 0 && messages[index - 1].author.id === item.author.id && new Date(item.createdAt).getTime() - new Date(messages[index - 1].createdAt).getTime() < 300_000;
        return <article className={`message ${compact ? 'compact' : ''}`} key={item.id}>
          {!compact && <Avatar name={item.author.username} profile={item.author.profile} serverUrl={serverUrl} />}
          <div>{!compact && <div className="message-head"><strong>{item.author.username}</strong><time>{new Date(item.createdAt).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</time></div>}{item.body && <p>{item.body}</p>}{item.attachment && <div className="message-attachment">{item.attachment.previewDataUrl ? <img src={item.attachment.previewDataUrl} alt="Prévia leve do arquivo" /> : <span className="attachment-file-icon"><Icon name="file" /></span>}<div><strong>{item.attachment.name}</strong><small>{formatFileSize(item.attachment.size)} · prévia local leve</small></div><button onClick={() => onDownload(item.attachment!)} title="Baixar arquivo"><Icon name="download" /></button></div>}</div>
        </article>;
      })}<div ref={bottom} />
    </div>
    <div className="chat-composer">
      <label className="file-sync-toggle" title="Quando ativo, o arquivo completo fica guardado neste PC"><input type="checkbox" checked={syncFiles} onChange={(event) => onSyncFiles(event.target.checked)} /><Icon name="syncFile" /><span>Sincronizar arquivos neste PC</span></label>
      {pendingAttachment && <div className="pending-attachment"><Icon name="paperclip" /><span><strong>{pendingAttachment.name}</strong><small>{formatFileSize(pendingAttachment.size)}</small></span><button type="button" onClick={onClearAttachment} title="Remover anexo"><Icon name="close" /></button></div>}
      <form className="message-box" onSubmit={sendMessage}><input ref={fileInput} className="hidden-file-input" type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} /><button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} title={uploading ? 'Preparando arquivo…' : 'Anexar arquivo'}><Icon name={uploading ? 'syncFile' : 'plus'} /></button><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Conversar em #${channel?.name ?? ''}`} maxLength={2000} /><button className="send-button" aria-label="Enviar" disabled={!message.trim() && !pendingAttachment}><Icon name="send" /></button></form>
    </div>
  </main>;
}

interface VoiceViewModel {
  channelId: string | null;
  members: VoiceState[];
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  remoteMedia: RemoteMedia[];
  peerHealth: Record<string, PeerHealth>;
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

function CallView({ voice, channel, members, speakerId, userVolumes, mutedUsers, streamVolume, setStreamVolume, streamMuted, setStreamMuted, serverUrl, onProfile, onNotice }: { voice: VoiceViewModel; channel: Channel; members: VoiceState[]; speakerId: string; userVolumes: Record<string, number>; mutedUsers: Record<string, boolean>; streamVolume: number; setStreamVolume: (volume: number) => void; streamMuted: boolean; setStreamMuted: (muted: boolean) => void; serverUrl: string; onProfile: (user: PublicUser) => void; onNotice: (message: string) => void }) {
  const [theaterMediaKey, setTheaterMediaKey] = useState<string | null>(null);
  const [hiddenScreenUsers, setHiddenScreenUsers] = useState<Set<string>>(() => new Set());
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
  const visibleVideoMedia = videoMedia.filter((media) => media.kind !== 'screen' || !hiddenScreenUsers.has(media.user?.id ?? media.peerId));
  const audioMedia = voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length === 0);
  const tiles = inThisCall ? voice.members : members;
  const expectedRemoteStreams = voice.members.filter((member) => member.id !== voice.user.id && member.screen);
  const missingStreams = expectedRemoteStreams.filter((member) => !videoMedia.some((media) => media.kind === 'screen' && (media.user?.id === member.id || media.peerId === member.socketId)));
  const hiddenStreams = expectedRemoteStreams.filter((member) => hiddenScreenUsers.has(member.id) && videoMedia.some((media) => media.kind === 'screen' && (media.user?.id === member.id || media.peerId === member.socketId)));
  const watchingLive = visibleVideoMedia.some((media) => media.kind === 'screen');
  const volumeFor = (userId?: string) => userId ? Math.max(0, Math.min(2, userVolumes[userId] ?? 1)) : 1;
  const mutedFor = (userId?: string) => Boolean(userId && mutedUsers[userId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement) setTheaterMediaKey(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    const active = new Set(voice.members.filter((member) => member.screen).map((member) => member.id));
    setHiddenScreenUsers((current) => {
      const next = new Set([...current].filter((id) => active.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [voice.members]);
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
  const videoCount = (voice.localScreen ? 1 : 0) + (voice.localCamera ? 1 : 0) + visibleVideoMedia.length + missingStreams.length + hiddenStreams.length;
  return <main className="call-view">
    <div className={`stage-grid count-${Math.min(4, videoCount)} ${theaterMediaKey ? 'focused-live' : ''}`}>
      {voice.localScreen && showMedia('local-screen') && <VideoTile mediaKey="local-screen" stream={voice.localScreen} label={`${voice.user.username} · sua tela`} muted screen theater={theaterMediaKey === 'local-screen'} onTheater={setTheaterMediaKey} />}
      {voice.localCamera && showMedia('local-camera') && <VideoTile mediaKey="local-camera" stream={voice.localCamera} label={`${voice.user.username} · você`} muted theater={theaterMediaKey === 'local-camera'} onTheater={setTheaterMediaKey} />}
      {visibleVideoMedia.map((media) => { const mediaKey = `${media.peerId}:${media.stream.id}`; const screen = media.kind === 'screen'; return showMedia(mediaKey) && <VideoTile key={mediaKey} mediaKey={mediaKey} stream={media.stream} label={`${media.user?.username ?? 'Amigo'}${screen ? ' · AO VIVO' : ''}`} muted={screen ? voice.deafened || streamMuted : voice.deafened || mutedFor(media.user?.id)} volume={screen ? streamVolume : volumeFor(media.user?.id)} speakerId={speakerId} screen={screen} remote theater={theaterMediaKey === mediaKey} onTheater={setTheaterMediaKey} onDetached={trackDetached} onNotice={onNotice} onClose={screen ? () => { setTheaterMediaKey(null); setHiddenScreenUsers((current) => new Set(current).add(media.user?.id ?? media.peerId)); } : undefined} />; })}
      {!theaterMediaKey && missingStreams.map((member) => <div className="stream-recovery-card" key={`missing-${member.id}`}><span className="live-dot" /><strong>{member.username} está AO VIVO</strong><p>A transmissão está se reconectando automaticamente.</p><small>{voice.peerHealth[member.socketId] === 'recovering' ? 'Recuperando conexão…' : 'Aguardando a faixa de vídeo…'}</small><button onClick={() => voice.recoverPeer(member.socketId, 'tentativa manual da interface', true)}>Tentar agora</button></div>)}
      {!theaterMediaKey && hiddenStreams.map((member) => <div className="stream-recovery-card stream-hidden-card" key={`hidden-${member.id}`}><Icon name="screen" /><strong>Live de {member.username} ocultada</strong><p>Você saiu desta transmissão, mas continua na call.</p><button onClick={() => setHiddenScreenUsers((current) => { const next = new Set(current); next.delete(member.id); return next; })}>Assistir novamente</button></div>)}
      {!visibleVideoMedia.length && !missingStreams.length && !hiddenStreams.length && !voice.localCamera && !voice.localScreen && <div className="audio-stage">
        {tiles.length ? tiles.map((member) => <ParticipantTile key={member.socketId} member={member} serverUrl={serverUrl} onProfile={onProfile} />) : <div className="empty-call"><img src={logoUrl} alt="" /><h2>A call está quietinha</h2><p>Entre e seja o host. Quem chegar depois conecta direto com você.</p></div>}
      </div>}
    </div>
    {audioMedia.map((media) => <MediaElement key={`${media.peerId}:${media.stream.id}`} stream={media.stream} muted={voice.deafened || mutedFor(media.user?.id)} volume={volumeFor(media.user?.id)} speakerId={speakerId} audioOnly remote />)}
    <footer className={`call-dock ${inThisCall ? '' : 'is-idle'}`}>
      {!inThisCall ? <button className="join-call" onClick={() => void voice.join(channel.id)}><Icon name="voice" /> Entrar na call</button> : <>
        <div className="dock-side start">
          {voice.screenOn && <div className="dock-field">
            <span className="dock-label">Qualidade</span>
            <Dropdown label="Qualidade da transmissão ao vivo" value={voice.quality} options={qualityDropdownOptions} onChange={(next) => { void voice.setQuality(next as StreamQuality).then((applied) => { if (applied) onNotice(`Live ajustada para ${SCREEN_QUALITIES[next as StreamQuality]?.label ?? next}.`); }); }} />
          </div>}
        </div>
        <div className="dock-controls">
          <ControlButton icon={voice.muted ? 'micOff' : 'mic'} label={voice.muted ? 'Ativar microfone' : 'Silenciar'} active={voice.muted} danger onClick={() => void voice.toggleMute()} />
          <ControlButton icon="headphones" label={voice.deafened ? 'Ouvir de novo' : 'Ensurdecer'} active={voice.deafened} danger onClick={voice.toggleDeafen} />
          <ControlButton icon="camera" label={voice.cameraOn ? 'Parar a câmera' : 'Ligar a câmera'} active={voice.cameraOn} onClick={() => void voice.toggleCamera()} />
          <ControlButton icon="screen" label={voice.screenOn ? 'Parar a transmissão' : 'Transmitir a tela'} active={voice.screenOn} accent onClick={() => void voice.requestScreenShare()} />
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

function ControlButton({ icon, label, active, danger, accent, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; active?: boolean; danger?: boolean; accent?: boolean; onClick: () => void }) {
  return <button className={`call-control ${active ? 'active' : ''} ${danger ? 'danger' : ''} ${accent ? 'accent' : ''}`} onClick={onClick} title={label} aria-label={label}><Icon name={icon} /></button>;
}

function ParticipantTile({ member, serverUrl, onProfile }: { member: VoiceState; serverUrl: string; onProfile: (user: PublicUser) => void }) {
  return <button className={`participant-tile ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`} onClick={() => onProfile(member)}><Avatar name={member.username} profile={member.profile} serverUrl={serverUrl} large /><strong>{member.username}</strong>{member.screen && <span className="streaming-label"><span className="live-dot" /> AO VIVO</span>}<span className="tile-ping">{member.pingMs < 9999 ? `${member.pingMs} ms` : 'medindo…'}</span><div className="participant-badges">{member.isHost && <span className="host-badge"><Icon name="host" /> Host</span>}{member.muted && <span className="muted-badge"><Icon name="micOff" /></span>}</div></button>;
}

function VideoTile({ mediaKey, stream, label, muted, volume = 1, speakerId, screen, remote, theater = false, onTheater, onClose, onDetached, onNotice }: { mediaKey: string; stream: MediaStream; label: string; muted: boolean; volume?: number; speakerId?: string; screen?: boolean; remote?: boolean; theater?: boolean; onTheater?: (key: string | null) => void; onClose?: () => void; onDetached?: (key: string, detached: boolean) => void; onNotice?: (message: string) => void }) {
  const tileRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const detachedLive = useDetachedLive(mediaRef, label, `tumacord-live-${mediaKey.replace(/[^a-zA-Z0-9]/g, '')}`);
  const canDetach = Boolean(remote && detachedLive.supported);
  const [fullscreen, setFullscreen] = useState(false);
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
  return <div ref={tileRef} onDoubleClick={onTileDoubleClick} className={`video-tile ${screen ? 'screen' : ''} ${theater ? 'is-theater' : ''} ${fullscreen ? 'is-fullscreen' : ''} ${detachedLive.detached ? 'is-detached' : ''}`}><MediaElement stream={stream} muted={muted} volume={volume} speakerId={speakerId} remote={remote} mediaRef={mediaRef} />{detachedLive.detached && <div className="detached-live-note"><Icon name="popOut" /><strong>Em uma janela flutuante</strong><small>Ela fica sobre os outros aplicativos, mesmo com o Tumacord minimizado.</small></div>}<span>{screen && <i className="live-dot" />}{label}</span><div className="video-actions">{onClose && <button onClick={() => void closeTile()} title="Sair desta live sem sair da call"><Icon name="close" /></button>}{canDetach && <button onClick={() => void toggleDetached()} title={detachedLive.detached ? 'Trazer de volta para o app' : 'Soltar em uma janela flutuante sobre os outros apps'}><Icon name={detachedLive.detached ? 'popIn' : 'popOut'} /></button>}<button onClick={toggleTheater} disabled={fullscreen} title={fullscreen ? 'Saia da tela cheia para usar a grade' : theater ? 'Voltar à grade (ou clique duas vezes)' : 'Ampliar dentro do app (ou clique duas vezes)'}><Icon name={theater ? 'shrink' : 'expand'} /></button><button onClick={() => void toggleFullscreen()} title={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia real'}><Icon name={fullscreen ? 'minimize' : 'maximize'} /></button></div></div>;
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
      applyDirect();
      return () => { syncPlayback.current = () => undefined; applyTrackGate(false); media.srcObject = null; };
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
      applyTrackGate(false);
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
    <button className={`voice-volume-mute ${muted ? 'is-muted' : ''}`} aria-pressed={muted} onClick={() => onMuted(!muted)} title={muted ? 'A voz volta; a transmissão tem controle próprio' : 'Silencia só a voz; a transmissão tem controle próprio'}>
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

function SettingsModal({ devices, quality, setQuality, soundEnabled, setSoundEnabled, soundVolume, setSoundVolume: updateSoundVolume, networkPreferences, onNetworkPreferences, mediaSnapshot, connectionMode, onNotice, onClose, onLogout }: { devices: ReturnType<typeof useDevices>; quality: StreamQuality; setQuality: (quality: StreamQuality) => void | Promise<boolean>; soundEnabled: boolean; setSoundEnabled: (enabled: boolean) => void; soundVolume: number; setSoundVolume: (volume: number) => void; networkPreferences: NetworkPreferences; onNetworkPreferences: (patch: Partial<NetworkPreferences>) => void; mediaSnapshot: ReturnType<typeof useVoice>['mediaSnapshot']; connectionMode: 'p2p' | 'server'; onNotice: (message: string) => void; onClose: () => void; onLogout: () => void }) {
  const [tab, setTab] = useState<'media' | 'network' | 'diagnostics'>('media');
  function update<K extends keyof typeof devices.preferences>(key: K, value: (typeof devices.preferences)[K]): void {
    devices.setPreferences({ ...devices.preferences, [key]: value });
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal">
    <aside><h2>Configurações</h2><button className={tab === 'media' ? 'selected' : ''} onClick={() => setTab('media')}>Voz e vídeo</button><button className={tab === 'network' ? 'selected' : ''} onClick={() => setTab('network')}>Rede e conexão</button><button className={tab === 'diagnostics' ? 'selected' : ''} onClick={() => setTab('diagnostics')}>Diagnóstico</button><button onClick={onLogout}>Sair da conta</button><span className="settings-version">Tumacord v{APP_VERSION}</span></aside>
    {tab === 'network' && <NetworkSettings preferences={networkPreferences} onChange={onNetworkPreferences} onClose={onClose} />}
    {tab === 'diagnostics' && <MediaDiagnostics snapshot={mediaSnapshot} preferences={networkPreferences} connectionMode={connectionMode} onNotice={onNotice} onClose={onClose} />}
    {tab === 'media' && <section><button className="modal-close" onClick={onClose}><Icon name="close" /></button><h1>Voz e vídeo</h1><p className="settings-intro">O Tumacord processa a voz localmente em 48 kHz com cancelamento de eco, filtro neural GTCRN, corte de ruído grave e compressor de voz.</p>
      <DeviceSelect label="Microfone" hint="As entradas duplicadas do Chromium ficam de fora da lista." value={devices.preferences.microphoneId} devices={devices.microphones} onChange={(value) => update('microphoneId', value)} />
      <DeviceSelect label="Saída de áudio" value={devices.preferences.speakerId} devices={devices.speakers} onChange={(value) => update('speakerId', value)} />
      <DeviceSelect label="Câmera" value={devices.preferences.cameraId} devices={devices.cameras} onChange={(value) => update('cameraId', value)} />
      <label className="sound-toggle"><input type="checkbox" checked={devices.preferences.noiseSuppression} onChange={(event) => update('noiseSuppression', event.target.checked)} /><span><strong>Supressão neural de ruído</strong><small>GTCRN em WebAssembly para reduzir teclado, ventilador e ruído ambiente sem enviar seu áudio para nenhum serviço.</small></span></label>
      <div className="setting-label"><span className="setting-title">Qualidade da transmissão<small>Vale para a próxima live e para a que já estiver no ar.</small></span><Dropdown label="Qualidade da transmissão" value={quality} options={qualityDropdownOptions} onChange={(next) => { void setQuality(next as StreamQuality); }} /></div>
      <label className="sound-toggle"><input type="checkbox" checked={soundEnabled} onChange={(event) => setSoundEnabled(event.target.checked)} /><span><strong>Sons de feedback</strong><small>Entrada, saída, mensagens, microfone e troca de host.</small></span></label>
      <label className="feedback-volume"><span>Volume dos feedbacks</span><input type="range" min="0.2" max="1" step="0.05" value={soundVolume} disabled={!soundEnabled} onChange={(event) => updateSoundVolume(Number(event.target.value))} onMouseUp={() => playSound('notification')} /><output>{Math.round(soundVolume * 100)}%</output></label>
      <div className="quality-note"><strong>Áudio da transmissão</strong><span>Ao marcar áudio, o Tumacord cria uma fonte estéreo temporária no PipeWire. Jogos, navegador e outros aplicativos entram na live; Tumacord, Discord e a voz da call são excluídos automaticamente, inclusive na tela inteira.</span></div>
    </section>}
  </div></div>;
}

function NetworkSettings({ preferences, onChange, onClose }: { preferences: NetworkPreferences; onChange: (patch: Partial<NetworkPreferences>) => void; onClose: () => void }) {
  const [report, setReport] = useState<DirectReport | null>(null);
  const [checking, setChecking] = useState(true);
  const check = useCallback(async (force: boolean) => {
    setChecking(true);
    setReport(await readDirectReport({ force }));
    setChecking(false);
  }, []);
  useEffect(() => { void check(false); }, [check]);
  return <section><button className="modal-close" onClick={onClose}><Icon name="close" /></button><h1>Rede e conexão</h1>
    <p className="settings-intro">A call vai direto de computador para computador. O Tumacord procura sozinho o melhor caminho: rede local, IPv6 e, quando o roteador deixa, uma porta aberta para o IPv4. A mídia continua cifrada de ponta a ponta por DTLS-SRTP.</p>
    <div className="reachability-card">
      <div className="reachability-head"><strong>{checking ? 'Verificando os caminhos…' : `Alcance: ${describeGrade(report?.grade ?? 'blocked')}`}</strong><button disabled={checking} onClick={() => void check(true)}>Testar de novo</button></div>
      <span>{checking ? 'Consultando STUN e o roteador; leva alguns segundos.' : report ? describeReachability({ grade: report.grade, paths: report.paths, ipv6: report.ipv6, cgnat: report.cgnat, natMapping: report.natMapping, mappedVia: report.mappedVia }) : 'A verificação de rede está disponível apenas no aplicativo instalado.'}</span>
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
  const relatorio = useRef<HTMLTextAreaElement>(null);
  // Uma leitura por segundo: o suficiente para acompanhar uma falha aparecer,
  // sem transformar o painel em custo de CPU durante a call.
  useEffect(() => {
    const timer = window.setInterval(() => setEstado(snapshot()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot]);
  const camadas: LayerVerdict[] = diagnoseMicrophone(estado);
  const contexto = {
    version: APP_VERSION,
    connectionMode,
    stunConfigured: preferences.stunEnabled && preferences.stunServers.length > 0,
    turnConfigured: preferences.turnEnabled && cachedTurnServers().length > 0,
    paths: estado.paths,
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

function InviteModal({ callId, callName, hostUsername, server, serverKey, onClose, onNotice }: { callId: string; callName: string; hostUsername: string; server?: string; serverKey?: string; onClose: () => void; onNotice: (message: string) => void }) {
  // O código é gerado uma vez, dentro do efeito. Gerá-lo no corpo do render
  // fazia a call inteira ditar o ritmo: cada atualização de ping re-renderizava
  // este modal e produzia um código diferente na tela.
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const codeField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let active = true;
    // Com servidor de encontro não há o que sondar: o convite é a call mais o
    // segredo, e quem entra chega lá por conexão de saída.
    const material = server ? Promise.resolve(null) : readDirectReport();
    void material.then((report) => {
      if (!active) return;
      setCode(buildInvite(report, { callId, callName, hostUsername, server, key: serverKey }));
      setLoading(false);
    });
    return () => { active = false; };
  }, [callId, callName, hostUsername, server, serverKey]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="invite-modal">
    <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Enlace direto</span>
    <h2>Convidar pela internet</h2>
    <p>{server
      ? 'O código aponta o servidor da call e leva o segredo que dá direito de entrar. Nenhum endereço da sua máquina vai junto, e quem receber chega por conexão de saída — atravessa CGNAT sem abrir porta nenhuma.'
      : 'O código carrega os endereços por onde este computador aceita entrada e a chave que protege a porta. Ele vale por 12 horas; mande por onde preferir.'}</p>
    {loading && <p className="invite-status">Procurando os caminhos até aqui…</p>}
    {!loading && !code && <p className="invite-status">{server
      ? 'Faltou a chave de acesso deste servidor para montar o convite. Entre de novo informando a chave e tente outra vez.'
      : 'Nenhum caminho de entrada foi encontrado. Use um servidor de encontro, peça para outra pessoa do grupo gerar o convite, ou ligue o ZeroTier em Configurações → Rede e conexão.'}</p>}
    {code && <>
      <textarea ref={codeField} className="invite-code" readOnly value={code} rows={4} onFocus={(event) => event.currentTarget.select()} />
      <button className="primary-button" onClick={() => { void copyText(code, codeField.current).then((copied) => onNotice(copied ? 'Convite copiado.' : 'Não consegui copiar; o texto ficou selecionado, use Ctrl+C.')); }}>Copiar convite</button>
      <small className="invite-hint">{server
        ? 'Este é o mesmo código enquanto o servidor e a chave não mudarem. Quem receber cola em “Entrar por convite” ou no campo de convite da tela de entrada, e não precisa de porta aberta, UPnP nem IPv6.'
        : 'Este é o mesmo código enquanto os endereços deste computador não mudarem: reabrir esta janela mostra ele de novo, e o que você já enviou continua valendo. Quem receber cola em “Entrar por convite” ou no campo de convite da tela de entrada. A chave vale para a call inteira, então a troca de host continua funcionando.'}</small>
    </>}
  </div></div>;
}

function JoinInviteModal({ onJoin, onClose, onNotice }: { onJoin: (code: string) => Promise<boolean>; onClose: () => void; onNotice: (message: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    if (!readInvite(code)) {
      setError('Código inválido ou vencido. Peça um convite novo ao host.');
      setBusy(false);
      return;
    }
    const joined = await onJoin(code);
    setBusy(false);
    if (!joined) return setError('O convite é válido, mas nenhum dos caminhos respondeu. O host pode ter fechado o app ou trocado de rede.');
    onNotice('Entrando na call pelo convite…');
    onClose();
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><div className="invite-modal">
    <button className="modal-close" disabled={busy} onClick={onClose}><Icon name="close" /></button>
    <span className="modal-eyebrow">Enlace direto</span>
    <h2>Entrar por convite</h2>
    <p>Cole o código que você recebeu. Os caminhos são tentados em paralelo e o primeiro que responder é usado.</p>
    <textarea className="invite-code" value={code} rows={4} spellCheck={false} placeholder="TUMA1.…" onChange={(event) => setCode(event.target.value)} />
    {error && <p className="invite-status error">{error}</p>}
    <button className="primary-button" disabled={busy || !code.trim()} onClick={() => void submit()}>{busy ? 'Procurando o host…' : 'Entrar na call'}</button>
  </div></div>;
}

function DeviceSelect({ label, hint, value, devices, onChange }: { label: string; hint?: string; value: string; devices: MediaDeviceInfo[]; onChange: (value: string) => void }) {
  const options = [
    { value: '', label: 'Padrão do sistema' },
    ...devices.map((device, index) => ({ value: device.deviceId, label: cleanDeviceLabel(device.label) || `${label} ${index + 1}` })),
  ];
  return <div className="setting-label"><span className="setting-title">{label}{hint && <small>{hint}</small>}</span><Dropdown label={label} value={value} options={options} onChange={onChange} /></div>;
}

function ShareSetupModal({ initialQuality, busy, onContinue, onClose }: { initialQuality: StreamQuality; busy: boolean; onContinue: (includeAudio: boolean, quality: StreamQuality) => void; onClose: () => void }) {
  const [includeAudio, setIncludeAudio] = useState(true);
  const [selectedQuality, setSelectedQuality] = useState<StreamQuality>(initialQuality);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><div className="share-setup"><button className="modal-close" disabled={busy} onClick={onClose}><Icon name="close" /></button><span className="modal-eyebrow">Nova transmissão</span><h2>Como você quer transmitir?</h2><p>Defina a qualidade e o áudio primeiro. A tela ou janela será escolhida uma única vez na próxima etapa.</p><div className="quality-cards">{qualityOptions.map(([value, option]) => <button key={value} disabled={busy} className={selectedQuality === value ? 'selected' : ''} onClick={() => setSelectedQuality(value)}><Icon name="screen" /><span><strong>{option.label.split(' · ')[0]}</strong><small>{option.label.split(' · ')[1] ?? 'Qualidade original'}</small></span></button>)}</div><label className="share-audio-card"><input type="checkbox" disabled={busy} checked={includeAudio} onChange={(event) => setIncludeAudio(event.target.checked)} /><span><strong>Compartilhar áudio</strong><small>Inclui o som do sistema, mantendo Tumacord e Discord fora da live.</small></span></label><button className="primary-button share-continue" disabled={busy} onClick={() => onContinue(includeAudio, selectedQuality)}>{busy ? 'Abrindo o seletor…' : 'Continuar para escolher a tela'} {!busy && <Icon name="chevron" />}</button></div></div>;
}

function SourcePicker({ sources, busy, onSelect, onBack, onClose }: { sources: DesktopSource[]; busy: boolean; onSelect: (id: string, kind: DesktopSource['kind']) => void; onBack: () => void; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><div className="source-picker"><header><div><span className="modal-eyebrow">Nova transmissão</span><h2>Escolha uma tela ou janela</h2><p>Um clique inicia a transmissão; os demais cartões ficam bloqueados enquanto a captura abre.</p></div><div className="source-header-actions"><button disabled={busy} onClick={onBack}>Voltar</button><button className="icon-button" disabled={busy} onClick={onClose}><Icon name="close" /></button></div></header><div className="source-grid">{sources.map((source) => <button key={source.id} disabled={busy} onClick={() => onSelect(source.id, source.kind)}><span className="source-thumbnail"><img src={source.thumbnail} alt="" />{source.kind === 'screen' && <small>TELA INTEIRA</small>}</span><strong>{source.name}</strong></button>)}</div></div></div>;
}

function Avatar({ name, profile, serverUrl = '', small, large, online, imageOverride }: { name: string; profile?: UserProfile; serverUrl?: string; small?: boolean; large?: boolean; online?: boolean; imageOverride?: string }) {
  const hue = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  const image = imageOverride ?? profileMediaUrl(serverUrl, profile?.avatar);
  return <span className={`avatar ${small ? 'small' : ''} ${large ? 'large' : ''} ${image ? 'has-image' : ''}`} style={{ '--avatar-hue': hue, '--avatar-accent': profile?.accentColor ?? '#ff5c5c', ...(image ? { backgroundImage: `url(${image})` } : {}) } as React.CSSProperties}>{!image && name.slice(0, 1).toUpperCase()}{online && <i />}</span>;
}

export default App;
