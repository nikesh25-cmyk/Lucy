import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { RESTORATION_PLAN } from '../src/community.js';

async function serve(t, f) {
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, { token, input, method = input ? 'POST' : 'GET', apiClient } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}), ...(apiClient ? { 'X-API-Client': apiClient } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
}

test('the restoration routes keep the plan public, the opening human-only and every step a saved act', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const req = await serve(t, f);
  const garden = `home:${alice.id}`;

  const board = await req('/restoration');
  assert.equal(board.status, 200);
  assert.equal(board.data.plan.slug, 'gathering-garden');
  assert.equal(board.data.plan.steps.length, RESTORATION_PLAN.steps.length);
  assert.equal(board.data.policy.coins_awarded, 0);
  assert.equal(board.data.policy.grants_land, false);
  assert.equal(board.data.policy.grants_role, false);
  assert.equal(board.data.policy.grants_moderator, false);
  assert.equal(board.data.policy.grants_reviewer, false);
  assert.match(board.data.policy.promise, /never advances a single step/);
  assert.equal(board.data.event, null);
  assert.equal((await req('/restoration?event_id=restoration:home:nobody')).status, 404, 'an unknown restoration answers 404');
  assert.equal((await req('/restoration', { method: 'POST', apiClient: 'operator' })).status, 405, 'the read route accepts GET only');
  assert.equal((await req('/restoration/place', { method: 'GET' })).status, 405, 'the placement route accepts POST only');

  // Opening is a signed-in human decision; a runtime credential cannot open one, and no operator can
  // open a restoration on a garden it does not own.
  assert.equal((await req('/restoration/open', { input: { agent_id: alice.id }, apiClient: 'operator' })).status, 401);
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute'] });
  assert.equal((await req('/restoration/open', { token: runtime.token, input: { agent_id: alice.id } })).status, 403);
  assert.equal((await req('/restoration/open', { token: f.credentials.alice.token, input: { agent_id: bob.id } })).status, 404);
  // The garden has to be open to visitors first: the shipped garden-visiting setting is the gate.
  await req(`/agents/${alice.id}/home`, { token: f.credentials.alice.token, method: 'PATCH', input: { visibility: 'private' } });
  assert.equal((await req('/restoration/open', { token: f.credentials.alice.token, input: { agent_id: alice.id } })).status, 409);
  await req(`/agents/${alice.id}/home`, { token: f.credentials.alice.token, method: 'PATCH', input: { visibility: 'public' } });
  const opened = await req('/restoration/open', { token: f.credentials.alice.token, input: { agent_id: alice.id, hours: 6 } });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.id, `restoration:${garden}`);
  assert.equal(opened.data.phase, 'open');
  assert.equal(opened.data.site.open_to_visitors, true);
  assert.equal(opened.data.policy.coins_awarded, 0);
  assert.equal((await req(`/restoration?event_id=${encodeURIComponent(opened.data.id)}`)).status, 200);
  assert.equal((await req(`/restoration?event_id=${encodeURIComponent(opened.data.id)}`, { token: f.credentials.bob.token })).data.event.site.world_id, garden);

  // The shipped gathering route still describes a gathering: a restoration window that has already
  // started is not an RSVP route, so participation goes through the restoration's own pledge.
  assert.equal((await req('/events/rsvp', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id, action: 'join' } })).status, 409);
  assert.equal((await req('/restoration/join', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id } })).status, 403, 'a resident that has not stood in the garden cannot pledge');
  const travelled = await req(`/agents/${bob.id}/travel`, { token: f.credentials.bob.token, input: { world_id: garden } });
  assert.equal(travelled.status, 200);
  const joined = await req('/restoration/join', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id } });
  assert.equal(joined.status, 200);
  assert.equal(joined.data.viewer.joined, true);
  assert.equal(joined.data.viewer.promise.counted_as_work, false);
  assert.equal(joined.data.progress.steps_completed, 0, 'a pledge advances no step');

  // A caller cannot record work that does not exist, and cannot answer a step its calling does not.
  assert.equal((await req('/restoration/contribute', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id, step_id: 'beds' } })).status, 403);
  assert.equal((await req('/restoration/contribute', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id, step_id: 'nowhere' } })).status, 404);
  await req('/callings/select', { token: f.credentials.bob.token, input: { agent_id: bob.id, calling_id: 'cultivator' } });
  const missing = await req('/restoration/contribute', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id, step_id: 'beds' } });
  assert.equal(missing.status, 409, 'a step with no saved fact is refused instead of credited');
  assert.match(missing.data.error, /not recorded for/);

  // A runtime without the build scope cannot place, whatever the resident’s calling is; the garden’s
  // own builder can, from beside the measured tile.
  const slot = RESTORATION_PLAN.steps.find((step) => step.id === 'ground').slots[1];
  assert.equal((await req('/restoration/place', { token: runtime.token, input: { agent_id: alice.id, event_id: opened.data.id, x: slot.x, y: slot.y } })).status, 403, 'a runtime without the build scope cannot place into a garden');
  assert.equal((await req('/restoration/place', { token: f.credentials.alice.token, input: { agent_id: alice.id, event_id: opened.data.id, x: slot.x, y: slot.y } })).status, 403, 'a resident that has not pledged places nothing');
  await req('/callings/select', { token: f.credentials.alice.token, input: { agent_id: alice.id, calling_id: 'builder' } });
  await req(`/agents/${alice.id}/travel`, { token: f.credentials.alice.token, input: { world_id: garden } });
  assert.equal((await req('/restoration/join', { token: f.credentials.alice.token, input: { agent_id: alice.id, event_id: opened.data.id } })).status, 200);
  f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', slot.x, slot.y - 1, alice.id);
  const placed = await req('/restoration/place', { token: f.credentials.alice.token, input: { agent_id: alice.id, event_id: opened.data.id, x: slot.x, y: slot.y } });
  assert.equal(placed.status, 200);
  assert.equal(placed.data.placed.type, slot.type);
  assert.equal(f.platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', garden, slot.x, slot.y).type, slot.type);
  const duplicate = await req('/restoration/place', { token: f.credentials.alice.token, input: { agent_id: alice.id, event_id: opened.data.id, x: slot.x, y: slot.y } });
  assert.equal(duplicate.status, 409, 'one planned tile is filled once');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden).n, 1);
  // Leaving withdraws the promise only, and the refusal tables keep working.
  const left = await req('/restoration/leave', { token: f.credentials.bob.token, input: { agent_id: bob.id, event_id: opened.data.id } });
  assert.equal(left.status, 200);
  assert.equal(left.data.left, true);
  assert.equal(left.data.participants_count, 1, 'only the leaving resident’s promise was withdrawn');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden).n, 1, 'leaving never removes a saved object');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);

  // The interface reads those payload fields by name and creates nodes instead of injecting markup.
  const source = readFileSync(fileURLToPath(new URL('../app.js', import.meta.url)), 'utf8');
  for (const field of ['renderRestoration', 'loadRestoration', 'restorationEventPanel', 'restorationStepList', 'restorationArtifactList', 'restorationParticipantList', 'restorationControls', 'restorationPromiseNote', 'restorationOpenForm']) {
    assert.match(source, new RegExp(`function ${field}\\(|async function ${field}\\(`), `${field} must exist in the interface`);
  }
  for (const field of ['restoration', 'artifact', 'participants', 'progress', 'policy', 'promise']) assert.match(source, new RegExp(field));
  // The menu entry now lives in the one section catalogue the game shell and the workspace both read.
  assert.match(readFileSync(fileURLToPath(new URL('../src/ui/command-deck.js', import.meta.url)), 'utf8'), /'restoration', 'World restoration'/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /\$\([^)]*\)\.html\s*=/);
});
