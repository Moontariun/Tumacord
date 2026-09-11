// O serviço que ordena as mesas de desenho.
//
// Uma mesa compartilhada precisa de alguém que decida a ordem das operações.
// Sem isso, duas pessoas desenhando ao mesmo tempo terminam com dois quadros
// diferentes e nenhum jeito de saber qual é o certo. Aqui esse alguém é o
// servidor da sessão: no dedicado ele é a instalação; no P2P ele é o host, que
// é o mesmo processo rodando na máquina de quem abriu a call.
//
// O que ele guarda por mesa é um snapshot em uma revisão conhecida, mais as
// operações que vieram depois. Quem entra recebe o snapshot e aplica o resto;
// quem reconecta diz até onde chegou e recebe só a diferença. As duas coisas
// saem do mesmo par, e é por isso que entrar atrasado e reconectar não são
// dois caminhos de código diferentes.
//
// Nada aqui apaga desenho para caber. Compactar troca *histórico* por
// snapshot, nunca traço por espaço, e o teto de traços recusa a operação nova
// com uma mensagem em vez de derrubar em silêncio o que já estava na folha.

import { randomUUID } from 'node:crypto';
import {
  applyBoardOp,
  boardSnapshot,
  canManageBoard,
  compactBoardLog,
  countBoardPoints,
  emptyBoardState,
  normalizeBoardName,
  recoverBoard,
  replayBoard,
  roleFor,
  roleMayDraw,
  MAX_BOARDS_PER_CHANNEL,
  MAX_OPS_PER_BATCH,
  type BoardActor,
  type BoardOp,
  type BoardOpEnvelope,
  type BoardParticipant,
  type BoardRecovery,
  type BoardRole,
  type BoardSnapshot,
  type BoardState,
  type BoardStatus,
  type BoardSummary,
} from '../shared/whiteboard.js';

/** Teto global de mesas por instalação, para o arquivo não crescer sem fim. */
export const MAX_BOARDS = 64;
/** Ids de operação lembrados por mesa, para a retentativa não virar traço duplo. */
const SEEN_LIMIT = 4_096;
/** Mesas excluídas lembradas. É o que impede uma delas de voltar do nada. */
export const TOMBSTONE_LIMIT = 512;

/** A mesa como ela vai para o disco. Sem participantes: eles morrem com o processo. */
export interface StoredBoard {
  id: string;
  name: string;
  channelId: string;
  origin: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  status: BoardStatus;
  locked: boolean;
  allowObservers: boolean;
  /** Contas que perderam a permissão de desenhar nesta mesa. */
  revoked: string[];
  snapshot: BoardSnapshot;
  log: BoardOpEnvelope[];
}

interface LiveBoard extends StoredBoard {
  state: BoardState;
  participants: Map<string, BoardParticipant>;
  seen: Set<string>;
  seenOrder: string[];
}

export interface CreateBoardInput {
  channelId: string;
  name: unknown;
  origin: string;
  actor: BoardActor;
}

export type BoardOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SubmitResult {
  accepted: BoardOpEnvelope[];
  rejected: Array<{ id: string; error: string }>;
  revision: number;
}

export interface JoinResult {
  board: BoardSummary;
  role: BoardRole;
  snapshot: BoardSnapshot;
  ops: BoardOpEnvelope[];
  revision: number;
  participants: BoardParticipant[];
}

export type ManageAction = 'lock' | 'unlock' | 'observers' | 'clear' | 'close' | 'reopen' | 'archive' | 'rename' | 'revoke' | 'restore' | 'delete';

export class Whiteboards {
  private readonly boards = new Map<string, LiveBoard>();
  // Mesas excluídas.
  //
  // Excluir precisa ser definitivo, e "definitivo" tem um inimigo: a mesa pode
  // voltar de fora. Um cliente que estava desenhando quando a exclusão
  // aconteceu ainda tem o quadro na memória, e no P2P ele devolve o que tem
  // quando o host troca. Sem uma lápide, a mesa excluída reapareceria inteira
  // na primeira troca de host — e quem a excluiu não teria como saber por quê.
  private readonly tombstones = new Set<string>();
  private tombstoneOrder: string[] = [];

  constructor(private readonly onChange: (board: StoredBoard) => void = () => undefined, private readonly onDelete: (boardId: string, tombstones: readonly string[]) => void = () => undefined) {}

  /** Uma mesa que foi excluída não volta — nem por adoção, nem por reconexão. */
  wasDeleted(boardId: string): boolean {
    return this.tombstones.has(boardId);
  }

  get deletedBoards(): readonly string[] {
    return this.tombstoneOrder;
  }

  private rememberDeletion(boardId: string): void {
    if (this.tombstones.has(boardId)) return;
    this.tombstones.add(boardId);
    this.tombstoneOrder.push(boardId);
    // A lista tem teto: a mais antiga sai primeiro. Uma mesa excluída há
    // quinhentas exclusões já não tem ninguém segurando uma cópia dela.
    while (this.tombstoneOrder.length > TOMBSTONE_LIMIT) {
      const antiga = this.tombstoneOrder.shift();
      if (antiga) this.tombstones.delete(antiga);
    }
  }

  create(input: CreateBoardInput): BoardOutcome<BoardSummary> {
    // Arquivar libera a vaga *do canal*, porque o limite por canal conta só as
    // abertas — mas não libera esta, que conta tudo o que ocupa disco. Dizer
    // "arquive" aqui mandaria a pessoa fazer algo que não resolve.
    if (this.boards.size >= MAX_BOARDS) return { ok: false, error: `Este servidor já tem ${MAX_BOARDS} mesas, contando as arquivadas. Exclua alguma antes de criar outra.` };
    const noCanal = [...this.boards.values()].filter((board) => board.channelId === input.channelId && board.status === 'open');
    if (noCanal.length >= MAX_BOARDS_PER_CHANNEL) {
      return { ok: false, error: `Este canal já tem ${MAX_BOARDS_PER_CHANNEL} mesas abertas. Encerre ou arquive alguma antes de criar outra.` };
    }
    const agora = new Date().toISOString();
    const board: LiveBoard = {
      id: randomUUID(),
      name: normalizeBoardName(input.name),
      channelId: input.channelId,
      origin: input.origin,
      createdBy: input.actor.userId,
      createdByName: input.actor.username,
      createdAt: agora,
      updatedAt: agora,
      status: 'open',
      locked: false,
      allowObservers: true,
      revoked: [],
      snapshot: { revision: 0, strokes: [] },
      log: [],
      state: emptyBoardState(),
      participants: new Map(),
      seen: new Set(),
      seenOrder: [],
    };
    this.boards.set(board.id, board);
    this.onChange(stored(board));
    return { ok: true, value: this.summary(board) };
  }

  get(boardId: string): LiveBoard | undefined {
    return this.boards.get(boardId);
  }

  /** As mesas que este canal mostra. Arquivada não aparece na lista do dia a dia. */
  list(channelIds: readonly string[], includeArchived = false): BoardSummary[] {
    return [...this.boards.values()]
      .filter((board) => channelIds.includes(board.channelId) && (includeArchived || board.status !== 'archived'))
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .map((board) => this.summary(board));
  }

  summary(board: LiveBoard): BoardSummary {
    return {
      id: board.id,
      name: board.name,
      channelId: board.channelId,
      origin: board.origin,
      createdBy: board.createdBy,
      createdByName: board.createdByName,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      status: board.status,
      locked: board.locked,
      allowObservers: board.allowObservers,
      revision: board.state.revision,
      strokes: board.state.strokes.length,
      points: countBoardPoints(board.state.strokes),
      participants: board.participants.size,
    };
  }

  roleOf(board: LiveBoard, actor: BoardActor): BoardRole {
    return roleFor(board, actor, board.revoked.includes(actor.userId));
  }

  join(boardId: string, socketId: string, actor: BoardActor, asObserver = false): BoardOutcome<JoinResult> {
    const board = this.boards.get(boardId);
    if (!board) return { ok: false, error: 'Essa mesa não existe mais.' };
    let role = this.roleOf(board, actor);
    if (asObserver && role !== 'manager') role = 'observer';
    if (role === 'observer' && !board.allowObservers && !canManageBoard(board, actor)) {
      return { ok: false, error: 'Esta mesa não está aceitando observadores.' };
    }
    board.participants.set(socketId, { socketId, userId: actor.userId, username: actor.username, role });
    return {
      ok: true,
      value: {
        board: this.summary(board),
        role,
        // Quem entra recebe o snapshot na revisão em que ele foi tirado e as
        // operações posteriores juntas, no mesmo pacote. Aplicar as duas
        // coisas de uma vez é o que faz o quadro de quem chega no meio do
        // desenho ser o mesmo de quem já estava lá.
        snapshot: board.snapshot,
        ops: board.log.filter((envelope) => envelope.rev > board.snapshot.revision),
        revision: board.state.revision,
        participants: [...board.participants.values()],
      },
    };
  }

  leave(socketId: string): LiveBoard[] {
    const saiu: LiveBoard[] = [];
    for (const board of this.boards.values()) {
      if (board.participants.delete(socketId)) saiu.push(board);
    }
    return saiu;
  }

  participants(boardId: string): BoardParticipant[] {
    return [...(this.boards.get(boardId)?.participants.values() ?? [])];
  }

  mayDraw(board: LiveBoard, socketId: string, actor: BoardActor): { ok: boolean; error?: string } {
    if (board.status !== 'open') return { ok: false, error: board.status === 'archived' ? 'Esta mesa foi arquivada.' : 'Esta mesa foi encerrada.' };
    // O papel guardado no participante é o que vale enquanto ele está aqui: é
    // ele que a revogação troca, e é por isso que revogar corta na hora quem
    // já estava conectado, sem depender de o cliente cooperar.
    const participante = board.participants.get(socketId);
    const role = participante?.role ?? this.roleOf(board, actor);
    if (board.locked && role !== 'manager') return { ok: false, error: 'Esta mesa está bloqueada para novos desenhos.' };
    if (!roleMayDraw(role)) return { ok: false, error: 'Você está nesta mesa como observador.' };
    return { ok: true };
  }

  // O ponto onde a ordem acontece.
  //
  // Cada operação aceita recebe o próximo número, e só ela. Recusa não gasta
  // número — é isso que mantém a sequência densa e permite que quem recebe
  // detecte lacuna por comparação simples.
  submit(boardId: string, socketId: string, actor: BoardActor, ops: readonly BoardOp[]): BoardOutcome<SubmitResult> {
    const board = this.boards.get(boardId);
    if (!board) return { ok: false, error: 'Essa mesa não existe mais.' };
    const permitido = this.mayDraw(board, socketId, actor);
    if (!permitido.ok) return { ok: false, error: permitido.error ?? 'Você não pode desenhar nesta mesa.' };
    if (ops.length > MAX_OPS_PER_BATCH) return { ok: false, error: `Pedido grande demais: no máximo ${MAX_OPS_PER_BATCH} operações por vez.` };
    const manager = this.roleOf(board, actor) === 'manager';
    const accepted: BoardOpEnvelope[] = [];
    const rejected: Array<{ id: string; error: string }> = [];
    for (const op of ops) {
      // A retentativa de quem reconectou sem saber se o pedido chegou traz a
      // mesma operação de novo, com o mesmo id. Ela é tratada como aceita e
      // não desenha nada pela segunda vez.
      if (board.seen.has(op.id)) continue;
      const envelope: BoardOpEnvelope = {
        id: op.id,
        rev: board.state.revision + 1,
        author: actor.userId,
        authorName: actor.username,
        at: Date.now(),
        op,
      };
      const outcome = applyBoardOp(board.state, envelope, { manager });
      if (outcome.status !== 'applied') {
        // `refused` devolve um estado com a revisão avançada para o cliente
        // não travar; aqui ele é ignorado de propósito — nada foi carimbado.
        rejected.push({ id: op.id, error: outcome.status === 'refused' ? outcome.error : 'Operação fora de ordem.' });
        continue;
      }
      board.state = outcome.state;
      board.log.push(envelope);
      this.remember(board, op.id);
      accepted.push(envelope);
    }
    if (accepted.length) {
      board.updatedAt = new Date().toISOString();
      const compactado = compactBoardLog(board.snapshot, board.log);
      board.snapshot = compactado.snapshot;
      board.log = compactado.log;
      this.onChange(stored(board));
    }
    return { ok: true, value: { accepted, rejected, revision: board.state.revision } };
  }

  recover(boardId: string, since: number): BoardOutcome<BoardRecovery> {
    const board = this.boards.get(boardId);
    if (!board) return { ok: false, error: 'Essa mesa não existe mais.' };
    return { ok: true, value: recoverBoard(board.snapshot, board.log, Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0) };
  }

  manage(boardId: string, actor: BoardActor, action: ManageAction, value?: unknown): BoardOutcome<{ board: BoardSummary; op?: BoardOpEnvelope; revoked?: string; deleted?: boolean }> {
    const board = this.boards.get(boardId);
    if (!board) return { ok: false, error: 'Essa mesa não existe mais.' };
    if (!canManageBoard(board, actor)) return { ok: false, error: 'Só quem criou a mesa ou administra o servidor pode fazer isso.' };
    let op: BoardOpEnvelope | undefined;
    let revoked: string | undefined;
    // A exclusão é a única ação que devolve o retrato de algo que já não
    // existe: quem chama precisa do nome da mesa para poder dizer o que sumiu.
    if (action === 'delete') {
      const retrato = this.summary(board);
      this.boards.delete(boardId);
      this.rememberDeletion(boardId);
      this.onDelete(boardId, this.tombstoneOrder);
      return { ok: true, value: { board: retrato, deleted: true } };
    }
    switch (action) {
      case 'lock': board.locked = true; break;
      case 'unlock': board.locked = false; break;
      case 'observers': board.allowObservers = value !== false; break;
      case 'close': board.status = 'closed'; break;
      case 'reopen': board.status = 'open'; break;
      // Arquivar preserva o conteúdo: a mesa sai da lista do dia a dia e
      // continua inteira no arquivo do servidor dedicado.
      case 'archive': board.status = 'archived'; break;
      case 'rename': board.name = normalizeBoardName(value); break;
      case 'clear': {
        // Limpar tudo é uma operação como qualquer outra: ganha revisão, entra
        // no histórico e chega a todo mundo pelo mesmo caminho. Fora do
        // histórico ela seria invisível para quem reconectasse depois.
        const opId = randomUUID();
        const envelope: BoardOpEnvelope = {
          id: opId,
          rev: board.state.revision + 1,
          author: actor.userId,
          authorName: actor.username,
          at: Date.now(),
          op: { id: opId, kind: 'clear' },
        };
        const outcome = applyBoardOp(board.state, envelope, { manager: true });
        if (outcome.status !== 'applied') return { ok: false, error: 'Não foi possível limpar a mesa agora.' };
        board.state = outcome.state;
        board.log.push(envelope);
        this.remember(board, opId);
        op = envelope;
        break;
      }
      case 'revoke':
      case 'restore': {
        const alvo = typeof value === 'string' ? value : '';
        if (!alvo) return { ok: false, error: 'Informe quem perde ou recupera a permissão.' };
        if (alvo === board.createdBy) return { ok: false, error: 'Quem criou a mesa não perde a permissão de desenhar nela.' };
        board.revoked = action === 'revoke'
          ? [...new Set([...board.revoked, alvo])]
          : board.revoked.filter((candidate) => candidate !== alvo);
        // O papel de quem já está conectado muda agora, e não no próximo
        // `join`: revogar tem de bloquear a operação seguinte, não a próxima
        // sessão.
        for (const participante of board.participants.values()) {
          if (participante.userId !== alvo) continue;
          participante.role = action === 'revoke' ? 'observer' : (board.locked ? 'observer' : 'drawer');
        }
        revoked = alvo;
        break;
      }
    }
    board.updatedAt = new Date().toISOString();
    // Bloquear a mesa rebaixa quem desenhava; desbloquear devolve, menos para
    // quem teve a permissão revogada individualmente.
    if (action === 'lock' || action === 'unlock') {
      for (const participante of board.participants.values()) {
        if (participante.role === 'manager') continue;
        participante.role = board.locked || board.revoked.includes(participante.userId) ? 'observer' : 'drawer';
      }
    }
    this.onChange(stored(board));
    return { ok: true, value: { board: this.summary(board), op, revoked } };
  }

  remove(boardId: string): boolean {
    return this.boards.delete(boardId);
  }

  /** As mesas de um canal que deixou de existir saem junto com ele. */
  removeChannel(channelId: string): string[] {
    const removidas: string[] = [];
    for (const [id, board] of this.boards) {
      if (board.channelId !== channelId) continue;
      this.boards.delete(id);
      removidas.push(id);
    }
    return removidas;
  }

  // Adoção de mesa na troca de host, no P2P.
  //
  // Quando o host sai, a sinalização muda de máquina e o novo servidor sobe
  // vazio. Quem estava na mesa devolve o que tem, e a mesa continua enquanto o
  // grupo continuar. A adoção é recusada se a mesa já existe aqui — o primeiro
  // que chegar manda, e os demais viram reentrega — e recusada se a origem for
  // outra: conteúdo de um grupo não atravessa para outro.
  adopt(input: StoredBoard, origin: string): BoardOutcome<BoardSummary> {
    // A primeira pergunta é se ela foi excluída: devolver uma mesa que alguém
    // apagou de propósito é desfazer a decisão dessa pessoa em silêncio.
    if (this.tombstones.has(input.id)) return { ok: false, error: 'Essa mesa foi excluída.' };
    if (input.origin !== origin) return { ok: false, error: 'Essa mesa é de outro grupo.' };
    if (this.boards.has(input.id)) return { ok: false, error: 'Esta mesa já está aqui.' };
    if (this.boards.size >= MAX_BOARDS) return { ok: false, error: 'Não há espaço para mais mesas neste servidor.' };
    const board = this.hydrate(input);
    this.boards.set(board.id, board);
    this.onChange(stored(board));
    return { ok: true, value: this.summary(board) };
  }

  /** O que vai para o disco do servidor dedicado. */
  toStored(): StoredBoard[] {
    return [...this.boards.values()].map((board) => stored(board));
  }

  /** O que volta do disco quando o servidor sobe, exclusões inclusive. */
  load(boards: readonly StoredBoard[], deleted: readonly string[] = []): void {
    this.boards.clear();
    this.tombstones.clear();
    this.tombstoneOrder = [];
    for (const boardId of deleted.slice(-TOMBSTONE_LIMIT)) this.rememberDeletion(boardId);
    for (const board of boards.slice(0, MAX_BOARDS)) {
      if (this.tombstones.has(board.id)) continue;
      const vivo = this.hydrate(board);
      this.boards.set(vivo.id, vivo);
    }
  }

  private hydrate(input: StoredBoard): LiveBoard {
    const snapshot: BoardSnapshot = { revision: input.snapshot?.revision ?? 0, strokes: input.snapshot?.strokes ?? [] };
    const log = [...(input.log ?? [])].sort((first, second) => first.rev - second.rev);
    const state: BoardState = replayBoard(snapshot, log);
    const board: LiveBoard = {
      ...input,
      revoked: [...(input.revoked ?? [])],
      snapshot,
      log,
      state,
      participants: new Map(),
      seen: new Set(),
      seenOrder: [],
    };
    for (const envelope of log.slice(-SEEN_LIMIT)) this.remember(board, envelope.id);
    return board;
  }

  private remember(board: LiveBoard, opId: string): void {
    if (board.seen.has(opId)) return;
    board.seen.add(opId);
    board.seenOrder.push(opId);
    while (board.seenOrder.length > SEEN_LIMIT) {
      const antigo = board.seenOrder.shift();
      if (antigo) board.seen.delete(antigo);
    }
  }
}

function stored(board: LiveBoard): StoredBoard {
  return {
    id: board.id,
    name: board.name,
    channelId: board.channelId,
    origin: board.origin,
    createdBy: board.createdBy,
    createdByName: board.createdByName,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    status: board.status,
    locked: board.locked,
    allowObservers: board.allowObservers,
    revoked: [...board.revoked],
    // Vai para o disco o snapshot mais o histórico posterior, e não o estado
    // pronto: remontar na subida é barato, e guardar as duas coisas em
    // paralelo abriria espaço para elas discordarem uma da outra.
    snapshot: boardSnapshot(board.snapshot),
    log: [...board.log],
  };
}
