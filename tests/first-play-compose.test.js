import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstPlayGuide, guideCards, guideModel } from '../src/ui/first-play-guide.js';

test('the encounter renders the server reply expectation as accessible text', () => {
  const note = 'Your private message is saved. A reply may wait until the operator runs this resident.';
  const model = guideModel({ encounter: { kind: 'agent', name: 'Mira', role_label: 'Cultivator',
    response_availability: 'unconfirmed', response_note: note, actions: [] } });
  const card = guideCards(model).encounter;
  assert.equal(model.encounter.response_availability, 'unconfirmed');
  assert.equal(card.children.find((child) => child.attrs?.['data-guide'] === 'encounter-response')?.text, note);
});

test('an encounter opens a text composer without posting a blank message or claiming completion', async () => {
  const writes = [], composed = [], changes = [];
  const guide = createFirstPlayGuide({
    transport: async (...args) => { writes.push(args); return { id: 'unexpected' }; },
    onCompose: async (action) => { composed.push(action); },
    onChange: () => changes.push('repaint'),
  });
  const snapshot = { next_step: { id: 'meet', actions: [] }, progress: { done: 2, total: 5 } };
  guide.update(snapshot);
  const action = { id: 'meet-nearest', route: '/messages', method: 'POST', requires_input: true, body: { agent_id: 'viewer', channel: 'private', recipient_id: 'resident' } };
  const result = await guide.activate(action);
  assert.deepEqual(result, { ok: true, composing: true });
  assert.deepEqual(composed, [action]);
  assert.deepEqual(writes, []);
  assert.equal(guide.model().progress.done, 2);
  assert.equal(guide.model().confirmation, null);
  assert.deepEqual(changes, [], 'opening a composer preserves focus instead of repainting the guide');
});

test('a refused guide action stays readable through a repaint and dismissal resets on sign-out', async () => {
  let changes = 0;
  const guide = createFirstPlayGuide({
    transport: async () => { throw Object.assign(new Error('The world is paused.'), { status: 403 }); },
    onChange: () => { changes++; },
  });
  const snapshot = { next_step: { id: 'restore', actions: [] } };
  guide.update(snapshot);
  const result = await guide.activate({ id: 'join', route: '/restoration/join', body: {} });
  assert.equal(result.ok, false);
  guide.update(snapshot);
  assert.match(guide.model().error.message, /paused/);
  assert.equal(changes, 1);
  guide.dismiss();
  assert.equal(guide.dismissed, true);
  guide.reset();
  assert.equal(guide.dismissed, false);
  assert.equal(guide.model().ready, false);
});
