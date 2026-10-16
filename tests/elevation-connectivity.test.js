import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const worldId = 'frontier:0:0';
const position = (f, agent, tile) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?', worldId, tile.x, tile.y, agent.id);
const build = (f, owner, agent, tile, changes = {}) => f.tx('frontierBuild', f.actor(owner), agent.id, { world_id: worldId, ...tile, z: 0, type: 'stone', ...changes });
const assign = (f, owner, plotY = 5) => f.tx('landAssign', f.actor(owner), { plot_id: `plot:0:0:5:${plotY}`, purpose: 'An elevation safety fixture' });
const clearPatch = (plotY = 5) => {
  const definition = getWorldDefinition(worldId);
  for (let y = plotY * 6 + 1; y < plotY * 6 + 5; y++) for (let x = 31; x < 35; x++) {
    if ([[0, 0], [-1, 0], [-2, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dy]) => walkable({ x: x + dx, y: y + dy }, definition))) return { x, y };
  }
  throw new Error('Expected a clear construction patch.');
};

test('a resident on an authored roof does not freeze another operator’s construction', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const climber = f.tx('createAgent', f.actor('alice'), { kind: 'human', name: 'A human climber' });
  assign(f, 'alice'); assign(f, 'bob', 6);
  const roof = clearPatch(), work = clearPatch(6);
  position(f, alice, { x: roof.x - 2, y: roof.y });
  position(f, climber, { x: roof.x - 1, y: roof.y });
  position(f, bob, { x: work.x - 1, y: work.y });
  build(f, 'alice', alice, roof);
  const climbed = f.tx('climbAgent', f.actor('alice'), { agent_id: climber.id, direction: 'right' });
  assert.deepEqual({ x: climbed.x, y: climbed.y, z: climbed.z, blocked: climbed.blocked }, { ...roof, z: 1, blocked: false });
  f.advance();
  assert.equal(build(f, 'bob', bob, work).changed, true);
  // A paused resident must still be able to escape when resumed, without freezing builders.
  f.platform.run("UPDATE agents SET status='paused' WHERE id=?", climber.id);
  f.advance();
  assert.equal(build(f, 'bob', bob, work, { z: 1 }).changed, true);
  assert.deepEqual({ ...f.platform.get('SELECT x,y,z,grounded FROM agents WHERE id=?', climber.id) }, { ...roof, z: 1, grounded: 1 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 3);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.verifyAudit(), true);
});

test('removing an occupied support cannot drop a resident below their only climbable exits', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), tile = clearPatch();
  assign(f, 'alice');
  position(f, alice, { x: tile.x - 2, y: tile.y });
  position(f, bob, { x: tile.x - 1, y: tile.y });
  build(f, 'alice', alice, tile);
  const climbed = f.tx('climbAgent', f.actor('bob'), { agent_id: bob.id, direction: 'right' });
  assert.equal(climbed.z, 1);
  const walls = [{ x: tile.x, y: tile.y - 1 }, { x: tile.x, y: tile.y + 1 }, { x: tile.x + 1, y: tile.y }, { x: tile.x - 1, y: tile.y }];
  for (const wall of walls) for (let z = 0; z < 2; z++) {
    f.advance();
    assert.equal(build(f, 'alice', alice, wall, { z }).changed, true, 'The resident can climb from the one-layer roof onto these two-layer walls.');
  }
  f.advance();
  const actions = f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n;
  assert.throws(() => build(f, 'alice', alice, tile, { remove: true }), { status: 409 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks').n, 9);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_actions').n, actions);
  assert.deepEqual({ ...f.platform.get('SELECT z,grounded FROM agents WHERE id=?', bob.id) }, { z: 1, grounded: 1 });
  // Open a one-layer exit before removing the roof; the resident then settles safely.
  assert.equal(build(f, 'alice', alice, walls[3], { z: 1, remove: true }).removed, true);
  f.advance();
  assert.equal(build(f, 'alice', alice, tile, { remove: true }).removed, true);
  assert.deepEqual({ ...f.platform.get('SELECT z,grounded FROM agents WHERE id=?', bob.id) }, { z: 0, grounded: 1 });
  f.advance();
  const escaped = f.tx('climbAgent', f.actor('bob'), { agent_id: bob.id, direction: 'left' });
  assert.deepEqual({ x: escaped.x, y: escaped.y, z: escaped.z, blocked: escaped.blocked }, { ...walls[3], z: 1, blocked: false });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

test('escape checks follow descent from the maximum roof instead of requiring ascent from a road', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), tile = clearPatch();
  assign(f, 'alice');
  position(f, alice, { x: tile.x - 2, y: tile.y });
  for (let z = 0; z < 8; z++) { f.advance(); build(f, 'alice', alice, tile, { z }); }
  // Model a persisted resident who reached this valid roof before this request.
  position(f, bob, tile);
  f.platform.run('UPDATE agents SET z=8 WHERE id=?', bob.id);
  f.advance();
  const neighbor = { x: tile.x + 1, y: tile.y };
  assert.equal(build(f, 'alice', alice, neighbor).changed, true);
  const descended = f.tx('climbAgent', f.actor('bob'), { agent_id: bob.id, direction: 'right' });
  assert.deepEqual({ x: descended.x, y: descended.y, z: descended.z, grounded: descended.grounded, blocked: descended.blocked }, { ...neighbor, z: 1, grounded: true, blocked: false });
});

test('moderators can clear a pre-existing enclosure one layer at a time', async t => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), moderator = f.agent('moderator'), tile = clearPatch();
  assign(f, 'alice');
  position(f, alice, { x: tile.x - 2, y: tile.y });
  position(f, moderator, { x: tile.x - 2, y: tile.y });
  const walls = [{ x: tile.x, y: tile.y - 1 }, { x: tile.x, y: tile.y + 1 }, { x: tile.x + 1, y: tile.y }, { x: tile.x - 1, y: tile.y }];
  for (const wall of walls) for (let z = 0; z < 3; z++) { f.advance(); build(f, 'alice', alice, wall, { z }); }
  // A retained avatar can already be trapped in imported geometry. Cleanup must not
  // require a single removal to restore the entire route before permitting that removal.
  position(f, bob, tile);
  f.advance();
  assert.equal(build(f, 'moderator', moderator, walls[0], { z: 2, remove: true }).removed, true);
  assert.equal(f.tx('climbAgent', f.actor('bob'), { agent_id: bob.id, direction: 'up' }).blocked, true);
  f.advance();
  assert.equal(build(f, 'moderator', moderator, walls[0], { z: 1, remove: true }).removed, true);
  f.advance();
  const escaped = f.tx('climbAgent', f.actor('bob'), { agent_id: bob.id, direction: 'up' });
  assert.deepEqual({ x: escaped.x, y: escaped.y, z: escaped.z, blocked: escaped.blocked }, { ...walls[0], z: 1, blocked: false });
  assert.equal(f.platform.verifyAudit(), true);
});
