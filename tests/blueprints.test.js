import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Platform } from '../src/platform.js';
import { BLUEPRINTS, BLUEPRINT_CATALOGUE, blueprintById, FRONTIER_PALETTE, FRONTIER_LIMITS, LAND_BLOCK_GUARDS } from '../src/frontier.js';
import { blockOccupiesTile } from '../src/footprints.js';
import { frontierPlotId, getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const world = 'frontier:0:0', plot = 'plot:0:0:5:5';
// Three anchors inside plot 5,5 (x 30–35, y 30–35) that do not overlap each other, and the acting
// resident's own tile: every blueprint cell stays inside the six-tile build range from here.
const anchors = { 'garden-shelter': { x: 33, y: 31 }, 'gathering-pavilion': { x: 30, y: 33 }, 'research-kiosk': { x: 30, y: 30 } };
const standing = { x: 32, y: 32 };
const steward = (f, owner = 'alice') => f.tx('landAssign', f.actor(owner), { plot_id: plot, purpose: 'A shared learning garden', description: 'An isolated blueprint fixture.' });
const stand = (f, agent, tile = standing, z = 0) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=?,grounded=1 WHERE id=?', world, tile.x, tile.y, z, agent.id);
const request = (f, owner, agent, input) => f.tx('frontierBuild', f.actor(owner), agent.id, { world_id: world, ...input });
const blocks = (f) => f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n;
const actions = (f) => f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n;
const agentActions = (f) => f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions WHERE account_id=? AND created_at>=?', f.actor('alice').account.id, `${new Date(f.clock()).toISOString().slice(0, 10)}T00:00:00.000Z`).n;
/** Every row of every table, so "no writes" is asserted against the whole database, not one table. */
const snapshot = (f) => {
  const tables = f.platform.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((row) => row.name);
  return JSON.stringify(tables.map((name) => [name, f.platform.all(`SELECT * FROM ${name}`)]));
};
const issueCodes = (report) => report.issues.map((issue) => issue.code);

test('authored blueprints are frozen plain geometry inside the sealed frontier palette', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  assert.deepEqual(BLUEPRINTS.map((blueprint) => blueprint.id), ['garden-shelter', 'gathering-pavilion', 'research-kiosk']);
  assert.equal(Object.isFrozen(BLUEPRINTS), true);
  for (const blueprint of BLUEPRINTS) {
    assert.equal(Object.isFrozen(blueprint), true);
    assert.equal(blueprint.cells.length, blueprint.block_count);
    assert.equal(Object.values(blueprint.block_types).reduce((total, count) => total + count, 0), blueprint.block_count);
    assert.equal(new Set(blueprint.cells.map((cell) => `${cell.x},${cell.y},${cell.z}`)).size, blueprint.cells.length, 'no cell is declared twice');
    assert.equal(blueprint.block_types.path, blueprint.cells.filter((cell) => cell.type === 'path').length);
    for (const cell of blueprint.cells) {
      assert.equal(FRONTIER_PALETTE.includes(cell.type), true, `${cell.type} is a sealed frontier block`);
      assert.equal(cell.z >= 0 && cell.z <= FRONTIER_LIMITS.maximum_z, true);
      assert.equal(cell.x >= 0 && cell.x < blueprint.footprint.width && cell.y >= 0 && cell.y < blueprint.footprint.depth, true, 'every cell is inside the declared footprint');
      if (cell.type === 'path') assert.equal(cell.z, 0, 'paths belong on the ground layer');
      if (cell.z > 0) {
        const below = blueprint.cells.find((item) => item.x === cell.x && item.y === cell.y && item.z === cell.z - 1);
        assert.equal(Boolean(below) && blockOccupiesTile(below.type), true, 'a raised layer needs a solid layer below it');
      }
    }
    // A doorway is a tile a resident walks through, so no declared entrance may carry a solid block.
    for (const entrance of blueprint.entrances) assert.equal(blueprint.cells.some((cell) => cell.x === entrance.x && cell.y === entrance.y && blockOccupiesTile(cell.type)), false, 'a doorway stays open');
  }
  assert.deepEqual(BLUEPRINT_CATALOGUE.map(({ id, block_count }) => [id, block_count]), [['garden-shelter', 14], ['gathering-pavilion', 13], ['research-kiosk', 11]]);
  assert.equal(blueprintById('garden-shelter').name, 'Garden shelter');
  assert.equal(blueprintById('script'), null);
  steward(f);
  stand(f, alice);
  assert.equal(request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], preview: true }).blueprint.block_count, 14);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a preview reports footprint, layers, block count, doorways and ownership without writing anything', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  steward(f);
  stand(f, alice);
  const before = snapshot(f);
  const report = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], preview: true });
  assert.equal(report.valid, true);
  assert.equal(report.writes, 0);
  assert.equal(report.replay, false);
  assert.equal(report.new_blocks, 14);
  assert.equal(report.block_count, 14);
  assert.deepEqual(report.footprint, { origin: { x: 33, y: 31 }, width: 3, depth: 2 });
  assert.equal(report.cells.length, 14);
  assert.deepEqual(report.cells.filter((cell) => cell.z === 2).map(({ x, y, z, type }) => ({ x, y, z, type })),
    [{ x: 33, y: 31, z: 2, type: 'wood' }, { x: 34, y: 31, z: 2, type: 'wood' }, { x: 35, y: 31, z: 2, type: 'wood' }]);
  assert.deepEqual(report.layers.map((layer) => [layer.z, layer.type, layer.cells.length]), [[0, 'path', 1], [0, 'wood', 5], [1, 'wood', 5], [2, 'wood', 3]]);
  assert.deepEqual(report.access.protected_cells, []);
  assert.equal(report.access.shared_clear, true);
  assert.deepEqual(report.access.doorways, [{ x: 34, y: 32, clear: true }]);
  assert.deepEqual(report.ownership, { plot_id: plot, steward_account_id: f.actor('alice').account.id, is_mine: true, purpose: 'A shared learning garden', can_build: true, can_remove: true });
  assert.deepEqual({ actions_remaining: report.budgets.actions_remaining, blocks_remaining: report.budgets.blocks_remaining, interval_ready: report.budgets.interval_ready, actions_today: report.budgets.actions_today }, { actions_remaining: 500, blocks_remaining: 2048, interval_ready: true, actions_today: 0 });
  // Every blueprint previews, and a refused preview reports why instead of hiding it.
  for (const blueprint of BLUEPRINTS) assert.equal(request(f, 'alice', alice, { blueprint: blueprint.id, ...anchors[blueprint.id], preview: true }).valid, true);
  const refused = request(f, 'alice', alice, { blueprint: 'garden-shelter', x: 12, y: 12, preview: true });
  assert.equal(refused.valid, false);
  assert.equal(refused.ownership.is_mine, false);
  assert.equal(issueCodes(refused).includes('out_of_plot'), true);
  assert.equal(snapshot(f), before, 'a preview never writes');
  assert.equal(blocks(f), 0);
  assert.equal(actions(f), 0);
});

test('each named blueprint applies on a valid assigned plot and the structure survives a restart', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  steward(f);
  stand(f, alice);
  for (const blueprint of BLUEPRINTS) {
    f.advance();
    const applied = request(f, 'alice', alice, { blueprint: blueprint.id, ...anchors[blueprint.id] });
    assert.equal(applied.applied, true, blueprint.id);
    assert.equal(applied.changed, true);
    assert.equal(applied.replay, false);
    assert.equal(applied.new_blocks, blueprint.block_count);
    assert.equal(applied.actions, blueprint.block_count, 'one authoritative block write is one frontier action');
    assert.equal(applied.blocks.length, blueprint.block_count);
    assert.equal(applied.plot_id, plot);
  }
  assert.equal(blocks(f), 38);
  assert.equal(actions(f), 38);
  assert.equal(f.platform.get('SELECT COUNT(DISTINCT plot_id) AS n FROM frontier_blocks').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE creator_account_id!=?', f.actor('alice').account.id).n, 0);
  // The stored rows satisfy the land guard: every block is inside the stewarded plot bounds.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks b JOIN land_parcels p ON p.id=b.plot_id WHERE b.x<p.x OR b.x>=p.x+6 OR b.y<p.y OR b.y>=p.y+6').n, 0);
  assert.equal(f.platform.verifyAudit(), true);
  f.platform.close();
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 38, 'a built blueprint persists after restart');
  const restored = restarted.world(restarted.authenticate(f.credentials.alice.token), { agent_id: alice.id });
  assert.equal(restored.blocks.length, 38);
  assert.equal(restored.frontier.block_count, 38);
  assert.equal(restored.frontier.blueprints.length, 3);
  assert.equal(restored.frontier.blueprints.every((blueprint) => blueprint.block_count > 0 && blueprint.summary.length > 40 && blueprint.doorways > 0), true);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('out-of-plot, out-of-range and blocked-doorway requests are refused with storage untouched', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob', 'Second builder');
  steward(f);
  stand(f, alice);
  // 1. Outside the operator's own plot: open land and the reserved public crossroads.
  for (const tile of [{ x: 12, y: 31 }, { x: 24, y: 24 }]) {
    stand(f, bob, tile);
    const refused = request(f, 'bob', bob, { blueprint: 'garden-shelter', x: tile.x, y: tile.y, preview: true });
    assert.equal(refused.valid, false, `${tile.x},${tile.y}`);
    assert.equal(issueCodes(refused).includes('out_of_plot'), true);
    assert.throws(() => request(f, 'bob', bob, { blueprint: 'garden-shelter', x: tile.x, y: tile.y }), { status: 403 });
  }
  // A footprint that spans two plot addresses is refused as a whole.
  const spanning = request(f, 'alice', alice, { blueprint: 'research-kiosk', x: 29, y: 32, preview: true });
  assert.equal(spanning.valid, false);
  assert.deepEqual(issueCodes(spanning), ['out_of_plot']);
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'research-kiosk', x: 29, y: 32 }), { status: 403 });
  // 2. Beyond the six-tile build range.
  stand(f, alice, { x: 30, y: 30 });
  const far = request(f, 'alice', alice, { blueprint: 'garden-shelter', x: 33, y: 33, preview: true });
  assert.equal(issueCodes(far).includes('out-of-range'), true);
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'garden-shelter', x: 33, y: 33 }), { status: 409 });
  stand(f, alice);
  // 3. A doorway that would open onto ground nobody can reach.
  f.advance(); request(f, 'alice', alice, { x: 32, y: 31, z: 0, type: 'stone' });
  f.advance(); request(f, 'alice', alice, { x: 32, y: 31, z: 1, type: 'stone' });
  const sealed = request(f, 'alice', alice, { blueprint: 'research-kiosk', ...anchors['research-kiosk'], preview: true });
  assert.equal(sealed.valid, false);
  assert.deepEqual(issueCodes(sealed), ['blocked-doorway']);
  assert.deepEqual(sealed.access.doorways, [{ x: 31, y: 31, clear: false }]);
  const sealedBefore = snapshot(f);
  f.advance();
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'research-kiosk', ...anchors['research-kiosk'] }), { status: 409 });
  assert.equal(snapshot(f), sealedBefore, 'a refused doorway application writes nothing');
  assert.equal(blocks(f), 2, 'only the fixture supports exist');
});

test('resident intersection, the escape rule and the daily budget are refused with storage untouched', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  steward(f);
  stand(f, alice);
  // 1. A resident standing where the structure would be solid.
  stand(f, bob, { x: 34, y: 31 });
  const intersecting = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], preview: true });
  assert.equal(intersecting.valid, false);
  assert.deepEqual(issueCodes(intersecting), ['resident']);
  const residentBefore = snapshot(f);
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'] }), { status: 409 });
  assert.equal(snapshot(f), residentBefore, 'a resident intersection writes nothing');
  // 2. The escape rule: a resident inside the kiosk doorway with its only way out walled off.
  f.advance(); request(f, 'alice', alice, { x: 32, y: 31, z: 0, type: 'stone' });
  f.advance(); request(f, 'alice', alice, { x: 32, y: 31, z: 1, type: 'stone' });
  stand(f, bob, { x: 31, y: 31 });
  const trapped = request(f, 'alice', alice, { blueprint: 'research-kiosk', ...anchors['research-kiosk'], preview: true });
  assert.equal(trapped.valid, false);
  assert.deepEqual(issueCodes(trapped), ['trap']);
  const trapBefore = snapshot(f);
  f.advance();
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'research-kiosk', ...anchors['research-kiosk'] }), { status: 409, message: /cut a resident off/ });
  assert.equal(snapshot(f), trapBefore, 'a trap refusal writes nothing');
  // 3. The daily action budget: three actions left and a fourteen-block blueprint.
  const old = new Date(f.clock() - 1000).toISOString();
  const account = f.actor('alice').account.id;
  const filler = FRONTIER_LIMITS.actions_per_operator_day - agentActions(f) - 3;
  f.platform.transaction(() => { for (let n = 0; n < filler; n++) f.platform.run('INSERT INTO frontier_actions VALUES(?,?,?,?,?,?)', randomUUID(), account, alice.id, world, 'place', old); });
  const overBudget = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], preview: true });
  assert.equal(overBudget.valid, false);
  assert.deepEqual(issueCodes(overBudget), ['budget']);
  assert.equal(overBudget.budgets.actions_remaining, 3);
  const budgetBefore = snapshot(f);
  f.advance();
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'] }), { status: 429 });
  assert.equal(snapshot(f), budgetBefore, 'a budget refusal writes nothing');
  assert.equal(blocks(f), 2);
  assert.equal(f.platform.verifyAudit(), true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('the per-area block cap refuses a blueprint before any of it is written', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  steward(f);
  stand(f, alice);
  // A capacity fixture for the area cap: the synthetic rows skip the parcel guard, which the
  // shipped path only satisfies through a stewarded plot. The guard is restored before asserting.
  const capacity = FRONTIER_LIMITS.blocks_per_sector - 10;
  f.platform.db.exec('DROP TRIGGER frontier_blocks_plot_insert');
  f.platform.transaction(() => {
    let written = 0;
    for (let y = 0; y < 24 && written < capacity; y++) for (let x = 0; x < 48 && written < capacity; x++) {
      for (const z of [0, 1]) {
        if (written >= capacity) break;
        f.platform.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), world, x, y, z, 'stone', alice.id, f.actor('alice').account.id, new Date(f.clock()).toISOString());
        written++;
      }
    }
  });
  f.platform.db.exec(LAND_BLOCK_GUARDS);
  assert.equal(blocks(f), capacity);
  const report = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], preview: true });
  assert.equal(report.valid, false);
  assert.deepEqual(issueCodes(report), ['area-capacity']);
  assert.deepEqual({ blocks_in_sector: report.budgets.blocks_in_sector, blocks_remaining: report.budgets.blocks_remaining }, { blocks_in_sector: capacity, blocks_remaining: 10 });
  f.advance();
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'] }), { status: 429 });
  assert.equal(blocks(f), capacity, 'the area cap refuses before the first write');
});

test('replaying an applied blueprint changes nothing and spends no further action budget', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  steward(f);
  stand(f, alice);
  const applied = request(f, 'alice', alice, { blueprint: 'gathering-pavilion', ...anchors['gathering-pavilion'] });
  assert.equal(applied.new_blocks, 13);
  const after = snapshot(f);
  f.advance();
  const replay = request(f, 'alice', alice, { blueprint: 'gathering-pavilion', ...anchors['gathering-pavilion'] });
  assert.deepEqual({ applied: replay.applied, changed: replay.changed, replay: replay.replay, new_blocks: replay.new_blocks, existing_blocks: replay.existing_blocks, writes: replay.writes }, { applied: false, changed: false, replay: true, new_blocks: 0, existing_blocks: 13, writes: 0 });
  assert.equal(blocks(f), 13);
  assert.equal(actions(f), 13);
  assert.equal(snapshot(f), after, 'a replay writes nothing at all');
  const preview = request(f, 'alice', alice, { blueprint: 'gathering-pavilion', ...anchors['gathering-pavilion'], preview: true });
  assert.equal(preview.valid, true);
  assert.equal(preview.replay, true);
  assert.equal(preview.new_blocks, 0);
  assert.equal(snapshot(f), after);
  // A different structure over the same tiles is refused instead of overwriting the first one.
  f.advance();
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'garden-shelter', x: 30, y: 33 }), { status: 409 });
  f.advance();
  assert.throws(() => request(f, 'alice', alice, { blueprint: 'research-kiosk', x: 30, y: 33 }), { status: 409 });
  assert.equal(blocks(f), 13);
});

test('removal respects ownership, takes the structure down top first and leaves a safe descent', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), moderator = f.agent('moderator');
  steward(f);
  stand(f, alice);
  request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'] });
  assert.equal(blocks(f), 14);
  stand(f, bob, { x: 34, y: 33 });
  stand(f, moderator, { x: 34, y: 33 });
  f.advance();
  // Another operator’s agent, without the plot, may not remove the structure.
  assert.throws(() => request(f, 'bob', bob, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], remove: true }), { status: 403 });
  assert.equal(blocks(f), 14);
  // A removal preview reports the structure without touching it.
  const preview = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], remove: true, preview: true });
  assert.deepEqual({ found_blocks: preview.found_blocks, removed: preview.removed, writes: preview.writes }, { found_blocks: 14, removed: false, writes: 0 });
  assert.equal(preview.cells.every((cell) => cell.built === true), true);
  assert.equal(blocks(f), 14);
  // A resident standing on the structure descends to the ground instead of floating.
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=3,grounded=1 WHERE id=?', world, 34, 31, bob.id);
  const deletes = [];
  const run = f.platform.run.bind(f.platform);
  f.platform.run = (sql, ...args) => { if (/^DELETE FROM frontier_blocks/.test(sql)) deletes.push(f.platform.get('SELECT z FROM frontier_blocks WHERE id=?', args[0]).z); return run(sql, ...args); };
  f.advance();
  const removed = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], remove: true });
  f.platform.run = run;
  assert.deepEqual({ removed: removed.removed, changed: removed.changed, removed_blocks: removed.removed_blocks, actions: removed.actions }, { removed: true, changed: true, removed_blocks: 14, actions: 14 });
  assert.deepEqual([...deletes].sort((a, b) => b - a), deletes, 'the structure comes down top first');
  assert.equal(blocks(f), 0);
  assert.deepEqual({ ...f.platform.get('SELECT x,y,z,grounded FROM agents WHERE id=?', bob.id) }, { x: 34, y: 31, z: 0, grounded: 1 }, 'removal settles the standing resident');
  // A finished structure replays as a no-op removal, and a moderator may take another operator’s work down.
  f.advance();
  const replay = request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'], remove: true });
  assert.deepEqual({ removed: replay.removed, replay: replay.replay, removed_blocks: replay.removed_blocks }, { removed: false, replay: true, removed_blocks: 0 });
  f.advance();
  request(f, 'alice', alice, { blueprint: 'research-kiosk', ...anchors['research-kiosk'] });
  assert.throws(() => request(f, 'bob', bob, { blueprint: 'research-kiosk', ...anchors['research-kiosk'], remove: true }), { status: 403 });
  f.advance();
  assert.equal(request(f, 'moderator', moderator, { blueprint: 'research-kiosk', ...anchors['research-kiosk'], remove: true }).removed_blocks, 11);
  assert.equal(blocks(f), 0);
  assert.equal(f.platform.verifyAudit(), true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('a blueprint is all-or-nothing even when a write fails in the middle of the structure', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  steward(f);
  stand(f, alice);
  const run = f.platform.run.bind(f.platform);
  let inserts = 0;
  f.platform.run = (sql, ...args) => {
    if (/^INSERT INTO frontier_blocks/.test(sql) && ++inserts === 5) throw new Error('simulated storage failure');
    return run(sql, ...args);
  };
  // Called without a surrounding transaction on purpose: the write phase carries its own savepoint.
  assert.throws(() => f.platform.frontierBuild(f.actor('alice'), alice.id, { world_id: world, blueprint: 'garden-shelter', ...anchors['garden-shelter'] }), /simulated storage failure/);
  f.platform.run = run;
  assert.equal(inserts, 5);
  assert.equal(blocks(f), 0, 'no half-built structure remains');
  assert.equal(actions(f), 0);
  assert.equal(f.platform.verifyAudit(), true);
  f.advance();
  assert.equal(request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'] }).new_blocks, 14, 'the same request still succeeds afterwards');
  assert.equal(blocks(f), 14);
});

test('blueprint placement keeps the shipped movement and elevation semantics intact', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  steward(f);
  stand(f, alice);
  request(f, 'alice', alice, { blueprint: 'garden-shelter', ...anchors['garden-shelter'] });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', world).n, 0, 'a blueprint places blocks, never scenery objects');
  // The path floor of the doorway stays walkable ground: walking onto it is an ordinary step.
  stand(f, alice, { x: 34, y: 33 });
  const walked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' });
  assert.deepEqual({ x: walked.x, y: walked.y, z: walked.z, blocked: walked.blocked }, { x: 34, y: 32, z: 0, blocked: false });
  f.advance();
  // The back wall is a wall for ordinary movement and stays one layer too tall to climb.
  const blocked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' });
  assert.deepEqual({ x: blocked.x, y: blocked.y, blocked: blocked.blocked }, { x: 34, y: 32, blocked: true });
  f.advance();
  const climbed = f.tx('climbAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' });
  assert.deepEqual({ x: climbed.x, y: climbed.y, blocked: climbed.blocked }, { x: 34, y: 32, blocked: true });
  // A single hand-placed block keeps its own shipped rules beside the blueprint.
  stand(f, alice, { x: 32, y: 33 });
  f.advance();
  assert.equal(request(f, 'alice', alice, { x: 33, y: 33, z: 0, type: 'stone' }).changed, true);
  assert.equal(blocks(f), 15);
  assert.equal(walkable({ x: 34, y: 32 }, getWorldDefinition(world)), true, 'a path floor never blocks the doorway');
  assert.equal(frontierPlotId(world, 34, 32), plot);
});
