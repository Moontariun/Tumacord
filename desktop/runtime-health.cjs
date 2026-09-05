const fs = require('node:fs');
const path = require('node:path');

const GPU_FAILURE_WINDOW_MS = 10 * 60 * 1_000;
const GPU_FAILURE_THRESHOLD = 2;
const GPU_FAILURE_REASONS = new Set(['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);

function emptyState() {
  return { gpuFailures: [], safeModePending: false };
}

function normalizedState(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return emptyState();
  const gpuFailures = Array.isArray(value.gpuFailures)
    ? value.gpuFailures.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now - GPU_FAILURE_WINDOW_MS && timestamp <= now)
    : [];
  return { gpuFailures, safeModePending: value.safeModePending === true };
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

function recordGpuFailure(file, details, now = Date.now()) {
  const state = readRuntimeHealth(file, now);
  if (details?.type !== 'GPU' || !GPU_FAILURE_REASONS.has(details.reason)) return { ...state, shouldRelaunch: false };
  state.gpuFailures.push(now);
  state.safeModePending = state.gpuFailures.length >= GPU_FAILURE_THRESHOLD;
  writeRuntimeHealth(file, state);
  return { ...state, shouldRelaunch: state.safeModePending };
}

function consumeSafeGpuMode(file, argv = process.argv, environment = process.env, now = Date.now()) {
  const explicitlyRequested = argv.includes('--tumacord-safe-gpu') || environment.TUMACORD_DISABLE_GPU === '1';
  const state = readRuntimeHealth(file, now);
  const pending = state.safeModePending;
  if (pending) writeRuntimeHealth(file, emptyState());
  return explicitlyRequested || pending;
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

module.exports = {
  GPU_FAILURE_THRESHOLD,
  GPU_FAILURE_WINDOW_MS,
  appendRuntimeEvent,
  consumeSafeGpuMode,
  normalizedState,
  readRuntimeHealth,
  recordGpuFailure,
  safeRelaunchArgs,
  writeRuntimeHealth,
};
