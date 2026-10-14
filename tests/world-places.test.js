// The five authored public places inside the existing world registry.
//
// Each place is a doorway on the Commons map with a court of its own behind it: an arrival path the
// map already draws, a walkable entrance, a stated purpose and scenery of its own. These tests hold
// the five to that contract from both sides of the wire — the world definition the client renders and
// the records the server enforces — and to the one thing a place may never do: register land. A venue
// is a fictional NemoWorld place, not a real-world institution, and every scenery type it places is
// an existing sealed, project-authored definition (no new asset, no third-party art).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from '../assets/vendor/three-voxel.js';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { getWorldDefinition, walkable, terrainAt, sharedWorldIds, publicVenueIds, PUBLIC_VENUE_PLANS, VENUE_COLUMNS, VENUE_ROWS } from '../world.js';
import { REGIONS } from '../src/civic.js';
import { SCENERY_CLASSES, sceneryClass, sceneryBlocks, solidSceneryAt, solidTileKeys, standableTile, RESIDENT_CLEARANCE, RESIDENT_HEIGHT, GROUND_DETAIL, KNEE_HEIGHT } from '../src/footprints.js';
import { planWalk } from '../src/world-walk.js';
import { voxelPlan } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';
import content from '../src/content.js';

const planOf = (id) => PUBLIC_VENUE_PLANS.find((plan) => plan.id === id);
const definitions = publicVenueIds.map((id) => getWorldDefinition(id));
const commons = getWorldDefinition('commons');

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

// The renderer is asserted against the same class rules the shared table declares, using the real
// instance matrices the GPU would receive (the approach of tests/render-obstacles.test.js).
const column = (x, y) => ({ minX: x + .5 - RESIDENT_CLEARANCE, maxX: x + .5 + RESIDENT_CLEARANCE, minY: y + .5 - RESIDENT_CLEARANCE, maxY: y + .5 + RESIDENT_CLEARANCE });
const drawnBoxes = (scene) => {
  const boxes = [], matrix = new THREE.Matrix4();
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix);
      const e = matrix.elements;
      boxes.push({ minX: e[12] - Math.abs(e[0]) / 2, maxX: e[12] + Math.abs(e[0]) / 2, minY: e[13] - Math.abs(e[5]) / 2,
        maxY: e[13] + Math.abs(e[5]) / 2, minZ: e[14] - Math.abs(e[10]) / 2, maxZ: e[14] + Math.abs(e[10]) / 2 });
    }
  }
  return boxes;
};
const overColumn = (box, tile) => box.minX < tile.maxX && box.maxX > tile.minX && box.minZ < tile.maxY && box.maxZ > tile.minY;
/** A box a standing resident would be inside: above the floor decal, below the head. */
const entersStanding = (box, tile) => overColumn(box, tile) && box.maxY > GROUND_DETAIL && box.minY < RESIDENT_HEIGHT;
/** A box that reaches into the resident's column between knee and head. */
const overKnee = (box, tile) => overColumn(box, tile) && box.maxY > KNEE_HEIGHT && box.minY < RESIDENT_HEIGHT;
const boxesAt = (boxes, x, y) => boxes.filter((box) => overColumn(box, column(x, y)));

const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const registryDigest = (platform) => digest({
  parcels: platform.all('SELECT * FROM land_parcels ORDER BY id'),
  sectors: platform.all('SELECT * FROM frontier_sectors ORDER BY world_id'),
  blocks: platform.all('SELECT * FROM frontier_blocks ORDER BY world_id,x,y,z'),
  stewardships: platform.all('SELECT * FROM land_stewardships ORDER BY plot_id'),
  events: platform.all('SELECT * FROM land_events ORDER BY id'),
});

test('the five places are authored data: frozen plans, one contract each, and a stated purpose', () => {
  assert.equal(Object.isFrozen(PUBLIC_VENUE_PLANS), true);
  assert.equal(Object.isFrozen(publicVenueIds), true);
  assert.deepEqual([...publicVenueIds], ['venue:workshop-annexe', 'venue:amphitheatre', 'venue:archive', 'venue:observatory-annexe', 'venue:seed-bank']);
  assert.equal(publicVenueIds.length, 5, 'the set is deliberately small');
  for (const plan of PUBLIC_VENUE_PLANS) {
    // Every level of the table is frozen: a plan cannot be reshaped at runtime.
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.paint) && Object.isFrozen(plan.objects) && Object.isFrozen(plan.places) && Object.isFrozen(plan.door), `${plan.id} must be frozen throughout`);
    assert.match(plan.id, /^venue:[a-z-]+$/, `${plan.id} is a venue id`);
    for (const field of ['name', 'purpose', 'description', 'lore', 'ambiance', 'symbol', 'color', 'groundColor']) assert.ok(typeof plan[field] === 'string' && plan[field].length > 0, `${plan.id} states ${field}`);
    assert.match(plan.description, /A fictional NemoWorld place/, `${plan.id} says plainly that the place is fictional`);
    assert.equal(/\b(government|ministry|embassy|consulate|university|united nations|institute|agency|association)\b/i.test(`${plan.name} ${plan.purpose} ${plan.description}`), false,
      'a place never presents itself as a real-world institution, body or service');
  }
  assert.throws(() => { PUBLIC_VENUE_PLANS[0].name = 'Something else'; }, TypeError);
  assert.throws(() => { PUBLIC_VENUE_PLANS[0].objects.push(['bench', 1, 1]); }, TypeError);
  assert.throws(() => { PUBLIC_VENUE_PLANS[0].door.x = 1; }, TypeError);
  assert.equal(new Set(PUBLIC_VENUE_PLANS.map((plan) => plan.name)).size, 5, 'five distinct names');
  assert.equal(new Set(PUBLIC_VENUE_PLANS.map((plan) => plan.purpose)).size, 5, 'five distinct purposes');
  assert.equal(new Set(PUBLIC_VENUE_PLANS.map((plan) => plan.groundColor)).size, 5, 'five distinct ground tones');
  for (const definition of definitions) {
    assert.equal(definition.kind, 'venue');
    assert.equal(definition.columns, VENUE_COLUMNS);
    assert.equal(definition.rows, VENUE_ROWS);
    assert.deepEqual(definition.start, { x: planOf(definition.id).entrance, y: VENUE_ROWS - 2 });
    assert.ok(definition.description && definition.lore && definition.ambiance);
    assert.equal(definition.portals.length, 1);
    assert.equal(definition.portals[0].name, 'Return to the Commons');
    assert.equal(definition.portals[0].targetWorldId, 'commons');
    assert.ok(definition.objects.length > 0 && definition.objects.length < 260, `${definition.id} stays inside the renderer's 260-object bound`);
    assert.ok(definition.landmarks.length >= 2, `${definition.id} names the places inside it`);
    // The name is not a name the world already uses.
    for (const id of [...sharedWorldIds, 'frontier:0:0', 'country:NPL']) assert.notEqual(getWorldDefinition(id).name, definition.name);
  }
});

test('each place is entered from the Commons by walking its own doorway, which the map already roads from the arrival', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const doors = PUBLIC_VENUE_PLANS.map((plan) => ({ id: plan.id, plan, door: { x: plan.door.x, y: plan.door.y } }));
  assert.equal(new Set(doors.map(({ door }) => `${door.x},${door.y}`)).size, 5, 'five distinct doorways');
  for (const { id, plan, door } of doors) {
    // One doorway, one landmark, one gateway marker and one doorway route on the Commons map.
    const portals = commons.portals.filter((portal) => portal.targetWorldId === id);
    assert.equal(portals.length, 1, `${id} keeps exactly one Commons doorway`);
    assert.deepEqual({ x: portals[0].x, y: portals[0].y }, door);
    assert.equal(portals[0].name, plan.name);
    assert.equal(commons.landmarks.filter((place) => place.x === door.x && place.y === door.y && place.name === plan.name).length, 1, `${id} is named on the Commons map`);
    assert.equal(commons.objects.filter((object) => object.type === 'gateway' && object.x === door.x && object.y === door.y).length, 1, `${id} draws a doorway marker`);
    assert.equal(walkable(door, commons), true, `${id} doorway is walkable`);
    assert.equal(solidSceneryAt(door, commons.objects), false, `${id} doorway is clear of solid scenery`);
    // The arrival path is authored: a planned cardinal route from the shared arrival to the doorway,
    // over tiles that are walkable and free of solid scenery.
    const route = planWalk(commons, commons.start, door);
    assert.ok(route && route.length > 1, `${id} has a route from the Commons arrival to its doorway`);
    let position = { ...commons.start };
    for (const direction of route) {
      position = { x: position.x + { up: 0, down: 0, left: -1, right: 1 }[direction], y: position.y + { up: -1, down: 1, left: 0, right: 0 }[direction] };
      assert.equal(walkable(position, commons), true, `${id} route tile ${position.x},${position.y} stays walkable`);
      assert.equal(solidSceneryAt(position, commons.objects), false, `${id} route tile ${position.x},${position.y} stays clear`);
    }
    assert.deepEqual(position, door, `${id} route ends on the doorway`);
    // The resident arrives on the Commons and is refused until it stands at that doorway.
    f.advance(); f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", commons.start.x, commons.start.y, alice.id);
    assert.throws(() => f.tx('travel', f.actor('alice'), alice.id, { world_id: id }), { status: 409 });
    assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');
    f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', door.x, door.y, alice.id);
    f.advance();
    const entered = f.tx('travel', f.actor('alice'), alice.id, { world_id: id });
    assert.equal(entered.entered, true);
    const definition = getWorldDefinition(id);
    assert.deepEqual({ x: entered.x, y: entered.y }, definition.start, `${id} arrives at its own entrance tile`);
    assert.equal(walkable(entered, definition), true);
    assert.equal(solidSceneryAt(entered, definition.objects), false);
    assert.equal(entered.grounded, true);
    const stored = f.platform.get('SELECT world_id,x,y,grounded FROM agents WHERE id=?', alice.id);
    assert.deepEqual({ ...stored }, { world_id: id, x: definition.start.x, y: definition.start.y, grounded: 1 });
    assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_visits WHERE agent_id=? AND world_id=?', alice.id, id).n, 1, `${id} records the visit`);
    // Walking back out returns the resident to the same Commons doorway tile.
    f.advance();
    const returned = f.tx('travel', f.actor('alice'), alice.id, { world_id: 'commons' });
    assert.deepEqual({ x: returned.x, y: returned.y }, door, `${id} returns through its own doorway`);
  }
  assert.equal(f.platform.verifyAudit(), true);
});

test('the doorway read names the place and offers the one action that enters it', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const plan = PUBLIC_VENUE_PLANS[1], door = { x: plan.door.x, y: plan.door.y };
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", door.x, door.y, alice.id);
  const read = f.platform.interactionView(f.actor('alice'), { agent_id: alice.id, world_id: 'commons', x: door.x, y: door.y });
  assert.equal(read.fixture.kind, 'door', 'the doorway is a door fixture');
  assert.equal(read.fixture.name, plan.name, 'the read names the place behind the doorway');
  assert.equal(read.fixture.target_world_id, plan.id, 'the read names the world the door opens into');
  assert.equal(read.fixture.action.id, 'travel');
  assert.equal(read.fixture.action.label, `Enter ${plan.name}`);
  assert.equal(read.fixture.in_range, true, 'the resident standing on the doorway may act');
  assert.equal(read.fixture.can_act, true);
  assert.match(read.fixture.hint, /Manhattan distance 1/);
  assert.match(read.fixture.hint, new RegExp(plan.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Pressing the door is the same one write the world already performs for a doorway.
  f.advance();
  const used = f.tx('interact', f.actor('alice'), { agent_id: alice.id, x: door.x, y: door.y, action: 'travel' }, 'place-doorway');
  assert.equal(used.interaction.kind, 'door');
  assert.equal(used.interaction.name, plan.name);
  assert.equal(used.result.entered, true);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, plan.id);
  // The same door from a street across the Commons is refused with the next usable step, not entered.
  f.advance();
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", commons.start.x, commons.start.y, alice.id);
  assert.throws(() => f.tx('interact', f.actor('alice'), { agent_id: alice.id, x: door.x, y: door.y, action: 'travel' }, 'place-doorway-away'),
    (error) => error.status === 409 && typeof error.next_step === 'string' && error.next_step.length > 0);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');
  assert.equal(f.platform.verifyAudit(), true);
});

test('each place is one connected court behind a walkable wall opening, and every place and doorway inside it is routable', () => {
  for (const definition of definitions) {
    const plan = planOf(definition.id), reachable = reachableFromArrival(definition);
    assert.equal(walkable(definition.start, definition), true, `${definition.id} arrives on a walkable tile`);
    assert.equal(solidSceneryAt(definition.start, definition.objects), false, `${definition.id} arrives clear of solid scenery`);
    // The entrance is an opening in the enclosure, not a wall painted over: for a walled court the
    // wall row is a door surface at the entrance column and wall everywhere else, and an open court
    // paves the same tile so the entrance is drawn either way.
    const opening = { x: plan.entrance, y: VENUE_ROWS - 1 };
    assert.equal(walkable(opening, definition), true, `${definition.id} keeps a walkable entrance`);
    assert.equal(terrainAt(opening, definition), plan.walls ? 'path' : 'plaza', `${definition.id} draws its entrance as a door surface`);
    if (plan.walls) {
      let walls = 0;
      for (let x = 0; x < VENUE_COLUMNS; x++) if (terrainAt({ x, y: VENUE_ROWS - 1 }, definition) === 'wall') walls++;
      assert.equal(walls, VENUE_COLUMNS - 1, `${definition.id} has exactly one opening in its south wall`);
    }
    // One connected walkable court: no walkable tile is stranded from the arrival.
    let walkableTiles = 0;
    for (let y = 0; y < definition.rows; y++) for (let x = 0; x < definition.columns; x++) if (walkable({ x, y }, definition)) walkableTiles++;
    assert.equal(reachable.size, walkableTiles, `${definition.id} is one connected walkable court (${walkableTiles} tiles)`);
    assert.ok(walkableTiles > definition.columns, `${definition.id} leaves ground to walk on`);
    // Every named place and the way back out is walkable, clear, reachable and routable.
    for (const place of definition.landmarks) {
      assert.equal(walkable(place, definition), true, `${definition.id} place ${place.name} is walkable`);
      assert.equal(solidSceneryAt(place, definition.objects), false, `${definition.id} place ${place.name} is clear`);
      assert.equal(reachable.has(`${place.x},${place.y}`), true, `${definition.id} place ${place.name} is reachable from the arrival`);
      assert.ok(planWalk(definition, definition.start, place), `${definition.id} keeps a planned route to ${place.name}`);
      assert.ok(place.description.length > 0 && place.symbol.length > 0);
    }
    for (const portal of definition.portals) {
      assert.equal(walkable(portal, definition), true);
      assert.equal(solidSceneryAt(portal, definition.objects), false);
      assert.equal(reachable.has(`${portal.x},${portal.y}`), true);
      assert.ok(planWalk(definition, definition.start, portal));
    }
    // Scenery may not stand on the arrival, a named place or the doorway.
    const reserved = new Set([`${definition.start.x},${definition.start.y}`, ...definition.landmarks.map((place) => `${place.x},${place.y}`), ...definition.portals.map((portal) => `${portal.x},${portal.y}`)]);
    for (const object of definition.objects) {
      assert.equal(reserved.has(`${object.x},${object.y}`), false, `${definition.id} keeps ${object.type} off ${object.x},${object.y}`);
      assert.equal(sceneryBlocks(object.type), solidSceneryAt(object, definition.objects), `${definition.id} agrees with the shared table on ${object.type}`);
      if (sceneryBlocks(object.type)) continue;
      // A walk-through decoration sits on or beside reachable ground.
      const open = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reachable.has(`${object.x + dx},${object.y + dy}`));
      assert.equal(open, true, `${definition.id} decoration ${object.type} at ${object.x},${object.y} is reachable`);
    }
  }
});

test('the server and the renderer agree on every tile each place draws', () => {
  for (const definition of definitions) {
    // The court centre, so the 37 x 37 render window holds the whole place and every tile is read.
    const centre = { x: Math.floor(VENUE_COLUMNS / 2), y: Math.floor(VENUE_ROWS / 2) };
    const plan = voxelPlan(definition, {}, centre);
    const scene = createVoxelScene();
    const first = scene.update(definition, {}, { position: centre });
    const boxes = drawnBoxes(scene), solids = solidTileKeys(plan.objects);
    const second = scene.update({ ...definition }, {}, { position: centre });
    assert.deepEqual(second.cubes, first.cubes, `${definition.id} draws the same cubes on a rebuild`);
    assert.ok(first.cubes > 0, `${definition.id} draws geometry`);
    assert.equal(plan.cells.length, VENUE_COLUMNS * VENUE_ROWS, `${definition.id} renders every tile of its court`);
    let walkableTiles = 0, refusedTiles = 0;
    for (const cell of plan.cells) {
      const { x, y, type } = cell, key = `${x},${y}`, tile = column(x, y), columns = boxesAt(boxes, x, y);
      const stand = standableTile({ x, y }, definition.terrain, plan.objects) && !solids.has(key);
      assert.equal(walkable({ x, y }, definition), stand, `${definition.id} ${key}: the plan's objects and the definition's objects agree`);
      if (stand) {
        walkableTiles++;
        const blocked = columns.filter((box) => overKnee(box, tile));
        assert.equal(blocked.length, 0, `${definition.id} ${key} is walkable, so nothing may stand in its column above ${KNEE_HEIGHT} m`);
        continue;
      }
      refusedTiles++;
      assert.equal(columns.some((box) => entersStanding(box, tile)), true, `${definition.id} ${key} (${type}) is refused, so it must be drawn as an obstacle`);
    }
    assert.ok(walkableTiles > 40 && refusedTiles >= 5, `${definition.id} exercises both directions (${walkableTiles} walkable, ${refusedTiles} refused)`);
    // Each scenery type resolves the same occupancy in the server predicates and in the drawn world.
    for (const type of new Set(definition.objects.map((object) => object.type))) {
      assert.ok(Object.hasOwn(SCENERY_CLASSES, type), `${definition.id} places the unclassified type ${type}`);
      assert.equal(sceneryClass(type), SCENERY_CLASSES[type]);
      const object = definition.objects.find((item) => item.type === type);
      assert.equal(sceneryBlocks(type), walkable(object, definition) === false, `${definition.id} ${type} resolves the same occupancy in server and renderer`);
    }
    scene.destroy();
  }
});

test('every asset a place draws is an existing sealed, project-authored definition', () => {
  const placed = new Set(definitions.flatMap((definition) => definition.objects.map((object) => object.type)));
  assert.ok(placed.size >= 10, `the five places reuse a spread of the sealed vocabulary (${placed.size} types)`);
  for (const type of placed) {
    const entry = content.entry(type, 'furniture');
    assert.ok(entry, `${type} is a sealed furniture definition`);
    assert.equal(entry.license.spdx, 'LicenseRef-NemoWorld-Project-Authored', `${type} is project-authored work`);
    assert.equal(entry.license.notice_file, 'content/THIRD_PARTY.md');
    assert.equal(entry.license.commit, null);
    assert.deepEqual(content.assets(type, 'furniture'), [], `${type} bundles no third-party asset file`);
  }
  // The sealed layer is unchanged by these places: the counts are the sealed ones, and no entry was
  // added for a place.
  const manifest = content.manifest();
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(manifest.kinds, { appearance: 20, block: 9, cosmetic: 32, crop: 6, furniture: 31 });
  const sealed = execFileSync(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'seal-content.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(sealed, /98/);
});

test('the five places are distinct from each other and from every authored world', () => {
  const signature = (definition) => JSON.stringify([definition.terrain, definition.objects, definition.landmarks, definition.groundColor, definition.start]);
  const signatures = definitions.map(signature);
  assert.equal(new Set(signatures).size, 5, 'five distinct layouts');
  const authored = [...sharedWorldIds, 'country:NPL', 'frontier:0:0', 'home:sample', 'house:sample', ...REGIONS.map((region) => `district:${region.id}`)];
  const authoredSignatures = new Set(authored.map((id) => signature(getWorldDefinition(id))));
  for (const definition of definitions) assert.equal(authoredSignatures.has(signature(definition)), false, `${definition.id} is not a copy of a shared world`);
  // Each place uses its own mix of scenery: no two places place the same set of types.
  const vocabularies = definitions.map((definition) => [...new Set(definition.objects.map((object) => object.type))].sort().join(','));
  assert.equal(new Set(vocabularies).size, 5, 'five distinct scenery vocabularies');
  // Two processes resolve the same five courts, so the client and the server cannot drift.
  const script = `import { getWorldDefinition, publicVenueIds } from ${JSON.stringify(pathToFileURL(join(fileURLToPath(new URL('..', import.meta.url)), 'world.js')).href)};
    console.log(JSON.stringify(publicVenueIds.map((id) => { const d = getWorldDefinition(id);
      return [d.id, d.name, d.kind, d.groundColor, d.terrain, d.objects, d.landmarks, d.portals, d.start]; })));`;
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  const first = run(), second = run();
  assert.equal(first, second, 'two processes resolve the five places identically');
  const parsed = JSON.parse(first);
  assert.equal(parsed.length, 5);
  assert.deepEqual(parsed.map((venue) => venue[0]), [...publicVenueIds]);
  assert.equal(parsed.every((venue) => venue[2] === 'venue' && venue[7].length === 1), true);
});

test('a place registers no land: the finite inventory is byte-for-byte unchanged', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const count = (sql) => f.platform.get(sql).n;
  const before = {
    parcels: count('SELECT COUNT(*) AS n FROM land_parcels'),
    stewardships: count('SELECT COUNT(*) AS n FROM land_stewardships'),
    events: count('SELECT COUNT(*) AS n FROM land_events'),
    sectors: count('SELECT COUNT(*) AS n FROM frontier_sectors'),
    blocks: count('SELECT COUNT(*) AS n FROM frontier_blocks'),
    frontierWorlds: count("SELECT COUNT(*) AS n FROM worlds WHERE kind='frontier'"),
    venueRows: count("SELECT COUNT(*) AS n FROM worlds WHERE kind='venue'"),
    digest: registryDigest(f.platform),
  };
  assert.equal(before.parcels, 16384, 'the registry starts at its full 16,384 gross slots');
  assert.equal(before.venueRows, 5, 'one public venue row per place, and no more');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM worlds WHERE kind='venue' AND owner_agent_id IS NOT NULL").n, 0, 'a place is owned by no resident');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM worlds WHERE kind='venue' AND visibility!='public'").n, 0, 'a place is public');
  const land = f.platform.land(null, { world_id: 'frontier:0:0' }).counts;
  // Resolving and entering every place must create no sector, parcel, block, stewardship or event.
  for (const definition of definitions) {
    assert.equal(getWorldDefinition(definition.id).kind, 'venue');
    const door = planOf(definition.id).door;
    f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", door.x, door.y, alice.id);
    f.advance();
    assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: definition.id }).entered, true);
    const view = f.platform.world(f.actor('alice'), { agent_id: alice.id });
    assert.equal(view.world.id, definition.id);
    assert.equal(view.world.kind, 'venue');
    assert.equal(view.landmarks.some((place) => place.name === definition.landmarks[0].name), true, 'the world read lists the place by name');
    assert.equal(view.objects.length, 0, 'no resident object has been written into a place');
  }
  const after = {
    parcels: count('SELECT COUNT(*) AS n FROM land_parcels'),
    stewardships: count('SELECT COUNT(*) AS n FROM land_stewardships'),
    events: count('SELECT COUNT(*) AS n FROM land_events'),
    sectors: count('SELECT COUNT(*) AS n FROM frontier_sectors'),
    blocks: count('SELECT COUNT(*) AS n FROM frontier_blocks'),
    frontierWorlds: count("SELECT COUNT(*) AS n FROM worlds WHERE kind='frontier'"),
    venueRows: count("SELECT COUNT(*) AS n FROM worlds WHERE kind='venue'"),
    digest: registryDigest(f.platform),
  };
  assert.deepEqual(after, before, 'the finite land registry is byte-for-byte unchanged');
  assert.deepEqual(f.platform.land(null, { world_id: 'frontier:0:0' }).counts, land, 'the parcelled inventory is unchanged');
  assert.equal(count("SELECT COUNT(*) AS n FROM land_parcels WHERE world_id LIKE 'venue:%'"), 0, 'no place registers a parcel');
  assert.equal(count('SELECT COUNT(*) AS n FROM land_stewardships'), 0, 'no place registers a stewardship');
  const venueWorldIds = new Set(f.platform.all("SELECT id FROM worlds WHERE kind='venue'").map((row) => row.id));
  assert.equal(f.platform.all('SELECT world_id FROM frontier_sectors').some((row) => venueWorldIds.has(row.world_id)), false, 'no place owns a frontier area');
  assert.equal(f.platform.all('SELECT world_id FROM frontier_blocks').some((row) => venueWorldIds.has(row.world_id)), false, 'no place owns a frontier block');
  assert.equal(f.platform.all('SELECT world_id FROM land_parcels').some((row) => venueWorldIds.has(row.world_id)), false, 'no place owns a parcelled address');
  assert.equal(f.platform.verifyAudit(), true);
});

test('the shared directory keeps its thirty authored worlds, and a place stays a public read with a public row', async (t) => {
  const f = await fixture(t);
  const listing = f.platform.worldList(null, { limit: 50 });
  assert.equal(listing.shared_count, 30, 'the five places never inflate the authored shared directory');
  assert.equal(listing.worlds.length, 30);
  assert.equal(listing.worlds.some((world) => world.kind === 'venue'), false);
  for (const definition of definitions) {
    const world = f.platform.world(null, { world_id: definition.id });
    assert.equal(world.world.id, definition.id);
    assert.equal(world.world.visibility, 'public');
    assert.equal(world.world.owner_agent_id, null);
    assert.equal(world.world.columns, VENUE_COLUMNS);
    assert.equal(world.world.rows, VENUE_ROWS);
    const published = world.scenery.filter((item) => item.blocks === true);
    assert.ok(published.length > 0, 'the world read publishes the place\'s solid scenery');
    for (const item of published) assert.equal(walkable({ x: item.x, y: item.y }, definition), false, 'published solid scenery matches walkable()');
    assert.equal(world.portals.some((portal) => portal.target_world_id === 'commons'), true, 'the way back out is published');
  }
  // The Commons publishes all five doorways as portals and names all five on the map.
  const view = f.platform.world(null, { world_id: 'commons' });
  const doors = view.portals.filter((portal) => publicVenueIds.includes(portal.target_world_id));
  assert.deepEqual(doors.map((portal) => portal.target_world_id).sort(), [...publicVenueIds].sort());
  for (const portal of doors) assert.equal(view.landmarks.some((place) => place.x === portal.x && place.y === portal.y && place.name === portal.label), true);
  // A restart seeds the same five rows and nothing else.
  f.platform.close();
  const restarted = new Platform(f.database, () => f.clock());
  t.after(() => restarted.close());
  assert.equal(restarted.get("SELECT COUNT(*) AS n FROM worlds WHERE kind='venue'").n, 5);
  assert.equal(restarted.worldList(null, { limit: 50 }).shared_count, 30);
});
