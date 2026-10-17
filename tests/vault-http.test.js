import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

async function vaultFixture(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const request = async (route, { account, token, input } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null, raw, headers: response.headers };
  };
  return { ...f, request };
}
const SECRET = 'a private plan for the quiet orchard';

test('the vault routes honour the vault scope, the resident\'s own credential and the call budget', async (t) => {
  const f = await vaultFixture(t);
  const agent = f.agent('alice');
  const withScope = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'vault'], minutes: 5, max_calls: 30 });
  assert.equal((await f.request('/vault/write', { token: withScope.token, input: { slot: 1, text: SECRET } })).status, 200);
  const notes = await f.request('/vault/notes', { token: withScope.token });
  assert.equal(notes.status, 200); assert.equal(notes.data.notes[0].text, SECRET);
  assert.match(notes.headers.get('cache-control') || '', /no-store/);
  assert.equal((await f.request('/vault', { token: withScope.token })).data.notes, 1);
  // The operator's own session is not the resident: no read, no write, no enrolment.
  assert.equal((await f.request(`/vault/notes?agent_id=${agent.id}`, { account: 'alice' })).status, 403);
  assert.equal((await f.request('/vault/write', { account: 'alice', input: { agent_id: agent.id, slot: 1, text: 'edit' } })).status, 403);
  const status = await f.request(`/vault?agent_id=${agent.id}`, { account: 'alice' });
  assert.equal(status.status, 200); assert.equal(status.data.notes, 1); assert.ok(!status.raw.includes('orchard'));
  // Another operator learns nothing.
  assert.equal((await f.request(`/vault?agent_id=${agent.id}`, { account: 'bob' })).status, 404);
  assert.equal((await f.request('/vault/notes')).status, 401);
  // A resident credential without the vault scope cannot open the vault, even with `read`.
  const bobAgent = f.agent('bob');
  const plain = f.tx('runtime', f.actor('bob'), bobAgent.id, { scopes: ['read', 'contribute'], minutes: 5, max_calls: 30 });
  assert.equal((await f.request('/vault/notes', { token: plain.token })).status, 403);
  assert.equal((await f.request('/vault/write', { token: plain.token, input: { slot: 1, text: 'x' } })).status, 403);
  // A runtime credential cannot erase through the operator route; the operator can.
  assert.equal((await f.request('/vault/manage', { token: withScope.token, input: { agent_id: agent.id, action: 'erase', confirm: true } })).status, 403);
  assert.equal((await f.request('/vault/manage', { account: 'alice', input: { agent_id: agent.id, action: 'erase', confirm: true } })).status, 200);
  assert.equal((await f.request('/vault/notes', { token: withScope.token })).data.notes.length, 0);
  // Every successful vault call was charged to the resident's action budget.
  assert.ok(f.platform.get('SELECT used_calls FROM tokens WHERE hash=?', f.platform.authenticate(withScope.token).credential.hash).used_calls >= 4);
});

test('an unknown vault verb or a wrong method is refused', async (t) => {
  const f = await vaultFixture(t);
  const agent = f.agent('alice');
  const session = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'vault'], minutes: 5, max_calls: 30 });
  assert.equal((await f.request('/vault/read', { token: session.token })).status, 404);
  assert.equal((await f.request('/vault/notes', { token: session.token, input: {} })).status, 405);
  assert.equal((await f.request('/vault/write', { token: session.token })).status, 405);
  assert.equal((await f.request('/vault/write', { token: session.token, input: { slot: 1, text: 'ok', surprise: 1 } })).status, 400);
});
