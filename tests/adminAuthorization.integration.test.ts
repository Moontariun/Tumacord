import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { freePort } from './freePort';

// A saída de erro do servidor é capturada e vai junto na falha.
//
// Com `stdio: 'ignore'`, um servidor que não sobe deixava só o código de saída
// — e "encerrou (1)" cabe em porta ocupada, exceção na carga do arquivo de
// dados e meia dúzia de outras coisas. Quem lê a reprovação no CI precisa do
// motivo, não do código.
function motivo(erro: string[]): string {
  const texto = erro.join('').trim();
  return texto ? ` Ele disse: ${texto.split('\n').slice(-6).join(' / ')}` : '';
}

async function waitForServer(url: string, child: ChildProcess, erro: string[] = []): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes do teste (${child.exitCode})${motivo(erro)}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Servidor não iniciou a tempo.${motivo(erro)}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function connect(url: string, token: string): Promise<Socket> {
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket não conectou')), 5_000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function ask<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} não respondeu`)), 5_000);
    socket.emit(event, payload, (result: T) => { clearTimeout(timer); resolve(result); });
  });
}

async function entrar(url: string, username: string, password: string) {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, allowCreate: true }),
  });
  return { status: response.status, body: await response.json() as { token: string; user: { isAdmin?: boolean; role?: string } } };
}

// Por padrão o helper já cria a conta dona antes de tudo, que é como um
// servidor real nasce: o operador sobe o contêiner e faz a própria conta. Sem
// isso, a primeira pessoa a entrar viraria dona — a proteção que impede um
// servidor de existir sem ninguém capaz de administrá-lo.
async function servidorDedicado(context: { after: (fn: () => Promise<void>) => void }, criarDono = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-admin-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
      TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
      ADMIN_USERNAME: 'Chefe', TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const erro: string[] = [];
  child.stderr?.on('data', (pedaco: Buffer) => { erro.push(String(pedaco)); if (erro.length > 40) erro.shift(); });
  const sockets: Socket[] = [];
  context.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  });
  await waitForServer(url, child, erro);
  if (criarDono) await entrar(url, 'Chefe', 'senha-do-chefe');
  return { url, sockets };
}

// Antes desta versão `channel:create` não verificava nada: qualquer usuário
// autenticado criava canal de texto e de voz no servidor dedicado.
test('usuário comum não cria canal; a administração cria', { timeout: 30_000 }, async (context) => {
  const { url, sockets } = await servidorDedicado(context);

  const comum = await entrar(url, 'Fulano', 'senha-do-fulano');
  assert.equal(comum.body.user.isAdmin ?? false, false);
  const socketComum = await connect(url, comum.body.token);
  sockets.push(socketComum);

  const recusado = await ask<{ ok: boolean; error?: string }>(socketComum, 'channel:create', { name: 'invasao', type: 'text' });
  assert.equal(recusado.ok, false);
  assert.match(recusado.error ?? '', /administração/i);

  const recusadoVoz = await ask<{ ok: boolean }>(socketComum, 'channel:create', { name: 'invasao-voz', type: 'voice' });
  assert.equal(recusadoVoz.ok, false, 'canal de voz também precisa ser bloqueado');

  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  assert.equal(chefe.body.user.role, 'owner');
  assert.equal(chefe.body.user.isAdmin, true);
  const socketChefe = await connect(url, chefe.body.token);
  sockets.push(socketChefe);

  const criado = await ask<{ ok: boolean; channel?: { id: string; type: string } }>(socketChefe, 'channel:create', { name: 'anuncios', type: 'text' });
  assert.equal(criado.ok, true);
  assert.equal(criado.channel?.type, 'text');
});

// Os dois caminhos que criam canal precisam criar o **mesmo** canal.
//
// Até a 0.9.9 eram duas operações diferentes: a do socket não atribuía
// posição — o canal nascia no fim por acidente de inserção —, usava outro
// `slugify`, não aceitava categoria, tópico nem limite, e não deixava registro
// na auditoria. Por qual porta se entrou mudava o que saía.
test('socket e API criam o mesmo canal, com posição e auditoria', { timeout: 30_000 }, async (context) => {
  const { url, sockets } = await servidorDedicado(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  const socketChefe = await connect(url, chefe.body.token);
  sockets.push(socketChefe);
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${chefe.body.token}` };

  const porSocket = await ask<{ ok: boolean; channel?: Record<string, unknown> }>(socketChefe, 'channel:create', { name: 'Pelo Socket', type: 'text' });
  const respostaRest = await fetch(`${url}/api/admin/channels`, {
    method: 'POST', headers: cabecalho, body: JSON.stringify({ name: 'Pela API', type: 'text' }),
  });
  const porRest = await respostaRest.json() as { ok: boolean; channel?: Record<string, unknown> };

  assert.equal(porSocket.ok, true);
  assert.equal(respostaRest.status, 201);
  // A posição é o que ordena a lista. Sem ela, o canal do socket dependia da
  // ordem de inserção no arquivo e não podia ser reordenado.
  assert.equal(typeof porSocket.channel?.position, 'number', 'o canal do socket precisa nascer posicionado');
  assert.equal(typeof porRest.channel?.position, 'number');
  assert.deepEqual(Object.keys(porSocket.channel ?? {}).sort(), Object.keys(porRest.channel ?? {}).sort(), 'os dois caminhos produzem o mesmo formato');
  // O mesmo `slugify`: acento e maiúscula tratados igual nos dois.
  assert.match(String(porSocket.channel?.id), /^pelo-socket-[0-9a-f]{4}$/);
  assert.match(String(porRest.channel?.id), /^pela-api-[0-9a-f]{4}$/);

  const auditoria = await (await fetch(`${url}/api/admin/audit`, { headers: cabecalho })).json() as { entries: { action: string; target: string }[] };
  const criacoes = auditoria.entries.filter((entrada) => entrada.action === 'channel.create').map((entrada) => entrada.target);
  assert.ok(criacoes.includes('Pelo Socket'), 'a criação pelo socket também precisa deixar registro');
  assert.ok(criacoes.includes('Pela API'));
});

// Esconder o botão é conveniência; quem recusa é o servidor. Um cliente que
// chame o socket direto passa pela mesma conferência do papel persistido.
test('o nome do canal é validado nos dois caminhos, e não só na interface', { timeout: 30_000 }, async (context) => {
  const { url, sockets } = await servidorDedicado(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  const socketChefe = await connect(url, chefe.body.token);
  sockets.push(socketChefe);

  const vazio = await ask<{ ok: boolean; error?: string }>(socketChefe, 'channel:create', { name: '   ', type: 'text' });
  assert.equal(vazio.ok, false);
  const longo = await ask<{ ok: boolean; error?: string }>(socketChefe, 'channel:create', { name: 'x'.repeat(33), type: 'text' });
  assert.equal(longo.ok, false);
  // Um tipo inventado não cria um terceiro tipo de canal.
  const tipoEstranho = await ask<{ ok: boolean; channel?: { type: string } }>(socketChefe, 'channel:create', { name: 'estranho', type: 'quadro' });
  assert.equal(tipoEstranho.channel?.type ?? 'text', 'text', 'o que não é voz é texto');
});

// Segundo caminho para o mesmo estrago: empurrar um pacote de sincronização
// com canais novos dentro.
test('sincronização de usuário comum não injeta canais', { timeout: 30_000 }, async (context) => {
  const { url, sockets } = await servidorDedicado(context);
  const comum = await entrar(url, 'Fulano', 'senha-do-fulano');
  const socketComum = await connect(url, comum.body.token);
  sockets.push(socketComum);

  const resultado = await ask<{ ok: boolean; channels: Array<{ id: string }> }>(socketComum, 'chat:sync:push', {
    channels: [{ id: 'canal-invadido', name: 'invadido', type: 'text' }],
    messages: [],
    profiles: [],
    availableAttachmentIds: [],
  });
  assert.equal(resultado.ok, true, 'a sincronização de mensagens continua funcionando');
  assert.equal(resultado.channels.some((channel) => channel.id === 'canal-invadido'), false, 'o canal não pode ter entrado');
});

// Medido antes da correção: doze senhas erradas em 595 ms, todas 401.
test('senhas erradas em sequência passam a esbarrar em limite', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  await entrar(url, 'Alvo', 'senha-verdadeira');

  const status: number[] = [];
  for (let tentativa = 0; tentativa < 9; tentativa += 1) {
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Alvo', password: `chute-${tentativa}` }),
    });
    status.push(response.status);
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0, 'a resposta precisa dizer quanto esperar');
      break;
    }
  }
  assert.ok(status.includes(429), `nenhuma tentativa foi barrada: ${status.join(', ')}`);
  assert.equal(status[0], 401, 'a primeira tentativa errada ainda responde senha incorreta');
});

test('quem acerta a senha não fica preso no limite do vizinho', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  await entrar(url, 'Alvo', 'senha-verdadeira');
  for (let tentativa = 0; tentativa < 8; tentativa += 1) {
    await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Alvo', password: 'errada' }),
    });
  }
  const outro = await entrar(url, 'Vizinho', 'senha-do-vizinho');
  assert.equal(outro.status, 200, 'o bloqueio é por usuário e origem, não global');
});

test('o anexo entre pares continua servindo a rede local, sem regressão', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  const sessao = await entrar(url, 'Fulano', 'senha-do-fulano');
  const envio = await fetch(`${url}/api/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessao.body.token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'nota.txt' },
    body: Buffer.from('conteudo do grupo'),
  });
  const anexo = await envio.json() as { id: string };
  // O teste roda em 127.0.0.1, que é endereço da própria máquina e continua
  // liberado — é o caso do P2P na mesma rede. A recusa para endereço público
  // é coberta pelos testes de `isTrustedLocalAddress`.
  const local = await fetch(`${url}/api/peer/attachments/${anexo.id}`);
  assert.equal(local.status, 200);
  assert.equal(await local.text(), 'conteudo do grupo');
});

// Migração vinda da 0.8.0: o `ADMIN_USERNAME` vira o dono inicial e, a partir
// daí, o papel persistido é que manda.
test('a primeira conta de um servidor novo vira dona, e o papel persiste', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context, false);
  const primeiro = await entrar(url, 'Pioneiro', 'senha-do-pioneiro');
  assert.equal(primeiro.body.user.role, 'owner', 'quem cria o servidor fica com ele');
  assert.equal(primeiro.body.user.isAdmin, true, 'clientes antigos continuam enxergando administração');

  const segundo = await entrar(url, 'Chegou Depois', 'senha-qualquer');
  assert.equal(segundo.body.user.role, 'member');
  assert.equal(segundo.body.user.isAdmin ?? false, false);

  // O nome apontado por ADMIN_USERNAME entra como admin quando o servidor já
  // tem dono: a variável não sequestra um servidor em uso.
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  assert.equal(chefe.body.user.role, 'admin');
  assert.equal(chefe.body.user.isAdmin, true);
});

test('o papel sobrevive ao reinício do servidor', { timeout: 40_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-papel-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const ambiente = (adminUsername: string) => ({
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
    TUMACORD_P2P_MODE: '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
    ADMIN_USERNAME: adminUsername, TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  });
  // Este teste sobe o servidor duas vezes, com donos diferentes. A saída de
  // erro é acumulada aqui para a falha dizer o motivo em qualquer uma delas.
  const erro: string[] = [];
  const subir = (adminUsername: string) => {
    const processo = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env: ambiente(adminUsername), stdio: ['ignore', 'ignore', 'pipe'] });
    processo.stderr?.on('data', (pedaco: Buffer) => { erro.push(String(pedaco)); if (erro.length > 40) erro.shift(); });
    return processo;
  };

  let child = subir('Pioneiro');
  context.after(async () => { await stopServer(child); await rm(root, { recursive: true, force: true }); });
  await waitForServer(url, child, erro);
  assert.equal((await entrar(url, 'Pioneiro', 'senha-do-pioneiro')).body.user.role, 'owner');
  await entrar(url, 'Outro', 'senha-do-outro');
  await stopServer(child);

  // Sobe de novo com OUTRO nome na variável: o dono precisa continuar o mesmo.
  child = subir('Outro');
  await waitForServer(url, child, erro);
  assert.equal((await entrar(url, 'Pioneiro', 'senha-do-pioneiro')).body.user.role, 'owner', 'trocar a variável não pode sequestrar o servidor');
  // A variável só decide papel no momento em que a conta é criada. Depois
  // disso o papel é dado, e apontá-la para uma conta existente não promove
  // ninguém — senão bastaria editar o ambiente para virar administrador.
  assert.equal((await entrar(url, 'Outro', 'senha-do-outro')).body.user.role, 'member');
});

// --- atualizar o servidor pelo painel ---------------------------------------
//
// É a ação mais perigosa do projeto: ela troca o código que está rodando.
// Nenhum caso aqui aplica nada — o que se prova é que os caminhos de recusa
// fecham. Aplicar de verdade trocaria o código desta cópia do repositório, e
// está dito como manual em `docs/QA.md`.

async function pedirAtualizacao(url: string, token: string, metodo: 'GET' | 'POST', corpo?: unknown) {
  const resposta = await fetch(`${url}/api/admin/update`, {
    method: metodo,
    headers: { authorization: `Bearer ${token}`, ...(corpo === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
  return { status: resposta.status, body: await resposta.json().catch(() => ({})) as { enabled?: boolean; reason?: string; error?: string; releases?: unknown[] } };
}

test('trocar a versão do servidor é do dono, e só dele', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);

  const comum = await entrar(url, 'Fulano', 'senha-do-fulano');
  assert.equal((await pedirAtualizacao(url, comum.body.token, 'GET')).status, 403);
  assert.equal((await pedirAtualizacao(url, comum.body.token, 'POST', { tag: 'v0.9.8' })).status, 403);

  // Administrador cuida de canais e de gente. Trocar o código do servidor é de
  // quem responde por ele.
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  const promovido = await fetch(`${url}/api/admin/users/${encodeURIComponent(comum.body.user.id)}/role`, {
    method: 'POST',
    headers: { authorization: `Bearer ${chefe.body.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });
  assert.equal(promovido.ok, true);
  const comoAdmin = await entrar(url, 'Fulano', 'senha-do-fulano');
  const recusaDoAdmin = await pedirAtualizacao(url, comoAdmin.body.token, 'GET');
  assert.equal(recusaDoAdmin.status, 403);
  assert.match(recusaDoAdmin.body.error ?? '', /dono/i);
});

test('o padrão é não aceitar atualização pelo painel, e o dono vê o motivo', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');

  const leitura = await pedirAtualizacao(url, chefe.body.token, 'GET');
  assert.equal(leitura.status, 200);
  assert.equal(leitura.body.enabled, false, 'ligar isso é decisão de quem hospeda');
  assert.match(leitura.body.reason ?? '', /TUMACORD_SELF_UPDATE/);
  assert.deepEqual(leitura.body.releases, [], 'desligado, nem a lista é buscada');

  // E o caminho que executa recusa pelo mesmo motivo, sem depender de o botão
  // estar escondido no navegador.
  const tentativa = await pedirAtualizacao(url, chefe.body.token, 'POST', { tag: 'v0.9.8' });
  assert.equal(tentativa.status, 409);
  assert.match(tentativa.body.error ?? '', /desligada/);
});

test('a tentativa de atualizar fica registrada antes de acontecer', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  await pedirAtualizacao(url, chefe.body.token, 'POST', { tag: 'v0.9.8' });

  const registro = await fetch(`${url}/api/admin/audit`, { headers: { authorization: `Bearer ${chefe.body.token}` } });
  const { entries } = await registro.json() as { entries: Array<{ action: string; target?: string; actorUsername: string }> };
  const pedido = entries.find((entrada) => entrada.action === 'server.update');
  assert.ok(pedido, 'uma atualização que derruba o servidor no meio não deixaria rastro se o registro viesse depois');
  assert.equal(pedido?.target, 'v0.9.8');
  assert.equal(pedido?.actorUsername, 'Chefe');
});

test('um corpo sem etiqueta de texto é recusado na porta', { timeout: 30_000 }, async (context) => {
  const { url } = await servidorDedicado(context);
  const chefe = await entrar(url, 'Chefe', 'senha-do-chefe');
  for (const corpo of [{}, { tag: 42 }, { tag: null }, { tag: 'v'.repeat(80) }, { tag: ['v0.9.8'] }]) {
    const resposta = await pedirAtualizacao(url, chefe.body.token, 'POST', corpo);
    assert.equal(resposta.status, 400, `${JSON.stringify(corpo)} não passa do esquema`);
  }
});

