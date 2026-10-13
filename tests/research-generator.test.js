import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { COUNTRIES, planCountryResearch, RESEARCH_CONCERNS, RESEARCH_THEMES } from '../src/civic-engine.js';

const LDC = COUNTRIES.entries.filter((country) => country.ldc);
const CONCERN_IDS = RESEARCH_CONCERNS.map((concern) => concern.id);
const country = (iso2) => COUNTRIES.entries.find((item) => item.iso2 === iso2);

test('every seeded country proposal belongs to one concern and states prerequisites, dependencies, outputs and acceptance', async (t) => {
  const f = await fixture(t);
  const leads = f.platform.all(`SELECT * FROM research_leads WHERE country_code IN (${LDC.map(() => '?').join(',')})`, ...LDC.map((item) => item.iso2));
  assert.ok(leads.length > 0);
  for (const lead of leads) {
    assert.ok([...CONCERN_IDS, 'agriculture'].includes(lead.stage), `${lead.id} carries a known concern`);
    assert.ok(JSON.parse(lead.source_urls).every((url) => /^https:\/\//.test(url)), `${lead.id} cites https sources only`);
    if (lead.stage === 'agriculture') continue;
    for (const label of ['Outputs:', 'Acceptance:', 'Source prerequisites:', 'Dependencies:', 'Primary source categories:', 'Rights:']) assert.ok(lead.instructions.includes(label), `${lead.id} carries ${label}`);
    assert.doesNotMatch(lead.instructions, /\{[a-zA-Z]+\}/, `${lead.id} has no unresolved placeholder`);
  }
  // The retired interchangeable stage templates are gone for every country.
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM research_leads WHERE stage IN ('evidence','partners','proposal')").n, 0);
});

test('the seeded corpus has no two proposals with the same substantive question and emits applied concerns only for scoped themes', async (t) => {
  const f = await fixture(t);
  for (const item of LDC) {
    const plan = planCountryResearch(item);
    assert.equal(new Set(plan.leads.map((lead) => lead.substantive_key)).size, plan.leads.length, `${item.iso2} keys are unique`);
    assert.equal(plan.consolidations.length, 0, `${item.iso2} needs no consolidation with the current theme map`);
  }
  // A country with retained agriculture evidence gets the three applied concerns; one without gets none.
  const nepal = planCountryResearch(country('NP'));
  assert.equal(nepal.leads.filter((lead) => lead.goal === 2).length, 4);
  assert.equal(nepal.leads.filter((lead) => lead.goal === 17).length, 4);
  const senegal = planCountryResearch(country('SN'));
  assert.equal(senegal.leads.filter((lead) => lead.goal === 2).length, 1);
  assert.equal(senegal.leads.filter((lead) => lead.goal === 17).length, 4);
  // 43 LDC seeds with agriculture evidence (23 rows) + Senegal (20 rows) + six Nepal tea leads.
  assert.equal(f.platform.research(null).catalog_total, 43 * 23 + 20 + 6);
});

test('an applied concern shared by two goals is consolidated once and the consolidation is recorded', async (t) => {
  const f = await fixture(t);
  const target = COUNTRIES.entries.find((item) => !item.ldc);
  const theme = { id: 'overlap-check', title: 'Overlap check', goals: [2, 3], subject: 'subject for {country}', subjectBasis: 'basis for {country}', evidenceGate: 'none', openScopeChoices: ['choose one'], limit: 'limit' };
  const plan = planCountryResearch(target, [theme]);
  assert.equal(plan.leads.length, 17 + 3);
  assert.deepEqual(plan.consolidations.map((item) => item.consolidated_id).sort(), [`${target.iso2}-3-destination`, `${target.iso2}-3-institutions`, `${target.iso2}-3-interventions`]);
  assert.deepEqual([...new Set(plan.consolidations.map((item) => item.canonical_id))].sort(), [`${target.iso2}-2-destination`, `${target.iso2}-2-institutions`, `${target.iso2}-2-interventions`]);
  f.platform.seedCountryResearch(target, [theme]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_lead_consolidations WHERE country_code=?', target.iso2).n, 3);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_leads WHERE id LIKE ?', `${target.iso2}-3-%`).n, 1);
  assert.equal(f.platform.get('SELECT canonical_id FROM research_lead_consolidations WHERE consolidated_id=?', `${target.iso2}-3-destination`).canonical_id, `${target.iso2}-2-destination`);
  assert.equal(f.platform.research(null, { country: target.iso2 }).country_plan.dedupe.consolidations, 3);
});

test('revising a proposed proposal archives the replaced version and an activated proposal is never rewritten', async (t) => {
  const f = await fixture(t);
  const baseline = f.platform.get("SELECT * FROM research_leads WHERE id='AF-2-baseline'");
  assert.equal(baseline.status, 'proposed');
  assert.equal(baseline.task_id, null);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_lead_versions WHERE lead_id=?', baseline.id).n, 0);
  f.platform.run("UPDATE research_leads SET instructions='A manually edited older scope' WHERE id=?", baseline.id);
  f.platform.initCivic();
  const live = f.platform.get('SELECT * FROM research_leads WHERE id=?', baseline.id);
  assert.notEqual(live.instructions, 'A manually edited older scope');
  const history = f.platform.researchLeadVersions(baseline.id);
  assert.equal(history.current_revision, 2);
  assert.equal(history.versions.length, 1);
  assert.equal(history.versions[0].revision, 1);
  assert.equal(history.versions[0].revision_reason, 'superseded');
  assert.equal(history.versions[0].instructions, 'A manually edited older scope');
  assert.equal(history.current.instructions, live.instructions);
  // Idempotent: the same generator content changes nothing further.
  f.platform.initCivic();
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_lead_versions WHERE lead_id=?', baseline.id).n, 1);
  // An activated proposal is ineligible: its content and history are preserved and its task is untouched.
  const other = f.platform.get("SELECT * FROM research_leads WHERE id='AF-3-baseline'");
  const activated = f.tx('researchActivate', f.actor('admin'), { lead_id: other.id, beneficiary: 'Fictional version fixture; no consent presumed', reviewer_id: f.actor('reviewer').account.id });
  const task = f.platform.get('SELECT * FROM tasks WHERE id=?', activated.task_id);
  f.platform.run("UPDATE research_leads SET instructions='Approved scope that must not be rewritten' WHERE id=?", other.id);
  f.platform.initCivic();
  assert.equal(f.platform.get('SELECT instructions FROM research_leads WHERE id=?', other.id).instructions, 'Approved scope that must not be rewritten');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_lead_versions WHERE lead_id=?', other.id).n, 0);
  assert.deepEqual(f.platform.get('SELECT * FROM tasks WHERE id=?', activated.task_id), task);
  assert.equal(f.platform.verifyAudit(), true);
});

test('the country baseline keeps its registered sources and its goal guidance', async (t) => {
  const f = await fixture(t);
  for (const [id, count, pattern] of [['NP-2-baseline', 5, /modeled ILO employment qualifier/], ['NP-7-baseline', 3, /electricity access/], ['NP-17-baseline', 3, /original-provider/]]) {
    const lead = f.platform.get('SELECT * FROM research_leads WHERE id=?', id);
    assert.equal(JSON.parse(lead.source_urls).length, count, id);
    assert.match(lead.instructions, pattern, id);
  }
});

test('seeding selects no beneficiary, activates nothing and creates no claim, submission, adoption or reward', async (t) => {
  const f = await fixture(t);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM research_leads WHERE status!='proposed'").n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  const assembly = f.platform.assembly();
  assert.equal(assembly.concerns.length, 4);
  assert.equal(assembly.research_themes.length, RESEARCH_THEMES.length);
  assert.match(assembly.research_dedupe_rule, /substantive key/);
});

test('an installation seeded by the older generator has its retired interchangeable rows recorded as consolidated, not rewritten', async (t) => {
  const f = await fixture(t);
  const created = '2026-01-01T00:00:00.000Z';
  f.platform.run('INSERT INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'NP-2-evidence', 'NP', 2, 'evidence', 'Nepal: Compare practical interventions · SDG 2', 'An interchangeable template that names no commodity or destination.', 'A generic rubric.', '["https://sdgs.un.org/goals/goal2"]', created);
  f.platform.initCivic();
  const consolidation = f.platform.get('SELECT * FROM research_lead_consolidations WHERE consolidated_id=?', 'NP-2-evidence');
  assert.equal(consolidation.canonical_id, 'NP-2-interventions');
  assert.match(consolidation.reason, /superseded by the interventions concern/);
  // The retired row is preserved exactly: nothing about it is rewritten or deleted.
  const legacy = f.platform.get('SELECT * FROM research_leads WHERE id=?', 'NP-2-evidence');
  assert.equal(legacy.instructions, 'An interchangeable template that names no commodity or destination.');
  assert.equal(legacy.status, 'proposed');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_lead_versions WHERE lead_id=?', 'NP-2-evidence').n, 0);
  // Retirement must reach the actual desk and activation route, while preserving the stored row.
  const retired = f.platform.research(null, { country: 'NP', q: 'interchangeable template', status: 'consolidated' });
  assert.equal(retired.total, 1);
  assert.equal(retired.leads[0].status, 'consolidated');
  assert.equal(retired.leads[0].recorded_status, 'proposed');
  assert.equal(retired.leads[0].replacement_id, 'NP-2-interventions');
  assert.equal(f.platform.research(null, { country: 'NP', q: 'interchangeable template', status: 'proposed' }).total, 0);
  assert.equal(retired.retained_total, retired.catalog_total + 1);
  const beforeMissions = f.platform.get('SELECT COUNT(*) AS n FROM missions').n;
  assert.throws(() => f.tx('researchActivate', f.actor('admin'), { lead_id: legacy.id, beneficiary: 'Fictional fixture' }), error => error.status === 409 && /NP-2-interventions/.test(error.message));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM missions').n, beforeMissions);
  assert.deepEqual(f.platform.get('SELECT * FROM research_leads WHERE id=?', legacy.id), legacy);
  // Unsupported concerns must retire too; a baseline is not falsely called their replacement.
  f.platform.run('INSERT INTO research_leads(id,country_code,goal,stage,title,instructions,rubric,source_urls,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'NP-3-evidence', 'NP', 3, 'evidence', 'Unscoped older template', 'No answerable subject selected.', 'Historical rubric.', '[]', created);
  const unscopedBefore = f.platform.get('SELECT * FROM research_leads WHERE id=?', 'NP-3-evidence');
  f.platform.initCivic();
  const unscoped = f.platform.research(null, { country: 'NP', q: 'Unscoped older template', status: 'retired' });
  assert.equal(unscoped.total, 1);
  assert.equal(unscoped.leads[0].replacement_id, '');
  assert.equal(unscoped.retained_total, unscoped.catalog_total + 2);
  assert.throws(() => f.tx('researchActivate', f.actor('admin'), { lead_id: 'NP-3-evidence', beneficiary: 'Fictional fixture' }), error => error.status === 409 && /without a scoped replacement/.test(error.message));
  assert.deepEqual(f.platform.get('SELECT * FROM research_leads WHERE id=?', 'NP-3-evidence'), unscopedBefore);
  // Idempotent across restarts.
  f.platform.initCivic();
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_lead_consolidations WHERE consolidated_id=?', 'NP-2-evidence').n, 1);
});
