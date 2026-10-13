// The keyboard and text half of direct world interaction.
//
// These are the pure controls the world view drives: the reach a fixture uses, the keys that use the
// fixture the aim line names, and the aim line's own reading of it. Driving a real browser is the job
// of `npm run browser`; this file deliberately starts nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTION_DISTANCE, INTERACTION_KEYS, isInteractionKey, keyIntent, reticleText, WALK_KEYS, TURN_KEYS } from '../src/camera-controls.js';

const inReach = { label: 'Bench', x: 12, y: 7, in_range: true, required_distance: INTERACTION_DISTANCE, action: { label: 'Sit on the bench' } };
const outOfReach = { label: 'Door', x: 35, y: 24, in_range: false, required_distance: INTERACTION_DISTANCE, action: { label: 'Enter The Makers’ Workshop' } };

test('a fixture is used at the same one-tile reach a doorway already requires', () => {
  assert.equal(INTERACTION_DISTANCE, 1);
  assert.deepEqual([...INTERACTION_KEYS], ['Enter', ' ', 'i']);
  for (const key of INTERACTION_KEYS) {
    assert.equal(isInteractionKey(key), true);
    assert.deepEqual(keyIntent(key, { agent: true, fixture: true }), { kind: 'interact' }, `${key} uses the picked fixture`);
  }
});

test('the interaction keys stay unbound until a fixture is picked, and never replace walking or building', () => {
  // Without a picked fixture the keys keep their old meaning (none), so walking and turning are
  // unchanged for everyone who is not using a fixture.
  for (const key of [...INTERACTION_KEYS, 'z', 'Tab', '1']) assert.equal(keyIntent(key, { agent: true }), null);
  for (const key of INTERACTION_KEYS) assert.equal(keyIntent(key, { agent: true, fixture: true, building: true }), null, 'building keeps its own keys');
  assert.deepEqual(keyIntent('3', { frontier: true, palette: ['stone', 'wood', 'glass'], agent: true, fixture: true }), { kind: 'build', type: 'glass' }, 'a frontier digit still picks a block');
  for (const [key, direction] of Object.entries(WALK_KEYS)) assert.deepEqual(keyIntent(key, { agent: true, fixture: true }), { kind: 'walk', direction });
  for (const [key, turn] of Object.entries(TURN_KEYS)) assert.deepEqual(keyIntent(key, { agent: true, fixture: true }), { kind: 'turn', yaw: turn.yaw, pitch: turn.pitch });
  assert.deepEqual(keyIntent('Enter', { agent: false, fixture: true }), { kind: 'interact' }, 'a visitor who has picked a fixture can still press Enter — the server decides what it may do');
});

test('the aim line names the fixture and the way to use it, in plain text', () => {
  const ready = reticleText({ firstPerson: true, facing: { yaw: 0 }, position: { x: 12, y: 8 }, selection: { x: 12, y: 7, type: 'object' }, blocked: true, fixture: inReach });
  assert.match(ready, /the bench with Enter, Space or I/);
  assert.match(ready, /Sit on the bench with Enter, Space or I/);
  assert.match(ready, /aimed at scenery 12, 7/);
  const far = reticleText({ facing: { yaw: 0 }, position: { x: 10, y: 6 }, selection: { x: 35, y: 24, type: 'portal' }, fixture: outOfReach });
  assert.match(far, /stand within 1 tile of the door at 35, 24/);
  assert.equal(/with Enter, Space or I/.test(far), false, 'a fixture out of reach is not offered as usable');
  for (const text of [ready, far]) assert.equal(/[<>]/.test(text), false, 'the aim line is text, never markup');
  // A view with no fixture picked reads exactly as it did before.
  const plain = reticleText({ facing: { yaw: 0 }, position: { x: 10, y: 6 }, selection: { x: 11, y: 6, type: 'terrain' }, blocked: false });
  assert.match(plain, /aimed at ground 11, 6 · walkable/);
  assert.equal(/Enter, Space or I/.test(plain), false);
});
