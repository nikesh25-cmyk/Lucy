import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '../src/platform.js';
import { journeyMethods, RESOURCE_OFFER_SCHEMA } from '../src/journey.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';
import { fixture } from './helpers.js';

Object.assign(Platform.prototype, journeyMethods);

const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);

test('an exchange survives a backup and restore, and a schema 19 database migrates forward', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 4);
  const offer = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 2 } }, 'p-mig');
  f.tx('offerAccept', f.actor('bob'), { offer_id: offer.id }, 'a-mig');
  const directory = mkdtempSync(join(tmpdir(), 'nemoworld-offer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backup = join(directory, 'backup.sqlite');
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 24);
  const restored = restoreDatabase(backup, join(directory, 'restored.sqlite'));
  assert.equal(restored.schema_version, 24);
  const reopened = new Platform(join(directory, 'restored.sqlite'), f.clock);
  t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT status FROM resource_offers WHERE id=?', offer.id).status, 'accepted');
  assert.equal(reopened.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', bob.id, 'herbs').quantity, 2);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM resource_offer_events WHERE offer_id=?', offer.id).n, 2);
  assert.equal(reopened.verifyAudit(), true);
  // A schema 19 database has no offer layer: it migrates forward, empty, without touching the world.
  f.platform.close();
  const legacy = new DatabaseSync(f.database);
  legacy.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER resource_offers_validate_insert; DROP TRIGGER resource_offers_lifecycle; DROP TRIGGER resource_offer_events_no_update; DROP TRIGGER resource_offer_events_no_delete; DROP TABLE resource_offer_events; DROP TABLE resource_offers; PRAGMA user_version=19');
  legacy.close();
  assert.equal(validateDatabase(f.database).schema_version, 19, 'a pre-change database is still a valid schema 19 database');
  const migrated = new Platform(f.database, f.clock);
  t.after(() => migrated.close());
  assert.equal(validateDatabase(f.database).schema_version, 24);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM resource_offer_events').n, 0);
  assert.equal(migrated.verifyAudit(), true);
  // The recreated layer is immediately usable again.
  const actor = migrated.authenticate(f.credentials.alice.token);
  const next = migrated.transaction(() => migrated.offerCreate(actor, { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 1 } }, 'p-next'));
  assert.equal(next.status, 'proposed');
  assert.equal(validateDatabase(f.database).schema_version, 24);
});

test('recovery re-checks a stored offer: a duplicated settlement fails validation', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 2);
  const offer = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 2 } }, 'p-tamper');
  f.tx('offerAccept', f.actor('bob'), { offer_id: offer.id }, 'a-tamper');
  assert.equal(validateDatabase(f.database).schema_version, 24);
  // Two settlement events would mean the escrow settled twice; recovery refuses it.
  f.platform.run('INSERT INTO resource_offer_events VALUES(?,?,?,?,?,?)', 'dup', offer.id, f.actor('bob').account.id, 'accepted', '', 0);
  assert.throws(() => validateDatabase(f.database), /history is invalid/);
});

test('recovery refuses a negative shelf even if storage lost the CHECK', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  stock(f, alice, 'herbs', 2);
  f.platform.db.exec('PRAGMA ignore_check_constraints=ON');
  try { f.platform.run('UPDATE journey_inventory SET quantity=-1 WHERE agent_id=? AND kind=?', alice.id, 'herbs'); }
  finally { f.platform.db.exec('PRAGMA ignore_check_constraints=OFF'); }
  assert.equal(f.platform.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', alice.id, 'herbs').quantity, -1, 'the fixture really stored a negative shelf');
  assert.throws(() => validateDatabase(f.database), /resident inventory is invalid/);
});

test('an offer database that lost a protection fails validation', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 1);
  f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 1 } }, 'p-guard');
  assert.equal(validateDatabase(f.database).schema_version, 24);
  f.platform.db.exec('DROP TRIGGER resource_offers_lifecycle');
  assert.throws(() => validateDatabase(f.database), /protections are incomplete/);
  f.platform.db.exec(RESOURCE_OFFER_SCHEMA);
  assert.equal(validateDatabase(f.database).schema_version, 24);
});
