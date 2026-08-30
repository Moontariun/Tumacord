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
}

export function defaultServerUrl(): string {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return window.location.origin;
  return localStorage.getItem(SERVER_KEY) ?? 'http://127.0.0.1:3927';
}

export function loadSession(): SavedSession | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as SavedSession | null;
  } catch {
    return null;
  }
}

export function saveSession(session: SavedSession): void {
  const { password: _password, resumeChannelId: _resumeChannelId, ...safeSession } = session;
  localStorage.setItem(SESSION_KEY, JSON.stringify(safeSession));
  localStorage.setItem(SERVER_KEY, session.serverUrl);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

async function authenticate(path: 'login' | 'register', serverUrl: string, username: string, password: string, resumeChannelId?: string, allowCreate = false, connectionMode: 'p2p' | 'server' = 'p2p'): Promise<SavedSession> {
  const normalizedUrl = serverUrl.trim().replace(/\/$/, '');
  const response = await fetch(`${normalizedUrl}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, ...(allowCreate ? { allowCreate: true } : {}) }),
  });
  const body = await response.json() as SessionResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Não foi possível entrar.');
  const saved = { serverUrl: normalizedUrl, token: body.token, user: body.user, serverName: body.serverName, password, resumeChannelId, connectionMode };
  saveSession(saved);
  return saved;
}

export function login(serverUrl: string, username: string, password: string, resumeChannelId?: string, allowCreate = false, connectionMode: 'p2p' | 'server' = 'p2p'): Promise<SavedSession> {
  return authenticate('login', serverUrl, username, password, resumeChannelId, allowCreate, connectionMode);
}

export function register(serverUrl: string, username: string, password: string, resumeChannelId?: string, connectionMode: 'p2p' | 'server' = 'p2p'): Promise<SavedSession> {
  return authenticate('register', serverUrl, username, password, resumeChannelId, false, connectionMode);
}
