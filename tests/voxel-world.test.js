import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { createVoxelScene, createVoxelWorld } from '../src/voxel-world.js';
import { VOXEL_LIMITS, voxelWindow, voxelPlan, voxelPick, orbitCamera, normalizeOrbit, voxelParcelAddress, voxelParcels } from '../src/voxel-geometry.js';

const definition = (columns = 48, rows = 48) => ({ id: 'test-sector', columns, rows, kind: 'outdoors', start: { x: 24, y: 24 },
  terrain: Array.from({ length: rows }, () => Array(columns).fill('meadow')), objects: [], portals: [], landmarks: [] });
const castDown = (scene, x, y) => new THREE.Raycaster(new THREE.Vector3(x + .5, 12, y + .5), new THREE.Vector3(0, -1, 0))
  .intersectObjects(scene.pickables, false).map(voxelPick).find(Boolean);

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

test('scene renders the nearby shared world with real characters and reuses static terrain during movement', () => {
  const scene = createVoxelScene(), world = getWorldDefinition('commons'), participants = [{ id: 'human', name: 'Human', x: 10, y: 6, color: '#cb725f', status: 'active' }];
  const stats = scene.update(world, { participants }, { position: world.start, self: participants[0] });
  assert.ok(stats.cells > 300 && stats.cells <= VOXEL_LIMITS.cells); assert.equal(stats.participants, 1);
  assert.ok(stats.cubes > stats.cells * 2); assert.ok(stats.drawBatches < 130);
  const staticGroup = scene.root.children[0], oldPeople = scene.root.children[1]; let disposed = 0;
  assert.ok(oldPeople.children.some(mesh => mesh.material.color.getHexString() === 'cb725f'), 'Saved character color must appear in its actual 3D materials');
  for (const mesh of oldPeople.children) mesh.addEventListener('dispose', () => disposed++);
  participants[0].x = 12; scene.update(world, { participants }, { position: world.start, self: participants[0] });
  assert.equal(scene.root.children[0], staticGroup); assert.notEqual(scene.root.children[1], oldPeople); assert.ok(disposed > 0);
  const playerHit = castDown(scene, 12, 6); assert.equal(playerHit.type, 'participant'); assert.equal(playerHit.participant.id, 'human');
  scene.destroy(); scene.destroy(); assert.equal(scene.pickables.length, 0);
  assert.throws(() => scene.update(world), /destroyed/);
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
  const selectedOverlay = scene.root.getObjectByName('parcel-overlay'); assert.equal(selectedOverlay.userData.selectedParcel, selected.id);
  const edgeMesh = selectedOverlay.children.find(mesh => mesh.material.depthTest === false && mesh.material.opacity > .8);
  assert.ok(edgeMesh); edgeMesh.computeBoundingBox(); assert.ok(Math.abs(edgeMesh.boundingBox.min.x - (30 - .11 / 2)) < 1e-6); assert.ok(Math.abs(edgeMesh.boundingBox.max.x - (36 + .11 / 2)) < 1e-6);
  assert.ok(!scene.pickables.some(mesh => selectedOverlay.children.includes(mesh)));
  scene.highlightParcel(reserved, selected);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-characters'), people);
  assert.equal(scene.root.children.filter(group => group.name === 'parcel-overlay').length, 1);
  assert.equal(scene.root.getObjectByName('parcel-overlay').userData.selectedParcel, reserved.id);
  scene.update(world, snapshot, { ...options, parcelSelection: reserved });
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-characters'), people);
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
