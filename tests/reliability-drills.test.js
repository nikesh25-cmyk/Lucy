// Wave 7 — the reliability drills, asserted.
//
// scripts/reliability-drills.mjs runs three drills on their own disposable installations. This suite
// runs that script once against a private workspace and then re-reads what it left behind: the
// databases it killed a process inside, the diagnostics response it produced and the world it rolled
// back. The drill is not trusted to grade itself — the assertions here open the files and databases
// directly and recompute the properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runReliabilityDrills, PLANTED } from '../scripts/reliability-drills.mjs';
import { validateDatabase } from '../src/recovery.js';

let workspace, report;
test.before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'nemoworld-wave7-suite-'));
  report = await runReliabilityDrills({ workspace });
});
test.after(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

const drill = (id) => {
  const entry = report.drills.find((candidate) => candidate.id === id);
  assert.ok(entry, `the ${id} drill did not run`);
  return entry;
};

test('every Wave 7 reliability drill passed on a disposable installation', () => {
  const failed = report.drills.filter((entry) => !entry.ok).map((entry) => `${entry.id}: ${entry.checks.filter((check) => !check.ok).map((check) => check.name).join('; ') || entry.detail}`);
  assert.equal(failed.length, 0, failed.join('\n'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.drills.map((entry) => entry.id), ['crash-during-write', 'unexpected-error-record', 'rollback-release-candidate']);
  for (const entry of report.drills) assert.ok(entry.checks.length >= 4, `${entry.id} made too few assertions`);
  assert.ok(existsSync(report.report_path));
});

test('a process killed inside a transaction leaves no torn batch, and the interrupted job is explicit', () => {
  const entry = drill('crash-during-write');
  assert.equal(entry.ok, true);
  const { batch_size: batchSize, trials } = entry.artifacts;
  assert.equal(trials.length, 3);
  assert.ok(trials.some((trial) => trial.batch_rolled_back), 'at least one kill must land inside a transaction body');
  for (const trial of trials) {
    assert.equal(validateDatabase(trial.database).schema_version, 27, `${trial.label}: the killed database validates`);
    const db = new DatabaseSync(trial.database, { readOnly: true });
    try {
      // Recompute atomicity from the rows themselves, not from the drill's counters: every batch is
      // the whole 4,000 rows or none of them.
      const perBatch = new Map();
      for (const row of db.prepare("SELECT id FROM messages WHERE text='wave7-crash-drill'").all()) {
        const batch = Number(String(row.id).split('-')[1]);
        perBatch.set(batch, (perBatch.get(batch) || 0) + 1);
      }
      assert.ok(perBatch.size >= 1, `${trial.label}: the killed world kept at least one whole batch`);
      for (const [batch, n] of perBatch) assert.equal(n, batchSize, `${trial.label}: batch ${batch} is ${n} rows, not ${batchSize} — a transaction was left half-applied`);
      // The job the process was running is an explicit record, and its credential is dead.
      const job = db.prepare('SELECT status, detail FROM jobs WHERE id=?').get(trial.job_id);
      assert.equal(job.status, 'interrupted', `${trial.label}: the interrupted job is classified`);
      assert.match(job.detail, /No action is repeated automatically/);
      assert.equal(db.prepare('SELECT status FROM resident_runs WHERE id=?').get(trial.job_id).status, 'interrupted');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='resident.run.interrupted'").get().n, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { db.close(); }
  }
});

test('an unexpected server error leaves a structured record and no planted secret on any surface', () => {
  const entry = drill('unexpected-error-record');
  assert.equal(entry.ok, true);
  assert.equal(entry.artifacts.note === undefined, true);
  const artifacts = entry.artifacts;
  // The planted values are read back from the workspace, so this suite greps the real output rather
  // than the drill's own idea of what it planted.
  const { secrets } = JSON.parse(readFileSync(artifacts.secrets, 'utf8'));
  assert.ok(secrets.length >= 6, 'tokens, a password digest and every private marker were planted');
  const diagnostics = readFileSync(artifacts.diagnostics, 'utf8');
  const log = readFileSync(artifacts.log, 'utf8');
  const response = readFileSync(artifacts.response, 'utf8');
  for (const [label, text] of [['the diagnostics', diagnostics], ['the log', log], ['the response', response]]) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${label} contains a planted value`);
    for (const marker of Object.values(PLANTED)) assert.equal(text.includes(marker), false, `${label} contains a planted marker`);
    assert.equal(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text), false, `${label} contains an email address`);
    assert.equal(/\b[0-9a-f]{64}\b/.test(text), false, `${label} contains a hash- or token-shaped value`);
  }
  // The record is real and structured: an administrator reads it, an anonymous caller cannot.
  const payload = JSON.parse(diagnostics);
  const incidents = payload.diagnostics.incidents;
  assert.equal(incidents.recorded_since_start, 1);
  assert.equal(incidents.recent.length, 1);
  assert.deepEqual(Object.keys(incidents.recent[0]).sort(), ['at', 'error_code', 'error_name', 'id', 'kind', 'method', 'note', 'route', 'status']);
  assert.equal(incidents.recent[0].route, '/world');
  assert.equal(incidents.recent[0].status, 500);
  // A request the world itself refused is not an incident, so the counter means something.
  assert.equal(payload.diagnostics.incidents.recorded_since_start, 1);
  const parsedLog = log.split('\n').filter((line) => line.includes('"level":"error"')).map((line) => JSON.parse(line));
  assert.equal(parsedLog.length, 1);
  assert.equal(parsedLog[0].route, '/world');
  assert.equal(parsedLog[0].id, incidents.recent[0].id, 'the log line and the dashboard record are the same incident');
});

test('the rollback path returns a fresh public world exactly to its release point', () => {
  const entry = drill('rollback-release-candidate');
  assert.equal(entry.ok, true);
  const evidence = entry.artifacts;
  assert.ok(existsSync(evidence.backup));
  assert.ok(existsSync(evidence.preserved_original));
  assert.equal(validateDatabase(evidence.backup).schema_version, 27);
  // The release changed the world, and the rollback undid exactly that.
  assert.ok(evidence.after_release.accounts > evidence.release_point.accounts);
  assert.ok(evidence.after_release.world_objects > evidence.release_point.world_objects);
  assert.deepEqual(evidence.rolled_back, evidence.release_point);
  // And the live database really is the release-point state, read independently of the drill.
  const db = new DatabaseSync(evidence.database, { readOnly: true });
  try {
    for (const [table, expected] of Object.entries(evidence.release_point)) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, expected, `${table} was not restored to the release point`);
    assert.equal(db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get().hash, evidence.release_point_audit_tip, 'the audit chain tip is the release-point tip');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE email='postrelease@reliability.invalid'").get().n, 0);
  } finally { db.close(); }
});
