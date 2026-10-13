import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Platform } from '../src/platform.js';
import { GRANT_SCOPE_LIMITS, PLOT_GRANT_POLICY, LAND_BLOCK_GUARDS, PLOT_GRANT_SCHEMA } from '../src/frontier.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';
import { walkable } from '../world.js';
import { fixture } from './helpers.js';

const world = 'frontier:0:0', plot = 'plot:0:0:5:5';
// Fixed, asserted fixture tiles inside plot 5,5 (x 30–35, y 30–35), all within the six-tile build
// range of the guest's post at 34, 33.
const base = { x: 32, y: 32 }, east = { x: 33, y: 32 }, west = { x: 31, y: 32 }, north = { x: 32, y: 31 }, south = { x: 32, y: 33 }, post = { x: 34, y: 33 };
for (const tile of [base, east, west, north, south, post]) assert.equal(walkable(tile, world), true, `fixture tile ${tile.x},${tile.y} is walkable`);
const day = (f) => `${new Date(f.clock()).toISOString().slice(0, 10)}T00:00:00.000Z`;
const stand = (f, agent, position) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', world, position.x, position.y, agent.id);
const steward = (f, owner = 'alice') => f.tx('landAssign', f.actor(owner), { plot_id: plot, purpose: 'A shared learning garden', description: 'A collaboration fixture.' });
const grantInput = (guest, changes = {}) => ({ plot_id: plot, guest_agent_id: guest.id, purpose: 'Help lay the garden path', duration_minutes: 120, block_types: ['wood', 'path'], layers: [0, 1], actions: ['place', 'remove'], max_blocks: 4, ...changes });
const grantFor = (f, guest, changes = {}, owner = 'alice') => f.tx('plotGrantCreate', f.actor(owner), grantInput(guest, changes));
const build = (f, actor, agent, position, changes = {}) => f.tx('frontierBuild', actor, agent.id, { world_id: world, ...position, z: 0, type: 'wood', ...changes });
const standing = (f, id) => f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE grant_id=?', id).n;
const blocks = (f) => f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n;
const actionsFor = (f, name) => f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions WHERE account_id=? AND created_at>=?', f.actor(name).account.id, day(f)).n;
const runtimeFor = (f, name, agent, scopes = ['read', 'build']) => f.platform.authenticate(f.tx('runtime', f.actor(name), agent.id, { scopes, max_calls: 40 }).token, 'build');
/** Every row of every table, so "no writes" is asserted against the whole database. */
const snapshot = (f) => {
  const tables = f.platform.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((row) => row.name);
  return JSON.stringify(tables.map((name) => [name, f.platform.all(`SELECT * FROM ${name}`)]));
};
const tableSnapshot = (f, table) => JSON.stringify(f.platform.all(`SELECT * FROM ${table} ORDER BY rowid`));
// The plot guard exactly as schema 18 shipped it: stewardship only, with no collaboration path.
const SCHEMA_18_GUARD = `CREATE TRIGGER IF NOT EXISTS frontier_blocks_plot_insert BEFORE INSERT ON frontier_blocks WHEN NEW.plot_id IS NULL OR NOT EXISTS(SELECT 1 FROM land_parcels p JOIN land_stewardships s ON s.plot_id=p.id JOIN agents a ON a.id=NEW.creator_agent_id JOIN accounts o ON o.id=NEW.creator_account_id WHERE p.id=NEW.plot_id AND p.reserved=0 AND p.world_id=NEW.world_id AND NEW.x>=p.x AND NEW.x<p.x+6 AND NEW.y>=p.y AND NEW.y<p.y+6 AND s.account_id=NEW.creator_account_id AND a.operator_id=NEW.creator_account_id AND a.status='active' AND o.status='active') BEGIN SELECT RAISE(ABORT,'Building requires operator land stewardship'); END;`;

test('a collaboration grant names one plot, one guest, a stated purpose and a deliberately narrow scope', async t => {
  const f = await fixture(t), bob = f.agent('bob'), second = f.agent('bob', 'Second bob resident');
  const bobAccount = f.actor('bob').account.id;
  steward(f);
  assert.equal(GRANT_SCOPE_LIMITS.block_types, 4);
  assert.equal(GRANT_SCOPE_LIMITS.layers, 2);
  assert.equal(GRANT_SCOPE_LIMITS.max_blocks, 36);
  assert.equal(GRANT_SCOPE_LIMITS.duration_minutes_max, 20160);
  assert.match(PLOT_GRANT_POLICY.scope, /at most 4 block types, at most 2 layers/);
  assert.match(PLOT_GRANT_POLICY.creator, /Only the plot’s signed-in human steward/);
  assert.match(PLOT_GRANT_POLICY.budget, /guest operator’s own daily frontier actions/);
  // Creating, extending and re-granting are human-steward actions: no runtime credential, no other
  // operator and no signed-out visitor can reach them.
  const runtime = runtimeFor(f, 'bob', bob);
  for (const actor of [null, f.actor('bob'), runtime]) assert.throws(() => f.tx('plotGrantCreate', actor, grantInput(bob)), { status: 403 });
  for (const actor of [null, f.actor('bob'), runtime]) assert.throws(() => f.tx('plotGrantPreview', actor, grantInput(bob)), { status: 403 });
  // The guest may be named as one resident, or as one operator, never as both, never as itself.
  assert.equal(f.tx('plotGrantPreview', f.actor('alice'), grantInput(bob)).grant.guest.name, bob.name);
  assert.equal(f.tx('plotGrantPreview', f.actor('alice'), { ...grantInput(bob), guest_agent_id: '', guest_account_id: f.actor('bob').account.id }).grant.guest.agent_id, null);
  const before = snapshot(f);
  for (const changes of [
    { guest_agent_id: '', guest_account_id: '' }, { guest_agent_id: bob.id, guest_account_id: f.actor('bob').account.id },
    { guest_agent_id: '', guest_account_id: f.actor('alice').account.id },
    { purpose: '' }, { purpose: 'a'.repeat(121) }, { purpose: '   ' },
    { duration_minutes: 14 }, { duration_minutes: 20161 }, { duration_minutes: 'two hours' },
    { block_types: [] }, { block_types: ['wood', 'stone', 'glass', 'brick', 'sand'] }, { block_types: ['script'] }, { block_types: ['wood', 'wood'] },
    { layers: [] }, { layers: [0, 1, 2] }, { layers: [8] }, { layers: ['0'] },
    { actions: [] }, { actions: ['remove'] }, { actions: ['place', 'demolish'] },
    { max_blocks: 0 }, { max_blocks: 37 }, { max_blocks: 4.5 },
    { payment: 0 }, { transfer: true }, { account_id: f.actor('bob').account.id }, { role: 'admin' },
  ]) assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), grantInput(bob, changes)), { status: 400 }, JSON.stringify(changes));
  assert.equal(snapshot(f), before, 'no refused preview writes anything');
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), grantInput(bob, { guest_agent_id: 'unknown-resident' })), { status: 404 });
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), { ...grantInput(bob), guest_agent_id: '', guest_account_id: 'unknown-operator' }), { status: 404 });
  // A plot's own steward is required, and an inactive guest operator cannot be invited.
  assert.throws(() => grantFor(f, second, {}, 'bob'), { status: 403 });
  f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", bobAccount);
  assert.throws(() => grantFor(f, bob), { status: 409 });
  f.platform.run("UPDATE accounts SET status='active' WHERE id=?", bobAccount);
  const created = grantFor(f, bob);
  assert.equal(created.created, true);
  assert.equal(created.writes, 1);
  assert.equal(created.changed, true);
  assert.equal(created.grant.status, 'active');
  assert.deepEqual(created.grant.scope, { block_types: ['path', 'wood'], layers: [0, 1], actions: ['place', 'remove'], max_blocks: 4 });
  assert.match(created.grant.permissions, /May place and remove path, wood on layers 0 and 1, up to 4 standing blocks/);
  assert.equal(Date.parse(created.grant.expires_at) - Date.parse(created.grant.created_at), 120 * 60000);
  assert.equal(f.platform.get('SELECT uses,last_used_at FROM plot_grants').last_used_at, '');
  // One live grant per plot, guest and resident: a second identical grant is refused until the
  // first is revoked, while a different resident of the same operator is a separate invitation.
  assert.throws(() => grantFor(f, bob), { status: 409 });
  f.advance(2000);
  assert.equal(grantFor(f, second, { guest_agent_id: second.id, block_types: ['glass'], layers: [2], actions: ['place'], max_blocks: 1 }).created, true);
  const listed = f.tx('plotGrants', f.actor('alice'));
  assert.equal(listed.as_steward.length, 2);
  assert.equal(listed.as_guest.length, 0);
  assert.equal(listed.events.filter((event) => event.action === 'create').length, 2);
  assert.equal(listed.policy.scope, PLOT_GRANT_POLICY.scope);
  assert.equal(listed.limits.max_blocks, 36);
  assert.equal(listed.my_plot.id, plot);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a preview reports the exact access, writes nothing and refuses outside the stewarded plot', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f);
  const before = snapshot(f);
  const preview = f.tx('plotGrantPreview', f.actor('alice'), grantInput(bob, { max_blocks: 12, duration_minutes: 1440 }));
  assert.equal(preview.writes, 0);
  assert.equal(preview.grant.plot_id, plot);
  assert.equal(preview.grant.plot_address, 'Area 0, 0 · Plot 6, 6');
  assert.equal(preview.grant.plot_purpose, 'A shared learning garden');
  assert.equal(preview.grant.purpose, 'Help lay the garden path');
  assert.equal(preview.grant.duration_minutes, 1440);
  assert.deepEqual(preview.grant.scope, { block_types: ['path', 'wood'], layers: [0, 1], actions: ['place', 'remove'], max_blocks: 12 });
  assert.equal(preview.grant.steward.name, 'alice');
  assert.equal(preview.grant.guest.name, bob.name);
  assert.equal(preview.grant.guest.operator, 'bob');
  assert.equal(preview.grant.used_blocks, 0);
  assert.equal(preview.grant.status, 'active');
  assert.equal(preview.grant.expires_at.length, 24);
  assert.equal(JSON.stringify(preview).includes('@example.org'), false, 'no contact detail is exposed');
  assert.equal(snapshot(f), before, 'a valid preview writes nothing at all');
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), { ...grantInput(bob), plot_id: 'plot:0:0:1:1' }), { status: 403 });
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), { ...grantInput(bob), plot_id: 'plot:0:0:05:5' }), { status: 400 });
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), { ...grantInput(bob), plot_id: 'plot:8:0:1:1' }), { status: 400 });
  assert.equal(snapshot(f), before, 'no refused preview writes anything either');
  f.platform.run('UPDATE settings SET value=? WHERE key=?', 'true', 'paused');
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), grantInput(bob)), { status: 503 });
  f.platform.run('UPDATE settings SET value=? WHERE key=?', 'false', 'paused');
  f.advance(2000);
  f.tx('landRelease', f.actor('alice'), { plot_id: plot });
  assert.throws(() => f.tx('plotGrantPreview', f.actor('alice'), grantInput(bob)), { status: 403 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM plot_grants').n, 0);
});

test('a guest builds inside the granted scope while every existing rule still applies', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  steward(f); stand(f, alice, post); stand(f, bob, post);
  // Before the grant the guest is refused exactly as before.
  assert.throws(() => build(f, f.actor('bob'), bob, base), { status: 403 });
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0, 1], max_blocks: 12 });
  const guest = build(f, f.actor('bob'), bob, base);
  assert.equal(guest.changed, true);
  assert.equal(guest.grant_id, created.grant.id);
  assert.equal(guest.plot_id, plot);
  assert.deepEqual({ ...f.platform.get('SELECT plot_id,grant_id,creator_account_id FROM frontier_blocks') }, { plot_id: plot, grant_id: created.grant.id, creator_account_id: f.actor('bob').account.id });
  // The same guest may replay the same block and may stack on the plot's own foundation.
  assert.equal(build(f, f.actor('bob'), bob, base).changed, false);
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base, { z: 1 }).changed, true);
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base, { z: 1, remove: true }).removed, true);
  // Out of scope: another block type, another layer, another plot, another operator's land.
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, east, { type: 'stone' }), { status: 403, message: /stone block is outside/ });
  assert.throws(() => build(f, f.actor('bob'), bob, east, { z: 4 }), { status: 403, message: /Layer 4 is outside/ });
  const outside = f.platform.land(f.actor('bob'), { world_id: world, status: 'available', limit: 5 }).plots.find((item) => walkable({ x: item.x + 1, y: item.y + 2 }, world));
  assert.ok(outside, 'an unassigned plot exists to prove the plot boundary is still enforced');
  stand(f, bob, { x: outside.x + 1, y: outside.y + 1 });
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, { x: outside.x + 1, y: outside.y + 2 }), { status: 403 });
  // Shared access and the build range still apply to a guest.
  stand(f, bob, { x: 24, y: 32 });
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, { x: 24, y: 33 }), { status: 409, message: /public passages/ });
  assert.throws(() => build(f, f.actor('bob'), bob, { x: 40, y: 40 }), { status: 409, message: /Walk closer/ });
  // Occupied cells still apply to a guest.
  stand(f, bob, post); stand(f, alice, west);
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, west), { status: 409, message: /occupied resident tiles/ });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.verifyAudit(), true);
});

test('a guest cannot close a second layer around a resident either', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  steward(f); stand(f, alice, base); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0, 1], max_blocks: 12 });
  for (const side of [east, west, north, south]) { f.advance(); assert.equal(build(f, f.actor('bob'), bob, side).changed, true, 'one climbable layer is not a trap'); }
  for (const side of [east, west, north]) { f.advance(); assert.equal(build(f, f.actor('bob'), bob, side, { z: 1 }).changed, true); }
  const before = snapshot(f);
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, south, { z: 1 }), { status: 409, message: /cut a resident off/ });
  assert.equal(snapshot(f), before, 'the refused trap writes nothing');
  assert.equal(standing(f, created.grant.id), 7);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n, 7);
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, south, { z: 1, remove: true }).removed, false, 'a removal that never happened reports no change');
  assert.equal(build(f, f.actor('bob'), bob, north, { z: 1, remove: true }).removed, true, 'the guest can still open their own wall');
  assert.equal(f.platform.verifyAudit(), true);
});

test('the granted maximum of standing blocks is enforced from the live count, and the guard agrees', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 2 });
  f.advance(); assert.equal(build(f, f.actor('bob'), bob, base).changed, true);
  assert.equal(standing(f, created.grant.id), 1);
  f.advance(); assert.equal(build(f, f.actor('bob'), bob, east).changed, true);
  assert.equal(standing(f, created.grant.id), 2);
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, north), { status: 403, message: /allows 2 standing blocks and they are all placed/ });
  assert.equal(standing(f, created.grant.id), 2);
  // The storage guard reads the same standing count, so a writer that skipped the method cannot
  // place beyond the grant's maximum either.
  f.advance();
  assert.throws(() => f.platform.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id,grant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'over-cap', world, north.x, north.y, 0, 'wood', bob.id, f.actor('bob').account.id, new Date(f.clock()).toISOString(), plot, created.grant.id), /stewardship or a live plot collaboration grant/);
  // Removing the guest's own block frees the allowance again.
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base, { remove: true }).removed, true);
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, north).changed, true);
  assert.equal(standing(f, created.grant.id), 2);
  assert.equal(blocks(f), 2);
});

test('a guest build spends the guest’s own daily budget and interval, and never the steward’s', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  steward(f); stand(f, alice, post); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  f.advance();
  build(f, f.actor('bob'), bob, base);
  assert.equal(actionsFor(f, 'bob'), 1, 'the action ledger records the account that made the write');
  assert.equal(actionsFor(f, 'alice'), 0, 'the steward’s daily budget is untouched by a guest');
  assert.equal(f.platform.get('SELECT uses FROM plot_grants WHERE id=?', created.grant.id).uses, 1);
  assert.equal(f.platform.get('SELECT last_used_at FROM plot_grants WHERE id=?', created.grant.id).last_used_at.length, 24);
  // The 200 ms interval is the guest's own, and the steward can build in the same instant.
  assert.throws(() => build(f, f.actor('bob'), bob, east), { status: 429, message: /moment between building actions/ });
  f.advance(2000);
  assert.equal(f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id: world, ...west, z: 0, type: 'grass' }).changed, true);
  assert.equal(actionsFor(f, 'alice'), 1);
  // A guest who has spent the whole day is refused by the existing daily limit; the steward is not.
  f.platform.transaction(() => { for (let n = 0; n < 500; n++) f.platform.run('INSERT INTO frontier_actions VALUES(?,?,?,?,?,?)', `guest-action-${n}`, f.actor('bob').account.id, bob.id, world, 'place', new Date(f.clock() - 1000).toISOString()); });
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, east), { status: 429, message: /daily frontier action limit/ });
  assert.equal(blocks(f), 2);
});

test('revocation is read live, so a credential cached before the revoke cannot build', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  const cached = runtimeFor(f, 'bob', bob);
  f.advance();
  assert.equal(build(f, cached, bob, base).changed, true);
  f.advance();
  const revoked = f.tx('plotGrantRevoke', f.actor('alice'), { grant_id: created.grant.id });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.writes, 1);
  assert.equal(revoked.grant.live, false);
  assert.equal(revoked.grant.status, 'revoked');
  // The very same credential value — the same actor object — is refused on the next build.
  assert.throws(() => build(f, cached, bob, east), { status: 403, message: /steward must grant you a live collaboration/ });
  // A guest can still take their own block down, so construction is never stranded on the plot.
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base, { remove: true }).removed, true);
  f.advance();
  assert.throws(() => build(f, cached, bob, base), { status: 403 });
  // Re-granting is the steward's alone, and it is a new fact with a new identity.
  f.advance();
  const again = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  assert.notEqual(again.grant.id, created.grant.id);
  f.advance();
  assert.equal(build(f, cached, bob, base).changed, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM plot_grant_events WHERE plot_id=?', plot).n, 3);
  assert.equal(f.platform.get('SELECT status FROM plot_grants WHERE id=?', created.grant.id).status, 'revoked');
});

test('expiry ends a grant by itself, and a paused or suspended party loses access too', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  const bobAccount = f.actor('bob').account.id, aliceAccount = f.actor('alice').account.id;
  steward(f); stand(f, bob, post);
  const created = grantFor(f, bob, { duration_minutes: 60, block_types: ['wood'], layers: [0], max_blocks: 12 });
  f.advance(120);
  assert.equal(build(f, f.actor('bob'), bob, base).changed, true);
  assert.equal(f.platform.get('SELECT status FROM plot_grants').status, 'active');
  f.advance(3600000);
  assert.throws(() => build(f, f.actor('bob'), bob, east), { status: 403 });
  const listing = f.tx('plotGrants', f.actor('alice')).as_steward.find((row) => row.id === created.grant.id);
  assert.equal(listing.live, false);
  assert.equal(listing.status, 'expired');
  assert.equal(f.tx('plotGrants', f.actor('bob')).as_guest[0].status, 'expired');
  assert.equal(f.platform.get('SELECT status FROM plot_grants').status, 'active', 'the row keeps its status until it is closed');
  // An expired grant is closed on the record when the steward grants again: it is never extended.
  f.advance(2000);
  const live = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  assert.equal(live.created, true);
  assert.equal(f.platform.get('SELECT status FROM plot_grants WHERE id=?', created.grant.id).status, 'revoked');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM plot_grant_events WHERE grant_id=? AND action='revoke'", created.grant.id).n, 1);
  assert.equal(build(f, f.actor('bob'), bob, east).changed, true);
  // Pausing the guest resident, suspending either operator and losing the stewardship each end
  // access immediately, because the grant is only ever read together with their live state.
  f.advance();
  f.platform.run("UPDATE agents SET status='paused' WHERE id=?", bob.id);
  assert.throws(() => build(f, f.actor('bob'), bob, north), { status: 403, message: /paused/ });
  f.platform.run("UPDATE agents SET status='active' WHERE id=?", bob.id);
  f.advance();
  f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", bobAccount);
  assert.throws(() => build(f, f.actor('bob'), bob, north), { status: 403 });
  f.platform.run("UPDATE accounts SET status='active' WHERE id=?", bobAccount);
  f.advance();
  f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", aliceAccount);
  assert.throws(() => build(f, f.actor('bob'), bob, north), { status: 403, message: /live collaboration/ });
  f.platform.run("UPDATE accounts SET status='active' WHERE id=?", aliceAccount);
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, north).changed, true);
  assert.equal(live.grant.status, 'active');
  assert.equal(live.replaces, created.grant.id, 'the expired grant is closed and replaced, never extended');
});

test('a grant is revoked when its plot is released or its steward is removed', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  steward(f); stand(f, alice, post); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  f.advance(); build(f, f.actor('bob'), bob, base);
  // A plot with live collaboration cannot be released while the guest's construction stands.
  assert.throws(() => f.tx('landRelease', f.actor('alice'), { plot_id: plot }), { status: 409 });
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base, { remove: true }).removed, true);
  f.advance();
  assert.equal(f.tx('landRelease', f.actor('alice'), { plot_id: plot }).released, true);
  assert.equal(f.platform.get('SELECT status FROM plot_grants WHERE id=?', created.grant.id).status, 'revoked');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM plot_grant_events WHERE grant_id=? AND action='revoke'", created.grant.id).n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, base), { status: 403 });
  // A stewardship removed directly, as account removal does, revokes its grants at storage level.
  f.advance();
  assert.equal(f.tx('landAssign', f.actor('alice'), { plot_id: plot, purpose: 'Second purpose' }).assigned, true);
  f.advance();
  const again = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base).changed, true);
  f.platform.transaction(() => f.platform.deleteAccount(f.actor('alice')));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  const removed = f.platform.get('SELECT status,revoked_at,revoked_by FROM plot_grants WHERE id=?', again.grant.id);
  assert.equal(removed.status, 'revoked');
  assert.equal(removed.revoked_at.length, 24);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM plot_grant_events WHERE grant_id=? AND action='revoke'", again.grant.id).n, 1);
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, east), { status: 403 });
  // The guest's construction is preserved for cleanup, and the land registry is untouched.
  assert.equal(blocks(f), 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n, 16384);
  assert.equal(f.platform.verifyAudit(), true);
});

test('guests cannot grant access onward, acquire land or sub-let', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f);
  grantFor(f, bob);
  const guestSession = f.actor('bob');
  const guestCredential = runtimeFor(f, 'bob', bob);
  const held = f.platform.get('SELECT id FROM plot_grants');
  for (const actor of [guestSession, guestCredential]) {
    assert.throws(() => f.tx('plotGrantCreate', actor, grantInput(bob)), { status: 403 }, 'a guest cannot create a grant');
    assert.throws(() => f.tx('plotGrantPreview', actor, grantInput(bob)), { status: 403 });
    assert.throws(() => f.tx('plotGrantRevoke', actor, { grant_id: held.id }), { status: 403 }, 'a guest cannot revoke the grant that lets them build');
  }
  assert.throws(() => f.tx('landAssign', guestCredential, { plot_id: 'plot:0:0:1:1', purpose: 'Agent acquisition' }), { status: 403 }, 'a runtime cannot acquire land');
  assert.throws(() => f.tx('plotGrants', guestCredential), { status: 403 }, 'a runtime cannot read the collaboration record');
  assert.throws(() => f.tx('landRelease', guestSession, { plot_id: plot }), { status: 403 });
  assert.throws(() => f.tx('landAssign', guestSession, { plot_id: plot, purpose: 'Take the granted plot' }), { status: 409 });
  assert.equal(f.platform.get('SELECT account_id FROM land_stewardships').account_id, f.actor('alice').account.id);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM plot_grants').n, 1);
  // A grant conveys no blueprint right either, and the refusal says so plainly.
  stand(f, bob, post);
  assert.throws(() => f.tx('frontierBuild', guestSession, bob.id, { world_id: world, blueprint: 'garden-shelter', x: 31, y: 31 }), { status: 403, message: /Blueprints belong to the plot’s steward/ });
  // The collaboration record is visible only to the two operators concerned.
  assert.equal(f.tx('plotGrants', guestSession).as_guest.length, 1);
  assert.equal(f.tx('plotGrants', guestSession).as_steward.length, 0);
  assert.equal(f.tx('plotGrants', f.actor('alice')).as_guest.length, 0);
  assert.equal(f.tx('plotGrants', guestSession).events.length, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a grant changes neither the stewardship record nor the finite land registry', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f); stand(f, bob, post);
  const registry = tableSnapshot(f, 'land_parcels'), stewardships = tableSnapshot(f, 'land_stewardships');
  const sectors = tableSnapshot(f, 'frontier_sectors'), summary = JSON.stringify(f.platform.landSummary());
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  f.advance(); build(f, f.actor('bob'), bob, base);
  f.advance(); f.tx('plotGrantRevoke', f.actor('alice'), { grant_id: created.grant.id });
  assert.equal(tableSnapshot(f, 'land_parcels'), registry, 'the 16,384-slot registry is not rewritten');
  assert.equal(tableSnapshot(f, 'land_stewardships'), stewardships, 'stewardship is not rewritten');
  assert.equal(tableSnapshot(f, 'frontier_sectors'), sectors, 'area counts are unchanged');
  assert.equal(JSON.stringify(f.platform.landSummary()), summary, 'every registry count is unchanged');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n, 16384);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_events').n, 1, 'only the assignment event exists');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('grants and their history are append-only, and stored rows keep their meaning', async t => {
  const f = await fixture(t), bob = f.agent('bob'), aliceResident = f.agent('alice', 'Alice resident');
  steward(f);
  const created = grantFor(f, bob);
  const before = snapshot(f);
  assert.throws(() => f.platform.run('UPDATE plot_grants SET scope=? WHERE id=?', JSON.stringify({ block_types: ['wood', 'stone', 'glass', 'brick'], layers: [0, 1], actions: ['place'], max_blocks: 36 }), created.grant.id), /never rewritten/);
  assert.throws(() => f.platform.run('UPDATE plot_grants SET expires_at=? WHERE id=?', '2099-01-01T00:00:00.000Z', created.grant.id), /never rewritten/);
  assert.throws(() => f.platform.run('UPDATE plot_grants SET purpose=? WHERE id=?', 'A later purpose', created.grant.id), /never rewritten/);
  assert.throws(() => f.platform.run('DELETE FROM plot_grants WHERE id=?', created.grant.id), /recorded history/);
  assert.throws(() => f.platform.run("UPDATE plot_grant_events SET detail='edited'"), /append-only/);
  assert.throws(() => f.platform.run('DELETE FROM plot_grant_events'), /append-only/);
  assert.equal(snapshot(f), before);
  const insert = (id, changes) => f.platform.run('INSERT INTO plot_grants(id,plot_id,steward_account_id,guest_account_id,guest_agent_id,purpose,scope,expires_at,created_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)', id, plot, f.actor('alice').account.id, changes.guest ?? f.actor('bob').account.id, changes.agent ?? bob.id, 'A stored grant', changes.scope, changes.expires_at ?? '2099-01-01T00:00:00.000Z', changes.created_at ?? new Date(f.clock()).toISOString(), 'active');
  const narrow = JSON.stringify({ block_types: ['wood'], layers: [0], actions: ['place'], max_blocks: 4 });
  assert.throws(() => insert('bypass-wide', { scope: JSON.stringify({ block_types: ['wood', 'stone', 'glass', 'brick', 'sand'], layers: [0, 1], actions: ['place'], max_blocks: 4 }) }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-layers', { scope: JSON.stringify({ block_types: ['wood'], layers: [0, 1, 2], actions: ['place'], max_blocks: 4 }) }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-actions', { scope: JSON.stringify({ block_types: ['wood'], layers: [0], actions: ['remove'], max_blocks: 4 }) }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-cap', { scope: JSON.stringify({ block_types: ['wood'], layers: [0], actions: ['place'], max_blocks: 37 }) }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-loose', { scope: narrow.replace('"max_blocks":4', '"max_blocks":4,"extra":true') }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-self', { scope: narrow, guest: f.actor('alice').account.id, agent: '' }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-forever', { scope: narrow, expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z' }), /Invalid plot collaboration grant/);
  assert.throws(() => insert('bypass-stranger', { scope: narrow, agent: aliceResident.id }), /Invalid plot collaboration grant/);
  assert.equal(snapshot(f), before);
  // The plot guard refuses a guest block that no live grant covers, or that falls outside the plot.
  stand(f, bob, post);
  const block = (id, x, y, grant = null) => f.platform.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id,grant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, world, x, y, 0, 'wood', bob.id, f.actor('bob').account.id, new Date(f.clock()).toISOString(), plot, grant);
  assert.throws(() => block('bypass-block', base.x, base.y), /stewardship or a live plot collaboration grant/);
  assert.throws(() => block('bypass-outside', 29, 34, created.grant.id), /stewardship or a live plot collaboration grant/);
  f.platform.db.exec('DROP TRIGGER frontier_blocks_plot_insert');
  block('bypass-block', base.x, base.y, created.grant.id);
  assert.equal(f.platform.get('SELECT grant_id FROM frontier_blocks WHERE id=?', 'bypass-block').grant_id, created.grant.id);
  f.platform.db.exec(LAND_BLOCK_GUARDS);
  f.platform.run('UPDATE frontier_blocks SET creator_agent_id=?,creator_account_id=? WHERE id=?', aliceResident.id, f.actor('alice').account.id, 'bypass-block');
  assert.throws(() => validateDatabase(f.database), /collaboration construction is invalid/);
  f.platform.run('DELETE FROM frontier_blocks WHERE id=?', 'bypass-block');
  assert.equal(validateDatabase(f.database).schema_version, 19);
});

test('racing grants, a revoke mid-build and a repeated revoke stay atomic', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  const beforeSecond = snapshot(f);
  assert.throws(() => f.platform.transaction(() => { f.platform.plotGrantCreate(f.actor('alice'), grantInput(bob)); }), { status: 409 });
  assert.equal(snapshot(f), beforeSecond);
  // A revocation in the middle of a build: the build is refused and the whole transaction — the
  // revocation it contained included — rolls back, so no half-applied state survives.
  const beforeMidBuild = snapshot(f);
  f.advance(2000);
  assert.throws(() => f.platform.transaction(() => { f.platform.plotGrantRevoke(f.actor('alice'), { grant_id: created.grant.id }); f.platform.frontierBuild(f.actor('bob'), bob.id, { world_id: world, ...base, z: 0, type: 'wood' }); }), { status: 403 });
  assert.equal(snapshot(f), beforeMidBuild);
  assert.equal(f.platform.get('SELECT status FROM plot_grants WHERE id=?', created.grant.id).status, 'active');
  // A build that commits, then a revocation, then a repeated revocation that reports no change.
  f.advance();
  assert.equal(build(f, f.actor('bob'), bob, base).changed, true);
  f.advance();
  assert.equal(f.tx('plotGrantRevoke', f.actor('alice'), { grant_id: created.grant.id }).revoked, true);
  f.advance();
  const repeat = f.tx('plotGrantRevoke', f.actor('alice'), { grant_id: created.grant.id });
  assert.equal(repeat.revoked, false);
  assert.equal(repeat.writes, 0);
  assert.equal(repeat.changed, false);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM plot_grant_events WHERE grant_id=? AND action='revoke'", created.grant.id).n, 1);
  assert.equal(blocks(f), 1, 'the committed guest block stays recorded');
  assert.equal(f.platform.verifyAudit(), true);
});

test('a tampered scope refuses the next guest build and leaves the ledger untouched', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 6 });
  f.advance();
  build(f, f.actor('bob'), bob, base);
  // Narrow the scope under a live grant; the live read refuses the next write with nothing spent.
  f.platform.db.exec('DROP TRIGGER plot_grants_lifecycle');
  f.platform.run('UPDATE plot_grants SET scope=? WHERE id=?', JSON.stringify({ block_types: ['glass'], layers: [0], actions: ['place'], max_blocks: 1 }), created.grant.id);
  const actionsBefore = f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n;
  f.advance();
  assert.throws(() => build(f, f.actor('bob'), bob, east), { status: 403, message: /block is outside this collaboration grant/ });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n, actionsBefore);
  assert.equal(blocks(f), 1);
  assert.equal(f.platform.get('SELECT uses FROM plot_grants WHERE id=?', created.grant.id).uses, 1);
});

test('a pre-change database migrates to schema 19, backs up and restores with its grants intact', async t => {
  const f = await fixture(t), bob = f.agent('bob');
  steward(f); stand(f, bob, post);
  const created = grantFor(f, bob, { block_types: ['wood'], layers: [0], max_blocks: 12 });
  f.advance();
  build(f, f.actor('bob'), bob, base);
  const directory = mkdtempSync(join(tmpdir(), 'nemoworld-grant-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backup = join(directory, 'backup.sqlite');
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 19);
  const restored = restoreDatabase(backup, join(directory, 'restored.sqlite'));
  assert.equal(restored.schema_version, 19);
  const reopened = new Platform(join(directory, 'restored.sqlite'), f.clock);
  t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM plot_grants').n, 1);
  assert.equal(reopened.get('SELECT uses FROM plot_grants').uses, 1);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 1);
  assert.equal(reopened.get('SELECT grant_id FROM frontier_blocks').grant_id, created.grant.id);
  assert.equal(reopened.verifyAudit(), true);
  // A schema 18 database has no collaboration layer: it migrates forward, empty, without touching
  // the world it already held.
  f.platform.close();
  const legacy = new DatabaseSync(f.database);
  legacy.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER land_stewardships_revoke_grants; DROP TABLE plot_grant_events; DROP TABLE plot_grants; DROP TRIGGER frontier_blocks_plot_insert; PRAGMA user_version=18');
  legacy.exec(SCHEMA_18_GUARD);
  legacy.exec('ALTER TABLE frontier_blocks DROP COLUMN grant_id');
  legacy.close();
  assert.equal(validateDatabase(f.database).schema_version, 18);
  const migrated = new Platform(f.database, f.clock);
  t.after(() => migrated.close());
  assert.equal(validateDatabase(f.database).schema_version, 19);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM plot_grants').n, 0);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM plot_grant_events').n, 0);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 1, 'guest construction is preserved');
  assert.equal(migrated.get('SELECT plot_id FROM frontier_blocks').plot_id, plot, 'the parcel column is unchanged');
  assert.equal(migrated.get('SELECT grant_id FROM frontier_blocks').grant_id, null);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 1);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM land_parcels').n, 16384);
  assert.equal(migrated.verifyAudit(), true);
  assert.match(migrated.get("SELECT sql FROM sqlite_schema WHERE name='frontier_blocks_plot_insert'").sql, /plot_grants/);
  // The recreated layer is immediately usable again.
  const actor = migrated.authenticate(f.credentials.alice.token);
  const next = migrated.transaction(() => migrated.plotGrantCreate(actor, grantInput(bob, { block_types: ['wood'], layers: [0], max_blocks: 12 })));
  assert.equal(next.created, true);
  assert.equal(validateDatabase(f.database).schema_version, 19);
  // A collaboration database that lost its guard, its tables or a narrow scope fails validation
  // rather than being accepted as an equivalent world.
  migrated.db.exec('DROP TRIGGER frontier_blocks_plot_insert');
  migrated.db.exec(LAND_BLOCK_GUARDS.replace(/CREATE TRIGGER IF NOT EXISTS frontier_blocks_plot_insert[\s\S]*?END;/, "CREATE TRIGGER frontier_blocks_plot_insert BEFORE INSERT ON frontier_blocks WHEN 0 BEGIN SELECT RAISE(ABORT,'no guard'); END;"));
  assert.throws(() => validateDatabase(f.database), /guard is incomplete/);
  migrated.db.exec('DROP TRIGGER frontier_blocks_plot_insert');
  migrated.db.exec(LAND_BLOCK_GUARDS);
  migrated.db.exec('DROP TRIGGER plot_grants_validate_insert');
  migrated.db.exec('DROP TRIGGER plot_grants_lifecycle');
  migrated.run('UPDATE plot_grants SET scope=? WHERE id=?', JSON.stringify({ block_types: ['wood', 'stone', 'glass', 'brick', 'sand'], layers: [0, 1], actions: ['place'], max_blocks: 4 }), next.grant.id);
  migrated.db.exec(PLOT_GRANT_SCHEMA);
  assert.throws(() => validateDatabase(f.database), /scope is invalid/, 'a structurally complete database with a widened grant still fails validation');
  migrated.db.exec('DROP TRIGGER plot_grants_lifecycle');
  migrated.run('UPDATE plot_grants SET scope=? WHERE id=?', JSON.stringify({ block_types: ['wood'], layers: [0], actions: ['place'], max_blocks: 12 }), next.grant.id);
  migrated.db.exec(PLOT_GRANT_SCHEMA);
  assert.equal(validateDatabase(f.database).schema_version, 19);
  assert.equal(created.grant.id.length, 36);
});
