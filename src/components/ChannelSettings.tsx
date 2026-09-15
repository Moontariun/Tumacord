import { useEffect, useMemo, useState } from 'react';
import type { Channel, ChannelAccess, ChannelPermissionKey, ChannelPermissions, ServerRole } from '../../shared/types';
import { PERMISSIONS_BY_TYPE, PERMISSION_LABEL, resolveAccess } from '../../shared/channelPermissions';
import { Icon } from './Icon';

// Editar um canal: o que ele é e quem pode fazer o quê nele.
//
// A tela é conveniência da administração. Quem aplica cada regra é o servidor,
// ao entregar o canal, a mensagem e a entrada na call — um membro que chame o
// socket direto passa pela mesma conferência.
//
// Cada célula tem três estados, como no Discord: herdar (o traço), permitir e
// negar. "Herdar" numa pessoa segue a linha de Todos; "herdar" em Todos é
// "pode". É o que deixa fazer um canal fechado com duas pessoas dentro: nega
// "Ver" em Todos e permite nas duas.

interface AdminUser {
  id: string;
  username: string;
  role: ServerRole;
}

type Tri = boolean | undefined;

function next(value: Tri): Tri {
  if (value === undefined) return true;
  if (value === true) return false;
  return undefined;
}

function clonePermissions(permissions: ChannelPermissions | undefined): ChannelPermissions {
  return {
    everyone: { ...(permissions?.everyone ?? {}) },
    users: Object.fromEntries(Object.entries(permissions?.users ?? {}).map(([id, regra]) => [id, { ...regra }])),
  };
}

function compact(permissions: ChannelPermissions): ChannelPermissions | null {
  const everyone = Object.fromEntries(Object.entries(permissions.everyone ?? {}).filter(([, valor]) => typeof valor === 'boolean'));
  const users = Object.fromEntries(Object.entries(permissions.users ?? {})
    .map(([id, regra]) => [id, Object.fromEntries(Object.entries(regra).filter(([, valor]) => typeof valor === 'boolean'))] as const)
    .filter(([, regra]) => Object.keys(regra).length));
  if (!Object.keys(everyone).length && !Object.keys(users).length) return null;
  return { ...(Object.keys(everyone).length ? { everyone } : {}), ...(Object.keys(users).length ? { users } : {}) };
}

export function ChannelSettingsModal({ channel, serverUrl, token, onClose, onNotice, onSaved }: {
  channel: Channel;
  serverUrl: string;
  token: string;
  onClose: () => void;
  onNotice: (message: string) => void;
  onSaved?: () => void;
}) {
  const [tab, setTab] = useState<'geral' | 'permissoes'>('geral');
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [limit, setLimit] = useState(String(channel.userLimit ?? 0));
  const [rules, setRules] = useState<ChannelPermissions>(() => clonePermissions(channel.permissions));
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const keys = PERMISSIONS_BY_TYPE[channel.type];

  useEffect(() => {
    let vivo = true;
    void fetch(`${serverUrl}/api/admin/users`, { headers: { authorization: `Bearer ${token}` } })
      .then((resposta) => resposta.ok ? resposta.json() : Promise.reject(new Error('recusado')))
      .then((corpo: { users?: AdminUser[] }) => { if (vivo) setUsers(corpo.users ?? []); })
      .catch(() => { if (vivo) setUsers([]); });
    return () => { vivo = false; };
  }, [serverUrl, token]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const visibleUsers = useMemo(() => {
    const termo = filter.trim().toLocaleLowerCase('pt-BR');
    return (users ?? [])
      .filter((user) => !termo || user.username.toLocaleLowerCase('pt-BR').includes(termo))
      .sort((a, b) => a.username.localeCompare(b.username, 'pt-BR'));
  }, [filter, users]);

  const setEveryone = (key: ChannelPermissionKey, value: Tri) => setRules((atual) => {
    const everyone = { ...(atual.everyone ?? {}) };
    if (value === undefined) delete everyone[key]; else everyone[key] = value;
    return { ...atual, everyone };
  });
  const setUser = (userId: string, key: ChannelPermissionKey, value: Tri) => setRules((atual) => {
    const regra = { ...(atual.users?.[userId] ?? {}) };
    if (value === undefined) delete regra[key]; else regra[key] = value;
    return { ...atual, users: { ...(atual.users ?? {}), [userId]: regra } };
  });

  const privado = rules.everyone?.view === false;

  const save = async () => {
    setSaving(true);
    setError('');
    const corpo: Record<string, unknown> = { name, topic, permissions: compact(rules) };
    if (channel.type === 'voice') corpo.userLimit = Number(limit) || 0;
    try {
      const resposta = await fetch(`${serverUrl}/api/admin/channels/${encodeURIComponent(channel.id)}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const retorno = await resposta.json().catch(() => ({})) as { error?: string };
      if (!resposta.ok) throw new Error(retorno.error ?? 'O servidor recusou a alteração.');
      onNotice(`Canal ${name.trim() || channel.name} atualizado.`);
      onSaved?.();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não consegui salvar o canal.');
    } finally {
      setSaving(false);
    }
  };

  const Cell = ({ value, effective, onChange, label, disabled }: { value: Tri; effective: boolean; onChange: (value: Tri) => void; label: string; disabled?: boolean }) => (
    <button
      type="button"
      disabled={disabled}
      className={`perm-cell ${value === true ? 'is-allow' : value === false ? 'is-deny' : 'is-inherit'} ${effective ? 'effective-allow' : 'effective-deny'}`}
      onClick={() => onChange(next(value))}
      title={`${label}: ${value === true ? 'permitido' : value === false ? 'negado' : `herdado (${effective ? 'pode' : 'não pode'})`} — clique para trocar`}
      aria-label={`${label}: ${value === true ? 'permitido' : value === false ? 'negado' : 'herdado'}`}
    >{value === true ? <Icon name="shield" /> : value === false ? <Icon name="close" /> : <span>—</span>}</button>
  );

  const everyoneEffective = resolveAccess({ permissions: rules }, '', false);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}>
    <div className="settings-modal channel-settings" role="dialog" aria-modal="true" aria-labelledby="channel-settings-title">
      <aside>
        <h2><Icon name={channel.type === 'voice' ? 'voice' : 'hash'} /> {channel.name}</h2>
        <button className={tab === 'geral' ? 'selected' : ''} onClick={() => setTab('geral')}>Geral</button>
        <button className={tab === 'permissoes' ? 'selected' : ''} onClick={() => setTab('permissoes')}>Permissões</button>
      </aside>
      <section>
        <button className="modal-close" disabled={saving} onClick={onClose}><Icon name="close" /></button>
        <h1 id="channel-settings-title">{tab === 'geral' ? 'Editar canal' : 'Permissões'}</h1>
        {tab === 'geral' && <div className="channel-settings-form">
          <label>Nome <input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} /></label>
          <label>Tópico <input value={topic} maxLength={190} onChange={(event) => setTopic(event.target.value)} placeholder="Do que se fala aqui" /></label>
          {channel.type === 'voice' && <label>Limite de pessoas <input type="number" min={0} max={99} value={limit} onChange={(event) => setLimit(event.target.value)} /><small>0 é sem limite. A administração entra mesmo com a call cheia.</small></label>}
          <label className="sound-toggle"><input type="checkbox" checked={privado} onChange={(event) => setEveryone('view', event.target.checked ? false : undefined)} /><span><strong>Canal privado</strong><small>Some para todo mundo, menos para a administração e para quem você permitir em Permissões.</small></span></label>
        </div>}
        {tab === 'permissoes' && <div className="channel-permissions">
          <p className="settings-intro">— herda, <Icon name="shield" className="inline-icon" /> permite, <Icon name="close" className="inline-icon" /> nega. Dono e admins sempre podem tudo. A mudança vale na hora: quem perde a entrada sai da call.</p>
          <div className="perm-table" style={{ '--perm-cols': keys.length } as React.CSSProperties}>
            <div className="perm-row perm-head"><span>Quem</span>{keys.map((key) => <span key={key}>{PERMISSION_LABEL[key]}</span>)}</div>
            <div className="perm-row perm-everyone"><strong>Todos</strong>{keys.map((key) => <Cell key={key} label={PERMISSION_LABEL[key]} value={rules.everyone?.[key]} effective={everyoneEffective[key]} onChange={(value) => setEveryone(key, value)} />)}</div>
            <input className="perm-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Procurar pessoa" />
            {users === null && <p className="invite-status">Carregando as contas…</p>}
            {visibleUsers.map((user) => {
              const admin = user.role === 'owner' || user.role === 'admin';
              const efetivo: ChannelAccess = resolveAccess({ permissions: rules }, user.id, admin);
              return <div className="perm-row" key={user.id}>
                <span className="perm-user">{user.username}{admin && <em>{user.role === 'owner' ? 'dono' : 'admin'}</em>}</span>
                {keys.map((key) => <Cell key={key} label={`${PERMISSION_LABEL[key]} para ${user.username}`} disabled={admin} value={admin ? undefined : rules.users?.[user.id]?.[key]} effective={efetivo[key]} onChange={(value) => setUser(user.id, key, value)} />)}
              </div>;
            })}
          </div>
        </div>}
        {error && <div className="form-error">{error}</div>}
        <div className="confirm-actions">
          <button type="button" disabled={saving} onClick={onClose}>Cancelar</button>
          <button type="button" className="primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </section>
    </div>
  </div>;
}
