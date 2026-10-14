// The garden transition the browser suite deliberately skips: a crop that ripens on the server clock.
//
// The shipped browser scenarios plant, tend and reload a crop, then grant the grown resources a real
// harvest would produce, because waiting twenty minutes of wall clock inside the browser gate tests
// nothing. This file drives the same two routes a browser uses — `POST /journey/garden` and the crop
// patch of `POST /interact` — against a temporary database whose clock the fixture moves, so the
// maturity instant, the refused early harvest, the saved resources and the single receipt a harvest
// earns are asserted at the level the server decides them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

const HERB_GROWTH = 20 * 60_000, WOOD_GROWTH = 30 * 60_000, TEND_SAVING = 5 * 60_000;
const TILE = { x: 8, y: 7 };

async function setup(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', account, token, input, key } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: {
        ...(input ? { 'Content-Type': 'application/json' } : {}),
        ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { ...f, request };
}

/**
 * The garden a resident farms: the resident travels to its own home, one crop patch is placed, and the
 * resident stands beside it. This is fixture setup — the planting, the tending and the harvest below
 * are the shipped HTTP actions, and every assertion reads a row the server wrote.
 */
async function prepareGarden(f, agent, calling = 'cultivator') {
  const garden = `home:${agent.id}`;
  assert.equal(f.tx('travel', f.actor('alice'), agent.id, { world_id: garden }).world_id, garden);
  f.tx('build', f.actor('alice'), agent.id, { type: 'farm', ...TILE });
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', TILE.x, TILE.y + 1, agent.id);
  assert.equal(f.platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, TILE.x, TILE.y).type, 'farm');
  if (calling) assert.equal((await f.request('/callings/select', { method: 'POST', account: 'alice', input: { agent_id: agent.id, calling_id: calling } })).status, 200);
  return garden;
}

const storedCrop = (f, agent) => f.platform.get('SELECT kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=? AND y=?', agent.id, TILE.x, TILE.y);
const inventory = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', agent.id).map((item) => [item.kind, item.quantity]));
const receipts = (f, agent) => f.platform.all('SELECT objective_id,source_kind,source_id,points,earned_day FROM calling_receipts WHERE agent_id=? ORDER BY objective_id', agent.id);
const harvestCount = (f) => f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='journey.harvest'").n;
const cropOnTile = (f, agent, journey) => journey.data.crops.find((crop) => crop.x === TILE.x && crop.y === TILE.y);

/** Reads the crop patch through the interaction route, exactly as the world panel does. */
async function readTile(f, agent, garden) {
  const read = await f.request(`/interact?world_id=${encodeURIComponent(garden)}&x=${TILE.x}&y=${TILE.y}&agent_id=${agent.id}`, { account: 'alice' });
  assert.equal(read.status, 200);
  assert.equal(read.data.fixture.kind, 'crop_patch');
  return read.data.fixture;
}

/** The harvest the panel offers — whether a tend is still available beside it or not. */
const harvestOption = (fixture) => fixture.action.options.find((option) => option.action === 'harvest');

const plant = (f, agent, kind) => f.request('/journey/garden', { method: 'POST', account: 'alice', input: { agent_id: agent.id, action: 'plant', kind, x: TILE.x, y: TILE.y } });
const tend = (f, agent) => f.request('/journey/garden', { method: 'POST', account: 'alice', input: { agent_id: agent.id, action: 'tend', x: TILE.x, y: TILE.y } });
const harvest = (f, agent) => f.request('/journey/garden', { method: 'POST', account: 'alice', input: { agent_id: agent.id, action: 'harvest', x: TILE.x, y: TILE.y } });
const harvestByHand = (f, agent, key) => f.request('/interact', { method: 'POST', account: 'alice', key, input: { agent_id: agent.id, x: TILE.x, y: TILE.y, action: 'garden', garden_action: 'harvest' } });

test('a crop ripens on the server clock and one harvest is credited once through the garden and interaction routes', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const garden = await prepareGarden(f, alice);

  const planted = await plant(f, alice, 'herbs');
  assert.equal(planted.status, 200);
  assert.equal(planted.data.crop.kind, 'herbs');
  assert.equal(planted.data.crop.harvested_at, null);
  assert.equal(planted.data.crop.ready, false);
  assert.equal(planted.data.crop.ready_at - planted.data.crop.planted_at, HERB_GROWTH, 'sown herbs ripen twenty minutes after planting');

  // The panel offers the crop it can see: a tend, and a harvest named as not yet possible.
  const growing = await readTile(f, alice, garden);
  assert.deepEqual(growing.action.options, [
    { action: 'tend', label: 'Tend the crop (saves up to 5 minutes)' },
    { action: 'harvest', label: 'Harvest when the crop is ready', available: false },
  ]);
  assert.equal(growing.action.label, 'Tend the crop', 'the offered verb must be the one that can work now');
  assert.equal(growing.can_act, true);
  assert.equal(growing.distance, 1);
  assert.equal(growing.blocked_by, null);

  // An early harvest is refused on both routes, and neither refusal writes anything.
  const early = await harvest(f, alice);
  assert.equal(early.status, 409);
  assert.equal(early.data.error, 'This crop is still growing.');
  const earlyByHand = await harvestByHand(f, alice, 'journey-harvest-early');
  assert.equal(earlyByHand.status, 409);
  assert.equal(earlyByHand.data.error, 'This crop is still growing.');
  assert.match(earlyByHand.data.next_step, /tend it once to shorten the wait/);
  assert.equal(storedCrop(f, alice).harvested_at, null);
  assert.deepEqual(inventory(f, alice), {});
  assert.equal(f.platform.get('SELECT harvests FROM journey_profiles WHERE agent_id=?', alice.id).harvests, 0);
  assert.equal(harvestCount(f), 0);
  assert.equal(receipts(f, alice).length, 0);

  // One tend is allowed, shortens this crop by five minutes, and cannot be repeated.
  const tended = await tend(f, alice);
  assert.equal(tended.status, 200);
  assert.equal(tended.data.crop.tended_at, f.clock());
  assert.equal(tended.data.crop.ready_at - tended.data.crop.planted_at, HERB_GROWTH - TEND_SAVING);
  const twice = await tend(f, alice);
  assert.equal(twice.status, 409);
  assert.equal(twice.data.error, 'This crop has already been tended.');
  assert.deepEqual((await readTile(f, alice, garden)).action.options,
    [{ action: 'harvest', label: 'Harvest when the crop is ready', available: false }],
    'a tended crop offers only the harvest it is waiting for');

  // The readiness instant is the server's, not the caller's: one millisecond early is still refused.
  const readyAt = storedCrop(f, alice).planted_at + HERB_GROWTH - TEND_SAVING;
  f.advance(readyAt - f.clock() - 1);
  assert.equal(harvestOption(await readTile(f, alice, garden)).available, false);
  assert.equal(cropOnTile(f, alice, await f.request(`/journey?agent_id=${alice.id}`, { account: 'alice' })).ready, false);
  assert.equal((await harvest(f, alice)).status, 409);

  f.advance(1);
  const ripe = await readTile(f, alice, garden);
  assert.deepEqual(ripe.action.options, [{ action: 'harvest', label: 'Harvest 4 resources', available: true }]);
  assert.equal(ripe.action.label, 'Harvest 4 resources');
  assert.match(ripe.hint, /Harvest 4 resources/);

  // The harvest itself, through the crop patch the panel renders.
  const harvested = await harvestByHand(f, alice, 'journey-harvest-1');
  assert.equal(harvested.status, 200);
  assert.equal(harvested.data.interaction.kind, 'crop_patch');
  assert.equal(harvested.data.interaction.action, 'garden');
  assert.equal(harvested.data.result.crop.harvested_at, f.clock());
  assert.deepEqual(harvested.data.result.inventory, [{ kind: 'herbs', quantity: 4 }]);
  const stored = storedCrop(f, alice);
  assert.equal(stored.harvested_at, f.clock());
  assert.deepEqual(inventory(f, alice), { herbs: 4 });
  assert.equal(f.platform.get('SELECT harvests FROM journey_profiles WHERE agent_id=?', alice.id).harvests, 1);
  assert.equal(harvestCount(f), 1);

  // The same click with the same key is one write; a fresh key for the same tile is refused by the
  // crop's own state, so no second gathering and no second credit can exist.
  const replayed = await harvestByHand(f, alice, 'journey-harvest-1');
  assert.equal(replayed.status, 200);
  assert.equal(replayed.data.replay, true);
  assert.equal(replayed.data.result.crop.harvested_at, stored.harvested_at);
  const again = await harvestByHand(f, alice, 'journey-harvest-2');
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'There is no growing crop on this tile.');
  assert.match(again.data.next_step, /Plant herbs, fiber or wood on this tile first/);
  assert.deepEqual(inventory(f, alice), { herbs: 4 }, 'the second click must gather nothing again');
  assert.equal(f.platform.get('SELECT harvests FROM journey_profiles WHERE agent_id=?', alice.id).harvests, 1);
  assert.equal(harvestCount(f), 1);

  // The Cultivator's harvest objective is credited from the harvest, and a harvest is not a coin.
  const calling = await f.request(`/callings?agent_id=${alice.id}`, { account: 'alice' });
  assert.equal(calling.status, 200);
  assert.deepEqual(receipts(f, alice).map((row) => row.objective_id), ['cultivator.crop_harvest', 'cultivator.crop_plant']);
  const earned = receipts(f, alice).find((row) => row.objective_id === 'cultivator.crop_harvest');
  assert.equal(earned.source_kind, 'crop_harvest');
  assert.equal(earned.source_id, `${TILE.x}:${TILE.y}:${stored.planted_at}`, 'the receipt must name the exact planting that was gathered');
  assert.equal(earned.points, 5);
  assert.equal(calling.data.calling.id, 'cultivator');
  assert.equal(calling.data.today.earned, 10, 'the planting and the harvest each spend five of the ten a day');
  assert.equal(calling.data.today.remaining, 0);
  assert.equal(calling.data.experience.cosmetic, true);
  const wallet = await f.request(`/coins?agent_id=${alice.id}`, { account: 'alice' });
  assert.equal(wallet.data.balance, 0);
  assert.equal(wallet.data.receipt_count, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  // Reading the boards again cannot credit the same planting twice.
  assert.equal((await f.request(`/callings?agent_id=${alice.id}`, { account: 'alice' })).data.today.earned, 10);
  assert.equal(receipts(f, alice).length, 2);
});

test('a harvested tile carries a new planting with its own growth time, and gathered resources are not experience', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const garden = await prepareGarden(f, alice);

  // Cycle one: herbs, tended once, gathered at the served instant.
  assert.equal((await plant(f, alice, 'herbs')).status, 200);
  const firstPlanting = storedCrop(f, alice).planted_at;
  assert.equal((await tend(f, alice)).status, 200);
  f.advance(HERB_GROWTH - TEND_SAVING);
  assert.equal((await harvest(f, alice)).status, 200);
  assert.deepEqual(inventory(f, alice), { herbs: 4 });

  // Cycle two: the same tile takes a new planting, timed from its own planting and nothing else.
  const replanted = await plant(f, alice, 'wood');
  assert.equal(replanted.status, 200);
  assert.equal(replanted.data.crop.kind, 'wood');
  assert.equal(replanted.data.crop.harvested_at, null);
  assert.equal(replanted.data.crop.tended_at, null, 'the gathered planting’s tend must not carry into the next one');
  assert.equal(replanted.data.crop.ready_at - replanted.data.crop.planted_at, WOOD_GROWTH);
  assert.notEqual(storedCrop(f, alice).planted_at, firstPlanting);
  // The tile must not inherit the shorter crop's ripening instant.
  f.advance(HERB_GROWTH);
  assert.equal(harvestOption(await readTile(f, alice, garden)).available, false, 'a fresh planting is never ready at the earlier crop’s instant');
  assert.equal((await harvest(f, alice)).status, 409);
  f.advance(WOOD_GROWTH - HERB_GROWTH);
  const harvested = await harvestByHand(f, alice, 'cycle-2-harvest');
  assert.equal(harvested.status, 200);
  assert.deepEqual(harvested.data.result.inventory, [{ kind: 'herbs', quantity: 4 }, { kind: 'wood', quantity: 2 }]);
  assert.equal(f.platform.get('SELECT harvests FROM journey_profiles WHERE agent_id=?', alice.id).harvests, 2);
  assert.equal(harvestCount(f), 2);

  // Gathered resources are not experience: the second harvest yields its two resources while the day's
  // cosmetic allowance is already spent, so the receipts stay at the two the first cycle earned.
  const calling = await f.request(`/callings?agent_id=${alice.id}`, { account: 'alice' });
  assert.equal(inventory(f, alice).wood, 2);
  assert.equal(calling.data.today.earned, 10);
  assert.equal(calling.data.experience.earned, 10);
  assert.equal(receipts(f, alice).length, 2, 'a spent daily allowance is not a second receipt');
  // The allowance is a window on the day, not a bank: a fact recorded on a spent day is never credited
  // later, so a resident cannot farm facts on one day and claim them on the next.
  f.advance(86_400_000);
  const nextDay = await f.request(`/callings?agent_id=${alice.id}`, { account: 'alice' });
  assert.equal(nextDay.data.today.earned, 0);
  assert.equal(nextDay.data.experience.earned, 10);
  assert.equal(receipts(f, alice).length, 2);
  // A third cycle on the new day is credited again, so the limit is a window and not a block.
  assert.equal((await plant(f, alice, 'herbs')).status, 200);
  f.advance(HERB_GROWTH);
  assert.equal((await harvest(f, alice)).status, 200);
  assert.equal(f.platform.get('SELECT harvests FROM journey_profiles WHERE agent_id=?', alice.id).harvests, 3);
  const credited = await f.request(`/callings?agent_id=${alice.id}`, { account: 'alice' });
  assert.equal(credited.data.today.earned, 10, 'the new day earns its own planting and harvest');
  assert.equal(receipts(f, alice).length, 4);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0, 'no amount of gardening mints a NemoCoin');
});
