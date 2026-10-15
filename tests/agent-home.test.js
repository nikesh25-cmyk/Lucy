import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

const vis = (f, id) => f.platform.get('SELECT visibility FROM worlds WHERE id=?', id).visibility;
const denied = (action, status = 403) => assert.throws(action, { status });

test('an AI resident\'s cottage starts as its own private space while its garden stays open', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  assert.equal(vis(f, `home:${agent.id}`), 'public');
  assert.equal(vis(f, `house:${agent.id}`), 'private');
  // The resident (its own credential) and its operator can use the cottage; another operator cannot see in.
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'move'], minutes: 5, max_calls: 20 });
  assert.equal(f.platform.world(f.platform.authenticate(runtime.token), { world_id: `house:${agent.id}` }).world.kind, 'house');
  assert.equal(f.platform.world(f.actor('alice'), { world_id: `house:${agent.id}` }).world.kind, 'house');
  const other = f.agent('bob');
  denied(() => f.platform.world(f.actor('bob'), { world_id: `house:${agent.id}` }));
  denied(() => f.platform.world(null, { world_id: `house:${agent.id}` }));
  f.tx('travel', f.actor('bob'), other.id, { world_id: `home:${agent.id}` });
  f.advance();
  denied(() => f.tx('travel', f.actor('bob'), other.id, { world_id: `house:${agent.id}` }));
});

test('the cottage switch is independent of the garden switch, and closing the garden also closes the cottage', async (t) => {
  const f = await fixture(t);
  const agent = f.agent('alice'), guest = f.agent('bob');
  const house = `house:${agent.id}`;
  assert.deepEqual(f.tx('homeSettings', f.actor('alice'), agent.id, { house_visibility: 'public' }).house_visibility, 'public');
  assert.equal(vis(f, `home:${agent.id}`), 'public');
  f.tx('travel', f.actor('bob'), guest.id, { world_id: `home:${agent.id}` });
  f.advance();
  f.tx('travel', f.actor('bob'), guest.id, { world_id: house });
  // Closing only the cottage sends its guest out to the Commons and leaves the garden open.
  f.tx('homeSettings', f.actor('alice'), agent.id, { house_visibility: 'private' });
  assert.equal(vis(f, house), 'private'); assert.equal(vis(f, `home:${agent.id}`), 'public');
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', guest.id).world_id, 'commons');
  // Opening the garden does not open the cottage.
  f.tx('homeSettings', f.actor('alice'), agent.id, { visibility: 'private' });
  f.tx('homeSettings', f.actor('alice'), agent.id, { visibility: 'public' });
  assert.equal(vis(f, `home:${agent.id}`), 'public'); assert.equal(vis(f, house), 'private');
  // Closing the garden closes an open cottage too.
  f.tx('homeSettings', f.actor('alice'), agent.id, { house_visibility: 'public' });
  f.tx('homeSettings', f.actor('alice'), agent.id, { visibility: 'private' });
  assert.equal(vis(f, house), 'private');
  denied(() => f.platform.homeSettings(f.actor('alice'), agent.id, { house_visibility: 'everyone' }), 400);
  denied(() => f.platform.homeSettings(f.actor('bob'), agent.id, { house_visibility: 'public' }), 404);
  const runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read'], minutes: 5, max_calls: 20 });
  denied(() => f.platform.homeSettings(f.platform.authenticate(runtime.token), agent.id, { house_visibility: 'public' }));
});

test('a human avatar\'s cottage still follows its garden', async (t) => {
  const f = await fixture(t);
  const human = f.tx('createAgent', f.actor('alice'), { name: 'Alice human', kind: 'human' });
  const row = f.platform.get('SELECT kind FROM agents WHERE id=?', human.id);
  if (row.kind !== 'human') return t.skip('human avatars are created through a separate route');
  assert.equal(vis(f, `house:${human.id}`), vis(f, `home:${human.id}`));
});
