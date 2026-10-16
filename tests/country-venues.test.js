// Task 20 — eight reviewed country venue variants. Each of the eight catalog entries assigned a
// variant is a fictional NemoWorld space inspired by a documented ecological or cultural practice;
// it is not a representation of territory, a government or a people, and eight variants are shared
// shapes rather than 248 unique venues. These tests assert the invariants the shipped code and the
// renderer both depend on: a deterministic pure-lookup assignment, the 40 × 28 kind-'country'
// contract, a fully walkable and clear 16 × 16 plaza band for any of the 248 ambassador stands, one
// connected walkable component from the arrival to the plaza, the landmark and every portal,
// agreement with the one shared footprint table, and an unchanged finite land inventory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from '../assets/vendor/three-voxel.js';
import { fixture } from './helpers.js';
import { getWorldDefinition, walkable, terrainAt, countryVenueVariant, COUNTRY_VENUE_VARIANTS, COUNTRY_VENUE_ASSIGNMENT, COUNTRY_VENUE_PLAZA, COUNTRY_COLUMNS, COUNTRY_ROWS } from '../world.js';
import { SCENERY_CLASSES, sceneryClass, sceneryBlocks, solidSceneryAt, RESIDENT_CLEARANCE, RESIDENT_HEIGHT, GROUND_DETAIL, KNEE_HEIGHT } from '../src/footprints.js';
import { planWalk } from '../src/world-walk.js';
import { createVoxelScene } from '../src/voxel-world.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog/countries.json', import.meta.url), 'utf8')).entries;
const assignedIso3 = Object.keys(COUNTRY_VENUE_ASSIGNMENT);
const assignedIds = assignedIso3.map((iso3) => `country:${iso3}`);
const unassignedIso3 = catalog.map((entry) => entry.iso3).filter((iso3) => !Object.hasOwn(COUNTRY_VENUE_ASSIGNMENT, iso3));
const standFor = (iso3) => { const index = catalog.findIndex((entry) => entry.iso3 === iso3); return { x: COUNTRY_VENUE_PLAZA.x + (index % COUNTRY_VENUE_PLAZA.width), y: COUNTRY_VENUE_PLAZA.y + Math.floor(index / COUNTRY_VENUE_PLAZA.width) }; };
const variantShape = (iso3) => { const definition = getWorldDefinition(`country:${iso3}`); return JSON.stringify([definition.terrain, definition.objects, definition.landmarks, definition.groundColor]); };

// A cardinal flood fill from the arrival over the tiles the server calls walkable.
function reachableFromArrival(definition) {
  const start = definition.start, seen = new Set([`${start.x},${start.y}`]), queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const next = { x: queue[cursor].x + dx, y: queue[cursor].y + dy }, key = `${next.x},${next.y}`;
    if (seen.has(key) || !walkable(next, definition)) continue;
    seen.add(key); queue.push(next);
  }
  return seen;
}
const plazaTiles = () => { const tiles = []; for (let y = COUNTRY_VENUE_PLAZA.y; y < COUNTRY_VENUE_PLAZA.y + COUNTRY_VENUE_PLAZA.height; y++) for (let x = COUNTRY_VENUE_PLAZA.x; x < COUNTRY_VENUE_PLAZA.x + COUNTRY_VENUE_PLAZA.width; x++) tiles.push({ x, y }); return tiles; };

// The renderer is asserted against the same class rules the shared table declares, using the real
// instance matrices the GPU would receive (the approach of tests/footprints.test.js).
const column = (x, y) => ({ minX: x + 0.5 - RESIDENT_CLEARANCE, maxX: x + 0.5 + RESIDENT_CLEARANCE, minY: y + 0.5 - RESIDENT_CLEARANCE, maxY: y + 0.5 + RESIDENT_CLEARANCE });
const boxOf = (mesh, index) => { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix); const e = matrix.elements;
  return { minX: e[12] - Math.abs(e[0]) / 2, maxX: e[12] + Math.abs(e[0]) / 2, minY: e[13] - Math.abs(e[5]) / 2, maxY: e[13] + Math.abs(e[5]) / 2, minZ: e[14] - Math.abs(e[10]) / 2, maxZ: e[14] + Math.abs(e[10]) / 2 }; };
const standingOverlap = (box, tile, top = RESIDENT_HEIGHT) => box.minX < tile.maxX && box.maxX > tile.minX && box.minZ < tile.maxY && box.maxZ > tile.minY && box.minY < top && box.maxY > GROUND_DETAIL;
const meadow = (objects) => ({ id: 'country-venue-test', kind: 'outdoors', columns: 12, rows: 12, start: { x: 4, y: 4 },
  terrain: Array.from({ length: 12 }, () => Array(12).fill('meadow')), objects, portals: [], landmarks: [] });
const renderedBoxes = (definition, matches, position = { x: 4, y: 4 }) => {
  const scene = createVoxelScene(); scene.update(definition, {}, { position });
  const boxes = [];
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) if (matches(mesh.userData.picks[index])) boxes.push(boxOf(mesh, index));
  }
  scene.destroy(); return boxes;
};
const neighbourhood = (x, y) => { const tiles = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push({ dx, dy, tile: column(x + dx, y + dy) }); return tiles; };
const variantSceneryTypes = new Set(assignedIds.flatMap((id) => (getWorldDefinition(id).objects || []).map((object) => object.type)));

test('the eight assignments are a frozen pure lookup and every catalog entry still resolves to a venue', () => {
  assert.equal(Object.isFrozen(COUNTRY_VENUE_VARIANTS), true);
  assert.equal(Object.isFrozen(COUNTRY_VENUE_ASSIGNMENT), true);
  assert.deepEqual([...COUNTRY_VENUE_VARIANTS], ['generic', 'terraces', 'satoyama', 'andenes', 'chinampas', 'argan', 'kaya', 'fabod', 'reef']);
  const catalogIso3 = new Set(catalog.map((entry) => entry.iso3));
  assert.equal(COUNTRY_VENUE_VARIANTS.length, 9);
  for (const [iso3, variant] of Object.entries(COUNTRY_VENUE_ASSIGNMENT)) {
    assert.ok(catalogIso3.has(iso3), `${iso3} is not a catalog entry`);
    assert.ok(COUNTRY_VENUE_VARIANTS.includes(variant) && variant !== 'generic', `${iso3} is assigned the unknown or generic variant ${variant}`);
  }
  assert.equal(Object.keys(COUNTRY_VENUE_ASSIGNMENT).length, 8);
  // The selector is a pure lookup: the assignment for an iso3 is exactly the authored value, and an
  // entry with no assignment keeps the generic shape. No hash, clock or database read is involved.
  for (const iso3 of assignedIso3) assert.equal(countryVenueVariant(iso3), COUNTRY_VENUE_ASSIGNMENT[iso3]);
  for (const iso3 of unassignedIso3) assert.equal(countryVenueVariant(iso3), 'generic');
  for (const value of ['', 'XXX', undefined, null, 'npl']) assert.equal(countryVenueVariant(value), 'generic');
  // Exactly eight of the 248 entries are non-generic, and every one of the 248 resolves.
  const variants = catalog.map((entry) => countryVenueVariant(entry.iso3));
  assert.equal(variants.filter((variant) => variant !== 'generic').length, 8);
  assert.equal(variants.every((variant) => COUNTRY_VENUE_VARIANTS.includes(variant)), true);
  for (const iso3 of catalog.map((entry) => entry.iso3)) assert.equal(getWorldDefinition(`country:${iso3}`).kind, 'country');
  // The tables are frozen: an attempt to reshape a venue at runtime throws instead of succeeding.
  assert.throws(() => { COUNTRY_VENUE_ASSIGNMENT.NPL = 'reef'; }, TypeError);
  assert.throws(() => { COUNTRY_VENUE_VARIANTS.push('invented'); }, TypeError);
});

test('every assigned venue keeps the shared contract: 40 × 28, a clear plaza band and a valid stand for all 248 entries', () => {
  const band = plazaTiles();
  for (const iso3 of assignedIso3) {
    const id = `country:${iso3}`, definition = getWorldDefinition(id), variant = COUNTRY_VENUE_ASSIGNMENT[iso3];
    assert.equal(definition.kind, 'country');
    assert.equal(definition.columns, COUNTRY_COLUMNS);
    assert.equal(definition.rows, COUNTRY_ROWS);
    assert.equal(definition.variant, variant, `${id} exposes its resolved variant`);
    assert.equal(walkable(definition.start, definition), true, `${id} arrives on a walkable tile`);
    assert.equal(solidSceneryAt(definition.start, definition.objects), false, `${id} arrives clear of solid scenery`);
    // Every plaza tile stays walkable, free of mass scenery and a plaza or garden surface, so any of
    // the 256 tiles can hold an ambassador stand.
    for (const tile of band) {
      assert.equal(walkable(tile, definition), true, `${id} plaza ${tile.x},${tile.y} must stay walkable`);
      assert.equal(solidSceneryAt(tile, definition.objects), false, `${id} plaza ${tile.x},${tile.y} must stay clear of solid scenery`);
      assert.ok(['plaza', 'garden'].includes(terrainAt(tile, definition)), `${id} plaza ${tile.x},${tile.y} terrain is a walkable surface`);
    }
    // Every authored object uses a sealed scenery type, and none stands on the plaza.
    for (const object of definition.objects) {
      assert.ok(Object.hasOwn(SCENERY_CLASSES, object.type), `${id} places the unclassified type ${object.type}`);
      assert.equal(sceneryClass(object.type), SCENERY_CLASSES[object.type]);
      if (sceneryBlocks(object.type)) assert.equal(solidSceneryAt(object, definition.objects), true);
    }
    assert.ok(definition.objects.length > 0 && definition.objects.length < 260, `${id} stays inside the renderer's 260-object bound`);
    // The assigned stand and all 248 catalog stands resolve: the band is one clear walkable piece.
    const stand = standFor(iso3);
    assert.equal(walkable(stand, definition), true, `${iso3} stand ${stand.x},${stand.y} must be walkable`);
    assert.equal(solidSceneryAt(stand, definition.objects), false, `${iso3} stand must be clear of solid scenery`);
    for (const entry of catalog) {
      const tile = standFor(entry.iso3);
      assert.equal(walkable(tile, definition), true, `${entry.iso3} stand in ${id} must be walkable`);
      assert.equal(solidSceneryAt(tile, definition.objects), false, `${entry.iso3} stand in ${id} must be clear`);
    }
    // Text mode has a named landmark and a named return portal for every venue.
    assert.ok(definition.landmarks.length >= 1);
    for (const place of definition.landmarks) assert.ok(typeof place.name === 'string' && place.name.length > 0);
    const returns = definition.portals.filter((p) => p.targetWorldId === 'commons');
    assert.equal(returns.length, 1);
    assert.equal(returns[0].name, 'Return to the Commons');
    assert.match(definition.description, /a NemoWorld research venue for one country or area/);
    assert.equal(definition.portals.some((p) => String(p.name).match(/\bUN\b|government|embassy/i)), false);
  }
});

test('each variant stays navigable: one cardinal walk from the arrival reaches the plaza, the landmark and every portal', () => {
  for (const iso3 of assignedIso3) {
    const id = `country:${iso3}`, definition = getWorldDefinition(id), reachable = reachableFromArrival(definition);
    const reached = (tile) => reachable.has(`${tile.x},${tile.y}`);
    for (const tile of plazaTiles()) assert.equal(reached(tile), true, `${id} plaza ${tile.x},${tile.y} must be reachable from the arrival`);
    for (const place of definition.landmarks) {
      assert.equal(walkable(place, definition), true, `${id} landmark ${place.name} must be walkable`);
      assert.equal(solidSceneryAt(place, definition.objects), false, `${id} landmark ${place.name} must be clear`);
      assert.equal(reached(place), true, `${id} landmark ${place.name} must be reachable from the arrival`);
      assert.ok(planWalk(definition, definition.start, place), `${id} keeps a planned route to ${place.name}`);
    }
    for (const portal of definition.portals) {
      assert.equal(walkable(portal, definition), true, `${id} portal ${portal.name} must be walkable`);
      assert.equal(reached(portal), true, `${id} portal ${portal.name} must be reachable`);
      assert.ok(planWalk(definition, definition.start, portal), `${id} keeps a planned route to ${portal.name}`);
    }
    // A walk-through (flat or frame) object must sit on or beside reachable ground: a variant can
    // never wall a resident away from a decoration the server lets it stand among.
    for (const object of definition.objects) {
      if (sceneryBlocks(object.type)) continue;
      const open = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reached({ x: object.x + dx, y: object.y + dy }));
      assert.equal(open, true, `${id} decorative ${object.type} at ${object.x},${object.y} must be reachable`);
    }
    // The venue is one connected walkable piece: no walkable tile is stranded from the arrival.
    let walkableTiles = 0;
    for (let y = 0; y < definition.rows; y++) for (let x = 0; x < definition.columns; x++) if (walkable({ x, y }, definition)) walkableTiles++;
    assert.equal(reachable.size, walkableTiles, `${id} has exactly one connected walkable component`);
  }
});

test('the eight venues are distinct from each other and from the generic shape, which the other 240 entries keep', () => {
  const signatures = new Map(assignedIso3.map((iso3) => [COUNTRY_VENUE_ASSIGNMENT[iso3], variantShape(iso3)]));
  assert.equal(new Set(signatures.values()).size, 8, 'the eight variants have eight distinct layouts');
  const generic = variantShape(unassignedIso3[0]);
  assert.equal(signatures.has('generic'), false);
  for (const [variant, signature] of signatures) assert.notEqual(signature, generic, `${variant} must differ from the generic shape`);
  // The same variant renders the same shape for two different entries; a variant is a shared shape.
  const sameVariant = catalog.filter((entry) => countryVenueVariant(entry.iso3) === 'terraces');
  assert.equal(sameVariant.length, 1, 'each reviewed variant is assigned to one reviewed entry in this first set');
  // The 240 unassigned entries keep the generic shape and the generic landmark naming.
  assert.equal(unassignedIso3.length, 240);
  for (const iso3 of unassignedIso3.slice(0, 12)) {
    const definition = getWorldDefinition(`country:${iso3}`);
    assert.equal(definition.variant, 'generic');
    assert.equal(definition.landmarks.length, 1);
    assert.match(definition.landmarks[0].name, /research desk$/);
  }
});

test('the selector is deterministic across separate processes: two runs render identical venues', () => {
  const script = `import { getWorldDefinition } from ${JSON.stringify(pathToFileURL(join(fileURLToPath(new URL('..', import.meta.url)), 'world.js')).href)};
    const ids = ${JSON.stringify(assignedIds)};
    console.log(JSON.stringify(ids.map((id) => { const d = getWorldDefinition(id);
      return [d.id, d.name, d.variant, d.groundColor, d.terrain, d.objects, d.landmarks, d.portals, d.start]; })));`;
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  const first = run(), second = run();
  assert.equal(first, second, 'two processes resolve the eight venues identically');
  // A non-empty result proves the venues resolved rather than every run printing the same failure.
  const parsed = JSON.parse(first);
  assert.equal(parsed.length, 8);
  assert.deepEqual(parsed.map((venue) => venue[2]), assignedIso3.map((iso3) => COUNTRY_VENUE_ASSIGNMENT[iso3]));
});

test('every scenery type a variant places is sealed and the renderer draws the class the shared table declares', () => {
  assert.ok(variantSceneryTypes.size >= 10, 'the variants use a spread of scenery classes');
  for (const type of variantSceneryTypes) {
    const kind = SCENERY_CLASSES[type];
    assert.ok(['mass', 'flat', 'frame'].includes(kind), `${type} must be sealed with a class, not defaulted`);
    const boxes = renderedBoxes(meadow([{ type, x: 4, y: 4 }]), (pick) => pick?.type === 'object' && (pick.object?.type || pick.object?.kind) === type);
    assert.ok(boxes.length, `${type} must be drawn by the renderer`);
    if (kind === 'mass') {
      assert.ok(boxes.some((box) => standingOverlap(box, column(4, 4), Infinity)), `${type} must occupy its own tile`);
      for (const { dx, dy, tile } of neighbourhood(4, 4)) if (dx || dy) assert.equal(boxes.some((box) => standingOverlap(box, tile)), false, `${type} must not reach into the resident at ${4 + dx},${4 + dy}`);
    } else if (kind === 'flat') {
      for (const box of boxes) {
        assert.ok(box.minX >= 4 - 1e-6 && box.maxX <= 5 + 1e-6 && box.minZ >= 4 - 1e-6 && box.maxZ <= 5 + 1e-6, `${type} must stay inside its own tile`);
        assert.ok(box.maxY <= KNEE_HEIGHT + 1e-9, `${type} is ground detail no higher than ${KNEE_HEIGHT}`);
      }
    } else {
      for (const { dx, dy, tile } of neighbourhood(4, 4)) assert.equal(boxes.some((box) => standingOverlap(box, tile)), false, `${type} is a walk-through frame beside the resident at ${4 + dx},${4 + dy}`);
    }
  }
  // Server and renderer agree in the venue itself: a solid type is refused by walkable(), while a
  // flat or frame type stays walkable and is drawn beside the resident's standing column.
  for (const type of variantSceneryTypes) {
    const definition = meadow([{ type, x: 4, y: 4 }]);
    assert.equal(sceneryBlocks(type), walkable({ x: 4, y: 4 }, definition) === false, `${type} resolves the same occupancy in server and renderer`);
  }
  // Rendering each venue is deterministic: two builds produce identical instance counts.
  for (const id of assignedIds) {
    const definition = getWorldDefinition(id);
    const scene = createVoxelScene();
    const first = scene.update(definition, {}, { position: { x: 20, y: 14 } });
    const second = scene.update({ ...definition }, {}, { position: { x: 20, y: 14 } });
    scene.destroy();
    assert.deepEqual(second.cubes, first.cubes, `${id} draws the same cubes on a rebuild`);
    assert.equal(first.cubes > 0, true, `${id} draws geometry`);
  }
});

test('a country venue registers no land: the finite frontier, sectors, parcels and blocks are unchanged', async (t) => {
  const f = await fixture(t);
  const count = (sql) => f.platform.get(sql).n;
  const before = {
    frontier: count("SELECT COUNT(*) AS n FROM worlds WHERE kind='frontier'"),
    sectors: count('SELECT COUNT(*) AS n FROM frontier_sectors'),
    parcels: count('SELECT COUNT(*) AS n FROM land_parcels'),
    blocks: count('SELECT COUNT(*) AS n FROM frontier_blocks'),
    countryRows: count("SELECT COUNT(*) AS n FROM worlds WHERE kind='country'"),
  };
  assert.equal(before.countryRows, 248, 'one seeded venue row per catalog entry');
  assert.equal(before.parcels, 16384, 'the registry starts at its full 16,384 gross slots');
  // Resolving and entering every venue must not create a sector, parcel, block or stewardship row.
  for (const iso3 of catalog.map((entry) => entry.iso3)) {
    const definition = getWorldDefinition(`country:${iso3}`);
    assert.equal(definition.kind, 'country');
    assert.equal(definition.columns, COUNTRY_COLUMNS);
  }
  const stand = f.platform.get('SELECT x,y FROM npc_ambassadors WHERE id=?', 'amb-NPL');
  const venue = f.platform.world(null, { world_id: 'country:NPL', x: Math.max(0, Math.min(20, stand.x - 10)), y: Math.max(0, Math.min(14, stand.y - 7)) });
  assert.equal(venue.landmarks.some((place) => place.name === 'The Shared Grove'), true, 'the text view lists the variant landmark');
  assert.deepEqual(venue.terrain.length, 14);
  assert.equal(venue.terrain.every((row) => row.length === 20), true);
  assert.equal(count("SELECT COUNT(*) AS n FROM worlds WHERE kind='frontier'"), before.frontier);
  assert.equal(count('SELECT COUNT(*) AS n FROM frontier_sectors'), before.sectors);
  assert.equal(count('SELECT COUNT(*) AS n FROM land_parcels'), before.parcels);
  assert.equal(count('SELECT COUNT(*) AS n FROM frontier_blocks'), before.blocks);
  assert.equal(count("SELECT COUNT(*) AS n FROM land_parcels WHERE world_id LIKE 'country:%'"), 0, 'no venue registers a parcel');
  assert.equal(count('SELECT COUNT(*) AS n FROM land_stewardships'), 0, 'no venue registers a stewardship');
  const countryWorldIds = new Set(f.platform.all("SELECT id FROM worlds WHERE kind='country'").map((row) => row.id));
  assert.ok(before.sectors >= 1, 'the seed frontier area is open');
  assert.equal(f.platform.all('SELECT world_id FROM frontier_sectors').some((row) => countryWorldIds.has(row.world_id)), false, 'no venue owns a frontier sector');
  assert.equal(f.platform.all('SELECT world_id FROM frontier_blocks').some((row) => countryWorldIds.has(row.world_id)), false, 'no venue owns a frontier block');
  // The bounded shared world list still excludes country venues, so 248 rows never bloat it.
  const listing = f.platform.worldList(f.actor('alice'), { limit: 50 });
  assert.equal(listing.worlds.some((world) => world.kind === 'country'), false);
});
