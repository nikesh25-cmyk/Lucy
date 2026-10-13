// Obstacle truth: what is drawn with mass is a tile the server refuses, and every tile the server
// refuses is drawn as something a resident can see. Both directions are asserted over the real
// authored worlds, over every scenery type the shared table declares, over water and over saved
// block columns — because the renderer grew a ground-cover pass, a water pass, a sky pass and a
// rebuilt set of building and furniture shapes, and each of those could have broken the agreement.
//
// The rule is read from src/footprints.js, never restated: RESIDENT_CLEARANCE is the drawn resident's
// half-width, GROUND_DETAIL is the floor-decal height the table calls "never an obstacle", and
// KNEE_HEIGHT is the tallest thing a walkable tile may carry. `standableTile` and `solidTileKeys`
// are the server's own predicates.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition, sharedWorldIds } from '../world.js';
import { REGIONS } from '../src/civic.js';
import { SCENERY_CLASSES, GROUND_DETAIL, KNEE_HEIGHT, RESIDENT_HEIGHT, RESIDENT_CLEARANCE, TERRAIN_BLOCKING, standableTile, solidTileKeys, solidSceneryAt, sceneryBlocks } from '../src/footprints.js';
import { blockLayers, surfaceAt } from '../src/elevation.js';
import { voxelPlan } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { WATER_TINTS } from '../src/scene/water.js';

const meadow = (columns = 12, rows = 12, objects = []) => ({ id: 'render-meadow', kind: 'outdoors', columns, rows, start: { x: 4, y: 4 },
  terrain: Array.from({ length: rows }, () => Array(columns).fill('meadow')), objects, portals: [], landmarks: [] });
const column = (x, y) => ({ minX: x + .5 - RESIDENT_CLEARANCE, maxX: x + .5 + RESIDENT_CLEARANCE, minY: y + .5 - RESIDENT_CLEARANCE, maxY: y + .5 + RESIDENT_CLEARANCE });
/** Every instance the GPU would receive, with its real instance matrix. */
const drawnBoxes = (scene) => {
  const boxes = [], matrix = new THREE.Matrix4();
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix);
      const e = matrix.elements;
      boxes.push({ minX: e[12] - Math.abs(e[0]) / 2, maxX: e[12] + Math.abs(e[0]) / 2,
        minY: e[13] - Math.abs(e[5]) / 2, maxY: e[13] + Math.abs(e[5]) / 2,
        minZ: e[14] - Math.abs(e[10]) / 2, maxZ: e[14] + Math.abs(e[10]) / 2,
        color: mesh.material.color.getHexString(), pick: mesh.userData.picks[index] ?? null });
    }
  }
  return boxes;
};
const overColumn = (box, tile) => box.minX < tile.maxX && box.maxX > tile.minX && box.minZ < tile.maxY && box.maxZ > tile.minY;
/** A box that a standing resident would be inside: it reaches above the floor decal and below the head. */
const entersStanding = (box, tile) => overColumn(box, tile) && box.maxY > GROUND_DETAIL && box.minY < RESIDENT_HEIGHT;
const overKnee = (box, tile) => overColumn(box, tile) && box.maxY > KNEE_HEIGHT && box.minY < RESIDENT_HEIGHT;
/** A resident walks through a frame: geometry is legal beside the column, at the knee, or over the head. */
const clearsStanding = (box, tile) => !overColumn(box, tile) || box.maxY <= KNEE_HEIGHT || box.minY >= RESIDENT_HEIGHT;

/** Every drawn box that overlaps one tile's standing column. */
const boxesAt = (boxes, x, y) => { const tile = column(x, y); return boxes.filter((box) => overColumn(box, tile)); };

const worlds = ['commons', ...REGIONS.slice(0, 3).map((region) => `district:${region.id}`), 'frontier:0:0', 'frontier:-3:5', 'country:NPL', 'home:sample', 'house:sample'];
const planOf = (definition) => voxelPlan(definition, {}, definition.start);

test('every drawn obstacle in a real world is a tile the server refuses, and the reverse', () => {
  for (const id of worlds) {
    const definition = getWorldDefinition(id), plan = planOf(definition), solids = solidTileKeys(plan.objects);
    const scene = createVoxelScene(); scene.update(definition, {}, { position: definition.start });
    const boxes = drawnBoxes(scene);
    assert.ok(plan.cells.length > 100, `${id} draws a real window`);
    let walkableTiles = 0, refusedTiles = 0;
    for (const cell of plan.cells) {
      const { x, y, type } = cell, key = `${x},${y}`;
      const columns = boxesAt(boxes, x, y), tile = column(x, y);
      // The server's own rule for this tile: its terrain type and its authored scenery.
      const walkable = standableTile({ x, y }, definition.terrain, plan.objects) && !TERRAIN_BLOCKING.includes(type) && !solids.has(key);
      assert.equal(walkable, !TERRAIN_BLOCKING.includes(type) && !solids.has(key), `${id} ${key}: standableTile and the drawn class agree`);
      if (walkable) {
        walkableTiles++;
        const blocked = columns.filter((box) => overKnee(box, tile));
        assert.equal(blocked.length, 0, `${id} ${key} is walkable, so nothing may stand in its column above ${KNEE_HEIGHT} m (found ${JSON.stringify(blocked.slice(0, 2))})`);
        // A resident walks among ground detail, never inside it: untargetable decoration is either a
        // floor decal or entirely overhead (the cloud layer and the phase markers sit at 10 m).
        for (const box of columns) if (!box.pick) assert.ok(box.maxY <= GROUND_DETAIL || box.minY >= RESIDENT_HEIGHT,
          `${id} ${key}: untargetable decoration must stay at or below ${GROUND_DETAIL} m or above ${RESIDENT_HEIGHT} m (${box.maxY})`);
        continue;
      }
      refusedTiles++;
      // A tile the server refuses is either visibly solid, or open water drawn as water — the one
      // declared exception, because a resident is not stopped by a curb but by the water itself.
      const visible = columns.some((box) => entersStanding(box, tile));
      assert.ok(visible || type === 'water', `${id} ${key} (${type}) is not walkable, so it must be drawn as an obstacle`);
    }
    assert.ok(walkableTiles > 40 && refusedTiles > 5, `${id} exercises both directions (${walkableTiles} walkable, ${refusedTiles} refused)`);
    scene.destroy();
  }
});

test('every scenery type keeps the drawn world and the shared table in agreement', () => {
  let checked = 0;
  for (const type of Object.keys(SCENERY_CLASSES)) {
    if (['gateway', 'portal', 'gate'].includes(type)) continue;
    const definition = meadow(12, 12, [{ type, x: 4, y: 4 }]), plan = planOf(definition);
    const scene = createVoxelScene(); scene.update(definition, {}, { position: { x: 4, y: 4 } });
    const boxes = drawnBoxes(scene), key = '4,4', tile = column(4, 4);
    const kind = SCENERY_CLASSES[type], solid = solidSceneryAt({ x: 4, y: 4 }, plan.objects);
    assert.equal(solid, sceneryBlocks(type), `${type} resolves one occupancy`);
    if (solid) {
      const own = boxes.filter((box) => entersStanding(box, tile));
      assert.ok(own.length >= 1, `${type} is a mass, so its own tile must hold a drawn obstacle`);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        assert.equal(boxes.some((box) => entersStanding(box, column(4 + dx, 4 + dy))), false, `${type} must not stand inside the resident at ${4 + dx},${4 + dy}`);
      }
    } else {
      for (const box of boxes) assert.ok(clearsStanding(box, tile), `${type} stays walkable, so nothing may stand in its column between the knee and the head`);
    }
    // The whole window still agrees, not only the tested tile: the cover, understory and sky passes
    // run in the same build and must not plant anything a resident is stopped by.
    for (const cell of plan.cells) {
      const walkable = standableTile({ x: cell.x, y: cell.y }, definition.terrain, plan.objects);
      if (walkable) assert.equal(boxesAt(boxes, cell.x, cell.y).filter((box) => overKnee(box, column(cell.x, cell.y))).length, 0, `${type} build: ${cell.x},${cell.y} must stay clear`);
    }
    assert.ok(boxes.length > 0, `${type} is drawn`);
    scene.destroy(); checked++;
  }
  assert.ok(checked >= 20, `the loop covers the sealed vocabulary (${checked} types)`);
});

test('a mass is drawn as an obstacle, not as a floor decal: the pond and the garden path read as what they are', () => {
  const pond = { type: 'pond', x: 4, y: 4 }, path = { type: 'path', x: 5, y: 4 };
  const scene = createVoxelScene(); scene.update(meadow(12, 12, [pond, path]), {}, { position: { x: 4, y: 4 } });
  const boxes = drawnBoxes(scene);
  const pondBoxes = boxes.filter((box) => box.pick?.object === pond), pathBoxes = boxes.filter((box) => box.pick?.object === path);
  // A pond is a `mass`: the server refuses the tile, so its rim must be a real obstacle, not a curb.
  const top = Math.max(...pondBoxes.map((box) => box.maxY));
  assert.ok(top > GROUND_DETAIL, `the pond rim must rise above the ${GROUND_DETAIL} m decal height (measured ${top.toFixed(3)} m)`);
  assert.ok(pondBoxes.some((box) => box.color === '77b5bd'), 'the pond holds the tone its sealed definition declares');
  assert.ok(pondBoxes.some((box) => box.maxY < top), 'and water below the rim');
  for (const box of pondBoxes) assert.ok(box.minX >= 3.99 && box.maxX <= 5.01 && box.minZ >= 3.99 && box.maxZ <= 5.01, 'the pond stays inside its own tile');
  // A garden path is `flat`: it stays a walkable decal the resident stands on.
  assert.ok(pathBoxes.length >= 1);
  for (const box of pathBoxes) assert.ok(box.maxY <= GROUND_DETAIL, `the path stays a floor decal (${box.maxY})`);
  scene.destroy();
});

test('water is drawn as water, its tiles are refused, and its picks stay on the surface', () => {
  const definition = meadow(12, 12), shape = [['meadow', 'water', 'water', 'water'], ['water', 'water', 'water', 'water'], ['water', 'water', 'water', 'water'], ['meadow', 'meadow', 'water', 'water']];
  for (let y = 0; y < shape.length; y++) for (let x = 0; x < shape[y].length; x++) definition.terrain[4 + y][4 + x] = shape[y][x];
  const scene = createVoxelScene(); scene.update(definition, {}, { position: { x: 5, y: 5 } });
  const boxes = drawnBoxes(scene);
  const deep = boxes.filter((box) => box.pick?.terrain === 'water' && box.color === boxes.find((item) => item.pick?.terrain === 'water').color);
  assert.ok(deep.length, 'the water surface is drawn');
  const tints = new Set(boxes.filter((box) => box.pick?.terrain === 'water' && box.maxY > -.1 && box.maxY < 0).map((box) => box.color));
  assert.equal(tints.size, 2, `deep and shallow water are distinguishable (${[...tints].join(', ')})`);
  for (const [x, y] of [[5, 4], [4, 5], [6, 7]]) {
    assert.equal(standableTile({ x, y }, definition.terrain, definition.objects), false, `water at ${x},${y} is never walkable`);
    const pickable = boxesAt(boxes, x, y).filter((box) => box.pick?.type === 'terrain');
    assert.equal(pickable.length, 3, `water at ${x},${y} keeps exactly the bed, the slab and the surface pickable`);
    const decoration = boxesAt(boxes, x, y).filter((box) => !box.pick);
    assert.ok(decoration.every((box) => box.maxY <= .45), `water reads never rise past the knee on a refused tile (${x},${y})`);
  }
  // A shoreline tile carries a lighter break on the side that meets land, in the water module's own
  // tones rather than a literal here, so the assertion follows the tint instead of pinning it.
  const tones = [WATER_TINTS.foam, WATER_TINTS.glint].map((tone) => new THREE.Color(tone).getHexString());
  const shore = boxesAt(boxes, 5, 4).filter((box) => !box.pick);
  assert.ok(shore.some((box) => tones.includes(box.color)), `the shore reads as a break or a glide, not as flat water (${shore.map((box) => box.color).join(', ')})`);
  scene.destroy();
});

test('a saved block column is drawn at its own layer, and the layer its surface stands on stays clear', () => {
  const blocks = [{ id: 'a0', x: 5, y: 5, z: 0, type: 'wood' }, { id: 'a1', x: 5, y: 5, z: 1, type: 'wood' }, { id: 'a2', x: 5, y: 5, z: 2, type: 'wood' },
    { id: 'p0', x: 6, y: 5, z: 0, type: 'path' }, { id: 'legacy-path', x: 6, y: 6, z: 1, type: 'path' }];
  const scene = createVoxelScene(); scene.update(meadow(12, 12), { blocks }, { position: { x: 5, y: 5 } });
  const boxes = drawnBoxes(scene), layers = blockLayers(blocks);
  for (const block of blocks) {
    const drawn = boxes.find((box) => box.pick?.block?.id === block.id);
    assert.ok(drawn, `block ${block.id} is drawn`);
    if (block.type === 'path') { assert.ok(drawn.maxY - block.z <= GROUND_DETAIL, `the thin path block at ${block.x},${block.y},${block.z} stays a decal on its own layer`); continue; }
    assert.ok(Math.abs((drawn.minY + drawn.maxY) / 2 - (block.z + .5)) < 1e-3, `block ${block.id} is centred on layer ${block.z}`);
    assert.ok(drawn.maxY <= block.z + 1 && drawn.minY >= block.z - 1e-3, `block ${block.id} stays inside layer ${block.z}`);
    assert.ok(drawn.maxY - block.z > .9 && drawn.maxX - drawn.minX > .98, `the solid block ${block.id} fills its layer`);
  }
  // The server's own column model, read back: the wood column is solid, the path column is not.
  assert.deepEqual([...layers.get('5,5')].sort(), [0, 1, 2]);
  assert.equal(layers.has('6,5'), false, 'a path on the ground is not a solid layer');
  assert.equal(layers.has('6,6'), false, 'a legacy path row above the ground is not a solid layer either, and is drawn as the surface it is');
  const standing = surfaceAt(5, 5, layers);
  for (const box of boxesAt(boxes, 5, 5)) {
    if (box.maxY <= standing + GROUND_DETAIL) continue;
    assert.ok(box.minY >= standing + RESIDENT_HEIGHT || box.maxY <= standing + GROUND_DETAIL, 'nothing but air stands in the column above the surface a resident would occupy');
  }
  scene.destroy();
});

test('ground cover obeys the tile it grows on, and never becomes climbable by accident', () => {
  const definition = getWorldDefinition('commons'), plan = planOf(definition);
  const scene = createVoxelScene(); scene.update(definition, {}, { position: definition.start });
  const boxes = drawnBoxes(scene), solids = solidTileKeys(plan.objects);
  let decals = 0, understory = 0, overhead = 0;
  for (const box of boxes) {
    if (box.pick) continue;
    // Everything above the drawn resident's head is sky: the cloud layer, the phase disc and its
    // halo, a star, or a landmark pennant flag. It is scenery over the world, never ground cover.
    if (box.minY >= RESIDENT_HEIGHT) { overhead++; continue; }
    decals++;
    assert.ok(box.maxX - box.minX <= 1.01 && box.maxZ - box.minZ <= 1.01, `a land decoration spans more than its own tile (${box.minX}-${box.maxX})`);
    if (box.maxY > KNEE_HEIGHT) understory++;
  }
  assert.ok(decals > 50, `the ground-cover pass draws (${decals} land decorations)`);
  assert.ok(understory > 0, 'the understory exists around the planted tiles');
  assert.ok(overhead > 0, 'the sky layer is above the resident, not in their way');
  // Nothing a resident is stopped by was added anywhere the server says is walkable.
  for (const cell of plan.cells) {
    if (!standableTile({ x: cell.x, y: cell.y }, definition.terrain, plan.objects) || solids.has(`${cell.x},${cell.y}`)) continue;
    for (const box of boxesAt(boxes, cell.x, cell.y)) assert.ok(clearsStanding(box, column(cell.x, cell.y)), `nothing stands between the knee and the head on walkable ${cell.x},${cell.y}`);
  }
  scene.destroy();
});
