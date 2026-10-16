import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { authorizeAction, parseAction } from '../runtime/agent.js';
import { fixture } from './helpers.js';

test('the runtime pre-filter only approves actions the server also enforces', async (t) => {
  // authorizeAction is an advisory copy of server policy for one local runtime. The server stays
  // authoritative, so the safe direction of divergence is the runtime refusing more than the server.
  // This test pins that direction: every approval is sent to the server and must be accepted, and the
  // single known stricter case (directory visiting, tests/world-platform.test.js) is asserted too.
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const homeId = `home:${alice.id}`, otherGarden = `home:${bob.id}`;
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'move', 'build'], max_calls: 40 });
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (route, input) => {
    const response = await fetch(base + route, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return response.status;
  };
  const status = { agent_id: alice.id, scopes: ['read', 'move', 'build'] };
  const approve = (action, view) => {
    const parsed = parseAction(action);
    assert.deepEqual(authorizeAction(parsed, view, status), parsed, `${action.action} must be approved before it is sent`);
    return parsed;
  };

  const view = f.platform.world(f.platform.authenticate(runtime.token), { agent_id: alice.id });
  approve({ action: 'travel', world_id: homeId }, view);
  assert.equal(await post(`/agents/${alice.id}/travel`, { world_id: homeId }), 200, 'an approved travel must be accepted');
  const garden = f.platform.world(f.platform.authenticate(runtime.token), { agent_id: alice.id });
  approve({ action: 'build', type: 'flowers', x: 4, y: 8 }, garden);
  assert.equal(await post(`/agents/${alice.id}/build`, { type: 'flowers', x: 4, y: 8 }), 201, 'an approved build must be accepted');

  // Directory visiting is documented (README.md, docs/ARCHITECTURE.md): the server accepts the visit,
  // the runtime declines it. Refusing more is safe; approving more never is.
  f.advance();
  assert.throws(() => authorizeAction(parseAction({ action: 'travel', world_id: otherGarden }), garden, status), /permissions/);
  assert.equal(await post(`/agents/${alice.id}/travel`, { world_id: otherGarden }), 200, 'the server still permits a documented directory visit');

  // Both sides refuse the same things: a private garden and a build outside the runtime's own space.
  f.tx('homeSettings', f.actor('bob'), bob.id, { visibility: 'private' });
  f.advance();
  assert.throws(() => authorizeAction(parseAction({ action: 'travel', world_id: otherGarden }), garden, status), /permissions/);
  assert.equal(await post(`/agents/${alice.id}/travel`, { world_id: otherGarden }), 403);
  const commons = f.platform.world(f.platform.authenticate(runtime.token), { agent_id: alice.id });
  assert.equal(commons.world.id, 'commons');
  assert.throws(() => authorizeAction(parseAction({ action: 'build', type: 'flowers', x: 4, y: 8 }), commons, status), /permissions/);
  assert.equal(await post(`/agents/${alice.id}/build`, { type: 'flowers', x: 4, y: 8 }), 403);
});
