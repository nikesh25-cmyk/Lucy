import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Platform } from '../src/platform.js';
import { acquireProcessLock, backupDatabase, redactDiagnostics, restoreDatabase, validateDatabase, EVIDENCE_LIMITS } from '../src/recovery.js';
import { COMMUNITY_TABLES } from '../src/community.js';
import { JOURNEY_TABLES } from '../src/journey.js';
import { fixture } from './helpers.js';

const setup = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'world-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
test('SQLite backups recover durable changes and preserve the previous database', (t) => {
  const directory = setup(t), path = join(directory, 'world.sqlite'), backup = join(directory, 'backup.sqlite');
  const platform = new Platform(path);
  platform.transaction(() => platform.audit('system', 'test.original'));
  backupDatabase(platform.db, backup);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  platform.transaction(() => platform.audit('system', 'test.later'));
  platform.close();
  const result = restoreDatabase(backup, path);
  assert.ok(result.preserved_original);
  assert.equal(validateDatabase(path).schema_version, 22);
  const restored = new Platform(path), preserved = new Platform(result.preserved_original);
  try {
    assert.equal(restored.all('SELECT event FROM audit').length, 1);
    assert.equal(preserved.all('SELECT event FROM audit').length, 2);
    assert.equal(restored.verifyAudit(), true);
  } finally { restored.close(); preserved.close(); }
});
test('restore rejects active server locks and malformed backups', (t) => {
  const directory = setup(t), path = join(directory, 'world.sqlite'), backup = join(directory, 'backup.sqlite');
  const platform = new Platform(path); backupDatabase(platform.db, backup); platform.close();
  const release = acquireProcessLock(join(directory, 'server.lock'));
  try { assert.throws(() => restoreDatabase(backup, path), /running/); } finally { release(); }
  writeFileSync(join(directory, 'bad.sqlite'), 'not a database');
  assert.throws(() => restoreDatabase(join(directory, 'bad.sqlite'), path));
  assert.equal(validateDatabase(path).schema_version, 22);
});
test('stale process locks are reclaimed and released safely', (t) => {
  const directory = setup(t), path = join(directory, 'server.lock');
  writeFileSync(path, JSON.stringify({ pid: 2147483647, nonce: 'previous' }));
  const release = acquireProcessLock(path);
  assert.throws(() => acquireProcessLock(path), /running/);
  release();
  const releaseAgain = acquireProcessLock(path); releaseAgain();
});

test('a validated backup restores over a corrupt original without discarding its bytes', (t) => {
  const directory = setup(t), path = join(directory, 'world.sqlite'), backup = join(directory, 'backup.sqlite');
  const platform = new Platform(path); backupDatabase(platform.db, backup); platform.close();
  writeFileSync(path, 'damaged original');
  const result = restoreDatabase(backup, path);
  assert.equal(validateDatabase(path).schema_version, 22);
  assert.equal(statSync(result.preserved_original).size, 'damaged original'.length);
});

test('version one backups restore and migrate without losing accounts, avatars or messages', async (t) => {
  const directory = setup(t), source = join(directory, 'legacy.sqlite'), destination = join(directory, 'restored.sqlite');
  const platform = new Platform(source);
  const credentials = await platform.register({ name: 'Original owner', email: 'owner@example.org', password: 'legacy-test-password', consent: true });
  const actor = platform.authenticate(credentials.token);
  const agent = platform.transaction(() => platform.createAgent(actor, { name: 'Original avatar' }));
  platform.transaction(() => platform.message(actor, { agent_id: agent.id, text: 'A preserved legacy conversation.' }));
  platform.close();
  // Remove world additions and their frontier references to recreate a v1 backup.
  const legacy = new DatabaseSync(source);
  legacy.exec('PRAGMA foreign_keys=OFF; DROP VIEW calling_source_events; DROP VIEW calling_objective_rules; DROP TABLE calling_receipts; DROP TABLE resident_callings');
  for (const table of [...COMMUNITY_TABLES, ...JOURNEY_TABLES]) legacy.exec(`DROP TABLE ${table}`);
  legacy.exec(`DROP TRIGGER land_stewardships_revoke_grants; DROP TABLE plot_grant_events; DROP TABLE plot_grants;
    DROP TABLE land_stewardships; DROP TABLE land_events; DROP TABLE land_parcels;
    DROP TABLE frontier_actions; DROP TABLE frontier_blocks; DROP TABLE frontier_sectors;
    DROP TABLE world_objects; DROP TABLE worlds;
    DROP INDEX agents_spatial; DROP INDEX messages_world;
    ALTER TABLE agents DROP COLUMN world_id;
    ALTER TABLE agents DROP COLUMN posture;
    ALTER TABLE agents DROP COLUMN emote;
    ALTER TABLE agents DROP COLUMN emote_until;
    ALTER TABLE agents DROP COLUMN last_emote;
    ALTER TABLE messages DROP COLUMN world_id;
    PRAGMA user_version=1;`);
  legacy.close();
  assert.equal(validateDatabase(source).schema_version, 1);
  assert.equal(restoreDatabase(source, destination).schema_version, 1);
  const restored = new Platform(destination);
  try {
    assert.equal(validateDatabase(destination).schema_version, 22);
    const restoredActor = restored.authenticate(credentials.token);
    assert.equal(restored.me(restoredActor).account.name, 'Original owner');
    assert.equal(restored.me(restoredActor).agents[0].name, 'Original avatar');
    assert.equal(restored.get('SELECT world_id FROM agents WHERE id=?', agent.id).world_id, 'commons');
    assert.ok(restored.get('SELECT id FROM worlds WHERE owner_agent_id=?', agent.id));
    assert.equal(restored.world(restoredActor).messages[0].text, 'A preserved legacy conversation.');
  } finally { restored.close(); }
});

test('version two state upgrades atomically and version three recovery requires resident tables', async (t) => {
  const directory = setup(t), path = join(directory, 'v2.sqlite'), backup = join(directory, 'v3-backup.sqlite');
  const original = new Platform(path);
  const credentials = await original.register({ name: 'Garden owner', email: 'garden@example.org', password: 'migration-password-2026', consent: true });
  const actor = original.authenticate(credentials.token);
  const avatar = original.transaction(() => original.createAgent(actor, { name: 'Preserved resident' }));
  original.close();
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA foreign_keys=OFF; DROP VIEW calling_source_events; DROP VIEW calling_objective_rules; DROP TABLE calling_receipts; DROP TABLE resident_callings');
  for (const table of [...COMMUNITY_TABLES, ...JOURNEY_TABLES]) legacy.exec(`DROP TABLE ${table}`);
  legacy.exec('ALTER TABLE agents DROP COLUMN emote; ALTER TABLE agents DROP COLUMN emote_until; ALTER TABLE agents DROP COLUMN last_emote; PRAGMA user_version=2');
  legacy.close();
  assert.equal(validateDatabase(path).schema_version, 2);
  const upgraded = new Platform(path);
  try {
    assert.equal(validateDatabase(path).schema_version, 22);
    const nextActor = upgraded.authenticate(credentials.token);
    assert.equal(upgraded.me(nextActor).agents[0].id, avatar.id);
    assert.equal(upgraded.journey(nextActor, { agent_id: avatar.id }).discoveries[0].world_id, 'commons');
    assert.ok(upgraded.space(nextActor, `home:${avatar.id}`));
    assert.equal(upgraded.verifyAudit(), true);
    backupDatabase(upgraded.db, backup);
  } finally { upgraded.close(); }
  const incomplete = new DatabaseSync(backup);
  incomplete.exec('DROP TABLE journey_journal'); incomplete.close();
  assert.throws(() => validateDatabase(backup), /complete NemoWorld/);
});

test('process locks recover after a reused PID or a different host boot', (t) => {
  const directory = setup(t), path = join(directory, 'server.lock');
  // Simulate two host boots directly. macOS process inspection is unavailable in some test
  // sandboxes, while production still uses the real process identity provider by default.
  const identityOf = () => ({ boot: 'current-host-boot', start: 'current-process-start' });
  writeFileSync(path, JSON.stringify({ pid: process.pid, nonce: 'previous-container', identity: { boot: 'a-previous-host-boot', start: '1' } }));
  const release = acquireProcessLock(path, { identityOf });
  try { assert.throws(() => acquireProcessLock(path, { identityOf }), /running/); } finally { release(); }
});

// The evidence library's own rules, re-checked. Every rewrite below is one a tool with database
// access can perform: the append-only trigger is dropped for the write and restored afterwards,
// exactly as `tests/evidence-library.test.js` does, so validation — not the trigger — is the gate.
const rewriteCapture = (platform, sql, ...values) => {
  platform.db.exec('DROP TRIGGER evidence_captures_no_update');
  try { platform.run(sql, ...values); }
  finally { platform.db.exec("CREATE TRIGGER evidence_captures_no_update BEFORE UPDATE ON evidence_captures BEGIN SELECT RAISE(ABORT,'Evidence captures are append-only'); END"); }
};

test('a capture re-pointed at another source URL fails full validation', async (t) => {
  const f = await fixture(t);
  const capture = f.platform.get('SELECT * FROM evidence_captures ORDER BY sha256 LIMIT 1');
  rewriteCapture(f.platform, 'UPDATE evidence_captures SET url=? WHERE id=?', 'https://elsewhere.example/other-response.json', capture.id);
  // The row still names its own source and hash; only the address it is stored under has moved.
  assert.equal(f.platform.get('SELECT source_key FROM evidence_captures WHERE id=?', capture.id).source_key, capture.source_key);
  assert.equal(f.platform.get('SELECT url FROM evidence_captures WHERE id=?', capture.id).url, 'https://elsewhere.example/other-response.json');
  assert.throws(() => validateDatabase(f.database), /evidence library validation failed/);
});

test('a retained-evidence total past its byte quota fails full validation', async (t) => {
  const f = await fixture(t);
  const capture = f.platform.get('SELECT * FROM evidence_captures WHERE retained=1 LIMIT 1');
  const retained = f.platform.get('SELECT COALESCE(SUM(bytes),0) AS n FROM evidence_captures WHERE retained=1').n;
  assert.ok(retained <= EVIDENCE_LIMITS.max_retained_bytes, 'the seeded library starts inside its quota');
  rewriteCapture(f.platform, 'UPDATE evidence_captures SET retained_path=?,bytes=? WHERE id=?', 'catalog/fabricated-response.json', EVIDENCE_LIMITS.max_retained_bytes, capture.id);
  assert.ok(f.platform.get('SELECT COALESCE(SUM(bytes),0) AS n FROM evidence_captures WHERE retained=1').n > EVIDENCE_LIMITS.max_retained_bytes);
  assert.throws(() => validateDatabase(f.database), /evidence library validation failed/);
});

test('a withdrawn source without its recorded withdrawal fails full validation', async (t) => {
  const f = await fixture(t);
  const source = f.platform.get('SELECT * FROM evidence_sources ORDER BY source_key LIMIT 1');
  assert.equal(source.status, 'active');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM evidence_events WHERE source_id=?', source.id).n, 0);
  // The identity trigger guards the source's address, not its status, so this rewrite needs no
  // dropped trigger at all. A withdrawal is recorded by its own append-only event with its reason;
  // a status and reason written without that event is not a withdrawal the world ever performed.
  f.platform.run("UPDATE evidence_sources SET status='withdrawn',withdrawn_reason='Tampered withdrawal.' WHERE id=?", source.id);
  assert.throws(() => validateDatabase(f.database), /evidence library validation failed/);
});

test('the diagnostics redaction drops private content fields and keeps the counters it names', () => {
  const redacted = redactDiagnostics({
    records: { accounts: 4, messages: 412, ambassador_conversations: 177 },
    model: { state_note: 'The local model is idle: nothing is running and nothing is waiting.' },
    integrity: { quick_check: 'ok', journal_mode: 'wal' },
    recovery: { backup_point: 'The last committed transaction before the copy began.', replay_policy: 'A recorded action is never replayed.' },
    message: 'PRIVATE-MESSAGE-MARKER', text: 'PRIVATE-TEXT-MARKER', journal_text: 'PRIVATE-JOURNAL-MARKER',
    artifact: 'PRIVATE-ARTIFACT-MARKER', prompt: 'PRIVATE-PROMPT-MARKER', conversation: [{ answer: 'PRIVATE-ANSWER-MARKER' }],
    excerpt: 'PRIVATE-EXCERPT-MARKER', transcript: 'PRIVATE-TRANSCRIPT-MARKER', body: { content: 'PRIVATE-BODY-MARKER' },
  });
  for (const field of ['message', 'text', 'journal_text', 'artifact', 'prompt', 'conversation', 'excerpt', 'transcript', 'body']) assert.equal(redacted[field], '[redacted-field]', `${field} must be dropped`);
  assert.equal(JSON.stringify(redacted).includes('PRIVATE'), false);
  // The named counters, their notes and their policy text are published unchanged.
  assert.equal(redacted.records.accounts, 4);
  assert.equal(redacted.records.messages, 412);
  assert.equal(redacted.records.ambassador_conversations, 177);
  assert.match(redacted.model.state_note, /idle/);
  assert.equal(redacted.integrity.journal_mode, 'wal');
  assert.match(redacted.recovery.backup_point, /committed transaction/);
  assert.match(redacted.recovery.replay_policy, /never replayed/);
});
