// The bounded viewport read over a real platform: the cover across a seam, the saved state of every
// region it includes, and the stated bound measured rather than asserted from reading the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { MAP_LAYOUT, toGlobal } from '../src/global-map.js';
import { VIEWPORT_BOUNDS } from '../src/map-viewport.js';

const place = (f, agent, world, x, y) => f.platform.run("UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0,last_seen=? WHERE id=?", world, x, y, f.clock(), agent.id);
const rectOf = (worldId) => MAP_LAYOUT.find((item) => item.world === worldId);
const localWindow = (region) => { const rect = rectOf(region.world_id); return { x: region.window.gx - rect.x, y: region.window.gy - rect.y, right: region.window.gx - rect.x + region.window.columns, bottom: region.window.gy - rect.y + region.window.rows }; };

/** Instrument the platform so a read's own database work is counted, not inferred. */
function meter(platform) {
  const counts = { statements: 0, rows: 0, all: 0, get: 0, run: 0 };
  const originals = {};
  const wrap = (name, tally) => {
    originals[name] = platform[name];
    const original = platform[name].bind(platform);
    platform[name] = (...args) => {
      counts[name] += 1; counts.statements += 1;
      const result = original(...args);
      const size = Array.isArray(result) ? result.length : result === undefined || result === null ? 0 : 1;
      counts.rows += size;
      tally(size);
      return result;
    };
  };
  wrap('all', (size) => { counts.rows += size; });
  wrap('get', () => {});
  wrap('run', () => {});
  counts.stop = () => { for (const [name, original] of Object.entries(originals)) platform[name] = original; };
  return counts;
}

/** One read of a region with its window, and the same read without it: the chunking decision, measured. */
function rowsRead(platform, worldId, local, chunked) {
  const where = chunked ? 'AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?' : '';
  const args = chunked ? [local.x, local.right - 1, local.y, local.bottom - 1] : [];
  return ['agents', 'world_objects', 'npc_mayors', 'npc_ambassadors']
    .map((table) => platform.all(`SELECT id FROM ${table} WHERE world_id=? ${where}`, worldId, ...args).length)
    .reduce((sum, count) => sum + count, 0);
}

/**
 * A map rectangle cannot hold a saved placement: the shipped `world_objects_build_guard` allows one
 * only inside a world of kind 'home' or 'house'. To exercise the windowed object read at all, this
 * fixture gives one region of the layout that kind inside the disposable test database. It changes no
 * shipped rule and no production row.
 */
function allowPlacements(f, worldId) {
  f.platform.run("UPDATE worlds SET kind='home' WHERE id=?", worldId);
  const rect = rectOf(worldId);
  const tiles = [];
  for (let y = 1; y < rect.height - 1 && tiles.length < 40; y++) for (let x = 1; x < rect.width - 1 && tiles.length < 40; x++) tiles.push({ x, y });
  return tiles;
}

test('a viewport across the north seam reports every included region, its actors and their presence', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  place(f, alice, 'commons', 25, 0);
  place(f, bob, 'district:highlands', 25, 35);
  const aliceAt = toGlobal('commons', 25, 0), bobAt = toGlobal('district:highlands', 25, 35);
  assert.equal(bobAt.gy, aliceAt.gy - 1, 'the fixture really straddles the seam');
  const window = { gx: aliceAt.gx - 6, gy: aliceAt.gy - 6, columns: 12, rows: 12 };
  const view = f.platform.mapViewport(f.actor('alice'), { ...window, agent_id: alice.id });

  const ids = view.regions.map((region) => region.world_id);
  assert.deepEqual([...ids].sort(), ['commons', 'district:highlands'], 'both sides of the seam are read');
  assert.deepEqual(ids, [...ids].sort(), 'the regions are ordered, so two clients can diff the same window');
  const seenAlice = view.participants.find((item) => item.id === alice.id), seenBob = view.participants.find((item) => item.id === bob.id);
  assert.deepEqual({ world: seenAlice.world_id, x: seenAlice.x, y: seenAlice.y }, { world: 'commons', x: 25, y: 0 }, 'the anchor side keeps its own world and coordinates');
  assert.deepEqual({ world: seenBob.world_id, x: seenBob.x, y: seenBob.y }, { world: 'district:highlands', x: 25, y: 35 }, 'the far side of the seam keeps its own world and coordinates');
  assert.ok(['connected', 'recent_visit', 'offline'].includes(view.presence[bob.id]), `a resident across the seam reports its presence (saw ${view.presence[bob.id]})`);
  assert.equal(view.viewer_agent_id, alice.id);
  for (const region of view.regions) {
    const local = localWindow(region);
    const expected = f.platform.all('SELECT id FROM agents WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?', region.world_id, local.x, local.right - 1, local.y, local.bottom - 1).map((row) => row.id).sort();
    assert.deepEqual(view.participants.filter((item) => item.world_id === region.world_id && item.kind !== 'npc').map((item) => item.id).sort(), expected, `${region.world_id}: exactly the windowed residents are returned`);
  }

  // A resident who is not in the window at all is absent, and the cover does not depend on who is in it.
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${alice.id}`, bob.id);
  const again = f.platform.mapViewport(f.actor('alice'), { ...window, agent_id: alice.id });
  assert.equal(again.participants.some((item) => item.id === bob.id), false, 'moving the resident out of the window removes it');
  assert.deepEqual(again.regions.map((region) => region.world_id), ids, 'the cover of a window does not depend on who is in it');

  // A saved change of posture and emote across the seam is reported, because those are stored rows.
  place(f, bob, 'district:highlands', 25, 35);
  f.platform.run("UPDATE agents SET posture='sitting',emote='wave' WHERE id=?", bob.id);
  const posture = f.platform.mapViewport(f.actor('alice'), { ...window, agent_id: alice.id }).participants.find((item) => item.id === bob.id);
  assert.deepEqual({ posture: posture.posture, emote: posture.emote }, { posture: 'sitting', emote: 'wave' }, 'the neighbour\'s saved posture and expression cross the seam');
});

test('the finite world is not reachable from a viewport: a map rectangle can hold no saved placement', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  place(f, alice, 'commons', 25, 0);
  // The shipped guard, not this module, is what refuses it: a placement exists only in a garden or cottage.
  assert.throws(() => f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES('nope','commons','bench',25,10,?)", new Date(f.clock()).toISOString()),
    /Garden objects must use the build palette/, 'the database refuses a saved placement in a map rectangle');
  assert.throws(() => f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES('nope2','district:highlands','bench',5,5,?)", new Date(f.clock()).toISOString()),
    /Garden objects must use the build palette/, 'and in any other rectangle of the map');
  const at = toGlobal('commons', 25, 0);
  const view = f.platform.mapViewport(f.actor('alice'), { gx: at.gx - 6, gy: at.gy - 6, columns: 12, rows: 12 });
  assert.deepEqual(view.objects, [], 'so a crossing viewport reports no saved placement, because there is none to report');
  assert.deepEqual(view.regions.map((region) => region.counts.objects), view.regions.map(() => 0));
});

test('saved state in every included region is windowed, tagged with its own world, and bounded', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  place(f, alice, 'commons', 25, 0);
  const tiles = allowPlacements(f, 'orchard');
  for (const [index, tile] of tiles.entries()) f.platform.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?)', `orchard-${index}`, 'orchard', 'bench', tile.x, tile.y, new Date(f.clock()).toISOString());
  const orchard = rectOf('orchard');
  const view = f.platform.mapViewport(f.actor('alice'), { gx: orchard.x, gy: orchard.y, columns: 20, rows: 14 });
  const region = view.regions.find((item) => item.world_id === 'orchard');
  assert.ok(region, 'the orchard is covered by a window over it');
  const local = localWindow(region);
  const expected = f.platform.all('SELECT id FROM world_objects WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?', 'orchard', local.x, local.right - 1, local.y, local.bottom - 1).map((row) => row.id).sort();
  assert.ok(expected.length > 0, 'the fixture put saved placements inside the window');
  assert.deepEqual(view.objects.filter((item) => item.world_id === 'orchard').map((item) => item.id).sort(), expected, 'exactly the saved placements inside the clipped window are returned');
  assert.equal(region.counts.objects, expected.length, 'and the region reports the count it returned');
  assert.ok(view.objects.every((item) => item.world_id === 'orchard' && Number.isInteger(item.x) && Number.isInteger(item.y)), 'every placement carries the world it is stored in');
  // A placement outside the window is not read.
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES('outside','orchard','bench',?,?,?)", orchard.width - 1, orchard.height - 1, new Date(f.clock()).toISOString());
  const again = f.platform.mapViewport(f.actor('alice'), { gx: orchard.x, gy: orchard.y, columns: 20, rows: 14 });
  assert.equal(again.objects.some((item) => item.id === 'outside'), false, 'a placement past the window is not returned');
});

test('the bound is measured: the read stays inside its own statement and row ceilings and writes nothing', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  place(f, alice, 'commons', 25, 0);
  const actor = f.actor('alice');
  const counts = meter(f.platform);
  const wide = f.platform.mapViewport(actor, { gx: 90, gy: 60, columns: 200, rows: 200, agent_id: alice.id });
  assert.equal(counts.run, 0, 'a viewport read issues no write');
  assert.equal(wide.work.statements, counts.statements, 'the read reports the statements it really issued');
  assert.ok(counts.statements <= VIEWPORT_BOUNDS.max_statements, `the measured ${counts.statements} statements stay inside the stated ${VIEWPORT_BOUNDS.max_statements}`);
  assert.equal(wide.work.regions, 6, 'this clamped window covers six regions, including the second-ring rainforest strip');
  assert.ok(wide.work.regions <= VIEWPORT_BOUNDS.max_regions, 'the region count stays inside the stated bound');
  assert.ok(wide.participants.length <= VIEWPORT_BOUNDS.max_participants && wide.objects.length <= VIEWPORT_BOUNDS.max_rows_returned, 'no family exceeds its stated cap');
  assert.equal(wide.clamped, true, 'an over-large window is clamped and says so');
  assert.deepEqual(wide.window, { gx: 90, gy: 60, columns: 96, rows: 64 }, 'the clamped window is answered, not the request');
  t.diagnostic(`measure: regions=${wide.work.regions} statements=${counts.statements}/${VIEWPORT_BOUNDS.max_statements} rows=${counts.rows} ceiling=${VIEWPORT_BOUNDS.max_rows_returned}`);

  for (const region of MAP_LAYOUT) {
    const one = meter(f.platform);
    f.platform.mapViewport(actor, { world_id: region.world, x: 0, y: 0, agent_id: alice.id });
    assert.ok(one.statements <= VIEWPORT_BOUNDS.max_statements, `${region.world}: ${one.statements} statements inside the bound`);
    assert.equal(one.run, 0, `${region.world}: the read writes nothing`);
  }
});

test('the windowed read is the chunking decision, measured against the same read over a whole region', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  place(f, alice, 'commons', 25, 0);
  const tiles = allowPlacements(f, 'orchard');
  for (const [index, tile] of tiles.entries()) f.platform.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?)', `chunk-${index}`, 'orchard', 'flowers', tile.x, tile.y, new Date(f.clock()).toISOString());
  const orchard = rectOf('orchard');
  const view = f.platform.mapViewport(f.actor('alice'), { gx: orchard.x - 30, gy: orchard.y, columns: 60, rows: 28 });
  const region = view.regions.find((item) => item.world_id === 'orchard');
  const local = localWindow(region);
  const whole = rowsRead(f.platform, 'orchard', local, false), windowed = rowsRead(f.platform, 'orchard', local, true);
  assert.ok(windowed <= whole, `the windowed read can never return more rows than the whole-region read (${windowed} vs ${whole})`);
  assert.ok(windowed < whole, `the windowed read is the smaller read for this window (${windowed} vs ${whole} rows)`);
  const inWindow = f.platform.all('SELECT id FROM world_objects WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?', 'orchard', local.x, local.right - 1, local.y, local.bottom - 1).map((row) => row.id).sort();
  assert.deepEqual(view.objects.filter((item) => item.world_id === 'orchard').map((item) => item.id).sort(), inWindow, 'the read returns exactly the placements inside the clipped window');
  assert.equal(region.tiles, local.right - local.x === 0 ? 0 : (local.right - local.x) * (local.bottom - local.y), 'the region counts the tiles it clipped');
  t.diagnostic(`chunking: windowed ${windowed} rows for orchard vs ${whole} for the whole region; ${inWindow.length} of ${tiles.length} placements are inside the window`);
});

test('the viewport route is a read over real HTTP, adds no authority of its own and leaks no private field', async (t) => {
  const f = await fixture(t);
  const app = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.stopEvents(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bob = f.agent('bob');
  place(f, bob, 'district:highlands', 25, 35);
  const at = toGlobal('commons', 25, 0);

  const response = await fetch(`${base}/api/v1/map?world_id=commons&gx=${at.gx - 6}&gy=${at.gy - 6}&columns=12&rows=12`);
  assert.equal(response.status, 200, 'an anonymous client may read a viewport, exactly as /world is public');
  const view = await response.json();
  assert.deepEqual(view.regions.map((item) => item.world_id), ['commons', 'district:highlands']);
  assert.ok(view.participants.some((item) => item.id === bob.id), 'the anonymous read sees the resident across the seam');
  const text = JSON.stringify(view);
  assert.equal(/operator_id|"operator"|capabilities|limitations|accepted_contributions|has_session/.test(text), false, 'no operator identity or private profile field leaves the read');
  assert.equal(text.includes('home:'), false, 'no garden or cottage is ever a region of the viewport');

  assert.equal((await fetch(`${base}/api/v1/map?world_id=hall`)).status, 404, 'a world that is not on the map is refused');
  assert.ok((await fetch(`${base}/api/v1/map`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status >= 400, 'the route is a GET-only read');
});

test('the viewport read is measured against the shipped map window over the same seam', async (t) => {
  // The published `world?map=core` window is the map owner's projection and is not changed here. This
  // measures both reads over the same seam so the cost of the new one is stated, not assumed.
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  place(f, alice, 'commons', 25, 2);
  place(f, bob, 'district:highlands', 26, 33);
  const actor = f.actor('alice');
  const time = (run) => { const started = performance.now(); const value = run(); return { value, ms: performance.now() - started }; };
  const shipped = meter(f.platform);
  const ownerWindow = time(() => f.platform.world(actor, { world_id: 'commons', agent_id: alice.id, map: 'core' }));
  const shippedCount = { ...shipped };
  shipped.stop();
  const bounded = meter(f.platform);
  const at = toGlobal('commons', 25, 2);
  const viewport = time(() => f.platform.mapViewport(actor, { gx: at.gx - 20, gy: at.gy - 14, columns: 40, rows: 28, agent_id: alice.id }));
  const boundedCount = { ...bounded };
  bounded.stop();
  assert.equal(boundedCount.run, 0, 'the bounded viewport read writes nothing at all');
  assert.ok(viewport.value.participants.some((item) => item.id === bob.id), 'both reads see the resident across the seam');
  assert.ok(ownerWindow.value.map.participants.some((item) => item.id === bob.id), 'the shipped window sees the resident too');
  t.diagnostic(`shipped map=core: ${shippedCount.statements} statements, ${shippedCount.rows} rows, ${shippedCount.run} writes, ${ownerWindow.ms.toFixed(1)} ms`);
  t.diagnostic(`bounded /map:     ${boundedCount.statements} statements, ${boundedCount.rows} rows, ${boundedCount.run} writes, ${viewport.ms.toFixed(1)} ms`);
  assert.equal(boundedCount.statements, viewport.value.work.statements, 'the new read reports its own statements');
  assert.ok(boundedCount.statements <= VIEWPORT_BOUNDS.max_statements, 'the new read is inside its stated bound');
  assert.ok(viewport.value.work.regions <= 3, 'a viewport at a seam covers only the regions the window really touches');
});

test('every region the read ranges over is a public shared world in the seeded registry', async (t) => {
  const f = await fixture(t);
  for (const item of MAP_LAYOUT) {
    const row = f.platform.get('SELECT owner_agent_id,visibility,kind FROM worlds WHERE id=?', item.world);
    assert.ok(row, `${item.world} is a seeded world row`);
    assert.equal(row.owner_agent_id, null, `${item.world} is an unowned shared world, so no garden's privacy can be reached through it`);
    assert.equal(row.visibility, 'public', `${item.world} is public, which is why the viewport read adds no readability of its own`);
  }
});
