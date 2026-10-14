// The advisory mission-quality reading over the shipped HTTP route. It assembles a proposal from the
// records the platform already holds, returns the pure module's assessment of it, decides nothing,
// writes nothing and blocks no create, activate, claim, submit, review or adoption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { fixture, realMission, evidence } from './helpers.js';
import { verifyCoinLedger } from '../src/coins.js';

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const get = (base, token, path) => fetch(base + '/api/v1' + path, { headers: auth(token) });
const post = (base, token, path, body) => fetch(base + '/api/v1' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': globalThis.crypto.randomUUID(), ...auth(token) }, body: JSON.stringify(body) });
async function server(t, f) {
  const { server: http } = createApp({ platform: f.platform });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }));
  return `http://127.0.0.1:${http.address().port}`;
}
// Every table the module's own suite watches, plus the audit chain, so "writes nothing" is checked
// against the whole store rather than one counter.
const TABLES = ['missions', 'tasks', 'claims', 'submissions', 'reviews', 'adoptions', 'coin_rewards', 'research_leads', 'audit'];
const counts = (f) => TABLES.map((table) => `${table}:${f.platform.get(`SELECT COUNT(*) AS n FROM ${table}`).n}`).join('|');
const quality = async (base, token, query) => { const response = await get(base, token, `/quality?${query}`); return { status: response.status, body: await response.json() }; };
const codes = (report) => report.signals.map((signal) => signal.code);
const fields = (report) => report.missing.map((entry) => entry.field);

test('a reviewer reads the module’s assessment of a task with a known defect, with its measures and thresholds', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const { task } = realMission(f);
  // The shipped fixture task states an imperative and records no source register: the two defects the
  // route must report, each under its own field name.
  const { status, body: report } = await quality(base, f.credentials.reviewer.token, `task=${encodeURIComponent(task.id)}`);
  assert.equal(status, 200);
  assert.equal(report.kind, 'mission_quality_assessment');
  assert.equal(report.version, 1);
  assert.equal(report.advisory, true);
  assert.equal(report.scope, 'task');
  assert.equal(report.completeness.complete, false);
  for (const field of ['question', 'limits', 'sources']) assert.ok(fields(report).includes(field), `${field} must be reported as missing`);
  const question = report.missing.find((entry) => entry.field === 'question');
  assert.equal(question.requirement, 'brief');
  assert.match(question.reason, /topic or an imperative/);
  assert.match(report.completeness.note, /not an approval, a priority, a readiness decision/);
  // The specific signal codes are returned with the measure each was computed from.
  const topic = report.signals.find((signal) => signal.code === 'question_is_topic');
  assert.ok(topic, 'a topic instead of a question is signalled');
  assert.equal(topic.severity, 'attention');
  assert.equal(topic.advisory, true);
  assert.equal(topic.measure.interrogative, false);
  assert.equal(topic.measure.minimum_words, report.thresholds.question_minimum_words);
  assert.match(topic.detail, /cannot be judged against a topic/);
  for (const signal of report.signals) {
    assert.equal(signal.advisory, true, `${signal.code} is advisory`);
    assert.ok(signal.measure && typeof signal.measure === 'object', `${signal.code} carries its measure`);
    assert.ok(signal.detail.length > 0);
    // A signal never carries a verdict, a status or a reward.
    for (const forbidden of ['status', 'decision', 'approved', 'rejected', 'awarded', 'amount', 'authority']) assert.equal(forbidden in signal, false, `${signal.code} carries no ${forbidden}`);
  }
  // The score, the plain score and the threshold are returned rather than summarised away.
  assert.equal(report.duplicates.threshold, 0.6);
  assert.equal(report.duplicates.threshold, report.thresholds.duplicate_similarity);
  assert.equal(report.duplicates.considered, f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n);
  assert.equal(report.duplicates.above_threshold, report.duplicates.matches.length);
  assert.match(report.duplicates.basis, /Dice coefficient/);
  // The authority statement is the module's own, in words.
  assert.equal(report.authority.level, 'advisory');
  assert.equal(report.authority.changes_status, false);
  assert.equal(report.authority.writes_storage, false);
  assert.equal(report.authority.awards_or_withholds_coins, false);
  assert.equal(report.authority.approves_or_rejects, false);
  assert.match(report.authority.coin_decision, /src\/coins\.js/);
  assert.equal(report.severed_units.coins, false);
  // The response is the assessment and nothing else: no wrapper and no added shape.
  assert.deepEqual(Object.keys(report).sort(), ['advisory', 'authority', 'boundaries', 'completeness', 'duplicates', 'fictional', 'kind', 'ladder', 'missing', 'review', 'scope', 'severed_units', 'signals', 'subject', 'thresholds', 'version']);
  // The collusion measures are deliberately not read into a reviewer-visible response, and the module
  // says so rather than implying a clean bill of health.
  assert.equal(report.review.checked, false);
  assert.equal(report.review.records_supplied, 0);
  assert.match(report.review.note, /no collusion measure could be computed/);
});

test('a proposal that came from a research lead is read from that lead’s own register, and is never its own duplicate', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const lead = f.platform.get("SELECT * FROM research_leads WHERE id='AF-1-baseline'");
  const activated = f.tx('researchActivate', f.actor('admin'), { lead_id: lead.id, beneficiary: 'A fixture reading group', owner_id: f.actor('admin').account.id, reviewer_id: f.actor('reviewer').account.id });
  const total = f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n;
  const { status, body: report } = await quality(base, f.credentials.reviewer.token, `task=${encodeURIComponent(activated.task_id)}`);
  assert.equal(status, 200);
  assert.equal(report.subject.title, lead.title);
  // The source register read here is the one the shipped research path recorded on the lead, and it
  // is a register of bare URLs: the register is present, and its date and version are not.
  assert.ok(report.completeness.satisfied.includes('sources'));
  assert.ok(fields(report).includes('source_date'));
  assert.ok(fields(report).includes('source_version'));
  assert.ok(fields(report).includes('limits'));
  assert.ok(codes(report).includes('framework_only_sources'), 'the mirrored framework-host rule is applied to those sources');
  assert.deepEqual(report.signals.find((signal) => signal.code === 'framework_only_sources').measure.framework_hosts, ['sdgs.un.org', 'unstats.un.org']);
  // The lead that produced this work is excluded from the corpus it is compared against, so a proposal
  // is never reported as textually close to the entry it came from.
  assert.equal(report.duplicates.considered, total - 1);
  assert.equal(report.duplicates.matches.some((match) => match.id === lead.id), false);
  // The same reading is available for the mission, and it reports the mission scope.
  const mission = await quality(base, f.credentials.reviewer.token, `mission=${encodeURIComponent(activated.mission_id)}`);
  assert.equal(mission.status, 200);
  assert.equal(mission.body.scope, 'mission');
  assert.equal(mission.body.subject.title, lead.title);
  assert.equal(mission.body.kind, 'mission_quality_assessment');
});

test('a near-duplicate is reported with the score that was computed, and a distinct proposal is not', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const lead = f.platform.get("SELECT * FROM research_leads WHERE id='NP-2-baseline'");
  // One mission that carries a stored research proposal's own text, and one that carries none of it.
  const copy = f.tx('createMission', f.actor('admin'), { title: lead.title, area: 'Agriculture', summary: 'A scoped reading of the stored country baseline proposal.', beneficiary: 'A fixture reading group', owner_id: f.actor('admin').account.id, reviewer_id: f.actor('reviewer').account.id, rubric: lead.rubric });
  const copyTask = f.tx('createTask', f.actor('admin'), { mission_id: copy.id, title: 'Compare one stored proposal', instructions: lead.instructions.slice(0, 2000), rights: 'Explicit permission required.', allowed_domains: ['sdgs.un.org'] });
  const distinct = f.tx('createMission', f.actor('admin'), { title: 'Bicycle lane surface audit', area: 'Accessibility', summary: 'Compare the recorded surfaces of three city bicycle lanes.', beneficiary: 'A fixture audit group', owner_id: f.actor('admin').account.id, reviewer_id: f.actor('reviewer').account.id, rubric: 'Every measurement names its instrument and its date.' });
  const distinctTask = f.tx('createTask', f.actor('admin'), { mission_id: distinct.id, title: 'Record one lane surface', instructions: 'Which surface was recorded for the East Quay lane in the March survey? Name the instrument and the exact run.', rights: 'Explicit permission required.', allowed_domains: ['sdgs.un.org'] });
  const close = await quality(base, f.credentials.reviewer.token, `task=${encodeURIComponent(copyTask.id)}`);
  assert.equal(close.status, 200);
  const top = close.body.duplicates.matches[0];
  assert.equal(top.id, lead.id);
  assert.ok(top.score >= close.body.duplicates.threshold, `${top.score} must be at or above ${close.body.duplicates.threshold}`);
  assert.equal(typeof top.plain_score, 'number');
  assert.equal(top.threshold, close.body.duplicates.threshold);
  assert.ok(top.distinguishing.in_existing.length > 0 || top.distinguishing.in_proposal.length > 0);
  const signal = close.body.signals.find((item) => item.code === 'near_duplicate');
  assert.ok(signal, 'the same finding appears as one advisory signal');
  assert.equal(signal.measure.closest.id, top.id);
  assert.equal(signal.measure.closest.score, top.score);
  assert.equal(signal.measure.threshold, close.body.duplicates.threshold);
  // A genuinely distinct proposal is reported as distinct: no match, and the corpus was still read.
  const other = await quality(base, f.credentials.reviewer.token, `task=${encodeURIComponent(distinctTask.id)}`);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.duplicates.matches, []);
  assert.equal(codes(other.body).includes('near_duplicate'), false);
  assert.ok(other.body.duplicates.considered > 1000, 'the whole stored corpus was compared');
});

test('an anonymous caller, a member, a moderator and an outsider are all refused, and the route is a read', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const { mission, task } = realMission(f);
  const query = `task=${encodeURIComponent(task.id)}`;
  assert.equal((await fetch(`${base}/api/v1/quality?${query}`)).status, 401, 'no session at all is refused');
  // The audience is the review workbench's: a reviewer or an administrator, and nobody else.
  for (const who of ['alice', 'bob', 'moderator']) assert.equal((await get(base, f.credentials[who].token, `/quality?${query}`)).status, 403, `${who} must be refused`);
  assert.equal((await quality(base, f.credentials.admin.token, query)).status, 200, 'an administrator may read it');
  assert.equal((await quality(base, f.credentials.reviewer.token, `task=no-such-task`)).status, 404);
  assert.equal((await quality(base, f.credentials.reviewer.token, `mission=no-such-mission`)).status, 404);
  assert.equal((await quality(base, f.credentials.reviewer.token, '')).status, 400, 'a reading must name what it reads');
  assert.equal((await quality(base, f.credentials.reviewer.token, `mission=${encodeURIComponent(mission.id)}`)).status, 200);
  const written = await post(base, f.credentials.reviewer.token, '/quality', { task: task.id });
  assert.equal(written.status, 405);
  assert.match(written.headers.get('allow') || '', /GET/);
});

test('reading the assessment writes nothing: no table, no status and no audit entry changes', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const { mission, task } = realMission(f);
  const before = {
    counts: counts(f),
    audit: f.platform.verifyAudit(),
    mission: f.platform.get('SELECT * FROM missions WHERE id=?', mission.id),
    task: f.platform.get('SELECT * FROM tasks WHERE id=?', task.id),
    settings: f.platform.all('SELECT * FROM settings ORDER BY key'),
  };
  for (const who of ['reviewer', 'admin']) {
    for (const query of [`task=${encodeURIComponent(task.id)}`, `mission=${encodeURIComponent(mission.id)}`]) {
      assert.equal((await quality(base, f.credentials[who].token, query)).status, 200);
    }
  }
  assert.equal(counts(f), before.counts, 'no table gained or lost a row');
  assert.equal(f.platform.verifyAudit(), true);
  assert.equal(f.platform.verifyAudit(), before.audit);
  assert.deepEqual(f.platform.get('SELECT * FROM missions WHERE id=?', mission.id), before.mission);
  assert.deepEqual(f.platform.get('SELECT * FROM tasks WHERE id=?', task.id), before.task);
  assert.deepEqual(f.platform.all('SELECT * FROM settings ORDER BY key'), before.settings);
  // Two readings of the same proposal return the same assessment, because it is a pure read.
  const first = await quality(base, f.credentials.reviewer.token, `task=${encodeURIComponent(task.id)}`);
  const second = await quality(base, f.credentials.reviewer.token, `task=${encodeURIComponent(task.id)}`);
  assert.equal(JSON.stringify(first.body), JSON.stringify(second.body));
});

test('a flagged proposal is still created, activated, claimed, submitted, reviewed and adopted normally', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const agent = f.agent('alice');
  const { mission, task } = realMission(f);
  const path = `task=${encodeURIComponent(task.id)}`;
  const flagged = await quality(base, f.credentials.reviewer.token, path);
  assert.equal(flagged.status, 200);
  assert.ok(flagged.body.signals.length > 0, 'the fixture proposal carries at least one advisory signal');
  assert.ok(flagged.body.missing.length > 0, 'and at least one unusable required field');
  // Nothing about those flags is a gate: the whole ordinary path still runs, over HTTP.
  const claim = await post(base, f.credentials.alice.token, '/claims', { task_id: task.id, agent_id: agent.id });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  const submission = await post(base, f.credentials.alice.token, '/submissions', evidence(claimed, { artifact: 'A contribution whose mission carries advisory signals.' }));
  assert.equal(submission.status, 201);
  const contributed = await submission.json();
  const review = await post(base, f.credentials.reviewer.token, '/reviews', { submission_id: contributed.id, decision: 'accepted', reason: 'Independent fixture acceptance of a flagged proposal.' });
  assert.equal(review.status, 201, 'a flagged mission is reviewed normally');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE submission_id=?', contributed.id).n, 1);
  assert.equal(f.platform.get('SELECT amount FROM coin_rewards WHERE submission_id=?', contributed.id).amount, 10);
  assert.equal(verifyCoinLedger(f.platform.db), true);
  const adoption = await post(base, f.credentials.admin.token, '/adoptions', { submission_id: contributed.id, note: 'Used in the fictional register.', evidence: 'Register entry REG-Q-1.' });
  assert.equal(adoption.status, 201);
  // The flags themselves never changed: the assessment of the proposal is identical before and after
  // a full create, activate, claim, submit, review and adoption sequence.
  const after = await quality(base, f.credentials.reviewer.token, path);
  assert.equal(JSON.stringify(after.body), JSON.stringify(flagged.body));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 1);
});
