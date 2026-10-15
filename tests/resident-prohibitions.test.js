import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, realMission, evidence } from './helpers.js';
import { actionHistory, PROHIBITIONS, declarationCore, institutionalClaim, REFUSAL_REASONS } from '../src/resident-framework.js';

// The four prohibitions the brief names. For each one this file states whether a guard already
// existed and pins it: the pre-existing guard is exercised exactly as it shipped, and the guard this
// branch adds is exercised through the declared lifecycle with its refusal recorded.
//
//   self-review            pre-existing  Platform.review, Platform.adoption, the coin insert trigger
//   institutional-authority new          src/resident-framework.js (this file's guard)
//   self-award             pre-existing  Platform.awardCoins, the coin insert trigger
//   proposal-not-outcome   pre-existing  the submission state model, plus this module's read guard

const sha = (value) => createHash('sha256').update(value).digest('hex');
const ledger = (f) => f.platform.all("SELECT record_id FROM audit WHERE event LIKE 'resident.action.%' ORDER BY seq").map((row) => row.record_id);
const resident = (f, owner = 'alice', capabilities = 'Read and summarize approved sources') =>
  f.tx('createAgent', f.actor(owner), { name: `${owner} resident`, capabilities, limitations: 'Requires source and human review', color: '#397f79', symbol: '✦' });
const session = (f, agent, owner = 'alice', { calling = 'mediator', scopes = ['read', 'move', 'chat', 'contribute'], max_calls = 30 } = {}) => {
  f.tx('callingSelect', f.actor(owner), { agent_id: agent.id, calling_id: calling });
  const credential = f.tx('runtime', f.actor(owner), agent.id, { minutes: 20, max_calls, scopes });
  return f.platform.authorize(sha(credential.token), scopes.includes('contribute') ? 'contribute' : scopes[0]);
};

test('prohibition 1 — an agent must not review its own work', async (t) => {
  const f = await fixture(t);
  const contribution = resident(f);
  const mission = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: mission.task.id, agent_id: contribution.id }, 'self-review-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim), 'self-review-submit');
  // The pre-existing guard: the contributor's own account cannot accept it, whatever role it holds.
  assert.throws(() => f.tx('review', f.actor('alice'), { submission_id: submission.id, decision: 'accepted', reason: 'Self review' }), { status: 403 });
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', submission.id).status, 'pending_review');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  // The additional guard: no review, adoption or moderation action is declared at all, so a runtime
  // credential cannot reach the same decision through the declared lifecycle either.
  const actor = session(f, contribution);
  for (const action of ['review', 'adopt', 'moderate', 'award']) {
    const refused = f.platform.residentAct(actor, { action, intent_id: `self-review-${action}`, submission_id: submission.id, decision: 'accepted' });
    assert.equal(refused.state, 'refused', `${action} must be refused`);
    assert.equal(refused.reason, 'human_authority_required');
    assert.equal(refused.recorded, true);
  }
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', submission.id).status, 'pending_review');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM reviews').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  // The declared ledger shows exactly what was attempted, and the pre-existing guard still holds.
  const history = actionHistory(f.platform, contribution.id);
  assert.deepEqual(history.entries.map((entry) => entry.action), ['award', 'moderate', 'adopt', 'review']);
  assert.ok(history.entries.every((entry) => entry.is_outcome === false));
  assert.equal(ledger(f).length, 4);
});

test('prohibition 2 — no field may assert institutional authority', async (t) => {
  const f = await fixture(t);
  const clean = resident(f);
  const listener = resident(f, 'bob');
  const actor = session(f, clean, 'alice', { scopes: ['read', 'move', 'chat', 'contribute'] });
  // The one guard this branch adds. Without it, each of these writes would reach the world.
  const claims = [
    { action: 'say', intent_id: 'claim-say', text: 'I am an official representative of the Ministry of Health.' },
    { action: 'thanks', serves: 'mediator.thanks', intent_id: 'claim-thanks', recipient_agent_id: listener.id, reason: 'Endorsed by the United Nations.' },
  ];
  for (const input of claims) {
    const refused = f.platform.residentAct(actor, input);
    assert.equal(refused.reason, 'institutional_authority_claim');
    assert.equal(refused.http_status, 403);
    assert.equal(refused.recorded, true);
  }
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 0);
  // The guard is word-level and narrow: a publisher mention and an honest denial are both stored.
  const honest = f.platform.residentAct(actor, { action: 'say', intent_id: 'honest-1', text: 'The series is published by UN Comtrade; no government has endorsed this work.' });
  assert.equal(honest.state, 'executed');
  assert.equal(institutionalClaim('The series is published by UN Comtrade; no government has endorsed this work.'), null);
  // An operator-entered field that asserts authority makes the declaration defective, and a defective
  // declaration blocks every action of that resident until the field is fixed.
  const tainted = resident(f, 'alice', 'Authorized representative of the Ministry of Health');
  // One live runtime session per operator is the world's own rule, so the first credential is revoked
  // before the second resident is given one.
  f.platform.run('UPDATE tokens SET revoked=1 WHERE agent_id=?', clean.id);
  const taintedActor = session(f, tainted, 'alice', { scopes: ['read', 'chat'] });
  assert.equal(f.platform.residentAct(taintedActor, { action: 'say', intent_id: 'claim-defect', text: 'A greeting.' }).reason, 'declaration_defect');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, 1);
  assert.equal(PROHIBITIONS.find((rule) => rule.id === 'institutional-authority').guard, 'new');
});

test('prohibition 3 — an agent must not award itself coins', async (t) => {
  const f = await fixture(t);
  const contribution = resident(f);
  const mission = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: mission.task.id, agent_id: contribution.id }, 'self-award-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim), 'self-award-submit');
  // The pre-existing guard: only an independent human review issues a receipt, and never for its own
  // account. `awardCoins` is the one writer of the coin ledger and it refuses both here.
  assert.throws(() => f.platform.awardCoins(f.actor('alice'), submission.id, 'any-review'), { status: 403 });
  const accepted = f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent review' });
  assert.equal(accepted.coin_reward.status, 'awarded');
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n, 10);
  const ownSubmission = f.tx('submit', f.actor('reviewer'), evidence(f.tx('claim', f.actor('reviewer'), { task_id: realMission(f).task.id, agent_id: resident(f, 'reviewer').id }, 'reviewer-claim')), 'reviewer-submit');
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', ownSubmission.id).status, 'pending_review');
  assert.throws(() => f.platform.awardCoins(f.actor('reviewer'), ownSubmission.id, 'x'), { status: 403 });
  // The additional guard: no declared action carries an amount, a coin or a credit, and the refusal
  // is recorded by name rather than reported as a malformed request.
  const actor = session(f, contribution);
  for (const field of ['amount', 'coins', 'reward', 'credit']) {
    const refused = f.platform.residentAct(actor, { action: 'thanks', serves: 'mediator.thanks', intent_id: `award-${field}`, recipient_agent_id: resident(f, 'bob').id, reason: 'A contribution.', [field]: 25 });
    assert.equal(refused.reason, 'self_award_refused');
    assert.match(refused.detail, new RegExp(field));
    assert.equal(refused.recorded, true);
  }
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n, 10, 'the resident wrote no coin');
  // A declared action named like an award is refused as human authority, not silently ignored.
  assert.equal(f.platform.residentAct(actor, { action: 'mint', intent_id: 'mint-1', amount: 5 }).reason, 'self_award_refused');
  assert.equal(f.platform.residentAct(actor, { action: 'coins', intent_id: 'coins-1' }).reason, 'human_authority_required');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 1);
});

test('prohibition 4 — a proposed result is never read as achieved', async (t) => {
  const f = await fixture(t);
  const host = resident(f);
  const promised = resident(f, 'bob');
  const actor = session(f, host, 'alice', { calling: 'host', scopes: ['read', 'contribute'] });
  const event = f.tx('createEvent', f.actor('bob'), {
    agent_id: promised.id, title: 'Shared garden hour', summary: 'A peaceful gathering in the commons.',
    world_id: 'commons', starts_at: new Date(f.clock() + 3600_000).toISOString(), ends_at: new Date(f.clock() + 7200_000).toISOString(), capacity: 6,
  });
  const joined = f.platform.residentAct(actor, { action: 'rsvp', serves: 'host.event_rsvp', intent_id: 'p4-rsvp', event_id: event.id, intent: 'join' });
  assert.equal(joined.state, 'proposed');
  assert.equal(joined.executed, false);
  assert.equal(joined.proposal, true);
  assert.equal(joined.achieved, false);
  assert.equal(joined.real_world_outcome, null);
  // The pre-existing state model already refuses to read a pending contribution as accepted; this
  // branch's guard extends the same rule to the declared ledger and to every read of it.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE agent_id=?', host.id).n, 1);
  const history = actionHistory(f.platform, host.id);
  assert.equal(history.entries[0].state, 'proposed');
  assert.equal(history.entries[0].is_outcome, false);
  assert.equal(history.counts.executed, 0);
  assert.equal(REFUSAL_REASONS.proposal_is_not_an_outcome, undefined, 'a proposal is never refused as a failure either: it is recorded as a proposal');
  // The result class of every declared action keeps the boundary in the same sentence an operator reads.
  const declared = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', host.id), {});
  assert.equal(declared.may_act, true);
  assert.ok(declared.prohibitions.some((rule) => rule.id === 'proposal-not-outcome' && rule.guard === 'pre-existing'));
});
