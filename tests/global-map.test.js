// The global map layout, its projection and the seam pass, with no database and no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldDefinition, landmarkAt, walkable, sharedWorldIds } from '../world.js';
import { JOURNEY_LEG_STEPS, JOURNEY_MAX_STEPS, planJourney, planWalk } from '../src/world-walk.js';
import { sceneryBlocks } from '../src/footprints.js';
import {
  AVENUES, MAP_BOUNDS, MAP_COLUMNS, MAP_ID, MAP_LAYOUT, MAP_ROWS, SEAM_CLEAR_DEPTH, fromGlobal, mapDistance, mapEnabled, neighbourStep, nearbyWorlds, onMap, seams, toGlobal, worldRects,
} from '../src/global-map.js';

const stitched = () => getWorldDefinition(MAP_ID);

test('every rectangle matches its world, stays on the map and overlaps no other', () => {
  for (const item of MAP_LAYOUT) {
    const definition = getWorldDefinition(item.world);
    assert.deepEqual([definition.columns, definition.rows], [item.width, item.height], `${item.world} is drawn at the size the layout reserves`);
    assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.width <= MAP_COLUMNS && item.y + item.height <= MAP_ROWS, `${item.world} is inside the map`);
  }
  for (const a of MAP_LAYOUT) for (const b of MAP_LAYOUT) {
    if (a === b) continue;
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    assert.ok(apart, `${a.world} and ${b.world} do not overlap`);
  }
  assert.deepEqual(MAP_BOUNDS, { x: 0, y: 0, width: 288, height: 208 }, 'the second ring fills the 288 x 208 map');
  assert.equal(MAP_LAYOUT.length, 23);
});

test('the projection round-trips every tile of every placed world and refuses everything else', () => {
  for (const item of MAP_LAYOUT) {
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) {
      const global = toGlobal(item.world, x, y);
      assert.deepEqual(fromGlobal(global.gx, global.gy), { world_id: item.world, x, y });
    }
  }
  for (const id of ['hall', 'library', 'observatory', 'country:NPL', 'frontier:0:0', 'home:abc', 'house:abc', 'whale-city', 'terrace-of-venues']) {
    assert.equal(onMap(id), false, `${id} is not a rectangle of the map`);
    assert.equal(toGlobal(id, 1, 1), null);
  }
  assert.equal(toGlobal('commons', 1.5, 2), null);
  assert.equal(fromGlobal(0, 0), null, 'the sea belongs to no world');
  assert.equal(fromGlobal(MAP_COLUMNS, 40), null);
});

test('a step that leaves a world lands on the neighbour tile, and a step that stays inside lands nowhere', () => {
  assert.deepEqual(neighbourStep('commons', 25, 0, 'up'), { world_id: 'district:highlands', x: 25, y: 35 });
  assert.deepEqual(neighbourStep('district:highlands', 25, 35, 'down'), { world_id: 'commons', x: 25, y: 0 });
  assert.deepEqual(neighbourStep('commons', 73, 63, 'down'), { world_id: 'district:harbor', x: 25, y: 0 });
  assert.deepEqual(neighbourStep('commons', 0, 20, 'left'), { world_id: 'district:woodlands', x: 47, y: 20 });
  assert.deepEqual(neighbourStep('commons', 95, 50, 'right'), { world_id: 'harbor', x: 0, y: 14 });
  assert.equal(neighbourStep('commons', 25, 1, 'up'), null, 'one tile inside the edge stays inside');
  assert.deepEqual(neighbourStep('district:highlands', 0, 2, 'left'), { world_id: 'district:rainforest', x: 47, y: 2 });
  assert.deepEqual(neighbourStep('district:highlands', 24, 0, 'up'), { world_id: 'district:foothills', x: 24, y: 35 });
  assert.equal(neighbourStep('district:wetlands', 0, 2, 'left'), null, 'the sea beyond the west end of the map has no world');
  assert.equal(neighbourStep('district:savanna', 5, 35, 'down'), null, 'nor has the sea below the south row');
  assert.equal(neighbourStep('hall', 0, 5, 'left'), null, 'an interior is not on the map');
  assert.equal(neighbourStep('commons', 5, 5, 'sideways'), null);
});

test('distance, windows and nearby worlds read through the projection', () => {
  assert.equal(mapDistance({ world_id: 'commons', x: 25, y: 0 }, { world_id: 'district:highlands', x: 25, y: 35 }), 1);
  assert.equal(mapDistance({ world_id: 'commons', x: 25, y: 0 }, { world_id: 'hall', x: 1, y: 1 }), null);
  const straddle = worldRects(110, 66, 20, 14).map((item) => item.world_id).sort();
  assert.deepEqual(straddle, ['commons', 'district:highlands']);
  assert.deepEqual(nearbyWorlds('commons', 25, 2), ['district:highlands']);
  assert.deepEqual(nearbyWorlds('commons', 48, 30), []);
  assert.deepEqual(nearbyWorlds('hall', 2, 2), []);
});

test('every outdoor shared world has a place on the map, and the sea around it belongs to nobody', () => {
  const placed = new Set(MAP_LAYOUT.map((item) => item.world));
  const outdoors = sharedWorldIds.filter((id) => id === 'commons' || id === 'orchard' || id === 'harbor' || id.startsWith('district:'));
  assert.equal(outdoors.length, 23);
  assert.deepEqual([...placed].sort(), [...outdoors].sort());
  // Interiors and venues stay doors on the map, never rectangles of it.
  for (const id of sharedWorldIds.filter((entry) => !outdoors.includes(entry))) assert.equal(placed.has(id), false, `${id} is a door, not a rectangle`);
});

test('the layout has thirty-six seams and each avenue sits on a seam at a tile both worlds can walk', () => {
  const found = seams();
  assert.equal(found.length, 36);
  assert.equal(Object.keys(AVENUES).length, 34);
  // Only the two joins that run along open water have no road: Farmlands | Harbor and Harbor | the Commons district.
  assert.deepEqual(found.filter((item) => !AVENUES[`${item.a}|${item.b}`]).map((item) => `${item.a}|${item.b}`).sort(), ['district:farmlands|harbor', 'harbor|district:commons']);
  const keys = new Set(found.map((item) => `${item.a}|${item.b}`));
  for (const [key, centres] of Object.entries(AVENUES)) {
    assert.ok(keys.has(key), `${key} names a real seam`);
    const seam = found.find((item) => `${item.a}|${item.b}` === key);
    for (const centre of centres) {
      assert.ok(centre >= seam.from + 1 && centre < seam.to - 1, `${key}: avenue ${centre} is inside the shared stretch`);
      for (const lane of [-1, 0, 1]) {
        const k = centre + lane;
        const a = seam.axis === 'v' ? fromGlobal(seam.line - 1, k) : fromGlobal(k, seam.line - 1), b = seam.axis === 'v' ? fromGlobal(seam.line, k) : fromGlobal(k, seam.line);
        assert.equal(a.world_id, seam.a); assert.equal(b.world_id, seam.b);
        assert.equal(walkable(a, a.world_id), true, `${key}: ${JSON.stringify(a)} is walkable`);
        assert.equal(walkable(b, b.world_id), true, `${key}: ${JSON.stringify(b)} is walkable`);
      }
    }
  }
});

test('every avenue is a road on both sides of the join and runs into the road network of each world', () => {
  const roads = new Set(['path', 'plaza', 'bridge']);
  for (const seam of seams()) for (const centre of AVENUES[`${seam.a}|${seam.b}`] || []) {
    const a = seam.axis === 'v' ? fromGlobal(seam.line - 1, centre) : fromGlobal(centre, seam.line - 1), b = seam.axis === 'v' ? fromGlobal(seam.line, centre) : fromGlobal(centre, seam.line);
    for (const side of [a, b]) {
      const definition = getWorldDefinition(side.world_id), seen = new Set([`${side.x},${side.y}`]), queue = [side];
      assert.ok(roads.has(definition.terrain[side.y][side.x]), `${side.world_id} ${side.x},${side.y} is a road at the join`);
      for (let index = 0; index < queue.length; index++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = { x: queue[index].x + dx, y: queue[index].y + dy }, key = `${next.x},${next.y}`;
        if (!seen.has(key) && roads.has(definition.terrain[next.y]?.[next.x])) { seen.add(key); queue.push(next); }
      }
      assert.ok(seen.size >= 40, `${seam.a}|${seam.b}: the avenue meets only ${seen.size} road tiles of ${side.world_id}, not its road network`);
    }
  }
});

test('the open border opens every tree that has open ground on both sides, and the clear zone holds no fixture', () => {
  for (const seam of seams()) {
    for (let k = seam.from; k < seam.to; k++) {
      const a = seam.axis === 'v' ? fromGlobal(seam.line - 1, k) : fromGlobal(k, seam.line - 1), b = seam.axis === 'v' ? fromGlobal(seam.line, k) : fromGlobal(k, seam.line);
      const left = getWorldDefinition(a.world_id).terrain[a.y][a.x], right = getWorldDefinition(b.world_id).terrain[b.y][b.x];
      const open = (world, tile, type) => !['water', 'tree', 'building', 'fountain', 'wall'].includes(type) && walkable(tile, world);
      // A tree may stay facing open ground only when there is no open ground behind it to open it onto.
      const behind = (side, tree, toward) => { const definition = getWorldDefinition(side.world_id), x = side.x + toward[0], y = side.y + toward[1]; return open(side.world_id, { x, y }, definition.terrain[y]?.[x]); };
      const towardA = seam.axis === 'v' ? [-1, 0] : [0, -1], towardB = seam.axis === 'v' ? [1, 0] : [0, 1];
      if (open(a.world_id, a, left) && right === 'tree') assert.equal(behind(b, right, towardB), false, `${b.world_id} ${b.x},${b.y} is a tree facing open ground with open ground behind it`);
      if (open(b.world_id, b, right) && left === 'tree') assert.equal(behind(a, left, towardA), false, `${a.world_id} ${a.x},${a.y} is a tree facing open ground with open ground behind it`);
    }
  }
  // No portal, landmark, gateway or solid scenery stands within SEAM_CLEAR_DEPTH of any seam.
  for (const seam of seams()) for (const side of [seam.a, seam.b]) {
    const item = MAP_LAYOUT.find((entry) => entry.world === side), definition = getWorldDefinition(side);
    const depth = (tile) => { const g = toGlobal(side, tile.x, tile.y); return seam.axis === 'v' ? (g.gy >= seam.from && g.gy < seam.to ? Math.abs(g.gx - (side === seam.a ? seam.line - 1 : seam.line)) : Infinity)
      : (g.gx >= seam.from && g.gx < seam.to ? Math.abs(g.gy - (side === seam.a ? seam.line - 1 : seam.line)) : Infinity); };
    const fixtures = [...definition.portals, ...definition.landmarks, ...definition.objects.filter((object) => object.type === 'gateway')];
    for (const fixture of fixtures) assert.ok(depth(fixture) >= SEAM_CLEAR_DEPTH, `${side}: ${fixture.name || fixture.type} at ${fixture.x},${fixture.y} is inside a seam's clear zone`);
    for (const object of definition.objects) if (sceneryBlocks(object.type) && definition.terrain[object.y][object.x] !== 'tree') {
      assert.ok(depth(object) >= SEAM_CLEAR_DEPTH, `${side}: ${object.type} at ${object.x},${object.y} is solid scenery inside a seam's clear zone`);
    }
    assert.ok(item);
  }
});

test('the stitched map is the same occupancy as every world it joins, and one walkable piece', () => {
  const map = stitched();
  assert.equal(map.id, MAP_ID);
  assert.deepEqual([map.columns, map.rows], [MAP_COLUMNS, MAP_ROWS]);
  for (const item of MAP_LAYOUT) {
    const definition = getWorldDefinition(item.world);
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) {
      assert.equal(walkable({ x: item.x + x, y: item.y + y }, map), walkable({ x, y }, definition), `${item.world} ${x},${y} is walkable on the map exactly when it is in its own world`);
    }
  }
  assert.equal(walkable({ x: 0, y: 0 }, map), false, 'the sea is never walkable');
  // One flood fill from the Commons arrival reaches every walkable tile of every placed world.
  const reached = new Set([`${map.start.x},${map.start.y}`]), queue = [map.start];
  for (let index = 0; index < queue.length; index++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const next = { x: queue[index].x + dx, y: queue[index].y + dy }, key = `${next.x},${next.y}`;
    if (!reached.has(key) && walkable(next, map)) { reached.add(key); queue.push(next); }
  }
  for (const item of MAP_LAYOUT) {
    const definition = getWorldDefinition(item.world);
    let open = 0, seen = 0;
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) if (walkable({ x, y }, definition)) { open++; if (reached.has(`${item.x + x},${item.y + y}`)) seen++; }
    assert.equal(seen, open, `${item.world}: every walkable tile is reachable on foot from the Commons arrival`);
  }
});

test('every ground colour on the map belongs to the world that owns the tile', () => {
  const map = stitched();
  assert.equal(map.groundAt(...Object.values(toGlobal('district:snowline', 4, 4))), getWorldDefinition('district:snowline').groundColor);
  assert.equal(map.groundAt(0, 0), null);
});

test('the map is on unless it is switched off or the server runs in production', () => {
  assert.equal(mapEnabled({}), true);
  assert.equal(mapEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(mapEnabled({ NODE_ENV: 'production', GLOBAL_MAP: 'on' }), true);
  assert.equal(mapEnabled({ GLOBAL_MAP: 'off' }), false);
});

test('every avenue carries a signpost on each side that names the world it leads to', () => {
  let counted = 0;
  for (const seam of seams()) {
    if (!AVENUES[`${seam.a}|${seam.b}`]) continue;
    for (const [side, other] of [[seam.a, seam.b], [seam.b, seam.a]]) {
      const definition = getWorldDefinition(side), name = getWorldDefinition(other).name;
      const post = definition.landmarks.find((item) => item.signpost && item.name.startsWith('Road to ') && item.name.toLowerCase().includes(other === 'district:commons' ? 'commons district' : name.replace(/^The /, '').toLowerCase()));
      assert.ok(post, `${side} has a signpost to ${other}`);
      counted++;
      assert.equal(walkable(post, side), true, `${side}: the signpost tile is open ground`);
      assert.equal(['path', 'plaza', 'bridge'].includes(definition.terrain[post.y][post.x]), false, `${side}: the signpost stands beside the road, not on it`);
      assert.equal(landmarkAt(post, side)?.name, post.name);
    }
  }
  assert.equal(counted, 68, 'two signposts for each of the 34 avenues');
  // The signpost is a navigation marker: it stays out of the clear zone and never makes the world unreachable.
  assert.equal(stitched().landmarks.filter((item) => item.signpost).length, 68);
});

test('a journey crosses many worlds in one plan, in legs, where a single walk gives up', () => {
  const map = stitched();
  const from = toGlobal('district:wetlands', 10, 18), to = toGlobal('district:savanna', 40, 18);
  const start = { x: from.gx, y: from.gy }, target = { x: to.gx, y: to.gy };
  assert.equal(walkable(start, map) && walkable(target, map), true);
  assert.equal(planWalk(map, start, target), null, 'a single walk is limited to one viewport\'s worth of route');
  const journey = planJourney(map, start, target);
  assert.ok(journey, 'a journey from the far west end to the far south-east is planned');
  assert.ok(journey.route.length > 192 && journey.route.length <= JOURNEY_MAX_STEPS, `${journey.route.length} steps`);
  assert.ok(journey.legs.every((leg) => leg.length <= JOURNEY_LEG_STEPS) && journey.legs.flat().length === journey.route.length);
  // Replaying it tile by tile on the stitched map ends on the target, on walkable tiles only, through many worlds.
  const worlds = new Set(), at = { ...start };
  for (const direction of journey.route) {
    at.x += { left: -1, right: 1 }[direction] || 0; at.y += { up: -1, down: 1 }[direction] || 0;
    assert.equal(walkable(at, map), true);
    worlds.add(fromGlobal(at.x, at.y).world_id);
  }
  assert.deepEqual(at, target);
  assert.ok(worlds.size >= 6, `the route crosses ${worlds.size} worlds`);
  // The route is planned over open ground only: the sea has no route.
  assert.equal(planJourney(map, start, { x: 0, y: 0 }), null);
});

test('journey leg sizes must be positive integers', () => {
  const map = stitched(), start = map.start, target = { x: start.x + 1, y: start.y };
  for (const legSteps of [0, -1, .5, NaN, Infinity, '64', null]) {
    assert.equal(planJourney(map, start, target, { legSteps }), null, `${String(legSteps)} is refused before a route can loop or acquire empty legs`);
  }
  assert.deepEqual(planJourney(map, start, target, { legSteps: 1 }).legs, [['right']]);
});

test('every world of the map can be walked to from every other, over avenues only where a road is needed', () => {
  const map = stitched(), origin = toGlobal('commons', getWorldDefinition('commons').start.x, getWorldDefinition('commons').start.y);
  const start = { x: origin.gx, y: origin.gy };
  for (const item of MAP_LAYOUT) {
    const arrival = getWorldDefinition(item.world).start, there = toGlobal(item.world, arrival.x, arrival.y);
    const journey = planJourney(map, start, { x: there.gx, y: there.gy });
    assert.ok(journey, `the Commons arrival to the ${item.world} arrival is a journey`);
    assert.ok(journey.route.length <= JOURNEY_MAX_STEPS);
  }
});
