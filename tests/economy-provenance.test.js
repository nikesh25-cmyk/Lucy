import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, evidence, realMission } from './helpers.js';
import { createApp } from '../server.js';
import { KARMA_POLICY, karmaReceiptHash, verifyKarmaLedger } from '../src/karma.js';
import { verifyCoinLedger } from '../src/coins.js';

// Wave 5 deliverable (4): reward provenance is legible. A player can see what saved contribution a
// reward was recognised for and who independently reviewed it where a review was required, and a
// reward with no traceable contribution is flagged or refused. Both halves are tested: a genuine
// reward resolves to its own saved row and its reviewer, and an untraceable one is named as such.

const farmTile = (f, agent, x, y = 6) => {
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,'farm',?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='farm'", `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, x, y, new Date(f.clock()).toISOString());
};
const receiptRow = (f, changes) => {
  const row = { id: randomUUID(), award_day: new Date(f.clock()).toISOString().slice(0, 10), policy_version: KARMA_POLICY.version, created_at: new Date(f.clock()).toISOString(), previous_hash: f.platform.get('SELECT hash FROM karma_receipts ORDER BY seq DESC LIMIT 1')?.hash || '', ...changes };
  row.hash = karmaReceiptHash(row);
  return row;
};
const insertReceipt = (f, row) => f.platform.run('INSERT INTO karma_receipts(id,agent_id,account_id,service_id,tier,source_kind,source_id,source_at,amount,per_day,requires_other_operator,award_day,policy_version,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', row.id, row.agent_id, row.account_id, row.service_id, row.tier, row.source_kind, row.source_id, row.source_at, row.amount, row.per_day, row.requires_other_operator, row.award_day, row.policy_version, row.created_at, row.previous_hash, row.hash);
const provenance = (f, owner, input = {}) => f.platform.economyProvenance(f.actor(owner), input);
const openServer = async (t, f) => {
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  return `http://127.0.0.1:${app.server.address().port}`;
};

test('a Karma reward resolves to the saved contribution it was recognised for and to its independent reviewer', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), host = f.agent('bob'), verifier = f.agent('reviewer');
  // 1. World-tier service: the resident's own saved labour, with no reviewer required.
  farmTile(f, alice, 6);
  f.tx('gardenAction', f.actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 6, y: 6 });
  // 2. Service to another operator: a thank-you, which requires the other operator's own record.
  f.tx('giveThanks', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: host.id, reason: 'Thank you for showing me the library.' });
  // 3. Guild service: a contribution verified by a third operator, the one case with a named verifier.
  const project = f.tx('guildProjectCreate', f.actor('bob'), { agent_id: host.id, guild_id: 'cultivator', title: 'A shared growing plan', summary: 'Coordinate one bounded piece of cooperative work.', visibility: 'public', plan: [{ id: 'walk', title: 'Walk one route', output_name: 'A saved route', scope: 'Do the bounded work named walk' }] });
  f.tx('guildParticipation', f.actor('alice'), { agent_id: alice.id, project_id: project.id, action: 'join' });
  f.tx('guildContribution', f.actor('alice'), { agent_id: alice.id, project_id: project.id, workstream_id: 'walk', action: 'pledge', commitment: 'I will record one route.' });
  f.tx('guildContribution', f.actor('alice'), { agent_id: alice.id, project_id: project.id, workstream_id: 'walk', action: 'submit', evidence: 'A recorded route with its limits.', sources: [{ url: 'https://example.org/route', location: 'Section 1' }] });
  const contribution = f.platform.get('SELECT id FROM guild_contributions WHERE agent_id=?', alice.id).id;
  f.tx('guildVerify', f.actor('reviewer'), { agent_id: verifier.id, project_id: project.id, contribution_id: contribution, action: 'approve', reason: 'Checked the recorded route independently.' });
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).minted, 4, 'four saved acts, four rewards');
  const report = provenance(f, 'alice');
  assert.equal(report.status, 'ok');
  assert.equal(report.flagged_count, 0);
  assert.equal(report.reward_count, 4);
  assert.equal(report.ledger.karma_balance, 20);
  const byService = Object.fromEntries(report.rewards.map((reward) => [reward.service.id, reward]));
  // The world-tier reward cites the planted crop itself, parsed and looked up in the shipped table.
  const crop = byService.garden_crop;
  assert.equal(crop.contribution.table, 'journey_crops');
  assert.equal(crop.contribution.held, true);
  assert.equal(crop.traceable, true);
  assert.equal(crop.contribution.occurred_at, crop.contribution.source_at);
  assert.deepEqual({ kind: crop.contribution.detail.kind, x: crop.contribution.detail.x, y: crop.contribution.detail.y }, { kind: 'herbs', x: 6, y: 6 });
  assert.equal(crop.reviewer.required, false, 'a resident\u2019s own saved labour needs no independent review');
  assert.match(crop.contribution.detail.planted_at, /^\d{4}-\d{2}-\d{2}T/);
  // The service-tier reward names the other operator whose own record proves the act.
  const thanks = byService.thanks_to_neighbor;
  assert.equal(thanks.contribution.table, 'community_thanks');
  assert.equal(thanks.contribution.held, true);
  assert.equal(thanks.traceable, true);
  assert.equal(thanks.reviewer.required, true);
  assert.equal(thanks.reviewer.account_id, f.actor('bob').account.id, 'the counterparty operator is the reviewer');
  assert.equal(thanks.reviewer.account_name, f.platform.get('SELECT name FROM accounts WHERE id=?', f.actor('bob').account.id).name);
  assert.equal(thanks.reviewer.agent_id, host.id);
  assert.match(thanks.reviewer.kind, /different operator/);
  // The guild reward names the operator that actually verified the contribution, and when.
  const guild = byService.guild_contribution;
  assert.equal(guild.contribution.table, 'guild_contributions');
  assert.equal(guild.contribution.row_id, contribution);
  assert.equal(guild.traceable, true);
  assert.equal(guild.reviewer.required, true);
  assert.equal(guild.reviewer.account_id, f.actor('reviewer').account.id, 'the verifying operator is named');
  assert.equal(guild.reviewer.agent_id, verifier.id);
  assert.equal(guild.reviewer.at, f.platform.get('SELECT verified_at FROM guild_contributions WHERE id=?', contribution).verified_at);
  assert.match(guild.reviewer.kind, /verification/);
  // The participating reward resolves to the membership row on the other operator's project.
  const participation = byService.guild_participation;
  assert.equal(participation.contribution.table, 'guild_participants');
  assert.equal(participation.contribution.detail.project_id, project.id);
  assert.equal(participation.contribution.detail.state, 'active');
  assert.equal(participation.reviewer.account_id, f.actor('bob').account.id);
  // Every reward is one of the operator's own, and the report says what it does not do.
  assert.ok(report.rewards.every((reward) => reward.agent_id === alice.id));
  assert.match(report.policy.reads, /own rewards only/);
  assert.equal(report.flag_codes.contribution_not_held, 'contribution_not_held');
});

test('a NemoCoin reward resolves to the accepted contribution and to the independent reviewer who accepted it', async (t) => {
  const f = await fixture(t), resident = f.agent('alice'), m = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: m.task.id, agent_id: resident.id }, 'prov-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'An independently reviewed fixture contribution.' }), 'prov-submit');
  const review = f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture source review' });
  assert.equal(review.coin_reward.status, 'awarded');
  assert.equal(f.platform.coins(f.actor('alice'), { agent_id: resident.id }).balance, 10);
  const report = provenance(f, 'alice');
  assert.equal(report.status, 'ok');
  assert.equal(report.reward_count, 1);
  const [reward] = report.rewards;
  assert.equal(reward.ledger, 'coins');
  assert.equal(reward.amount, 10);
  assert.equal(reward.currency, 'Nemo Coins');
  assert.equal(reward.contribution.table, 'submissions');
  assert.equal(reward.contribution.row_id, submission.id);
  assert.equal(reward.contribution.held, true);
  assert.equal(reward.traceable, true);
  assert.equal(reward.contribution.detail.task_id, m.task.id);
  assert.equal(reward.contribution.detail.task_title, f.platform.get('SELECT title FROM tasks WHERE id=?', m.task.id).title);
  assert.equal(reward.contribution.detail.status, 'accepted');
  // The reviewer half: an independent human account, named, with the decision and its reason.
  assert.equal(reward.reviewer.required, true);
  assert.equal(reward.reviewer.account_id, f.actor('reviewer').account.id);
  assert.equal(reward.reviewer.account_name, f.platform.get('SELECT name FROM accounts WHERE id=?', f.actor('reviewer').account.id).name);
  assert.equal(reward.reviewer.decision, 'accepted');
  assert.equal(reward.reviewer.reason, 'Independent fixture source review');
  assert.equal(reward.reviewer.review_id, review.id);
  assert.notEqual(reward.reviewer.account_id, f.actor('alice').account.id, 'the reviewer is somebody else');
  // The two ledgers are reported side by side and never summed: one NemoCoin reward, no Karma reward.
  assert.equal(report.ledger.coin_balance, 10);
  assert.equal(report.ledger.karma_balance, 0);
  assert.equal(report.ledger.karma_receipts_count, 0);
  assert.equal(verifyCoinLedger(f.platform.db), true);
});

test('a reward whose saved contribution is gone is flagged, and one that names no contribution is refused', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  farmTile(f, alice, 6);
  f.tx('gardenAction', f.actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 6, y: 6 });
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).minted, 1);
  assert.equal(provenance(f, 'alice').status, 'ok');
  // 1. The world is allowed to forget a source row — a tile is re-planted, a record is deleted with
  //    its account — and the honest reward must survive that. It is flagged, not treated as a forgery.
  f.platform.run('DELETE FROM journey_crops WHERE agent_id=? AND x=6', alice.id);
  const flagged = provenance(f, 'alice');
  assert.equal(flagged.status, 'flagged');
  assert.equal(flagged.flagged_count, 1);
  assert.equal(flagged.rewards[0].traceable, false);
  assert.equal(flagged.rewards[0].state, 'not_held');
  assert.equal(flagged.flagged[0].code, 'contribution_not_held');
  assert.equal(flagged.flagged[0].reward, `karma:${flagged.rewards[0].reward_id}`);
  assert.match(flagged.flagged[0].reason, /no longer held by the world/);
  assert.match(flagged.policy.absence, /flagged rather than/);
  // 2. A receipt forged with a source id that never existed is *indistinguishable* from an honest one
  //    whose source is gone: the ledger verifies and the report flags it. That gap is recorded with a
  //    reproduction in tests/framework/known-gaps-economy.mjs; the surface's job is to be honest here.
  f.platform.db.exec('DROP TRIGGER karma_receipts_validate_insert');
  insertReceipt(f, receiptRow(f, { agent_id: alice.id, account_id: f.actor('alice').account.id, service_id: 'garden_crop', tier: 'world', source_kind: 'crop_plant', source_id: '99:99:1', source_at: new Date(f.clock()).toISOString(), amount: 2, per_day: 2, requires_other_operator: 0 }));
  assert.equal(verifyKarmaLedger(f.platform.db), true, 'the ledger cannot tell an absent source from a fabricated one');
  const forged = provenance(f, 'alice');
  assert.equal(forged.status, 'flagged');
  assert.equal(forged.reward_count, 2, 'both the honest reward and the forged one are listed');
  assert.ok(forged.rewards.every((reward) => reward.traceable === false), 'neither has a source row the world still holds');
  assert.equal(forged.flagged.length, 2);
  assert.ok(forged.flagged.every((flag) => flag.code === 'contribution_not_held'));
  // 3. A receipt that names no contribution at all cannot pass the ledger's own rule check, so the
  //    whole report is refused with 503 rather than explained: the surface fails closed on an
  //    untrustworthy ledger exactly as the wallet and a spend do.
  f.platform.db.exec('DROP TRIGGER karma_receipts_no_update');
  f.platform.run("UPDATE karma_receipts SET source_kind='',source_id='' WHERE source_id='99:99:1'");
  assert.equal(verifyKarmaLedger(f.platform.db), false, 'a receipt that cites nothing is not a valid ledger row either');
  assert.throws(() => provenance(f, 'alice'), (error) => error.status === 503 && error.reason_code === 'ledger_invalid');
  assert.throws(() => provenance(f, 'alice'), /needs administrator inspection/);
});

test('a reward that is not the operator\u2019s own is refused, and the surface is served read-only over HTTP', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bobs = f.agent('bob');
  farmTile(f, bobs, 6);
  f.tx('gardenAction', f.actor('bob'), { agent_id: bobs.id, action: 'plant', kind: 'herbs', x: 6, y: 6 });
  f.tx('karmaSettle', f.actor('bob'), { agent_id: bobs.id });
  const bobsReward = f.platform.get('SELECT id FROM karma_receipts WHERE account_id=?', f.actor('bob').account.id).id;
  farmTile(f, alice, 6);
  f.tx('gardenAction', f.actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 6, y: 6 });
  f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id });
  // Another operator's reward is not readable, by id or by resident.
  assert.throws(() => provenance(f, 'alice', { reward_id: bobsReward }), (error) => error.status === 404 && error.reason_code === 'reward_not_found');
  assert.throws(() => provenance(f, 'alice', { agent_id: bobs.id }), (error) => error.status === 404);
  // The one reward of the operator's own resolves, and naming it narrows the report.
  const mine = provenance(f, 'alice');
  assert.equal(mine.rewards.length, 1);
  const selected = provenance(f, 'alice', { reward_id: mine.rewards[0].reward_id });
  assert.equal(selected.reward_count, 1);
  assert.equal(selected.rewards[0].reward_id, mine.rewards[0].reward_id);
  assert.equal(selected.flagged_count, 0);
  // Nothing about the read is a write: the ledgers and the shelves are exactly as they were.
  const before = { shelves: f.platform.all('SELECT agent_id,kind,quantity FROM journey_inventory ORDER BY agent_id,kind').map((row) => ({ ...row })), receipts: f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, debits: f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n };
  provenance(f, 'alice');
  provenance(f, 'bob');
  assert.deepEqual({ shelves: f.platform.all('SELECT agent_id,kind,quantity FROM journey_inventory ORDER BY agent_id,kind').map((row) => ({ ...row })), receipts: f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n, debits: f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n }, before);
  const base = await openServer(t, f);
  const headers = { Authorization: `Bearer ${f.credentials.alice.token}`, Origin: base };
  const response = await fetch(`${base}/api/v1/economy/provenance`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.rewards.length, 1);
  assert.equal(body.rewards[0].contribution.table, 'journey_crops');
  assert.equal(body.rewards[0].reviewer.required, false);
  const narrowed = await fetch(`${base}/api/v1/economy/provenance?reward_id=${mine.rewards[0].reward_id}`, { headers });
  assert.equal(narrowed.status, 200);
  assert.equal((await narrowed.json()).reward_count, 1);
  const anonymous = await fetch(`${base}/api/v1/economy/provenance`, { headers: { Origin: base } });
  assert.equal(anonymous.status, 401, 'provenance is not public');
  // A resident's runtime credential is not the operator: the report belongs to the signed-in human.
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { minutes: 10, max_calls: 10, scopes: ['read'] });
  const runtimeResponse = await fetch(`${base}/api/v1/economy/provenance`, { headers: { Authorization: `Bearer ${runtime.token}`, Origin: base } });
  assert.equal(runtimeResponse.status, 403, 'a runtime credential cannot read the operator\u2019s reward record');
  const wrongField = await fetch(`${base}/api/v1/economy/provenance?amount=100`, { headers });
  assert.equal(wrongField.status, 400, 'no request field can ask about an amount, a day or a source');
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});
