// Walking across a seam of the global map on a real platform: no portal, one authoritative write per step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { fromGlobal, toGlobal } from '../src/global-map.js';

const place = (f, agent, world, x, y) => f.platform.run("UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0 WHERE id=?", world, x, y, agent.id);
const stored = (f, agent) => ({ ...f.platform.get('SELECT world_id,x,y,z FROM agents WHERE id=?', agent.id) });
const step = (f, name, agent, direction) => { f.advance(200); return f.tx('moveAgent', f.actor(name), { agent_id: agent.id, direction }); };

test('a resident walks from the Commons into Highlands and back with no portal and one write per step', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  place(f, agent, 'commons', 25, 1);
  const before = f.platform.all("SELECT event FROM audit WHERE event='world.entered'").length;
  const north = step(f, 'alice', agent, 'up');
  assert.equal(north.blocked, false); assert.equal(north.world_id, 'commons'); assert.equal(north.y, 0);
  const across = step(f, 'alice', agent, 'up');
  assert.deepEqual({ blocked: across.blocked, seam: across.seam, world_id: across.world_id, from: across.from_world_id, x: across.x, y: across.y }, { blocked: false, seam: true, world_id: 'district:highlands', from: 'commons', x: 25, y: 35 });
  assert.deepEqual(stored(f, agent), { world_id: 'district:highlands', x: 25, y: 35, z: 0 });
  assert.equal(f.platform.all("SELECT event FROM audit WHERE event='world.entered'").length, before + 1, 'crossing counts as entering the world');
  assert.deepEqual(toGlobal('district:highlands', 25, 35), { gx: 121, gy: 71 });
  const inside = step(f, 'alice', agent, 'up');
  assert.deepEqual({ world_id: inside.world_id, y: inside.y, seam: inside.seam }, { world_id: 'district:highlands', y: 34, seam: undefined });
  step(f, 'alice', agent, 'down');
  const back = step(f, 'alice', agent, 'down');
  assert.deepEqual({ world_id: back.world_id, x: back.x, y: back.y, seam: back.seam }, { world_id: 'commons', x: 25, y: 0, seam: true });
  assert.deepEqual(fromGlobal(121, 72), { world_id: 'commons', x: 25, y: 0 });
});

test('a step into a tile the neighbour refuses, a throttled step and a paused resident all stay put', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  // Wetlands (0, 5) is the west end of the map and faces the sea: nothing is there to land on.
  place(f, agent, 'district:wetlands', 0, 5);
  const sea = step(f, 'alice', agent, 'left');
  assert.equal(sea.blocked, true);
  assert.deepEqual(stored(f, agent), { world_id: 'district:wetlands', x: 0, y: 5, z: 0 });
  // The south-east corner of the map is open water too: Harbor's south edge has a district below it, but no road.
  place(f, agent, 'district:savanna', 47, 35);
  assert.equal(step(f, 'alice', agent, 'down').blocked, true, 'the south edge of the map has no world below it');
  // A water tile across a seam refuses exactly as a water tile inside the world does.
  place(f, agent, 'commons', 95, 40);
  const water = step(f, 'alice', agent, 'right');
  assert.equal(water.blocked, true, 'the Harbor edge is water and refuses the step');
  assert.deepEqual(stored(f, agent), { world_id: 'commons', x: 95, y: 40, z: 0 });
  // The 120 ms throttle covers a crossing.
  place(f, agent, 'commons', 25, 0);
  f.platform.run('UPDATE agents SET last_move=? WHERE id=?', f.clock(), agent.id);
  assert.throws(() => f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction: 'up' }), /Move more slowly/);
  assert.deepEqual(stored(f, agent), { world_id: 'commons', x: 25, y: 0, z: 0 });
  // A paused resident is refused before any projection happens.
  f.platform.run("UPDATE agents SET status='paused' WHERE id=?", agent.id);
  f.advance(500);
  assert.throws(() => f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction: 'up' }), /paused/);
  assert.deepEqual(stored(f, agent), { world_id: 'commons', x: 25, y: 0, z: 0 });
});

test('a world that is not on the map keeps its walls: an interior edge never leads anywhere', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  place(f, agent, 'hall', 1, 5);
  const wall = step(f, 'alice', agent, 'left');
  assert.equal(wall.blocked, true);
  assert.deepEqual(stored(f, agent), { world_id: 'hall', x: 1, y: 5, z: 0 });
});

test('the seam is a door that is switched off when the map is', async (t) => {
  const previous = process.env.GLOBAL_MAP; process.env.GLOBAL_MAP = 'off';
  t.after(() => { if (previous === undefined) delete process.env.GLOBAL_MAP; else process.env.GLOBAL_MAP = previous; });
  const f = await fixture(t), agent = f.agent('alice');
  place(f, agent, 'commons', 25, 0);
  const refused = step(f, 'alice', agent, 'up');
  assert.equal(refused.blocked, true);
  assert.equal(f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: agent.id, map: 'core' }).map, undefined);
});

test('the map window carries both sides of a seam, each in its own world, and nothing private', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  place(f, alice, 'commons', 25, 2);
  place(f, bob, 'district:highlands', 26, 33);
  const plain = f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: alice.id });
  assert.equal(plain.map, undefined, 'a request without map= is the payload it always was');
  const view = f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: alice.id, map: 'core' });
  assert.equal(view.world.id, 'commons');
  assert.equal(view.participants.some((item) => item.id === bob.id), false, 'the stored world lists only its own residents');
  const seen = view.map.participants.find((item) => item.id === bob.id);
  assert.ok(seen, 'the resident across the seam is in the map window');
  assert.deepEqual({ world_id: seen.world_id, x: seen.x, y: seen.y }, { world_id: 'district:highlands', x: 26, y: 33 });
  assert.deepEqual(view.map.worlds.map((item) => item.world_id), ['district:highlands']);
  assert.ok(view.map.participants.length <= 200);
  // A resident far from every seam reads an empty neighbourhood.
  place(f, bob, 'commons', 48, 30);
  const far = f.platform.world(f.actor('bob'), { world_id: 'commons', agent_id: bob.id, map: 'core' });
  assert.deepEqual(far.map.worlds, []);
  // A garden or cottage is never part of the window.
  const home = f.platform.all("SELECT id FROM worlds WHERE kind='home' LIMIT 1")[0];
  const text = JSON.stringify(view.map);
  if (home) assert.equal(text.includes(home.id), false);
  // The map window is only for worlds on the map.
  assert.equal(f.platform.world(f.actor('alice'), { world_id: 'hall', map: 'core' }).map, undefined);
});

test('a nearby message crosses a seam, and the neighbour can read it', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  place(f, alice, 'commons', 25, 0);
  place(f, bob, 'district:highlands', 25, 34);
  f.advance(3000);
  const sent = f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'nearby', text: 'Can you hear me across the border?' });
  const row = f.platform.get('SELECT recipients FROM messages WHERE id=?', sent.id);
  assert.ok(JSON.parse(row.recipients).includes(bob.id), 'a resident two tiles away across the seam is a recipient');
  const read = f.platform.world(f.actor('bob'), { world_id: 'district:highlands', agent_id: bob.id });
  assert.ok(read.messages.some((item) => item.id === sent.id), 'and reads it from their own world');
  place(f, bob, 'district:highlands', 25, 20);
  f.advance(3000);
  const far = f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'nearby', text: 'And now?' });
  assert.equal(JSON.parse(f.platform.get('SELECT recipients FROM messages WHERE id=?', far.id).recipients).includes(bob.id), false);
});

test('a presence delta near a seam reaches subscribers of the world across it, and only those', async () => {
  const { createEventHub } = await import('../server.js');
  const account = { id: 'account-1' }, actor = { account, kind: 'session', credential: { hash: 'a'.repeat(64) } };
  const hub = createEventHub({ platform: { authorize: () => actor, canReadWorld: () => true } });
  const open = (worldId) => { const chunks = []; const response = { writeHead() {}, write(chunk) { chunks.push(chunk); return true; }, end() {}, on() {} };
    assert.equal(hub.subscribe({ actor, worldId, request: {}, response }).ok, true); return chunks; };
  const highlands = open('district:highlands'), snowline = open('district:snowline'), hall = open('hall');
  const delta = { agents: [{ id: 'walker', x: 25, y: 1, world_id: 'commons' }] };
  assert.equal(hub.publishNear('commons', 25, 1, delta), 1, 'only the Highlands subscriber is within sight of that tile');
  assert.equal(hub.publishNear('commons', 60, 30, delta), 0, 'far from every seam nobody across it is told');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(highlands.some((chunk) => String(chunk).includes('"walker"')));
  assert.equal(snowline.some((chunk) => String(chunk).includes('"walker"')), false);
  assert.equal(hall.some((chunk) => String(chunk).includes('"walker"')), false);
  hub.closeAll?.();
});

test('phase 2: a resident walks north from Highlands into Foothills and round a four-way corner, never leaving the map by a portal', async (t) => {
  const f = await fixture(t), agent = f.agent('alice');
  // Highlands -> Foothills along the avenue at global x 120 (Highlands local 24).
  place(f, agent, 'district:highlands', 24, 1);
  assert.equal(step(f, 'alice', agent, 'up').y, 0);
  const north = step(f, 'alice', agent, 'up');
  assert.deepEqual({ world_id: north.world_id, x: north.x, y: north.y, seam: north.seam, from: north.from_world_id }, { world_id: 'district:foothills', x: 24, y: 35, seam: true, from: 'district:highlands' });
  // The four-way corner at global (144, 36): Foothills, Grasslands, Highlands and Snowline meet there. Walk round it.
  place(f, agent, 'district:highlands', 47, 0);
  const up = step(f, 'alice', agent, 'up');
  assert.deepEqual({ world_id: up.world_id, x: up.x, y: up.y, seam: up.seam }, { world_id: 'district:foothills', x: 47, y: 35, seam: true });
  const right = step(f, 'alice', agent, 'right');
  assert.deepEqual({ world_id: right.world_id, x: right.x, y: right.y, seam: right.seam }, { world_id: 'district:grasslands', x: 0, y: 35, seam: true });
  const down = step(f, 'alice', agent, 'down');
  assert.deepEqual({ world_id: down.world_id, x: down.x, y: down.y, seam: down.seam }, { world_id: 'district:snowline', x: 0, y: 0, seam: true });
  const left = step(f, 'alice', agent, 'left');
  assert.deepEqual({ world_id: left.world_id, x: left.x, y: left.y, seam: left.seam }, { world_id: 'district:highlands', x: 47, y: 0, seam: true }, 'round the corner and back to the tile it started on');
  assert.equal(f.platform.all("SELECT 1 FROM audit WHERE event='world.entered'").length >= 5, true);
});

test('the map window at a four-way corner reads every world there, each in its own coordinates', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), others = ['bob', 'reviewer', 'moderator'].map((name) => f.agent(name));
  place(f, alice, 'district:highlands', 47, 0);
  const spots = [['district:foothills', 46, 34], ['district:grasslands', 2, 33], ['district:snowline', 1, 2]];
  others.forEach((agent, index) => place(f, agent, ...spots[index]));
  const view = f.platform.world(f.actor('alice'), { world_id: 'district:highlands', agent_id: alice.id, map: 'core' });
  assert.deepEqual(view.map.worlds.map((item) => item.world_id).sort(), ['district:foothills', 'district:grasslands', 'district:snowline']);
  for (const [index, agent] of others.entries()) {
    const seen = view.map.participants.find((item) => item.id === agent.id);
    assert.ok(seen, `${spots[index][0]} resident is in the window`);
    assert.deepEqual([seen.world_id, seen.x, seen.y], spots[index]);
  }
});

test('private gardens and cottages are never on the map: no step leaves one, and no window ever carries one', async (t) => {
  const f = await fixture(t), agent = f.agent('alice'), guest = f.agent('bob');
  for (const world of [`home:${agent.id}`, `house:${agent.id}`]) {
    const definition = (await import('../world.js')).getWorldDefinition(world);
    place(f, agent, world, 0, 5);
    for (const direction of ['left', 'up']) {
      place(f, agent, world, direction === 'left' ? 0 : 5, direction === 'left' ? 5 : 0);
      const edge = step(f, 'alice', agent, direction);
      assert.equal(edge.blocked, true, `${world}: the ${direction} edge is a wall, not a seam`);
      assert.equal(stored(f, agent).world_id, world);
    }
    assert.ok(definition.columns > 0);
    assert.equal(f.platform.world(f.actor('alice'), { world_id: world, agent_id: agent.id, map: 'core' }).map, undefined, `${world} has no map window`);
  }
  // A resident standing in a cottage is on no tile of the map, so no window near any seam carries them.
  place(f, agent, `house:${agent.id}`, 5, 5);
  place(f, guest, 'commons', 25, 1);
  const view = f.platform.world(f.actor('bob'), { world_id: 'commons', agent_id: guest.id, map: 'core' });
  const text = JSON.stringify(view.map);
  assert.equal(text.includes(agent.id), false);
  assert.equal(text.includes('house:'), false); assert.equal(text.includes('home:'), false);
  assert.equal(view.map.worlds.every((item) => !/^(home|house):/.test(item.world_id)), true);
});
