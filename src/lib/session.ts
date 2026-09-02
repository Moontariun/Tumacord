import type { SessionResponse } from '../../shared/types';

const SESSION_KEY = 'tumacord.session';
const SERVER_KEY = 'tumacord.server';

export interface SavedSession {
  serverUrl: string;
  token: string;
  user: SessionResponse['user'];
  serverName: string;
  password?: string;
  resumeChannelId?: string;
  connectionMode?: 'p2p' | 'server';
  rememberMe?: boolean;
}

export function defaultServerUrl(): string {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return window.location.origin;
  return localStorage.getItem(SERVER_KEY) ?? 'http://127.0.0.1:3927';
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) ?? sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedSession;
    return { ...saved, rememberMe: saved.rememberMe ?? Boolean(localStorage.getItem(SESSION_KEY)) };
  } catch {
    return null;
  }
}

export function saveSession(session: SavedSession): void {
  const persistent = session.rememberMe ?? true;
  const target = persistent ? localStorage : sessionStorage;
  const other = persistent ? sessionStorage : localStorage;
  target.setItem(SESSION_KEY, JSON.stringify({ ...session, rememberMe: persistent }));
  other.removeItem(SESSION_KEY);
  localStorage.setItem(SERVER_KEY, session.serverUrl);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

async function authenticate(path: 'login' | 'register', serverUrl: string, username: string, password: string, resumeChannelId?: string, allowCreate = false, connectionMode: 'p2p' | 'server' = 'p2p', rememberMe = true, serverKey = ''): Promise<SavedSession> {
  const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
  const response = await fetch(`${normalizedUrl}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, ...(allowCreate ? { allowCreate: true } : {}), ...(serverKey.trim() ? { serverKey: serverKey.trim() } : {}) }),
  });
  const body = await response.json() as SessionResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Não foi possível entrar.');
  // A senha só precisa acompanhar a sessão no modo dinâmico: ela permite
  // autenticar automaticamente no novo host durante a troca P2P. No servidor
  // dedicado o token persistente é suficiente, então não guardamos a senha.
  const saved = { serverUrl: normalizedUrl, token: body.token, user: body.user, serverName: body.serverName, password: connectionMode === 'p2p' ? password : undefined, resumeChannelId, connectionMode, rememberMe };
  saveSession(saved);
  return saved;
}

export function login(serverUrl: string, username: string, password: string, resumeChannelId?: string, allowCreate = false, connectionMode: 'p2p' | 'server' = 'p2p', rememberMe = true, serverKey = ''): Promise<SavedSession> {
  return authenticate('login', serverUrl, username, password, resumeChannelId, allowCreate, connectionMode, rememberMe, serverKey);
}

export function register(serverUrl: string, username: string, password: string, resumeChannelId?: string, connectionMode: 'p2p' | 'server' = 'p2p', rememberMe = true, serverKey = ''): Promise<SavedSession> {
  return authenticate('register', serverUrl, username, password, resumeChannelId, false, connectionMode, rememberMe, serverKey);
}
