// The renderer window across a join of the global map: budgets, occupancy at the seam, and motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition, walkable } from '../world.js';
import { KNEE_HEIGHT, RESIDENT_CLEARANCE, RESIDENT_HEIGHT } from '../src/footprints.js';
import { DIORAMA_BUDGET, VOXEL_LIMITS, voxelPlan } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { AVENUES, MAP_ID, fromGlobal, seams } from '../src/global-map.js';
import { mapActive, mapSnapshot, toMapItem } from '../src/map-view.js';

const map = getWorldDefinition(MAP_ID);
/** The global tile on each side of every avenue, at the join. */
const crossings = [];
for (const seam of seams()) for (const centre of AVENUES[`${seam.a}|${seam.b}`] || []) {
  crossings.push(seam.axis === 'v' ? { label: `${seam.a}|${seam.b}`, x: seam.line, y: centre } : { label: `${seam.a}|${seam.b}`, x: centre, y: seam.line });
}

function drawn(scene) {
  const boxes = [], matrix = new THREE.Matrix4();
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix);
      const e = matrix.elements;
      boxes.push({ group: group.name, centreX: e[12], height: e[13], centreY: e[14], halfWidth: Math.abs(e[0]) / 2, halfHeight: Math.abs(e[5]) / 2, halfLength: Math.abs(e[10]) / 2 });
    }
  }
  return boxes;
}

test('there is an avenue to cross on every seam that has one', () => {
  assert.equal(crossings.length, 11);
});

test('a window straddling any join stays inside the instance, cell and batch budgets', () => {
  let worstInstances = 0, worstBatches = 0;
  for (const crossing of crossings) for (const offset of [-18, -6, 0, 6, 18]) {
    const position = { x: crossing.x + (crossing.label.includes('|commons') && !crossing.label.startsWith('commons') ? 0 : 0), y: crossing.y + offset };
    for (const anchor of [position, { x: position.y + 0, y: position.x + 0 }]) {
      if (!walkable(anchor, map)) continue;
      const scene = createVoxelScene(), plan = voxelPlan(map, { camera: { x: 0, y: 0 } }, anchor);
      assert.ok(plan.cells.length <= VOXEL_LIMITS.cells);
      const stats = scene.update(map, {}, { position: anchor, self: null });
      assert.ok(stats.cubes <= DIORAMA_BUDGET.instances, `${crossing.label} at ${anchor.x},${anchor.y} draws ${stats.cubes} instances`);
      assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `${crossing.label} at ${anchor.x},${anchor.y} draws ${stats.drawBatches} batches`);
      worstInstances = Math.max(worstInstances, stats.cubes); worstBatches = Math.max(worstBatches, stats.drawBatches);
      scene.destroy?.();
    }
  }
  assert.ok(worstInstances > 0 && worstBatches > 0);
});

test('nothing solid is drawn on a walkable tile of the avenue at the join', () => {
  for (const crossing of crossings.slice(0, 6)) {
    const scene = createVoxelScene(), anchor = { x: crossing.x, y: crossing.y };
    scene.update(map, {}, { position: anchor, self: null });
    const boxes = drawn(scene).filter((box) => !['voxel-characters', 'voxel-sky', 'voxel-lights'].includes(box.group));
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      const tile = { x: crossing.x + dx, y: crossing.y + dy };
      if (!walkable(tile, map)) continue;
      const column = { minX: tile.x + .5 - RESIDENT_CLEARANCE, maxX: tile.x + .5 + RESIDENT_CLEARANCE, minY: tile.y + .5 - RESIDENT_CLEARANCE, maxY: tile.y + .5 + RESIDENT_CLEARANCE };
      const blocking = boxes.filter((box) => box.centreX - box.halfWidth < column.maxX && box.centreX + box.halfWidth > column.minX && box.centreY - box.halfLength < column.maxY && box.centreY + box.halfLength > column.minY
        && box.height + box.halfHeight > KNEE_HEIGHT && box.height - box.halfHeight < RESIDENT_HEIGHT);
      assert.equal(blocking.length, 0, `${crossing.label}: walkable ${tile.x},${tile.y} must be clear of anything above knee height`);
    }
  }
});

test('a walker crossing a join glides in one scene; with reduced motion it lands on the confirmed tile', () => {
  const crossing = crossings[0], walker = { id: 'walker', x: crossing.x, y: crossing.y - 1, z: 0, kind: 'human', status: 'active', color: '#cb725f', world_id: MAP_ID };
  const options = { position: { x: walker.x, y: walker.y }, time: 0, self: walker };
  const gliding = createVoxelScene();
  gliding.update(map, { participants: [walker] }, options);
  walker.y += 1;
  gliding.update(map, { participants: [walker] }, options);
  assert.equal(gliding.animating, true, 'one step over the join is the same one-tile tween as any other step');
  const still = createVoxelScene();
  walker.y -= 1;
  still.update(map, { participants: [walker] }, options);
  walker.y += 1;
  still.update(map, { participants: [walker] }, { ...options, reducedMotion: true });
  assert.equal(still.animating, false);
});

test('the browser view puts the stored world and its neighbour on one set of coordinates', () => {
  const world = { world: { id: 'commons', name: 'The Commons' }, participants: [{ id: 'a', x: 25, y: 1, world_id: 'commons', kind: 'human' }], objects: [{ x: 3, y: 3, type: 'bench' }],
    map: { id: 'core', participants: [{ id: 'b', x: 25, y: 34, world_id: 'district:highlands', kind: 'agent' }], objects: [{ x: 1, y: 1, type: 'flowers', world_id: 'district:highlands' }] } };
  assert.equal(mapActive(world), true);
  assert.equal(mapActive({ world: { id: 'hall' }, map: {} }), false, 'an interior never uses the map view');
  assert.equal(mapActive({ world: { id: 'commons' } }), false, 'a server without the map sends no window, and the client keeps its per-world view');
  const view = mapSnapshot(world, world.participants[0], map);
  const [a, b] = view.snapshot.participants;
  assert.deepEqual([a.x, a.y, a.world_id, a.local_x], [121, 73, MAP_ID, 25]);
  assert.deepEqual([b.x, b.y, b.home_world_id], [121, 70, 'district:highlands']);
  assert.equal(a.x, b.x); assert.equal(a.y - b.y, 3, 'the two residents are three tiles apart on the map, whichever world stores them');
  assert.deepEqual(view.position, { x: 121, y: 73, z: 0 });
  assert.equal(view.snapshot.objects.length, 2);
  assert.deepEqual(fromGlobal(view.snapshot.objects[0].x, view.snapshot.objects[0].y), { world_id: 'commons', x: 3, y: 3 });
  assert.equal(toMapItem({ id: 'x', x: 1, y: 1, world_id: 'hall' }).x, 1, 'an item that is not on the map is returned as it was');
  assert.equal(view.snapshot.terrain, undefined, 'the stored world\'s local terrain overlay is not mixed into global coordinates');
});
