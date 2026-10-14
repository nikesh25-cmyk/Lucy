import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { validateDatabase, restoreDatabase } from '../src/recovery.js';
import { fixture } from './helpers.js';

async function expansionFixture(t) {
  const f = await fixture(t);
  const backupDir = join(f.directory, 'backups');
  const { server } = createApp({ platform: f.platform, backupDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  };
  t.after(stop);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const request = async (route, { account, token, input, method = input === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null, raw };
  };
  return { ...f, server, stop, backupDir, request };
}

const recipeQuantities = (inventory) => Object.fromEntries(inventory.map((item) => [item.kind, item.quantity]));
const milestoneId = (project) => project.milestones[0].id;
const success = (response) => assert.ok([200, 201].includes(response.status), JSON.stringify(response.data));

test('private passports and journals enforce character ownership, runtime scopes, action budgets and revocation', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  const sibling = f.agent('alice', 'Sibling avatar');
  const secret = 'A private personal reflection, not a public character profile.';
  assert.equal((await f.request('/journey/profile', { account: 'alice', input: { agent_id: alice.id, bio: secret, purpose: 'Practice careful source reading.' } })).status, 200);
  success(await f.request('/journey/journal', { account: 'alice', input: { agent_id: alice.id, text: secret } }));
  const own = await f.request(`/journey?agent_id=${alice.id}`, { account: 'alice' });
  assert.equal(own.status, 200);
  assert.equal(own.data.profile.bio, secret);
  assert.equal(own.data.journal.some((entry) => entry.text === secret), true);
  assert.equal((await f.request(`/journey?agent_id=${alice.id}`, { account: 'bob' })).status, 404);
  assert.equal((await f.request(`/journey?agent_id=${alice.id}`)).status, 401);
  assert.equal((await f.request('/world')).raw.includes(secret), false);
  assert.equal((await f.request('/community')).raw.includes(secret), false);
  const session = await f.request('/runtime/start', { account: 'alice', input: { agent_id: alice.id, scopes: ['read', 'contribute'], max_calls: 2 } });
  const token = session.data.token;
  assert.equal((await f.request(`/journey?agent_id=${sibling.id}`, { token })).status, 404);
  assert.equal((await f.request('/journey/garden', { token, input: { action: 'plant', x: 4, y: 8, kind: 'herbs' } })).status, 403);
  success(await f.request('/journey/journal', { token, input: { text: 'Bounded session reflection.' } }));
  assert.equal((await f.request('/journey', { token })).status, 200);
  assert.equal((await f.request('/runtime/status', { token })).data.remaining_calls, 0);
  assert.equal((await f.request('/journey', { token })).status, 429);
  await f.request('/agents/control', { account: 'alice', input: { agent_id: alice.id, status: 'paused' } });
  assert.equal((await f.request('/journey', { token })).status, 401);
});

test('garden resources use server time, harvest only once and crafting spends inventory atomically', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  const home = `home:${alice.id}`;
  const move = await f.request(`/agents/${alice.id}/travel`, { account: 'alice', input: { world_id: home } });
  assert.equal(move.status, 200);
  for (const [x, kind] of [[4, 'herbs'], [5, 'fiber']]) {
    assert.equal((await f.request(`/agents/${alice.id}/build`, { account: 'alice', input: { type: 'farm', x, y: 8 } })).status, 201);
    const planted = await f.request('/journey/garden', { account: 'alice', input: { agent_id: alice.id, action: 'plant', x, y: 8, kind, planted_at: 0, ready_at: 0 } });
    assert.equal(planted.status, 200);
    assert.ok(planted.data.crop.ready_at >= f.clock() + 20 * 60_000);
  }
  assert.equal((await f.request('/journey/garden', { account: 'bob', input: { agent_id: alice.id, action: 'harvest', x: 4, y: 8 } })).status, 404);
  assert.equal((await f.request('/journey/garden', { account: 'alice', input: { agent_id: alice.id, action: 'harvest', x: 4, y: 8, ready_at: 0, server_time: f.clock() + 86_400_000 } })).status, 409);
  f.advance(25 * 60_000);
  for (const x of [4, 5]) assert.equal((await f.request('/journey/garden', { account: 'alice', input: { agent_id: alice.id, action: 'harvest', x, y: 8 } })).status, 200);
  assert.equal((await f.request('/journey/garden', { account: 'alice', input: { agent_id: alice.id, action: 'harvest', x: 4, y: 8 } })).status, 409);
  const races = await Promise.all([
    f.request('/journey/craft', { account: 'alice', input: { agent_id: alice.id, recipe_id: 'flower_crown' } }),
    f.request('/journey/craft', { account: 'alice', input: { agent_id: alice.id, recipe_id: 'flower_crown' } }),
  ]);
  assert.equal(races.filter((response) => response.status === 200 || response.status === 201).length, 1);
  assert.equal(races.filter((response) => [400, 409].includes(response.status)).length, 1);
  const journey = await f.request(`/journey?agent_id=${alice.id}`, { account: 'alice' });
  const inventory = recipeQuantities(journey.data.inventory);
  assert.equal(inventory.herbs || 0, 0);
  assert.equal(inventory.fiber, 1);
  assert.equal(inventory.flower_crown, 1);
  assert.equal(journey.data.merit.total, 0);
});

test('gratitude forbids self endorsement and duplicate sender identities and hides private operator data', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  const sibling = f.agent('alice', 'Alternate gratitude identity');
  const bob = f.agent('bob');
  assert.ok([400, 403].includes((await f.request('/thanks', { account: 'alice', input: { agent_id: alice.id, recipient_agent_id: sibling.id, reason: 'Self endorsement.' } })).status));
  const thanks = await f.request('/thanks', { account: 'alice', input: { agent_id: alice.id, recipient_agent_id: bob.id, reason: 'Thank you for explaining the evidence.' } });
  success(thanks);
  const repeat = await f.request('/thanks', { account: 'alice', input: { agent_id: sibling.id, recipient_agent_id: bob.id, reason: 'Duplicate through another avatar.' } });
  assert.equal(repeat.status, 409);
  const community = await f.request('/community');
  assert.equal(community.status, 200);
  assert.equal(community.data.thanks.length, 1);
  assert.doesNotMatch(community.raw, /alice@example\.org|bob@example\.org|"password"|"token"|"hash"/);
  const journey = await f.request(`/journey?agent_id=${bob.id}`, { account: 'bob' });
  assert.equal(journey.data.goodwill.thanks, 1);
  assert.equal(journey.data.merit.total, 0);
});

test('community runtime actions require contribution scope and human management remains protected', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const readOnly = await f.request('/runtime/start', { account: 'alice', input: { agent_id: alice.id, scopes: ['read'], max_calls: 3 } });
  const token = readOnly.data.token;
  const circleInput = { name: 'Bounded community circle', summary: 'A local scope fixture.', focus: 'Learning' };
  assert.equal((await f.request('/circles', { token, input: circleInput })).status, 403);
  assert.equal((await f.request(`/community?agent_id=${bob.id}`, { token })).status, 404);
  assert.equal((await f.request('/community', { token })).status, 200);
  assert.equal((await f.request('/runtime/status', { token })).data.remaining_calls, 2);
  const contributor = await f.request('/runtime/start', { account: 'alice', input: { agent_id: alice.id, scopes: ['read', 'contribute'], max_calls: 3 } });
  const circle = await f.request('/circles', { token: contributor.data.token, input: circleInput });
  success(circle);
  assert.equal((await f.request('/community/manage', { token: contributor.data.token, input: { kind: 'circle', id: circle.data.id, action: 'archive', reason: 'Runtime cannot perform human management.' } })).status, 403);
  assert.equal((await f.request('/community', { token })).status, 401);
  f.tx('pause', f.actor('admin'), true);
  assert.equal((await f.request('/circles/membership', { token: contributor.data.token, input: { circle_id: circle.data.id, action: 'leave' } })).status, 503);
});

test('project milestones need an operator independent of both creator and submitter', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  const sibling = f.agent('alice', 'Same project operator');
  const bob = f.agent('bob');
  const reviewer = f.agent('reviewer');
  const project = await f.request('/projects', { account: 'alice', input: { agent_id: alice.id, title: 'Community learning register', summary: 'Practice cooperation on a small resource map.', goal: 'Document one licensed source.', evidence_requirements: 'Record exact original source and limitations.', milestones: ['Document source'] } });
  success(project);
  const projectId = project.data.id;
  const milestone = milestoneId(project.data);
  assert.equal((await f.request('/projects/pledges', { account: 'bob', input: { agent_id: bob.id, project_id: projectId, action: 'pledge', commitment: 'Read and record the source.' } })).status, 200);
  assert.equal((await f.request('/projects/milestones', { account: 'bob', input: { agent_id: bob.id, project_id: projectId, milestone_id: milestone, action: 'submit', evidence: 'A source entry with attribution and limitations.', sources: [{ url: 'https://example.org/resource', location: 'Section 2' }] } })).status, 200);
  for (const agent of [alice, sibling]) assert.equal((await f.request('/projects/milestones', { account: 'alice', input: { agent_id: agent.id, project_id: projectId, milestone_id: milestone, action: 'approve', reason: 'Creator operator cannot confirm.' } })).status, 403);
  assert.equal((await f.request('/projects/milestones', { account: 'bob', input: { agent_id: bob.id, project_id: projectId, milestone_id: milestone, action: 'approve', reason: 'Submitter cannot confirm.' } })).status, 403);
  const approved = await f.request('/projects/milestones', { account: 'reviewer', input: { agent_id: reviewer.id, project_id: projectId, milestone_id: milestone, action: 'approve', reason: 'Independent peer confirms the fixture evidence.' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status, 'completed');
  assert.equal((await f.request(`/journey?agent_id=${bob.id}`, { account: 'bob' })).data.merit.total, 0);
  assert.equal((await f.request('/community/manage', { account: 'bob', input: { kind: 'project', id: projectId, action: 'archive', reason: 'Another operator cannot archive.' } })).status, 403);
});

test('competing event RSVPs allocate the final seat once and private spaces cannot host public events', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  const reviewer = f.agent('reviewer');
  const eventInput = { agent_id: alice.id, title: 'Open evidence conversation', summary: 'A bounded local fixture gathering.', world_id: 'commons', starts_at: new Date(f.clock() + 60 * 60_000).toISOString(), ends_at: new Date(f.clock() + 90 * 60_000).toISOString(), capacity: 2 };
  const event = await f.request('/events', { account: 'alice', input: eventInput });
  success(event);
  const seats = await Promise.all([
    f.request('/events/rsvp', { account: 'bob', input: { agent_id: bob.id, event_id: event.data.id, action: 'join' } }),
    f.request('/events/rsvp', { account: 'reviewer', input: { agent_id: reviewer.id, event_id: event.data.id, action: 'join' } }),
  ]);
  assert.deepEqual(seats.map((r) => r.status).sort(), [200, 409]);
  const listed = await f.request('/community');
  assert.equal(listed.data.events.find((entry) => entry.id === event.data.id).attendee_count, 2);
  const winningAccount = seats[0].status === 200 ? 'bob' : 'reviewer';
  const losingAccount = winningAccount === 'bob' ? 'reviewer' : 'bob';
  const losingAgent = winningAccount === 'bob' ? reviewer : bob;
  await f.request('/operations/accounts', { account: 'admin', input: { account_id: f.credentials[winningAccount].account.id, status: 'suspended' } });
  assert.equal((await f.request('/events/rsvp', { account: losingAccount, input: { agent_id: losingAgent.id, event_id: event.data.id, action: 'join' } })).status, 409);
  await f.request('/operations/accounts', { account: 'admin', input: { account_id: f.credentials[winningAccount].account.id, status: 'active' } });
  assert.equal((await f.request('/community')).data.events.find((entry) => entry.id === event.data.id).attendee_count, 2);
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'private' });
  assert.ok([400, 403].includes((await f.request('/events', { account: 'alice', input: { ...eventInput, world_id: `home:${alice.id}` } })).status));
  f.advance(60 * 60_000 + 1);
  const lateAgent = f.agent('moderator');
  assert.equal((await f.request('/events/rsvp', { account: 'moderator', input: { agent_id: lateAgent.id, event_id: event.data.id, action: 'join' } })).status, 409);
});

test('HTTP backups preserve community and private journey state in schema three', async (t) => {
  const f = await expansionFixture(t);
  const alice = f.agent('alice');
  await f.request('/journey/journal', { account: 'alice', input: { agent_id: alice.id, text: 'A durable private journey note.' } });
  const circle = await f.request('/circles', { account: 'alice', input: { agent_id: alice.id, name: 'Careful learning circle', summary: 'An isolated local persistence fixture.', focus: 'Learning' } });
  success(circle);
  const backup = await f.request('/operations/backup', { account: 'admin', input: {} });
  assert.equal(backup.status, 201);
  const path = join(f.backupDir, backup.data.filename);
  assert.equal(validateDatabase(path).schema_version, 24);
  await f.stop();
  const restoredPath = join(f.directory, 'restored.sqlite');
  restoreDatabase(path, restoredPath, { lockPath: join(f.directory, 'restored.lock') });
  const restored = new Platform(restoredPath, f.clock);
  t.after(() => restored.close());
  const actor = restored.authenticate(f.credentials.alice.token);
  assert.equal(restored.journey(actor, { agent_id: alice.id }).journal.some((entry) => entry.text === 'A durable private journey note.'), true);
  assert.equal(restored.community(actor, {}).circles.some((entry) => entry.id === circle.data.id), true);
  assert.equal(restored.verifyAudit(), true);
});
