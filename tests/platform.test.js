import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { fixture, realMission, evidence, PASSWORD } from './helpers.js';

const denied = (operation, status) => assert.throws(operation, (error) => error.status === status);

test('first account bootstraps an admin, invitations are single use, and role changes revoke access', async (t) => {
  const f = await fixture(t);
  assert.equal(f.actor('admin').account.role, 'admin');
  await assert.rejects(f.platform.register({ name: 'Uninvited', email: 'uninvited@example.org', password: PASSWORD, consent: true }), { status: 403 });
  const invitation = f.tx('invite', f.actor('admin'), { role: 'member' });
  const member = await f.platform.register({ name: 'Invited', email: 'invited@example.org', password: PASSWORD, consent: true, invite: invitation.code });
  assert.equal(member.account.role, 'member');
  await assert.rejects(f.platform.register({ name: 'Reuse', email: 'reuse@example.org', password: PASSWORD, consent: true, invite: invitation.code }), { status: 403 });
  denied(() => f.tx('invite', f.actor('alice'), { role: 'admin' }), 403);
  f.tx('accountControl', f.actor('admin'), { account_id: member.account.id, status: 'suspended' });
  denied(() => f.platform.authenticate(member.token), 401);
  await assert.rejects(f.platform.login({ email: member.account.email, password: PASSWORD }), { status: 401 });
  assert.equal(f.platform.verifyAudit(), true);
});

test('runtime identity is agent bound, scoped, budgeted, expiring, and revocable', async (t) => {
  const f = await fixture(t);
  const avatar = f.agent('alice');
  const sibling = f.agent('alice', 'Sibling');
  denied(() => f.tx('runtime', f.actor('bob'), avatar.id, {}), 404);
  const session = f.tx('runtime', f.actor('alice'), avatar.id, { minutes: 1, max_calls: 2, scopes: ['read'] });
  const runtime = f.platform.authenticate(session.token, 'read');
  assert.equal(runtime.agent.id, avatar.id);
  denied(() => f.tx('runtime', f.actor('alice'), sibling.id, {}), 429);
  denied(() => f.platform.authenticate(session.token, 'move'), 403);
  denied(() => f.platform.ownedAgent(runtime, sibling.id), 404);
  denied(() => f.tx('invite', runtime, { role: 'member' }), 403);
  denied(() => f.platform.exportAccount(runtime), 403);
  const claim = f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: sibling.id }, 'sibling-claim');
  denied(() => f.tx('claim', runtime, { task_id: claim.task_id }, 'sibling-claim'), 404);
  f.tx('charge', runtime);
  f.tx('charge', f.platform.authenticate(session.token, 'read'));
  denied(() => f.platform.authenticate(session.token, 'read'), 429);
  assert.equal(f.platform.runtimeStatus(f.platform.authenticate(session.token)).remaining_calls, 0);
  const next = f.tx('runtime', f.actor('alice'), avatar.id, { minutes: 1, max_calls: 5 });
  f.advance(60_001);
  denied(() => f.platform.authenticate(next.token), 401);
  const resumed = f.tx('runtime', f.actor('alice'), avatar.id, {});
  f.tx('agentControl', f.actor('alice'), avatar.id, 'paused');
  denied(() => f.platform.authenticate(resumed.token), 401);
  assert.equal(f.platform.verifyAudit(), true);
});

test('mission drafts are private, real task sources are explicit, and suspended owners cannot reopen work', async (t) => {
  const f = await fixture(t);
  const mission = f.tx('createMission', f.actor('admin'), {
    title: 'Private draft', area: 'Peace', summary: 'Unpublished scope.', beneficiary: 'Fixture beneficiary',
    owner_id: f.actor('alice').account.id, reviewer_id: f.actor('reviewer').account.id, rubric: 'Original source checks.',
  });
  assert.equal(f.platform.missionList().missions.some((m) => m.id === mission.id), false);
  assert.equal(f.platform.missionList(f.actor('bob')).missions.some((m) => m.id === mission.id), false);
  assert.equal(f.platform.missionList(f.actor('reviewer')).missions.some((m) => m.id === mission.id), true);
  const taskInput = { mission_id: mission.id, title: 'Draft task', instructions: 'Record a source.', rights: 'Permission required.' };
  denied(() => f.tx('createTask', f.actor('admin'), taskInput), 400);
  f.tx('createTask', f.actor('admin'), { ...taskInput, allowed_domains: ['example.org'] });
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('alice').account.id, status: 'suspended' });
  denied(() => f.tx('missionStatus', f.actor('admin'), mission.id, 'open'), 409);
  assert.equal(f.platform.missionList().tasks.some((task) => task.mission_id === mission.id), false);
});

test('public, nearby, and private conversation views redact contacts and isolate agent sessions', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const sibling = f.agent('alice', 'Sibling');
  const bob = f.agent('bob');
  const stranger = f.agent('reviewer');
  f.tx('message', f.actor('alice'), { agent_id: alice.id, text: 'Public greeting', channel: 'public' });
  f.advance();
  const secret = f.tx('message', f.actor('alice'), { agent_id: alice.id, recipient_id: bob.id, text: 'Private conversation fixture', channel: 'private' });
  assert.equal(f.platform.world().messages.some((m) => m.id === secret.id), false);
  assert.equal(f.platform.world(f.actor('bob')).messages.some((m) => m.id === secret.id), true);
  assert.equal(f.platform.world(f.actor('reviewer')).messages.some((m) => m.id === secret.id), false);
  const runtime = f.tx('runtime', f.actor('alice'), sibling.id, {});
  assert.equal(f.platform.world(f.platform.authenticate(runtime.token)).messages.some((m) => m.id === secret.id), false);
  f.platform.run('UPDATE agents SET x=25,y=15 WHERE id=?', stranger.id);
  f.advance();
  const nearby = f.tx('message', f.actor('alice'), { agent_id: alice.id, text: 'Nearby conversation fixture', channel: 'nearby' });
  assert.equal(f.platform.world(f.actor('bob')).messages.some((m) => m.id === nearby.id), true);
  assert.equal(f.platform.world(f.actor('reviewer')).messages.some((m) => m.id === nearby.id), false);
  assert.doesNotMatch(JSON.stringify(f.platform.world()), /alice@example\.org|bob@example\.org|password|credential|token/);
  denied(() => f.tx('report', f.actor('reviewer'), { target_type: 'message', target_id: secret.id, reason: 'Guessing a hidden message identifier' }), 404);
});

test('claims have one winner, an operator quota across agents, retries, release, and expiry', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const sibling = f.agent('alice', 'Second avatar');
  const bob = f.agent('bob');
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: alice.id }, 'alice-compete')),
    Promise.resolve().then(() => f.tx('claim', f.actor('bob'), { task_id: 'climate-practice', agent_id: bob.id }, 'bob-compete')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  const claim = results[0].value;
  assert.equal(f.tx('claim', f.actor('alice'), { task_id: claim.task_id, agent_id: alice.id }, 'alice-compete').id, claim.id);
  denied(() => f.tx('claim', f.actor('alice'), { task_id: 'peace-practice', agent_id: sibling.id }, 'sibling-task'), 429);
  denied(() => f.tx('claim', f.actor('alice'), { task_id: 'peace-practice', agent_id: alice.id }, 'alice-compete'), 409);
  denied(() => f.tx('releaseClaim', f.actor('bob'), claim.id), 404);
  f.tx('releaseClaim', f.actor('alice'), claim.id);
  const lease = f.tx('claim', f.actor('bob'), { task_id: 'climate-practice', agent_id: bob.id }, 'after-release');
  f.advance(20 * 60_000 + 1);
  f.platform.missionList();
  assert.equal(f.platform.get('SELECT status FROM claims WHERE id=?', lease.id).status, 'expired');
  assert.equal(f.platform.get('SELECT status FROM tasks WHERE id=?', lease.task_id).status, 'open');
});

test('evidence requires approved domains and inert uploads, independent review, correction versions, and durable acceptance', async (t) => {
  const f = await fixture(t);
  const avatar = f.agent('alice');
  const { mission, task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: avatar.id }, 'source-claim');
  denied(() => f.tx('submit', f.actor('alice'), evidence(claim, { sources: [{ url: 'https://unapproved.example/report', location: 'Page 2' }] }), 'bad-domain'), 400);
  denied(() => f.tx('submit', f.actor('alice'), evidence(claim, { mime: 'text/html', artifact: '<script>alert(1)</script>' }), 'active-html'), 400);
  denied(() => f.tx('submit', f.actor('alice'), evidence(claim, { sources: [{ url: 'https://username:password@example.org/report', location: 'Page 2' }] }), 'credential-source'), 400);
  const first = f.tx('submit', f.actor('alice'), evidence(claim), 'submission-1');
  assert.equal(f.tx('submit', f.actor('alice'), evidence(claim), 'submission-1').id, first.id);
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('alice').account.id, role: 'reviewer' });
  denied(() => f.tx('review', f.actor('alice'), { submission_id: first.id, decision: 'accepted', reason: 'Self review is forbidden.' }), 403);
  denied(() => f.tx('review', f.actor('bob'), { submission_id: first.id, decision: 'accepted', reason: 'Unauthorized reviewer.' }), 403);
  f.tx('review', f.actor('reviewer'), { submission_id: first.id, decision: 'changes_requested', reason: 'Add a clearer uncertainty statement.' });
  const corrected = f.tx('submit', f.actor('alice'), evidence(claim, { limitations: 'The source covers one region and cannot establish a worldwide conclusion.' }), 'submission-2');
  assert.equal(corrected.version, 2);
  f.tx('review', f.actor('reviewer'), { submission_id: corrected.id, decision: 'accepted', reason: 'Sources, rights and limitations checked in this fixture.' });
  assert.equal(f.platform.gallery().length, 1);
  assert.equal(f.platform.world().participants.find((a) => a.id === avatar.id).accepted_contributions, 1);
  denied(() => f.tx('adoption', f.actor('bob'), { submission_id: corrected.id, note: 'Not the owner.' }), 403);
  f.tx('adoption', f.actor('admin'), { submission_id: corrected.id, note: 'Used in the fixture register.' });
  assert.equal(f.platform.gallery()[0].adoption_count, 1);
  assert.equal(f.platform.history(f.actor('bob')).submissions.length, 0);
  assert.equal(f.platform.get('SELECT status FROM missions WHERE id=?', mission.id).status, 'open');
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  assert.equal(restarted.gallery()[0].version, 2);
  assert.equal(restarted.world().participants.find((a) => a.id === avatar.id).accepted_contributions, 1);
  assert.equal(restarted.verifyAudit(), true);
});

test('moderation quarantines content, suspension revokes agents, and appeals need another human', async (t) => {
  const f = await fixture(t);
  const avatar = f.agent('alice');
  const publicMessage = f.tx('message', f.actor('alice'), { agent_id: avatar.id, text: 'Reported fixture content.' });
  const report = f.tx('report', f.actor('bob'), { target_type: 'message', target_id: publicMessage.id, reason: 'Please inspect this content.' });
  denied(() => f.tx('moderate', f.actor('alice'), { report_id: report.id, action: 'quarantine', reason: 'Unauthorized moderation.' }), 403);
  denied(() => f.tx('moderate', f.actor('moderator'), { report_id: report.id, action: 'quarantine', reason: '' }), 400);
  assert.equal(f.platform.world().messages.some((m) => m.id === publicMessage.id), true);
  f.tx('moderate', f.actor('moderator'), { report_id: report.id, action: 'quarantine', reason: 'Quarantine while checking context.' });
  assert.equal(f.platform.world().messages.some((m) => m.id === publicMessage.id), false);
  const appeal = f.tx('appeal', f.actor('alice'), { report_id: report.id, reason: 'Please consider the original context.' });
  denied(() => f.tx('decideAppeal', f.actor('moderator'), { appeal_id: appeal.id, decision: 'overturned', reason: 'Original decision maker.' }), 403);
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('bob').account.id, role: 'moderator' });
  denied(() => f.tx('decideAppeal', f.actor('bob'), { appeal_id: appeal.id, decision: 'overturned', reason: 'Original reporter remains involved.' }), 403);
  f.tx('decideAppeal', f.actor('admin'), { appeal_id: appeal.id, decision: 'overturned', reason: 'Independent review supports restoration.' });
  assert.equal(f.platform.world().messages.some((m) => m.id === publicMessage.id), true);
  const token = f.tx('runtime', f.actor('alice'), avatar.id, {});
  const agentReport = f.tx('report', f.actor('bob'), { target_type: 'agent', target_id: avatar.id, reason: 'Inspect avatar participation.' });
  f.tx('moderate', f.actor('moderator'), { report_id: agentReport.id, action: 'suspend', reason: 'Suspend pending review.' });
  denied(() => f.platform.authenticate(token.token), 401);
  denied(() => f.tx('agentControl', f.actor('alice'), avatar.id, 'active'), 403);
  const agentAppeal = f.tx('appeal', f.actor('alice'), { report_id: agentReport.id, reason: 'Request independent review.' });
  f.tx('decideAppeal', f.actor('admin'), { appeal_id: agentAppeal.id, decision: 'overturned', reason: 'Resume only after the operator restarts.' });
  assert.equal(f.platform.get('SELECT status FROM agents WHERE id=?', avatar.id).status, 'paused');
  assert.equal(f.platform.safety(f.actor('reviewer')).reports.length, 0);
  assert.equal(f.platform.verifyAudit(), true);
});

test('pause gates actions, operations require admin, export excludes credentials and unrelated moderation, deletion redacts presence', async (t) => {
  const f = await fixture(t);
  const avatar = f.agent('alice');
  const stranger = f.agent('bob');
  const claim = f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: avatar.id }, 'delete-lease');
  const message = f.tx('message', f.actor('bob'), { agent_id: stranger.id, text: 'Other account content.' });
  f.tx('report', f.actor('reviewer'), { target_type: 'message', target_id: message.id, reason: 'Report outside moderator own export.' });
  assert.equal(f.platform.exportAccount(f.actor('moderator')).moderation.reports.length, 0);
  const exported = f.platform.exportAccount(f.actor('alice'));
  assert.equal(exported.account.email, 'alice@example.org');
  assert.equal(exported.agents.length, 1);
  assert.doesNotMatch(JSON.stringify(exported), /"password"|"token"|"hash"|"scopes"|bob@example\.org/);
  denied(() => f.platform.operations(f.actor('alice')), 403);
  denied(() => f.tx('pause', f.actor('moderator'), true), 403);
  f.tx('pause', f.actor('admin'), true);
  denied(() => f.tx('moveAgent', f.actor('alice'), { agent_id: avatar.id, direction: 'right' }), 503);
  denied(() => f.tx('message', f.actor('alice'), { agent_id: avatar.id, text: 'Blocked by platform pause.' }), 503);
  denied(() => f.tx('runtime', f.actor('alice'), avatar.id, {}), 503);
  assert.equal(f.platform.operations(f.actor('admin')).paused, true);
  f.tx('pause', f.actor('admin'), false);
  f.tx('deleteAccount', f.actor('alice'));
  denied(() => f.platform.authenticate(f.credentials.alice.token), 401);
  assert.equal(f.platform.world().participants.some((a) => a.id === avatar.id), false);
  assert.equal(f.platform.get('SELECT name FROM accounts WHERE id=?', exported.account.id).name, 'Deleted member');
  assert.equal(f.platform.get('SELECT status FROM tasks WHERE id=?', claim.task_id).status, 'open');
  assert.doesNotMatch(JSON.stringify(f.platform.world()), /alice@example\.org|alice avatar/);
});

test('overturning one appeal preserves another independent quarantine on the same content', async (t) => {
  const f = await fixture(t);
  const avatar = f.agent('alice');
  const message = f.tx('message', f.actor('alice'), { agent_id: avatar.id, text: 'Content with two independent reports.' });
  const first = f.tx('report', f.actor('bob'), { target_type: 'message', target_id: message.id, reason: 'First concern.' });
  const second = f.tx('report', f.actor('reviewer'), { target_type: 'message', target_id: message.id, reason: 'Second concern.' });
  for (const report of [first, second]) f.tx('moderate', f.actor('moderator'), { report_id: report.id, action: 'quarantine', reason: 'Maintain quarantine for this independently recorded concern.' });
  const firstAppeal = f.tx('appeal', f.actor('alice'), { report_id: first.id, reason: 'Review first concern.' });
  f.tx('decideAppeal', f.actor('admin'), { appeal_id: firstAppeal.id, decision: 'overturned', reason: 'First concern resolved.' });
  assert.equal(f.platform.world().messages.some((m) => m.id === message.id), false);
  const secondAppeal = f.tx('appeal', f.actor('alice'), { report_id: second.id, reason: 'Review second concern.' });
  f.tx('decideAppeal', f.actor('admin'), { appeal_id: secondAppeal.id, decision: 'overturned', reason: 'Second concern independently resolved.' });
  assert.equal(f.platform.world().messages.some((m) => m.id === message.id), true);
});

test('submission quotas span corrections and agent identities, and retrying an existing submission is free', async (t) => {
  const f = await fixture(t);
  const firstAgent = f.agent('alice');
  const secondAgent = f.agent('alice', 'Another contribution identity');
  const claim = f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: firstAgent.id }, 'daily-claim');
  let submission;
  for (let version = 1; version <= 10; version++) {
    submission = f.tx('submit', f.actor('alice'), evidence(claim), `daily-submission-${version}`);
    assert.equal(submission.version, version);
    f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'changes_requested', reason: `Clarify fixture revision ${version}.` });
  }
  assert.equal(f.tx('submit', f.actor('alice'), evidence(claim), 'daily-submission-10').id, submission.id);
  denied(() => f.tx('submit', f.actor('alice'), evidence(claim), 'daily-submission-11'), 429);
  f.tx('releaseClaim', f.actor('alice'), claim.id);
  const secondClaim = f.tx('claim', f.actor('alice'), { task_id: 'peace-practice', agent_id: secondAgent.id }, 'daily-sibling-claim');
  denied(() => f.tx('submit', f.actor('alice'), evidence(secondClaim), 'sibling-submission'), 429);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n, 10);
});

test('a real mission refuses new contributions after its designated reviewer becomes unavailable', async (t) => {
  const f = await fixture(t);
  const avatar = f.agent('alice');
  const { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: avatar.id }, 'review-capacity-claim');
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('reviewer').account.id, role: 'member' });
  denied(() => f.tx('submit', f.actor('alice'), evidence(claim), 'unreviewable-submission'), 409);
  assert.equal(f.platform.get('SELECT status FROM claims WHERE id=?', claim.id).status, 'leased');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n, 0);
});
