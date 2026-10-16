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
  const request = async (route, { method = 'GET', account, token, input } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: { ...(input ? { 'Content-Type': 'application/json' } : {}), ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { ...f, request };
}

test('HTTP agents inhabit and build gardens while private visiting settings protect the world', async (t) => {
  const f = await setup(t), alice = f.agent('alice'), bob = f.agent('bob');
  const home = `home:${alice.id}`;
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'move', 'build'], max_calls: 30 });
  const token = runtime.token;
  const entered = await f.request(`/agents/${alice.id}/travel`, { method: 'POST', token, input: { world_id: home } });
  assert.equal(entered.status, 200);
  assert.equal(entered.data.world_id, home);
  assert.equal((await f.request(`/agents/${alice.id}/build`, { method: 'POST', token, input: { x: 12, y: 10, type: 'farm' } })).status, 201);
  assert.equal((await f.request(`/agents/${alice.id}/posture`, { method: 'POST', token, input: { posture: 'meditating' } })).status, 200);
  assert.equal((await f.request(`/agents/${alice.id}/heartbeat`, { method: 'POST', token, input: {} })).data.presence, 'connected');
  const view = await f.request('/world', { token });
  assert.equal(view.data.world.id, home);
  assert.equal(view.data.objects[0].type, 'farm');
  assert.equal(view.data.participants.find((a) => a.id === alice.id).posture, 'meditating');
  assert.equal(view.data.participants.find((a) => a.id === alice.id).presence, 'connected');
  assert.equal((await f.request(`/agents/${alice.id}/home`, { method: 'PATCH', token, input: { visibility: 'private' } })).status, 403);
  assert.equal((await f.request(`/agents/${alice.id}/home`, { method: 'PATCH', account: 'alice', input: { name: 'Quiet garden', visibility: 'private' } })).status, 200);
  assert.equal((await f.request(`/world?world_id=${encodeURIComponent(home)}`)).status, 403);
  assert.equal((await f.request(`/world?world_id=${encodeURIComponent(home)}`, { account: 'bob' })).status, 403);
  assert.equal((await f.request(`/world?world_id=${encodeURIComponent(home)}`, { account: 'alice' })).status, 200);
  assert.equal((await f.request('/worlds?limit=1')).data.worlds.some((w) => w.id === home), false);
  assert.equal((await f.request('/worlds?q=Quiet', { account: 'alice' })).data.worlds.some((w) => w.id === home), true);
  assert.equal((await f.request(`/agents/${bob.id}/travel`, { method: 'POST', account: 'bob', input: { world_id: home } })).status, 403);
  assert.equal((await f.request(`/agents/${alice.id}/build`, { method: 'POST', account: 'bob', input: { x: 12, y: 11, type: 'tree' } })).status, 404);
});

test('HTTP world actions enforce scopes, doorway access and inert building inputs', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'move'], max_calls: 20 });
  const token = runtime.token;
  const entered = await f.request(`/agents/${alice.id}/travel`, { method: 'POST', token, input: { world_id: `home:${alice.id}` } });
  assert.equal(entered.status, 200);
  assert.equal((await f.request(`/agents/${alice.id}/build`, { method: 'POST', token, input: { x: 12, y: 10, type: 'farm' } })).status, 403);
  assert.equal((await f.request('/runtime/status', { token })).data.remaining_calls, 19);
  assert.equal((await f.request(`/agents/${alice.id}/posture`, { method: 'POST', token, input: { posture: 'flying' } })).status, 400);
  f.advance();
  assert.equal((await f.request(`/agents/${alice.id}/travel`, { method: 'POST', token, input: { world_id: 'commons' } })).status, 200);
  f.advance();
  assert.equal((await f.request(`/agents/${alice.id}/travel`, { method: 'POST', token, input: { world_id: 'meditation' } })).status, 409);
  assert.equal((await f.request(`/agents/${alice.id}/home`, { method: 'POST', account: 'alice', input: { visibility: 'private' } })).status, 405);
  assert.equal((await f.request('/world?x=-1', { token })).status, 400);
  assert.equal((await f.request('/worlds?limit=100000')).status, 400);
  assert.equal((await f.request('/agents/%ZZ/posture', { method: 'POST', account: 'alice', input: { posture: 'sitting' } })).status, 400);
  f.advance();
  assert.equal((await f.request(`/agents/${alice.id}/travel`, { method: 'POST', account: 'alice', input: { world_id: `home:${alice.id}` } })).status, 200);
  assert.equal((await f.request(`/agents/${alice.id}/build`, { method: 'POST', account: 'alice', input: { x: 12, y: 10, type: '<script>unsafe</script>' } })).status, 400);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n, 0);
  const readOnly = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read'], max_calls: 3 });
  assert.equal((await f.request(`/agents/${alice.id}/posture`, { method: 'POST', token: readOnly.token, input: { posture: 'sitting' } })).status, 403);
  assert.equal((await f.request(`/agents/${alice.id}/heartbeat`, { method: 'POST', token: readOnly.token, input: {} })).status, 200);
});
