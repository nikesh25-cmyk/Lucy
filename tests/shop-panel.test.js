// The shop panel: the wallet line, what service earns Karma Coins, the shop itself with its confirm
// step, the movement ledger, and the keyboard and focus contract.
//
// These are the pure halves of the component — the two payload models, the view tree, and the focus
// and keyboard behaviour asserted on created nodes through the same tiny in-test DOM the other UI
// module tests use (`tests/build-interface.test.js`, `tests/interaction-prompt.test.js`). Nothing here
// drives a real browser or a real server: the panel sends nothing, so there is nothing to drive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  KARMA_COIN_NAME, KARMA_COIN_SENTENCE, REDUCED_MOTION_CLASS, TOUCH_TARGET_MIN,
  allowanceText, coinText, createShopPanel, formatTimestamp, karmaModel, prefersReducedMotion,
  purchaseSentence, shopModel, tierLabel,
} from '../src/ui/shop-panel.js';

const source = readFileSync(fileURLToPath(new URL('../src/ui/shop-panel.js', import.meta.url)), 'utf8');

// A fixture pair in exactly the shape the two other owners defined for GET /api/v1/karma and
// GET /api/v1/shop.
const karmaPayload = {
  balance: 12,
  policy: { sentence: 'Karma Coins are earned by service in the world and spent only in this shop.' },
  services: [
    { id: 'shared_garden', label: 'Tend the shared garden', tier: 'world', award: 3, per_day: 5, remaining_today: 4, hint: 'Water a bed in the Commons; the server records the service when the bed is tended.' },
    { id: 'help_a_neighbour', label: 'Carry a neighbour’s load', tier: 'resident', award: 5, per_day: 2, remaining_today: 0, hint: 'Help another resident with a plot they steward.' },
  ],
  entries: [
    { direction: 'earn', label: 'Tended the shared garden', amount: 3, created_at: '2026-10-14T09:15:00Z' },
    { direction: 'spend', label: 'Bought a paper lantern', amount: 4, created_at: '2026-10-13T18:02:00Z' },
  ],
  today: { earned: 3, spent: 0 },
  verify: { source: 'ledger' },
};
const shopPayload = {
  balance: 12,
  policy: { sentence: 'Goods are in-world items only; the shop never sells money, leave or standing.' },
  goods: [
    { id: 'paper_lantern', label: 'Paper lantern', summary: 'A warm light for a doorway.', category: 'keepsakes', price: 4, per_day_limit: 3, remaining_today: 2, affordable: true },
    { id: 'seed_bundle', label: 'Seed bundle', summary: 'Four kinds of seed for a garden.', category: 'growing', price: 3, per_day_limit: 5, remaining_today: 5, affordable: true },
    { id: 'carved_bench', label: 'Carved bench', summary: 'A bench for a shared path.', category: 'keepsakes', price: 40, per_day_limit: 1, remaining_today: 1, affordable: false },
    { id: 'festival_banner', label: 'Festival banner', summary: 'Hung above a gathering place.', category: 'growing', price: 6, per_day_limit: 1, remaining_today: 0, affordable: true },
  ],
  entries: [{ direction: 'spend', label: 'Bought a seed bundle', amount: 3, created_at: '2026-10-12T08:00:00Z' }],
};

// A tiny in-test DOM. It has only what `mount` and the focus helpers use, and it throws if anything
// ever assigns innerHTML — the shipped shell contains none, and this component must keep that true.
class FakeText {
  constructor(text) { this.data = String(text); }
  get textContent() { return this.data; }
}
class FakeElement {
  constructor(tag, owner = null) { this.tag = tag; this.ownerDocument = owner; this.childNodes = []; this.attributes = {}; this.listeners = {}; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set innerHTML(_value) { throw new Error('innerHTML must never be assigned'); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  dispatch(type, event = {}) { for (const handler of this.listeners[type] || []) handler({ preventDefault() {}, ...event }); }
  find(predicate) { if (predicate(this)) return this; for (const node of this.childNodes) if (node instanceof FakeElement) { const found = node.find(predicate); if (found) return found; } return null; }
  collect(found = []) { found.push(this); for (const node of this.childNodes) if (node instanceof FakeElement) node.collect(found); return found; }
}
const fakeDocument = () => {
  const doc = { activeElement: null };
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.createTextNode = (text) => new FakeText(text);
  return doc;
};
const byAttribute = (root, attribute, value) => root.find((node) => node.getAttribute(attribute) === value);
const paintInto = (panel, { trigger = null } = {}) => {
  const document = fakeDocument();
  const root = new FakeElement('div', document);
  const node = panel.paint(root, { document, trigger });
  return { root, document, node };
};

test('a payload renders the balance, the service list and the goods', () => {
  const panel = createShopPanel({});
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  const { root } = paintInto(panel);
  const text = root.textContent;
  // The wallet line: the balance and the currency's name.
  assert.match(text, /Karma Coins: 12/);
  assert.equal(byAttribute(root, 'data-shop-panel', '1').tag, 'section');
  // Every service: label, tier, award, today's allowance and the server's own hint.
  assert.match(text, /Tend the shared garden — World service/);
  assert.match(text, /Award: 3 Karma Coins/);
  assert.match(text, /4 of 5 still available today\./);
  assert.match(text, /Water a bed in the Commons/);
  assert.match(text, /Carry a neighbour’s load — Service to another resident/);
  assert.match(text, /Award: 5 Karma Coins/);
  assert.match(text, /No more of this service today\./);
  assert.equal(byAttribute(root, 'data-service', 'shared_garden').getAttribute('data-tier'), 'world');
  // The goods, grouped by the category the server states, in the server's own order.
  const categories = root.collect().filter((node) => node.getAttribute('data-category') !== null);
  assert.deepEqual(categories.map((node) => node.getAttribute('data-category')), ['keepsakes', 'growing']);
  assert.equal(byAttribute(root, 'data-category', 'keepsakes').find((node) => node.tag === 'h4').textContent, 'Keepsakes');
  assert.match(text, /Paper lantern — 4 Karma Coins/);
  assert.match(text, /A warm light for a doorway\./);
  assert.match(text, /2 of 3 still available today\./);
  assert.match(text, /Carved bench — 40 Karma Coins/);
  // The ledger of both directions, each with its label and the time the server recorded.
  assert.match(text, /Tended the shared garden — earned 3 Karma Coins/);
  assert.match(text, /Bought a paper lantern — spent 4 Karma Coins/);
  assert.match(text, /Recorded \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.equal(byAttribute(root, 'data-direction', 'spend') !== null, true);
  // The server's own shop rule is quoted, not paraphrased.
  assert.match(text, /Goods are in-world items only; the shop never sells money, leave or standing\./);
});

test('the wallet states what Karma Coins are and are not, in one plain sentence', () => {
  const panel = createShopPanel({});
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  const { root } = paintInto(panel);
  const sentence = root.find((node) => node.getAttribute('class') === 'privacy ui-shop-sentence');
  assert.equal(sentence.textContent, KARMA_COIN_SENTENCE, 'the sentence is the panel’s own, verbatim');
  assert.match(root.textContent, /earned by doing service in the world/);
  assert.match(root.textContent, /spent only in this shop/);
  assert.match(root.textContent, /not NemoCoins/);
  assert.match(root.textContent, /not money/);
  assert.match(root.textContent, /no cash value/);
  assert.match(root.textContent, /cannot be transferred or converted/);
  assert.match(root.textContent, /buy nothing that is not an in-world good/);
  // The currency's name is spelled out wherever a number appears.
  assert.equal(KARMA_COIN_NAME, 'Karma Coins');
  assert.equal(coinText(3), '3 Karma Coins');
  assert.equal(coinText(1), '1 Karma Coin');
});

test('affordability is the server’s own flag, never an arithmetic the panel performs', () => {
  const odd = {
    balance: 1,
    goods: [
      { id: 'dear', label: 'Dear good', summary: '', category: 'keepsakes', price: 999, per_day_limit: 1, remaining_today: 1, affordable: true },
      { id: 'cheap', label: 'Cheap good', summary: '', category: 'keepsakes', price: 1, per_day_limit: 1, remaining_today: 1, affordable: false },
    ],
  };
  const panel = createShopPanel({});
  panel.update({ shop: odd });
  const { root } = paintInto(panel);
  assert.equal(byAttribute(root, 'data-buy', 'dear').getAttribute('disabled'), null, 'a good the server calls affordable stays buyable even though it costs more than the balance');
  assert.equal(byAttribute(root, 'data-buy', 'cheap').getAttribute('disabled'), '', 'a good the server calls unaffordable is disabled');
  assert.equal(byAttribute(root, 'data-good', 'cheap').getAttribute('data-affordable'), 'false');
  assert.match(root.textContent, /Not affordable yet: this good costs 1 Karma Coin and your wallet holds 1 Karma Coins\./);
  assert.equal(panel.model().wallet.balance, 1, 'the balance is the server’s number, rendered as it arrived');
});

test('an unaffordable good is disabled and can never fire a purchase', () => {
  const purchases = [];
  const panel = createShopPanel({ onPurchase: (id) => purchases.push(id) });
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  const { root } = paintInto(panel);
  const disabled = byAttribute(root, 'data-buy', 'carved_bench');
  assert.equal(disabled.getAttribute('disabled'), '');
  assert.equal(disabled.getAttribute('aria-disabled'), 'true');
  assert.match(disabled.textContent, /cannot be bought yet/);
  assert.match(root.textContent, /Not affordable yet: this good costs 40 Karma Coins and your wallet holds 12 Karma Coins\./);
  disabled.dispatch('click');
  assert.deepEqual(purchases, [], 'a click on a disabled good is not a purchase');
  assert.equal(panel.select('carved_bench'), null, 'the good cannot be armed either');
  assert.equal(panel.buy(), null, 'so there is nothing to confirm');
  assert.deepEqual(purchases, []);
  // A good whose daily allowance is used up is refused for the same reason, in words.
  const banner = byAttribute(root, 'data-buy', 'festival_banner');
  assert.equal(banner.getAttribute('disabled'), '');
  assert.match(root.textContent, /No more of this good today; it returns tomorrow\./);
  banner.dispatch('click');
  assert.deepEqual(purchases, []);
});

test('the first click on a good only asks, and the confirm is what fires', () => {
  const purchases = [];
  const root = new FakeElement('div');
  const document = fakeDocument();
  const panel = createShopPanel({ onPurchase: (id) => purchases.push(id), onChange: () => panel.paint(root, { document }) });
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  panel.paint(root, { document });
  byAttribute(root, 'data-buy', 'paper_lantern').dispatch('click');
  assert.deepEqual(purchases, [], 'the first click buys nothing');
  assert.equal(panel.model().selected, 'paper_lantern');
  const confirm = byAttribute(root, 'data-confirm-buy', 'paper_lantern');
  assert.ok(confirm, 'the confirm step is rendered after the first click');
  assert.equal(byAttribute(root, 'data-buy', 'paper_lantern'), null, 'the row offers the confirm instead of a second buy button');
  assert.match(root.textContent, /Buy Paper lantern for 4 Karma Coins\?/);
  assert.match(root.textContent, /Nothing has been bought yet\./);
  confirm.dispatch('click');
  assert.deepEqual(purchases, ['paper_lantern']);
  // Until the server answers, the same confirmation cannot fire a second request.
  confirm.dispatch('click');
  assert.deepEqual(purchases, ['paper_lantern']);
  // Cancel asks for nothing at all.
  const panel2 = createShopPanel({ onPurchase: (id) => purchases.push(id) });
  panel2.update({ karma: karmaPayload, shop: shopPayload });
  panel2.select('seed_bundle');
  const { root: root2 } = paintInto(panel2);
  byAttribute(root2, 'data-confirm-cancel', 'seed_bundle').dispatch('click');
  assert.equal(panel2.model().selected, null);
  assert.deepEqual(purchases, ['paper_lantern']);
});

test('a refusal is shown in the server’s own words, never rephrased and never as a success', () => {
  const wording = 'Today’s allowance for Carved bench is used up; it returns tomorrow.';
  const panel = createShopPanel({});
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  panel.update({ refusal: { error: wording } });
  const { root } = paintInto(panel);
  const alert = byAttribute(root, 'data-shop-refusal-words', '1');
  assert.equal(alert.textContent, wording);
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.equal(alert.getAttribute('aria-live'), 'assertive');
  assert.equal(byAttribute(root, 'data-shop-refusal', '1') !== null, true);
  assert.equal(byAttribute(root, 'data-shop-purchase', '1'), null, 'a refusal is not a purchase');
  // A refusal that arrived with a purchase payload is replaced by the next payload, never kept.
  panel.update({ purchase: { purchase: { id: 'pur-9', good: 'seed_bundle', price: 3, granted: 'seed bundle' }, balance_after: 9 } });
  assert.equal(byAttribute(paintInto(panel).root, 'data-shop-refusal', '1'), null);
});

test('a purchase response moves the wallet only when a new payload hands it over', () => {
  const purchases = [];
  const panel = createShopPanel({ onPurchase: (id) => purchases.push(id) });
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  assert.equal(panel.model().wallet.balance, 12);
  panel.select('paper_lantern');
  assert.equal(panel.buy().id, 'paper_lantern');
  assert.deepEqual(purchases, ['paper_lantern']);
  assert.equal(panel.model().wallet.balance, 12, 'firing a request changes no balance: only a new payload does');
  assert.equal(panel.model().saved, null, 'the panel does not assume the purchase succeeded');
  panel.update({
    karma: { ...karmaPayload, balance: 8 },
    shop: { ...shopPayload, balance: 8 },
    purchase: { purchase: { id: 'pur-1', good: 'paper_lantern', price: 4, granted: 'paper lantern' }, balance_after: 8 },
  });
  assert.equal(panel.model().wallet.balance, 8);
  const text = paintInto(panel).root.textContent;
  assert.match(text, /The server granted paper lantern for 4 Karma Coins\./);
  assert.match(text, /Your wallet then held 8 Karma Coins\./);
  assert.equal(purchaseSentence({ purchase: { granted: 'paper lantern', price: 4 }, balance_after: 8 }), 'The server granted paper lantern for 4 Karma Coins. Your wallet then held 8 Karma Coins.');
  assert.equal(purchaseSentence({}), 'The server recorded a purchase.');
  // The shop projection's own flat record, whose `granted` is an object rather than a name.
  const flat = { purchase_id: 'pur-2', good_id: 'herbs', label: 'Herb bundle', category: 'resource', price: 8, granted: { kind: 'herbs', quantity: 2 }, balance_after: 16, repeated: false };
  assert.equal(purchaseSentence(flat), 'The server granted Herb bundle for 8 Karma Coins. Your wallet then held 16 Karma Coins.');
  panel.update({ purchase: flat });
  const confirmation = byAttribute(paintInto(panel).root, 'data-shop-purchase', '1');
  assert.equal(confirmation.getAttribute('role'), 'status');
  assert.match(confirmation.textContent, /The server granted Herb bundle for 8 Karma Coins\./);
});

test('the panel is operable from the keyboard alone, and never traps Tab', () => {
  const purchases = [];
  const panel = createShopPanel({ onPurchase: (id) => purchases.push(id) });
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  assert.equal(panel.handleKey('1'), true, 'a digit arms the first good');
  assert.equal(panel.model().selected, 'paper_lantern');
  assert.equal(panel.handleKey('3'), false, 'an unaffordable good cannot be armed from the keyboard');
  assert.equal(panel.handleKey('4'), false, 'nor a good whose allowance is used up');
  assert.equal(panel.handleKey('Enter'), true);
  assert.deepEqual(purchases, ['paper_lantern']);
  panel.update({ shop: shopPayload });
  assert.equal(panel.handleKey('2'), true);
  assert.equal(panel.model().selected, 'seed_bundle');
  assert.equal(panel.handleKey('Escape'), true, 'Escape cancels the armed good');
  assert.equal(panel.model().selected, null);
  assert.equal(panel.handleKey('Escape'), false, 'and does nothing more when nothing is armed and nothing is open');
  assert.equal(panel.handleKey('Tab'), false, 'Tab is never intercepted, so the panel never traps focus');
  // Every control the panel renders is a real button, reachable without a mouse.
  const { root } = paintInto(panel);
  const controls = byAttribute(root, 'data-shop-panel', '1').collect().filter((node) => node.tag === 'button');
  assert.ok(controls.length >= 4);
  for (const control of controls) assert.equal(control.getAttribute('type'), 'button');
});

test('focus moves into the panel when it opens and back to the trigger when it closes', () => {
  const document = fakeDocument();
  const trigger = new FakeElement('button', document);
  const root = new FakeElement('div', document);
  const panel = createShopPanel({ onChange: () => panel.paint(root, { document, trigger }) });
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  panel.paint(root, { document, trigger });
  assert.equal(document.activeElement, null, 'a closed panel that is already on screen takes no focus');
  panel.open();
  assert.equal(document.activeElement.getAttribute('data-shop-panel'), '1', 'opening puts the focus inside the panel');
  assert.equal(document.activeElement.getAttribute('aria-modal'), 'false', 'and the panel is not modal, so Tab still leaves it');
  // Opening renders its own labelled, pointer-reachable dismissal.
  const close = byAttribute(root, 'data-shop-close', '1');
  assert.equal(close.getAttribute('type'), 'button');
  close.dispatch('click');
  assert.equal(document.activeElement, trigger, 'closing returns the focus to the trigger');
  assert.equal(panel.isOpen(), false);
  // A repaint after opening again lands on the panel, and a repaint after a selection does not steal it.
  panel.open();
  assert.equal(document.activeElement.getAttribute('data-shop-panel'), '1');
  panel.select('paper_lantern');
  assert.equal(document.activeElement.getAttribute('data-confirm-buy'), 'paper_lantern', 'the focus follows the confirmation it opened');
  panel.cancel();
  assert.equal(document.activeElement.getAttribute('data-buy'), 'paper_lantern', 'and comes back to the row when it is cancelled');
  const { root: elsewhere } = paintInto(panel);
  assert.equal(elsewhere.find((node) => node.tag === 'section').getAttribute('tabindex'), '-1', 'the container itself is focusable, so a keyboard user can land on it');
});

test('the reduced-motion class is applied when the reader asks for it', () => {
  const quiet = createShopPanel({ reducedMotion: () => true });
  quiet.update({ karma: karmaPayload, shop: shopPayload });
  assert.match(JSON.stringify(quiet.view()), new RegExp(REDUCED_MOTION_CLASS));
  const normal = createShopPanel({});
  normal.update({ karma: karmaPayload, shop: shopPayload });
  assert.doesNotMatch(JSON.stringify(normal.view()), new RegExp(REDUCED_MOTION_CLASS));
  assert.equal(prefersReducedMotion((query) => ({ matches: query === '(prefers-reduced-motion: reduce)' })), true);
  assert.equal(prefersReducedMotion(null), false);
  assert.equal(TOUCH_TARGET_MIN, 44, 'the panel is styled to the project’s 44 px minimum target');
});

test('every state is written out, so nothing depends on a tooltip or on colour', () => {
  const panel = createShopPanel({});
  panel.update({ karma: karmaPayload, shop: shopPayload, agentId: 'agent-1' });
  const { root } = paintInto(panel);
  const nodes = root.collect();
  assert.equal(nodes.filter((node) => node.getAttribute('title') !== null).length, 0, 'no state lives in a title attribute');
  const text = root.textContent;
  for (const state of [/World service/, /Service to another resident/, /Award: 3 Karma Coins/, /still available today/, /No more of this service today/, /No more of this good today/, /Not affordable yet/, /cannot be bought yet/, /earned 3 Karma Coins/, /spent 4 Karma Coins/]) {
    assert.match(text, state);
  }
  // The two tiers the payload names are spelled out rather than guessed at.
  assert.equal(tierLabel('world'), 'World service');
  assert.equal(tierLabel('resident'), 'Service to another resident');
  assert.equal(tierLabel('service_to_a_neighbour'), 'Service to a neighbour');
  assert.equal(tierLabel(null), 'Tier not stated by the server');
  assert.equal(allowanceText({ remaining_today: 2, per_day: 5 }, 'this good'), '2 of 5 still available today.');
  assert.equal(allowanceText({ remaining_today: 0 }, 'this good'), 'No more of this good today.');
  assert.equal(allowanceText({}, 'this good'), null);
});

test('no server string is ever markup, and the module injects none', () => {
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(source, /\.html\s*=/);
  const hostile = {
    balance: 3,
    policy: { sentence: '<img src=x onerror=alert(1)>' },
    goods: [
      { id: 'x', label: '<script>alert(2)</script>', summary: '<b>bold</b>', category: '<i>cat</i>', price: 1, per_day_limit: 1, remaining_today: 1, affordable: false },
    ],
    entries: [{ direction: 'spend', label: '<em>spent</em>', amount: 1, created_at: null }],
  };
  const panel = createShopPanel({});
  panel.update({ karma: { ...karmaPayload, balance: 3, services: [{ id: 's', label: '<script>alert(3)</script>', tier: '<u>tier</u>', award: 1, per_day: 1, remaining_today: 1, hint: '<script>alert(4)</script>' }] }, shop: hostile });
  const { root } = paintInto(panel);
  // The strings arrive whole, as text: no element was built out of them.
  assert.match(root.textContent, /<script>alert\(2\)<\/script>/);
  assert.match(root.textContent, /<script>alert\(3\)<\/script>/);
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.deepEqual(root.collect().filter((node) => ['script', 'img', 'b', 'i', 'em', 'u'].includes(node.tag)), []);
  assert.equal(root.nodeType, undefined, 'the shim has no parser, so a real browser check stays pending (see the handoff)');
});

test('the models keep only what the server stated', () => {
  const karma = karmaModel(karmaPayload);
  assert.equal(karma.ready, true);
  assert.equal(karma.balance, 12);
  assert.equal(karma.services[1].exhausted, true);
  assert.equal(karma.entries[0].direction, 'earn');
  assert.equal(karma.entries[1].amount, 4);
  const shop = shopModel(shopPayload);
  assert.deepEqual(shop.categories.map((category) => category.name), ['keepsakes', 'growing']);
  assert.deepEqual(shop.categories[0].goods.map((good) => good.id), ['paper_lantern', 'carved_bench']);
  assert.equal(shop.goods[3].exhausted, true);
  assert.equal(shop.goods[3].can_buy, false, 'a used-up allowance is not buyable');
  assert.equal(shop.policy, shopPayload.policy.sentence);
  // No payload at all is an honest empty state, not a fabricated one.
  const empty = createShopPanel({});
  const { root } = paintInto(empty);
  assert.match(root.textContent, /Karma Coins: not stated by the server/);
  assert.match(root.textContent, /not NemoCoins/, 'the wallet sentence is present before any payload arrives');
  assert.equal(byAttribute(root, 'data-shop-services', 'empty') !== null, true);
  assert.equal(byAttribute(root, 'data-shop-goods', 'empty') !== null, true);
  assert.equal(empty.model().ready, false);
  // A timestamp the server already made readable is passed through; an ISO instant is made readable.
  assert.equal(formatTimestamp('2026-10-14 09:15'), '2026-10-14 09:15');
  assert.equal(formatTimestamp(''), '');
  assert.equal(formatTimestamp('not a time'), 'not a time');
  assert.match(formatTimestamp('2026-10-14T09:15:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// The two sibling modules landed their own projections while this panel was written, and their field
// names differ from the brief the panel was built to (`can_afford` rather than `affordable`,
// `daily_limit` rather than `per_day_limit`, a policy object rather than `{ sentence }`, and the tier
// `service` rather than `resident`). These two payloads are in their shape, so the panel is asserted
// against the real contract and not only against the agreed one.
const realKarma = {
  agent_id: 'agent-1', currency: 'Karma Coins', unit: 'karma', balance: 24, earned: 30, spent: 6,
  policy: { version: 1, currency: 'Karma Coins', cash_value: false, convertible: false, sentence: 'Karma Coins are earned by service in the world and spent only in the shop: they are not NemoCoins, not money, have no cash value, cannot be transferred or converted, and buy nothing that is not an in-world good.' },
  services: [
    { id: 'garden_crop', label: 'A crop planted in your own garden', tier: 'world', award: 2, per_day: 2, requires_other_operator: false, source_kind: 'journey_crop', note: 'A saved journey_crops row for a farm tile in the garden of your own resident.', hint: 'A saved journey_crops row for a farm tile in the garden of your own resident.', used_today: 1, minted: 3, remaining_today: 1 },
    { id: 'thanks_to_neighbor', label: 'A thank-you recorded for a resident of a different operator', tier: 'service', award: 6, per_day: 2, requires_other_operator: true, source_kind: 'neighbor_thanks', note: 'A saved community_thanks row whose giver and recipient belong to different operators.', hint: 'A saved community_thanks row whose giver and recipient belong to different operators.', used_today: 0, minted: 0, remaining_today: 2 },
  ],
  today: { day: '2026-10-14', earned: 2, spent: 6, limit: 60, remaining: 58 },
  entries: [{ direction: 'spend', amount: 6, label: 'Spent on herbs', good_id: 'herbs', day: '2026-10-14', created_at: '2026-10-14T10:00:00.000Z' }],
  verify: { ledger: true, chain: true }, integrity_valid: true,
};
const realShop = {
  agent_id: 'agent-1', currency: 'Karma Coins', balance: 24,
  policy: { version: 1, currency: 'Karma Coins', cash_value: false, gift_or_transfer: false, description: 'The shop sells only in-world goods and never land, roles, authority, XP, review power or anything with real-world value.' },
  categories: ['resource', 'object', 'cosmetic'],
  goods: [
    { id: 'herbs', label: 'Herb bundle', summary: 'Two herb crops, grown from the sealed herb seed.', category: 'resource', price: 8, grant: { kind: 'herbs', quantity: 2 }, note: 'Grown crops only.', daily_limit: 6, bought_today: 0, remaining_today: 6, available_today: true, can_afford: true },
    { id: 'fountain', label: 'Fountain', summary: 'A fountain, the centrepiece of a garden.', category: 'object', price: 35, daily_limit: 1, bought_today: 0, remaining_today: 1, available_today: true, can_afford: false },
    { id: 'festival_banner', label: 'Festival banner keepsake', summary: 'The festival banner, the shop’s most costly keepsake.', category: 'cosmetic', price: 40, daily_limit: 1, bought_today: 1, remaining_today: 0, available_today: false, can_afford: true, note: 'One a day.' },
  ],
  server_time: 0,
};

test('the panel reads the sibling modules’ own projection, not just the agreed brief', () => {
  const panel = createShopPanel({});
  panel.update({ karma: realKarma, shop: realShop, agentId: 'agent-1' });
  const { root } = paintInto(panel);
  const text = root.textContent;
  assert.match(text, /Karma Coins: 24/);
  // `tier: 'service'` is the karma module's own word for service to another resident.
  assert.equal(tierLabel('service'), 'Service to another resident');
  assert.match(text, /A thank-you recorded for a resident of a different operator — Service to another resident/);
  assert.match(text, /Award: 6 Karma Coins/);
  assert.match(text, /1 of 2 still available today\./);
  assert.match(text, /A crop planted in your own garden — World service/);
  assert.match(text, /Award: 2 Karma Coins/);
  assert.match(text, /A saved journey_crops row/, 'the server’s `note` is used when `hint` is absent');
  // `daily_limit` is read as the good's allowance for the day.
  assert.match(text, /6 of 6 still available today\./);
  assert.equal(byAttribute(root, 'data-good', 'herbs').getAttribute('data-remaining'), '6');
  // `can_afford: false` disables the good; so does a used-up allowance (`available_today: false`).
  assert.equal(byAttribute(root, 'data-buy', 'fountain').getAttribute('disabled'), '');
  assert.match(text, /Not affordable yet: this good costs 35 Karma Coins and your wallet holds 24 Karma Coins\./);
  assert.equal(byAttribute(root, 'data-buy', 'festival_banner').getAttribute('disabled'), '');
  assert.match(text, /No more of this good today; it returns tomorrow\./);
  assert.equal(byAttribute(root, 'data-buy', 'herbs').getAttribute('disabled'), null);
  // The policy object's own sentence is quoted, and the currency name comes from the payload.
  assert.match(text, /The server says: The shop sells only in-world goods and never land, roles, authority, XP, review power or anything with real-world value\./);
  assert.equal(panel.model().wallet.name, 'Karma Coins');
  // The shop payload carries no ledger of its own, so the karma payload's entries are the ledger.
  assert.match(text, /Spent on herbs — spent 6 Karma Coins/);
  assert.deepEqual(panel.model().categories.map((category) => category.name), ['resource', 'object', 'cosmetic']);
  assert.deepEqual(panel.model().categories.map((category) => category.label), ['Resource', 'Object', 'Cosmetic']);
  // A server that names the unit something else is followed rather than corrected.
  const named = shopModel({ currency: 'karma', balance: 1, goods: [] });
  assert.equal(named.currency, 'karma');
  assert.equal(coinText(1, 'karma'), '1 karma');
  assert.equal(coinText(2, 'karma'), '2 karma');
});
