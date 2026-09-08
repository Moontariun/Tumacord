import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  ESCALATION_COOLDOWN_MS,
  HEALTHY_RUNS_TO_RELAX,
  MITIGATION_LADDER,
  consumeMitigation,
  consumeSafeGpuMode,
  mitigationRelaunchArgs,
  readRuntimeHealth,
  recordGpuFailure,
  recordHealthyRun,
  recordPresentationFault,
  safeRelaunchArgs,
} = require('../desktop/runtime-health.cjs') as {
  ESCALATION_COOLDOWN_MS: number;
  HEALTHY_RUNS_TO_RELAX: number;
  MITIGATION_LADDER: string[];
  consumeMitigation: (file: string, argv?: string[], environment?: Record<string, string>, now?: number) => string;
  consumeSafeGpuMode: (file: string, argv?: string[], environment?: Record<string, string>, now?: number) => boolean;
  mitigationRelaunchArgs: (step: string, argv?: string[]) => string[];
  readRuntimeHealth: (file: string, now?: number) => { gpuFailures: number[]; safeModePending: boolean; mitigation: string; pendingMitigation: string };
  recordGpuFailure: (file: string, details: { type: string; reason: string }, now?: number) => { shouldRelaunch: boolean };
  recordHealthyRun: (file: string, now?: number) => { relaxed: boolean; mitigation: string };
  recordPresentationFault: (file: string, details?: Record<string, unknown>, now?: number, platform?: string) => { escalated: boolean; step: string; shouldRelaunch: boolean };
  safeRelaunchArgs: (argv?: string[]) => string[];
};

function arquivoTemporario(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tumacord-runtime-')), 'health.json');
}

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
    const depois = readRuntimeHealth(file, now + 2_000);
    assert.deepEqual(depois.gpuFailures, []);
    assert.equal(depois.safeModePending, false);
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


// A recuperação da 0.8.8 tinha um gatilho só: o processo GPU cair duas vezes
// em dez minutos. Uma interface que para de pintar com todo mundo vivo não
// acionava nada — e foi exatamente isso que aconteceu nesta máquina, onde o
// registro de saúde não guardou nenhum evento no dia da falha.
test('falha de apresentação sobe um degrau por vez, e nunca dois seguidos sem carência', () => {
  const file = arquivoTemporario();
  const now = 1_800_000_000_000;
  assert.equal(recordPresentationFault(file, {}, now, 'linux').escalated, false, 'uma falha sozinha não muda nada');
  const segunda = recordPresentationFault(file, {}, now + 1_000, 'linux');
  assert.equal(segunda.escalated, true);
  assert.equal(segunda.step, 'reduce-effects');
  assert.equal(segunda.shouldRelaunch, false, 'largar enfeite não precisa reiniciar');
  // Logo em seguida, mesmo com duas falhas novas, a carência segura.
  recordPresentationFault(file, {}, now + 2_000, 'linux');
  const cedoDemais = recordPresentationFault(file, {}, now + 3_000, 'linux');
  assert.equal(cedoDemais.escalated, false);
  assert.equal(readRuntimeHealth(file, now + 3_000).mitigation, 'reduce-effects');
});

test('a escada vai até o fim, um degrau de cada vez, respeitando a carência', () => {
  const file = arquivoTemporario();
  let now = 1_800_000_000_000;
  const degraus: string[] = [];
  for (let volta = 0; volta < 4; volta += 1) {
    recordPresentationFault(file, {}, now, 'linux');
    const passo = recordPresentationFault(file, {}, now + 1_000, 'linux');
    degraus.push(passo.step);
    now += ESCALATION_COOLDOWN_MS + 10_000;
  }
  assert.deepEqual(degraus, ['reduce-effects', 'software-composite', 'xwayland', 'safe-gpu']);
  // Chegando ao último degrau, novas falhas não reiniciam mais nada.
  recordPresentationFault(file, {}, now, 'linux');
  const teto = recordPresentationFault(file, {}, now + 1_000, 'linux');
  assert.equal(teto.escalated, false);
  assert.equal(teto.shouldRelaunch, false);
});

test('fora do Linux a escada pula o backend X11 em vez de empurrar bandeira de outro sistema', () => {
  const file = arquivoTemporario();
  let now = 1_800_000_000_000;
  const degraus: string[] = [];
  for (let volta = 0; volta < 3; volta += 1) {
    recordPresentationFault(file, {}, now, 'win32');
    degraus.push(recordPresentationFault(file, {}, now + 1_000, 'win32').step);
    now += ESCALATION_COOLDOWN_MS + 10_000;
  }
  assert.deepEqual(degraus, ['reduce-effects', 'software-composite', 'safe-gpu']);
  assert.equal(degraus.includes('xwayland'), false);
});

test('aberturas saudáveis devolvem a mitigação, um degrau por vez', () => {
  const file = arquivoTemporario();
  const now = 1_800_000_000_000;
  recordPresentationFault(file, {}, now, 'linux');
  recordPresentationFault(file, {}, now + 1_000, 'linux');
  assert.equal(readRuntimeHealth(file, now).mitigation, 'reduce-effects');
  for (let volta = 0; volta < HEALTHY_RUNS_TO_RELAX - 1; volta += 1) {
    assert.equal(recordHealthyRun(file, now + 2_000).relaxed, false);
  }
  const soltou = recordHealthyRun(file, now + 2_000);
  assert.equal(soltou.relaxed, true);
  assert.equal(soltou.mitigation, 'none');
});

test('o degrau que precisa de reinício vale na PRÓXIMA abertura e é consumido uma vez', () => {
  const file = arquivoTemporario();
  let now = 1_800_000_000_000;
  recordPresentationFault(file, {}, now, 'linux');
  recordPresentationFault(file, {}, now + 1_000, 'linux');
  now += ESCALATION_COOLDOWN_MS + 10_000;
  recordPresentationFault(file, {}, now, 'linux');
  const passo = recordPresentationFault(file, {}, now + 1_000, 'linux');
  assert.equal(passo.step, 'software-composite');
  assert.equal(passo.shouldRelaunch, true);
  assert.equal(consumeMitigation(file, ['tumacord'], {}, now + 2_000), 'software-composite');
  // Consumido o pendente, a mitigação continua valendo mas não pede reinício
  // de novo: nada de laço de reabertura.
  assert.equal(readRuntimeHealth(file, now + 2_000).pendingMitigation, 'none');
  assert.equal(consumeMitigation(file, ['tumacord'], {}, now + 3_000), 'software-composite');
});

test('a bandeira explícita da pessoa vence a escada, e o reinício não acumula bandeiras', () => {
  const file = arquivoTemporario();
  const now = 1_800_000_000_000;
  assert.equal(consumeMitigation(file, ['tumacord', '--tumacord-xwayland'], {}, now), 'xwayland');
  assert.equal(consumeMitigation(file, ['tumacord'], { TUMACORD_SOFTWARE_COMPOSITE: '1' }, now), 'software-composite');
  assert.deepEqual(
    mitigationRelaunchArgs('xwayland', ['/opt/Tumacord/tumacord', '--flag', '--tumacord-safe-gpu']),
    ['--flag', '--tumacord-xwayland'],
    'sair de um degrau para outro larga a bandeira anterior; senão o teste compara duas mudanças ao mesmo tempo',
  );
  assert.deepEqual(MITIGATION_LADDER[0], 'none');
});
