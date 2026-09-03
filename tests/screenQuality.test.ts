import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopScreenCaptureConstraints, maximumAdaptiveScreenScale, parseStreamQuality, SCREEN_QUALITIES, screenCaptureConstraints, screenScaleForQuality } from '../src/lib/screenQuality.js';

test('qualidade padrão é 1080p60 e valor salvo inválido não reduz a live silenciosamente', () => {
  assert.equal(parseStreamQuality(null), 'source');
  assert.equal(parseStreamQuality('valor-antigo'), 'source');
  assert.equal(parseStreamQuality('ultra30'), 'ultra30');
  assert.equal(SCREEN_QUALITIES.source.label, '1080p · 60 FPS');
});

test('todas as qualidades reutilizam uma única captura 1440p60', () => {
  assert.deepEqual(screenCaptureConstraints(), {
    width: { ideal: 2560, max: 2560 },
    height: { ideal: 1440, max: 1440 },
    frameRate: { ideal: 60, max: 60 },
  });
  assert.deepEqual(desktopScreenCaptureConstraints(), {
    chromeMediaSource: 'desktop',
    maxWidth: 2560,
    maxHeight: 1440,
    maxFrameRate: 60,
  });
});

test('troca de qualidade calcula somente a escala do encoder da captura existente', () => {
  const settings = { width: 2560, height: 1440 };
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.ultra60), 1);
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.source), 1.33);
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.balanced), 2);
  assert.equal(screenScaleForQuality(settings, SCREEN_QUALITIES.data), 3);
  assert.equal(maximumAdaptiveScreenScale(3), 4);
});
