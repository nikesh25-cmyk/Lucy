import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { getWorldDefinition } from '../world.js';
import { MAP_ID, toGlobal } from '../src/global-map.js';
import { storedPresencePoint, toMapItem } from '../src/map-view.js';
import { createPresenceTracker, displayCoords } from '../src/camera-controls.js';
import { VIEWPORT_BOUNDS } from '../src/map-viewport.js';

const place = (f, resident, world, x, y) => f.platform.run(
  'UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0 WHERE id=?', world, x, y, resident.id
);
const held = (view, id) => [...view.participants, ...view.map.participants].find((resident) => resident.id === id);

test('an observation anchored on the previous region follows the stored resident across a seam', async (t) => {
  const f = await fixture(t), resident = f.agent('alice');
  place(f, resident, 'commons', 25, 0);
  const request = { world_id: 'commons', agent_id: resident.id, map: 'core' };
  const before = f.platform.world(f.actor('alice'), request);
  assert.equal(held(before, resident.id).world_id, 'commons');
  f.advance(200);
  const crossed = f.tx('moveAgent', f.actor('alice'), { agent_id: resident.id, direction: 'up' });
  assert.equal(crossed.seam, true);
  const after = f.platform.world(f.actor('alice'), request);
  assert.equal(after.world.id, 'commons', 'the subscription can retain its original anchor while reconnecting');
  const seen = held(after, resident.id);
  assert.ok(seen, 'the followed resident remains visible in the stitched payload');
  assert.deepEqual({ world_id: seen.world_id, x: seen.x, y: seen.y }, { world_id: 'district:highlands', x: 25, y: 35 });
  const centre = toGlobal(seen.world_id, seen.x, seen.y);
  assert.equal(after.map.window.gx + Math.floor(after.map.window.width / 2), centre.gx);
  assert.equal(after.map.window.gy + Math.floor(after.map.window.height / 2), centre.gy);
  assert.ok(after.map.worlds.every((world) => !world.world_id.startsWith('home:') && !world.world_id.startsWith('house:')),
    'following a resident does not project private homes into the map');
});

test('an off-map followed resident leaves the observation centered on the public anchor camera', async (t) => {
  const f = await fixture(t), resident = f.agent('alice');
  place(f, resident, `home:${resident.id}`, 5, 5);
  const view = f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: resident.id, map: 'core', x: 0, y: 0 });
  assert.equal(held(view, resident.id), undefined, 'a private garden is not made part of the stitched map');
  assert.ok(view.map.worlds.every((world) => !world.world_id.startsWith('home:')));
  assert.ok(Number.isFinite(view.map.window.gx) && Number.isFinite(view.map.window.gy));
});

test('cross-region fixture inspection names the recovery without inventing a local distance', async (t) => {
  const f = await fixture(t), resident = f.agent('alice');
  place(f, resident, 'commons', 25, 0);
  const world = 'district:highlands', bench = getWorldDefinition(world).objects.find((item) => item.type === 'bench');
  assert.ok(bench);
  const read = f.platform.interactionView(f.actor('alice'), { agent_id: resident.id, world_id: world, x: bench.x, y: bench.y });
  assert.equal(read.fixture.distance, null);
  assert.equal(read.fixture.in_range, false);
  assert.equal(read.fixture.can_act, false);
  assert.equal(read.fixture.blocked_by, 'another_world');
  assert.match(read.fixture.hint, /resident is in another region/);
  assert.doesNotMatch(read.fixture.hint, /no resident is acting/);
  assert.match(read.fixture.next_step, /bring .* into/);
  const visitor = f.platform.interactionView(null, { world_id: world, x: bench.x, y: bench.y });
  assert.equal(visitor.fixture.distance, null);
  assert.equal(visitor.fixture.blocked_by, 'inspect_only');
  assert.match(visitor.fixture.hint, /no resident is acting/);
});

test('world and guide observations perform no patrol writes while the explicit patrol tick still works', async (t) => {
  const f = await fixture(t), resident = f.agent('alice');
  place(f, resident, 'commons', 25, 0);
  f.advance(60_000);
  const changes = () => f.platform.get('SELECT total_changes() AS n').n;
  const patrol = () => f.platform.all('SELECT id,x,y,ticks,last_tick FROM npc_mayors ORDER BY id');
  const beforePatrol = patrol(), beforeChanges = changes();
  f.platform.mayors(null);
  f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: resident.id, map: 'core' });
  f.platform.world(null, { world_id: 'commons', map: 'core', x: 0, y: 0 });
  assert.equal(changes(), beforeChanges, 'anonymous and signed-in observations commit no database changes');
  assert.deepEqual(patrol(), beforePatrol, 'a guide does not move merely because a region was observed');
  f.tx('tickMayors');
  const afterPatrol = patrol();
  assert.ok(afterPatrol.some((guide, index) => guide.ticks > beforePatrol[index].ticks), 'the server-owned tick still advances due guides');
  assert.ok(changes() > beforeChanges);
});

test('the playing map uses one bounded viewport without recursive world reads and preserves public appearance', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), outside = f.agent('bob', 'Outside the people window');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'cultivator' });
  f.tx('updateProfile', f.actor('bob'), { agent_id: bob.id, title: 'Resident', avatar: 'star', bio: 'private map biography', purpose: 'private map purpose' });
  place(f, alice, 'commons', 25, 0);
  place(f, bob, 'district:highlands', 26, 33);
  place(f, outside, 'district:highlands', 42, 33);
  f.platform.run("UPDATE npc_mayors SET x=24,y=34 WHERE id='mayor-highlands'");
  const guide = f.platform.get("SELECT sprite,direction FROM npc_mayors WHERE id='mayor-highlands'");
  const actor = f.actor('alice'), viewer = f.platform.ownedAgent(actor, alice.id);
  let statements = 0, writes = 0, viewportCalls = 0, viewportWork = null;
  for (const method of ['get', 'all', 'run']) {
    const original = f.platform[method].bind(f.platform);
    f.platform[method] = (...args) => { statements++; if (method === 'run') writes++; return original(...args); };
  }
  const viewport = f.platform.mapViewport.bind(f.platform);
  f.platform.mapViewport = (...args) => { viewportCalls++; const result = viewport(...args); viewportWork = result.work; return result; };
  f.platform.world = () => { throw new Error('mapWindow must not recursively build a world payload'); };
  const view = f.platform.mapWindow(actor, viewer, 'commons', { x: 15, y: 0 }, { agent_id: alice.id });
  assert.equal(viewportCalls, 1, 'the actual playing-map projection uses the shared viewport reader');
  assert.equal(writes, 0);
  assert.equal(viewportWork.tiles, 37 * 37);
  assert.equal(viewportWork.regions, view.worlds.length, 'the anchor is not read again or charged to the neighbour roster');
  assert.ok(viewportWork.statements <= VIEWPORT_BOUNDS.max_statements);
  // publicCallings performs six bounded batch reads; the cosmetic roster adds one more.
  assert.equal(statements, viewportWork.statements + 7, 'all extra work is the stated public appearance batch');
  assert.ok(statements <= 4 * view.worlds.length + 9, `the measured ${statements} statements stay bounded by the regions read`);
  assert.equal(view.id, 'core');
  assert.deepEqual(view.window, { gx: 111, gy: 65, width: 20, height: 14 });
  assert.ok(view.participants.length <= 199);
  const seen = view.participants.find((item) => item.id === bob.id);
  assert.equal(seen.calling.id, 'cultivator');
  assert.equal(seen.avatar, 'star');
  assert.equal(seen.title, 'Resident');
  const civic = view.participants.find((item) => item.id === 'mayor-highlands');
  assert.equal(civic.sprite, guide.sprite);
  assert.equal(civic.direction, guide.direction);
  assert.equal(civic.calling.id, 'steward');
  assert.equal(view.participants.some((item) => item.id === outside.id), false, 'the 37-tile read does not expand the 20-tile people window');
  assert.equal(view.participants.some((item) => item.id === alice.id), false, 'the ordinary anchor payload supplies its own residents');
  assert.doesNotMatch(JSON.stringify(view), /private map biography|private map purpose|operator_id|capabilities|limitations/);
});

test('presence diagnostics convert confirmed map tiles and fractional display points into their stored regions', () => {
  let now = 0;
  const tracker = createPresenceTracker({ now: () => now, duration: 100, reducedMotion: () => false });
  tracker.confirm(toMapItem({ id: 'walker', world_id: 'commons', x: 25, y: 0, z: 0 }));
  now = 1;
  const record = tracker.confirm(toMapItem({ id: 'walker', world_id: 'district:highlands', x: 25, y: 35, z: 0 }));
  assert.equal(record.world, MAP_ID);
  assert.equal(record.duration, 100, 'the renderer retains a continuous global frame across the seam');
  assert.deepEqual(storedPresencePoint(record.confirmed, record.world), { world_id: 'district:highlands', x: 25, y: 35, z: 0 });
  const halfway = displayCoords(record, 51);
  assert.equal(halfway.y, 71.5);
  assert.deepEqual(storedPresencePoint(halfway, record.world), { world_id: 'district:highlands', x: 25, y: 35.5, z: 0 });
  assert.deepEqual(record.confirmed, { x: 121, y: 71, z: 0 }, 'a diagnostic conversion does not mutate the renderer record');
});

test('presence diagnostics use the record frame for interiors and preserve the reduced-motion outcome', () => {
  const point = { x: 106, y: 77, z: 1 };
  assert.deepEqual(storedPresencePoint(point, 'hall'), point, 'an interior record is never interpreted as a global tile');
  assert.deepEqual(storedPresencePoint(point, MAP_ID), { x: 10, y: 5, z: 1, world_id: 'commons' });
  const tracker = createPresenceTracker({ reducedMotion: () => true });
  tracker.confirm(toMapItem({ id: 'walker', world_id: 'commons', x: 10, y: 5 }));
  const record = tracker.confirm(toMapItem({ id: 'walker', world_id: 'commons', x: 11, y: 5 }));
  assert.equal(record.duration, 0);
  assert.deepEqual(storedPresencePoint(displayCoords(record, record.at), record.world), { x: 11, y: 5, z: 0, world_id: 'commons' });
  assert.equal(storedPresencePoint(null, MAP_ID), null);
});

test('a followed resident remains visible in a crowded neighbor after crossing a seam', async t => {
  const f = await fixture(t), viewer = f.agent('alice'), template = f.agent('bob');
  place(f, viewer, 'district:highlands', 25, 35);
  place(f, template, 'district:highlands', 25, 34);
  const row = f.platform.get('SELECT * FROM agents WHERE id=?', template.id);
  const columns = Object.keys(row);
  const insert = f.platform.db.prepare(`INSERT INTO agents(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
  f.platform.transaction(() => {
    for (let i = 0; i < 205; i++) insert.run(...columns.map(key => key === 'id' ? `map-crowd-${i}` : key === 'last_seen' ? f.clock() : row[key]));
  });
  f.platform.run('UPDATE agents SET last_seen=0 WHERE id=?', viewer.id);
  const result = f.platform.world(f.actor('alice'), { world_id:'commons', agent_id:viewer.id, map:'core', x:15, y:0 });
  assert.ok(result.map.participants.some(actor => actor.id === viewer.id), 'the followed resident is retained before either participant cap');
  assert.ok(result.map.participants.length <= 199);
});
