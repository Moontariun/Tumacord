import assert from 'node:assert/strict';
import test from 'node:test';
import { volumeToGain } from '../src/lib/audioGain';

test('mantém 100% em ganho unitário', () => {
  assert.equal(volumeToGain(1), 1);
});

test('transforma 200% em +18 dB de ganho real', () => {
  assert.ok(Math.abs(volumeToGain(2) - (10 ** 0.9)) < 0.000001);
});

test('limita o ganho entre silêncio e 200%', () => {
  assert.equal(volumeToGain(-1), 0);
  assert.equal(volumeToGain(3), 10 ** 0.9);
});

test('150% já produz aumento claramente perceptível', () => {
  assert.ok(Math.abs(volumeToGain(1.5) - (10 ** 0.45)) < 0.000001);
});
