// Architecture and district variety, measured on the real boxes.
//
// src/scene/architecture.js draws houses, civic buildings and pavilions from a district style. This file holds
// the two promises that make that safe: no variant ever reaches into a neighbour's standing column or draws an
// unpicked box in the walking height band (the rules src/footprints.js states), and the variety is real — five
// cottages in a row differ, and the twenty districts do not share one template.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cubeBatch, createResources } from '../src/scene/batch.js';
import { civic, cottage, pavilion, HEAD, LOW_REACH } from '../src/scene/architecture.js';
import { DISTRICT_STYLES, districtKey, districtStyle } from '../src/scene/districts.js';
import { RESIDENT_CLEARANCE } from '../src/footprints.js';
import { REGIONS } from '../src/civic.js';
import { getWorldDefinition } from '../world.js';
import * as THREE from '../assets/vendor/three-voxel.js';

const colors = { wall: '#d5c4a1', roof: '#bd7961', glass: '#9bcfc4', dark: '#324842', cream: '#f1e9cb', trim: '#f1e9cb', stone: '#968b79', gold: '#e2ca83', wood: '#81664a', leaf: '#468969' };
const PICK = { type: 'object' };
/** Builds one tile's worth of boxes through the real batch, and reads them back from the instance matrices. */
function boxesOf(draw, x = 4, y = 4) {
  const resources = createResources(), batch = cubeBatch(resources); draw(batch, x, y);
  const { group } = batch.finish(), matrix = new THREE.Matrix4(), boxes = [];
  for (const mesh of group.children) for (let index = 0; index < mesh.count; index++) {
    mesh.getMatrixAt(index, matrix); const e = matrix.elements, pick = mesh.userData.picks[index];
    boxes.push({ minX: e[12] - Math.abs(e[0]) / 2, maxX: e[12] + Math.abs(e[0]) / 2, minY: e[13] - Math.abs(e[5]) / 2, maxY: e[13] + Math.abs(e[5]) / 2,
      minZ: e[14] - Math.abs(e[10]) / 2, maxZ: e[14] + Math.abs(e[10]) / 2, pick, style: mesh.userData.style });
  }
  resources.dispose(); return boxes;
}
// The matrices are 32-bit floats, so the column is shrunk by a hair (0.1 mm) before a box is said to enter it.
const EPS = 1e-4, reach = RESIDENT_CLEARANCE - EPS;
const tile = (x, y) => ({ minX: x + .5 - reach, maxX: x + .5 + reach, minZ: y + .5 - reach, maxZ: y + .5 + reach });
const inColumn = (box, t) => box.minX < t.maxX && box.maxX > t.minX && box.minZ < t.maxZ && box.maxZ > t.minZ && box.minY < HEAD && box.maxY > .1;
const draws = { cottage: (style) => (batch, x, y) => cottage(batch, { x, y, pick: PICK, style, colors }),
  'civic-building': (style) => (batch, x, y) => civic(batch, { x, y, pick: PICK, style, colors }),
  shelter: (style) => (batch, x, y) => pavilion(batch, { x, y, pick: PICK, style, colors }) };

test('every style, every building kind and many tiles keep the walking band clear and the mass honest', () => {
  let checked = 0;
  for (const [key, style] of Object.entries(DISTRICT_STYLES)) for (const [kind, draw] of Object.entries(draws)) for (let seed = 0; seed < 14; seed++) {
    const x = 3 + seed * 7, y = 5 + seed * 3, boxes = boxesOf(draw(style), x, y), label = `${key} ${kind} at ${x},${y}`;
    assert.ok(boxes.length > 8 && boxes.length < 140, `${label} draws a bounded number of boxes (${boxes.length})`);
    for (const box of boxes) for (const value of Object.values(box)) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${label} is finite`);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const neighbour = tile(x + dx, y + dy);
      for (const box of boxes) assert.equal(inColumn(box, neighbour), false, `${label} must not reach into the resident at ${x + dx},${y + dy} (${JSON.stringify(box)})`);
    }
    // Below head height nothing reaches past the tile edge plus the 0.12 m a standing resident leaves.
    for (const box of boxes) if (box.minY < HEAD) {
      for (const [low, high, centre] of [[box.minX, box.maxX, x + .5], [box.minZ, box.maxZ, y + .5]]) assert.ok(low >= centre - LOW_REACH - EPS && high <= centre + LOW_REACH + EPS, `${label}: a low box reaches ${low.toFixed(2)}..${high.toFixed(2)}`);
    }
    if (kind !== 'shelter') {
      // A house is a mass: some picked box occupies its own tile in the standing band, and every unpicked one is overhead.
      assert.ok(boxes.some((box) => box.pick && inColumn(box, tile(x, y))), `${label} occupies its own tile`);
      for (const box of boxes) if (!box.pick) assert.ok(box.minY >= 2, `${label}: smoke and other unpicked boxes stay overhead (${box.minY})`);
      assert.ok(Math.max(...boxes.filter((box) => box.pick).map((box) => box.maxY)) < 5.2, `${label} stays a house, not a skyscraper`);
    } else for (const box of boxes) assert.ok(box.pick, `${label} is picked`);
    checked++;
  }
  assert.equal(checked, Object.keys(DISTRICT_STYLES).length * 3 * 14);
});

test('five cottages in a row are five different houses, and the districts are not one template', () => {
  const style = DISTRICT_STYLES.commons, signature = (boxes) => `${boxes.length}:${[...new Set(boxes.map((box) => box.maxY.toFixed(2)))].length}:${Math.max(...boxes.map((box) => box.maxY)).toFixed(2)}`;
  const row = [10, 16, 22, 28, 34].map((x) => boxesOf(draws.cottage(style), x, 27)), seen = new Set(row.map(signature));
  assert.ok(seen.size >= 4, `five neighbours show at least four different silhouettes (${[...seen].join(' | ')})`);
  const palettes = new Set(REGIONS.map((region) => JSON.stringify(DISTRICT_STYLES[region.id].wall)));
  assert.equal(palettes.size, REGIONS.length, 'every district has its own wall palette');
  const roofs = new Set(REGIONS.map((region) => JSON.stringify(DISTRICT_STYLES[region.id].shapes)));
  assert.ok(roofs.size >= 8, `the districts choose from at least eight different roof-shape sets (${roofs.size})`);
  for (const region of REGIONS) assert.equal(districtKey(getWorldDefinition(`district:${region.id}`)), region.id);
  assert.equal(districtKey({ id: 'frontier:0:0' }), 'commons'); assert.equal(districtKey({ id: 'country:NPL' }), 'commons'); assert.equal(districtKey(null), 'commons');
  assert.equal(districtStyle(getWorldDefinition('district:coast')), DISTRICT_STYLES.coast);
  const shapes = new Set(Object.values(DISTRICT_STYLES).flatMap((style) => style.shapes));
  assert.ok(shapes.size >= 9, `the style table reaches ${shapes.size} roof shapes`);
});

test('the same tile always draws the same house, and the cities build civic towers', () => {
  const style = DISTRICT_STYLES.cities, one = boxesOf(draws.cottage(style), 12, 27), two = boxesOf(draws.cottage(style), 12, 27);
  assert.deepEqual(one, two);
  const civicBoxes = boxesOf(draws['civic-building'](style), 24, 10);
  assert.ok(Math.max(...civicBoxes.map((box) => box.maxY)) > 3.4, 'a city civic building is a clock tower');
});
