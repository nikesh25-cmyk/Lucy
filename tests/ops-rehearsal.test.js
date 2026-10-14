// Task 27 — the failure drills, asserted.
//
// scripts/ops-rehearsal.mjs runs every drill on its own disposable installation. This suite runs that
// script once against a private workspace and then re-checks what it left behind: the databases it
// restored, the backups it refused and the diagnostics response it produced. The drill is not trusted
// to grade itself — the assertions here read the files and databases directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runOpsRehearsal, PLANTED } from '../scripts/ops-rehearsal.mjs';
import { validateDatabase } from '../src/recovery.js';

let workspace, report;
test.before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'nemoworld-ops-suite-'));
  report = await runOpsRehearsal({ workspace });
});
test.after(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

const drill = (id) => {
  const entry = report.drills.find((candidate) => candidate.id === id);
  assert.ok(entry, `the ${id} drill did not run`);
  return entry;
};

test('every operational failure drill passed on a disposable installation', () => {
  const failed = report.drills.filter((entry) => !entry.ok).map((entry) => `${entry.id}: ${entry.checks.filter((check) => !check.ok).map((check) => check.name).join('; ') || entry.detail}`);
  assert.equal(failed.length, 0, failed.join('\n'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.drills.map((entry) => entry.id), ['recovery-point', 'corrupt-backup', 'migration-rehearsal', 'interrupted-worker', 'model-queue-saturation', 'storage-limit', 'diagnostics-redaction', 'safety-and-pause']);
  for (const entry of report.drills) assert.ok(entry.checks.length >= 4, `${entry.id} made too few assertions`);
  assert.ok(existsSync(report.report_path));
});

test('safety and pause drill leaves a recovered, independently decided world', () => {
  const entry = drill('safety-and-pause');
  assert.equal(entry.ok, true);
  const database = join(workspace, 'safety-and-pause', 'world.sqlite');
  assert.equal(validateDatabase(database).schema_version, 23);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='paused'").get().value, 'false');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='overturned'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM appeals WHERE status='overturned'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='platform.paused'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event='platform.resumed'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text='The world resumed after the drill.'").get().n, 1);
  } finally { db.close(); }
});

test('the restored world keeps its world, land, coin, quest and guild records at schema 23', () => {
  const directory = join(workspace, 'recovery-point');
  const database = join(directory, 'world.sqlite');
  assert.equal(validateDatabase(database).schema_version, 23);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_objects').get().n, 1);
    assert.equal(db.prepare('SELECT plot_id FROM land_stewardships').get().plot_id, 'plot:0:0:5:5');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM land_events').get().n, 1);
    assert.equal(db.prepare('SELECT amount FROM coin_rewards').get().amount, 10);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quest_enrollments e JOIN quest_chains c ON c.id=e.chain_id WHERE c.slug='quiet-harvest'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM guild_contributions WHERE status='verified'").get().n, 1);
    // The write committed after the backup was taken must not be in the restored world.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_objects WHERE x=5 AND y=8').get().n, 0);
  } finally { db.close(); }
});

test('the migration rehearsal lands a schema 17 world on 23 without losing records', () => {
  const drillEntry = drill('migration-rehearsal');
  const restored = join(workspace, 'migration-rehearsal', 'migrated', 'world.sqlite');
  assert.equal(validateDatabase(restored).schema_version, 23);
  const db = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coin_rewards').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quest_enrollments').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guild_projects').get().n, 0);
    assert.equal(db.prepare('SELECT plot_id FROM land_stewardships').get().plot_id, 'plot:0:0:5:5');
  } finally { db.close(); }
  assert.match(drillEntry.detail, /world_objects=1/);
});

test('every invalid backup was refused and the live world survived intact', () => {
  const directory = join(workspace, 'corrupt-backup');
  assert.ok(existsSync(join(directory, 'garbage.sqlite')));
  assert.ok(existsSync(join(directory, 'damaged.sqlite')));
  assert.ok(existsSync(join(directory, 'foreign.sqlite')));
  assert.equal(validateDatabase(join(directory, 'world.sqlite')).schema_version, 23);
  const entry = drill('corrupt-backup');
  assert.ok(entry.checks.filter((check) => /refused/.test(check.name)).length >= 8);
  for (const check of entry.checks) assert.ok(check.ok, check.name);
});

test('no token, password, contact address or private artifact appears in the produced diagnostics', () => {
  const diagnosticsPath = join(workspace, 'diagnostics-redaction', 'diagnostics.json');
  const healthPath = join(workspace, 'diagnostics-redaction', 'health.json');
  const diagnostics = readFileSync(diagnosticsPath, 'utf8');
  const health = readFileSync(healthPath, 'utf8');
  const reportText = readFileSync(report.report_path, 'utf8');
  const secrets = [PLANTED.email, PLANTED.password, PLANTED.message, PLANTED.journal, PLANTED.artifact, PLANTED.journalOwner];
  for (const [label, text] of [['the diagnostics response', diagnostics], ['the public health response', health], ['the rehearsal report', reportText]]) {
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${label} contains a planted secret`);
    assert.equal(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text), false, `${label} contains an email address`);
    assert.equal(/\b[0-9a-f]{64}\b/.test(text), false, `${label} contains a hash- or token-shaped value`);
  }
  // The subject of the grep is a real administrator diagnostics payload, not a stub.
  const payload = JSON.parse(diagnostics);
  assert.equal(payload.diagnostics.schema.version, 23);
  assert.ok(payload.diagnostics.model.state);
  assert.ok(Number.isInteger(payload.diagnostics.storage.database_bytes));
  assert.ok('interrupted' in payload.diagnostics.runs);
});
