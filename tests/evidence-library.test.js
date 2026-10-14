import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Platform } from '../src/platform.js';
import { validateDatabase, backupDatabase, restoreDatabase, EVIDENCE_LIMITS } from '../src/recovery.js';
import { readSource } from '../runtime/research-worker.js';
import { statisticsUrl } from '../src/statistics.js';
import { fixture } from './helpers.js';

const catalog = JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json', import.meta.url), 'utf8'));
const series = catalog.countries.find((country) => country.country_code === 'AF').series.find((entry) => entry.indicator === 'NV.AGR.TOTL.ZS');
const retainedFixtures = [...new Map(catalog.countries.flatMap((country) => country.series || []).filter((entry) => entry.raw_file && entry.sha256).map((entry) => [entry.sha256, entry])).values()];
const retainedUrl = series.url;
const retainedSha = series.sha256;
const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const randomHash = () => createHash('sha256').update(String(Math.random() * 1e9)).digest('hex');
const retainedInput = (url, entry, changes = {}) => ({ url, sha256: entry.sha256, retained: true, retained_path: entry.raw_file, retrieved_at: '2026-10-12', evidence_kind: 'normalized-statistics', locator: 'Retained test fixture', ...changes });

function demoClaim(f, name = 'alice') {
  const agent = f.agent(name);
  return f.tx('claim', f.actor(name), { task_id: 'climate-practice', agent_id: agent.id }, `claim-${name}-${randomHash().slice(0, 12)}`);
}

test('the library seeds every retained catalog response with its bytes, hash, licence and location', async (t) => {
  const f = await fixture(t);
  const { platform } = f;
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM evidence_captures').n, 222);
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM evidence_sources').n, 222);
  const capture = platform.get('SELECT * FROM evidence_captures WHERE sha256=?', retainedSha);
  assert.ok(capture, 'the retained series is captured');
  assert.equal(capture.retained, 1);
  assert.equal(capture.origin, 'catalog');
  assert.equal(capture.evidence_kind, 'normalized-statistics');
  assert.equal(capture.unit, series.unit);
  assert.equal(capture.license_name, series.license.name);
  assert.equal(capture.license_attribution, series.license.attribution);
  assert.match(capture.locator, /AFG\/NV\.AGR\.TOTL\.ZS/);
  assert.equal(capture.retained_path, series.raw_file);
  const file = readFileSync(new URL(`../${series.raw_file}`, import.meta.url));
  assert.equal(capture.bytes, file.length);
  assert.equal(capture.bytes, statSync(new URL(`../${series.raw_file}`, import.meta.url)).size);
  assert.equal(createHash('sha256').update(file).digest('hex'), retainedSha);
  const library = platform.evidenceLibrary(f.actor('reviewer'), { limit: 1 });
  assert.equal(library.total, 222);
  assert.equal(library.limits.max_captures, EVIDENCE_LIMITS.max_captures);
  assert.equal(library.limits.max_captures_per_source, EVIDENCE_LIMITS.max_captures_per_source);
});

test('a receipt points at the exact version it cited while a bare link stays unverified', async (t) => {
  const f = await fixture(t);
  const claim = demoClaim(f);
  const submission = f.tx('submit', f.actor('alice'), {
    claim_id: claim.id,
    artifact: 'A cited evidence register.',
    sources: [
      { url: retainedUrl, location: `Retained raw response; SHA256 ${retainedSha}`, date: '2026-10-11' },
      { url: 'https://example.org/plain-report', location: 'Section 4, paragraph 2', date: '2026-01-01' },
    ],
    method: 'Read the retained response and recorded its exact location.',
    limitations: 'Sector context only.',
    rights: 'CC BY 4.0 for the retained series; the plain report is a link only.',
  }, 'submit-evidence-1');
  const before = f.platform.get('SELECT * FROM evidence_captures WHERE sha256=?', retainedSha);
  const evidence = f.platform.submissionEvidence(submission.id);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].state, 'captured');
  assert.equal(evidence[0].capture.id, before.id);
  assert.equal(evidence[0].capture.sha256, retainedSha);
  assert.equal(evidence[0].capture.retained, true);
  assert.equal(evidence[0].capture.license.name, 'CC BY 4.0');
  assert.match(evidence[0].capture.locator, new RegExp(series.raw_file.split('/').pop()));
  assert.equal(evidence[1].state, 'missing');
  assert.equal(evidence[1].capture, null);
  assert.match(evidence[1].state_note, /not verified evidence and must not be presented as support/);
  assert.deepEqual(f.platform.get('SELECT * FROM evidence_captures WHERE id=?', before.id), before, 'citing a version never rewrites it');
});

test('a contributor supplied SHA-256 cannot create captured evidence, including when an admin recorded only that hash', async (t) => {
  const f = await fixture(t);
  const url = 'https://example.org/unretained-contributor-claim';
  const sha = randomHash();
  const before = f.platform.get('SELECT COUNT(*) AS n FROM evidence_captures').n;
  const claim = demoClaim(f);
  const submission = f.tx('submit', f.actor('alice'), {
    claim_id: claim.id, artifact: 'Unverified source claim.', sources: [{ url, location: `Section 2; SHA256 ${sha}`, date: '2026-10-12' }],
    method: 'Contributor claim.', limitations: 'Source bytes were not retained.', rights: 'Unconfirmed.',
  }, 'submit-unretained');
  const evidence = f.platform.submissionEvidence(submission.id)[0];
  assert.equal(evidence.state, 'missing');
  assert.equal(evidence.capture, null);
  assert.match(evidence.state_note, /contributor-declared hash alone is not verified evidence/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM evidence_captures').n, before, 'submission creates no hash-only capture');
  const declared = f.platform.registerCapture({ url, sha256: sha, retrieved_at: '2026-10-12', origin: 'curator' });
  assert.equal(declared.retained, 0);
  const draft = f.platform.resolveCitation({ url, location: `Section 2; SHA256 ${sha}` }, 1);
  assert.equal(draft.state, 'missing');
  assert.equal(draft.capture.verification, 'declared-hash-only');
  assert.equal(f.platform.submissionEvidence(submission.id)[0].state, 'missing');
  const upgradeUrl = 'https://example.org/immutable-hash-claim';
  const oldDeclaration = f.platform.registerCapture({ url: upgradeUrl, sha256: retainedSha, retrieved_at: '2026-10-12', origin: 'curator' });
  assert.throws(() => f.platform.registerCapture(retainedInput(upgradeUrl, series)), /cannot be silently upgraded/i);
  assert.deepEqual(f.platform.get('SELECT * FROM evidence_captures WHERE id=?', oldDeclaration.id), oldDeclaration, 'the old hash-only row is not rewritten');
  assert.equal(validateDatabase(f.database).schema_version, 23);
});

test('legacy schema-22 hash-only citation rows stay intact but read as unverified after restart', async (t) => {
  const f = await fixture(t);
  const url = 'https://example.org/legacy-hash-only';
  const sha = randomHash();
  const claim = demoClaim(f);
  const submission = f.tx('submit', f.actor('alice'), {
    claim_id: claim.id, artifact: 'Historic hash-only citation.', sources: [{ url, location: `Section 4; SHA256 ${sha}`, date: '2026-10-12' }],
    method: 'Contributor report.', limitations: 'No retained bytes.', rights: 'Unknown.',
  }, 'submit-legacy-hash');
  const declared = f.platform.registerCapture({ url, sha256: sha, retrieved_at: '2026-10-12', origin: 'submission' });
  const original = f.platform.get('SELECT * FROM submission_evidence WHERE submission_id=?', submission.id);
  f.platform.run('DELETE FROM submission_evidence WHERE submission_id=?', submission.id);
  f.platform.run('INSERT INTO submission_evidence(submission_id,source_number,capture_id,url,locator,cited_date,state,created_at) VALUES(?,?,?,?,?,?,?,?)',
    submission.id, original.source_number, declared.id, original.url, original.locator, original.cited_date, 'captured', original.created_at);
  const historic = f.platform.get('SELECT * FROM submission_evidence WHERE submission_id=?', submission.id);
  assert.equal(validateDatabase(f.database).schema_version, 23, 'legacy storage remains valid');
  assert.equal(f.platform.submissionEvidence(submission.id)[0].state, 'missing');
  assert.equal(f.platform.submissionEvidence(submission.id)[0].capture.verification, 'declared-hash-only');
  const workbench = f.platform.reviewWorkbench(f.actor('reviewer'), { submission: submission.id }).citations[0];
  assert.equal(workbench.state, 'missing');
  assert.equal(workbench.cited_version, null);
  assert.equal(workbench.comparison.same_version, false);
  f.platform.close();
  const reopened = new Platform(f.database);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get('SELECT * FROM submission_evidence WHERE submission_id=?', submission.id), historic, 'no historical receipt is rewritten');
  assert.equal(reopened.submissionEvidence(submission.id)[0].state, 'missing');
});

test('only newer retained bytes mark a citation stale or replaced', async (t) => {
  const f = await fixture(t);
  const claim = demoClaim(f);
  const submission = f.tx('submit', f.actor('alice'), {
    claim_id: claim.id, artifact: 'Original support.',
    sources: [{ url: retainedUrl, location: `Row 1; SHA256 ${retainedSha}`, date: '2026-10-11' }],
    method: 'Retained read.', limitations: 'Context.', rights: 'CC BY 4.0.',
  }, 'submit-stale');
  const original = f.platform.submissionEvidence(submission.id)[0];
  assert.equal(original.state, 'captured');
  f.tx('evidenceCapture', f.actor('admin'), { url: retainedUrl, sha256: randomHash(), retrieved_at: '2026-10-12', locator: 'Hash-only assertion' });
  assert.equal(f.platform.submissionEvidence(submission.id)[0].state, 'captured', 'a newer hash assertion does not make source bytes stale');
  const newer = f.tx('evidenceCapture', f.actor('admin'), retainedInput(retainedUrl, retainedFixtures[1], { unit: '% of GDP', declared_date: '2026-10-09' }));
  const stale = f.platform.submissionEvidence(submission.id)[0];
  assert.equal(stale.state, 'stale');
  assert.equal(stale.capture.id, original.capture.id);
  assert.equal(stale.versions.length, 3);
  f.tx('evidenceCapture', f.actor('admin'), retainedInput(retainedUrl, retainedFixtures[2], { retrieved_at: '2026-10-13', declared_date: '2026-10-10', locator: 'Corrected edition', supersedes: original.capture.id }));
  const replaced = f.platform.submissionEvidence(submission.id)[0];
  assert.equal(replaced.state, 'replaced');
  assert.equal(replaced.capture.id, original.capture.id);
  assert.ok(replaced.versions.some((version) => version.supersedes === original.capture.id));
  assert.ok(f.platform.get('SELECT id FROM evidence_captures WHERE id=?', original.capture.id));
});

test('conflicting declared dates and units remain visible with their byte-retention status', async (t) => {
  const f = await fixture(t);
  const url = retainedUrl;
  const first = f.tx('evidenceCapture', f.actor('admin'), retainedInput(url, retainedFixtures[1], { retrieved_at: '2026-10-01', declared_date: '2026-01-01', unit: '% of land area' }));
  f.tx('evidenceCapture', f.actor('admin'), { url, sha256: randomHash(), retrieved_at: '2026-10-02', declared_date: '2025-06-30', unit: 'percent of total land', evidence_kind: 'normalized-statistics', locator: 'Second declared hash' });
  const claim = demoClaim(f);
  const submission = f.tx('submit', f.actor('alice'), {
    claim_id: claim.id, artifact: 'Two captures disagree.', sources: [{ url, location: `Table 1; SHA256 ${first.sha256}`, date: '2026-10-01' }],
    method: 'Read.', limitations: 'Context.', rights: 'Review terms.',
  }, 'submit-conflict');
  const entry = f.platform.submissionEvidence(submission.id)[0];
  assert.equal(entry.conflict, true);
  assert.deepEqual([...entry.declared_dates].sort(), ['2025-06-30', '2026-01-01']);
  assert.deepEqual([...entry.units].sort(), ['% of GDP', '% of land area', 'percent of total land']);
  assert.equal(entry.versions.length, 3);
  assert.equal(entry.versions.find((version) => !version.retained).verification, 'declared-hash-only');
});

test('a withdrawn source stays distinct and a fresh capture records that it is available again', async (t) => {
  const f = await fixture(t);
  const claim = demoClaim(f);
  const submission = f.tx('submit', f.actor('alice'), {
    claim_id: claim.id, artifact: 'Support.', sources: [{ url: retainedUrl, location: `Row; SHA256 ${retainedSha}`, date: '2026-10-11' }],
    method: 'Read.', limitations: 'Context.', rights: 'CC BY 4.0.',
  }, 'submit-withdrawn');
  f.tx('evidenceWithdraw', f.actor('reviewer'), { url: retainedUrl, reason: 'Browser check: the page now refuses the request.' });
  const withdrawn = f.platform.submissionEvidence(submission.id)[0];
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.source_status, 'withdrawn');
  assert.match(withdrawn.withdrawn_reason, /refuses/);
  assert.equal(withdrawn.capture.sha256, retainedSha, 'the captured version is retained exactly');
  f.tx('evidenceCapture', f.actor('admin'), { url: retainedUrl, sha256: randomHash(), retrieved_at: '2026-10-14', evidence_kind: 'normalized-statistics', locator: 'Available again' });
  assert.equal(f.platform.submissionEvidence(submission.id)[0].source_status, 'active');
  assert.ok(f.platform.get("SELECT id FROM evidence_events WHERE kind='restored'"));
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM evidence_events WHERE kind='withdrawn'").n, 1);
});

test('a capture fails closed on a forbidden host, a private address, a wrong hash or an exhausted quota', async (t) => {
  const f = await fixture(t);
  const hash = randomHash();
  assert.throws(() => f.tx('evidenceCapture', f.actor('admin'), { url: 'https://evil.example/report', sha256: hash, retrieved_at: '2026-10-12' }), { status: 403 });
  assert.throws(() => f.tx('evidenceCapture', f.actor('admin'), { url: 'https://127.0.0.1/report', sha256: hash, retrieved_at: '2026-10-12' }), { status: 403 });
  const before = f.platform.get('SELECT COUNT(*) AS n FROM evidence_captures').n;
  assert.throws(() => f.tx('evidenceCapture', f.actor('admin'), { url: retainedUrl, sha256: hash, retained: true, retained_path: series.raw_file, retrieved_at: '2026-10-12' }), { status: 409 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM evidence_captures').n, before, 'a refused capture stores nothing');
  assert.equal(f.platform.get('SELECT id FROM evidence_captures WHERE sha256=?', hash), undefined);
  assert.throws(() => f.tx('evidenceCapture', f.actor('alice'), { url: retainedUrl, sha256: hash, retrieved_at: '2026-10-12' }), { status: 403 });
});

test('the per-source version quota evicts only uncited versions and refuses when every version is cited', async (t) => {
  const f = await fixture(t);
  // The synthetic URL collects distinct retained fixture bytes solely to exercise per-source quota.
  const url = 'https://api.worldbank.org/v2/test-only/evidence-quota';
  const share = [];
  for (let index = 0; index < EVIDENCE_LIMITS.max_captures_per_source; index += 1) share.push(f.tx('evidenceCapture', f.actor('admin'), retainedInput(url, retainedFixtures[index], { retrieved_at: `2026-10-${String(index + 1).padStart(2, '0')}`, locator: `Version ${index + 1}` })));
  const sourceId = share[0].source_id;
  const count = () => f.platform.get('SELECT COUNT(*) AS n FROM evidence_captures WHERE source_id=?', sourceId).n;
  assert.equal(count(), EVIDENCE_LIMITS.max_captures_per_source);
  // An uncited version is the eviction candidate: a fresh one is accepted and the oldest is gone.
  const oldest = share[0].sha256;
  f.tx('evidenceCapture', f.actor('admin'), retainedInput(url, retainedFixtures[EVIDENCE_LIMITS.max_captures_per_source], { retrieved_at: '2026-11-01', locator: 'Newest' }));
  assert.equal(count(), EVIDENCE_LIMITS.max_captures_per_source);
  assert.equal(f.platform.get('SELECT id FROM evidence_captures WHERE source_id=? AND sha256=?', sourceId, oldest), undefined, 'the oldest uncited version was evicted');
  // Cite every retained version, so nothing is evictable and a further capture fails closed.
  const versions = f.platform.all('SELECT * FROM evidence_captures WHERE source_id=?', sourceId);
  assert.equal(versions.length, EVIDENCE_LIMITS.max_captures_per_source);
  const agent = f.agent('alice');
  const claim = f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: agent.id }, 'claim-quota');
  f.tx('submit', f.actor('alice'), {
    claim_id: claim.id, artifact: 'All versions cited.', sources: versions.map((version) => ({ url, location: `Row; SHA256 ${version.sha256}`, date: '2026-10-12' })),
    method: 'Read.', limitations: 'Context.', rights: 'Review terms.',
  }, 'submit-quota');
  const cited = f.platform.get('SELECT COUNT(*) AS n FROM submission_evidence e JOIN evidence_captures c ON c.id=e.capture_id WHERE c.source_id=?', sourceId).n;
  assert.equal(cited, EVIDENCE_LIMITS.max_captures_per_source);
  assert.throws(() => f.tx('evidenceCapture', f.actor('admin'), retainedInput(url, retainedFixtures[EVIDENCE_LIMITS.max_captures_per_source + 1], { retrieved_at: '2026-12-01', locator: 'Over quota' })), { status: 409 });
  assert.equal(count(), EVIDENCE_LIMITS.max_captures_per_source, 'a refused capture stores nothing');
});

test('a private draft resolves the same exact versions without writing anything', async (t) => {
  const f = await fixture(t);
  const claim = demoClaim(f);
  f.tx('draftSave', f.actor('alice'), { claim_id: claim.id, expected_revision: 0, format: 'evidence-form-v1', values: { artifact: 'Draft', method: 'Read.', limitations: 'Context.', rights: 'CC BY 4.0.', url_0: retainedUrl, location_0: 'Row 1', date_0: '2026-10-11', url_1: retainedUrl, location_1: `Row 2; SHA256 ${retainedSha}`, date_1: '2026-10-11' } });
  const resolved = f.platform.draftEvidence(f.actor('alice'), { claim_id: claim.id });
  assert.equal(resolved.sources.length, 2);
  assert.equal(resolved.sources[0].state, 'missing', 'a draft URL without a hash is unverified');
  assert.equal(resolved.sources[1].state, 'captured');
  assert.equal(resolved.sources[1].capture.sha256, retainedSha);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM evidence_captures').n, 222, 'reading a draft writes no capture');
});

test('the reader still fails closed on a redirect, a private answer and a forbidden host', async () => {
  const url = statisticsUrl('NPL', 'AG.LND.ARBL.ZS');
  await assert.rejects(readSource(url, ['example.org'], { resolve }), /approved/);
  await assert.rejects(readSource(url, ['api.worldbank.org'], { resolve: async () => [{ address: '10.0.0.5', family: 4 }] }), /private/);
  await assert.rejects(readSource(url, ['api.worldbank.org'], { resolve, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }) }), /unavailable/);
});

test('the storage layer refuses an edited capture, a rewritten source identity and an invalid capture', async (t) => {
  const f = await fixture(t);
  const capture = f.platform.get('SELECT * FROM evidence_captures LIMIT 1');
  assert.throws(() => f.platform.run('UPDATE evidence_captures SET sha256=? WHERE id=?', randomHash(), capture.id), /append-only/);
  assert.throws(() => f.platform.run('UPDATE evidence_sources SET url=? WHERE id=?', 'https://example.org/x', capture.source_id), /immutable/);
  assert.throws(() => f.platform.run('INSERT INTO evidence_captures(id,source_id,source_key,url,sha256,retrieved_at,created_at) VALUES(?,?,?,?,?,?,?)', 'x', capture.source_id, capture.source_key, capture.url, 'not-a-hash', '2026-10-12', new Date().toISOString()), /invalid/);
});

test('a schema 21 database migrates forward to 23 and survives backup and restore', async (t) => {
  const f = await fixture(t);
  const { platform } = f;
  assert.equal(validateDatabase(f.database).schema_version, 23);
  platform.db.exec('PRAGMA foreign_keys=OFF; DROP TABLE submission_evidence; DROP TABLE evidence_events; DROP TABLE evidence_captures; DROP TABLE evidence_sources; PRAGMA user_version=21');
  assert.equal(validateDatabase(f.database).schema_version, 21);
  platform.close();
  const migrated = new Platform(f.database);
  t.after(() => migrated.close());
  assert.equal(migrated.get('PRAGMA user_version').user_version, 23);
  assert.equal(validateDatabase(f.database).schema_version, 23);
  assert.equal(migrated.verifyAudit(), true);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM evidence_captures').n, 222);
  const backup = `${f.directory}/evidence-backup.sqlite`;
  backupDatabase(migrated.db, backup);
  const restored = restoreDatabase(backup, `${f.directory}/evidence-restored.sqlite`);
  assert.equal(restored.schema_version, 23);
  assert.equal(validateDatabase(`${f.directory}/evidence-restored.sqlite`).schema_version, 23);
});

test('a tampered evidence library fails full validation', async (t) => {
  const f = await fixture(t);
  const capture = f.platform.get('SELECT * FROM evidence_captures LIMIT 1');
  f.platform.db.exec('DROP TRIGGER evidence_captures_no_update');
  f.platform.run('UPDATE evidence_captures SET bytes=-5 WHERE id=?', capture.id);
  f.platform.db.exec("CREATE TRIGGER evidence_captures_no_update BEFORE UPDATE ON evidence_captures BEGIN SELECT RAISE(ABORT,'Evidence captures are append-only'); END");
  assert.throws(() => validateDatabase(f.database), /evidence library validation failed/);
});
