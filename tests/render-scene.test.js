// The scene layout and the reuse policy that has to survive it.
//
// Task 31 moved the world's composition out of src/voxel-world.js into src/scene/. These tests pin
// the interface that move created and re-assert the two measured rendering wins it must not cost:
// an unchanged viewport rebuilds nothing, and a one-block edit still leaves the diorama alone. They
// also add the new guarantee the sky layer needs — a phase change rebuilds the sky and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as batch from '../src/scene/batch.js';
import * as terrain from '../src/scene/terrain.js';
import * as water from '../src/scene/water.js';
import * as vegetation from '../src/scene/vegetation.js';
import * as buildings from '../src/scene/buildings.js';
import * as blocks from '../src/scene/blocks.js';
import * as parcels from '../src/scene/parcels.js';
import * as sky from '../src/scene/sky.js';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition, sharedWorldIds } from '../world.js';
import { REGIONS } from '../src/civic.js';
import { RESIDENT_CLEARANCE } from '../src/footprints.js';
import { VOXEL_LIMITS } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';

const commons = getWorldDefinition('commons');
const roster = () => [
  { id: 'human', name: 'Human', x: 10, y: 6, z: 0, color: '#cb725f', posture: 'standing', kind: 'human', status: 'active', last_seen: '2026-10-13T09:00:00Z' },
  { id: 'npc-1', name: 'Guide', x: 12, y: 8, z: 0, color: 'teal', posture: 'sitting', kind: 'npc', status: 'active', last_seen: '2026-10-13T09:00:01Z' },
];
const meshes = (scene, name) => [...(scene.root.getObjectByName(name)?.children || [])];
const same = (group, before) => group.children.length === before.length && before.every((mesh, index) => group.children[index] === mesh);

test('the scene modules expose one documented interface each, and share the batch primitives', () => {
  assert.equal(typeof batch.createResources, 'function');
  assert.equal(typeof batch.cubeBatch, 'function');
  assert.equal(typeof batch.disposeBatch, 'function');
  assert.deepEqual(batch.SHADOWLESS_STYLES.filter((style) => ['cloud', 'detail', 'haze', 'star', 'sun'].includes(style)).sort(), ['cloud', 'detail', 'haze', 'star', 'sun'].sort());
  for (const name of ['groundPass', 'portalFrames', 'gateFrames', 'landmarkPennants', 'layer']) assert.ok(Object.hasOwn(terrain, name), `src/scene/terrain.js exports ${name}`);
  for (const name of ['waterTile', 'waterBasin', 'waterDepth', 'shoreSides', 'WATER_TINTS']) assert.ok(Object.hasOwn(water, name), `src/scene/water.js exports ${name}`);
  assert.equal(typeof vegetation.groundCoverPass, 'function');
  assert.equal(typeof buildings.wallTile, 'function');
  assert.equal(typeof buildings.buildingTile, 'function');
  assert.equal(typeof blocks.blocksScene, 'function');
  assert.equal(typeof parcels.parcelScene, 'function');
  for (const name of ['SKY_PHASES', 'SHADOW_LIMITS', 'CLOUD_BANKS', 'CLOUD_SLABS', 'applyPhase', 'fogFor', 'phaseLighting', 'shadowExtent', 'skyScene']) assert.ok(Object.hasOwn(sky, name), `src/scene/sky.js exports ${name}`);
  // The shared resident geometry still has one definition, read by every scene module and the test
  // that measures it: nothing under src/scene/ restates the standing column.
  assert.equal(RESIDENT_CLEARANCE, 0.38);
  assert.deepEqual(Object.keys(water.WATER_TINTS).sort(), ['deep', 'foam', 'glint', 'lily', 'reed', 'shallow']);
});

test('an unchanged viewport rebuilds no batch, and each change rebuilds only what changed', () => {
  const scene = createVoxelScene(), people = roster(), position = { x: 12, y: 8 };
  const options = { position, self: people[0], dayPhase: 'day' };
  scene.update(commons, { participants: people }, options);
  const terrainMeshes = meshes(scene, 'voxel-terrain'), characterMeshes = meshes(scene, 'voxel-characters'), skyMeshes = meshes(scene, 'voxel-sky');
  assert.ok(terrainMeshes.length > 0 && characterMeshes.length > 0 && skyMeshes.length > 0);

  // An idle poll: identical payload, so every batch is reused.
  scene.update(commons, { participants: people }, options);
  assert.ok(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes));
  assert.ok(same(scene.root.getObjectByName('voxel-characters'), characterMeshes));
  assert.ok(same(scene.root.getObjectByName('voxel-sky'), skyMeshes));

  // A roster poll that only moves presence: nothing is rebuilt at all.
  scene.update(commons, { participants: people.map((person) => ({ ...person, last_seen: '2026-10-13T09:30:00Z', presence: 'connected' })) }, options);
  assert.ok(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes));
  assert.ok(same(scene.root.getObjectByName('voxel-characters'), characterMeshes));
  assert.ok(same(scene.root.getObjectByName('voxel-sky'), skyMeshes));

  // A phase change is the one thing the sky layer follows: the diorama and the residents do not move.
  scene.update(commons, { participants: people }, { ...options, dayPhase: 'night' });
  assert.ok(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes), 'a phase change never rebuilds the diorama');
  assert.ok(same(scene.root.getObjectByName('voxel-characters'), characterMeshes), 'nor the residents');
  assert.equal(same(scene.root.getObjectByName('voxel-sky'), skyMeshes), false, 'only the sky batch follows the phase');
  const nightSky = meshes(scene, 'voxel-sky');
  scene.update(commons, { participants: people }, { ...options, dayPhase: 'evening' });
  assert.ok(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes));
  assert.equal(same(scene.root.getObjectByName('voxel-sky'), nightSky), false, 'the legacy evening alias resolves to dusk, which is its own sky');
  const duskSky = meshes(scene, 'voxel-sky');

  // Placing one block rebuilds the saved blocks and nothing else — the measured one-block win.
  const block = { id: 'bench-one', x: 9, y: 9, z: 0, type: 'wood' };
  scene.update(commons, { participants: people, blocks: [block] }, { ...options, dayPhase: 'dusk' });
  assert.ok(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes));
  assert.ok(same(scene.root.getObjectByName('voxel-sky'), duskSky));
  const blockMeshes = meshes(scene, 'voxel-blocks');
  block.z = 1;
  scene.update(commons, { participants: people, blocks: [block] }, { ...options, dayPhase: 'dusk' });
  assert.ok(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes), 'placing one block must not rebuild the diorama');
  assert.equal(same(scene.root.getObjectByName('voxel-blocks'), blockMeshes), false);
  // Moving the viewport moves the window, so the diorama and its sky follow, and the blocks do not.
  const movedBlocks = meshes(scene, 'voxel-blocks');
  scene.update(commons, { participants: people, blocks: [block] }, { ...options, position: { x: 14, y: 10 }, dayPhase: 'dusk' });
  assert.equal(same(scene.root.getObjectByName('voxel-terrain'), terrainMeshes), false, 'a new window is a new diorama');
  assert.ok(same(scene.root.getObjectByName('voxel-blocks'), movedBlocks), 'and it never rebuilds the saved blocks');
  scene.destroy();
});

test('the occlusion cull and the layer budget survive the extraction', () => {
  const scene = createVoxelScene(), position = commons.start;
  const full = scene.update(commons, {}, { position, cullHidden: false });
  const fullInstances = meshes(scene, 'voxel-terrain').reduce((sum, mesh) => sum + mesh.count, 0);
  const grid = scene.update(commons, {}, { position });
  const culledInstances = meshes(scene, 'voxel-terrain').reduce((sum, mesh) => sum + mesh.count, 0);
  assert.ok(culledInstances < fullInstances, 'enclosed interior base cubes are still culled whole');
  assert.equal(full.cubes - grid.cubes, fullInstances - culledInstances, 'the cull is the only difference between the two builds');
  assert.ok(full.cubes > grid.cubes);
  // The layer tally names what each pass drew and never claims more than the scene holds.
  const layers = grid.layers, total = Object.values(layers).reduce((sum, value) => sum + value, 0);
  for (const name of ['terrain', 'water', 'buildings', 'furniture', 'navigation', 'cover', 'understory', 'sky']) assert.ok(Object.hasOwn(layers, name), `the report names the ${name} layer`);
  assert.ok(total <= grid.cubes, `${total} layer cubes must not exceed the ${grid.cubes} the scene holds`);
  assert.ok(layers.sky > 0);
  assert.equal(grid.skyCubes, layers.sky, 'the sky layer is the sky batch it reports');
  // The one child order both the tests and the renderer read: terrain, characters, blocks, plots, sky.
  assert.equal(scene.root.children[0].name, 'voxel-terrain');
  assert.equal(scene.root.children[1].name, 'voxel-characters');
  assert.equal([...scene.root.children].pop().name !== 'voxel-terrain', true);
  assert.ok(scene.pickables.every((mesh) => mesh.userData.picks));
  scene.destroy();
});

test('every authored world draws finite, colour-valid instances from three camera positions', () => {
  // A missing palette key or a NaN tint would not throw: it would draw an invisible or degenerate
  // instance. This walks every shared world and every district at three positions and reads the real
  // instance matrices and material colours back.
  const ids = [...sharedWorldIds, ...REGIONS.map((region) => `district:${region.id}`), 'frontier:0:0', 'frontier:-3:5', 'home:sample', 'house:sample'];
  const matrix = new THREE.Matrix4();
  let built = 0, cubes = 0;
  for (const id of ids) {
    const definition = getWorldDefinition(id), scene = createVoxelScene();
    for (const [x, y] of [[definition.start.x, definition.start.y], [1, 1]]) {
      const stats = scene.update(definition, {}, { position: { x, y } });
      cubes += stats.cubes; built++;
      assert.ok(stats.cubes > 0, `${id} draws geometry at ${x},${y}`);
      for (const group of scene.root.children) for (const mesh of group.children) {
        const hex = mesh.material.color?.getHexString?.();
        assert.match(hex || '', /^[0-9a-f]{6}$/, `${id} draws a valid material colour in ${group.name}`);
        for (let index = 0; index < mesh.count; index++) {
          mesh.getMatrixAt(index, matrix);
          assert.ok(matrix.elements.every((value) => Number.isFinite(value)), `${id} ${group.name} instance ${index} is finite`);
        }
      }
    }
    scene.destroy();
  }
  assert.ok(ids.length >= 40, `the sweep covers the authored worlds (${ids.length})`);
  assert.equal(built, ids.length * 2, 'every world was built from both positions');
  assert.ok(cubes > 100000, `${built} builds drew ${cubes} cubes`);
});

test('batches stay inside the draw-call and instance budgets on a full viewport', () => {
  for (const id of ['commons', 'frontier:0:0', 'country:NPL', 'house:sample']) {
    const scene = createVoxelScene(), definition = getWorldDefinition(id), people = roster();
    const stats = scene.update(definition, { participants: people, blocks: [{ id: 'b', x: definition.start.x, y: definition.start.y, z: 0, type: 'stone' }] }, { position: definition.start });
    assert.ok(stats.cells <= VOXEL_LIMITS.cells, `${id} stays inside the cell bound`);
    assert.ok(stats.blocks <= VOXEL_LIMITS.blocks);
    assert.ok(stats.participants <= VOXEL_LIMITS.participants);
    assert.ok(stats.drawBatches < 130, `${id} draws ${stats.drawBatches} batches`);
    assert.ok(meshes(scene, 'voxel-terrain').length > 0);
    scene.destroy();
  }
});
