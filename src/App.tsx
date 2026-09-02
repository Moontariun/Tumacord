import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AdminOverview, Channel, ChatAttachment, ChatMessage, ChatSyncBundle, PublicUser, ServerSnapshot, UserProfile, VoiceState } from '../shared/types';
import { Icon } from './components/Icon';
import { useDevices } from './hooks/useDevices';
import { qualityOptions, useVoice, type PeerHealth, type RemoteMedia, type StreamQuality } from './hooks/useVoice';
import { clearSession, defaultServerUrl, loadSession, login, register, saveSession, type SavedSession } from './lib/session';
import { playSound, readSoundEnabled, readSoundVolume, setSoundPreference, setSoundVolume, unlockAudio, type FeedbackSound } from './lib/sound';
import { cacheAttachment, downloadBlob, formatFileSize, hasLocalAttachment, loadLocalSyncBundle, mirrorLocally, resolveAttachment, uploadAttachment } from './lib/chatSync';
import { volumeToGain } from './lib/audioGain';
import { profileMediaUrl, updateProfile, uploadProfileMedia } from './lib/profile';
import logoUrl from '../assets/tumacord-logo.png';
import packageMetadata from '../package.json';

const APP_VERSION = packageMetadata.version;

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
  return <Tumacord session={session} onSessionChange={setSession} onLogout={() => { clearSession(); setSession(null); }} />;
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
    const target = connectionMode === 'p2p' && isDesktop ? 'http://127.0.0.1:3927' : serverUrl;
    try {
      const authenticated = mode === 'register'
        ? await register(target, username, password, undefined, connectionMode, rememberMe, serverKey)
        : await login(target, username, password, undefined, connectionMode === 'server', connectionMode, rememberMe, serverKey);
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
      <p>{mode === 'register' ? 'Crie sua conta e entre na turma.' : 'Entre e o Tumacord encontra a turma sozinho.'}</p>
      <div className="connection-mode" role="tablist" aria-label="Tipo de conexão">
        <button type="button" disabled={!isDesktop} className={connectionMode === 'p2p' ? 'selected' : ''} onClick={() => setConnectionMode('p2p')} title={!isDesktop ? 'O modo P2P automático está disponível no aplicativo instalado.' : undefined}><Icon name="users" /><span><strong>P2P automático</strong><small>{isDesktop ? 'ZeroTier/LAN, host dinâmico' : 'Disponível no aplicativo'}</small></span></button>
        <button type="button" className={connectionMode === 'server' ? 'selected' : ''} onClick={() => setConnectionMode('server')}><Icon name="server" /><span><strong>Servidor dedicado</strong><small>Conectar por endereço</small></span></button>
      </div>
      {connectionMode === 'server' && <div className="server-login-fields">
        <label>Endereço do servidor <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://tumacord.exemplo:4600" required /></label>
        <label>Chave do servidor <input type="password" value={serverKey} onChange={(event) => setServerKey(event.target.value)} autoComplete="off" placeholder="Chave definida pelo host" /></label>
        <p className="server-security-note"><Icon name="shield" /><span><strong>Conexão protegida</strong><small>HTTPS/WSS quando configurado; voz, câmera e tela usam WebRTC criptografado.</small></span></p>
      </div>}
      <label>Usuário <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="Como a turma te chama?" required /></label>
      <label>Senha <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="••••••••" required /></label>
      {mode === 'register' && <label>Confirmar senha <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="Repita a senha" required /></label>}
      <label className="remember-login"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /><span><strong>Continuar conectado</strong><small>Reabre o Tumacord nesta conta sem pedir login novamente.</small></span></label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button" disabled={loading}>{loading ? (mode === 'register' ? 'Criando…' : 'Entrando…') : mode === 'register' ? 'Criar conta' : 'Entrar no Tumacord'}</button>
      <button type="button" className="account-toggle" onClick={() => { setMode((current) => current === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'register' ? 'Já tenho uma conta' : 'Criar uma conta nova'}</button>
      <small>{connectionMode === 'p2p' ? 'Uma conversa e uma call para a turma. As calls da rede aparecem dentro do app; ninguém precisa copiar IP.' : 'A primeira entrada cria sua conta nesse servidor com as mesmas credenciais locais. A porta padrão é 4600.'}</small>
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
  const [profileUser, setProfileUser] = useState<PublicUser | null>(null);
  const [userVolumes, setUserVolumes] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('tumacord.user-volumes') ?? '{}') as Record<string, number>; } catch { return {}; }
  });
  const devices = useDevices();
  const toastTimer = useRef<number | null>(null);
  const resumedCall = useRef(false);
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

  const enterDiscoveredCall = useCallback(async (call: DiscoveredCall) => {
    if (!session.password) return onLogout();
    try {
      onSessionChange(await login(call.url, session.user.username, session.password, call.callId, true, 'p2p', session.rememberMe ?? true));
    } catch {
      showToast('Não consegui entrar nessa call. Confira se o host ainda está online.');
    }
  }, [onLogout, onSessionChange, session.password, session.user.username, showToast]);

  const handleHostHandoff = useCallback((host: VoiceState, channelId: string, abrupt: boolean) => {
    if (session.connectionMode === 'server') return;
    const selfWillHost = host.id === session.user.id;
    const target = selfWillHost ? 'http://127.0.0.1:3927' : host.endpoint;
    showToast(selfWillHost ? 'O host saiu. Você tem o menor ping e está assumindo a call…' : `${host.username} tem o menor ping e está assumindo como host…`, 'host');
    const delay = selfWillHost ? 0 : abrupt ? 1100 : 800;
    window.setTimeout(async () => {
      if (!session.password) return onLogout();
      try {
        onSessionChange(await login(target, session.user.username, session.password, channelId, true, 'p2p', session.rememberMe ?? true));
      } catch {
        showToast('A troca automática de host falhou. Tentando localizar a call novamente…');
        onLogout();
      }
    }, delay);
  }, [onLogout, onSessionChange, session.connectionMode, session.password, session.user.id, session.user.username, showToast]);

  useEffect(() => {
    const next = io(session.serverUrl, { auth: { token: session.token }, transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 3000 });
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
    const mergeBundle = (bundle: ChatSyncBundle) => {
      void mirrorLocally(bundle.channels, bundle.messages);
      mergeVisible(bundle.messages);
    };
    const pushLocalHistory = async () => {
      const local = await loadLocalSyncBundle();
      next.emit('chat:sync:push', local, (result: ChatSyncBundle & { ok?: boolean }) => { if (result?.ok !== false && result?.messages) mergeBundle(result); });
    };
    next.on('connect', () => { setConnected(true); void pushLocalHistory(); });
    next.on('disconnect', () => setConnected(false));
    next.on('connect_error', (error) => {
      setConnected(false);
      if (error.message === 'unauthorized') { clearSession(); onLogout(); }
    });
    next.on('server:snapshot', (incoming: ServerSnapshot) => { setSnapshot(incoming); void mirrorLocally(incoming.channels, []); });
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
  }, [onLogout, session.serverUrl, session.token, session.user.id]);

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
    if (!resume || resumedCall.current || !connected || !visibleChannels.some((channel) => channel.id === resume)) return;
    resumedCall.current = true;
    setSelectedChannelId(resume);
    void voice.join(resume);
  }, [connected, session.resumeChannelId, visibleChannels, voice]);

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

  return <div className="app-shell">
    <nav className="server-rail" aria-label="Servidor Tumacord">
      <button className="server-icon active" title="Tumacord"><span className="server-icon-art"><img src={logoUrl} alt="Tumacord" /></span></button>
    </nav>

    <aside className="channel-sidebar">
      <header className="server-header"><span>{snapshot.serverName}</span></header>
      <div className="channel-scroll">
        {discoveredCalls.length > 0 && <section className="network-calls"><div className="group-title"><span>Calls na rede</span><i className="live-dot" /></div>{discoveredCalls.map((call) => <button className="network-call" key={`${call.hostId}:${call.callId}`} onClick={() => void enterDiscoveredCall(call)}><div><strong>{call.callName}</strong><span>{call.hostUsername} · {call.participants} {call.participants === 1 ? 'pessoa' : 'pessoas'}</span></div><small>{call.pingMs} ms</small></button>)}</section>}
        <ChannelGroup title={session.connectionMode === 'server' ? 'Canais de texto' : 'Conversa'} onAdd={session.connectionMode === 'server' ? () => createChannel('text') : undefined}>
          {visibleChannels.filter((channel) => channel.type === 'text').map((channel) => <ChannelButton key={channel.id} channel={channel} selected={selectedChannelId === channel.id} onClick={() => openChannel(channel)} />)}
        </ChannelGroup>
        <ChannelGroup title={session.connectionMode === 'server' ? 'Canais de voz' : 'Call da turma'} onAdd={session.connectionMode === 'server' ? () => createChannel('voice') : undefined}>
          {visibleChannels.filter((channel) => channel.type === 'voice').map((channel) => <div key={channel.id}>
            <ChannelButton channel={channel} selected={selectedChannelId === channel.id} connected={voice.channelId === channel.id} onClick={() => openChannel(channel)} />
            {(snapshot.voiceRooms[channel.id] ?? []).map((member) => <div className={`voice-member-mini ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`} key={member.socketId}><Avatar name={member.username} profile={member.profile} serverUrl={session.serverUrl} small /><span className="voice-member-copy"><strong>{member.username}</strong><small>{member.screen ? <><span className="live-dot" /> AO VIVO</> : member.pingMs < 9999 ? `${member.pingMs} ms` : 'na call'}</small></span><span className="voice-member-icons">{member.isHost && <Icon name="host" />}{member.muted && <Icon name="micOff" />}</span></div>)}
          </div>)}
        </ChannelGroup>
      </div>
      {voice.channelId && <div className="voice-status">
        <div><strong>Voz conectada</strong><span>{currentVoiceChannel?.name}</span></div>
        <button onClick={voice.leave} title="Desconectar"><Icon name="phoneOff" /></button>
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
        {selectedChannel?.type === 'text' && <span className="channel-topic">Conversa da turma sem complicação.</span>}
        <div className="topbar-spacer" />
        <span className={`connection-pill ${connected ? 'online' : ''}`} title={session.connectionMode === 'server' ? session.serverUrl : 'Host dinâmico pela rede local/ZeroTier'}><i />{connected ? (session.connectionMode === 'server' ? 'Servidor conectado' : 'P2P conectado') : 'Reconectando'}</span>
        {isServerAdmin && <button className="admin-toolbar-button" onClick={() => setAdminOpen(true)} title="Painel administrativo"><Icon name="shield" /></button>}
        <button className={memberListOpen ? 'toolbar-active' : ''} onClick={() => setMemberListOpen((value) => !value)} title="Membros"><Icon name="users" /></button>
        <button onClick={() => void toggleAppFullscreen()} title={appFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}><Icon name={appFullscreen ? 'minimize' : 'maximize'} /></button>
      </header>
      <div className="content-row">
        {selectedChannel?.type === 'voice'
          ? <CallView voice={voice} channel={selectedChannel} members={selectedMembers} speakerId={devices.preferences.speakerId} userVolumes={userVolumes} setUserVolume={setUserVolume} serverUrl={session.serverUrl} p2pMode={session.connectionMode !== 'server'} onProfile={setProfileUser} onNotice={showToast} />
          : <ChatView channel={selectedChannel} messages={messages} message={message} setMessage={setMessage} sendMessage={sendMessage} pendingAttachment={pendingAttachment} uploading={attachmentUploading} syncFiles={syncFiles} onFile={selectAttachment} onClearAttachment={() => setPendingAttachment(null)} onSyncFiles={changeFileSync} onDownload={downloadAttachment} serverUrl={session.serverUrl} />}
        {memberListOpen && <MemberList users={snapshot.onlineUsers} voiceMembers={allVoiceMembers} volumeMembers={voice.members} currentUserId={session.user.id} userVolumes={userVolumes} setUserVolume={setUserVolume} serverUrl={session.serverUrl} onProfile={setProfileUser} />}
      </div>
    </section>

    {settingsOpen && <SettingsModal devices={devices} quality={voice.quality} setQuality={voice.setQuality} soundEnabled={soundEnabled} setSoundEnabled={changeSoundPreference} soundVolume={soundVolume} setSoundVolume={changeSoundVolume} onClose={() => setSettingsOpen(false)} onLogout={onLogout} />}
    {adminOpen && <AdminModal serverUrl={session.serverUrl} token={session.token} currentUserId={session.user.id} onClose={() => setAdminOpen(false)} onNotice={showToast} />}
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
  setQuality: (quality: StreamQuality) => Promise<void>;
  user: { id: string; username: string };
}

function CallView({ voice, channel, members, speakerId, userVolumes, setUserVolume, serverUrl, p2pMode, onProfile, onNotice }: { voice: VoiceViewModel; channel: Channel; members: VoiceState[]; speakerId: string; userVolumes: Record<string, number>; setUserVolume: (userId: string, volume: number) => void; serverUrl: string; p2pMode: boolean; onProfile: (user: PublicUser) => void; onNotice: (message: string) => void }) {
  const [streamVolume, setStreamVolume] = useState(1);
  const [streamMuted, setStreamMuted] = useState(false);
  const [theaterMediaKey, setTheaterMediaKey] = useState<string | null>(null);
  const [hiddenScreenUsers, setHiddenScreenUsers] = useState<Set<string>>(() => new Set());
  const inThisCall = voice.channelId === channel.id;
  const videoMedia = voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length > 0);
  const visibleVideoMedia = videoMedia.filter((media) => media.kind !== 'screen' || !hiddenScreenUsers.has(media.user?.id ?? media.peerId));
  const audioMedia = voice.remoteMedia.filter((media) => media.stream.getVideoTracks().length === 0);
  const tiles = inThisCall ? voice.members : members;
  const expectedRemoteStreams = voice.members.filter((member) => member.id !== voice.user.id && member.screen);
  const missingStreams = expectedRemoteStreams.filter((member) => !videoMedia.some((media) => media.kind === 'screen' && (media.user?.id === member.id || media.peerId === member.socketId)));
  const hiddenStreams = expectedRemoteStreams.filter((member) => hiddenScreenUsers.has(member.id) && videoMedia.some((media) => media.kind === 'screen' && (media.user?.id === member.id || media.peerId === member.socketId)));
  const remoteMembers = voice.members.filter((member) => member.id !== voice.user.id);
  const routeStates = remoteMembers.map((member) => voice.peerHealth[member.socketId] ?? 'connecting');
  const routeRecovering = routeStates.some((state) => state === 'recovering' || state === 'failed');
  const routeConnecting = !routeRecovering && routeStates.some((state) => state === 'connecting');
  const validPings = remoteMembers.map((member) => member.pingMs).filter((ping) => ping < 9999);
  const routePing = validPings.length ? Math.round(validPings.reduce((total, ping) => total + ping, 0) / validPings.length) : undefined;
  const volumeFor = (userId?: string) => userId ? Math.max(0, Math.min(2, userVolumes[userId] ?? 1)) : 1;
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
  const showMedia = (key: string) => !theaterMediaKey || theaterMediaKey === key;
  const videoCount = (voice.localScreen ? 1 : 0) + (voice.localCamera ? 1 : 0) + visibleVideoMedia.length + missingStreams.length + hiddenStreams.length;
  return <main className="call-view">
    <div className={`stage-grid count-${Math.min(4, videoCount)} ${theaterMediaKey ? 'focused-live' : ''}`}>
      {voice.localScreen && showMedia('local-screen') && <VideoTile mediaKey="local-screen" stream={voice.localScreen} label={`${voice.user.username} · sua tela`} muted screen theater={theaterMediaKey === 'local-screen'} onTheater={setTheaterMediaKey} />}
      {voice.localCamera && showMedia('local-camera') && <VideoTile mediaKey="local-camera" stream={voice.localCamera} label={`${voice.user.username} · você`} muted theater={theaterMediaKey === 'local-camera'} onTheater={setTheaterMediaKey} />}
      {visibleVideoMedia.map((media) => { const mediaKey = `${media.peerId}:${media.stream.id}`; const screen = media.kind === 'screen'; return showMedia(mediaKey) && <VideoTile key={mediaKey} mediaKey={mediaKey} stream={media.stream} label={`${media.user?.username ?? 'Amigo'}${screen ? ' · AO VIVO' : ''}`} muted={voice.deafened || (screen && streamMuted)} volume={Math.min(2, (screen ? streamVolume : 1) * volumeFor(media.user?.id))} speakerId={speakerId} screen={screen} theater={theaterMediaKey === mediaKey} onTheater={setTheaterMediaKey} onClose={screen ? () => { setTheaterMediaKey(null); setHiddenScreenUsers((current) => new Set(current).add(media.user?.id ?? media.peerId)); } : undefined} />; })}
      {!theaterMediaKey && missingStreams.map((member) => <div className="stream-recovery-card" key={`missing-${member.id}`}><span className="live-dot" /><strong>{member.username} está AO VIVO</strong><p>A transmissão está se reconectando automaticamente.</p><small>{voice.peerHealth[member.socketId] === 'recovering' ? 'Recuperando conexão…' : 'Aguardando a faixa de vídeo…'}</small><button onClick={() => voice.recoverPeer(member.socketId, 'tentativa manual da interface', true)}>Tentar agora</button></div>)}
      {!theaterMediaKey && hiddenStreams.map((member) => <div className="stream-recovery-card stream-hidden-card" key={`hidden-${member.id}`}><Icon name="screen" /><strong>Live de {member.username} ocultada</strong><p>Você saiu desta transmissão, mas continua na call.</p><button onClick={() => setHiddenScreenUsers((current) => { const next = new Set(current); next.delete(member.id); return next; })}>Assistir novamente</button></div>)}
      {!visibleVideoMedia.length && !missingStreams.length && !hiddenStreams.length && !voice.localCamera && !voice.localScreen && <div className="audio-stage">
        {tiles.length ? tiles.map((member) => <ParticipantTile key={member.socketId} member={member} serverUrl={serverUrl} onProfile={onProfile} />) : <div className="empty-call"><img src={logoUrl} alt="" /><h2>A call está quietinha</h2><p>Entre e seja o host. Quem chegar depois conecta direto com você.</p></div>}
      </div>}
    </div>
    {audioMedia.map((media) => <MediaElement key={`${media.peerId}:${media.stream.id}`} stream={media.stream} muted={voice.deafened} volume={volumeFor(media.user?.id)} speakerId={speakerId} audioOnly />)}
    <div className="call-footer">
      <div className="call-status-tools">
        {p2pMode && inThisCall && remoteMembers.length > 0 && <div className={`p2p-route ${routeRecovering ? 'recovering' : routeConnecting ? 'connecting' : 'stable'}`} title="Estado dos enlaces diretos WebRTC pela rede ZeroTier/LAN"><span><i /><strong>{routeRecovering ? 'Recuperando rota' : routeConnecting ? 'Conectando malha' : 'Malha P2P estável'}</strong><small>{routePing === undefined ? `${remoteMembers.length} ${remoteMembers.length === 1 ? 'par' : 'pares'}` : `${routePing} ms médio`}</small></span><button onClick={() => { const count = voice.recoverAllPeers(); onNotice(count ? `Reconectando ${count} ${count === 1 ? 'enlace P2P' : 'enlaces P2P'} sem sair da call.` : 'Não há outros participantes para reconectar.'); }}><Icon name="refresh" /><span>Reconectar</span></button></div>}
        {inThisCall && voice.screenOn && <label className="quality-picker"><span><i /> Qualidade ao vivo</span><select value={voice.quality} onChange={(event) => { const next = event.target.value as StreamQuality; void voice.setQuality(next).then(() => onNotice(`Live ajustada para ${qualityOptions.find(([value]) => value === next)?.[1].label ?? next}.`)); }}>{qualityOptions.map(([value, option]) => <option value={value} key={value}>{option.label}</option>)}</select></label>}
      </div>
      <div className="call-primary-controls">
        {!inThisCall ? <button className="join-call" onClick={() => void voice.join(channel.id)}><Icon name="voice" /> Entrar na call</button> : <>
          <ControlButton icon={voice.muted ? 'micOff' : 'mic'} label={voice.muted ? 'Ativar microfone' : 'Silenciar'} active={voice.muted} danger onClick={() => void voice.toggleMute()} />
          <ControlButton icon="headphones" label={voice.deafened ? 'Ouvir' : 'Ensurdecer'} active={voice.deafened} danger onClick={voice.toggleDeafen} />
          <ControlButton icon="camera" label={voice.cameraOn ? 'Parar vídeo' : 'Câmera'} active={voice.cameraOn} onClick={() => void voice.toggleCamera()} />
          <ControlButton icon="screen" label={voice.screenOn ? 'Parar stream' : 'Transmitir tela'} active={voice.screenOn} accent onClick={() => void voice.requestScreenShare()} />
          <ControlButton icon="phoneOff" label="Sair" danger active onClick={voice.leave} />
        </>}
      </div>
      <div className="call-viewer-tools">
        {visibleVideoMedia.some((media) => media.kind === 'screen') && <label className="stream-audio-controls"><button type="button" onClick={() => setStreamMuted((muted) => !muted)} title={streamMuted ? 'Ativar áudio da live' : 'Mutar áudio da live'}><Icon name={streamMuted ? 'volumeOff' : 'volume'} /></button><span>Live</span><input type="range" min="0" max="2" step="0.01" value={streamMuted ? 0 : streamVolume} onChange={(event) => { setStreamMuted(false); setStreamVolume(Number(event.target.value)); }} aria-label="Volume da live (até 200%)" /><output>{streamMuted ? 0 : Math.round(streamVolume * 100)}%</output></label>}
      </div>
    </div>
  </main>;
}

function ControlButton({ icon, label, active, danger, accent, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; active?: boolean; danger?: boolean; accent?: boolean; onClick: () => void }) {
  return <button className={`call-control ${active ? 'active' : ''} ${danger ? 'danger' : ''} ${accent ? 'accent' : ''}`} onClick={onClick}><Icon name={icon} /><span>{label}</span></button>;
}

function ParticipantTile({ member, serverUrl, onProfile }: { member: VoiceState; serverUrl: string; onProfile: (user: PublicUser) => void }) {
  return <button className={`participant-tile ${member.speaking ? 'speaking' : ''} ${member.screen ? 'is-streaming' : ''}`} onClick={() => onProfile(member)}><Avatar name={member.username} profile={member.profile} serverUrl={serverUrl} large /><strong>{member.username}</strong>{member.screen && <span className="streaming-label"><span className="live-dot" /> AO VIVO</span>}<span className="tile-ping">{member.pingMs < 9999 ? `${member.pingMs} ms` : 'medindo…'}</span><div className="participant-badges">{member.isHost && <span className="host-badge"><Icon name="host" /> Host</span>}{member.muted && <span className="muted-badge"><Icon name="micOff" /></span>}</div></button>;
}

function VideoTile({ mediaKey, stream, label, muted, volume = 1, speakerId, screen, theater = false, onTheater, onClose }: { mediaKey: string; stream: MediaStream; label: string; muted: boolean; volume?: number; speakerId?: string; screen?: boolean; theater?: boolean; onTheater?: (key: string | null) => void; onClose?: () => void }) {
  const tileRef = useRef<HTMLDivElement>(null);
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
  return <div ref={tileRef} className={`video-tile ${screen ? 'screen' : ''} ${theater ? 'is-theater' : ''} ${fullscreen ? 'is-fullscreen' : ''}`}><MediaElement stream={stream} muted={muted} volume={volume} speakerId={speakerId} /><span>{screen && <i className="live-dot" />}{label}</span><div className="video-actions">{onClose && <button onClick={() => void closeTile()} title="Sair desta live sem sair da call"><Icon name="close" /></button>}<button onClick={() => onTheater?.(theater ? null : mediaKey)} title={theater ? 'Voltar à grade' : 'Ampliar dentro do app'}><Icon name={theater ? 'shrink' : 'expand'} /></button><button onClick={() => void toggleFullscreen()} title={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia real'}><Icon name={fullscreen ? 'minimize' : 'maximize'} /></button></div></div>;
}

function MediaElement({ stream, muted, volume = 1, speakerId, audioOnly }: { stream: MediaStream; muted: boolean; volume?: number; speakerId?: string; audioOnly?: boolean }) {
  const ref = useRef<HTMLMediaElement>(null);
  const [trackRevision, setTrackRevision] = useState(0);
  const gainContext = useRef<AudioContext | null>(null);
  const gainNode = useRef<GainNode | null>(null);
  const playback = useRef({ muted, volume, speakerId });
  const syncPlayback = useRef<() => void>(() => undefined);
  playback.current = { muted, volume, speakerId };
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
    const AudioContextClass = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const applyDirectFallback = () => {
      const current = playback.current;
      media.muted = current.muted;
      media.volume = Math.max(0, Math.min(1, current.volume));
      const sinkMedia = media as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (current.speakerId && sinkMedia.setSinkId) void sinkMedia.setSinkId(current.speakerId).catch(() => undefined);
      void media.play().catch(() => undefined);
    };
    if (!AudioContextClass) {
      syncPlayback.current = applyDirectFallback;
      applyDirectFallback();
      return () => { syncPlayback.current = () => undefined; media.srcObject = null; };
    }
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    source.connect(gain).connect(limiter).connect(context.destination);
    gainContext.current = context;
    gainNode.current = gain;
    const apply = () => {
      const current = playback.current;
      const now = context.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(current.muted ? 0 : volumeToGain(current.volume), now, 0.012);
      if (context.state === 'running') {
        // WebAudio entrega o ganho real acima de 100%. O elemento HTML fica
        // mudo para não duplicar o som.
        media.muted = true;
        media.volume = 1;
      } else {
        // Se PipeWire/Chromium suspender o AudioContext, o áudio continua pelo
        // elemento nativo (limitado a 100%) até o grafo retomar.
        applyDirectFallback();
      }
      const sinkContext = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (current.speakerId && sinkContext.setSinkId) void sinkContext.setSinkId(current.speakerId).catch(() => undefined);
    };
    syncPlayback.current = apply;
    const resume = () => {
      if (context.state === 'suspended') void context.resume().then(apply).catch(applyDirectFallback);
      else apply();
    };
    context.addEventListener('statechange', apply);
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    document.addEventListener('visibilitychange', resume);
    for (const track of audioTracks) track.addEventListener('unmute', resume);
    const watchdog = window.setInterval(resume, 2_000);
    apply();
    resume();
    return () => {
      window.clearInterval(watchdog);
      context.removeEventListener('statechange', apply);
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      document.removeEventListener('visibilitychange', resume);
      for (const track of audioTracks) track.removeEventListener('unmute', resume);
      source.disconnect(); gain.disconnect(); limiter.disconnect();
      syncPlayback.current = () => undefined;
      gainNode.current = null; gainContext.current = null;
      media.srcObject = null;
      void context.close().catch(() => undefined);
    };
  }, [stream, trackRevision]);
  useEffect(() => {
    syncPlayback.current();
  }, [muted, speakerId, stream, volume]);
  return audioOnly ? <audio ref={ref as React.RefObject<HTMLAudioElement>} autoPlay /> : <video ref={ref as React.RefObject<HTMLVideoElement>} autoPlay playsInline />;
}

function MemberList({ users, voiceMembers, volumeMembers, currentUserId, userVolumes, setUserVolume, serverUrl, onProfile }: { users: PublicUser[]; voiceMembers: VoiceState[]; volumeMembers: VoiceState[]; currentUserId: string; userVolumes: Record<string, number>; setUserVolume: (userId: string, volume: number) => void; serverUrl: string; onProfile: (user: PublicUser) => void }) {
  const voiceByUser = useMemo(() => new Map(voiceMembers.map((member) => [member.id, member])), [voiceMembers]);
  const audibleUsers = useMemo(() => new Set(volumeMembers.map((member) => member.id)), [volumeMembers]);
  const inCall = users.filter((user) => voiceByUser.has(user.id));
  const available = users.filter((user) => !voiceByUser.has(user.id));
  const renderMember = (user: PublicUser) => {
    const voice = voiceByUser.get(user.id);
    const volume = Math.max(0, Math.min(2, userVolumes[user.id] ?? 1));
    const self = user.id === currentUserId;
    return <article className={`member-row ${voice?.speaking ? 'speaking' : ''} ${voice?.screen ? 'is-streaming' : ''} ${voice ? 'in-call' : 'available'}`} key={user.id}>
      <div className="member-row-main">
        <button className="member-profile" onClick={() => onProfile(user)}>
          <Avatar name={user.username} profile={user.profile} serverUrl={serverUrl} small online />
          <span className="member-copy">
            <span className="member-name"><strong>{user.username}</strong>{self && <em>Você</em>}</span>
            <small><i className={voice ? 'voice-presence' : ''} />{voice ? (voice.pingMs < 9999 ? `Na chamada · ${voice.pingMs} ms` : 'Na chamada') : 'Online agora'}</small>
          </span>
        </button>
        <span className="member-badges">
          {voice?.screen && <span className="member-live"><span className="live-dot" /> AO VIVO</span>}
          {voice?.isHost && <span className="member-host" title="Host da chamada"><Icon name="host" /></span>}
        </span>
      </div>
      {voice && !self && audibleUsers.has(user.id) && <div className="member-row-audio"><span>Volume</span><label className="member-volume" title={`Volume de ${user.username}: ${Math.round(volume * 100)}%`}><Icon name={volume === 0 ? 'volumeOff' : 'volume'} /><input type="range" min="0" max="2" step="0.01" value={volume} onChange={(event) => setUserVolume(user.id, Number(event.target.value))} aria-label={`Volume de ${user.username} (até 200%)`} /><output>{Math.round(volume * 100)}%</output></label></div>}
      {voice && self && <div className="member-self-state"><Icon name={voice.muted ? 'micOff' : 'mic'} /><span>{voice.muted ? 'Seu microfone está silenciado' : 'Você está na chamada'}</span></div>}
    </article>;
  };
  return <aside className="member-list">
    <header><div><small>Presença</small><h3>Pessoas online</h3></div><span title={`${users.length} online`}>{users.length}</span></header>
    <div className="member-list-scroll">
      {inCall.length > 0 && <section className="member-section"><div className="member-section-title"><span>Na chamada</span><b>{inCall.length}</b></div>{inCall.map(renderMember)}</section>}
      {available.length > 0 && <section className="member-section"><div className="member-section-title"><span>Disponíveis</span><b>{available.length}</b></div>{available.map(renderMember)}</section>}
      {!users.length && <div className="member-list-empty"><Icon name="users" /><strong>Ninguém por aqui</strong><span>Seus amigos aparecem quando entram.</span></div>}
    </div>
  </aside>;
}

function AdminModal({ serverUrl, token, currentUserId, onClose, onNotice }: { serverUrl: string; token: string; currentUserId: string; onClose: () => void; onNotice: (message: string) => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${serverUrl}/api/admin/overview`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json() as AdminOverview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível carregar o painel.');
      setOverview(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o painel.');
    } finally {
      setLoading(false);
    }
  }, [serverUrl, token]);
  useEffect(() => { void load(); }, [load]);
  const disconnectUser = async (user: PublicUser) => {
    if (!window.confirm(`Desconectar ${user.username} do servidor agora?`)) return;
    setDisconnecting(user.id);
    try {
      const response = await fetch(`${serverUrl}/api/admin/users/${encodeURIComponent(user.id)}/disconnect`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível desconectar o usuário.');
      onNotice(`${user.username} foi desconectado do servidor.`);
      window.setTimeout(() => void load(), 250);
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : 'Não foi possível desconectar o usuário.');
    } finally {
      setDisconnecting(null);
    }
  };
  const activeCalls = overview ? Object.values(overview.voiceRooms).filter((members) => members.length > 0).length : 0;
  const uptime = overview ? formatUptime(overview.uptimeSeconds) : '—';
  return <div className="modal-backdrop admin-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="admin-modal">
    <header><div><span className="modal-eyebrow">Servidor dedicado</span><h1>Painel administrativo</h1><p>Visão operacional reservada ao usuário Moontariun.</p></div><div className="admin-header-actions"><button onClick={() => void load()} disabled={loading}><Icon name="refresh" /> Atualizar</button><button className="modal-close" onClick={onClose}><Icon name="close" /></button></div></header>
    {error && <div className="form-error admin-error">{error}</div>}
    {loading && !overview ? <div className="admin-loading">Carregando estado do servidor…</div> : overview && <div className="admin-content">
      <div className="admin-stats"><article><span>Online agora</span><strong>{overview.onlineUsers.length}</strong></article><article><span>Calls ativas</span><strong>{activeCalls}</strong></article><article><span>Canais</span><strong>{overview.channels.length}</strong></article><article><span>Tempo ativo</span><strong>{uptime}</strong></article></div>
      <div className="admin-security"><span className={overview.security.accessKeyRequired ? 'secure' : 'warning'}><Icon name="shield" />{overview.security.accessKeyRequired ? 'Chave de acesso ativa' : 'Sem chave de acesso'}</span><span className={overview.security.tls ? 'secure' : 'neutral'}>{overview.security.tls ? 'HTTPS/WSS ativo' : 'HTTP na rede privada'}</span><span className="secure">Mídia {overview.security.media}</span><small>Versão {overview.version} · iniciado em {new Date(overview.startedAt).toLocaleString('pt-BR')}</small></div>
      <div className="admin-columns">
        <section className="admin-section"><div className="admin-section-title"><div><small>Estrutura</small><h2>Canais</h2></div><b>{overview.channels.length}</b></div><div className="admin-list">{overview.channels.map((channel) => { const participants = channel.type === 'voice' ? overview.voiceRooms[channel.id]?.length ?? 0 : undefined; return <article key={channel.id}><span className="admin-list-icon"><Icon name={channel.type === 'voice' ? 'voice' : 'hash'} /></span><div><strong>{channel.name}</strong><small>{channel.type === 'voice' ? `${participants} na call` : 'Canal de texto'}</small></div></article>; })}</div></section>
        <section className="admin-section"><div className="admin-section-title"><div><small>Presença</small><h2>Usuários conectados</h2></div><b>{overview.onlineUsers.length}</b></div><div className="admin-list admin-user-list">{overview.onlineUsers.map((user) => { const inVoice = Object.values(overview.voiceRooms).flat().find((member) => member.id === user.id); return <article key={user.id}><Avatar name={user.username} profile={user.profile} serverUrl={serverUrl} small online /><div><strong>{user.username}{user.isAdmin && <em>Admin</em>}</strong><small>{inVoice ? `Na call · ${inVoice.pingMs < 9999 ? `${inVoice.pingMs} ms` : 'conectado'}` : 'No servidor'}</small></div>{user.id !== currentUserId && <button disabled={disconnecting === user.id} onClick={() => void disconnectUser(user)}>{disconnecting === user.id ? 'Saindo…' : 'Desconectar'}</button>}</article>; })}{!overview.onlineUsers.length && <p>Nenhum usuário conectado.</p>}</div></section>
      </div>
    </div>}
  </section></div>;
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
  const chooseImage = (file: File | undefined, kind: 'avatar' | 'banner') => {
    if (!file) return;
    if (!/^image\/(?:gif|png|jpeg|webp)$/.test(file.type) || file.size > 6 * 1024 * 1024) {
      setError('Use GIF, PNG, JPG ou WebP de até 6 MB.');
      return;
    }
    const preview = URL.createObjectURL(file);
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
  return <div className="modal-backdrop profile-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="profile-card" style={{ '--profile-accent': accentColor } as React.CSSProperties}>
    <button className="modal-close" onClick={onClose} title="Fechar"><Icon name="close" /></button>
    <div className="profile-banner" style={bannerPreview ? { backgroundImage: `url(${bannerPreview})` } : undefined}>{own && <label className="profile-media-edit"><Icon name="paperclip" /> Alterar banner<input type="file" accept="image/gif,image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0], 'banner')} /></label>}</div>
    <div className="profile-avatar-wrap"><Avatar name={user.username} profile={{ ...initial, avatar: avatarRemoved ? undefined : initial.avatar }} serverUrl={serverUrl} large imageOverride={avatarPreview} />{own && <label className="avatar-edit" title="Alterar avatar"><Icon name="paperclip" /><input type="file" accept="image/gif,image/png,image/jpeg,image/webp" onChange={(event) => chooseImage(event.target.files?.[0], 'avatar')} /></label>}</div>
    <section className="profile-body"><h2>{user.username}</h2>{own ? <>
      <label className="profile-field">Descrição<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={190} placeholder="Conte algo sobre você…" /><small>{bio.length}/190</small></label>
      <label className="profile-color">Cor do perfil <input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
      <div className="profile-remove-row">{(avatarPreview || initial.avatar) && <button onClick={() => { setAvatarRemoved(true); setAvatarFile(null); setAvatarPreview(undefined); }}>Remover avatar</button>}{(bannerPreview || initial.banner) && <button onClick={() => { setBannerRemoved(true); setBannerFile(null); setBannerPreview(undefined); }}>Remover banner</button>}</div>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button profile-save" disabled={saving} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar perfil'}</button>
    </> : <p className="profile-bio">{initial.bio || 'Este usuário ainda não escreveu uma descrição.'}</p>}</section>
  </div></div>;
}

function SettingsModal({ devices, quality, setQuality, soundEnabled, setSoundEnabled, soundVolume, setSoundVolume: updateSoundVolume, onClose, onLogout }: { devices: ReturnType<typeof useDevices>; quality: StreamQuality; setQuality: (quality: StreamQuality) => void; soundEnabled: boolean; setSoundEnabled: (enabled: boolean) => void; soundVolume: number; setSoundVolume: (volume: number) => void; onClose: () => void; onLogout: () => void }) {
  function update<K extends keyof typeof devices.preferences>(key: K, value: (typeof devices.preferences)[K]): void {
    devices.setPreferences({ ...devices.preferences, [key]: value });
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-modal">
    <aside><h2>Configurações</h2><button className="selected">Voz e vídeo</button><button onClick={onLogout}>Sair da conta</button><span className="settings-version">Tumacord v{APP_VERSION}</span></aside>
    <section><button className="modal-close" onClick={onClose}><Icon name="close" /></button><h1>Voz e vídeo</h1><p className="settings-intro">O Tumacord processa a voz localmente em 48 kHz com cancelamento de eco, filtro neural GTCRN, corte de ruído grave e compressor de voz.</p>
      <DeviceSelect label="Dispositivo de entrada" value={devices.preferences.microphoneId} devices={devices.microphones} onChange={(value) => update('microphoneId', value)} />
      <DeviceSelect label="Dispositivo de saída" value={devices.preferences.speakerId} devices={devices.speakers} onChange={(value) => update('speakerId', value)} />
      <DeviceSelect label="Câmera" value={devices.preferences.cameraId} devices={devices.cameras} onChange={(value) => update('cameraId', value)} />
      <label className="sound-toggle"><input type="checkbox" checked={devices.preferences.noiseSuppression} onChange={(event) => update('noiseSuppression', event.target.checked)} /><span><strong>Supressão neural de ruído</strong><small>GTCRN em WebAssembly para reduzir teclado, ventilador e ruído ambiente sem enviar seu áudio para nenhum serviço.</small></span></label>
      <label className="setting-label">Qualidade da transmissão<select value={quality} onChange={(event) => setQuality(event.target.value as StreamQuality)}>{qualityOptions.map(([value, option]) => <option value={value} key={value}>{option.label}</option>)}</select></label>
      <label className="sound-toggle"><input type="checkbox" checked={soundEnabled} onChange={(event) => setSoundEnabled(event.target.checked)} /><span><strong>Sons de feedback</strong><small>Entrada, saída, mensagens, microfone e troca de host.</small></span></label>
      <label className="feedback-volume"><span>Volume dos feedbacks</span><input type="range" min="0.2" max="1" step="0.05" value={soundVolume} disabled={!soundEnabled} onChange={(event) => updateSoundVolume(Number(event.target.value))} onMouseUp={() => playSound('notification')} /><output>{Math.round(soundVolume * 100)}%</output></label>
      <div className="quality-note"><strong>Áudio da transmissão</strong><span>Ao marcar áudio, o Tumacord cria uma fonte estéreo temporária no PipeWire. Jogos, navegador e outros aplicativos entram na live; Tumacord, Discord e a voz da call são excluídos automaticamente, inclusive na tela inteira.</span></div>
    </section>
  </div></div>;
}

function DeviceSelect({ label, value, devices, onChange }: { label: string; value: string; devices: MediaDeviceInfo[]; onChange: (value: string) => void }) {
  return <label className="setting-label">{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Padrão do sistema</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${label} ${index + 1}`}</option>)}</select></label>;
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
