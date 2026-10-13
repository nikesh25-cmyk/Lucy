import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { createVoxelScene, createVoxelWorld, peopleVisualKey, DISTANT_GROUND_LIMITS } from '../src/voxel-world.js';
import { VOXEL_LIMITS, voxelWindow, voxelPlan, voxelPick, orbitCamera, firstPersonCamera, normalizeOrbit, voxelParcelAddress, voxelParcels, cellOccludedBelow, createOrbitInput } from '../src/voxel-geometry.js';

const definition = (columns = 48, rows = 48) => ({ id: 'test-sector', columns, rows, kind: 'outdoors', start: { x: 24, y: 24 },
  terrain: Array.from({ length: rows }, () => Array(columns).fill('meadow')), objects: [], portals: [], landmarks: [] });
const castDown = (scene, x, y) => new THREE.Raycaster(new THREE.Vector3(x + .5, 12, y + .5), new THREE.Vector3(0, -1, 0))
  .intersectObjects(scene.pickables, false).map(voxelPick).find(Boolean);
const groupInstances = (scene, name) => scene.root.getObjectByName(name).children.reduce((total, mesh) => total + mesh.count, 0);
const sameMeshes = (group, meshes) => group.children.length === meshes.length && meshes.every((mesh, index) => group.children[index] === mesh);
/** Instances that carry a terrain pick for one cell: the base cube and the surface slab. */
const instancesAt = (scene, x, y) => scene.root.getObjectByName('voxel-terrain').children.reduce((total, mesh) =>
  total + mesh.userData.picks.filter(pick => pick?.type === 'terrain' && pick.x === x && pick.y === y).length, 0);
/** Highest rendered point of a batch group, measured from real instance matrices. */
const topOf = group => group.children.reduce((top, mesh) => {
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < mesh.count; index++) { mesh.getMatrixAt(index, matrix); top = Math.max(top, matrix.elements[13] + Math.abs(matrix.elements[5]) / 2); }
  return top;
}, -Infinity);
/** Bases recomputed from retained terrain, including neighbors just beyond the render window. */
const hiddenCellCount = (world, plan) => plan.cells.filter(({ x, y, type }) => !['water', 'bridge'].includes(type) &&
  [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) =>
    typeof world.terrain[y + dy]?.[x + dx] === 'string' && world.terrain[y + dy][x + dx] !== 'water')).length;

test('voxel viewport remains bounded at world edges and rejects invalid or duplicate records', () => {
  const world = definition(4000, 50), center = { x: 2000, y: 24 }, window = voxelWindow(world, center);
  assert.equal((window.right - window.x) * (window.bottom - window.y), VOXEL_LIMITS.cells);
  assert.deepEqual(voxelWindow(world, { x: -100, y: Infinity }), { x: 0, y: 6, right: 19, bottom: 43, columns: 4000, rows: 50 });
  const plan = voxelPlan(world, { camera: { x: 1999, y: 24 }, terrain: [['path']], blocks: [
    { x: 2000, y: 24, z: 0, type: 'wood' }, { x: 2000, y: 24, z: 0, type: 'brick' }, { x: 2001, y: 24, z: 8, type: 'stone' },
    { x: 2000.1, y: 24, z: 1, type: 'glass' }, { x: 1, y: 1, z: 0, type: 'wood' }],
    participants: [{ id: 'valid', x: 2000, y: 24 }, { id: 'valid', x: 2000, y: 24 }, { id: 'revoked', x: 2000, y: 24, status: 'revoked' }] }, center);
  assert.equal(plan.cells.length, VOXEL_LIMITS.cells); assert.equal(plan.cells.find(item => item.x === 1999 && item.y === 24).type, 'path');
  assert.equal(plan.blocks.length, 1); assert.equal(plan.blocks[0].type, 'wood'); assert.equal(plan.participants.length, 1);
  const dense = voxelPlan(world, { blocks: Array.from({ length: 3000 }, (_, i) => ({ x: 1982 + i % 37, y: 6 + Math.floor(i / 37) % 37, z: Math.floor(i / 1369), type: 'stone' })) }, center);
  assert.equal(dense.blocks.length, VOXEL_LIMITS.blocks);
});

test('actual Three.js raycasts select authored layers and convert cube faces to movement coordinates', () => {
  const scene = createVoxelScene(), world = definition(8, 8), block = { id: 'block-one', x: 3, y: 3, z: 2, type: 'wood' };
  scene.update(world, { blocks: [block, { id: 'path', x: 4, y: 3, z: 0, type: 'path' }] }, { position: { x: 3, y: 3 } });
  const hit = castDown(scene, 3, 3); assert.equal(hit.type, 'block'); assert.equal(hit.block.id, block.id);
  assert.deepEqual(hit.face, { x: 0, y: 0, z: 1 }); assert.deepEqual(hit.adjacent, { x: 3, y: 3, z: 3 });
  const side = new THREE.Raycaster(new THREE.Vector3(3.5, 2.5, 5), new THREE.Vector3(0, 0, -1))
    .intersectObjects(scene.pickables, false).map(voxelPick).find(Boolean);
  assert.equal(side.block.id, block.id); assert.deepEqual(side.face, { x: 0, y: 1, z: 0 }); assert.deepEqual(side.adjacent, { x: 3, y: 4, z: 2 });
  const pathHit = castDown(scene, 4, 3); assert.equal(pathHit.block.type, 'path'); assert.equal(pathHit.z, 0);
  const ground = castDown(scene, 1, 1); assert.equal(ground.type, 'terrain'); assert.equal(ground.terrain, 'meadow');
  assert.equal(castDown(scene, 12, 12), undefined); scene.destroy(); assert.equal(scene.pickables.length, 0); assert.equal(scene.root.children.length, 0);
});

test('distant ground is one finite render-only mesh that follows world switches and cleans up', () => {
  const scene = createVoxelScene(), first = definition(8, 6);
  first.groundColor = '#829b77';
  scene.update(first, {}, { position: first.start });
  const mesh = scene.root.getObjectByName('voxel-distant-ground');
  assert.ok(mesh); assert.equal(mesh.geometry.parameters.width, 8); assert.equal(mesh.geometry.parameters.depth, 6);
  assert.deepEqual(mesh.position.toArray(), [4, DISTANT_GROUND_LIMITS.y - .02, 3]);
  assert.equal(mesh.geometry.attributes.position.count, DISTANT_GROUND_LIMITS.vertices);
  assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, true); assert.equal(mesh.userData.renderOnly, true);
  assert.equal(scene.pickables.includes(mesh), false);
  assert.equal(scene.stats.distantGround, 1, 'the extra draw is included in the scene report');
  let geometryDisposed = 0, materialDisposed = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposed++); mesh.material.addEventListener('dispose', () => materialDisposed++);

  const second = definition(11, 9); second.id = 'second-sector'; second.groundColor = '#b29a72';
  scene.update(second, {}, { position: second.start });
  const switched = scene.root.getObjectByName('voxel-distant-ground');
  assert.notEqual(switched, mesh); assert.deepEqual(switched.position.toArray(), [5.5, DISTANT_GROUND_LIMITS.y - .02, 4.5]);
  assert.equal(geometryDisposed, 1); assert.equal(materialDisposed, 1);
  const room = { ...definition(6, 5), id: 'test-room', kind: 'interior' };
  scene.update(room, {}, { position: room.start });
  assert.equal(scene.root.getObjectByName('voxel-distant-ground'), undefined, 'interior rooms have no distant outdoor surface');
  assert.equal(scene.stats.distantGround, 0);
  scene.destroy(); assert.equal(scene.root.getObjectByName('voxel-distant-ground'), undefined);
});

test('scene renders the nearby shared world with real characters and reuses static terrain during movement', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons'), participants = [{ id: 'human', name: 'Human', x: 10, y: 6, color: '#cb725f', status: 'active' }];
  const stats = scene.update(world, { participants }, { position: world.start, self: participants[0] });
  assert.ok(stats.cells > 300 && stats.cells <= VOXEL_LIMITS.cells); assert.equal(stats.participants, 1);
  // Exactly computed from the same plan: every cell keeps its surface slab and every non-enclosed
  // cell keeps its base cube, so the scene can never fall below `cells * 2 - hidden` terrain cubes.
  const plan = voxelPlan(world, { participants }, world.start), hidden = hiddenCellCount(world, plan);
  assert.ok(hidden > 300 && hidden < stats.cells, 'the whole-node cull applies to interior cells only');
  assert.ok(stats.cubes > stats.cells * 2 - hidden, `${stats.cubes} rendered cubes must cover ${stats.cells} slabs and ${stats.cells - hidden} bases`);
  assert.ok(stats.drawBatches < 130);
  const staticGroup = scene.root.children[0], oldPeople = scene.root.children[1]; let disposed = 0;
  assert.ok(oldPeople.children.some(mesh => mesh.material.color.getHexString() === 'cb725f'), 'Saved character color must appear in its actual 3D materials');
  for (const mesh of oldPeople.children) mesh.addEventListener('dispose', () => disposed++);
  participants[0].x = 12; scene.update(world, { participants }, { position: world.start, self: participants[0] });
  assert.equal(scene.root.children[0], staticGroup); assert.notEqual(scene.root.children[1], oldPeople); assert.ok(disposed > 0);
  const playerHit = castDown(scene, 12, 6); assert.equal(playerHit.type, 'participant'); assert.equal(playerHit.participant.id, 'human');
  scene.destroy(); scene.destroy(); assert.equal(scene.pickables.length, 0);
  assert.throws(() => scene.update(world), /destroyed/);
});

test('interior base cubes are culled whole, the surface pick survives, and a water seam keeps its base', () => {
  const scene = createVoxelScene(), grid = definition(48, 48), world = { ...grid, id: 'frontier:0:0', kind: 'frontier' };
  world.terrain = grid.terrain.map((row, y) => row.map((type, x) => x === 30 ? 'water' : type));
  const parcel = voxelParcelAddress(world.id, { x: 24, y: 24 }), snapshot = { frontier: { parcels: [{ ...parcel, state: 'assigned', purpose: 'learning', steward_name: 'Ada' }] } }, position = { x: 24, y: 24 };
  const plan = voxelPlan(world, snapshot, position), hidden = hiddenCellCount(world, plan);
  assert.equal(hidden, 1258, 'retained terrain beyond the viewport also occludes internal window edges');
  const full = scene.update(world, snapshot, { position, cullHidden: false }), fullInstances = groupInstances(scene, 'voxel-terrain');
  assert.equal(instancesAt(scene, 24, 24), 2, 'the base cube and the slab both carry the interior cell pick');
  const culled = scene.update(world, snapshot, { position });
  assert.equal(fullInstances - groupInstances(scene, 'voxel-terrain'), hidden, 'exactly the interior base cubes are dropped');
  assert.equal(full.cubes - culled.cubes, hidden);
  assert.equal(instancesAt(scene, 24, 24), 1, 'only the slab remains, so the cell is still pickable');
  const interior = castDown(scene, 24, 24);
  assert.equal(interior.type, 'terrain'); assert.equal(interior.terrain, 'meadow'); assert.equal(interior.parcel.id, parcel.id); assert.equal(interior.parcel.steward_name, 'Ada');
  assert.equal(instancesAt(scene, 29, 24), 2, 'a land cell beside water keeps its exposed base');
  assert.equal(instancesAt(scene, 30, 24), 3, 'water keeps base, slab and surface');
  const seam = castDown(scene, 29, 24); assert.equal(seam.type, 'terrain'); assert.equal(seam.terrain, 'meadow');
  assert.equal(cellOccludedBelow(world, snapshot, plan, 24, 24), true);
  assert.equal(cellOccludedBelow(world, snapshot, plan, 29, 24), false, 'water never occludes');
  assert.equal(cellOccludedBelow(world, snapshot, plan, 30, 24), false, 'a water base is never culled');
  assert.equal(cellOccludedBelow(world, snapshot, plan, plan.window.x, 24), true, 'an internal window edge is occluded by the retained world neighbor');
  const edgePlan = voxelPlan(world, snapshot, { x: 0, y: 0 });
  assert.equal(cellOccludedBelow(world, snapshot, edgePlan, 0, 0), false, 'the actual world edge keeps its exposed base');
  assert.equal(cellOccludedBelow(world, snapshot, plan, 24, 24.5), false, 'only integer cells are addressed');
  assert.equal(cellOccludedBelow(world, snapshot, null, 24, 24), false);
  scene.destroy();
});

test('avatars render at their elevation layer and the orbit camera already follows that layer', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons'), walker = { id: 'walker', x: 10, y: 6, color: '#cb725f', status: 'active' };
  scene.update(world, { participants: [walker] }, { position: world.start, self: walker });
  const groundHit = castDown(scene, 10, 6), groundTop = topOf(scene.root.getObjectByName('voxel-characters'));
  assert.equal(groundHit.type, 'participant'); assert.equal(groundHit.z, 0); assert.equal(groundHit.participant.z, undefined, 'a participant without z is untouched');
  walker.z = 3; walker.grounded = true;
  scene.update(world, { participants: [walker] }, { position: world.start, self: walker });
  const liftedTop = topOf(scene.root.getObjectByName('voxel-characters'));
  // Instance matrices are float32, so compare the layer offset within that precision.
  assert.ok(Math.abs((liftedTop - groundTop) - 3) < 1e-5, `every body cube moves up one layer (${groundTop} -> ${liftedTop})`);
  const lifted = castDown(scene, 10, 6);
  assert.equal(lifted.type, 'participant'); assert.equal(lifted.z, 3); assert.equal(lifted.participant.grounded, true);
  assert.equal(orbitCamera({ x: 10, y: 6, z: 3 }).target.y, 3.75, 'orbitCamera already reads and clamps position.z');
  assert.equal(orbitCamera({ x: 10, y: 6, z: 99 }).target.y, VOXEL_LIMITS.height + .75);
  walker.posture = 'sitting'; walker.z = 0;
  scene.update(world, { participants: [walker] }, { position: world.start, self: walker });
  assert.ok(Math.abs(topOf(scene.root.getObjectByName('voxel-characters')) - (groundTop - .26)) < 1e-5, 'posture keeps lowering the body');
  scene.destroy();
});

test('participant polls that change no visible field reuse the same character batches', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons');
  const self = { id: 'human', name: 'Human', x: 10, y: 6, z: 0, color: '#cb725f', posture: 'standing', kind: 'human', status: 'active', last_seen: '2026-10-11T00:00:00Z' };
  const mayor = { id: 'npc-mayor', name: 'Mayor', x: 11, y: 8, z: 2, color: 'teal', posture: 'sitting', kind: 'npc', status: 'active', last_seen: '2026-10-11T00:00:01Z' };
  const options = { position: world.start, self };
  const first = scene.update(world, { participants: [self, mayor] }, options);
  const people = scene.root.getObjectByName('voxel-characters'), peopleMeshes = [...people.children]; let disposed = 0;
  for (const mesh of peopleMeshes) mesh.addEventListener('dispose', () => disposed++);
  mayor.last_seen = '2026-10-11T00:02:30Z'; mayor.accepted_contributions = 12; mayor.emote = 'wave'; mayor.emote_until = '2026-10-11T00:03:00Z';
  const second = scene.update(world, { participants: [mayor, self] }, options);
  assert.equal(scene.root.getObjectByName('voxel-characters'), people); assert.ok(sameMeshes(people, peopleMeshes));
  assert.equal(disposed, 0, 'a volatile-field poll must not dispose any character batch'); assert.equal(second.cubes, first.cubes);
  assert.equal(peopleVisualKey([self, mayor], self), peopleVisualKey([mayor, self], self), 'the projected key ignores roster order');
  assert.equal(peopleVisualKey([{ ...self, name: 'Renamed', last_seen: 'much later', status: 'away' }, mayor], self), peopleVisualKey([self, mayor], self), 'curated profile fields stay out of the projected key');
  const freshSelf = { ...self, name: 'Renamed', title: 'Gardener', presence: 'connected' }, freshMayor = { ...mayor, name: 'Fresh Mayor' };
  scene.update(world, { participants: [freshMayor, freshSelf] }, { ...options, self: freshSelf });
  assert.equal(scene.root.getObjectByName('voxel-characters'), people); assert.ok(sameMeshes(people, peopleMeshes)); assert.equal(disposed, 0);
  const freshPick = castDown(scene, 10, 6); assert.equal(freshPick.participant, freshSelf); assert.equal(freshPick.participant.name, 'Renamed'); assert.equal(freshPick.participant.title, 'Gardener');
  assert.equal(castDown(scene, 11, 8).participant, freshMayor, 'reused instances must point at the latest roster records');
  const forced = scene.update(world, { participants: [mayor, self] }, { ...options, rebuildPeople: true });
  assert.notEqual(scene.root.getObjectByName('voxel-characters'), people); assert.ok(disposed > 0, 'rebuildPeople restores the always-rebuild path');
  assert.equal(forced.cubes, first.cubes);
  const lifted = scene.root.getObjectByName('voxel-characters'); mayor.z = 3;
  scene.update(world, { participants: [mayor, self] }, options);
  assert.notEqual(scene.root.getObjectByName('voxel-characters'), lifted, 'changing the elevation layer is a visible change');
  const beforeMove = scene.root.getObjectByName('voxel-characters'); self.x = 12;
  scene.update(world, { participants: [mayor, self] }, options);
  assert.notEqual(scene.root.getObjectByName('voxel-characters'), beforeMove, 'moving a participant still replaces the batch');
  const moved = castDown(scene, 12, 6); assert.equal(moved.type, 'participant'); assert.equal(moved.participant.id, 'human');
  scene.destroy();
});

test('changing the selected character moves its gold ring while leaving terrain and block batches intact', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons');
  const a = { id: 'a', x: 12, y: 6, z: 0, kind: 'human', status: 'active', color: '#cb725f' }, b = { ...a, id: 'b', x: 13 };
  const snapshot = { participants: [a, b], blocks: [{ id: 'wall', x: 8, y: 8, z: 0, type: 'wood' }] };
  scene.update(world, snapshot, { position: world.start, self: a });
  const terrain = scene.root.getObjectByName('voxel-terrain'), blocks = scene.root.getObjectByName('voxel-blocks'), people = scene.root.getObjectByName('voxel-characters');
  const goldX = () => { const mesh = scene.root.getObjectByName('voxel-characters').children.find(item => item.material.color.getHexString() === 'e2ca83'), matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix); return matrix.elements[12]; };
  assert.equal(goldX(), 12.5); assert.notEqual(peopleVisualKey([a, b], a), peopleVisualKey([a, b], b));
  scene.update(world, snapshot, { position: world.start, self: b });
  assert.equal(goldX(), 13.5); assert.notEqual(scene.root.getObjectByName('voxel-characters'), people);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-blocks'), blocks); scene.destroy();
});

test('explicit public callings add original emblems and objective updates refresh picks without rebuilding avatars', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons'), resident = { id: 'maker', x: 12, y: 6, z: 0, kind: 'human', status: 'active', color: '#397f79' };
  const initial = scene.update(world, { participants: [resident] }, { position: world.start, self: resident });
  const withCalling = { ...resident, calling: { id: 'builder', name: 'Builder', rank: { level: 1, title: 'Apprentice' }, current_objective: { id: 'place', title: 'Build a useful place', complete: false } } };
  const emblem = scene.update(world, { participants: [withCalling] }, { position: world.start, self: withCalling });
  assert.ok(emblem.cubes > initial.cubes); const people = scene.root.getObjectByName('voxel-characters');
  assert.ok(people.children.some(mesh => mesh.material.color.getHexString() === 'd39170'));
  const advanced = { ...withCalling, calling: { ...withCalling.calling, rank: { level: 2, title: 'Maker' }, current_objective: { ...withCalling.calling.current_objective, complete: true } } };
  scene.update(world, { participants: [advanced] }, { position: world.start, self: advanced });
  assert.equal(scene.root.getObjectByName('voxel-characters'), people); assert.equal(castDown(scene, 12, 6).participant.calling.rank.level, 2);
  assert.equal(castDown(scene, 12, 6).participant.calling.current_objective.complete, true);
  const unsupported = { ...resident, calling: { id: '__proto__', name: 'Administrator' } };
  assert.equal(scene.update(world, { participants: [unsupported] }, { position: world.start, self: unsupported }).cubes, initial.cubes);
  scene.destroy();
});

test('one orbit input owner emits applied drag look state and programmatic camera updates stay silent', () => {
  const calls = [], input = createOrbitInput({ initial: { yaw: 0, pitch: .6, distance: 17 }, onLook: value => calls.push(value) });
  input.set({ yaw: 1 }); input.rotate(.2, .1); input.zoom(-2); assert.equal(calls.length, 0);
  const before = input.orbit, after = input.drag(10, 5); assert.equal(calls.length, 1); assert.deepEqual(calls[0], after); assert.deepEqual(input.orbit, after);
  assert.ok(Math.abs(after.yaw - (before.yaw - .08)) < 1e-12); assert.ok(Math.abs(after.pitch - (before.pitch + .03)) < 1e-12);
  calls[0].yaw = 999; assert.deepEqual(input.orbit, after, 'callbacks cannot mutate camera state');
  input.drag(0, 0); assert.equal(calls.length, 1);
  input.drag(Infinity, NaN); assert.equal(calls.length, 1); input.drag(0, 10000); assert.equal(input.orbit.pitch, 1.22);
});

test('first-person input keeps a level or upward view and mode switches preserve yaw without extra look events', () => {
  const calls = [], input = createOrbitInput({ mode: 'first-person', initial: { yaw: .7, pitch: 0 }, onLook: value => calls.push(value) });
  assert.equal(input.mode, 'first-person'); assert.equal(input.orbit.pitch, 0);
  input.set({ pitch: -.8 }); assert.equal(input.orbit.pitch, -.8); assert.equal(calls.length, 0);
  input.drag(0, -10000); assert.equal(input.orbit.pitch, -1.4); assert.equal(calls.length, 1);
  input.setMode('orbit'); assert.equal(input.orbit.pitch, .3); assert.equal(input.orbit.yaw, .7); assert.equal(calls.length, 1);
  input.setMode('first-person'); input.set({ pitch: 0 }); assert.equal(input.orbit.pitch, 0); assert.equal(calls.length, 1);
  const level = firstPersonCamera({ x: 16, y: 16, z: 2 }, { yaw: 0, pitch: 0 });
  assert.deepEqual(level.eye, { x: 16.5, y: 3.35, z: 16.5 }); assert.deepEqual(level.target, { x: 16.5, y: 3.35, z: 15.5 });
  assert.ok(firstPersonCamera({ x: 16, y: 16 }, { pitch: -.6 }).target.y > 1.35);
  assert.ok(firstPersonCamera({ x: 16, y: 16 }, { pitch: .6 }).target.y < 1.35);
});

test('true first-person projection picks the forward block and hides only the viewer while reusing world geometry', () => {
  const scene = createVoxelScene(), world = definition();
  const self = { id: 'viewer', x: 16, y: 16, z: 2, kind: 'human', status: 'active', color: '#cb725f' }, peer = { ...self, id: 'peer', x: 18 };
  const snapshot = { participants: [self, peer], blocks: [{ id: 'forward-wall', x: 16, y: 14, z: 3, type: 'wood' }] };
  const options = { position: self, self, cameraMode: 'orbit' };
  assert.equal(scene.update(world, snapshot, options).participants, 2);
  const terrain = scene.root.getObjectByName('voxel-terrain'), blocks = scene.root.getObjectByName('voxel-blocks');
  const fpStats = scene.update(world, snapshot, { ...options, cameraMode: 'first-person' }); assert.equal(fpStats.participants, 1);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-blocks'), blocks);
  assert.ok(scene.pickables.every(mesh => mesh.userData.picks.every(pick => pick?.participant?.id !== self.id)));
  assert.equal(castDown(scene, 18, 16).participant.id, peer.id); assert.equal(castDown(scene, 16, 16).type, 'terrain');
  const placement = firstPersonCamera(self, { yaw: 0, pitch: 0 }), camera = new THREE.PerspectiveCamera(48, 16 / 9, .1, 100);
  camera.position.set(placement.eye.x, placement.eye.y, placement.eye.z); camera.lookAt(placement.target.x, placement.target.y, placement.target.z); camera.updateMatrixWorld();
  const projected = new THREE.Vector3(placement.target.x, placement.target.y, placement.target.z).project(camera);
  assert.ok(Math.abs(projected.x) < 1e-10); assert.ok(Math.abs(projected.y) < 1e-10);
  const hit = new THREE.Raycaster(); hit.setFromCamera(new THREE.Vector2(0, 0), camera);
  const picked = hit.intersectObjects(scene.pickables, false).map(voxelPick).find(Boolean); assert.equal(picked.type, 'block'); assert.equal(picked.block.id, 'forward-wall');
  assert.deepEqual(picked.face, { x: 0, y: 1, z: 0 });
  const fpPeople = scene.root.getObjectByName('voxel-characters'); scene.update(world, snapshot, { ...options, cameraMode: 'first-person' });
  assert.equal(scene.root.getObjectByName('voxel-characters'), fpPeople);
  scene.update(world, snapshot, options); assert.equal(castDown(scene, 16, 16).participant.id, self.id);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-blocks'), blocks); scene.destroy();
});

test('live nameplates follow the confirmed tracker and omit self in first-person', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons');
  const self = { id: 'viewer', name: 'Viewer', x: 16, y: 16, z: 0, kind: 'human', status: 'active' };
  const peer = { id: 'peer', name: 'Peer', x: 18, y: 16, z: 0, kind: 'human', status: 'active' };
  const far = { id: 'far', name: 'Far', x: 60, y: 60, z: 0, kind: 'human', status: 'active' };
  scene.update(world, { participants: [self, peer, far] }, { position: self, self, time: 1000 });
  assert.deepEqual(scene.nameplates([self, peer, far], self, { time: 1000 }).map(label => label.id), ['viewer', 'peer']);
  assert.deepEqual(scene.nameplates([self, peer, far], self, { cameraMode: 'first-person', time: 1000 }).map(label => label.id), ['peer']);
  scene.destroy();
});

test('an unchanged payload reuses every batch while a one-block edit rebuilds only the saved blocks', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons');
  const participants = [{ id: 'human', name: 'Human', x: 10, y: 6, color: '#cb725f', status: 'active' }];
  const options = { position: world.start, self: participants[0] }, block = { id: 'bench-one', x: 8, y: 8, z: 0, type: 'wood' };
  const first = scene.update(world, { participants, blocks: [block] }, options);
  const terrain = scene.root.getObjectByName('voxel-terrain'), terrainMeshes = [...terrain.children];
  const people = scene.root.getObjectByName('voxel-characters'), peopleMeshes = [...people.children];
  const blocks = scene.root.getObjectByName('voxel-blocks'), blockMeshes = [...blocks.children];
  assert.equal(first.blocks, 1); assert.ok(blockMeshes.length > 0);
  const second = scene.update(world, { participants, blocks: [{ ...block }] }, options);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.ok(sameMeshes(terrain, terrainMeshes));
  assert.equal(scene.root.getObjectByName('voxel-characters'), people); assert.ok(sameMeshes(people, peopleMeshes));
  assert.equal(scene.root.getObjectByName('voxel-blocks'), blocks); assert.ok(sameMeshes(blocks, blockMeshes));
  assert.equal(second.cubes, first.cubes);
  block.z = 2;
  const edited = scene.update(world, { participants, blocks: [block] }, options);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.ok(sameMeshes(terrain, terrainMeshes), 'placing one block must not rebuild the diorama');
  assert.equal(scene.root.getObjectByName('voxel-characters'), people); assert.ok(sameMeshes(people, peopleMeshes));
  assert.notEqual(scene.root.getObjectByName('voxel-blocks'), blocks); assert.equal(edited.cubes, first.cubes);
  const placed = castDown(scene, 8, 8); assert.equal(placed.type, 'block'); assert.equal(placed.block.id, block.id); assert.equal(placed.z, 2);
  scene.destroy();
});

test('frontier gateways expose an unopened neighbor without presenting it as an enterable portal', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('frontier:0:0');
  const neighbor = { direction: 'up', x: 24, y: 1, exists: false, target_world_id: 'frontier:0:-1' };
  scene.update(world, { portals: [], frontier: { neighbors: [neighbor] } }, { position: { x: 24, y: 2 } });
  const closed = castDown(scene, 24, 1); assert.equal(closed.type, 'gate'); assert.equal(closed.neighbor.exists, false);
  const portal = { x: 24, y: 1, target_world_id: 'frontier:0:-1' };
  scene.update(world, { portals: [portal], frontier: { neighbors: [{ ...neighbor, exists: true }] } }, { position: { x: 24, y: 2 } });
  const open = castDown(scene, 24, 1); assert.equal(open.type, 'portal'); assert.equal(open.portal.target_world_id, 'frontier:0:-1');
  scene.destroy();
});

test('physical plot addresses match finite-world coordinates and reject cross-world or malformed parcel records', () => {
  assert.equal(voxelParcelAddress('frontier:-8:7', { x: 47, y: 0 }).id, 'plot:-8:7:7:0');
  assert.equal(voxelParcelAddress('frontier:7:-8', { x: 0, y: 47 }).id, 'plot:7:-8:0:7');
  for (const [world, position] of [['commons', { x: 2, y: 2 }], ['frontier:8:0', { x: 2, y: 2 }], ['frontier:0:0', { x: 48, y: 0 }], ['frontier:0:0', { x: 6.2, y: 0 }]]) assert.equal(voxelParcelAddress(world, position), null);
  const world = getWorldDefinition('frontier:0:0'), address = voxelParcelAddress(world.id, { x: 31, y: 31 });
  const list = voxelParcels(world, { frontier: { parcels: [{ ...address, state: 'assigned', purpose: 'learning', width: 999 },
    { ...address, plot_x: 5.5 }, { ...address, world_id: 'frontier:1:0', id: 'plot:1:0:5:5' }, { ...address, id: 'invalid' }] } }, voxelWindow(world, { x: 31, y: 31 }));
  assert.equal(list.length, 1); assert.equal(list[0].width, 6); assert.equal(list[0].area_m2, 36); assert.equal(list[0].purpose, 'learning');
  assert.deepEqual(voxelParcels(world, { frontier: { parcels: [] } }), []);
});

test('real parcel raycasts retain stewardship data while selection overlays reuse terrain, blocks, and avatars', () => {
  const scene = createVoxelScene(), world = { ...definition(), id: 'frontier:0:0', kind: 'frontier' };
  const selected = { ...voxelParcelAddress(world.id, { x: 31, y: 31 }), state: 'assigned', purpose: 'learning', steward_name: 'Ada', is_mine: true };
  const reserved = { ...voxelParcelAddress(world.id, { x: 25, y: 31 }), state: 'reserved', reserved_reason: 'Public passage' };
  const blocks = [{ id: 'learning-wall', x: 32, y: 32, z: 0, type: 'wood' }], participants = [{ id: 'human', x: 33, y: 33, status: 'active', color: 'teal' }];
  const snapshot = { blocks, participants, frontier: { parcels: [selected, reserved] } }, options = { position: { x: 31, y: 31 }, parcelSelection: selected };
  const stats = scene.update(world, snapshot, options);
  assert.equal(stats.blocks, 1); assert.equal(stats.participants, 1); assert.equal(stats.parcels, 2); assert.equal(stats.selectedParcel, selected.id);
  const ground = castDown(scene, 31, 31); assert.equal(ground.type, 'terrain'); assert.equal(ground.parcel.id, selected.id); assert.equal(ground.parcel.steward_name, 'Ada');
  const authored = castDown(scene, 32, 32); assert.equal(authored.type, 'block'); assert.equal(authored.block.id, 'learning-wall'); assert.equal(authored.parcel.id, selected.id);
  const road = castDown(scene, 25, 31); assert.equal(road.parcel.state, 'reserved'); assert.equal(road.parcel.reserved_reason, 'Public passage');
  const terrain = scene.root.getObjectByName('voxel-terrain'), people = scene.root.getObjectByName('voxel-characters');
  const terrainMeshes = [...terrain.children], peopleMeshes = [...people.children], blockMeshes = [...scene.root.getObjectByName('voxel-blocks').children];
  const selectedOverlay = scene.root.getObjectByName('parcel-overlay'); assert.equal(selectedOverlay.userData.selectedParcel, selected.id);
  const edgeMesh = selectedOverlay.children.find(mesh => mesh.material.depthTest === false && mesh.material.opacity > .8);
  assert.ok(edgeMesh); edgeMesh.computeBoundingBox(); assert.ok(Math.abs(edgeMesh.boundingBox.min.x - (30 - .11 / 2)) < 1e-6); assert.ok(Math.abs(edgeMesh.boundingBox.max.x - (36 + .11 / 2)) < 1e-6);
  assert.ok(!scene.pickables.some(mesh => selectedOverlay.children.includes(mesh)));
  scene.highlightParcel(reserved, selected);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-characters'), people);
  assert.ok(sameMeshes(terrain, terrainMeshes) && sameMeshes(people, peopleMeshes) && sameMeshes(scene.root.getObjectByName('voxel-blocks'), blockMeshes), 'a hover highlight must reuse every existing batch');
  assert.equal(scene.root.children.filter(group => group.name === 'parcel-overlay').length, 1);
  assert.equal(scene.root.getObjectByName('parcel-overlay').userData.selectedParcel, reserved.id);
  scene.update(world, snapshot, { ...options, parcelSelection: reserved });
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-characters'), people);
  assert.ok(sameMeshes(terrain, terrainMeshes) && sameMeshes(people, peopleMeshes) && sameMeshes(scene.root.getObjectByName('voxel-blocks'), blockMeshes), 'an identical payload must reuse every existing batch');
  assert.equal(scene.root.children.filter(group => group.name === 'voxel-terrain').length, 1); assert.equal(scene.root.children.filter(group => group.name === 'voxel-characters').length, 1);
  scene.update(getWorldDefinition('commons'), {}, { position: { x: 10, y: 6 } });
  assert.equal(scene.root.getObjectByName('parcel-overlay'), undefined); assert.equal(castDown(scene, 10, 6).parcel, undefined);
  scene.destroy();
});

test('camera follows its target with finite constrained orbit and projects that target to the center', () => {
  const result = orbitCamera({ x: 12, y: 19, z: 0 }, { yaw: 100000, pitch: Infinity, distance: -10 });
  assert.equal(result.orbit.distance, 6); assert.ok(result.orbit.yaw >= -Math.PI && result.orbit.yaw <= Math.PI);
  assert.deepEqual(normalizeOrbit({ pitch: 0, distance: 400 }), { yaw: Math.PI / 4, pitch: .3, distance: 32 });
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, .1, 100), { eye, target } = result;
  camera.position.set(eye.x, eye.y, eye.z); camera.lookAt(target.x, target.y, target.z); camera.updateMatrixWorld();
  const projected = new THREE.Vector3(target.x, target.y, target.z).project(camera);
  assert.ok(Math.abs(projected.x) < 1e-10); assert.ok(Math.abs(projected.y) < 1e-10);
  assert.equal(createVoxelWorld(null), null); assert.equal(createVoxelWorld({ getContext() { throw Error('No graphics'); }, addEventListener() {} }), null);
});

test('retained Three.js bundle and license match the verified pinned dependency manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../assets/vendor/three-source-manifest.json', import.meta.url)));
  assert.equal(manifest.package, 'three'); assert.equal(manifest.version, '0.186.1'); assert.equal(manifest.license, 'MIT'); assert.equal(manifest.integrity_verified, true);
  assert.match(manifest.registry, /^https:\/\/registry\.npmjs\.org\/three\/0\.186\.1$/);
  for (const file of manifest.files) {
    const content = readFileSync(new URL('../' + file.path, import.meta.url));
    assert.equal(content.length, file.bytes); assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256);
  }
});
