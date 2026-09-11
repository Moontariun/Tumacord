// A mesa na tela.
//
// Ela mora dentro do app — não é janela sobreposta ao jogo nem camada sobre a
// live —, e por isso funciona igual no Linux e no Windows, com ou sem call
// aberta. O que este arquivo faz é traduzir mão em operação e operação em
// pixel; a conversa com quem ordena mora em `src/lib/boards.ts`.
//
// Zoom e deslocamento são só daqui. Mexer no seu zoom não mexe na visão de
// mais ninguém: a folha tem coordenadas próprias, e cada pessoa olha para ela
// de onde quiser.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Icon } from './Icon';
import { downloadBlob } from '../lib/chatSync';
import {
  BOARD_COLORS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_WIDTHS,
  DEFAULT_BOARD_WIDTH,
  MIN_BOARD_POINT_DISTANCE,
  boardPointsAreFarEnough,
  documentToView,
  fitBoard,
  roleMayDraw,
  strokeAt,
  viewToDocument,
  zoomAround,
  type BoardPoint,
  type BoardStroke,
  type BoardView,
} from '../../shared/whiteboard';
import type { BoardSession, BoardsApi } from '../lib/boards';

/** O fundo da folha. Ele vai junto na exportação: o traço claro precisa dele. */
const BOARD_BACKGROUND = '#181a1f';
const BOARD_GRID = 'rgba(255,255,255,.045)';

type Tool = 'pen' | 'eraser' | 'hand';

export function Whiteboard({ session, api, currentUserId, connectionMode, onNotice, onClose }: {
  session: BoardSession;
  api: BoardsApi;
  currentUserId: string;
  connectionMode: 'p2p' | 'server';
  onNotice: (message: string) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(BOARD_COLORS[0]);
  const [width, setWidth] = useState<number>(DEFAULT_BOARD_WIDTH);
  const [view, setView] = useState<BoardView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pausado, setPausado] = useState(() => document.visibilityState === 'hidden');
  const traco = useRef<{ id: string; ultimo: BoardPoint; pendentes: BoardPoint[] } | null>(null);
  const arrasto = useRef<{ x: number; y: number; view: BoardView } | null>(null);
  const apagados = useRef(new Set<string>());
  const ajustado = useRef(false);

  const { board, state, role, participants, cursors, status, notice } = session;
  const podeDesenhar = roleMayDraw(role) && board.status === 'open' && (!board.locked || role === 'manager');
  const gerencia = role === 'manager';
  const meusTracos = useMemo(() => state.strokes.filter((stroke) => stroke.author === currentUserId), [currentUserId, state.strokes]);

  // Fora da vista, a mesa para de pintar e de mandar cursor. O que continua é
  // a sincronização: voltar para a aba não pode significar um quadro velho.
  useEffect(() => {
    const alternar = () => setPausado(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', alternar);
    return () => document.removeEventListener('visibilitychange', alternar);
  }, []);

  // A folha inteira na tela, uma vez, quando a mesa abre. Depois disso o zoom
  // é de quem está olhando, e mexer nele por conta própria seria arrancar a
  // visão da pessoa do lugar onde ela a deixou.
  useEffect(() => {
    const area = host.current;
    if (!area || ajustado.current) return;
    const caixa = area.getBoundingClientRect();
    if (caixa.width < 2 || caixa.height < 2) return;
    ajustado.current = true;
    setView(fitBoard(caixa.width, caixa.height));
  }, [status]);

  const medir = useCallback(() => host.current?.getBoundingClientRect() ?? null, []);

  const pontoDoEvento = useCallback((event: { clientX: number; clientY: number }): BoardPoint | null => {
    const caixa = medir();
    if (!caixa) return null;
    return viewToDocument(event.clientX - caixa.left, event.clientY - caixa.top, view);
  }, [medir, view]);

  // Repintar é caro demais para acontecer a cada render do React sem motivo:
  // aqui ele acontece quando o quadro, o traço em andamento ou a visão mudam.
  useEffect(() => {
    const tela = canvas.current;
    const area = host.current;
    if (!tela || !area || pausado) return;
    const caixa = area.getBoundingClientRect();
    const densidade = window.devicePixelRatio || 1;
    const largura = Math.max(1, Math.round(caixa.width * densidade));
    const altura = Math.max(1, Math.round(caixa.height * densidade));
    if (tela.width !== largura || tela.height !== altura) {
      tela.width = largura;
      tela.height = altura;
    }
    const ctx = tela.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(densidade, 0, 0, densidade, 0, 0);
    ctx.clearRect(0, 0, caixa.width, caixa.height);
    desenharFolha(ctx, caixa.width, caixa.height, view);
    // O quadro é o que quem ordena confirmou. O traço em andamento é
    // desenhado por cima dele enquanto a resposta não volta: ou ele ainda nem
    // existe no quadro (entra no fim), ou ele já existe com menos pontos do
    // que a mão já andou (a versão local manda). Como os dois têm o mesmo id,
    // a mesma cor e a mesma espessura, a troca é invisível.
    const visiveis = api.draft && !state.strokes.some((stroke) => stroke.id === api.draft!.id)
      ? [...state.strokes, api.draft]
      : state.strokes.map((stroke) => (api.draft && stroke.id === api.draft.id && api.draft.points.length > stroke.points.length ? api.draft : stroke));
    for (const stroke of visiveis) desenharTraco(ctx, stroke, view);
    for (const cursor of cursors) {
      const ponto = documentToView({ x: cursor.x, y: cursor.y }, view);
      if (ponto.x < -40 || ponto.y < -40 || ponto.x > caixa.width + 40 || ponto.y > caixa.height + 40) continue;
      ctx.beginPath();
      ctx.arc(ponto.x, ponto.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = cursor.color;
      ctx.fill();
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.fillText(cursor.username, ponto.x + 9, ponto.y + 4);
    }
  }, [api.draft, cursors, pausado, state.strokes, view]);

  // A folha acompanha a janela: mudar o tamanho não pode deslocar o desenho.
  useEffect(() => {
    const area = host.current;
    if (!area || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setView((atual) => ({ ...atual })));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const ponto = pontoDoEvento(event);
    if (!ponto) return;
    // Capturar o ponteiro é o que faz a mão continuar desenhando quando sai
    // da área — e é opcional: um navegador que recuse não pode derrubar o
    // traço inteiro junto.
    try { (event.target as HTMLElement).setPointerCapture?.(event.pointerId); } catch { /* segue sem captura */ }
    // O botão do meio e a ferramenta de mão fazem a mesma coisa: mover a folha.
    if (tool === 'hand' || event.button === 1 || event.buttons === 4) {
      arrasto.current = { x: event.clientX, y: event.clientY, view };
      return;
    }
    if (!podeDesenhar) return;
    if (tool === 'eraser') {
      apagados.current = new Set();
      apagarEm(ponto);
      return;
    }
    const id = crypto.randomUUID();
    traco.current = { id, ultimo: ponto, pendentes: [] };
    api.beginStroke({ id, author: currentUserId, authorName: '', color, width, points: [ponto], at: Date.now() });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const ponto = pontoDoEvento(event);
    if (!ponto) return;
    if (!pausado) api.moveCursor(ponto.x, ponto.y, color);
    const movendo = arrasto.current;
    if (movendo) {
      const escala = Math.max(0.0001, movendo.view.scale);
      setView({
        scale: movendo.view.scale,
        offsetX: movendo.view.offsetX - (event.clientX - movendo.x) / escala,
        offsetY: movendo.view.offsetY - (event.clientY - movendo.y) / escala,
      });
      return;
    }
    if (!podeDesenhar) return;
    if (tool === 'eraser' && event.buttons === 1) return void apagarEm(ponto);
    const atual = traco.current;
    if (!atual || event.buttons !== 1) return;
    // Um ponto por pixel de mouse encheria o histórico sem melhorar a linha. A
    // distância mínima é em unidades de documento, então ela não muda com o
    // zoom de quem desenha.
    if (!boardPointsAreFarEnough(atual.ultimo, ponto, MIN_BOARD_POINT_DISTANCE / Math.max(1, view.scale))) return;
    atual.ultimo = ponto;
    atual.pendentes.push(ponto);
    if (atual.pendentes.length >= 6) {
      api.extendStroke(atual.pendentes);
      atual.pendentes = [];
    }
  };

  const onPointerUp = () => {
    arrasto.current = null;
    const atual = traco.current;
    if (!atual) return;
    if (atual.pendentes.length) api.extendStroke(atual.pendentes);
    api.endStroke();
    traco.current = null;
  };

  const apagarEm = (ponto: BoardPoint) => {
    const alvo = strokeAt(state.strokes, ponto, 8 / Math.max(0.2, view.scale));
    if (!alvo || apagados.current.has(alvo.id)) return;
    // Cada pessoa apaga os seus; quem gerencia apaga os dos outros. O pedido
    // que não vale é recusado do outro lado, e não escondido só aqui.
    if (!gerencia && alvo.author !== currentUserId) return void onNotice(`Esse traço é de ${alvo.authorName || 'outra pessoa'}. Você apaga os seus.`);
    apagados.current.add(alvo.id);
    api.erase([alvo.id]);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const caixa = medir();
    if (!caixa) return;
    const fator = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((atual) => zoomAround(atual, event.clientX - caixa.left, event.clientY - caixa.top, fator));
  };

  const ajustar = () => {
    const caixa = medir();
    if (caixa) setView(fitBoard(caixa.width, caixa.height));
  };

  const aproximar = (fator: number) => {
    const caixa = medir();
    if (caixa) setView((atual) => zoomAround(atual, caixa.width / 2, caixa.height / 2, fator));
  };

  const desfazer = () => {
    const ultimo = meusTracos[meusTracos.length - 1];
    if (!ultimo) return void onNotice('Você ainda não desenhou nada nesta mesa.');
    api.undo(ultimo.id);
  };

  // A exportação desenha a folha inteira em tamanho de documento, e não o que
  // está na tela: quem exportou com zoom de 40% leva o quadro completo.
  const exportar = () => {
    const tela = document.createElement('canvas');
    tela.width = BOARD_WIDTH;
    tela.height = BOARD_HEIGHT;
    const ctx = tela.getContext('2d');
    if (!ctx) return void onNotice('Não foi possível gerar a imagem aqui.');
    ctx.fillStyle = BOARD_BACKGROUND;
    ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    for (const stroke of state.strokes) desenharTraco(ctx, stroke, { scale: 1, offsetX: 0, offsetY: 0 });
    tela.toBlob((blob) => {
      if (!blob) return void onNotice('Não foi possível gerar a imagem aqui.');
      downloadBlob(blob, `${board.name}.png`);
      onNotice('Imagem da mesa salva.');
    }, 'image/png');
  };

  const limpar = async () => {
    if (await api.manage('clear')) {
      setConfirmClear(false);
      onNotice('A mesa foi limpa.');
    }
  };

  const excluir = async () => {
    if (await api.manage('delete')) {
      setConfirmDelete(false);
      onNotice(`A mesa “${board.name}” foi excluída.`);
      onClose();
    }
  };

  const outros = participants.filter((participante) => participante.userId !== currentUserId);

  return <section className="board-surface">
    <header className="board-toolbar">
      <button className="board-back" onClick={onClose} title="Voltar"><Icon name="chevron" /></button>
      <div className="board-identity">
        <strong>{board.name}</strong>
        <small>
          {board.status === 'open' ? (board.locked ? 'Bloqueada para novos desenhos' : `${board.strokes} ${board.strokes === 1 ? 'traço' : 'traços'}`) : board.status === 'closed' ? 'Encerrada' : 'Arquivada'}
          {' · '}criada por {board.createdByName}
        </small>
      </div>
      <div className="board-tools">
        <button className={tool === 'pen' ? 'selected' : ''} disabled={!podeDesenhar} onClick={() => setTool('pen')} title="Caneta"><Icon name="pencil" /></button>
        <button className={tool === 'eraser' ? 'selected' : ''} disabled={!podeDesenhar} onClick={() => setTool('eraser')} title="Borracha — apaga o traço inteiro"><Icon name="eraser" /></button>
        <button className={tool === 'hand' ? 'selected' : ''} onClick={() => setTool('hand')} title="Mover a folha"><Icon name="hand" /></button>
        <button disabled={!podeDesenhar || !meusTracos.length} onClick={desfazer} title="Desfazer o seu último traço"><Icon name="undo" /></button>
      </div>
      <div className="board-palette">
        {BOARD_COLORS.map((opcao) => <button key={opcao} className={`board-color ${color === opcao ? 'selected' : ''}`} style={{ background: opcao }} disabled={!podeDesenhar} onClick={() => { setColor(opcao); setTool('pen'); }} title={`Cor ${opcao}`} />)}
      </div>
      <div className="board-widths">
        {BOARD_WIDTHS.map((opcao) => <button key={opcao} className={`board-width ${width === opcao ? 'selected' : ''}`} disabled={!podeDesenhar} onClick={() => { setWidth(opcao); setTool('pen'); }} title={`Espessura ${opcao}`}><i style={{ width: Math.min(18, 4 + opcao / 2), height: Math.min(18, 4 + opcao / 2) }} /></button>)}
      </div>
      <div className="topbar-spacer" />
      <div className="board-zoom">
        <button onClick={() => aproximar(1 / 1.2)} title="Afastar">–</button>
        <button onClick={ajustar} title="Enquadrar a folha">{Math.round(view.scale * 100)}%</button>
        <button onClick={() => aproximar(1.2)} title="Aproximar">+</button>
      </div>
      <button className="board-action" onClick={exportar} title="Exportar em PNG"><Icon name="download" /></button>
    </header>

    <div className="board-body">
      <div
        ref={host}
        className={`board-canvas tool-${tool} ${podeDesenhar ? '' : 'read-only'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={canvas} />
        {status === 'loading' && <div className="board-veil">Abrindo a mesa…</div>}
        {status === 'recovering' && <div className="board-veil">Recuperando o que faltou…</div>}
        {status === 'gone' && <div className="board-veil">{notice || 'Esta mesa não está mais disponível.'}</div>}
        {pausado && <div className="board-veil">Pausada enquanto a janela está em segundo plano.</div>}
      </div>

      <aside className="board-side">
        <div className="board-people">
          <div className="group-title"><span>Na mesa</span><small>{participants.length}</small></div>
          <div className="board-person self">
            <span><strong>Você</strong><small>{role === 'manager' ? 'gerencia' : role === 'drawer' ? 'desenhando' : 'observando'}</small></span>
          </div>
          {outros.map((participante) => <div className="board-person" key={participante.socketId}>
            <span><strong>{participante.username}</strong><small>{participante.role === 'manager' ? 'gerencia' : participante.role === 'drawer' ? 'desenhando' : 'observando'}</small></span>
            {gerencia && participante.role !== 'manager' && <button
              onClick={() => void api.manage(participante.role === 'observer' ? 'restore' : 'revoke', participante.userId)}
              title={participante.role === 'observer' ? 'Devolver a permissão de desenhar' : 'Deixar só como observador'}
            ><Icon name={participante.role === 'observer' ? 'pencil' : 'lock'} /></button>}
          </div>)}
          {!outros.length && <p className="board-empty">Ninguém mais entrou ainda. O anúncio já foi para o canal.</p>}
        </div>

        {gerencia && <div className="board-manage">
          <div className="group-title"><span>Gerenciar</span></div>
          <button onClick={() => void api.manage(board.locked ? 'unlock' : 'lock')}>
            <Icon name="lock" /><span>{board.locked ? 'Liberar novos desenhos' : 'Bloquear novos desenhos'}</span>
          </button>
          <button onClick={() => void api.manage('observers', !board.allowObservers)}>
            <Icon name="users" /><span>{board.allowObservers ? 'Não aceitar observadores' : 'Aceitar observadores'}</span>
          </button>
          {/* Limpar tudo apaga o trabalho do grupo, e por isso pergunta antes. */}
          {confirmClear
            ? <div className="board-confirm">
              <p>Isto apaga o que <strong>todo mundo</strong> desenhou nesta mesa. Não dá para desfazer.</p>
              <div><button className="danger" onClick={() => void limpar()}>Limpar mesmo assim</button><button onClick={() => setConfirmClear(false)}>Cancelar</button></div>
            </div>
            : <button className="danger" onClick={() => { setConfirmDelete(false); setConfirmClear(true); }}><Icon name="eraser" /><span>Limpar o quadro</span></button>}
          {board.status === 'open'
            ? <button onClick={() => void api.manage('close')}><Icon name="close" /><span>Encerrar a mesa</span></button>
            : <button onClick={() => void api.manage('reopen')}><Icon name="refresh" /><span>Reabrir a mesa</span></button>}
          {connectionMode === 'server' && <button onClick={() => void api.manage('archive').then((ok) => { if (ok) onClose(); })}><Icon name="file" /><span>Arquivar, guardando o conteúdo</span></button>}
          {/* Quatro coisas diferentes com nomes parecidos, e esta é a única
              sem volta: limpar esvazia a folha, encerrar para os desenhos,
              arquivar tira da lista guardando tudo, excluir apaga a mesa. */}
          {confirmDelete
            ? <div className="board-confirm">
              <p>Isto apaga a mesa <strong>“{board.name}”</strong> e tudo o que foi desenhado nela, para todo mundo. Não dá para desfazer, e ela não volta nem em outra sessão. As imagens que alguém já exportou continuam com quem as salvou.</p>
              <div><button className="danger" onClick={() => void excluir()}>Excluir a mesa</button><button onClick={() => setConfirmDelete(false)}>Cancelar</button></div>
            </div>
            : <button className="danger" onClick={() => { setConfirmClear(false); setConfirmDelete(true); }}><Icon name="close" /><span>Excluir a mesa</span></button>}
        </div>}

        {connectionMode === 'p2p' && <p className="board-warning">
          Esta mesa vive enquanto o grupo estiver reunido: ela não é guardada em
          servidor nenhum. Ela sobrevive à troca de host, e some quando a última
          pessoa sai. Exporte em PNG o que quiser manter.
        </p>}
        {board.locked && !gerencia && <p className="board-warning">Quem criou a mesa bloqueou novos desenhos. Você continua vendo o quadro.</p>}
        {role === 'observer' && !board.locked && <p className="board-warning">Você está nesta mesa como observador.</p>}
      </aside>
    </div>

    {notice && status !== 'gone' && <div className="board-notice"><span>{notice}</span><button onClick={api.dismissNotice}><Icon name="close" /></button></div>}
  </section>;
}

function desenharFolha(ctx: CanvasRenderingContext2D, largura: number, altura: number, view: BoardView): void {
  ctx.fillStyle = BOARD_BACKGROUND;
  ctx.fillRect(0, 0, largura, altura);
  // A borda da folha e uma grade fraca: sem elas não dá para saber onde o
  // documento começa, e o zoom vira um passeio no escuro.
  const inicio = documentToView({ x: 0, y: 0 }, view);
  const fim = documentToView({ x: BOARD_WIDTH, y: BOARD_HEIGHT }, view);
  const passo = 120 * view.scale;
  if (passo > 12) {
    ctx.strokeStyle = BOARD_GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = inicio.x; x <= fim.x; x += passo) { ctx.moveTo(x, inicio.y); ctx.lineTo(x, fim.y); }
    for (let y = inicio.y; y <= fim.y; y += passo) { ctx.moveTo(inicio.x, y); ctx.lineTo(fim.x, y); }
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(inicio.x, inicio.y, fim.x - inicio.x, fim.y - inicio.y);
}

function desenharTraco(ctx: CanvasRenderingContext2D, stroke: BoardStroke, view: BoardView): void {
  if (!stroke.points.length) return;
  const pontos = stroke.points.map((ponto) => documentToView(ponto, view));
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = Math.max(0.6, stroke.width * view.scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pontos.length === 1) {
    ctx.beginPath();
    ctx.arc(pontos[0].x, pontos[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pontos[0].x, pontos[0].y);
  // Curva pelos pontos médios: a linha sai da mão tremida sem precisar de mais
  // pontos no histórico.
  for (let indice = 1; indice < pontos.length - 1; indice += 1) {
    const meio = { x: (pontos[indice].x + pontos[indice + 1].x) / 2, y: (pontos[indice].y + pontos[indice + 1].y) / 2 };
    ctx.quadraticCurveTo(pontos[indice].x, pontos[indice].y, meio.x, meio.y);
  }
  ctx.lineTo(pontos[pontos.length - 1].x, pontos[pontos.length - 1].y);
  ctx.stroke();
}
