// O lado do cliente da mesa de desenho.
//
// Este arquivo cuida de três coisas que não cabem no componente de tela: a
// conversa com quem ordena as operações, a fila de saída e a recuperação.
//
// **A fila de saída existe por causa da mão.** Desenhar produz dezenas de
// pontos por segundo, e mandar um pedido por ponto entupiria o caminho de
// quem está do outro lado. Os pontos são agrupados em pedaços e enviados em
// lote; cada pedaço leva um id próprio, e é por isso que reenviar depois de
// uma reconexão não desenha nada duas vezes.
//
// **A recuperação é a mesma coisa que entrar atrasado.** Quem perdeu uma
// revisão no meio e quem acabou de abrir a mesa fazem o mesmo pedido: "estou
// na revisão tal, me diga o que mudou". A resposta pode ser a diferença ou o
// quadro inteiro, e nos dois casos o resultado é o mesmo desenho.
//
// **O que é seu aparece na hora.** O traço em andamento é desenhado localmente
// enquanto a resposta não volta. Ele não é o quadro — o quadro é o que quem
// ordena confirmou —, é só a mão andando sem esperar a rede.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  applyOrderedOp,
  BOARD_CURSOR_INTERVAL_MS,
  MAX_OPS_PER_BATCH,
  type BoardCursor,
  type BoardOp,
  type BoardOpEnvelope,
  type BoardParticipant,
  type BoardRole,
  type BoardSnapshot,
  type BoardState,
  type BoardStroke,
  type BoardSummary,
} from '../../shared/whiteboard';

/** Quanto tempo o cursor de outra pessoa fica na tela sem notícias dela. */
const CURSOR_TTL_MS = 3_000;
/** Intervalo de despacho da fila. Junta a mão de um piscar de olhos em um pedido. */
const FLUSH_INTERVAL_MS = 60;

export interface BoardSession {
  board: BoardSummary;
  role: BoardRole;
  state: BoardState;
  participants: BoardParticipant[];
  cursors: BoardCursor[];
  status: 'loading' | 'ready' | 'recovering' | 'gone';
  /** O que quem ordena recusou por último, para a tela poder explicar. */
  notice: string;
}

interface JoinReply {
  ok: boolean;
  error?: string;
  board?: BoardSummary;
  role?: BoardRole;
  snapshot?: BoardSnapshot;
  ops?: BoardOpEnvelope[];
  revision?: number;
  participants?: BoardParticipant[];
}

interface SyncReply {
  ok: boolean;
  error?: string;
  board?: BoardSummary;
  mode?: 'ops' | 'snapshot';
  snapshot?: BoardSnapshot;
  ops?: BoardOpEnvelope[];
  revision?: number;
}

export interface UseBoardsOptions {
  socket: Socket | null;
  connected: boolean;
  userId: string;
  connectionMode: 'p2p' | 'server';
  /** Canal onde as mesas novas nascem — e cuja permissão a mesa herda. */
  channelId: string;
  /** Call em que esta pessoa está agora, para devolver a mesa na troca de host. */
  voiceChannelId?: string;
  onNotice: (message: string) => void;
}

export interface BoardsApi {
  boards: BoardSummary[];
  active: BoardSession | null;
  /** O traço que a mão está fazendo agora, antes de a resposta voltar. */
  draft: BoardStroke | null;
  create: (name: string) => Promise<BoardSummary | null>;
  open: (boardId: string, observer?: boolean) => void;
  close: () => void;
  refresh: () => void;
  beginStroke: (stroke: BoardStroke) => void;
  extendStroke: (points: BoardStroke['points']) => void;
  endStroke: () => void;
  erase: (strokeIds: string[]) => void;
  undo: (strokeId: string) => void;
  manage: (action: string, value?: string | boolean) => Promise<boolean>;
  moveCursor: (x: number, y: number, color: string) => void;
  dismissNotice: () => void;
}

export function useBoards(options: UseBoardsOptions): BoardsApi {
  const { socket, connected, userId, connectionMode, channelId, voiceChannelId, onNotice } = options;
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [active, setActive] = useState<BoardSession | null>(null);
  const [draft, setDraft] = useState<BoardStroke | null>(null);

  const activeIdRef = useRef<string>('');
  const revisionRef = useRef(0);
  const draftRef = useRef<BoardStroke | null>(null);
  // A fila do que ainda não foi confirmado. Ela sobrevive à reconexão de
  // propósito: o mesmo pedaço reenviado com o mesmo id é reconhecido do outro
  // lado e não vira traço dobrado.
  const queueRef = useRef<BoardOp[]>([]);
  const inFlightRef = useRef(false);
  const recoveringRef = useRef(false);
  const lastCursorRef = useRef(0);
  const observerRef = useRef(false);
  // O último quadro conhecido de cada mesa. No P2P é ele que volta para o ar
  // quando o host troca e o servidor novo sobe vazio.
  const heldRef = useRef(new Map<string, { board: BoardSummary; state: BoardState }>());
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  // A lista vem sem filtro de canal de propósito: a mesa é anunciada para quem
  // enxerga o canal dela, e quem enxerga precisa poder entrar sem antes
  // adivinhar em que canal ela nasceu. Quem decide o que aparece é o servidor.
  const refresh = useCallback(() => {
    if (!socket) return;
    socket.emit('board:list', {}, (reply: { ok: boolean; boards?: BoardSummary[] }) => {
      if (reply?.ok && Array.isArray(reply.boards)) setBoards(reply.boards);
    });
  }, [socket]);

  // Entrar na mesa é sempre o mesmo caminho: o que muda entre abrir pela
  // primeira vez e voltar depois de cair é só a revisão de onde se parte.
  const joinBoard = useCallback((boardId: string, observer: boolean) => {
    if (!socket) return;
    setActive((atual) => (atual && atual.board.id === boardId ? { ...atual, status: 'loading' } : atual));
    socket.emit('board:join', { boardId, observer }, (reply: JoinReply) => {
      if (!reply?.ok || !reply.board) {
        if (activeIdRef.current === boardId) {
          setActive((atual) => (atual ? { ...atual, status: 'gone', notice: reply?.error ?? 'Essa mesa não está mais disponível.' } : atual));
        }
        return;
      }
      const base: BoardState = { revision: reply.snapshot?.revision ?? 0, strokes: [...(reply.snapshot?.strokes ?? [])] };
      const state = applyAll(base, reply.ops ?? []);
      revisionRef.current = state.revision;
      heldRef.current.set(boardId, { board: reply.board, state });
      setActive({
        board: reply.board,
        role: reply.role ?? 'observer',
        state,
        participants: reply.participants ?? [],
        cursors: [],
        status: 'ready',
        notice: '',
      });
      setBoards((lista) => mergeBoard(lista, reply.board!));
    });
  }, [socket]);

  const open = useCallback((boardId: string, observer = false) => {
    activeIdRef.current = boardId;
    observerRef.current = observer;
    queueRef.current = [];
    draftRef.current = null;
    setDraft(null);
    joinBoard(boardId, observer);
  }, [joinBoard]);

  const close = useCallback(() => {
    const boardId = activeIdRef.current;
    activeIdRef.current = '';
    queueRef.current = [];
    draftRef.current = null;
    setDraft(null);
    setActive(null);
    if (boardId && socket) socket.emit('board:leave', { boardId });
  }, [socket]);

  // Recuperação por diferença. É o que roda quando uma revisão falta e o que
  // roda depois de reconectar — o mesmo pedido, a mesma resposta.
  const recover = useCallback(() => {
    const boardId = activeIdRef.current;
    if (!socket || !boardId || recoveringRef.current) return;
    recoveringRef.current = true;
    setActive((atual) => (atual ? { ...atual, status: 'recovering' } : atual));
    socket.emit('board:sync', { boardId, since: revisionRef.current }, (reply: SyncReply) => {
      recoveringRef.current = false;
      if (!reply?.ok) {
        // Não estar mais na mesa do outro lado é o caso normal depois de uma
        // queda longa: entrar de novo resolve, e o quadro volta inteiro.
        joinBoard(boardId, observerRef.current);
        return;
      }
      setActive((atual) => {
        if (!atual || atual.board.id !== boardId) return atual;
        const base = reply.mode === 'snapshot' && reply.snapshot
          ? { revision: reply.snapshot.revision, strokes: [...reply.snapshot.strokes] }
          : atual.state;
        const state = applyAll(base, reply.ops ?? []);
        revisionRef.current = state.revision;
        heldRef.current.set(boardId, { board: reply.board ?? atual.board, state });
        return { ...atual, board: reply.board ?? atual.board, state, status: 'ready' };
      });
    });
  }, [joinBoard, socket]);

  // --- o que chega pelo fio -------------------------------------------------
  useEffect(() => {
    if (!socket) return;
    const onAnnounce = (payload: { board?: BoardSummary; restored?: boolean }) => {
      if (!payload?.board) return;
      setBoards((lista) => mergeBoard(lista, payload.board!));
      if (payload.board.createdBy === userId || payload.restored) return;
      noticeRef.current(`${payload.board.createdByName} abriu a mesa “${payload.board.name}”.`);
    };
    const onUpdated = (payload: { board?: BoardSummary }) => {
      if (!payload?.board) return;
      setBoards((lista) => mergeBoard(lista, payload.board!));
      setActive((atual) => (atual && atual.board.id === payload.board!.id ? { ...atual, board: payload.board! } : atual));
    };
    const onOps = (payload: { boardId?: string; ops?: BoardOpEnvelope[] }) => {
      if (!payload?.boardId || payload.boardId !== activeIdRef.current || !Array.isArray(payload.ops)) return;
      let faltou = false;
      setActive((atual) => {
        if (!atual || atual.board.id !== payload.boardId) return atual;
        let state = atual.state;
        for (const envelope of [...payload.ops!].sort((first, second) => first.rev - second.rev)) {
          const outcome = applyOrderedOp(state, envelope);
          if (outcome.status === 'gap') { faltou = true; break; }
          // Uma recusa vinda do fio não pode travar a sequência: a revisão
          // avança, e o desenho fica como estava.
          if (outcome.status === 'applied' || outcome.status === 'refused') state = outcome.state;
        }
        if (state === atual.state) return atual;
        revisionRef.current = state.revision;
        heldRef.current.set(atual.board.id, { board: atual.board, state });
        return { ...atual, state };
      });
      if (faltou) recover();
    };
    const onState = (payload: { board?: BoardSummary; participants?: BoardParticipant[] }) => {
      if (!payload?.board) return;
      setBoards((lista) => mergeBoard(lista, payload.board!));
      setActive((atual) => {
        if (!atual || atual.board.id !== payload.board!.id) return atual;
        const eu = (payload.participants ?? atual.participants).find((participante) => participante.userId === userId);
        return { ...atual, board: payload.board!, participants: payload.participants ?? atual.participants, role: eu?.role ?? atual.role };
      });
    };
    const onParticipants = (payload: { boardId?: string; participants?: BoardParticipant[] }) => {
      setActive((atual) => {
        if (!atual || atual.board.id !== payload?.boardId) return atual;
        const eu = (payload.participants ?? []).find((participante) => participante.userId === userId);
        return { ...atual, participants: payload.participants ?? [], role: eu?.role ?? atual.role };
      });
    };
    const onCursor = (payload: { boardId?: string; cursor?: BoardCursor }) => {
      if (!payload?.cursor || payload.boardId !== activeIdRef.current) return;
      setActive((atual) => {
        if (!atual) return atual;
        const agora = Date.now();
        const outros = atual.cursors.filter((cursor) => cursor.socketId !== payload.cursor!.socketId && agora - cursor.at < CURSOR_TTL_MS);
        return { ...atual, cursors: [...outros, { ...payload.cursor!, at: agora }] };
      });
    };
    // Um pedido em voo quando a conexão cai nunca recebe resposta. Sem soltar
    // esta trava, a fila ficaria parada para sempre e a mesa deixaria de
    // aceitar traço até a pessoa recarregar o aplicativo.
    const onDisconnect = () => { inFlightRef.current = false; };
    const onClosed = (payload: { boardId?: string; reason?: string }) => {
      if (!payload?.boardId) return;
      heldRef.current.delete(payload.boardId);
      setBoards((lista) => lista.filter((board) => board.id !== payload.boardId));
      if (payload.boardId !== activeIdRef.current) return;
      setActive((atual) => (atual ? { ...atual, status: 'gone', notice: payload.reason ?? 'Esta mesa foi encerrada.' } : atual));
    };
    socket.on('board:announce', onAnnounce);
    socket.on('board:updated', onUpdated);
    socket.on('board:ops', onOps);
    socket.on('board:state', onState);
    socket.on('board:participants', onParticipants);
    socket.on('board:cursor', onCursor);
    socket.on('board:closed', onClosed);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('board:announce', onAnnounce);
      socket.off('board:updated', onUpdated);
      socket.off('board:ops', onOps);
      socket.off('board:state', onState);
      socket.off('board:participants', onParticipants);
      socket.off('board:cursor', onCursor);
      socket.off('board:closed', onClosed);
      socket.off('disconnect', onDisconnect);
    };
  }, [recover, socket, userId]);

  // --- reconexão e troca de host --------------------------------------------
  useEffect(() => {
    if (!socket || !connected) return;
    refresh();
    // No P2P, o servidor que ordena é a máquina do host. Quando o host sai, o
    // servidor novo sobe vazio — e quem estava na mesa devolve o que tem. A
    // devolução é recusada por um servidor dedicado e por um canal diferente;
    // aqui a tentativa é barata e o pior caso é um "já está aqui".
    if (connectionMode === 'p2p' && voiceChannelId) {
      for (const guardada of heldRef.current.values()) {
        // Mesa vazia não vale uma devolução: ela não tem conteúdo a salvar, e
        // recriar uma folha em branco é um clique.
        if (!guardada.state.strokes.length) continue;
        socket.emit('board:adopt', {
          board: {
            ...guardada.board,
            revoked: [],
            snapshot: { revision: guardada.state.revision, strokes: guardada.state.strokes },
          },
        }, (reply: { ok: boolean }) => {
          if (reply?.ok) refresh();
        });
      }
    }
    if (activeIdRef.current) {
      // Entrar de novo devolve a presença e o papel; a diferença do quadro vem
      // logo depois, a partir da revisão que já se tem.
      joinBoard(activeIdRef.current, observerRef.current);
    }
  }, [connected, connectionMode, joinBoard, refresh, socket, voiceChannelId]);

  // --- fila de saída ---------------------------------------------------------
  useEffect(() => {
    if (!socket) return;
    const timer = window.setInterval(() => {
      if (inFlightRef.current || !queueRef.current.length || !activeIdRef.current || !socket.connected) return;
      const lote = queueRef.current.slice(0, MAX_OPS_PER_BATCH);
      inFlightRef.current = true;
      socket.emit('board:ops', { boardId: activeIdRef.current, ops: lote }, (reply: { ok: boolean; retry?: boolean; error?: string; rejected?: Array<{ id: string; error: string }> }) => {
        inFlightRef.current = false;
        if (!reply?.ok) {
          // "Espere um instante" deixa os pedaços na fila: eles voltam com os
          // mesmos ids, e o outro lado sabe reconhecê-los. Perder o traço de
          // quem desenhou rápido demais seria apagar trabalho por causa de um
          // limite de vazão.
          if (reply?.retry) return;
          // Qualquer outra recusa é definitiva — mesa encerrada, permissão
          // revogada, observador. Insistir só repetiria a mesma resposta.
          queueRef.current = [];
          draftRef.current = null;
          setDraft(null);
          if (reply?.error) setActive((atual) => (atual ? { ...atual, notice: reply.error! } : atual));
          return;
        }
        const enviados = new Set(lote.map((op) => op.id));
        queueRef.current = queueRef.current.filter((op) => !enviados.has(op.id));
        const recusa = reply.rejected?.[0];
        if (recusa) {
          draftRef.current = null;
          setDraft(null);
          setActive((atual) => (atual ? { ...atual, notice: recusa.error } : atual));
        }
      });
    }, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [socket]);

  // O traço local some quando o quadro confirmado já o contém por inteiro.
  useEffect(() => {
    if (!draft || !active) return;
    const confirmado = active.state.strokes.find((stroke) => stroke.id === draft.id);
    if (confirmado && confirmado.points.length >= draft.points.length && !queueRef.current.length) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [active, draft]);

  // Cursor alheio é enfeite com prazo: sem notícias da pessoa, ele sai da tela.
  useEffect(() => {
    if (!active?.cursors.length) return;
    const timer = window.setInterval(() => {
      const agora = Date.now();
      setActive((atual) => {
        if (!atual?.cursors.length) return atual;
        const vivos = atual.cursors.filter((cursor) => agora - cursor.at < CURSOR_TTL_MS);
        return vivos.length === atual.cursors.length ? atual : { ...atual, cursors: vivos };
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [active?.cursors.length]);

  const create = useCallback((name: string) => new Promise<BoardSummary | null>((resolve) => {
    if (!socket) return resolve(null);
    socket.emit('board:create', { channelId, name }, (reply: { ok: boolean; error?: string; board?: BoardSummary }) => {
      if (!reply?.ok || !reply.board) {
        noticeRef.current(reply?.error ?? 'Não foi possível criar a mesa.');
        return resolve(null);
      }
      setBoards((lista) => mergeBoard(lista, reply.board!));
      resolve(reply.board);
    });
  }), [channelId, socket]);

  const enqueue = useCallback((op: BoardOp) => {
    queueRef.current.push(op);
  }, []);

  const beginStroke = useCallback((stroke: BoardStroke) => {
    draftRef.current = stroke;
    setDraft(stroke);
    enqueue({ id: `${stroke.id}@0`, kind: 'stroke', stroke: stroke.id, color: stroke.color, width: stroke.width, points: stroke.points });
  }, [enqueue]);

  const extendStroke = useCallback((points: BoardStroke['points']) => {
    const atual = draftRef.current;
    if (!atual || !points.length) return;
    const proximo = { ...atual, points: [...atual.points, ...points] };
    draftRef.current = proximo;
    setDraft(proximo);
    enqueue({ id: `${atual.id}@${proximo.points.length}`, kind: 'stroke', stroke: atual.id, color: atual.color, width: atual.width, points });
  }, [enqueue]);

  const endStroke = useCallback(() => {
    const atual = draftRef.current;
    if (!atual) return;
    // O último pedaço marca o fim do traço. Ele vai mesmo sem pontos novos
    // porque é ele que diz "a caneta levantou" para quem está assistindo.
    enqueue({ id: `${atual.id}@fim`, kind: 'stroke', stroke: atual.id, color: atual.color, width: atual.width, points: atual.points.slice(-1), done: true });
  }, [enqueue]);

  const erase = useCallback((strokeIds: string[]) => {
    if (!strokeIds.length) return;
    enqueue({ id: `apagar-${crypto.randomUUID()}`, kind: 'erase', targets: strokeIds.slice(0, 64) });
  }, [enqueue]);

  const undo = useCallback((strokeId: string) => {
    enqueue({ id: `desfazer-${crypto.randomUUID()}`, kind: 'undo', target: strokeId });
  }, [enqueue]);

  const manage = useCallback((action: string, value?: string | boolean) => new Promise<boolean>((resolve) => {
    const boardId = activeIdRef.current;
    if (!socket || !boardId) return resolve(false);
    socket.emit('board:manage', { boardId, action, value }, (reply: { ok: boolean; error?: string }) => {
      if (!reply?.ok) noticeRef.current(reply?.error ?? 'Não foi possível fazer isso agora.');
      resolve(Boolean(reply?.ok));
    });
  }), [socket]);

  const moveCursor = useCallback((x: number, y: number, color: string) => {
    const agora = Date.now();
    if (!socket || !activeIdRef.current || agora - lastCursorRef.current < BOARD_CURSOR_INTERVAL_MS) return;
    lastCursorRef.current = agora;
    socket.emit('board:cursor', { boardId: activeIdRef.current, x, y, color });
  }, [socket]);

  const dismissNotice = useCallback(() => {
    setActive((atual) => (atual && atual.notice ? { ...atual, notice: '' } : atual));
  }, []);

  useEffect(() => () => { activeIdRef.current = ''; }, []);

  return useMemo(() => ({
    boards,
    active,
    draft,
    create,
    open,
    close,
    refresh,
    beginStroke,
    extendStroke,
    endStroke,
    erase,
    undo,
    manage,
    moveCursor,
    dismissNotice,
  }), [active, beginStroke, boards, close, create, dismissNotice, draft, endStroke, erase, extendStroke, manage, moveCursor, open, refresh, undo]);
}

function applyAll(base: BoardState, ops: readonly BoardOpEnvelope[]): BoardState {
  let state = base;
  for (const envelope of [...ops].sort((first, second) => first.rev - second.rev)) {
    const outcome = applyOrderedOp(state, envelope);
    if (outcome.status === 'applied' || outcome.status === 'refused') state = outcome.state;
  }
  return state;
}

function mergeBoard(boards: readonly BoardSummary[], board: BoardSummary): BoardSummary[] {
  const semArquivada = board.status === 'archived' ? boards.filter((candidate) => candidate.id !== board.id) : null;
  if (semArquivada) return semArquivada;
  const indice = boards.findIndex((candidate) => candidate.id === board.id);
  if (indice < 0) return [board, ...boards];
  const proximos = [...boards];
  proximos[indice] = board;
  return proximos;
}
