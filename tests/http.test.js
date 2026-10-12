import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { request as nativeRequest } from 'node:http';
import { createApp } from '../server.js';
import { fixture, realMission, evidence, PASSWORD } from './helpers.js';

// Fetch normalizes Host; use the HTTP client to exercise the server's actual Host check.
const requestHost = (base, host) => new Promise((resolve, reject) => {
  const request = nativeRequest(`${base}/api/v1/world`, { headers: { Host: host } }, (response) => {
    response.resume();
    response.once('end', () => resolve(response.statusCode));
  });
  request.once('error', reject);
  request.end();
});

async function httpFixture(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', account, token, cookie, input, headers = {} } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: {
        ...(input !== undefined ? { 'Content-Type': 'application/json', 'X-API-Client': 'operator' } : {}),
        ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers,
      },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw, data: raw ? JSON.parse(raw) : null };
  };
  return { ...f, server, base, request };
}

test('HTTP browser authentication uses a protected cookie and rejects foreign origins and hosts', async (t) => {
  const f = await httpFixture(t);
  const login = await f.request('/auth/login', { method: 'POST', input: { email: 'alice@example.org', password: PASSWORD }, headers: { Origin: f.base, 'X-API-Client': '' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.token, undefined);
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await f.request('/me', { cookie })).data.account.email, 'alice@example.org');
  assert.equal((await f.request('/auth/login', { method: 'POST', input: { email: 'alice@example.org', password: PASSWORD }, headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal(await requestHost(f.base, 'foreign.example'), 403);
  assert.equal(await requestHost(f.base, '127.0.0.1:1'), 403);
  assert.equal((await f.request('/agents', { method: 'POST', cookie, input: { name: 'CSRF attempt' }, headers: { 'X-API-Client': '' } })).status, 403);
  const create = await f.request('/agents', { method: 'POST', cookie, input: { name: 'Cookie avatar', limitations: 'Fixture' }, headers: { Origin: f.base, 'X-API-Client': '' } });
  assert.equal(create.status, 201);
  const logout = await f.request('/auth/logout', { method: 'POST', cookie, input: {}, headers: { Origin: f.base } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/me', { cookie })).status, 401);
});

test('HTTP invitation enrollment, runtime scopes and budgets enforce the external agent boundary', async (t) => {
  const f = await httpFixture(t);
  const invitation = await f.request('/invites', { method: 'POST', account: 'admin', input: { role: 'member' } });
  const registration = await f.request('/auth/register', { method: 'POST', input: { name: 'HTTP operator', email: 'http@example.org', password: PASSWORD, consent: true, invite: invitation.data.code } });
  assert.equal(registration.status, 201);
  const agent = await f.request('/agents', { method: 'POST', token: registration.data.token, input: { name: 'HTTP robot', capabilities: 'Approved source reading', limitations: 'Bounded fixture' } });
  assert.equal(agent.status, 201);
  const started = await f.request('/runtime/start', { method: 'POST', token: registration.data.token, input: { agent_id: agent.data.id, scopes: ['read', 'move'], minutes: 2, max_calls: 2 } });
  assert.equal(started.status, 201);
  const token = started.data.token;
  assert.equal((await f.request('/runtime/status', { token })).data.remaining_calls, 2);
  assert.equal((await f.request('/messages', { method: 'POST', token, input: { text: 'Forbidden scope' } })).status, 403);
  assert.equal((await f.request('/me', { token })).status, 403);
  assert.equal((await f.request('/export', { token })).status, 403);
  assert.equal((await f.request('/operations/pause', { method: 'POST', token, input: { paused: true } })).status, 403);
  assert.equal((await f.request('/world', { token })).status, 200);
  assert.equal((await f.request('/runtime/status', { token })).data.remaining_calls, 1);
  assert.equal((await f.request('/move', { method: 'POST', token, input: { direction: 'right' } })).status, 200);
  assert.equal((await f.request('/world', { token })).status, 429);
  assert.equal((await f.request('/runtime/status', { token })).data.remaining_calls, 0);
  const wrongOwner = await f.request('/runtime/start', { method: 'POST', account: 'bob', input: { agent_id: agent.data.id } });
  assert.equal(wrongOwner.status, 404);
  const race = await f.request('/runtime/start', { method: 'POST', token: registration.data.token, input: { agent_id: agent.data.id, scopes: ['contribute'], max_calls: 1 } });
  const racingActions = await Promise.all([
    f.request('/jobs', { method: 'POST', token: race.data.token, input: { status: 'completed', detail: 'First competing action.' } }),
    f.request('/jobs', { method: 'POST', token: race.data.token, input: { status: 'completed', detail: 'Second competing action.' } }),
  ]);
  assert.deepEqual(racingActions.map((r) => r.status).sort(), [201, 429]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM jobs WHERE agent_id=?', agent.data.id).n, 1);
});

test('HTTP competing claims, retries, review corrections and public gallery complete the evidence workflow', async (t) => {
  const f = await httpFixture(t);
  const { task } = realMission(f);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const results = await Promise.all([
    f.request('/claims', { method: 'POST', account: 'alice', input: { task_id: task.id, agent_id: alice.id }, headers: { 'Idempotency-Key': 'http-alice-claim' } }),
    f.request('/claims', { method: 'POST', account: 'bob', input: { task_id: task.id, agent_id: bob.id }, headers: { 'Idempotency-Key': 'http-bob-claim' } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const winningIndex = results.findIndex((r) => r.status === 201);
  const winner = winningIndex === 0 ? 'alice' : 'bob';
  const winningAgent = winningIndex === 0 ? alice : bob;
  const claim = results[winningIndex].data;
  const retry = await f.request('/claims', { method: 'POST', account: winner, input: { task_id: task.id, agent_id: winningAgent.id }, headers: { 'Idempotency-Key': `http-${winner}-claim` } });
  assert.equal(retry.data.id, claim.id);
  const submission = await f.request('/submissions', { method: 'POST', account: winner, input: evidence(claim), headers: { 'Idempotency-Key': 'http-submit-1' } });
  assert.equal(submission.status, 201);
  const correction = await f.request('/reviews', { method: 'POST', account: 'reviewer', input: { submission_id: submission.data.id, decision: 'changes_requested', reason: 'Clarify geographic limitations.' } });
  assert.equal(correction.status, 201);
  const revised = await f.request('/submissions', { method: 'POST', account: winner, input: evidence(claim, { limitations: 'Limited to the area described in the source.' }), headers: { 'Idempotency-Key': 'http-submit-2' } });
  assert.equal(revised.data.version, 2);
  assert.equal((await f.request('/reviews', { method: 'POST', account: 'reviewer', input: { submission_id: revised.data.id, decision: 'accepted', reason: 'Approved after checking the fixture rubric.' } })).status, 201);
  const gallery = await f.request('/gallery');
  assert.equal(gallery.data[0].id, revised.data.id);
  assert.equal((await f.request('/world')).data.participants.find((a) => a.id === winningAgent.id).accepted_contributions, 1);
  assert.doesNotMatch(gallery.raw, /password|token|@example\.org/);
});

test('HTTP private conversations, exports and inert content preserve account boundaries', async (t) => {
  const f = await httpFixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const text = '<img src=x onerror="alert(document.cookie)"><script>fetch("/api/v1/export")</script>';
  const sent = await f.request('/messages', { method: 'POST', account: 'alice', input: { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text } });
  assert.equal(sent.status, 200);
  assert.equal((await f.request('/world')).data.messages.some((m) => m.id === sent.data.id), false);
  assert.equal((await f.request('/world', { account: 'reviewer' })).data.messages.some((m) => m.id === sent.data.id), false);
  const ownWorld = await f.request('/world', { account: 'bob' });
  assert.equal(ownWorld.data.messages.find((m) => m.id === sent.data.id).text, text);
  assert.match(ownWorld.headers.get('content-type'), /^application\/json/);
  assert.equal(ownWorld.headers.get('x-content-type-options'), 'nosniff');
  const html = await fetch(f.base);
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(html.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal((await html.text()).includes(text), false);
  const exported = await f.request(`/export?account_id=${f.actor('bob').account.id}`, { account: 'alice' });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.account.id, f.actor('alice').account.id);
  assert.doesNotMatch(exported.raw, /bob@example\.org|"password"|"token"|"hash"/);
  assert.equal((await f.request(`/accounts/${f.actor('bob').account.id}/export`, { account: 'alice' })).status, 404);
});

test('HTTP methods and malformed requests fail safely without exception details', async (t) => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/world', { method: 'POST', account: 'alice', input: {} })).status, 405);
  assert.equal((await f.request('/not-a-route')).status, 404);
  const head = await fetch(`${f.base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const badBody = await fetch(`${f.base}/api/v1/agents`, { method: 'POST', headers: { Authorization: `Bearer ${f.credentials.alice.token}`, 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(badBody.status, 400);
  const badType = await fetch(`${f.base}/api/v1/agents`, { method: 'POST', headers: { Authorization: `Bearer ${f.credentials.alice.token}`, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(badType.status, 415);
  assert.equal((await f.request('/claims', { method: 'POST', account: 'alice', input: { task_id: 'climate-practice' } })).status, 400);
  const originalWorld = f.platform.world;
  f.platform.world = () => { throw new Error('Sensitive fixture error password=do-not-expose'); };
  const failed = await f.request('/world');
  f.platform.world = originalWorld;
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.data, { error: 'Server error.' });
  assert.doesNotMatch(failed.raw, /Sensitive|password|stack|platform\.js/);
});
