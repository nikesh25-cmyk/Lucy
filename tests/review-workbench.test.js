// Task 26 — the reviewer workbench. Every assertion drives the real platform path: a structured
// contribution is submitted, a reviewer reads the workbench, requests changes, the contributor
// corrects the version, the reviewer accepts it, and the mission owner records an adoption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, realMission } from './helpers.js';
import { briefFixture } from './brief-fixture.js';
import { citationComparison, requestedChangesReason, storedAdoption, storedRequestedChanges, submissionState, adoptionDeclaration } from '../src/review-assessment.js';
import { createDeliveryPacket } from '../src/delivery-packet.js';

const randomHash = () => createHash('sha256').update(String(Math.random() * 1e9)).digest('hex');
const SOURCE = 'https://example.org/reviewer-workbench-report';
const source = (sha) => ({ url: SOURCE, location: `Section 2, paragraph 3; SHA256 ${sha}`, date: '2026-10-11' });
const supporting = (changes = {}) => ({
  findings: [{ finding_number: 1, result: 'supported', checked_source_numbers: [1], notes: 'Opened the cited section and read the qualification with it.', ...changes }],
  scope_notes: 'Fictional fixture scope only; the proposed recipient remains unconfirmed.',
  rights_notes: 'Attribution recorded; no reuse permission has been established.',
  cost_notes: 'Freight remains unknown and no budget is approved by this review.',
});
// One contributor, one resident, one real mission owned by the administrator and reviewed by the
// independent reviewer account: four distinct roles for the workbench to keep apart.
async function workbenchFixture(t) {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const { mission, task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'workbench-claim');
  const sha = randomHash();
  const submission = f.tx('submit', f.actor('alice'), { claim_id: claim.id, brief: briefFixture(), sources: [source(sha)], method: 'Read the cited section and recorded its exact location.', limitations: 'A workflow fixture; facts and rights need human verification.', rights: 'Public material recorded with attribution.', mime: 'application/json' }, 'workbench-submit');
  return { ...f, resident: agent, mission, task, claim, submission, sha };
}
const workbench = (f, submission, who = 'reviewer') => f.platform.reviewWorkbench(f.actor(who), { submission: submission.id });

test('the state model, the citation comparison and the composed review text are pure and unambiguous', () => {
  assert.equal(submissionState('pending_review').value, 'pending');
  assert.equal(submissionState('accepted').value, 'accepted');
  assert.equal(submissionState('accepted', true).value, 'adopted');
  assert.equal(submissionState('quarantined').value, 'held');
  assert.equal(submissionState('quarantined', true).value, 'held', 'quarantine holds availability even after a recorded adoption');
  assert.equal(submissionState('quarantined').quarantined, true);
  assert.match(submissionState('quarantined').note, /retained exactly as they were/);
  assert.match(submissionState('changes_requested').note, /nothing is accepted yet/);
  assert.equal(submissionState('rejected').value, 'rejected');
  // A citation with no pinned version has nothing to compare, and says so instead of implying support.
  const uncited = citationComparison(null, null, 'missing');
  assert.equal(uncited.same_version, false);
  assert.equal(uncited.cited_sha256, null);
  assert.match(uncited.summary, /not verified evidence/);
  // The cited version and the current version are compared field by field, never merged.
  const cited = { sha256: 'a'.repeat(64), bytes: 10, retained: true, retrieved_at: '2026-10-01', declared_date: '2026-01-01', unit: '% of GDP', locator: 'Table 1', title: 'First edition' };
  const current = { ...cited, sha256: 'b'.repeat(64), bytes: 12, declared_date: '2025-06-30', title: 'Second edition' };
  const changed = citationComparison(cited, current, 'stale');
  assert.equal(changed.same_version, false);
  assert.equal(changed.newer_version_available, true);
  assert.deepEqual(changed.changed_fields.sort(), ['bytes', 'declared_date', 'sha256', 'title']);
  assert.equal(changed.cited_sha256, cited.sha256);
  assert.match(changed.summary, /cited version \(a{12}/);
  assert.deepEqual(citationComparison(cited, cited, 'captured').changed_fields, []);
  // Requested changes are composed into the version-specific review record and read back exactly.
  const composed = requestedChangesReason('Clarify the fixture.', ['Name the exact supporting clause.', 'State the unit for every figure.']);
  assert.match(composed.reason, /REQUESTED CHANGES — THIS SUBMISSION VERSION/);
  assert.deepEqual(storedRequestedChanges(composed.reason), ['Name the exact supporting clause.', 'State the unit for every figure.']);
  assert.deepEqual(storedRequestedChanges('A plain review with no requested changes.'), []);
  assert.deepEqual(requestedChangesReason('Plain review', undefined).items, []);
  assert.throws(() => requestedChangesReason('Plain review', ['']), { status: 400 });
  assert.throws(() => requestedChangesReason('Plain review', Array.from({ length: 11 }, (_, index) => `Change ${index}`)), { status: 400 });
  // The adoption declaration carries its own evidence and states what adoption is not.
  const declaration = adoptionDeclaration('Cited in the community register.', 'Register entry 2026-10-13.');
  assert.match(declaration, /MISSION OWNER DECLARATION/);
  assert.match(declaration, /not proof that the work was implemented/);
  assert.deepEqual(storedAdoption(declaration), { note: 'Cited in the community register.', evidence: 'Register entry 2026-10-13.', declaration_only: true });
  assert.equal(storedAdoption(adoptionDeclaration('Used once.', '')).evidence, '');
  assert.throws(() => adoptionDeclaration('', 'evidence'), { status: 400 });
});

test('the workbench shows the criteria, each cited source version, the four roles and the state', async (t) => {
  const f = await workbenchFixture(t);
  const view = workbench(f, f.submission);
  assert.equal(view.submission.id, f.submission.id);
  assert.equal(view.submission.state.value, 'pending');
  assert.equal(view.availability.held, false);
  assert.equal(view.criteria.structured, true);
  assert.equal(view.criteria.findings.length, 1);
  assert.deepEqual(view.criteria.findings[0].source_numbers, [1]);
  assert.match(view.criteria.rubric, /Check exact original sources/);
  // The cited version is pinned and compared against what the library holds now.
  assert.equal(view.citations.length, 1);
  const citation = view.citations[0];
  assert.equal(citation.state, 'captured');
  assert.equal(citation.cited_version.sha256, f.sha);
  assert.equal(citation.current_version.sha256, f.sha);
  assert.equal(citation.comparison.same_version, true);
  assert.match(citation.comparison.summary, /is the current version of this source/);
  // Four roles, named, with the reviewer able to act and the adopter unable to.
  assert.equal(view.roles.proposer.name, 'Admin');
  assert.equal(view.roles.contributor.name, 'alice');
  assert.equal(view.roles.reviewer.name, 'reviewer');
  assert.equal(view.roles.adopter.name, 'Admin');
  assert.deepEqual(view.roles.distinct, { contributor_from_reviewer: true, adopter_from_contributor: true, adopter_from_reviewer: true });
  assert.equal(view.roles.may_review, true);
  assert.equal(view.roles.review_refusal, '');
  assert.equal(view.roles.may_adopt, false, 'a pending version is not adopted, and the reviewer is not the adopter');
  assert.match(view.roles.adoption_refusal, /Only the mission owner/);
  assert.match(f.platform.reviewWorkbench(f.actor('admin'), { submission: f.submission.id }).roles.adoption_refusal, /Only a currently accepted contribution/);
  assert.equal(view.coin.issued, false);
  assert.deepEqual(view.requested_changes.items, []);
  // The contributor and the administrator can read it; the reviewer of another mission cannot.
  assert.equal(workbench(f, f.submission, 'alice').roles.may_review, false);
  assert.equal(workbench(f, f.submission, 'admin').roles.may_review, true);
  assert.throws(() => f.platform.reviewWorkbench(f.actor('bob'), { submission: f.submission.id }), { status: 403 });
  // A runtime credential can never open it.
  assert.throws(() => f.platform.reviewWorkbench({ kind: 'runtime', account: f.actor('alice').account, agent: f.agent('alice', 'Sibling') }, { submission: f.submission.id }), { status: 403 });
  // Opening the workbench writes nothing at all.
  const before = [f.platform.get('SELECT COUNT(*) AS n FROM reviews').n, f.platform.get('SELECT COUNT(*) AS n FROM audit').n, f.platform.get('SELECT COUNT(*) AS n FROM submissions').n];
  workbench(f, f.submission);
  assert.deepEqual([f.platform.get('SELECT COUNT(*) AS n FROM reviews').n, f.platform.get('SELECT COUNT(*) AS n FROM audit').n, f.platform.get('SELECT COUNT(*) AS n FROM submissions').n], before);
});

test('a newer capture and an explicit supersede change only the state a reviewer reads, never the cited version', async (t) => {
  const f = await workbenchFixture(t);
  const cited = f.platform.submissionEvidence(f.submission.id)[0];
  const stored = f.platform.get('SELECT * FROM evidence_captures WHERE id=?', cited.capture.id);
  const newer = f.tx('evidenceCapture', f.actor('admin'), { url: SOURCE, sha256: randomHash(), retrieved_at: '2026-10-12', declared_date: '2026-10-09', unit: 'percent', locator: 'Recapture 2026-10-12', evidence_kind: 'web-excerpt' });
  const stale = workbench(f, f.submission).citations[0];
  assert.equal(stale.state, 'stale');
  assert.equal(stale.cited_version.sha256, f.sha, 'the contribution still points at the version it cited');
  assert.equal(stale.current_version.sha256, newer.sha256);
  assert.equal(stale.comparison.same_version, false);
  assert.ok(stale.comparison.changed_fields.includes('sha256'));
  assert.deepEqual(f.platform.get('SELECT * FROM evidence_captures WHERE id=?', cited.capture.id), stored, 'comparison rewrites no capture');
  const superseding = f.tx('evidenceCapture', f.actor('admin'), { url: SOURCE, sha256: randomHash(), retrieved_at: '2026-10-13', locator: 'Corrected edition', evidence_kind: 'web-excerpt', supersedes: cited.capture.id });
  const replaced = workbench(f, f.submission).citations[0];
  assert.equal(replaced.state, 'replaced');
  assert.equal(replaced.cited_version.id, cited.capture.id);
  assert.equal(replaced.current_version.sha256, superseding.sha256);
  // A withdrawal is an operator observation and leaves the cited version exactly as captured.
  f.tx('evidenceWithdraw', f.actor('reviewer'), { url: SOURCE, reason: 'Browser check: the page now refuses the request.' });
  const withdrawn = workbench(f, f.submission).citations[0];
  assert.equal(withdrawn.state, 'withdrawn');
  assert.match(withdrawn.withdrawn_reason, /refuses/);
  assert.equal(withdrawn.cited_version.sha256, f.sha);
  assert.deepEqual(f.platform.get('SELECT * FROM evidence_captures WHERE id=?', cited.capture.id), stored);
  // A withdrawn source is a documented reason a reviewer may refuse acceptance. It is a human
  // judgment, not an automatic block: the workbench says so and nothing is decided for the reviewer.
  assert.match(withdrawn.state_note, /retained exactly as it was captured/);
  assert.match(workbench(f, f.submission).boundaries.evidence, /never the version the contribution cited/);
});

test('a reviewer requests changes criterion by criterion and the contributor reads exactly what was requested', async (t) => {
  const f = await workbenchFixture(t);
  const requested = ['Name the exact supporting clause instead of the section.', 'Give the unit of every figure you repeat.', 'State that the freight estimate is unverified.'];
  const review = f.tx('review', f.actor('reviewer'), {
    submission_id: f.submission.id,
    decision: 'changes_requested',
    reason: 'Two findings need a tighter citation before this can be accepted.',
    requested_changes: requested,
    assessment: supporting({ result: 'uncertain', notes: 'The section is cited but the paragraph is not identified.' }),
  });
  assert.equal(review.decision, 'changes_requested');
  assert.deepEqual(review.requested_changes, requested);
  assert.equal(review.state.value, 'changes_requested');
  const stored = f.platform.get('SELECT * FROM reviews WHERE submission_id=?', f.submission.id);
  assert.match(stored.reason, /HUMAN EVIDENCE ASSESSMENT — THIS SUBMISSION VERSION/);
  assert.match(stored.reason, /Finding 1: Support or applicability uncertain/);
  assert.match(stored.reason, /REQUESTED CHANGES — THIS SUBMISSION VERSION/);
  // The contribution goes back to its contributor, unchanged, with nothing accepted and no coin.
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', f.submission.id).status, 'changes_requested');
  assert.equal(f.platform.get('SELECT status FROM claims WHERE id=?', f.claim.id).status, 'changes_requested');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', f.resident.id).n, 0);
  assert.equal(f.platform.gallery().some((record) => record.id === f.submission.id), false);
  // The contributor's own history carries the same list, and the workbench shows it with the state.
  const contributor = f.platform.history(f.actor('alice')).submissions.find((entry) => entry.id === f.submission.id);
  assert.deepEqual(contributor.requested_changes, requested);
  assert.equal(contributor.state.value, 'changes_requested');
  assert.equal(contributor.adoptions.length, 0);
  const view = workbench(f, f.submission);
  assert.deepEqual(view.requested_changes.items, requested);
  assert.equal(view.requested_changes.review_id, stored.id);
  assert.equal(view.assessment.decision, 'changes_requested');
  assert.equal(view.submission.state.value, 'changes_requested');
  assert.equal(view.roles.may_review, false, 'a reviewed version is not reviewed again');
  assert.match(view.roles.review_refusal, /not waiting for review/);
  // Another operator's history never carries this list.
  assert.equal(f.platform.history(f.actor('bob')).submissions.length, 0);
  // Requested changes belong to the changes-requested decision alone.
  const second = f.tx('submit', f.actor('alice'), { claim_id: f.claim.id, brief: briefFixture({ recipient: 'Proposed fixture recipient; no real appointment' }), sources: [source(randomHash())], method: 'Corrected read.', limitations: 'Still a workflow fixture.', rights: 'Public material with attribution.', mime: 'application/json' }, 'workbench-submit-2');
  assert.throws(() => f.tx('review', f.actor('reviewer'), { submission_id: second.id, decision: 'accepted', reason: 'Accept.', requested_changes: ['Not allowed here.'], assessment: supporting() }), { status: 400 });
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', second.id).status, 'pending_review');
});

test('the corrected version is accepted criterion by criterion and issues exactly one receipt', async (t) => {
  const f = await workbenchFixture(t);
  f.tx('review', f.actor('reviewer'), { submission_id: f.submission.id, decision: 'changes_requested', reason: 'Tighten the citation.', requested_changes: ['Cite the paragraph, not the section.'] });
  const corrected = f.tx('submit', f.actor('alice'), { claim_id: f.claim.id, brief: briefFixture({ recipient: 'Proposed fixture recipient; no real appointment' }), sources: [{ url: SOURCE, location: `Section 2, paragraph 3; SHA256 ${randomHash()}`, date: '2026-10-12' }], method: 'Re-read the corrected section.', limitations: 'Still a workflow fixture.', rights: 'Public material with attribution.', mime: 'application/json' }, 'workbench-corrected');
  assert.equal(corrected.version, 2);
  const view = workbench(f, corrected);
  assert.equal(view.submission.state.value, 'pending');
  assert.deepEqual(view.requested_changes.items, [], 'the previous version keeps its own list; this version has none yet');
  assert.equal(view.roles.may_review, true);
  const accepted = f.tx('review', f.actor('reviewer'), { submission_id: corrected.id, decision: 'accepted', reason: 'Paragraph citation checked; unknown freight left explicit.', assessment: supporting() });
  assert.equal(accepted.coin_reward.status, 'awarded');
  assert.equal(accepted.state.value, 'accepted');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', f.resident.id).n, 1);
  assert.equal(f.platform.get('SELECT amount FROM coin_rewards WHERE agent_id=?', f.resident.id).amount, 10);
  const acceptedView = workbench(f, corrected, 'admin');
  assert.equal(acceptedView.submission.state.value, 'accepted');
  assert.equal(acceptedView.coin.issued, true);
  assert.equal(acceptedView.coin.amount, 10);
  assert.equal(acceptedView.coin.availability, 'available');
  assert.equal(acceptedView.roles.may_review, false);
  assert.equal(acceptedView.roles.may_adopt, true, 'the mission owner may now declare an adoption');
  assert.equal(workbench(f, corrected, 'reviewer').roles.may_adopt, false, 'the reviewer may never adopt the version they accepted');
  assert.match(workbench(f, corrected, 'reviewer').roles.adoption_refusal, /Only the mission owner/);
  // The earlier version keeps its own review and its own state, and the contributor reads both.
  assert.equal(workbench(f, f.submission).submission.state.value, 'changes_requested');
  const history = f.platform.history(f.actor('alice'));
  assert.equal(history.submissions.length, 2);
  assert.deepEqual(history.submissions.map((entry) => entry.state.value).sort(), ['accepted', 'changes_requested']);
  assert.deepEqual(history.submissions.find((entry) => entry.id === f.submission.id).requested_changes, ['Cite the paragraph, not the section.']);
});

test('the mission owner records an adoption with its supporting evidence, and self-adoption is refused', async (t) => {
  const f = await workbenchFixture(t);
  f.tx('review', f.actor('reviewer'), { submission_id: f.submission.id, decision: 'changes_requested', reason: 'Fixture correction requested.', requested_changes: ['State the fixture scope again.'] });
  const submission = f.tx('submit', f.actor('alice'), { claim_id: f.claim.id, brief: briefFixture({ recipient: 'Proposed fixture recipient; no real appointment' }), sources: [source(randomHash())], method: 'Read.', limitations: 'Fixture.', rights: 'Attribution.', mime: 'application/json' }, 'workbench-submit-2');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Fixture reviewed.', assessment: supporting() });
  // The reviewer cannot adopt: the adopter is the mission owner, and must be a different person.
  const reviewer = f.actor('reviewer');
  assert.equal(f.platform.reviewWorkbench(reviewer, { submission: submission.id }).roles.may_adopt, false);
  assert.throws(() => f.tx('adoption', reviewer, { submission_id: submission.id, note: 'Adopting my own review.' }), { status: 403 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', submission.id).n, 0);
  // A contribution cannot be declared adopted until it is currently accepted.
  const otherTask = f.tx('createTask', f.actor('admin'), { mission_id: f.mission.id, title: 'Another fixture task', instructions: 'Fixture', rights: 'Fixture permission', allowed_domains: ['example.org'] });
  const otherClaim = f.tx('claim', f.actor('bob'), { task_id: otherTask.id, agent_id: f.agent('bob').id }, 'workbench-pending-claim');
  const pending = f.tx('submit', f.actor('bob'), { claim_id: otherClaim.id, artifact: 'Not reviewed yet.', sources: [{ url: SOURCE, location: 'Section 5', date: '2026-10-11' }], method: 'Read.', limitations: 'Fixture.', rights: 'Attribution.' }, 'workbench-pending');
  assert.throws(() => f.tx('adoption', f.actor('admin'), { submission_id: pending.id, note: 'Adopting unreviewed work.' }), { status: 409 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', pending.id).n, 0);
  // The mission owner declares the use, with the evidence they can name.
  const declaration = f.tx('adoption', f.actor('admin'), { submission_id: submission.id, note: 'Cited in the fictional community register.', evidence: 'Register entry REG-2026-10-13, reviewed by the same mission owner.' });
  assert.equal(declaration.evidence_supplied, true);
  assert.equal(declaration.declaration_only, true);
  assert.match(declaration.declaration, /DOCUMENTED ADOPTION/);
  assert.match(declaration.boundary, /not proof that the work was implemented/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', submission.id).n, 1);
  const storedRow = f.platform.get('SELECT * FROM adoptions WHERE submission_id=?', submission.id);
  assert.equal(storedRow.owner_id, f.actor('admin').account.id);
  // The workbench, the gallery and the packet all show it as a declaration with its evidence.
  const view = f.platform.reviewWorkbench(f.actor('admin'), { submission: submission.id });
  assert.equal(view.submission.state.value, 'adopted');
  assert.equal(view.adoptions.length, 1);
  assert.equal(view.adoptions[0].evidence, 'Register entry REG-2026-10-13, reviewed by the same mission owner.');
  assert.equal(view.adoptions[0].declaration_only, true);
  assert.equal(view.roles.may_adopt, true);
  const record = f.platform.gallery(submission.id)[0];
  assert.equal(record.adoption_count, 1);
  assert.equal(record.state.value, 'adopted');
  assert.equal(record.adoptions[0].note, 'Cited in the fictional community register.');
  const packet = createDeliveryPacket(record);
  assert.equal(packet.documented_uses, 1);
  assert.equal(packet.adoptions[0].declared_by, 'Admin');
  assert.match(packet.adoptions[0].supporting_evidence, /REG-2026-10-13/);
  assert.match(packet.boundary, /recorded declaration by the mission owner/);
  assert.match(packet.boundary, /not proof that the work was implemented/);
  assert.match(packet.boundary, /may become outdated/);
  // An adoption without a named evidence reference is honest about the gap rather than silent.
  f.tx('adoption', f.actor('admin'), { submission_id: submission.id, note: 'A second, unrecorded use.' });
  const second = f.platform.gallery(submission.id)[0].adoptions.find((adoption) => adoption.note === 'A second, unrecorded use.');
  assert.equal(second.evidence, '');
  assert.equal(second.declaration_only, true);
});

test('self-adoption is refused when the mission owner is also the contributor, and grants nothing', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const { task } = realMission(f, { owner_id: f.actor('alice').account.id });
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'self-adoption-claim');
  const submission = f.tx('submit', f.actor('alice'), { claim_id: claim.id, artifact: 'Work the contributor also owns.', sources: [{ url: SOURCE, location: 'Section 1', date: '2026-10-11' }], method: 'Read.', limitations: 'Fixture.', rights: 'Attribution.' }, 'self-adoption-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture acceptance.' });
  const view = f.platform.reviewWorkbench(f.actor('alice'), { submission: submission.id });
  assert.equal(view.roles.distinct.adopter_from_contributor, false);
  assert.equal(view.roles.may_adopt, false);
  assert.match(view.roles.adoption_refusal, /cannot adopt their own contribution/);
  assert.throws(() => f.tx('adoption', f.actor('alice'), { submission_id: submission.id, note: 'Adopting my own work.' }), { status: 403 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n, 0, 'a refused self-adoption writes no record at all');
  assert.equal(f.platform.gallery(submission.id)[0].adoption_count, 0);
  assert.equal(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).merit.adopted, 0);
});

test('a private draft survives the changes-requested round trip and stays with its owner', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'draft-round-trip-claim');
  const counts = { sources: 1, findings: 1, options: 2, milestones: 1, costs: 1 };
  const saved = f.tx('draftSave', f.actor('alice'), { claim_id: claim.id, expected_revision: 0, format: 'decision-brief-form-v1', counts, values: { title: 'Private brief in progress', finding_0_text: 'Unfinished private work.' } });
  assert.equal(saved.revision, 1);
  const submission = f.tx('submit', f.actor('alice'), { claim_id: claim.id, brief: briefFixture(), sources: [source(randomHash())], method: 'Read.', limitations: 'Fixture.', rights: 'Attribution.', mime: 'application/json' }, 'draft-round-trip-submit');
  assert.equal(f.platform.drafts(f.actor('alice')).length, 0, 'submitting archives the private draft');
  assert.equal(f.platform.exportAccount(f.actor('alice')).drafts.length, 1, 'the archived draft stays in the owner’s export');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'changes_requested', reason: 'Correct the citation.', requested_changes: ['Cite the paragraph instead of the section.'] });
  const mine = f.platform.drafts(f.actor('alice'));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].claim_id, claim.id);
  assert.equal(mine[0].content.values.title, 'Private brief in progress');
  assert.deepEqual(f.platform.drafts(f.actor('bob')), [], 'another operator sees no draft');
  f.advance(600);
  const next = f.tx('draftSave', f.actor('alice'), { claim_id: claim.id, expected_revision: 1, format: 'decision-brief-form-v1', counts, values: { title: 'Corrected brief in progress' } });
  assert.equal(next.revision, 2);
  assert.throws(() => f.tx('draftSave', f.actor('bob'), { claim_id: claim.id, expected_revision: 2, format: 'decision-brief-form-v1', counts, values: { title: 'Not mine' } }), { status: 404 });
  const view = workbench(f, submission);
  assert.deepEqual(view.requested_changes.items, ['Cite the paragraph instead of the section.']);
  assert.equal(view.roles.may_review, false);
});
