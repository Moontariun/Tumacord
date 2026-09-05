import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEAD_HOLD_MS,
  DEVICE_CHANGE_HOLD_MS,
  MAX_AUTOMATIC_RECAPTURES,
  MUTED_HOLD_MS,
  RECAPTURE_COOLDOWN_MS,
  SILENCE_HOLD_MS,
  capturedDeviceIsGone,
  defaultAudioInputSignature,
  describeMicrophoneFault,
  faultFromLevel,
  initialMicrophoneFault,
  microphoneIdentityOf,
  planMicrophoneRecovery,
  type MicrophoneFault,
} from '../src/lib/microphoneHealth';

type FakeDevice = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'groupId'>;

const fifine: FakeDevice = { kind: 'audioinput', deviceId: 'id-fifine', groupId: 'grupo-fifine' };
const webcam: FakeDevice = { kind: 'audioinput', deviceId: 'id-webcam', groupId: 'grupo-webcam' };
const defaultAsFifine: FakeDevice = { kind: 'audioinput', deviceId: 'default', groupId: 'grupo-fifine' };
const defaultAsWebcam: FakeDevice = { kind: 'audioinput', deviceId: 'default', groupId: 'grupo-webcam' };

test('a assinatura do dispositivo padrão vem do grupo da entrada virtual', () => {
  assert.equal(defaultAudioInputSignature([defaultAsFifine, fifine, webcam]), 'grupo-fifine');
  assert.equal(defaultAudioInputSignature([fifine, webcam]), '', 'sem a entrada virtual não há assinatura para comparar');
  assert.equal(defaultAudioInputSignature([{ kind: 'audioinput', deviceId: 'default', groupId: '' }]), 'default');
});

test('a identidade resolvida sai das configurações da faixa, não da preferência', () => {
  assert.deepEqual(microphoneIdentityOf({ getSettings: () => ({ deviceId: 'id-fifine', groupId: 'grupo-fifine' }) }), { deviceId: 'id-fifine', groupId: 'grupo-fifine' });
  assert.deepEqual(microphoneIdentityOf(undefined), { deviceId: '', groupId: '' });
  assert.deepEqual(microphoneIdentityOf({ getSettings: () => ({}) }), { deviceId: '', groupId: '' });
});

test('com “Padrão do sistema”, mudar o padrão conta como dispositivo perdido', () => {
  const base = { preferenceId: '', captured: { deviceId: 'default', groupId: 'grupo-fifine' }, capturedDefaultSignature: 'grupo-fifine' };
  assert.equal(capturedDeviceIsGone({ ...base, devices: [defaultAsFifine, fifine, webcam] }), false);
  assert.equal(capturedDeviceIsGone({ ...base, devices: [defaultAsWebcam, fifine, webcam] }), true);
});

test('lista vazia ou sem entrada padrão não é tratada como perda de dispositivo', () => {
  const base = { preferenceId: '', captured: { deviceId: 'default', groupId: 'grupo-fifine' }, capturedDefaultSignature: 'grupo-fifine' };
  assert.equal(capturedDeviceIsGone({ ...base, devices: [] }), false, 'antes da permissão a lista chega vazia');
  assert.equal(capturedDeviceIsGone({ ...base, devices: [fifine] }), false);
  assert.equal(capturedDeviceIsGone({ ...base, capturedDefaultSignature: '', devices: [defaultAsWebcam, fifine] }), false);
});

test('com um dispositivo escolhido, perder é sumir da lista', () => {
  const base = { preferenceId: 'id-fifine', captured: { deviceId: 'id-fifine', groupId: 'grupo-fifine' }, capturedDefaultSignature: '' };
  assert.equal(capturedDeviceIsGone({ ...base, devices: [fifine, webcam] }), false);
  assert.equal(capturedDeviceIsGone({ ...base, devices: [webcam] }), true);
});

test('energia zero é captura morta; energia baixa é sala quieta', () => {
  assert.equal(faultFromLevel(0), 'dead');
  assert.equal(faultFromLevel(0.0005), 'silent');
  assert.equal(faultFromLevel(0.006), 'silent');
  assert.equal(faultFromLevel(0.02), 'none');
});

function planAt(fault: MicrophoneFault, elapsed: number, overrides: Partial<Parameters<typeof planMicrophoneRecovery>[0]> = {}) {
  const now = 1_000_000;
  return planMicrophoneRecovery({ now, fault, faultSince: now - elapsed, lastRecaptureAt: 0, recaptures: 0, warned: false, ...overrides });
}

test('cada falha tem o próprio tempo de espera antes da recaptura', () => {
  assert.equal(planAt('none', 10 * 60_000).action, 'wait');
  assert.equal(planAt('muted', MUTED_HOLD_MS - 1).action, 'wait');
  assert.equal(planAt('muted', MUTED_HOLD_MS).action, 'recapture');
  assert.equal(planAt('device-changed', DEVICE_CHANGE_HOLD_MS).action, 'recapture');
  assert.equal(planAt('dead', DEAD_HOLD_MS - 1).action, 'wait');
  assert.equal(planAt('dead', DEAD_HOLD_MS).action, 'recapture');
  assert.equal(planAt('silent', DEAD_HOLD_MS).action, 'wait', 'sala quieta não pode custar uma renegociação');
  assert.equal(planAt('silent', SILENCE_HOLD_MS).action, 'recapture');
});

test('a captura morta é reconhecida muito antes do silêncio comum', () => {
  assert.ok(DEAD_HOLD_MS < SILENCE_HOLD_MS / 5);
});

test('o intervalo mínimo impede recapturas em sequência', () => {
  const now = 1_000_000;
  const plan = planMicrophoneRecovery({ now, fault: 'dead', faultSince: now - DEAD_HOLD_MS, lastRecaptureAt: now - (RECAPTURE_COOLDOWN_MS - 1), recaptures: 1, warned: false });
  assert.deepEqual(plan, { action: 'wait', recaptures: 1 });
  const afterCooldown = planMicrophoneRecovery({ now, fault: 'dead', faultSince: now - DEAD_HOLD_MS, lastRecaptureAt: now - RECAPTURE_COOLDOWN_MS, recaptures: 1, warned: false });
  assert.deepEqual(afterCooldown, { action: 'recapture', recaptures: 2 });
});

test('esgotado o orçamento, o app avisa uma vez e para de tentar', () => {
  const now = 1_000_000;
  const exhausted = { now, fault: 'dead' as const, faultSince: now - DEAD_HOLD_MS, lastRecaptureAt: now - 60_000, recaptures: MAX_AUTOMATIC_RECAPTURES };
  assert.deepEqual(planMicrophoneRecovery({ ...exhausted, warned: false }), { action: 'warn', recaptures: MAX_AUTOMATIC_RECAPTURES });
  assert.deepEqual(planMicrophoneRecovery({ ...exhausted, warned: true }), { action: 'wait', recaptures: MAX_AUTOMATIC_RECAPTURES });
});

test('cada falha se explica em português para quem está na call', () => {
  assert.match(describeMicrophoneFault('muted'), /interrompida/);
  assert.match(describeMicrophoneFault('device-changed'), /padrão do sistema/);
  assert.match(describeMicrophoneFault('dead'), /nenhuma amostra/);
  assert.match(describeMicrophoneFault('silent'), /não capta som/);
  assert.equal(describeMicrophoneFault('none'), '');
});

// --- leitura por pipeline (medidor e contexto sempre do mesmo lugar) ---

import { faultFromReading, microphoneIsMeasurable, type MicrophoneReading } from '../src/lib/microphoneHealth';

const faixaViva = { readyState: 'live', enabled: true, muted: false };

function leitura(patch: Partial<MicrophoneReading> = {}): MicrophoneReading {
  return { level: 0.05, contextState: 'running', track: faixaViva, userMuted: false, ...patch };
}

// O defeito corrigido: o caminho neural media no medidor do próprio
// processamento, mas a saúde consultava o AudioContext compartilhado. Com o
// compartilhado suspenso, a recuperação se desligava sozinha.
test('o contexto avaliado é o que acompanha o medidor, não outro qualquer', () => {
  assert.equal(microphoneIsMeasurable(leitura({ contextState: 'running' })), true);
  assert.equal(microphoneIsMeasurable(leitura({ contextState: 'suspended' })), false);
  assert.equal(microphoneIsMeasurable(leitura({ contextState: 'unknown' })), false);
});

test('sem medidor a leitura não vira silêncio — ela simplesmente não diz nada', () => {
  assert.equal(microphoneIsMeasurable(leitura({ level: null })), false);
  assert.equal(faultFromReading(leitura({ level: null })), 'none', 'ausência de medida não pode disparar recaptura');
});

test('a faixa precisa estar viva, habilitada e não silenciada para a medida valer', () => {
  assert.equal(microphoneIsMeasurable(leitura({ track: { ...faixaViva, readyState: 'ended' } })), false);
  assert.equal(microphoneIsMeasurable(leitura({ track: { ...faixaViva, enabled: false } })), false);
  assert.equal(microphoneIsMeasurable(leitura({ track: { ...faixaViva, muted: true } })), false);
  assert.equal(microphoneIsMeasurable(leitura({ track: null })), false);
});

test('faixa silenciada pelo sistema é falha de mic, mesmo sem o evento onmute', () => {
  assert.equal(faultFromReading(leitura({ track: { ...faixaViva, muted: true } })), 'muted');
});

test('quem se mutou de propósito nunca é tratado como microfone quebrado', () => {
  assert.equal(faultFromReading(leitura({ userMuted: true, level: 0 })), 'none');
  assert.equal(microphoneIsMeasurable(leitura({ userMuted: true })), false);
});

test('com tudo no lugar, a energia decide entre captura morta, sala quieta e ok', () => {
  assert.equal(faultFromReading(leitura({ level: 0 })), 'dead');
  assert.equal(faultFromReading(leitura({ level: 0.001 })), 'silent');
  assert.equal(faultFromReading(leitura({ level: 0.05 })), 'none');
});

// Sair da call precisa devolver a saúde do microfone ao começo. Sem isso o
// orçamento gasto na chamada anterior deixava a recuperação desligada na
// seguinte — justamente quando alguém saiu e voltou por causa de áudio.
test('o estado inicial da falha começa zerado e não é compartilhado', () => {
  const primeiro = initialMicrophoneFault();
  assert.deepEqual(primeiro, { kind: 'none', since: 0, recaptures: 0, lastRecaptureAt: 0, warned: false });
  primeiro.recaptures = 3;
  primeiro.warned = true;
  const segundo = initialMicrophoneFault();
  assert.equal(segundo.recaptures, 0, 'cada chamada devolve um objeto próprio');
  assert.equal(segundo.warned, false);
});

test('com o orçamento devolvido, a recuperação volta a agir', () => {
  const agora = 1_000_000;
  const gasto = { now: agora, fault: 'dead' as const, faultSince: agora - DEAD_HOLD_MS, lastRecaptureAt: 0, recaptures: MAX_AUTOMATIC_RECAPTURES, warned: true };
  assert.equal(planMicrophoneRecovery(gasto).action, 'wait', 'esgotado, ele desiste');
  const devolvido = { ...gasto, ...initialMicrophoneFault(), now: agora, fault: 'dead' as const, faultSince: agora - DEAD_HOLD_MS };
  assert.equal(planMicrophoneRecovery(devolvido).action, 'recapture');
});
