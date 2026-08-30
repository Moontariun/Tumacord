import assert from 'node:assert/strict';
import test from 'node:test';
import { volumeToGain } from '../src/lib/audioGain';

test('mantém 100% em ganho unitário', () => {
  assert.equal(volumeToGain(1), 1);
});

test('transforma 200% em +10 dB de ganho real', () => {
  assert.ok(Math.abs(volumeToGain(2) - Math.sqrt(10)) < 0.000001);
});

test('limita o ganho entre silêncio e 200%', () => {
  assert.equal(volumeToGain(-1), 0);
  assert.equal(volumeToGain(3), Math.sqrt(10));
});
