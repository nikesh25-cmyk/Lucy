import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { openDatabase } from '../src/database.js';
import { WORLD_CONTENT_SCHEMA_VERSION } from '../src/schema27.js';
import { worldContentChecksCurrent } from '../src/schema24.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const rows = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()]));
const schema = (db) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();

// Build the historical CHECK fixture without exercising the production rebuild itself. These are
// disposable databases only; reopening forces SQLite to parse the old, narrower CREATE statements.
function legacyChecks(path, version, { unsupported = false } = {}) {
  const db = new DatabaseSync(path);
  db.enableDefensive(false);
  db.exec('PRAGMA writable_schema=ON');
  for (const [table, field, values] of [['journey_crops', 'kind', unsupported ? "'herbs','removed_crop'" : "'herbs'"], ['frontier_blocks', 'type', "'wood','path'"]]) {
    const old = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
    const updated = old.replace(new RegExp(`(${field} IN \\()[^)]*(\\))`), `$1${values}$2`);
    assert.notEqual(updated, old, `${table}: the fixture really narrows the stored constraint`);
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name=?").run(updated, table);
  }
  db.exec(`PRAGMA writable_schema=OFF; PRAGMA user_version=${version}`);
  db.close();
}

function stripFutureTables(db, version) {
  if (version < 26) db.exec('DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE shop_purchases; DROP TABLE karma_purchases; DROP TABLE karma_receipts;');
  if (version < 25) db.exec('DROP TABLE resident_vault; DROP TABLE resident_vault_keys;');
}

async function savedWorld(t, version) {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), actor = f.actor('alice');
  f.tx('travel', actor, alice.id, { world_id: `home:${alice.id}` });
  f.tx('build', actor, alice.id, { type: 'farm', x: 4, y: 8 });
  f.tx('gardenAction', actor, { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 4, y: 8 });
  f.tx('landAssign', actor, { plot_id: 'plot:0:0:5:5', purpose: 'A persistent shared garden', description: 'Migration fixture.' });
  const grant = f.tx('plotGrantCreate', actor, { plot_id: 'plot:0:0:5:5', guest_agent_id: bob.id, purpose: 'Save one path', duration_minutes: 120, block_types: ['wood', 'path'], layers: [0], actions: ['place'], max_blocks: 2 }).grant;
  f.platform.run('UPDATE agents SET world_id=?,x=34,y=33,z=0,grounded=1 WHERE id=?', 'frontier:0:0', bob.id);
  f.tx('frontierBuild', f.actor('bob'), bob.id, { world_id: 'frontier:0:0', x: 32, y: 32, z: 0, type: 'path' });
  if (version >= 26) f.tx('karmaSettle', actor, { agent_id: alice.id });
  stripFutureTables(f.platform.db, version);
  f.platform.close();
  legacyChecks(f.database, version);
  return { ...f, alice, bob, grant };
}

for (const version of [24, 25, 26]) test(`schema ${version} upgrades narrow content checks with saved crops, blocks, grants and a restorable backup`, async (t) => {
  const f = await savedWorld(t, version);
  assert.equal(validateDatabase(f.database).schema_version, version, 'a valid narrow legacy backup remains supported');
  const legacy = new DatabaseSync(f.database);
  const before = rows(legacy);
  // A custom dependent view, guard and index must survive too; migration must not silently drop
  // operational objects just because their SQL refers to one of the rebuilt tables.
  legacy.exec("CREATE VIEW saved_crop_probe AS SELECT agent_id,kind FROM journey_crops; CREATE INDEX saved_crop_probe_idx ON journey_crops(kind); CREATE TRIGGER saved_crop_probe_guard BEFORE DELETE ON journey_crops BEGIN SELECT RAISE(ABORT,'saved crop probe'); END;");
  const backup = join(f.directory, `legacy-${version}.sqlite`);
  backupDatabase(legacy, backup);
  legacy.close();
  const migrated = new Platform(f.database, f.clock);
  t.after(() => migrated.close());
  assert.equal(validateDatabase(f.database).schema_version, WORLD_CONTENT_SCHEMA_VERSION);
  assert.equal(worldContentChecksCurrent(migrated.db), true);
  const after = rows(migrated.db);
  for (const [table, records] of Object.entries(before)) assert.deepEqual(after[table], records, `${table}: every legacy row is preserved`);
  assert.equal(migrated.get('SELECT grant_id FROM frontier_blocks WHERE creator_agent_id=?', f.bob.id).grant_id, f.grant.id);
  assert.equal(migrated.get('SELECT kind FROM saved_crop_probe WHERE agent_id=?', f.alice.id).kind, 'herbs');
  assert.ok(migrated.get("SELECT name FROM sqlite_schema WHERE type='index' AND name='saved_crop_probe_idx'"));
  assert.throws(() => migrated.run('DELETE FROM journey_crops WHERE agent_id=?', f.alice.id), /saved crop probe/);
  assert.equal(migrated.verifyAudit(), true);
  assert.deepEqual(migrated.all('PRAGMA foreign_key_check'), []);
  // Exercise a genuinely new-to-the-legacy-list crop after the migration, through the public world
  // method rather than by bypassing its server rules.
  f.advance(25 * 60_000);
  migrated.transaction(() => migrated.gardenAction(migrated.authenticate(f.credentials.alice.token), { agent_id: f.alice.id, action: 'harvest', x: 4, y: 8 }));
  migrated.transaction(() => migrated.gardenAction(migrated.authenticate(f.credentials.alice.token), { agent_id: f.alice.id, action: 'plant', kind: 'fiber', x: 4, y: 8 }));
  assert.equal(migrated.get('SELECT kind FROM journey_crops WHERE agent_id=?', f.alice.id).kind, 'fiber');
  migrated.run('UPDATE agents SET world_id=?,x=34,y=33,z=0,grounded=1 WHERE id=?', 'frontier:0:0', f.alice.id);
  migrated.transaction(() => migrated.frontierBuild(migrated.authenticate(f.credentials.alice.token), f.alice.id, { world_id: 'frontier:0:0', x: 33, y: 32, z: 0, type: 'stone' }));
  assert.equal(migrated.get('SELECT type FROM frontier_blocks WHERE creator_agent_id=?', f.alice.id).type, 'stone');
  const restored = join(f.directory, `restored-${version}.sqlite`);
  assert.equal(restoreDatabase(backup, restored).schema_version, version);
  const reopened = new Platform(restored, f.clock);
  t.after(() => reopened.close());
  assert.equal(validateDatabase(restored).schema_version, WORLD_CONTENT_SCHEMA_VERSION);
  assert.equal(reopened.get('SELECT kind FROM journey_crops WHERE agent_id=?', f.alice.id).kind, 'herbs');
  assert.equal(reopened.get('SELECT grant_id FROM frontier_blocks WHERE creator_agent_id=?', f.bob.id).grant_id, f.grant.id);
});

test('unsupported legacy content refuses migration and rolls back schema, records and version', async (t) => {
  const f = await fixture(t);
  f.platform.close();
  legacyChecks(f.database, 26, { unsupported: true });
  const db = new DatabaseSync(f.database), before = rows(db), beforeSchema = schema(db);
  db.close();
  assert.throws(() => openDatabase(f.database), /cannot be upgraded without removing unsupported content/);
  const after = new DatabaseSync(f.database);
  t.after(() => after.close());
  assert.deepEqual(rows(after), before);
  assert.deepEqual(schema(after), beforeSchema);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 26);
  assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.throws(() => validateDatabase(f.database), /world content constraints/);
});

test('an interruption after a table copy restores the original tables, guards, records and schema version', async (t) => {
  const f = await savedWorld(t, 26);
  const db = new DatabaseSync(f.database), before = rows(db), beforeSchema = schema(db);
  db.close();
  const exec = DatabaseSync.prototype.exec;
  let rebuilt = false;
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (sql.includes('ALTER TABLE "journey_crops_v27" RENAME TO "journey_crops"')) {
      rebuilt = true;
      throw new Error('Injected interruption after the first table rebuild.');
    }
    return result;
  };
  try { assert.throws(() => openDatabase(f.database), /Injected interruption/); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(rebuilt, true, 'the interruption reached the real rebuild, after copying saved data');
  const after = new DatabaseSync(f.database);
  t.after(() => after.close());
  assert.deepEqual(rows(after), before);
  assert.deepEqual(schema(after), beforeSchema);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 26);
  assert.equal(validateDatabase(f.database).schema_version, 26);
});

test('content drift in an already-current world requires another migration and never rewrites its constraints silently', async (t) => {
  const f = await fixture(t);
  f.platform.close();
  legacyChecks(f.database, WORLD_CONTENT_SCHEMA_VERSION);
  const db = new DatabaseSync(f.database), before = schema(db);
  db.close();
  assert.throws(() => openDatabase(f.database), /Stored world content constraints are incomplete/);
  assert.throws(() => validateDatabase(f.database), /world content constraints/);
  const after = new DatabaseSync(f.database);
  t.after(() => after.close());
  assert.deepEqual(schema(after), before);
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, WORLD_CONTENT_SCHEMA_VERSION);
});
