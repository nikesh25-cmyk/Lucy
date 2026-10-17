import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixture, evidence, realMission } from './helpers.js';
import { GOOD_CLASSES, GOOD_FAMILIES } from '../src/goods-policy.js';
import { SHOP_CATALOGUE, SHOP_CATEGORIES, SHOP_POLICY } from '../src/shop.js';
import { KARMA_POLICY, KARMA_SCHEMA } from '../src/karma.js';
import { COIN_POLICY, COIN_SCHEMA, CREDIT_UNITS, UNIT_SEPARATION_POLICY, verifyCoinLedger } from '../src/coins.js';
import { verifyKarmaLedger } from '../src/karma.js';

// Wave 5 deliverable (3): NemoCoins, Karma, compute credits, money and verified carbon credits stay
// distinct. Nothing converts one into another, nothing cashes out, no plot is for sale, and a reward
// in one ledger is never counted as another.
//
// What the owner's own tests already prove, and this file does not repeat: a shop purchase moves no
// NemoCoin, no land, no role and no world object (tests/shop.test.js), and no Karma path moves a
// NemoCoin (tests/karma-ledger.test.js). The new ground here is the four units as one readable
// policy, the structural proof that no route or method converts them, and the counting half — a
// purse of one unit cannot pay for the other's goods.

const here = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const room = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('the four units of account are stated once each, and the classification agrees they never move', () => {
  assert.deepEqual(UNIT_SEPARATION_POLICY.units, ['nemocoin', 'compute_credit', 'money', 'carbon_credit']);
  assert.equal(UNIT_SEPARATION_POLICY.version, 1);
  assert.equal(UNIT_SEPARATION_POLICY.conversion_paths, 0, 'there is no conversion path, not a disabled one');
  assert.equal(UNIT_SEPARATION_POLICY.cash_out, false);
  assert.equal(UNIT_SEPARATION_POLICY.token, false);
  assert.match(UNIT_SEPARATION_POLICY.description, /four separate units/);
  // Only NemoCoin exists as a balance. The other three are unimplemented concepts with no ledger at
  // all, which is a stronger statement than a zero balance.
  const implemented = CREDIT_UNITS.filter((unit) => unit.implemented);
  assert.deepEqual(implemented.map((unit) => unit.id), ['nemocoin']);
  assert.equal(implemented[0].ledger, 'coin_rewards');
  for (const unit of CREDIT_UNITS) {
    assert.equal(unit.transferable, false, `${unit.id} is not transferable`);
    assert.equal(unit.cash_value, false, `${unit.id} has no cash value`);
    assert.equal(unit.convertible, false, `${unit.id} is not convertible`);
  }
  for (const unit of CREDIT_UNITS.filter((entry) => !entry.implemented)) {
    assert.equal(unit.ledger, null, `${unit.id} names no ledger`);
    assert.equal(unit.balance, false, `${unit.id} holds no balance`);
    assert.match(unit.description, /Unimplemented concept/);
  }
  // Karma is a fifth unit of account and states the same rules as booleans, not as prose.
  assert.equal(KARMA_POLICY.separate_unit, true);
  for (const flag of ['transferable', 'transferable_between_accounts', 'transferable_between_residents', 'cash_value', 'cash_out', 'token', 'convertible', 'convertible_from_nemo_coins', 'convertible_to_nemo_coins', 'convertible_to_money', 'convertible_to_carbon_credits', 'buys_land', 'buys_role', 'buys_experience', 'buys_review_authority', 'buys_moderation_power', 'buys_runtime_scope']) {
    assert.equal(KARMA_POLICY[flag], false, `KARMA_POLICY.${flag} must be false`);
  }
  assert.equal(KARMA_POLICY.currency === COIN_POLICY.currency, false, 'two units, two names');
  assert.equal(COIN_POLICY.transferable, false);
  // The classification names every one of them as account-bound, with its own reason, so a reader of
  // this world's goods table cannot mistake a unit of account for something that moves.
  const bound = GOOD_FAMILIES.filter((family) => family.classification === GOOD_CLASSES.account_bound).map((family) => family.id);
  for (const family of ['karma_coin', 'nemo_coin', 'compute_credit', 'real_money', 'carbon_credit', 'calling_experience', 'land_stewardship', 'role_authority', 'runtime_scope', 'shop_cosmetic', 'shop_object_grant']) assert.ok(bound.includes(family), `${family} is account-bound`);
});

test('no route, method or module in this build converts, cashes out or sells one unit as another', () => {
  // 1. The shipped HTTP surface: every write route and every read route, collected from the server's
  //    own tables rather than from a list kept beside them.
  const server = here('../server.js');
  const routes = [...server.matchAll(/\[?'(\/[a-z0-9/_-]+)'/g)].map((match) => match[1]);
  assert.ok(routes.length > 100, `the route table was read (${routes.length} routes)`);
  const forbidden = /convert|exchange|swap|cashout|cash-out|cash_out|redeem|payout|top-?up|sell|mint|gift|transfer/;
  const offenders = routes.filter((route) => forbidden.test(route));
  assert.deepEqual(offenders, [], 'no route converts, cashes out, sells, mints, gifts or transfers value');
  // 2. No route names two units at once, which is what a conversion endpoint would have to do.
  for (const route of routes) {
    const units = ['karma', 'coin', 'credit', 'money', 'carbon'].filter((unit) => route.includes(unit));
    assert.ok(units.length <= 1, `${route} names more than one unit of account: ${units.join(', ')}`);
  }
  // 3. The two currency modules never name each other's tables, so neither can write the other's
  //    ledger even by accident. The classification table is the only module that names both, and it
  //    contains no write statement at all.
  const karma = here('../src/karma.js'), coins = here('../src/coins.js');
  assert.doesNotMatch(karma, /coin_rewards|coinMethods|COIN_POLICY/);
  assert.doesNotMatch(coins, /karma_receipts|karma_purchases|KARMA_POLICY/);
  assert.doesNotMatch(KARMA_SCHEMA, /coin_rewards/);
  assert.doesNotMatch(COIN_SCHEMA, /karma/);
  for (const module of ['../src/goods-policy.js', '../src/economy-provenance.js']) {
    const source = room(module);
    assert.doesNotMatch(source, /INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|\.db\.exec/, `${module} writes nothing`);
  }
  // 4. The two ledgers are separate schemas with separate protections, and neither carries a column
  //    that could hold the other's amount.
  assert.doesNotMatch(KARMA_SCHEMA, /\bnemo|\bcoin_amount/);
  assert.doesNotMatch(COIN_SCHEMA, /\bkarma/);
});

test('a reward in one ledger is never counted as another, and cannot pay for the other\u2019s goods', async (t) => {
  const f = await fixture(t), resident = f.agent('alice'), m = realMission(f);
  // One account, both ledgers: ten NemoCoins from an independent acceptance and six Karma Coins from
  // a thank-you to another operator, at the same moment.
  const claim = f.tx('claim', f.actor('alice'), { task_id: m.task.id, agent_id: resident.id }, 'sep-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'A separated fixture contribution.' }), 'sep-submit');
  const review = f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent fixture review' });
  assert.equal(review.coin_reward.amount, 10);
  f.tx('giveThanks', f.actor('alice'), { agent_id: resident.id, recipient_agent_id: f.agent('bob').id, reason: 'Thank you for reviewing my route.' });
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: resident.id }).balance, 6);
  const coins = f.platform.coins(f.actor('alice'), { agent_id: resident.id });
  const wallet = f.platform.karmaWallet(f.actor('alice'), { agent_id: resident.id });
  assert.equal(coins.balance, 10);
  assert.equal(wallet.balance, 6);
  assert.equal(coins.currency, undefined, 'the coin wallet names its unit in its policy, not as a second field to drift');
  assert.equal(coins.policy.currency, 'Nemo Coins');
  assert.equal(wallet.currency, 'Karma Coins');
  // Each sum is its own rows, and neither ledger holds the other's amount anywhere.
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n, 10);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM karma_receipts').n, 6);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM coin_rewards WHERE amount!=10").n, 0, 'no coin receipt carries a Karma amount');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM karma_receipts WHERE amount NOT IN (2,6)").n, 0, 'no Karma receipt carries a coin amount');
  // The counting half: ten NemoCoins cannot pay for eight Karma Coins' worth of goods. A purse of one
  // unit is not a balance of the other, and the shop asks the Karma wallet alone.
  const refused = await (async () => { try { f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: resident.id }, 'sep-buy-1'); return null; } catch (error) { return error; } })();
  assert.equal(refused?.status, 409, 'a purchase is refused for a short Karma purse, not paid from the coin balance');
  assert.match(refused.message, /holds 6 Karma Coins, so it cannot pay 8/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 0);
  assert.equal(f.platform.coins(f.actor('alice'), { agent_id: resident.id }).balance, 10, 'the coin balance is untouched by a refused Karma purchase');
  // The provenance report keeps the two ledgers in their own fields and never sums them.
  const report = f.platform.economyProvenance(f.actor('alice'), {});
  assert.equal(report.ledger.coin_balance, 10);
  assert.equal(report.ledger.karma_balance, 6);
  assert.equal(report.ledger.coin_receipts_count, 1);
  assert.equal(report.ledger.karma_receipts_count, 1);
  assert.deepEqual(report.rewards.map((reward) => reward.ledger).sort(), ['coins', 'karma']);
  assert.equal(report.rewards.find((reward) => reward.ledger === 'coins').unit, 'coins');
  assert.equal(report.rewards.find((reward) => reward.ledger === 'karma').unit, 'karma');
  assert.equal(verifyCoinLedger(f.platform.db), true);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('no path buys, sells or transfers land, a role, a scope or an experience point', async (t) => {
  const f = await fixture(t), resident = f.agent('alice');
  // The shop states what it can never sell, and its own catalogue stocks none of it.
  assert.deepEqual(SHOP_POLICY.never_sells, ['land', 'roles', 'authority', 'experience points', 'review power', 'real-world value']);
  assert.equal(SHOP_POLICY.moves_land, false);
  assert.equal(SHOP_POLICY.moves_roles, false);
  assert.equal(SHOP_POLICY.moves_scopes, false);
  assert.equal(SHOP_POLICY.cash_value, false);
  assert.equal(SHOP_POLICY.convertible, false);
  const stocked = [...new Set(SHOP_CATALOGUE.map((good) => good.category))];
  assert.ok(stocked.length >= 2, 'the shop stocks more than one kind of good');
  for (const category of stocked) assert.ok(SHOP_CATEGORIES.includes(category), `${category} is a shop category`);
  for (const good of SHOP_CATALOGUE) assert.doesNotMatch(good.id, /land|plot|role|scope|authority|experience|coin|money|carbon/);
  // A land-shaped, role-shaped or unit-shaped good is simply not in the catalogue, with no route that
  // could invent it: the good id is read from the request and matched against the frozen list.
  for (const id of ['land', 'plot', 'frontier', 'role', 'admin', 'scope', 'experience', 'nemocoin', 'karma_coin', 'money', 'carbon_credit']) {
    assert.throws(() => f.tx('shopPurchase', f.actor('alice'), { good_id: id, agent_id: resident.id }, `sep-${id}`), (error) => error.status === 400 && /does not sell that good/.test(error.message));
  }
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 0);
  // A plot is assigned by the world to an account and released by the world; there is no price, no
  // sale, no transfer and no purchase behind it, and no ledger column that could hold one.
  const plots = f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n;
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0, 'nobody starts with land');
  assert.deepEqual(f.platform.all('PRAGMA table_info(land_stewardships)').map((column) => column.name), ['plot_id', 'account_id', 'purpose', 'description', 'assigned_at'], 'stewardship has no price, no buyer and no amount');
  assert.deepEqual(f.platform.all('PRAGMA table_info(karma_purchases)').map((column) => column.name).filter((name) => /plot|land|parcel|role|scope/.test(name)), [], 'the Karma ledger has no column that could name land, a role or a scope');
  // The gift and transfer flags are stated on the shop itself, and no method moves Karma to a second
  // account: the shop's own write names the buyer and the buyer's resident only.
  assert.equal(SHOP_POLICY.gift_or_transfer, false);
  const shop = room('../src/shop.js');
  assert.match(shop, /shopPurchase\(platform, actor, input = \{\}, key\)/);
  assert.match(shop, /agent\.id, good\.id/, 'a purchase grants to the buyer\u2019s own resident');
  assert.equal(plots, f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n, 'no purchase created a plot');
});
