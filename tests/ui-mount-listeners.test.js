import test from 'node:test';
import assert from 'node:assert/strict';
import { el, mount, createHotbar } from '../src/ui/build-interface.js';
import { createInventoryPanel } from '../src/ui/inventory-panel.js';

// The same minimal stub `tests/build-interface.test.js` uses, so this file proves a listener exists
// rather than proving a browser event loop works.
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
  click() { for (const handler of this.listeners.click || []) handler({ type: 'click' }); }
  find(predicate) { if (predicate(this)) return this; for (const node of this.childNodes) if (node instanceof FakeElement) { const found = node.find(predicate); if (found) return found; } return null; }
}
const fakeDocument = () => ({ createElement: (tag) => new FakeElement(tag), createTextNode: (text) => new FakeText(text) });
const byLabel = (root, label) => root.find((node) => node.tag === 'button' && node.getAttribute('aria-label') === label);

test('a handler passed as `on` is wired as a click, and the { click } form still works', () => {
  const document = fakeDocument(), root = new FakeElement('div');
  const calls = [];
  mount(root, el('div', {}, [el('button', { on: () => calls.push('shorthand'), text: 'One' }), el('button', { on: { click: () => calls.push('explicit') }, text: 'Two' })]), document);
  const shorthand = root.find((node) => node.tag === 'button' && node.textContent === 'One');
  const explicit = root.find((node) => node.tag === 'button' && node.textContent === 'Two');
  assert.ok(shorthand && explicit, 'both buttons must render');
  shorthand.click(); explicit.click();
  assert.deepEqual(calls, ['shorthand', 'explicit'], 'both spellings must reach their handler through mount');
  assert.equal(shorthand.listeners.click.length, 1, 'the shorthand attaches exactly one listener');
});

test('the shipped buttons in the inventory panel and the hotbar answer a click', async () => {
  const document = fakeDocument(), root = new FakeElement('div');
  const calls = [];
  const panel = createInventoryPanel({ api: async (path, method, body) => { calls.push([path, method, body]); return { crafted: 'herbs', inventory: [{ kind: 'herbs', quantity: 4 }] }; } });
  panel.update({ journey: { inventory: [{ kind: 'herbs', quantity: 3 }, { kind: 'fiber', quantity: 2 }], crops: [], recipes: [{ id: 'herb-bundle', name: 'Herb bundle', output: 'herbs', ingredients: { herbs: 2 } }] }, agentId: 'agent-1' });
  mount(root, panel.view(), document);
  // The recipe is one real button built with the function-form shorthand: a click must reach the
  // panel's own craft path and the server stub, not silently do nothing.
  const recipe = root.find((node) => node.tag === 'button' && String(node.getAttribute('aria-label')).startsWith('Craft'));
  assert.ok(recipe, 'the recipe must render as a labelled button');
  recipe.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call[0]), ['/journey/craft'], 'the click must issue the craft request');
  assert.deepEqual(calls[0][2], { agent_id: 'agent-1', recipe_id: 'herb-bundle' }, 'the request names the resident and the recipe and nothing else');
  assert.equal(panel.model().shelf.find((item) => item.kind === 'herbs').quantity, 4, 'the panel takes the server’s returned shelf as the truth');

  const hotbarRoot = new FakeElement('div');
  const chosen = [];
  const hotbar = createHotbar({ onSelect: (type) => chosen.push(type) });
  hotbar.update({ world: { kind: 'home', build_palette: ['bench', 'lantern'] } });
  mount(hotbarRoot, hotbar.view(), document);
  const remove = hotbarRoot.find((node) => node.tag === 'button' && /^Remove a block or object/.test(String(node.getAttribute('aria-label'))));
  assert.ok(remove, 'the removal control must render as a labelled button');
  assert.equal(remove.listeners.click.length, 1, 'the removal control must have a click listener');
  remove.click();
  assert.deepEqual(chosen, ['remove'], 'clicking removal must select the removal mode');
  const paletteButton = hotbarRoot.find((node) => node.tag === 'button' && node.getAttribute('data-build-type') === 'bench');
  paletteButton.click();
  assert.deepEqual(chosen, ['remove', 'bench'], 'a garden object entry must select its own kind');
});
