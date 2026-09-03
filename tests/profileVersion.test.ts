import assert from 'node:assert/strict';
import test from 'node:test';
import { profileIsNewer, profileRevisionKey } from '../shared/profileVersion.js';

test('cliente e servidor usam o mesmo desempate para perfis simultâneos', () => {
  const updatedAt = '2026-09-02T12:00:00.000Z';
  const alpha = { bio: 'alfa', accentColor: '#aa0000', updatedAt };
  const beta = { bio: 'beta', accentColor: '#bb0000', updatedAt };
  const winner = profileRevisionKey(alpha) > profileRevisionKey(beta) ? alpha : beta;
  const loser = winner === alpha ? beta : alpha;
  assert.equal(profileIsNewer(winner, loser), true);
  assert.equal(profileIsNewer(loser, winner), false);
  assert.equal(profileIsNewer(winner, winner), false);
});
