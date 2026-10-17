// The renderer window across a join of the global map: budgets, occupancy at the seam, and motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition, walkable } from '../world.js';
import { KNEE_HEIGHT, RESIDENT_CLEARANCE, RESIDENT_HEIGHT } from '../src/footprints.js';
import { DIORAMA_BUDGET, VOXEL_LIMITS, voxelPlan } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { AVENUES, MAP_ID, MAP_LAYOUT, fromGlobal, seams, worldRects } from '../src/global-map.js';
import { mapActive, mapSnapshot, toMapItem } from '../src/map-view.js';

const map = getWorldDefinition(MAP_ID);
/** The global tile on each side of every avenue, at the join. */
const crossings = [];
for (const seam of seams()) for (const centre of AVENUES[`${seam.a}|${seam.b}`] || []) {
  crossings.push(seam.axis === 'v' ? { label: `${seam.a}|${seam.b}`, x: seam.line, y: centre } : { label: `${seam.a}|${seam.b}`, x: centre, y: seam.line });
}

function drawn(scene) {
  const boxes = [], matrix = new THREE.Matrix4(), colour = new THREE.Color();
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix);
      if (mesh.instanceColor) mesh.getColorAt(index, colour); else colour.set(0xffffff);
      colour.multiply(mesh.material.color);
      const e = matrix.elements;
      boxes.push({ group: group.name, colour: colour.getHexString(), centreX: e[12], height: e[13], centreY: e[14], halfWidth: Math.abs(e[0]) / 2, halfHeight: Math.abs(e[5]) / 2, halfLength: Math.abs(e[10]) / 2, pick: mesh.userData.picks[index] || null });
    }
  }
  return boxes;
}

test('there is an avenue to cross on every seam that has one', () => {
  assert.equal(crossings.length, 34);
});

test('a window straddling any join stays inside the instance, cell and batch budgets', () => {
  let worstInstances = 0, worstBatches = 0;
  for (const crossing of crossings) for (const offset of [-18, -6, 0, 6, 18]) {
    const position = { x: crossing.x, y: crossing.y + offset };
    for (const anchor of [position, { x: position.y, y: position.x }]) {
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
  console.log(`# worst window at an avenue: ${worstInstances} instances, ${worstBatches} of ${DIORAMA_BUDGET.draw_calls} batches`);
});

/** Every global point where four worlds meet at a corner: the window there carries four ground colours. */
const junctions = [];
for (let gx = 1; gx < map.columns; gx++) for (let gy = 1; gy < map.rows; gy++) if (worldRects(gx - 1, gy - 1, 2, 2).length === 4) junctions.push({ x: gx, y: gy });

test('a window around a four-way corner of the map stays inside the instance, cell and batch budgets', () => {
  assert.ok(junctions.length >= 8, `the second ring leaves ${junctions.length} four-way corners`);
  let worstBatches = 0, worstInstances = 0;
  for (const corner of junctions) for (const [dx, dy] of [[0, 0], [-6, -6], [6, 6], [-6, 6], [6, -6], [-12, 0], [12, 0]]) {
    // The nearest open tile to the offset point, so the viewer stands somewhere a resident could.
    let anchor = null;
    for (let r = 0; r < 8 && !anchor; r++) for (let ox = -r; ox <= r && !anchor; ox++) for (let oy = -r; oy <= r && !anchor; oy++) {
      const tile = { x: corner.x + dx + ox, y: corner.y + dy + oy };
      if (walkable(tile, map)) anchor = tile;
    }
    assert.ok(anchor);
    const scene = createVoxelScene(), plan = voxelPlan(map, { camera: { x: 0, y: 0 } }, anchor);
    assert.ok(plan.cells.length <= VOXEL_LIMITS.cells);
    const stats = scene.update(map, {}, { position: anchor, self: null });
    assert.ok(stats.cubes <= DIORAMA_BUDGET.instances, `corner ${corner.x},${corner.y} (${dx},${dy}) draws ${stats.cubes} instances`);
    assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `corner ${corner.x},${corner.y} (${dx},${dy}) draws ${stats.drawBatches} batches`);
    worstBatches = Math.max(worstBatches, stats.drawBatches); worstInstances = Math.max(worstInstances, stats.cubes);
    scene.destroy?.();
  }
  console.log(`# worst four-way corner window: ${worstInstances} instances, ${worstBatches} of ${DIORAMA_BUDGET.draw_calls} batches`);
});

test('no 37 x 37 window on the map overlaps more than five worlds, and only two places reach five', () => {
  let most = 0; const fives = new Set();
  for (let gx = 0; gx + 37 <= map.columns; gx++) for (let gy = 0; gy + 37 <= map.rows; gy++) {
    const found = worldRects(gx, gy, 37, 37).map((item) => item.world_id).sort();
    most = Math.max(most, found.length);
    if (found.length === 5) fives.add(found.join(','));
  }
  assert.equal(most, 5, 'the 40-wide Orchard and Harbor beside four 48-wide districts make five the worst case');
  assert.deepEqual([...fives].sort(), ['commons,district:coast,district:riverlands,district:woodlands,orchard', 'commons,district:commons,district:farmlands,district:harbor,harbor']);
  assert.equal(MAP_LAYOUT.length, 23);
});

test('dense joined groves adapt only decoration, keep every pick and stay bounded when night lights appear', () => {
  const position = { x: 136, y: 121 }, scene = createVoxelScene();
  scene.update(map, {}, { position, lod: false, dayPhase: 'day' });
  const full = drawn(scene);
  const day = scene.update(map, {}, { position, dayPhase: 'day' });
  const adapted = drawn(scene);
  assert.equal(day.detail.adapted, true, 'this dense grove needs a smaller decorative ring');
  assert.ok(day.detail.radius > 0 && day.detail.radius < day.detail.requestedRadius);
  assert.ok(day.cubes <= DIORAMA_BUDGET.instances);
  const picks = (boxes) => boxes.filter((box) => box.pick).map((box) => JSON.stringify(box)).sort();
  assert.deepEqual(picks(adapted), picks(full), 'every surface, tree, building, fixture and entrance keeps its picked geometry');
  const remaining = new Set(adapted.map((box) => JSON.stringify(box)));
  const lost = full.filter((box) => !remaining.has(JSON.stringify(box)));
  assert.ok(lost.length > 0);
  assert.ok(lost.every((box) => box.pick === null), 'the budget removes only unpicked detail');
  const night = scene.update(map, {}, { position, dayPhase: 'night', reducedMotion: true });
  assert.ok(night.skyCubes > day.skyCubes, 'the scene actually gained its night sky geometry');
  assert.ok(night.cubes <= DIORAMA_BUDGET.instances, 'the actual night sky and lamp batches remain inside the same budget');
  assert.equal(scene.animating, false);
  const terrain = scene.root.getObjectByName('voxel-terrain');
  const again = scene.update(map, {}, { position, dayPhase: 'night', reducedMotion: true });
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain, 'unchanged frames reuse the adapted terrain batch');
  assert.equal(again.detail.radius, night.detail.radius, 'the report retains the same tier as the cached meshes');
  scene.destroy();
});

test('a four-region scene with distinct human and AI appearances stays inside the total draw-call budget by day and night', () => {
  const position = { x: 95, y: 71 }, participants = [];
  const colors = ['#397f79', '#3d5875', '#cb725f'], callings = ['cultivator', 'builder', 'steward'];
  for (let x = position.x - 5; x <= position.x + 5 && participants.length < 20; x++) for (let y = position.y - 5; y <= position.y + 5 && participants.length < 20; y++) {
    if (!walkable({ x, y }, map)) continue;
    const index = participants.length;
    participants.push({ id: `mixed-resident-${index}`, name: `Mixed resident ${index}`, world_id: MAP_ID, x, y, z: 0,
      kind: index % 2 ? 'agent' : 'human', status: 'active', color: colors[index % colors.length],
      calling: { id: callings[index % callings.length], name: callings[index % callings.length] }, avatar: index % 2 ? 'star' : 'sprout' });
  }
  assert.equal(participants.length, 20);
  for (const count of [3, 20]) for (const dayPhase of ['day', 'night']) {
    const scene = createVoxelScene(), roster = participants.slice(0, count);
    const options = { position, self: roster[0], dayPhase, weather: 'clear', time: 0 };
    scene.update(map, { participants: roster }, { ...options, lod: false });
    const fullPicks = drawn(scene).filter((box) => box.pick).map((box) => JSON.stringify(box)).sort();
    const stats = scene.update(map, { participants: roster }, options);
    assert.equal(stats.participants, count);
    assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `${count} distinct residents at this junction in ${dayPhase} draw ${stats.drawBatches} batches`);
    assert.deepEqual(drawn(scene).filter((box) => box.pick).map((box) => JSON.stringify(box)).sort(), fullPicks, 'batching retains every picked matrix and its exact displayed source colour');
    const actorInstances = scene.root.getObjectByName('voxel-characters').children.reduce((sum, mesh) => sum + mesh.count, 0);
    assert.ok(stats.cubes - actorInstances <= DIORAMA_BUDGET.instances, 'static geometry retains its existing ceiling independently of the declared actor allowance');
    const terrain = scene.root.getObjectByName('voxel-terrain');
    scene.update(map, { participants: roster.map((resident) => ({ ...resident, last_seen: 1 })) }, options);
    assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain, 'a volatile presence poll reuses the same compact terrain batch');
    scene.destroy();
  }
});

test('nothing solid is drawn on a walkable tile of the avenue at the join', () => {
  for (const crossing of crossings.filter((_, index) => index < 6 || index % 5 === 0)) {
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
