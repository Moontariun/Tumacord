import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminOverview, Channel, ChannelCategory, ServerRole } from '../../shared/types';
import { Icon } from './Icon';
import { Dropdown } from './Dropdown';
import { defaultChoice } from '../../shared/serverUpdate';
import { describeMissing, mergeCapabilities, readCapabilities, UNKNOWN_CAPABILITIES, type ServerCapabilities } from '../lib/capabilities';
import { beginLoad, failLoad, isBusy, settle, untracked, type Tracked } from '../lib/freshness';
import { ChannelSettingsModal } from './ChannelSettings';

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
//
// O painel inteiro carrega de uma vez só, em uma leitura numerada. Toda ação
// administrativa recarrega, e antes disso a recarga apagava a tela: `loading`
// virava verdadeiro, as listas sumiam e voltavam. Com a máquina ocupada, duas
// recargas podiam se cruzar e a mais velha, chegando por último, sobrescrevia
// a mais nova. Agora o valor anterior fica em tela enquanto a leitura corre,
// e uma resposta de geração antiga é descartada em silêncio.

type Area = 'overview' | 'channels' | 'users' | 'version' | 'logs';

// Um pedido que nunca responde deixaria o painel em "carregando" para sempre.
// Doze segundos é folgado para uma rede ruim e curto para quem está esperando.
const REQUEST_TIMEOUT_MS = 12_000;

interface AdminUser {
  id: string;
  username: string;
  role: ServerRole;
  createdAt: string;
  lastSeenAt?: string;
  online: boolean;
  sessions: number;
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

interface PainelDados {
  overview: AdminOverview | null;
  channels: Channel[];
  categories: ChannelCategory[];
  users: AdminUser[];
  audit: AuditEntry[];
}

/** Uma versão publicada, como o servidor a oferece. */
interface VersaoOferecida {
  releaseId: string;
  tag: string;
  version: string;
  publishedAt: string;
  /** O canal de onde ela veio: campo explícito, e não sufixo da versão. */
  channel: string;
  /** O motivo de não dever ser instalada, quando há um. */
  broken: string;
  /** O aviso de parada obrigatória que a release declara, quando declara. */
  requiredStop: string;
  current: boolean;
  newer: boolean;
}

interface EstadoDaAtualizacao {
  status: 'idle' | 'running' | 'done' | 'error';
  tag: string;
  startedAt: string;
  finishedAt: string;
  log: string;
  jobId: string;
}

interface PainelDeVersao {
  enabled: boolean;
  reason: string;
  current: string;
  releases: VersaoOferecida[];
  state: EstadoDaAtualizacao;
  error?: string;
}

type Resultado<T> = { ok: true; body: T } | { ok: false; error: string };

const AREAS: Array<{ id: Area; label: string }> = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'channels', label: 'Canais' },
  { id: 'users', label: 'Usuários' },
  { id: 'version', label: 'Versão' },
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
  'server.update': 'pediu a atualização do servidor para',
  'user.role': 'mudou o papel de',
  'user.remove': 'removeu',
  'voice.disconnect': 'desconectou da call',
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
  const [dados, setDados] = useState<Tracked<PainelDados>>(() => untracked<PainelDados>());
  const [busy, setBusy] = useState<string | null>(null);
  const [editando, setEditando] = useState<Channel | null>(null);
  const [servidor, setServidor] = useState<ServerCapabilities>(UNKNOWN_CAPABILITIES);
  const montado = useRef(true);
  const geracao = useRef(0);

  useEffect(() => { montado.current = true; return () => { montado.current = false; }; }, []);

  // Um só caminho de chamada: com sessão, com prazo, com erro estruturado e
  // sabendo distinguir "o servidor recusou" de "não consegui falar com ele".
  // A diferença importa: a primeira é uma resposta, a segunda é a ausência de
  // uma — e ausência não pode virar conclusão sobre o servidor.
  const pedir = useCallback(async <T,>(rota: string, metodo = 'GET', corpo?: unknown): Promise<Resultado<T>> => {
    const controller = new AbortController();
    const prazo = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resposta = await fetch(`${serverUrl}${rota}`, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(corpo === undefined ? {} : { 'content-type': 'application/json' }) },
        signal: controller.signal,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
      const corpoResposta = await resposta.json().catch(() => ({})) as { error?: string } & T;
      if (!resposta.ok) {
        return { ok: false, error: corpoResposta.error ?? 'O servidor recusou a operação.' };
      }
      return { ok: true, body: corpoResposta };
    } catch {
      return { ok: false, error: 'Não consegui falar com o servidor agora.' };
    } finally {
      window.clearTimeout(prazo);
    }
  }, [serverUrl, token]);

  // As ações administrativas continuam com a forma antiga — `null` é recusa —
  // porque quem chama só precisa saber se deu certo.
  const chamar = useCallback(async <T,>(rota: string, metodo = 'GET', corpo?: unknown): Promise<T | null> => {
    const resultado = await pedir<T>(rota, metodo, corpo);
    if (resultado.ok) return resultado.body;
    if (montado.current) onNotice(resultado.error);
    return null;
  }, [onNotice, pedir]);

  // O que o servidor sabe fazer é lido dentro de uma função assíncrona; sem o
  // espelho, `carregar` capturaria o valor da renderização em que nasceu.
  const servidorRef = useRef<ServerCapabilities>(servidor);
  servidorRef.current = servidor;

  const carregar = useCallback(async () => {
    const pedido = ++geracao.current;
    const atual = () => montado.current && pedido === geracao.current;
    setDados((estado) => beginLoad(estado, pedido));
    // Antes de qualquer coisa, o que este servidor sabe fazer. Um servidor
    // anterior à 0.8.1 não tem estes endpoints, e a pessoa precisa ler isso em
    // vez de receber um erro sem explicação a cada clique. Mas só uma resposta
    // de verdade conta: uma consulta que falhou mantém o que já se sabia.
    const saude = await pedir<unknown>('/api/health');
    if (!atual()) return;
    const capacidades = mergeCapabilities(servidorRef.current, saude.ok ? readCapabilities(saude.body) : UNKNOWN_CAPABILITIES);
    servidorRef.current = capacidades;
    setServidor(capacidades);
    const faltando = describeMissing(capacidades, ['adminChannels', 'adminUsers', 'adminAudit']);
    if (faltando) {
      setDados((estado) => failLoad(estado, pedido, faltando));
      return;
    }
    const geral = await pedir<AdminOverview & { channels: Channel[]; categories?: ChannelCategory[] }>('/api/admin/overview');
    if (!atual()) return;
    if (!geral.ok) {
      setDados((estado) => failLoad(estado, pedido, geral.error));
      return;
    }
    const lista = await pedir<{ users: AdminUser[] }>('/api/admin/users');
    if (!atual()) return;
    const registro = await pedir<{ entries: AuditEntry[] }>('/api/admin/audit');
    if (!atual()) return;
    setDados((estado) => settle(estado, pedido, {
      overview: geral.body,
      channels: geral.body.channels ?? [],
      categories: geral.body.categories ?? [],
      // Uma das duas listas pode ter falhado sozinha. Manter a anterior é
      // melhor do que mostrar uma lista vazia que não corresponde a nada.
      users: lista.ok ? lista.body.users : estado.value?.users ?? [],
      audit: registro.ok ? registro.body.entries : estado.value?.audit ?? [],
    }));
  }, [pedir]);

  useEffect(() => { void carregar(); }, [carregar]);

  const executar = async (chave: string, acao: () => Promise<unknown>, sucesso: string) => {
    setBusy(chave);
    const resultado = await acao();
    if (montado.current) setBusy(null);
    if (resultado === null) return false;
    if (montado.current) onNotice(sucesso);
    await carregar();
    return true;
  };

  const dadosVisiveis = dados.value;
  const carregando = dadosVisiveis === null && dados.status !== 'failed';
  // A mensagem só substitui a tela quando não há nada a mostrar. Com dados em
  // mãos ela vira um aviso discreto, e os controles continuam onde estavam.
  const aviso = dados.status === 'failed' || dados.status === 'stale' ? dados.error : '';
  const overview = dadosVisiveis?.overview ?? null;
  const channels = dadosVisiveis?.channels ?? [];
  const categories = dadosVisiveis?.categories ?? [];
  const users = dadosVisiveis?.users ?? [];
  const audit = dadosVisiveis?.audit ?? [];

  return <div className="modal-backdrop" onMouseDown={(evento) => { if (evento.target === evento.currentTarget) onClose(); }}>
    <div className="settings-modal admin-panel">
      <aside>
        <h2>Servidor</h2>
        {AREAS.map((entrada) => <button key={entrada.id} className={area === entrada.id ? 'selected' : ''} onClick={() => setArea(entrada.id)}>{entrada.label}</button>)}
        <span className="settings-version">{overview ? `v${overview.version}` : servidor.version ? `v${servidor.version}` : ''}</span>
      </aside>
      <section>
        <button className="modal-close" onClick={onClose}><Icon name="close" /></button>
        <h1>{AREAS.find((entrada) => entrada.id === area)?.label}</h1>
        {carregando && <p className="invite-status">Carregando…</p>}
        {aviso && <p className="invite-status error">{aviso} <button className="ghost" disabled={isBusy(dados)} onClick={() => void carregar()}>Tentar de novo</button></p>}
        {dadosVisiveis && <>
          {area === 'overview' && <Overview overview={overview} users={users} channels={channels} />}
          {area === 'channels' && <Channels
            channels={channels} categories={categories} busy={busy}
            onCreateChannel={(corpo) => executar('canal', () => chamar('/api/admin/channels', 'POST', corpo), 'Canal criado.')}
            onRenameChannel={(id, name) => executar(id, () => chamar(`/api/admin/channels/${encodeURIComponent(id)}`, 'PATCH', { name }), 'Canal renomeado.')}
            onDeleteChannel={(id, nome) => executar(id, () => chamar(`/api/admin/channels/${encodeURIComponent(id)}`, 'DELETE'), `Canal ${nome} apagado.`)}
            onEditChannel={setEditando}
            onMoveChannel={(ids) => executar('ordem', () => chamar('/api/admin/channels/order', 'POST', { ids }), 'Ordem salva.')}
            onCreateCategory={(name) => executar('categoria', () => chamar('/api/admin/categories', 'POST', { name }), 'Categoria criada.')}
            onDeleteCategory={(id, nome) => executar(id, () => chamar(`/api/admin/categories/${encodeURIComponent(id)}`, 'DELETE'), `Categoria ${nome} apagada; os canais dela ficaram sem categoria.`)}
          />}
          {area === 'users' && <Users
            users={users} currentUserId={currentUserId} busy={busy}
            onRole={(id, role, nome) => executar(id, () => chamar(`/api/admin/users/${encodeURIComponent(id)}/role`, 'POST', { role }), `${nome} agora é ${ROLE_LABEL[role].toLowerCase()}.`)}
            onRemove={(id, nome) => executar(id, () => chamar(`/api/admin/users/${encodeURIComponent(id)}`, 'DELETE'), `${nome} foi removido do servidor.`)}
            onDisconnect={(id, nome) => executar(id, () => chamar(`/api/admin/users/${encodeURIComponent(id)}/disconnect`, 'POST'), `${nome} foi desconectado.`)}
          />}
          {area === 'version' && <Versao pedir={pedir} onNotice={onNotice} />}
          {area === 'logs' && <Logs entries={audit} />}
        </>}
      </section>
    </div>
    {editando && <ChannelSettingsModal channel={editando} serverUrl={serverUrl} token={token} onClose={() => setEditando(null)} onNotice={onNotice} onSaved={() => void carregar()} />}
  </div>;
}

/**
 * A versão que este servidor roda, e para qual ele pode ir.
 *
 * A lista vem do próprio servidor, que a busca no GitHub — o mesmo lugar de
 * onde o aplicativo tira a atualização dele. O navegador não escolhe de onde
 * ela vem nem manda nada além da etiqueta escolhida; quem confere se aquela
 * etiqueta pode ser aplicada é o servidor, e ele confere de novo na hora.
 */
function Versao({ pedir, onNotice }: { pedir: <T,>(rota: string, metodo?: string, corpo?: unknown) => Promise<Resultado<T>>; onNotice: (message: string) => void }) {
  const [painel, setPainel] = useState<PainelDeVersao | null>(null);
  const [erro, setErro] = useState('');
  const [escolhida, setEscolhida] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(async () => {
    const resultado = await pedir<PainelDeVersao>('/api/admin/update');
    if (!resultado.ok) return setErro(resultado.error);
    setErro('');
    setPainel(resultado.body);
    setEscolhida((atual) => atual || defaultChoice(resultado.body.releases));
  }, [pedir]);

  useEffect(() => { void carregar(); }, [carregar]);

  // Enquanto o executor aplica, este servidor reinicia no meio: a leitura vai falhar
  // e voltar sozinha. Continuar perguntando é o que mostra o fim.
  const rodando = painel?.state.status === 'running';
  useEffect(() => {
    if (!rodando) return;
    const timer = window.setInterval(() => { void carregar(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [carregar, rodando]);

  const aplicar = async () => {
    setEnviando(true);
    const resultado = await pedir<{ ok: boolean }>('/api/admin/update', 'POST', { tag: escolhida });
    setEnviando(false);
    setConfirmando(false);
    if (!resultado.ok) return onNotice(resultado.error);
    onNotice(`Atualização para ${escolhida} pedida. O servidor vai reiniciar.`);
    void carregar();
  };

  if (erro) return <p className="invite-status error">{erro} <button className="ghost" onClick={() => void carregar()}>Tentar de novo</button></p>;
  if (!painel) return <p className="invite-status">Consultando as versões publicadas…</p>;

  const alvo = painel.releases.find((entrada) => entrada.tag === escolhida);
  return <>
    <p className="settings-intro">Este servidor está na <strong>v{painel.current}</strong>. As versões vêm do catálogo assinado do serviço de atualizações desta instalação, e quem aplica é o executor no host.</p>

    {!painel.enabled
      ? <p className="invite-status">{painel.reason}</p>
      : <>
        {painel.error && <p className="invite-status error">{painel.error} <button className="ghost" onClick={() => void carregar()}>Tentar de novo</button></p>}
        <div className="setting-label">
          <span className="setting-title">Versão</span>
          <Dropdown
            label="Versão"
            value={escolhida}
            options={painel.releases.map((entrada) => ({
              value: entrada.tag,
              label: `${entrada.tag}${entrada.current ? ' · em uso' : entrada.newer ? '' : ' · anterior'}${entrada.broken ? ' · retirada' : ''}${entrada.channel === 'test' ? ' · teste' : ''}`,
            }))}
            onChange={setEscolhida}
          />
        </div>
        {alvo?.broken && <p className="invite-status error">A {alvo.tag} está marcada como retirada: {alvo.broken}. O servidor recusa aplicá-la.</p>}
        {alvo?.current && <p className="invite-status">Esta é a versão que já está rodando.</p>}
        {alvo && !alvo.current && !alvo.newer && !alvo.broken && <p className="invite-status">A {alvo.tag} é anterior à que está rodando. Voltar é possível, e é o caminho quando algo quebrou.</p>}
        {alvo?.requiredStop && !alvo.current && <p className="invite-status">{alvo.requiredStop}</p>}

        <div className="update-actions">
          <button
            className="primary-button"
            disabled={enviando || rodando || !alvo || Boolean(alvo.broken) || alvo.current}
            onClick={() => setConfirmando(true)}
            title="Copia os dados, aplica a versão escolhida e reinicia o servidor"
          >{rodando ? 'Atualizando…' : 'Atualizar servidor'}</button>
        </div>

        {painel.state.status !== 'idle' && <p className={`invite-status ${painel.state.status === 'error' ? 'error' : ''}`}>
          <strong>{painel.state.status === 'running' ? `Aplicando ${painel.state.tag}…` : painel.state.status === 'done' ? `A ${painel.state.tag} foi aplicada.` : `A ${painel.state.tag} falhou.`}</strong>
          {painel.state.log && <><br />{painel.state.log.split('\n').slice(-6).join(' · ')}</>}
        </p>}
      </>}

    {confirmando && alvo && <div className="modal-backdrop" onMouseDown={(evento) => { if (evento.target === evento.currentTarget) setConfirmando(false); }}><div className="confirm-dialog" role="alertdialog" aria-modal="true">
      <h2>Atualizar para {alvo.tag}?</h2>
      <p>O executor copia os dados, troca o código e reinicia o servidor. Quem estiver em uma call cai durante o reinício. Se a cópia falhar, nada é aplicado.</p>
      <div className="confirm-actions">
        <button type="button" autoFocus onClick={() => setConfirmando(false)}>Cancelar</button>
        <button type="button" className="danger" disabled={enviando} onClick={() => void aplicar()}>{enviando ? 'Pedindo…' : 'Atualizar'}</button>
      </div>
    </div></div>}
  </>;
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

function Channels({ channels, categories, busy, onCreateChannel, onRenameChannel, onDeleteChannel, onEditChannel, onMoveChannel, onCreateCategory, onDeleteCategory }: {
  channels: Channel[];
  categories: ChannelCategory[];
  busy: string | null;
  onCreateChannel: (corpo: { name: string; type: 'text' | 'voice'; categoryId?: string }) => Promise<boolean>;
  onRenameChannel: (id: string, name: string) => Promise<boolean>;
  onDeleteChannel: (id: string, nome: string) => Promise<boolean>;
  onEditChannel: (canal: Channel) => void;
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
          <small>{canal.type === 'voice' ? 'voz' : 'texto'}{canal.categoryId ? ` · ${categories.find((c) => c.id === canal.categoryId)?.name ?? 'categoria removida'}` : ''}{canal.topic ? ` · ${canal.topic}` : ''}{canal.permissions ? ' · com regras de acesso' : ''}</small>
        </div>
        <div className="admin-row-actions">
          <button disabled={indice === 0 || busy === 'ordem'} title="Subir" onClick={() => mover(canal.id, -1)}>↑</button>
          <button disabled={indice === ordenados.length - 1 || busy === 'ordem'} title="Descer" onClick={() => mover(canal.id, 1)}>↓</button>
          <button disabled={busy === canal.id} onClick={() => onEditChannel(canal)} title="Nome, tópico, limite e quem pode ver, escrever, entrar, falar e transmitir">Permissões</button>
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
