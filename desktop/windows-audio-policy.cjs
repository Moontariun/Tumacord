// Quem entra no áudio da transmissão no Windows, e quem nunca entra.
//
// Este arquivo não fala com o Windows. Ele recebe a lista de sessões de áudio
// que o helper nativo enumerou e devolve os processos que podem ser
// capturados. É de propósito: a regra que impede a call de voltar pela live é
// a parte que mais precisa de teste, e teste de política não pode depender de
// ter um Discord aberto na máquina.
//
// A unidade de captura é a *árvore* de processos, não o processo. Um jogo
// moderno toca som por um processo auxiliar; um navegador toca por um
// renderizador. Capturar a árvore do processo dono resolve os dois casos — e
// obriga a deduplicar, porque capturar pai e filho ao mesmo tempo entregaria
// o mesmo som duas vezes.

// Discord aparece com nomes diferentes conforme o canal de distribuição, e os
// processos auxiliares dele herdam o mesmo executável por serem Electron. O
// Tumacord entra na lista pelo mesmo motivo pelo qual entra no roteador do
// Linux: o que ele reproduz é a voz de quem está na call.
const BLOCKED_EXECUTABLES = Object.freeze([
  'tumacord.exe',
  'tumacord-audio-helper.exe',
  'discord.exe',
  'discordcanary.exe',
  'discordptb.exe',
  'discorddevelopment.exe',
]);

// Um teto para o caso patológico: uma máquina com dezenas de sessões abertas
// não pode virar dezenas de clientes WASAPI e dezenas de threads.
const DEFAULT_CAPTURE_LIMIT = 24;

function normalizeExecutable(value) {
  if (typeof value !== 'string') return '';
  const withoutDirectory = value.split(/[\\/]/).pop() ?? '';
  return withoutDirectory.trim().toLowerCase();
}

function isBlockedExecutable(value) {
  return BLOCKED_EXECUTABLES.includes(normalizeExecutable(value));
}

function ancestorList(session) {
  return Array.isArray(session?.ancestors) ? session.ancestors : [];
}

// O motivo pelo qual uma sessão fica de fora, na ordem em que importa: o que
// bloqueia por segurança vem antes do que apenas evita duplicata.
function exclusionReason(session, blockedPids) {
  if (session.expired) return 'expired';
  if (session.system) return 'system-sounds';
  if (blockedPids.has(session.pid)) return 'self';
  if (isBlockedExecutable(session.exe)) return 'blocked-executable';
  for (const ancestor of ancestorList(session)) {
    if (blockedPids.has(ancestor.pid)) return 'self';
    if (isBlockedExecutable(ancestor.exe)) return 'blocked-ancestor';
  }
  return '';
}

/**
 * Escolhe as raízes de árvore que o helper deve capturar.
 *
 * @param {object} input
 * @param {Array} input.sessions sessões enumeradas pelo helper
 * @param {Array<number>} [input.selfPids] processos do próprio Tumacord
 * @param {number} [input.limit]
 */
function selectCaptureRoots({ sessions, selfPids = [], limit = DEFAULT_CAPTURE_LIMIT } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const blockedPids = new Set(selfPids.filter((pid) => Number.isInteger(pid) && pid > 0));
  const included = [];
  const excluded = [];

  const candidates = [];
  for (const session of list) {
    if (!session || !Number.isInteger(session.pid) || session.pid <= 0) continue;
    const reason = exclusionReason(session, blockedPids);
    if (reason) excluded.push({ pid: session.pid, exe: normalizeExecutable(session.exe), reason });
    else candidates.push(session);
  }

  // Um processo cuja árvore já será capturada por um ancestral não pode virar
  // uma segunda captura: o áudio chegaria somado consigo mesmo.
  const candidatePids = new Set(candidates.map((session) => session.pid));
  const roots = [];
  for (const session of candidates) {
    const covering = ancestorList(session).find((ancestor) => candidatePids.has(ancestor.pid));
    if (covering) {
      excluded.push({ pid: session.pid, exe: normalizeExecutable(session.exe), reason: 'covered-by-ancestor' });
      continue;
    }
    roots.push(session);
  }

  // Com muitas sessões, quem está tocando agora tem prioridade sobre quem só
  // abriu um fluxo e ficou em silêncio.
  roots.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || left.pid - right.pid);
  for (const session of roots) {
    if (included.length >= limit) {
      excluded.push({ pid: session.pid, exe: normalizeExecutable(session.exe), reason: 'limit' });
      continue;
    }
    included.push({ pid: session.pid, exe: normalizeExecutable(session.exe), active: Boolean(session.active) });
  }

  return { roots: included.map((entry) => entry.pid), included, excluded };
}

// A janela escolhida no seletor do Tumacord chega como `window:<HWND>:<n>`.
// O identificador do Electron carrega o HWND em decimal; qualquer outra forma
// é recusada em vez de adivinhada.
function windowHandleFromSourceId(sourceId) {
  if (typeof sourceId !== 'string') return 0;
  const parts = sourceId.split(':');
  if (parts[0] !== 'window' || parts.length < 2) return 0;
  const handle = Number.parseInt(parts[1], 10);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : 0;
}

function sourceKindFromId(sourceId) {
  if (typeof sourceId !== 'string') return '';
  if (sourceId.startsWith('window:')) return 'window';
  if (sourceId.startsWith('screen:')) return 'screen';
  return '';
}

const FRAME_HEADER_BYTES = 8;
const FRAME_TYPE_PCM = 1;
const FRAME_TYPE_EVENT = 2;
// 4 MiB é ordens de grandeza acima do maior quadro real (3840 bytes de PCM).
// O teto existe para que um fluxo corrompido não peça uma alocação enorme.
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Decodificador incremental do fluxo do helper.
 *
 * O `stdout` de um processo chega em pedaços que não respeitam limite de
 * quadro: um bloco de PCM pode vir partido em três leituras, e duas leituras
 * podem trazer quatro quadros. Guardar o resto entre chamadas é o que mantém
 * o áudio contínuo.
 */
function createFrameDecoder() {
  let pending = Buffer.alloc(0);
  return function push(chunk) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    const frames = [];
    let offset = 0;
    while (pending.length - offset >= FRAME_HEADER_BYTES) {
      if (pending[offset] !== 0x54 || pending[offset + 1] !== 0x41) {
        // Sem sincronismo, avançar um byte é a única saída que não descarta
        // um quadro válido logo adiante.
        offset += 1;
        continue;
      }
      const type = pending[offset + 2];
      const length = pending.readUInt32LE(offset + 4);
      if (length > MAX_FRAME_BYTES) {
        offset += 1;
        continue;
      }
      if (pending.length - offset - FRAME_HEADER_BYTES < length) break;
      const start = offset + FRAME_HEADER_BYTES;
      frames.push({ type, payload: pending.subarray(start, start + length) });
      offset = start + length;
    }
    pending = offset ? pending.subarray(offset) : pending;
    return frames;
  };
}

function parseEvent(payload) {
  try {
    const parsed = JSON.parse(payload.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function captureCommand(pids) {
  const list = (Array.isArray(pids) ? pids : [])
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .join(',');
  return list ? `CAPTURE ${list}\n` : 'CAPTURE\n';
}

function windowCommand(handle) {
  return `WINDOW ${Number.isSafeInteger(handle) && handle > 0 ? handle : 0}\n`;
}

module.exports = {
  BLOCKED_EXECUTABLES,
  DEFAULT_CAPTURE_LIMIT,
  FRAME_TYPE_EVENT,
  FRAME_TYPE_PCM,
  captureCommand,
  createFrameDecoder,
  isBlockedExecutable,
  normalizeExecutable,
  parseEvent,
  selectCaptureRoots,
  sourceKindFromId,
  windowCommand,
  windowHandleFromSourceId,
};
