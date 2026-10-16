// Direct world interaction over the shipped HTTP API.
//
// Every check below drives the real routes against a temporary database and then reads the server's
// own records, so what a resident can do by hand from the world view is proven at the level the server
// decides: the same authoritative action, the same distance rule a doorway already needs, and a
// refusal that always carries the next usable step. Nothing here asserts a cosmetic animation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

async function setup(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', account, token, input, key } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: {
        ...(input ? { 'Content-Type': 'application/json' } : {}),
        ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  // A fixture may place a resident on a tile the scenario needs; every action afterwards is real.
  const place = (agentId, x, y) => f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', x, y, agentId);
  return { ...f, request, place };
}

const auditCount = (f, event) => f.platform.get('SELECT COUNT(*) AS n FROM audit WHERE event=?', event).n;

test('a resident reads the fixture beside it and travels through the doorway with the world’s own action', async (t) => {
  const f = await setup(t), alice = f.agent('alice');

  const read = await f.request(`/interact?agent_id=${alice.id}&world_id=commons&x=11&y=6`, { account: 'alice' });
  assert.equal(read.status, 200);
  const fixtureRead = read.data.fixture;
  assert.equal(fixtureRead.kind, 'door');
  assert.equal(fixtureRead.label, 'Door');
  assert.equal(fixtureRead.action.id, 'travel');
  assert.equal(fixtureRead.action.route, 'POST /api/v1/agents/:id/travel');
  assert.equal(fixtureRead.can_act, true);
  assert.equal(fixtureRead.blocked_by, null);
  assert.equal(read.data.required_distance, 1);
  assert.equal(fixtureRead.distance, 1);
  // The hint names the fixture, the available interaction and the requirement, and the next step says
  // the action is available now.
  assert.match(fixtureRead.hint, /Door at 11, 6/);
  assert.match(fixtureRead.hint, /Enter/);
  assert.match(fixtureRead.hint, /Manhattan distance 1/);
  assert.match(fixtureRead.hint, /1 tile away, so you can use it now/);
  assert.match(fixtureRead.next_step, /Available now/);
  assert.equal(read.data.viewer.agent_id, alice.id);
  // Reading never writes.
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');

  const before = auditCount(f, 'world.entered');
  const travelled = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-door-1', input: { agent_id: alice.id, x: 11, y: 6, action: 'travel' } });
  assert.equal(travelled.status, 200);
  assert.equal(travelled.data.interaction.kind, 'door');
  assert.equal(travelled.data.interaction.action, 'travel');
  assert.equal(travelled.data.result.world_id, 'hall');
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'hall');
  assert.equal(auditCount(f, 'world.entered'), before + 1);

  // The same click, sent twice with one key, is one write.
  const repeated = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-door-1', input: { agent_id: alice.id, x: 11, y: 6, action: 'travel' } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.replay, true);
  assert.equal(repeated.data.result.world_id, 'hall');
  assert.equal(auditCount(f, 'world.entered'), before + 1, 'a repeated key must not enter the world again');
});

test('the distance requirement is stated and refused instead of widened', async (t) => {
  const f = await setup(t), alice = f.agent('alice');

  const read = await f.request(`/interact?agent_id=${alice.id}&world_id=commons&x=35&y=24`, { account: 'alice' });
  assert.equal(read.status, 200);
  assert.equal(read.data.fixture.kind, 'door');
  assert.equal(read.data.fixture.in_range, false);
  assert.equal(read.data.fixture.can_act, false);
  assert.equal(read.data.fixture.blocked_by, 'out_of_range');
  assert.match(read.data.fixture.hint, /Door at 35, 24/);
  assert.match(read.data.fixture.next_step, /Step onto or beside 35, 24/);

  const refused = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-far-door', input: { agent_id: alice.id, x: 35, y: 24 } });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /alice avatar is 43 tiles away/);
  assert.match(refused.data.hint, /43 tiles away/);
  assert.match(refused.data.next_step, /within 1 tile of it/);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');

  // One tile short of nothing: a tile with no fixture answers 404 and names the nearest real one.
  const empty = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-empty-tile', input: { agent_id: alice.id, x: 10, y: 6 } });
  assert.equal(empty.status, 404);
  assert.match(empty.data.error, /no fixture a resident can use at 10, 6/);
  assert.match(empty.data.next_step, /nearest fixture is the (door|bench|crop patch|crafting station|country ambassador desk) at \d+, \d+/);

  // A read of that tile reports the same absence with the same next step, and writes nothing.
  const emptyRead = await f.request(`/interact?agent_id=${alice.id}&world_id=commons&x=10&y=6`, { account: 'alice' });
  assert.equal(emptyRead.status, 200);
  assert.equal(emptyRead.data.fixture, null);
  assert.match(emptyRead.data.hint, /No door, crop patch, bench, crafting station or country ambassador desk stands at 10, 6/);
});

test('a crop patch in another resident’s garden is refused with the owner named', async (t) => {
  const f = await setup(t), alice = f.agent('alice'), bob = f.agent('bob');
  const garden = `home:${alice.id}`;
  // Alice prepares a real crop patch in her own garden through the shipped build action.
  assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: garden }).world_id, garden);
  f.tx('build', f.actor('alice'), alice.id, { type: 'farm', x: 8, y: 7 });
  assert.equal(f.platform.get("SELECT type FROM world_objects WHERE world_id=? AND x=8 AND y=7", garden).type, 'farm');

  // Bob visits the public garden and stands beside the patch.
  assert.equal(f.tx('travel', f.actor('bob'), bob.id, { world_id: garden }).world_id, garden);
  f.platform.run('UPDATE agents SET x=8,y=8 WHERE id=?', bob.id);
  const refused = await f.request('/interact', { method: 'POST', account: 'bob', key: 'interaction-foreign-crop', input: { agent_id: bob.id, x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'herbs' } });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /own garden/);
  assert.match(refused.data.next_step, /alice avatar’s garden/);
  assert.match(refused.data.hint, /Crop patch at 8, 7/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', bob.id).n, 0);

  // The owner, on the same tile, plants for real and the crop survives a re-read.
  f.platform.run('UPDATE agents SET x=8,y=8 WHERE id=?', alice.id);
  const planted = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-own-crop', input: { agent_id: alice.id, x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'herbs' } });
  assert.equal(planted.status, 200);
  assert.equal(planted.data.result.crop.kind, 'herbs');
  const stored = f.platform.get('SELECT kind,planted_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=8 AND y=7', alice.id);
  assert.equal(stored.kind, 'herbs');
  assert.equal(stored.harvested_at, null);
  // A second click cannot plant the same tile twice: the world refuses the growing tile and no row is
  // added, and the interface is told what to do with the crop instead.
  const again = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-own-crop-2', input: { agent_id: alice.id, x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'wood' } });
  assert.equal(again.status, 409);
  assert.match(again.data.next_step, /Tend or harvest the crop already planted/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', alice.id).n, 1);
  assert.equal(f.platform.get('SELECT kind FROM journey_crops WHERE agent_id=?', alice.id).kind, 'herbs');
});

test('a bench sits the resident with the existing posture action', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  // The Meeting Hall's benches and its arrival tile share one room; Alice stands beside a bench.
  assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: 'hall' }).world_id, 'hall');
  f.platform.run('UPDATE agents SET x=12,y=8 WHERE id=?', alice.id);

  const read = await f.request(`/interact?agent_id=${alice.id}&world_id=hall&x=12&y=7`, { account: 'alice' });
  assert.equal(read.status, 200);
  assert.equal(read.data.fixture.kind, 'bench');
  assert.equal(read.data.fixture.action.id, 'posture');
  assert.equal(read.data.fixture.action.route, 'POST /api/v1/agents/:id/posture');
  assert.match(read.data.fixture.hint, /Bench at 12, 7/);
  assert.match(read.data.fixture.hint, /Sit on the bench/);
  assert.equal(read.data.fixture.distance, 1);

  const sat = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-bench-1', input: { agent_id: alice.id, x: 12, y: 7, action: 'posture' } });
  assert.equal(sat.status, 200);
  assert.equal(sat.data.result.posture, 'sitting');
  assert.equal(f.platform.get('SELECT posture FROM agents WHERE id=?', alice.id).posture, 'sitting');

  // Sitting twice is one write: the repeated key returns the recorded outcome.
  const again = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-bench-1', input: { agent_id: alice.id, x: 12, y: 7, action: 'posture' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.replay, true);
  assert.equal(again.data.result.posture, 'sitting');

  // The same key for a different intent is a client mistake, not a second action.
  const mismatched = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-bench-1', input: { agent_id: alice.id, x: 12, y: 7, action: 'posture', posture: 'meditating' } });
  assert.equal(mismatched.status, 409);
  assert.match(mismatched.data.error, /different interaction/);
  assert.equal(f.platform.get('SELECT posture FROM agents WHERE id=?', alice.id).posture, 'sitting');
});

test('a crafting station gathers the ingredients first, then crafts through the existing recipe action', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  // Alice reaches the Makers' Workshop through its doorway in the Commons, then stands at a station.
  f.platform.run('UPDATE agents SET x=35,y=23 WHERE id=?', alice.id);
  const entered = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-workshop-door', input: { agent_id: alice.id, x: 35, y: 24, action: 'travel' } });
  assert.equal(entered.status, 200);
  assert.equal(entered.data.result.world_id, 'workshop');
  f.platform.run('UPDATE agents SET x=5,y=10 WHERE id=?', alice.id);

  const read = await f.request(`/interact?agent_id=${alice.id}&world_id=workshop&x=5&y=11`, { account: 'alice' });
  assert.equal(read.status, 200);
  assert.equal(read.data.fixture.kind, 'crafting_station');
  assert.equal(read.data.fixture.action.id, 'craft');
  assert.match(read.data.fixture.hint, /Crafting station at 5, 11/);
  assert.match(read.data.fixture.hint, /Craft a keepsake/);
  assert.ok(read.data.fixture.action.options.some((option) => option.recipe_id === 'flower_crown' && option.available === false));

  const missing = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-craft-missing', input: { agent_id: alice.id, x: 5, y: 11, action: 'craft', recipe_id: 'flower_crown' } });
  assert.equal(missing.status, 409);
  assert.match(missing.data.error, /ingredients/);
  assert.match(missing.data.next_step, /2 herbs and 1 fiber/);
  assert.match(missing.data.next_step, /still needs 2 more herbs and 1 more fiber/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_inventory WHERE agent_id=? AND kind=?', alice.id, 'flower_crown').n, 0);

  // The fixture grants the resident the grown resources a real garden would have produced.
  for (const [kind, quantity] of [['herbs', 2], ['fiber', 1]]) f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=excluded.quantity', alice.id, kind, quantity);
  const crafted = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-craft-ok', input: { agent_id: alice.id, x: 5, y: 11, action: 'craft', recipe_id: 'flower_crown' } });
  assert.equal(crafted.status, 200);
  assert.equal(crafted.data.result.crafted, 'flower_crown');
  const shelf = Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', alice.id).map((item) => [item.kind, item.quantity]));
  assert.equal(shelf.flower_crown, 1);
  assert.equal(shelf.herbs, 0);
  assert.equal(f.platform.get('SELECT crafts FROM journey_profiles WHERE agent_id=?', alice.id).crafts, 1);

  // The same click again with its key writes nothing.
  const repeated = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-craft-ok', input: { agent_id: alice.id, x: 5, y: 11, action: 'craft', recipe_id: 'flower_crown' } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.replay, true);
  assert.equal(f.platform.get('SELECT crafts FROM journey_profiles WHERE agent_id=?', alice.id).crafts, 1);
});

test('an ambassador desk talks through the existing conversation action, and a paused desk is refused', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const stand = f.platform.get("SELECT id,world_id,x,y,name FROM npc_ambassadors WHERE id='amb-NPL'");
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', stand.world_id, stand.x, stand.y + 1, alice.id);

  const read = await f.request(`/interact?agent_id=${alice.id}&world_id=${encodeURIComponent(stand.world_id)}&x=${stand.x}&y=${stand.y}`, { account: 'alice' });
  assert.equal(read.status, 200);
  assert.equal(read.data.fixture.kind, 'ambassador_desk');
  assert.equal(read.data.fixture.name, stand.name);
  assert.equal(read.data.fixture.action.id, 'talk');
  assert.equal(read.data.fixture.action.route, 'POST /api/v1/ambassadors/talk');
  assert.match(read.data.fixture.hint, /Talk to /);
  assert.match(read.data.fixture.hint, /ambassador’s stand/);

  const turns = () => f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', f.actor('alice').account.id).n;
  const answered = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-talk-1', input: { agent_id: alice.id, x: stand.x, y: stand.y, action: 'talk', question: 'What can we research here?' } });
  assert.equal(answered.status, 200);
  assert.equal(answered.data.result.ambassador_id, 'amb-NPL');
  assert.equal(turns(), 1);
  // The desk's own per-conversation rule keeps a rapid second click from storing a second turn.
  const rapid = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-talk-2', input: { agent_id: alice.id, x: stand.x, y: stand.y, action: 'talk', question: 'And now?' } });
  assert.equal(rapid.status, 429);
  assert.match(rapid.data.next_step, /Wait a moment/);
  assert.equal(turns(), 1);

  // A paused ambassador keeps its desk readable and refuses the conversation with its state named.
  f.tx('ambassadorControl', f.actor('admin'), { ambassador_id: 'amb-NPL', status: 'paused' });
  const pausedRead = await f.request(`/interact?agent_id=${alice.id}&world_id=${encodeURIComponent(stand.world_id)}&x=${stand.x}&y=${stand.y}`, { account: 'alice' });
  assert.equal(pausedRead.status, 200);
  assert.equal(pausedRead.data.fixture, null);
  assert.match(pausedRead.data.hint, /No door, crop patch, bench, crafting station or country ambassador desk/);
});

test('a paused or revoked resident is refused with its own state, and an observer can inspect but never act for it', async (t) => {
  const f = await setup(t), alice = f.agent('alice'), bob = f.agent('bob');

  assert.equal((await f.request('/agents/control', { method: 'POST', account: 'alice', input: { agent_id: alice.id, status: 'paused' } })).status, 200);
  const paused = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-paused', input: { agent_id: alice.id, x: 11, y: 6 } });
  assert.equal(paused.status, 403);
  assert.match(paused.data.error, /is paused/);
  assert.match(paused.data.next_step, /Resume alice avatar in My characters/);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');

  assert.equal((await f.request('/agents/control', { method: 'POST', account: 'alice', input: { agent_id: alice.id, status: 'revoked' } })).status, 200);
  const revoked = await f.request('/interact', { method: 'POST', account: 'alice', key: 'interaction-revoked', input: { agent_id: alice.id, x: 11, y: 6 } });
  assert.equal(revoked.status, 403);
  assert.match(revoked.data.error, /revoked/);
  assert.match(revoked.data.next_step, /must resume this resident/);
  assert.equal((await f.request('/agents/control', { method: 'POST', account: 'alice', input: { agent_id: alice.id, status: 'active' } })).status, 200);

  // Another operator's resident is not found: a spectator may never act as someone else's character.
  const before = auditCount(f, 'world.entered');
  const impersonated = await f.request('/interact', { method: 'POST', account: 'bob', key: 'interaction-impersonate', input: { agent_id: alice.id, x: 11, y: 6 } });
  assert.equal(impersonated.status, 404);
  assert.equal(auditCount(f, 'world.entered'), before);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');

  // A visitor with no acting resident reads the same fixture and is told it is inspection only.
  const anonymous = await f.request('/interact?world_id=commons&x=11&y=6');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data.viewer, null);
  assert.equal(anonymous.data.fixture.kind, 'door');
  assert.equal(anonymous.data.fixture.can_act, false);
  assert.equal(anonymous.data.fixture.blocked_by, 'inspect_only');
  assert.match(anonymous.data.fixture.next_step, /Inspection only/);
  assert.equal(auditCount(f, 'world.entered'), before);

  // A signed-in operator whose own resident is elsewhere is told exactly that.
  const elsewhere = await f.request(`/interact?world_id=hall&x=10&y=11&agent_id=${bob.id}`, { account: 'bob' });
  assert.equal(elsewhere.status, 200);
  assert.equal(elsewhere.data.fixture.blocked_by, 'another_world');
  assert.equal(elsewhere.data.fixture.can_act, false);
  assert.match(elsewhere.data.fixture.next_step, /bob avatar is in The Commons, not here/);
  const refused = await f.request('/interact', { method: 'POST', account: 'bob', key: 'interaction-elsewhere', input: { agent_id: bob.id, x: 10, y: 11 } });
  assert.equal(refused.status, 404);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', bob.id).world_id, 'commons');
});

test('a runtime without the action’s scope cannot use a fixture the world keeps behind it', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const garden = `home:${alice.id}`;
  assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: garden }).world_id, garden);
  f.tx('build', f.actor('alice'), alice.id, { type: 'farm', x: 8, y: 7 });
  f.platform.run('UPDATE agents SET x=8,y=7 WHERE id=?', alice.id);
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'move'], max_calls: 20 });
  const refused = await f.request('/interact', { method: 'POST', token: runtime.token, key: 'interaction-scope', input: { x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'herbs' } });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /build scope is required/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', alice.id).n, 0);
});
