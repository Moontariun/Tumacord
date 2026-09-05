import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou (${child.exitCode}).`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Servidor não iniciou a tempo.');
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function servidor(context: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-adminapi-'));
  const port = 33_000 + Math.floor(Math.random() * 6_000);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      ADMIN_USERNAME: 'Chefe', TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: 'ignore',
  });
  context.after(async () => { await stopServer(child); await rm(root, { recursive: true, force: true }); });
  await waitForServer(url, child);
  const dono = await entrar(url, 'Dono', 'senha-do-dono');
  const comum = await entrar(url, 'Fulano', 'senha-do-fulano');
  return { url, dono, comum };
}

async function entrar(url: string, username: string, password: string) {
  const r = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, allowCreate: true }),
  });
  return await r.json() as { token: string; user: { id: string; role?: string } };
}

function comoAdmin(token: string, metodo = 'GET', corpo?: unknown) {
  return {
    method: metodo,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  };
}

test('usuário comum não alcança nenhum endpoint administrativo', { timeout: 30_000 }, async (context) => {
  const { url, comum } = await servidor(context);
  const rotas: Array<[string, string, unknown?]> = [
    ['/api/admin/users', 'GET'],
    ['/api/admin/audit', 'GET'],
    ['/api/admin/channels', 'POST', { name: 'invasao', type: 'text' }],
    ['/api/admin/categories', 'POST', { name: 'invasao' }],
    ['/api/admin/channels/order', 'POST', { ids: [] }],
  ];
  for (const [rota, metodo, corpo] of rotas) {
    const resposta = await fetch(`${url}${rota}`, comoAdmin(comum.token, metodo, corpo));
    assert.equal(resposta.status, 403, `${metodo} ${rota} deveria recusar`);
  }
  const semSessao = await fetch(`${url}/api/admin/users`);
  assert.equal(semSessao.status, 403);
});

test('a administração cria, edita, reordena e apaga canais', { timeout: 30_000 }, async (context) => {
  const { url, dono } = await servidor(context);
  const criado = await (await fetch(`${url}/api/admin/channels`, comoAdmin(dono.token, 'POST', { name: 'Anúncios', type: 'text', topic: 'avisos do grupo' }))).json() as { channel: { id: string; name: string; topic?: string; position?: number } };
  assert.equal(criado.channel.name, 'Anúncios');
  assert.equal(criado.channel.topic, 'avisos do grupo');
  assert.ok(criado.channel.position && criado.channel.position > 0);

  const editado = await (await fetch(`${url}/api/admin/channels/${criado.channel.id}`, comoAdmin(dono.token, 'PATCH', { name: 'Avisos' }))).json() as { channel: { name: string } };
  assert.equal(editado.channel.name, 'Avisos');

  const voz = await (await fetch(`${url}/api/admin/channels`, comoAdmin(dono.token, 'POST', { name: 'Jogos', type: 'voice', userLimit: 8 }))).json() as { channel: { id: string; userLimit?: number } };
  assert.equal(voz.channel.userLimit, 8);

  const ordem = await fetch(`${url}/api/admin/channels/order`, comoAdmin(dono.token, 'POST', { ids: [voz.channel.id, criado.channel.id] }));
  assert.equal(ordem.status, 200);

  assert.equal((await fetch(`${url}/api/admin/channels/${criado.channel.id}`, comoAdmin(dono.token, 'DELETE'))).status, 200);
});

test('validação recusa nome vazio, longo, com símbolo e limite fora de faixa', { timeout: 30_000 }, async (context) => {
  const { url, dono } = await servidor(context);
  const casos: Array<[unknown, string]> = [
    [{ name: '', type: 'text' }, 'vazio'],
    [{ name: 'a'.repeat(40), type: 'text' }, 'longo'],
    [{ name: '<script>', type: 'text' }, 'símbolo'],
    [{ name: 'ok', type: 'text', userLimit: 5 }, 'limite em canal de texto'],
    [{ name: 'ok', type: 'voice', userLimit: 500 }, 'limite fora de faixa'],
    [{ name: 'ok', type: 'text', topic: 'x'.repeat(300) }, 'tópico longo'],
  ];
  for (const [corpo, motivo] of casos) {
    const resposta = await fetch(`${url}/api/admin/channels`, comoAdmin(dono.token, 'POST', corpo));
    assert.equal(resposta.status, 400, `deveria recusar: ${motivo}`);
    assert.ok((await resposta.json() as { error: string }).error, 'a recusa precisa explicar o motivo');
  }
});

// Um servidor sem canal de texto fica sem lugar para conversar e sem como
// recriar um pela interface normal.
test('o último canal de texto não pode ser apagado', { timeout: 30_000 }, async (context) => {
  const { url, dono } = await servidor(context);
  const lista = await (await fetch(`${url}/api/health`)).json() as unknown;
  assert.ok(lista);
  const canais = await (await fetch(`${url}/api/admin/audit`, comoAdmin(dono.token))).json() as unknown;
  assert.ok(canais);
  // Apaga todos os de texto menos um; o último precisa resistir.
  const overview = await (await fetch(`${url}/api/admin/overview`, comoAdmin(dono.token))).json() as { channels: Array<{ id: string; type: string }> };
  const texto = overview.channels.filter((c) => c.type === 'text');
  for (const canal of texto.slice(0, -1)) {
    assert.equal((await fetch(`${url}/api/admin/channels/${canal.id}`, comoAdmin(dono.token, 'DELETE'))).status, 200);
  }
  const ultimo = texto.at(-1)!;
  const recusa = await fetch(`${url}/api/admin/channels/${ultimo.id}`, comoAdmin(dono.token, 'DELETE'));
  assert.equal(recusa.status, 409);
  assert.match((await recusa.json() as { error: string }).error, /último canal de texto/);
});

test('apagar categoria solta os canais dela em vez de levá-los junto', { timeout: 30_000 }, async (context) => {
  const { url, dono } = await servidor(context);
  const categoria = await (await fetch(`${url}/api/admin/categories`, comoAdmin(dono.token, 'POST', { name: 'Administração' }))).json() as { category: { id: string } };
  const canal = await (await fetch(`${url}/api/admin/channels`, comoAdmin(dono.token, 'POST', { name: 'logs', type: 'text', categoryId: categoria.category.id }))).json() as { channel: { id: string; categoryId?: string } };
  assert.equal(canal.channel.categoryId, categoria.category.id);

  assert.equal((await fetch(`${url}/api/admin/categories/${categoria.category.id}`, comoAdmin(dono.token, 'DELETE'))).status, 200);
  const overview = await (await fetch(`${url}/api/admin/overview`, comoAdmin(dono.token))).json() as { channels: Array<{ id: string; categoryId?: string }> };
  const sobrevivente = overview.channels.find((c) => c.id === canal.channel.id);
  assert.ok(sobrevivente, 'o canal não pode ter sido apagado junto');
  assert.equal(sobrevivente?.categoryId, undefined);
});

test('papéis: dono promove, admin não promove a dono, e o último dono resiste', { timeout: 30_000 }, async (context) => {
  const { url, dono, comum } = await servidor(context);
  assert.equal(dono.user.role, 'owner');

  const promovido = await fetch(`${url}/api/admin/users/${comum.user.id}/role`, comoAdmin(dono.token, 'POST', { role: 'admin' }));
  assert.equal(promovido.status, 200);

  const admin = await entrar(url, 'Fulano', 'senha-do-fulano');
  assert.equal(admin.user.role, 'admin');

  const tentativa = await fetch(`${url}/api/admin/users/${admin.user.id}/role`, comoAdmin(admin.token, 'POST', { role: 'owner' }));
  assert.equal(tentativa.status, 403, 'admin não pode se promover a dono');

  const rebaixarDono = await fetch(`${url}/api/admin/users/${dono.user.id}/role`, comoAdmin(dono.token, 'POST', { role: 'admin' }));
  assert.equal(rebaixarDono.status, 403, 'o último dono não pode se rebaixar');
  assert.match((await rebaixarDono.json() as { error: string }).error, /pelo menos um dono/);
});

test('o registro de auditoria guarda as ações, inclusive as negadas, sem segredo', { timeout: 30_000 }, async (context) => {
  const { url, dono, comum } = await servidor(context);
  await fetch(`${url}/api/admin/channels`, comoAdmin(dono.token, 'POST', { name: 'auditado', type: 'text' }));
  await fetch(`${url}/api/admin/users/${dono.user.id}/role`, comoAdmin(dono.token, 'POST', { role: 'member' }));

  const registro = await (await fetch(`${url}/api/admin/audit`, comoAdmin(dono.token))).json() as { entries: Array<{ action: string; result: string; actorUsername: string; target?: string }> };
  const criacao = registro.entries.find((e) => e.action === 'channel.create');
  assert.equal(criacao?.actorUsername, 'Dono');
  assert.equal(criacao?.target, 'auditado');

  const negada = registro.entries.find((e) => e.result === 'denied');
  assert.ok(negada, 'ação negada precisa ficar registrada — é a mais interessante quando algo dá errado');

  const texto = JSON.stringify(registro);
  assert.equal(texto.includes(dono.token), false, 'nenhum token no registro');
  assert.equal(texto.includes(comum.token), false);
});
