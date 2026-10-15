import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';
import { ensureTradeMarket, marketMethods } from '../src/trade-market.js';
import { TRADE_MARKET_LIMITS, TRADE_MARKET_POLICY, verifyTradeRecords } from '../src/trade-board.js';
import { validateDatabase } from '../src/recovery.js';

// The board, exercised through the platform the same way the garden and the offer layer are: the
// shipped `journey_inventory` shelf is the only place items live, and every assertion below is about
// what the database actually stored.

const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0', agent.id).map((item) => [item.kind, item.quantity]));
// Everything held on a shelf plus everything escrowed in an open listing. The board may move units
// between those two places; it may never create or destroy one.
const world = (f, kinds) => {
  const onShelves = f.platform.all(`SELECT kind,SUM(quantity) AS n FROM journey_inventory WHERE kind IN (${kinds.map(() => '?').join(',')}) GROUP BY kind`, ...kinds);
  const escrowed = f.platform.all(`SELECT kind,SUM(offered-taken) AS n FROM trade_terms WHERE kind IN (${kinds.map(() => '?').join(',')}) AND listing_id IN (SELECT id FROM trade_listings WHERE status='open') GROUP BY kind`, ...kinds);
  const counts = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  for (const row of [...onShelves, ...escrowed]) counts[row.kind] += row.n || 0;
  return counts;
};
const refused = (action, status) => {
  try { action(); }
  catch (error) { assert.equal(error.status, status, `expected HTTP ${status}, received ${error.status}: ${error.message}`); return error.message; }
  throw new Error(`Expected a refusal with HTTP ${status}.`);
};
// The board's tables are created additively when the process starts, exactly as `createApp` does.
const boarded = (f) => ensureTradeMarket(f.platform);

test('a listed exchange moves each unit once, conserves every unit and mints nothing', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 5);
  stock(f, alice, 'fiber', 2);
  const before = world(f, ['herbs', 'fiber']);
  assert.deepEqual(before, { herbs: 5, fiber: 2 });
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 5, fiber: 2 }, note: 'Spare harvest.' }, 'board-post-1');
  assert.equal(listing.status, 'open');
  assert.deepEqual(listing.items, { herbs: 5, fiber: 2 });
  assert.deepEqual(listing.remaining, { herbs: 5, fiber: 2 });
  assert.deepEqual(shelf(f, alice), {}, 'the posted goods leave the shelf as the listing appears (the escrow)');
  const replayed = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 5, fiber: 2 }, note: 'Spare harvest.' }, 'board-post-1');
  assert.equal(replayed.repeated, true);
  assert.equal(replayed.id, listing.id);
  assert.deepEqual(shelf(f, alice), {}, 'a replayed post escrows nothing again');
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 2 } }, 'board-claim-1');
  assert.deepEqual(claim.items, { herbs: 2 });
  assert.deepEqual(shelf(f, bob), { herbs: 2 });
  assert.deepEqual(claim.listing.remaining, { herbs: 3, fiber: 2 });
  const claimReplay = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 2 } }, 'board-claim-1');
  assert.equal(claimReplay.repeated, true);
  assert.equal(claimReplay.id, claim.id);
  assert.deepEqual(shelf(f, bob), { herbs: 2 }, 'a replayed claim credits nothing again');
  assert.deepEqual(world(f, ['herbs', 'fiber']), before, 'the same units exist, wherever they are held');
  // The second operator claims the rest with a different operator entirely.
  const rest = f.tx('tradeClaim', f.actor('reviewer'), { agent_id: f.agent('reviewer').id, listing_id: listing.id }, 'board-claim-2');
  assert.deepEqual(rest.items, { herbs: 3, fiber: 2 });
  assert.equal(rest.listing.status, 'filled');
  assert.equal(rest.listing.settled_at !== null, true);
  assert.deepEqual(rest.listing.remaining, {});
  assert.deepEqual(world(f, ['herbs', 'fiber']), before);
  assert.equal(verifyTradeRecords(f.platform), true);
  // A filled listing is final, in the schema as well as in the method.
  assert.match(refused(() => f.tx('tradeClaim', f.actor('moderator'), { agent_id: f.agent('moderator').id, listing_id: listing.id }, 'board-claim-3'), 409), /filled/);
  assert.throws(() => f.platform.run("UPDATE trade_listings SET status='open' WHERE id=?", listing.id), /final/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0, 'the board writes no coin reward');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('money','currency','credit_balances','conversion_rates')").n, 0);
  assert.equal(TRADE_MARKET_POLICY.moves_coins, false);
  assert.equal(TRADE_MARKET_POLICY.moves_land, false);
  assert.equal(TRADE_MARKET_POLICY.converts_units, false);
  assert.equal(TRADE_MARKET_POLICY.prices, 0);
});

test('an over-claim, a self-claim and a foreign withdrawal are refused, and the shelf cannot go negative', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), sibling = f.agent('alice', 'alice second avatar'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'wood', 3);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { wood: 3 } }, 'refuse-post');
  // A resident of the poster's own operator can never take it, and one operator never trades with itself.
  assert.match(refused(() => f.tx('tradeClaim', f.actor('alice'), { agent_id: sibling.id, listing_id: listing.id }, 'refuse-own'), 403), /different operator/);
  // Claiming more than is left, or a kind the listing never held, is refused without moving anything.
  assert.match(refused(() => f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { wood: 4 } }, 'refuse-over'), 409), /holds 3 wood/);
  assert.match(refused(() => f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 1 } }, 'refuse-kind'), 400), /Claim only the kinds this listing holds/);
  assert.deepEqual(shelf(f, bob), {});
  assert.deepEqual({ ...f.platform.get('SELECT offered,taken FROM trade_terms WHERE listing_id=? AND kind=?', listing.id, 'wood') }, { offered: 3, taken: 0 });
  // Only the posting side withdraws it; an outsider and a different operator are refused.
  assert.match(refused(() => f.tx('tradeCancel', f.actor('bob'), { listing_id: listing.id }), 403), /own operator/);
  const partly = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { wood: 1 } }, 'refuse-take');
  assert.deepEqual(partly.items, { wood: 1 });
  // One operator claims a listing once, so the same resident cannot drain it in several requests.
  assert.match(refused(() => f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { wood: 1 } }, 'refuse-twice'), 409), /already claimed/);
  assert.match(refused(() => f.tx('tradeClaim', f.actor('reviewer'), { agent_id: f.agent('reviewer').id, listing_id: listing.id, items: { wood: 3 } }, 'refuse-left'), 409), /holds 2 wood/);
  // The over-take guard is stated twice: the guarded update cannot pass `offered`, and the CHECK in
  // the schema refuses a row that tries to. Neither can leave a shelf or a listing below zero.
  assert.throws(() => f.platform.run('UPDATE trade_terms SET taken=offered+1 WHERE listing_id=?', listing.id), /CHECK|null/);
  assert.throws(() => f.platform.run('UPDATE journey_inventory SET quantity=-1 WHERE agent_id=? AND kind=?', bob.id, 'wood'), /CHECK|null/);
  const withdrawn = f.tx('tradeCancel', f.actor('alice'), { listing_id: listing.id });
  assert.equal(withdrawn.status, 'cancelled');
  assert.deepEqual(withdrawn.returned, { wood: 2 }, 'only what was not taken comes back');
  assert.deepEqual(shelf(f, alice), { wood: 2 });
  assert.deepEqual(shelf(f, bob), { wood: 1 });
  assert.deepEqual(world(f, ['wood']), { wood: 3 });
  assert.equal(verifyTradeRecords(f.platform), true);
  assert.throws(() => f.platform.run("UPDATE trade_listings SET status='open' WHERE id=?", listing.id), /final/);
});

test('a listing cannot escrow goods the resident does not hold, and a refused post leaves nothing behind', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  boarded(f);
  stock(f, alice, 'herbs', 1);
  assert.match(refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 } }, 'poor-post'), 409), /not all on the shelf/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_listings').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_terms').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_events').n, 0);
  // A kind the world cannot grow or craft is never listed, so no coin, unit or invention can be posted.
  assert.match(refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { nemocoin: 1 } }, 'coin-post'), 400), /grown or crafted/);
  assert.match(refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 0 } }, 'zero-post'), 400), /grow or craft|1–99/);
  assert.deepEqual(shelf(f, alice), { herbs: 1 });
  // A partial escrow of a two-kind bundle rolls the whole request back, not just the failing kind.
  stock(f, alice, 'fiber', 1);
  assert.match(refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 1, fiber: 2 } }, 'rollback-post'), 409), /not all on the shelf/);
  assert.deepEqual(shelf(f, alice), { herbs: 1, fiber: 1 }, 'the refused bundle left the shelf exactly as it was');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_terms').n, 0);
  assert.equal(verifyTradeRecords(f.platform), true);
});

test('the board refuses to serve a stored ledger it cannot balance', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), reviewer = f.agent('reviewer');
  boarded(f);
  stock(f, alice, 'herbs', 2);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 } }, 'verify-post');
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 1 } }, 'verify-claim');
  assert.equal(verifyTradeRecords(f.platform), true);
  // A claim that took five of the two units the listing ever held is exactly the state the guarded
  // update and the CHECK exist to prevent; a raw insert bypasses both, and the pass refuses it.
  f.platform.run('INSERT INTO trade_claims VALUES(?,?,?,?,?,?)', 'tampered-claim', listing.id, reviewer.id, f.actor('reviewer').account.id, 'tampered-key', 0);
  f.platform.run('INSERT INTO trade_claim_units VALUES(?,?,?)', 'tampered-claim', 'herbs', 5);
  assert.equal(verifyTradeRecords(f.platform), false);
  // Schema 23 checks the ledger during database opening, so it cannot be served after restart.
  f.platform.close();
  assert.throws(() => new Platform(f.database, f.clock), /Stored trade board records are invalid/);
  assert.throws(() => validateDatabase(f.database), /trade board validation failed/);
});

test('account deletion settles open offers immediately and erases authored listing notes', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 2);
  stock(f, bob, 'fiber', 2);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 2 }, note: 'My private trade note', expires_minutes: 60 }, 'deleted-post');
  const other = f.tx('tradePost', f.actor('bob'), { agent_id: bob.id, items: { fiber: 2 } }, 'other-post');
  const claim = f.tx('tradeClaim', f.actor('alice'), { agent_id: alice.id, listing_id: other.id, items: { fiber: 1 } }, 'private-claim-key');
  assert.deepEqual(shelf(f, alice), { fiber: 1 });
  const exported = f.tx('exportAccount', f.actor('alice'));
  assert.equal(exported.trade.posted_total, 1);
  assert.equal(exported.trade.claimed_total, 1);
  assert.equal(exported.trade.claimed[0].id, claim.id);
  assert.equal(exported.trade.posted[0].note, 'My private trade note');
  assert.equal(f.tx('exportAccount', f.actor('bob')).trade.claimed_total, 0, 'another account exports only its own claims');
  // The operator gives up the remaining escrow and erases their authored note in one transaction.
  f.tx('deleteAccount', f.actor('alice'));
  assert.deepEqual(shelf(f, alice), {});
  f.advance(61 * 60_000);
  assert.equal(f.tx('tradeExpire'), 0);
  const settled = f.platform.get('SELECT status,returned,note,post_key FROM trade_listings WHERE id=?', listing.id);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.note, '[removed]');
  assert.equal(settled.post_key, `removed:${listing.id}`);
  assert.equal(f.platform.get('SELECT claim_key FROM trade_claims WHERE id=?', claim.id).claim_key, `removed:${claim.id}`);
  assert.deepEqual(JSON.parse(settled.returned), { herbs: 2 }, 'the release is still recorded on the listing');
  assert.deepEqual(shelf(f, alice), {}, 'and no shelf row is written back for the removed account');
  assert.equal(verifyTradeRecords(f.platform), true);
  assert.equal(validateDatabase(f.database).schema_version, 25);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a sibling resident and a runtime credential stay inside their own operator', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), sibling = f.agent('alice', 'alice second avatar'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 4);
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute'], max_calls: 40 });
  const agent = f.platform.authenticate(runtime.token);
  const listing = f.tx('tradePost', agent, { items: { herbs: 3 } }, 'runtime-post');
  assert.equal(listing.poster.agent_id, alice.id, 'a runtime lists for its own bound resident and no other');
  assert.deepEqual(listing.items, { herbs: 3 });
  assert.match(refused(() => f.tx('tradePost', agent, { agent_id: sibling.id, items: { herbs: 1 } }, 'runtime-sibling'), 404), /not found/);
  // A runtime of the other operator claims for its own resident only.
  const other = f.tx('runtime', f.actor('bob'), bob.id, { scopes: ['read', 'contribute'], max_calls: 40 });
  const bobRuntime = f.platform.authenticate(other.token);
  const claimed = f.tx('tradeClaim', bobRuntime, { listing_id: listing.id, items: { herbs: 1 } }, 'runtime-claim');
  assert.equal(claimed.claimer.agent_id, bob.id);
  assert.deepEqual(shelf(f, bob), { herbs: 1 });
  const board = f.tx('tradeBoard', bobRuntime, {});
  assert.equal(board.agent_id, bob.id);
  assert.deepEqual(board.claimed.map((entry) => entry.id), [claimed.id], 'a runtime reads only its own agent\u2019s claims');
  assert.deepEqual(board.listings.map((entry) => entry.id), [listing.id], 'the other operator\u2019s board shows the standing listing');
  assert.equal(board.listings[0].can_claim, false, 'and marks it unclaimable by an operator that already took from it');
  const own = f.tx('tradeBoard', agent, {});
  assert.deepEqual(own.listings, [], 'the poster\u2019s own side never reads its listing on the open board');
  assert.deepEqual(own.posted.map((entry) => [entry.id, entry.claims.length]), [[listing.id, 1]], 'it reads its own listing, with the claim it received');
  // A read-only runtime reads the board but may not post to it.
  const reader = f.tx('runtime', f.actor('reviewer'), f.agent('reviewer').id, { scopes: ['read'], max_calls: 10 });
  const readOnly = f.platform.authenticate(reader.token);
  assert.equal(readOnly.kind, 'runtime');
  assert.equal(f.tx('tradeBoard', readOnly, {}).listings.length, 1, 'any signed-in operator reads the open board');
  assert.equal(marketMethods.tradePost.name, 'tradePost');
  assert.equal(TRADE_MARKET_LIMITS.open_per_agent, 20);
  assert.ok(Object.isFrozen(TRADE_MARKET_POLICY) && Object.isFrozen(TRADE_MARKET_LIMITS));
});
