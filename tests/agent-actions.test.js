import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_LIMITS, authorizeAction, observationPrompt, parseAction } from '../runtime/agent.js';

const OBSERVATION_MARKER = 'WORLD OBSERVATIONS:\n';
const observations = (prompt) => JSON.parse(prompt.split(OBSERVATION_MARKER)[1]);
const status = (scopes) => ({ agent_id: 'fixture-agent', scopes, expires_at: Date.now() + 60000, remaining_calls: 100, paused: false });
const ALL_SCOPES = ['read', 'move', 'chat', 'contribute', 'build'];

// One observation with every new action usable: a bench the resident already stands beside, a
// neighbour the server marked as a different operator's, herbs on the shelf and one open project.
function actionView(overrides = {}) {
  return {
    world: { id: 'commons', name: 'Commons', kind: 'commons', width: 20, height: 14 },
    own_home: null, portals: [], landmarks: [], camera: { x: 0, y: 0 }, bounds: { columns: 20, rows: 14 },
    terrain: [], scenery: [], objects: [{ type: 'bench', x: 4, y: 4 }], messages: [],
    participants: [
      { id: 'fixture-agent', name: 'Self', kind: 'agent', status: 'active', x: 4, y: 5, z: 0, operator_id: 'operator-one' },
      { id: 'neighbour', name: 'Neighbour', kind: 'agent', status: 'active', x: 5, y: 5, z: 0, different_operator: true },
    ],
    journey: { agent_id: 'fixture-agent', inventory: [{ kind: 'herbs', quantity: 3 }], crops: [], recipes: [] },
    guilds: { viewer_agent_id: 'fixture-agent', total: 1, projects: [{ id: 'project-one', guild_id: 'explorer', guild_name: 'Wayfarers', title: 'A shared map', summary: 'Trace one route.', status: 'open', visibility: 'public', participation: { joined: false, state: null, role: null } }] },
    ...overrides,
  };
}
const participant = (overrides) => ({ id: 'fixture-agent', name: 'Self', kind: 'agent', status: 'active', x: 4, y: 5, z: 0, operator_id: 'operator-one', ...overrides });

test('each new action parses to exactly one bounded shape', () => {
  assert.deepEqual(parseAction('{"action":"inspect","x":4,"y":4}'), { action: 'inspect', x: 4, y: 4 });
  assert.deepEqual(parseAction({ action: 'survey' }), { action: 'survey' });
  assert.deepEqual(parseAction({ action: 'sit', x: 4, y: 4 }), { action: 'sit', x: 4, y: 4 });
  assert.deepEqual(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 2 }),
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 2 });
  assert.deepEqual(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'flower_crown', quantity: 1, note: '  A gift for the map.  ' }),
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'flower_crown', quantity: 1, note: 'A gift for the map.' });
  assert.deepEqual(parseAction({ action: 'guild', project_id: 'project-one', intent: 'join' }), { action: 'guild', project_id: 'project-one', intent: 'join' });
  assert.deepEqual(parseAction({ action: 'guild', project_id: 'project-one', intent: 'leave' }), { action: 'guild', project_id: 'project-one', intent: 'leave' });
});

test('a new action cannot smuggle an identity, a price, a coin path or an extra field', () => {
  for (const raw of [
    { action: 'inspect', x: 4 },
    { action: 'inspect', x: 4, y: 4, agent_id: 'other' },
    { action: 'inspect', x: -1, y: 4 }, { action: 'inspect', x: 4, y: 2.5 }, { action: 'inspect', x: 300, y: 4 },
    { action: 'survey', limit: 50 }, { action: 'survey', world_id: 'elsewhere' },
    { action: 'sit', x: 4, y: 4, posture: 'meditating' }, { action: 'sit', x: 4, y: 4, agent_id: 'other' },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs' },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1, coins: 5 },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1, price: 3 },
    { action: 'offer', recipient_agent_id: 'https://evil.invalid', kind: 'herbs', quantity: 1 },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'diamonds', quantity: 1 },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 0 },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: ACTION_LIMITS.offer_quantity + 1 },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1, note: '' },
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1, note: 'x'.repeat(ACTION_LIMITS.offer_note + 1) },
    { action: 'guild', project_id: 'project-one' },
    { action: 'guild', project_id: 'project-one', intent: 'archive' },
    { action: 'guild', project_id: 'project-one', intent: 'join', role: 'organiser' },
    { action: 'guild', project_id: 'project-one', intent: 'join', agent_id: 'other' },
  ]) assert.throws(() => parseAction(raw), /Invalid model action/, JSON.stringify(raw));
});

test('every new action is refused without the scope it needs', () => {
  const view = actionView();
  const refuses = (action, scopes) => assert.throws(() => authorizeAction(action, view, status(scopes)), /Action exceeds the observed world or granted permissions/, `${action.action} with ${scopes.join('+') || 'no scope'}`);
  // A read needs `read`; sitting and standing at a bench need `move`; an offer and a participation
  // need `contribute`. Nothing here can be reached with the read scope alone.
  refuses(parseAction({ action: 'inspect', x: 4, y: 4 }), []);
  refuses(parseAction({ action: 'survey' }), []);
  refuses(parseAction({ action: 'sit', x: 4, y: 4 }), ['read']);
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1 }), ['read', 'move', 'chat']);
  refuses(parseAction({ action: 'guild', project_id: 'project-one', intent: 'join' }), ['read', 'move', 'chat']);
  // Each one is approved once its own scope is granted, and never before.
  assert.deepEqual(authorizeAction(parseAction({ action: 'inspect', x: 4, y: 4 }), view, status(['read'])), { action: 'inspect', x: 4, y: 4 });
  assert.deepEqual(authorizeAction(parseAction({ action: 'survey' }), view, status(['read'])), { action: 'survey' });
  assert.deepEqual(authorizeAction(parseAction({ action: 'sit', x: 4, y: 4 }), view, status(['read', 'move'])), { action: 'sit', x: 4, y: 4 });
  assert.deepEqual(authorizeAction(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1 }), view, status(ALL_SCOPES)),
    { action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1 });
  assert.deepEqual(authorizeAction(parseAction({ action: 'guild', project_id: 'project-one', intent: 'join' }), view, status(ALL_SCOPES)),
    { action: 'guild', project_id: 'project-one', intent: 'join' });
});

test('a fixture, a resident or a project the observation does not show is refused before anything is sent', () => {
  const all = status(ALL_SCOPES), view = actionView();
  const refuses = (action, overrides) => assert.throws(() => authorizeAction(action, { ...view, ...overrides }, all), /Action exceeds the observed world or granted permissions/);
  // A tile with no observed fixture, and the same tile one step past the nearby radius.
  refuses(parseAction({ action: 'inspect', x: 9, y: 9 }), {});
  refuses(parseAction({ action: 'inspect', x: 14, y: 14 }), { objects: [{ type: 'bench', x: 14, y: 14 }] });
  refuses(parseAction({ action: 'sit', x: 4, y: 4 }), { objects: [], scenery: [], portals: [] });
  refuses(parseAction({ action: 'sit', x: 8, y: 4 }), { objects: [{ type: 'bench', x: 8, y: 4 }] });
  refuses(parseAction({ action: 'survey' }), { objects: [], scenery: [], portals: [], participants: [participant()] });
  // An offer to nobody, to a resident of the same operator, to an inactive resident, and one that
  // promises more than the shelf holds.
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'absent-resident', kind: 'herbs', quantity: 1 }), {});
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1 }), { participants: view.participants.map((item) => ({ ...item, different_operator: false })) });
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1 }), { participants: view.participants.map((item) => item.id === 'neighbour' ? { ...item, status: 'paused' } : item) });
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 4 }), {});
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'fiber', quantity: 1 }), {});
  refuses(parseAction({ action: 'offer', recipient_agent_id: 'neighbour', kind: 'herbs', quantity: 1 }), { journey: { agent_id: 'someone-else', inventory: [{ kind: 'herbs', quantity: 3 }] } });
  // A project that is not on the observed board, one that is closed, one already joined cannot be
  // joined again, and one this resident is not in cannot be left.
  refuses(parseAction({ action: 'guild', project_id: 'project-two', intent: 'join' }), {});
  refuses(parseAction({ action: 'guild', project_id: 'project-one', intent: 'join' }), { guilds: { ...view.guilds, projects: [{ ...view.guilds.projects[0], status: 'closed' }] } });
  refuses(parseAction({ action: 'guild', project_id: 'project-one', intent: 'join' }), { guilds: { ...view.guilds, projects: [{ ...view.guilds.projects[0], participation: { joined: true, state: 'active', role: 'member' } }] } });
  refuses(parseAction({ action: 'guild', project_id: 'project-one', intent: 'leave' }), {});
  refuses(parseAction({ action: 'guild', project_id: 'project-one', intent: 'leave' }), { guilds: { ...view.guilds, viewer_agent_id: 'someone-else' } });
});

test('the prompt advertises each new action only when the observation makes it usable', () => {
  const view = actionView(), all = status(ALL_SCOPES);
  const usable = observationPrompt(view, all);
  for (const shape of ['{"action":"survey"}', '{"action":"inspect","x":integer,"y":integer}', '{"action":"sit","x":integer,"y":integer}', '{"action":"offer",', '{"action":"guild",']) {
    assert.ok(usable.includes(shape), `${shape} must be offered when it is usable`);
  }
  const observed = observations(usable);
  assert.deepEqual(observed.fixtures, [{ kind: 'bench', name: 'Bench', x: 4, y: 4, distance: 1 }]);
  assert.equal(observed.guilds.viewer_agent_id, 'fixture-agent');
  assert.deepEqual(observed.guilds.projects, [{ id: 'project-one', guild_id: 'explorer', guild_name: 'Wayfarers', title: 'A shared map', summary: 'Trace one route.', status: 'open', visibility: 'public', participation: { joined: false, state: null, role: null } }]);
  assert.equal(Object.hasOwn(observed.guilds.projects[0], 'contributions'), false, 'no contribution history reaches the model');
  assert.equal(Object.hasOwn(observed.guilds.projects[0], 'participants'), false, 'no participant list reaches the model');

  // The same observation with no fixture, no shelf and no project advertises none of them.
  const barren = observationPrompt(actionView({
    objects: [], scenery: [], portals: [], participants: [participant()],
    journey: { agent_id: 'fixture-agent', inventory: [], crops: [], recipes: [] }, guilds: undefined,
  }), all);
  for (const shape of ['{"action":"survey"}', '{"action":"inspect"', '{"action":"sit"', '{"action":"offer"', '{"action":"guild"']) {
    assert.ok(!barren.includes(shape), `${shape} must not be offered when it is not usable`);
  }
  const empty = observations(barren);
  assert.equal(Object.hasOwn(empty, 'fixtures'), false);
  assert.equal(Object.hasOwn(empty, 'guilds'), false);

  // Without the contribute scope the offer and the participation are never advertised, even though
  // both are usable-looking; the read and the bench need their own scopes as well.
  const readOnly = observationPrompt(view, status(['read']));
  assert.match(readOnly, /\{"action":"survey"\}/);
  for (const shape of ['{"action":"sit"', '{"action":"offer"', '{"action":"guild"']) assert.ok(!readOnly.includes(shape), `${shape} must not be offered without its scope`);
  const noMove = observationPrompt(view, status(['read', 'contribute']));
  assert.ok(!noMove.includes('{"action":"sit"'), 'sitting needs the move scope');

  // The neighbour the shared world read does not mark as a different operator's is never offered.
  const sameOperator = observationPrompt(actionView({ participants: view.participants.map((item) => ({ ...item, different_operator: false })) }), all);
  assert.ok(!sameOperator.includes('{"action":"offer"'), 'an offer is only offered towards a different operator');
});

test('the prompt carries one bounded server reading and drops a reading of another world', () => {
  const read = {
    source: 'inspect', world_id: 'commons', decision: 4, required_distance: 1,
    fixture: { kind: 'bench', label: 'Bench', name: 'Bench', x: 4, y: 4, distance: 1, in_range: true, can_act: true, blocked_by: null,
      action: { id: 'posture', label: 'Sit on the bench', route: 'POST /api/v1/agents/:id/posture', scope: null, options: [] },
      requirement: 'stand on or beside the bench — Manhattan distance 1', hint: 'Bench at 4, 4', next_step: 'Available now.' },
    nearby: [{ kind: 'bench', label: 'Bench', x: 4, y: 4, distance: 1, in_range: true }], hint: 'Bench at 4, 4',
  };
  const prompt = observationPrompt({ ...actionView(), sighting: read }, status(ALL_SCOPES));
  assert.match(prompt, /The sighting below is the one server reading you asked for earlier/);
  const observed = observations(prompt);
  assert.equal(observed.sighting.source, 'inspect');
  assert.equal(observed.sighting.decision, 4);
  assert.equal(observed.sighting.fixture.kind, 'bench');
  assert.deepEqual(observed.sighting.nearby.map((item) => item.x), [4]);
  // A reading taken in another world is not a reading of this one and is never rendered.
  const elsewhere = observationPrompt({ ...actionView(), sighting: { ...read, world_id: 'elsewhere' } }, status(ALL_SCOPES));
  assert.equal(Object.hasOwn(observations(elsewhere), 'sighting'), false);
  assert.ok(!elsewhere.includes('The sighting below'));
});

test('a reading is never a model note: an inspect of an unobserved tile is refused even with a sighting', () => {
  const read = { source: 'survey', world_id: 'commons', decision: 2, fixture: null, nearby: [], hint: '', required_distance: 1 };
  const view = { ...actionView(), sighting: read };
  assert.throws(() => authorizeAction(parseAction({ action: 'inspect', x: 12, y: 12 }), view, status(ALL_SCOPES)), /permissions/);
  assert.throws(() => authorizeAction(parseAction({ action: 'sit', x: 12, y: 12 }), view, status(ALL_SCOPES)), /permissions/);
});
