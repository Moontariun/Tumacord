import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPTURE_FAILURE_LIMIT,
  CAPTURE_RETRY_MS,
  classifyCaptureOutcome,
  describeCaptureBudget,
  effectiveEnvelope,
  fitsEnvelope,
  initialCaptureSession,
  observeCaptureSettings,
  planCaptureConstraints,
  recordCaptureAttempt,
} from '../src/lib/captureBudget.js';
import { captureEnvelopeFor } from '../src/lib/screenQuality.js';

const AGORA = 1_800_000_000_000;

test('uma captura 1440p60 com perfil 720p30 é pedida para reduzir', () => {
  const session = initialCaptureSession({ width: 2560, height: 1440, frameRate: 60 });
  const plan = planCaptureConstraints({ session, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA });
  assert.equal(plan.apply, true);
  assert.deepEqual(plan.constraints, {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  });
});

test('captura que já cabe no perfil não é reconfigurada à toa', () => {
  const session = initialCaptureSession({ width: 1280, height: 720, frameRate: 30 });
  const plan = planCaptureConstraints({ session, quality: 'balanced', settings: { width: 1280, height: 720, frameRate: 30 }, now: AGORA });
  assert.equal(plan.apply, false);
  assert.equal(plan.reason, 'already-fits');
});

test('60 contra 59,94 não conta como fora do perfil', () => {
  assert.equal(fitsEnvelope({ width: 1920, height: 1080, frameRate: 59.94 }, captureEnvelopeFor('source')), true);
  assert.equal(fitsEnvelope({ width: 1920, height: 1080, frameRate: 75 }, captureEnvelopeFor('source')), false);
});

test('constraint não suportada fecha o caminho depois de três recusas, sem ficar tentando', () => {
  let session = initialCaptureSession({ width: 2560, height: 1440, frameRate: 60 });
  for (let tentativa = 0; tentativa < CAPTURE_FAILURE_LIMIT; tentativa += 1) {
    session = recordCaptureAttempt(session, { quality: 'balanced', key: `k${tentativa}`, ok: false, outcome: 'unknown', now: AGORA + tentativa });
  }
  assert.equal(session.supported, false);
  const plan = planCaptureConstraints({ session, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA + 10_000 });
  assert.equal(plan.apply, false);
  assert.equal(plan.reason, 'unsupported');
});

test('pedido aceito e ignorado pelo navegador não é repetido em laço', () => {
  const session = initialCaptureSession({ width: 2560, height: 1440, frameRate: 60 });
  const primeiro = planCaptureConstraints({ session, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA });
  const depois = recordCaptureAttempt(session, {
    quality: 'balanced',
    key: primeiro.key,
    ok: true,
    outcome: classifyCaptureOutcome(primeiro.envelope, { width: 2560, height: 1440, frameRate: 60 }, { width: 2560, height: 1440, frameRate: 60 }),
    settings: { width: 2560, height: 1440, frameRate: 60 },
    now: AGORA,
  });
  assert.deepEqual(depois.ignored, [primeiro.key]);
  const segundo = planCaptureConstraints({ session: depois, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA + 10 * CAPTURE_RETRY_MS });
  assert.equal(segundo.apply, false);
  assert.equal(segundo.reason, 'known-ignored');
});

test('duas trocas de qualidade seguidas não viram duas reconfigurações de captura', () => {
  const session = initialCaptureSession({ width: 2560, height: 1440, frameRate: 60 });
  const primeiro = planCaptureConstraints({ session, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA });
  const depois = recordCaptureAttempt(session, { quality: 'balanced', key: primeiro.key, ok: true, outcome: 'unknown', now: AGORA });
  const repetido = planCaptureConstraints({ session: depois, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA + 1_000 });
  assert.equal(repetido.reason, 'cooling-down');
  // Passada a carência, tentar de novo é legítimo.
  const maisTarde = planCaptureConstraints({ session: depois, quality: 'balanced', settings: { width: 2560, height: 1440, frameRate: 60 }, now: AGORA + CAPTURE_RETRY_MS + 1 });
  assert.equal(maisTarde.apply, true);
});

test('reduzir a captura não ensina que a fonte encolheu, então subir de novo continua possível', () => {
  let session = initialCaptureSession({ width: 2560, height: 1440, frameRate: 60 });
  session = recordCaptureAttempt(session, { quality: 'balanced', key: 'a', ok: true, outcome: 'matched', settings: { width: 1280, height: 720, frameRate: 30 }, now: AGORA });
  assert.equal(session.sourceWidth, 2560);
  const subir = planCaptureConstraints({ session, quality: 'source', settings: { width: 1280, height: 720, frameRate: 30 }, now: AGORA + CAPTURE_RETRY_MS + 1 });
  assert.equal(subir.apply, true);
  assert.equal(subir.envelope.width, 1920);
});

test('subir de qualidade respeita o que a fonte já provou entregar', () => {
  const session = observeCaptureSettings(initialCaptureSession(), { width: 1920, height: 1080, frameRate: 30 });
  const envelope = effectiveEnvelope(session, 'ultra60');
  assert.equal(envelope.width, 1920);
  assert.equal(envelope.height, 1080);
  assert.equal(envelope.frameRate, 30);
});

test('o orçamento de FPS entra na captura, não só no encoder', () => {
  const session = initialCaptureSession({ width: 1920, height: 1080, frameRate: 60 });
  const plan = planCaptureConstraints({ session, quality: 'source', settings: { width: 1920, height: 1080, frameRate: 60 }, now: AGORA, fpsBudget: 30 });
  assert.equal(plan.apply, true);
  assert.deepEqual(plan.constraints?.frameRate, { ideal: 30, max: 30 });
});

test('classificação separa o que reduziu do que não reduziu e do que não dá para saber', () => {
  const envelope = captureEnvelopeFor('balanced');
  assert.equal(classifyCaptureOutcome(envelope, { width: 2560, height: 1440 }, { width: 1280, height: 720, frameRate: 30 }), 'matched');
  assert.equal(classifyCaptureOutcome(envelope, { width: 2560, height: 1440, frameRate: 60 }, { width: 1920, height: 1080, frameRate: 60 }), 'reduced');
  assert.equal(classifyCaptureOutcome(envelope, { width: 2560, height: 1440, frameRate: 60 }, { width: 2560, height: 1440, frameRate: 60 }), 'ignored');
  assert.equal(classifyCaptureOutcome(envelope, { width: 2560, height: 1440 }, {}), 'unknown');
});

// O texto é a parte que a pessoa lê. Ele não pode dizer "economizei" quando a
// captura continuou grande: era exatamente a mentira que a 0.8.8 contava ao
// anunciar 720p enquanto capturava 1440p60.
test('um 720p que não reduziu a captura não anuncia economia', () => {
  const envelope = captureEnvelopeFor('balanced');
  const texto = describeCaptureBudget('balanced', envelope, { width: 2560, height: 1440, frameRate: 60 });
  assert.match(texto, /acima do pedido/);
  assert.match(texto, /2560×1440/);
  const honesto = describeCaptureBudget('balanced', envelope, { width: 1280, height: 720, frameRate: 30 });
  assert.match(honesto, /dentro do pedido/);
  const semMedida = describeCaptureBudget('balanced', envelope, {});
  assert.match(semMedida, /desconhecida/);
});
