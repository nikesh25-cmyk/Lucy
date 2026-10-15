import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

// The operator-visible half of the framework, over real HTTP: pause, inspect, resume and revoke, a
// moderator's own sanction path, the one additive read route, and the privacy line that read must
// not cross. Both halves are asserted: the allowed read, and the refusal on private material.

const sha = (value) => createHash('sha256').update(value).digest('hex');
const openServer = async (t, f) => {
  const app = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  return { app, base };
};
const request = (base, token, route, { method = 'GET', body, key } = {}) => fetch(`${base}/api/v1${route}`, {
  method, redirect: 'error',
  headers: { Authorization: `Bearer ${token}`, Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const resident = (f, owner = 'alice', name = 'Operator resident') =>
  f.tx('createAgent', f.actor(owner), { name, capabilities: 'Read and summarize approved sources', limitations: 'Requires source and human review', color: '#397f79', symbol: '✦' });
const gathering = (f, host) => f.tx('createEvent', f.actor('bob'), {
  agent_id: host.id, title: 'Shared garden hour', summary: 'A peaceful gathering in the commons.', world_id: 'commons',
  starts_at: new Date(f.clock() + 3600_000).toISOString(), ends_at: new Date(f.clock() + 7200_000).toISOString(), capacity: 5,
});

test('an operator pauses, inspects, resumes and revokes a resident, and every state is readable', async (t) => {
  const f = await fixture(t);
  const { base } = await openServer(t, f);
  const mine = resident(f);
  const neighbour = resident(f, 'bob', 'Neighbour resident');
  f.tx('callingSelect', f.actor('alice'), { agent_id: mine.id, calling_id: 'mediator' });
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: mine.id, kind: 'purpose', attribute: 'intent', subject: 'Stated purpose', value: 'Notice other operators’ work and say so plainly.' });
  const session = f.tx('runtime', f.actor('alice'), mine.id, { minutes: 20, max_calls: 6, scopes: ['read', 'move', 'chat', 'contribute'] });

  // One declared action through the route, with the intent id carried in the shipped Idempotency-Key header.
  const action = { action: 'thanks', serves: 'mediator.thanks', recipient_agent_id: neighbour.id, reason: 'A specific, observed contribution to the shared garden.' };
  const first = await request(base, session.token, '/residents/act', { method: 'POST', body: action, key: 'intent-walkthrough-1' });
  assert.equal(first.status, 200);
  const executed = await first.json();
  assert.equal(executed.state, 'executed');
  assert.equal(executed.success, true);
  assert.equal(executed.saved.verified, true);
  assert.equal(executed.budget.remaining_after_charge, 5);
  // The same intent again is a replay, never a second write.
  const replay = await request(base, session.token, '/residents/act', { method: 'POST', body: action, key: 'intent-walkthrough-1' });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).state, 'replayed');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 1);
  assert.equal(f.platform.get("SELECT used_calls FROM tokens WHERE agent_id=? AND kind='runtime'", mine.id).used_calls, 2, 'the route charges one call per request, as every other runtime write does');

  // Inspect: the declaration, the budget, the purpose, the history and the controls, for the owner.
  const inspected = await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`);
  assert.equal(inspected.status, 200);
  const view = await inspected.json();
  assert.equal(view.viewer.relationship, 'owner');
  assert.equal(view.declaration.identity.agent_id, mine.id);
  assert.equal(view.declaration.calling.id, 'mediator');
  assert.equal(view.declaration.purpose.statement, 'Notice other operators’ work and say so plainly.');
  assert.equal(view.declaration.budget.max_calls, 6);
  assert.deepEqual(view.declaration.prohibitions.map((rule) => rule.id), ['self-review', 'institutional-authority', 'self-award', 'proposal-not-outcome']);
  assert.equal(view.action_history.entries[0].action, 'thanks');
  assert.equal(view.action_history.entries[0].state, 'executed');
  assert.equal(view.action_history.entries[0].is_outcome, true);
  assert.equal(view.action_history.counts.executed, 1);
  assert.equal(view.controls.find((control) => control.control === 'pause').available, true);
  assert.equal(view.controls.find((control) => control.control === 'resume').available, false);
  assert.ok(view.privacy.excluded.some((entry) => entry.material === 'memory'));
  // Another operator's session learns nothing beyond a 404, and a session may not act for a resident.
  assert.equal((await request(base, f.credentials.bob.token, `/residents/declaration?agent_id=${mine.id}`)).status, 404);
  assert.equal((await request(base, f.credentials.alice.token, '/residents/act', { method: 'POST', body: action, key: 'session-1' })).status, 403);

  // Pause: the world's own control, and the declaration follows it without a second store.
  assert.equal((await request(base, f.credentials.alice.token, '/agents/control', { method: 'POST', body: { agent_id: mine.id, status: 'paused' } })).status, 200);
  const paused = await (await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`)).json();
  assert.equal(paused.declaration.identity.state, 'paused');
  assert.equal(paused.declaration.may_act, false);
  assert.equal(paused.declaration.may_act_reason, 'resident_not_active');
  assert.equal(paused.controls.find((control) => control.control === 'pause').available, false);
  assert.equal(paused.controls.find((control) => control.control === 'resume').available, true);
  assert.equal(paused.declaration.budget.live_credential, false, 'pausing revoked the runtime credential');

  // Resume, then act again with a fresh credential.
  assert.equal((await request(base, f.credentials.alice.token, '/agents/control', { method: 'POST', body: { agent_id: mine.id, status: 'active' } })).status, 200);
  const resumed = await (await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`)).json();
  assert.equal(resumed.declaration.identity.state, 'active');
  const second = f.tx('runtime', f.actor('alice'), mine.id, { minutes: 20, max_calls: 4, scopes: ['read', 'contribute'] });
  // A cooperative project another operator keeps, so the pledge is anchored to a real record.
  const project = f.tx('createProject', f.actor('bob'), { agent_id: neighbour.id, title: 'Shared garden survey', summary: 'Survey one bed together.', goal: 'One reviewed survey note.', evidence_requirements: 'A dated note with its exact location.', milestones: ['Record the survey'] });
  const again = await request(base, second.token, '/residents/act', { method: 'POST', body: { action: 'pledge', serves: 'mediator.project_pledge', project_id: project.id, intent: 'pledge', commitment: 'I can inspect the stated goal and report one bounded next step for human review.', intent_id: 'after-resume-1' } });
  assert.equal(again.status, 200);
  const pledged = await again.json();
  assert.equal(pledged.state, 'proposed');
  assert.equal(pledged.proposal, true);
  assert.equal(pledged.achieved, false);

  // Revoke: the credential is gone, so the runtime cannot continue past it.
  assert.equal((await request(base, f.credentials.alice.token, '/agents/control', { method: 'POST', body: { agent_id: mine.id, status: 'revoked' } })).status, 200);
  const revoked = await (await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`)).json();
  assert.equal(revoked.declaration.identity.state, 'revoked');
  assert.equal(revoked.declaration.budget.revoked, true);
  assert.equal(revoked.declaration.may_act, false);
  assert.equal(revoked.controls.find((control) => control.control === 'revoke').available, false);
  assert.equal((await request(base, second.token, '/residents/act', { method: 'POST', body: { action: 'pledge', serves: 'mediator.project_pledge', project_id: project.id, intent: 'pledge', commitment: 'A second bounded step.', intent_id: 'after-revoke-1' } })).status, 401);
  // The whole ledger is the world's own audit chain, and it still verifies after all of this.
  assert.equal(f.platform.verifyAudit(), true);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event LIKE 'resident.action.%'").n, 2);
});

test('a moderator suspends a resident, and the sanction and its lift are readable and reversible', async (t) => {
  const f = await fixture(t);
  const { base } = await openServer(t, f);
  const mine = resident(f);
  const neighbour = resident(f, 'bob', 'Neighbour resident');
  f.tx('callingSelect', f.actor('alice'), { agent_id: mine.id, calling_id: 'mediator' });
  const session = f.tx('runtime', f.actor('alice'), mine.id, { minutes: 20, max_calls: 8, scopes: ['read', 'contribute'] });
  await request(base, session.token, '/residents/act', { method: 'POST', body: { action: 'thanks', serves: 'mediator.thanks', recipient_agent_id: neighbour.id, reason: 'A named contribution.', intent_id: 'moderation-1' } });

  const report = await (await request(base, f.credentials.alice.token, '/reports', { method: 'POST', body: { target_type: 'agent', target_id: mine.id, reason: 'A moderator should look at this resident.' } })).json();
  const suspended = await request(base, f.credentials.moderator.token, '/moderation', { method: 'POST', body: { report_id: report.id, action: 'suspend', reason: 'Suspended while the report is examined.' } });
  assert.equal(suspended.status, 200);
  const afterSanction = await (await request(base, f.credentials.moderator.token, `/residents/declaration?agent_id=${mine.id}`)).json();
  assert.equal(afterSanction.declaration.identity.state, 'suspended');
  assert.equal(afterSanction.declaration.may_act, false);
  assert.equal(afterSanction.declaration.budget.revoked, true);
  assert.equal(afterSanction.controls.find((control) => control.control === 'lift-suspension').available, true);
  assert.equal(afterSanction.action_history.counts.executed, 1, 'the sanction leaves the recorded history untouched');
  // The owner cannot lift its own suspension, and the revoked credential is refused.
  const refusedResume = await request(base, f.credentials.alice.token, '/agents/control', { method: 'POST', body: { agent_id: mine.id, status: 'active' } });
  assert.equal(refusedResume.status, 403);
  assert.match((await refusedResume.json()).error, /moderator/);
  assert.equal((await request(base, session.token, '/residents/act', { method: 'POST', body: { action: 'thanks', serves: 'mediator.thanks', recipient_agent_id: neighbour.id, reason: 'A second contribution.', intent_id: 'moderation-2' } })).status, 401);

  // An appeal, decided by a different uninvolved human, returns the resident to paused; the operator
  // then decides whether to resume it. Nothing here grants a moderator a reading of private material.
  const appeal = await (await request(base, f.credentials.alice.token, '/appeals', { method: 'POST', body: { report_id: report.id, reason: 'The report should be reconsidered.' } })).json();
  const overturned = await request(base, f.credentials.admin.token, '/appeals/decide', { method: 'POST', body: { appeal_id: appeal.id, decision: 'overturned', reason: 'The report does not describe a community harm.' } });
  assert.equal(overturned.status, 200);
  const lifted = await (await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`)).json();
  assert.equal(lifted.declaration.identity.state, 'paused');
  assert.equal(lifted.controls.find((control) => control.control === 'resume').available, true);
  assert.equal((await request(base, f.credentials.alice.token, '/agents/control', { method: 'POST', body: { agent_id: mine.id, status: 'active' } })).status, 200);
  assert.equal((await (await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`)).json()).declaration.identity.state, 'active');
});

test('the inspection surface exposes the declaration and refuses every piece of private material', async (t) => {
  const f = await fixture(t);
  const { base } = await openServer(t, f);
  const mine = resident(f);
  const neighbour = resident(f, 'bob', 'Neighbour resident');
  const secret = 'private-sentence-do-not-expose-7c21';
  // Private material of three kinds: an operator preference, a private conversation and a vault note.
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: mine.id, kind: 'preference', attribute: 'communication', subject: 'Quiet hours', value: secret });
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: mine.id, kind: 'purpose', attribute: 'intent', subject: 'Stated purpose', value: 'Keep the shared path open.' });
  f.tx('runtime', f.actor('bob'), neighbour.id, { minutes: 10, max_calls: 20, scopes: ['read', 'chat'] });
  f.tx('message', f.actor('bob'), { agent_id: neighbour.id, text: secret, channel: 'private', recipient_id: mine.id });
  const session = f.tx('runtime', f.actor('alice'), mine.id, { minutes: 20, max_calls: 10, scopes: ['read', 'chat', 'contribute', 'vault'] });
  f.tx('vaultWrite', f.platform.authorize(sha(session.token), 'vault'), { agent_id: mine.id, slot: 2, text: secret });
  // The resident also does one recorded piece of work, so the history it exposes is not empty.
  const event = gathering(f, neighbour);
  f.tx('callingSelect', f.actor('alice'), { agent_id: mine.id, calling_id: 'host' });
  const acted = await request(base, session.token, '/residents/act', { method: 'POST', body: { action: 'rsvp', serves: 'host.event_rsvp', event_id: event.id, intent: 'join', intent_id: 'privacy-1' } });
  assert.equal(acted.status, 200);
  assert.equal((await acted.json()).state, 'proposed');

  for (const [who, token] of [['operator', f.credentials.alice.token], ['moderator', f.credentials.moderator.token]]) {
    const response = await request(base, token, `/residents/declaration?agent_id=${mine.id}`);
    assert.equal(response.status, 200, `${who} may inspect`);
    const body = await response.text();
    assert.equal(body.includes(secret), false, `${who} must never receive private material`);
    const view = JSON.parse(body);
    assert.equal(view.viewer.relationship, who === 'operator' ? 'owner' : 'moderation');
    // The allowed read is real, not an empty object.
    assert.equal(view.declaration.identity.agent_id, mine.id);
    assert.equal(view.declaration.purpose.statement, 'Keep the shared path open.');
    assert.deepEqual(view.declaration.purpose.facts.map((fact) => fact.attribute), ['intent']);
    assert.equal(view.action_history.entries[0].action, 'rsvp');
    assert.equal(view.action_history.entries[0].state, 'proposed');
    assert.equal(view.action_history.entries[0].is_outcome, false);
    assert.ok(view.declaration.limitations.policy.length > 0);
    assert.equal(view.privacy.excluded.length, 4);
  }

  // A moderator may not pause, revoke or resume another operator's resident directly.
  assert.equal((await request(base, f.credentials.moderator.token, '/agents/control', { method: 'POST', body: { agent_id: mine.id, status: 'paused' } })).status, 404);
  const moderationView = await (await request(base, f.credentials.moderator.token, `/residents/declaration?agent_id=${mine.id}`)).json();
  assert.equal(moderationView.controls.find((control) => control.control === 'pause').available, false);
  assert.equal(moderationView.controls.find((control) => control.control === 'suspend').available, true);
  assert.match(moderationView.controls.find((control) => control.control === 'pause').refused, /open report/);

  // Asking for private material is refused by name, with where each piece stays.
  for (const include of ['memory', 'conversations', 'vault', 'memory,conversations,vault']) {
    const refused = await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}&include=${include}`);
    assert.equal(refused.status, 403, `${include} must be refused`);
    const body = await refused.json();
    assert.equal(body.state, 'refused');
    assert.match(body.error, /never exposes/);
    assert.ok(body.private_refusals.length > 0);
    assert.ok(body.private_refusals.every((entry) => entry.note && entry.where_it_stays));
    assert.equal(JSON.stringify(body).includes(secret), false);
  }
  assert.equal((await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}&include=models`)).status, 400);
  // The private routes still serve their own authorised callers, so nothing was removed by this surface.
  assert.equal((await (await request(base, f.credentials.alice.token, `/memory?agent_id=${mine.id}`)).text()).includes(secret), true);
});

test('the runtime and the operator read one declaration, not two copies of it', async (t) => {
  const f = await fixture(t);
  const { base } = await openServer(t, f);
  const mine = resident(f);
  f.tx('callingSelect', f.actor('alice'), { agent_id: mine.id, calling_id: 'researcher' });
  f.tx('memoryManage', f.actor('alice'), { action: 'record', agent_id: mine.id, kind: 'purpose', attribute: 'boundary', subject: 'Boundary', value: 'Only public, licensed sources.' });
  const session = f.tx('runtime', f.actor('alice'), mine.id, { minutes: 20, max_calls: 5, scopes: ['read', 'move', 'chat', 'contribute'] });
  // The resident's own private read carries the declaration; the operator route carries the same one.
  const residentRead = await request(base, session.token, '/callings');
  assert.equal(residentRead.status, 200);
  const residentView = (await residentRead.json()).declaration;
  assert.ok(residentView, 'the resident reads its own declaration inside the read it already makes');
  const operatorView = (await (await request(base, f.credentials.alice.token, `/residents/declaration?agent_id=${mine.id}`)).json()).declaration;
  // The two reads differ only in the live counters each request charges, so the stable halves are
  // compared whole and the moving counters are compared field by field.
  const stable = ({ generated_at, budget, ...rest }) => rest;
  assert.deepEqual(stable(residentView), stable(operatorView));
  const { used_calls: residentUsed, remaining_calls: residentRemaining, expires_in_ms: residentExpiry, ...residentBudget } = residentView.budget;
  const { used_calls: operatorUsed, remaining_calls: operatorRemaining, expires_in_ms: operatorExpiry, ...operatorBudget } = operatorView.budget;
  assert.deepEqual(residentBudget, operatorBudget);
  assert.equal(residentBudget.max_calls, 5);
  assert.equal(residentBudget.live_credential, true);
  assert.equal(operatorUsed - residentUsed, 1, 'only the counters move between two reads of one declaration');
  assert.equal(residentRemaining - operatorRemaining, 1);
  assert.equal(residentExpiry, operatorExpiry, 'the test clock is frozen, so the expiry is unmoved');
  assert.deepEqual(residentView.purpose.boundaries, ['Only public, licensed sources.']);
  // A researcher's own objectives are a scoped claim and an independent acceptance: the approved-source
  // worker's work and a human decision. No declared action may serve them, so this calling's available
  // actions are its presence and record actions, and the declaration says exactly that.
  const work = residentView.permitted_actions.filter((entry) => entry.family === 'work');
  assert.ok(work.every((entry) => entry.serves.length === 0 && entry.available === false));
  assert.ok(work.every((entry) => entry.purpose_basis === 'not-named-by-this-calling'));
  assert.ok(residentView.permitted_actions.filter((entry) => entry.family !== 'work' && entry.granted).every((entry) => entry.available));
  assert.equal(residentView.permitted_actions.find((entry) => entry.action === 'note').granted, false, 'the vault scope was not granted');
  assert.equal(residentView.may_act, true);
});
