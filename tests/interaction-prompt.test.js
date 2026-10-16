// The contextual interaction prompt: the small prompt, the keyboard map and the compact overlays.
//
// These are the pure halves of the component — the prompt and overlay models, the payloads built
// only from the server's own fixture description, the keyboard mapping, and the tiny DOM painter.
// Driving the real routes is `tests/interaction-prompt-http.test.js`; driving a real browser is the
// job of the four UI owners and `npm run browser`, which this task does not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INTERACTION_KEYS, DISMISS_KEY, CYCLE_KEYS, FIXTURE_KEYBOARD, keyboardMap, keyIntent,
  payloadFor, defaultChoice, optionValue, messagePayload, nearbyEntries,
  promptModel, overlayModel, refusalModel, confirmationMessage,
  createInteractionPrompt, paintPrompt, paintOverlay,
} from '../src/ui/interaction-prompt.js';

const source = readFileSync(fileURLToPath(new URL('../src/ui/interaction-prompt.js', import.meta.url)), 'utf8');

// A fixture description in exactly the shape the server's own GET /interact returns for a fixture.
const doorFixture = {
  kind: 'door', label: 'Door', name: 'Meeting Hall', x: 11, y: 6, distance: 1, in_range: true,
  can_act: true, blocked_by: null, requirement: 'stand on or beside the doorway — Manhattan distance 1',
  hint: 'Door at 11, 6 · Enter Meeting Hall · stand on or beside the doorway — Manhattan distance 1 · you are 1 tile away, so you can use it now.',
  next_step: 'Available now. Use the interaction control, or press Enter, Space or I on the aimed tile.',
  action: { id: 'travel', label: 'Enter Meeting Hall', route: 'POST /api/v1/agents/:id/travel', scope: null, options: [] },
};
const cropFixture = {
  kind: 'crop_patch', label: 'Crop patch', name: 'Crop patch', x: 8, y: 7, distance: 1, in_range: true,
  can_act: true, blocked_by: null, requirement: 'stand on or beside the crop patch — Manhattan distance 1',
  hint: 'Crop patch at 8, 7 · Plant a crop · stand on or beside the crop patch — Manhattan distance 1 · you are 1 tile away, so you can use it now.',
  next_step: 'Available now. Use the interaction control, or press Enter, Space or I on the aimed tile.',
  action: {
    id: 'garden', label: 'Plant a crop', route: 'POST /api/v1/journey/garden', scope: 'build',
    options: [{ action: 'plant', kind: 'herbs', label: 'Plant herbs (30 minutes)' }, { action: 'plant', kind: 'fiber', label: 'Plant fiber (15 minutes)' }, { action: 'plant', kind: 'wood', label: 'Plant wood (60 minutes)' }],
  },
};
const craftFixture = {
  kind: 'crafting_station', label: 'Crafting station', name: 'Crafting station', x: 5, y: 11, distance: 1, in_range: true,
  can_act: true, blocked_by: null, requirement: 'stand on or beside the crafting station — Manhattan distance 1',
  hint: 'Crafting station at 5, 11 · Craft a keepsake · stand on or beside the crafting station — Manhattan distance 1 · you are 1 tile away, so you can use it now.',
  next_step: 'Available now. Use the interaction control, or press Enter, Space or I on the aimed tile.',
  action: {
    id: 'craft', label: 'Craft a keepsake', route: 'POST /api/v1/journey/craft', scope: 'build',
    options: [{ recipe_id: 'flower_crown', label: 'Flower crown — 2 herbs + 1 fiber', available: false }, { recipe_id: 'woven_band', label: 'Woven band — 1 fiber', available: true }],
  },
};

test('every fixture kind has a keyboard equivalent, and the map is one data structure', () => {
  const map = keyboardMap();
  const byKind = Object.fromEntries(map.map((entry) => [entry.kind, entry]));
  assert.deepEqual(Object.keys(byKind).sort(), ['ambassador_desk', 'bench', 'crafting_station', 'crop_patch', 'door', 'resident']);
  assert.deepEqual(
    Object.fromEntries(map.map((entry) => [entry.kind, entry.action])),
    { door: 'travel', crop_patch: 'garden', bench: 'posture', crafting_station: 'craft', ambassador_desk: 'talk', resident: 'message' },
  );
  for (const entry of map) {
    assert.deepEqual(entry.keys, ['Enter', ' ', 'i'], `${entry.kind} keeps the shipped keys`);
    assert.match(entry.route, /^POST \/api\/v1\//);
    assert.equal(typeof entry.use, 'string');
    assert.equal(typeof entry.submit, 'string');
  }
  // A conversation and an activity open an overlay; a door and a bench perform directly.
  assert.equal(FIXTURE_KEYBOARD.door.overlay, null);
  assert.equal(FIXTURE_KEYBOARD.bench.overlay, null);
  assert.equal(FIXTURE_KEYBOARD.crop_patch.overlay, 'activity');
  assert.equal(FIXTURE_KEYBOARD.crafting_station.overlay, 'activity');
  assert.equal(FIXTURE_KEYBOARD.ambassador_desk.overlay, 'conversation');
  assert.equal(FIXTURE_KEYBOARD.resident.overlay, 'conversation');
});

test('the interaction keys use the focused fixture and never replace walking, turning or building', () => {
  assert.deepEqual([...INTERACTION_KEYS], ['Enter', ' ', 'i']);
  for (const key of INTERACTION_KEYS) assert.deepEqual(keyIntent(key, { focused: true }), { kind: 'activate' }, `${key} uses the focused fixture`);
  // With nothing focused the keys stay unbound, so a walker who is not using a fixture is unaffected.
  for (const key of [...INTERACTION_KEYS, 'w', 'q', 'r', '3', 'Tab']) assert.equal(keyIntent(key, { focused: false }), null);
  assert.deepEqual(keyIntent(CYCLE_KEYS.next, {}), { kind: 'cycle', direction: 1 });
  assert.deepEqual(keyIntent(CYCLE_KEYS.previous, {}), { kind: 'cycle', direction: -1 });
});

test('an open overlay owns the keyboard, so no gameplay shortcut fires underneath it', () => {
  assert.deepEqual(keyIntent(DISMISS_KEY, { overlayOpen: true }), { kind: 'dismiss' });
  for (const key of ['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', '3', 'Enter', ' ']) {
    assert.deepEqual(keyIntent(key, { overlayOpen: true }), { kind: 'overlay', key }, `${key} stays inside the overlay`);
  }
  // Tab keeps its native meaning, so the overlay never traps focus.
  assert.equal(keyIntent('Tab', { overlayOpen: true }), null);
});

test('the prompt is a plain-text live region naming the server’s own fixture line', () => {
  const model = promptModel({ fixture: doorFixture });
  assert.equal(model.visible, true);
  assert.equal(model.kind, 'door');
  assert.equal(model.role, 'status');
  assert.equal(model.ariaLive, 'polite');
  assert.equal(model.tabIndex, 0);
  assert.equal(model.text, doorFixture.hint, 'the hint is the server’s, verbatim');
  assert.equal(model.next_step, doorFixture.next_step);
  assert.equal(model.placement.pointerEvents, 'none', 'the prompt never covers the world');
  assert.equal(model.placement.maxLines, 1);
  assert.deepEqual(model.keys, ['Enter', ' ', 'i']);
  assert.equal(/[<>]/.test(model.text), false, 'the prompt is text, never markup');
  // No fixture at all is an honest empty state, not a fabricated one.
  const empty = promptModel({ hint: 'Pick a tile in The Commons to read what it offers.' });
  assert.equal(empty.visible, false);
  assert.equal(empty.kind, 'none');
});

test('a refusal is a live alert that never reads as an accomplished action', () => {
  const refusal = refusalModel({ status: 409, message: 'Door at 35, 24: alice avatar is 43 tiles away.', body: { error: 'Door at 35, 24: alice avatar is 43 tiles away.', hint: 'Door at 35, 24 · Door at 35, 24: alice avatar is 43 tiles away. · Step onto or beside 35, 24.', next_step: 'Step onto or beside 35, 24 — within 1 tile of it — and use it again.' } }, { kind: 'door', label: 'Door', name: 'Meeting Hall', x: 35, y: 24 });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.accomplished, false);
  assert.equal(refusal.status, 409);
  assert.equal(refusal.role, 'alert');
  assert.match(refusal.next_step, /Step onto or beside 35, 24/);
  const model = promptModel({ fixture: doorFixture }, { refusal });
  assert.equal(model.role, 'alert');
  assert.equal(model.ariaLive, 'assertive');
  assert.match(model.text, /Step onto or beside 35, 24/);
});

test('a payload is built only from the server’s own fixture description', () => {
  assert.deepEqual(payloadFor(doorFixture), { x: 11, y: 6, action: 'travel' });
  assert.deepEqual(payloadFor({ ...doorFixture, kind: 'bench', action: { id: 'posture' } }), { x: 11, y: 6, action: 'posture', posture: 'sitting' });
  // No crop is growing, so the first offered option — the plant — is chosen.
  assert.deepEqual(payloadFor(cropFixture), { x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'herbs' });
  assert.deepEqual(payloadFor(cropFixture, { choice: 'plant:wood' }), { x: 8, y: 7, action: 'garden', garden_action: 'plant', kind: 'wood' });
  // Once a harvest is available it is offered first.
  const ready = defaultChoice({ kind: 'crop_patch', action: { options: [{ action: 'tend', label: 't' }, { action: 'harvest', label: 'h', available: true }] } });
  assert.equal(ready, 'harvest');
  // A craft picks the first recipe whose ingredients are held.
  assert.deepEqual(payloadFor(craftFixture), { x: 5, y: 11, action: 'craft', recipe_id: 'woven_band' });
  assert.deepEqual(payloadFor({ ...craftFixture, kind: 'ambassador_desk', action: { id: 'talk', options: [] } }, { question: 'What can we research here?' }), { x: 5, y: 11, action: 'talk', question: 'What can we research here?' });
  assert.equal(optionValue({ action: 'plant', kind: 'herbs' }), 'plant:herbs');
  assert.equal(optionValue({ recipe_id: 'flower_crown' }), 'flower_crown');
  assert.deepEqual(messagePayload('hello nearby'), { channel: 'nearby', text: 'hello nearby' });
});

test('nearby entries combine the server’s fixtures with the residents the caller supplies', () => {
  const view = { nearby: [{ kind: 'door', label: 'Door', name: 'Meeting Hall', x: 11, y: 6, distance: 1, in_range: true }, { kind: 'bench', label: 'Bench', name: 'Bench', x: 12, y: 7, distance: 2, in_range: false }] };
  const entries = nearbyEntries(view, [{ id: 'b1', name: 'Bob', x: 12, y: 6, distance: 2 }]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.type), ['fixture', 'fixture', 'resident']);
  assert.equal(entries[2].name, 'Bob');
  assert.equal(entries[2].in_range, true, 'a resident the caller has already placed nearby is offered');
});

test('the overlay is a non-modal conversation or activity, dismissible by Escape and a labelled control', () => {
  const activity = overlayModel(cropFixture, { resident: true });
  assert.equal(activity.open, true);
  assert.equal(activity.kind, 'activity');
  assert.equal(activity.role, 'dialog');
  assert.equal(activity.modal, false);
  assert.equal(activity.ariaModal, 'false');
  assert.equal(activity.suspendsShortcuts, true);
  assert.deepEqual(activity.dismissKeys, ['Escape']);
  assert.equal(activity.dismiss.label, 'Close');
  assert.deepEqual(activity.focus, { initial: 'first-control', returnTo: 'prompt' });
  const choice = activity.controls.find((control) => control.type === 'choice');
  assert.ok(choice, 'an activity offers a server-defined choice');
  assert.deepEqual(choice.options.map((option) => option.value), ['plant:herbs', 'plant:fiber', 'plant:wood']);
  assert.equal(choice.value, 'plant:herbs', 'the first offered option is preselected');
  // A recipe the resident cannot yet craft is shown disabled rather than hidden.
  const crafting = overlayModel(craftFixture, { resident: true });
  const recipes = crafting.controls.find((control) => control.type === 'choice');
  assert.equal(recipes.options.find((option) => option.value === 'flower_crown').disabled, true);
  assert.equal(recipes.options.find((option) => option.value === 'woven_band').disabled, false);
  assert.equal(recipes.value, 'woven_band');
  const conversation = overlayModel({ ...craftFixture, kind: 'ambassador_desk', label: 'Country ambassador desk', name: 'Nepal', action: { id: 'talk', label: 'Talk to Nepal', options: [] } }, { resident: true });
  assert.equal(conversation.kind, 'conversation');
  assert.match(conversation.title, /Nepal/);
  assert.equal(conversation.controls.some((control) => control.type === 'text' && control.name === 'question'), true);
});

test('a driver with no acting resident gets a disabled submit, since the server would refuse anyway', () => {
  const overlay = overlayModel(cropFixture, { resident: false });
  assert.equal(overlay.controls.find((control) => control.type === 'submit').disabled, true);
});

test('the confirmation is composed from server fields only', () => {
  assert.equal(confirmationMessage({ interaction: { kind: 'door', x: 11, y: 6 }, result: { world_id: 'hall' } }), 'Entered hall.');
  assert.equal(confirmationMessage({ interaction: { kind: 'bench', x: 12, y: 7 }, result: { posture: 'sitting' } }), 'Sitting on the bench at 12, 7.');
  assert.equal(confirmationMessage({ interaction: { kind: 'crafting_station' }, result: { crafted: 'flower_crown' } }), 'Crafted flower_crown.');
  assert.equal(confirmationMessage({ interaction: { kind: 'crop_patch', x: 8, y: 7 }, result: { crop: { kind: 'herbs' } } }), 'Planted herbs at 8, 7.');
  assert.equal(confirmationMessage({ interaction: { kind: 'ambassador_desk', name: 'Nepal' }, result: { ambassador_id: 'amb-NPL' } }), 'Asked Nepal.');
  assert.equal(confirmationMessage({ interaction: { kind: 'resident' }, result: { id: 'm1' } }), 'Said that to the residents nearby.');
});

test('the module never injects markup', () => {
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /\.html\s*=/);
});

// A deliberately tiny DOM: only what the painters use, so the accessibility contract is asserted on
// created nodes rather than on a rendered page.
class FakeElement {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.className = ''; this.id = ''; this.type = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) { for (const handler of this.listeners[type] || []) handler({ preventDefault() {}, ...event }); }
}
const fakeDocument = { createElement: (tag) => new FakeElement(tag) };
const find = (node, tag) => {
  if (node.tagName === tag) return node;
  for (const child of node.children || []) { const hit = find(child, tag); if (hit) return hit; }
  return null;
};

test('the painter creates an accessible live region with textContent and no markup', () => {
  const host = new FakeElement('div');
  const node = paintPrompt(host, promptModel({ fixture: doorFixture }), { document: fakeDocument });
  assert.equal(host.hidden, false);
  assert.equal(node.tagName, 'P');
  assert.equal(node.getAttribute('role'), 'status');
  assert.equal(node.getAttribute('aria-live'), 'polite');
  assert.equal(node.getAttribute('aria-atomic'), 'true');
  assert.equal(node.getAttribute('tabindex'), '0');
  assert.equal(node.textContent, doorFixture.hint);
  assert.equal(node.children.length, 0);
  // Nothing drawn is markup: the text node holds the raw server string.
  assert.equal(node.textContent, 'Door at 11, 6 · Enter Meeting Hall · stand on or beside the doorway — Manhattan distance 1 · you are 1 tile away, so you can use it now.');
});

test('the overlay painter renders a dismissible, non-modal dialog and collects its values', () => {
  const host = new FakeElement('div');
  let submitted = null, dismissed = false;
  paintOverlay(host, overlayModel(cropFixture, { resident: true }), { document: fakeDocument, onDismiss: () => { dismissed = true; }, onSubmit: (values) => { submitted = values; } });
  const panel = host.children[0];
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'false');
  const close = find(panel, 'BUTTON');
  assert.equal(close.type, 'button');
  close.dispatch('click');
  assert.equal(dismissed, true, 'the labelled Close control dismisses the overlay');
  const select = find(panel, 'SELECT');
  assert.ok(select, 'an activity paints its labelled choice');
  select.value = 'plant:wood';
  const form = find(panel, 'FORM');
  form.dispatch('submit');
  assert.deepEqual(submitted, { choice: 'plant:wood' });
});
