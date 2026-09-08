const fs = require('node:fs');
const path = require('node:path');

const GPU_FAILURE_WINDOW_MS = 10 * 60 * 1_000;
const GPU_FAILURE_THRESHOLD = 2;
const GPU_FAILURE_REASONS = new Set(['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);

// Até a 0.8.8 o único gatilho de recuperação era o processo GPU morrer duas
// vezes em dez minutos. Só que a interface pode corromper com o processo GPU
// vivo e feliz — foi exatamente o que aconteceu no CachyOS, com o Chromium
// falhando em alocar buffers (`Failed to create BO with modifiers`) e o
// processo seguindo em pé. Nenhum evento de queda foi registrado naquele dia.
//
// Por isso existe uma segunda família de falhas, a de APRESENTAÇÃO: a janela
// está visível e em foco e mesmo assim para de pintar. Quem observa isso é o
// renderer, que mede a cadência da própria pintura; quem decide o que fazer é
// esta escada, aqui.
//
// A escada nunca pula degraus e nunca reinicia em laço:
//
//   none               nada foi mudado; só diagnóstico
//   reduce-effects     a interface larga desfoque, animação e prévia; sem reinício
//   software-composite a composição desta janela sai da GPU; sem reinício de call
//   xwayland           a próxima execução testa o backend X11 em vez do Wayland
//   safe-gpu           último recurso: uma execução sem aceleração
//
// `software-composite` não é um chute. A medição desta máquina (cinco pares de
// execuções alternadas, mesmo codec, mesma resolução) mostra que, com encoder
// de vídeo por SOFTWARE e composição por GPU ligada, cada quadro custa cerca de
// 43 ms para ser codificado — e 1,5 ms com a composição fora da GPU. A
// diferença é a viagem do quadro da GPU de volta para a memória do sistema, que
// o encoder de software precisa fazer e que disputa a mesma GPU com o jogo.
// Ele vale só para o processo do Tumacord: nenhum outro programa, nenhum
// driver, nenhuma configuração do sistema é tocada.
//
// Descer a escada também é gradual: três aberturas saudáveis seguidas
// devolvem um degrau. Uma mitigação que ficou para sempre é uma mitigação que
// ninguém revalidou.
const PRESENTATION_WINDOW_MS = 10 * 60 * 1_000;
const PRESENTATION_THRESHOLD = 2;
// Dois minutos entre escalonamentos. Sem isso, uma falha que dispara três
// eventos seguidos levaria o aplicativo de "nada" a "sem aceleração" em
// segundos, sem ninguém conseguir ler o que aconteceu.
const ESCALATION_COOLDOWN_MS = 2 * 60 * 1_000;
const HEALTHY_RUNS_TO_RELAX = 3;
const MITIGATION_LADDER = ['none', 'reduce-effects', 'software-composite', 'xwayland', 'safe-gpu'];

function emptyState() {
  return {
    gpuFailures: [],
    presentationFaults: [],
    safeModePending: false,
    mitigation: 'none',
    pendingMitigation: 'none',
    lastEscalationAt: 0,
    healthyRuns: 0,
  };
}

function recentTimestamps(value, now, window) {
  return Array.isArray(value)
    ? value.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now - window && timestamp <= now)
    : [];
}

function normalizedMitigation(value) {
  return MITIGATION_LADDER.includes(value) ? value : 'none';
}

function normalizedState(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return emptyState();
  return {
    gpuFailures: recentTimestamps(value.gpuFailures, now, GPU_FAILURE_WINDOW_MS),
    presentationFaults: recentTimestamps(value.presentationFaults, now, PRESENTATION_WINDOW_MS),
    safeModePending: value.safeModePending === true,
    mitigation: normalizedMitigation(value.mitigation),
    pendingMitigation: normalizedMitigation(value.pendingMitigation),
    lastEscalationAt: Number.isFinite(value.lastEscalationAt) ? value.lastEscalationAt : 0,
    healthyRuns: Number.isFinite(value.healthyRuns) && value.healthyRuns >= 0 ? value.healthyRuns : 0,
  };
}

function readRuntimeHealth(file, now = Date.now()) {
  try { return normalizedState(JSON.parse(fs.readFileSync(file, 'utf8')), now); }
  catch { return emptyState(); }
}

function writeRuntimeHealth(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

function nextMitigation(current, platform = process.platform) {
  const index = MITIGATION_LADDER.indexOf(normalizedMitigation(current));
  let candidate = MITIGATION_LADDER[Math.min(MITIGATION_LADDER.length - 1, index + 1)];
  // X11 é um backend do Ozone: fora do Linux o degrau não existe e a escada
  // pula direto para o último. Empurrar `--ozone-platform=x11` no Windows
  // seria embaralhar o diagnóstico de quem for ler a linha de comando.
  if (candidate === 'xwayland' && platform !== 'linux') candidate = 'safe-gpu';
  return candidate;
}

function previousMitigation(current) {
  const index = MITIGATION_LADDER.indexOf(normalizedMitigation(current));
  return MITIGATION_LADDER[Math.max(0, index - 1)];
}

function recordGpuFailure(file, details, now = Date.now()) {
  const state = readRuntimeHealth(file, now);
  if (details?.type !== 'GPU' || !GPU_FAILURE_REASONS.has(details.reason)) return { ...state, shouldRelaunch: false };
  state.gpuFailures.push(now);
  state.safeModePending = state.gpuFailures.length >= GPU_FAILURE_THRESHOLD;
  writeRuntimeHealth(file, state);
  return { ...state, shouldRelaunch: state.safeModePending };
}

// Falha de apresentação: a janela devia estar pintando e não está. O renderer
// mede; aqui só se decide o degrau.
function recordPresentationFault(file, details = {}, now = Date.now(), platform = process.platform) {
  const state = readRuntimeHealth(file, now);
  state.presentationFaults.push(now);
  const enough = state.presentationFaults.length >= PRESENTATION_THRESHOLD;
  const cooled = now - state.lastEscalationAt >= ESCALATION_COOLDOWN_MS;
  const ceiling = normalizedMitigation(details.ceiling ?? 'safe-gpu');
  const atCeiling = MITIGATION_LADDER.indexOf(state.mitigation) >= MITIGATION_LADDER.indexOf(ceiling);
  if (!enough || !cooled || atCeiling) {
    writeRuntimeHealth(file, state);
    return { ...state, escalated: false, step: state.mitigation, shouldRelaunch: false };
  }
  const step = nextMitigation(state.mitigation, platform);
  state.mitigation = step;
  state.healthyRuns = 0;
  state.lastEscalationAt = now;
  state.presentationFaults = [];
  // `reduce-effects` acontece dentro da sessão: a interface simplesmente para
  // de gastar. Os degraus de composição e de backend precisam de uma execução
  // nova, porque são bandeiras de linha de comando do Chromium.
  const shouldRelaunch = step === 'software-composite' || step === 'xwayland' || step === 'safe-gpu';
  state.pendingMitigation = shouldRelaunch ? step : 'none';
  if (step === 'safe-gpu') state.safeModePending = true;
  writeRuntimeHealth(file, state);
  return { ...state, escalated: true, step, shouldRelaunch };
}

// Uma abertura que passou o tempo mínimo sem falha de apresentação conta como
// saudável. Três delas devolvem um degrau da escada.
function recordHealthyRun(file, now = Date.now()) {
  const state = readRuntimeHealth(file, now);
  if (state.mitigation === 'none') {
    state.healthyRuns = 0;
    writeRuntimeHealth(file, state);
    return { ...state, relaxed: false };
  }
  state.healthyRuns += 1;
  if (state.healthyRuns < HEALTHY_RUNS_TO_RELAX) {
    writeRuntimeHealth(file, state);
    return { ...state, relaxed: false };
  }
  state.mitigation = previousMitigation(state.mitigation);
  state.healthyRuns = 0;
  if (state.mitigation !== 'safe-gpu') state.safeModePending = false;
  writeRuntimeHealth(file, state);
  return { ...state, relaxed: true };
}

function consumeSafeGpuMode(file, argv = process.argv, environment = process.env, now = Date.now()) {
  const explicitlyRequested = argv.includes('--tumacord-safe-gpu') || environment.TUMACORD_DISABLE_GPU === '1';
  const state = readRuntimeHealth(file, now);
  const pending = state.safeModePending;
  if (pending) {
    state.safeModePending = false;
    state.gpuFailures = [];
    if (state.pendingMitigation === 'safe-gpu') state.pendingMitigation = 'none';
    writeRuntimeHealth(file, state);
  }
  return explicitlyRequested || pending;
}

// Qual mitigação vale nesta execução. A bandeira explícita da pessoa vence
// sempre; depois vem o que a escada deixou pendente; e, por último, a
// mitigação que já estava valendo e não precisa de reinício.
function consumeMitigation(file, argv = process.argv, environment = process.env, now = Date.now()) {
  const state = readRuntimeHealth(file, now);
  if (argv.includes('--tumacord-xwayland') || environment.TUMACORD_OZONE === 'x11') return 'xwayland';
  if (argv.includes('--tumacord-software-composite') || environment.TUMACORD_SOFTWARE_COMPOSITE === '1') return 'software-composite';
  if (argv.includes('--tumacord-safe-gpu') || environment.TUMACORD_DISABLE_GPU === '1') return 'safe-gpu';
  if (argv.includes('--tumacord-reduce-effects') || environment.TUMACORD_REDUCE_EFFECTS === '1') return 'reduce-effects';
  const pending = state.pendingMitigation;
  if (pending !== 'none') {
    state.pendingMitigation = 'none';
    writeRuntimeHealth(file, state);
    return pending;
  }
  return state.mitigation;
}

function appendRuntimeEvent(file, event) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > 256 * 1_024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Diagnóstico nunca pode derrubar o aplicativo.
  }
}

function safeRelaunchArgs(argv = process.argv) {
  return [...new Set([...argv.slice(1), '--tumacord-safe-gpu'])];
}

// O reinício de comparação de backend não pode carregar a bandeira do degrau
// anterior: sair de `--tumacord-safe-gpu` para XWayland tem que largar a
// primeira, senão o teste compara duas mudanças ao mesmo tempo.
const MITIGATION_FLAGS = ['--tumacord-safe-gpu', '--tumacord-xwayland', '--tumacord-software-composite'];

function mitigationRelaunchArgs(step, argv = process.argv) {
  const clean = argv.slice(1).filter((entry) => !MITIGATION_FLAGS.includes(entry));
  if (step === 'xwayland') return [...clean, '--tumacord-xwayland'];
  if (step === 'safe-gpu') return [...clean, '--tumacord-safe-gpu'];
  if (step === 'software-composite') return [...clean, '--tumacord-software-composite'];
  return clean;
}

module.exports = {
  ESCALATION_COOLDOWN_MS,
  GPU_FAILURE_THRESHOLD,
  GPU_FAILURE_WINDOW_MS,
  HEALTHY_RUNS_TO_RELAX,
  MITIGATION_LADDER,
  PRESENTATION_THRESHOLD,
  PRESENTATION_WINDOW_MS,
  appendRuntimeEvent,
  consumeMitigation,
  consumeSafeGpuMode,
  mitigationRelaunchArgs,
  nextMitigation,
  normalizedState,
  previousMitigation,
  readRuntimeHealth,
  recordGpuFailure,
  recordHealthyRun,
  recordPresentationFault,
  safeRelaunchArgs,
  writeRuntimeHealth,
};
