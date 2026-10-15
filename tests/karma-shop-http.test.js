import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { validateDatabase } from '../src/recovery.js';
import { verifyKarmaLedger, KARMA_POLICY } from '../src/karma.js';
import { shopCatalogue } from '../src/shop.js';
import { getWorldDefinition, walkable } from '../world.js';

const count = (f, sql, ...args) => f.platform.get(sql, ...args).n;

/** A real listener on a real temporary database, with the shipped `req` closure idiom. */
async function open(t, f) {
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { token, input, method = input ? 'POST' : 'GET', key } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { base, req };
}

/** Free walkable garden tiles a resident may build on, clear of the arrival, its exits and each other. */
const freeTiles = (worldId, taken = []) => {
  const definition = getWorldDefinition(worldId);
  const tiles = [];
  for (let y = 2; y < definition.rows - 2; y += 1) for (let x = 2; x < definition.columns - 2; x += 1) {
    if (!walkable({ x, y }, definition)) continue;
    if (Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) <= 2) continue;
    if ((definition.portals || []).some((portal) => Math.abs(portal.x - x) + Math.abs(portal.y - y) <= 2)) continue;
    if (taken.some((tile) => tile.x === x && tile.y === y)) continue;
    tiles.push({ x, y });
  }
  return tiles;
};

test('a resident earns Karma Coins from saved service in its own space and spends them once in the shop', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const garden = `home:${resident.id}`;
  const cottage = `house:${resident.id}`;
  const { req } = await open(t, f);
  const token = f.credentials.alice.token;

  // 1. The complimentary personal space. Every resident of an account owns one garden and one cottage
  //    the moment it exists, and it is reached by the ordinary travel route, not by a special case.
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM worlds WHERE id=? AND kind=?', garden, 'home'), 1, 'a resident must own a personal garden');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM worlds WHERE id=? AND kind=?', cottage, 'house'), 1, 'a resident must own a personal cottage');
  assert.equal((await req(`/world?world_id=${garden}`, { token })).status, 200, 'the personal space must be readable by its owner');

  // 2. Real service, through the shipped methods only: travel home, lay two farm patches, plant two
  //    crops and place two garden objects. Nothing here is a client claim; every row is server-written.
  f.tx('travel', f.actor('alice'), resident.id, { world_id: garden });
  const [farmOne, farmTwo, bench, lantern] = freeTiles(garden);
  f.tx('build', f.actor('alice'), resident.id, { x: farmOne.x, y: farmOne.y, type: 'farm' });
  f.tx('gardenAction', f.actor('alice'), { agent_id: resident.id, action: 'plant', kind: 'herbs', x: farmOne.x, y: farmOne.y });
  f.tx('build', f.actor('alice'), resident.id, { x: farmTwo.x, y: farmTwo.y, type: 'farm' });
  f.tx('gardenAction', f.actor('alice'), { agent_id: resident.id, action: 'plant', kind: 'fiber', x: farmTwo.x, y: farmTwo.y });
  f.tx('build', f.actor('alice'), resident.id, { x: bench.x, y: bench.y, type: 'bench' });
  f.tx('build', f.actor('alice'), resident.id, { x: lantern.x, y: lantern.y, type: 'lantern' });
  const coinsBefore = count(f, 'SELECT COUNT(*) AS n FROM coin_rewards');
  const parcelsBefore = count(f, 'SELECT COUNT(*) AS n FROM land_parcels');
  const stewardshipsBefore = count(f, 'SELECT COUNT(*) AS n FROM land_stewardships');

  // 3. Settling is the operator's one action: it turns saved service into receipts and nothing else.
  const settled = await req('/karma/settle', { token, input: { agent_id: resident.id } });
  assert.equal(settled.status, 200, `settling must be a signed-in operator action: ${JSON.stringify(settled.data)}`);
  assert.equal(settled.data.balance, 8, 'two planted crops and two saved objects earn eight Karma Coins');
  const sources = f.platform.all('SELECT service_id,amount FROM karma_receipts WHERE agent_id=? ORDER BY service_id', resident.id);
  assert.deepEqual(sources.map((row) => row.service_id), ['garden_crop', 'garden_crop', 'home_furnishing', 'home_furnishing'], 'each receipt must name the saved act it was earned by');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=? AND type=?', garden, 'farm').n, 2, 'the farm tiles are the garden’s own tool and earn nothing themselves');

  const again = await req('/karma/settle', { token, input: { agent_id: resident.id } });
  assert.equal(again.data.minted, 0, 'settling twice must not mint the same saved row twice');
  assert.equal(again.data.balance, 8, 'a repeated settle leaves the purse alone');

  // 4. The wallet and the shop read the same purse, and the shop's own policy says what it never sells.
  const wallet = await req(`/karma?agent_id=${resident.id}`, { token });
  assert.equal(wallet.status, 200);
  assert.equal(wallet.data.balance, 8);
  assert.equal(wallet.data.currency, KARMA_POLICY.currency);
  assert.equal(wallet.data.entries.filter((entry) => entry.direction === 'earn').length, 4, 'the ledger shows where every coin came from');
  assert.ok(wallet.data.services.every((service) => service.tier === 'world' || service.requires_other_operator === true), 'every service that pays six requires another operator');
  const shop = await req(`/shop?agent_id=${resident.id}`, { token });
  assert.equal(shop.status, 200);
  assert.equal(shop.data.balance, 8);
  const bundle = shop.data.goods.find((good) => good.id === 'herbs');
  assert.equal(bundle.can_afford, true);
  assert.equal(bundle.remaining_today, bundle.daily_limit);
  assert.match(shop.data.policy.never_sells.join(' '), /land/);

  // 5. One purchase: the debit and the grant commit together, and the good is usable afterwards.
  const key = 'fixture-purchase-0001';
  const bought = await req('/shop/purchase', { token, key, input: { agent_id: resident.id, good_id: 'herbs' } });
  assert.equal(bought.status, 200, `a purchase with enough Karma must succeed: ${JSON.stringify(bought.data)}`);
  assert.equal(bought.data.balance_after, 0);
  assert.equal(f.platform.get('SELECT quantity AS n FROM journey_inventory WHERE agent_id=? AND kind=?', resident.id, 'herbs').n, 2, 'the bought resource lands on the resident’s own shelf');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM shop_purchases WHERE account_id=?', f.actor('alice').account.id), 1);

  // A replay of the same key grants nothing twice, and a second attempt with no Karma is refused.
  const replay = await req('/shop/purchase', { token, key, input: { agent_id: resident.id, good_id: 'herbs' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.repeated, true, 'a replayed purchase key must be answered from the recorded purchase');
  assert.equal(f.platform.get('SELECT quantity AS n FROM journey_inventory WHERE agent_id=? AND kind=?', resident.id, 'herbs').n, 2, 'a replayed key must grant nothing twice');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM shop_purchases'), 1, 'a replayed key must record no second purchase');
  const broke = await req('/shop/purchase', { token, key: 'fixture-purchase-0002', input: { agent_id: resident.id, good_id: 'herbs' } });
  assert.ok(broke.status >= 400, 'a purchase beyond the purse must be refused');
  assert.equal(f.platform.get('SELECT quantity AS n FROM journey_inventory WHERE agent_id=? AND kind=?', resident.id, 'herbs').n, 2);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM karma_purchases'), 1, 'a refused purchase leaves no debit row');

  // 6. A resident credential can neither earn nor spend: only the signed-in operator can.
  const runtime = f.tx('runtime', f.actor('alice'), resident.id, { minutes: 5, max_calls: 20, scopes: ['read', 'build'] });
  assert.equal((await req('/karma/settle', { token: runtime.token, input: { agent_id: resident.id } })).status, 403, 'a runtime credential must not settle Karma Coins');
  assert.equal((await req('/shop/purchase', { token: runtime.token, key: 'fixture-purchase-0003', input: { agent_id: resident.id, good_id: 'herbs' } })).status, 403, 'a runtime credential must not spend Karma Coins');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM karma_receipts'), 4, 'a refused settle mints nothing');

  // 7. The loop moves nothing else: no NemoCoin, no land, and both ledgers still prove themselves.
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), coinsBefore, 'earning or spending Karma must mint no NemoCoin');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM land_parcels'), parcelsBefore, 'the finite land registry is untouched');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM land_stewardships'), stewardshipsBefore, 'Karma buys no stewardship');
  assert.equal(verifyKarmaLedger(f.platform.db), true, 'both Karma chains must verify after the loop');
  assert.equal(validateDatabase(f.database).schema_version, 26, 'the database must validate at the current schema');
  assert.equal(shopCatalogue(f.platform, f.actor('alice'), { agent_id: resident.id }).goods.every((good) => good.price >= 8), true);
});

test('the same loop is refused for any request that names its own amount, source or day', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const { req } = await open(t, f);
  const token = f.credentials.alice.token;
  // A fresh purse holds nothing, and no field in any request can change that.
  const wallet = await req(`/karma?agent_id=${resident.id}`, { token });
  assert.equal(wallet.data.balance, 0);
  for (const input of [
    { agent_id: resident.id, amount: 5000 },
    { agent_id: resident.id, source_kind: 'garden_crop', source_id: 'invented', tier: 'service' },
    { agent_id: resident.id, award_day: '2099-01-01' },
  ]) {
    const response = await req('/karma/settle', { token, input });
    assert.ok(response.status >= 400, `settle must refuse extra fields: ${JSON.stringify(input)}`);
  }
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM karma_receipts'), 0, 'no request field can mint a receipt');
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM karma_purchases'), 0, 'no request field can spend');
});
