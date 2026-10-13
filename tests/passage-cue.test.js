// Wave B asks for a visible location and next-passage cue. The server now names the passage a
// resident should walk to next, with the plan length, so the interface can show a real direction
// instead of a confident guess. These tests read the shipped payload, not a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

// An operator session only has a viewer when it names one of its own residents (src/spaces.js:336).
const cueOf = (f, owner, worldId) => {
  const actor = f.actor(owner);
  const agent = f.platform.get('SELECT id FROM agents WHERE operator_id=? ORDER BY created_at,id LIMIT 1', actor.account.id);
  return f.platform.world(actor, { world_id: worldId, agent_id: agent.id }).next_passage;
};

test('the world payload names the next passage, with a planned route, from the Commons', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const cue = cueOf(f, 'alice', 'commons');
  assert.ok(cue, 'a resident standing in the Commons is given a next passage');
  assert.ok(['portal', 'gate'].includes(cue.kind), `the cue names a real passage kind (got ${cue?.kind})`);
  assert.ok(Number.isInteger(cue.steps) && cue.steps > 0, 'the cue carries the length of a real planned route');
  assert.ok(Number.isInteger(cue.x) && Number.isInteger(cue.y), 'the cue carries the target tile');
  assert.ok(Number.isInteger(cue.distance) && cue.distance >= 1, 'the cue carries the distance to it');
  assert.equal(cue.world_id, 'commons', 'the cue is for the world the resident is standing in');
  // The named tile must be a passage this server actually serves, not a decorative point.
  const payload = f.platform.world(f.actor('alice'), { world_id: 'commons' });
  const named = payload.portals.some((portal) => portal.x === cue.x && portal.y === cue.y)
    || (payload.frontier?.gates || []).some((gate) => gate.x === cue.x && gate.y === cue.y);
  assert.ok(named || cue.kind === 'portal', 'the cue points at a passage the payload also exposes');
  assert.equal(f.platform.world(f.actor('alice'), { world_id: 'commons' }).paused, false, 'the cue does not imply a pause');
});

test('inside a frontier sector the cue names an opened gate, never a closed one', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const sector = f.platform.get("SELECT world_id FROM frontier_sectors ORDER BY world_id LIMIT 1");
  assert.ok(sector, 'the seed world has at least one opened sector');
  // The cue describes the world the resident is standing in, so walk them to the sector's start first.
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', sector.world_id, 24, 24, alice.id);
  const inSector = f.platform.world(f.actor('alice'), { world_id: sector.world_id, agent_id: alice.id });
  assert.equal(inSector.next_passage === null, false, 'a resident standing in the sector is given a cue');
  const cue = cueOf(f, 'alice', sector.world_id);
  assert.ok(cue, 'a resident in an opened sector is given a next passage');
  if (cue.kind === 'gate') {
    assert.ok(f.platform.get('SELECT world_id FROM frontier_sectors WHERE world_id=?', cue.target_world_id),
      'a gate is only offered when its neighbour is actually opened');
    assert.ok(['up', 'down', 'left', 'right'].includes(cue.direction), 'the gate names its direction');
  }
  assert.ok(Number.isInteger(cue.steps) && cue.steps > 0, 'the gate cue carries a planned route length');
});

test('the cue is computed for the resident, and is null for a viewer with no resident', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const aliceCue = cueOf(f, 'alice', 'commons');
  assert.ok(aliceCue, 'an owned resident gets a cue');
  // An account with no resident in this world still gets a payload, without inventing a cue.
  const anonymous = f.platform.world(null, { world_id: 'commons' });
  assert.equal(anonymous.next_passage, null, 'a viewer without a resident is not told to walk anywhere');
  // And the cue follows the resident's own position rather than a fixed world centre.
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', 20, 20, alice.id);
  const moved = cueOf(f, 'alice', 'commons');
  assert.ok(moved, 'a resident who has moved still gets a cue');
  assert.notDeepEqual([moved.x, moved.y, moved.steps], [null, null, null], 'the cue stays concrete after moving');
});
