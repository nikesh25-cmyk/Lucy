import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture, realMission, evidence } from './helpers.js';

const count = (f, sql, ...args) => f.platform.get(sql, ...args).n;
const hash = (token) => createHash('sha256').update(token).digest('hex');

/** A real listener on a real temporary database, with the shipped `req` closure idiom. */
async function open(t, f) {
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { token, input, method = input ? 'POST' : 'GET', origin } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: base } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { base, req };
}

test('the first-play route answers anonymously, personalises with a token, and refuses unknown input', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const { req } = await open(t, f);
  const anonymous = await req('/first-play');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data.viewer, null);
  assert.equal(anonymous.data.policy.coins_awarded, 0);
  assert.deepEqual(anonymous.data.steps.map((item) => item.done), [false, false, false, false, false]);
  const personalised = await req(`/first-play?agent_id=${resident.id}`, { token: f.credentials.alice.token });
  assert.equal(personalised.status, 200);
  assert.equal(personalised.data.viewer.agent_id, resident.id);
  assert.equal(personalised.data.viewer.account_id, f.actor('alice').account.id);
  assert.equal((await req('/first-play?bogus=1', { token: f.credentials.alice.token })).status, 400);
  assert.equal((await req('/first-play?bogus=1')).status, 400);
});

test('anonymous observers cannot act through the shipped routes the guide points at', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const { req } = await open(t, f);
  const anonymous = await req('/first-play');
  assert.equal(anonymous.data.viewer, null);
  assert.deepEqual(anonymous.data.next_step.actions, []);
  const tables = ['messages', 'community_rsvps', 'world_objects', 'journey_crops', 'audit', 'calling_receipts'];
  const before = tables.map((table) => count(f, `SELECT COUNT(*) AS n FROM ${table}`));
  const attempts = [
    ['/messages', { channel: 'nearby', text: 'Hello from nobody.' }],
    ['/restoration/join', { agent_id: resident.id, event_id: `restoration:home:${resident.id}` }],
    ['/restoration/place', { agent_id: resident.id, event_id: `restoration:home:${resident.id}` }],
    ['/journey/garden', { agent_id: resident.id, action: 'plant', kind: 'herbs', x: 4, y: 7 }],
  ];
  for (const [path, input] of attempts) {
    // An API-style write with no Origin and no credential is refused before the route runs.
    assert.ok([401, 403].includes((await req(path, { input })).status), `${path} refuses a bare unauthenticated write`);
    // A same-origin browser observer reaches the route and is refused by its own authority check.
    assert.equal((await req(path, { input, origin: true })).status, 401, `${path} refuses an unauthenticated observer`);
  }
  const after = tables.map((table) => count(f, `SELECT COUNT(*) AS n FROM ${table}`));
  assert.deepEqual(after, before);
});

test('a revoked runtime credential can no longer read the guide or act', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const { req } = await open(t, f);
  const started = await req('/runtime/start', { token: f.credentials.alice.token, input: { agent_id: resident.id, scopes: ['read', 'build'], max_calls: 20, minutes: 10 } });
  assert.equal(started.status, 201);
  const token = started.data.token;
  assert.match(token, /^[a-f0-9]{64}$/);
  const status = await req('/runtime/status', { token });
  assert.equal(status.status, 200);
  assert.equal(status.data.agent_id, resident.id);
  const before = await req('/first-play', { token });
  assert.equal(before.status, 200);
  assert.equal(before.data.viewer.agent_id, resident.id);

  const revoked = await req('/agents/control', { token: f.credentials.alice.token, input: { agent_id: resident.id, status: 'revoked' } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.status, 'revoked');
  assert.equal((await req('/runtime/status', { token })).status, 401);
  const refused = await req('/first-play', { token });
  assert.ok([401, 403].includes(refused.status), `the guide refuses the revoked credential (${refused.status})`);
  const write = await req('/messages', { token, input: { agent_id: resident.id, channel: 'public', text: 'This must not be written.' } });
  assert.ok([401, 403].includes(write.status));
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM messages WHERE agent_id=?', resident.id), 0);
  assert.equal(f.platform.get('SELECT revoked FROM tokens WHERE hash=?', hash(token)).revoked, 1);
});

test('a client-supplied completion cannot fake a saved step', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const { req } = await open(t, f);
  const steps = () => f.platform.firstPlay(f.actor('alice'), { agent_id: resident.id }).steps.map((item) => [item.id, item.done]);
  const stepsBefore = steps();
  const receiptsBefore = count(f, 'SELECT COUNT(*) AS n FROM calling_receipts');
  const refused = await req('/quests/complete', { token: f.credentials.alice.token, input: { agent_id: resident.id, chain_id: 'explorer-basics', step: 'first-walk', done: true } });
  assert.equal(refused.status, 400);
  // A read route has no write method: POST /first-play is refused with 405, exactly like /content.
  assert.equal((await req('/first-play', { token: f.credentials.alice.token, input: { agent_id: resident.id, done: true } })).status, 405);
  assert.equal((await req('/content', { token: f.credentials.alice.token, input: {} })).status, 405);
  assert.deepEqual(steps(), stepsBefore);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM calling_receipts'), receiptsBefore);
});

test('self-review cannot mint coins, while an independent review mints exactly one receipt of ten', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const m = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: m.task.id, agent_id: resident.id }, 'first-play-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'An independently reviewed first-play contribution.' }), 'first-play-submit');
  const { req } = await open(t, f);
  const ownReview = await req('/reviews', { token: f.credentials.alice.token, input: { submission_id: submission.id, decision: 'accepted', reason: 'I accept my own work.' } });
  assert.equal(ownReview.status, 403);
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', submission.id).status, 'pending_review');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);

  const review = await req('/reviews', { token: f.credentials.reviewer.token, input: { submission_id: submission.id, decision: 'accepted', reason: 'Independent source review.' } });
  assert.equal(review.status, 201);
  assert.equal(review.data.coin_reward.amount, 10);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 1);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n, 10);
});

test('only a character standing near an ambassador can save a guided meeting', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const ambassador = f.platform.get("SELECT * FROM npc_ambassadors WHERE iso3='NPL'");
  const { req } = await open(t, f);
  const token = f.credentials.alice.token;
  const meet = async () => (await req(`/first-play?agent_id=${alice.id}`, { token })).data.steps.find((item) => item.id === 'meet').done;
  const auditCount = () => count(f, "SELECT COUNT(*) AS n FROM audit WHERE event='firstplay.ambassador_met' AND actor=?", f.actor('alice').account.id);

  const fromCommons = await req('/ambassadors/talk', { token, input: { ambassador_id: ambassador.id, agent_id: alice.id, question: 'What can I learn here?' } });
  assert.equal(fromCommons.status, 409);
  assert.equal(auditCount(), 0);
  assert.equal(await meet(), false);

  const ordinary = await req('/ambassadors/talk', { token, input: { ambassador_id: ambassador.id, question: 'What does this desk explain?' } });
  assert.equal(ordinary.status, 200);
  assert.equal(auditCount(), 0, 'an account-level research question is not a character encounter');
  assert.equal(await meet(), false);

  f.advance();
  const travel = await req(`/agents/${alice.id}/travel`, { token, input: { world_id: ambassador.world_id } });
  assert.equal(travel.status, 200);
  const atStart = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
  const far = Math.abs(atStart.x - ambassador.x) + Math.abs(atStart.y - ambassador.y) > 6;
  if (far) {
    const tooFar = await req('/ambassadors/talk', { token, input: { ambassador_id: ambassador.id, agent_id: alice.id, question: 'Can you hear me here?' } });
    assert.equal(tooFar.status, 409);
    assert.equal(auditCount(), 0);
  }

  const otherCharacter = await req('/ambassadors/talk', { token, input: { ambassador_id: ambassador.id, agent_id: bob.id, question: 'An unauthorised character asks.' } });
  assert.ok([403, 404].includes(otherCharacter.status));
  assert.equal(auditCount(), 0);
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', ambassador.x, ambassador.y, alice.id);
  const nearby = await req('/ambassadors/talk', { token, input: { ambassador_id: ambassador.id, agent_id: alice.id, question: 'What can I learn about this country?' } });
  assert.equal(nearby.status, 200);
  assert.equal(auditCount(), 1);
  assert.equal(await meet(), true);
});
