import assert from 'node:assert/strict';
import test from 'node:test';
import { captureEnvelopeFor, CAPTURE_CEILING, desktopScreenCaptureConstraints, maximumAdaptiveScreenScale, parseStreamQuality, SCREEN_QUALITIES, screenBitrateHints, screenCaptureConstraints, screenQualityOptions, screenQualityOrder, screenScaleForQuality } from '../src/lib/screenQuality.js';

test('qualidade padrão é 1080p60 e valor salvo inválido não reduz a live silenciosamente', () => {
  assert.equal(parseStreamQuality(null), 'source');
  assert.equal(parseStreamQuality('valor-antigo'), 'source');
  assert.equal(parseStreamQuality('ultra30'), 'ultra30');
  assert.equal(SCREEN_QUALITIES.source.label, '1080p · 60 FPS');
});

// Este teste substitui o da 0.8.8, que EXIGIA captura 1440p60 em todos os
// perfis. Aquele comportamento era o defeito: escolher 720p30 num monitor
// 1440p continuava capturando 1440p60 e mandava o encoder reduzir cada quadro
// por software.
test('cada perfil pede à captura o seu próprio teto, não 1440p60 para todos', () => {
  assert.deepEqual(screenCaptureConstraints('balanced'), {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  });
  assert.deepEqual(desktopScreenCaptureConstraints('balanced'), {
    chromeMediaSource: 'desktop',
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 30,
  });
  assert.deepEqual(screenCaptureConstraints('source').width, { ideal: 1920, max: 1920 });
  assert.deepEqual(desktopScreenCaptureConstraints('data').maxFrameRate, 15);
});

test('o perfil mais alto ainda respeita o teto absoluto de captura', () => {
  assert.deepEqual(captureEnvelopeFor('ultra60'), { ...SCREEN_QUALITIES.ultra60 });
  assert.equal(captureEnvelopeFor('ultra60').width, CAPTURE_CEILING.width);
  assert.equal(captureEnvelopeFor('ultra60').frameRate, CAPTURE_CEILING.frameRate);
});

test('perfil inválido cai no padrão em vez de estourar o teto de captura', () => {
  assert.deepEqual(captureEnvelopeFor('inexistente' as never), { ...SCREEN_QUALITIES.source });
});

test('a escala do encoder continua compensando uma captura maior que o perfil', () => {
  const settings = { width: 2560, height: 1440 };
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.ultra60), 1);
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.source), 1.33);
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.balanced), 2);
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.data), 3);
  assert.equal(maximumAdaptiveScreenScale(3), 4);
});

test('seletor lista as resoluções em ordem crescente e sem repetir a mesma altura fora de ordem', () => {
  assert.deepEqual(screenQualityOptions.map(([, option]) => option.label), [
    '480p · 15 FPS',
    '720p · 30 FPS',
    '1080p · 30 FPS',
    '1080p · 60 FPS',
    '1440p · 30 FPS',
    '1440p · 60 FPS',
  ]);
  assert.deepEqual(screenQualityOrder, ['data', 'balanced', 'high', 'source', 'ultra30', 'ultra60']);
});

test('dicas de bitrate abrem a live perto do perfil escolhido', () => {
  const hints = screenBitrateHints(SCREEN_QUALITIES.source);
  assert.equal(hints.maxKbps, 8_000);
  assert.equal(hints.startKbps, 6_800);
  assert.equal(hints.minKbps, 2_800);
});
