// Movement feedback: one wording per input outcome — the accepted press, the server's refusal and
// the reconcile after a refusal. The wording is produced from the server's own result, so the HUD can
// never describe a tile the step did not reach, and a refusal names what stopped it and where the
// player still stands, which is what makes a refusal recoverable rather than silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveFeedback, blockedCause } from '../src/camera-controls.js';

test('an accepted step reports the direction and the tile the server stored', () => {
  assert.deepEqual(moveFeedback({ outcome: 'step', direction: 'up', to: { x: 10, y: 5 } }), { tone: 'step', text: 'Stepped up to 10, 5.' });
  // A fractional drawn point is named by the tile it falls in, never by a fraction.
  assert.equal(moveFeedback({ outcome: 'step', direction: 'left', to: { x: 9.4, y: 5.9 } }).text, 'Stepped left to 9, 5.');
});

test('a refusal names the obstacle, the stored tile, and the way out', () => {
  const blocked = moveFeedback({ outcome: 'blocked', direction: 'up', from: { x: 10, y: 6 }, cause: 'water' });
  assert.deepEqual(blocked, { tone: 'refused', text: 'The way up is blocked by water. Restored to 10, 6 — choose another direction.' });
  assert.equal(moveFeedback({ outcome: 'blocked', direction: 'right', from: { x: 1, y: 1 } }).text, 'The way right is blocked. Restored to 1, 1 — choose another direction.');
  // The refusal must name where the player still stands, so it can never imply a step was taken.
  const at = moveFeedback({ outcome: 'blocked', direction: 'down', from: { x: 2, y: 3 }, cause: 'a tree' });
  assert.match(at.text, /Restored to 2, 3/);
  assert.doesNotMatch(at.text, /Stepped/);
});

test('a failed request is a refusal too: the server’s reason travels with the reconcile', () => {
  const restored = moveFeedback({ outcome: 'restored', from: { x: 4, y: 4 }, message: 'Move more slowly.' });
  assert.deepEqual(restored, { tone: 'restored', text: 'Move more slowly. Restored to 4, 4.' });
  assert.equal(moveFeedback({ outcome: 'restored', from: { x: 4, y: 4 } }).text, 'Restored to 4, 4.', 'a missing reason still reconciles readably');
  assert.equal(moveFeedback({ outcome: 'travel', message: 'Arrived in The Hall.' }).tone, 'travel');
  assert.deepEqual(moveFeedback({ outcome: 'travel' }), { tone: 'travel', text: 'Arrived.' });
});

test('the obstacle is named from the terrain and scenery the client already holds', () => {
  assert.equal(blockedCause({ terrain: 'water' }), 'water');
  assert.equal(blockedCause({ terrain: 'tree' }), 'a tree');
  assert.equal(blockedCause({ terrain: 'building' }), 'a building');
  assert.equal(blockedCause({ terrain: 'wall' }), 'a wall');
  assert.equal(blockedCause({ terrain: 'fountain' }), 'the fountain');
  assert.equal(blockedCause({ scenery: true }), 'a solid object', 'saved furniture and scenery block as one object');
  assert.equal(blockedCause({ outside: true }), 'the edge of the world', 'a step past the map is named as the edge, not as terrain');
  assert.equal(blockedCause({ terrain: 'stone_court' }), 'the stone court', 'an unnamed terrain type is still spoken plainly');
  assert.equal(blockedCause({}), '', 'nothing known is no claim at all');
  // The blocked feedback folds the cause in without inventing one when there is none.
  assert.equal(moveFeedback({ outcome: 'blocked', direction: 'up', from: { x: 0, y: 0 }, cause: blockedCause({ terrain: 'water' }) }).text,
    'The way up is blocked by water. Restored to 0, 0 — choose another direction.');
});
