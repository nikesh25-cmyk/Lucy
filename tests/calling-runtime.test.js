import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { authorizeAction, NAVIGATION_LIMITS, parseAction, runAgent } from '../runtime/agent.js';
import { getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

async function httpFixture(t, { budget = 100 } = {}) {
  const f = await fixture(t);
  f.platform.clock = Date.now;
  const agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 2, max_calls: budget, scopes: ['read', 'move', 'build', 'contribute'] });
  const app = createApp({ platform: f.platform });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const url = `http://127.0.0.1:${app.server.address().port}`, requests = [];
  const fetchImpl = async (address, options) => { requests.push({ path: new URL(address).pathname, body: options.body ? JSON.parse(options.body) : null }); return fetch(address, options); };
  const run = options => runAgent({ url, token: runtime.token, fetchImpl, maxCalls: 1, stepDelayMs: 0, reportJob: false, ...options });
  return { ...f, agent, runtime, url, requests, fetchImpl, run };
}
const observations = prompt => JSON.parse(prompt.split('WORLD OBSERVATIONS:\n')[1]);

test('a bounded model follows its own Cultivator objective through a real saved crop action', async t => {
  const f = await httpFixture(t);
  f.tx('callingSelect', f.actor('alice'), { agent_id: f.agent.id, calling_id: 'cultivator' });
  f.tx('travel', f.actor('alice'), f.agent.id, { world_id: `home:${f.agent.id}` });
  f.tx('build', f.actor('alice'), f.agent.id, { type: 'farm', x: 4, y: 8 });
  const result = await f.run({ modelFn: async ({ prompt }) => {
    const view = observations(prompt);
    assert.equal(view.callings.agent_id, f.agent.id);
    assert.equal(view.callings.calling.id, 'cultivator');
    assert.equal(view.callings.today.objectives[0].complete, false);
    assert.match(prompt, /You cannot choose a Calling/);
    assert.ok(prompt.length <= 24000);
    assert.equal(view.callings.receipts, undefined, 'Private receipt rows are not needed by the model.');
    const suggestion = view.callings.suggested_actions.find(item => item.objective_id === 'cultivator.crop_plant');
    assert.deepEqual(suggestion.action, { action: 'garden', intent: 'plant', x: 4, y: 8, kind: 'herbs' });
    return JSON.stringify(suggestion.action);
  } });
  assert.equal(result.status, 'completed');
  assert.equal(result.action_count, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', f.agent.id).n, 1);
  const response = await fetch(`${f.url}/api/v1/callings`, { headers: { authorization: `Bearer ${f.runtime.token}` } });
  assert.equal(response.status, 200);
  const progress = await response.json();
  assert.equal(progress.today.objectives.find(item => item.id === 'cultivator.crop_plant').complete, true);
  assert.equal(progress.experience.available, 5);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.ok(f.requests.every(request => !request.body || !['experience', 'xp', 'coins', 'rank', 'agent_id'].some(key => Object.hasOwn(request.body, key))));
});

test('walking to an observed distant landmark executes at most 24 checked steps in one decision', async t => {
  const f = await httpFixture(t), target = { x: 84, y: 53 };
  const result = await f.run({ durationMs: 10000, modelFn: async () => JSON.stringify({ action: 'walk_to', ...target }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.model_calls, 1);
  assert.equal(result.action_count, 1);
  assert.equal(result.navigation_steps, NAVIGATION_LIMITS.steps_per_decision);
  const steps = f.requests.filter(request => ['/api/v1/move', '/api/v1/climb'].includes(request.path));
  assert.equal(steps.length, 24);
  assert.ok(steps.every(request => Object.keys(request.body).length === 1 && ['up', 'down', 'left', 'right'].includes(request.body.direction)));
  const resident = f.platform.get('SELECT x,y,world_id FROM agents WHERE id=?', f.agent.id);
  assert.equal(resident.world_id, 'commons');
  assert.notDeepEqual({ x: resident.x, y: resident.y }, target);
  assert.equal(f.platform.get("SELECT used_calls FROM tokens WHERE kind='runtime' AND agent_id=?", f.agent.id).used_calls, 29, 'Four observations, a route refresh and 24 moves consume the exact credential budget.');
});

test('bounded navigation uses the server climb route for an observed one-layer foundation', async t => {
  const f = await httpFixture(t), definition = getWorldDefinition('frontier:0:0');
  const target = Array.from({ length: 16 }, (_, index) => ({ x: 31 + index % 4, y: 31 + Math.floor(index / 4) })).find(tile => walkable(tile, definition) && walkable({ x: tile.x - 1, y: tile.y }, definition));
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A walkable foundation fixture' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', definition.id, target.x - 1, target.y, f.agent.id);
  f.tx('frontierBuild', f.actor('alice'), f.agent.id, { world_id: definition.id, ...target, z: 0, type: 'wood' });
  const result = await f.run({ modelFn: async () => JSON.stringify({ action: 'walk_to', ...target }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.navigation_steps, 1);
  assert.deepEqual(f.requests.find(request => request.path === '/api/v1/climb').body, { direction: 'right' });
  assert.deepEqual({ ...f.platform.get('SELECT x,y,z,grounded FROM agents WHERE id=?', f.agent.id) }, { ...target, z: 1, grounded: 1 });
});

test('navigation stops at its remaining API budget without a third movement or another provider call', async t => {
  const f = await httpFixture(t, { budget: 7 });
  let providerCalls = 0;
  const result = await f.run({ maxCalls: 2, modelFn: async () => { providerCalls++; return '{"action":"walk_to","x":19,"y":6}'; } });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stop_reason, 'credential_budget_exhausted');
  assert.equal(result.navigation_steps, 2);
  assert.equal(result.action_count, 1);
  assert.equal(providerCalls, 1);
  assert.equal(f.requests.filter(request => request.path === '/api/v1/move').length, 2);
  assert.equal(f.platform.get("SELECT used_calls FROM tokens WHERE kind='runtime' AND agent_id=?", f.agent.id).used_calls, 7);
});

test('revoking a runtime after its first navigation step forbids all further steps', async t => {
  const f = await httpFixture(t);
  const fetchImpl = async (address, options) => {
    const response = await f.fetchImpl(address, options);
    if (new URL(address).pathname === '/api/v1/move' && response.ok) f.tx('agentControl', f.actor('alice'), f.agent.id, 'paused');
    return response;
  };
  const result = await f.run({ fetchImpl, maxCalls: 2, modelFn: async () => '{"action":"walk_to","x":19,"y":6}' });
  assert.equal(result.status, 'failed');
  assert.equal(result.model_calls, 1);
  assert.equal(result.navigation_steps, 1);
  assert.equal(result.action_count, 1);
  assert.equal(f.requests.filter(request => request.path === '/api/v1/move').length, 1);
  assert.equal(f.platform.get('SELECT x FROM agents WHERE id=?', f.agent.id).x, 11);
});

test('navigation and Calling outputs cannot smuggle identities, rewards, selectors or unseen targets', async t => {
  for (const action of [
    { action: 'walk_to', x: 19, y: 6, world_id: 'frontier:1:0' },
    { action: 'walk_to', x: 19, y: 6, agent_id: 'someone-else' },
    { action: 'walk_to', x: 19, y: 6, xp: 999 },
    { action: 'walk_to', x: -1, y: 6 },
    { action: 'walk_to', x: 2.5, y: 6 },
    { action: 'walk_to', x: 19, y: 6, url: 'https://example.org' },
    { action: 'calling', calling_id: 'builder' },
    { action: 'reward', experience: 10, coins: 100 },
    { action: 'garden', intent: 'plant', x: 3, y: 4, kind: 'herbs', experience: 5 },
  ]) assert.throws(() => parseAction(action), /Invalid/);
  assert.throws(() => parseAction(Object.assign(Object.create({ permission: 'admin' }), { action: 'wait' })), /Invalid/);
  const f = await httpFixture(t), status = { agent_id: f.agent.id, scopes: ['read', 'move'] };
  const view = f.platform.world(f.platform.authenticate(f.runtime.token));
  assert.throws(() => authorizeAction(parseAction({ action: 'walk_to', x: 50, y: 50 }), view, status), /permissions/);
  assert.throws(() => authorizeAction(parseAction({ action: 'walk_to', x: 19, y: 6 }), view, { ...status, scopes: ['read'] }), /permissions/);
  const result = await f.run({ modelFn: async () => '{"action":"walk_to","x":19,"y":6,"coins":100}' });
  assert.equal(result.status, 'failed');
  assert.equal(result.action_count, 0);
  assert.equal(f.requests.filter(request => request.body).length, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a mismatched private Calling observation stops before the model sees it', async t => {
  const f = await httpFixture(t);
  let providerCalls = 0;
  const fetchImpl = async (address, options) => {
    const response = await f.fetchImpl(address, options);
    if (new URL(address).pathname === '/api/v1/callings') return new Response(JSON.stringify({ agent_id: 'private-sibling', calling: { purpose: 'Private sibling material' } }));
    return response;
  };
  const result = await f.run({ fetchImpl, modelFn: async () => { providerCalls++; return '{"action":"wait"}'; } });
  assert.equal(result.status, 'failed');
  assert.equal(providerCalls, 0);
  assert.equal(result.model_calls, 0);
  assert.equal(f.requests.filter(request => request.body).length, 0);
});
