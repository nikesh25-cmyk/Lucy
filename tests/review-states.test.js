// Task 26 — the four states a reviewer reads, the quarantine hold, and the exact coin issuance this
// task must not change. Every assertion drives the shipped server or the shipped platform path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { fixture, realMission, evidence } from './helpers.js';
import { verifyCoinLedger } from '../src/coins.js';
import { validateDatabase } from '../src/recovery.js';

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const get = (base, token, path) => fetch(base + '/api/v1' + path, { headers: auth(token) });
const post = (base, token, path, body) => fetch(base + '/api/v1' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': globalThis.crypto.randomUUID(), ...auth(token) }, body: JSON.stringify(body) });
async function server(t, f) {
  const { server: http } = createApp({ platform: f.platform });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }));
  return `http://127.0.0.1:${http.address().port}`;
}
// One real mission, one contributor, one resident, one accepted contribution with one receipt.
async function acceptedFixture(t) {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const { mission, task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'states-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'A reviewed contribution whose state must stay unambiguous.' }), 'states-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture acceptance.' });
  return { ...f, resident: agent, mission, task, claim, submission };
}
const quarantine = (f, submission) => {
  const report = f.tx('report', f.actor('bob'), { target_type: 'submission', target_id: submission.id, reason: 'A fictional evidence concern for the state test.' });
  f.tx('moderate', f.actor('moderator'), { report_id: report.id, action: 'quarantine', reason: 'Hold for inspection.' });
  return report;
};
const states = (f, submission) => ({
  history: f.platform.history(f.actor('alice')).submissions.find((entry) => entry.id === submission.id)?.state?.value,
  gallery: f.platform.gallery(submission.id)[0]?.state?.value,
  workbench: f.platform.reviewWorkbench(f.actor('reviewer'), { submission: submission.id }).submission.state.value,
  availability: f.platform.reviewWorkbench(f.actor('reviewer'), { submission: submission.id }).availability.held,
});

test('pending, accepted, held and adopted are one unambiguous value on every surface', async (t) => {
  const f = await acceptedFixture(t);
  const otherTask = f.tx('createTask', f.actor('admin'), { mission_id: f.mission.id, title: 'Second state task', instructions: 'Fixture', rights: 'Fixture permission', allowed_domains: ['example.org'] });
  const pendingClaim = f.tx('claim', f.actor('bob'), { task_id: otherTask.id, agent_id: f.agent('bob').id }, 'states-pending-claim');
  const pending = f.tx('submit', f.actor('bob'), evidence(pendingClaim, { artifact: 'Work still waiting for a human reviewer.' }), 'states-pending');
  // Pending: named as pending, absent from the gallery, and no coin.
  assert.equal(f.platform.history(f.actor('bob')).submissions.find((entry) => entry.id === pending.id).state.value, 'pending');
  assert.equal(f.platform.gallery().some((record) => record.id === pending.id), false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', pending.id).n, 0);
  // Accepted: named as accepted on the contributor history, in the gallery and in the workbench.
  assert.deepEqual([states(f, f.submission).history, states(f, f.submission).gallery, states(f, f.submission).workbench], ['accepted', 'accepted', 'accepted']);
  assert.equal(states(f, f.submission).availability, false);
  // Held: quarantine is a different word from accepted, and says the availability is held.
  quarantine(f, f.submission);
  assert.deepEqual([states(f, f.submission).history, states(f, f.submission).workbench], ['held', 'held']);
  assert.equal(states(f, f.submission).availability, true);
  assert.equal(f.platform.gallery().some((record) => record.id === f.submission.id), false, 'a held version never appears as approved work');
  const held = f.platform.reviewWorkbench(f.actor('reviewer'), { submission: f.submission.id });
  assert.match(held.availability.note, /without rewriting history/);
  assert.equal(held.coin.availability, 'held');
  assert.equal(held.coin.issued, true, 'the issued receipt is retained, only its availability is held');
  // Adopted: the state changes only once the mission owner records the use, and adoption is refused
  // while the version is held.
  assert.throws(() => f.tx('adoption', f.actor('admin'), { submission_id: f.submission.id, note: 'Adopting a held version.' }), { status: 409 });
  f.tx('appeal', f.actor('alice'), { report_id: f.platform.get('SELECT id FROM reports ORDER BY created_at DESC LIMIT 1').id, reason: 'Independent reinspection requested.' });
  const appeal = f.platform.get('SELECT id FROM appeals ORDER BY created_at DESC LIMIT 1');
  f.tx('decideAppeal', f.actor('admin'), { appeal_id: appeal.id, decision: 'overturned', reason: 'Restored after an independent reinspection.' });
  assert.equal(states(f, f.submission).history, 'accepted');
  f.tx('adoption', f.actor('admin'), { submission_id: f.submission.id, note: 'Used in the fictional register.', evidence: 'Register entry REG-1.' });
  assert.deepEqual([states(f, f.submission).history, states(f, f.submission).gallery, states(f, f.submission).workbench], ['adopted', 'adopted', 'adopted']);
  assert.equal(states(f, f.submission).availability, false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', f.submission.id).n, 1, 'an adoption mints nothing');
});

test('quarantine holds availability without rewriting the acceptance, the receipt or the contribution', async (t) => {
  const f = await acceptedFixture(t);
  const before = {
    review: f.platform.get('SELECT * FROM reviews WHERE submission_id=?', f.submission.id),
    receipt: f.platform.get('SELECT * FROM coin_rewards WHERE submission_id=?', f.submission.id),
    submission: f.platform.get('SELECT id,claim_id,version,artifact,sources,method,limitations,rights,created_at,idempotency_key FROM submissions WHERE id=?', f.submission.id),
    wallet: f.platform.coins(f.actor('alice'), { agent_id: f.resident.id }),
  };
  assert.equal(before.wallet.balance, 10);
  assert.equal(before.wallet.held, 0);
  quarantine(f, f.submission);
  // The acceptance record and the issued receipt are byte-identical: only availability changed.
  assert.deepEqual(f.platform.get('SELECT * FROM reviews WHERE submission_id=?', f.submission.id), before.review);
  assert.deepEqual(f.platform.get('SELECT * FROM coin_rewards WHERE submission_id=?', f.submission.id), before.receipt);
  const version = f.platform.get('SELECT id,claim_id,version,artifact,sources,method,limitations,rights,created_at,idempotency_key FROM submissions WHERE id=?', f.submission.id);
  assert.deepEqual(version, before.submission, 'the contribution itself is untouched by moderation');
  const wallet = f.platform.coins(f.actor('alice'), { agent_id: f.resident.id });
  assert.equal(wallet.issued, 10);
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.held, 10);
  assert.deepEqual(wallet.receipts.map((receipt) => receipt.state), ['held']);
  assert.equal(wallet.receipts[0].id, before.receipt.id, 'the same receipt is held, not replaced');
  assert.equal(wallet.receipt_count, 1);
  // The receipt is not withdrawn and the ledger still verifies; the database still validates.
  assert.equal(verifyCoinLedger(f.platform.db), true);
  assert.equal(f.platform.verifyAudit(), true);
  assert.equal(validateDatabase(f.database).schema_version, 26);
  // A held contribution is not offered as approved work, and its packet is refused.
  assert.equal(f.platform.gallery().some((record) => record.id === f.submission.id), false);
  assert.throws(() => f.platform.deliveryPacket({ submission: f.submission.id }), { status: 404 });
  // Restoring availability needs an independent decision, and issues no second receipt.
  const report = f.platform.get('SELECT id FROM reports ORDER BY created_at DESC LIMIT 1').id;
  const appeal = f.tx('appeal', f.actor('alice'), { report_id: report, reason: 'Independent reinspection requested.' });
  f.tx('decideAppeal', f.actor('admin'), { appeal_id: appeal.id, decision: 'overturned', reason: 'Restored after an independent reinspection.' });
  assert.equal(f.platform.coins(f.actor('alice'), { agent_id: f.resident.id }).balance, 10);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 1);
  assert.deepEqual(f.platform.get('SELECT * FROM coin_rewards WHERE submission_id=?', f.submission.id), before.receipt);
});

test('an acceptance is atomic and idempotent: a replay and two simultaneous reviews issue one receipt', async (t) => {
  const f = await acceptedFixture(t);
  const base = await server(t, f);
  const secondTask = f.tx('createTask', f.actor('admin'), { mission_id: f.mission.id, title: 'Raced state task', instructions: 'Fixture', rights: 'Fixture permission', allowed_domains: ['example.org'] });
  const second = f.agent('alice', 'Race resident');
  const claim = f.tx('claim', f.actor('alice'), { task_id: secondTask.id, agent_id: second.id }, 'states-race-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'One raced contribution that must earn exactly one receipt.' }), 'states-race-submit');
  const [first, concurrent] = await Promise.all([
    post(base, f.credentials.reviewer.token, '/reviews', { submission_id: submission.id, decision: 'accepted', reason: 'Concurrent acceptance A.' }),
    post(base, f.credentials.admin.token, '/reviews', { submission_id: submission.id, decision: 'accepted', reason: 'Concurrent acceptance B.' }),
  ]);
  assert.deepEqual([first.status, concurrent.status].sort(), [201, 409]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM reviews WHERE submission_id=?', submission.id).n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', submission.id).n, 1);
  const replay = await post(base, f.credentials.reviewer.token, '/reviews', { submission_id: submission.id, decision: 'accepted', reason: 'A replay of the same acceptance.' });
  assert.equal(replay.status, 409);
  assert.match((await replay.json()).error, /already been reviewed/);
  const wallet = f.platform.coins(f.actor('alice'), { agent_id: second.id });
  assert.equal(wallet.receipt_count, 1);
  assert.equal(wallet.balance, 10);
  assert.equal(wallet.issued, 10);
  assert.equal(verifyCoinLedger(f.platform.db), true);
  const view = f.platform.reviewWorkbench(f.actor('reviewer'), { submission: submission.id });
  assert.equal(view.coin.issued, true);
  assert.equal(view.coin.availability, 'available');
  assert.equal(view.coin.amount, 10);
});

test('the workbench route is session-only, read-only, and refuses anyone outside the mission', async (t) => {
  const f = await acceptedFixture(t);
  const base = await server(t, f);
  const path = `/review/workbench?submission=${encodeURIComponent(f.submission.id)}`;
  assert.equal((await fetch(base + '/api/v1' + path)).status, 401);
  // An unrelated member can read nothing about someone else's contribution.
  assert.equal((await get(base, f.credentials.bob.token, path)).status, 403);
  // The contributor, the reviewer and the administrator can each open it.
  for (const who of ['alice', 'reviewer', 'admin']) {
    const response = await get(base, f.credentials[who].token, path);
    assert.equal(response.status, 200, `${who} must be able to open the workbench`);
    const body = await response.json();
    assert.equal(body.submission.id, f.submission.id);
    assert.equal(body.submission.state.value, 'accepted');
    assert.equal(body.roles.may_adopt, who === 'admin', 'only the mission owner may adopt');
    assert.equal(body.roles.may_review, false, 'an accepted version is not reviewed again');
  }
  assert.equal((await get(base, f.credentials.reviewer.token, '/review/workbench?submission=no-such-submission')).status, 404);
  assert.equal((await post(base, f.credentials.reviewer.token, '/review/workbench', { submission: f.submission.id })).status, 405);
  // Reading the workbench writes nothing at all.
  const before = [f.platform.get('SELECT COUNT(*) AS n FROM audit').n, f.platform.get('SELECT COUNT(*) AS n FROM reviews').n];
  await get(base, f.credentials.reviewer.token, path);
  assert.deepEqual([f.platform.get('SELECT COUNT(*) AS n FROM audit').n, f.platform.get('SELECT COUNT(*) AS n FROM reviews').n], before);
});

test('the proposer, contributor, reviewer and adopter stay distinct through the HTTP layer', async (t) => {
  const f = await acceptedFixture(t);
  const base = await server(t, f);
  // The contributor may not adopt, even though they are a mission member.
  const contributor = await post(base, f.credentials.alice.token, '/adoptions', { submission_id: f.submission.id, note: 'Adopting my own contribution.' });
  assert.equal(contributor.status, 403);
  assert.match((await contributor.json()).error, /Only the mission owner/);
  // The reviewer who accepted it may not adopt it.
  const reviewer = await post(base, f.credentials.reviewer.token, '/adoptions', { submission_id: f.submission.id, note: 'Adopting the version I accepted.' });
  assert.equal(reviewer.status, 403);
  assert.match((await reviewer.json()).error, /Only the mission owner/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n, 0);
  // A contribution cannot be declared adopted before it is accepted.
  const otherTask = f.tx('createTask', f.actor('admin'), { mission_id: f.mission.id, title: 'Unreviewed state task', instructions: 'Fixture', rights: 'Fixture permission', allowed_domains: ['example.org'] });
  const otherClaim = f.tx('claim', f.actor('bob'), { task_id: otherTask.id, agent_id: f.agent('bob').id }, 'states-unreviewed-claim');
  const unreviewed = f.tx('submit', f.actor('bob'), evidence(otherClaim, { artifact: 'Not yet reviewed by anyone.' }), 'states-unreviewed');
  const early = await post(base, f.credentials.admin.token, '/adoptions', { submission_id: unreviewed.id, note: 'Adopting unreviewed work.' });
  assert.equal(early.status, 409);
  // The mission owner records the declaration with its supporting evidence.
  const declared = await post(base, f.credentials.admin.token, '/adoptions', { submission_id: f.submission.id, note: 'Cited in the fictional community register.', evidence: 'Register entry REG-2026-10-13.' });
  assert.equal(declared.status, 201);
  const body = await declared.json();
  assert.equal(body.declaration_only, true);
  assert.equal(body.evidence_supplied, true);
  assert.match(body.declaration, /DOCUMENTED ADOPTION/);
  assert.match(body.boundary, /not proof that the work was implemented/);
  assert.equal(body.state.value, 'adopted');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', f.submission.id).n, 1);
  const gallery = await (await fetch(base + '/api/v1/gallery')).json();
  assert.match(JSON.stringify(gallery), /REG-2026-10-13/, 'the gallery shows the recorded evidence, not a claim of outcome');
  const record = gallery.find((entry) => entry.id === f.submission.id);
  assert.equal(record.state.value, 'adopted');
  assert.equal(record.adoptions.length, 1);
  assert.equal(record.adoptions[0].evidence, 'Register entry REG-2026-10-13.');
  assert.equal(record.adoptions[0].declaration_only, true);
  // A mission whose owner is also the contributor refuses the declaration outright.
  const own = realMission(f, { owner_id: f.actor('alice').account.id });
  const ownClaim = f.tx('claim', f.actor('alice'), { task_id: own.task.id, agent_id: f.resident.id }, 'states-self-claim');
  const ownSubmission = f.tx('submit', f.actor('alice'), evidence(ownClaim, { artifact: 'Work contributed by the mission owner.' }), 'states-self-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: ownSubmission.id, decision: 'accepted', reason: 'Independent fixture acceptance.' });
  const selfAdoption = await post(base, f.credentials.alice.token, '/adoptions', { submission_id: ownSubmission.id, note: 'Adopting my own work.' });
  assert.equal(selfAdoption.status, 403);
  assert.match((await selfAdoption.json()).error, /cannot adopt their own contribution/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', ownSubmission.id).n, 0);
  // Self-review is refused on the same path, and leaves no review row.
  const selfReviewTask = f.tx('createTask', f.actor('admin'), { mission_id: own.mission.id, title: 'Second self-review task', instructions: 'Fixture', rights: 'Fixture permission', allowed_domains: ['example.org'] });
  const secondOwnClaim = f.tx('claim', f.actor('alice'), { task_id: selfReviewTask.id, agent_id: f.agent('alice', 'Third resident').id }, 'states-self-review-claim');
  const pending = f.tx('submit', f.actor('alice'), evidence(secondOwnClaim, { artifact: 'A second piece only a different reviewer may judge.' }), 'states-self-review-submit');
  const reviews = f.platform.get('SELECT COUNT(*) AS n FROM reviews').n;
  const selfReview = await post(base, f.credentials.alice.token, '/reviews', { submission_id: pending.id, decision: 'accepted', reason: 'Accepting my own contribution.' });
  assert.equal(selfReview.status, 403);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM reviews').n, reviews);
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', pending.id).status, 'pending_review');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', pending.id).n, 0);
});
