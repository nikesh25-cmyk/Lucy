import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { reticleText, controlHint } from '../src/camera-controls.js';
import { promptModel, createInteractionPrompt } from '../src/ui/interaction-prompt.js';

const door = {
  kind: 'door', label: 'Door', name: 'Meeting Hall', x: 11, y: 6,
  distance: 1, in_range: true, can_act: true, blocked_by: null,
  hint: 'Door at 11, 6 · Enter Meeting Hall · stand beside the doorway — Manhattan distance 1.',
  next_step: 'Use the interaction control, or press Enter, Space or I.',
  requirement: 'stand beside the doorway — Manhattan distance 1',
  action: { id: 'travel', label: 'Enter Meeting Hall', route: 'POST /travel' },
};

test('compact game aim keeps saved orientation and position without the empty-pick or keyboard manual', () => {
  const input = { firstPerson: true, facing: { yaw: 0 }, position: { x: 10, y: 6, z: 0 } };
  assert.equal(reticleText({ ...input, compact: true }), 'First person · facing north · at 10, 6');
  const full = reticleText(input);
  assert.match(full, /layer 0/);
  assert.match(full, /no tile picked yet/);
  assert.match(full, /WASD walks/);
  assert.match(reticleText({ ...input, compact: true, position: { x: 10, y: 6, z: 2 } }), /layer 2/);
  const picked = reticleText({ ...input, compact: true, fixture: door, selection: { x: 11, y: 6, type: 'portal' } });
  assert.match(picked, /Enter Meeting Hall with Enter, Space or I/);
  assert.doesNotMatch(picked, /aimed at|Manhattan|no tile picked/);
  assert.match(reticleText({ ...input, compact: true, selection: { x: 9, y: 6, type: 'block' }, blocked: true }), /solid, walk around it/);
});

test('the compact game control line offers help while the default still lists every keyboard alternative', () => {
  assert.equal(controlHint({ compact: true, playing: true, mode: 'first-person' }), 'WASD to walk · Drag to look · More for controls');
  assert.equal(controlHint({ compact: true, playing: false }), 'Drag to look · Click the map to explore');
  assert.match(controlHint({ playing: true, mode: 'first-person' }), /Q\/E turn · R\/F tilt · arrow keys also walk · V switches view · Enter, Space or I to interact/);
});

test('compact ordinary prompts use the server action and honest approach wording; detail remains available', () => {
  const ready = promptModel({ fixture: door }, { compact: true });
  assert.equal(ready.text, 'Enter Meeting Hall · Interact');
  assert.equal(ready.requirement, door.requirement);
  assert.equal(ready.next_step, door.next_step);
  assert.equal(promptModel({ fixture: door }).text, door.hint);
  const far = { ...door, in_range: false, can_act: false, distance: 7, blocked_by: 'out_of_range' };
  assert.equal(promptModel({ fixture: far }, { compact: true }).text, 'Enter Meeting Hall · Move closer');
  assert.equal(promptModel({}, { compact: true }).visible, false);
  const resident = promptModel(null, { compact: true, focusKind: 'resident', focused: { name: 'River', x: 10, y: 6, distance: 1 } });
  assert.equal(resident.text, 'Speak to River · Interact');
});

test('compact mode preserves blocked hints and refusal alerts exactly', () => {
  for (const blocked_by of ['platform_paused', 'revoked', 'another_world', 'inspect_only', 'unknown']) {
    const fixture = { ...door, can_act: false, blocked_by, hint: `Server explains ${blocked_by}.` };
    assert.equal(promptModel({ fixture }, { compact: true }).text, fixture.hint);
  }
  const refusal = { hint: 'The world is paused.', next_step: 'Try again when an administrator resumes it.' };
  const compact = promptModel({ fixture: door }, { compact: true, refusal });
  assert.equal(compact.text, `${refusal.hint} ${refusal.next_step}`);
  assert.equal(compact.role, 'alert');
  assert.equal(compact.ariaLive, 'assertive');
});

test('the same controller switches between game and detailed workspace hints without another read or write', async () => {
  let game = true, reads = 0, writes = 0;
  const controller = createInteractionPrompt({ compact: () => game, transport: {
    interactRead: async () => { reads++; return { fixture: door }; },
    interactWrite: async () => { writes++; },
  } });
  await controller.refresh();
  assert.equal(controller.prompt().text, 'Enter Meeting Hall · Interact');
  game = false;
  assert.equal(controller.prompt().text, door.hint);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test('the real shell assigns action ownership only when the local game HUD is mounted', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function mountTouchControls(');
  const end = app.indexOf('\n// ---------------------------------------------------------------------------------------------', start);
  const code = app.slice(start, end);
  for (const [gamePresentation, hasHud] of [[true,true],[true,false],[false,true],[false,false]]) {
    let owner = null, received = null, synchronized = 0;
    const quickbar = { name: 'local quickbar' };
    const scope = { state: { gamePresentation, graphics: 'voxel' }, touchControls: null,
      window: { matchMedia() {}, innerWidth: 390, innerHeight: 844 }, document: {},
      createTouchControls(options) { received = options; return { root: { classList: { toggle(name,on) { owner = { name,on }; } } }, avoidQuickbar() {} }; },
      syncTouchEnabled() { synchronized++; },
    };
    vm.createContext(scope);
    vm.runInContext(`${code}\nthis.mount = mountTouchControls;`, scope);
    scope.mount({ querySelector(selector) { return hasHud && ['.game-quickbar','.game-hud-bottom'].includes(selector) ? quickbar : null; } }, {}, {}, null);
    assert.equal(owner.name, 'nm-touch-hud-owned');
    assert.equal(owner.on, gamePresentation && hasHud, 'a missing HUD must retain the pad actions');
    assert.equal(received.quickbar, hasHud ? quickbar : null, 'the detached map supplies its own HUD for overlap measurement');
    assert.equal(synchronized, 1, 'existing enable/disable synchronization remains in place');
  }
});
