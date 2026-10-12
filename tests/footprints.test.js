// The reconciliation table is executable: every scenery type is classified once, and that class
// decides server occupancy and renderer geometry together. A drift in any of the five consumers
// (walkable, canStep, planWalk, placement, renderer) fails one of these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition, sharedWorldIds, walkable, move, terrainAt } from '../world.js';
import { REGIONS } from '../src/civic.js';
import { SCENERY_CLASSES, BLOCKING_SCENERY, DECORATIVE_SCENERY, DEFAULT_SCENERY_CLASS, TERRAIN_BLOCKING, sceneryClass, sceneryBlocks, solidTileKeys, solidSceneryAt, RESIDENT_CLEARANCE, RESIDENT_HEIGHT, GROUND_DETAIL, KNEE_HEIGHT } from '../src/footprints.js';
import { ELEVATION_BLOCKING_OBJECTS, canStep, blockLayers } from '../src/elevation.js';
import { planWalk } from '../src/world-walk.js';
import { createVoxelScene } from '../src/voxel-world.js';
import content from '../src/content.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog/countries.json', import.meta.url), 'utf8')).entries;
const worldIds = [...sharedWorldIds, 'frontier:0:0', 'frontier:-3:5', ...REGIONS.map((region) => `district:${region.id}`), 'country:NPL', 'home:sample', 'house:sample'];

const meadow = (columns = 12, rows = 12, objects = []) => ({ id: 'test-meadow', kind: 'outdoors', columns, rows, start: { x: 4, y: 4 },
  terrain: Array.from({ length: rows }, () => Array(columns).fill('meadow')), objects, portals: [], landmarks: [] });
// One cardinal step onto `position` from its left neighbour, with the shared solid index supplied.
const stepOnto = (definition, objects, position) => canStep({ x: position.x - 1, y: position.y, z: 0 }, 'right',
  { walkable, definition, layers: blockLayers([]), objects, solidTiles: solidTileKeys(objects) });

test('every scenery type the world can place is classified exactly once, and unknown types fail closed', () => {
  const authored = new Set(Object.keys(SCENERY_CLASSES));
  for (const id of worldIds) for (const object of getWorldDefinition(id).objects || []) assert.ok(authored.has(object.type || object.kind), `${id} places an unclassified scenery type ${object.type || object.kind}`);
  for (const type of new Set([...content.palette('garden'), ...content.palette('house')])) assert.ok(authored.has(type), `the sealed build palettes place an unclassified type ${type}`);
  // Water, buildings and walls are terrain only; trees and fountains exist as both a terrain type and
  // a placeable object, and both spellings resolve to the same solid class.
  for (const type of ['water', 'building', 'wall']) assert.equal(Object.hasOwn(SCENERY_CLASSES, type), false);
  for (const type of ['tree', 'fountain']) assert.equal(sceneryBlocks(type), true);
  for (const [type, kind] of Object.entries(SCENERY_CLASSES)) {
    assert.ok(['mass', 'flat', 'frame'].includes(kind), `${type} has an unknown class ${kind}`);
    assert.equal(sceneryClass(type), kind);
    assert.equal(sceneryBlocks(type), kind === 'mass');
  }
  assert.deepEqual([...BLOCKING_SCENERY, ...DECORATIVE_SCENERY].sort(), Object.keys(SCENERY_CLASSES).sort());
  assert.equal(BLOCKING_SCENERY.length + DECORATIVE_SCENERY.length, Object.keys(SCENERY_CLASSES).length);
  for (const type of ['invented-statue', 'coin', '', undefined, null, 7]) {
    assert.equal(sceneryClass(type), DEFAULT_SCENERY_CLASS);
    assert.equal(sceneryBlocks(type), true, `${String(type)} must fail closed as a solid`);
  }
  assert.equal(DEFAULT_SCENERY_CLASS, 'mass');
  assert.equal(Object.isFrozen(SCENERY_CLASSES), true);
  assert.deepEqual(ELEVATION_BLOCKING_OBJECTS, BLOCKING_SCENERY, 'the elevation blocker list is the shared table');
});

test('blocking scenery is refused by walkable, canStep and planWalk; decorative scenery is not', () => {
  const tile = { x: 5, y: 4 }, open = meadow(12, 12);
  for (const type of BLOCKING_SCENERY) {
    const saved = [{ type, x: tile.x, y: tile.y }], authored = meadow(12, 12, saved);
    // A saved object (garden furniture) is refused by the shared solid index, and an authored object
    // is refused by walkable() as well: both enforcement points read the same table.
    assert.equal(stepOnto(open, saved, tile).blocked, true, `${type} must block a step`);
    assert.equal(stepOnto(open, saved, tile).reason, 'object', `${type} blocks through the shared scenery check`);
    assert.equal(walkable(tile, authored), false, `${type} must not be walkable as authored scenery`);
    assert.equal(stepOnto(authored, saved, tile).blocked, true, `${type} must block its authored step too`);
    assert.equal(planWalk(authored, { x: 3, y: 4 }, tile), null, `${type} must be routed around`);
    assert.equal(planWalk(open, { x: 3, y: 4 }, tile, { objects: saved }), null, `${type} is routed around as a saved object too`);
    assert.deepEqual(move({ x: 4, y: 4 }, 'right', authored), { x: 4, y: 4 }, `${type} must stop the terrain move helper`);
    assert.equal(solidSceneryAt(tile, saved), true);
  }
  for (const type of DECORATIVE_SCENERY) {
    const saved = [{ type, x: tile.x, y: tile.y }], authored = meadow(12, 12, saved);
    assert.equal(walkable(tile, authored), true, `${type} must stay walkable`);
    assert.equal(stepOnto(authored, saved, tile).blocked, false, `${type} must not block a step`);
    assert.deepEqual(planWalk(authored, { x: 3, y: 4 }, tile), ['right', 'right'], `${type} must stay routable`);
    assert.deepEqual(move({ x: 4, y: 4 }, 'right', authored), { x: 5, y: 4 });
    assert.equal(solidSceneryAt(tile, saved), false);
  }
  for (const type of TERRAIN_BLOCKING) {
    const definition = meadow(12, 12);
    definition.terrain[4][4] = type;
    assert.equal(walkable({ x: 4, y: 4 }, definition), false, `terrain ${type} must not be walkable`);
  }
});

test('authored scenery on walkable terrain is now occupancy: the Commons tree resolves where a meadow tile did not', () => {
  const commons = getWorldDefinition('commons'), trees = (commons.objects || []).filter((object) => object.type === 'tree' && !TERRAIN_BLOCKING.includes(terrainAt(object, 'commons')));
  assert.ok(trees.length >= 8, 'the Commons still places decorative trees on open meadow');
  for (const tree of trees) {
    assert.equal(TERRAIN_BLOCKING.includes(terrainAt(tree, 'commons')), false, `the terrain under ${tree.x},${tree.y} is walkable on its own`);
    assert.equal(walkable(tree, commons), false, `a resident may not stand inside the tree at ${tree.x},${tree.y}`);
    assert.equal(stepOnto(commons, [{ type: 'tree', x: tree.x, y: tree.y }], tree).blocked, true, `the server refuses the tree at ${tree.x},${tree.y}`);
    assert.equal(planWalk(commons, { x: tree.x - 1, y: tree.y }, tree), null);
  }
  const farm = (commons.objects || []).find((object) => object.type === 'farm');
  assert.ok(farm, 'the Commons keeps a low crop patch');
  assert.equal(walkable(farm, commons), true, 'a resident still walks among low crops');
  const positions = solidTileKeys(commons.objects);
  assert.ok(positions.size > 20 && positions.size < (commons.objects || []).length, 'the solid index holds a subset of the authored scenery');
});

test('arrival and portal tiles stay clear, and every shared world stays connected from its arrival', () => {
  for (const id of worldIds) {
    const definition = getWorldDefinition(id);
    assert.equal(walkable(definition.start, definition), true, `${id} must arrive on a walkable tile`);
    assert.equal(solidSceneryAt(definition.start, definition.objects), false, `${id} must arrive clear of solid scenery`);
    for (const portal of definition.portals || []) {
      assert.equal(walkable(portal, definition), true, `${id} portal ${portal.name} at ${portal.x},${portal.y} must stay walkable`);
      assert.equal(solidSceneryAt(portal, definition.objects), false, `${id} portal ${portal.name} must stay clear of solid scenery`);
      assert.ok(planWalk(definition, definition.start, portal), `${id} must keep a route from the arrival to ${portal.name}`);
    }
  }
});

test('every country ambassador stand is a clear plaza tile, not inside a lantern, bench or table', () => {
  const plaza = { x: 12, y: 8, width: 16, height: 16 };
  for (const iso3 of [...new Set(catalog.map((entry) => entry.iso3))].slice(0, 40)) {
    const definition = getWorldDefinition(`country:${iso3}`), index = catalog.findIndex((entry) => entry.iso3 === iso3);
    const stand = { x: plaza.x + (index % plaza.width), y: plaza.y + Math.floor(index / plaza.width) };
    assert.equal(walkable(stand, definition), true, `${iso3} ambassador stands on a walkable plaza tile`);
    assert.equal(solidSceneryAt(stand, definition.objects), false, `${iso3} ambassador stand ${stand.x},${stand.y} must be clear of solid scenery`);
    assert.ok(['plaza', 'garden'].includes(terrainAt(stand, definition)), `${iso3} stand terrain is a walkable plaza surface`);
  }
});

// The renderer is asserted against the same class rules the table declares, using the real instance
// matrices the GPU would receive.
const column = (x, y) => ({ minX: x + 0.5 - RESIDENT_CLEARANCE, maxX: x + 0.5 + RESIDENT_CLEARANCE, minY: y + 0.5 - RESIDENT_CLEARANCE, maxY: y + 0.5 + RESIDENT_CLEARANCE });
const boxOf = (mesh, index) => { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix); const element = matrix.elements;
  return { minX: element[12] - Math.abs(element[0]) / 2, maxX: element[12] + Math.abs(element[0]) / 2, minY: element[13] - Math.abs(element[5]) / 2, maxY: element[13] + Math.abs(element[5]) / 2,
    minZ: element[14] - Math.abs(element[10]) / 2, maxZ: element[14] + Math.abs(element[10]) / 2 }; };
const standingOverlap = (box, tile, top = RESIDENT_HEIGHT) => box.minX < tile.maxX && box.maxX > tile.minX && box.minZ < tile.maxY && box.maxZ > tile.minY && box.minY < top && box.maxY > GROUND_DETAIL;
const renderedBoxes = (definition, matches, snapshot = {}) => {
  const scene = createVoxelScene(); scene.update(definition, snapshot, { position: { x: 4, y: 4 } });
  const boxes = [];
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) if (matches(mesh.userData.picks[index])) boxes.push(boxOf(mesh, index));
  }
  scene.destroy(); return boxes;
};
const neighbourhood = (x, y) => { const tiles = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push({ dx, dy, tile: column(x + dx, y + dy) }); return tiles; };

test('the renderer draws each scenery class as the table declares it', () => {
  for (const [type, kind] of Object.entries(SCENERY_CLASSES)) {
    if (['gateway', 'portal', 'gate'].includes(type)) continue;
    const definition = meadow(12, 12, [{ type, x: 4, y: 4 }]);
    const boxes = renderedBoxes(definition, (pick) => pick?.type === 'object' && (pick.object?.type || pick.object?.kind) === type);
    assert.ok(boxes.length, `${type} must be drawn`);
    if (kind === 'mass') {
      assert.ok(boxes.some((box) => standingOverlap(box, column(4, 4), Infinity)), `${type} must occupy its own tile`);
      for (const { dx, dy, tile } of neighbourhood(4, 4)) if (dx || dy) assert.equal(boxes.some((box) => standingOverlap(box, tile)), false, `${type} must not reach into the resident standing in ${4 + dx},${4 + dy}`);
    } else if (kind === 'flat') {
      for (const box of boxes) {
        assert.ok(box.minX >= 4 - 1e-6 && box.maxX <= 5 + 1e-6 && box.minZ >= 4 - 1e-6 && box.maxZ <= 5 + 1e-6, `${type} must stay inside its own tile`);
        assert.ok(box.maxY <= KNEE_HEIGHT + 1e-9, `${type} is ground detail no higher than ${KNEE_HEIGHT}`);
      }
    } else {
      for (const { dx, dy, tile } of neighbourhood(4, 4)) assert.equal(boxes.some((box) => standingOverlap(box, tile)), false, `${type} is a walk-through frame beside the resident at ${4 + dx},${4 + dy}`);
    }
  }
});

test('portals, frontier gates and landmark pennants are walk-through navigation markers', () => {
  const portal = { x: 4, y: 4, name: 'Hall', targetWorldId: 'hall' };
  const portalBoxes = renderedBoxes({ ...meadow(12, 12), portals: [portal] }, (pick) => pick?.type === 'portal');
  assert.ok(portalBoxes.length);
  for (const { dx, dy, tile } of neighbourhood(4, 4)) assert.equal(portalBoxes.some((box) => standingOverlap(box, tile)), false, `the portal frame must not cover the resident at ${4 + dx},${4 + dy}`);
  assert.equal(renderedBoxes(meadow(12, 12), (pick) => pick?.type === 'gate').length, 0, 'an open world draws no gate');
  const gate = { direction: 'up', x: 4, y: 4, exists: false, target_world_id: 'frontier:0:-1' };
  const closedBoxes = renderedBoxes(meadow(12, 12), (pick) => pick?.type === 'gate', { frontier: { neighbors: [gate] } });
  assert.ok(closedBoxes.length);
  for (const { dx, dy, tile } of neighbourhood(4, 4)) assert.equal(closedBoxes.some((box) => standingOverlap(box, tile)), false, `the frontier gate frame must not cover the resident at ${4 + dx},${4 + dy}`);
  // Landmark pennants carry no pick, so every non-terrain instance in the tile is checked directly.
  const pennant = renderedBoxes({ ...meadow(12, 12), landmarks: [{ x: 4, y: 4, name: 'Welcome Plaza', color: '#d9a36d' }] }, (pick) => pick === undefined || pick === null);
  assert.ok(pennant.length >= 2, 'the pennant pole and flag are drawn');
  for (const { dx, dy, tile } of neighbourhood(4, 4)) assert.equal(pennant.some((box) => standingOverlap(box, tile)), false, `the landmark marker must not cover the resident at ${4 + dx},${4 + dy}`);
});

test('a solid tile index is stable and complete for saved and authored objects alike', () => {
  const objects = [{ type: 'bench', x: 1, y: 2 }, { type: 'flowers', x: 1, y: 3 }, { kind: 'tree', x: 2, y: 2 }, { type: 'invented', x: 3, y: 2 }, { type: 'cottage' }, null];
  const index = solidTileKeys(objects);
  assert.deepEqual([...index].sort(), ['1,2', '2,2', '3,2']);
  assert.equal(solidTileKeys(objects), index, 'the index is derived once per object list');
  assert.equal(solidTileKeys([]).size, 0);
  assert.equal(solidTileKeys(undefined).size, 0);
  assert.equal(solidSceneryAt({ x: 1.5, y: 2 }, objects), false);
  assert.equal(solidSceneryAt({ x: 1, y: 3 }, objects), false);
});
