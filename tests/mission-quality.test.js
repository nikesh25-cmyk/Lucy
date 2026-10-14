import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import {
  assessMission, assessReviewIntegrity, dismissSignal, duplicateMatches, corpusWeights, tokenSetOf, entryText, similarity,
  AUTHORITY, BOUNDARIES, LADDER_BLOCKED, MISSION_AREAS, REQUIRED_FIELDS, SEVERITIES, SIGNAL_CODES, SOURCE_RULES, STATUS_LADDER, THRESHOLDS,
} from '../src/mission-quality.js';

// The module is a pure reader. Nothing in this suite writes through it, and no test depends on a
// live installation: the "existing corpus" is read from the temporary database the fixture seeds.
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) deepFreeze(value[key]); }
  return value;
};

// A fully specified proposal: one real, answerable question with a source register that carries a
// date and a version. Nothing here is a claim about a real institution or a real outcome.
const completeProposal = (f, overrides = {}) => ({
  mission: {
    id: 'proposal-tea-directive', title: 'Indian tea import directive clause comparison', area: 'Agriculture',
    summary: 'Compare the operative clauses of the current Indian tea import directive with the provisions they replaced.',
    owner_id: f.actor('alice').account.id, beneficiary: 'A Nepal tea producer group (fixture; no consent presumed or contacted)',
    reviewer_id: f.actor('reviewer').account.id,
    rubric: 'Every clause cites the page of the current directive. Superseded provisions are labelled and dated. An unreadable clause stays unresolved rather than guessed. Amended text is never described as current without confirmation.',
  },
  task: {
    id: 'task-tea-directive', title: 'Compare Directive 02/2026 against the February provisions',
    instructions: 'Which operative clauses of Tea Board India Directive 02/2026 apply to Nepal-origin bulk tea placed on the Indian domestic market? Compare each clause with the provision it replaced and record what is still unresolved.',
    rights: 'Paraphrase with attribution and inspect each source\u2019s reuse terms. No full protected text, table or logo is reproduced.',
    allowed_domains: ['www.teaboard.gov.in'],
  },
  question: 'Which operative clauses of Tea Board India Directive 02/2026 apply to Nepal-origin bulk tea placed on the Indian domestic market?',
  limits: 'The directive does not establish buyer demand, tariff treatment, laboratory capacity or shipment economics. Nothing here is a finding until a human reviewer accepts it.',
  sources: [{ url: 'https://www.teaboard.gov.in/directive-02-2026', location: 'Page 3, clause 4.2', date: '2026-06-01', version: 'sha256:aa11000000000000000000000000000000000000000000000000000000000000' }],
  ...overrides,
});

const corpusFrom = (platform) => platform.all('SELECT id,title,instructions,rubric FROM research_leads').map((lead) => ({ id: lead.id, title: lead.title, instructions: lead.instructions, rubric: lead.rubric }));
const fields = (report) => report.missing.map((entry) => entry.field);
const codes = (report) => report.signals.map((signal) => signal.code);

test('a fully specified real mission reports no missing field and no quality signal', async (t) => {
  const f = await fixture(t);
  const report = assessMission(completeProposal(f), { existing: corpusFrom(f.platform) });
  assert.deepEqual(report.missing, []);
  assert.equal(report.completeness.complete, true);
  assert.equal(report.scope, 'task');
  assert.equal(report.fictional, false);
  assert.deepEqual(report.signals, []);
  assert.deepEqual(report.duplicates.matches, []);
  // Completeness is a statement about the fields, not a decision about the mission.
  assert.match(report.completeness.note, /not an approval, a priority, a readiness decision/);
  assert.equal(report.advisory, true);
});

test('the report marks external implementation and a measured outcome as blocked on a consenting beneficiary', async (t) => {
  const f = await fixture(t);
  const report = assessMission(completeProposal(f), { existing: corpusFrom(f.platform) });
  assert.deepEqual(report.ladder.stages, [...STATUS_LADDER]);
  assert.deepEqual(LADDER_BLOCKED.map((entry) => entry.stage), ['externally evidenced implementation', 'measured outcome']);
  for (const entry of report.ladder.blocked) assert.equal(entry.blocked_on, 'a consenting beneficiary');
  // An adoption declaration is a declaration, not implementation, and the seeded leads are proposals.
  assert.match(report.ladder.note, /recorded adoption declaration is a declaration, not implementation/);
  assert.match(report.ladder.note, /proposals, not studies/);
  assert.match(BOUNDARIES.corpus, /proposals, not studies/);
});

test('a demonstration mission is legitimate only with an explicit fictional marker', async (t) => {
  const f = await fixture(t);
  const demonstration = { mission: { id: 'demo-1', title: 'Practice source register', area: 'Climate', summary: 'Practise recording one source.', rubric: 'A human checks the location and rights before use.' }, question: 'Which public page states the local heat-resilience guidance?', limits: 'A practice activity proves no outcome.', rights: 'Public page, paraphrased.', sources: [{ url: 'https://sdgs.un.org/goals/goal13', location: 'Goal 13 page', date: '2026-10-11', version: 'v1' }] };
  const withoutMarker = assessMission(demonstration);
  assert.ok(fields(withoutMarker).includes('owner'));
  assert.ok(fields(withoutMarker).includes('beneficiary'));
  assert.ok(fields(withoutMarker).includes('reviewer'));
  assert.ok(codes(withoutMarker).includes('fictional_marker_absent'));
  // The shipped `demo` flag is the explicit marker, and it waives the owner and the beneficiary. A
  // reviewer is still required: a demonstration still has to be reviewed by someone other than the
  // person doing it, and the brief's fiction exemption is written for the owner and beneficiary only.
  const withMarker = assessMission({ ...demonstration, demo: true });
  assert.equal(withMarker.fictional, true);
  assert.deepEqual(fields(withMarker), ['reviewer']);
  assert.equal(codes(withMarker).includes('fictional_marker_absent'), false);
  assert.deepEqual(fields(assessMission({ ...demonstration, demo: true, mission: { ...demonstration.mission, reviewer_id: f.actor('reviewer').account.id } })), []);
  // A phrase is not a marker: a demonstration still needs the explicit flag to waive those fields.
  const proseOnly = assessMission({ ...demonstration, mission: { ...demonstration.mission, title: 'Fictional demonstration of a source register' } });
  assert.equal(proseOnly.fictional, false);
  assert.ok(fields(proseOnly).includes('owner'));
  // The marker waives nothing else: a fictional proposal still needs a question, criteria, limits and rights.
  const thin = assessMission({ id: 'demo-2', title: 'Practice', area: 'Climate', demo: true, summary: 'Practice.' });
  for (const field of ['question', 'evidence_criteria', 'limits', 'rights', 'sources']) assert.ok(fields(thin).includes(field), field);
});

test('each required field is reported with its own name and a reason when it is missing or unusable', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['title', (p) => { delete p.mission.title; delete p.task.title; return p; }],
    ['area', (p) => { delete p.mission.area; return p; }],
    ['owner', (p) => { delete p.mission.owner_id; return p; }],
    ['beneficiary', (p) => { delete p.mission.beneficiary; return p; }],
    ['question', (p) => { delete p.question; delete p.task.instructions; delete p.mission.summary; return p; }],
    ['evidence_criteria', (p) => { delete p.mission.rubric; return p; }],
    ['limits', (p) => { delete p.limits; return p; }],
    ['rights', (p) => { delete p.task.rights; return p; }],
    ['sources', (p) => { delete p.sources; return p; }],
    ['source_date', (p) => { delete p.sources[0].date; return p; }],
    ['source_version', (p) => { delete p.sources[0].version; return p; }],
    ['reviewer', (p) => { delete p.mission.reviewer_id; return p; }],
    ['reviewer_independence', (p) => { p.mission.reviewer_id = p.mission.owner_id; return p; }],
    ['source_hosts', (p) => { delete p.task.allowed_domains; return p; }],
  ];
  const required = cases.map(([field]) => field).sort();
  assert.deepEqual(required, [...new Set(REQUIRED_FIELDS.map((entry) => entry.field))].sort());
  for (const [field, damage] of cases) {
    const report = assessMission(damage(completeProposal(f)));
    assert.ok(fields(report).includes(field), `${field} is reported`);
    const entry = report.missing.find((item) => item.field === field);
    assert.ok(entry.reason.length > 30, `${field} carries a reason`);
    assert.equal(entry.requirement, REQUIRED_FIELDS.find((item) => item.field === field).requirement);
    assert.equal(report.completeness.complete, false);
    // No other field of the complete proposal goes missing because of that one defect.
    const collateral = fields(report).filter((name) => name !== field);
    assert.deepEqual(collateral, [], `${field} does not make other fields missing`);
    assert.equal(report.completeness.missing.includes(field), true);
    assert.equal(report.completeness.satisfied.includes(field), false);
  }
  // The unusable-value path: a placeholder beneficiary and an unsupported area are reported, not accepted.
  const named = completeProposal(f);
  const placeholder = assessMission({ ...named, mission: { ...named.mission, beneficiary: 'To be selected' } });
  assert.ok(fields(placeholder).includes('beneficiary'));
  assert.match(placeholder.missing.find((item) => item.field === 'beneficiary').reason, /names no party/);
  const offList = assessMission({ ...named, mission: { ...named.mission, area: 'Ocean' } });
  assert.ok(fields(offList).includes('area'));
  assert.match(offList.missing.find((item) => item.field === 'area').reason, /not one of the areas/);
  // A beneficiary that names a party is usable even when the field also mentions an unresolved
  // attribute, so the placeholder rule is not a substring rule and does not flag one.
  const looksLike = assessMission({ ...named, mission: { ...named.mission, beneficiary: 'Placeholder Industries Ltd (fixture)' } });
  assert.equal(fields(looksLike).includes('beneficiary'), false);
  const unresolved = assessMission({ ...named, mission: { ...named.mission, beneficiary: 'Smallholder tea growers in Bardiya district whose land tenure is unknown' } });
  assert.equal(fields(unresolved).includes('beneficiary'), false);
  // "Beneficiary to be selected" names nobody, so it is still reported.
  const pending = assessMission({ ...named, mission: { ...named.mission, beneficiary: 'Beneficiary to be selected' } });
  assert.ok(fields(pending).includes('beneficiary'));
});

test('a topic instead of a question is flagged, and a goal restated as a question is flagged separately', async (t) => {
  const f = await fixture(t);
  const topic = assessMission(completeProposal(f, { question: 'Climate resilience and adaptation finance' }));
  assert.ok(codes(topic).includes('question_is_topic'));
  assert.ok(fields(topic).includes('question'));
  assert.match(topic.signals.find((signal) => signal.code === 'question_is_topic').detail, /not interrogative/);
  // An imperative is a topic too.
  const imperative = assessMission(completeProposal(f, { question: 'Record the publisher, date, geography, claim and exact supporting location of one source.' }));
  assert.ok(codes(imperative).includes('question_is_topic'));
  // An answerable question is not flagged, and neither is a short interrogative one.
  for (const question of ['How much tea was exported?', 'Which clauses of the directive are still operative?']) {
    assert.equal(codes(assessMission(completeProposal(f, { question }))).includes('question_is_topic'), false, question);
  }
  // A question that only repeats the proposal's own summary restates a goal.
  const restatement = assessMission({ id: 'r', title: 'Heat resilience register', area: 'Climate', demo: true, summary: 'Build a traceable register of public heat resilience evidence.', question: 'Build a traceable register of public heat resilience evidence?', rubric: 'Sources are checked.', limits: 'A register is not an outcome.', rights: 'Paraphrase.', sources: [{ url: 'https://sdgs.un.org/goals/goal13', location: 'Goal 13', date: '2026-10-11', version: 'v1' }] });
  assert.ok(codes(restatement).includes('question_restates_goal'));
  assert.equal(codes(restatement).includes('question_is_topic'), false);
});

test('a near-duplicate is reported with the matched id and the score that was computed, and a distinct proposal is not', async (t) => {
  const f = await fixture(t);
  const corpus = corpusFrom(f.platform);
  const source = f.platform.get("SELECT * FROM research_leads WHERE id='NP-2-baseline'");
  const copy = { id: 'proposal-copy', title: source.title, instructions: source.instructions, rubric: source.rubric };
  const matches = duplicateMatches(copy, corpus);
  assert.equal(matches.considered, corpus.length - 0);
  assert.ok(matches.above_threshold > 1, 'a template copy matches its own template family');
  assert.equal(matches.matches[0].id, 'NP-2-baseline');
  assert.equal(matches.matches[0].score, 1, 'a byte-identical copy scores 1');
  assert.equal(matches.matches[0].plain_score, 1);
  assert.equal(matches.matches[0].threshold, THRESHOLDS.duplicate_similarity);
  assert.match(matches.matches[0].basis, /Dice coefficient/);
  assert.equal(matches.matches[0].advisory, true);
  assert.deepEqual(matches.matches[0].distinguishing.in_existing, [], 'nothing distinguishes a copy from its source');
  assert.equal(matches.matches.length, Math.min(THRESHOLDS.duplicate_matches_reported, matches.above_threshold));
  // The assessment carries the same finding as a signal, with the closest id and score in the measure.
  const assessed = assessMission(completeProposal(f, { mission: { ...completeProposal(f).mission, id: 'proposal-copy', title: source.title }, task: { ...completeProposal(f).task, instructions: source.instructions }, question: source.instructions.split('\n')[0], title: source.title }), { existing: corpus });
  const signal = assessed.signals.find((item) => item.code === 'near_duplicate');
  assert.ok(signal, 'the near-duplicate is signalled');
  assert.equal(signal.measure.closest.id, 'NP-2-baseline');
  assert.equal(typeof signal.measure.closest.score, 'number');
  assert.ok(signal.measure.closest.score >= signal.measure.threshold);
  assert.ok(signal.measure.closest.score < 1, 'a copy wrapped in the copier\u2019s own framing scores below an exact copy');
  assert.match(signal.detail, /never an automatic rejection/);
  // A genuinely distinct proposal is not reported, and the six Nepal tea proposals are distinct of each other.
  const distinct = assessMission(completeProposal(f), { existing: corpus });
  assert.deepEqual(distinct.duplicates.matches, []);
  assert.equal(codes(distinct).includes('near_duplicate'), false);
  const pilots = corpus.filter((entry) => entry.id.startsWith('pilot-tea-'));
  assert.equal(pilots.length, 6);
  for (const pilot of pilots) {
    const other = duplicateMatches(pilot, corpus.filter((entry) => entry.id !== pilot.id));
    assert.deepEqual(other.matches, [], `${pilot.id} is not a near-duplicate of anything in the shipped corpus`);
  }
});

test('a title match that is not a semantic match is not reported as a duplicate', async (t) => {
  const f = await fixture(t);
  const corpus = corpusFrom(f.platform);
  const source = f.platform.get("SELECT * FROM research_leads WHERE id='NP-2-baseline'");
  // A naive rule keyed on the title would call this a duplicate of NP-2-baseline: it carries the
  // same title. The measure compares the text, and the text asks a different question.
  const sameTitle = {
    id: 'proposal-same-title', title: source.title,
    summary: 'Scope one licensed cold-store operator near the Nepal\u2013India border crossing.',
    question: 'Which licensed cold-store operator in Biratnagar can hold a single 40 kg lot of orthodox tea, and what does its published tariff schedule charge per pallet-day?',
    rubric: 'The tariff cites the operator\u2019s own published schedule and its date.',
    limits: 'A published schedule does not establish available capacity or a booking.',
    rights: 'Paraphrase with attribution.',
    sources: [{ url: 'https://www.teacoffee.gov.np/tariff', location: 'Tariff table', date: '2026-05-01', version: 'v3' }],
  };
  const matches = duplicateMatches(sameTitle, corpus);
  assert.deepEqual(matches.matches, []);
  assert.ok(similarity(tokenSetOf(sameTitle.title), tokenSetOf(source.title)) === 1, 'the titles are in fact identical');
  // A proposal that merely quotes part of an existing entry is also not reported: the measure is
  // computed over the whole text, so a partial lift does not reach the threshold.
  const partial = { id: 'proposal-partial', title: source.title, summary: source.instructions.slice(0, 600), rubric: source.rubric, question: source.instructions.split('\n')[0], limits: 'Recorded.', rights: 'Recorded.' };
  assert.deepEqual(duplicateMatches(partial, corpus).matches, []);
});

test('the duplicate threshold is calibrated on the shipped corpus, not asserted', async (t) => {
  const f = await fixture(t);
  const corpus = corpusFrom(f.platform);
  const leads = f.platform.all('SELECT id,stage,goal,country_code FROM research_leads');
  const weights = corpusWeights(corpus);
  const sets = new Map(corpus.map((entry) => [entry.id, tokenSetOf(entryText(entry))]));
  const score = (a, b) => similarity(sets.get(a), sets.get(b), weights);
  // The measurement runs over the two goals the shipped concern templates live on, so the scan stays
  // bounded while still covering every class the threshold has to sort.
  const rows = leads.filter((lead) => lead.goal === 2 || lead.goal === 17);
  let lowestTemplate = Infinity, highestUnrelated = 0, highestRelated = 0;
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j], value = score(a.id, b.id);
    // One concern template, one goal, another subject: what the signal exists to surface.
    if (a.stage === b.stage && a.goal === b.goal && a.country_code !== b.country_code) lowestTemplate = Math.min(lowestTemplate, value);
    // Different subject, goal and concern: work that is not the same work at all.
    else if (a.stage !== b.stage && a.goal !== b.goal && a.country_code !== b.country_code) highestUnrelated = Math.max(highestUnrelated, value);
    // Everything else: related, and deliberately claimed neither way.
    else highestRelated = Math.max(highestRelated, value);
  }
  assert.equal(THRESHOLDS.duplicate_similarity, 0.6);
  assert.ok(lowestTemplate >= THRESHOLDS.duplicate_similarity, `every same-template pair clears the threshold (lowest ${lowestTemplate.toFixed(4)})`);
  assert.ok(highestUnrelated < THRESHOLDS.duplicate_similarity, `no unrelated pair reaches the threshold (highest ${highestUnrelated.toFixed(4)})`);
  assert.ok(highestRelated > THRESHOLDS.duplicate_similarity, `related-but-different pairs straddle the threshold (highest ${highestRelated.toFixed(4)}), which is why the signal reports the tokens that distinguish them`);
  // The threshold sits at the middle of the widest gap the corpus shows between unrelated work and
  // work that shares a template. It is an editorial choice inside that measured band, and this test
  // is the re-measurement: if the corpus changes, the band moves and this test says so.
  assert.ok(THRESHOLDS.duplicate_similarity > highestUnrelated && THRESHOLDS.duplicate_similarity < Math.min(lowestTemplate, highestRelated), 'inside the measured band');
  // A proposal that reproduces a shipped entry's own text while wrapping it in its own summary,
  // rubric, limits, rights and question is still caught: that is the duplicate worth catching.
  const wrapper = {
    summary: 'Compare the operative clauses of the current Indian tea import directive with the provisions they replaced.',
    rubric: 'Every clause cites the page of the current directive. Superseded provisions are labelled and dated.',
    limits: 'The directive does not establish buyer demand, tariff treatment or shipment economics.',
    rights: 'Paraphrase with attribution and inspect each source\u2019s reuse terms.',
    question: 'Which operative clauses of Tea Board India Directive 02/2026 apply to Nepal-origin bulk tea placed on the Indian domestic market?',
  };
  for (const id of ['NP-2-baseline', 'NP-2-destination', 'NP-17-institutions', 'BD-2-interventions']) {
    const source = corpus.find((entry) => entry.id === id);
    const wrapped = duplicateMatches({ id: `copy-of-${id}`, title: source.title, instructions: source.instructions, rubric: source.rubric, ...wrapper }, corpus);
    assert.equal(wrapped.matches[0].id, id, `${id} is still the closest match to a wrapped copy`);
    assert.ok(wrapped.matches[0].score >= THRESHOLDS.duplicate_similarity, `a wrapped copy of ${id} scores ${wrapped.matches[0].score}`);
  }
  // The six Nepal tea proposals are distinct of the whole corpus.
  for (const lead of leads.filter((item) => item.id.startsWith('pilot-tea-'))) {
    let best = 0;
    for (const other of leads) if (other.id !== lead.id) best = Math.max(best, score(lead.id, other.id));
    assert.ok(best < THRESHOLDS.duplicate_similarity, `${lead.id} best match ${best.toFixed(4)} stays below the threshold`);
    assert.ok(best >= 0.3, `${lead.id} best match ${best.toFixed(4)} is a measured value, not zero`);
  }
  // A new, fully specified mission about the same subject as a shipped proposal stays below it too.
  const clean = assessMission(completeProposal(f), { existing: corpus });
  assert.deepEqual(clean.duplicates.matches, []);
  assert.equal(clean.duplicates.considered, corpus.length);
});

test('a reviewer who is the owner or the contributor is flagged, and reported as an unusable field', async (t) => {
  const f = await fixture(t);
  const proposal = completeProposal(f);
  const owner = assessMission({ ...proposal, mission: { ...proposal.mission, reviewer_id: proposal.mission.owner_id } });
  assert.ok(codes(owner).includes('reviewer_is_owner'));
  assert.ok(fields(owner).includes('reviewer_independence'));
  assert.equal(owner.signals.find((signal) => signal.code === 'reviewer_is_owner').severity, 'priority');
  const contributor = assessMission({ ...proposal, contributor_id: proposal.mission.reviewer_id });
  assert.ok(codes(contributor).includes('reviewer_is_contributor'));
  assert.ok(fields(contributor).includes('reviewer_independence'));
  assert.equal(codes(contributor).includes('reviewer_is_owner'), false);
  // A distinct reviewer, owner and contributor is the ordinary case and is not flagged.
  const clean = assessMission({ ...proposal, contributor_id: f.actor('bob').account.id });
  assert.equal(codes(clean).includes('reviewer_is_owner'), false);
  assert.equal(codes(clean).includes('reviewer_is_contributor'), false);
  assert.equal(fields(clean).includes('reviewer_independence'), false);
});

test('reviewer concentration and a small reviewer pool are computed from the supplied records only', async (t) => {
  const f = await fixture(t);
  const contributor = f.actor('alice').account.id, other = f.actor('bob').account.id;
  const reviewer = f.actor('reviewer').account.id, admin = f.actor('admin').account.id;
  const records = [];
  for (let index = 0; index < 8; index++) records.push({ reviewer_id: reviewer, contributor_id: contributor, decision: 'accepted' });
  for (let index = 0; index < 4; index++) records.push({ reviewer_id: admin, contributor_id: other, decision: 'accepted' });
  records.push({ reviewer_id: reviewer, contributor_id: other, decision: 'changes_requested' });
  const integrity = assessReviewIntegrity(records);
  assert.deepEqual(integrity.records, { supplied: 13, accepted: 12, contributors: 2, reviewers: 2 });
  const concentration = integrity.signals.find((signal) => signal.code === 'reviewer_concentration');
  assert.ok(concentration);
  assert.equal(concentration.measure.share, 1);
  assert.equal(concentration.measure.accepted, 8);
  assert.equal(concentration.measure.contributor_accepted, 8);
  assert.equal(concentration.measure.share_threshold, THRESHOLDS.reviewer_share);
  assert.equal(concentration.advisory, true);
  assert.match(concentration.detail, /proof/);
  const pool = integrity.signals.find((signal) => signal.code === 'small_reviewer_pool');
  assert.equal(pool.measure.distinct_reviewers, 2);
  assert.equal(pool.measure.accepted_records, 12);
  // Only accepted records are counted, and a completed measure is reported as a measured share.
  assert.equal(integrity.measures.reviewer_shares.some((share) => share.contributor_id === other && share.reviewer_id === reviewer), false);
  assert.equal(integrity.measures.reviewer_pool.distinct_reviewers, 2);

  // The floor: two acceptances covered by one reviewer is not reported, so a naive rule keyed only
  // on "one reviewer handled every acceptance" would have flagged it wrongly.
  const tiny = assessReviewIntegrity([{ reviewer_id: reviewer, contributor_id: contributor, decision: 'accepted' }, { reviewer_id: reviewer, contributor_id: contributor, decision: 'accepted' }]);
  assert.deepEqual(tiny.signals, []);
  assert.equal(tiny.measures.reviewer_shares[0].share, 1);
  // An empty record set yields no signal at all, and says so instead of implying a clean bill of health.
  const empty = assessMission(completeProposal(f), { existing: { proposals: corpusFrom(f.platform), reviews: [] } });
  assert.equal(empty.review.checked, false);
  assert.match(empty.review.note, /not a clean bill of health/);
  // A supplied self-review is flagged on the record, because the shipped review path refuses one.
  const selfReview = assessReviewIntegrity([{ reviewer_id: contributor, contributor_id: contributor, decision: 'accepted' }]);
  assert.equal(selfReview.signals.find((signal) => signal.code === 'reviewer_is_contributor').severity, 'priority');
  // The proposal carries only the integrity signals that concern a party it names.
  const relevant = assessMission({ ...completeProposal(f), contributor_id: contributor }, { existing: { proposals: [], reviews: records } });
  assert.ok(codes(relevant).includes('reviewer_concentration'));
  const stranger = {
    mission: { id: 'proposal-stranger', title: 'Cold storage tariff scope check', area: 'Trade', summary: 'Read one published tariff schedule for a licensed store.', owner_id: 'stranger-owner', reviewer_id: 'stranger-reviewer', beneficiary: 'A fixture group', rubric: 'The schedule is cited with its date and its page.' },
    question: 'Which published tariff schedule applies to one 40 kg pallet of orthodox tea, and from what date?',
    limits: 'A published schedule does not establish capacity or a booking.',
    rights: 'Paraphrase with attribution.',
    sources: [{ url: 'https://www.teacoffee.gov.np/tariff', location: 'Tariff table', date: '2026-05-01', version: 'v3' }],
  };
  const unrelated = assessMission(stranger, { existing: { proposals: [], reviews: records } });
  assert.deepEqual(unrelated.signals, [], 'a proposal naming none of the recorded parties carries none of their integrity signals');
});

test('the shipped source rules are mirrored: a source the platform would refuse is signalled, and it is the same source', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['https_only', 'http://www.teaboard.gov.in/directive', 'http: is not https'],
    ['public_hostname', 'https://127.0.0.1/directive', 'literal address'],
    ['public_hostname', 'https://localhost/directive', 'literal address'],
    ['no_port', 'https://www.teaboard.gov.in:8443/directive', 'names port'],
    ['no_credentials', 'https://user:secret@www.teaboard.gov.in/directive', 'carries credentials'],
    ['valid_url', 'not a url', 'not a parseable absolute URL'],
  ];
  for (const [rule, url, expected] of cases) {
    const report = assessMission(completeProposal(f, { sources: [{ url, location: 'Page 1', date: '2026-06-01', version: 'v1' }] }));
    const signal = report.signals.find((item) => item.code === 'source_unfetchable');
    assert.ok(signal, `${url} is signalled`);
    assert.equal(signal.measure.rule, rule);
    assert.match(signal.detail, new RegExp(expected));
    assert.ok(signal.detail.includes(SOURCE_RULES[rule]), `${rule} names the shipped rule`);
  }
  // The approved-host rule is the shipped submission rule, checked against the real refusal.
  const outside = assessMission(completeProposal(f, { sources: [{ url: 'https://elsewhere.example.net/page', location: 'Section 1', date: '2026-06-01', version: 'v1' }] }));
  const notApproved = outside.signals.find((signal) => signal.code === 'source_host_not_approved');
  assert.equal(notApproved.measure.rule, 'approved_host');
  const checkedMission = f.tx('createMission', f.actor('admin'), { title: 'Source host rule', area: 'Climate', summary: 'Check the shipped host rule.', beneficiary: 'A fixture group', reviewer_id: f.actor('reviewer').account.id, rubric: 'Exact sources only.' });
  const checkedTask = f.tx('createTask', f.actor('admin'), { mission_id: checkedMission.id, title: 'One source', instructions: 'Cite one approved source.', rights: 'Paraphrase.', allowed_domains: ['www.teaboard.gov.in'] });
  f.tx('missionStatus', f.actor('admin'), checkedMission.id, 'open');
  const claim = f.tx('claim', f.actor('alice'), { task_id: checkedTask.id }, 'host-check-1');
  assert.throws(() => f.tx('submit', f.actor('alice'), { claim_id: claim.id, artifact: 'A source outside the approved list.', sources: [{ url: 'https://elsewhere.example.net/page', location: 'Section 1' }], method: 'Read it.', limitations: 'Fixture.', rights: 'Fixture.' }, 'host-check-2'),
    (error) => error.status === 400 && /outside the task approved domains/.test(error.message));
  // An unapproved hostname is refused at task creation, exactly as the signal says.
  assert.throws(() => f.tx('createTask', f.actor('admin'), { mission_id: checkedMission.id, title: 'Bad host', instructions: 'x', rights: 'y', allowed_domains: ['not a hostname'] }), (error) => error.status === 400);
  // A host the evidence library does not already know is signalled only when the caller supplies it.
  const unknown = assessMission(completeProposal(f), { known_hosts: ['sdgs.un.org'] });
  assert.equal(unknown.signals.find((signal) => signal.code === 'source_host_unknown').measure.rule, 'registered_host');
  assert.equal(codes(assessMission(completeProposal(f))).includes('source_host_unknown'), false);
  // Every named source being a framework or catalog reference is reported as the collection gap it is.
  const frameworkOnly = assessMission(completeProposal(f, { sources: [{ url: 'https://sdgs.un.org/goals/goal2', location: 'Goal 2 page', date: '2026-10-11', version: 'v1' }], task: { ...completeProposal(f).task, allowed_domains: ['sdgs.un.org'] } }));
  assert.ok(codes(frameworkOnly).includes('framework_only_sources'));
  assert.equal(frameworkOnly.signals.find((signal) => signal.code === 'framework_only_sources').measure.framework_hosts.length, 2);
});

test('a signal is dismissed by a named independent human and stays advisory either way', async (t) => {
  const f = await fixture(t);
  const report = assessMission({ ...completeProposal(f), mission: { ...completeProposal(f).mission, reviewer_id: completeProposal(f).mission.owner_id } });
  const signal = report.signals.find((item) => item.code === 'reviewer_is_owner');
  assert.equal(signal.advisory, true);
  assert.equal('dismissal' in signal, false, 'a returned signal is not pre-dismissed');
  const dismissed = dismissSignal(signal, { reviewer: { id: f.actor('moderator').account.id, name: 'moderator' }, note: 'Checked: this is the declared practice mission, and the note records why the review is not independent.' });
  assert.equal(dismissed.advisory, true, 'a dismissed signal is still advisory, never a conclusion');
  assert.equal(dismissed.dismissal.declaration_only, true);
  assert.equal(dismissed.dismissal.changes_nothing, true);
  assert.equal(dismissed.dismissal.evidence_retained, false);
  assert.match(dismissed.advisory_note, /remains advisory/);
  assert.equal(signal.dismissal, undefined, 'the original signal is untouched');
  // A dismissal needs a named human and a note; and the parties the signal concerns cannot dismiss it.
  assert.throws(() => dismissSignal(signal, { reviewer: 'someone' }), (error) => error.status === 400);
  assert.throws(() => dismissSignal(signal, { note: 'Fine.' }), (error) => error.status === 400);
  assert.throws(() => dismissSignal(signal, { reviewer: { id: completeProposal(f).mission.owner_id }, note: 'Fine.' }), (error) => error.status === 403 && /independent human/.test(error.message));
  // A named human may be given as a plain string, and dismissing changes nothing about the signal's code.
  const plain = dismissSignal(signal, { reviewer: 'moderator', note: 'Checked against the mission record.' });
  assert.equal(plain.code, signal.code);
  assert.equal(plain.dismissal.reviewed_by, 'moderator');
});

test('the module is pure: a call changes no row, no status, no coin and no audit entry', async (t) => {
  const f = await fixture(t);
  const proposal = deepFreeze(completeProposal(f));
  const existing = deepFreeze({ proposals: corpusFrom(f.platform), reviews: [{ reviewer_id: f.actor('reviewer').account.id, contributor_id: f.actor('alice').account.id, decision: 'accepted' }] });
  const counts = () => ['missions', 'tasks', 'claims', 'submissions', 'reviews', 'adoptions', 'coin_rewards', 'research_leads', 'audit'].map((table) => f.platform.get(`SELECT COUNT(*) AS n FROM ${table}`).n).join('|');
  const before = counts();
  const auditBefore = f.platform.verifyAudit();
  const first = assessMission(proposal, { existing, known_hosts: ['www.teaboard.gov.in'] });
  const second = assessMission(proposal, { existing, known_hosts: ['www.teaboard.gov.in'] });
  // A defective proposal and a proposal naming a concentrated reviewer, so every path runs.
  const defective = assessMission({ id: 'x', title: 'Thin proposal', area: 'Climate', summary: 'A topic.', sources: ['https://127.0.0.1/x'] });
  const colluding = assessMission(completeProposal(f), { existing: { proposals: [], reviews: Array.from({ length: 12 }, () => ({ reviewer_id: f.actor('reviewer').account.id, contributor_id: f.actor('alice').account.id, decision: 'accepted' })) } });
  assert.equal(counts(), before, 'no table gained or lost a row');
  assert.equal(f.platform.verifyAudit(), auditBefore);
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'the same input produces the same output');
  assert.ok(Object.isFrozen(proposal) && Object.isFrozen(existing), 'the inputs are frozen, so any write would have thrown');
  assert.deepEqual(first.missing, []);
  assert.ok(defective.missing.length > 0 && defective.signals.length > 0);
  assert.ok(colluding.signals.some((signal) => signal.code === 'reviewer_concentration'));
  // A signal never grants or removes authority: it has no status, decision or reward field, and the
  // report says in words that the coin decision is not here.
  for (const signal of first.signals) {
    assert.equal(signal.advisory, true);
    assert.ok(SIGNAL_CODES[signal.code], `${signal.code} is a documented code`);
    assert.ok(SEVERITIES[signal.severity], `${signal.severity} is a documented severity`);
    for (const forbidden of ['status', 'decision', 'approved', 'rejected', 'awarded', 'held', 'amount', 'authority']) assert.equal(forbidden in signal, false, `${signal.code} carries no ${forbidden}`);
  }
  for (const entry of first.missing) assert.ok(REQUIRED_FIELDS.some((item) => item.field === entry.field));
  for (const key of ['status', 'decision', 'approved', 'rejected', 'awarded']) assert.equal(key in first, false);
  assert.deepEqual(first.authority, { ...AUTHORITY });
  assert.equal(first.authority.changes_status, false);
  assert.equal(first.authority.awards_or_withholds_coins, false);
  assert.equal(first.authority.writes_storage, false);
  assert.match(first.authority.coin_decision, /src\/coins\.js/);
  assert.deepEqual(first.severed_units, { coins: false, compute_credits: false, money: false, carbon_credits: false, note: first.severed_units.note });
  assert.match(first.authority.units, /compute credits, real money or verified carbon credits/);
});

test('the module exports no writer, and the mirrored area list still matches the shipped createMission', async (t) => {
  const f = await fixture(t);
  const module = await import('../src/mission-quality.js');
  for (const name of Object.keys(module)) assert.equal(/award|approve|reject|create|delete|update|save|store|publish|insert|write|mint/i.test(name), false, `${name} is not a writer`);
  // Every mirrored area is still accepted by the real createMission, and an unlisted one is still refused.
  for (const area of MISSION_AREAS) {
    const mission = f.tx('createMission', f.actor('admin'), { title: `Area ${area}`, area, summary: 'Check the mirrored area list.', beneficiary: 'A fixture group', reviewer_id: f.actor('reviewer').account.id, rubric: 'Areas are checked against the shipped list.' });
    assert.equal(f.platform.get('SELECT area FROM missions WHERE id=?', mission.id).area, area);
  }
  assert.throws(() => f.tx('createMission', f.actor('admin'), { title: 'Wrong area', area: 'Ocean', summary: 'x', beneficiary: 'y', reviewer_id: f.actor('reviewer').account.id, rubric: 'z' }), (error) => error.status === 400 && /supported mission area/.test(error.message));
});

test('an existing proposal being revised is not a duplicate of itself, and the corpus is read as given', async (t) => {
  const f = await fixture(t);
  const corpus = corpusFrom(f.platform);
  const source = corpus.find((entry) => entry.id === 'NP-2-baseline');
  const sameId = duplicateMatches({ ...source, summary: 'A revised scope for the same proposal.' }, corpus);
  assert.equal(sameId.matches.some((match) => match.id === 'NP-2-baseline'), false, 'the same id is not reported as its own duplicate');
  assert.equal(sameId.considered, corpus.length - 1);
  // A corpus entry with no id cannot be matched to anything and is not counted.
  const withoutId = duplicateMatches(source, [{ title: 'No identifier' }, ...corpus]);
  assert.equal(withoutId.considered, corpus.length - 1);
  // The measure is symmetric and bounded, and it is zero when nothing is shared.
  const weights = corpusWeights(corpus);
  assert.equal(similarity(tokenSetOf('alpha beta gamma'), tokenSetOf('delta epsilon zeta'), weights), 0);
  assert.equal(similarity(tokenSetOf('same words here'), tokenSetOf('same words here'), weights), 1);
  assert.equal(similarity(tokenSetOf('same words here'), tokenSetOf('same words there'), weights), similarity(tokenSetOf('same words there'), tokenSetOf('same words here'), weights));
});
