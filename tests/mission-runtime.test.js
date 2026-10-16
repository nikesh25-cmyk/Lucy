import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, realMission, evidence, PASSWORD } from './helpers.js';
import { createApp } from '../server.js';

async function httpPost(url, path, body, token = null, key = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
}

async function httpGet(url, path, token = null) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${url}/api/v1${path}`, { headers, redirect: 'error' });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('a runtime with contribute scope claims one task and submits evidence through the HTTP routes', async (t) => {
  const f = await fixture(t);
  const { task } = realMission(f);
  const agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  const directory = await httpGet(url, '/missions?limit=12', runtime.token);
  assert.equal(directory.status, 200);
  assert.ok(directory.body.tasks.some((item) => item.id === task.id), 'the created task appears in the directory');
  assert.equal(directory.body.active_claim, null);

  const key = 'runtime-claim-key-1';
  const claim = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, key);
  assert.equal(claim.status, 201);
  assert.equal(claim.body.task_id, task.id);
  assert.equal(claim.body.status, 'leased');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n, 1);

  const claimReplay = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, key);
  assert.equal(claimReplay.status, 201);
  assert.equal(claimReplay.body.id, claim.body.id);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n, 1);

  const directory2 = await httpGet(url, '/missions?limit=12', runtime.token);
  assert.equal(directory2.body.active_claim.id, claim.body.id);

  const submitKey = 'runtime-submit-key-1';
  const submit = await httpPost(url, '/submissions', evidence(claim.body), runtime.token, submitKey);
  assert.equal(submit.status, 201);
  assert.equal(submit.body.status, 'pending_review');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n, 1);

  const submitReplay = await httpPost(url, '/submissions', evidence(claim.body), runtime.token, submitKey);
  assert.equal(submitReplay.status, 201);
  assert.equal(submitReplay.body.id, submit.body.id);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n, 1);

  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a runtime without contribute scope is refused on mission work routes', async (t) => {
  const f = await fixture(t);
  const { task } = realMission(f);
  const agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'move'] });
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  const claim = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, 'no-contribute-claim');
  assert.equal(claim.status, 403);
  const submit = await httpPost(url, '/submissions', { claim_id: 'any', artifact: 'x', sources: [{ url: 'https://example.org/a' }] }, runtime.token, 'no-contribute-submit');
  assert.equal(submit.status, 403);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n, 0);
});

test('a paused or revoked runtime credential is refused before the mission handler', async (t) => {
  const f = await fixture(t);
  const { task } = realMission(f);
  const agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  f.tx('agentControl', f.actor('alice'), agent.id, 'paused');
  const paused = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, 'paused-claim');
  assert.equal(paused.status, 401);

  f.tx('agentControl', f.actor('alice'), agent.id, 'active');
  const runtime2 = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const active = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime2.token, 'active-claim');
  assert.equal(active.status, 201);

  f.tx('agentControl', f.actor('alice'), agent.id, 'paused');
  const revoked = await httpPost(url, '/submissions', { claim_id: active.body.id, artifact: 'x', sources: [{ url: 'https://example.org/a' }] }, runtime2.token, 'revoked-submit');
  assert.equal(revoked.status, 401);
});

test('claim lease expires after 20 minutes and a second operator can then claim the task', async (t) => {
  const f = await fixture(t);
  const { task } = realMission(f);
  const aliceAgent = f.agent('alice');
  const bobAgent = f.agent('bob');
  const runtime = f.tx('runtime', f.actor('alice'), aliceAgent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  const claim = await httpPost(url, '/claims', { task_id: task.id, agent_id: aliceAgent.id }, runtime.token, 'lease-claim');
  assert.equal(claim.status, 201);

  const bobRuntimeEarly = f.tx('runtime', f.actor('bob'), bobAgent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const blocked = await httpPost(url, '/claims', { task_id: task.id, agent_id: bobAgent.id }, bobRuntimeEarly.token, 'bob-early-claim');
  assert.equal(blocked.status, 409);

  f.advance(21 * 60 * 1000);
  const bobRuntime = f.tx('runtime', f.actor('bob'), bobAgent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const reopened = await httpPost(url, '/claims', { task_id: task.id, agent_id: bobAgent.id }, bobRuntime.token, 'bob-late-claim');
  assert.equal(reopened.status, 201);
  assert.notEqual(reopened.body.id, claim.body.id);
  assert.equal(reopened.body.account_id, f.actor('bob').account.id);
});

test('one active claim per operator: same leased task is 409, a different open task is 429', async (t) => {
  const f = await fixture(t);
  const { task, mission } = realMission(f);
  const task2 = f.tx('createTask', f.actor('admin'), {
    mission_id: mission.id, title: 'Second task', instructions: 'Another source.',
    rights: 'Permission required.', allowed_domains: ['example.org'],
  });
  const agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  const claim = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, 'one-claim');
  assert.equal(claim.status, 201);

  const sameTask = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, 'same-task');
  assert.equal(sameTask.status, 409);

  const differentTask = await httpPost(url, '/claims', { task_id: task2.id, agent_id: agent.id }, runtime.token, 'different-task');
  assert.equal(differentTask.status, 429);
});

test('a runtime cannot review, adopt or mint a coin, and a human avatar cannot receive a runtime token', async (t) => {
  const f = await fixture(t);
  const { task } = realMission(f);
  const agent = f.agent('alice');
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;

  const claim = await httpPost(url, '/claims', { task_id: task.id, agent_id: agent.id }, runtime.token, 'review-claim');
  const submit = await httpPost(url, '/submissions', evidence(claim.body), runtime.token, 'review-submit');
  assert.equal(submit.status, 201);

  const review = await httpPost(url, '/reviews', { submission_id: submit.body.id, decision: 'accepted', reason: 'Looks fine.' }, runtime.token);
  assert.equal(review.status, 403);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);

  const human = f.tx('createAgent', f.actor('bob'), { name: 'Bob human', kind: 'human', color: '#397f79', symbol: '✦' });
  assert.throws(() => f.tx('runtime', f.actor('bob'), human.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] }), /Human avatars/);
});
