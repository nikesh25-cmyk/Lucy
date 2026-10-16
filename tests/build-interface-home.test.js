// One placement interface for every buildable world: a garden, a cottage and the frontier.
//
// The pointer hotbar and the placement preview were mounted for `world.kind === 'frontier'` only, so
// the one thing a player most wants to do — build in their own home — had no pointing, no preview and
// no keyboard path. These tests pin the extension: the same components serve an object world, the
// preview shape follows the palette the server published, and every new surface is reachable without
// a pointer.
//
// Every payload is a real one from the real platform, so no palette, plot, grant, resident or bound
// in this file is invented here. The only browser-free DOM is the tiny one at the bottom, which
// refuses `innerHTML` exactly as `tests/build-interface.test.js` does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';
import {
  aimLineView, createHotbar, createPlacementPreview, hotbarModel, hoverTargetView, mount, paletteFor,
  placementModel, placementRulesFor,
} from '../src/ui/build-interface.js';

const source = readFileSync(fileURLToPath(new URL('../src/ui/build-interface.js', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------------------------
// A real platform: one resident with a garden, a cottage and a stewarded frontier plot.
// ---------------------------------------------------------------------------------------------
async function worlds(t) {
  const f = await fixture(t);
  const alice = f.agent('alice');
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A shared learning garden', description: 'Object-world fixture.' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 32, 32, alice.id);
  const home = () => f.platform.world(f.actor('alice'), { world_id: `home:${alice.id}`, agent_id: alice.id });
  const house = () => f.platform.world(f.actor('alice'), { world_id: `house:${alice.id}`, agent_id: alice.id });
  const frontier = () => f.platform.world(f.actor('alice'), { world_id: 'frontier:0:0', agent_id: alice.id });
  const move = (worldId, x, y) => f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', worldId, x, y, alice.id);
  const session = () => ({ agentId: alice.id, worldId: `home:${alice.id}`, player: alice });
  return { f, alice, home, house, frontier, move, session };
}

const tile = (x, y, z = 0) => ({ x, y, z, type: 'terrain', adjacent: { x, y, z } });

/** Terrain the world does not let a resident stand on (src/footprints.js). A test needs a legal tile. */
const BLOCKING_TERRAIN = new Set(['water', 'tree', 'building', 'fountain', 'wall']);

/** A tile inside the payload's own window that is walkable and holds nothing at all. */
function emptyTile(world) {
  const occupied = new Set([...(world.objects || []), ...(world.scenery || []), ...(world.participants || [])].map((item) => `${item.x},${item.y}`));
  const rows = world.terrain || [];
  for (let y = 0; y < rows.length; y += 1) {
    for (let x = 0; x < (rows[y] || []).length; x += 1) {
      const worldX = world.camera.x + x, worldY = world.camera.y + y;
      if (BLOCKING_TERRAIN.has(rows[y][x])) continue;
      if (occupied.has(`${worldX},${worldY}`)) continue;
      return { x: worldX, y: worldY };
    }
  }
  return { x: 0, y: 0 };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { for (const key of Object.keys(value)) deepFreeze(value[key]); Object.freeze(value); }
  return value;
};

// ---------------------------------------------------------------------------------------------
// The rules, from the payload alone.
// ---------------------------------------------------------------------------------------------
test('a garden is an object world: the rules and the palette both come from the payload', async t => {
  const { home } = await worlds(t);
  const world = home();
  const rules = placementRulesFor(world);
  assert.equal(rules.available, true);
  assert.equal(rules.kind, 'home');
  assert.equal(rules.shape, 'object');
  assert.equal(rules.preview, 'footprint');
  assert.equal(rules.maximum_z, 0, 'a garden places on the ground only');
  assert.deepEqual(rules.types, world.build_palette);
  assert.ok(rules.types.includes('farm'));
  assert.equal(Object.isFrozen(rules), true);
  assert.equal(Object.isFrozen(rules.types), true);
  // The reach is whatever the payload published — this world publishes none, and null says so
  // rather than inventing a number.
  assert.equal(rules.build_range, world.build_range ?? null);
  assert.equal(rules.reason, null);
});

test('a cottage is an object world with the cottage palette, and the two palettes are different', async t => {
  const { home, house } = await worlds(t);
  const garden = home();
  const cottage = house();
  const rules = placementRulesFor(cottage);
  assert.equal(rules.kind, 'house');
  assert.equal(rules.shape, 'object');
  assert.equal(rules.preview, 'footprint');
  assert.equal(rules.maximum_z, 0);
  assert.deepEqual(rules.types, cottage.build_palette);
  assert.notDeepEqual(rules.types, garden.build_palette, 'the payload publishes a different palette for each');
  assert.equal(paletteFor(cottage).shape, 'object');
});

test('the frontier keeps block rules unchanged: a layer range, geometry and the published reach', async t => {
  const { frontier } = await worlds(t);
  const world = frontier();
  const rules = placementRulesFor(world);
  assert.equal(rules.kind, 'frontier');
  assert.equal(rules.shape, 'block');
  assert.equal(rules.preview, 'geometry');
  assert.equal(rules.maximum_z, world.frontier.limits.maximum_z);
  assert.equal(rules.build_range, world.frontier.limits.build_range);
  assert.deepEqual(rules.types, world.frontier.palette);
  assert.equal(paletteFor(world).shape, 'block');
});

test('a world with no palette is described as unavailable rather than guessed at', () => {
  for (const world of [null, undefined, {}, { world: { kind: 'commons' } }, { world: { kind: 'home' } }]) {
    const rules = placementRulesFor(world);
    assert.equal(rules.available, false);
    assert.equal(rules.shape, null);
    assert.equal(rules.preview, null);
    assert.equal(rules.maximum_z, 0);
    assert.equal(rules.build_range, null);
    assert.deepEqual(rules.types, []);
    assert.match(rules.reason, /not available/i);
  }
});

test('the hotbar renders the same entry shape for objects as for blocks', async t => {
  const { home, house, frontier } = await worlds(t);
  const garden = home();
  const model = hotbarModel({ world: garden });
  assert.equal(model.available, true);
  assert.equal(model.shape, 'object');
  assert.equal(model.maximum_z, 0);
  assert.equal(model.plot, null, 'an object world has no plot');
  assert.equal(model.entries.every((entry) => entry.available), true);
  assert.equal(model.remove.available, true);
  assert.deepEqual(model.entries.map((entry) => entry.type), garden.build_palette);
  assert.deepEqual(model.entries.map((entry) => entry.key), garden.build_palette.map((_, index) => String(index + 1)));
  for (const entry of model.entries) {
    assert.equal(entry.kind, 'object');
    assert.ok(entry.label.length > 0);
    assert.equal(entry.reason, null);
    // The garden publishes no object cap in GET /world, so the count is honestly unknown.
    assert.equal(entry.remaining, null);
  }
  const cottage = hotbarModel({ world: house() });
  assert.deepEqual(cottage.entries.map((entry) => entry.type), house().build_palette);
  assert.equal(cottage.shape, 'object');
  // The frontier is unchanged: the same keys, the same labels, and now the server's own area count.
  const block = hotbarModel({ world: frontier() });
  assert.equal(block.shape, 'block');
  assert.equal(block.entries.every((entry) => entry.kind === 'block'), true);
  assert.equal(block.entries.every((entry) => entry.remaining === block.remaining), true);
});

// ---------------------------------------------------------------------------------------------
// The preview: a footprint for objects, geometry for blocks.
// ---------------------------------------------------------------------------------------------
test('the preview is a bounded footprint for an object and block geometry for a frontier tile', async t => {
  const { frontier, home, session } = await worlds(t);
  const garden = home();
  const spot = emptyTile(garden);
  const object = placementModel({ world: garden, pick: tile(spot.x, spot.y), session: { ...session(), kind: 'farm', player: { id: 'x', status: 'active' } } });
  assert.equal(object.preview.shape, 'footprint');
  assert.equal(object.preview.name, 'Farm');
  assert.deepEqual({ x: object.preview.x, y: object.preview.y }, spot);
  assert.deepEqual({ width: object.preview.width, height: object.preview.height }, { width: 1, height: 1 });
  assert.equal(object.preview.in_bounds, true);
  assert.equal(object.preview.state, 'unverified', 'no rule is claimed that the payload did not publish');
  assert.match(object.preview.state_text, /server decides/i);
  assert.equal(object.preview.existing, null);
  assert.equal(object.blocked, false);
  assert.equal(object.asserts.length, 0);
  assert.equal(object.rules.shape, 'object');

  const world = frontier();
  const block = placementModel({ world, pick: tile(32, 32), session: { kind: 'wood', player: { id: 'x', status: 'active' } } });
  assert.equal(block.preview.shape, 'block');
  assert.deepEqual({ x: block.preview.x, y: block.preview.y, z: block.preview.z }, { x: 32, y: 32, z: 0 });
  assert.equal(block.preview.maximum_z, world.frontier.limits.maximum_z);
  assert.equal(block.preview.occupied, false);
  assert.equal(block.maximum_z, world.frontier.limits.maximum_z, 'the frontier layer range is unchanged');
});

test('a resident the payload reports on the tile blocks the footprint and is named in the view', async t => {
  const { home, move, alice, session } = await worlds(t);
  const before = home();
  const spot = emptyTile(before);
  move(`home:${alice.id}`, spot.x, spot.y);
  const world = home();
  assert.equal(world.participants.some((person) => person.x === spot.x && person.y === spot.y), true, 'the payload itself reports the resident there');

  const model = placementModel({ world, pick: tile(spot.x, spot.y), session: { ...session(), kind: 'flowers', player: alice } });
  assert.equal(model.preview.shape, 'footprint');
  assert.equal(model.preview.state, 'blocked');
  assert.equal(model.preview.resident.name, alice.name);
  assert.equal(model.asserts.some((item) => item.code === 'resident' && item.source === 'world-payload'), true);
  assert.match(model.preview.state_text, /resident/i);

  const preview = createPlacementPreview({ api: async () => ({ x: spot.x, y: spot.y, removed: false }) });
  preview.update({ world, pick: tile(spot.x, spot.y), session: session() });
  preview.setKind('flowers');
  const tree = JSON.stringify(preview.view());
  assert.match(tree, /"data-footprint":"\d+,\d+"/);
  assert.match(tree, /"data-footprint-state":"blocked"/);
  assert.match(tree, /"data-footprint-size":"1x1"/);
  assert.match(tree, new RegExp(alice.name));
});

// ---------------------------------------------------------------------------------------------
// The write path: an object world uses the resident's own route.
// ---------------------------------------------------------------------------------------------
test('an object world places through the resident route the shell already uses, and offers no blueprint', async t => {
  const { home, alice, session } = await worlds(t);
  const world = home();
  const spot = emptyTile(world);
  const calls = [];
  const api = async (path, method, body) => { calls.push({ path, method, body }); return { world_id: `home:${alice.id}`, x: spot.x, y: spot.y, removed: false }; };
  const preview = createPlacementPreview({ api });
  preview.update({ world, pick: tile(spot.x, spot.y), session: session() });
  preview.setKind('farm');
  const outcome = await preview.confirm();
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/agents/${alice.id}/build`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { x: spot.x, y: spot.y, type: 'farm' });
  assert.match(JSON.stringify(preview.view()), /"data-saved":"1"/);

  // A blueprint is the frontier's own validation: no request is sent, and no control is offered.
  const guarded = [];
  const quiet = createPlacementPreview({ api: async (...args) => { guarded.push(args); return { valid: true }; } });
  quiet.update({ world, pick: tile(spot.x, spot.y), session: session() });
  quiet.setBlueprint('garden-shelter');
  assert.equal(await quiet.previewBlueprint(), null);
  assert.deepEqual(guarded, []);
  assert.doesNotMatch(JSON.stringify(quiet.view()), /data-preview/);
  assert.match(JSON.stringify(quiet.view()), /Place the object here/);
});

test('a garden refusal reaches the player verbatim, with the object wording the server uses', async t => {
  const { home, alice, session } = await worlds(t);
  const world = home();
  const spot = emptyTile(world);
  const preview = createPlacementPreview({ api: async () => { throw Object.assign(new Error('Keep the original cottage furniture clear.'), { status: 409 }); } });
  preview.update({ world, pick: tile(spot.x, spot.y), session: session() });
  preview.setKind('table');
  const outcome = await preview.confirm();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refusal.code, 'keep-clear');
  assert.equal(outcome.refusal.saved, false);
  const tree = JSON.stringify(preview.view());
  assert.match(tree, /Keep the original cottage furniture clear\./);
  assert.match(tree, /"data-refusal":"keep-clear"/);
  assert.doesNotMatch(tree, /"data-saved":"1"/);
  assert.ok(alice.id);
});

test('a removal in an object world asks the same route to remove, and never sends a type', async t => {
  const { home, alice, session } = await worlds(t);
  const calls = [];
  const preview = createPlacementPreview({ api: async (path, method, body) => { calls.push({ path, method, body }); return { x: 3, y: 3, removed: true }; } });
  preview.update({ world: home(), pick: tile(3, 3), session: session() });
  preview.setKind('remove');
  await preview.confirm();
  assert.equal(calls[0].path, `/agents/${alice.id}/build`);
  assert.deepEqual(calls[0].body, { x: 3, y: 3, remove: true });
});

// ---------------------------------------------------------------------------------------------
// The hover channel: reading a tile commits to nothing.
// ---------------------------------------------------------------------------------------------
test('hoverTargetView is pure and reports the server\'s own reasons without writing', async t => {
  const { frontier, home, move, alice, session } = await worlds(t);
  const world = deepFreeze(clone(frontier()));
  const selection = { kind: 'wood', mode: 'place' };
  const before = clone(world);
  const view = hoverTargetView({ world, selection, hover: tile(2, 2) });
  assert.deepEqual(clone(world), before, 'a frozen payload is unchanged: nothing was written');
  assert.deepEqual(clone(view), clone(hoverTargetView({ world: clone(world), selection: { ...selection }, hover: tile(2, 2) })), 'the same input gives the same reading');
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.reasons), true);
  assert.deepEqual(view.tile, { x: 2, y: 2, z: 0 });
  // The label is recomputed from the payload's own parcels, exactly as the reader would.
  const parcel = world.frontier.parcels.find((plot) => 2 >= plot.x && 2 < plot.x + plot.width && 2 >= plot.y && 2 < plot.y + plot.height);
  assert.equal(view.label, parcel ? `Plot of ${parcel.steward_name || 'no named steward'}` : 'Tile 2, 2');
  assert.equal(parcel.id, 'plot:0:0:0:0');
  assert.equal(view.action.id, 'place');
  assert.deepEqual([...view.action.keys], [...view.keys]);
  const codes = view.reasons.map((reason) => reason.code);
  assert.ok(codes.includes('no-grant'), 'the tile is in a plot nobody stewards for this resident');
  assert.ok(codes.includes('out-of-range'), `the resident is 64 tiles away; build_range is ${world.frontier.limits.build_range}`);
  for (const reason of view.reasons) {
    assert.ok(reason.reason && reason.next_step, `${reason.code} must carry a reason and a next step`);
    assert.equal(reason.source, 'world-payload');
  }

  // Nothing hovered is a plain reading, not an error.
  const empty = hoverTargetView({ world, selection, hover: null });
  assert.equal(empty.tile, null);
  assert.equal(empty.action, null);
  assert.deepEqual(empty.keys, []);
  assert.deepEqual(empty.reasons, []);

  // A garden tile a resident stands on reads as that resident, and says why it is blocked.
  const gardenBefore = home();
  const spot = emptyTile(gardenBefore);
  move(`home:${alice.id}`, spot.x, spot.y);
  const garden = home();
  const hovering = hoverTargetView({ world: garden, selection: { kind: 'flowers', mode: 'place' }, hover: tile(spot.x, spot.y) });
  assert.match(hovering.label, new RegExp(alice.name));
  assert.equal(hovering.reasons.some((reason) => reason.code === 'resident'), true);
  assert.equal(hovering.action.id, 'place');
  assert.deepEqual(hovering.action.keys, ['3', 'c'], 'flowers is the garden palette\'s third entry');
  assert.ok(session().agentId);
});

test('hoverTargetView reads a saved object, a passage and a block from the payload by name', async t => {
  const { frontier, home, house, f, alice, move } = await worlds(t);
  const before = home();
  const spot = emptyTile(before);
  const benchAt = { x: spot.x, y: spot.y };
  // Alice has to be in the garden for the server to let her shape it, and the saved object then
  // appears in the payload's own window, exactly as a player would find it.
  move(`home:${alice.id}`, 12, 12);
  f.tx('build', f.actor('alice'), alice.id, { type: 'bench', x: benchAt.x, y: benchAt.y });
  const withObject = home();
  assert.equal(withObject.objects.some((object) => object.x === benchAt.x && object.y === benchAt.y && object.type === 'bench'), true);
  assert.equal(hoverTargetView({ world: withObject, hover: tile(benchAt.x, benchAt.y) }).label, 'Bench');

  // The garden's own passages are reported by the payload, and reading one offers the enter action.
  const portalTile = withObject.portals[0];
  const portal = hoverTargetView({ world: withObject, hover: tile(portalTile.x, portalTile.y) });
  assert.equal(portal.label, portalTile.label);
  assert.equal(portal.action.id, 'enter');

  // A cottage's authored furniture is in the payload too, and it is what the world keeps clear.
  const cottage = house();
  const furniture = cottage.scenery.find((item) => item.blocks);
  assert.ok(furniture, 'the cottage payload reports its own blocking furniture');
  const held = placementModel({ world: cottage, pick: tile(furniture.x, furniture.y), session: { kind: 'table', player: alice } });
  assert.equal(held.preview.shape, 'footprint');
  assert.equal(held.preview.furniture.type, furniture.type);
  assert.equal(held.preview.state, 'blocked');
  assert.equal(held.asserts.some((item) => item.code === 'keep-clear' && item.source === 'world-payload'), true);
  assert.equal(hoverTargetView({ world: cottage, hover: tile(furniture.x, furniture.y) }).reasons.some((reason) => reason.code === 'keep-clear'), true);

  // A block in the frontier reads by type and layer, and says the cell is already built.
  move('frontier:0:0', 32, 32);
  f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id: 'frontier:0:0', type: 'wood', x: 33, y: 32, z: 0 });
  const built = frontier();
  assert.equal(built.blocks.some((block) => block.x === 33 && block.y === 32 && block.z === 0), true);
  const block = hoverTargetView({ world: built, hover: tile(33, 32) });
  assert.equal(block.label, 'Wood block · layer 0');
  assert.equal(block.reasons.some((reason) => reason.code === 'blocked-cell'), true);
});

// ---------------------------------------------------------------------------------------------
// Keyboard parity for the new surfaces.
// ---------------------------------------------------------------------------------------------
test('every new control has a keyboard path: the aim line, the object hotbar and the object preview', async t => {
  const { home, alice, session } = await worlds(t);
  const world = home();
  const spot = emptyTile(world);
  const selection = { kind: 'farm', mode: 'place' };
  const view = hoverTargetView({ world, selection, hover: tile(spot.x, spot.y) });
  assert.deepEqual([...view.keys], ['5', 'c'], 'the palette key for the fifth garden entry, then confirm');

  // Those keys are the module's own handleKey map, not decoration.
  const selected = [];
  const hotbar = createHotbar({ onSelect: (type) => selected.push(type) });
  hotbar.update({ world });
  assert.equal(hotbar.handleKey(view.keys[0]), true);
  assert.equal(hotbar.selected(), 'farm');
  assert.deepEqual(selected, ['farm']);

  const calls = [];
  const preview = createPlacementPreview({ api: async (path, method, body) => { calls.push({ path, body }); return { x: spot.x, y: spot.y }; } });
  preview.update({ world, pick: tile(spot.x, spot.y), session: session() });
  preview.setKind(hotbar.selected());
  assert.equal(preview.handleKey(view.keys[1]), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/agents/${alice.id}/build`);

  // The aim line is a focusable, announced element, so a keyboard reaches the reading a pointer gets.
  const aim = aimLineView(view);
  assert.equal(aim.attrs.tabindex, '0');
  assert.equal(aim.attrs.role, 'status');
  assert.equal(aim.attrs['aria-live'], 'polite');
  assert.equal(aim.attrs['data-aim-tile'], `${spot.x},${spot.y}`);
  const root = new FakeElement('div');
  mount(root, aim, fakeDocument());
  assert.match(root.textContent, /Farm at \d+, \d+/);
  assert.match(root.textContent, /press 5 or c/);

  // Nothing these surfaces render asks for motion, so prefers-reduced-motion has nothing to suppress
  // here: the state is text, colour and focus, and the aim line is a polite live region.
  assert.doesNotMatch(source, /transition|animation|scroll-behavior|smooth/);
});

test('mount renders the object preview and the hotbar with textContent only, never innerHTML', async t => {
  const { home, alice, session } = await worlds(t);
  const world = home();
  const spot = emptyTile(world);
  const hotbar = createHotbar({});
  hotbar.update({ world });
  const root = new FakeElement('div');
  mount(root, hotbar.view(), fakeDocument());
  const buttons = root.find((node) => node.tag === 'button' && node.attributes['data-build-kind'] === 'object');
  assert.equal(buttons.tag, 'button');
  assert.equal(root.find((node) => node.tag === 'button' && String(node.attributes['data-build-type']).length > 0) !== null, true);
  assert.match(root.textContent, /Remove my object/);
  assert.doesNotMatch(root.textContent, /Remove my block/);
  assert.ok(alice.id && session().agentId);
});

// ---------------------------------------------------------------------------------------------
// A tiny in-test DOM, as in tests/build-interface.test.js: it has only what `mount` uses and it
// throws if anything ever assigns innerHTML.
// ---------------------------------------------------------------------------------------------
class FakeText {
  constructor(text) { this.data = String(text); }
  get textContent() { return this.data; }
}
class FakeElement {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.attributes = {}; this.listeners = {}; this.value = undefined; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set innerHTML(_value) { throw new Error('innerHTML must never be assigned'); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const node of this.childNodes) if (node instanceof FakeElement) { const found = node.find(predicate); if (found) return found; }
    return null;
  }
}
const fakeDocument = () => ({ createElement: (tag) => new FakeElement(tag), createTextNode: (text) => new FakeText(text) });
