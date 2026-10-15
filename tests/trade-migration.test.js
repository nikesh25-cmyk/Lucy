import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Platform } from '../src/platform.js';
import { ensureTradeMarket } from '../src/trade-market.js';
import { verifyTradeRecords } from '../src/trade-board.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';
import { fixture } from './helpers.js';

const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const tables = (platform) => new Set(platform.all("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
const version = (platform) => platform.get('PRAGMA user_version').user_version;

test('schema 22 without a board migrates to schema 23 without losing existing records', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  stock(f, alice, 'herbs', 3);
  const before = {
    accounts: f.platform.get('SELECT COUNT(*) AS n FROM accounts').n,
    agents: f.platform.get('SELECT COUNT(*) AS n FROM agents').n,
    audit: f.platform.get('SELECT COUNT(*) AS n FROM audit').n,
  };
  f.platform.close();
  // Reconstruct a pre-board schema-22 file from the populated fixture. Removing the empty tables
  // leaves its accounts, avatars, inventory, land and audit rows intact.
  const old = new DatabaseSync(f.database);
  old.exec('PRAGMA foreign_keys=OFF; DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases; DROP TABLE trade_claim_units; DROP TABLE trade_claims; DROP TABLE trade_events; DROP TABLE trade_terms; DROP TABLE trade_listings; PRAGMA user_version=22;');
  old.close();
  assert.equal(validateDatabase(f.database).schema_version, 22, 'legacy backups remain accepted');
  const restoredPath = join(f.directory, 'schema-22-restored.sqlite');
  assert.equal(restoreDatabase(f.database, restoredPath).schema_version, 22, 'a schema-22 backup without trade tables restores');
  const migrated = new Platform(restoredPath, f.clock);
  t.after(() => migrated.close());
  assert.equal(version(migrated), 26);
  for (const name of ['trade_listings', 'trade_terms', 'trade_claims', 'trade_claim_units', 'trade_events']) assert.equal(tables(migrated).has(name), true, name);
  assert.equal(validateDatabase(restoredPath).schema_version, 26);
  assert.deepEqual({ accounts: migrated.get('SELECT COUNT(*) AS n FROM accounts').n, agents: migrated.get('SELECT COUNT(*) AS n FROM agents').n, audit: migrated.get('SELECT COUNT(*) AS n FROM audit').n }, before);
  assert.equal(migrated.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', alice.id, 'herbs').quantity, 3);
  const posted = migrated.transaction(() => migrated.tradePost(migrated.authenticate(f.credentials.alice.token), { agent_id: alice.id, items: { herbs: 2 } }, 'migrate-post'));
  assert.equal(posted.status, 'open');
  assert.equal(verifyTradeRecords(migrated), true);
});

test('schema 22 with a populated trade board migrates without changing its ledger', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 3);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 3 } }, 'pre23-post');
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 1 } }, 'pre23-claim');
  const records = Object.fromEntries(['trade_listings', 'trade_terms', 'trade_claims', 'trade_claim_units', 'trade_events'].map((name) => [name, f.platform.all(`SELECT * FROM ${name}`)]));
  f.platform.close();
  const old = new DatabaseSync(f.database);
  old.exec('DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases; PRAGMA user_version=22');
  old.close();
  assert.equal(validateDatabase(f.database).schema_version, 22);
  const migrated = new Platform(f.database, f.clock);
  t.after(() => migrated.close());
  assert.equal(version(migrated), 26);
  for (const [name, rows] of Object.entries(records)) assert.deepEqual(migrated.all(`SELECT * FROM ${name}`), rows, name);
  assert.equal(migrated.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', bob.id, 'herbs').quantity, 1);
  assert.equal(migrated.get('SELECT id FROM trade_claims WHERE id=?', claim.id).id, claim.id);
  assert.equal(validateDatabase(f.database).schema_version, 26);
});

test('a listed exchange survives close, reopen, backup and restore, and settles on expiry once', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), reviewer = f.agent('reviewer');
  stock(f, alice, 'herbs', 4);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 4 }, expires_minutes: 60 }, 'persist-post');
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 1 } }, 'persist-claim');
  const directory = mkdtempSync(join(tmpdir(), 'nemoworld-trade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backup = join(directory, 'backup.sqlite');
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 26, 'recovery accepts a database that carries the board');
  // A process restart reads the same listing, terms, claim and ledger back.
  f.platform.close();
  const reopened = new Platform(f.database, f.clock);
  t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT status FROM trade_listings WHERE id=?', listing.id).status, 'open');
  assert.deepEqual({ ...reopened.get('SELECT offered,taken FROM trade_terms WHERE listing_id=? AND kind=?', listing.id, 'herbs') }, { offered: 4, taken: 1 });
  assert.deepEqual({ ...reopened.get('SELECT claimer_agent_id,claim_key FROM trade_claims WHERE id=?', claim.id) }, { claimer_agent_id: bob.id, claim_key: 'persist-claim' });
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM trade_events WHERE listing_id=?', listing.id).n, 2);
  assert.equal(reopened.verifyAudit(), true);
  assert.equal(verifyTradeRecords(reopened), true);
  // A replayed claim is answered from the stored row without crediting again.
  const actor = reopened.authenticate(f.credentials.bob.token);
  const replayed = reopened.transaction(() => reopened.tradeClaim(actor, { agent_id: bob.id, listing_id: listing.id, items: { herbs: 1 } }, 'persist-claim'));
  assert.equal(replayed.repeated, true);
  assert.equal(reopened.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', bob.id, 'herbs').quantity, 1);
  // Time passes the stated life: the listing settles once on the tick and returns only what was left.
  f.advance(61 * 60_000);
  assert.equal(reopened.transaction(() => reopened.tradeExpire()), 1);
  assert.equal(reopened.transaction(() => reopened.tradeExpire()), 0, 'a second expiry settles nothing again');
  assert.equal(reopened.get('SELECT status FROM trade_listings WHERE id=?', listing.id).status, 'expired');
  assert.deepEqual(JSON.parse(reopened.get('SELECT returned FROM trade_listings WHERE id=?', listing.id).returned), { herbs: 3 });
  assert.equal(reopened.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', alice.id, 'herbs').quantity, 3);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM trade_events WHERE listing_id=? AND action=?', listing.id, 'expired').n, 1);
  assert.equal(verifyTradeRecords(reopened), true);
  // The restored copy is the same board, and it still balances.
  const restored = restoreDatabase(backup, join(directory, 'restored.sqlite'));
  assert.equal(restored.schema_version, 26);
  const copy = new Platform(join(directory, 'restored.sqlite'), f.clock);
  t.after(() => copy.close());
  assert.equal(copy.get('SELECT status FROM trade_listings WHERE id=?', listing.id).status, 'open', 'the backup holds the open listing as it was taken');
  assert.deepEqual({ ...copy.get('SELECT offered,taken FROM trade_terms WHERE listing_id=? AND kind=?', listing.id, 'herbs') }, { offered: 4, taken: 1 });
  assert.equal(verifyTradeRecords(copy), true);
  // The clock has already passed that listing's stated life, so the restored board refuses to claim
  // it and settles it back to its poster instead.
  const restoredActor = copy.authenticate(f.credentials.reviewer.token);
  assert.throws(() => copy.transaction(() => copy.tradeClaim(restoredActor, { agent_id: reviewer.id, listing_id: listing.id }, 'restore-claim')), /expired|cannot be claimed/);
  assert.equal(copy.transaction(() => copy.tradeExpire()), 1);
  assert.deepEqual(JSON.parse(copy.get('SELECT returned FROM trade_listings WHERE id=?', listing.id).returned), { herbs: 3 });
  assert.equal(copy.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', alice.id, 'herbs').quantity, 3);
  assert.equal(verifyTradeRecords(copy), true);
  // The restored board is immediately usable again: a new listing is posted and claimed on it.
  copy.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'fiber',2)", reviewer.id);
  const next = copy.transaction(() => copy.tradePost(restoredActor, { agent_id: reviewer.id, items: { fiber: 2 } }, 'restore-post'));
  assert.equal(next.status, 'open');
  const taken = copy.transaction(() => copy.tradeClaim(copy.authenticate(f.credentials.bob.token), { agent_id: bob.id, listing_id: next.id }, 'restore-claim-2'));
  assert.equal(taken.listing.status, 'filled');
  assert.deepEqual(taken.items, { fiber: 2 });
  assert.equal(copy.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', bob.id, 'fiber').quantity, 2);
  assert.equal(verifyTradeRecords(copy), true);
  assert.equal(copy.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a board that lost a protection or a row fails the startup check', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  ensureTradeMarket(f.platform);
  stock(f, alice, 'herbs', 1);
  f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 1 } }, 'guard-post');
  f.platform.close();
  // A listing whose terms were removed can no longer account for what it escrowed.
  const tampered = new DatabaseSync(f.database);
  tampered.exec('PRAGMA foreign_keys=OFF; DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases; DROP TRIGGER trade_terms_no_delete; DELETE FROM trade_terms;');
  tampered.close();
  assert.throws(() => new Platform(f.database, f.clock), /Stored trade board schema is incomplete/);
  assert.throws(() => validateDatabase(f.database), /trade board schema is incomplete/);
});

test('a same-named weakened trade trigger cannot pass backup validation', async (t) => {
  const f = await fixture(t);
  f.platform.close();
  const tampered = new DatabaseSync(f.database);
  tampered.exec('DROP TRIGGER trade_terms_no_delete; CREATE TRIGGER trade_terms_no_delete BEFORE DELETE ON trade_terms BEGIN SELECT 1; END;');
  tampered.close();
  assert.throws(() => validateDatabase(f.database), /trade board schema is incomplete/);
  assert.throws(() => new Platform(f.database, f.clock), /Stored trade board schema is incomplete/);
});
