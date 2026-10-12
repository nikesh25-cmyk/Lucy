import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { BLUEPRINT_CATALOGUE } from '../src/frontier.js';

// The repository has no browser automation, so the build panel's own contract is verified here over
// real HTTP: the same route, headers and JSON the panel sends, with the world payload the panel
// reads its blueprint choices from.
test('blueprint API previews without writing, applies atomically, replays and removes under ownership', async t => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A shared learning garden', description: 'An isolated blueprint fixture.' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 32, 32, agent.id);
  const app = createApp({ platform: f.platform });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const request = async (path, token, input) => {
    const response = await fetch(base + path, { method: input ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json', Origin: new URL(base).origin } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const token = f.credentials.alice.token;
  // The world payload carries the catalogue the panel renders, with the fields the labels need.
  const world = await request('/world?world_id=frontier:0:0', token);
  assert.equal(world.status, 200);
  assert.deepEqual(world.data.frontier.blueprints.map(blueprint => [blueprint.id, blueprint.block_count]), BLUEPRINT_CATALOGUE.map(blueprint => [blueprint.id, blueprint.block_count]));
  assert.equal(world.data.frontier.blueprints.every(blueprint => blueprint.name && blueprint.summary && blueprint.footprint.width >= 2 && blueprint.doorways > 0), true);
  // A preview reports the plan and writes nothing.
  const preview = await request('/frontier/build', token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'garden-shelter', x: 33, y: 31, preview: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.valid, true);
  assert.equal(preview.data.writes, 0);
  assert.equal(preview.data.cells.length, 14);
  assert.equal(preview.data.access.doorways[0].clear, true);
  assert.equal(preview.data.ownership.is_mine, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n, 0);
  // A runtime with building permission uses the same route, then applies the structure.
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'build'], max_calls: 20 });
  assert.equal((await request('/frontier/build', runtime.token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'gathering-pavilion', x: 30, y: 33, preview: true })).data.valid, true);
  f.advance();
  const applied = await request('/frontier/build', runtime.token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'gathering-pavilion', x: 30, y: 33 });
  assert.equal(applied.status, 200);
  assert.deepEqual({ applied: applied.data.applied, new_blocks: applied.data.new_blocks, plot_id: applied.data.plot_id }, { applied: true, new_blocks: 13, plot_id: 'plot:0:0:5:5' });
  f.advance();
  assert.equal((await request('/frontier/build', token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'gathering-pavilion', x: 30, y: 33 })).data.replay, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 13);
  // A stale area reference, an unowned plot and a wrong blueprint are refused.
  assert.equal((await request('/frontier/build', token, { agent_id: agent.id, world_id: 'frontier:1:0', blueprint: 'gathering-pavilion', x: 30, y: 33 })).status, 409);
  assert.equal((await request('/frontier/build', token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'gathering-pavilion', x: 12, y: 6 })).status, 403);
  assert.equal((await request('/frontier/build', token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'castle', x: 30, y: 30 })).status, 400);
  f.advance();
  const removed = await request('/frontier/build', token, { agent_id: agent.id, world_id: 'frontier:0:0', blueprint: 'gathering-pavilion', x: 30, y: 33, remove: true });
  assert.deepEqual({ removed: removed.data.removed, removed_blocks: removed.data.removed_blocks }, { removed: true, removed_blocks: 13 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.verifyAudit(), true);
});
