import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { ensureTradeMarket } from '../src/trade-market.js';
import {
  GOOD_CLASSES, GOOD_FAMILIES, GOOD_REFUSAL_CODES, ITEM_KINDS,
  assertReservationCovered, assertTransferable, familiesForKind, heldByAccount, kindClassification,
  shopGoodClassification, shopReservations, transferableSurplus,
} from '../src/goods-policy.js';
import { SHOP_CATALOGUE, SHOP_CATEGORIES } from '../src/shop.js';
import { KARMA_POLICY } from '../src/karma.js';
import { COIN_POLICY, UNIT_SEPARATION_POLICY } from '../src/coins.js';
import content from '../src/content.js';

// Wave 5 deliverable (1): which goods are transferable and which are account-bound, as data plus
// enforcement. The classification is one table (src/goods-policy.js) that the trade board, the
// resource-offer layer, the shop and the account export all read, and this file exercises the rule
// through the shipped platform rather than through the module's own helpers.

const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0', agent.id).map((item) => [item.kind, item.quantity]));
const boarded = (f) => ensureTradeMarket(f.platform);
const refused = (action, status, code) => {
  try { action(); }
  catch (error) {
    assert.equal(error.status, status, `expected HTTP ${status}, received ${error.status}: ${error.message}`);
    if (code) assert.equal(error.reason_code, code, `expected the named reason ${code}, received ${error.reason_code}: ${error.message}`);
    return error.message;
  }
  throw new Error(`Expected a refusal with HTTP ${status}.`);
};
// A farm tile in the resident's own garden, exactly as the Karma ledger's own tests build one: the
// saved row is what the faucet reads, and the real garden route is exercised elsewhere.
const farmTile = (f, agent, x, y = 6) => {
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,'farm',?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='farm'", `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, x, y, new Date(f.clock()).toISOString());
};
const furnish = (f, agent, x, y = 6) => f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,'bench',?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='bench'", `bench-${agent.id}-${x}-${y}`, `home:${agent.id}`, x, y, new Date(f.clock()).toISOString());
// Eight Karma Coins a day of the world tier: two planted crops and two saved furnishings. Repeated
// across the UTC boundary, which is the only way the faucet pays a second day, so a purse large enough
// for a keepsake is reached the way a player reaches it rather than by writing a receipt.
function earn(f, owner, days = 1) {
  const agent = f.agent(owner), actor = f.actor(owner);
  for (let day = 0; day < days; day += 1) {
    if (day) f.advance(25 * 3_600_000);
    farmTile(f, agent, 6 + day * 2);
    f.tx('gardenAction', actor, { agent_id: agent.id, action: 'plant', kind: 'herbs', x: 6 + day * 2, y: 6 });
    farmTile(f, agent, 7 + day * 2);
    f.tx('gardenAction', actor, { agent_id: agent.id, action: 'plant', kind: 'fiber', x: 7 + day * 2, y: 6 });
    furnish(f, agent, 10 + day * 2);
    furnish(f, agent, 11 + day * 2);
    f.tx('karmaSettle', actor, { agent_id: agent.id });
  }
  return agent;
}
const openServer = async (t, f) => {
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const close = async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); };
  t.after(close);
  return { base: `http://127.0.0.1:${app.server.address().port}` };
};

test('every good family is named once, with its class, and the shop\u2019s categories agree with the table', () => {
  const ids = GOOD_FAMILIES.map((family) => family.id);
  assert.equal(new Set(ids).size, ids.length, 'no family is named twice');
  for (const family of GOOD_FAMILIES) {
    assert.ok(['transferable', 'account_bound'].includes(family.classification), `${family.id} has one of the two classes`);
    assert.ok(family.reason.length > 40 && family.moves.length > 10 && family.evidence.length > 10, `${family.id} states its reason, where it may go and its evidence`);
  }
  // Every sealed item kind is classified, and every crop kind and craft output is covered by a family.
  for (const kind of [...Object.keys(content.crops()), ...content.recipes().map((recipe) => recipe.output)]) {
    assert.ok(ITEM_KINDS.includes(kind), `${kind} is an item kind`);
    assert.ok(familiesForKind(kind).length, `${kind} is named by at least one family`);
    assert.equal(kindClassification(kind), GOOD_CLASSES.transferable, `${kind} is a shelf item, so the kind itself is transferable`);
  }
  assert.equal(kindClassification('nemo_coin'), null, 'a unit of account is not a shelf item');
  // The shop's own three categories are all classified, and its projection states the class of every
  // good it sells from this table rather than from its own list.
  for (const category of SHOP_CATEGORIES) assert.ok(shopGoodClassification(category).family, `${category} is classified`);
  for (const good of SHOP_CATALOGUE) {
    const classification = shopGoodClassification(good.category);
    assert.equal(classification.classification, good.category === 'cosmetic' ? GOOD_CLASSES.account_bound : GOOD_CLASSES.transferable, `${good.id} is classified by its category`);
  }
  // The classification cannot contradict the policies the unit owners ship.
  assert.equal(KARMA_POLICY.transferable, false);
  assert.equal(COIN_POLICY.transferable, false);
  assert.equal(UNIT_SEPARATION_POLICY.conversion_paths, 0);
  assert.equal(UNIT_SEPARATION_POLICY.cash_out, false);
  assert.equal(UNIT_SEPARATION_POLICY.token, false);
  // A currency family states the same rule its own policy does, so a reader never has to guess.
  const karma = GOOD_FAMILIES.find((family) => family.id === 'karma_coin');
  assert.equal(karma.classification, GOOD_CLASSES.account_bound);
  assert.match(karma.reason, /not NemoCoins, not money/);
});

test('a keepsake bought with Karma is refused on the trade board with its named reason, and nothing moves', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 3), bobs = f.agent('bob');
  boarded(f);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 24);
  const bought = f.tx('shopPurchase', f.actor('alice'), { good_id: 'flower_crown', agent_id: alice.id }, 'goods-crown-1');
  assert.equal(bought.category, 'cosmetic');
  assert.deepEqual(shelf(f, alice).flower_crown, 1);
  const purse = f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance;
  assert.equal(purse, 4, 'the keepsake cost its whole 20 Karma Coins');
  // The shop's own purchase record is the reservation: one flower crown of this account is account-bound.
  assert.deepEqual([...shopReservations(f.platform, f.actor('alice').account.id)], [['flower_crown', 1]]);
  assert.equal(heldByAccount(f.platform, f.actor('alice').account.id, 'flower_crown'), 1);
  assert.equal(transferableSurplus(f.platform, f.actor('alice').account.id, 'flower_crown'), 0);
  const listings = f.platform.get('SELECT COUNT(*) AS n FROM trade_listings').n;
  const message = refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { flower_crown: 1 }, note: 'A gift.' }, 'goods-post-1'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  assert.match(message, /account-bound/);
  assert.match(message, /bought 1 of it from the shop/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_listings').n, listings, 'a refused listing writes no listing row');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_terms').n, 0, 'and escrows no unit');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the keepsake stays on its own shelf');
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, purse, 'and no Karma moved');
  // The resource-offer path is the same rule and the same named reason.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  refused(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bobs.id, items: { flower_crown: 1 } }, 'goods-offer-1'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0, 'a refused offer writes no offer row');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 });
  // The keepsake is still the resident's own to wear: the refusal is about moving it, not holding it.
  f.tx('updateProfile', f.actor('alice'), { agent_id: alice.id, avatar: 'flower_crown' });
  assert.equal(f.platform.get('SELECT avatar FROM journey_profiles WHERE agent_id=?', alice.id).avatar, 'flower_crown');
});

test('a crafted keepsake still moves between operators, and the reservation only bounds the surplus', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 3), bob = f.agent('bob');
  boarded(f);
  // One keepsake the resident made itself, from its own shelf: it has no shop purchase behind it.
  stock(f, alice, 'herbs', 2); stock(f, alice, 'fiber', 1);
  assert.equal(f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'flower_crown' }).crafted, 'flower_crown');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 });
  const before = shelf(f, alice).flower_crown;
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { flower_crown: 1 }, note: 'Made one too many.' }, 'crafted-post-1');
  assert.equal(listing.status, 'open');
  assert.deepEqual(shelf(f, alice), {}, 'a crafted keepsake escrows as any grown good does');
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id }, 'crafted-claim-1');
  assert.deepEqual(claim.items, { flower_crown: 1 });
  assert.deepEqual(shelf(f, bob), { flower_crown: 1 }, 'a crafted keepsake really does move to another operator');
  assert.equal(before, 1);
  // Now the same account buys one from the shop: one of its two flower crowns is account-bound, so one
  // may leave the account and the second may not.
  stock(f, alice, 'herbs', 4); stock(f, alice, 'fiber', 2);
  f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'flower_crown' });
  f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'flower_crown' });
  assert.equal(f.tx('shopPurchase', f.actor('alice'), { good_id: 'flower_crown', agent_id: alice.id }, 'surplus-buy-1').good_id, 'flower_crown');
  assert.deepEqual(shelf(f, alice), { flower_crown: 3 });
  assert.equal(transferableSurplus(f.platform, f.actor('alice').account.id, 'flower_crown'), 2);
  const one = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { flower_crown: 2 }, note: 'Surplus only.' }, 'surplus-post-1');
  assert.deepEqual(one.items, { flower_crown: 2 }, 'the unreserved surplus leaves the shelf');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the bought one stays with the account that bought it');
  // Two listings cannot jointly exceed the same surplus: the escrow has already left the shelf.
  assert.deepEqual([...shopReservations(f.platform, f.actor('alice').account.id)], [['flower_crown', 1]]);
  assert.equal(transferableSurplus(f.platform, f.actor('alice').account.id, 'flower_crown'), 0);
  refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { flower_crown: 1 } }, 'surplus-post-2'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  // The two escrowed keepsakes are claimed by a different operator: they were never account-bound.
  const claim2 = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: one.id }, 'surplus-claim-1');
  assert.deepEqual(claim2.items, { flower_crown: 2 });
  assert.deepEqual(shelf(f, bob), { flower_crown: 3 });
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 });
  // Nothing was created or destroyed by any of it: three units exist and three are held.
  assert.equal(f.platform.get("SELECT COALESCE(SUM(quantity),0) AS n FROM journey_inventory WHERE kind='flower_crown'").n, 4, 'three crafted-or-bought plus the one that was crafted first and traded');
});

test('the shop states the class of every good it sells, and the readable route and export carry the same table', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 3);
  const catalogue = f.platform.shopCatalogue(f.actor('alice'), { agent_id: alice.id });
  const cosmetic = catalogue.goods.find((good) => good.id === 'flower_crown');
  const resource = catalogue.goods.find((good) => good.id === 'herbs');
  assert.equal(cosmetic.classification, GOOD_CLASSES.account_bound);
  assert.equal(cosmetic.transferable, false);
  assert.equal(cosmetic.family, 'shop_cosmetic');
  assert.equal(resource.classification, GOOD_CLASSES.transferable);
  assert.equal(resource.transferable, true);
  f.tx('shopPurchase', f.actor('alice'), { good_id: 'flower_crown', agent_id: alice.id }, 'route-buy-1');
  const view = f.platform.goodsPolicy(f.actor('alice'), {});
  assert.equal(view.account_id, f.actor('alice').account.id);
  assert.deepEqual(view.account_bound.map((entry) => [entry.kind, entry.reserved, entry.held, entry.transferable]), [['flower_crown', 1, 1, 0]]);
  assert.equal(view.account_bound[0].reason_code, GOOD_REFUSAL_CODES.account_bound_good);
  assert.ok(!view.transferable_kinds.includes('flower_crown'), 'a reserved kind is no longer listed as transferable');
  assert.deepEqual(view.units.separation, UNIT_SEPARATION_POLICY, 'the four units travel with the classification');
  // Another operator sees only its own account-bound goods.
  assert.deepEqual(f.platform.goodsPolicy(f.actor('bob'), {}).account_bound, []);
  // The named reason reaches HTTP with a 409 instead of a 500, and the classification is readable there.
  const { base } = await openServer(t, f);
  const headers = { Authorization: `Bearer ${f.credentials.alice.token}`, 'Content-Type': 'application/json', Origin: base };
  const goods = await fetch(`${base}/api/v1/economy/goods`, { headers });
  assert.equal(goods.status, 200);
  assert.deepEqual((await goods.json()).account_bound.map((entry) => entry.kind), ['flower_crown']);
  const denied = await fetch(`${base}/api/v1/economy/goods`, { headers: { Origin: base } });
  assert.equal(denied.status, 401, 'the classification of an account is not public');
  const posted = await fetch(`${base}/api/v1/trade/listings`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'route-post-1' }, body: JSON.stringify({ agent_id: alice.id, items: { flower_crown: 1 } }) });
  assert.equal(posted.status, 409);
  assert.match((await posted.json()).error, /account-bound/);
  const exported = f.platform.exportAccount(f.actor('alice'));
  assert.equal(exported.goods.families.length, GOOD_FAMILIES.length);
  assert.deepEqual(exported.goods.account_bound.map((entry) => entry.kind), ['flower_crown']);
  assert.doesNotMatch(JSON.stringify(exported.goods), /"hash"|"previous_hash"|"token"|"idempotency_key"|"key"|"fingerprint"/);
});

test('an escrow of an account-bound good that predates the rule can be neither claimed nor accepted', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 3), bob = f.agent('bob');
  boarded(f);
  f.tx('shopPurchase', f.actor('alice'), { good_id: 'flower_crown', agent_id: alice.id }, 'legacy-buy-1');
  // A listing written before this rule existed: the units are escrowed by hand, the listing and its
  // posted event are the rows `tradePost` would have written, and the guard never ran.
  const now = f.clock(), id = 'legacy-listing', at = new Date(now).toISOString();
  f.platform.run('UPDATE journey_inventory SET quantity=quantity-1 WHERE agent_id=? AND kind=?', alice.id, 'flower_crown');
  f.platform.run('INSERT INTO trade_listings VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, alice.id, f.actor('alice').account.id, JSON.stringify({ flower_crown: 1 }), '', 'open', 'legacy-post', now, now + 3_600_000, null, '{}');
  f.platform.run('INSERT INTO trade_terms VALUES(?,?,?,0)', id, 'flower_crown', 1);
  f.platform.run("INSERT INTO trade_events VALUES(?,?,?,?,?,?)", 'legacy-event', id, f.actor('alice').account.id, 'posted', '', now);
  assert.deepEqual(shelf(f, alice), {}, 'the legacy escrow has taken the unit off the shelf');
  // The take side refuses, and the refusal is the same named reason.
  const message = refused(() => f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: id }, 'legacy-claim-1'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  assert.match(message, /bought 1 from the shop/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_claims').n, 0, 'a refused claim writes no claim row');
  assert.equal(f.platform.get("SELECT taken FROM trade_terms WHERE listing_id=? AND kind='flower_crown'", id).taken, 0, 'and takes nothing');
  assert.deepEqual(shelf(f, bob), {}, 'the account-bound good never reaches the other operator');
  // The offer layer refuses the same legacy escrow. Cancelling the listing first hands the unit back,
  // and the offer's own legacy escrow then takes it out of the shelf the way `offerCreate` would have.
  f.tx('tradeCancel', f.actor('alice'), { listing_id: id });
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the escrow returns to its own account');
  const offerId = 'legacy-offer';
  f.platform.run('UPDATE journey_inventory SET quantity=quantity-1 WHERE agent_id=? AND kind=?', alice.id, 'flower_crown');
  f.platform.run('INSERT INTO resource_offers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', offerId, alice.id, f.actor('alice').account.id, bob.id, f.actor('bob').account.id, JSON.stringify({ flower_crown: 1 }), '', 'proposed', 'legacy-propose', null, now, now + 3_600_000, null, null);
  refused(() => f.tx('offerAccept', f.actor('bob'), { offer_id: offerId }, 'legacy-accept-1'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  assert.equal(f.platform.get('SELECT status FROM resource_offers WHERE id=?', offerId).status, 'proposed', 'the offer is untouched by the refusal');
  assert.deepEqual(shelf(f, bob), {}, 'and the account-bound good still never reaches the other operator');
  // Withdrawing the offer returns the same single unit: one unit was moved between three places by
  // hand and is held exactly once at every step of the way.
  f.tx('offerCancel', f.actor('alice'), { offer_id: offerId });
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the refused offer returns its escrow');
  assert.equal(f.platform.get("SELECT COALESCE(SUM(quantity),0) AS n FROM journey_inventory WHERE kind='flower_crown'").n, 1, 'one unit exists and one is held');
  assert.equal(assertTransferable(f.platform, { account_id: f.actor('alice').account.id, agent_id: alice.id, items: { herbs: 5 } }), true, 'an ordinary grown kind is always transferable');
  assert.equal(assertReservationCovered(f.platform, { account_id: f.actor('alice').account.id, items: { herbs: 5 } }), true);
});
