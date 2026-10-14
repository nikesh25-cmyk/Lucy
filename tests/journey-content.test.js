// The authored content a resident can actually pursue: the six sealed crops, the crafting ladder in
// src/journey.js, and the garden and frontier definitions the two new palettes carry. Every
// assertion here goes through the real server paths (gardenAction, craftItem, build, frontierBuild),
// so a definition that is sealed but not reachable fails, and nothing in this content mints a coin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { journeyMethods, CROP_CARE, CROP_CARE_BONUS, CROP_LIMITS, RECIPE_DEFECTS, RECIPE_EXTENSIONS, RECIPE_LIMITS, RECIPE_POLICY, RESOURCE_OFFER_POLICY } from '../src/journey.js';
import { verifyCoinLedger } from '../src/coins.js';
import { FRONTIER_LIMITS } from '../src/frontier.js';
import { sceneryBlocks, sceneryClass } from '../src/footprints.js';
import content from '../src/content.js';
import { fixture } from './helpers.js';

Object.assign(Platform.prototype, journeyMethods);

const MINUTE = 60_000;
const sealedCrops = content.crops();
const sealedYield = (kind) => content.entry(kind, 'crop').rules.yield.quantity;
const sealedGrowth = (kind) => content.entry(kind, 'crop').rules.grow_ms;
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
const garden = (f, agent, input) => f.tx('gardenAction', f.actor('alice'), { agent_id: agent.id, ...input });
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0 ORDER BY kind', agent.id).map((item) => [item.kind, item.quantity]));
const coinRows = (f) => f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n;

test('the six sealed crops each declare their own growth, yield and care window, and share one garden cap', () => {
  assert.deepEqual(Object.keys(sealedCrops), ['herbs', 'fiber', 'wood', 'blossom', 'grain', 'resin']);
  assert.deepEqual(Object.entries(sealedCrops), [['herbs', 1_200_000], ['fiber', 1_500_000], ['wood', 1_800_000], ['blossom', 900_000], ['grain', 2_400_000], ['resin', 3_000_000]]);
  assert.equal(new Set(Object.values(sealedCrops)).size, 6, 'no two crops grow for the same time');
  assert.deepEqual(Object.keys(sealedCrops).map(sealedYield), [2, 2, 2, 3, 4, 1]);
  assert.equal(CROP_LIMITS.growing, 20, 'the shared garden cap is unchanged by the new kinds');
  assert.equal(CROP_LIMITS.saved_seed_window_ms, 60 * MINUTE);
  // The care bands divide each crop's own growth, so one elapsed tend time can be careful for one
  // kind and bountiful for another. That is the "own care" a new kind brings.
  assert.deepEqual(CROP_CARE, ['plain', 'careful', 'bountiful', 'late']);
  assert.deepEqual(CROP_CARE_BONUS, { plain: 0, careful: 1, bountiful: 2, late: 0 });
  assert.equal(sealedGrowth('blossom') / 3, 5 * MINUTE);
  assert.equal(sealedGrowth('grain') / 3, 13 * MINUTE + 20_000);
});

test('every sealed crop sows, tends and gathers with its own timing, care window and yield', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  const kinds = Object.keys(sealedCrops);
  for (const [index, kind] of kinds.entries()) {
    const y = 4 + index, x = 4;
    patch(f, agent, x, y);
    const planted = garden(f, agent, { action: 'plant', kind, x, y });
    assert.equal(planted.crop.ready_at - planted.crop.planted_at, sealedGrowth(kind), `${kind} keeps its own growth time`);
    // A tend at the very start of the crop's life is bountiful for every kind, and it saves exactly
    // the sealed five minutes.
    const tended = garden(f, agent, { action: 'tend', x, y });
    assert.equal(tended.crop.care, 'bountiful', `${kind} is bountiful when tended at once`);
    assert.equal(tended.crop.ready_at - tended.crop.planted_at, sealedGrowth(kind) - 300_000, `${kind} keeps the five minute saving`);
    f.advance(sealedGrowth(kind) - 300_000 - 1);
    denied(() => garden(f, agent, { action: 'harvest', x, y }), 409);
    f.advance(1);
    const standing = f.platform.journey(f.actor('alice'), { agent_id: agent.id }).crops.find((crop) => crop.x === x && crop.y === y);
    assert.equal(standing.ready, true, `${kind} is ready at its own published instant`);
    const gathered = garden(f, agent, { action: 'harvest', x, y });
    assert.deepEqual(gathered.gathered, { kind, quantity: sealedYield(kind) + CROP_CARE_BONUS.bountiful, base: sealedYield(kind), care: 'bountiful' });
    assert.equal(shelf(f, agent)[kind], sealedYield(kind) + CROP_CARE_BONUS.bountiful, `${kind} gathers its own amount`);
  }
  assert.equal(coinRows(f), 0, 'no sowing, tend or harvest mints a coin');
  assert.equal(verifyCoinLedger(f.platform.db), true);
});

test('one elapsed tend time is bountiful for a slow crop and careful for a quick one, and a late tend gathers the base yield', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  // Blossom (15 min) and grain (40 min) are planted at the same instant; the same 500000 ms tend
  // later falls in blossom's middle third and inside grain's first third.
  patch(f, agent, 4, 4); patch(f, agent, 4, 5);
  garden(f, agent, { action: 'plant', kind: 'blossom', x: 4, y: 4 });
  garden(f, agent, { action: 'plant', kind: 'grain', x: 4, y: 5 });
  f.advance(500_000);
  assert.equal(garden(f, agent, { action: 'tend', x: 4, y: 4 }).crop.care, 'careful', 'blossom is past its first third');
  assert.equal(garden(f, agent, { action: 'tend', x: 4, y: 5 }).crop.care, 'bountiful', 'grain is inside its first third');
  f.advance(100_000);
  assert.deepEqual(garden(f, agent, { action: 'harvest', x: 4, y: 4 }).gathered, { kind: 'blossom', quantity: 4, base: 3, care: 'careful' });
  f.advance(1_500_000);
  assert.deepEqual(garden(f, agent, { action: 'harvest', x: 4, y: 5 }).gathered, { kind: 'grain', quantity: 6, base: 4, care: 'bountiful' });
  // A tend after the crop's two thirds keeps the saving but earns no bonus, so the harvest is the
  // sealed base alone.
  patch(f, agent, 5, 4);
  garden(f, agent, { action: 'plant', kind: 'blossom', x: 5, y: 4 });
  f.advance(700_000);
  assert.equal(garden(f, agent, { action: 'tend', x: 5, y: 4 }).crop.care, 'late');
  assert.deepEqual(garden(f, agent, { action: 'harvest', x: 5, y: 4 }).gathered, { kind: 'blossom', quantity: 3, base: 3, care: 'late' });
  assert.equal(coinRows(f), 0);
});

test('the garden cap is one shared twenty for the new kinds as much as the old', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  const kinds = ['herbs', 'blossom', 'grain', 'resin'];
  let planted = 0;
  for (let y = 2; y < 7; y++) for (let x = 2; x < 7 && planted < CROP_LIMITS.growing; x++, planted += 1) {
    patch(f, agent, x, y);
    garden(f, agent, { action: 'plant', kind: kinds[planted % kinds.length], x, y });
  }
  assert.equal(planted, CROP_LIMITS.growing);
  patch(f, agent, 8, 8);
  denied(() => garden(f, agent, { action: 'plant', kind: 'resin', x: 8, y: 8 }), 429);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', agent.id).n, CROP_LIMITS.growing);
  assert.equal(coinRows(f), 0);
});

test('the authored ladder is reachable from seed: crops are grown, then a keepsake is made from a keepsake', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  // The whole chain is worked from seed: nothing is written to the shelf except by gardenAction and
  // craftItem. Every ingredient is grown or crafted, and the deepest recipe spends a craft.
  assert.deepEqual(RECIPE_DEFECTS, []);
  assert.equal(RECIPE_EXTENSIONS.length, 3);
  const seeds = { herbs: 2, fiber: 2, grain: 4, blossom: 3, resin: 1 };
  const beds = Object.keys(seeds);
  for (const [index, kind] of beds.entries()) {
    const x = 3 + index, y = 4;
    patch(f, agent, x, y);
    garden(f, agent, { action: 'plant', kind, x, y });
  }
  f.advance(sealedGrowth('resin') + 1);
  for (const [index, kind] of beds.entries()) {
    const x = 3 + index, y = 4;
    assert.deepEqual(garden(f, agent, { action: 'harvest', x, y }).gathered, { kind, quantity: sealedYield(kind), base: sealedYield(kind), care: 'plain' });
  }
  assert.deepEqual(shelf(f, agent), { blossom: 3, fiber: 2, grain: 4, herbs: 2, resin: 1 });
  // Step one spends only grown resources; step two spends step one; step three spends step two.
  assert.deepEqual(f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'sun_thread' }).crafted, 'sun_thread');
  assert.deepEqual(shelf(f, agent), { blossom: 3, fiber: 1, grain: 4, resin: 1, sun_thread: 1 });
  // A keepsake the resident has just made is offered back as a keepsake appearance, exactly like a
  // sealed one, while it is still on the shelf.
  assert.ok(f.platform.journey(f.actor('alice'), { agent_id: agent.id }).profile_options.avatars.includes('sun_thread'), 'a crafted keepsake is an owned keepsake');
  assert.deepEqual(f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'field_ribbon' }).crafted, 'field_ribbon');
  assert.deepEqual(shelf(f, agent), { blossom: 3, fiber: 1, grain: 3, resin: 1, field_ribbon: 1 });
  assert.deepEqual(f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'harvest_garland' }).crafted, 'harvest_garland');
  assert.deepEqual(shelf(f, agent), { fiber: 1, grain: 3, harvest_garland: 1 });
  const passport = f.platform.journey(f.actor('alice'), { agent_id: agent.id });
  // The two keepsakes the deepest recipe spent are gone from the shelf, so they are no longer offered,
  // and the finished keepsake is. The world still holds no new object and no coin.
  assert.equal(passport.profile_options.avatars.includes('sun_thread'), false, 'a spent keepsake is no longer owned');
  assert.ok(passport.profile_options.avatars.includes('harvest_garland'));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n, beds.length);
  assert.equal(coinRows(f), 0);
  assert.equal(verifyCoinLedger(f.platform.db), true);
});

test('the published recipe list is the sealed recipes in their sealed order, then the authored ladder in one shape', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  const sealed = content.recipes();
  const passport = f.platform.journey(f.actor('alice'), { agent_id: agent.id });
  assert.deepEqual(passport.recipes.slice(0, sealed.length), sealed, 'the sealed recipes are published first and unchanged');
  assert.deepEqual(passport.recipes.slice(sealed.length), RECIPE_EXTENSIONS.map((recipe) => ({ id: recipe.id, name: recipe.name, ingredients: { ...recipe.ingredients }, output: recipe.output })));
  assert.equal(passport.recipes.length, sealed.length + RECIPE_EXTENSIONS.length);
  for (const recipe of passport.recipes) {
    assert.deepEqual(Object.keys(recipe).sort(), ['id', 'ingredients', 'name', 'output'], `${recipe.id} keeps the one published recipe shape`);
    assert.equal(recipe.output, recipe.id, `${recipe.id} outputs the keepsake it is named for`);
    for (const [kind, quantity] of Object.entries(recipe.ingredients)) assert.ok(Number.isInteger(quantity) && quantity > 0 && quantity <= RECIPE_LIMITS.quantity, `${recipe.id} needs a whole quantity of ${kind}`);
  }
  // Reachability, read straight from the published list: every ingredient is a sealed crop or a
  // keepsake an earlier published recipe makes, so the deepest recipe is three steps from seed.
  const grown = new Set(Object.keys(sealedCrops));
  const made = new Set();
  for (const recipe of passport.recipes) {
    for (const kind of Object.keys(recipe.ingredients)) assert.ok(grown.has(kind) || made.has(kind), `${recipe.id} spends ${kind}, which is grown or already made`);
    made.add(recipe.output);
  }
  const deepest = RECIPE_EXTENSIONS.at(-1);
  assert.ok(Object.keys(deepest.ingredients).some((kind) => made.has(kind) && !grown.has(kind)), 'the deepest recipe spends a keepsake');
  assert.equal(RECIPE_POLICY.coins_awarded, 0);
  assert.equal(RESOURCE_OFFER_POLICY.coins_awarded, 0);
  // A keepsake the resident has not made cannot be claimed as one.
  denied(() => f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'harvest_garland' }), 409);
  denied(() => f.tx('craftItem', f.actor('alice'), { agent_id: agent.id, recipe_id: 'invented-recipe' }), 400);
  assert.equal(coinRows(f), 0);
});

test('the new garden furniture and frontier blocks place through the sealed palettes and mint nothing', async (t) => {
  const f = await setup(t), agent = f.agent('alice');
  // Every new furniture definition is buildable from the garden palette, and the two that declare
  // the cottage palette build inside the cottage as well.
  const gardenTypes = ['well', 'birdbath', 'sundial', 'millstone'];
  f.platform.run('UPDATE agents SET world_id=?,x=8,y=8,z=0,grounded=1 WHERE id=?', `home:${agent.id}`, agent.id);
  for (const [index, type] of gardenTypes.entries()) {
    assert.ok(content.palette('garden').includes(type), `${type} is on the sealed garden palette`);
    const placed = f.tx('build', f.actor('alice'), agent.id, { x: 10 + index, y: 8, type });
    assert.equal(placed.removed, false);
    assert.equal(f.platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', placed.world_id, placed.x, placed.y).type, type);
    assert.equal(sceneryBlocks(type), true, `${type} occupies its tile`);
    assert.equal(sceneryClass(type), 'mass');
  }
  assert.equal(content.palette('house').includes('birdbath') && content.palette('house').includes('millstone'), true);
  f.platform.run('UPDATE agents SET world_id=?,x=8,y=9,z=0,grounded=1 WHERE id=?', `house:${agent.id}`, agent.id);
  const indoors = f.tx('build', f.actor('alice'), agent.id, { x: 6, y: 9, type: 'millstone' });
  assert.equal(f.platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', indoors.world_id, indoors.x, indoors.y).type, 'millstone');
  // A type outside the palette is still refused, so the new entries widen the palette rather than
  // bypass it.
  denied(() => f.tx('build', f.actor('alice'), agent.id, { x: 7, y: 9, type: 'invented-statue' }), 400);
  // Both new frontier blocks place inside a stewarded plot, at the sealed layer ceiling and below.
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A workshop yard' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', 'frontier:0:0', 30, 32, agent.id);
  const clay = f.tx('frontierBuild', f.actor('alice'), agent.id, { world_id: 'frontier:0:0', x: 31, y: 33, z: 0, type: 'clay' });
  assert.equal(clay.changed, true);
  f.advance(1000);
  // Slate is placed above the clay it rests on: a block above the ground needs a solid block below.
  denied(() => f.tx('frontierBuild', f.actor('alice'), agent.id, { world_id: 'frontier:0:0', x: 32, y: 33, z: 1, type: 'slate' }), 409);
  const slate = f.tx('frontierBuild', f.actor('alice'), agent.id, { world_id: 'frontier:0:0', x: 31, y: 33, z: 1, type: 'slate' });
  assert.equal(slate.changed, true);
  assert.deepEqual(f.platform.all('SELECT type,z FROM frontier_blocks WHERE world_id=? ORDER BY z', 'frontier:0:0').map((row) => ({ ...row })), [{ type: 'clay', z: 0 }, { type: 'slate', z: 1 }]);
  assert.equal(FRONTIER_LIMITS.maximum_z, content.entry('slate', 'block').rules.stack.z_max);
  f.advance(1000);
  denied(() => f.tx('frontierBuild', f.actor('alice'), agent.id, { world_id: 'frontier:0:0', x: 31, y: 33, z: FRONTIER_LIMITS.maximum_z + 1, type: 'slate' }), 400);
  assert.equal(coinRows(f), 0);
  assert.equal(verifyCoinLedger(f.platform.db), true);
});
