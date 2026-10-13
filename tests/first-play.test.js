import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { RESTORATION_PLACEMENT_STEP } from '../src/community.js';
import { COUNTRIES, ambassadorIdentity } from '../src/civic-engine.js';
import { FIRST_PLAY_ENCOUNTER_CANNOT } from '../src/firstplay.js';

const error = (status) => (caught) => caught.status === status;
const count = (f, sql, ...args) => f.platform.get(sql, ...args).n;
const step = (view, id) => view.steps.find((item) => item.id === id);
const doneOf = (view) => Object.fromEntries(view.steps.map((item) => [item.id, item.done]));
const position = (f, id) => f.platform.get('SELECT x,y,z,world_id,yaw,pitch FROM agents WHERE id=?', id);
const standAt = (f, id, x, y) => f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', x, y, id);
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
  place(f, 'alice', alice, event, RESTORATION_PLACEMENT_STEP.slots[0]);
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
  // Three planned placements complete the shared ground step.
  for (const slot of RESTORATION_PLACEMENT_STEP.slots) place(f, 'alice', alice, event, slot);
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
  assert.ok(encounter.actions.length > 0);
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
  assert.ok(encounter.actions.length > 0);
  await expectServed(t, f, encounter.actions.map((item) => item.route));
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
  // The membership is counted for the viewer's own keep step — and for no other — so the shared
  // restore step is complete: the viewer has counted work and another operator takes part.
  const block = guide(f, 'alice', alice).restoration;
  const actor = block.actors.find((item) => item.agent_id === alice.id);
  assert.deepEqual(actor.contributions, [{ step_id: 'keep', counted: 1, standing: null }]);
  assert.deepEqual(block.viewer.steps.map((item) => [item.step_id, item.my_counted]), [['ground', 0], ['beds', 0], ['light', 0], ['keep', 1]]);
  assert.equal(step(guide(f, 'alice', alice), 'restore').done, true);

  // One placement is counted for the ground step alone, never for the other three.
  f.tx('callingSelect', f.actor('bob'), { agent_id: bob.id, calling_id: 'builder' });
  place(f, 'bob', bob, event, RESTORATION_PLACEMENT_STEP.slots[0]);
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
