import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture, PASSWORD, realMission, evidence } from './helpers.js';
import { Platform } from '../src/platform.js';
import { COIN_SCHEMA, verifyCoinLedger } from '../src/coins.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';
import { getWorldDefinition, walkable } from '../world.js';

const signup = (name, changes = {}) => ({ name, email: `${name}@example.org`, password: PASSWORD, consent: true, ...changes });
const human = f => f.tx('createAgent', f.actor('alice'), { kind: 'human', name: 'Alice explorer' });

test('public registration creates members, preserves privileged invitations, and an administrator can close and reopen signup', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.platform.registrationPolicy(), { mode: 'open', public_signup: true, first_admin_required: false });
  const joined = await f.platform.register(signup('public-human', { role: 'admin' }));
  assert.equal(joined.account.role, 'member');
  assert.equal(f.platform.authenticate((await f.platform.login(signup('public-human'))).token).account.id, joined.account.id);
  await assert.rejects(f.platform.register(signup('bad-invite', { invite: 'invalid-even-when-open', role: 'reviewer' })), { status: 403 });
  assert.throws(() => f.tx('registrationSettings', f.actor('alice'), { mode: 'closed' }), { status: 403 });
  assert.throws(() => f.tx('registrationSettings', f.actor('admin'), { mode: 'invite-only' }), { status: 400 });
  assert.equal(f.tx('registrationSettings', f.actor('admin'), { mode: 'closed' }).public_signup, false);
  await assert.rejects(f.platform.register(signup('closed-public')), { status: 403 });
  const invitation = f.tx('invite', f.actor('admin'), { role: 'reviewer' });
  const reviewer = await f.platform.register(signup('invited-reviewer', { invite: invitation.code, role: 'admin' }));
  assert.equal(reviewer.account.role, 'reviewer');
  await assert.rejects(f.platform.register(signup('invite-replay', { invite: invitation.code })), { status: 403 });
  f.platform.close();
  const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  assert.equal(restarted.registrationPolicy().mode, 'closed');
  restarted.transaction(() => restarted.registrationSettings(restarted.authenticate(f.credentials.admin.token), { mode: 'open' }));
  assert.equal((await restarted.register(signup('reopened-public'))).account.role, 'member');
  assert.equal(restarted.verifyAudit(), true);
});

test('first administrator still requires the private setup code on a public deployment', async t => {
  const platform = new Platform(':memory:'); t.after(() => platform.close());
  platform.publicMode = true; platform.setupCode = 'private-setup-fixture-code-2026';
  assert.equal(platform.registrationPolicy().public_signup, false);
  await assert.rejects(platform.register(signup('owner')), { status: 403 });
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  const first = await platform.register(signup('owner', { setup_code: platform.setupCode, role: 'member' }));
  assert.equal(first.account.role, 'admin');
  assert.equal((await platform.register(signup('second', { setup_code: platform.setupCode, role: 'admin' }))).account.role, 'member');
});

test('a human avatar has its own quota, immutable identity, durable movement, chat and home construction', async t => {
  const f = await fixture(t), avatar = human(f);
  assert.equal(avatar.kind, 'human');
  for (let n = 0; n < 5; n++) assert.equal(f.agent('alice', `Worker ${n}`).kind, 'agent');
  assert.throws(() => f.agent('alice', 'Sixth worker'), { status: 429 });
  assert.throws(() => human(f), { status: 429 });
  assert.throws(() => f.tx('createAgent', f.actor('bob'), { kind: 'npc', name: 'Invalid' }), { status: 400 });
  assert.throws(() => f.platform.run("UPDATE agents SET kind='agent' WHERE id=?", avatar.id), /immutable/);
  assert.throws(() => f.tx('moveAgent', f.actor('bob'), { agent_id: avatar.id, direction: 'left' }), { status: 404 });
  f.tx('moveAgent', f.actor('alice'), { agent_id: avatar.id, direction: 'right' });
  f.tx('message', f.actor('alice'), { agent_id: avatar.id, text: 'A human is exploring the shared world.', channel: 'public' });
  f.advance();
  const homeId = `home:${avatar.id}`;
  f.tx('travel', f.actor('alice'), avatar.id, { world_id: homeId });
  const definition = getWorldDefinition(homeId);
  let tile;
  for (let y = 0; y < definition.rows && !tile; y++) for (let x = 0; x < definition.columns && !tile; x++) {
    if (walkable({ x, y }, definition) && Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) > 1 && !(definition.portals || []).some(p => Math.abs(p.x - x) + Math.abs(p.y - y) <= 1)) tile = { x, y };
  }
  assert.ok(tile);
  f.tx('build', f.actor('alice'), avatar.id, { type: 'flowers', ...tile });
  f.tx('homeSettings', f.actor('alice'), avatar.id, { visibility: 'private' });
  assert.throws(() => f.platform.world(f.actor('bob'), { world_id: homeId }), { status: 403 });
  const exported = f.platform.exportAccount(f.actor('alice'));
  assert.equal(exported.format, 'shared-world-account-v18');
  assert.equal(exported.agents.filter(a => a.kind === 'human').length, 1);
  assert.equal(exported.world_objects.some(o => o.type === 'flowers'), true);
  f.platform.close(); const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  const view = restarted.world(restarted.authenticate(f.credentials.alice.token), { agent_id: avatar.id });
  assert.equal(view.world.id, homeId);
  assert.equal(view.agents.find(a => a.id === avatar.id).kind, 'human');
  assert.equal(view.objects.some(o => o.kind === 'flowers'), true);
  assert.equal(restarted.get('SELECT verified FROM agents WHERE id=?', avatar.id).verified, 0);
});

test('human avatars cannot receive or use runtime credentials and accepted human work does not mint agent coins', async t => {
  const f = await fixture(t), avatar = human(f), { task } = realMission(f);
  assert.throws(() => f.tx('runtime', f.actor('alice'), avatar.id, { scopes: ['build'] }), { status: 403 });
  const rawToken = 'a'.repeat(64), tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const args = [tokenHash, f.actor('alice').account.id, avatar.id, 'runtime', f.clock() + 60000, 10, '["read"]'];
  assert.throws(() => f.platform.run('INSERT INTO tokens(hash,account_id,agent_id,kind,expires_at,max_calls,scopes) VALUES(?,?,?,?,?,?,?)', ...args), /Only agents/);
  // Authentication must reject a legacy or malicious credential even if an insert guard was bypassed.
  f.platform.db.exec('DROP TRIGGER tokens_agent_runtime');
  f.platform.run('INSERT INTO tokens(hash,account_id,agent_id,kind,expires_at,max_calls,scopes) VALUES(?,?,?,?,?,?,?)', ...args);
  assert.throws(() => f.platform.authenticate(rawToken, 'read'), { status: 403 });
  f.platform.run('DELETE FROM tokens WHERE hash=?', tokenHash);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: avatar.id }, 'human-source-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'A reviewed human-authored contribution fixture.' }), 'human-source-submit');
  const review = f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent human review.' });
  assert.equal(review.coin_reward.status, 'not_eligible');
  assert.match(review.coin_reward.reason, /Human avatars/);
  assert.equal(f.platform.coins(f.actor('alice'), { agent_id: avatar.id }).balance, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  const date = new Date(f.clock()).toISOString();
  assert.throws(() => f.platform.run('INSERT INTO coin_rewards(id,agent_id,account_id,task_id,submission_id,review_id,fingerprint,amount,policy_version,award_day,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', 'fake-human-reward', avatar.id, f.actor('alice').account.id, task.id, submission.id, review.id, 'human-fingerprint', 10, 1, date.slice(0,10), date, '', 'fake-hash'), /Ineligible coin receipt/);
});

test('schema nine migration preserves agent identities, sessions, coin receipt hashes and old backup validation', async t => {
  const f = await fixture(t), agent = f.agent('alice'), { task } = realMission(f);
  const session = f.tx('runtime', f.actor('alice'), agent.id, {});
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'migration-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'Preserve this accepted agent receipt across schema upgrades.' }), 'migration-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture.' });
  const receipt = { ...f.platform.get('SELECT * FROM coin_rewards') };
  f.platform.db.exec(`DROP VIEW calling_source_events; DROP VIEW calling_objective_rules; DROP TABLE calling_receipts; DROP TABLE resident_callings;
    DROP TRIGGER agents_kind_immutable; DROP TRIGGER tokens_agent_runtime; DROP TRIGGER tokens_agent_runtime_update; DROP TRIGGER coins_validate_insert; DROP INDEX one_human_avatar;
    DROP TRIGGER land_stewardships_revoke_grants; DROP TABLE plot_grant_events; DROP TABLE plot_grants;
    DROP TABLE land_stewardships; DROP TABLE land_events; DROP TABLE land_parcels;
    DROP TABLE frontier_actions; DROP TABLE frontier_blocks; DROP TABLE frontier_sectors;
    ALTER TABLE agents DROP COLUMN kind; DELETE FROM settings WHERE key='registration'; PRAGMA user_version=9;`);
  f.platform.db.exec(COIN_SCHEMA.replaceAll(" AND a.kind='agent'", ''));
  const older = join(f.directory, 'schema-nine.sqlite'); backupDatabase(f.platform.db, older);
  assert.equal(validateDatabase(older).schema_version, 9);
  f.platform.close(); const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  assert.equal(validateDatabase(f.database).schema_version, 25);
  assert.equal(restarted.me(restarted.authenticate(f.credentials.alice.token)).agents[0].kind, 'agent');
  assert.equal(restarted.authenticate(session.token, 'read').agent.kind, 'agent');
  assert.deepEqual({ ...restarted.get('SELECT * FROM coin_rewards') }, receipt);
  assert.equal(restarted.coins(restarted.authenticate(f.credentials.alice.token), { agent_id: agent.id }).balance, 10);
  assert.equal(restarted.registrationPolicy().mode, 'open');
  assert.equal(verifyCoinLedger(restarted.db), true);
  assert.equal(restarted.verifyAudit(), true);
  restarted.db.exec('DROP TRIGGER agents_kind_immutable');
  assert.throws(() => validateDatabase(f.database), /human avatar schema/);
});

test('schema ten migration retains legacy frontier geometry and coin receipts while adding finite land protections', async t => {
  const f = await fixture(t), agent = f.agent('alice'), { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'land-migration-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'Accepted agent work remains separate from virtual land.' }), 'land-migration-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture.' });
  const receipt = { ...f.platform.get('SELECT * FROM coin_rewards') };
  for (const name of ['land_parcels_no_update','land_parcels_no_delete','land_parcels_validate_insert','land_stewardships_validate_insert','land_stewardships_no_update','frontier_sectors_finite_insert','frontier_sectors_identity_immutable','frontier_blocks_plot_insert']) f.platform.db.exec(`DROP TRIGGER ${name}`);
  f.platform.db.exec('DROP VIEW calling_source_events; DROP VIEW calling_objective_rules; DROP TABLE calling_receipts; DROP TABLE resident_callings; DROP TRIGGER land_stewardships_revoke_grants; DROP TABLE plot_grant_events; DROP TABLE plot_grants; DROP TABLE land_stewardships; DROP TABLE land_events; ALTER TABLE frontier_blocks DROP COLUMN grant_id; ALTER TABLE frontier_blocks DROP COLUMN plot_id; DROP TABLE land_parcels; PRAGMA user_version=10');
  const date = new Date(f.clock()).toISOString();
  f.platform.run("INSERT INTO worlds VALUES(?,?,?,NULL,?,?,?,?)", 'frontier:8:0', 'Preserved legacy area', 'frontier', 'public', 48, 48, date);
  f.platform.run('INSERT INTO frontier_sectors VALUES(?,?,?,?,?,?)', 'frontier:8:0', 8, 0, f.actor('alice').account.id, agent.id, date);
  f.platform.run('INSERT INTO frontier_blocks VALUES(?,?,?,?,?,?,?,?,?)', 'legacy-land-block', 'frontier:8:0', 6, 6, 0, 'wood', agent.id, f.actor('alice').account.id, date);
  const old = join(f.directory, 'schema-ten.sqlite'); backupDatabase(f.platform.db, old);
  assert.equal(validateDatabase(old).schema_version, 10);
  f.platform.close(); const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  assert.equal(validateDatabase(f.database).schema_version, 25);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM land_parcels').n, 16384);
  const preserved = restarted.get('SELECT * FROM frontier_blocks WHERE id=?', 'legacy-land-block');
  assert.equal(preserved.world_id, 'frontier:8:0'); assert.equal(preserved.plot_id, null); assert.equal(preserved.type, 'wood');
  assert.deepEqual({ ...restarted.get('SELECT * FROM coin_rewards') }, receipt);
  assert.equal(restarted.coins(restarted.authenticate(f.credentials.alice.token), { agent_id: agent.id }).balance, 10);
  assert.throws(() => restarted.run('UPDATE land_parcels SET area_m2=999'), /immutable|read.only|fixed|registry/i);
  assert.throws(() => restarted.transaction(() => {
    restarted.run("INSERT INTO worlds VALUES(?,?,?,NULL,?,?,?,?)", 'frontier:9:0', 'Outside new perimeter', 'frontier', 'public', 48, 48, date);
    restarted.run('INSERT INTO frontier_sectors VALUES(?,?,?,?,?,?)', 'frontier:9:0', 9, 0, null, null, date);
  }), /finite|perimeter|bounds|land|outside/i);
  assert.equal(restarted.get('SELECT id FROM worlds WHERE id=?', 'frontier:9:0'), undefined);
  assert.equal(restarted.verifyAudit(), true);
  const partialPath = join(f.directory, 'incomplete-land.sqlite'); backupDatabase(restarted.db, partialPath);
  const partial = new DatabaseSync(partialPath);
  const noDelete = partial.prepare("SELECT sql FROM sqlite_schema WHERE name='land_parcels_no_delete'").get().sql;
  partial.exec('DROP TRIGGER land_parcels_no_delete');
  partial.prepare('DELETE FROM land_parcels WHERE id=?').run('plot:-8:-8:0:0');
  partial.exec(noDelete); partial.close();
  assert.throws(() => validateDatabase(partialPath), /finite land registry is incomplete/);
});

test('account removal ends stewardship and redacts land text while preserving shared construction and preventing reassignment of occupied ground', async t => {
  const f = await fixture(t), avatar = human(f), plotId = 'plot:0:0:5:5';
  f.tx('landAssign', f.actor('alice'), { plot_id: plotId, purpose: 'A private fixture purpose', description: 'Fixture text that must be removed with this account.' });
  f.platform.run('UPDATE agents SET world_id=?,x=30,y=32 WHERE id=?', 'frontier:0:0', avatar.id);
  f.tx('frontierBuild', f.actor('alice'), avatar.id, { world_id: 'frontier:0:0', x: 31, y: 33, z: 0, type: 'wood' });
  const block = { ...f.platform.get('SELECT * FROM frontier_blocks') };
  const before = f.platform.exportAccount(f.actor('alice')).frontier;
  assert.equal(before.stewardships.length, 1); assert.equal(before.land_events.length, 1);
  assert.equal(f.platform.exportAccount(f.actor('bob')).frontier.land_events.length, 0);
  f.tx('deleteAccount', f.actor('alice'));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  assert.deepEqual({ ...f.platform.get('SELECT * FROM frontier_blocks') }, block);
  const event = f.platform.get('SELECT * FROM land_events');
  assert.equal(event.purpose, '[removed]'); assert.equal(event.description, ''); assert.equal(event.action, 'assign');
  const publicPlot = f.platform.landPlot(f.actor('bob'), { plot_id: plotId }).plot;
  assert.equal(publicPlot.block_count, 1); assert.equal(publicPlot.can_assign, false); assert.equal(publicPlot.purpose, '');
  assert.throws(() => f.tx('landAssign', f.actor('bob'), { plot_id: plotId, purpose: 'Appropriate occupied ground' }), { status: 409 });
  assert.throws(() => f.platform.authenticate(f.credentials.alice.token), { status: 401 });
  assert.equal(validateDatabase(f.database).schema_version, 25);
  assert.equal(f.platform.verifyAudit(), true);
});
