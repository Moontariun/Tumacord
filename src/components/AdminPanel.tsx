import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminOverview, Channel, ChannelCategory, ServerRole } from '../../shared/types';
import { Icon } from './Icon';
import { Dropdown } from './Dropdown';
import { describeMissing, readCapabilities, type ServerCapabilities } from '../lib/capabilities';

// Painel de administração do servidor.
//
// Ele é a interface de uma API que já valida tudo do lado do servidor. Nada
// aqui autoriza nada: esconder um botão é conveniência, não permissão — o
// mesmo pedido feito à mão continua sendo recusado.
//
// A organização em áreas existe porque um painel plano com trinta botões
// obriga a pessoa a procurar. Cada área responde uma pergunta: o que está
// acontecendo, como o servidor está arrumado, quem está nele, e o que foi
// feito.

type Area = 'overview' | 'channels' | 'users' | 'network' | 'logs';

interface AdminUser {
  id: string;
  username: string;
  role: ServerRole;
  createdAt: string;
  lastSeenAt?: string;
  online: boolean;
  sessions: number;
}

interface TurnState {
  urls: string[];
  secretConfigured: boolean;
  ttlSeconds: number;
  managedBy: 'painel' | 'ambiente' | 'nenhum';
}

interface AuditEntry {
  id: string;
  at: string;
  actorUsername: string;
  action: string;
  target?: string;
  result: 'ok' | 'denied' | 'error';
  detail?: string;
}

const AREAS: Array<{ id: Area; label: string }> = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'channels', label: 'Canais' },
  { id: 'users', label: 'Usuários' },
  { id: 'network', label: 'Rede / TURN' },
  { id: 'logs', label: 'Registro' },
];

const ROLE_LABEL: Record<ServerRole, string> = { owner: 'Dono', admin: 'Admin', member: 'Membro' };

const ACTION_LABEL: Record<string, string> = {
  'channel.create': 'criou o canal',
  'channel.update': 'editou o canal',
  'channel.delete': 'apagou o canal',
  'channel.reorder': 'reordenou os canais',
  'category.create': 'criou a categoria',
  'category.update': 'renomeou a categoria',
  'category.delete': 'apagou a categoria',
  'category.reorder': 'reordenou as categorias',
  'user.role': 'mudou o papel de',
  'user.remove': 'removeu',
};

function quando(iso: string): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function AdminPanel({ serverUrl, token, currentUserId, onClose, onNotice }: {
  serverUrl: string;
  token: string;
  currentUserId: string;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [area, setArea] = useState<Area>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [turn, setTurn] = useState<TurnState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [servidor, setServidor] = useState<ServerCapabilities | null>(null);
  const montado = useRef(true);

  useEffect(() => { montado.current = true; return () => { montado.current = false; }; }, []);

  // Um só caminho de chamada: com sessão, com erro estruturado e sem deixar a
  // tela mentir quando a resposta chega depois de fechar o painel.
  const chamar = useCallback(async <T,>(rota: string, metodo = 'GET', corpo?: unknown): Promise<T | null> => {
    try {
      const resposta = await fetch(`${serverUrl}${rota}`, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(corpo === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
      const corpoResposta = await resposta.json().catch(() => ({})) as { error?: string } & T;
      if (!resposta.ok) {
        if (montado.current) onNotice(corpoResposta.error ?? 'O servidor recusou a operação.');
        return null;
      }
      return corpoResposta;
    } catch {
      if (montado.current) onNotice('Não consegui falar com o servidor.');
      return null;
    }
  }, [onNotice, serverUrl, token]);

  const carregar = useCallback(async () => {
    if (montado.current) { setLoading(true); setError(''); }
    // Antes de qualquer coisa, o que este servidor sabe fazer. Um servidor
    // anterior à 0.8.1 não tem estes endpoints, e a pessoa precisa ler isso em
    // vez de receber um erro sem explicação a cada clique.
    const saude = await fetch(`${serverUrl}/api/health`).then((r) => r.json()).catch(() => null);
    const capacidades = readCapabilities(saude);
    if (montado.current) setServidor(capacidades);
    const faltando = describeMissing(capacidades, ['adminChannels', 'adminUsers', 'adminAudit']);
    if (faltando) {
      if (montado.current) { setError(faltando); setLoading(false); }
      return;
    }
    const geral = await chamar<AdminOverview & { channels: Channel[]; categories?: ChannelCategory[] }>('/api/admin/overview');
    if (!montado.current) return;
    if (!geral) { setError('Não foi possível carregar o painel.'); setLoading(false); return; }
    setOverview(geral);
    setChannels(geral.channels ?? []);
    setCategories(geral.categories ?? []);
    const lista = await chamar<{ users: AdminUser[] }>('/api/admin/users');
    if (montado.current && lista) setUsers(lista.users);
    const registro = await chamar<{ entries: AuditEntry[] }>('/api/admin/audit');
    if (montado.current && registro) setAudit(registro.entries);
    const rede = await chamar<{ turn: TurnState }>('/api/admin/settings');
    if (montado.current && rede) setTurn(rede.turn);
    if (montado.current) setLoading(false);
  }, [chamar, serverUrl]);

  useEffect(() => { void carregar(); }, [carregar]);

  const executar = async (chave: string, acao: () => Promise<unknown>, sucesso: string) => {
    setBusy(chave);
    const resultado = await acao();
    setBusy(null);
    if (resultado === null) return false;
    onNotice(sucesso);
    await carregar();
    return true;
  };

  return <div className="modal-backdrop" onMouseDown={(evento) => { if (evento.target === evento.currentTarget) onClose(); }}>
    <div className="settings-modal admin-panel">
      <aside>
        <h2>Servidor</h2>
        {AREAS.map((entrada) => <button key={entrada.id} className={area === entrada.id ? 'selected' : ''} onClick={() => setArea(entrada.id)}>{entrada.label}</button>)}
        <span className="settings-version">{overview ? `v${overview.version}` : servidor?.version ? `v${servidor.version}` : ''}</span>
      </aside>
      <section>
        <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
        <h1>{AREAS.find((entrada) => entrada.id === area)?.label}</h1>
        {loading && <p className="invite-status">Carregando…</p>}
        {error && !loading && <p className="invite-status error">{error} <button className="ghost" onClick={() => void carregar()}>Tentar de novo</button></p>}
        {!loading && !error && area === 'overview' && <Overview overview={overview} users={users} channels={channels} />}
        {!loading && !error && area === 'channels' && <Channels
          channels={channels} categories={categories} busy={busy}
          onCreateChannel={(corpo) => executar('canal', () => chamar('/api/admin/channels', 'POST', corpo), 'Canal criado.')}
          onRenameChannel={(id, name) => executar(id, () => chamar(`/api/admin/channels/${encodeURIComponent(id)}`, 'PATCH', { name }), 'Canal renomeado.')}
          onDeleteChannel={(id, nome) => executar(id, () => chamar(`/api/admin/channels/${encodeURIComponent(id)}`, 'DELETE'), `Canal ${nome} apagado.`)}
          onMoveChannel={(ids) => executar('ordem', () => chamar('/api/admin/channels/order', 'POST', { ids }), 'Ordem salva.')}
          onCreateCategory={(name) => executar('categoria', () => chamar('/api/admin/categories', 'POST', { name }), 'Categoria criada.')}
          onDeleteCategory={(id, nome) => executar(id, () => chamar(`/api/admin/categories/${encodeURIComponent(id)}`, 'DELETE'), `Categoria ${nome} apagada; os canais dela ficaram sem categoria.`)}
        />}
        {!loading && !error && area === 'users' && <Users
          users={users} currentUserId={currentUserId} busy={busy}
          onRole={(id, role, nome) => executar(id, () => chamar(`/api/admin/users/${encodeURIComponent(id)}/role`, 'POST', { role }), `${nome} agora é ${ROLE_LABEL[role].toLowerCase()}.`)}
          onRemove={(id, nome) => executar(id, () => chamar(`/api/admin/users/${encodeURIComponent(id)}`, 'DELETE'), `${nome} foi removido do servidor.`)}
          onDisconnect={(id, nome) => executar(id, () => chamar(`/api/admin/users/${encodeURIComponent(id)}/disconnect`, 'POST'), `${nome} foi desconectado.`)}
        />}
        {!loading && !error && area === 'network' && <Network
          turn={turn} busy={busy}
          onSave={(corpo) => executar('turn', () => chamar('/api/admin/settings', 'PATCH', corpo), 'Configuração do relay salva.')}
        />}
        {!loading && !error && area === 'logs' && <Logs entries={audit} />}
      </section>
    </div>
  </div>;
}

function Overview({ overview, users, channels }: { overview: AdminOverview | null; users: AdminUser[]; channels: Channel[] }) {
  if (!overview) return <p className="invite-status">Sem dados do servidor.</p>;
  const emVoz = Object.values(overview.voiceRooms ?? {}).flat().length;
  const horas = Math.floor((overview.uptimeSeconds ?? 0) / 3600);
  const minutos = Math.floor(((overview.uptimeSeconds ?? 0) % 3600) / 60);
  const cartoes: Array<[string, string]> = [
    ['Versão', overview.version],
    ['No ar há', horas ? `${horas} h ${minutos} min` : `${minutos} min`],
    ['Conectados', String(overview.onlineUsers?.length ?? 0)],
    ['Em call', String(emVoz)],
    ['Contas', String(users.length)],
    ['Canais', String(channels.length)],
    ['Chave de acesso', overview.security?.accessKeyRequired ? 'exigida' : 'não exigida'],
    ['HTTPS', overview.security?.tls ? 'ativo' : 'desligado'],
    ['Relay TURN', overview.turn ? 'disponível' : 'indisponível'],
    ['Mídia', overview.security?.media ?? 'DTLS-SRTP'],
  ];
  return <>
    <p className="settings-intro">Nenhum segredo aparece aqui — chaves e credenciais são mostradas apenas como configuradas ou não.</p>
    <ul className="admin-cards">
      {cartoes.map(([rotulo, valor]) => <li key={rotulo}><span>{rotulo}</span><strong>{valor}</strong></li>)}
    </ul>
  </>;
}

function Channels({ channels, categories, busy, onCreateChannel, onRenameChannel, onDeleteChannel, onMoveChannel, onCreateCategory, onDeleteCategory }: {
  channels: Channel[];
  categories: ChannelCategory[];
  busy: string | null;
  onCreateChannel: (corpo: { name: string; type: 'text' | 'voice'; categoryId?: string }) => Promise<boolean>;
  onRenameChannel: (id: string, name: string) => Promise<boolean>;
  onDeleteChannel: (id: string, nome: string) => Promise<boolean>;
  onMoveChannel: (ids: string[]) => Promise<boolean>;
  onCreateCategory: (name: string) => Promise<boolean>;
  onDeleteCategory: (id: string, nome: string) => Promise<boolean>;
}) {
  const [nome, setNome] = useState('');
  const [tipo, setTipo] = useState<'text' | 'voice'>('text');
  const [categoria, setCategoria] = useState('');
  const [nomeCategoria, setNomeCategoria] = useState('');
  const ordenados = [...channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const mover = (id: string, direcao: -1 | 1) => {
    const indice = ordenados.findIndex((canal) => canal.id === id);
    const destino = indice + direcao;
    if (indice < 0 || destino < 0 || destino >= ordenados.length) return;
    const proximo = [...ordenados];
    [proximo[indice], proximo[destino]] = [proximo[destino], proximo[indice]];
    void onMoveChannel(proximo.map((canal) => canal.id));
  };

  return <>
    <div className="admin-form">
      <input value={nome} onChange={(evento) => setNome(evento.target.value)} placeholder="Nome do canal" maxLength={32} />
      <Dropdown label="Tipo" value={tipo} options={[{ value: 'text', label: 'Texto' }, { value: 'voice', label: 'Voz' }]} onChange={(valor) => setTipo(valor as 'text' | 'voice')} />
      <Dropdown label="Categoria" value={categoria} options={[{ value: '', label: 'Sem categoria' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} onChange={setCategoria} />
      <button className="primary-button" disabled={!nome.trim() || busy === 'canal'} onClick={() => { void onCreateChannel({ name: nome, type: tipo, ...(categoria ? { categoryId: categoria } : {}) }).then((ok) => { if (ok) setNome(''); }); }}>
        {busy === 'canal' ? 'Criando…' : 'Criar canal'}
      </button>
    </div>
    <div className="admin-form">
      <input value={nomeCategoria} onChange={(evento) => setNomeCategoria(evento.target.value)} placeholder="Nome da categoria" maxLength={32} />
      <button disabled={!nomeCategoria.trim() || busy === 'categoria'} onClick={() => { void onCreateCategory(nomeCategoria).then((ok) => { if (ok) setNomeCategoria(''); }); }}>
        {busy === 'categoria' ? 'Criando…' : 'Criar categoria'}
      </button>
    </div>

    {categories.length > 0 && <ul className="admin-list admin-category-list">
      {categories.map((cat) => <li key={cat.id}>
        <strong>{cat.name}</strong>
        <button className="danger" disabled={busy === cat.id} onClick={() => { if (window.confirm(`Apagar a categoria ${cat.name}? Os canais dela ficam sem categoria — nenhum canal é apagado.`)) void onDeleteCategory(cat.id, cat.name); }}>Apagar</button>
      </li>)}
    </ul>}

    <ul className="admin-list admin-channel-list">
      {ordenados.map((canal, indice) => <li key={canal.id}>
        <Icon name={canal.type === 'voice' ? 'voice' : 'hash'} />
        <div>
          <strong>{canal.name}</strong>
          <small>{canal.type === 'voice' ? 'voz' : 'texto'}{canal.categoryId ? ` · ${categories.find((c) => c.id === canal.categoryId)?.name ?? 'categoria removida'}` : ''}{canal.topic ? ` · ${canal.topic}` : ''}</small>
        </div>
        <div className="admin-row-actions">
          <button disabled={indice === 0 || busy === 'ordem'} title="Subir" onClick={() => mover(canal.id, -1)}>↑</button>
          <button disabled={indice === ordenados.length - 1 || busy === 'ordem'} title="Descer" onClick={() => mover(canal.id, 1)}>↓</button>
          <button disabled={busy === canal.id} onClick={() => { const novo = window.prompt('Novo nome do canal', canal.name); if (novo && novo !== canal.name) void onRenameChannel(canal.id, novo); }}>Renomear</button>
          <button className="danger" disabled={busy === canal.id} onClick={() => { if (window.confirm(`Apagar o canal ${canal.name}? As mensagens dele vão junto e isso não tem volta.`)) void onDeleteChannel(canal.id, canal.name); }}>Apagar</button>
        </div>
      </li>)}
      {!ordenados.length && <p className="invite-status">Nenhum canal ainda.</p>}
    </ul>
  </>;
}

function Users({ users, currentUserId, busy, onRole, onRemove, onDisconnect }: {
  users: AdminUser[];
  currentUserId: string;
  busy: string | null;
  onRole: (id: string, role: ServerRole, nome: string) => Promise<boolean>;
  onRemove: (id: string, nome: string) => Promise<boolean>;
  onDisconnect: (id: string, nome: string) => Promise<boolean>;
}) {
  const donos = users.filter((usuario) => usuario.role === 'owner').length;
  return <>
    <p className="settings-intro">O servidor recusa qualquer ação que o deixaria sem dono, mesmo que o botão pareça disponível.</p>
    <ul className="admin-list admin-user-list">
      {users.map((usuario) => <li key={usuario.id}>
        <div>
          <strong>{usuario.username}{usuario.id === currentUserId && <em>você</em>}</strong>
          <small>
            {ROLE_LABEL[usuario.role]} · {usuario.online ? 'online' : 'offline'} · {usuario.sessions} {usuario.sessions === 1 ? 'sessão' : 'sessões'}
            {usuario.lastSeenAt ? ` · visto ${quando(usuario.lastSeenAt)}` : ''} · desde {quando(usuario.createdAt)}
          </small>
        </div>
        <div className="admin-row-actions">
          <Dropdown
            label="Papel"
            value={usuario.role}
            options={[{ value: 'owner', label: 'Dono' }, { value: 'admin', label: 'Admin' }, { value: 'member', label: 'Membro' }]}
            onChange={(valor) => {
              const proximo = valor as ServerRole;
              if (proximo === usuario.role) return;
              if (usuario.role === 'owner' && donos <= 1) return;
              if (proximo === 'owner' && !window.confirm(`Tornar ${usuario.username} dono do servidor? Donos podem promover e remover qualquer pessoa.`)) return;
              void onRole(usuario.id, proximo, usuario.username);
            }}
          />
          {usuario.online && <button disabled={busy === usuario.id} onClick={() => { if (window.confirm(`Desconectar ${usuario.username} agora?`)) void onDisconnect(usuario.id, usuario.username); }}>Desconectar</button>}
          {usuario.id !== currentUserId && <button className="danger" disabled={busy === usuario.id} onClick={() => { if (window.confirm(`Remover a conta de ${usuario.username}? As sessões dela morrem junto e isso não tem volta.`)) void onRemove(usuario.id, usuario.username); }}>Remover</button>}
        </div>
      </li>)}
      {!users.length && <p className="invite-status">Nenhuma conta neste servidor.</p>}
    </ul>
  </>;
}

function Network({ turn, busy, onSave }: {
  turn: TurnState | null;
  busy: string | null;
  onSave: (corpo: { turnUrls?: string[]; turnSecret?: string; turnTtlSeconds?: number }) => Promise<boolean>;
}) {
  const [urls, setUrls] = useState(turn?.urls.join('\n') ?? '');
  const [segredo, setSegredo] = useState('');
  const [validade, setValidade] = useState(String(turn?.ttlSeconds ?? 28800));
  const origem = turn?.managedBy === 'painel' ? 'definido aqui no painel'
    : turn?.managedBy === 'ambiente' ? 'vindo do arquivo .env do servidor'
    : 'não configurado';

  return <>
    <p className="settings-intro">
      O relay TURN é a reserva para quando nenhum caminho direto se forma — os dois lados atrás de CGNAT simétrico, sem IPv6.
      O que você salvar aqui passa a valer <strong>sem reiniciar o servidor</strong> e tem precedência sobre o `.env`.
    </p>
    <ul className="admin-cards">
      <li><span>Estado</span><strong>{turn?.urls.length && turn.secretConfigured ? 'ativo' : 'inativo'}</strong></li>
      <li><span>Origem</span><strong>{origem}</strong></li>
      <li><span>Segredo</span><strong>{turn?.secretConfigured ? '•••••••• configurado' : 'ausente'}</strong></li>
      <li><span>Validade</span><strong>{Math.round((turn?.ttlSeconds ?? 0) / 3600)} h</strong></li>
    </ul>

    <div className="setting-label">
      <span className="setting-title">Endereços do relay<small>Um por linha, começando com `turn:` ou `turns:`.</small></span>
      <textarea className="invite-code" rows={3} value={urls} spellCheck={false} placeholder="turn:turn.seudominio.com:3478" onChange={(evento) => setUrls(evento.target.value)} />
    </div>
    <div className="setting-label">
      <span className="setting-title">Segredo compartilhado<small>O mesmo valor do coturn. Ele nunca é devolvido por aqui — deixe em branco para manter o atual.</small></span>
      <input type="password" autoComplete="new-password" value={segredo} placeholder={turn?.secretConfigured ? '•••••••• (mantém o atual)' : 'pelo menos 12 caracteres'} onChange={(evento) => setSegredo(evento.target.value)} />
    </div>
    <div className="setting-label">
      <span className="setting-title">Validade das credenciais<small>Em segundos, entre 300 e 86400.</small></span>
      <input value={validade} inputMode="numeric" onChange={(evento) => setValidade(evento.target.value)} />
    </div>

    <button className="primary-button" disabled={busy === 'turn'} onClick={() => {
      const corpo: { turnUrls?: string[]; turnSecret?: string; turnTtlSeconds?: number } = {
        turnUrls: urls.split('\n').map((linha) => linha.trim()).filter(Boolean),
        turnTtlSeconds: Number(validade),
      };
      // Segredo em branco significa "não mexa", e não "apague".
      if (segredo.trim()) corpo.turnSecret = segredo.trim();
      void onSave(corpo).then((ok) => { if (ok) setSegredo(''); });
    }}>{busy === 'turn' ? 'Salvando…' : 'Salvar configuração do relay'}</button>

    <div className="quality-note">
      <strong>O relay ainda precisa existir</strong>
      <span>Isto diz ao aplicativo onde encontrar o relay e como se autenticar. O coturn em si sobe na máquina com `docker compose --profile turn up -d`, e o segredo aqui precisa ser o mesmo que ele usa. Libere `3478/udp`, `3478/tcp` e a faixa `49160-49200/udp` no firewall.</span>
    </div>
  </>;
}

function Logs({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <p className="invite-status">Nenhuma ação administrativa registrada ainda.</p>;
  return <>
    <p className="settings-intro">As ações recusadas também ficam registradas — são elas que explicam por que algo não funcionou.</p>
    <ul className="admin-list admin-audit-list">
      {entries.map((entrada) => <li key={entrada.id} className={entrada.result === 'denied' ? 'denied' : ''}>
        <span className="admin-audit-when">{quando(entrada.at)}</span>
        <div>
          <strong>{entrada.actorUsername} {ACTION_LABEL[entrada.action] ?? entrada.action}{entrada.target ? ` ${entrada.target}` : ''}</strong>
          {entrada.detail && <small>{entrada.detail}</small>}
        </div>
        {entrada.result === 'denied' && <em>recusado</em>}
      </li>)}
    </ul>
  </>;
}
