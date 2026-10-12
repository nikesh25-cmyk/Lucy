import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Platform } from '../src/platform.js';
import { FRONTIER_LIMITS, FRONTIER_PALETTE } from '../src/frontier.js';
import { frontierCoordinates, frontierGates, getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const seed = 'frontier:0:0';
const position = (f, agent, x, y, world = seed) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', world, x, y, agent.id);
const closeTo = (f, agent, tile, world = seed) => position(f, agent, tile.x - 1, tile.y, world);
const openTile = (world = seed) => {
  const definition = getWorldDefinition(world);
  for (let y = 31; y <= 34; y++) for (let x = 31; x <= 34; x++) {
    if ([[0, 0], [1, 0], [-1, 0], [-2, 0], [0, 1], [0, -1]].every(([dx, dy]) => walkable({ x: x + dx, y: y + dy }, definition))) return { x, y };
  }
  throw new Error('Expected an open test patch.');
};
const currentWorld = (f, agent) => f.platform.get('SELECT world_id FROM agents WHERE id=?', agent.id).world_id;
const build = (f, owner, agent, tile, changes = {}) => f.tx('frontierBuild', f.actor(owner), agent.id, { world_id: currentWorld(f, agent), ...tile, z: 0, type: 'stone', ...changes });
const expand = (f, actor, agent, input) => f.tx('frontierExpand', actor, agent.id, { world_id: currentWorld(f, agent), ...input });
const steward = (f, owner = 'alice', world = seed) => f.tx('landAssign', f.actor(owner), { plot_id: world.replace('frontier:', 'plot:') + ':5:5', purpose: 'A shared learning garden', description: 'An isolated workflow fixture.' });

test('frontier terrain is deterministic and bounded with connected protected gates and a Commons entrance', async t => {
  const f = await fixture(t);
  assert.deepEqual(frontierCoordinates('frontier:-8:7'), { x: -8, y: 7 });
  for (const id of ['frontier:065:0', 'frontier:65:0', 'frontier:-0:0', 'frontier:0.5:0', 'frontier:1:2:3']) assert.equal(frontierCoordinates(id), null);
  const initial = getWorldDefinition(seed), copy = JSON.stringify(initial.terrain);
  // Exercise dynamic definition cache eviction without creating or storing sectors.
  for (let x = -20; x < 20; x++) getWorldDefinition(`frontier:${x}:1`);
  assert.equal(JSON.stringify(getWorldDefinition(seed).terrain), copy);
  assert.equal(initial.columns, 48); assert.equal(initial.rows, 48);
  for (const gate of frontierGates(seed)) {
    assert.equal(walkable(gate, seed), true);
    assert.equal(walkable({ x: gate.x, y: 24 }, seed), true);
    assert.equal(walkable({ x: 24, y: gate.y }, seed), true);
  }
  const portal = getWorldDefinition('commons').portals.find(p => p.targetWorldId === seed);
  assert.deepEqual({ x: portal.x, y: portal.y }, { x: 19, y: 6 });
  assert.equal(walkable(portal, 'commons'), true);
  assert.equal(f.platform.frontierMap(null).total, 1);
  assert.equal(f.platform.world(null, { world_id: seed }).portals.length, 1, 'Uncreated neighbors are not usable portals.');
  assert.throws(() => f.platform.world(null, { world_id: 'frontier:1:0' }), { status: 404 });
  assert.equal(f.platform.worldList(null).shared_count, 30, 'Frontier pages do not inflate the fixed shared directory.');
});

test('humans and scoped agents expand only adjacent passages with idempotency, quotas and continuous crossing', async t => {
  const f = await fixture(t), human = f.tx('createAgent', f.actor('alice'), { kind: 'human', name: 'Alice builder' }), agent = f.agent('alice');
  assert.throws(() => expand(f, null, human, { direction: 'right' }), { status: 401 });
  assert.throws(() => expand(f, f.actor('alice'), human, { direction: 'right' }), { status: 409 });
  position(f, human, 24, 24);
  assert.throws(() => expand(f, f.actor('alice'), human, { direction: 'right' }), { status: 409 });
  assert.throws(() => expand(f, f.actor('alice'), human, { direction: 'diagonal' }), { status: 400 });
  position(f, human, 46, 24);
  const first = expand(f, f.actor('alice'), human, { direction: 'right', target_world_id: 'frontier:44:44' });
  assert.equal(first.target_world_id, 'frontier:1:0'); assert.equal(first.created, true);
  assert.equal(expand(f, f.actor('alice'), human, { direction: 'right' }).created, false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n, 1);
  const crossed = f.tx('moveAgent', f.actor('alice'), { agent_id: human.id, direction: 'right' });
  assert.deepEqual({ x: crossed.x, y: crossed.y, world_id: crossed.world_id }, { x: 1, y: 24, world_id: 'frontier:1:0' });
  f.advance();
  const returned = f.tx('moveAgent', f.actor('alice'), { agent_id: human.id, direction: 'left' });
  assert.deepEqual({ x: returned.x, y: returned.y, world_id: returned.world_id }, { x: 46, y: 24, world_id: seed });
  const readOnly = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'move'], max_calls: 10 });
  position(f, agent, 24, 1);
  assert.throws(() => expand(f, f.platform.authenticate(readOnly.token), agent, { direction: 'up' }), { status: 403 });
  const worker = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['build', 'move'], max_calls: 20 });
  f.advance();
  assert.equal(expand(f, f.platform.authenticate(worker.token, 'build'), agent, { direction: 'up' }).created, true);
  // Shared account quota includes both human and agent residents.
  for (let x = 1; x < 7; x++) { f.advance(); position(f, human, 46, 24, `frontier:${x}:0`); expand(f, f.actor('alice'), human, { direction: 'right' }); }
  f.advance(); position(f, human, 24, 46, seed);
  assert.throws(() => expand(f, f.actor('alice'), human, { direction: 'down' }), { status: 429 });
  assert.equal(f.platform.frontierMap(null, { limit: 2 }).has_more, true);
  assert.equal(f.platform.frontierMap(null, { offset: 2, limit: 2 }).sectors.length, 2);
  assert.throws(() => f.platform.frontierMap(null, { limit: 51 }), { status: 400 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('frontier blocks enforce foundations, ownership, range, occupancy, protected roads and movement collisions', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), tile = openTile();
  steward(f);
  closeTo(f, alice, tile); closeTo(f, bob, tile);
  for (const changes of [{ x: -1 }, { x: 48 }, { z: 8 }, { z: -1 }, { type: 'script' }, { z: 1 }, { type: 'path', z: 1 }]) assert.throws(() => build(f, 'alice', alice, tile, changes), error => [400, 409].includes(error.status));
  assert.throws(() => build(f, 'bob', alice, tile), { status: 404 });
  assert.throws(() => build(f, 'alice', alice, { x: 24, y: tile.y }), { status: 409 });
  assert.throws(() => build(f, 'alice', alice, { x: 2, y: 2 }), { status: 409 });
  const occupied = f.platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
  assert.throws(() => build(f, 'alice', alice, occupied), { status: 409 });
  const foundation = build(f, 'alice', alice, tile);
  assert.equal(foundation.changed, true);
  assert.equal(build(f, 'alice', alice, tile).changed, false);
  assert.throws(() => build(f, 'bob', bob, tile), { status: 403 });
  assert.throws(() => build(f, 'bob', bob, tile, { z: 1 }), { status: 403 });
  assert.throws(() => build(f, 'bob', bob, tile, { remove: true }), { status: 403 });
  assert.throws(() => build(f, 'alice', alice, { ...tile, x: tile.x + 1 }), { status: 429 });
  const blockedMove = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.equal(blockedMove.x, tile.x - 1);
  f.advance(); assert.equal(build(f, 'alice', alice, tile, { z: 1, type: 'glass' }).changed, true);
  f.advance(); assert.throws(() => build(f, 'alice', alice, tile, { remove: true }), { status: 409 });
  assert.equal(build(f, 'alice', alice, tile, { z: 1, remove: true }).removed, true);
  f.advance(); assert.equal(build(f, 'alice', alice, tile, { remove: true }).removed, true);
  f.advance(); assert.equal(build(f, 'alice', alice, tile, { type: 'path' }).changed, true);
  f.advance(); assert.equal(f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' }).x, tile.x);
  f.platform.run("UPDATE agents SET status='paused' WHERE id=?", alice.id);
  assert.throws(() => build(f, 'alice', alice, tile, { remove: true }), { status: 403 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(FRONTIER_PALETTE.includes('glass'), true);
});

test('two-layer construction cannot trap another resident and human moderators can open a climbable exit', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), moderator = f.agent('moderator'), tile = openTile();
  steward(f);
  position(f, alice, tile.x - 2, tile.y); position(f, bob, tile.x, tile.y); position(f, moderator, tile.x - 2, tile.y);
  for (const neighbor of [{ x: tile.x, y: tile.y - 1 }, { x: tile.x, y: tile.y + 1 }, { x: tile.x + 1, y: tile.y }]) for (let z = 0; z < 2; z++) { f.advance(); build(f, 'alice', alice, neighbor, { z }); }
  f.advance(); assert.equal(build(f, 'alice', alice, { x: tile.x - 1, y: tile.y }).changed, true, 'One layer remains a climbable exit.');
  f.advance(); assert.throws(() => build(f, 'alice', alice, { x: tile.x - 1, y: tile.y }, { z: 1 }), { status: 409 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 7);
  assert.equal(build(f, 'moderator', moderator, { x: tile.x, y: tile.y - 1 }, { z: 1, remove: true }).removed, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 6);
  assert.equal(f.platform.verifyAudit(), true);
});

test('climbing admits one authored layer, refuses two, and settling follows the block column', async t => {
  const f = await fixture(t), alice = f.agent('alice'), tile = openTile();
  steward(f);
  closeTo(f, alice, tile);
  f.advance(); assert.equal(build(f, 'alice', alice, tile).changed, true);
  const climbed = f.tx('climbAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.deepEqual({ x: climbed.x, y: climbed.y, z: climbed.z, grounded: climbed.grounded, blocked: climbed.blocked },
    { x: tile.x, y: tile.y, z: 1, grounded: true, blocked: false });
  assert.deepEqual({ ...f.platform.get('SELECT z,grounded FROM agents WHERE id=?', alice.id) }, { z: 1, grounded: 1 });
  // Removing the support under a standing resident settles the stored column cache.
  f.advance(); assert.equal(build(f, 'alice', alice, tile, { remove: true }).removed, true);
  assert.deepEqual({ ...f.platform.get('SELECT z,grounded FROM agents WHERE id=?', alice.id) }, { z: 0, grounded: 1 });
  // Two authored layers are too high for one step, and ordinary movement stays a wall.
  const stackTile = { x: tile.x - 1, y: tile.y };
  f.advance(); assert.equal(build(f, 'alice', alice, stackTile).changed, true);
  f.advance(); assert.equal(build(f, 'alice', alice, stackTile, { z: 1, type: 'glass' }).changed, true);
  const refused = f.tx('climbAgent', f.actor('alice'), { agent_id: alice.id, direction: 'left' });
  assert.deepEqual({ x: refused.x, y: refused.y, z: refused.z, grounded: refused.grounded, blocked: refused.blocked },
    { x: tile.x, y: tile.y, z: 0, grounded: true, blocked: true });
  f.advance(); assert.equal(build(f, 'alice', alice, stackTile, { z: 1, remove: true }).removed, true);
  f.advance(); const walked = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'left' });
  assert.deepEqual({ x: walked.x, y: walked.y, z: walked.z, blocked: walked.blocked }, { x: tile.x, y: tile.y, z: 0, blocked: true });
  f.advance(); const stepped = f.tx('climbAgent', f.actor('alice'), { agent_id: alice.id, direction: 'left' });
  assert.deepEqual({ x: stepped.x, y: stepped.y, z: stepped.z, blocked: stepped.blocked }, { x: stackTile.x, y: stackTile.y, z: 1, blocked: false });
  const participant = f.platform.world(f.actor('alice'), { world_id: seed, agent_id: alice.id }).participants.find((item) => item.id === alice.id);
  assert.deepEqual({ z: participant.z, grounded: participant.grounded }, { z: 1, grounded: 1 });
});

test('looking wraps yaw, clamps pitch and keeps its own throttle', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  const looked = f.tx('lookAgent', f.actor('alice'), { agent_id: alice.id, yaw: 9, pitch: 5 });
  assert.ok(Math.abs(looked.yaw - (9 - Math.PI * 2)) < 1e-9);
  assert.equal(looked.pitch, 1.4);
  assert.deepEqual({ ...f.platform.get('SELECT yaw,pitch FROM agents WHERE id=?', alice.id) }, { yaw: looked.yaw, pitch: 1.4 });
  assert.throws(() => f.tx('lookAgent', f.actor('alice'), { agent_id: alice.id, yaw: NaN, pitch: 0 }), { status: 400 });
  assert.throws(() => f.tx('lookAgent', f.actor('alice'), { agent_id: alice.id, yaw: 0, pitch: Infinity }), { status: 400 });
  // A look uses last_look only: it can be taken inside the movement throttle, but it never
  // lets a move bypass that throttle, and two looks in a row are throttled too.
  f.advance(2000); f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' });
  f.advance(50);
  assert.deepEqual(f.tx('lookAgent', f.actor('alice'), { agent_id: alice.id, yaw: 0, pitch: -2 }), { yaw: 0, pitch: -1.4 });
  assert.throws(() => f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'up' }), { status: 429 });
  assert.throws(() => f.tx('lookAgent', f.actor('alice'), { agent_id: alice.id, yaw: 0.5, pitch: 0 }), { status: 429 });
});

test('frontier mutations require the observed area and reject stale requests after a resident crosses', async t => {
  const f = await fixture(t), alice = f.agent('alice');
  position(f, alice, 46, 24);
  expand(f, f.actor('alice'), alice, { direction: 'right' });
  f.advance();
  const crossing = f.tx('moveAgent', f.actor('alice'), { agent_id: alice.id, direction: 'right' });
  assert.equal(crossing.world_id, 'frontier:1:0');
  steward(f, 'alice', 'frontier:1:0');
  const tile = openTile('frontier:1:0'); closeTo(f, alice, tile, 'frontier:1:0');
  const actionCount = f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n;
  for (const world_id of [undefined, null, '', 'commons', 'frontier:065:0']) {
    assert.throws(() => f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id, ...tile, type: 'wood' }), { status: 400 });
    assert.throws(() => f.tx('frontierExpand', f.actor('alice'), alice.id, { world_id, direction: 'right' }), { status: 400 });
  }
  assert.throws(() => build(f, 'alice', alice, tile, { world_id: seed }), { status: 409 });
  assert.throws(() => build(f, 'alice', alice, tile, { world_id: seed, remove: true }), { status: 409 });
  position(f, alice, 46, 24, 'frontier:1:0');
  assert.throws(() => expand(f, f.actor('alice'), alice, { world_id: seed, direction: 'right' }), { status: 409 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_sectors').n, 2);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n, actionCount);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  closeTo(f, alice, tile, 'frontier:1:0');
  assert.equal(build(f, 'alice', alice, tile, { type: 'wood' }).changed, true);
  assert.equal(f.platform.frontierMap(null).sectors.find(sector => sector.world_id === 'frontier:1:0').block_count, 1);
  assert.equal(f.platform.frontierMap(null).sectors.find(sector => sector.world_id === seed).block_count, 0);
});

test('sector blocks, bounded public views and private building exports persist across restart without rewards', async t => {
  const f = await fixture(t), alice = f.agent('alice'), tile = openTile(); steward(f); closeTo(f, alice, tile);
  build(f, 'alice', alice, tile, { type: 'wood' }); f.advance(); build(f, 'alice', alice, tile, { type: 'brick', z: 1 });
  const view = f.platform.world(null, { world_id: seed, x: tile.x - 2, y: tile.y - 2 });
  assert.equal(view.blocks.length, 2); assert.equal(view.blocks[1].z, 1);
  assert.equal(view.frontier.block_count, 2); assert.equal(view.frontier.neighbors.length, 4);
  assert.equal(f.platform.frontierMap(null).sectors.find(sector => sector.world_id === seed).block_count, 2);
  assert.equal(view.blocks.some(b => Object.hasOwn(b, 'creator_account_id')), false);
  assert.equal(view.terrain.length, 14); assert.equal(view.terrain[0].length, 20);
  assert.equal(f.platform.world(null, { world_id: seed, x: 0, y: 0 }).blocks.length, 0);
  const wider = f.platform.world(null, { world_id: seed, x: 0, y: 0, view: 'voxel' });
  assert.equal(wider.blocks.length, 2, 'Three dimensional terrain and authored blocks share a wider window.');
  assert.deepEqual(wider.block_window, { x: 0, y: 0, columns: 37, rows: 37 });
  assert.equal(f.platform.exportAccount(f.actor('alice')).frontier.blocks.length, 2);
  assert.equal(f.platform.frontierExport(f.actor('bob')).blocks.length, 0);
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'build'] });
  assert.throws(() => f.platform.frontierExport(f.platform.authenticate(runtime.token)), { status: 403 });
  f.platform.close(); const restarted = new Platform(f.database, f.clock); t.after(() => restarted.close());
  const restored = restarted.world(restarted.authenticate(f.credentials.alice.token), { agent_id: alice.id });
  assert.equal(restored.world.id, seed); assert.equal(restored.blocks.length, 2); assert.equal(restored.frontier.block_count, 2);
  assert.equal(restarted.frontierMap(null).total, 1);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(restarted.verifyAudit(), true);
});

test('building daily budgets, global sector capacity, pause and coordinate edges fail without partial writes', async t => {
  const f = await fixture(t), alice = f.agent('alice'), tile = openTile(); steward(f); closeTo(f, alice, tile);
  const oldTimestamp = new Date(f.clock() - 1000).toISOString();
  // Synthetic storage fixtures exercise the hard limits without hundreds of UI calls.
  f.platform.transaction(() => { for (let n = 0; n < FRONTIER_LIMITS.actions_per_operator_day; n++) f.platform.run('INSERT INTO frontier_actions VALUES(?,?,?,?,?,?)', randomUUID(), f.actor('alice').account.id, alice.id, seed, 'place', oldTimestamp); });
  assert.throws(() => build(f, 'alice', alice, tile), { status: 429 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 0);
  f.advance(86400000); assert.equal(build(f, 'alice', alice, tile).changed, true);
  f.advance(); position(f, alice, 24, 1);
  f.platform.run("UPDATE settings SET value='true' WHERE key='paused'");
  assert.throws(() => expand(f, f.actor('alice'), alice, { direction: 'up' }), { status: 503 });
  f.platform.run("UPDATE settings SET value='false' WHERE key='paused'");
  f.platform.transaction(() => {
    let created = 1;
    for (let y = -8; y <= 7 && created < FRONTIER_LIMITS.sectors; y++) for (let x = -8; x <= 7 && created < FRONTIER_LIMITS.sectors; x++) {
      if (x === 0 && y === 0) continue;
      const id = `frontier:${x}:${y}`, definition = getWorldDefinition(id);
      f.platform.run('INSERT INTO worlds VALUES(?,?,?,NULL,?,?,?,?)', id, definition.name, 'frontier', 'public', 48, 48, oldTimestamp);
      f.platform.run('INSERT INTO frontier_sectors VALUES(?,?,?,NULL,NULL,?)', id, x, y, oldTimestamp); created++;
    }
  });
  assert.equal(expand(f, f.actor('alice'), alice, { direction: 'up' }).created, false);
  assert.equal(f.platform.frontierMap(null).total, 256);
  assert.ok(frontierGates('frontier:-8:-8').every(g => !['up', 'left'].includes(g.direction)));
  position(f, alice, 24, 1, 'frontier:-8:-8');
  assert.throws(() => expand(f, f.actor('alice'), alice, { direction: 'up' }), { status: 400 });
  assert.equal(f.platform.worldList(null).shared_count, 30);
});
