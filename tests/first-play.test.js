import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';
import { RESTORATION_PLACEMENT_STEP, RESTORATION_LIST } from '../src/community.js';
import { COUNTRIES, ambassadorIdentity } from '../src/civic-engine.js';
import { FIRST_PLAY_ENCOUNTER_CANNOT } from '../src/firstplay.js';

const error = (status) => (caught) => caught.status === status;
const count = (f, sql, ...args) => f.platform.get(sql, ...args).n;
const step = (view, id) => view.steps.find((item) => item.id === id);
const doneOf = (view) => Object.fromEntries(view.steps.map((item) => [item.id, item.done]));
const position = (f, id) => f.platform.get('SELECT x,y,z,world_id,yaw,pitch FROM agents WHERE id=?', id);
const standAt = (f, id, x, y) => f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', x, y, id);
const viewerDistance = (f, id, target) => { const at = position(f, id); return Math.abs(at.x - target.x) + Math.abs(at.y - target.y); };
const guide = (f, owner, agent) => f.platform.firstPlay(f.actor(owner), { agent_id: agent.id });

/** A public garden belonging to one resident of one operator, opened as one restoration window. */
function openedGarden(f, owner, agent, hours = 6) {
  f.tx('homeSettings', f.actor(owner), agent.id, { visibility: 'public' });
  return f.tx('restorationOpen', f.actor(owner), { agent_id: agent.id, hours });
}
/** A documented visit: the resident actually travels into the garden, which records the visit. */
function visit(f, owner, agent, worldId) {
  f.advance();
  return f.tx('travel', f.actor(owner), agent.id, { world_id: worldId });
}
function pledge(f, owner, agent, event) { return f.tx('restorationJoin', f.actor(owner), { agent_id: agent.id, event_id: event.id }); }
/** One planned placement: stand beside the tile, then place it through the shipped route. */
function place(f, owner, agent, event, slot) {
  standAt(f, agent.id, slot.x, slot.y - 1);
  f.advance(400);
  return f.tx('restorationPlace', f.actor(owner), { agent_id: agent.id, event_id: event.id, x: slot.x, y: slot.y });
}
/** Every route the guide publishes must be one this server actually serves (never a 404 or 405). */
async function expectServed(t, f, routes) {
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  for (const route of routes) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.notEqual(response.status, 404, `${route} is served by the server`);
    assert.notEqual(response.status, 405, `${route} accepts the posted method`);
  }
}

test('the guide derives all five steps one saved row at a time', async (t) => {
  const f = await fixture(t);
  // A signed-in account that owns no resident yet: the guide answers, but every step is open.
  const empty = f.platform.firstPlay(f.actor('alice'), {});
  assert.equal(empty.viewer, null);
  assert.deepEqual(doneOf(empty), { enter: false, calling: false, meet: false, practice: false, restore: false });
  assert.equal(empty.progress.done, 0);

  const alice = f.agent('alice');
  const bob = f.agent('bob');

  let view = guide(f, 'alice', alice);
  assert.deepEqual(doneOf(view), { enter: true, calling: false, meet: false, practice: false, restore: false });
  assert.equal(view.progress.done, 1);
  assert.equal(view.next_step.id, 'calling');

  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  view = guide(f, 'alice', alice);
  assert.deepEqual(doneOf(view), { enter: true, calling: true, meet: false, practice: false, restore: false });
  assert.equal(view.progress.done, 2);

  // Meet: another operator's resident stands within earshot and the viewer speaks to it.
  const aliceAt = position(f, alice.id);
  standAt(f, bob.id, aliceAt.x + 2, aliceAt.y);
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'nearby', text: 'Hello from Alice.' });
  view = guide(f, 'alice', alice);
  assert.deepEqual(doneOf(view), { enter: true, calling: true, meet: true, practice: false, restore: false });
  assert.equal(view.progress.done, 3);

  // Practice: one saved act in the viewer's own garden earns a calling receipt.
  const garden = `home:${alice.id}`;
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  visit(f, 'alice', alice, garden);
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'flowers' });
  f.platform.callings(f.actor('alice'), { agent_id: alice.id });
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?', alice.id), 1);
  view = guide(f, 'alice', alice);
  assert.deepEqual(doneOf(view), { enter: true, calling: true, meet: true, practice: true, restore: false });
  assert.equal(view.progress.done, 4);

  // Restore: a shared restoration the viewer's own placement answers beside another operator.
  const event = f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id, hours: 6 });
  f.tx('restorationJoin', f.actor('alice'), { agent_id: alice.id, event_id: event.id });
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  place(f, 'alice', alice, event, RESTORATION_PLACEMENT_STEP.slots[0]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, false, 'another operator’s pledge is not work');
  place(f, 'bob', bob, event, RESTORATION_PLACEMENT_STEP.slots[1]);
  view = guide(f, 'alice', alice);
  assert.deepEqual(doneOf(view), { enter: true, calling: true, meet: true, practice: true, restore: true });
  assert.equal(view.progress.done, 5);
  assert.equal(view.next_step, null);

  // The whole flow is coinless: the guide issues no NemoCoin and writes no receipt.
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
  assert.equal(view.policy.coins_awarded, 0);
  assert.equal(view.policy.client_completion, false);
});

test('a default explorer row cannot satisfy the calling step; only a saved selection can', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  // Every resident starts with an explorer row, so a selection table could not tell chosen from defaulted.
  const seeded = f.platform.get('SELECT * FROM resident_callings WHERE agent_id=?', alice.id);
  assert.equal(seeded.calling_id, 'explorer');
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE event='calling.selected' AND record_id=?", alice.id), 0);

  let view = guide(f, 'alice', alice);
  assert.equal(view.viewer.calling_id, 'explorer');
  assert.equal(step(view, 'calling').done, false);
  assert.equal(step(view, 'enter').done, true);

  // Re-selecting the default writes no audit row and still does not satisfy the step.
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'explorer' });
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE event='calling.selected' AND record_id=?", alice.id), 0);
  assert.equal(step(guide(f, 'alice', alice), 'calling').done, false);

  // A real change records the saved row the guide reads.
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'cultivator' });
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE event='calling.selected' AND record_id=?", alice.id), 1);
  view = guide(f, 'alice', alice);
  assert.equal(view.viewer.calling_id, 'cultivator');
  assert.equal(step(view, 'calling').done, true);
});

test('the guide read writes nothing, however many times it is asked', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const aliceAt = position(f, alice.id);
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  standAt(f, bob.id, aliceAt.x + 1, aliceAt.y);
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'nearby', text: 'Hello from Alice.' });
  const garden = `home:${alice.id}`;
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  visit(f, 'alice', alice, garden);
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'flowers' });
  f.platform.callings(f.actor('alice'), { agent_id: alice.id });
  const event = f.tx('restorationOpen', f.actor('alice'), { agent_id: alice.id, hours: 6 });
  f.tx('restorationJoin', f.actor('alice'), { agent_id: alice.id, event_id: event.id });
  place(f, 'alice', alice, event, RESTORATION_PLACEMENT_STEP.slots[0]);

  const tables = ['audit', 'calling_receipts', 'coin_rewards', 'community_rsvps', 'world_objects'];
  // The fixture holds saved rows in four of the five tables, so a stray write would be visible.
  for (const table of ['audit', 'calling_receipts', 'community_rsvps', 'world_objects']) assert.ok(count(f, `SELECT COUNT(*) AS n FROM ${table}`) > 0);
  const before = tables.map((table) => count(f, `SELECT COUNT(*) AS n FROM ${table}`));
  for (let index = 0; index < 6; index += 1) f.platform.firstPlay(f.actor('alice'), { agent_id: alice.id });
  const after = tables.map((table) => count(f, `SELECT COUNT(*) AS n FROM ${table}`));
  assert.deepEqual(after, before);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
});

test('the guide never issues a coin, even when a cooperative step is completed', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, event);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  // Three planned placements complete the ground step, with counted work from both operators.
  for (const slot of RESTORATION_PLACEMENT_STEP.slots.slice(0, 2)) place(f, 'alice', alice, event, slot);
  place(f, 'bob', bob, event, RESTORATION_PLACEMENT_STEP.slots[2]);
  const eventView = f.platform.restoration(f.actor('alice'), { event_id: event.id }).event;
  assert.equal(eventView.progress.steps.find((item) => item.id === 'ground').complete, true);
  const view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, true);
  assert.equal(view.policy.coins_awarded, 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM land_stewardships'), 0);
});

test('a nearby operated resident is described by its own calling and one shared list of limits', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'cultivator' });
  const aliceAt = position(f, alice.id);
  standAt(f, bob.id, aliceAt.x + 2, aliceAt.y);
  const encounter = guide(f, 'alice', alice).encounter;
  assert.equal(encounter.kind, 'agent');
  assert.equal(encounter.scripted, false);
  assert.equal(encounter.calling.id, 'cultivator');
  assert.match(encounter.honest_statement, /Cultivator/);
  assert.match(encounter.honest_statement, /represent no company, institution, government or person/i);
  assert.match(encounter.honest_statement, new RegExp(encounter.name));
  assert.deepEqual(encounter.cannot, [...FIRST_PLAY_ENCOUNTER_CANNOT]);
  assert.ok(encounter.cannot.length > 0);
  assert.deepEqual(encounter.actions[0].body, { agent_id: alice.id, channel: 'private', recipient_id: bob.id });
  assert.equal(encounter.actions[0].requires_input, true);
  assert.equal(guide(f, 'alice', alice).next_step.actions.length, 0, 'calling remains the first incomplete step');
  await expectServed(t, f, encounter.actions.map((item) => item.route));
});

test('a country ambassador is described by its authored civic identity', async (t) => {
  const f = await fixture(t);
  const ambassador = f.platform.get("SELECT * FROM npc_ambassadors WHERE status='active' ORDER BY iso3 LIMIT 1");
  assert.ok(ambassador, 'the world seeds at least one active country ambassador');
  const country = COUNTRIES.entries.find((entry) => entry.iso3 === ambassador.iso3);
  assert.ok(country, `${ambassador.iso3} is a catalog country`);
  const view = f.platform.firstPlay(null, { world_id: ambassador.world_id });
  const encounter = view.encounter;
  assert.equal(encounter.kind, 'npc');
  assert.equal(encounter.scripted, true);
  assert.ok(encounter.honest_statement.includes(ambassadorIdentity(country)));
  assert.ok(encounter.cannot.length > 0);
  assert.deepEqual(encounter.actions, [], 'anonymous observation has no executable talk action');
  const alice = f.agent('alice');
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', ambassador.world_id, ambassador.x, ambassador.y, alice.id);
  const signed = guide(f, 'alice', alice).encounter;
  assert.equal(signed.npc_id, ambassador.id);
  assert.deepEqual(signed.actions[0].body, { ambassador_id: ambassador.id, agent_id: alice.id });
  assert.equal(signed.actions[0].requires_input, true);
  await expectServed(t, f, signed.actions.map((item) => item.route));
});

test('the shared restoration names both operators and the step each saved row counts toward', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, event);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);

  // Both pledged, nobody has done saved work: the restore step is not done.
  let view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, false);

  const [first, second] = RESTORATION_PLACEMENT_STEP.slots;
  place(f, 'bob', bob, event, first);
  view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, false, 'only the other operator has contributed');

  place(f, 'alice', alice, event, second);
  view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, true);

  const block = view.restoration;
  assert.equal(block.actors.length, 2);
  const actors = Object.fromEntries(block.actors.map((actor) => [actor.agent_id, actor]));
  assert.equal(actors[alice.id].operator_distinct, false);
  assert.equal(actors[bob.id].operator_distinct, true);
  for (const actor of [actors[alice.id], actors[bob.id]]) {
    assert.deepEqual(actor.contributions, [{ step_id: 'ground', counted: 1, standing: 2 }]);
    assert.equal(actor.promise.counted_as_work, false);
  }
  const remaining = Object.fromEntries(block.remaining.map((item) => [item.step_id, item]));
  assert.deepEqual(Object.keys(remaining).sort(), ['beds', 'ground', 'keep', 'light']);
  assert.deepEqual([remaining.ground.progress, remaining.ground.target], [2, 3]);
  assert.deepEqual([remaining.beds.progress, remaining.beds.target], [0, 2]);
  assert.deepEqual([remaining.light.progress, remaining.light.target], [0, 2]);
  assert.deepEqual([remaining.keep.progress, remaining.keep.target], [0, 1]);
  assert.equal(block.steps_completed, 0);

  // Another operator must actually take part: the viewer's counted work alone is not enough.
  f.tx('restorationLeave', f.actor('bob'), { agent_id: bob.id, event_id: event.id });
  view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, false);
  assert.equal(view.restoration.actors.length, 1);
  f.advance();
  pledge(f, 'bob', bob, event);
  view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, true);
});

test('a pledge is reported as a promise and never advances a step', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  const view = guide(f, 'bob', bob);
  const block = view.restoration;
  assert.equal(step(view, 'restore').done, false);
  assert.deepEqual(block.viewer.steps.map((item) => [item.step_id, item.progress]), [['ground', 0], ['beds', 0], ['light', 0], ['keep', 0]]);
  assert.deepEqual(block.remaining.map((item) => item.progress), [0, 0, 0, 0]);
  const actor = block.actors.find((item) => item.agent_id === bob.id);
  assert.equal(actor.promise.code, 'pledge');
  assert.equal(actor.promise.counted_as_work, false);
  assert.match(actor.promise.label, /never counted as work/i);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 0);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
});

test('a counted contribution is attributed only to the step its own saved row answers', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'mediator' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, event);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, event);
  // A real saved membership of a circle another operator keeps answers the keepers' step.
  const circle = f.tx('createCircle', f.actor('bob'), { agent_id: bob.id, name: 'Garden keepers', summary: 'A circle another operator keeps.', focus: 'Care' });
  f.tx('circleMembership', f.actor('alice'), { agent_id: alice.id, circle_id: circle.id, action: 'join' });
  const contributed = f.tx('restorationContribute', f.actor('alice'), { agent_id: alice.id, event_id: event.id, step_id: 'keep' });
  assert.equal(contributed.contribution.step_complete, true);
  // The membership is counted for the viewer's keep step — and for no other. Bob's pledge still
  // is not counted work, even though both residents are on the participant list.
  const block = guide(f, 'alice', alice).restoration;
  const actor = block.actors.find((item) => item.agent_id === alice.id);
  assert.deepEqual(actor.contributions, [{ step_id: 'keep', counted: 1, standing: null }]);
  assert.deepEqual(block.viewer.steps.map((item) => [item.step_id, item.my_counted]), [['ground', 0], ['beds', 0], ['light', 0], ['keep', 1]]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, false);

  // One placement is counted for the ground step alone, never for the other three.
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  place(f, 'bob', bob, event, RESTORATION_PLACEMENT_STEP.slots[0]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, true);
  const placedBlock = guide(f, 'bob', bob).restoration;
  assert.deepEqual(placedBlock.viewer.steps.map((item) => [item.step_id, item.my_counted]), [['ground', 1], ['beds', 0], ['light', 0], ['keep', 0]]);
});

test('a sowing by the viewer credits only the shared beds step', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'cultivator' });
  const garden = `home:${alice.id}`;
  const event = openedGarden(f, 'alice', alice);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, event);
  // A real sowing in the viewer's own garden after the pledge answers the growers' step.
  f.advance();
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'farm' });
  f.tx('gardenAction', f.actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 8, y: 7 });
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=?', alice.id), 1);
  const block = guide(f, 'alice', alice).restoration;
  assert.deepEqual(block.viewer.steps.map((item) => [item.step_id, item.my_counted]), [['ground', 0], ['beds', 1], ['light', 0], ['keep', 0]]);
});

test('meeting requires this character’s own saved message to another operator’s AI resident', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), sibling = f.agent('alice', 'Alice second character');
  const human = f.tx('createAgent', f.actor('bob'), { kind: 'human', name: 'Bob human', capabilities: '', limitations: '', color: '#397f79', symbol: '✦' });
  const bob = f.agent('bob');
  const met = (agent) => step(guide(f, 'alice', agent), 'meet').done;
  assert.equal(met(alice), false);

  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: human.id, text: 'Hello, human.' });
  assert.equal(met(alice), false, 'a human recipient is not an AI encounter');
  f.advance();
  f.tx('message', f.actor('bob'), { agent_id: bob.id, channel: 'private', recipient_id: alice.id, text: 'An unsolicited greeting.' });
  assert.equal(met(alice), false, 'incoming text is not this character’s action');
  f.advance();
  f.tx('message', f.actor('alice'), { agent_id: sibling.id, channel: 'private', recipient_id: bob.id, text: 'The second character says hello.' });
  assert.equal(met(sibling), true);
  assert.equal(met(alice), false, 'a sibling character cannot inherit the meeting');
  f.advance();
  const ambassador = f.platform.get("SELECT id FROM npc_ambassadors WHERE status='active' LIMIT 1");
  f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: ambassador.id, question: 'What can you explain?' });
  assert.equal(met(alice), false, 'an account-level ambassador conversation cannot be attributed to this character');
  f.advance();
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'public', text: 'A public broadcast.' });
  assert.equal(met(alice), false, 'a broadcast has no named AI recipient');
  f.advance();
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'Hello, Bob AI resident.' });
  assert.equal(met(alice), true);
});

test('a saved first-play step survives better than a bounded page can drop', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const account = f.actor('alice').account.id;
  // A real meeting: this character's own private message to another operator's nearby AI resident.
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=? WHERE id=?", position(f, alice.id).x + 2, position(f, alice.id).y, bob.id);
  f.advance();
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'Hello, Bob AI resident.' });
  assert.equal(step(guide(f, 'alice', alice), 'meet').done, true);

  // Push unrelated saved rows past every bounded read, so the credited message cannot be inside the
  // page the world feed or the conversation view returns.
  for (let index = 0; index < 260; index++) {
    f.platform.run("INSERT INTO messages(id,agent_id,account_id,channel,recipients,text,status,created_at,world_id) VALUES(?,?,?,?,?,?,?,?,?)",
      `pressure-${index}`, bob.id, f.actor('bob').account.id, 'public', '[]', `Unrelated broadcast ${index}.`, 'visible', new Date(f.platform.clock() + index).toISOString(), 'commons');
  }
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM messages'), 261);
  assert.ok(!f.platform.world(f.actor('alice'), { world_id: 'commons' }).messages.some((message) => message.text === 'Hello, Bob AI resident.'),
    'the credited message is now outside the bounded world feed');
  assert.ok(!JSON.stringify(f.platform.history(f.actor('alice'))).includes('Hello, Bob AI resident.'),
    'the credited message is now outside the bounded history page');

  // The step still counts, because the guide asks the database for the fact itself rather than
  // reading whichever rows happen to be on a page. Reading it again credits nothing new.
  assert.equal(step(guide(f, 'alice', alice), 'meet').done, true);
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE actor=? AND event='firstplay.resident_met'", account), 1);
});

test('remote private chat stays private but only a nearby AI conversation proves a meeting', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const accountId = f.actor('alice').account.id;
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${bob.id}`, bob.id);
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'Remote private note.' });
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM messages WHERE account_id=? AND channel='private'", accountId), 1);
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE actor=? AND event='firstplay.resident_met'", accountId), 0);
  assert.equal(step(guide(f, 'alice', alice), 'meet').done, false);
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=? WHERE id=?", position(f, alice.id).x + 2, position(f, alice.id).y, bob.id);
  f.advance();
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'Hello here in the world.' });
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE actor=? AND event='firstplay.resident_met' AND record_id LIKE ?", accountId, `${alice.id}|%`), 1);
  assert.equal(step(guide(f, 'alice', alice), 'meet').done, true);
});

test('a new solo character can meet the scripted ambassador in a country venue and keep proof after restart', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  let view = guide(f, 'alice', alice);
  assert.equal(view.next_step.id, 'meet');
  assert.equal(view.encounter, null, 'no other account has an AI resident in this solo world');
  assert.match(view.next_step.instruction, /scripted ambassador/i);
  assert.equal(view.next_step.actions[0].route, `/agents/${alice.id}/travel`);
  assert.deepEqual(view.next_step.actions[0].body, { world_id: 'country:NPL' });
  visit(f, 'alice', alice, view.next_step.actions[0].body.world_id);
  const ambassador = f.platform.get("SELECT * FROM npc_ambassadors WHERE iso3='NPL'");
  assert.ok(ambassador);
  view = guide(f, 'alice', alice);
  assert.equal(view.next_step.target.world_id, ambassador.world_id);
  if (viewerDistance(f, alice.id, ambassador) > 6) {
    assert.deepEqual(view.next_step.actions, []);
    assert.match(view.next_step.instruction, /Walk within six tiles/);
  }
  standAt(f, alice.id, ambassador.x, ambassador.y);
  view = guide(f, 'alice', alice);
  assert.equal(view.encounter.kind, 'npc');
  assert.equal(view.encounter.scripted, true);
  assert.match(view.encounter.honest_statement, /cannot approve|cannot sanction|can never approve/i);
  assert.deepEqual(view.next_step.actions[0].body, { ambassador_id: ambassador.id, agent_id: alice.id });
  assert.equal(view.next_step.actions[0].requires_input, true);
  assert.equal(step(view, 'meet').done, false);
  f.tx('ambassadorTalk', f.actor('alice'), { ...view.next_step.actions[0].body, question: 'What can I learn about this country?' });
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM audit WHERE event='firstplay.ambassador_met' AND actor=? AND record_id LIKE ?", f.actor('alice').account.id, `${alice.id}|%`), 1);
  assert.equal(step(guide(f, 'alice', alice), 'meet').done, true);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
  f.platform.close();
  const reopened = new Platform(f.database, f.clock);
  t.after(() => reopened.close());
  const returning = reopened.firstPlay(reopened.authenticate(f.credentials.alice.token), { agent_id: alice.id });
  assert.equal(step(returning, 'meet').done, true);
  assert.equal(returning.resume.world_id, ambassador.world_id);
});

test('a suspended operator’s AI resident is not offered as a nearby meeting target', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  const at = position(f, alice.id);
  standAt(f, bob.id, at.x + 1, at.y);
  assert.equal(guide(f, 'alice', alice).encounter.agent_id, bob.id);
  f.tx('accountControl', f.actor('admin'), { account_id: f.actor('bob').account.id, status: 'suspended' });
  const view = guide(f, 'alice', alice);
  assert.equal(view.encounter, null);
  assert.equal(view.next_step.id, 'calling');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  assert.deepEqual(guide(f, 'alice', alice).next_step.actions[0].body, { world_id: 'country:NPL' });
});

test('a visible encounter excludes human and own avatars and exposes a composer only to an active human operator', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), sibling = f.agent('alice', 'Alice sibling');
  const human = f.tx('createAgent', f.actor('bob'), { kind: 'human', name: 'Bob human', capabilities: '', limitations: '', color: '#397f79', symbol: '✦' });
  const bob = f.agent('bob');
  const at = position(f, alice.id);
  standAt(f, sibling.id, at.x, at.y);
  standAt(f, human.id, at.x + 1, at.y);
  standAt(f, bob.id, at.x + 2, at.y);
  const encounter = guide(f, 'alice', alice).encounter;
  assert.equal(encounter.agent_id, bob.id);
  assert.deepEqual(encounter.actions[0].body, { agent_id: alice.id, channel: 'private', recipient_id: bob.id });
  assert.equal(encounter.actions[0].requires_input, true);
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read'] });
  assert.deepEqual(f.platform.firstPlay(f.platform.authenticate(runtime.token, 'read'), {}).encounter.actions, []);
  f.tx('agentControl', f.actor('alice'), alice.id, 'paused');
  assert.deepEqual(guide(f, 'alice', alice).encounter.actions, []);
});

test('restoration guide offers visit, pledge and adjacent planned placement only when usable', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'Ready to help.' });
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  visit(f, 'alice', alice, `home:${alice.id}`);
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'flowers' });
  f.platform.callings(f.actor('alice'), { agent_id: alice.id });
  assert.equal(step(guide(f, 'alice', alice), 'practice').done, true);

  const event = openedGarden(f, 'bob', bob);
  let view = guide(f, 'alice', alice);
  assert.equal(view.next_step.id, 'restore');
  assert.equal(view.next_step.actions[0].route, `/agents/${alice.id}/travel`);
  assert.deepEqual(view.next_step.actions[0].body, { world_id: `home:${bob.id}` });
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, view.next_step.actions[0].body);
  view = guide(f, 'alice', alice);
  assert.equal(view.next_step.actions[0].route, '/restoration/join');
  assert.equal(view.next_step.instruction.includes('promise'), true);
  f.tx('restorationJoin', f.actor('alice'), view.next_step.actions[0].body);
  view = guide(f, 'alice', alice);
  assert.deepEqual(view.next_step.actions, [], 'a distant planned tile is not yet placeable');
  assert.match(view.next_step.instruction, /Walk beside/);

  const slot = RESTORATION_PLACEMENT_STEP.slots[0];
  standAt(f, alice.id, slot.x, slot.y - 1);
  view = guide(f, 'alice', alice);
  assert.equal(view.next_step.actions[0].route, '/restoration/place');
  assert.deepEqual(view.next_step.actions[0].body, { agent_id: alice.id, event_id: event.id, x: slot.x, y: slot.y });
  place(f, 'alice', alice, event, slot);
  view = guide(f, 'alice', alice);
  assert.equal(step(view, 'restore').done, false, 'one operator’s saved placement is not shared work');
  assert.deepEqual(view.next_step.actions, []);

  visit(f, 'bob', bob, `home:${bob.id}`);
  pledge(f, 'bob', bob, event);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, false, 'the second operator’s pledge still does not count');
  place(f, 'bob', bob, event, RESTORATION_PLACEMENT_STEP.slots[1]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, true);
});

test('a joined grower is guided to a real empty crop patch in their own garden', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'I can plant for the garden.' });
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  visit(f, 'alice', alice, `home:${alice.id}`);
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'flowers' });
  f.platform.callings(f.actor('alice'), { agent_id: alice.id });
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'farm' });
  f.advance(24 * 60 * 60 * 1000);
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'cultivator' });
  const event = openedGarden(f, 'bob', bob);
  visit(f, 'alice', alice, `home:${bob.id}`);
  pledge(f, 'alice', alice, event);

  let view = guide(f, 'alice', alice);
  assert.equal(view.next_step.id, 'restore');
  assert.deepEqual(view.next_step.actions[0].body, { world_id: `home:${alice.id}` });
  f.advance();
  f.tx('travel', f.actor('alice'), alice.id, view.next_step.actions[0].body);
  view = guide(f, 'alice', alice);
  assert.deepEqual(view.next_step.actions, [], 'the crop patch is distant, so the guide asks the resident to walk there');
  standAt(f, alice.id, 8, 6);
  view = guide(f, 'alice', alice);
  assert.equal(view.next_step.actions[0].route, '/journey/garden');
  assert.deepEqual(view.next_step.actions[0].body, { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 8, y: 7 });
  f.tx('gardenAction', f.actor('alice'), view.next_step.actions[0].body);
  assert.equal(guide(f, 'alice', alice).restoration.viewer.my_counted_by_step.beds, 1);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, false, 'another operator must also save a step');
});

test('private or closed restoration is explained without an executable action', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('message', f.actor('alice'), { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'Ready to help.' });
  f.tx('homeSettings', f.actor('alice'), alice.id, { visibility: 'public' });
  visit(f, 'alice', alice, `home:${alice.id}`);
  f.tx('build', f.actor('alice'), alice.id, { x: 8, y: 7, type: 'flowers' });
  f.platform.callings(f.actor('alice'), { agent_id: alice.id });
  openedGarden(f, 'bob', bob, 1);
  f.tx('homeSettings', f.actor('bob'), bob.id, { visibility: 'private' });
  let view = guide(f, 'alice', alice);
  assert.equal(view.next_step.blocked.code, 'garden_private');
  assert.deepEqual(view.next_step.actions, []);
  f.advance(2 * 60 * 60 * 1000);
  view = guide(f, 'alice', alice);
  assert.deepEqual(view.next_step.actions, []);
  assert.match(view.next_step.instruction, /closed/);
});

test('the guide answers anonymously without a viewer or an action', async (t) => {
  const f = await fixture(t);
  const view = f.platform.firstPlay(null, {});
  assert.equal(view.viewer, null);
  assert.equal(view.resume, null);
  assert.equal(view.restoration, null);
  assert.deepEqual(view.steps.map((item) => item.done), [false, false, false, false, false]);
  assert.equal(view.progress.done, 0);
  assert.deepEqual(view.next_step.actions, []);
});

test('the guide still reads while the world is paused and names the refusal in force', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('pause', f.actor('admin'), true);
  let view = f.platform.firstPlay(f.actor('alice'), { agent_id: alice.id });
  assert.equal(view.world.paused, true);
  assert.equal(view.next_step.blocked.code, 'world_paused');
  assert.equal(view.next_step.blocked.message.length > 0, true);

  f.tx('pause', f.actor('admin'), false);
  f.tx('agentControl', f.actor('alice'), alice.id, 'paused');
  view = f.platform.firstPlay(f.actor('alice'), { agent_id: alice.id });
  assert.equal(view.world.paused, false);
  assert.equal(view.next_step.blocked.code, 'resident_unavailable');
  assert.equal(view.resume.refusal.code, 'resident_unavailable');
  assert.match(view.resume.refusal.message, /alice avatar/);
  assert.equal(typeof view.resume.refusal.recover, 'string');
  assert.equal(typeof view.resume.refusal.next_step, 'string');
});

test('the guide refuses unknown input and a runtime naming another resident', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  assert.throws(() => f.platform.firstPlay(f.actor('alice'), { agent_id: alice.id, done: true }), error(400));
  assert.throws(() => f.platform.firstPlay(f.actor('alice'), { bogus: 1 }), error(400));
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read'] });
  const actor = f.platform.authenticate(runtime.token, 'read');
  assert.throws(() => f.platform.firstPlay(actor, { agent_id: bob.id }), error(403));
  assert.equal(f.platform.firstPlay(actor, {}).viewer.agent_id, alice.id);
});

test('the guide restores the saved place, character, purpose and camera', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'cultivator' });
  f.tx('updateProfile', f.actor('alice'), { agent_id: alice.id, purpose: 'Grow food for the shared table.' });
  f.advance();
  f.tx('lookAgent', f.actor('alice'), alice.id, { yaw: 1.25, pitch: 0.5 });
  f.platform.run('UPDATE agents SET x=?,y=?,z=?,world_id=? WHERE id=?', 4, 9, 2, `home:${alice.id}`, alice.id);

  const saved = position(f, alice.id);
  const purpose = f.platform.get('SELECT purpose FROM journey_profiles WHERE agent_id=?', alice.id).purpose;
  const view = f.platform.firstPlay(f.actor('alice'), { agent_id: alice.id });
  const resume = view.resume;
  assert.equal(resume.character_id, alice.id);
  assert.equal(resume.world_id, saved.world_id);
  assert.deepEqual([resume.x, resume.y, resume.z], [saved.x, saved.y, saved.z]);
  assert.deepEqual([resume.yaw, resume.pitch], [saved.yaw, saved.pitch]);
  assert.equal(resume.calling_id, 'cultivator');
  assert.equal(resume.purpose, purpose);
  assert.equal(resume.refusal, null);
  assert.deepEqual(resume.restore.map((source) => source.id), ['place', 'character', 'purpose', 'camera']);
  assert.ok(resume.restore.every((source) => typeof source.source === 'string' && source.source.length > 0));
});

test('account-specific restoration read stays visible past the global newest-eight list', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const oldEvent = openedGarden(f, 'alice', alice);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, oldEvent);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, oldEvent);
  const [first, second] = RESTORATION_PLACEMENT_STEP.slots;
  place(f, 'alice', alice, oldEvent, first);
  place(f, 'bob', bob, oldEvent, second);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, true);
  assert.equal(step(guide(f, 'bob', bob), 'restore').done, true);

  // Flood the global list with newer restoration events opened by other operators.
  let opened = 0;
  for (const owner of ['reviewer', 'moderator']) {
    for (let i = 0; i < 5 && opened < RESTORATION_LIST + 1; i += 1) {
      const agent = f.tx('createAgent', f.actor(owner), { name: `${owner} flood ${i}`, capabilities: '', limitations: '', color: '#397f79', symbol: '✦' });
      f.tx('homeSettings', f.actor(owner), agent.id, { visibility: 'public' });
      f.advance();
      f.tx('restorationOpen', f.actor(owner), { agent_id: agent.id, hours: 6 });
      opened += 1;
    }
  }
  assert.ok(opened >= RESTORATION_LIST + 1, `opened at least ${RESTORATION_LIST + 1} newer events`);

  // The global restoration() list no longer includes the old event.
  const global = f.platform.restoration(f.actor('alice'), { agent_id: alice.id });
  assert.ok(!global.events.some((event) => event.id === oldEvent.id), 'old event is pushed out of the global newest-eight list');

  // Both accounts still see their counted work and the restore step stays done.
  const aliceView = guide(f, 'alice', alice);
  assert.equal(aliceView.restoration.event_id, oldEvent.id);
  assert.equal(step(aliceView, 'restore').done, true);
  const bobView = guide(f, 'bob', bob);
  assert.equal(bobView.restoration.event_id, oldEvent.id);
  assert.equal(step(bobView, 'restore').done, true);

  // The placed objects in the old garden are untouched and completion still derives from saved rows.
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 2);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM coin_rewards'), 0);
});

test('requested garden keeps its counted step after the same account works in nine other gardens', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const original = openedGarden(f, 'alice', alice);
  const originalGarden = `home:${alice.id}`;
  visit(f, 'alice', alice, originalGarden);
  pledge(f, 'alice', alice, original);
  visit(f, 'bob', bob, originalGarden);
  pledge(f, 'bob', bob, original);
  place(f, 'alice', alice, original, RESTORATION_PLACEMENT_STEP.slots[0]);
  place(f, 'bob', bob, original, RESTORATION_PLACEMENT_STEP.slots[1]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, true);

  // These are real newer counted placements by Alice, not merely events opened elsewhere.
  for (const owner of ['reviewer', 'moderator']) {
    for (let i = 0; i < (owner === 'reviewer' ? 5 : 4); i += 1) {
      const keeper = f.agent(owner, `${owner} keeper ${i}`);
      const newer = openedGarden(f, owner, keeper);
      const garden = `home:${keeper.id}`;
      visit(f, 'alice', alice, garden);
      pledge(f, 'alice', alice, newer);
      place(f, 'alice', alice, newer, RESTORATION_PLACEMENT_STEP.slots[0]);
      assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden), 1);
    }
  }
  assert.equal(count(f, "SELECT COUNT(DISTINCT substr(record_id,1,instr(record_id,'|')-1)) AS n FROM audit WHERE actor=? AND event='restoration.placed'", f.actor('alice').account.id), 10);

  const requested = f.platform.restorationForAccount(f.actor('alice'), alice.id, originalGarden);
  assert.equal(requested.id, original.id);
  const view = f.platform.firstPlay(f.actor('alice'), { agent_id: alice.id, world_id: originalGarden });
  assert.equal(view.restoration.event_id, original.id);
  assert.equal(step(view, 'restore').done, true);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', originalGarden), 2);

  f.platform.close();
  const reopened = new Platform(f.database, f.clock);
  t.after(() => reopened.close());
  const returning = reopened.firstPlay(reopened.authenticate(f.credentials.alice.token), { agent_id: alice.id, world_id: originalGarden });
  assert.equal(returning.restoration.event_id, original.id);
  assert.equal(step(returning, 'restore').done, true);
});

test('account-specific restoration read persists across server restart', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob');
  f.tx('callingSelect', f.actor('alice'), { agent_id: alice.id, calling_id: 'builder' });
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  const garden = `home:${alice.id}`;
  const oldEvent = openedGarden(f, 'alice', alice);
  visit(f, 'alice', alice, garden);
  pledge(f, 'alice', alice, oldEvent);
  visit(f, 'bob', bob, garden);
  pledge(f, 'bob', bob, oldEvent);
  place(f, 'alice', alice, oldEvent, RESTORATION_PLACEMENT_STEP.slots[0]);
  place(f, 'bob', bob, oldEvent, RESTORATION_PLACEMENT_STEP.slots[1]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, true);

  let opened = 0;
  for (const owner of ['reviewer', 'moderator']) {
    for (let i = 0; i < 5 && opened < RESTORATION_LIST + 1; i += 1) {
      const agent = f.tx('createAgent', f.actor(owner), { name: `${owner} flood ${i}`, capabilities: '', limitations: '', color: '#397f79', symbol: '✦' });
      f.tx('homeSettings', f.actor(owner), agent.id, { visibility: 'public' });
      f.advance();
      f.tx('restorationOpen', f.actor(owner), { agent_id: agent.id, hours: 6 });
      opened += 1;
    }
  }

  f.platform.close();
  const reopened = new Platform(f.database, f.clock);
  t.after(() => reopened.close());
  const returning = reopened.firstPlay(reopened.authenticate(f.credentials.alice.token), { agent_id: alice.id });
  assert.equal(returning.restoration.event_id, oldEvent.id);
  assert.equal(step(returning, 'restore').done, true);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', garden).n, 2);
});
