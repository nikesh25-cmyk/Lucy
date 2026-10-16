// The contextual interaction prompt against the shipped HTTP API.
//
// Every check below drives the real routes through an injected transport and then reads the server's
// own records, so what the prompt offers is proven at the level the server decides: the same
// `GET /interact` view, the same authoritative action (travel, garden, posture, craft, talk, a nearby
// message), and a refusal that always carries the next usable step. Nothing here stubs the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createInteractionPrompt } from '../src/ui/interaction-prompt.js';
import content from '../src/content.js';
import { fixture } from './helpers.js';

async function setup(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', account, token, input, key } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: {
        ...(input ? { 'Content-Type': 'application/json' } : {}),
        ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  // The transport the integration owner would build from the shipped `api()` helper: the component
  // names no route and holds no credential; this is the only place that knows them.
  const transport = (account) => {
    const token = f.credentials[account].token;
    const fail = (status, data) => Object.assign(new Error(data.error || 'The interaction was refused.'), { status, body: data });
    return {
      async interactRead(query) {
        const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null && value !== undefined).map(([name, value]) => [name, String(value)]));
        const { status, data } = await request(`/interact?${search}`, { token });
        if (status !== 200) throw fail(status, data);
        return data;
      },
      async interactWrite(payload, key) {
        const { status, data } = await request('/interact', { method: 'POST', token, input: payload, key });
        if (status >= 400) throw fail(status, data);
        return data;
      },
      async sendMessage(payload) {
        const { status, data } = await request('/messages', { method: 'POST', token, input: payload });
        if (status >= 400) throw fail(status, data);
        return data;
      },
    };
  };
  const place = (agentId, x, y, worldId = null) => worldId
    ? f.platform.run('UPDATE agents SET x=?,y=?,world_id=? WHERE id=?', x, y, worldId, agentId)
    : f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', x, y, agentId);
  return { ...f, request, transport, place };
}

const auditCount = (f, event) => f.platform.get('SELECT COUNT(*) AS n FROM audit WHERE event=?', event).n;

test('discovery by approach surfaces the nearest fixture, and the keyboard uses it', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 10, y: 6 } });

  // With no tile named, the server ranks the fixtures near the resident; the prompt names the nearest.
  const model = await prompt.approach();
  assert.equal(model.visible, true);
  assert.equal(model.kind, 'door');
  assert.equal(model.role, 'status');
  assert.equal(model.tabIndex, 0);
  assert.match(model.text, /Door at 11, 6/);
  assert.match(model.text, /Manhattan distance 1/);
  assert.match(model.text, /1 tile away, so you can use it now/);
  assert.equal(model.in_range, true);
  assert.equal(model.placement.pointerEvents, 'none');

  // The keyboard equivalent uses the focused fixture: Enter, Space or I.
  const intent = prompt.handleKey('Enter');
  assert.equal(intent.kind, 'activate');
  const confirmed = await intent.pending;
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.interaction.kind, 'door');
  assert.equal(confirmed.interaction.route, 'POST /api/v1/agents/:id/travel');
  assert.equal(confirmed.result.world_id, 'hall');
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'hall');
});

test('a read that names a tile with no fixture is an honest empty state, not a fabricated one', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 10, y: 6 } });
  const model = await prompt.refresh({ x: 10, y: 6 });
  assert.equal(model.visible, false);
  assert.equal(model.kind, 'none');
  assert.match(model.text, /No door, crop patch, bench, crafting station or country ambassador desk stands at 10, 6/);
  assert.equal(await prompt.activate(), null, 'there is nothing to act on');
});

test('an out-of-range fixture is refused with the approach step and never reads as an accomplishment', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 10, y: 6 } });

  const read = await prompt.refresh({ x: 35, y: 24 });
  assert.equal(read.kind, 'door');
  assert.equal(read.in_range, false);
  assert.equal(read.blocked_by, 'out_of_range');
  assert.match(read.next_step, /Step onto or beside 35, 24/);

  const refused = await prompt.activate();
  assert.equal(refused.ok, false);
  assert.equal(refused.accomplished, false);
  assert.equal(refused.status, 409);
  assert.match(refused.next_step, /within 1 tile of it/);
  assert.equal(prompt.confirmed, null, 'a refusal is never an accomplished action');
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');
  assert.equal(prompt.prompt().role, 'alert', 'the prompt becomes a live alert while a refusal stands');
});

test('a crop patch opens a compact activity overlay and plants through the world’s own action', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const garden = `home:${alice.id}`;
  assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: garden }).world_id, garden);
  f.tx('build', f.actor('alice'), alice.id, { type: 'farm', x: 8, y: 7 });
  f.place(alice.id, 8, 8);

  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: garden, agent: alice.id, position: { x: 8, y: 8 } });
  const read = await prompt.refresh({ x: 8, y: 7 });
  assert.equal(read.kind, 'crop_patch');
  assert.equal(read.action.id, 'garden');

  // Enter opens the overlay rather than acting blindly: the crop actions are the server's.
  const overlay = await prompt.activate();
  assert.equal(overlay.open, true);
  assert.equal(overlay.kind, 'activity');
  assert.equal(overlay.modal, false);
  assert.equal(overlay.suspendsShortcuts, true);
  assert.deepEqual(overlay.dismissKeys, ['Escape']);
  const choice = overlay.controls.find((control) => control.type === 'choice');
  // The plant options are the sealed crops, in their authored order: the overlay invents nothing.
  assert.deepEqual(choice.options.map((option) => option.value), Object.keys(content.crops()).map((kind) => `plant:${kind}`));

  const planted = await prompt.submitOverlay({ choice: 'plant:herbs' });
  assert.equal(planted.ok, true);
  assert.equal(planted.result.crop.kind, 'herbs');
  assert.equal(f.platform.get('SELECT kind FROM journey_crops WHERE agent_id=? AND x=8 AND y=7', alice.id).kind, 'herbs');
  assert.equal(prompt.overlay(), null, 'a submitted overlay closes');

  // A second planting on the same tile is refused by the world, with its own next step, and no row
  // is added — the refusal is never rendered as a crop.
  await prompt.activate();
  const again = await prompt.submitOverlay({ choice: 'plant:wood' });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.match(again.next_step, /Tend or harvest the crop already planted/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', alice.id).n, 1);
});

test('a crop patch in another resident’s garden names the owner before it is tried and is refused after', async (t) => {
  const f = await setup(t), alice = f.agent('alice'), bob = f.agent('bob');
  const garden = `home:${alice.id}`;
  assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: garden }).world_id, garden);
  f.tx('build', f.actor('alice'), alice.id, { type: 'farm', x: 8, y: 7 });
  assert.equal(f.tx('travel', f.actor('bob'), bob.id, { world_id: garden }).world_id, garden);
  f.place(bob.id, 8, 8);

  const prompt = createInteractionPrompt({ transport: f.transport('bob'), world: garden, agent: bob.id, position: { x: 8, y: 8 } });
  const read = await prompt.refresh({ x: 8, y: 7 });
  assert.match(read.text, /alice avatar’s garden/, 'the prompt names the owner before the click');
  await prompt.activate();
  const refused = await prompt.submitOverlay({ choice: 'plant:herbs' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.match(refused.next_step, /alice avatar’s garden/);
  assert.equal(refused.accomplished, false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', bob.id).n, 0);
});

test('a bench sits the resident directly, with no overlay and the world’s own posture action', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  assert.equal(f.tx('travel', f.actor('alice'), alice.id, { world_id: 'hall' }).world_id, 'hall');
  f.place(alice.id, 12, 8);
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'hall', agent: alice.id, position: { x: 12, y: 8 } });

  const read = await prompt.refresh({ x: 12, y: 7 });
  assert.equal(read.kind, 'bench');
  assert.equal(read.action.id, 'posture');
  const confirmed = await prompt.activate();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.result.posture, 'sitting');
  assert.equal(prompt.overlay(), null, 'a bench needs no overlay');
  assert.equal(f.platform.get('SELECT posture FROM agents WHERE id=?', alice.id).posture, 'sitting');
});

test('a crafting station gathers the ingredients first, then crafts, and a double gesture writes once', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  f.place(alice.id, 35, 23);
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 35, y: 23 }, coalesceMs: 60_000 });

  // Travel through the workshop doorway with the prompt itself.
  await prompt.refresh({ x: 35, y: 24 });
  const entered = await prompt.activate();
  assert.equal(entered.result.world_id, 'workshop');
  prompt.setWorld('workshop');
  f.place(alice.id, 5, 10);

  const read = await prompt.refresh({ x: 5, y: 11 });
  assert.equal(read.kind, 'crafting_station');
  assert.equal(read.action.id, 'craft');
  const overlay = await prompt.activate();
  const recipe = overlay.controls.find((control) => control.type === 'choice');
  assert.equal(recipe.options.find((option) => option.value === 'flower_crown').disabled, true, 'a recipe without ingredients is shown disabled');

  const missing = await prompt.submitOverlay({ choice: 'flower_crown' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 409);
  assert.match(missing.next_step, /2 more herbs and 1 more fiber/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM journey_inventory WHERE agent_id=? AND kind=?', alice.id, 'flower_crown').n, 0);

  // The fixture grants the grown resources a real garden would have produced.
  for (const [kind, quantity] of [['herbs', 2], ['fiber', 1]]) f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=excluded.quantity', alice.id, kind, quantity);
  await prompt.activate();
  const crafted = await prompt.submitOverlay({ choice: 'flower_crown' });
  assert.equal(crafted.ok, true);
  assert.equal(crafted.result.crafted, 'flower_crown');
  assert.equal(f.platform.get('SELECT crafts FROM journey_profiles WHERE agent_id=?', alice.id).crafts, 1);

  // Two activations of one gesture are one write: the second joins the one already in flight.
  for (const [kind, quantity] of [['herbs', 2], ['fiber', 1]]) f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=excluded.quantity', alice.id, kind, quantity);
  let writes = 0;
  const transport = f.transport('alice');
  const counting = { ...transport, interactWrite: (payload, key) => { writes += 1; return transport.interactWrite(payload, key); } };
  const pair = createInteractionPrompt({ transport: counting, world: 'workshop', agent: alice.id, position: { x: 5, y: 10 }, coalesceMs: 60_000 });
  await pair.refresh({ x: 5, y: 11 });
  const [first, second] = await Promise.all([pair.use(pair.view.fixture), pair.use(pair.view.fixture)]);
  assert.equal(writes, 1, 'a second activation while one is in flight joins it and sends nothing');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(f.platform.get('SELECT crafts FROM journey_profiles WHERE agent_id=?', alice.id).crafts, 2);
});

test('an ambassador desk opens a compact conversation overlay, and its own throttle refuses a rapid turn', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const stand = f.platform.get("SELECT id,world_id,x,y,name FROM npc_ambassadors WHERE id='amb-NPL'");
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', stand.world_id, stand.x, stand.y + 1, alice.id);

  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: stand.world_id, agent: alice.id, position: { x: stand.x, y: stand.y + 1 } });
  const read = await prompt.refresh({ x: stand.x, y: stand.y });
  assert.equal(read.kind, 'ambassador_desk');
  assert.equal(read.action.id, 'talk');
  assert.match(read.text, /Talk to /);

  const overlay = await prompt.activate();
  assert.equal(overlay.kind, 'conversation');
  assert.equal(overlay.controls.some((control) => control.type === 'text' && control.name === 'question'), true);

  const turns = () => f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations WHERE account_id=?', f.actor('alice').account.id).n;
  const answered = await prompt.submitOverlay({ question: 'What can we research here?' });
  assert.equal(answered.ok, true);
  assert.equal(answered.result.ambassador_id, 'amb-NPL');
  assert.equal(turns(), 1);

  await prompt.activate();
  const rapid = await prompt.submitOverlay({ question: 'And now?' });
  assert.equal(rapid.ok, false);
  assert.equal(rapid.status, 429);
  assert.match(rapid.next_step, /Wait a moment/);
  assert.equal(rapid.accomplished, false);
  assert.equal(turns(), 1);
});

test('a nearby resident is offered through the world’s nearby channel, and the overlay suspends the shortcuts', async (t) => {
  const f = await setup(t), alice = f.agent('alice'), bob = f.agent('bob');
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'commons', 12, 6, bob.id);
  const prompt = createInteractionPrompt({
    transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 10, y: 6 },
    residents: [{ id: bob.id, name: 'bob avatar', x: 12, y: 6 }],
  });
  await prompt.approach();
  const people = prompt.entries().filter((entry) => entry.type === 'resident');
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'bob avatar');
  assert.equal(people[0].distance, 2);

  const model = await prompt.focus(people[0]);
  assert.equal(model.kind, 'resident');
  assert.match(model.text, /bob avatar/);

  const overlay = await prompt.activate();
  assert.equal(overlay.kind, 'conversation');
  assert.equal(prompt.suspendsShortcuts, true, 'the overlay suspends the gameplay shortcuts');
  // While the overlay is open, a gameplay key is returned as an overlay intent, not passed through.
  assert.deepEqual(prompt.handleKey('w'), { kind: 'overlay', key: 'w' });
  assert.equal(prompt.handleKey('Escape').kind, 'dismiss');
  assert.equal(prompt.overlay(), null, 'Escape dismisses the overlay');

  await prompt.activate();
  const said = await prompt.submitOverlay({ text: 'hello nearby' });
  assert.equal(said.ok, true);
  assert.equal(said.interaction.kind, 'resident');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM messages WHERE agent_id=? AND channel='nearby'", alice.id).n, 1);
});

test('a paused or revoked resident is refused with its own state and never moves', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  assert.equal((await f.request('/agents/control', { method: 'POST', account: 'alice', input: { agent_id: alice.id, status: 'paused' } })).status, 200);
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 10, y: 6 } });
  const read = await prompt.refresh({ x: 11, y: 6 });
  assert.equal(read.blocked_by, 'paused');
  assert.match(read.next_step, /Resume the resident in My characters/);
  const refused = await prompt.activate();
  assert.equal(refused.status, 403);
  assert.match(refused.next_step, /Resume alice avatar in My characters/);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');

  assert.equal((await f.request('/agents/control', { method: 'POST', account: 'alice', input: { agent_id: alice.id, status: 'revoked' } })).status, 200);
  await prompt.refresh({ x: 11, y: 6 });
  const revoked = await prompt.activate();
  assert.equal(revoked.status, 403);
  assert.match(revoked.next_step, /must resume this resident/);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'commons');
});

test('the same gesture keeps one key, so a repeated doorway use replays instead of entering twice', async (t) => {
  const f = await setup(t), alice = f.agent('alice');
  const prompt = createInteractionPrompt({ transport: f.transport('alice'), world: 'commons', agent: alice.id, position: { x: 10, y: 6 }, coalesceMs: 60_000 });
  await prompt.refresh({ x: 11, y: 6 });
  const before = auditCount(f, 'world.entered');
  const first = await prompt.use(prompt.view.fixture);
  assert.equal(first.ok, true);
  assert.equal(first.result.world_id, 'hall');
  const second = await prompt.use(prompt.view.fixture);
  assert.equal(second.ok, true);
  assert.equal(second.replay, true, 'the same intent inside one gesture replays the recorded response');
  assert.equal(auditCount(f, 'world.entered'), before + 1, 'the door was crossed once');
});
