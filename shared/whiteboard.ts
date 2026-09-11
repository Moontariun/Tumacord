// Mesa de desenho compartilhada.
//
// Alguém cria um quadro em branco dentro do app, os outros entram e desenham
// juntos. Não é o mesmo que rabiscar sobre a live de alguém — aquilo é
// apontamento, mora em `shared/telestration.ts`, tem prazo de validade e vive
// dentro do vídeo. Aqui o quadro é o trabalho: ele fica, ele é o motivo de
// estarem ali, e sair da call não pode apagá-lo.
//
// Quatro decisões sustentam o resto do arquivo:
//
// **Coordenadas de documento.** Um ponto vale em unidades da folha, não em
// pixels da janela nem em fração do quadro capturado. Duas pessoas com janelas
// de tamanhos diferentes, uma com zoom e outra sem, precisam ver o traço no
// mesmo lugar da folha. Zoom e deslocamento são locais: mexer no seu zoom não
// move a visão de mais ninguém.
//
// **Operação, e não imagem.** O que viaja é "traço tal, destes pontos, desta
// cor" — nunca um quadro inteiro a cada movimento da mão. Cada operação tem
// identidade própria, e é essa identidade que faz a reconexão não desenhar
// duas vezes.
//
// **Revisão densa e crescente.** Quem ordena as operações carimba 1, 2, 3…
// sem buracos: só operação aceita ganha número. Com isso, quem recebe sabe
// exatamente três coisas — a revisão que esperava chegou (aplica), uma que já
// passou chegou de novo (ignora), ou saltou (pede recuperação). Deduplicação e
// detecção de lacuna saem da mesma comparação.
//
// **Nada some sozinho para liberar espaço.** O desenho de anotação guarda no
// máximo 64 traços e descarta o mais antigo — o que é correto para um
// apontamento que ia sumir de qualquer jeito, e destrutivo para uma mesa. Aqui
// o teto recusa a operação nova, com mensagem, e o que já está desenhado fica.

export interface BoardPoint {
  /** Unidade de documento no eixo X, de 0 a `BOARD_WIDTH`. */
  x: number;
  /** Unidade de documento no eixo Y, de 0 a `BOARD_HEIGHT`. */
  y: number;
}

/** A folha. Fixa, e independente de qualquer janela. */
export const BOARD_WIDTH = 1920;
export const BOARD_HEIGHT = 1080;

// Limites. Cada um existe porque o outro lado do fio pode ser um cliente
// adulterado, e porque uma mesa de horas precisa caber em memória e em disco.
/** Nome da mesa: cabe numa aba e numa notificação. */
export const MAX_BOARD_NAME = 48;
/** Traços por mesa. Ao encostar, a operação nova é recusada — nada é jogado fora. */
export const MAX_BOARD_STROKES = 4_000;
/** Pontos somados de todos os traços. É o teto de armazenamento da mesa. */
export const MAX_BOARD_POINTS = 200_000;
/** Pontos de um traço só. Um rabisco longo demais é cortado, não recusado. */
export const MAX_POINTS_PER_BOARD_STROKE = 2_000;
/** Operações por pedido. Segura a vazão sem obrigar uma ida por traço. */
export const MAX_OPS_PER_BATCH = 32;
/** Pontos por pedido enviado enquanto a mão anda. */
export const BOARD_POINTS_PER_MESSAGE = 24;
/** Distância mínima entre pontos guardados, em unidades de documento. */
export const MIN_BOARD_POINT_DISTANCE = 1.5;
/** Mesas abertas por canal. Um grupo não precisa de vinte quadros ao mesmo tempo. */
export const MAX_BOARDS_PER_CHANNEL = 8;
/** Operações mantidas no histórico antes de compactar em snapshot. */
export const BOARD_LOG_LIMIT = 1_000;
/** Espessuras oferecidas, em unidades de documento. */
export const BOARD_WIDTHS = [2, 4, 8, 16, 28] as const;
export const DEFAULT_BOARD_WIDTH = 4;
export const BOARD_COLORS = ['#f2f3f5', '#ff5c5c', '#ffd25c', '#52d789', '#5cc8ff', '#c05cff', '#111318'] as const;
/** Frequência máxima do cursor alheio. Ele é enfeite: não entra no histórico. */
export const BOARD_CURSOR_INTERVAL_MS = 90;

export type BoardStatus = 'open' | 'closed' | 'archived';
export type BoardRole = 'manager' | 'drawer' | 'observer';

// O que o cliente escreve. Autor, revisão e horário quem carimba é o servidor.
//
// Um traço não viaja inteiro no fim do movimento: ele viaja em pedaços,
// conforme a mão anda, senão quem está do outro lado só veria o desenho
// aparecer quando a caneta levantasse — e três pessoas desenhando juntas
// ficariam olhando para uma folha parada. Por isso `id` identifica o *pedaço*
// e `stroke` identifica o *traço*: o primeiro é a chave contra reentrega, o
// segundo é o objeto que a borracha apaga e o desfazer remove.
export type BoardOp =
  | { id: string; kind: 'stroke'; stroke: string; color: string; width: number; points: BoardPoint[]; done?: boolean }
  | { id: string; kind: 'erase'; targets: string[] }
  | { id: string; kind: 'undo'; target: string }
  | { id: string; kind: 'clear' };

export type BoardOpKind = BoardOp['kind'];

/** A operação depois de ordenada: é isto que viaja e é isto que se guarda. */
export interface BoardOpEnvelope {
  /** Identidade da operação, escolhida por quem desenhou. Chave de idempotência. */
  id: string;
  /** Posição na fila da mesa. Densa e crescente: só operação aceita ganha número. */
  rev: number;
  /** Conta de quem desenhou, validada pela sessão — nunca o que o cliente disse ser. */
  author: string;
  authorName: string;
  at: number;
  op: BoardOp;
}

export interface BoardStroke {
  /** Igual ao id da operação que o criou: aplicar duas vezes não duplica. */
  id: string;
  author: string;
  authorName: string;
  color: string;
  width: number;
  points: BoardPoint[];
  at: number;
}

export interface BoardState {
  revision: number;
  strokes: BoardStroke[];
}

/** O quadro numa revisão conhecida. É com isto que quem chega depois começa. */
export interface BoardSnapshot {
  revision: number;
  strokes: BoardStroke[];
}

export interface BoardSummary {
  id: string;
  name: string;
  channelId: string;
  /** Identidade do grupo onde a mesa nasceu. Ela não atravessa para outro. */
  origin: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  status: BoardStatus;
  /** Ninguém desenha; quem gerencia continua podendo limpar e reabrir. */
  locked: boolean;
  /** Se quem não desenha pode ao menos assistir. */
  allowObservers: boolean;
  revision: number;
  strokes: number;
  points: number;
  participants: number;
}

export interface BoardParticipant {
  socketId: string;
  userId: string;
  username: string;
  role: BoardRole;
}

/** Enfeite de tempo real: some quando a pessoa para, e não entra no histórico. */
export interface BoardCursor {
  socketId: string;
  userId: string;
  username: string;
  color: string;
  x: number;
  y: number;
  at: number;
}

export const emptyBoardState = (): BoardState => ({ revision: 0, strokes: [] });

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function isBoardColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function parseBoardWidth(value: unknown): number {
  const numero = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_BOARD_WIDTH;
  return clamp(Math.round(numero), BOARD_WIDTHS[0], BOARD_WIDTHS[BOARD_WIDTHS.length - 1]);
}

// O nome é texto de gente, e aparece no anúncio que todo mundo recebe. Vazio
// vira um nome padrão em vez de recusa: ninguém perde o quadro por causa disso.
export function normalizeBoardName(value: unknown): string {
  const bruto = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const limpo = bruto.replace(/[\u0000-\u001f\u007f]/g, '');
  return (limpo || 'Mesa sem nome').slice(0, MAX_BOARD_NAME);
}

export function sanitizeBoardPoints(input: unknown, limit = MAX_POINTS_PER_BOARD_STROKE): BoardPoint[] {
  if (!Array.isArray(input)) return [];
  const pontos: BoardPoint[] = [];
  for (const bruto of input) {
    if (!bruto || typeof bruto !== 'object') continue;
    const { x, y } = bruto as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    pontos.push({ x: clamp(x, 0, BOARD_WIDTH), y: clamp(y, 0, BOARD_HEIGHT) });
    if (pontos.length >= limit) break;
  }
  return pontos;
}

export function boardPointsAreFarEnough(previous: BoardPoint | undefined, next: BoardPoint, minimum = MIN_BOARD_POINT_DISTANCE): boolean {
  if (!previous) return true;
  return Math.hypot(next.x - previous.x, next.y - previous.y) >= minimum;
}

export function countBoardPoints(strokes: readonly BoardStroke[]): number {
  return strokes.reduce((total, stroke) => total + stroke.points.length, 0);
}

// Quem pode o quê.
//
// Gerenciar é do criador e de quem administra o servidor. Não existe "todo
// mundo apaga tudo": limpar a mesa afeta o trabalho de outras pessoas, e isso
// é decisão de quem responde por ela.
export interface BoardActor {
  userId: string;
  username: string;
  /** Administração do servidor: gerencia qualquer mesa. */
  serverAdmin?: boolean;
}

export function canManageBoard(board: Pick<BoardSummary, 'createdBy'>, actor: BoardActor): boolean {
  return actor.serverAdmin === true || board.createdBy === actor.userId;
}

export function roleFor(board: Pick<BoardSummary, 'createdBy' | 'locked'>, actor: BoardActor, revoked: boolean): BoardRole {
  if (canManageBoard(board, actor)) return 'manager';
  // Mesa bloqueada ou permissão revogada: a pessoa continua vendo, não escreve.
  return board.locked || revoked ? 'observer' : 'drawer';
}

export function roleMayDraw(role: BoardRole): boolean {
  return role === 'manager' || role === 'drawer';
}

const LIMITE_ARMAZENAMENTO = 'Esta mesa chegou ao limite de armazenamento. Apague algo ou comece uma mesa nova — nada do que já está desenhado será removido para abrir espaço.';

export type BoardApplyOutcome =
  | { status: 'applied'; state: BoardState }
  /** A revisão já passou: reconexão reentregando o que já foi desenhado. */
  | { status: 'duplicate' }
  /** Faltou revisão no meio: quem recebeu precisa pedir recuperação. */
  | { status: 'gap' }
  // Recusa carrega o estado com a revisão já avançada, e a razão é sutil: no
  // servidor a recusa não gasta número nenhum e este campo é ignorado, mas o
  // cliente que receber pelo fio uma operação que ele mesmo recusaria precisa
  // avançar a revisão assim mesmo. Não avançar transformaria a próxima
  // operação em lacuna, e a mesa entraria num laço de recuperação sem fim.
  | { status: 'refused'; error: string; state: BoardState };

export interface BoardApplyOptions {
  /** Se quem assinou a operação gerencia a mesa. Decide limpar e apagar alheio. */
  manager?: boolean;
  maxStrokes?: number;
  maxPoints?: number;
}

// O coração da mesa, e de propósito puro: é ele que o teste sacode com mil
// operações fora de ordem sem precisar de tela, de socket nem de servidor.
//
// A mesma função roda nas duas pontas. No servidor, `rev` é sempre
// `state.revision + 1` — é ele quem numera, e uma recusa não gasta número. No
// cliente, `rev` vem do fio, e é a comparação com a revisão local que separa
// "aplica" de "já vi isso" e de "perdi alguma coisa".
export function applyBoardOp(state: BoardState, envelope: BoardOpEnvelope, options: BoardApplyOptions = {}): BoardApplyOutcome {
  const maxStrokes = options.maxStrokes ?? MAX_BOARD_STROKES;
  const maxPoints = options.maxPoints ?? MAX_BOARD_POINTS;
  if (envelope.rev <= state.revision) return { status: 'duplicate' };
  if (envelope.rev > state.revision + 1) return { status: 'gap' };
  const op = envelope.op;

  // Daqui para baixo a revisão avança, aconteça o que acontecer com o desenho:
  // uma operação sem efeito ainda ocupou o número que quem ordena carimbou.
  const avancou = { ...state, revision: envelope.rev };

  if (op.kind === 'stroke') {
    const pontos = sanitizeBoardPoints(op.points);
    if (!pontos.length) return { status: 'refused', error: 'Traço sem pontos válidos.', state: avancou };
    const existente = state.strokes.find((stroke) => stroke.id === op.stroke);
    const total = countBoardPoints(state.strokes);
    if (existente) {
      // Um traço pertence a quem o começou. Continuar o traço de outra pessoa
      // seria escrever dentro do objeto dela sem passar pela borracha nem pelo
      // desfazer — e as duas coisas são de quem desenhou.
      if (existente.author !== envelope.author) return { status: 'refused', error: 'Esse traço é de outra pessoa.', state: avancou };
      const cabem = Math.max(0, MAX_POINTS_PER_BOARD_STROKE - existente.points.length);
      const novos = pontos.slice(0, cabem);
      // O traço encostou no teto de pontos: ele para de crescer, e nem ele nem
      // nenhum outro é jogado fora por causa disso.
      if (!novos.length) return { status: 'applied', state: avancou };
      if (total + novos.length > maxPoints) return { status: 'refused', error: LIMITE_ARMAZENAMENTO, state: avancou };
      return {
        status: 'applied',
        state: {
          revision: envelope.rev,
          strokes: state.strokes.map((stroke) => (stroke === existente ? { ...stroke, points: [...stroke.points, ...novos], at: envelope.at } : stroke)),
        },
      };
    }
    if (state.strokes.length >= maxStrokes) {
      return { status: 'refused', error: `Esta mesa chegou ao limite de ${maxStrokes} traços. Apague algo ou comece uma mesa nova — nada do que já está desenhado será removido para abrir espaço.`, state: avancou };
    }
    if (total + pontos.length > maxPoints) return { status: 'refused', error: LIMITE_ARMAZENAMENTO, state: avancou };
    const stroke: BoardStroke = {
      id: op.stroke,
      author: envelope.author,
      authorName: envelope.authorName,
      color: isBoardColor(op.color) ? op.color : BOARD_COLORS[0],
      width: parseBoardWidth(op.width),
      points: pontos,
      at: envelope.at,
    };
    return { status: 'applied', state: { revision: envelope.rev, strokes: [...state.strokes, stroke] } };
  }

  if (op.kind === 'erase') {
    // A borracha desta versão apaga traço inteiro. Cada pessoa apaga os seus;
    // quem gerencia apaga os dos outros. Alvo que não é apagável simplesmente
    // fica — recusar o pedido inteiro por causa de um traço alheio no caminho
    // transformaria a borracha em algo que falha no meio do movimento.
    const alvos = new Set(Array.isArray(op.targets) ? op.targets.filter((id) => typeof id === 'string') : []);
    if (!alvos.size) return { status: 'refused', error: 'Nada para apagar.', state: avancou };
    const restantes = state.strokes.filter((stroke) => !(alvos.has(stroke.id) && (options.manager || stroke.author === envelope.author)));
    if (restantes.length === state.strokes.length) return { status: 'refused', error: 'Você só apaga os seus traços nesta mesa.', state: avancou };
    return { status: 'applied', state: { revision: envelope.rev, strokes: restantes } };
  }

  if (op.kind === 'undo') {
    // Desfazer é operação explícita sobre um objeto identificado, e não "tira
    // o último do vetor". O último do vetor global costuma ser de outra
    // pessoa, e desfazer nunca pode apagar o trabalho alheio — nem de quem
    // gerencia a mesa, que para isso tem a borracha.
    const alvo = state.strokes.find((stroke) => stroke.id === op.target);
    // O alvo não está mais lá: alguém já desfez, ou a borracha passou antes.
    // Não é erro, e a revisão avança do mesmo jeito.
    if (!alvo) return { status: 'applied', state: avancou };
    if (alvo.author !== envelope.author) return { status: 'refused', error: 'Desfazer vale só para o que você mesmo desenhou.', state: avancou };
    return { status: 'applied', state: { revision: envelope.rev, strokes: state.strokes.filter((stroke) => stroke !== alvo) } };
  }

  if (!options.manager) return { status: 'refused', error: 'Limpar a mesa é de quem a criou ou administra o servidor.', state: avancou };
  return { status: 'applied', state: { revision: envelope.rev, strokes: [] } };
}

// Aplicar o que já foi ordenado.
//
// Quem recebe **não** reavalia permissão. A permissão foi decidida quando a
// operação foi aceita, por quem ordena, e refazer a conta aqui faria o quadro
// de quem recebe divergir do quadro de quem enviou: a borracha de quem
// gerencia a mesa, por exemplo, é recusada por qualquer outro participante que
// tentasse julgá-la de novo — e o traço apagado reapareceria só na tela dele.
export function applyOrderedOp(state: BoardState, envelope: BoardOpEnvelope): BoardApplyOutcome {
  return applyBoardOp(state, envelope, { manager: true });
}

/** Reconstrói o quadro a partir de um snapshot mais o que veio depois. */
export function replayBoard(snapshot: BoardSnapshot, ops: readonly BoardOpEnvelope[], options: BoardApplyOptions = {}): BoardState {
  let state: BoardState = { revision: snapshot.revision, strokes: [...snapshot.strokes] };
  for (const envelope of [...ops].sort((first, second) => first.rev - second.rev)) {
    const outcome = applyBoardOp(state, envelope, { ...options, manager: true });
    if (outcome.status === 'applied') state = outcome.state;
  }
  return state;
}

export function boardSnapshot(state: BoardState): BoardSnapshot {
  return { revision: state.revision, strokes: state.strokes.map((stroke) => ({ ...stroke, points: [...stroke.points] })) };
}

// Compactar é trocar histórico por snapshot, e nunca por traço.
//
// O snapshot carrega o quadro inteiro na revisão em que foi tirado, então
// jogar fora as operações anteriores a ele não apaga nada visível: elas já
// estão representadas no que ficou desenhado. O que se perde é a capacidade de
// recuperar por diferença quem estava parado numa revisão muito antiga — e
// para esse caso a resposta é mandar o snapshot inteiro.
export function compactBoardLog(
  snapshot: BoardSnapshot,
  log: readonly BoardOpEnvelope[],
  limit = BOARD_LOG_LIMIT,
): { snapshot: BoardSnapshot; log: BoardOpEnvelope[]; compacted: boolean } {
  if (log.length <= limit) return { snapshot, log: [...log], compacted: false };
  const mantidos = log.slice(-Math.floor(limit / 2));
  const corte = mantidos[0].rev;
  // O snapshot novo precisa ser o quadro *antes* do primeiro mantido, senão as
  // operações mantidas seriam aplicadas duas vezes por quem remontar.
  const anteriores = log.filter((envelope) => envelope.rev < corte);
  return { snapshot: boardSnapshot(replayBoard(snapshot, anteriores)), log: mantidos, compacted: true };
}

export type BoardRecovery =
  | { mode: 'ops'; ops: BoardOpEnvelope[]; revision: number }
  | { mode: 'snapshot'; snapshot: BoardSnapshot; ops: BoardOpEnvelope[]; revision: number };

// Quem reconecta diz a última revisão que tem. Se ela ainda está coberta pelo
// histórico, volta só a diferença; se ficou para trás do snapshot, volta o
// quadro inteiro. Nos dois casos o resultado é o mesmo quadro — a diferença é
// quanto viaja.
export function recoverBoard(snapshot: BoardSnapshot, log: readonly BoardOpEnvelope[], since: number): BoardRecovery {
  const revision = log.length ? Math.max(snapshot.revision, log[log.length - 1].rev) : snapshot.revision;
  const cobre = since >= snapshot.revision && (since >= revision || log.some((envelope) => envelope.rev === since + 1));
  if (cobre) return { mode: 'ops', ops: log.filter((envelope) => envelope.rev > since), revision };
  return { mode: 'snapshot', snapshot, ops: log.filter((envelope) => envelope.rev > snapshot.revision), revision };
}

// Zoom e deslocamento são locais. Estas duas funções são a única ponte entre o
// que a pessoa vê e o que viaja pelo fio.
export interface BoardView {
  /** Pixels de tela por unidade de documento. */
  scale: number;
  /** Canto superior esquerdo visível, em unidades de documento. */
  offsetX: number;
  offsetY: number;
}

export const MIN_BOARD_SCALE = 0.1;
export const MAX_BOARD_SCALE = 8;

export function clampBoardScale(scale: number): number {
  return clamp(Number.isFinite(scale) ? scale : 1, MIN_BOARD_SCALE, MAX_BOARD_SCALE);
}

export function viewToDocument(x: number, y: number, view: BoardView): BoardPoint {
  const escala = clampBoardScale(view.scale);
  return { x: clamp(view.offsetX + x / escala, 0, BOARD_WIDTH), y: clamp(view.offsetY + y / escala, 0, BOARD_HEIGHT) };
}

export function documentToView(point: BoardPoint, view: BoardView): { x: number; y: number } {
  const escala = clampBoardScale(view.scale);
  return { x: (point.x - view.offsetX) * escala, y: (point.y - view.offsetY) * escala };
}

/** Zoom preso ao ponteiro: o ponto sob o cursor não sai do lugar. */
export function zoomAround(view: BoardView, x: number, y: number, factor: number): BoardView {
  const escala = clampBoardScale(view.scale * (Number.isFinite(factor) ? factor : 1));
  const ancora = viewToDocument(x, y, view);
  return { scale: escala, offsetX: ancora.x - x / escala, offsetY: ancora.y - y / escala };
}

/** Enquadra a folha inteira no espaço disponível. É a visão de quem abre a mesa. */
export function fitBoard(width: number, height: number): BoardView {
  if (!(width > 0 && height > 0)) return { scale: 1, offsetX: 0, offsetY: 0 };
  const escala = clampBoardScale(Math.min(width / BOARD_WIDTH, height / BOARD_HEIGHT));
  return { scale: escala, offsetX: (BOARD_WIDTH - width / escala) / 2, offsetY: (BOARD_HEIGHT - height / escala) / 2 };
}

// O traço mais próximo de um ponto, dentro de uma tolerância. É o que a
// borracha usa: apagar traço inteiro exige achar qual é o traço.
export function strokeAt(strokes: readonly BoardStroke[], point: BoardPoint, tolerance = 8): BoardStroke | undefined {
  let melhor: BoardStroke | undefined;
  let menor = Infinity;
  for (const stroke of strokes) {
    const alcance = tolerance + stroke.width / 2;
    for (let index = 0; index < stroke.points.length; index += 1) {
      const distancia = index === 0
        ? Math.hypot(point.x - stroke.points[0].x, point.y - stroke.points[0].y)
        : distanceToSegment(point, stroke.points[index - 1], stroke.points[index]);
      if (distancia <= alcance && distancia < menor) {
        menor = distancia;
        melhor = stroke;
      }
    }
  }
  return melhor;
}

function distanceToSegment(point: BoardPoint, start: BoardPoint, end: BoardPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const comprimento = dx * dx + dy * dy;
  if (comprimento === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / comprimento, 0, 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
