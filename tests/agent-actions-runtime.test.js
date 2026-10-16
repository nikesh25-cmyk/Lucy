import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';
import { parseAction, runAgent, writeKey } from '../runtime/agent.js';

const OBSERVATION_MARKER = 'WORLD OBSERVATIONS:\n';
const observations = (prompt) => JSON.parse(prompt.split(OBSERVATION_MARKER)[1]);
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

/**
 * A live world with everything the new actions need, reached over the shipped HTTP routes exactly as
 * a resident reaches it: alice's own public garden with a bench she already stands beside, bob's
 * character visiting it as a different operator's resident, herbs on alice's shelf, and one open
 * guild project another operator created.
 */
async function runtimeFixture(t, { scopes = ['read', 'move', 'chat', 'contribute'] } = {}) {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const garden = `home:${alice.id}`;
  f.tx('travel', f.actor('alice'), alice.id, { world_id: garden });
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', 10, 10, alice.id);
  f.tx('build', f.actor('alice'), alice.id, { type: 'bench', x: 11, y: 10 });
  f.tx('travel', f.actor('bob'), bob.id, { world_id: garden });
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', 11, 11, bob.id);
  f.platform.run('INSERT INTO journey_inventory VALUES(?,?,?)', alice.id, 'herbs', 4);
  const project = f.tx('guildProjectCreate', f.actor('bob'), {
    agent_id: bob.id, guild_id: 'explorer', title: 'The Commons Cartography', summary: 'Trace one accessible route and record it.',
    visibility: 'public', plan: [{ id: 'trace-route', title: 'Trace one route', output_name: 'A traced route', scope: 'Walk it and record the tiles.' }],
  });
  const credential = f.tx('runtime', f.actor('alice'), alice.id, { minutes: 20, max_calls: 200, scopes });
  const { server, platform } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${server.address().port}`, requests = [];
  const fetchImpl = async (address, options) => {
    const target = new URL(address);
    requests.push({ path: target.pathname, search: target.search, body: options.body ? JSON.parse(options.body) : null, key: options.headers?.['Idempotency-Key'] ?? null });
    return fetch(address, options);
  };
  const run = (options) => runAgent({ url, token: credential.token, fetchImpl, maxCalls: 1, stepDelayMs: 0, reportJob: false, ...options });
  return { ...f, platform, server, alice, bob, garden, project, credential, requests, fetchImpl, url, run };
}

test('inspect and survey read the world through the shipped interaction route and carry the reading forward', async (t) => {
  const f = await runtimeFixture(t);
  const seen = [];
  const result = await f.run({ maxCalls: 2, runId: 'run-read', modelFn: async ({ prompt }) => {
    const view = observations(prompt);
    seen.push(view);
    return seen.length === 1 ? JSON.stringify({ action: 'inspect', x: 11, y: 10 }) : JSON.stringify({ action: 'survey' });
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.action_count, 2);
  // Both reads are the world's own interaction read: one named tile, then the neighbourhood. No route
  // is added for them and neither sends a body.
  assert.deepEqual(f.requests.filter((request) => request.path === '/api/v1/interact').map((request) => `${request.path}${request.search}`),
    [`/api/v1/interact?world_id=${encodeURIComponent(f.garden)}&x=11&y=10`, `/api/v1/interact?world_id=${encodeURIComponent(f.garden)}`]);
  assert.ok(f.requests.every((request) => request.path !== '/api/v1/interact' || request.body === null), 'a read sends no body');
  // The first decision had no reading; the second carries exactly the one the first asked for.
  assert.equal(Object.hasOwn(seen[0], 'sighting'), false);
  assert.equal(seen[1].sighting.source, 'inspect');
  assert.equal(seen[1].sighting.world_id, f.garden);
  assert.equal(seen[1].sighting.decision, 1);
  assert.equal(seen[1].sighting.fixture.kind, 'bench');
  assert.equal(seen[1].sighting.fixture.can_act, true);
  assert.equal(seen[1].sighting.fixture.action.id, 'posture');
  assert.deepEqual(seen[0].fixtures, [{ kind: 'bench', name: 'Bench', x: 11, y: 10, distance: 1 }]);
  // A read changes nothing: no object, message, offer, participation or coin was written.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', f.garden).n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants WHERE agent_id=?', f.alice.id).n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('sit runs the shipped bench interaction, stores one posture and takes a stable key', async (t) => {
  const f = await runtimeFixture(t);
  const action = { action: 'sit', x: 11, y: 10 };
  const result = await f.run({ runId: 'run-sit', modelFn: async ({ prompt }) => {
    assert.match(prompt, /\{"action":"sit","x":integer,"y":integer\}/, 'the bench beside the resident is offered');
    return JSON.stringify(action);
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.action_count, 1);
  const posted = f.requests.filter((request) => request.path === '/api/v1/interact' && request.body);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { agent_id: f.alice.id, x: 11, y: 10, action: 'posture' });
  assert.equal(posted[0].key, writeKey('run-sit', 1, 'sit', action));
  // The world's own posture is the only thing that changed.
  assert.equal(f.platform.get('SELECT posture FROM agents WHERE id=?', f.alice.id).posture, 'sitting');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(result.last_action.action, 'sit');
  // The world records that one key: the same key returns the recorded outcome and writes nothing.
  const replay = await fetch(`${f.url}/api/v1/interact`, { method: 'POST', headers: { authorization: `Bearer ${f.credential.token}`, 'content-type': 'application/json', 'Idempotency-Key': posted[0].key }, body: JSON.stringify(posted[0].body) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
  assert.equal(f.platform.get('SELECT posture FROM agents WHERE id=?', f.alice.id).posture, 'sitting');
});

test('sit is refused when the observation shows no bench beside the resident', async (t) => {
  const f = await runtimeFixture(t);
  // The bench is real and saved, but the resident has stepped away from it.
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', 20, 20, f.alice.id);
  const result = await f.run({ runId: 'run-far-sit', modelFn: async ({ prompt }) => {
    assert.ok(!prompt.includes('{"action":"sit"'), 'a bench out of reach is not offered');
    return JSON.stringify({ action: 'sit', x: 11, y: 10 });
  } });
  assert.equal(result.status, 'failed');
  assert.equal(result.action_count, 0);
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/interact').length, 0, 'nothing is sent for an unreachable bench');
  assert.equal(f.platform.get('SELECT posture FROM agents WHERE id=?', f.alice.id).posture, 'standing');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('offer posts to the shipped offers route, escrows exactly what was named and stores the key durably', async (t) => {
  const f = await runtimeFixture(t);
  const action = { action: 'offer', recipient_agent_id: f.bob.id, kind: 'herbs', quantity: 2, note: 'For the map you are tracing.' };
  const result = await f.run({ runId: 'run-offer', modelFn: async ({ prompt }) => {
    assert.match(prompt, /\{"action":"offer",/, 'an offer towards a different operator is offered');
    const neighbour = observations(prompt).participants.find((item) => item.id === f.bob.id);
    assert.equal(neighbour.different_operator, true, 'the observation marks the neighbour as a different operator');
    assert.equal(Object.hasOwn(neighbour, 'operator_id'), false, 'the world view never carries the other operator identity');
    return JSON.stringify(action);
  } });
  assert.equal(result.status, 'completed');
  const posted = f.requests.filter((request) => request.path === '/api/v1/journey/offers');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { recipient_agent_id: f.bob.id, items: { herbs: 2 }, note: 'For the map you are tracing.' });
  assert.equal(posted[0].key, writeKey('run-offer', 1, 'offer', action));
  const offers = f.platform.all('SELECT * FROM resource_offers');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].status, 'proposed');
  assert.deepEqual(JSON.parse(offers[0].items), { herbs: 2 });
  assert.equal(offers[0].offerer_agent_id, f.alice.id);
  assert.equal(offers[0].recipient_agent_id, f.bob.id);
  assert.equal(offers[0].propose_key, posted[0].key, 'the world stores the runtime key on the offer row');
  // Exactly two herbs left the shelf, and the recipient can accept only through its own operator.
  assert.equal(f.platform.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", f.alice.id).quantity, 2);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offer_events').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('an offer to a same-operator resident, an unobserved neighbour or more than the shelf holds is refused before it is sent', async (t) => {
  const f = await runtimeFixture(t);
  const sibling = f.agent('alice', 'alice second avatar');
  f.tx('travel', f.actor('alice'), sibling.id, { world_id: f.garden });
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', 12, 12, sibling.id);
  const attempts = [
    { action: 'offer', recipient_agent_id: sibling.id, kind: 'herbs', quantity: 1 },
    { action: 'offer', recipient_agent_id: 'not-in-the-world', kind: 'herbs', quantity: 1 },
    { action: 'offer', recipient_agent_id: f.bob.id, kind: 'herbs', quantity: 9 },
    { action: 'offer', recipient_agent_id: f.bob.id, kind: 'flower_crown', quantity: 1 },
  ];
  for (const [index, action] of attempts.entries()) {
    const result = await f.run({ runId: `run-refused-${index}`, modelFn: async ({ prompt }) => {
      assert.ok(!prompt.includes('{"action":"offer"') || action.quantity <= 4, 'an offer is only offered where the shelf and the neighbour allow it');
      return JSON.stringify(action);
    } });
    assert.equal(result.status, 'failed', `${JSON.stringify(action)} must stop the run`);
    assert.equal(result.action_count, 0);
  }
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/journey/offers').length, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  assert.equal(f.platform.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", f.alice.id).quantity, 4);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('guild joins and leaves the observed project through the shipped participation route', async (t) => {
  const f = await runtimeFixture(t);
  // One decision that does nothing but observe, so the calling this resident already has is settled
  // before the participation is added.
  await f.run({ runId: 'run-guild-warmup', modelFn: () => JSON.stringify({ action: 'wait' }) });
  const callingBefore = f.platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', f.alice.id)?.calling_id ?? null;
  const join = await f.run({ runId: 'run-guild-join', modelFn: async ({ prompt }) => {
    assert.match(prompt, /\{"action":"guild","project_id":"an observed guild project","intent":"join|leave"\}/);
    const board = observations(prompt).guilds;
    assert.equal(board.viewer_agent_id, f.alice.id);
    assert.deepEqual(board.projects.map((project) => project.id), [f.project.id]);
    assert.equal(typeof board.projects[0].summary, 'string');
    assert.equal(Object.hasOwn(board.projects[0], 'contributions'), false, 'no contribution history reaches the model');
    return JSON.stringify({ action: 'guild', project_id: f.project.id, intent: 'join' });
  } });
  assert.equal(join.status, 'completed');
  const posted = f.requests.filter((request) => request.path === '/api/v1/guilds/participation');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { project_id: f.project.id, action: 'join' });
  assert.equal(posted[0].key, writeKey('run-guild-join', 1, 'guild', parseAction({ action: 'guild', project_id: f.project.id, intent: 'join' })));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=? AND agent_id=?', f.project.id, f.alice.id).n, 1);
  assert.equal(f.platform.get('SELECT role FROM guild_participants WHERE project_id=? AND agent_id=?', f.project.id, f.alice.id).role, 'member');
  // Participation grants nothing: no calling, no receipt, no land and no coin.
  assert.equal(f.platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', f.alice.id)?.calling_id ?? null, callingBefore, 'joining grants no calling and changes none');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_contributions').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', f.alice.id).n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  // The world's own route is a no-op when the same resident joins again with a new key: one row, one
  // participation, however many times the write is repeated.
  const repeated = await fetch(`${f.url}/api/v1/guilds/participation`, { method: 'POST', headers: { authorization: `Bearer ${f.credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ project_id: f.project.id, action: 'join' }) });
  assert.equal(repeated.status, 200);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=? AND agent_id=?', f.project.id, f.alice.id).n, 1);

  // The next decision sees its own membership and may leave.
  const leave = await f.run({ runId: 'run-guild-leave', maxCalls: 1, modelFn: async ({ prompt }) => {
    assert.equal(observations(prompt).guilds.projects[0].participation.joined, true, 'the observed board reports the membership the server saved');
    return JSON.stringify({ action: 'guild', project_id: f.project.id, intent: 'leave' });
  } });
  assert.equal(leave.status, 'completed');
  assert.deepEqual(f.requests.filter((request) => request.path === '/api/v1/guilds/participation').map((request) => request.body),
    [{ project_id: f.project.id, action: 'join' }, { project_id: f.project.id, action: 'leave' }]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=? AND agent_id=?', f.project.id, f.alice.id).n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_projects').n, 1, 'leaving leaves the project itself untouched');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a project the resident already belongs to cannot be joined twice and an unobserved project is refused', async (t) => {
  const f = await runtimeFixture(t);
  await f.run({ runId: 'run-first-join', modelFn: () => JSON.stringify({ action: 'guild', project_id: f.project.id, intent: 'join' }) });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants').n, 2, 'the organiser plus the joining resident');
  const again = await f.run({ runId: 'run-second-join', modelFn: () => JSON.stringify({ action: 'guild', project_id: f.project.id, intent: 'join' }) });
  assert.equal(again.status, 'failed');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants').n, 2, 'a repeated join adds no participation row');
  const absent = await f.run({ runId: 'run-absent-join', modelFn: () => JSON.stringify({ action: 'guild', project_id: 'not-an-observed-project', intent: 'join' }) });
  assert.equal(absent.status, 'failed');
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/guilds/participation').length, 1, 'only the one accepted join was ever sent');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('every new write is refused without its own scope and none of them is sent', async (t) => {
  const f = await runtimeFixture(t, { scopes: ['read', 'move'] });
  const attempts = [
    { action: 'offer', recipient_agent_id: f.bob.id, kind: 'herbs', quantity: 1 },
    { action: 'guild', project_id: f.project.id, intent: 'join' },
  ];
  for (const [index, action] of attempts.entries()) {
    const result = await f.run({ runId: `run-scope-${index}`, modelFn: async ({ prompt }) => {
      assert.ok(!prompt.includes('{"action":"offer"'), 'no offer is advertised without the contribute scope');
      assert.ok(!prompt.includes('{"action":"guild"'), 'no participation is advertised without the contribute scope');
      return JSON.stringify(action);
    } });
    assert.equal(result.status, 'failed');
    assert.equal(result.action_count, 0);
  }
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/journey/offers').length, 0);
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/guilds/participation').length, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants').n, 1, 'only the operator-created organiser row exists');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);

  // A read-only run has no movement either, so even the bench it is standing beside is not offered.
  const readOnly = await runtimeFixture(t, { scopes: ['read'] });
  const refused = await readOnly.run({ runId: 'run-read-only-sit', modelFn: async ({ prompt }) => {
    assert.ok(!prompt.includes('{"action":"sit"'), 'sitting needs the move scope');
    assert.match(prompt, /\{"action":"survey"\}/, 'a read is still offered to a read-only resident');
    return JSON.stringify({ action: 'inspect', x: 11, y: 10 });
  } });
  assert.equal(refused.status, 'completed', 'a read needs only the read scope');
  assert.equal(readOnly.requests.filter((request) => request.path === '/api/v1/interact').length, 1);
});

test('a tile with no observed fixture, and a guild board the read did not carry, stop the run before a request', async (t) => {
  const f = await runtimeFixture(t);
  const inspected = await f.run({ runId: 'run-absent-fixture', modelFn: () => JSON.stringify({ action: 'inspect', x: 3, y: 3 }) });
  assert.equal(inspected.status, 'failed');
  assert.equal(inspected.action_count, 0);
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/interact').length, 0);
  // The resident cannot name the project its own read never carried: the server attaches the guild
  // board only to a contribute-scoped runtime read, and this test proves such a project is not guessed.
  const unobserved = await f.run({ runId: 'run-unobserved-project', modelFn: async ({ prompt }) => {
    assert.equal(Object.hasOwn(observations(prompt), 'guilds'), true);
    return JSON.stringify({ action: 'guild', project_id: 'invented-project', intent: 'join' });
  } });
  assert.equal(unobserved.status, 'failed');
  assert.equal(f.requests.filter((request) => request.path === '/api/v1/guilds/participation').length, 0);
});

test('a restart replays the same deterministic offer key and duplicates nothing', async (t) => {
  const f = await runtimeFixture(t);
  const action = { action: 'offer', recipient_agent_id: f.bob.id, kind: 'herbs', quantity: 2 };
  const first = await f.run({ runId: 'run-restart', modelFn: () => JSON.stringify(action) });
  assert.equal(first.status, 'completed');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 1);
  assert.equal(f.platform.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", f.alice.id).quantity, 2);

  // The world is stopped and reopened from the same file, exactly as a restart would.
  await close(f.server);
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM resource_offers').n, 1);
  assert.equal(restarted.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", f.alice.id).quantity, 2);
  assert.equal(restarted.verifyAudit(), true);

  const { server } = createApp({ platform: restarted, backupDir: join(f.directory, 'backups') });
  await listen(server);
  t.after(() => close(server));
  const replay = await runAgent({ url: `http://127.0.0.1:${server.address().port}`, token: f.credential.token, fetchImpl: f.fetchImpl,
    maxCalls: 1, stepDelayMs: 0, reportJob: false, runId: 'run-restart', modelFn: () => JSON.stringify(action) });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.action_count, 1, 'the retried write is still one confirmed action');
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM resource_offers').n, 1, 'the retried offer is the recorded one, not a second one');
  assert.equal(restarted.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", f.alice.id).quantity, 2, 'nothing was escrowed twice');
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM resource_offer_events').n, 1);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('repeating the single-row writes after a restart changes no state', async (t) => {
  const f = await runtimeFixture(t);
  await f.run({ runId: 'run-before-sit', modelFn: () => JSON.stringify({ action: 'sit', x: 11, y: 10 }) });
  await f.run({ runId: 'run-before-join', modelFn: () => JSON.stringify({ action: 'guild', project_id: f.project.id, intent: 'join' }) });
  await f.run({ runId: 'run-before-read', modelFn: () => JSON.stringify({ action: 'inspect', x: 11, y: 10 }) });
  const before = {
    objects: f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n,
    participants: f.platform.get('SELECT COUNT(*) AS n FROM guild_participants').n,
    agents: f.platform.get('SELECT COUNT(*) AS n FROM agents').n,
    posture: f.platform.get('SELECT posture FROM agents WHERE id=?', f.alice.id).posture,
  };

  await close(f.server);
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  const { server } = createApp({ platform: restarted, backupDir: join(f.directory, 'backups') });
  await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${server.address().port}`;
  const replay = (runId, action) => runAgent({ url, token: f.credential.token, fetchImpl: f.fetchImpl, maxCalls: 1, stepDelayMs: 0, reportJob: false,
    runId, modelFn: () => JSON.stringify(action) });
  assert.equal((await replay('run-after-sit', { action: 'sit', x: 11, y: 10 })).status, 'completed');
  // The resident is already a participant, so the runtime declines a second join locally and sends
  // nothing at all: the durable row is the world's, and the runtime never adds a second one.
  const joinReplay = await replay('run-after-join', { action: 'guild', project_id: f.project.id, intent: 'join' });
  assert.equal(joinReplay.status, 'failed');
  assert.equal(joinReplay.action_count, 0);
  assert.equal((await replay('run-after-read', { action: 'inspect', x: 11, y: 10 })).status, 'completed');

  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM world_objects').n, before.objects);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM guild_participants').n, before.participants);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM guild_participants WHERE agent_id=?', f.alice.id).n, 1);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM agents').n, before.agents);
  assert.equal(restarted.get('SELECT posture FROM agents WHERE id=?', f.alice.id).posture, before.posture);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM messages').n, 0);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(restarted.verifyAudit(), true);
});
