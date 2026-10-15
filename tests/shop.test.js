import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import content from '../src/content.js';
import { GARDEN_PALETTE, HOUSE_PALETTE, BUILD_PALETTE } from '../src/placement-policy.js';
import { SHOP_CATALOGUE, SHOP_CATEGORIES, SHOP_LIMITS, SHOP_SCHEMA, shopMethods, validateShopCatalogue } from '../src/shop.js';

// These unit tests isolate the shop from the ledger on purpose: they inject a stand-in that implements
// exactly the two methods the shop calls (the real ledger under the real shop is proved in
// tests/karma-integration.test.js and tests/karma-shop-http.test.js): `karmaWallet(actor,{agent_id})` and
// `karmaSpend(actor,{amount,good_id,key})`. The stub is deliberately not an in-memory map — it writes
// its balance and its ledger into the real SQLite file, inside the caller's transaction — so the
// rollback assertions below prove the debit really is undone by the same transaction that grants the
// good, rather than restating the shop's own bookkeeping back to itself.
const KARMA_STUB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS karma_stub_wallets(account_id TEXT PRIMARY KEY REFERENCES accounts(id),balance INTEGER NOT NULL CHECK(balance>=0));
  CREATE TABLE IF NOT EXISTS karma_stub_ledger(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),agent_id TEXT,amount INTEGER NOT NULL CHECK(amount>0),good_id TEXT NOT NULL,key TEXT NOT NULL,balance_after INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,key));
`;

function karmaStub(platform) {
  platform.db.exec(KARMA_STUB_SCHEMA);
  const balanceOf = (accountId) => platform.get('SELECT balance FROM karma_stub_wallets WHERE account_id=?', accountId)?.balance ?? 0;
  platform.karmaWallet = (actor, input = {}) => ({
    account_id: actor.account.id, agent_id: input.agent_id ?? null, currency: 'Karma Coins', balance: balanceOf(actor.account.id),
    ledger: platform.all('SELECT id,amount,good_id,key,balance_after,created_at FROM karma_stub_ledger WHERE account_id=? ORDER BY created_at,id', actor.account.id),
  });
  platform.karmaSpend = (actor, { amount, good_id, key }) => {
    const accountId = actor.account.id;
    // Idempotent on (account_id, key), exactly as the currency module's debit is.
    const previous = platform.get('SELECT * FROM karma_stub_ledger WHERE account_id=? AND key=?', accountId, key);
    if (previous) return { ok: true, balance_after: previous.balance_after, purchase_id: previous.id, reason: 'This key already spent Karma.' };
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false, purchase_id: null, balance_after: balanceOf(accountId), reason: 'The amount must be a positive whole number.' };
    const changed = platform.run('UPDATE karma_stub_wallets SET balance=balance-? WHERE account_id=? AND balance>=?', amount, accountId, amount);
    if (!changed.changes) return { ok: false, purchase_id: null, balance_after: balanceOf(accountId), reason: 'Not enough Karma Coins.' };
    const id = randomUUID(), balanceAfter = balanceOf(accountId);
    platform.run('INSERT INTO karma_stub_ledger(id,account_id,agent_id,amount,good_id,key,balance_after,created_at) VALUES(?,?,?,?,?,?,?,?)', id, accountId, actor.agent?.id ?? null, amount, good_id, key, balanceAfter, platform.clock());
    return { ok: true, balance_after: balanceAfter, purchase_id: id, reason: null };
  };
  return platform;
}

const creditKarma = (platform, accountId, amount) => platform.run('INSERT INTO karma_stub_wallets(account_id,balance) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET balance=balance+excluded.balance', accountId, amount);

async function shopWorld(t, { startAt, balance = 100 } = {}) {
  const f = await fixture(t, { startAt });
  // What the integrator does: the mixin onto the platform and the schema at open.
  Object.assign(f.platform, shopMethods);
  f.platform.db.exec(SHOP_SCHEMA);
  karmaStub(f.platform);
  for (const owner of ['alice', 'bob']) creditKarma(f.platform, f.actor(owner).account.id, balance);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const residents = { alice, bob };
  const actorOf = (who) => typeof who === 'string' ? f.actor(who) : who;
  // A signed-in operator names the resident it is buying for, exactly as every other journey write
  // does; this helper supplies the owner's own resident unless the test names another one.
  const buy = (who, input, key) => {
    const actor = actorOf(who);
    const payload = input.agent_id === undefined && Object.hasOwn(residents, who) ? { ...input, agent_id: residents[who].id } : input;
    return f.platform.transaction(() => f.platform.shopPurchase(actor, payload, key));
  };
  return {
    ...f, alice, bob, buy, actorOf,
    read: (who, input) => f.platform.shopCatalogue(actorOf(who), input),
    wallet: (who) => f.platform.get('SELECT balance FROM karma_stub_wallets WHERE account_id=?', actorOf(who).account.id)?.balance ?? 0,
    ledger: (who) => f.platform.all('SELECT * FROM karma_stub_ledger WHERE account_id=?', actorOf(who).account.id),
    shelf: (agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', agent.id).map((row) => [row.kind, row.quantity])),
    ownedGoods: () => f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n,
  };
}

test('the frozen catalogue stocks only genuinely scarce goods, and every grant names a sealed id', async () => {
  assert.equal(Object.isFrozen(SHOP_CATALOGUE), true);
  assert.ok(SHOP_CATALOGUE.length >= 8, 'the shop stocks at least eight goods');
  for (const good of SHOP_CATALOGUE) assert.ok(SHOP_CATEGORIES.includes(good.category), `${good.id} is in a category the module knows`);
  assert.ok(new Set(SHOP_CATALOGUE.map((good) => good.category)).size >= 2, 'the shop stocks more than one kind of good');
  // The module supports a placement entitlement, but no stock good may use it: the free build palette
  // already lets a resident place that furniture at no cost, so selling it would sell nothing. The
  // object path keeps its own validation above and stays ready for a good that is genuinely scarce.
  assert.equal(SHOP_CATALOGUE.filter((good) => good.category === 'object').length, 0, 'no good is stocked in the category the free palette already gives away');
  for (const good of SHOP_CATALOGUE) {
    assert.equal(Object.isFrozen(good), true, `${good.id} is frozen`);
    assert.equal(Object.isFrozen(good.grant), true, `${good.id} freezes its grant`);
    assert.equal(Number.isInteger(good.price), true, `${good.id} prices in whole Karma Coins`);
    assert.ok(good.price >= 8 && good.price <= 40, `${good.id} costs 8–40 Karma Coins`);
    assert.ok(Number.isInteger(good.per_account_limit_per_day) && good.per_account_limit_per_day >= 1, `${good.id} states a daily allowance`);
    if (good.category === 'resource') {
      assert.ok(Object.hasOwn(content.crops(), good.grant.kind), `${good.id} grants the sealed crop kind ${good.grant.kind}`);
      assert.ok(good.grant.quantity >= 1);
    } else if (good.category === 'object') {
      assert.ok(BUILD_PALETTE.includes(good.grant.type), `${good.id} grants the sealed buildable object ${good.grant.type}`);
      assert.ok((good.grant.world === 'garden' ? GARDEN_PALETTE : HOUSE_PALETTE).includes(good.grant.type), `${good.id} uses a palette its world can build`);
      assert.equal(content.entry(good.grant.type, 'furniture').kind, 'furniture');
    } else {
      assert.ok(content.cosmetics('craft').includes(good.grant.cosmetic), `${good.id} grants the sealed keepsake ${good.grant.cosmetic}`);
      assert.equal(content.entry(good.grant.cosmetic, 'cosmetic').rules.output, good.grant.cosmetic);
    }
  }
  assert.equal(validateShopCatalogue(SHOP_CATALOGUE), SHOP_CATALOGUE);
});

test('a catalogue that drifts from the sealed content is refused', async () => {
  const withGrant = (id, grant, changes = {}) => SHOP_CATALOGUE.map((good) => good.id === id ? { ...good, ...changes, ...(grant ? { grant } : {}) } : good);
  // The object category is supported but deliberately unstocked, so the object checks are exercised
  // against a fixture good that keeps every field the shipped goods use.
  const withObject = (grant) => [...SHOP_CATALOGUE.map((good) => ({ ...good })), { id: 'bench', label: 'Garden bench', summary: 'A bench for a garden tile.', note: 'A fixture object good.', category: 'object', price: 15, per_account_limit_per_day: 2, grant }];
  const cases = [
    ['a price outside the sealed range', withGrant('herbs', null, { price: 400 })],
    ['a fractional price', withGrant('herbs', null, { price: 8.5 })],
    ['a price below the sealed range', withGrant('herbs', null, { price: 1 })],
    ['an unknown category', withGrant('herbs', null, { category: 'land' })],
    ['no daily allowance', withGrant('herbs', null, { per_account_limit_per_day: 0 })],
    ['no label', withGrant('herbs', null, { label: '' })],
    ['no note', withGrant('herbs', null, { note: '   ' })],
    ['an unknown crop kind', withGrant('herbs', { kind: 'gold', quantity: 1 })],
    ['a zero quantity', withGrant('herbs', { kind: 'herbs', quantity: 0 })],
    ['an object the palettes do not allow', withObject({ type: 'throne', world: 'garden' })],
    ['a block sold as furniture', withObject({ type: 'path', world: 'garden' })],
    ['a garden object in the cottage palette', withObject({ type: 'fountain', world: 'house' })],
    ['a gated avatar sold as a keepsake', withGrant('flower_crown', { cosmetic: 'explorer_banner' })],
    ['an unknown cosmetic', withGrant('flower_crown', { cosmetic: 'crown_of_laurels' })],
    ['a duplicate good id', SHOP_CATALOGUE.map((good) => good.id === 'fiber' ? { ...good, id: 'herbs' } : good)],
    ['a catalogue with one category only', SHOP_CATALOGUE.filter((good) => good.category === 'resource').map((good) => ({ ...good }))],
    ['an empty catalogue', []],
  ];
  for (const [why, catalogue] of cases) assert.throws(() => validateShopCatalogue(catalogue), Error, `${why} must be refused`);
  // The shipped catalogue is deeply frozen and untouched by the copies above.
  assert.equal(SHOP_CATALOGUE.find((good) => good.id === 'herbs').price, 8);
  assert.equal(SHOP_CATALOGUE.filter((good) => good.category === 'resource').length, 4);
  assert.equal(SHOP_CATALOGUE.filter((good) => good.category === 'cosmetic').length, 4);
});

test('the projection shows the buyer their own allowance and policy, hides another operator, and refuses a runtime', async (t) => {
  const f = await shopWorld(t);
  const view = f.read('alice', { agent_id: f.alice.id });
  assert.equal(view.agent_id, f.alice.id);
  assert.equal(view.currency, 'Karma Coins');
  assert.equal(view.balance, 100);
  assert.equal(view.goods.length, SHOP_CATALOGUE.length);
  const herbs = view.goods.find((good) => good.id === 'herbs');
  assert.equal(herbs.price, 8);
  assert.equal(herbs.remaining_today, 6);
  assert.equal(herbs.bought_today, 0);
  assert.equal(herbs.can_afford, true);
  assert.equal(herbs.available_today, true);
  assert.deepEqual(herbs.grant, { kind: 'herbs', quantity: 2 });
  assert.match(view.policy.description, /never land, roles, authority, XP, review power or anything with real-world value/);
  assert.deepEqual(view.policy.never_sells, ['land', 'roles', 'authority', 'experience points', 'review power', 'real-world value']);
  assert.equal(view.policy.moves_coins, false);
  assert.equal(view.policy.moves_land, false);
  assert.equal(view.policy.gift_or_transfer, false);
  // Another operator's resident is not the caller's to read or to buy for.
  assert.throws(() => f.read('bob', { agent_id: f.alice.id }), { status: 404 });
  assert.throws(() => f.buy('bob', { good_id: 'herbs', agent_id: f.alice.id }, 'bob-for-alice'), { status: 404 });
  // One operator's spending never appears in another's allowance.
  f.buy('bob', { good_id: 'herbs' }, 'bob-herbs-1');
  const bobView = f.read('bob', { agent_id: f.bob.id });
  assert.equal(bobView.balance, 92);
  assert.equal(bobView.goods.find((good) => good.id === 'herbs').bought_today, 1);
  const aliceView = f.read('alice', { agent_id: f.alice.id });
  assert.equal(aliceView.balance, 100);
  assert.equal(aliceView.goods.find((good) => good.id === 'herbs').bought_today, 0);
  // A runtime credential neither reads the wallet nor spends it.
  const session = f.platform.transaction(() => f.platform.runtime(f.actor('alice'), f.alice.id, { minutes: 5, max_calls: 20, scopes: ['read', 'contribute', 'build'] }));
  const agentActor = f.platform.authenticate(session.token);
  assert.equal(agentActor.kind, 'runtime');
  assert.throws(() => f.read(agentActor, { agent_id: f.alice.id }), { status: 403 });
  assert.throws(() => f.buy(agentActor, { good_id: 'herbs' }, 'runtime-herbs-1'), { status: 403 });
  assert.equal(f.ledger('alice').length, 0);
});

test('a purchase debits the wallet once, grants the good once and takes no value from the request', async (t) => {
  const f = await shopWorld(t);
  const result = f.buy('alice', { good_id: 'herbs' }, 'alice-herbs-1');
  assert.equal(result.repeated, false);
  assert.equal(result.good_id, 'herbs');
  assert.equal(result.price, 8);
  assert.equal(result.balance_after, 92);
  assert.equal(result.agent_id, f.alice.id);
  assert.equal(typeof result.karma_receipt_id, 'string');
  assert.deepEqual(result.granted, { category: 'resource', kind: 'herbs', quantity: 2 });
  assert.equal(f.wallet('alice'), 92);
  assert.equal(f.ledger('alice').length, 1);
  assert.deepEqual(f.shelf(f.alice), { herbs: 2 });
  assert.equal(f.ownedGoods(), 1);
  // A body that names its own price, quantity or balance changes nothing: the catalogue decides.
  const crate = f.buy('alice', { good_id: 'herb_crate', price: 1, quantity: 99, balance: 99999, amount: 0 }, 'alice-crate-1');
  assert.equal(crate.price, 18);
  assert.deepEqual(crate.granted, { category: 'resource', kind: 'herbs', quantity: 5 });
  assert.equal(f.wallet('alice'), 74);
  assert.deepEqual(f.shelf(f.alice), { herbs: 7 });
  // An unknown good, a missing key and a missing resident are refused before any debit.
  assert.throws(() => f.buy('alice', { good_id: 'castle' }, 'alice-castle-1'), { status: 400 });
  assert.throws(() => f.buy('alice', { good_id: 'herbs' }, undefined), { status: 400 });
  assert.throws(() => f.platform.shopPurchase(f.actor('alice'), { good_id: 'herbs' }, 'alice-no-resident'), { status: 400 });
  assert.equal(f.ledger('alice').length, 2);
  assert.equal(f.ownedGoods(), 2);
});

test('a replayed purchase key grants nothing twice and returns the recorded result', async (t) => {
  const f = await shopWorld(t);
  const first = f.buy('alice', { good_id: 'fiber' }, 'alice-fiber-1');
  const replay = f.buy('alice', { good_id: 'fiber' }, 'alice-fiber-1');
  assert.equal(replay.repeated, true);
  assert.equal(replay.purchase_id, first.purchase_id);
  assert.equal(replay.balance_after, first.balance_after);
  assert.deepEqual(replay.granted, first.granted);
  assert.equal(f.wallet('alice'), 91);
  assert.equal(f.ledger('alice').length, 1);
  assert.equal(f.ownedGoods(), 1);
  assert.deepEqual(f.shelf(f.alice), { fiber: 2 });
  // The same key for a different good is a conflict, never a second grant.
  assert.throws(() => f.buy('alice', { good_id: 'wood' }, 'alice-fiber-1'), { status: 409 });
  assert.equal(f.ownedGoods(), 1);
  assert.deepEqual(f.shelf(f.alice), { fiber: 2 });
});

test('an insufficient balance debits nothing and grants nothing', async (t) => {
  const f = await shopWorld(t, { balance: 5 });
  assert.throws(() => f.buy('alice', { good_id: 'herbs' }, 'poor-1'), { status: 409 });
  assert.equal(f.wallet('alice'), 5);
  assert.equal(f.ledger('alice').length, 0);
  assert.deepEqual(f.shelf(f.alice), {});
  assert.equal(f.ownedGoods(), 0);
  assert.equal(f.read('alice', { agent_id: f.alice.id }).goods.find((good) => good.id === 'herbs').can_afford, false);
});

test('the per-account daily allowance is counted per UTC day and refused past its bound', async (t) => {
  const f = await shopWorld(t, { startAt: Date.UTC(2026, 9, 14, 12) });
  assert.equal(f.buy('alice', { good_id: 'flower_crown' }, 'crown-1').price, 20);
  assert.throws(() => f.buy('alice', { good_id: 'flower_crown' }, 'crown-2'), { status: 429 });
  assert.equal(f.wallet('alice'), 80);
  assert.equal(f.ledger('alice').length, 1);
  assert.deepEqual(f.shelf(f.alice), { flower_crown: 1 });
  // A second resident of the same operator shares the account's allowance.
  const sibling = f.agent('alice', 'Second resident');
  assert.throws(() => f.buy('alice', { good_id: 'flower_crown', agent_id: sibling.id }, 'crown-3'), { status: 429 });
  // The allowance returns on the next UTC day.
  f.advance(86400000);
  assert.equal(f.buy('alice', { good_id: 'flower_crown' }, 'crown-4').balance_after, 60);
  assert.equal(f.ownedGoods(), 2);
  assert.deepEqual(f.shelf(f.alice), { flower_crown: 2 });
});

test('a grant that fails rolls the Karma debit back with it', async (t) => {
  const f = await shopWorld(t);
  // The shelf bound is enforced inside the grant's own guarded write, after the debit.
  f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'herbs',?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=excluded.quantity", f.alice.id, SHOP_LIMITS.shelf_quantity_max);
  assert.throws(() => f.buy('alice', { good_id: 'herbs' }, 'full-shelf-1'), { status: 409 });
  assert.equal(f.wallet('alice'), 100, 'the debit was rolled back');
  assert.equal(f.ledger('alice').length, 0);
  assert.equal(f.shelf(f.alice).herbs, SHOP_LIMITS.shelf_quantity_max);
  assert.equal(f.ownedGoods(), 0);
  // The same when the shelf write itself aborts, using the trigger shape tests/journey.test.js uses.
  f.platform.db.exec("CREATE TRIGGER shop_grant_failure BEFORE INSERT ON journey_inventory WHEN NEW.kind='flower_crown' BEGIN SELECT RAISE(ABORT,'output failed'); END");
  assert.throws(() => f.buy('alice', { good_id: 'flower_crown' }, 'crown-fail-1'));
  assert.equal(f.wallet('alice'), 100);
  assert.equal(f.ledger('alice').length, 0);
  assert.deepEqual(f.shelf(f.alice), { herbs: SHOP_LIMITS.shelf_quantity_max });
  assert.equal(f.ownedGoods(), 0);
  // A caller that forgets the wrapper still cannot commit a debit without the goods: the shop opens
  // its own transaction whenever node:sqlite reports it is not already inside one.
  f.platform.run("UPDATE journey_inventory SET quantity=? WHERE agent_id=? AND kind='herbs'", SHOP_LIMITS.shelf_quantity_max, f.alice.id);
  assert.throws(() => f.platform.shopPurchase(f.actor('alice'), { good_id: 'herbs', agent_id: f.alice.id }, 'unwrapped-1'), { status: 409 });
  assert.equal(f.wallet('alice'), 100);
  assert.equal(f.ledger('alice').length, 0);
  assert.equal(f.ownedGoods(), 0);
});

test('a purchase moves no NemoCoin, no land, no role and no world object', async (t) => {
  const f = await shopWorld(t);
  const tables = ['coin_rewards', 'worlds', 'world_objects', 'land_parcels', 'land_stewardships', 'land_events', 'plot_grants', 'plot_grant_events', 'frontier_sectors', 'frontier_blocks', 'frontier_actions', 'resource_offers', 'journey_profiles', 'tokens'];
  const counts = () => Object.fromEntries(tables.map((table) => [table, f.platform.get(`SELECT COUNT(*) AS n FROM ${table}`).n]));
  const rows = () => ({
    before: { agent: { ...f.platform.get('SELECT * FROM agents WHERE id=?', f.alice.id) }, account: { ...f.platform.get('SELECT * FROM accounts WHERE id=?', f.actor('alice').account.id) } },
    counts: counts(),
  });
  const before = rows();
  const wood = f.buy('alice', { good_id: 'wood' }, 'leak-wood-1');
  const wreath = f.buy('alice', { good_id: 'herbal_wreath' }, 'leak-wreath-1');
  const crate = f.buy('alice', { good_id: 'herb_crate' }, 'leak-crate-1');
  const after = rows();
  assert.deepEqual(after.counts, before.counts);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.deepEqual(after.before.agent, before.before.agent);
  assert.deepEqual(after.before.account, before.before.account);
  assert.equal(f.actor('alice').account.role, 'member');
  // A purchase grants an item and nothing else: no world object is written anywhere, in the buyer's
  // own spaces included, because the shop never places anything.
  const myWorlds = ['home:' + f.alice.id, 'house:' + f.alice.id];
  for (const worldId of myWorlds) assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', worldId).n, 0, `${worldId} gains no object from a purchase`);
  assert.equal(wood.granted.kind, 'wood');
  assert.equal(crate.granted.quantity, 5);
  assert.equal(wreath.granted.cosmetic, 'herbal_wreath');
  // The cosmetic grant is real: the journey projection now offers the keepsake as an appearance.
  const journey = f.platform.journey(f.actor('alice'), { agent_id: f.alice.id });
  assert.ok(journey.profile_options.avatars.includes('herbal_wreath'), 'the bought keepsake is offered as a resident appearance');
  assert.equal(journey.inventory.find((item) => item.kind === 'herbal_wreath').quantity, 1);
});

test('the shop fails closed without the currency module and inside a paused world', async (t) => {
  // No Karma methods reachable: the shop never invents, guesses or stores a balance of its own. The
  // platform always mixes the currency in, so the deployment this defends against is simulated by
  // shadowing the two methods the shop calls.
  const bare = await fixture(t);
  Object.assign(bare.platform, shopMethods);
  bare.platform.db.exec(SHOP_SCHEMA);
  bare.platform.karmaWallet = undefined;
  bare.platform.karmaSpend = undefined;
  const resident = bare.agent('alice');
  assert.throws(() => bare.platform.shopCatalogue(bare.actor('alice'), { agent_id: resident.id }), { status: 503 });
  assert.throws(() => bare.platform.shopPurchase(bare.actor('alice'), { good_id: 'herbs', agent_id: resident.id }, 'no-currency-1'), { status: 503 });
  assert.equal(bare.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 0);
  // A paused world sells nothing, and the pause is checked before the debit.
  const f = await shopWorld(t);
  f.platform.pause(f.actor('admin'), true);
  assert.throws(() => f.buy('alice', { good_id: 'herbs' }, 'paused-1'), { status: 503 });
  assert.equal(f.wallet('alice'), 100);
  assert.equal(f.ledger('alice').length, 0);
  assert.equal(f.ownedGoods(), 0);
});
