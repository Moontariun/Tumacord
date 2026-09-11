import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { applyOrderedOp, type BoardOp, type BoardOpEnvelope, type BoardState, type BoardSummary } from '../shared/whiteboard.js';
import { freePort } from './freePort';

// As regras da mesa, provadas contra um servidor de verdade — que é onde elas
// moram. Esconder um botão no cliente é conveniência; o que um cliente
// modificado encontra é o que está aqui.

interface Ambiente {
  url: string;
  entrar: (username: string) => Promise<Socket>;
  /** `abrupto` derruba o processo sem encerramento gracioso, como o Windows faz. */
  reiniciar: (abrupto?: boolean) => Promise<void>;
}

// Prazos folgados de propósito. Estes testes sobem servidores de verdade, e
// eles disputam a máquina com as outras suítes que o runner roda em paralelo:
// uma máquina de integração contínua com quatro núcleos demora para arrancar um
// processo que a máquina de quem escreveu o teste arranca num piscar. Um prazo
// curto aqui não prova nada além da velocidade do computador.
function waitFor<T>(socket: Socket, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`tempo esgotado em ${event}`)); }, timeoutMs);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

function emit<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} não respondeu`)), timeoutMs);
    socket.emit(event, payload, (reply: T) => { clearTimeout(timer); resolve(reply); });
  });
}

async function pararServidor(child: ChildProcess, sinal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill(sinal);
  await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5_000).unref?.(); });
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`servidor encerrou (${child.exitCode})`);
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('servidor não iniciou a tempo');
}

async function ambiente(context: { after: (fn: () => Promise<void>) => void }, p2p = false): Promise<Ambiente> {
  const root = await mkdtemp(path.join(tmpdir(), 'tumacord-mesa-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: path.join(root, 'data'),
    TUMACORD_P2P_MODE: p2p ? '1' : '0', TUMACORD_SERVE_WEB: '0', SERVER_ACCESS_KEY: '',
    TUMACORD_DIRECT_KEY: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '',
  };
  let child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' });
  const sockets: Socket[] = [];
  context.after(async () => {
    // Esperar o processo sair antes de apagar o diretório. Desde a 0.9.1 o
    // encerramento do servidor grava as mesas em disco, e apagar a pasta
    // embaixo de quem ainda está escrevendo devolve ENOTEMPTY — falha que só
    // aparece em máquina lenta, que é justamente onde ninguém está olhando.
    for (const socket of sockets) socket.disconnect();
    await pararServidor(child);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  });
  await waitForServer(url, child);

  const entrar = async (username: string): Promise<Socket> => {
    const resposta = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'senha-de-teste', allowCreate: true }),
    });
    const { token } = await resposta.json() as { token: string };
    const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket);
    if (!socket.connected) await waitFor(socket, 'connect');
    return socket;
  };

  // Derrubar e subir de novo com o mesmo diretório de dados: é assim que
  // "salvar e reabrir" deixa de ser uma promessa e vira uma prova.
  const reiniciar = async (abrupto = false) => {
    for (const socket of sockets) socket.disconnect();
    // O servidor junta as gravações das mesas numa janela curta. Esperar essa
    // janela é esperar o disco, não esperar o desligamento: sem isso o teste
    // mediria a cortesia do sistema operacional na hora de matar o processo —
    // que no Windows não existe — em vez de medir a durabilidade da mesa.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // Sair grava as mesas; esperar a saída é esperar a gravação terminar. Com
    // `abrupto` não há gravação nenhuma na saída — é o que sobra quando o
    // sistema não oferece encerramento gracioso.
    await pararServidor(child, abrupto ? 'SIGKILL' : 'SIGTERM');
    child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' });
    await waitForServer(url, child);
  };

  return { url, entrar, reiniciar };
}

const criar = (socket: Socket, name = 'Plano da base', channelId = 'geral') =>
  emit<{ ok: boolean; error?: string; board?: BoardSummary }>(socket, 'board:create', { channelId, name });

const entrarNaMesa = (socket: Socket, boardId: string, observer = false) =>
  emit<{
    ok: boolean; error?: string; role?: string; revision?: number;
    snapshot?: { revision: number; strokes: unknown[] };
    ops?: BoardOpEnvelope[];
    participants?: Array<{ userId: string; username: string; role: string }>;
  }>(socket, 'board:join', { boardId, observer });

const desenhar = (socket: Socket, boardId: string, ops: BoardOp[]) =>
  emit<{ ok: boolean; error?: string; accepted?: BoardOpEnvelope[]; rejected?: Array<{ id: string; error: string }>; revision?: number }>(socket, 'board:ops', { boardId, ops });

const traco = (id: string, x: number, y: number): BoardOp => ({ id: `${id}@0`, kind: 'stroke', stroke: id, color: '#5cc8ff', width: 4, points: [{ x, y }] });

/** Remonta o quadro do jeito que o cliente remonta: snapshot mais o que veio depois. */
function montar(snapshot: { revision: number; strokes: unknown[] } | undefined, ops: readonly BoardOpEnvelope[] = []): BoardState {
  let state: BoardState = { revision: snapshot?.revision ?? 0, strokes: (snapshot?.strokes ?? []) as BoardState['strokes'] };
  for (const envelope of [...ops].sort((first, second) => first.rev - second.rev)) {
    const outcome = applyOrderedOp(state, envelope);
    if (outcome.status === 'applied' || outcome.status === 'refused') state = outcome.state;
  }
  return state;
}

test('três pessoas desenham ao mesmo tempo e convergem para o mesmo quadro', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const caio = await entrar('Caio');

  const criada = await criar(ana);
  assert.equal(criada.ok, true);
  const boardId = criada.board!.id;
  for (const socket of [ana, bia, caio]) assert.equal((await entrarNaMesa(socket, boardId)).ok, true);

  // As três mãos saem ao mesmo tempo; quem ordena decide a fila.
  const recebidos = new Map<Socket, BoardOpEnvelope[]>([[ana, []], [bia, []], [caio, []]]);
  for (const socket of recebidos.keys()) {
    socket.on('board:ops', (payload: { ops?: BoardOpEnvelope[] }) => recebidos.get(socket)!.push(...(payload.ops ?? [])));
  }
  await Promise.all([
    desenhar(ana, boardId, [traco('t-ana', 100, 100)]),
    desenhar(bia, boardId, [traco('t-bia', 200, 200)]),
    desenhar(caio, boardId, [traco('t-caio', 300, 300)]),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const quadros = [...recebidos.values()].map((ops) => montar(undefined, ops));
  assert.equal(quadros[0].strokes.length, 3);
  // Mesmas revisões, mesmos traços, na mesma ordem, nas três telas.
  assert.deepEqual(quadros[1], quadros[0]);
  assert.deepEqual(quadros[2], quadros[0]);
  assert.deepEqual(quadros[0].strokes.map((stroke) => stroke.authorName).sort(), ['Ana', 'Bia', 'Caio']);
});

test('quem entra depois vê os desenhos anteriores', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await desenhar(ana, boardId, [traco('t1', 10, 10), traco('t2', 20, 20), traco('t3', 30, 30)]);

  const atrasada = await entrar('Dani');
  const entrou = await entrarNaMesa(atrasada, boardId);
  assert.equal(entrou.ok, true);
  const quadro = montar(entrou.snapshot, entrou.ops);
  assert.deepEqual(quadro.strokes.map((stroke) => stroke.id), ['t1', 't2', 't3']);
  assert.equal(quadro.revision, entrou.revision);
});

test('reconectar não duplica traços, nem quando o mesmo pedido é reenviado', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  const lote = [traco('t1', 10, 10), { id: 't1@1', kind: 'stroke', stroke: 't1', color: '#5cc8ff', width: 4, points: [{ x: 20, y: 20 }] } satisfies BoardOp];
  const primeira = await desenhar(ana, boardId, lote);
  assert.equal(primeira.accepted?.length, 2);

  // A reconexão não sabe se o pedido chegou, então ela reenvia o mesmo lote.
  const repetida = await desenhar(ana, boardId, lote);
  assert.equal(repetida.ok, true);
  assert.equal(repetida.accepted?.length, 0, 'o mesmo pedaço não vira operação nova');
  assert.equal(repetida.revision, primeira.revision);

  const outra = await entrar('Bia');
  const entrou = await entrarNaMesa(outra, boardId);
  const quadro = montar(entrou.snapshot, entrou.ops);
  assert.equal(quadro.strokes.length, 1);
  assert.equal(quadro.strokes[0].points.length, 2, 'os dois pontos entraram uma vez cada');
});

test('passar de 64 traços não apaga os primeiros', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  for (let bloco = 0; bloco < 10; bloco += 1) {
    const ops = Array.from({ length: 10 }, (_valor, indice) => traco(`t${bloco * 10 + indice}`, 10 + indice * 5, 10 + bloco * 5));
    const resposta = await desenhar(ana, boardId, ops);
    assert.equal(resposta.rejected?.length ?? 0, 0);
  }

  const bia = await entrar('Bia');
  const entrou = await entrarNaMesa(bia, boardId);
  const quadro = montar(entrou.snapshot, entrou.ops);
  assert.equal(quadro.strokes.length, 100);
  assert.equal(quadro.strokes[0].id, 't0', 'o primeiro traço continua lá depois do 64.º');
  assert.equal(quadro.strokes[63].id, 't63');
});

test('desfazer não apaga o trabalho alheio, e a borracha respeita o dono', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await entrarNaMesa(bia, boardId);
  await desenhar(ana, boardId, [traco('da-ana', 10, 10)]);
  await desenhar(bia, boardId, [traco('da-bia', 20, 20)]);

  const desfeito = await desenhar(bia, boardId, [{ id: 'u1', kind: 'undo', target: 'da-ana' }]);
  assert.equal(desfeito.accepted?.length, 0);
  assert.match(desfeito.rejected?.[0]?.error ?? '', /só para o que você mesmo desenhou/);

  const apagado = await desenhar(bia, boardId, [{ id: 'e1', kind: 'erase', targets: ['da-ana'] }]);
  assert.match(apagado.rejected?.[0]?.error ?? '', /só apaga os seus traços/);

  // Quem criou a mesa gerencia, e a borracha dela alcança o traço dos outros.
  const pelaDona = await desenhar(ana, boardId, [{ id: 'e2', kind: 'erase', targets: ['da-bia'] }]);
  assert.equal(pelaDona.accepted?.length, 1);

  const caio = await entrar('Caio');
  const entrou = await entrarNaMesa(caio, boardId);
  assert.deepEqual(montar(entrou.snapshot, entrou.ops).strokes.map((stroke) => stroke.id), ['da-ana']);
});

test('observador não desenha, e a recusa vem do servidor', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  const comoObservadora = await entrarNaMesa(bia, boardId, true);
  assert.equal(comoObservadora.role, 'observer');

  const tentativa = await desenhar(bia, boardId, [traco('t1', 10, 10)]);
  assert.equal(tentativa.ok, false);
  assert.match(tentativa.error ?? '', /observador/i);
});

test('revogar bloqueia as próximas operações de quem já estava conectado', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  const entrouBia = await entrarNaMesa(bia, boardId);
  assert.equal(entrouBia.role, 'drawer');
  assert.equal((await desenhar(bia, boardId, [traco('antes', 10, 10)])).accepted?.length, 1);

  // Quem gerencia revoga pelo id da conta, que é o que a lista de
  // participantes entrega junto com a entrada.
  const idDaBia = entrouBia.participants!.find((participante) => participante.username === 'Bia')!.userId;
  const revogado = await emit<{ ok: boolean }>(ana, 'board:manage', { boardId, action: 'revoke', value: idDaBia });
  assert.equal(revogado.ok, true);

  const depois = await desenhar(bia, boardId, [traco('depois', 20, 20)]);
  assert.equal(depois.ok, false, 'a revogação corta na operação seguinte, sem esperar uma reconexão');
  assert.match(depois.error ?? '', /observador/i);

  // E devolver a permissão volta a deixar desenhar.
  await emit(ana, 'board:manage', { boardId, action: 'restore', value: idDaBia });
  assert.equal((await desenhar(bia, boardId, [traco('devolvido', 30, 30)])).accepted?.length, 1);
});

test('bloquear a mesa impede desenho de todo mundo, menos de quem gerencia', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await entrarNaMesa(bia, boardId);
  await emit(ana, 'board:manage', { boardId, action: 'lock' });

  const recusado = await desenhar(bia, boardId, [traco('t1', 10, 10)]);
  assert.equal(recusado.ok, false);
  assert.match(recusado.error ?? '', /bloqueada/);
  assert.equal((await desenhar(ana, boardId, [traco('t2', 20, 20)])).accepted?.length, 1);
});

test('limpar tudo chega a quem reconectar depois, porque é operação com revisão', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await desenhar(ana, boardId, [traco('t1', 10, 10), traco('t2', 20, 20)]);
  await emit(ana, 'board:manage', { boardId, action: 'clear' });

  const bia = await entrar('Bia');
  const entrou = await entrarNaMesa(bia, boardId);
  assert.equal(montar(entrou.snapshot, entrou.ops).strokes.length, 0);
});

test('salvar e reabrir no dedicado preserva o conteúdo da mesa', { timeout: 90_000 }, async (context) => {
  const { entrar, reiniciar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana, 'Mapa da casa');
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await desenhar(ana, boardId, [traco('t1', 10, 10), traco('t2', 20, 20), traco('t3', 30, 30)]);
  await desenhar(ana, boardId, [{ id: 'e1', kind: 'erase', targets: ['t2'] }]);

  await reiniciar();

  const depois = await entrar('Ana');
  const lista = await emit<{ ok: boolean; boards: BoardSummary[] }>(depois, 'board:list', {});
  const mesa = lista.boards.find((board) => board.id === boardId);
  assert.ok(mesa, 'a mesa sobreviveu ao reinício do servidor');
  assert.equal(mesa!.name, 'Mapa da casa');
  const entrou = await entrarNaMesa(depois, boardId);
  const quadro = montar(entrou.snapshot, entrou.ops);
  assert.deepEqual(quadro.strokes.map((stroke) => stroke.id), ['t1', 't3'], 'o que foi apagado continua apagado, e o resto continua lá');
});

// O encerramento gracioso grava o último traço antes de sair — mas ele não
// existe em todo lugar: no Windows um processo morto por `kill` não passa por
// manipulador nenhum. Por isso a mesa vai para o disco enquanto o desenho
// acontece, e não só quando o servidor é desligado com educação. Aqui ela é
// derrubada sem cerimônia, depois da janela de coalescência que o servidor
// documenta, e o que foi desenhado continua lá.
test('a mesa chega ao disco sem depender de um encerramento gracioso', { timeout: 90_000 }, async (context) => {
  const { entrar, reiniciar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana, 'Quadro sem rede');
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await desenhar(ana, boardId, [traco('t1', 10, 10), traco('t2', 20, 20)]);

  await reiniciar(true);

  const depois = await entrar('Ana');
  const lista = await emit<{ ok: boolean; boards: BoardSummary[] }>(depois, 'board:list', {});
  const mesa = lista.boards.find((board) => board.id === boardId);
  assert.ok(mesa, 'a mesa estava em disco antes de o processo morrer');
  const entrou = await entrarNaMesa(depois, boardId);
  assert.deepEqual(montar(entrou.snapshot, entrou.ops).strokes.map((stroke) => stroke.id), ['t1', 't2']);
});

test('a mesa funciona no P2P, e a troca de host não leva o quadro embora', { timeout: 90_000 }, async (context) => {
  // No P2P quem ordena é o host — o mesmo servidor, rodando na máquina dele.
  const { entrar, reiniciar } = await ambiente(context, true);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const criada = await criar(ana, 'Rascunho da noite', 'geral');
  assert.equal(criada.ok, true, criada.error);
  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await entrarNaMesa(bia, boardId);
  assert.equal((await desenhar(bia, boardId, [traco('t1', 10, 10)])).accepted?.length, 1);
  const entrou = await entrarNaMesa(bia, boardId);
  const quadro = montar(entrou.snapshot, entrou.ops);
  assert.equal(quadro.strokes.length, 1);

  // O host caiu. O servidor que sobe no lugar dele começa vazio — no P2P nada
  // é gravado em disco, e é isso que a interface promete —, e quem estava na
  // mesa devolve o que tem.
  await reiniciar();
  const anaNoNovo = await entrar('Ana');
  const listaVazia = await emit<{ ok: boolean; boards: BoardSummary[] }>(anaNoNovo, 'board:list', {});
  assert.equal(listaVazia.boards.length, 0, 'o host novo sobe sem mesa nenhuma');

  await emit(anaNoNovo, 'voice:join', 'call-geral');
  const adotada = await emit<{ ok: boolean; error?: string; board?: BoardSummary }>(anaNoNovo, 'board:adopt', {
    board: { ...criada.board!, revoked: [], snapshot: { revision: quadro.revision, strokes: quadro.strokes } },
  });
  assert.equal(adotada.ok, true, adotada.error);
  const noNovo = await entrarNaMesa(anaNoNovo, boardId);
  assert.equal(montar(noNovo.snapshot, noNovo.ops).strokes.length, 1, 'o quadro continua de pé com o host novo');

  // E a devolução não vale para quem não está na call do grupo.
  const deFora = await entrar('Dani');
  const recusada = await emit<{ ok: boolean; error?: string }>(deFora, 'board:adopt', {
    board: { ...criada.board!, id: 'outra-mesa', revoked: [], snapshot: { revision: 1, strokes: [] } },
  });
  assert.equal(recusada.ok, false);
  assert.match(recusada.error ?? '', /call do grupo/);
});

test('um servidor dedicado não recebe mesa vinda de fora', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const criada = await criar(ana);
  const recusada = await emit<{ ok: boolean; error?: string }>(ana, 'board:adopt', {
    board: { ...criada.board!, id: 'de-outro-grupo', origin: 'p2p', revoked: [], snapshot: { revision: 3, strokes: [] } },
  });
  assert.equal(recusada.ok, false);
  assert.match(recusada.error ?? '', /dedicado não recebe/);
});

test('a mesa entra e sai da lista sem levar o desenho junto', { timeout: 60_000 }, async (context) => {
  const { entrar } = await ambiente(context);
  const ana = await entrar('Ana');
  const bia = await entrar('Bia');
  const anuncio = waitFor<{ board: BoardSummary }>(bia, 'board:announce');
  const criada = await criar(ana, 'Mesa anunciada');
  assert.equal((await anuncio).board.name, 'Mesa anunciada');

  const boardId = criada.board!.id;
  await entrarNaMesa(ana, boardId);
  await desenhar(ana, boardId, [traco('t1', 10, 10)]);
  // Sair da mesa é sair da presença, e não apagar o que foi desenhado.
  ana.emit('board:leave', { boardId });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const entrou = await entrarNaMesa(bia, boardId);
  assert.equal(montar(entrou.snapshot, entrou.ops).strokes.length, 1);
});
