import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';

// The repository has no browser automation, so the collaboration panel's own contract is verified
// here over real HTTP: the same routes, headers and JSON the panel sends, with the world payload it
// reads its grants from. The preview is asserted against a whole-database snapshot before and after.
const world = 'frontier:0:0', plot = 'plot:0:0:5:5';
const snapshot = (f) => {
  const tables = f.platform.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((row) => row.name);
  return JSON.stringify(tables.map((name) => [name, f.platform.all(`SELECT * FROM ${name}`)]));
};

test('the collaboration API grants, previews without writing, refuses runtimes and revokes live', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('landAssign', f.actor('alice'), { plot_id: plot, purpose: 'A shared learning garden', description: 'An isolated collaboration fixture.' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', world, 34, 33, bob.id);
  const app = createApp({ platform: f.platform });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const request = async (path, token, input) => {
    const response = await fetch(base + path, { method: input ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json', Origin: new URL(base).origin } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const aliceToken = f.credentials.alice.token, bobToken = f.credentials.bob.token;
  const input = { plot_id: plot, guest_agent_id: bob.id, purpose: 'Help lay the garden path', duration_minutes: 120, block_types: ['wood'], layers: [0], actions: ['place', 'remove'], max_blocks: 6 };
  // The panel reads its palette and its collaboration policy from the world payload.
  const view = await request(`/world?world_id=${world}&agent_id=${alice.id}`, aliceToken);
  assert.equal(view.status, 200);
  assert.deepEqual(view.data.frontier.grants.as_steward, []);
  assert.equal(view.data.frontier.grants.policy.scope, String(view.data.frontier.grants.policy.scope));
  assert.equal(view.data.frontier.grants.limits.max_blocks, 36);
  assert.equal(Array.isArray(view.data.frontier.palette), true);
  // A runtime credential is issued before the first snapshot, so every snapshot below compares the
  // collaboration routes only.
  const guestCredential = f.tx('runtime', f.actor('bob'), bob.id, { scopes: ['read', 'build'], max_calls: 30 });
  const before = snapshot(f);
  // A signed-out visitor cannot preview or create, and no route accepts a payment field.
  assert.equal((await request('/frontier/grants', null)).status, 401);
  assert.equal((await request('/frontier/grant', null, { ...input, preview: true })).status, 401);
  assert.equal((await request('/frontier/grant', aliceToken, { ...input, preview: true, payment: 0 })).status, 400);
  // The preview writes nothing and reports exactly what would be authorised.
  const preview = await request('/frontier/grant', aliceToken, { ...input, preview: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal([...JSON.stringify(preview.data).matchAll(/"writes":0/g)].length, 1);
  assert.equal(preview.data.writes, 0);
  assert.equal(preview.data.grant.plot_id, plot);
  assert.equal(preview.data.grant.guest.name, bob.name);
  assert.equal(preview.data.grant.purpose, 'Help lay the garden path');
  assert.deepEqual(preview.data.grant.scope, { block_types: ['wood'], layers: [0], actions: ['place', 'remove'], max_blocks: 6 });
  assert.equal(preview.data.grant.expires_at.length, 24);
  assert.equal(snapshot(f), before);
  // A runtime credential cannot create, preview or revoke a grant: the route itself refuses it.
  for (const path of ['/frontier/grant', '/frontier/grant/revoke']) {
    assert.equal((await request(path, guestCredential.token, input)).status, 403);
    assert.equal(snapshot(f), before);
  }
  // Neither can the guest operator: only the plot's own human steward grants building access.
  assert.equal((await request('/frontier/grant', bobToken, input)).status, 403);
  assert.equal((await request('/frontier/grants', guestCredential.token)).status, 403);
  assert.equal(snapshot(f), before);
  // The steward grants it, and the guest reads the live grant back from the world payload.
  const created = await request('/frontier/grant', aliceToken, input);
  assert.equal(created.status, 200);
  assert.equal(created.data.created, true);
  assert.equal(created.data.writes, 1);
  const grant = created.data.grant;
  const guestView = await request(`/world?world_id=${world}&agent_id=${bob.id}`, bobToken);
  assert.equal(guestView.data.frontier.grants.as_guest.length, 1);
  assert.equal(guestView.data.frontier.grants.as_guest[0].live, true);
  assert.equal(guestView.data.frontier.grants.as_guest[0].id, grant.id);
  assert.equal(guestView.data.frontier.grants.as_guest[0].guest_name, bob.name);
  assert.match(guestView.data.frontier.grants.as_guest[0].permissions, /up to 6 standing blocks/);
  assert.equal(JSON.stringify(guestView.data.frontier.grants).includes('@example.org'), false);
  // The guest's runtime builds through the ordinary route, and the block records the grant.
  f.advance();
  const built = await request('/frontier/build', guestCredential.token, { world_id: world, x: 32, y: 32, z: 0, type: 'wood' });
  assert.equal(built.status, 200, JSON.stringify(built));
  assert.equal(built.data.grant_id, grant.id);
  assert.equal(f.platform.get('SELECT grant_id,creator_account_id FROM frontier_blocks').grant_id, grant.id);
  // A revocation over HTTP ends access on the guest's very next build, with no cached-credential gap.
  f.advance();
  const revoked = await request('/frontier/grant/revoke', aliceToken, { grant_id: grant.id });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.revoked, true);
  assert.equal(revoked.data.grant.live, false);
  f.advance();
  const refused = await request('/frontier/build', guestCredential.token, { world_id: world, x: 33, y: 32, z: 0, type: 'wood' });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, 'Build inside your operator’s assigned land plot. A signed-in human must first steward an available plot for a named purpose, or that plot’s steward must grant you a live collaboration on it.');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 1);
  // The collaboration record and its append-only history are readable by the two operators only.
  const record = await request(`/frontier/grants?plot_id=${plot}`, aliceToken);
  assert.equal(record.status, 200);
  assert.equal(record.data.as_steward.length, 1);
  assert.equal(record.data.as_steward[0].status, 'revoked');
  assert.deepEqual(record.data.events.map(event => event.action).sort(), ['create', 'revoke']);
  assert.equal(record.data.my_plot.id, plot);
  assert.equal(record.data.policy.land.startsWith('A grant conveys no stewardship'), true);
  const guestRecord = await request('/frontier/grants', bobToken);
  assert.equal(guestRecord.status, 200);
  assert.equal(guestRecord.data.as_guest.length, 1);
  assert.equal(guestRecord.data.as_steward.length, 0);
  // Stewardship, the registry and the coin ledger are untouched by the whole exchange.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n, 16384);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.verifyAudit(), true);
});
