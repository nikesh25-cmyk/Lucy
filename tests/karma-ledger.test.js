import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture} from './helpers.js';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';
import {backupDatabase} from '../src/recovery.js';
import {COIN_POLICY, verifyCoinLedger} from '../src/coins.js';
import {KARMA_POLICY, KARMA_SCHEMA, KARMA_SERVICES, karmaReconcile, karmaReceiptHash, verifyKarmaLedger} from '../src/karma.js';

// The ledger is installed by the platform itself (src/database.js creates the schema, src/platform.js
// mixes the methods in), so a fixture needs nothing more than the ordinary `fixture()` call.
const setup = async (t, options = {}) => fixture(t, options);
const error = (status) => (caught) => caught.status === status;
const mint = (f, agent) => f.platform.transaction(() => karmaReconcile(f.platform, agent));
const wallet = (f, owner, agent) => f.platform.karmaWallet(f.actor(owner), { agent_id: agent.id });
const balance = (f, agent) => wallet(f, 'alice', agent).balance;
const used = (f, agent, service) => f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=? AND service_id=?', agent.id, service).n;

// A farm tile in the resident's own garden, then the planted crop on it. The tile itself is a farm, so
// it is never a separate furnishing: the crop is the credited act.
const farmTile = (f, agent, x, y = 6) => {
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,'farm',?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='farm'", `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, x, y, new Date(f.clock()).toISOString());
};
const plant = (f, owner, agent, x, y = 6) => { farmTile(f, agent, x, y); return f.tx('gardenAction', f.actor(owner), { agent_id: agent.id, action: 'plant', kind: 'herbs', x, y }); };
// The next saved row of one service that no receipt has claimed yet: the test's own view of what the
// faucet can still see, read from the same registry the trigger validates against.
const openEvent = (f, agent, service) => f.platform.get(`SELECT e.* FROM karma_source_events e WHERE e.service_id=? AND e.agent_id=? AND NOT EXISTS(SELECT 1 FROM karma_receipts r WHERE r.agent_id=e.agent_id AND r.source_kind=e.source_kind AND r.source_id=e.source_id) ORDER BY e.occurred_at,e.source_id LIMIT 1`, service, agent.id);
const receiptRow = (f, changes) => {
  const row = { id: randomUUID(), award_day: new Date(f.clock()).toISOString().slice(0, 10), policy_version: KARMA_POLICY.version, created_at: new Date(f.clock()).toISOString(), previous_hash: f.platform.get('SELECT hash FROM karma_receipts ORDER BY seq DESC LIMIT 1')?.hash || '', ...changes };
  row.hash = karmaReceiptHash(row);
  return row;
};
const insertReceipt = (f, row) => f.platform.run('INSERT INTO karma_receipts(id,agent_id,account_id,service_id,tier,source_kind,source_id,source_at,amount,per_day,requires_other_operator,award_day,policy_version,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', row.id, row.agent_id, row.account_id, row.service_id, row.tier, row.source_kind, row.source_id, row.source_at, row.amount, row.per_day, row.requires_other_operator, row.award_day, row.policy_version, row.created_at, row.previous_hash, row.hash);
const snapshot = (f, name) => { const path = join(f.directory, name); backupDatabase(f.platform.db, path); return path; };
const openCopy = (t, path) => { const db = new DatabaseSync(path); t.after(() => { try { db.close(); } catch { /* the test may already have closed this copy */ } }); return db; };

test('a saved crop earns the world-tier award once, and the wallet is a private read-only projection', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  plant(f, 'alice', agent, 6);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: agent.id }).balance, 0, 'nothing is credited until the settle pass runs');
  assert.equal(mint(f, agent), 1);
  assert.equal(mint(f, agent), 0, 'the same saved row can never earn a second receipt');
  const w = wallet(f, 'alice', agent);
  assert.equal(w.balance, 2); assert.equal(w.earned, 2); assert.equal(w.spent, 0);
  assert.equal(w.currency, 'Karma Coins'); assert.equal(w.ledger_scope, 'operator account');
  assert.equal(w.entries.length, 1);
  assert.equal(w.entries[0].direction, 'earn'); assert.equal(w.entries[0].amount, 2);
  assert.match(w.entries[0].label, /crop planted/i);
  assert.ok(Number.isFinite(Date.parse(w.entries[0].created_at)));
  assert.equal(w.entries[0].service_id, 'garden_crop');
  assert.equal(w.counts.receipts, 1); assert.equal(w.counts.purchases, 0);
  assert.equal(w.today.earned, 2); assert.equal(w.today.limit, KARMA_POLICY.daily_operator_limit); assert.equal(w.today.remaining, 58);
  assert.equal(w.services.length, KARMA_SERVICES.length);
  const crop = w.services.find((service) => service.id === 'garden_crop');
  assert.equal(crop.tier, 'world'); assert.equal(crop.award, 2); assert.equal(crop.per_day, 2);
  assert.equal(crop.requires_other_operator, false);
  assert.equal(crop.used_today, 1); assert.equal(crop.remaining_today, 1); assert.equal(crop.minted, 1);
  assert.ok(crop.note && crop.hint, 'every service states the saved row it reads');
  assert.deepEqual(w.verify, { ledger: true, chain: true, sources: true, balance_non_negative: true });
  assert.equal(w.integrity_valid, true);
  // The projection writes nothing: reading it twice adds no receipt.
  const before = f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n;
  wallet(f, 'alice', agent); wallet(f, 'alice', agent);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, before);
  // Receipts are append-only.
  assert.throws(() => f.platform.run('UPDATE karma_receipts SET amount=6'), /append-only/);
  assert.throws(() => f.platform.run('DELETE FROM karma_receipts'), /append-only/);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('service to others needs a different operator, and the wallet stays private to its owner', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), host = f.agent('bob');
  const created = new Date(f.clock()).toISOString();
  // A thank-you inside one operator is not service to another operator: the registry cannot see it.
  f.platform.run('INSERT INTO community_thanks VALUES(?,?,?,?,?,?,?)', 'own-thanks', f.actor('alice').account.id, agent.id, agent.id, created.slice(0, 10), 'Thanking myself.', created);
  assert.equal(mint(f, agent), 0, 'a row one operator produced alone is not service to others');
  f.tx('giveThanks', f.actor('alice'), { agent_id: agent.id, recipient_agent_id: host.id, reason: 'Thank you for welcoming me to the library.' });
  assert.equal(mint(f, agent), 1);
  const w = wallet(f, 'alice', agent);
  assert.equal(w.balance, 6);
  assert.equal(w.entries[0].direction, 'earn'); assert.equal(w.entries[0].tier, 'service');
  assert.match(w.entries[0].label, /thank-you/i);
  assert.equal(w.services.find((service) => service.id === 'thanks_to_neighbor').requires_other_operator, true);
  assert.equal(w.services.find((service) => service.id === 'thanks_to_neighbor').remaining_today, 1);
  // The wallet is private: the same 404 a sibling or an outsider already sees elsewhere.
  assert.throws(() => f.platform.karmaWallet(f.actor('bob'), { agent_id: agent.id }), error(404));
  assert.throws(() => f.platform.karmaWallet(null, { agent_id: agent.id }), error(401));
  const sibling = f.agent('alice', 'Sibling');
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: sibling.id }).balance, 6, 'the purse belongs to the operator account');
  assert.throws(() => f.platform.karmaWallet(f.actor('alice'), { agent_id: 'not-a-resident' }), error(404));
  // Settling another operator's resident is refused by ownership, not by a policy branch.
  assert.throws(() => f.tx('karmaSettle', f.actor('bob'), { agent_id: agent.id }), error(404));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, 1);
});

test('one saved row earns one receipt, and a row the world does not hold is refused', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  plant(f, 'alice', agent, 6); plant(f, 'alice', agent, 7);
  f.platform.run('DELETE FROM journey_crops WHERE agent_id=? AND x=7', agent.id);
  assert.equal(mint(f, agent), 1, 'the garden row that does not exist earns nothing');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=?', agent.id).n, 1);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM (SELECT source_kind,source_id FROM karma_receipts GROUP BY source_kind,source_id HAVING COUNT(*)>1)").n, 0, 'no saved row is credited twice');
  // The trigger refuses a receipt that names no saved row at all, whatever the chain says.
  assert.throws(() => insertReceipt(f, receiptRow(f, { agent_id: agent.id, account_id: f.actor('alice').account.id, service_id: 'garden_crop', tier: 'world', source_kind: 'crop_plant', source_id: '9:9:1', source_at: new Date(f.clock()).toISOString(), amount: 2, per_day: 2, requires_other_operator: 0 })), /verified saved source/);
  // A source row the world has since removed does not invalidate an honest receipt: an operator may
  // delete their journey record, and the wallet must keep working when they do.
  f.platform.run('DELETE FROM journey_crops WHERE agent_id=? AND x=6', agent.id);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  assert.equal(balance(f, agent), 2);
});

test('a service pays twice a day and no more, in the method and in the trigger', async (t) => {
  const f = await setup(t, { startAt: Date.parse('2026-03-01T09:00:00.000Z') }), agent = f.agent('alice');
  for (const x of [6, 7, 8]) plant(f, 'alice', agent, x);
  assert.equal(mint(f, agent), 2, 'the third saved crop earns nothing today');
  assert.equal(used(f, agent, 'garden_crop'), 2);
  const event = openEvent(f, agent, 'garden_crop');
  assert.ok(event, 'the third crop is still an unminted saved row');
  assert.throws(() => insertReceipt(f, receiptRow(f, { agent_id: agent.id, account_id: f.actor('alice').account.id, service_id: 'garden_crop', tier: 'world', source_kind: event.source_kind, source_id: event.source_id, source_at: event.occurred_at, amount: 2, per_day: 2, requires_other_operator: 0 })), /Daily karma service limit/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, 2, 'the hand-written receipt was refused');
  assert.equal(balance(f, agent), 4);
});

test('the operator total stops at sixty Karma Coins a UTC day', async (t) => {
  const f = await setup(t, { startAt: Date.parse('2026-03-01T09:00:00.000Z') });
  const host = f.agent('bob'), second = f.tx('createAgent', f.actor('bob'), { name: 'Second host avatar', capabilities: 'Fixture', limitations: 'Fixture', color: '#397f79', symbol: '✦' });
  const agent = f.agent('alice');
  // One other operator offers everything a neighbour can accept: two circles, two projects, two
  // gatherings, two residents to thank and two shared worlds to walk into.
  const circles = [], projects = [], events = [];
  for (let n = 1; n <= 2; n++) {
    circles.push(f.tx('createCircle', f.actor('bob'), { agent_id: host.id, name: `Neighbour circle ${n}`, summary: 'A circle another operator keeps.', focus: 'Care' }));
    projects.push(f.tx('createProject', f.actor('bob'), { agent_id: host.id, title: `Neighbour project ${n}`, summary: 'A shared outcome another operator plans.', goal: 'One bounded shared outcome.', evidence_requirements: 'A recorded result with its limits.', milestones: ['One milestone'] }));
    const starts = new Date(f.clock() + n * 3_600_000).toISOString();
    events.push(f.tx('createEvent', f.actor('bob'), { agent_id: host.id, title: `Neighbour gathering ${n}`, summary: 'A gathering another operator keeps.', world_id: 'library', starts_at: starts, ends_at: new Date(Date.parse(starts) + 1_800_000).toISOString(), capacity: 10 }));
  }
  for (const circle of circles) f.tx('circleMembership', f.actor('alice'), { agent_id: agent.id, circle_id: circle.id, action: 'join' });
  for (const project of projects) f.tx('projectPledge', f.actor('alice'), { agent_id: agent.id, project_id: project.id, action: 'pledge', commitment: 'A clear contribution I promise to make.' });
  for (const event of events) f.tx('eventRSVP', f.actor('alice'), { agent_id: agent.id, event_id: event.id, action: 'join' });
  for (const recipient of [host, second]) f.tx('giveThanks', f.actor('alice'), { agent_id: agent.id, recipient_agent_id: recipient.id, reason: 'Thank you for one specific piece of work.' });
  for (const world of [`home:${host.id}`, `home:${second.id}`]) { f.platform.run('UPDATE agents SET world_id=? WHERE id=?', world, agent.id); f.tx('recordVisit', f.actor('alice'), agent.id, world); }
  // Two receipts of each of the five services to others: ten receipts of six Karma Coins.
  assert.equal(mint(f, agent), 10);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM karma_receipts').n, KARMA_POLICY.daily_operator_limit);
  for (const service of ['shared_space_visit', 'thanks_to_neighbor', 'neighbor_circle', 'neighbor_pledge', 'neighbor_gathering']) assert.equal(used(f, agent, service), 2, service);
  // A sixth kind of service with a whole allowance left still cannot pass the operator total.
  plant(f, 'alice', agent, 6);
  assert.equal(mint(f, agent), 0, 'the sixty-a-day operator total is full');
  const w = wallet(f, 'alice', agent);
  assert.equal(w.balance, 60); assert.equal(w.today.remaining, 0); assert.equal(w.entries.length, 10);
  assert.equal(w.services.find((service) => service.id === 'garden_crop').remaining_today, 2);
  assert.equal(w.services.find((service) => service.id === 'shared_space_visit').remaining_today, 0);
  // The trigger enforces the same total on a hand-written receipt whose own service has an allowance.
  const event = openEvent(f, agent, 'garden_crop');
  assert.ok(event);
  assert.throws(() => insertReceipt(f, receiptRow(f, { agent_id: agent.id, account_id: f.actor('alice').account.id, service_id: 'garden_crop', tier: 'world', source_kind: event.source_kind, source_id: event.source_id, source_at: event.occurred_at, amount: 2, per_day: 2, requires_other_operator: 0 })), /Operator daily karma limit/);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM karma_receipts').n, 60);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('the day is the server clock alone, and the allowance returns at the next UTC day', async (t) => {
  const f = await setup(t, { startAt: Date.parse('2026-03-01T23:30:00.000Z') }), agent = f.agent('alice');
  for (const x of [6, 7, 8]) plant(f, 'alice', agent, x);
  assert.equal(mint(f, agent), 2);
  const firstDay = new Date(f.clock()).toISOString().slice(0, 10);
  assert.equal(firstDay, '2026-03-01');
  assert.ok(f.platform.all('SELECT award_day,created_at FROM karma_receipts').every((row) => row.award_day === row.created_at.slice(0, 10)), 'the award day is the day of the server stamp');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE award_day=?', firstDay).n, 2);
  // No request field moves the day: a client can name a resident and nothing else.
  assert.throws(() => f.platform.karmaWallet(f.actor('alice'), { agent_id: agent.id, day: firstDay }), error(400));
  assert.throws(() => f.platform.karmaSpend(f.actor('alice'), { amount: 1, good_id: 'herbs', key: 'dated', day: firstDay }), error(400));
  f.advance(31 * 60_000);
  assert.equal(new Date(f.clock()).toISOString().slice(0, 10), '2026-03-02');
  for (const x of [9, 10, 11]) plant(f, 'alice', agent, x);
  assert.equal(mint(f, agent), 2, 'a new UTC day opens the allowance again');
  assert.deepEqual(f.platform.all('SELECT DISTINCT award_day FROM karma_receipts ORDER BY award_day').map((row) => row.award_day), ['2026-03-01', '2026-03-02']);
  assert.equal(wallet(f, 'alice', agent).balance, 8);
  assert.equal(wallet(f, 'alice', agent).today.earned, 4);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('a purchase debits once, stops at exactly zero and can never go below', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  plant(f, 'alice', agent, 6); plant(f, 'alice', agent, 7);
  assert.equal(mint(f, agent), 2);
  assert.equal(balance(f, agent), 4);
  f.advance();
  const first = f.platform.transaction(() => f.platform.karmaSpend(f.actor('alice'), { amount: 4, good_id: 'herbs', key: 'basket-1' }));
  assert.equal(first.ok, true); assert.equal(first.balance_after, 0); assert.equal(first.repeated, false);
  assert.ok(first.purchase_id);
  const replay = f.platform.transaction(() => f.platform.karmaSpend(f.actor('alice'), { amount: 4, good_id: 'herbs', key: 'basket-1' }));
  assert.equal(replay.ok, true); assert.equal(replay.repeated, true);
  assert.equal(replay.purchase_id, first.purchase_id, 'a replayed key answers with the same debit');
  assert.equal(replay.balance_after, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1);
  assert.throws(() => f.platform.transaction(() => f.platform.karmaSpend(f.actor('alice'), { amount: 4, good_id: 'fiber', key: 'basket-1' })), error(409), 'a key belongs to one good and one amount');
  const short = f.platform.transaction(() => f.platform.karmaSpend(f.actor('alice'), { amount: 1, good_id: 'herbs', key: 'basket-2' }));
  assert.equal(short.ok, false); assert.equal(short.reason_code, 'insufficient_balance');
  assert.equal(short.balance_after, 0); assert.equal(short.purchase_id, null); assert.match(short.reason, /holds 0 Karma Coins/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1, 'a refused purchase writes nothing');
  const w = wallet(f, 'alice', agent);
  assert.equal(w.balance, 0); assert.equal(w.spent, 4); assert.equal(w.counts.purchases, 1); assert.equal(w.today.spent, 4);
  assert.equal(w.entries[0].direction, 'spend'); assert.match(w.entries[0].label, /herbs/); assert.equal(w.entries[0].balance_after, 0);
  assert.throws(() => f.platform.run('UPDATE karma_purchases SET amount=1'), /append-only/);
  // The trigger refuses an overdraft whatever writes it, chain and all.
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const overdraft = { id: 'overdraft', account_id: f.actor('alice').account.id, agent_id: agent.id, good_id: 'herbs', amount: 1, balance_after: 0, policy_version: 1, idempotency_key: 'overdraft', fingerprint: sha(JSON.stringify(['herbs', 1])), created_at: new Date(f.clock()).toISOString(), previous_hash: f.platform.get('SELECT hash FROM karma_purchases ORDER BY seq DESC LIMIT 1').hash };
  overdraft.hash = sha(JSON.stringify([overdraft.id, overdraft.account_id, overdraft.agent_id, overdraft.good_id, overdraft.amount, overdraft.balance_after, overdraft.policy_version, overdraft.idempotency_key, overdraft.fingerprint, overdraft.created_at, overdraft.previous_hash]));
  assert.throws(() => f.platform.run('INSERT INTO karma_purchases(id,account_id,agent_id,good_id,amount,balance_after,policy_version,idempotency_key,fingerprint,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', overdraft.id, overdraft.account_id, overdraft.agent_id, overdraft.good_id, overdraft.amount, overdraft.balance_after, overdraft.policy_version, overdraft.idempotency_key, overdraft.fingerprint, overdraft.created_at, overdraft.previous_hash, overdraft.hash), /below zero/);
  assert.equal(balance(f, agent), 0);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('a paused account, a resident credential and a paused platform cannot move Karma Coins', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  plant(f, 'alice', agent, 6); plant(f, 'alice', agent, 7);
  assert.equal(mint(f, agent), 2);
  const alice = f.actor('alice'), sibling = f.agent('alice', 'Sibling');
  const runtime = f.tx('runtime', alice, agent.id, { scopes: ['read', 'contribute'], duration_minutes: 10, max_calls: 40 });
  const resident = f.platform.authenticate(runtime.token, 'read');
  // A resident credential may read its own wallet and can never mint, settle or spend.
  const projected = f.platform.karmaWallet(resident);
  assert.equal(projected.agent_id, agent.id); assert.equal(projected.balance, 4);
  assert.throws(() => f.tx('karmaSettle', resident, { agent_id: agent.id }), error(403));
  assert.throws(() => f.platform.karmaSpend(resident, { amount: 2, good_id: 'herbs', key: 'resident-1' }), error(403));
  assert.throws(() => f.platform.karmaWallet(resident, { agent_id: sibling.id }), error(404));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, 2);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 0);
  // A paused platform refuses the debit outright.
  f.tx('pause', f.actor('admin'), true);
  assert.throws(() => f.platform.karmaSpend(alice, { amount: 2, good_id: 'herbs', key: 'paused-platform' }), error(503));
  f.tx('pause', f.actor('admin'), false);
  // A suspended account cannot spend, even through a session it was already holding.
  f.tx('accountControl', f.actor('admin'), { account_id: alice.account.id, status: 'suspended' });
  const refused = f.platform.karmaSpend(alice, { amount: 2, good_id: 'herbs', key: 'paused-account' });
  assert.equal(refused.ok, false); assert.equal(refused.reason_code, 'account_paused');
  assert.match(refused.reason, /paused/);
  assert.equal(refused.balance_after, 4); assert.equal(refused.purchase_id, null);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 0);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('guild service counts only another operator’s project and a different operator’s verification', async (t) => {
  const f = await setup(t), host = f.agent('bob'), verifier = f.agent('reviewer'), agent = f.agent('alice');
  const project = f.tx('guildProjectCreate', f.actor('bob'), { agent_id: host.id, guild_id: 'cultivator', title: 'A shared growing plan', summary: 'Coordinate one bounded piece of cooperative work.', visibility: 'public', plan: [{ id: 'walk', title: 'Walk one route', output_name: 'A saved route', scope: 'Do the bounded work named walk' }] });
  // An organiser is part of its own project, so its own participation is not service to others.
  f.tx('guildParticipation', f.actor('bob'), { agent_id: host.id, project_id: project.id, action: 'join' });
  assert.equal(mint(f, host), 0, 'an organiser is not a guest of another operator');
  f.tx('guildParticipation', f.actor('alice'), { agent_id: agent.id, project_id: project.id, action: 'join' });
  assert.equal(mint(f, agent), 1);
  assert.equal(used(f, agent, 'guild_participation'), 1);
  // A submitted claim is not verified service until a different operator verifies it.
  f.tx('guildContribution', f.actor('alice'), { agent_id: agent.id, project_id: project.id, workstream_id: 'walk', action: 'pledge', commitment: 'I will record one route.' });
  const submitted = f.tx('guildContribution', f.actor('alice'), { agent_id: agent.id, project_id: project.id, workstream_id: 'walk', action: 'submit', evidence: 'A recorded route with its limits.', sources: [{ url: 'https://example.org/route', location: 'Section 1' }] });
  const contribution = submitted.contributions[0];
  assert.equal(mint(f, agent), 0, 'a claim no different operator has verified earns nothing');
  assert.throws(() => f.tx('guildVerify', f.actor('alice'), { agent_id: agent.id, project_id: project.id, contribution_id: contribution.id, action: 'approve', reason: 'Self verification.' }), error(403));
  f.tx('guildVerify', f.actor('reviewer'), { agent_id: verifier.id, project_id: project.id, contribution_id: contribution.id, action: 'approve', reason: 'Checked the recorded route independently.' });
  assert.equal(mint(f, agent), 1);
  assert.equal(used(f, agent, 'guild_contribution'), 1);
  const w = wallet(f, 'alice', agent);
  assert.equal(w.balance, 12);
  assert.equal(w.services.find((service) => service.id === 'guild_contribution').remaining_today, 1);
  assert.equal(w.entries.filter((entry) => entry.tier === 'service').length, 2);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('an edited receipt, a broken chain or a forged wallet fails verification, and no Karma path moves NemoCoins', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), host = f.agent('bob');
  plant(f, 'alice', agent, 6);
  plant(f, 'bob', host, 6);
  assert.equal(mint(f, agent), 1);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  // 0. The trigger refuses a hand-written receipt outright. A saved source, a matching chain and the
  //    right catalogue entry are not enough when the credited wallet does not own the resident...
  const hostEvent = openEvent(f, host, 'garden_crop');
  assert.ok(hostEvent);
  assert.throws(() => insertReceipt(f, receiptRow(f, { agent_id: host.id, account_id: f.actor('alice').account.id, service_id: 'garden_crop', tier: 'world', source_kind: hostEvent.source_kind, source_id: hostEvent.source_id, source_at: hostEvent.occurred_at, amount: 2, per_day: 2, requires_other_operator: 0 })), /owned resident/);
  //    ... and an amount outside the frozen catalogue is never a receipt.
  assert.throws(() => insertReceipt(f, receiptRow(f, { agent_id: agent.id, account_id: f.actor('alice').account.id, service_id: 'garden_crop', tier: 'service', source_kind: 'crop_plant', source_id: 'made-up', source_at: new Date(f.clock()).toISOString(), amount: 6, per_day: 2, requires_other_operator: 0 })), /verified saved source/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, 1);
  // 1. An edited receipt no longer proves itself.
  const editedPath = snapshot(f, 'karma-edited.sqlite');
  const edited = openCopy(t, editedPath);
  edited.exec("DROP TRIGGER karma_receipts_no_update;UPDATE karma_receipts SET amount=6");
  assert.equal(verifyKarmaLedger(edited), false);
  edited.close();
  // 2. A broken chain: the previous link no longer matches.
  const chainedPath = snapshot(f, 'karma-chained.sqlite');
  const chained = openCopy(t, chainedPath);
  chained.exec("DROP TRIGGER karma_receipts_no_update;UPDATE karma_receipts SET previous_hash='broken'");
  assert.equal(verifyKarmaLedger(chained), false);
  chained.close();
  // 3. A forged receipt with a recomputed chain that credits the wrong wallet for bob's saved crop.
  const forgedPath = snapshot(f, 'karma-forged.sqlite');
  const forged = openCopy(t, forgedPath);
  forged.exec('DROP TRIGGER karma_receipts_validate_insert');
  const event = { service_id: 'garden_crop', source_kind: 'crop_plant', source_id: `6:6:${f.platform.get('SELECT planted_at FROM journey_crops WHERE agent_id=? AND x=6', host.id).planted_at}` };
  const created = new Date(f.clock()).toISOString();
  const row = { id: 'forged-receipt', agent_id: host.id, account_id: f.actor('alice').account.id, service_id: event.service_id, tier: 'world', source_kind: event.source_kind, source_id: event.source_id, source_at: created, amount: 2, per_day: 2, requires_other_operator: 0, award_day: created.slice(0, 10), policy_version: 1, created_at: created, previous_hash: forged.prepare('SELECT hash FROM karma_receipts ORDER BY seq DESC LIMIT 1').get().hash };
  row.hash = karmaReceiptHash(row);
  forged.prepare('INSERT INTO karma_receipts(id,agent_id,account_id,service_id,tier,source_kind,source_id,source_at,amount,per_day,requires_other_operator,award_day,policy_version,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.agent_id, row.account_id, row.service_id, row.tier, row.source_kind, row.source_id, row.source_at, row.amount, row.per_day, row.requires_other_operator, row.award_day, row.policy_version, row.created_at, row.previous_hash, row.hash);
  forged.exec(`CREATE TRIGGER karma_receipts_validate_insert BEFORE INSERT ON karma_receipts BEGIN SELECT 1; END`);
  assert.equal(verifyKarmaLedger(forged), false, 'a receipt crediting a wallet that does not own the resident is a finding');
  forged.close();
  const opened = new Platform(forgedPath);
  t.after(() => opened.close());
  opened.initKarma();
  assert.throws(() => opened.karmaWallet(opened.authenticate(f.credentials.alice.token), { agent_id: agent.id }), error(503));
  assert.throws(() => opened.karmaSpend(opened.authenticate(f.credentials.alice.token), { amount: 2, good_id: 'herbs', key: 'forged' }), error(503));
  // The installation and its one honest receipt are untouched by all of the above.
  assert.equal(balance(f, agent), 2);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  // No Karma table, trigger or view can move NemoCoins, and no Karma route exists yet.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(verifyCoinLedger(f.platform.db), true);
  assert.equal(COIN_POLICY.award, 10); assert.equal(COIN_POLICY.operator_daily_limit, 100); assert.equal(COIN_POLICY.currency, 'Nemo Coins');
  assert.doesNotMatch(KARMA_SCHEMA, /coin_rewards|karma_coin_rewards/);
  assert.equal(KARMA_POLICY.currency === COIN_POLICY.currency, false);
  assert.equal(KARMA_POLICY.separate_unit, true);
  for (const flag of ['transferable', 'transferable_between_accounts', 'transferable_between_residents', 'cash_value', 'cash_out', 'token', 'convertible', 'convertible_from_nemo_coins', 'convertible_to_nemo_coins', 'convertible_to_money', 'convertible_to_carbon_credits', 'buys_land', 'buys_role', 'buys_experience', 'buys_review_authority', 'buys_moderation_power', 'buys_runtime_scope']) assert.equal(KARMA_POLICY[flag], false, `${flag} must be stated as a boolean flag`);
  assert.match(KARMA_POLICY.description, /never convertible/);
  assert.match(KARMA_POLICY.not_earned, /chatting, posting, claiming, submitting, reviewing, adopting, logging in/);
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${f.credentials.alice.token}`, 'Content-Type': 'application/json', Origin: base };
  // The routes that exist: the private wallet read and the operator-only settle pass. Neither has any
  // request field that can name an amount, a source or a day, and the two are the only Karma writers a
  // client can reach besides a shop purchase.
  const wallet = await fetch(`${base}/api/v1/karma?agent_id=${agent.id}`, { headers });
  assert.equal(wallet.status, 200);
  const walletBody = await wallet.json();
  assert.equal(walletBody.currency, 'Karma Coins');
  assert.equal(walletBody.balance, f.platform.karmaWallet(f.actor('alice'), { agent_id: agent.id }).balance);
  const settled = await fetch(`${base}/api/v1/karma/settle`, { method: 'POST', headers, body: JSON.stringify({ agent_id: agent.id }) });
  assert.equal(settled.status, 200);
  assert.equal((await settled.json()).balance, walletBody.balance);
  // There is no direct mint and no direct spend route: a purchase can only reach the ledger through
  // the shop, so an oversized amount in a request body cannot touch it at all.
  for (const path of ['/api/v1/karma/spend', '/api/v1/karma/mint', '/api/v1/karma/award']) {
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ amount: 999999, agent_id: agent.id }) });
    assert.ok([403, 404, 405].includes(response.status), `${path} must not be a Karma route (got ${response.status})`);
  }
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM karma_receipts').n, 2);
});
