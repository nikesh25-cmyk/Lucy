import test from 'node:test';
import assert from 'node:assert/strict';
import { ELEVATION_LIMITS, ELEVATION_DIRECTIONS, ELEVATION_BLOCKING_OBJECTS, blockLayers, surfaceAt, headClear,
  canOccupy, canStep, settle, simulateStep, isGrounded } from '../src/elevation.js';

const walkable = () => true;
const world = (blocks = [], extra = {}) => ({ walkable, objects: [], definition: null, layers: blockLayers(blocks), ...extra });
const stack = (x, y, height, type = 'wood') => Array.from({ length: height }, (_, z) => ({ x, y, z, type }));

test('elevation limits freeze the standable range and mirror the voxel height budget', () => {
  assert.equal(Object.isFrozen(ELEVATION_LIMITS), true);
  assert.deepEqual({ ...ELEVATION_LIMITS }, { min: 0, max: 8, stepUp: 1, maxFall: 8, headroom: 2, maxSubsteps: 8 });
  assert.deepEqual(ELEVATION_DIRECTIONS.up, [0, -1]);
  assert.deepEqual(ELEVATION_DIRECTIONS.right, [1, 0]);
  assert.equal(ELEVATION_BLOCKING_OBJECTS.includes('pond'), true);
});

test('surfaceAt reports the top of empty, single-layer and maximum-height columns', () => {
  const layers = blockLayers([{ x: 0, y: 0, z: 0, type: 'stone' }, ...stack(1, 0, 2), ...stack(2, 0, ELEVATION_LIMITS.max)]);
  assert.equal(surfaceAt(0, 0, layers), 1);
  assert.equal(surfaceAt(1, 0, layers), 2);
  assert.equal(surfaceAt(2, 0, layers), ELEVATION_LIMITS.max);
  assert.equal(surfaceAt(9, 9, layers), 0);
  assert.equal(surfaceAt(2, 0, new Map()), 0);
  assert.equal(surfaceAt(1.5, 0, layers), 0);
});

test('path blocks are a thin non-solid surface and never raise the column', () => {
  const layers = blockLayers([{ x: 3, y: 3, z: 0, type: 'path' }, { x: 3, y: 3, z: 1, type: 'path' }, { x: 3, y: 3, z: 0, type: 'wood' }]);
  assert.equal(layers.get('3,3').size, 1);
  assert.equal(layers.get('3,3').has(0), true);
  assert.equal(surfaceAt(3, 3, layers), 1);
  assert.equal(surfaceAt(4, 4, blockLayers([{ x: 4, y: 4, z: 0, type: 'path' }])), 0);
  assert.equal(blockLayers([{ x: 1.5, y: 0, z: 0, type: 'wood' }, { x: 0, y: 0, z: 0.5, type: 'wood' }, { x: 0, y: 0, z: -1, type: 'wood' }]).size, 0);
  assert.equal(blockLayers(null).size, 0);
});

test('step-up admits one layer and rejects two when authored step-up is enabled', () => {
  const one = canStep({ x: 10, y: 6, z: 0 }, 'right', world([...stack(11, 6, 1)]), { allowAuthoredStepUp: true });
  assert.equal(one.blocked, false);
  assert.equal(one.grounded, true);
  assert.deepEqual(one.position, { x: 11, y: 6, z: 1 });
  const two = canStep({ x: 12, y: 6, z: 0 }, 'right', world([...stack(13, 6, 2)]), { allowAuthoredStepUp: true });
  assert.equal(two.blocked, true);
  assert.equal(two.reason, 'too_high');
  assert.deepEqual(two.position, { x: 12, y: 6, z: 0 });
});

test('an authored solid blocks movement at any height under the default policy', () => {
  const foundation = world([...stack(11, 6, 1)]);
  const blocked = canStep({ x: 10, y: 6, z: 0 }, 'right', foundation);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'authored');
  assert.deepEqual(blocked.position, { x: 10, y: 6, z: 0 });
  const floating = canStep({ x: 10, y: 6, z: 0 }, 'right', world([{ x: 11, y: 6, z: 1, type: 'glass' }]));
  assert.equal(floating.blocked, true);
  const unlocked = canStep({ x: 10, y: 6, z: 0 }, 'right', foundation, { allowAuthoredStepUp: true });
  assert.equal(unlocked.blocked, false);
  const ignored = canStep({ x: 10, y: 6, z: 0 }, 'right', { ...foundation, authoredLayers: new Map() }, { allowAuthoredStepUp: true });
  assert.equal(ignored.blocked, false);
});

test('the ceiling gate checks the head space and the standable bounds', () => {
  const layers = blockLayers([{ x: 5, y: 5, z: 0, type: 'wood' }, { x: 5, y: 5, z: 3, type: 'wood' }]);
  assert.equal(headClear(5, 5, 0, layers), true);
  assert.equal(headClear(5, 5, 1, layers), false);
  assert.equal(headClear(5, 5, 2, layers), false);
  assert.equal(headClear(5, 5, 4, layers), true);
  assert.equal(headClear(5, 5, 1, layers, 1), true);
  assert.equal(canOccupy(5, 5, 1, layers), false);
  assert.equal(canOccupy(5, 5, 2, layers), false);
  assert.equal(canOccupy(5, 5, 4, layers), true);
  assert.equal(canOccupy(5, 5, ELEVATION_LIMITS.max + 1, layers), false);
  assert.equal(canOccupy(5, 5, -1, layers), false);
  assert.equal(canOccupy(5, 5, 1.5, layers), false);
});

test('a descent is an airborne transit that settle lands on the lower surface', () => {
  const world = { walkable, definition: null, layers: blockLayers([...stack(10, 6, 2), ...stack(11, 6, 1)]) };
  const down = canStep({ x: 10, y: 6, z: 2 }, 'right', world, { allowAuthoredStepUp: true });
  assert.equal(down.blocked, false);
  assert.equal(down.grounded, false);
  assert.deepEqual(down.position, { x: 11, y: 6, z: 2 });
  assert.equal(isGrounded(down.position, world.layers), false);
  const landed = settle(down.position, world.layers);
  assert.deepEqual(landed, { x: 11, y: 6, z: 1 });
  assert.equal(isGrounded(landed, world.layers), true);
});

test('descending is free inside a sector up to maxFall', () => {
  const world = { walkable, definition: null, layers: blockLayers([...stack(0, 0, ELEVATION_LIMITS.max)]) };
  const drop = canStep({ x: 0, y: 0, z: ELEVATION_LIMITS.max }, 'right', world, { allowAuthoredStepUp: true });
  assert.equal(drop.blocked, false);
  assert.equal(drop.grounded, false);
  assert.equal(settle(drop.position, world.layers).z, 0);
});

test('simulateStep stops at the first blocked substep of a three-tile delta', () => {
  const world = { walkable, definition: null, layers: blockLayers([...stack(12, 6, 1)]) };
  const run = simulateStep({ x: 10, y: 6, z: 0 }, { x: 3, y: 0 }, { world });
  assert.equal(run.reason, 'authored');
  assert.deepEqual(run.blockedAt, { x: 12, y: 6, z: 0 });
  assert.deepEqual(run.position, { x: 11, y: 6, z: 0 });
  assert.equal(run.substeps, 2);
  assert.equal(run.grounded, true);
  const clear = simulateStep({ x: 10, y: 6, z: 0 }, { x: 3, y: 0 }, { world: { walkable, definition: null, layers: new Map() } });
  assert.equal(clear.blockedAt, null);
  assert.deepEqual(clear.position, { x: 13, y: 6, z: 0 });
  assert.equal(clear.substeps, 3);
});

test('simulateStep rejects diagonal, non-integer and oversized advances', () => {
  const world = { walkable, definition: null, layers: new Map() };
  for (const delta of [{ x: 1, y: 1 }, { x: 1.5, y: 0 }, { x: Infinity, y: 0 }, { x: ELEVATION_LIMITS.maxSubsteps + 1, y: 0 }, { x: 0, y: NaN }]) {
    const result = simulateStep({ x: 10, y: 6, z: 0 }, delta, { world });
    assert.equal(result.reason, 'invalid');
    assert.equal(result.substeps, 0);
    assert.deepEqual(result.position, { x: 10, y: 6, z: 0 });
  }
  assert.equal(simulateStep({ x: 10.5, y: 6, z: 0 }, { x: 1, y: 0 }, { world }).reason, 'invalid');
  assert.equal(simulateStep({ x: 10, y: 6, z: 9 }, { x: 1, y: 0 }, { world }).reason, 'invalid');
});

test('settle drops an agent when its supporting block is removed', () => {
  const standing = settle({ x: 2, y: 2, z: 2 }, blockLayers(stack(2, 2, 2)));
  assert.deepEqual(standing, { x: 2, y: 2, z: 2 });
  assert.equal(settle({ x: 2, y: 2, z: 2 }, blockLayers(stack(2, 2, 1))).z, 1);
  assert.equal(settle({ x: 2, y: 2, z: 2 }, blockLayers([])).z, 0);
});

test('placed objects block only for the solid kinds and leave flowers passable', () => {
  const base = { walkable, definition: null, layers: new Map() };
  assert.equal(canStep({ x: 1, y: 1, z: 0 }, 'right', { ...base, objects: [{ x: 2, y: 1, type: 'pond' }] }).reason, 'object');
  assert.equal(canStep({ x: 1, y: 1, z: 0 }, 'right', { ...base, objects: [{ x: 2, y: 1, kind: 'cottage' }] }).reason, 'object');
  assert.equal(canStep({ x: 1, y: 1, z: 0 }, 'right', { ...base, objects: [{ x: 2, y: 1, type: 'flowers' }] }).blocked, false);
  assert.equal(canStep({ x: 1, y: 1, z: 0 }, 'right', { ...base, objects: [{ x: 2, y: 1, type: 'flowers' }], blockingObjects: new Set(['flowers']) }).reason, 'object');
  assert.equal(canStep({ x: 1, y: 1, z: 0 }, 'right', { walkable: () => false, layers: new Map() }).reason, 'unwalkable');
});

test('non-finite, out-of-bounds and non-integer inputs are rejected instead of propagated', () => {
  const world = { walkable, definition: null, layers: new Map() };
  assert.equal(canStep({ x: 10.5, y: 6, z: 0 }, 'right', world).reason, 'invalid');
  assert.equal(canStep({ x: 10, y: NaN, z: 0 }, 'right', world).reason, 'invalid');
  assert.equal(canStep({ x: 10, y: 6, z: 9 }, 'right', world).reason, 'invalid');
  assert.equal(canStep({ x: 10, y: 6, z: 0 }, 'sideways', world).reason, 'invalid');
  assert.equal(canStep({ x: 10, y: 6, z: 0 }, 'right', { layers: new Map() }).reason, 'invalid');
  const held = canStep({ x: 10, y: 6, z: 0 }, 'sideways', world);
  assert.equal(held.blocked, true);
  assert.deepEqual(held.position, { x: 10, y: 6, z: 0 });
});

test('isGrounded compares the feet against the column surface', () => {
  const layers = blockLayers([...stack(7, 7, 2)]);
  assert.equal(isGrounded({ x: 7, y: 7, z: 2 }, layers), true);
  assert.equal(isGrounded({ x: 7, y: 7, z: 1 }, layers), false);
  assert.equal(isGrounded({ x: 0, y: 0, z: 0 }, layers), true);
  assert.equal(isGrounded({ x: 7, y: 7 }, layers), false);
  assert.equal(isGrounded({ x: 7.5, y: 7, z: 2 }, layers), false);
});
