// The write contract, enforced against the real server over real HTTP: what an anonymous caller may
// not do, what a read-scoped runtime credential may not do, what no runtime credential may reach, and
// what every write must record. The declared policy it checks is `src/framework/write-contract.js`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writesFixture, RUNTIME_SCOPES } from './framework/writes-harness.js';
import { WRITE_ROUTES, policyFor, declaredRoutes } from '../src/framework/write-contract.js';

// A route path with its `:id` filled in, so a declared route can be addressed by a concrete request.
const pathOf = (entry, id) => entry.route.replace(':id', id);

test('every declared write refuses an unauthenticated caller with 401 or 403', async (t) => {
  const f = await writesFixture(t);
  const failures = [];
  for (const entry of WRITE_ROUTES) {
    if (entry.public) continue; // The two authentication writes are public by design.
    const response = await f.request(pathOf(entry, 'nobody'), { method: entry.method, input: {} });
    if (![401, 403].includes(response.status)) failures.push(`${entry.method} ${entry.route} → ${response.status} ${response.error || ''}`);
  }
  assert.deepEqual(failures, [], `unauthenticated writes were not refused: ${failures.join('; ')}`);
});

test('a read-scoped runtime credential cannot perform any write that needs a write scope', async (t) => {
  const f = await writesFixture(t);
  const resident = f.tx('createAgent', f.actor('admin'), { name: 'read-scope resident', kind: 'agent', capabilities: 'Read approved sources', limitations: 'Fixture bounds' });
  const readOnly = f.tx('runtime', f.actor('admin'), resident.id, { scopes: ['read'], max_calls: 500, minutes: 20 }).token;
  const failures = [];
  for (const entry of WRITE_ROUTES) {
    if (entry.scope === null || entry.scope === 'read' || entry.public) continue; // null is operator-only, checked below.
    const response = await f.request(pathOf(entry, resident.id), { method: entry.method, token: readOnly, input: {} });
    if (![401, 403].includes(response.status)) failures.push(`${entry.method} ${entry.route} (needs ${entry.scope}) → ${response.status}`);
  }
  assert.deepEqual(failures, [], `a read-scoped credential reached a write scope: ${failures.join('; ')}`);

  // The one declared exception, asserted rather than assumed: presence is documented as a read-scope
  // write (docs/API.md "POST /agents/:id/heartbeat | read"), pinned by tests/spaces-http.test.js:74,
  // and the resident client heartbeats every 20 s as a read action (app.js:2657). This wave leaves
  // the mapping alone because the evidence says read-scoped presence is intended policy; the
  // invariant it violates is reproduced by tests/framework/known-gaps.mjs.
  const heartbeat = policyFor('/agents/:id/heartbeat');
  assert.equal(heartbeat.scope, 'read');
  assert.equal(heartbeat.read_scope_write, true, 'the escalation must stay declared');
  const before = f.platform.get('SELECT last_seen FROM agents WHERE id=?', resident.id).last_seen;
  f.advance(1_000);
  const answered = await f.request(`/agents/${resident.id}/heartbeat`, { method: 'POST', token: readOnly, input: {} });
  assert.equal(answered.status, 200, 'the documented read-scope presence write');
  assert.equal(f.platform.get('SELECT last_seen FROM agents WHERE id=?', resident.id).last_seen, f.clock(), 'the read-scoped write is durable, not merely answered');
  assert.notEqual(before, f.clock());
});

test('no runtime credential reaches the operator-only surfaces, even holding every scope', async (t) => {
  const f = await writesFixture(t);
  const resident = f.tx('createAgent', f.actor('admin'), { name: 'every-scope resident', kind: 'agent', capabilities: 'Read approved sources', limitations: 'Fixture bounds' });
  const every = f.tx('runtime', f.actor('admin'), resident.id, { scopes: [...RUNTIME_SCOPES.every], max_calls: 500, minutes: 20 }).token;
  const failures = [];
  for (const entry of WRITE_ROUTES) {
    if (!entry.operator_only) continue;
    const response = await f.request(pathOf(entry, resident.id), { method: entry.method, token: every, input: {} });
    if (![401, 403].includes(response.status)) failures.push(`${entry.method} ${entry.route} → ${response.status}`);
  }
  assert.deepEqual(failures, [], `a runtime credential reached an operator-only write: ${failures.join('; ')}`);

  // The operator-only reads `server.js` names beside those writes in the same refusal.
  for (const route of ['/workers', '/me', '/export', '/operations', '/safety', '/drafts']) {
    const response = await f.request(route, { method: 'GET', token: every });
    assert.ok([401, 403].includes(response.status), `GET ${route} must refuse a runtime credential, answered ${response.status}`);
  }
  assert.ok(declaredRoutes().length === WRITE_ROUTES.length);
});
