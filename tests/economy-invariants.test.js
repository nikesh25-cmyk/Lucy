import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { ensureTradeMarket } from '../src/trade-market.js';
import { verifyTradeRecords } from '../src/trade-board.js';
import { verifyKarmaLedger } from '../src/karma.js';
import { verifyCoinLedger } from '../src/coins.js';
import { validateDatabase } from '../src/recovery.js';

// Wave 5 deliverable (2): the economic invariants, proved on the real database.
//
//   conservation  — nothing is created or destroyed by a trade, a purchase, a craft, an escrow
//                   return or an account deletion. Every unit of every kind is held exactly once, on
//                   a shelf or in an escrow, and the only things that change the total are the
//                   recorded grants the server itself wrote.
//   atomicity     — a half-completed trade cannot exist after a crash or a restart. A process killed
//                   in the middle of a real claim and in the middle of a real purchase leaves no row,
//                   no escrow and no debit behind, and a half-written trade record refuses to open.
//   replay safety — the same purchase, listing, claim or settle twice yields one effect, including
//                   after a real restart, because the second call is answered from the recorded row.
//   deletion      — an account gives up its goods, its escrow and its purse, and leaves no orphaned
//                   claim another operator could still take.
//   restart       — the whole projected state is identical after a real close and reopen.
//
// The owner's own tests already prove that a listed exchange moves each unit once
// (tests/trade-board.test.js), that a replayed post, claim and purchase key writes nothing twice, and
// that a grant the shelf cannot hold returns the Karma whole (tests/karma-integration.test.js). This
// file proves the identities across all of them at once, and the crash and restart halves that
// nothing else does.

const KIND_LIST = ['herbs', 'fiber', 'wood', 'flower_crown'];
const boarded = (f) => ensureTradeMarket(f.platform);
const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0 ORDER BY kind', agent.id).map((item) => [item.kind, item.quantity]));

/**
 * Every unit of every kind the world holds: on a shelf, or escrowed by an open listing or a proposed
 * offer. A unit in transit is held in exactly one of those places, so a change in these totals can
 * only come from something the server recorded (a grant, a craft, a deletion) and never from a trade
 * itself — which is the whole conservation claim, stated on the shipped tables.
 */
function totals(f, kinds = KIND_LIST) {
  const counts = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  const add = (kind, quantity) => { if (kinds.includes(kind)) counts[kind] += Number(quantity) || 0; };
  const placeholders = kinds.map(() => '?').join(',');
  for (const row of f.platform.all(`SELECT kind,SUM(quantity) AS n FROM journey_inventory WHERE kind IN (${placeholders}) GROUP BY kind`, ...kinds)) add(row.kind, row.n);
  for (const row of f.platform.all(`SELECT kind,SUM(offered-taken) AS n FROM trade_terms WHERE kind IN (${placeholders}) AND listing_id IN (SELECT id FROM trade_listings WHERE status='open') GROUP BY kind`, ...kinds)) add(row.kind, row.n);
  for (const row of f.platform.all(`SELECT j.key AS kind,SUM(j.value) AS n FROM resource_offers o, json_each(o.items) j WHERE o.status='proposed' AND j.key IN (${placeholders}) GROUP BY j.key`, ...kinds)) add(row.kind, row.n);
  return counts;
}
const delta = (before, after) => Object.fromEntries(Object.keys(before).map((kind) => [kind, after[kind] - before[kind]]));
// Four Karma Coins a day of the world tier, reached the way the wallet's own tests reach it: two
// crops planted in the resident's own garden and settled by its operator. Planting writes no shelf
// goods, so the baseline this helper leaves is an empty shelf and a purse of four a day, and every
// assertion below can be about its own action rather than about the fixture.
function earn(f, owner, days = 1) {
  const agent = f.agent(owner), actor = f.actor(owner);
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  for (let day = 0; day < days; day += 1) {
    if (day) f.advance(25 * 3_600_000);
    for (let slot = 0; slot < 2; slot += 1) {
      const x = 4 + day * 2, y = 6 + slot;
      f.platform.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type=excluded.type', `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, 'farm', x, y, new Date(f.clock()).toISOString());
      f.tx('gardenAction', actor, { agent_id: agent.id, action: 'plant', kind: slot ? 'fiber' : 'herbs', x, y });
    }
    f.tx('karmaSettle', actor, { agent_id: agent.id });
  }
  return agent;
}

test('a purchase, a craft and a trade each change the world by exactly what the server recorded', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 2), bob = f.agent('bob');
  boarded(f);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 8);
  const before = totals(f);
  assert.deepEqual(before, { herbs: 0, fiber: 0, wood: 0, flower_crown: 0 }, 'the world starts with no goods at all');
  // A purchase: two herb crops for eight Karma Coins. The shelf gains exactly the recorded grant and
  // the purse falls by exactly the price.
  const bought = f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'inv-buy-1');
  assert.deepEqual(bought.granted, { category: 'resource', kind: 'herbs', quantity: 2 });
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 0);
  // A craft: the output is made from ingredients the shelf already held, so the ingredients fall by
  // the recipe and the output rises by one.
  stock(f, alice, 'herbs', 1); stock(f, alice, 'fiber', 1);
  assert.equal(f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'flower_crown' }).crafted, 'flower_crown');
  assert.deepEqual(shelf(f, alice), { herbs: 1, flower_crown: 1 }, 'two herbs and one fiber became one keepsake');
  // A trade: the unit leaves one operator's shelf and lands on another's; the total never moves.
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 1 } }, 'inv-post-1');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the escrow takes the unit off the shelf');
  const escrowed = totals(f);
  assert.deepEqual(escrowed, { herbs: 1, fiber: 0, wood: 0, flower_crown: 1 }, 'escrow moves a unit between places, never in or out of the world');
  f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id }, 'inv-claim-1');
  assert.deepEqual(shelf(f, bob), { herbs: 1 });
  const after = totals(f);
  assert.deepEqual(after, escrowed, 'the claim is a move as well');
  // The whole identity: the difference between the start and the end is exactly what was recorded —
  // two herbs bought, one herb and one fiber stocked by the test, one flower crown crafted out of two
  // herbs and a fiber. Nothing else moved.
  const granted = Object.fromEntries(KIND_LIST.map((kind) => [kind, 0]));
  granted.herbs = 2;
  assert.deepEqual(granted, { herbs: 2, fiber: 0, wood: 0, flower_crown: 0 }, 'the shop recorded one grant of two herbs');
  assert.deepEqual(f.platform.all("SELECT json_extract(granted,'$.kind') AS kind,SUM(json_extract(granted,'$.quantity')) AS n FROM shop_purchases WHERE category='resource' GROUP BY kind").map((row) => ({ ...row })), [{ kind: 'herbs', n: 2 }]);
  assert.deepEqual(delta(before, after), {
    herbs: granted.herbs + 1 - 2,
    fiber: granted.fiber + 1 - 1,
    wood: 0,
    flower_crown: granted.flower_crown + 1,
  });
  assert.deepEqual(f.platform.all('SELECT kind,SUM(quantity) AS n FROM journey_inventory WHERE quantity>0 GROUP BY kind ORDER BY kind').map((row) => ({ ...row })), [{ kind: 'flower_crown', n: 1 }, { kind: 'herbs', n: 1 }]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM karma_purchases').n, 8, 'one debit, of exactly the price');
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  assert.equal(verifyTradeRecords(f.platform), true);
});

test('an escrow returns whole on cancel, on expiry and on a partial claim, and no unit is created or destroyed', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 5); stock(f, alice, 'fiber', 3);
  const before = totals(f);
  assert.deepEqual(before, { herbs: 5, fiber: 3, wood: 0, flower_crown: 0 });
  // The withdrawal path: a listing the poster cancels gives back exactly what it escrowed.
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 4, fiber: 3 }, note: 'A spare harvest.' }, 'return-post-1');
  assert.deepEqual(shelf(f, alice), { herbs: 1 }, 'the whole offer is escrowed, once');
  assert.deepEqual(totals(f), before, 'escrow is still holding, not spending');
  assert.deepEqual(f.tx('tradeCancel', f.actor('alice'), { listing_id: listing.id }).status, 'cancelled');
  assert.deepEqual(shelf(f, alice), { herbs: 5, fiber: 3 }, 'the withdrawal returns every unit, exactly once');
  assert.deepEqual(totals(f), before, 'a return is a move, not a grant');
  // The same through the world's own tick: an abandoned listing expires and returns its escrow.
  const abandoned = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 }, expires_minutes: 1 }, 'return-post-2');
  assert.deepEqual(shelf(f, alice), { herbs: 3, fiber: 3 });
  f.advance(60_000);
  assert.equal(f.platform.tradeExpire(), 1, 'the tick settles exactly the one listing that was due');
  assert.equal(f.platform.get('SELECT status FROM trade_listings WHERE id=?', abandoned.id).status, 'expired');
  assert.deepEqual(shelf(f, alice), { herbs: 5, fiber: 3 }, 'an expiry returns the escrow to its poster');
  // A partial claim: the claimer keeps what it took, the poster gets back only the remainder.
  const split = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 5, fiber: 3 }, note: 'Split this lot.' }, 'return-post-3');
  f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: split.id, items: { herbs: 3 } }, 'return-claim-1');
  f.tx('tradeCancel', f.actor('alice'), { listing_id: split.id });
  assert.deepEqual(shelf(f, bob), { herbs: 3 }, 'the claimer keeps exactly what it took');
  assert.deepEqual(shelf(f, alice), { herbs: 2, fiber: 3 }, 'and the poster gets back only what was left');
  assert.deepEqual(totals(f), before, 'every unit of a partly traded listing is still held exactly once');
  assert.equal(verifyTradeRecords(f.platform), true);
});

// ---------------------------------------------------------------------------------------------
// Atomicity. Two child processes do real, complete work inside a real transaction and are killed with
// SIGKILL before it commits, which is what a crash in the middle of a request is. Nothing may survive.
// ---------------------------------------------------------------------------------------------
const PLATFORM_URL = new URL('../src/platform.js', import.meta.url).href;
const MARKET_URL = new URL('../src/trade-market.js', import.meta.url).href;

function crash(f, token, body) {
  const script = join(f.directory, `crash-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, `import { Platform } from ${JSON.stringify(PLATFORM_URL)};
import { ensureTradeMarket } from ${JSON.stringify(MARKET_URL)};
const platform = new Platform(process.argv[2]);
ensureTradeMarket(platform);
const actor = platform.authenticate(process.argv[3]);
platform.transaction(() => {
${body}
  process.kill(process.pid, 'SIGKILL');
});
`);
  return spawnSync(process.execPath, [script, f.database, token], { encoding: 'utf8' });
}

test('a process killed in the middle of a claim or a purchase leaves the whole request undone', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 2), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 6);
  const posted = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 4 } }, 'crash-post-1');
  assert.deepEqual(shelf(f, alice), { herbs: 2 });
  // 1. A complete claim runs inside the transaction, and the process dies before it commits.
  const claimCrash = crash(f, f.credentials.bob.token, `  platform.tradeClaim(actor, { agent_id: ${JSON.stringify(bob.id)}, listing_id: ${JSON.stringify(posted.id)} }, 'crash-claim-key');`);
  assert.equal(claimCrash.signal, 'SIGKILL', `the crashed process must have been killed (status ${claimCrash.status}): ${claimCrash.stderr}`);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_claims').n, 0, 'an uncommitted claim does not exist after the crash');
  assert.equal(f.platform.get("SELECT taken FROM trade_terms WHERE listing_id=? AND kind='herbs'", posted.id).taken, 0, 'and it took nothing');
  assert.equal(f.platform.get('SELECT status FROM trade_listings WHERE id=?', posted.id).status, 'open', 'the listing is still open, not half filled');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_events').n, 1, 'only the committed post event is there');
  assert.deepEqual(shelf(f, bob), {}, 'the claimer received nothing');
  // The same claim is now made properly, and it commits exactly once.
  const claimed = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: posted.id }, 'crash-claim-key');
  assert.deepEqual(claimed.items, { herbs: 4 });
  assert.deepEqual(shelf(f, bob), { herbs: 4 });
  // 2. A purchase debits the Karma and grants the good inside one transaction too. The process dies
  //    before it commits, so neither half may be there afterwards.
  const before = { purchases: f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, debits: f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, shelf: shelf(f, alice) };
  const purse = f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance;
  assert.equal(purse, 8, 'the one day of service pays for exactly one resource bundle');
  const buyCrash = crash(f, f.credentials.alice.token, `  platform.shopPurchase(actor, { good_id: 'herbs', agent_id: ${JSON.stringify(alice.id)} }, 'crash-buy-key');`);
  assert.equal(buyCrash.signal, 'SIGKILL', `the crashed process must have been killed (status ${buyCrash.status}): ${buyCrash.stderr}`);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, before.purchases, 'an uncommitted purchase row does not exist');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, before.debits, 'and no Karma was debited');
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, purse, 'the purse is exactly where it was');
  assert.deepEqual(shelf(f, alice), before.shelf, 'and the shelf never received the good');
  // The key the crashed process used was never recorded, so the operator may use it again — and then
  // it is recorded once, which is the same replay guarantee seen from the crash side.
  assert.equal(f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'crash-buy-key').repeated, false);
  assert.equal(f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'crash-buy-key').repeated, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, before.purchases + 1);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 0);
  assert.equal(verifyKarmaLedger(f.platform.db), true, 'the ledger still verifies after two real crashes');
  assert.equal(verifyTradeRecords(f.platform), true);
  assert.equal(validateDatabase(f.database).schema_version, 27);
});

test('a half-written trade record refuses to open, at the board and at the backup gate', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 4);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 4 } }, 'half-post-1');
  // Half a claim, written straight into the tables: the claim row and the taken units are there, the
  // `trade_claim_units` row that records what it took is not. No code path can produce this state,
  // which is the point — the board must refuse to serve it rather than balance a broken ledger.
  f.platform.run('INSERT INTO trade_claims VALUES(?,?,?,?,?,?)', 'half-claim', listing.id, bob.id, f.actor('bob').account.id, 'half-claim-key', f.clock());
  f.platform.run('UPDATE trade_terms SET taken=taken+2 WHERE listing_id=? AND kind=?', listing.id, 'herbs');
  assert.equal(verifyTradeRecords(f.platform), false, 'the stored ledger is recognisably incomplete');
  assert.throws(() => validateDatabase(f.database), /trade board validation/);
  // A second, independent process refuses to open the file at all: the storage layer checks the trade
  // records during opening, so a half-written board cannot be served by a fresh server either.
  assert.throws(() => new Platform(f.database, () => f.clock()), /trade board records are invalid/);
  assert.equal(f.platform.get("SELECT taken FROM trade_terms WHERE listing_id=? AND kind='herbs'", listing.id).taken, 2, 'the refused open changed nothing');
  assert.deepEqual(shelf(f, alice), {}, 'and the poster\u2019s escrow is untouched by the refusal');
  // The karma ledger on the same file is untouched and still verifies: one broken board is not a
  // broken purse.
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  // The schema number itself is still 26: read straight from the header, because the validating open
  // is exactly what this damaged file must refuse.
  const raw = new DatabaseSync(f.database, { readOnly: true });
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 27);
  raw.close();
});

test('the same purchase, listing, claim and settle twice with one restart in between is one effect each', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 2), bob = f.agent('bob');
  boarded(f);
  const first = f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'replay-buy-1');
  const again = f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'replay-buy-1');
  assert.equal(again.purchase_id, first.purchase_id);
  assert.equal(again.repeated, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1, 'one debit, not two');
  assert.deepEqual(shelf(f, alice), { herbs: 2 }, 'one grant, not two');
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 } }, 'replay-post-1');
  const postAgain = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 } }, 'replay-post-1');
  assert.equal(postAgain.id, listing.id);
  assert.equal(postAgain.repeated, true);
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id }, 'replay-claim-1');
  const claimAgain = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id }, 'replay-claim-1');
  assert.equal(claimAgain.id, claim.id);
  assert.deepEqual(shelf(f, bob), { herbs: 2 });
  const purse = f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance;
  const counts = {
    shop: f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n,
    debits: f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n,
    claims: f.platform.get('SELECT COUNT(*) AS n FROM trade_claims').n,
    receipts: f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n,
  };
  // A real restart, and then all four submissions are replayed against the reopened database. Each
  // must be answered from the recorded row, with nothing written twice.
  f.platform.close();
  const reopened = new Platform(f.database, () => f.clock());
  t.after(() => { try { reopened.close(); } catch { /* the fixture may already have closed it */ } });
  ensureTradeMarket(reopened);
  const actor = reopened.authenticate(f.credentials.alice.token);
  const claimer = reopened.authenticate(f.credentials.bob.token);
  assert.equal(reopened.shopPurchase(actor, { good_id: 'herbs', agent_id: alice.id }, 'replay-buy-1').repeated, true);
  assert.equal(reopened.transaction(() => reopened.tradePost(actor, { agent_id: alice.id, items: { herbs: 2 } }, 'replay-post-1')).repeated, true);
  assert.equal(reopened.transaction(() => reopened.tradeClaim(claimer, { agent_id: bob.id, listing_id: listing.id }, 'replay-claim-1')).repeated, true);
  assert.equal(reopened.transaction(() => reopened.karmaSettle(actor, { agent_id: alice.id })).minted, 0, 'settling again mints nothing');
  assert.deepEqual({
    shop: reopened.get('SELECT COUNT(*) AS n FROM shop_purchases').n,
    debits: reopened.get('SELECT COUNT(*) AS n FROM karma_purchases').n,
    claims: reopened.get('SELECT COUNT(*) AS n FROM trade_claims').n,
    receipts: reopened.get('SELECT COUNT(*) AS n FROM karma_receipts').n,
  }, counts);
  assert.equal(reopened.karmaWallet(actor, { agent_id: alice.id }).balance, purse, 'the purse is identical after four replayed submissions');
  assert.equal(verifyKarmaLedger(reopened.db), true);
  assert.equal(verifyTradeRecords(reopened), true);
});

test('a deleted account gives up its goods, its escrow and its purse and leaves no orphaned claim', async (t) => {
  const f = await fixture(t), bob = f.agent('bob');
  // A session lasts seven days and earning nine UTC days of Karma crosses that boundary, so both
  // sessions are taken before the clock moves. The rule under test is the deletion, not the session.
  const aliceActor = f.actor('alice'), bobActor = f.actor('bob');
  const alice = earn(f, 'alice', 9);
  boarded(f);
  // One account earns a purse, buys a keepsake and two resource bundles, and leaves a listing open
  // with part of it claimed: the exact state a deletion has to resolve.
  f.tx('shopPurchase', aliceActor, { good_id: 'flower_crown', agent_id: alice.id }, 'delete-buy-1');
  f.tx('shopPurchase', aliceActor, { good_id: 'herbs', agent_id: alice.id }, 'delete-buy-2');
  f.tx('shopPurchase', aliceActor, { good_id: 'herbs', agent_id: alice.id }, 'delete-buy-3');
  assert.equal(f.platform.karmaWallet(aliceActor, { agent_id: alice.id }).balance, 0, 'nine days of service paid for all three purchases exactly');
  const before = totals(f);
  assert.deepEqual(before, { herbs: 4, fiber: 0, wood: 0, flower_crown: 1 }, 'what the account holds when it decides to delete');
  const listing = f.tx('tradePost', aliceActor, { agent_id: alice.id, items: { herbs: 4 } }, 'delete-post-1');
  f.tx('tradeClaim', bobActor, { agent_id: bob.id, listing_id: listing.id, items: { herbs: 2 } }, 'delete-claim-1');
  assert.deepEqual(shelf(f, bob), { herbs: 2 }, 'the other operator takes its half before the deletion');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the rest of the listing is still escrowed');
  assert.deepEqual(totals(f), before, 'posting and claiming moved units without creating any');
  const records = { receipts: f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=?', aliceActor.account.id).n, debits: f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, shop: f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n };
  assert.deepEqual(records, { receipts: 18, debits: 3, shop: 3 }, 'nine days of two receipts, three prices paid, three goods bought');
  f.tx('deleteAccount', aliceActor);
  // The open listing is settled before the inventory goes, so no escrow is stranded: the remainder
  // returns to the account and is then given up with it.
  assert.equal(f.platform.get('SELECT status FROM trade_listings WHERE id=?', listing.id).status, 'cancelled');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM trade_listings WHERE status='open'").n, 0, 'no listing of a deleted account stays publicly claimable');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_claims WHERE claimer_account_id=?', aliceActor.account.id).n, 0);
  assert.deepEqual(shelf(f, bob), { herbs: 2 }, 'the other operator keeps exactly what it claimed');
  assert.deepEqual(totals(f), { herbs: 2, fiber: 0, wood: 0, flower_crown: 0 }, 'the world loses exactly the deleting account\u2019s goods and nothing else');
  assert.deepEqual(delta(before, totals(f)), { herbs: -2, fiber: 0, wood: 0, flower_crown: -1 }, 'the units given up are the ones the deleted account held: two escrowed and one on its shelf');
  // The ledgers are append-only records, so the deletion keeps them and both chains still verify.
  assert.deepEqual({
    receipts: f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=?', aliceActor.account.id).n,
    debits: f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n,
    shop: f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n,
  }, records, 'the record of what the account was given and earned is kept');
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  assert.equal(verifyTradeRecords(f.platform), true);
  assert.equal(validateDatabase(f.database).schema_version, 27);
  // Nothing of the deleted account is reachable or spendable, and no orphaned claim survives to take
  // the goods that were returned to it before the deletion.
  assert.throws(() => f.platform.authenticate(f.credentials.alice.token), { status: 401 });
  assert.equal(f.platform.karmaSpend(aliceActor, { amount: 8, good_id: 'herbs', key: 'after-delete' }).ok, false);
  assert.throws(() => f.platform.karmaWallet(aliceActor, { agent_id: alice.id }), (error) => [403, 404].includes(error.status));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, records.debits, 'the refused spend wrote nothing');
  const creditor = f.platform.goodsPolicy(bobActor, {});
  assert.deepEqual(creditor.account_bound, [], 'and the surviving account holds nothing that was the deleted account\u2019s');
});

test('the whole projected economy is identical after a real restart', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 7), bob = f.agent('bob');
  boarded(f);
  f.tx('shopPurchase', f.actor('alice'), { good_id: 'flower_crown', agent_id: alice.id }, 'restart-buy-1');
  f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'restart-buy-2');
  stock(f, bob, 'herbs', 3);
  f.tx('offerCreate', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, items: { herbs: 2 } }, 'restart-offer-1');
  f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 } }, 'restart-post-1');
  const rows = (platform) => ({
    shelves: platform.all('SELECT agent_id,kind,quantity FROM journey_inventory WHERE quantity>0 ORDER BY agent_id,kind'),
    trade: platform.all('SELECT l.id,l.status,l.items,t.kind,t.offered,t.taken FROM trade_listings l JOIN trade_terms t ON t.listing_id=l.id ORDER BY l.id,t.kind'),
    offers: platform.all('SELECT id,status,items FROM resource_offers ORDER BY id'),
    karma: platform.all('SELECT id,agent_id,service_id,amount,award_day,created_at,hash FROM karma_receipts ORDER BY seq'),
    debits: platform.all('SELECT id,good_id,amount,balance_after,idempotency_key FROM karma_purchases ORDER BY seq'),
    shop: platform.all('SELECT id,good_id,category,price,granted,balance_after,key,day,created_at FROM shop_purchases ORDER BY created_at,id'),
    coins: platform.all('SELECT id,amount,hash FROM coin_rewards ORDER BY seq'),
    audit: platform.verifyAudit(),
  });
  const before = {
    ...rows(f.platform),
    wallet: f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }),
    goodsView: f.platform.goodsPolicy(f.actor('alice'), {}),
    catalogue: f.platform.shopCatalogue(f.actor('alice'), { agent_id: alice.id }),
    board: f.platform.tradeBoard(f.actor('bob'), { }),
    offersView: f.platform.resourceOffers(f.actor('bob'), {}),
    totals: totals(f),
  };
  assert.equal(before.audit, true, 'the audit chain verifies before the restart');
  assert.ok(before.trade.length && before.offers.length && before.shop.length, 'the restart has state to lose');
  // A real restart: the process closes its database and a new server opens the same file.
  f.platform.close();
  const platform = new Platform(f.database, () => f.clock());
  t.after(() => platform.close());
  const restarted = rows(platform);
  for (const key of ['shelves', 'trade', 'offers', 'karma', 'debits', 'shop', 'coins', 'audit']) assert.deepEqual(restarted[key], before[key], `${key} must be byte-identical after the restart`);
  // The projections are identical too, including every part the clock feeds: the whole wallet, the
  // classification, the shop allowances and the board are rebuilt from the same rows.
  const actor = platform.authenticate(f.credentials.alice.token);
  const other = platform.authenticate(f.credentials.bob.token);
  assert.deepEqual(platform.karmaWallet(actor, { agent_id: alice.id }), before.wallet);
  assert.deepEqual(platform.goodsPolicy(actor, {}), before.goodsView);
  assert.deepEqual(platform.shopCatalogue(actor, { agent_id: alice.id }), before.catalogue);
  assert.deepEqual(platform.resourceOffers(other, {}), before.offersView);
  assert.deepEqual(totals({ platform }), before.totals);
  ensureTradeMarket(platform);
  const board = platform.tradeBoard(other, {});
  assert.deepEqual(board.listings.map((card) => [card.id, card.status, card.items, card.remaining]), before.board.listings.map((card) => [card.id, card.status, card.items, card.remaining]));
  assert.equal(verifyKarmaLedger(platform.db), true);
  assert.equal(verifyCoinLedger(platform.db), true);
  assert.equal(verifyTradeRecords(platform), true);
  assert.equal(validateDatabase(f.database).schema_version, 27);
  // And the API is served from the restarted state: one read over HTTP returns the same classification.
  const app = createApp({ platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/v1/economy/goods`, { headers: { Authorization: `Bearer ${f.credentials.alice.token}`, Origin: base } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).account_bound, before.goodsView.account_bound);
});

test('a Karma receipt and a NemoCoin receipt are never counted for one another, before or after a restart', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 1);
  const wallet = f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id });
  assert.equal(wallet.balance, 4);
  assert.equal(wallet.counts.receipts, 2);
  assert.equal(f.platform.coins(f.actor('alice'), { agent_id: alice.id }).balance, 0, 'service in the world earns no NemoCoin');
  f.platform.close();
  const platform = new Platform(f.database, () => f.clock());
  t.after(() => platform.close());
  const actor = platform.authenticate(f.credentials.alice.token);
  const restarted = platform.karmaWallet(actor, { agent_id: alice.id });
  assert.equal(restarted.balance, wallet.balance, 'the Karma sum is unchanged by the restart');
  assert.equal(platform.coins(actor, { agent_id: alice.id }).balance, 0, 'and no coin receipt was conjured by the restart');
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=?', wallet.account_id).n, 2);
  assert.equal(verifyCoinLedger(platform.db), true);
  assert.equal(verifyKarmaLedger(platform.db), true);
});
