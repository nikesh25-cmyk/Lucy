import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { journeyMethods, CROP_CARE, CROP_CARE_BONUS, CROP_LIMITS, CROP_POLICY, CROP_STAGES, cropYield, savedSeedFrom } from '../src/journey.js';
import { verifyCoinLedger } from '../src/coins.js';
import content from '../src/content.js';
import { fixture } from './helpers.js';

Object.assign(Platform.prototype, journeyMethods);

const MINUTE = 60_000;
const grow = content.crops();
const kinds = Object.keys(grow);
const sealedYield = (kind) => content.entry(kind, 'crop').rules.yield.quantity;
const denied = (operation, status) => assert.throws(operation, (error) => error.status === status);

async function setup(t) {
  const f = await fixture(t);
  f.platform.initJourney();
  return f;
}
/** One farm tile in the resident's own garden, ready to plant on. */
function patch(f, agent, x, y) {
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  f.platform.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type=excluded.type',
    `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, 'farm', x, y, new Date(f.clock()).toISOString());
}
const sow = (f, agent, kind, x, y, extra = {}) => { patch(f, agent, x, y); return f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, action: 'plant', kind, x, y, ...extra }); };
const act = (f, agent, action, x, y, extra = {}) => f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, action, x, y, ...extra });
const passport = (f, agent) => f.platform.journey(f.actor('alice'), { agent_id: agent.id });
const cropAt = (f, agent, x, y) => passport(f, agent).crops.find((crop) => crop.x === x && crop.y === y);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', agent.id).map((item) => [item.kind, item.quantity]));
const rows = (f, agent) => f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', agent.id).n;
const growing = (f, agent) => f.platform.get("SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=? AND harvested_at IS NULL", agent.id).n;
const coinRows = (platform, agent) => platform.get('SELECT COUNT(*) AS n FROM coin_rewards WHERE agent_id=?', agent.id).n;

test('a crop walks named stages on the server clock, and the ready moment it publishes is the one a harvest checks', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  assert.deepEqual(CROP_STAGES, ['sprout', 'leafing', 'ripening', 'ready']);
  assert.equal(CROP_LIMITS.growing, 20, 'the sealed garden cap is the one the garden enforces');
  assert.equal(CROP_LIMITS.growing, Math.min(...kinds.map((kind) => content.entry(kind, 'crop').rules.max_growing)));
  const tiles = kinds.map((kind, index) => ({ kind, grow: grow[kind], band: grow[kind] / 3, x: 3 + index, y: 6 }));
  for (const tile of tiles) patch(f, agent, tile.x, tile.y);
  const plantedAt = f.clock();
  for (const tile of tiles) {
    const planted = act(f, agent, 'plant', tile.x, tile.y, { kind: tile.kind });
    assert.equal(planted.crop.planted_at, plantedAt, 'the planting time is the server clock');
    assert.equal(planted.crop.ready_at - planted.crop.planted_at, tile.grow, `${tile.kind} keeps its sealed growth time`);
    assert.equal(planted.crop.next_stage_at, plantedAt + tile.band, `${tile.kind} names the band it will move into`);
    assert.equal(planted.crop.stage, 'sprout');
    assert.equal(planted.crop.stage_index, 0);
    assert.equal(planted.crop.stage_at, plantedAt);
    assert.equal(planted.crop.ready, false);
  }
  // The clock alone moves every crop on, one sealed band at a time. A passport re-reads the same
  // derivation the action wrote, so the panel and the harvest can never disagree about the stage.
  const schedule = [[400_000, 'herbs', 'leafing'], [500_000, 'fiber', 'leafing'], [600_000, 'wood', 'leafing'], [800_000, 'herbs', 'ripening'], [1_000_000, 'fiber', 'ripening'], [1_200_000, 'herbs', 'ready'], [1_500_000, 'fiber', 'ready'], [1_800_000, 'wood', 'ready']];
  const expectedStage = (tile, elapsed) => elapsed >= tile.band * 3 ? 'ready' : elapsed >= tile.band * 2 ? 'ripening' : elapsed >= tile.band ? 'leafing' : 'sprout';
  let elapsed = 0;
  for (const [at, kind, stage] of schedule) {
    f.advance(at - elapsed);
    elapsed = at;
    const tile = tiles.find((item) => item.kind === kind);
    assert.equal(cropAt(f, agent, tile.x, tile.y).stage, stage, `${kind} at ${at}ms must stand in ${stage}`);
    for (const other of tiles) assert.equal(cropAt(f, agent, other.x, other.y).stage, expectedStage(other, elapsed), `${other.kind} at ${at}ms`);
  }
  // One millisecond before the published ready moment is still growing, a body cannot move that
  // moment, and the same millisecond it passes the gather is allowed.
  const last = sow(f, agent, 'herbs', 9, 6);
  assert.equal(last.crop.ready_at, last.crop.planted_at + 20 * MINUTE);
  f.advance(20 * MINUTE - 1);
  denied(() => act(f, agent, 'harvest', 9, 6), 409);
  denied(() => act(f, agent, 'harvest', 9, 6, { ready_at: 0, planted_at: 0, server_time: f.clock() + 86_400_000 }), 409);
  assert.equal(cropAt(f, agent, 9, 6).ready, false);
  f.advance(1);
  assert.equal(cropAt(f, agent, 9, 6).ready, true);
  assert.equal(act(f, agent, 'harvest', 9, 6).gathered.quantity, sealedYield('herbs'));
  // A planting body cannot write the times either: the stored row is the server's own clock.
  const asserted = sow(f, agent, 'herbs', 10, 6, { planted_at: 0, ready_at: 0, stage: 'ready', tended_at: 0 });
  assert.equal(asserted.crop.planted_at, f.clock());
  assert.equal(asserted.crop.tended_at, null);
  assert.equal(asserted.crop.stage, 'sprout');
  assert.equal(asserted.crop.ready, false);
});

test('tending records care, moves the crop on, and measurably raises a bounded harvest that the saved row explains', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), sealed = sealedYield('herbs'), ceiling = sealed + CROP_LIMITS.yield_bonus;
  assert.deepEqual(CROP_CARE, ['plain', 'careful', 'bountiful', 'late']);
  assert.equal(CROP_LIMITS.yield_bonus, Math.max(...Object.values(CROP_CARE_BONUS)));

  // Untended: the crop gathers the sealed yield of its kind, and nothing else.
  const plain = sow(f, agent, 'herbs', 3, 7);
  assert.deepEqual(plain.crop.yield, { base: sealed, care: 'plain', bonus: 0, min: sealed, max: ceiling, quantity: sealed });
  f.advance(20 * MINUTE);
  assert.deepEqual(act(f, agent, 'harvest', 3, 7).gathered, { kind: 'herbs', quantity: sealed, base: sealed, care: 'plain' });
  assert.deepEqual(shelf(f, agent), { herbs: sealed }, 'an untended crop gathers exactly the sealed yield');

  // Tended inside the crop's own first third: the fullest care, five minutes sooner, tended once only.
  const early = sow(f, agent, 'herbs', 4, 7);
  const bountiful = act(f, agent, 'tend', 4, 7);
  assert.equal(bountiful.crop.care, 'bountiful');
  assert.equal(bountiful.crop.yield.quantity, sealed + CROP_CARE_BONUS.bountiful);
  assert.equal(bountiful.crop.ready_at - early.crop.planted_at, 15 * MINUTE, 'an early tend keeps the five-minute saving');
  denied(() => act(f, agent, 'tend', 4, 7), 409);
  f.advance(15 * MINUTE);
  assert.equal(act(f, agent, 'harvest', 4, 7).gathered.quantity, sealed + CROP_CARE_BONUS.bountiful);
  assert.equal(shelf(f, agent).herbs, sealed * 2 + 2);

  // A tend inside the second third is `careful`, and it moves the crop on as well as shortening it.
  const middle = sow(f, agent, 'herbs', 5, 7);
  f.advance(700_000);
  assert.equal(cropAt(f, agent, 5, 7).stage, 'leafing');
  const careful = act(f, agent, 'tend', 5, 7);
  assert.equal(careful.crop.care, 'careful');
  assert.equal(careful.crop.stage, 'ripening', 'the shortened growth the bands divide moves the crop on');
  assert.equal(careful.crop.yield.quantity, sealed + CROP_CARE_BONUS.careful);
  assert.equal(careful.crop.ready_at - middle.crop.planted_at, 15 * MINUTE);
  f.advance(200_000);
  assert.equal(act(f, agent, 'harvest', 5, 7).gathered.care, 'careful');
  assert.equal(shelf(f, agent).herbs, sealed * 2 + 2 + (sealed + 1));

  // A tend that arrives late keeps its saving but gathers no more than an untended crop.
  sow(f, agent, 'herbs', 6, 7);
  f.advance(900_000);
  const late = act(f, agent, 'tend', 6, 7);
  assert.equal(late.crop.care, 'late');
  assert.equal(late.crop.ready, true, 'the capped saving is exactly the wait that was left');
  assert.equal(late.crop.yield.quantity, sealed);
  assert.equal(act(f, agent, 'harvest', 6, 7).gathered.quantity, sealed);
  assert.equal(shelf(f, agent).herbs, sealed * 3 + 2 + 1 + 2, 'every gather added exactly what its care earned');
  denied(() => act(f, agent, 'harvest', 6, 7), 409);

  // Whatever the kind and whatever the care, the amount stays inside the sealed bound, and the row
  // still in the database reproduces exactly the amount that went onto the shelf.
  for (const kind of kinds) {
    for (const [care, waited] of [['plain', null], ['bountiful', 0], ['careful', Math.round(grow[kind] * 0.5)], ['late', grow[kind]]]) {
      const derived = cropYield({ kind, planted_at: 0, tended_at: waited, harvested_at: null }), floor = sealedYield(kind);
      assert.equal(derived.care, care, `${kind} tended at ${waited}ms reads as ${care}`);
      assert.equal(derived.quantity, floor + CROP_CARE_BONUS[care]);
      assert.ok(derived.quantity >= floor && derived.quantity <= floor + CROP_LIMITS.yield_bonus, `${kind} ${care} stays inside [${floor}, ${floor + CROP_LIMITS.yield_bonus}]`);
    }
  }
  const stored = f.platform.get('SELECT kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=? AND y=?', agent.id, 5, 7);
  assert.equal(stored.kind, 'herbs');
  assert.equal(cropYield(stored).quantity, sealed + 1, 'the saved row alone explains the amount that was credited');
  assert.equal(rows(f, agent), 4);
  assert.equal(growing(f, agent), 0, 'a gathered bed is not a growing crop');
});

test('a tended gather leaves saved seed, and a second sowing inside the hour carries the care it was sown with', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), window = CROP_LIMITS.saved_seed_window_ms;
  assert.equal(window, 60 * MINUTE);
  assert.equal(CROP_POLICY.saved_seed_window_ms, window);
  assert.equal(savedSeedFrom({ kind: 'herbs', tended_at: 0, harvested_at: 0 }, 'herbs', window), true);
  assert.equal(savedSeedFrom({ kind: 'herbs', tended_at: 0, harvested_at: 0 }, 'herbs', window + 1), false);
  assert.equal(savedSeedFrom({ kind: 'herbs', tended_at: null, harvested_at: 0 }, 'herbs', 1), false);
  assert.equal(savedSeedFrom({ kind: 'herbs', tended_at: 0, harvested_at: 0 }, 'wood', 1), false);
  assert.equal(savedSeedFrom(null, 'herbs', 1), false);

  // Sow, tend, gather: the bed keeps its seed for one hour, and the seed carries the care into the
  // next sowing, so the same bed answers again without spending its one tend a second time.
  sow(f, agent, 'herbs', 3, 8);
  act(f, agent, 'tend', 3, 8);
  f.advance(15 * MINUTE);
  assert.equal(act(f, agent, 'harvest', 3, 8).gathered.quantity, sealedYield('herbs') + CROP_CARE_BONUS.bountiful);
  assert.deepEqual(cropAt(f, agent, 3, 8).seed, { kind: 'herbs', until: f.clock() + window, spent: false });
  const again = act(f, agent, 'plant', 3, 8, { kind: 'herbs' });
  assert.equal(again.from_saved_seed, true, 'the bed sows from its own saved seed');
  assert.equal(again.crop.tended_at, again.crop.planted_at, 'a sowing from saved seed is recorded as cared for from the start');
  assert.equal(again.crop.care, 'bountiful');
  assert.equal(again.crop.ready_at - again.crop.planted_at, 15 * MINUTE);
  assert.equal(cropAt(f, agent, 3, 8).seed, null, 'a growing bed has no gathered seed to show');
  denied(() => act(f, agent, 'tend', 3, 8), 409);
  f.advance(15 * MINUTE);
  assert.equal(act(f, agent, 'harvest', 3, 8).gathered.quantity, sealedYield('herbs') + CROP_CARE_BONUS.bountiful, 'the sow-gather-sow line keeps answering');

  // A crop nobody tended keeps no seed, so the bed sows plainly and the plain sowing must be tended
  // by hand. Saved seed is the seed of its own kind: another crop in the same bed starts plainly.
  sow(f, agent, 'wood', 4, 8);
  f.advance(30 * MINUTE);
  assert.equal(act(f, agent, 'harvest', 4, 8).gathered.quantity, sealedYield('wood'));
  assert.deepEqual(cropAt(f, agent, 4, 8).seed, { kind: 'wood', until: f.clock() + window, spent: false });
  assert.equal(act(f, agent, 'plant', 4, 8, { kind: 'wood' }).from_saved_seed, false, 'an untended crop leaves no viable seed');
  act(f, agent, 'tend', 4, 8);
  f.advance(25 * MINUTE);
  act(f, agent, 'harvest', 4, 8);
  assert.equal(act(f, agent, 'plant', 4, 8, { kind: 'herbs' }).from_saved_seed, false, 'saved seed is its own kind');
  const fresh = sow(f, agent, 'herbs', 5, 8);
  assert.equal(fresh.from_saved_seed, false, 'a bed that never held a crop sows plainly');

  // Let the hour pass and the bed is an ordinary one again: nothing is lost, the allowance has ended.
  act(f, agent, 'tend', 5, 8);
  f.advance(15 * MINUTE);
  act(f, agent, 'harvest', 5, 8);
  assert.equal(act(f, agent, 'plant', 5, 8, { kind: 'herbs' }).from_saved_seed, true);
  f.advance(15 * MINUTE);
  act(f, agent, 'harvest', 5, 8);
  f.advance(window + 1);
  assert.equal(cropAt(f, agent, 5, 8).seed.spent, true);
  assert.equal(act(f, agent, 'plant', 5, 8, { kind: 'herbs' }).from_saved_seed, false, 'a spent window sows plainly');
});

test('the garden summary is counted from the same saved rows, and the whole loop mints nothing at all', async (t) => {
  const f = await setup(t), agent = f.agent('alice'), crafted = new Set(content.recipes().map((recipe) => recipe.output));
  sow(f, agent, 'herbs', 3, 9);
  act(f, agent, 'tend', 3, 9);
  sow(f, agent, 'fiber', 4, 9);
  sow(f, agent, 'wood', 5, 9);
  act(f, agent, 'tend', 5, 9);
  f.advance(20 * MINUTE);
  act(f, agent, 'harvest', 3, 9);
  const view = passport(f, agent), garden = view.garden;
  assert.equal(garden.beds, rows(f, agent));
  assert.equal(garden.growing, growing(f, agent));
  assert.equal(garden.growing, 2);
  assert.equal(garden.ready, 0);
  assert.equal(Object.values(garden.by_stage).reduce((sum, count) => sum + count, 0), garden.growing);
  assert.equal(Object.values(garden.by_care).reduce((sum, count) => sum + count, 0), garden.growing);
  assert.equal(garden.by_stage.ripening, 2, 'both standing crops are in the band the clock puts them in');
  assert.equal(garden.by_care.bountiful, 1, 'the tended crop is the one counted as carefully kept');
  assert.equal(garden.by_care.plain, 1);
  assert.equal(garden.next_stage_at, Math.min(...view.crops.filter((crop) => crop.next_stage_at != null).map((crop) => crop.next_stage_at)));
  assert.equal(garden.next_ready_at, Math.min(...view.crops.filter((crop) => crop.harvested_at == null).map((crop) => crop.ready_at)));
  assert.ok(garden.next_stage_at > f.clock(), 'the cadence always names a change still ahead');
  assert.ok(garden.next_ready_at >= garden.next_stage_at);
  assert.equal(garden.saved_seed_beds, 1);
  assert.deepEqual(garden.saved_seed, [{ x: 3, y: 9, kind: 'herbs', until: f.clock() + CROP_LIMITS.saved_seed_window_ms }]);
  assert.deepEqual(garden.limits, CROP_POLICY);
  // Only grown or crafted resources ever reached the shelf: no seed item and no coin item exists.
  const held = Object.keys(shelf(f, agent));
  assert.ok(held.length, 'the loop actually produced something');
  for (const kind of held) assert.ok(Object.hasOwn(grow, kind) || crafted.has(kind), `${kind} is a grown or crafted resource`);
  // Practice mints nothing: no coin receipt, no balance, no merit, and the sealed ledger stays valid.
  assert.equal(coinRows(f.platform, agent), 0);
  assert.equal(view.coins.balance, 0);
  assert.equal(view.coins.issued, 0);
  assert.equal(view.coins.receipt_count, 0, 'no coin receipt exists for this resident at all');
  assert.equal(verifyCoinLedger(f.platform.db), true);
  assert.equal(view.merit.total, 0, 'growing and gathering earn practice, never merit');
});

test('every derived crop fact survives a real Platform reopen and follows the stored rows rather than a client', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  sow(f, agent, 'herbs', 3, 10);
  act(f, agent, 'tend', 3, 10);
  f.advance(15 * MINUTE);
  act(f, agent, 'harvest', 3, 10);
  act(f, agent, 'plant', 3, 10, { kind: 'herbs' });
  const before = passport(f, agent), stored = f.platform.get('SELECT * FROM journey_crops WHERE agent_id=? AND x=3 AND y=10', agent.id);
  f.platform.close();
  const restored = new Platform(f.database, f.clock);
  t.after(() => restored.close());
  restored.initJourney();
  const after = restored.journey(restored.authenticate(f.credentials.alice.token), { agent_id: agent.id });
  assert.deepEqual(after.crops, before.crops, 'the stage, care, yield and seed are re-derived identically after a restart');
  assert.deepEqual(after.garden, before.garden);
  assert.deepEqual(after.inventory, before.inventory);
  assert.equal(after.crops[0].care, 'bountiful', 'the sowing that carried its seed is still the cared-for one');
  assert.equal(after.crops[0].ready_at - after.crops[0].planted_at, 15 * MINUTE);
  assert.equal(coinRows(restored, agent), 0, 'a restart issues no coin either');
  assert.equal(verifyCoinLedger(restored.db), true);
  // The stored row is untouched while the clock moves on: only the derived facts follow the clock.
  f.advance(CROP_LIMITS.saved_seed_window_ms + 1);
  const later = restored.journey(restored.authenticate(f.credentials.alice.token), { agent_id: agent.id });
  assert.deepEqual(restored.get('SELECT * FROM journey_crops WHERE agent_id=? AND x=3 AND y=10', agent.id), stored, 'no stored crop fact changed');
  assert.equal(later.crops[0].planted_at, before.crops[0].planted_at);
  assert.equal(later.crops[0].stage, 'ready', 'the reopened platform derives the stage from the stored planting and the clock');
  assert.equal(later.garden.ready, 1);
  assert.equal(later.garden.saved_seed_beds, 0);
});
