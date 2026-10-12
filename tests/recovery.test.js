import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Platform } from '../src/platform.js';
import { acquireProcessLock, backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';
import { COMMUNITY_TABLES } from '../src/community.js';
import { JOURNEY_TABLES } from '../src/journey.js';

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
  assert.equal(validateDatabase(path).schema_version, 18);
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
  assert.equal(validateDatabase(path).schema_version, 18);
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
  assert.equal(validateDatabase(path).schema_version, 18);
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
  legacy.exec(`DROP TABLE land_stewardships; DROP TABLE land_events; DROP TABLE land_parcels;
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
    assert.equal(validateDatabase(destination).schema_version, 18);
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
    assert.equal(validateDatabase(path).schema_version, 18);
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
  writeFileSync(path, JSON.stringify({ pid: process.pid, nonce: 'previous-container', identity: { boot: 'a-previous-host-boot', start: '1' } }));
  const release = acquireProcessLock(path);
  try { assert.throws(() => acquireProcessLock(path), /running/); } finally { release(); }
});
