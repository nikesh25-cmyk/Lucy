import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Platform } from '../src/platform.js';
import { LAND_WORLD, LAND_SCHEMA, LAND_BLOCK_GUARDS } from '../src/frontier.js';
import { frontierCoordinates, frontierGates, frontierPlotId, getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const world = 'frontier:0:0', plot = 'plot:0:0:5:5';
const assign = (f, owner = 'alice', id = plot, changes = {}) => f.tx('landAssign', f.actor(owner), { plot_id: id, purpose: 'Agricultural learning garden', description: 'Develop a virtual teaching garden for source-based learning.', ...changes });
const tile = (id = world) => {
  for (let y = 31; y <= 34; y++) for (let x = 31; x <= 34; x++) if ([[0, 0], [-1, 0], [-2, 0], [1, 0], [0, 1], [0, -1]].every(([dx, dy]) => walkable({ x: x + dx, y: y + dy }, id))) return { x, y };
  throw new Error('Missing open fixture tile.');
};
const stand = (f, agent, position, id = world) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', id, position.x - 1, position.y, agent.id);
const build = (f, owner, agent, position, extra = {}) => f.tx('frontierBuild', f.actor(owner), agent.id, { world_id: world, ...position, z: 0, type: 'wood', ...extra });

test('finite land registry has immutable canonical addresses and exact complete inventory, scale and reserves', async t => {
  const f = await fixture(t), data = f.platform.land(null, { world_id: world, limit: 50 });
  assert.deepEqual(data.counts, { gross: 16384, reserved: 8192, permanent_reserved: 8192, assignable: 8192, opened: 64, assigned: 0, available: 32, unopened: 8160, occupied: 0, occupied_unassigned: 0, blocked_by_existing: 0, total: 16384, total_areas: 256, opened_areas: 1 });
  assert.equal(data.areas.length, 256); assert.equal(data.total, 64); assert.equal(data.has_more, true);
  assert.equal(data.world.width_m * data.world.height_m, 589824);
  assert.equal(data.world.plot_area_m2, 36); assert.match(data.world.units_note, /virtual.*no real property/i);
  assert.equal(data.areas.every(area => area.reserved_plots === 32 && area.assignable_plots === 32), true);
  assert.equal(frontierPlotId(world, 30, 35), plot); assert.equal(frontierPlotId('frontier:8:0', 30, 35), null);
  assert.equal(frontierCoordinates('frontier:-8:7').x, -8); assert.equal(frontierCoordinates('frontier:8:7'), null);
  assert.equal(frontierGates('frontier:-8:-8').some(gate => ['up', 'left'].includes(gate.direction)), false);
  assert.equal(f.platform.landPlot(null, { plot_id: 'plot:0:0:4:5' }).plot.reserved, true);
  assert.equal(f.platform.landPlot(null, { plot_id: plot }).plot.buildable_cells, 35);
  assert.throws(() => f.platform.run('UPDATE land_parcels SET x=0 WHERE id=?', plot), /immutable/);
  assert.throws(() => f.platform.run('DELETE FROM land_parcels WHERE id=?', plot), /immutable/);
  for (const id of ['plot:-0:0:5:5', 'plot:8:0:0:0', 'plot:0:0:8:0', 'plot:0:0:05:5', 'plot:0:0:5:5:extra', '']) assert.throws(() => f.platform.landPlot(null, { plot_id: id }), { status: 400 });
  assert.throws(() => f.platform.land(null, { world_id: 'frontier:8:0' }), { status: 400 });
  assert.throws(() => f.platform.land(null, { limit: 51 }), { status: 400 });
  assert.throws(() => f.platform.land(null, { mine: '1' }), { status: 401 });
});

test('human stewardship is one plot per operator, purposeful, idempotent and transactionally exclusive without payment', async t => {
  const f = await fixture(t), result = assign(f);
  assert.equal(result.assigned, true); assert.equal(result.plot.state, 'assigned'); assert.equal(result.plot.is_mine, true);
  assert.equal(assign(f).assigned, false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_events').n, 1);
  assert.throws(() => assign(f, 'bob'), { status: 409 });
  assert.throws(() => assign(f, 'alice', 'plot:0:0:1:1'), { status: 409 });
  assert.throws(() => assign(f, 'bob', 'plot:0:0:4:5'), { status: 409 });
  assert.throws(() => assign(f, 'bob', 'plot:1:0:5:5'), { status: 409 });
  for (const extra of [{ price: 0 }, { currency: 'NEMO' }, { payment: 'free' }, { account_id: f.actor('alice').account.id }, { transfer: true }]) assert.throws(() => assign(f, 'bob', 'plot:0:0:1:1', extra), { status: 400 });
  for (const changes of [{ purpose: '' }, { purpose: 'a'.repeat(121) }, { description: 'a'.repeat(501) }]) assert.throws(() => assign(f, 'bob', 'plot:0:0:1:1', changes), { status: 400 });
  assert.throws(() => f.platform.run('INSERT INTO land_stewardships VALUES(?,?,?,?,?)', 'plot:0:0:1:1', f.actor('alice').account.id, 'Duplicate account plot', '', new Date(f.clock()).toISOString()), /UNIQUE/);
  assert.throws(() => f.platform.run('UPDATE land_stewardships SET purpose=? WHERE plot_id=?', 'Change identity', plot), /Release stewardship/);
  const visible = f.platform.landPlot(null, { plot_id: plot }).plot;
  assert.equal(visible.steward_name, 'alice'); assert.equal(visible.is_mine, false); assert.equal(Object.hasOwn(visible, 'account_id'), false);
  assert.equal(f.platform.land(f.actor('alice'), { mine: '1' }).total, 1);
  assert.equal(f.platform.land(f.actor('bob'), { mine: '1' }).total, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('runtimes cannot acquire land and all owned residents build only in the operator plot with supported layers', async t => {
  const f = await fixture(t), first = f.agent('alice'), second = f.agent('alice', 'Second builder'), bob = f.agent('bob'), position = tile();
  stand(f, first, position); stand(f, second, position); stand(f, bob, position);
  assert.throws(() => build(f, 'alice', first, position), { status: 403 });
  assign(f);
  const runtime = f.tx('runtime', f.actor('alice'), first.id, { scopes: ['read', 'build'], max_calls: 20 }), actor = f.platform.authenticate(runtime.token, 'build');
  assert.throws(() => f.tx('landAssign', actor, { plot_id: plot, purpose: 'Agent acquisition' }), { status: 403 });
  assert.throws(() => f.tx('landRelease', actor, { plot_id: plot }), { status: 403 });
  assert.equal(f.platform.world(actor).frontier.parcels.find(parcel => parcel.id === plot).is_mine, true);
  const placed = f.tx('frontierBuild', actor, first.id, { world_id: world, ...position, z: 0, type: 'wood' });
  assert.equal(placed.plot_id, plot);
  assert.throws(() => build(f, 'bob', bob, position), { status: 403 });
  const outside = [27, 28, 29].map(x => ({ x, y: position.y })).find(point => walkable(point, world) && Math.abs(point.x - (position.x - 1)) <= 6);
  assert.ok(outside); assert.notEqual(frontierPlotId(world, outside.x, outside.y), plot);
  assert.throws(() => build(f, 'alice', second, outside), { status: 403 });
  f.advance(); assert.equal(build(f, 'alice', second, position, { z: 1, type: 'glass' }).changed, true);
  const human = f.tx('createAgent', f.actor('alice'), { kind: 'human', name: 'Human builder' }); stand(f, human, position);
  assert.throws(() => f.tx('landRelease', f.actor('alice'), { plot_id: plot }), { status: 409 });
  f.advance(); assert.equal(build(f, 'alice', human, position, { z: 1, remove: true }).removed, true);
  f.advance(); assert.equal(build(f, 'alice', human, position, { remove: true }).removed, true);
  assert.equal(f.tx('landRelease', f.actor('alice'), { plot_id: plot }).released, true);
  assert.equal(f.platform.landPlot(null, { plot_id: plot }).plot.state, 'available');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('legacy structures cannot be appropriated, are counted as occupied, and retain original-builder removal', async t => {
  const f = await fixture(t), original = f.agent('alice'), sibling = f.agent('alice', 'Sibling'), bob = f.agent('bob'), position = tile();
  stand(f, original, position); stand(f, sibling, position); stand(f, bob, position);
  // Emulate a block retained from schema ten; new inserts cannot omit a parcel.
  f.platform.db.exec('DROP TRIGGER frontier_blocks_plot_insert');
  f.platform.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), world, position.x, position.y, 0, 'wood', original.id, f.actor('alice').account.id, new Date(f.clock()).toISOString());
  f.platform.db.exec(LAND_BLOCK_GUARDS);
  const summary = f.platform.landSummary();
  assert.equal(summary.counts.available, 31); assert.equal(summary.counts.reserved, 8192); assert.equal(summary.counts.occupied_unassigned, 1);
  assert.equal(summary.counts.gross, summary.counts.reserved + summary.counts.available + summary.counts.assigned + summary.counts.unopened + summary.counts.occupied);
  assert.equal(summary.areas.find(area => area.world_id === world).available_plots, 31);
  const legacy = f.platform.landPlot(null, { plot_id: plot }).plot;
  assert.equal(legacy.state, 'reserved'); assert.equal(legacy.permanent_reserved, false); assert.match(legacy.reserved_reason, /Existing construction/);
  assert.throws(() => assign(f, 'bob'), { status: 409 });
  assert.throws(() => build(f, 'alice', sibling, position, { remove: true }), { status: 403 });
  assert.throws(() => build(f, 'bob', bob, position, { remove: true }), { status: 403 });
  assert.equal(build(f, 'alice', original, position, { remove: true }).removed, true);
  assert.equal(f.platform.landSummary().counts.available, 32);
  assert.equal(assign(f, 'bob').assigned, true);
});

test('stewardship persists and account deletion releases identity while preserving blocks for human cleanup', async t => {
  const f = await fixture(t), builder = f.agent('alice'), position = tile(); stand(f, builder, position); assign(f);
  build(f, 'alice', builder, position);
  const exported = f.platform.exportAccount(f.actor('alice'));
  assert.equal(exported.frontier.stewardships[0].plot_id, plot); assert.equal(exported.frontier.land_events.length, 1);
  f.platform.close(); const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  const alice = restarted.authenticate(f.credentials.alice.token);
  assert.equal(restarted.landPlot(alice, { plot_id: plot }).plot.is_mine, true);
  assert.equal(restarted.world(alice, { agent_id: builder.id }).frontier.my_plot.id, plot);
  restarted.transaction(() => restarted.deleteAccount(alice));
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 1);
  assert.equal(restarted.get('SELECT purpose,description FROM land_events').purpose, '[removed]');
  assert.equal(restarted.landSummary().counts.available, 31);
  assert.equal(restarted.landPlot(null, { plot_id: plot }).plot.state, 'reserved');
  assert.equal(restarted.verifyAudit(), true);
});

test('finite perimeter guards preserve legacy areas, while assignment quotas and pause stop new writes', async t => {
  const f = await fixture(t), agent = f.agent('alice'), timestamp = new Date(f.clock()).toISOString();
  assert.throws(() => f.platform.transaction(() => {
    f.platform.run('INSERT INTO worlds VALUES(?,?,?,NULL,?,?,?,?)', 'frontier:8:0', 'Outside', 'frontier', 'public', 48, 48, timestamp);
    f.platform.run('INSERT INTO frontier_sectors VALUES(?,?,?,NULL,NULL,?)', 'frontier:8:0', 8, 0, timestamp);
  }), /finite land boundary/);
  assert.equal(f.platform.get('SELECT id FROM worlds WHERE id=?', 'frontier:8:0'), undefined);
  // Preserve a pre-perimeter area without allocating new canonical plots for it.
  f.platform.db.exec('DROP TRIGGER frontier_sectors_finite_insert');
  f.platform.run('INSERT INTO worlds VALUES(?,?,?,NULL,?,?,?,?)', 'frontier:10:0', 'Legacy landscape', 'frontier', 'public', 48, 48, timestamp);
  f.platform.run('INSERT INTO frontier_sectors VALUES(?,?,?,NULL,NULL,?)', 'frontier:10:0', 10, 0, timestamp);
  f.platform.db.exec(LAND_SCHEMA);
  assert.equal(f.platform.frontierMap(null).legacy_total, 1); assert.equal(f.platform.frontierMap(null).total, 1);
  assert.equal(f.platform.world(null, { world_id: 'frontier:10:0' }).frontier.parcels.length, 0);
  assert.equal(f.platform.world(null, { world_id: 'frontier:10:0' }).portals.some(portal => portal.target_world_id === 'commons'), true);
  f.platform.run('UPDATE agents SET world_id=?,x=46,y=24 WHERE id=?', 'frontier:10:0', agent.id);
  assert.throws(() => f.tx('frontierExpand', f.actor('alice'), agent.id, { world_id: 'frontier:10:0', direction: 'right' }), { status: 409 });
  const available = f.platform.land(f.actor('alice'), { world_id: world, status: 'available', limit: 5 }).plots;
  for (const item of available.slice(0, 4)) { f.advance(); assign(f, 'alice', item.id); f.advance(); f.tx('landRelease', f.actor('alice'), { plot_id: item.id }); }
  f.advance(); assert.throws(() => assign(f, 'alice', available[4].id), { status: 429 });
  f.platform.run("UPDATE settings SET value='true' WHERE key='paused'");
  assert.throws(() => assign(f, 'bob', available[4].id), { status: 503 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n, 0);
  assert.equal(f.platform.landSummary().counts.gross, LAND_WORLD.total_plots);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});
