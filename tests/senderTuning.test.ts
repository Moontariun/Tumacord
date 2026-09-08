import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTuneOutcome,
  commandIsStale,
  degradationFor,
  initialTuneApplied,
  screenContentHint,
  screenEncoding,
  shouldRetry,
  TUNE_ATTEMPT_LIMIT,
  tuneIsNeeded,
  type TuneCommand,
} from '../src/lib/senderTuning.js';
import { SCREEN_QUALITIES } from '../src/lib/screenQuality.js';

const COMANDO: TuneCommand = { maxBitrate: 8_000_000, scale: 1, frameRate: 60, holdResolution: false };

// O defeito de estado da 0.8.8, virado teste.
test('setParameters rejeitado NÃO atualiza o estado aplicado', () => {
  const antes = { maxBitrate: 5_000_000, scale: 2, frameRate: 30, changedAt: 1_000, attempts: 0 };
  const depois = applyTuneOutcome(antes, COMANDO, false, 9_999);
  assert.equal(depois.scale, 2, 'a escala aplicada continua sendo a que o encoder tem');
  assert.equal(depois.frameRate, 30);
  assert.equal(depois.maxBitrate, 5_000_000);
  assert.equal(depois.changedAt, 1_000, 'o carimbo de tempo não pode marcar uma mudança que não houve');
  assert.equal(depois.attempts, 1);
});

test('só o sucesso move o estado aplicado e o carimbo de tempo', () => {
  const depois = applyTuneOutcome(initialTuneApplied(2, 30), COMANDO, true, 9_999);
  assert.deepEqual(depois, { maxBitrate: 8_000_000, scale: 1, frameRate: 60, changedAt: 9_999, attempts: 0 });
});

test('a repetição tem teto e o sucesso zera a contagem', () => {
  let estado = initialTuneApplied();
  for (let volta = 0; volta < TUNE_ATTEMPT_LIMIT; volta += 1) {
    assert.equal(shouldRetry(estado), true, `tentativa ${volta} ainda vale`);
    estado = applyTuneOutcome(estado, COMANDO, false, volta);
  }
  assert.equal(shouldRetry(estado), false, 'três recusas seguidas fecham a repetição');
  assert.equal(shouldRetry(applyTuneOutcome(estado, COMANDO, true, 10)), true);
});

// Duas trocas de qualidade em sequência: a primeira não pode chegar ao encoder
// depois da segunda.
test('comando obsoleto é descartado em vez de aplicado', () => {
  const antigo: TuneCommand = { maxBitrate: 2_500_000, scale: 2, frameRate: 30, holdResolution: true };
  assert.equal(commandIsStale(antigo, { scale: 1, frameRate: 60 }), true);
  assert.equal(commandIsStale(antigo, { scale: 2, frameRate: 30 }), false);
  // Só o FPS mudando já basta para o comando anterior ser obsoleto.
  assert.equal(commandIsStale(antigo, { scale: 2, frameRate: 48 }), true);
});

test('o teto de FPS do orçamento nunca passa do perfil', () => {
  const encoding = screenEncoding(SCREEN_QUALITIES.high, { ...COMANDO, frameRate: 60 });
  assert.equal(encoding.maxFramerate, 30, 'o perfil 1080p30 manda, mesmo com orçamento de 60');
  assert.equal(screenEncoding(SCREEN_QUALITIES.source, { ...COMANDO, frameRate: 30 }).maxFramerate, 30);
  assert.equal(screenEncoding(SCREEN_QUALITIES.source, { ...COMANDO, frameRate: 0 }).maxFramerate, 1, 'nunca zero');
  assert.equal(screenEncoding(SCREEN_QUALITIES.source, { ...COMANDO, scale: 9 }).scaleResolutionDownBy, 4);
});

test('o par de dicas conta a mesma história para jogo e para leitura', () => {
  assert.equal(screenContentHint(SCREEN_QUALITIES.source), 'motion');
  assert.equal(degradationFor(SCREEN_QUALITIES.source, COMANDO), 'maintain-framerate');
  assert.equal(screenContentHint(SCREEN_QUALITIES.high), 'detail');
  assert.equal(degradationFor(SCREEN_QUALITIES.high, COMANDO), 'maintain-resolution');
  // Na abertura a resolução é segurada, qualquer que seja o perfil.
  assert.equal(degradationFor(SCREEN_QUALITIES.source, { ...COMANDO, holdResolution: true }), 'maintain-resolution');
});

test('um comando que não muda nada não vira setParameters', () => {
  const aplicado = { maxBitrate: 8_000_000, scale: 1, frameRate: 60, changedAt: 0, attempts: 0 };
  assert.equal(tuneIsNeeded(aplicado, COMANDO), false);
  assert.equal(tuneIsNeeded(aplicado, { ...COMANDO, maxBitrate: 8_050_000 }), false, '50 kbps em 8 Mbps é ruído');
  assert.equal(tuneIsNeeded(aplicado, { ...COMANDO, maxBitrate: 5_000_000 }), true);
  assert.equal(tuneIsNeeded(aplicado, { ...COMANDO, frameRate: 48 }), true);
  assert.equal(tuneIsNeeded(aplicado, { ...COMANDO, scale: 1.25 }), true);
  assert.equal(tuneIsNeeded(aplicado, COMANDO, true), true, 'a saída da janela de abertura força reaplicar');
  assert.equal(tuneIsNeeded(initialTuneApplied(), COMANDO), true, 'sem bitrate aplicado ainda, sempre precisa');
});
