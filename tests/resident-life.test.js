import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { worldAtmosphere } from '../src/atmosphere.js';

test('expressions expire on server time, reject impersonation, and cannot bypass a paused world', async (t) => {
  const f = await fixture(t), avatar = f.agent('alice'), other = f.agent('bob');
  const first = f.tx('emote', f.actor('alice'), { agent_id: avatar.id, emote: 'wave', emote_until: Infinity });
  assert.equal(first.emote_until, f.clock() + 10000);
  assert.throws(() => f.tx('emote', f.actor('bob'), { agent_id: avatar.id, emote: 'heart' }), { status: 404 });
  assert.throws(() => f.tx('emote', f.actor('alice'), { agent_id: avatar.id, emote: 'cheer' }), { status: 429 });
  f.advance(5000);
  const credential = f.tx('runtime', f.actor('alice'), avatar.id, { scopes: ['read', 'move'] });
  const runtime = f.platform.authenticate(credential.token, 'move');
  assert.throws(() => f.tx('emote', runtime, { agent_id: other.id, emote: 'bow' }), { status: 404 });
  const next = f.tx('emote', runtime, { emote: 'bow' });
  f.advance(10001);
  assert.ok(f.platform.world(runtime).participants.find((a) => a.id === avatar.id).emote_until < f.clock());
  assert.equal(next.emote_until, f.clock() - 1);
  f.tx('pause', f.actor('admin'), true);
  assert.throws(() => f.tx('emote', runtime, { emote: 'none' }), { status: 503 });
});

test('every fictional sky phase has a bounded next transition and shares an exact cycle', () => {
  const cycle = 120 * 60_000;
  for (let i = 0; i < 4; i++) {
    const time = i * cycle / 4;
    const current = worldAtmosphere(time);
    assert.equal(current.phase, ['dawn', 'day', 'dusk', 'night'][i]);
    assert.equal(current.next_phase_at, time + cycle / 4);
    assert.equal(worldAtmosphere(time + cycle).phase, current.phase);
    assert.equal(worldAtmosphere(current.next_phase_at - 1).phase, current.phase);
    assert.notEqual(worldAtmosphere(current.next_phase_at).phase, current.phase);
  }
});
