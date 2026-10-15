// Coherence across the map's seams, established against a real platform: walking, collisions,
// interaction distance and construction rights mean the same thing on both sides of a join.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { getWorldDefinition, walkable } from '../world.js';
import { MAP_LAYOUT, fromGlobal, neighbourStep, toGlobal } from '../src/global-map.js';
import { INTERACTION_DISTANCE } from '../src/camera-controls.js';

const place = (f, agent, world, x, y) => f.platform.run("UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0 WHERE id=?", world, x, y, agent.id);
const stored = (f, agent) => ({ ...f.platform.get('SELECT world_id,x,y,z,posture FROM agents WHERE id=?', agent.id) });
const step = (f, name, agent, direction) => { f.advance(200); return f.tx('moveAgent', f.actor(name), { agent_id: agent.id, direction }); };
const rectOf = (worldId) => MAP_LAYOUT.find((item) => item.world === worldId);

test('a seam crossing is a step, not a travel: one agent row, no new world, and one map on both sides', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  place(f, agent, 'commons', 25, 1);
  const worldsBefore = f.platform.all('SELECT id FROM worlds ORDER BY id').map((row) => row.id);
  const othersBefore = JSON.stringify(f.platform.all('SELECT id,world_id,x,y,z FROM agents WHERE id!=? ORDER BY id', agent.id));
  const objectsBefore = f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n;
  const sectorsBefore = f.platform.get('SELECT COUNT(*) AS n FROM frontier_sectors').n;

  step(f, 'alice', agent, 'up');                       // commons 25,1 -> 25,0: still inside the world
  const landed = step(f, 'alice', agent, 'up');        // the step that leaves the world
  assert.equal(landed.blocked, false);
  assert.equal(landed.seam, true);
  assert.equal(landed.world_id, 'district:highlands');
  assert.equal(landed.from_world_id, 'commons');
  // The stored tuple is a real tile of the neighbour: it projects back to itself, so the client can draw it.
  const projected = toGlobal(landed.world_id, landed.x, landed.y);
  assert.deepEqual(fromGlobal(projected.gx, projected.gy), { world_id: landed.world_id, x: landed.x, y: landed.y });
  assert.equal(walkable({ x: landed.x, y: landed.y }, getWorldDefinition(landed.world_id)), true, 'the resident stands on a walkable tile of the world it entered');

  assert.deepEqual(f.platform.all('SELECT id FROM worlds ORDER BY id').map((row) => row.id), worldsBefore, 'walking across a seam creates no world');
  assert.equal(JSON.stringify(f.platform.all('SELECT id,world_id,x,y,z FROM agents WHERE id!=? ORDER BY id', agent.id)), othersBefore, 'no other resident moves');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n, objectsBefore, 'no saved placement is touched');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_sectors').n, sectorsBefore, 'the finite land registry is untouched');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='world.entered'").n, 1, 'the crossing counts as entering the world exactly once');

  const start = stored(f, agent);
  assert.equal(start.world_id, 'district:highlands', 'the round trips start on the far side of the seam');
  for (let index = 0; index < 3; index++) {
    const back = step(f, 'alice', agent, 'down');
    assert.deepEqual({ seam: back.seam, world: back.world_id, x: back.x, y: back.y }, { seam: true, world: 'commons', x: 25, y: 0 });
    const again = step(f, 'alice', agent, 'up');
    assert.deepEqual({ world: again.world_id, x: again.x, y: again.y }, { world: 'district:highlands', x: 25, y: 35 });
  }
  assert.deepEqual(stored(f, agent), start, 'three round trips end on the exact stored tuple they started from');
  assert.deepEqual(f.platform.all('SELECT id FROM worlds ORDER BY id').map((row) => row.id), worldsBefore);
});

test('a blocked step across a seam changes nothing at all: the same rule, applied on the far side', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  place(f, agent, 'district:highlands', 0, 5);
  const before = stored(f, agent);
  assert.equal(step(f, 'alice', agent, 'left').blocked, true, 'a step off the map is refused');
  assert.deepEqual(stored(f, agent), before, 'a refused crossing leaves the stored tuple exactly as it was');

  // The Commons' east edge faces the Harbor district, and the tile across it is water.
  place(f, agent, 'commons', 95, 40);
  const water = neighbourStep('commons', 95, 40, 'right');
  assert.equal(water.world_id, 'harbor', 'the tile across the east edge belongs to the Harbor district');
  assert.equal(walkable({ x: water.x, y: water.y }, getWorldDefinition('harbor')), false, 'the landing tile really is water');
  const refused = stored(f, agent);
  assert.equal(step(f, 'alice', agent, 'right').blocked, true, 'water across a seam refuses exactly as water inside a world does');
  assert.deepEqual(stored(f, agent), refused);

  // A step is judged against terrain, scenery, saved objects and block columns — never against agents,
  // so a resident standing on the landing tile blocks nothing on either side of the seam.
  place(f, agent, 'commons', 25, 0);
  const other = f.agent('bob');
  place(f, other, 'district:highlands', 25, 35);
  const landing = neighbourStep('commons', 25, 0, 'up');
  assert.deepEqual(landing, { world_id: 'district:highlands', x: 25, y: 35 });
  assert.equal(walkable({ x: landing.x, y: landing.y }, getWorldDefinition(landing.world_id)), true, 'the landing tile is walkable');
  const through = step(f, 'alice', agent, 'up');
  assert.deepEqual({ blocked: through.blocked, seam: through.seam, world: through.world_id, x: through.x, y: through.y }, { blocked: false, seam: true, world: 'district:highlands', x: 25, y: 35 },
    'a resident on the landing tile does not block a step');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM agents WHERE world_id=? AND x=? AND y=?', 'district:highlands', 25, 35).n, 2, 'both residents now share the tile');
});

test('a saved object in the landing world is a collision at the seam exactly as it is inside the world', async (t) => {
  // The shipped guard (`world_objects_build_guard`) allows a saved placement only in a world of kind
  // 'home'/'house', so a map rectangle can hold one only in a disposable database. That is the point:
  // the collision rule consults the *landing world's* stored objects, from either side of the join.
  const f = await fixture(t), agent = f.agent('alice');
  const woodlands = rectOf('district:woodlands'), orchard = rectOf('orchard');
  const centre = 72;
  const from = { world: 'district:woodlands', x: centre - woodlands.x, y: woodlands.height - 1 };
  const landing = neighbourStep(from.world, from.x, from.y, 'down');
  assert.deepEqual(landing, { world_id: 'orchard', x: centre - orchard.x, y: 0 }, 'the avenue lands where the layout says');

  place(f, agent, from.world, from.x, from.y);
  assert.deepEqual({ blocked: step(f, 'alice', agent, 'down').blocked }, { blocked: false }, 'the crossing is open before anything is placed');

  place(f, agent, from.world, from.x, from.y);
  f.platform.run("UPDATE worlds SET kind='home' WHERE id='orchard'");
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES('seam-block','orchard','tree',?,?,?)", landing.x, landing.y, new Date(f.clock()).toISOString());
  const before = stored(f, agent);
  assert.equal(step(f, 'alice', agent, 'down').blocked, true, 'a solid saved object on the landing tile refuses the crossing');
  assert.deepEqual(stored(f, agent), before, 'and the refusal writes nothing');
  f.platform.run("DELETE FROM world_objects WHERE id='seam-block'");
  const reopened = step(f, 'alice', agent, 'down');
  assert.deepEqual({ blocked: reopened.blocked, world: reopened.world_id, x: reopened.x, y: reopened.y }, { blocked: false, world: 'orchard', x: landing.x, y: landing.y },
    'removing the object reopens the crossing, so it was the collision and not the seam');
});

test('interaction distance is never subtracted across regions: a neighbouring fixture is out of range until you are in its world', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const bench = { world_id: 'district:highlands', x: 25, y: 35 };
  assert.deepEqual(neighbourStep('commons', 25, 0, 'up'), bench, 'the fixture tile is one step away in world space');
  const definition = getWorldDefinition('district:highlands');
  const scenery = (definition.objects || []).find((item) => item.type === 'bench');
  assert.ok(scenery, 'the district carries an authored bench');
  place(f, alice, 'commons', 25, 0);
  // The server reads the fixture in the world the resident is *stored* in, so the neighbouring bench is
  // not offered and the decision never mixes the two regions.
  const read = f.platform.interactionView(f.actor('alice'), { agent_id: alice.id, world_id: 'district:highlands', x: scenery.x, y: scenery.y });
  assert.equal(read.viewer.world_id, 'commons');
  assert.equal(read.fixture.blocked_by, 'another_world', 'a fixture in another stored world is not in range, however close it is on the map');
  assert.equal(read.fixture.can_act, false);
  assert.equal(read.fixture.in_range, false, 'the range decision never spans two regions');
  assert.match(read.fixture.next_step, /Travel there, or bring/, 'the resident is told to enter the world first');
  assert.equal(read.required_distance, INTERACTION_DISTANCE);
  assert.ok(INTERACTION_DISTANCE >= 1 && INTERACTION_DISTANCE <= 2, `the requirement is the documented adjacency (${INTERACTION_DISTANCE})`);
  assert.equal(read.fixture.distance, null, 'a distance is reported only inside the same stored world');
  assert.match(read.fixture.hint, /resident is in another region/, 'the hint explains why no distance is offered');

  // Inside one world the same resident is judged by ordinary one-world Manhattan distance.
  place(f, alice, 'district:highlands', scenery.x, scenery.y);
  const near = f.platform.interactionView(f.actor('alice'), { agent_id: alice.id, world_id: 'district:highlands', x: scenery.x, y: scenery.y });
  assert.equal(near.fixture.distance, 0);
  assert.equal(near.fixture.in_range, true);
  const away = f.platform.interactionView(f.actor('alice'), { agent_id: alice.id, world_id: 'district:highlands', x: 24, y: 31 });
  assert.equal(away.fixture.distance, Math.abs(scenery.x - 24) + Math.abs(scenery.y - 31), 'inside one world the distance is plain Manhattan distance');
  // A resident in the far world is refused by the same rule, from the other side of the seam.
  place(f, alice, 'commons', 25, 0);
  const fromFarSide = f.platform.interact;
  assert.equal(typeof fromFarSide, 'function');
  assert.throws(() => f.platform.interact(f.actor('alice'), { agent_id: alice.id, x: scenery.x, y: scenery.y }, 'seam-key-1'),
    /no fixture a resident can use|is \d+ tiles away/, 'using the neighbouring fixture from this side is refused, not re-measured');
});

test('construction rights follow the stored plot, never the region a client claims', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const garden = `home:${alice.id}`;
  const definition = getWorldDefinition(garden);
  const tiles = [];
  for (let y = 2; y < definition.rows - 2 && tiles.length < 6; y++) for (let x = 2; x < definition.columns - 2 && tiles.length < 6; x++) {
    if (walkable({ x, y }, definition) && Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) > 1) tiles.push({ x, y });
  }
  assert.equal(tiles.length, 6, 'the garden fixture offers buildable tiles');
  // The operator builds in its own garden.
  f.tx('travel', f.actor('alice'), alice.id, { world_id: garden });
  const built = f.tx('build', f.actor('alice'), alice.id, { type: 'bench', x: tiles[0].x, y: tiles[0].y });
  assert.deepEqual({ world: built.world_id, x: built.x, y: built.y }, { world: garden, x: tiles[0].x, y: tiles[0].y });

  // The build method takes (actor, agent, input) and names no world: a client cannot claim a region.
  assert.equal(f.platform.build.length, 3, 'the build route has no world parameter for a client to set');
  place(f, alice, 'commons', 25, 0);
  step(f, 'alice', alice, 'up'); step(f, 'alice', alice, 'up');
  assert.equal(stored(f, alice).world_id, 'district:highlands', 'the resident really walked into the neighbouring region');
  assert.throws(() => f.tx('build', f.actor('alice'), alice.id, { type: 'bench', x: 4, y: 4 }), /Build inside your own garden or cottage/,
    'a region of the shared map is not a plot, whatever the client claims');

  // Another operator's garden is not this resident's plot either, even standing inside it.
  f.tx('travel', f.actor('bob'), bob.id, { world_id: `home:${bob.id}` });
  place(f, bob, garden, tiles[1].x, tiles[1].y);
  assert.throws(() => f.tx('build', f.actor('bob'), bob.id, { type: 'bench', x: tiles[2].x, y: tiles[2].y }), /Build inside your own garden or cottage/,
    'standing in someone else\'s garden grants nothing');

  // And the database refuses a placement anywhere that is not such a plot, even if a route were to try.
  assert.throws(() => f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES('x','district:highlands','bench',4,4,?)", new Date(f.clock()).toISOString()),
    /Garden objects must use the build palette/, 'the stored plot, not the region, decides where a placement may exist');

  // The garden the operator built in still holds exactly its own placement, in its own coordinates.
  assert.deepEqual(f.platform.all('SELECT world_id,x,y,type FROM world_objects WHERE world_id=?', garden).map((row) => ({ ...row })), [{ world_id: garden, x: tiles[0].x, y: tiles[0].y, type: 'bench' }]);
});

test('the viewport read reports the stored world a resident is in, whatever the client is drawing', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  place(f, alice, 'commons', 25, 0);
  place(f, bob, 'district:highlands', 25, 35);
  const at = toGlobal('commons', 25, 0);
  const observed = [];
  for (let index = 0; index < 4; index++) {
    const view = f.platform.mapViewport(f.actor('alice'), { gx: at.gx - 8, gy: at.gy - 8, columns: 16, rows: 16 });
    const seen = view.participants.find((item) => item.id === alice.id);
    const row = f.platform.get('SELECT world_id,x,y FROM agents WHERE id=?', alice.id);
    assert.deepEqual({ world: seen.world_id, x: seen.x, y: seen.y }, { world: row.world_id, x: row.x, y: row.y }, 'the viewport read reports the stored world and the stored local tile');
    observed.push(seen.world_id);
    step(f, 'alice', alice, 'up');
  }
  assert.deepEqual(observed, ['commons', 'district:highlands', 'district:highlands', 'district:highlands'], 'the world the payload names changes exactly when the stored world does');
  const final = f.platform.get('SELECT world_id,x,y FROM agents WHERE id=?', alice.id);
  assert.deepEqual({ world_id: final.world_id, x: final.x, y: final.y }, { world_id: 'district:highlands', x: 25, y: 32 }, 'the walker really crossed and kept walking');
  const view = f.platform.mapViewport(f.actor('alice'), { gx: at.gx - 8, gy: at.gy - 8, columns: 16, rows: 16 });
  const mixed = view.participants.filter((item) => [alice.id, bob.id].includes(item.id)).map((item) => `${item.id}:${item.world_id}`);
  assert.equal(mixed.length, 2, 'both residents are in one payload');
  assert.ok(mixed.every((entry) => entry.endsWith(':district:highlands')), 'and each is tagged with the world it is really stored in');
});
