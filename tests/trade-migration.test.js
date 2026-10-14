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

test('a schema 22 database gains the board additively, without a version bump', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 3);
  // The database the platform opens is the shipped schema 22: the board is not part of it yet, and
  // every existing record is already in place.
  assert.equal(version(f.platform), 22);
  for (const name of ['trade_listings', 'trade_terms', 'trade_claims', 'trade_claim_units', 'trade_events']) assert.equal(tables(f.platform).has(name), false, name);
  assert.equal(validateDatabase(f.database).schema_version, 22);
  const before = { accounts: f.platform.get('SELECT COUNT(*) AS n FROM accounts').n, agents: f.platform.get('SELECT COUNT(*) AS n FROM agents').n, audit: f.platform.get('SELECT COUNT(*) AS n FROM audit').n };
  f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 3 } }, 'migrate-post');
  // Starting the process adds the tables; the version still says 22, and recovery still validates it.
  ensureTradeMarket(f.platform);
  for (const name of ['trade_listings', 'trade_terms', 'trade_claims', 'trade_claim_units', 'trade_events']) assert.equal(tables(f.platform).has(name), true, name);
  assert.equal(version(f.platform), 22, 'the board is additive inside schema 22; no version is claimed here');
  assert.equal(validateDatabase(f.database).schema_version, 22);
  assert.deepEqual({ accounts: f.platform.get('SELECT COUNT(*) AS n FROM accounts').n, agents: f.platform.get('SELECT COUNT(*) AS n FROM agents').n, audit: f.platform.get('SELECT COUNT(*) AS n FROM audit').n >= before.audit }, { accounts: before.accounts, agents: before.agents, audit: true });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(verifyTradeRecords(f.platform), true);
  // A database that already carries the board keeps it: opening the layer twice is a no-op.
  ensureTradeMarket(f.platform);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_listings').n, 1);
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
  assert.equal(validateDatabase(backup).schema_version, 22, 'recovery accepts a database that carries the board');
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
  assert.equal(restored.schema_version, 22);
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
  tampered.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER trade_terms_no_delete; DELETE FROM trade_terms;');
  tampered.close();
  const reopened = new Platform(f.database, f.clock);
  t.after(() => reopened.close());
  assert.equal(verifyTradeRecords(reopened), false);
  assert.throws(() => ensureTradeMarket(reopened), /Stored trade board records are invalid/);
});
