// Server-side coherence: a real first-person route through the Commons and a frontier area, walked
// one authoritative grid step at a time, with the camera asserted against the stored elevation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldDefinition, walkable, terrainAt } from '../world.js';
import { planWalk } from '../src/world-walk.js';
import { blockLayers, canStep } from '../src/elevation.js';
import { firstPersonCamera } from '../src/voxel-geometry.js';
import { solidSceneryAt, solidTileKeys } from '../src/footprints.js';
import { fixture } from './helpers.js';

const EYE = 1.35;
/** The camera the application builds: the resident's own cell centre plus the eye offset. */
const cameraFor = (position) => firstPersonCamera(position, { yaw: 0, pitch: 0 });
const assertCameraAtResident = (position) => {
  const { eye } = cameraFor(position);
  assert.deepEqual(eye, { x: position.x + .5, y: position.z + EYE, z: position.y + .5 }, `the camera must sit at ${position.x},${position.y} layer ${position.z}`);
};
const key = (position) => `${position.x},${position.y}`;

async function walkRoute(f, alice, agent, definition, route) {
  const visited = [];
  for (const direction of route) {
    f.advance(200);
    const step = f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction });
    assert.equal(step.blocked, false, `the planned step ${direction} must be walked`);
    assertCameraAtResident(step);
    visited.push({ x: step.x, y: step.y, z: step.z });
  }
  return visited;
}

test('a resident walks a planned first-person route through the Commons to the frontier gateway, camera at every stored layer', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const commons = getWorldDefinition('commons'), start = { x: 10, y: 6 }, gateway = { x: 19, y: 6 };
  const route = planWalk(commons, start, gateway);
  assert.ok(route && route.length > 4, 'the Commons publishes a route to the frontier gateway');
  let position = start;
  for (const direction of route) {
    const next = { x: position.x + { up: 0, down: 0, left: -1, right: 1 }[direction], y: position.y + { up: -1, down: 1, left: 0, right: 0 }[direction] };
    assert.equal(walkable(next, commons), true, `every planned tile stays walkable: ${key(next)}`);
    assert.equal(solidSceneryAt(next, commons.objects), false, `no planned tile is solid scenery: ${key(next)}`);
    position = next;
  }
  assert.deepEqual(position, gateway, 'the route ends on the gateway tile');
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", start.x, start.y, alice.id);
  await walkRoute(f, 'alice', alice, commons, route);
  const arrived = f.platform.get('SELECT x,y,z FROM agents WHERE id=?', alice.id);
  assert.deepEqual({ ...arrived }, { ...gateway, z: 0 });
  assertCameraAtResident(arrived);
  // The Commons carries authored scenery on its own walkable terrain; the route above avoided it.
  const blockedByScenery = (commons.objects || []).filter((object) => sceneryObstacle(commons, object)).slice(0, 6);
  assert.ok(blockedByScenery.length, 'the Commons still places trees on open ground');
  for (const tree of blockedByScenery) assert.equal(key(tree) === key(gateway), false, 'the gateway tile itself stays clear');
});

function sceneryObstacle(definition, object) {
  return solidSceneryAt(object, definition.objects) && !['water', 'tree', 'building', 'fountain', 'wall'].includes(terrainAt(object, definition));
}

test('a frontier route keeps to the public passages, and the camera follows the resident into the next area', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const frontier = getWorldDefinition('frontier:0:0'), start = frontier.start;
  f.platform.run("UPDATE agents SET world_id='commons',x=19,y=6,z=0,grounded=1 WHERE id=?", alice.id);
  f.advance();
  const entered = f.tx('travel', f.actor('alice'), alice.id, { world_id: 'frontier:0:0' });
  assert.equal(entered.entered, true); assertCameraAtResident(entered);
  for (const gate of frontier.portals) {
    assert.equal(walkable(gate, frontier), true, 'a frontier passage stays walkable');
    assert.ok(planWalk(frontier, start, gate), `the crossed-in resident keeps a route to ${gate.name}`);
  }
  const gate = frontier.portals.find((portal) => portal.targetWorldId === 'commons');
  const route = planWalk(frontier, start, gate);
  const visited = await walkRoute(f, 'alice', alice, frontier, route);
  assert.deepEqual(visited.at(-1), { x: gate.x, y: gate.y, z: 0 });
  assert.equal(visited.every((tile) => walkable(tile, frontier) && !solidTileKeys(frontier.objects).has(key(tile))), true, 'every frontier step stayed on a clear passage tile');
  // Authored trees exist in this sector and are solid scenery, not passages.
  const trees = frontier.objects.filter((object) => object.type === 'tree');
  assert.ok(trees.length > 100, 'the sector is wooded');
  assert.equal(trees.every((tree) => !walkable(tree, frontier)), true, 'a resident can never be drawn inside a sector tree');
  // A one-layer step-up must not turn scenery into a ramp.
  const bench = { type: 'bench', x: start.x + 1, y: start.y };
  const climb = canStep(start, 'right', { walkable: () => true, definition: frontier, layers: blockLayers([]), objects: [bench], solidTiles: solidTileKeys([bench]) }, { allowAuthoredStepUp: true });
  assert.deepEqual({ blocked: climb.blocked, reason: climb.reason }, { blocked: true, reason: 'object' });
});

test('the server refuses a step into authored scenery and allows the decorative tiles the renderer keeps walkable', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const commons = getWorldDefinition('commons');
  const tree = (commons.objects || []).find((object) => object.type === 'tree' && walkable({ x: object.x - 1, y: object.y }, commons) && !solidSceneryAt({ x: object.x - 1, y: object.y }, commons.objects));
  assert.ok(tree, 'the Commons places a tree with a clear approach');
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", tree.x - 1, tree.y, alice.id);
  f.advance(200);
  const blocked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.equal(blocked.blocked, true, 'a resident cannot step into a tree');
  assert.deepEqual({ x: blocked.x, y: blocked.y }, { x: tree.x - 1, y: tree.y }, 'a blocked step keeps the resident where it was');
  const farm = (commons.objects || []).find((object) => object.type === 'farm' && walkable({ x: object.x - 1, y: object.y }, commons) && walkable(object, commons));
  assert.ok(farm, 'the Commons places a low crop patch on open ground');
  f.platform.run('UPDATE agents SET x=?,y=?,z=0,grounded=1 WHERE id=?', farm.x - 1, farm.y, alice.id);
  f.advance(200);
  const walked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.equal(walked.blocked, false, 'a resident still walks among crops');
  assert.deepEqual({ x: walked.x, y: walked.y }, { x: farm.x, y: farm.y });
  assertCameraAtResident(walked);
  // The world view publishes the same occupancy the server enforces, for the text fallback and clients.
  const view = f.platform.world(f.actor('alice'), { agent_id: alice.id, x: farm.x - 4, y: farm.y - 3 });
  assert.ok(Array.isArray(view.scenery), 'the world snapshot publishes authored scenery');
  const published = view.scenery.find((item) => item.x === farm.x && item.y === farm.y);
  assert.equal(published.blocks, false, 'decorative scenery is published as walkable');
  const solid = view.scenery.find((item) => item.blocks === true);
  assert.ok(solid, 'solid scenery is published as blocking');
  assert.equal(solidSceneryAt(solid, view.scenery), true);
  assert.equal(walkable({ x: solid.x, y: solid.y }, getWorldDefinition(view.world.id)), false, 'published blocking scenery matches walkable()');
});

test('invalid placements and true traps are refused, and a legacy object on the doorway never spawns a resident inside it', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const home = `home:${alice.id}`, definition = getWorldDefinition(home);
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: home });
  const build = (tile, type) => f.tx('build', f.actor('alice'), alice.id, { x: tile.x, y: tile.y, type });
  // The arrival and its neighbours stay clear.
  assert.throws(() => build({ x: definition.start.x, y: definition.start.y }, 'bench'), { status: 409 });
  assert.throws(() => build({ x: definition.start.x + 1, y: definition.start.y }, 'bench'), { status: 409 });
  // A resident may not be built over.
  const resident = { x: 10, y: 16 };
  f.platform.run('UPDATE agents SET x=?,y=?,z=0,grounded=1 WHERE id=?', resident.x, resident.y, alice.id);
  assert.throws(() => build(resident, 'tree'), { status: 409, message: /occupied resident tiles/ });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', home).n, 0);
  // Three solid objects leave one exit; the fourth would strand the resident, so it is refused.
  const ring = [{ x: resident.x, y: resident.y - 1 }, { x: resident.x, y: resident.y + 1 }, { x: resident.x - 1, y: resident.y }, { x: resident.x + 1, y: resident.y }];
  for (const tile of ring.slice(0, 3)) assert.equal(build(tile, 'bench').x, tile.x);
  assert.throws(() => build(ring[3], 'bench'), { status: 409, message: /no walkable route/ });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', home).n, 3);
  f.advance(200);
  const held = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' });
  assert.equal(held.blocked, true, 'the resident is held by the ring while a way out remains open');
  // Removing one object restores the route: the ring was never a permanent trap.
  assert.equal(f.tx('build', f.actor('alice'), alice.id, { x: ring[0].x, y: ring[0].y, remove: true }).removed, true);
  f.advance(200);
  assert.equal(f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' }).blocked, false);
  // A legacy object written straight into storage must not become the arrival tile.
  const saved = () => f.platform.all('SELECT x,y,type FROM world_objects WHERE world_id=?', home);
  f.platform.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?)', 'legacy-doorway', home, 'bench', definition.start.x, definition.start.y, new Date(f.clock()).toISOString());
  assert.equal(solidSceneryAt(definition.start, saved()), true, 'the legacy object now occupies the doorway tile');
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, { world_id: 'commons' });
  f.advance();
  const back = f.tx('travel', f.actor('alice'), alice.id, { world_id: home });
  assert.equal(solidSceneryAt(back, saved()), false, 'no resident is spawned inside scenery');
  assert.equal(walkable(back, definition), true);
  assert.deepEqual({ x: back.x, y: back.y }, { x: definition.start.x, y: definition.start.y - 1 }, 'the arrival falls back to the clear cardinal tile beside the blocked doorway');
  assertCameraAtResident(back);
});
