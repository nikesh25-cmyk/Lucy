import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fixture } from './helpers.js';
import { assessMission, duplicateMatches, THRESHOLDS } from '../src/mission-quality.js';

// The Wave C mission exemplars are documents that a human could act on, so this suite checks them
// rather than trusting a one-off report. Every *.exemplar.json under docs/research/mission-exemplars
// is read here and put through the same module the shipped reviewer path uses. Two facts are kept
// apart throughout: a field that is *present and usable* is not an approval, and an exemplar that
// passes this module has not been activated, claimed, submitted, reviewed or adopted by anybody.
const DIR = new URL('../docs/research/mission-exemplars/', import.meta.url);
const PROSE_CAP = 2000; // the shipped `text()` limit for summary, beneficiary, rubric, rights and instructions
const TITLE_CAP = 100;
const exemplars = readdirSync(DIR).filter((name) => name.endsWith('.exemplar.json')).sort()
  .map((file) => ({ file, exemplar: JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) }));
const companionOf = (file) => readFileSync(new URL(file.replace(/\.exemplar\.json$/, '.md'), DIR), 'utf8');
const corpusFrom = (platform) => platform.all('SELECT id,title,instructions,rubric FROM research_leads').map((lead) => ({ id: lead.id, title: lead.title, instructions: lead.instructions, rubric: lead.rubric }));

test('the exemplar documents carry the checked field set, and the disclosure every one of them owes', () => {
  // The brief is explicit that volume is not the goal, so the count is asserted rather than left open.
  assert.ok(exemplars.length >= 2 && exemplars.length <= 3, `${exemplars.length} exemplars`);
  assert.equal(new Set(exemplars.map((entry) => entry.exemplar.id)).size, exemplars.length);
  for (const { file, exemplar } of exemplars) {
    const where = `${exemplar.id} (${file})`;
    const { mission, task } = exemplar;
    // The shipped shapes: createMission stores the rubric, createTask stores the rights and the
    // approved hostnames, and both refuse a blank title.
    assert.ok(mission.title && task.title, `${where}: both titles`);
    assert.ok(mission.area, `${where}: area`);
    assert.ok(mission.summary && mission.rubric, `${where}: summary and rubric`);
    assert.ok(exemplar.question.trim().endsWith('?'), `${where}: the question is interrogative`);
    assert.ok(exemplar.limits && exemplar.rights, `${where}: limits and rights`);

    // The source register: every source names a location, a date and a version, and every source
    // host is one the task approves, which is the rule the shipped task creation and submission
    // path applies.
    assert.ok(exemplar.sources.length >= 1, `${where}: a source register`);
    for (const [index, source] of exemplar.sources.entries()) {
      const label = `${where} source ${index + 1}`;
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:', `${label}: https only`);
      assert.ok(source.date, `${label}: a date`);
      assert.ok(source.version, `${label}: a version`);
      assert.ok(task.allowed_domains.includes(url.hostname), `${label}: ${url.hostname} is an approved host`);
    }

    // The reviewer must be a different person from the owner and from any contributor. Both are
    // declared role slots here — no human is named — so the slot names must differ, and the
    // document must say plainly that nobody has been named rather than implying a person.
    const owner = mission.owner, reviewer = mission.reviewer;
    assert.ok(owner?.id && reviewer?.id, `${where}: an owner and a reviewer are designated`);
    assert.notEqual(reviewer.id, owner.id, `${where}: reviewer differs from owner`);
    assert.match(reviewer.name, /unassigned/, `${where}: the reviewer slot says no human is named`);
    assert.equal(exemplar.reviewer_independence.reviewer_distinct_from_owner, true);
    assert.equal(exemplar.assignment.named_owner, false, `${where}: no named owner`);
    assert.equal(exemplar.assignment.named_reviewer, false, `${where}: no named reviewer`);
    assert.equal(exemplar.assignment.named_contributor, false, `${where}: no named contributor`);
    assert.match(exemplar.assignment.note, /not people/, `${where}: the slots are declared, not implied`);

    // The blocked dependency: no consenting beneficiary has been selected, so external
    // implementation and a measured outcome are blocked on it, and an adoption declaration is not
    // implementation. The statement is required in the document itself, not only in the handoff.
    assert.equal(exemplar.blocked_dependency.blocked_on, 'a consenting beneficiary', `${where}: blocked on`);
    assert.deepEqual(exemplar.blocked_dependency.blocked_stages, ['externally evidenced implementation', 'measured outcome']);
    assert.equal(exemplar.blocked_dependency.adoption_declaration_is_not_implementation, true);
    assert.equal(exemplar.blocked_dependency.outreach, 'none');
    assert.match(exemplar.limits, /consenting beneficiary/, `${where}: the limits state the blocked dependency`);
    assert.match(exemplar.limits, /declaration, not implementation/, `${where}: the limits state that adoption is not implementation`);

    // The companion is a plain-language account, not a summary of the JSON, and it owes the same
    // statement. It carries the question verbatim so the two cannot drift apart.
    const companion = companionOf(file);
    assert.match(companion, /no consenting beneficiary has been selected/i, `${where}: companion states the blocked dependency`);
    assert.match(companion, /blocked on that dependency/, `${where}: companion names the blocked stages`);
    assert.match(companion, /not implementation/, `${where}: companion separates adoption from implementation`);
    assert.ok(companion.includes(exemplar.question), `${where}: companion carries the question verbatim`);

    // The exemplar has to be creatable by the shipped path as written, so the strings must fit the
    // columns createMission and createTask actually store. The module's question is carried in the
    // task instructions and its limits with the mission rubric.
    assert.ok(mission.title.length <= TITLE_CAP, `${where}: title ${mission.title.length} <= ${TITLE_CAP}`);
    for (const [field, value] of [['summary', mission.summary], ['beneficiary', mission.beneficiary], ['rubric', mission.rubric], ['task rights', task.rights], ['task instructions', task.instructions]]) {
      assert.ok(value.length <= PROSE_CAP, `${where}: ${field} ${value.length} <= ${PROSE_CAP}`);
    }
    assert.ok(mission.rubric.length + exemplar.limits.length <= PROSE_CAP, `${where}: rubric plus limits ${mission.rubric.length + exemplar.limits.length} <= ${PROSE_CAP}`);

    // Every field the module checks is claimed by the shipped shape, and the exemplar says where.
    assert.match(exemplar.evidence_criteria, /rubric/, `${where}: the criteria field is named`);
    assert.deepEqual(exemplar.not_established.length >= 3, true, `${where}: what it does not establish is listed`);
  }
});

test('each exemplar passes the quality module against the seeded corpus, and the exemplars stay distinct', async (t) => {
  const f = await fixture(t);
  const corpus = corpusFrom(f.platform);
  assert.equal(corpus.length, 1015, 'the seeded proposal corpus');
  const reports = new Map();
  for (const { file, exemplar } of exemplars) {
    const report = assessMission(exemplar, { existing: corpus });
    reports.set(exemplar.id, report);
    const where = `${exemplar.id} (${file})`;

    // 1. Every required field is present and usable, and nothing is reported missing. A failing
    // assertion here prints the field, the reason and the rule it comes from.
    assert.deepEqual(report.missing, [], `${where}: no missing field`);
    assert.equal(report.completeness.complete, true, where);
    assert.equal(report.completeness.missing.length, 0, where);

    // 2. No near-duplicate against the seeded corpus. The threshold is the module's own 0.6 and it
    // is not moved for the exemplars: the exemplar is fixed, never the threshold.
    assert.equal(report.duplicates.threshold, THRESHOLDS.duplicate_similarity, where);
    assert.equal(report.duplicates.threshold, 0.6, where);
    assert.equal(report.duplicates.considered, corpus.length, where);
    assert.deepEqual(report.duplicates.matches, [], `${where}: no match at or above the threshold`);
    assert.equal(report.duplicates.above_threshold, 0, where);
    assert.deepEqual(report.signals.map((signal) => signal.code), [], `${where}: no signal at all`);

    // The margin is reported rather than implied: the closest corpus entry and its score.
    const closest = duplicateMatches(exemplar, corpus, { threshold: 0, limit: 1 }).matches[0];
    assert.ok(closest, `${where}: the corpus was compared`);
    assert.ok(closest.score < THRESHOLDS.duplicate_similarity, `${where}: closest is ${closest.id} at ${closest.score}`);
    assert.ok(!report.signals.some((signal) => signal.code === 'reviewer_is_owner' || signal.code === 'reviewer_is_contributor'), where);
    assert.equal(report.fictional, false, `${where}: a real proposal, not a declared demonstration`);

    // 3. The blocked dependency is the module's own, and the module's output carries the
    // disclosure the document makes: the owner and reviewer slots say no human is named.
    assert.deepEqual(report.ladder.blocked.map((entry) => [entry.stage, entry.blocked_on]), [
      ['externally evidenced implementation', 'a consenting beneficiary'],
      ['measured outcome', 'a consenting beneficiary'],
    ], where);
    assert.match(report.ladder.reached, /proposed/, where);
    assert.match(report.subject.owner.name, /unassigned/, `${where}: the module reports the unassigned owner slot`);
    assert.match(report.subject.reviewer.name, /unassigned/, `${where}: the module reports the unassigned reviewer slot`);
    assert.match(report.boundaries.corpus, /proposals, not studies/, where);
  }

  // 4. The exemplars are distinct from one another, not only from the corpus: no pair reaches the
  // threshold on its own text, and none is reported as a near-duplicate when the others are in the
  // comparison set beside the whole corpus.
  for (const { exemplar } of exemplars) {
    const others = exemplars.filter((entry) => entry.exemplar.id !== exemplar.id).map((entry) => entry.exemplar);
    for (const other of others) {
      assert.equal(duplicateMatches(exemplar, [other]).above_threshold, 0, `${exemplar.id} is not a near-duplicate of ${other.id}`);
    }
    const beside = assessMission(exemplar, { existing: [...corpus, ...others] });
    assert.deepEqual(beside.duplicates.matches, [], `${exemplar.id} stays clear when the other exemplars are in the corpus`);
    assert.deepEqual(beside.missing, [], `${exemplar.id} stays complete beside the other exemplars`);
  }
});
