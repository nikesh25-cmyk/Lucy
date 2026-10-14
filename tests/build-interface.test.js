import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import {
  classifyRefusal, createHotbar, createPlacementPreview, grantFor, hotbarModel, mount, paletteFor, placementModel, plotAt, targetOf,
} from '../src/ui/build-interface.js';
import { createInventoryPanel, inventoryModel, recipeAvailability } from '../src/ui/inventory-panel.js';

// The repository has no browser automation and this task may not add a browser scenario, so the
// build and inventory interface is verified at two levels: the pure model that turns a server payload
// into what the player sees, and the view tree `mount` renders, using a tiny in-test DOM that refuses
// `innerHTML`. The HTTP suite (tests/build-interface-http.test.js) drives the same payloads and routes.

// ---------------------------------------------------------------------------------------------
// A real server payload, from the real platform, so no palette/plot/grant value is a test fixture
// invented here.
// ---------------------------------------------------------------------------------------------
async function frontierFixture(t) {
  const f = await fixture(t);
  const alice = f.agent('alice');
  const bob = f.agent('bob');
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A shared learning garden', description: 'A build-interface fixture.' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 32, 32, alice.id);
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'frontier:0:0', 34, 34, bob.id);
  return {
    f, alice, bob,
    aliceWorld: () => f.platform.world(f.actor('alice'), { world_id: 'frontier:0:0', agent_id: alice.id }),
    bobWorld: () => f.platform.world(f.actor('bob'), { world_id: 'frontier:0:0', agent_id: bob.id }),
  };
}
const tile = (x, y, z = 0) => ({ x, y, z, type: 'terrain', adjacent: { x, y, z } });
const blockPick = (x, y, z, face) => ({ x, y, z, type: 'block', block: { type: 'wood' }, adjacent: { x: x + face.x, y: y + face.y, z: z + face.z } });

// ---------------------------------------------------------------------------------------------
// The hotbar palette is the server's own payload.
// ---------------------------------------------------------------------------------------------
test('the hotbar palette is exactly the server-published frontier palette, never a hardcoded list', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const palette = paletteFor(world);
  assert.deepEqual(palette.types, world.frontier.palette);
  assert.equal(palette.kind, 'frontier');
  assert.equal(palette.maximum_z, world.frontier.limits.maximum_z);
  const model = hotbarModel({ world, pick: tile(32, 32) });
  assert.deepEqual(model.entries.map((entry) => entry.type), world.frontier.palette);
  assert.deepEqual(model.entries.map((entry) => entry.key), world.frontier.palette.map((_, index) => String(index + 1)), 'one number key per sealed block, in palette order');
  assert.equal(model.entries.every((entry) => entry.label), true);
  assert.ok(alice);
});

test('a home or cottage palette comes from the server build_palette and has no layers', async t => {
  const { f, alice } = await frontierFixture(t);
  const world = f.platform.world(f.actor('alice'), { world_id: `home:${alice.id}`, agent_id: alice.id });
  const palette = paletteFor(world);
  assert.deepEqual(palette.types, world.build_palette);
  assert.equal(palette.kind, 'home');
  assert.equal(palette.maximum_z, 0);
  assert.ok(world.build_palette.includes('farm'));
});

test('a resident on their own stewarded plot may build the whole palette', async t => {
  const { aliceWorld } = await frontierFixture(t);
  const world = aliceWorld();
  const model = hotbarModel({ world, pick: tile(32, 32) });
  assert.equal(model.plot.id, 'plot:0:0:5:5');
  assert.equal(model.plot.is_mine, true);
  assert.equal(model.entries.every((entry) => entry.available), true);
  assert.equal(model.remove.available, true);
  assert.equal(model.reason, null);
});

test('a resident on a plot they do not steward and hold no grant for is told so plainly', async t => {
  const { aliceWorld } = await frontierFixture(t);
  const world = aliceWorld();
  const model = hotbarModel({ world, pick: tile(2, 2) });
  assert.equal(model.plot.is_mine, false);
  assert.equal(model.entries.some((entry) => entry.available), false);
  assert.equal(model.entries[0].reason, 'No collaboration grant here');
  assert.equal(model.remove.available, false);
  const placement = placementModel({ world, pick: tile(2, 2), session: { player: { id: 'x', status: 'active' } } });
  assert.equal(placement.blocked, true);
  assert.equal(placement.asserts[0].code, 'no-grant');
  assert.equal(placement.grantNotice.kind, 'none');
});

// ---------------------------------------------------------------------------------------------
// Grants, surfaced from the server's own listing.
// ---------------------------------------------------------------------------------------------
test('a live collaboration grant opens only its named block types, layers and actions', async t => {
  const { f, aliceWorld, bobWorld, alice, bob } = await frontierFixture(t);
  f.advance();
  const created = f.tx('plotGrantCreate', f.actor('alice'), {
    plot_id: 'plot:0:0:5:5', guest_agent_id: bob.id, purpose: 'Lay the garden path', duration_minutes: 120,
    block_types: ['wood', 'path'], layers: [0, 1], actions: ['place'], max_blocks: 12,
  });
  assert.equal(created.created, true);
  const world = bobWorld();
  const grant = grantFor(world.frontier.grants, 'plot:0:0:5:5');
  assert.equal(grant.live, true);
  assert.equal(grant.purpose, 'Lay the garden path');
  const model = hotbarModel({ world, pick: tile(32, 32) });
  const byType = Object.fromEntries(model.entries.map((entry) => [entry.type, entry]));
  assert.equal(byType.wood.available, true);
  assert.equal(byType.path.available, true);
  assert.equal(byType.stone.available, false);
  assert.match(byType.stone.reason, /grant/i);
  assert.equal(model.remove.available, false);
  assert.match(model.remove.reason, /placement only/i);
  // The steward's own view is unchanged: alice may still build everything on her plot.
  const steward = hotbarModel({ world: aliceWorld(), pick: tile(32, 32) });
  assert.equal(steward.entries.every((entry) => entry.available), true);
  assert.ok(alice);
});

test('the placement preview shows the grant purpose, scope and expiry, and none of it is invented', async t => {
  const { f, bobWorld, bob } = await frontierFixture(t);
  f.advance();
  const grant = f.tx('plotGrantCreate', f.actor('alice'), {
    plot_id: 'plot:0:0:5:5', guest_agent_id: bob.id, purpose: 'Lay the garden path', duration_minutes: 120,
    block_types: ['wood'], layers: [0, 1], actions: ['place', 'remove'], max_blocks: 12,
  });
  const world = bobWorld();
  const model = placementModel({ world, pick: tile(32, 32), session: { player: { id: bob.id, status: 'active' } } });
  assert.equal(model.grantNotice.kind, 'grant');
  assert.equal(model.grantNotice.purpose, 'Lay the garden path');
  assert.equal(model.grantNotice.expires_at, grant.grant.expires_at);
  assert.deepEqual(model.grantNotice.scope, grant.grant.scope);
  assert.equal(hotbarModel({ world, pick: tile(32, 32) }).remove.available, true);
});

test('an expired grant is explained as expired, not silently ignored', async t => {
  const { f, bobWorld, bob } = await frontierFixture(t);
  f.advance();
  f.tx('plotGrantCreate', f.actor('alice'), {
    plot_id: 'plot:0:0:5:5', guest_agent_id: bob.id, purpose: 'Short help', duration_minutes: 15,
    block_types: ['wood'], layers: [0], actions: ['place'], max_blocks: 4,
  });
  f.advance(16 * 60_000);
  const world = bobWorld();
  const model = placementModel({ world, pick: tile(32, 32), session: { player: { id: bob.id, status: 'active' } } });
  assert.equal(model.grantNotice.kind, 'none');
  assert.equal(model.grantNotice.ended, 'expired');
  assert.equal(model.asserts.some((item) => item.code === 'grant-expired'), true);
});

// ---------------------------------------------------------------------------------------------
// The server's own validation drives permitted / blocked.
// ---------------------------------------------------------------------------------------------
test('a blueprint preview is the server\'s own validation and its issues are rendered verbatim', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const valid = { blueprint: { id: 'garden-shelter', name: 'Garden shelter' }, block_count: 14, new_blocks: 14, existing_blocks: 0, replay: false, valid: true, issues: [], budgets: { actions_remaining: 486, actions_per_operator_day: 500, blocks_remaining: 2000, blocks_per_sector: 2048 }, access: { doorways: [{ x: 34, y: 32, clear: true }] }, ownership: { is_mine: true } };
  const modelValid = placementModel({ world, pick: tile(33, 31), session: { player: { id: alice.id, status: 'active' } }, blueprintReport: valid });
  assert.equal(modelValid.permitted, true);
  assert.equal(modelValid.source, 'server-preview');
  assert.equal(modelValid.asserts.length, 0);
  const blocked = { ...valid, valid: false, issues: [{ status: 409, code: 'out-of-range', message: 'Walk closer: 14 of the blueprint’s cells are further than 6 tiles away.' }] };
  const modelBlocked = placementModel({ world, pick: tile(4, 4), session: { player: { id: alice.id, status: 'active' } }, blueprintReport: blocked });
  assert.equal(modelBlocked.permitted, false);
  assert.equal(modelBlocked.blocked, true);
  assert.equal(modelBlocked.asserts.some((item) => item.code === 'out-of-range'), true);
  assert.match(modelBlocked.asserts.find((item) => item.code === 'out-of-range').message, /Walk closer/);
});

test('classification names the actual reason and the next usable step for the server\'s own refusals', () => {
  const cases = [
    [409, 'Walk closer before building.', 'out-of-range'],
    [403, 'Build inside your operator’s assigned land plot. A signed-in human must first steward an available plot for a named purpose.', 'no-grant'],
    [409, 'Keep the public passages and arrivals clear.', 'shared-access'],
    [409, 'A resident is standing where the blueprint would be solid.', 'resident'],
    [429, 'This operator has reached the daily frontier action limit.', 'budget'],
    [429, 'This sector has reached its block limit.', 'area-capacity'],
    [409, 'This block would cut a resident off from the public passages.', 'trap'],
    [409, 'Remove your existing block before replacing it.', 'blocked-cell'],
    [403, 'This resident is paused.', 'paused'],
    [500, 'Something unexpected.', 'unknown'],
  ];
  for (const [status, message, code] of cases) {
    const info = classifyRefusal(Object.assign(new Error(message), { status }));
    assert.equal(info.code, code, message);
    assert.equal(info.saved, false);
    assert.ok(info.reason && info.next_step && info.next_step.length > 5);
    assert.equal(info.status, status);
  }
  // A blueprint preview's own machine code is passed through rather than re-guessed.
  assert.equal(classifyRefusal({ status: 403, code: 'out_of_plot', message: 'x' }).code, 'out_of_plot');
});

test('the placement target is the picked cell for removal and the adjacent cell for placement', () => {
  const pick = blockPick(10, 10, 2, { x: 0, y: 0, z: 1 });
  assert.deepEqual(targetOf(pick, 'place'), { x: 10, y: 10, z: 3 });
  assert.deepEqual(targetOf(pick, 'remove'), { x: 10, y: 10, z: 2 });
  assert.deepEqual(targetOf(tile(7, 8), 'place'), { x: 7, y: 8, z: 0 });
});

// ---------------------------------------------------------------------------------------------
// The components: a refusal is never saved, a confirmation always is.
// ---------------------------------------------------------------------------------------------
test('a refused placement is rendered as a refusal and is never rendered as saved construction', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const calls = [];
  const api = async (path, method, body) => { calls.push({ path, method, body }); throw Object.assign(new Error('Walk closer before building.'), { status: 409 }); };
  const preview = createPlacementPreview({ api });
  preview.update({ world, pick: tile(32, 32), session: { agentId: alice.id, worldId: 'frontier:0:0', player: { id: alice.id, status: 'active' } } });
  preview.setKind('wood');
  const outcome = await preview.confirm();
  assert.equal(outcome.ok, false);
  assert.equal(calls[0].path, '/frontier/build');
  assert.deepEqual({ x: calls[0].body.x, y: calls[0].body.y, type: calls[0].body.type, preview: calls[0].body.preview ?? null }, { x: 32, y: 32, type: 'wood', preview: null });
  const tree = JSON.stringify(preview.view());
  assert.match(tree, /"data-refusal":"out-of-range"/);
  assert.doesNotMatch(tree, /"data-saved":"1"/);
  assert.match(tree, /Walk closer before building\./);
});

test('only a server confirmation becomes saved', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const api = async () => ({ world_id: 'frontier:0:0', x: 32, y: 32, z: 0, type: 'wood', id: 'block-1', changed: true, removed: false });
  const preview = createPlacementPreview({ api });
  preview.update({ world, pick: tile(32, 32), session: { agentId: alice.id, worldId: 'frontier:0:0', player: { id: alice.id, status: 'active' } } });
  preview.setKind('wood');
  await preview.confirm();
  const tree = JSON.stringify(preview.view());
  assert.match(tree, /"data-saved":"1"/);
  assert.doesNotMatch(tree, /"data-refusal"/);
});

test('a blueprint preview asks the server with preview:true and never writes', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const calls = [];
  const api = async (path, method, body) => { calls.push({ path, method, body }); return { valid: true, issues: [], writes: 0, blueprint: { id: 'garden-shelter', name: 'Garden shelter' }, block_count: 14, new_blocks: 14, existing_blocks: 0, replay: false }; };
  const preview = createPlacementPreview({ api });
  preview.update({ world, pick: tile(33, 31), session: { agentId: alice.id, worldId: 'frontier:0:0', player: { id: alice.id, status: 'active' } } });
  preview.setBlueprint('garden-shelter');
  const report = await preview.previewBlueprint();
  assert.equal(report.valid, true);
  assert.deepEqual(calls[0], { path: '/frontier/build', method: 'POST', body: { agent_id: alice.id, world_id: 'frontier:0:0', blueprint: 'garden-shelter', x: 33, y: 31, preview: true } });
  assert.equal(preview.refresh().permitted, true);
  assert.equal(preview.refresh().source, 'server-preview');
});

// ---------------------------------------------------------------------------------------------
// Keyboard parity.
// ---------------------------------------------------------------------------------------------
test('every build and inventory action has a keyboard path', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const selected = [];
  const hotbar = createHotbar({ onSelect: (type) => selected.push(type) });
  hotbar.update({ world, pick: tile(32, 32) });
  assert.equal(hotbar.handleKey('3'), true);
  assert.equal(hotbar.selected(), world.frontier.palette[2]);
  assert.equal(hotbar.handleKey('0'), true);
  assert.equal(hotbar.selected(), 'remove');
  assert.equal(hotbar.handleKey('z'), false);

  const api = async () => ({ x: 32, y: 32, z: 0, type: 'wood', removed: false, changed: true });
  const preview = createPlacementPreview({ api });
  preview.update({ world, pick: tile(32, 32), session: { agentId: alice.id, worldId: 'frontier:0:0', player: { id: alice.id, status: 'active' } } });
  preview.setKind('wood');
  assert.equal(preview.handleKey('r'), true);
  assert.equal(preview.handleKey('c'), true); // issues a removal
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(preview.handleKey('Escape'), true);
});

test('the injected input interface drives the pick and the camera module is never imported', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  let listener = null;
  const input = { subscribe: (fn) => { listener = fn; return () => { listener = null; }; } };
  const preview = createPlacementPreview({ api: async () => ({ x: 32, y: 32, z: 0, type: 'wood', removed: false, changed: true, world_id: 'frontier:0:0', id: 'b' }), input });
  preview.update({ world, session: { agentId: alice.id, worldId: 'frontier:0:0', player: { id: alice.id, status: 'active' } } });
  preview.setKind('wood');
  assert.ok(listener, 'the component subscribed to the injected pick source');
  listener({ ...tile(33, 34), type: 'object' });
  const model = preview.refresh();
  assert.deepEqual({ x: model.target.x, y: model.target.y }, { x: 33, y: 34 });
  preview.dispose();
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/ui/build-interface.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /from '\.\.\/camera-controls\.js'|from '\.\.\/game-input\.js'/);
});

// ---------------------------------------------------------------------------------------------
// The view tree and the DOM boundary.
// ---------------------------------------------------------------------------------------------
test('mount builds real elements with textContent only and never touches innerHTML', async t => {
  const { aliceWorld, alice } = await frontierFixture(t);
  const world = aliceWorld();
  const preview = createPlacementPreview({ api: async () => { throw Object.assign(new Error('Keep the public passages and arrivals clear.'), { status: 409 }); } });
  preview.update({ world, pick: tile(2, 2), session: { agentId: alice.id, worldId: 'frontier:0:0', player: { id: alice.id, status: 'active' } } });
  preview.setKind('wood');
  await preview.confirm();
  const root = new FakeElement('div');
  mount(root, preview.view(), fakeDocument());
  const text = root.textContent;
  assert.match(text, /Refused: Protected shared passage/);
  assert.match(text, /Keep the public passages and arrivals clear\./);
  assert.match(text, /Next step:/);
  assert.doesNotMatch(text, /saved by the server/i);
  assert.equal(root.find((node) => node.attributes['data-refusal'] === 'shared-access')?.tag, 'div');
});

// A tiny in-test DOM. It has only what `mount` uses, and it throws if anything ever assigns
// innerHTML — the shipped shell contains none, and this component must keep that true.
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
  find(predicate) { if (predicate(this)) return this; for (const node of this.childNodes) if (node instanceof FakeElement) { const found = node.find(predicate); if (found) return found; } return null; }
}
const fakeDocument = () => ({ createElement: (tag) => new FakeElement(tag), createTextNode: (text) => new FakeText(text) });

// ---------------------------------------------------------------------------------------------
// Inventory.
// ---------------------------------------------------------------------------------------------
test('the inventory shelf is the server\'s own list and coins are never rendered as items', async t => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const journey = f.tx('journey', f.actor('alice'), { agent_id: agent.id });
  assert.ok(journey.coins, 'the server payload carries coins');
  const model = inventoryModel({ journey });
  assert.deepEqual(model.shelf, []);
  assert.equal('coins' in model, false);
  assert.match(model.note, /not items/i);
  // A synthetic payload proves the panel reads only item kinds: a coin figure must never surface.
  const withCoins = inventoryModel({ journey: { ...journey, inventory: [{ kind: 'herbs', quantity: 2 }], coins: { balance: 987654, receipt_count: 11 } } });
  assert.deepEqual(withCoins.shelf.map((item) => item.kind), ['herbs']);
  const panel = createInventoryPanel({});
  panel.update({ journey: { ...journey, inventory: [{ kind: 'herbs', quantity: 2 }], coins: { balance: 987654, receipt_count: 11 } }, agentId: agent.id });
  const text = JSON.stringify(panel.view());
  assert.doesNotMatch(text, /987654/);
  assert.doesNotMatch(text, /"data-item":"[^"]*coin/i);
  assert.doesNotMatch(text, /balance/i);
});

test('recipes state what can be crafted now and which ingredients are missing', async t => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const journey = f.tx('journey', f.actor('alice'), { agent_id: agent.id });
  const recipe = journey.recipes.find((item) => item.id === 'flower_crown');
  const empty = recipeAvailability(recipe, new Map());
  assert.equal(empty.craftable, false);
  assert.deepEqual(empty.missing.map((item) => item.kind).sort(), ['fiber', 'herbs']);
  assert.equal(empty.missing.find((item) => item.kind === 'herbs').need, 2);
  assert.equal(empty.missing.find((item) => item.kind === 'herbs').have, 0);
  const enough = recipeAvailability(recipe, new Map([['herbs', 2], ['fiber', 1]]));
  assert.equal(enough.craftable, true);
  assert.equal(enough.missing.length, 0);
});

test('crafting uses the server\'s own response and shows a refusal as a refusal', async t => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const journey = f.tx('journey', f.actor('alice'), { agent_id: agent.id });
  const okApi = async () => ({ crafted: 'flower_crown', inventory: [{ kind: 'flower_crown', quantity: 1 }] });
  const panel = createInventoryPanel({ api: okApi });
  panel.update({ journey, agentId: agent.id });
  const crafted = await panel.craft({ id: 'flower_crown', name: 'Flower crown', craftable: true });
  assert.equal(crafted.crafted, 'flower_crown');
  assert.deepEqual(panel.model().shelf.map((item) => item.kind), ['flower_crown']);
  assert.match(JSON.stringify(panel.view()), /The server crafted Flower crown\./);

  const badApi = async () => { throw Object.assign(new Error('Gather the recipe ingredients first.'), { status: 409 }); };
  const refused = createInventoryPanel({ api: badApi });
  refused.update({ journey, agentId: agent.id });
  await refused.craft({ id: 'flower_crown', name: 'Flower crown', craftable: true });
  const text = JSON.stringify(refused.view());
  assert.match(text, /"data-inventory-status":"refused"/);
  assert.match(text, /Gather the recipe ingredients first\./);
});

test('the inventory panel has a keyboard path: digits select a recipe and c crafts it', async t => {
  const f = await fixture(t);
  const agent = f.agent('alice');
  f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'herbs',4) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=4", agent.id);
  f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'fiber',3) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=3", agent.id);
  const journey = f.tx('journey', f.actor('alice'), { agent_id: agent.id });
  assert.equal(journey.recipes[0].id, 'flower_crown');
  const calls = [];
  const panel = createInventoryPanel({ api: async (path, method, body) => { calls.push({ path, body }); return { crafted: 'flower_crown', inventory: [] }; } });
  panel.update({ journey, agentId: agent.id });
  assert.equal(panel.handleKey('1'), true);
  assert.equal(panel.selected(), journey.recipes[0].id);
  assert.equal(panel.handleKey('c'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0].path, '/journey/craft');
  assert.equal(calls[0].body.recipe_id, journey.recipes[0].id);
});
