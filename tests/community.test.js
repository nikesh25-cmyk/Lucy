import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { fixture, PASSWORD } from './helpers.js';

const projectInput = (agent, changes = {}) => ({ agent_id: agent.id, title: 'A shared accessible guide', summary: 'Cooperate on a useful public guide.', goal: 'Deliver an attributed guide for visitors.', evidence_requirements: 'Check attribution, source locations, and remaining uncertainty.', ...changes });
const eventInput = (f, agent, changes = {}) => ({ agent_id: agent.id, title: 'Community listening circle', summary: 'Meet to discuss the shared guide.', starts_at: new Date(f.clock() + 3600000).toISOString(), ends_at: new Date(f.clock() + 7200000).toISOString(), capacity: 3, ...changes });
const circleInput = (agent, changes = {}) => ({ agent_id: agent.id, name: 'Kind creators', summary: 'Share care and practical creative work.', focus: 'Care', ...changes });
const error = (status) => (caught) => caught.status === status;

test('circles persist membership and reject character impersonation', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), sibling = f.agent('alice', 'Second Alice avatar');
  const circle = f.tx('createCircle', f.actor('alice'), circleInput(alice));
  assert.equal(circle.member_count, 1);
  assert.throws(() => f.tx('circleMembership', f.actor('bob'), { agent_id: alice.id, circle_id: circle.id, action: 'join' }), error(404));
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['contribute'] });
  const actor = f.platform.authenticate(runtime.token, 'contribute');
  assert.throws(() => f.tx('circleMembership', actor, { agent_id: sibling.id, circle_id: circle.id, action: 'join' }), error(404));
  f.tx('circleMembership', f.actor('bob'), { agent_id: bob.id, circle_id: circle.id, action: 'join' });
  f.tx('circleMembership', f.actor('bob'), { agent_id: bob.id, circle_id: circle.id, action: 'join' });
  assert.equal(f.platform.community(null).circles[0].member_count, 2);
  assert.equal(f.platform.community(f.actor('bob'), { agent_id: bob.id }).circles[0].joined, true);
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  try { assert.equal(restarted.community(null).circles[0].member_count, 2); assert.equal(restarted.verifyAudit(), true); }
  finally { restarted.close(); }
});

test('shared projects require evidence and independent operator confirmation for every milestone', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), sibling = f.agent('alice', 'Alice helper'), bob = f.agent('bob'), reviewer = f.agent('reviewer');
  const project = f.tx('createProject', f.actor('alice'), projectInput(alice, { milestones: ['Trace the source', 'Publish the guide'] }));
  const first = project.milestones[0].id, second = project.milestones[1].id;
  const submit = (agent, milestone_id, extra = {}) => ({ agent_id: agent.id, project_id: project.id, milestone_id, action: 'submit', evidence: 'An attributed plain text guide, with the original section recorded.', sources: [{ url: 'https://example.org/guide', location: 'Section 3' }], ...extra });
  assert.throws(() => f.tx('projectMilestone', f.actor('bob'), submit(bob, first)), error(403));
  assert.throws(() => f.tx('projectMilestone', f.actor('alice'), submit(alice, first, { sources: [{ url: 'javascript:alert(1)', location: 'script' }] })), error(400));
  assert.equal(f.platform.community(null).projects[0].milestones[0].status, 'open');
  f.tx('projectMilestone', f.actor('alice'), submit(alice, first));
  assert.throws(() => f.tx('projectMilestone', f.actor('alice'), { agent_id: sibling.id, project_id: project.id, milestone_id: first, action: 'approve', reason: 'My other avatar.' }), error(403));
  f.tx('projectMilestone', f.actor('bob'), { agent_id: bob.id, project_id: project.id, milestone_id: first, action: 'changes_requested', reason: 'Clarify what the source actually supports.' });
  f.tx('projectMilestone', f.actor('alice'), submit(alice, first));
  assert.equal(f.tx('projectMilestone', f.actor('bob'), { agent_id: bob.id, project_id: project.id, milestone_id: first, action: 'approve', reason: 'Checked the revised attribution.' }).status, 'active');
  f.tx('projectPledge', f.actor('bob'), { agent_id: bob.id, project_id: project.id, action: 'pledge', commitment: 'Write the plain language version.' });
  f.tx('projectMilestone', f.actor('bob'), submit(bob, second));
  assert.throws(() => f.tx('projectMilestone', f.actor('bob'), { agent_id: bob.id, project_id: project.id, milestone_id: second, action: 'approve', reason: 'Approve myself.' }), error(403));
  assert.throws(() => f.tx('projectMilestone', f.actor('alice'), { agent_id: alice.id, project_id: project.id, milestone_id: second, action: 'approve', reason: 'Approve my own project.' }), error(403));
  const completed = f.tx('projectMilestone', f.actor('reviewer'), { agent_id: reviewer.id, project_id: project.id, milestone_id: second, action: 'approve', reason: 'Checked the guide independently.' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.milestones.every((m) => m.status === 'approved'), true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n, 0);
  assert.equal(f.platform.communityExport(f.actor('bob')).projects[0].id, project.id);
});

test('suspended submitting operators cannot gain milestone confirmation', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), reviewer = f.agent('reviewer');
  const project = f.tx('createProject', f.actor('alice'), projectInput(alice));
  f.tx('projectPledge', f.actor('bob'), { agent_id: bob.id, project_id: project.id, action: 'pledge', commitment: 'Contribute evidence.' });
  f.tx('projectMilestone', f.actor('bob'), { agent_id: bob.id, project_id: project.id, milestone_id: project.milestones[0].id, action: 'submit', evidence: 'A traceable result.' });
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('bob').account.id, status: 'suspended' });
  assert.throws(() => f.tx('projectMilestone', f.actor('reviewer'), { agent_id: reviewer.id, project_id: project.id, milestone_id: project.milestones[0].id, action: 'approve', reason: 'Attempt confirmation.' }), error(409));
});

test('event reservations remain bounded through suspension, resumption and cancellation', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), reviewer = f.agent('reviewer');
  const event = f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { capacity: 2 }));
  f.tx('eventRSVP', f.actor('bob'), { agent_id: bob.id, event_id: event.id, action: 'join' });
  const bobId = f.actor('bob').account.id;
  f.tx('accountControl', f.actor('admin'), { account_id: bobId, status: 'suspended' });
  let view = f.platform.community(null).events[0];
  assert.equal(view.attendee_count, 1); assert.equal(view.reserved_count, 2);
  assert.throws(() => f.tx('eventRSVP', f.actor('reviewer'), { agent_id: reviewer.id, event_id: event.id, action: 'join' }), error(409));
  f.tx('accountControl', f.actor('admin'), { account_id: bobId, status: 'active' });
  f.credentials.bob = await f.platform.login({ email: 'bob@example.org', password: PASSWORD });
  assert.equal(f.platform.community(null).events[0].attendee_count, 2);
  f.tx('eventRSVP', f.actor('bob'), { agent_id: bob.id, event_id: event.id, action: 'cancel' });
  assert.equal(f.tx('eventRSVP', f.actor('reviewer'), { agent_id: reviewer.id, event_id: event.id, action: 'join' }).attendee_count, 2);
  assert.throws(() => f.tx('eventRSVP', f.actor('bob'), { agent_id: alice.id, event_id: event.id, action: 'cancel' }), error(404));
});

test('event scheduling validates timezones and old events release creation quota', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  assert.throws(() => f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { starts_at: '2027-02-30T12:00:00Z' })), error(400));
  assert.throws(() => f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { starts_at: '2027-01-01T12:00:00' })), error(400));
  assert.throws(() => f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { capacity: 101 })), error(400));
  for (let index = 0; index < 10; index++) f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { title: `Gathering ${index}` }));
  assert.throws(() => f.tx('createEvent', f.actor('alice'), eventInput(f, alice)), error(429));
  f.advance(3 * 3600000);
  assert.doesNotThrow(() => f.tx('createEvent', f.actor('alice'), eventInput(f, alice)));
});

test('public gatherings disappear when their home becomes private and reject further joining', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const home = `home:${alice.id}`;
  const event = f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { world_id: home }));
  assert.equal(f.platform.community(null).events.length, 1);
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });
  assert.equal(f.platform.community(null).events.length, 0);
  assert.equal(f.platform.community(null).counts.events, 0);
  assert.throws(() => f.tx('eventRSVP', f.actor('alice'), { agent_id: alice.id, event_id: event.id, action: 'join' }), error(409));
  assert.throws(() => f.tx('eventRSVP', f.actor('bob'), { agent_id: bob.id, event_id: event.id, action: 'join' }), error(403));
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  const guestEvent = f.tx('createEvent', f.actor('bob'), eventInput(f, bob, { world_id: home }));
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('alice').account.id, status: 'suspended' });
  assert.equal(f.platform.community(null).events.length, 0);
  assert.throws(() => f.tx('createEvent', f.actor('bob'), eventInput(f, bob, { world_id: home })), error(400));
  assert.throws(() => f.tx('eventRSVP', f.actor('bob'), { agent_id: bob.id, event_id: guestEvent.id, action: 'join' }), error(409));
});

test('gratitude belongs to the operator identity, cannot reward oneself, and resets by UTC day', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), sibling = f.agent('alice', 'Alice helper'), bob = f.agent('bob');
  assert.throws(() => f.tx('giveThanks', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: sibling.id, reason: 'Self reward' }), error(403));
  f.tx('giveThanks', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, reason: 'Thank you for checking attribution.' });
  assert.throws(() => f.tx('giveThanks', f.actor('alice'), { agent_id: sibling.id, recipient_agent_id: bob.id, reason: 'Duplicate via another character' }), error(409));
  f.advance(86400000);
  f.tx('giveThanks', f.actor('alice'), { agent_id: sibling.id, recipient_agent_id: bob.id, reason: 'Thank you for a new contribution today.' });
  assert.equal(f.platform.community(null).thanks.length, 2);
  assert.equal(f.platform.communityExport(f.actor('bob')).thanks.length, 2);
  assert.doesNotMatch(JSON.stringify(f.platform.community(null)), /@example|password|token|giver_account_id/);
});

test('moderation stores reasons, hides archived circles and enforces retained membership quota', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const circle = f.tx('createCircle', f.actor('alice'), circleInput(alice));
  const project = f.tx('createProject', f.actor('alice'), projectInput(alice, { circle_id: circle.id }));
  const event = f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { circle_id: circle.id }));
  assert.throws(() => f.tx('manageCommunity', f.actor('bob'), { kind: 'circle', id: circle.id, action: 'archive', reason: 'Not my circle' }), error(403));
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['contribute'] });
  assert.throws(() => f.tx('manageCommunity', f.platform.authenticate(runtime.token), { kind: 'circle', id: circle.id, action: 'archive', reason: 'Agent cannot moderate' }), error(403));
  f.tx('pause', f.actor('admin'), true);
  f.tx('manageCommunity', f.actor('moderator'), { kind: 'circle', id: circle.id, action: 'archive', reason: 'The group has concluded.' });
  assert.equal(f.platform.get('SELECT management_reason FROM community_circles WHERE id=?', circle.id).management_reason, 'The group has concluded.');
  assert.equal(f.platform.get('SELECT status FROM community_projects WHERE id=?', project.id).status, 'archived');
  assert.equal(f.platform.get('SELECT status FROM community_events WHERE id=?', event.id).status, 'cancelled');
  assert.deepEqual(f.platform.community(null).counts, { circles: 0, projects: 0, events: 0, thanks: 0 });
  f.tx('pause', f.actor('admin'), false);
  for (let index = 1; index < 12; index++) {
    const next = f.tx('createCircle', f.actor('alice'), circleInput(alice, { name: `Circle ${index}` }));
    f.tx('manageCommunity', f.actor('alice'), { kind: 'circle', id: next.id, action: 'archive', reason: 'Retire the practice group.' });
  }
  assert.throws(() => f.tx('createCircle', f.actor('alice'), circleInput(alice)), error(429));
});

test('account deletion redacts contributed evidence while preserving shared project history', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const project = f.tx('createProject', f.actor('alice'), projectInput(alice));
  f.tx('projectPledge', f.actor('bob'), { agent_id: bob.id, project_id: project.id, action: 'pledge', commitment: 'A personal commitment.' });
  f.tx('projectMilestone', f.actor('bob'), { agent_id: bob.id, project_id: project.id, milestone_id: project.milestones[0].id, action: 'submit', evidence: 'Personal removable evidence.' });
  f.tx('giveThanks', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, reason: 'Personal appreciation.' });
  const bobCircle = f.tx('createCircle', f.actor('bob'), circleInput(bob));
  f.tx('circleMembership', f.actor('alice'), { agent_id: alice.id, circle_id: bobCircle.id, action: 'join' });
  const dependentProject = f.tx('createProject', f.actor('alice'), projectInput(alice, { circle_id: bobCircle.id }));
  const dependentEvent = f.tx('createEvent', f.actor('alice'), eventInput(f, alice, { circle_id: bobCircle.id }));
  f.platform.run('UPDATE community_circles SET management_reason=? WHERE id=?', 'Private author note.', bobCircle.id);
  f.tx('deleteCommunity', f.actor('bob'));
  const remaining = f.platform.community(null);
  assert.equal(remaining.projects.length, 1);
  assert.equal(remaining.projects[0].milestones[0].evidence, '[removed]');
  assert.equal(remaining.projects[0].pledges.some((p) => p.id === bob.id), false);
  assert.equal(remaining.thanks.length, 0);
  assert.equal(f.platform.get('SELECT status FROM community_projects WHERE id=?', dependentProject.id).status, 'archived');
  assert.equal(f.platform.get('SELECT status FROM community_events WHERE id=?', dependentEvent.id).status, 'cancelled');
  assert.equal(f.platform.get('SELECT management_reason FROM community_circles WHERE id=?', bobCircle.id).management_reason, '');
  assert.equal(f.platform.get('SELECT management_reason FROM community_projects WHERE id=?', dependentProject.id).management_reason, 'Circle owner account removed.');
  assert.equal(f.platform.verifyAudit(), true);
});
