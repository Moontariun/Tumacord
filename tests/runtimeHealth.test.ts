import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { consumeSafeGpuMode, readRuntimeHealth, recordGpuFailure, safeRelaunchArgs } = require('../desktop/runtime-health.cjs') as {
  consumeSafeGpuMode: (file: string, argv?: string[], environment?: Record<string, string>, now?: number) => boolean;
  readRuntimeHealth: (file: string, now?: number) => { gpuFailures: number[]; safeModePending: boolean };
  recordGpuFailure: (file: string, details: { type: string; reason: string }, now?: number) => { shouldRelaunch: boolean };
  safeRelaunchArgs: (argv?: string[]) => string[];
};

test('entra em modo gráfico seguro somente após falhas GPU repetidas', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tumacord-runtime-'));
  const file = path.join(directory, 'health.json');
  const now = 1_800_000_000_000;
  try {
    assert.equal(recordGpuFailure(file, { type: 'Utility', reason: 'crashed' }, now).shouldRelaunch, false);
    assert.equal(recordGpuFailure(file, { type: 'GPU', reason: 'clean-exit' }, now).shouldRelaunch, false);
    assert.equal(recordGpuFailure(file, { type: 'GPU', reason: 'crashed' }, now).shouldRelaunch, false);
    assert.equal(recordGpuFailure(file, { type: 'GPU', reason: 'oom' }, now + 1_000).shouldRelaunch, true);
    assert.equal(consumeSafeGpuMode(file, ['tumacord'], {}, now + 2_000), true);
    assert.deepEqual(readRuntimeHealth(file, now + 2_000), { gpuFailures: [], safeModePending: false });
    assert.equal(consumeSafeGpuMode(file, ['tumacord'], {}, now + 3_000), false, 'fallback automático vale por uma execução');
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test('falhas antigas expiram e flags explícitas ativam o fallback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tumacord-runtime-'));
  const file = path.join(directory, 'health.json');
  const now = 1_800_000_000_000;
  try {
    recordGpuFailure(file, { type: 'GPU', reason: 'crashed' }, now - 700_000);
    assert.equal(recordGpuFailure(file, { type: 'GPU', reason: 'crashed' }, now).shouldRelaunch, false);
    assert.equal(consumeSafeGpuMode(file, ['tumacord', '--tumacord-safe-gpu'], {}, now), true);
    assert.equal(consumeSafeGpuMode(file, ['tumacord'], { TUMACORD_DISABLE_GPU: '1' }, now), true);
    assert.deepEqual(safeRelaunchArgs(['/opt/Tumacord/tumacord', '--flag', '--tumacord-safe-gpu']), ['--flag', '--tumacord-safe-gpu']);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
