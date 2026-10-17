import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';
import { verifyKarmaLedger } from '../src/karma.js';
import { getWorldDefinition, walkable } from '../world.js';

// The Karma Coins economy and the shop were built against an older schema and merged onto schema 25
// (the resident vault) as schema 26. These tests prove what that merge has to keep true on the real
// current database: the real ledger sits under the real shop, an account export carries only the
// operator's own records, a deleted account leaves a ledger that still verifies, a backup restores,
// and a schema-25 world opens and gains the additive tables without touching anything else.

const KARMA_OBJECTS = 'DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases;';
const freeTiles = (worldId) => {
  const definition = getWorldDefinition(worldId), tiles = [];
  for (let y = 2; y < definition.rows - 2; y += 1) for (let x = 2; x < definition.columns - 2; x += 1) {
    if (!walkable({ x, y }, definition)) continue;
    if (Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) <= 2) continue;
    if ((definition.portals || []).some((portal) => Math.abs(portal.x - x) + Math.abs(portal.y - y) <= 2)) continue;
    tiles.push({ x, y });
  }
  return tiles;
};

// Two planted crops and two saved garden objects: four saved acts, eight Karma Coins once settled.
function earnEight(f, owner) {
  const resident = f.agent(owner), actor = f.actor(owner), garden = `home:${resident.id}`;
  f.tx('travel', actor, resident.id, { world_id: garden });
  const [farmOne, farmTwo, bench, lantern] = freeTiles(garden);
  f.tx('build', actor, resident.id, { x: farmOne.x, y: farmOne.y, type: 'farm' });
  f.tx('gardenAction', actor, { agent_id: resident.id, action: 'plant', kind: 'herbs', x: farmOne.x, y: farmOne.y });
  f.tx('build', actor, resident.id, { x: farmTwo.x, y: farmTwo.y, type: 'farm' });
  f.tx('gardenAction', actor, { agent_id: resident.id, action: 'plant', kind: 'fiber', x: farmTwo.x, y: farmTwo.y });
  f.tx('build', actor, resident.id, { x: bench.x, y: bench.y, type: 'bench' });
  f.tx('build', actor, resident.id, { x: lantern.x, y: lantern.y, type: 'lantern' });
  assert.equal(f.tx('karmaSettle', actor, { agent_id: resident.id }).balance, 8);
  return resident;
}

test('the real ledger sits under the real shop: a purchase debits once and an overfull shelf refuses it whole', async (t) => {
  const f = await fixture(t), alice = earnEight(f, 'alice'), actor = f.actor('alice');
  const bought = f.tx('shopPurchase', actor, { good_id: 'herbs', agent_id: alice.id }, 'integration-key-1');
  assert.equal(bought.price, 8);
  assert.equal(bought.balance_after, 0);
  assert.equal(f.platform.karmaWallet(actor, { agent_id: alice.id }).balance, 0);
  assert.equal(f.platform.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", alice.id).quantity, 2);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1);
  assert.equal(verifyKarmaLedger(f.platform.db), true);

  // A grant the shelf cannot hold fails after the debit has been written, so the whole request must
  // roll back: no Karma spent, no purchase row. Earn again on the next UTC day to be able to pay.
  f.advance(25 * 3_600_000);
  const [a, b, c, d] = freeTiles(`home:${alice.id}`).slice(8, 12);
  for (const [tile, type] of [[a, 'bench'], [b, 'lantern']]) f.tx('build', actor, alice.id, { x: tile.x, y: tile.y, type });
  for (const tile of [c, d]) {
    f.tx('build', actor, alice.id, { x: tile.x, y: tile.y, type: 'farm' });
    f.tx('gardenAction', actor, { agent_id: alice.id, action: 'plant', kind: 'herbs', x: tile.x, y: tile.y });
  }
  f.tx('karmaSettle', actor, { agent_id: alice.id });
  const before = f.platform.karmaWallet(actor, { agent_id: alice.id }).balance;
  assert.ok(before >= 8, 'a second day of saved service pays for another purchase');
  f.platform.run("UPDATE journey_inventory SET quantity=999 WHERE agent_id=? AND kind='herbs'", alice.id);
  const purchases = f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n;
  assert.throws(() => f.tx('shopPurchase', actor, { good_id: 'herbs', agent_id: alice.id }, 'integration-key-2'), (error) => error.status === 409);
  assert.equal(f.platform.karmaWallet(actor, { agent_id: alice.id }).balance, before, 'a refused grant returns the Karma');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, purchases);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1);
  assert.equal(f.platform.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", alice.id).quantity, 999);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('the account export carries only the operator’s own Karma and shop records, without chain hashes or keys', async (t) => {
  const f = await fixture(t), alice = earnEight(f, 'alice'), actor = f.actor('alice');
  f.tx('shopPurchase', actor, { good_id: 'herbs', agent_id: alice.id }, 'export-key-1');
  const exported = f.platform.exportAccount(actor);
  assert.equal(exported.karma.receipts.length, 4);
  assert.equal(exported.karma.purchases.length, 1);
  assert.equal(exported.karma.balance, 0);
  assert.equal(exported.karma.integrity_valid, true);
  assert.equal(exported.shop.purchases.length, 1);
  assert.equal(exported.shop.purchases[0].good_id, 'herbs');
  assert.deepEqual(exported.shop.purchases[0].granted, { category: 'resource', kind: 'herbs', quantity: 2 });
  assert.doesNotMatch(JSON.stringify({ karma: exported.karma, shop: exported.shop }), /"hash"|"previous_hash"|"token"|"idempotency_key"|"key"|"fingerprint"/);
  const other = f.platform.exportAccount(f.actor('bob'));
  assert.deepEqual(other.karma.receipts, []);
  assert.deepEqual(other.karma.purchases, []);
  assert.deepEqual(other.shop.purchases, []);
  // A resident credential is not the operator: it cannot read the export surface of the purse either.
  assert.throws(() => f.platform.karmaExport({ kind: 'runtime', account: actor.account }), (error) => error.status === 403);
});

test('a deleted account leaves a ledger that still verifies, a wallet nobody can reach and a purse nobody can spend', async (t) => {
  const f = await fixture(t), alice = earnEight(f, 'alice'), actor = f.actor('alice');
  f.tx('deleteAccount', actor);
  // The receipts are append-only and the account row is only blanked, so the chain is intact.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=?', actor.account.id).n, 4);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  assert.equal(validateDatabase(f.database).schema_version, 27);
  assert.throws(() => f.platform.karmaWallet(actor, { agent_id: alice.id }), (error) => [403, 404].includes(error.status));
  const spend = f.platform.karmaSpend(actor, { amount: 8, good_id: 'herbs', key: 'after-deletion' });
  assert.equal(spend.ok, false, 'a deleted operator cannot spend');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 0);
  // Nothing the deletion did reached another operator's purse.
  const bob = f.agent('bob');
  assert.equal(f.platform.karmaWallet(f.actor('bob'), { agent_id: bob.id }).balance, 0);
});

test('a backup restores at schema 26 with its ledger, and a schema 25 world gains the additive tables and nothing else', async (t) => {
  const f = await fixture(t), alice = earnEight(f, 'alice'), actor = f.actor('alice');
  f.tx('shopPurchase', actor, { good_id: 'herbs', agent_id: alice.id }, 'backup-key-1');
  const backup = join(f.directory, 'karma-backup.sqlite');
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version, 27);
  const reopened = new Platform(backup, () => f.clock());
  t.after(() => reopened.close());
  assert.equal(reopened.karmaWallet(reopened.authenticate(f.credentials.alice.token), { agent_id: alice.id }).balance, 0);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 1);

  // The same world as a schema-25 database: the Karma and shop objects removed, nothing else changed.
  const older = join(f.directory, 'schema-25.sqlite');
  backupDatabase(f.platform.db, older);
  const legacy = new DatabaseSync(older);
  legacy.exec(`PRAGMA foreign_keys=OFF; ${KARMA_OBJECTS} PRAGMA user_version=25;`);
  const accounts = legacy.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  legacy.close();
  assert.equal(validateDatabase(older).schema_version, 25, 'a schema-25 database is still accepted');
  const migrated = new Platform(older, () => f.clock());
  t.after(() => migrated.close());
  assert.equal(migrated.get('PRAGMA user_version').user_version, 27);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM accounts').n, accounts);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM karma_receipts').n, 0, 'migration never mints a receipt');
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 0);
  assert.equal(verifyKarmaLedger(migrated.db), true);
  assert.equal(migrated.verifyAudit(), true);
});

test('a private cottage is not a shared place: visiting it earns nothing, and it cannot be visited at all', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `house:${bob.id}`, alice.id);
  assert.throws(() => f.tx('recordVisit', f.actor('alice'), alice.id, `house:${bob.id}`), (error) => error.status === 403);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM karma_source_events WHERE service_id='shared_space_visit'").n, 0);
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).minted, 0);
});
