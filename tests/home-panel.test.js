// The home panel: an operator's AI residents' vaults (counts and an erase action, never a note) and the
// two independent visiting switches of each garden and cottage, plus the passport summary.
//
// These are the pure halves of the component, asserted on created nodes through the same tiny in-test
// DOM the other UI module tests use (`tests/shop-panel.test.js`), and the static structure of the
// module, the catalogue row, the stylesheet and app.js. Against a real server it is
// `tests/home-panel-http.test.js`; in real Chrome it is the `home-vault-interface` scenario.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ERASE_WARNING, MODE_LABELS, NO_VAULT_SENTENCE, OPERATOR_SIGHT, REDUCED_MOTION_CLASS, SWITCH_RULE, TOUCH_TARGET_MIN,
  bytesText, createHomePanel, homeSummaryModel, homeSummaryView, policyLines, prefersReducedMotion, spaceModel, vaultModel, vaultSentence, visitingSentence,
} from '../src/ui/home-panel.js';
import { SECTIONS, menuGroups, sectionById } from '../src/ui/command-deck.js';

const read = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const source = read('src/ui/home-panel.js');
const app = read('app.js');
const css = read('nemo-theme.css');
const server = read('server.js');

// What `GET /vault?agent_id=…` answers a signed-in operator, with the text VAULT_POLICY carries.
const POLICY = {
  summary: 'The vault holds a resident\'s own private notes as ciphertext. The operator can see how many notes exist and erase them, but a vault read needs the resident\'s own runtime credential.',
  sealed: 'Server-sealed: unreadable from the database, an export or a backup, and unreadable to other residents and operators. The server host, holding its master key, can read a note while the resident is running.',
  agent: 'Resident-held key: the server stores only ciphertext and never receives the key, so neither the operator nor the host can read it. Losing the key loses the notes.',
  effect: 'A vault note is never evidence. It cannot create a calling receipt, a memory fact, a claim, a coin, a plot right, a review or a permission.',
};
const vaultStatus = (extra = {}) => ({ agent_id: 'ada', name: 'Ada', enrolled: true, mode: 'sealed', notes: 3, bytes: 2048, updated_at: '2026-10-15T09:30:00Z', limits: { slots: 64, note_chars: 2000, total_bytes: 131072 }, policy: POLICY, modes: ['sealed', 'agent'], ...extra });
const world = (id, visibility) => ({ id, name: id, visibility });
const entry = (overrides = {}) => ({ resident: { id: 'ada', name: 'Ada', kind: 'agent' }, vault: vaultStatus(), garden: world('home:ada', 'public'), cottage: world('house:ada', 'private'), ...overrides });

// A tiny in-test DOM. It throws if anything ever assigns innerHTML — the shipped shell contains none.
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
const paintInto = (panel) => {
  const document = fakeDocument();
  const root = new FakeElement('div', document);
  panel.paint(root, { document });
  return { root, document };
};
const ready = (rows = [entry()], options = {}) => {
  const sent = { visibility: [], erase: [] };
  const panel = createHomePanel({ onVisibility: (id, patch) => sent.visibility.push({ id, patch }), onErase: (id) => sent.erase.push(id), ...options });
  panel.update({ residents: rows });
  return { panel, sent };
};

test('the operator sees whether a vault exists, its key model, the note count and the bytes', () => {
  const { panel } = ready();
  const { root } = paintInto(panel);
  const vault = byAttribute(root, 'data-home-vault', 'ada');
  assert.equal(vault.getAttribute('data-vault-enrolled'), 'true');
  assert.equal(vault.getAttribute('data-vault-mode'), 'sealed');
  assert.match(vault.textContent, /Sealed by the server\. 3 notes, 2\.0 KiB \(room for 64 notes\)\./);
  assert.match(vault.textContent, /Last written \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./);
  const held = ready([entry({ vault: vaultStatus({ mode: 'agent', notes: 1, bytes: 300 }) })]);
  assert.match(byAttribute(paintInto(held.panel).root, 'data-home-vault', 'ada').textContent, /Held by the resident\. 1 note, 300 bytes/);
  assert.equal(MODE_LABELS.sealed, 'Sealed by the server');
  assert.equal(MODE_LABELS.agent, 'Held by the resident');
  const none = ready([entry({ vault: vaultStatus({ enrolled: false, mode: null, notes: 0, bytes: 0, updated_at: null }) })]);
  const noneVault = byAttribute(paintInto(none.panel).root, 'data-home-vault', 'ada');
  assert.equal(noneVault.getAttribute('data-vault-enrolled'), 'false');
  assert.match(noneVault.textContent, new RegExp(NO_VAULT_SENTENCE.slice(0, 40)));
  assert.equal(byAttribute(noneVault, 'data-home-erase', 'ada').getAttribute('aria-disabled'), 'true', 'there is nothing to erase');
});

test('who can read the vault is the server’s own VAULT_POLICY text for that key model, never an invented claim', () => {
  const sealed = ready();
  const sealedText = byAttribute(paintInto(sealed.panel).root, 'data-home-vault', 'ada').textContent;
  for (const line of [POLICY.summary, POLICY.sealed, POLICY.effect]) assert.ok(sealedText.includes(line), `shows: ${line.slice(0, 40)}`);
  assert.equal(sealedText.includes(POLICY.agent), false, 'a sealed vault is not described with the resident-held sentence');
  const held = ready([entry({ vault: vaultStatus({ mode: 'agent' }) })]);
  const heldText = byAttribute(paintInto(held.panel).root, 'data-home-vault', 'ada').textContent;
  assert.ok(heldText.includes(POLICY.agent) && !heldText.includes(POLICY.sealed));
  assert.deepEqual(policyLines(vaultModel(vaultStatus())), [POLICY.summary, POLICY.sealed, POLICY.effect]);
  // A payload without a policy shows no statement at all; the panel writes none of its own.
  assert.deepEqual(policyLines(vaultModel(vaultStatus({ policy: undefined }))), []);
  // The source never states a privacy claim of its own: it names none of the reading rules the server does.
  assert.equal(/ciphertext|master key|the host can/i.test(source.replace(/\/\/.*$/gm, '')), false, 'the module carries no privacy claim in its strings');
  assert.match(OPERATOR_SIGHT, /only whether a vault exists/);
});

test('the operator view can never carry a note, a slot map or a key check', () => {
  const leaky = vaultStatus({ slots: [{ slot: 1, version: 2 }], key_check: 'AAAA', notes_text: 'my secret plan', text: 'my secret plan', ciphertext: 'zzzz' });
  const model = vaultModel(leaky);
  assert.deepEqual(Object.keys(model).sort(), ['bytes', 'enrolled', 'mode', 'mode_label', 'notes', 'policy', 'ready', 'slots', 'total_bytes', 'updated_at']);
  assert.equal(typeof model.notes, 'number', 'notes is a count');
  const { panel } = ready([entry({ vault: leaky })]);
  const { root } = paintInto(panel);
  for (const forbidden of ['my secret plan', 'AAAA', 'zzzz']) assert.equal(root.textContent.includes(forbidden), false, `${forbidden} is never drawn`);
  // The module has no request for a note and no field for one.
  assert.equal(/vault\/notes|key_check|\.ciphertext|\.nonce/.test(source), false);
  assert.equal(/vault\/notes|key_check/.test(app.slice(app.indexOf('Home & vault: each AI'), app.indexOf('The free personal space every resident'))), false, 'app.js asks only for the counts');
  assert.deepEqual(Object.keys(vaultModel(null)).includes('text'), false);
});

test('erase asks first, says what is lost, and only the confirm sends it', () => {
  const { panel, sent } = ready();
  let { root } = paintInto(panel);
  byAttribute(root, 'data-home-erase', 'ada').dispatch('click');
  assert.deepEqual(sent.erase, [], 'the first click erases nothing');
  assert.equal(panel.isArmed(), 'ada');
  ({ root } = paintInto(panel));
  const confirm = byAttribute(root, 'data-home-confirm', 'ada');
  assert.equal(confirm.getAttribute('role'), 'group');
  assert.match(confirm.textContent, /Erase Ada’s vault and its 3 notes\?/);
  assert.ok(confirm.textContent.includes(ERASE_WARNING));
  assert.match(confirm.textContent, /Nothing has been erased yet/);
  assert.match(byAttribute(root, 'data-home-confirm-erase', 'ada').textContent, /Erase Ada’s vault permanently/);
  byAttribute(root, 'data-home-cancel', 'ada').dispatch('click');
  assert.deepEqual(sent.erase, [], 'cancel erases nothing');
  assert.equal(panel.isArmed(), null);
  panel.arm('ada');
  ({ root } = paintInto(panel));
  byAttribute(root, 'data-home-confirm-erase', 'ada').dispatch('click');
  assert.deepEqual(sent.erase, ['ada'], 'exactly one request, after the confirm');
  // Until the server answers the same confirmation cannot fire again.
  assert.equal(panel.erase(), null);
  assert.deepEqual(sent.erase, ['ada']);
  // The vault only changes when the next payload says so.
  assert.equal(panel.model().residents[0].vault.notes, 3);
  panel.update({ residents: [entry({ vault: vaultStatus({ enrolled: false, mode: null, notes: 0, bytes: 0, updated_at: null }) })], saved: { agentId: 'ada', text: 'The server erased the vault: 3 notes and the key were deleted.' } });
  const after = paintInto(panel).root;
  assert.match(after.textContent, /The server erased the vault: 3 notes and the key were deleted\./);
  assert.equal(byAttribute(after, 'data-home-vault', 'ada').getAttribute('data-vault-enrolled'), 'false');
});

test('a vault that was never made cannot be armed, and a vault that vanishes cannot stay armed', () => {
  const { panel, sent } = ready([entry({ vault: vaultStatus({ enrolled: false, mode: null, notes: 0, bytes: 0 }) })]);
  assert.equal(panel.arm('ada'), null);
  assert.equal(panel.erase(), null);
  assert.deepEqual(sent.erase, []);
  const armed = ready();
  armed.panel.arm('ada');
  armed.panel.update({ residents: [entry({ vault: vaultStatus({ enrolled: false, mode: null, notes: 0, bytes: 0 }) })] });
  assert.equal(armed.panel.isArmed(), null);
});

test('the garden and the cottage are two independent switches and each sends only its own field', () => {
  const { panel, sent } = ready();
  const { root } = paintInto(panel);
  const garden = byAttribute(root, 'data-home-switch', 'ada:garden');
  const cottage = byAttribute(root, 'data-home-switch', 'ada:cottage');
  assert.equal(garden.getAttribute('role'), 'switch');
  assert.equal(cottage.getAttribute('role'), 'switch');
  assert.equal(garden.getAttribute('aria-checked'), 'true');
  assert.equal(cottage.getAttribute('aria-checked'), 'false');
  assert.equal(garden.textContent, 'Garden open to visitors — On');
  assert.equal(cottage.textContent, 'Cottage open to visitors — Off');
  assert.match(root.textContent, /The garden is open: anyone can visit it\./);
  assert.match(root.textContent, /The cottage is closed: only your account and this resident can enter\./);
  cottage.dispatch('click');
  assert.deepEqual(sent.visibility, [{ id: 'ada', patch: { house_visibility: 'public' } }], 'opening the cottage sends the cottage field only');
  panel.update({ residents: [entry({ cottage: world('house:ada', 'public') })] });
  const second = paintInto(panel).root;
  byAttribute(second, 'data-home-switch', 'ada:garden').dispatch('click');
  assert.deepEqual(sent.visibility[1], { id: 'ada', patch: { visibility: 'private' } }, 'closing the garden sends the garden field only; the server closes the cottage with it');
  panel.update({ residents: [entry({ garden: world('home:ada', 'private'), cottage: world('house:ada', 'private') })] });
  byAttribute(paintInto(panel).root, 'data-home-switch', 'ada:garden').dispatch('click');
  assert.deepEqual(sent.visibility[2], { id: 'ada', patch: { visibility: 'public' } }, 'opening the garden sends the garden field only; the cottage is left to its own switch');
  assert.equal(Object.keys(sent.visibility[2].patch).length, 1);
});

test('the panel says in plain words that closing the garden closes the cottage and opening it does not', () => {
  const { panel } = ready();
  const { root } = paintInto(panel);
  const rule = byAttribute(root, 'data-home-rule', '1');
  assert.equal(rule.textContent, SWITCH_RULE);
  assert.match(SWITCH_RULE, /Closing the garden also closes the cottage\./);
  assert.match(SWITCH_RULE, /Opening the garden does not open the cottage/);
  // Each switch is described by that sentence, so a screen reader hears it with the switch.
  const id = rule.getAttribute('id');
  assert.equal(byAttribute(root, 'data-home-switch', 'ada:garden').getAttribute('aria-describedby'), id);
  assert.equal(byAttribute(root, 'data-home-switch', 'ada:cottage').getAttribute('aria-describedby'), id);
  assert.match(root.textContent, /sends anyone visiting it back to the Commons/);
});

test('a switch moves nothing until the server answers, and a second press cannot race the first', () => {
  const { panel, sent } = ready();
  let { root } = paintInto(panel);
  byAttribute(root, 'data-home-switch', 'ada:cottage').dispatch('click');
  assert.equal(panel.model().residents[0].cottage.visibility, 'private', 'the state is still the server’s last word');
  ({ root } = paintInto(panel));
  assert.equal(byAttribute(root, 'data-home-switch', 'ada:cottage').getAttribute('aria-disabled'), 'true', 'busy while the request is out');
  assert.equal(byAttribute(root, 'data-home-switch', 'ada:cottage').getAttribute('disabled'), null, 'still focusable while busy');
  assert.equal(panel.toggle('ada', 'garden'), null);
  assert.equal(sent.visibility.length, 1);
  panel.update({ residents: [entry({ cottage: world('house:ada', 'public') })], saved: { agentId: 'ada', text: 'The server saved it: the garden is open to visitors and the cottage is open to visitors.' } });
  ({ root } = paintInto(panel));
  assert.equal(byAttribute(root, 'data-home-switch', 'ada:cottage').getAttribute('aria-checked'), 'true');
  assert.match(root.textContent, /The server saved it: the garden is open to visitors and the cottage is open to visitors\./);
});

test('a state the server did not state is never read as open, and its switch is disabled', () => {
  assert.equal(spaceModel({ visibility: 'weird' }).known, false);
  assert.equal(spaceModel(null).open, false);
  const { panel, sent } = ready([entry({ cottage: null })]);
  const { root } = paintInto(panel);
  const cottage = byAttribute(root, 'data-home-switch', 'ada:cottage');
  assert.equal(cottage.getAttribute('disabled'), '');
  assert.match(cottage.textContent, /state not stated/);
  assert.match(root.textContent, /The server has not said who can visit the cottage\./);
  cottage.dispatch('click');
  assert.deepEqual(sent.visibility, []);
  assert.equal(visitingSentence(spaceModel(world('x', 'public')), 'garden'), 'The garden is open: anyone can visit it.');
});

test('a refusal is shown in the server’s own words and is cleared by the next payload', () => {
  const { panel } = ready();
  panel.update({ refusal: { agentId: 'ada', text: 'Only the operator can change visiting settings.' } });
  let { root } = paintInto(panel);
  const words = byAttribute(root, 'data-home-refusal-words', '1');
  assert.equal(words.textContent, 'Only the operator can change visiting settings.');
  assert.equal(words.getAttribute('role'), 'alert');
  assert.equal(byAttribute(root, 'data-home-saved', 'ada'), null, 'a refusal is never shown as a success');
  panel.update({ residents: [entry()] });
  ({ root } = paintInto(panel));
  assert.equal(byAttribute(root, 'data-home-refusal', 'ada'), null);
});

test('several residents each get their own switches, vault and messages', () => {
  const rows = [entry(), entry({ resident: { id: 'bo', name: 'Bo', kind: 'agent' }, vault: vaultStatus({ agent_id: 'bo', enrolled: false, mode: null, notes: 0, bytes: 0 }), garden: world('home:bo', 'private'), cottage: world('house:bo', 'private') })];
  const { panel, sent } = ready(rows);
  panel.update({ refusal: { agentId: 'bo', text: 'Choose public or private visiting.' } });
  const { root } = paintInto(panel);
  assert.equal(byAttribute(root, 'data-home-resident', 'ada').find((node) => node.getAttribute('data-home-refusal') !== null), null, 'Ada shows no refusal');
  assert.ok(byAttribute(root, 'data-home-resident', 'bo').find((node) => node.getAttribute('data-home-refusal') !== null));
  byAttribute(root, 'data-home-switch', 'bo:garden').dispatch('click');
  assert.deepEqual(sent.visibility, [{ id: 'bo', patch: { visibility: 'public' } }]);
});

test('human characters have both independent privacy switches and no vault surface', () => {
  const human = entry({ resident: { id: 'human', name: 'Human builder', kind: 'human' }, garden: world('home:human', 'public'), cottage: world('house:human', 'private') });
  const { panel, sent } = ready([human]);
  const root = paintInto(panel).root;
  assert.ok(byAttribute(root, 'data-home-switch', 'human:garden'));
  assert.ok(byAttribute(root, 'data-home-switch', 'human:cottage'));
  assert.equal(byAttribute(root, 'data-home-vault', 'human'), null, 'even a supplied vault payload cannot create a human vault surface');
  panel.toggle('human', 'cottage');
  assert.deepEqual(sent.visibility.at(-1), { id: 'human', patch: { house_visibility: 'public' } });
  panel.update({ residents: [human] });
  assert.equal(panel.arm('human'), null, 'a human vault cannot be armed');
  const summary = homeSummaryModel(human), tree = homeSummaryView(summary);
  assert.equal(tree.children.filter(Boolean).some(node => node.attrs?.['data-home-summary-vault']), false);
  const links = tree.children.find(node => node.attrs?.class === 'actions')?.children || tree.children.at(-1).children;
  assert.deepEqual(links.filter(Boolean).map(node => node.attrs['data-home-open']), ['privacy']);
});

test('before the server answers the panel says so, and with no character it points to My characters', () => {
  const panel = createHomePanel({});
  assert.match(paintInto(panel).root.textContent, /Asking the server about your residents’ homes\./);
  panel.update({ residents: [] });
  const { root } = paintInto(panel);
  assert.match(root.textContent, /You have no characters yet\. Create one in My characters/);
  assert.equal(byAttribute(root, 'data-home-loading', '1'), null);
  const failed = ready([entry({ error: 'Part of this home could not be read: boom', vault: undefined, garden: undefined, cottage: undefined })]);
  assert.match(paintInto(failed.panel).root.textContent, /Part of this home could not be read: boom/);
});

test('the keyboard contract: every control is a real button, Escape cancels an armed erase, Tab is never intercepted', () => {
  const { panel } = ready();
  const { root } = paintInto(panel);
  for (const node of root.collect().filter((item) => item.getAttribute('role') === 'switch' || item.getAttribute('data-home-erase') !== null)) assert.equal(node.tag, 'button');
  assert.equal(panel.handleKey('Tab'), false);
  assert.equal(panel.handleKey('Escape'), false, 'nothing armed, nothing to cancel');
  panel.arm('ada');
  assert.equal(panel.handleKey('Escape'), true);
  assert.equal(panel.isArmed(), null);
  assert.equal(/preventDefault|trapFocus|keydown/.test(source), false, 'the module installs no key handler of its own');
});

test('focus lands where the player was: the confirm when armed, Erase when cancelled, the same switch after a press', () => {
  const { panel } = ready();
  let { root, document } = paintInto(panel);
  panel.arm('ada');
  ({ root, document } = paintInto(panel));
  assert.equal(document.activeElement, byAttribute(root, 'data-home-confirm-erase', 'ada'));
  panel.cancel();
  ({ root, document } = paintInto(panel));
  assert.equal(document.activeElement, byAttribute(root, 'data-home-erase', 'ada'));
  panel.toggle('ada', 'cottage');
  ({ root, document } = paintInto(panel)); // the press repaints (busy) ...
  assert.equal(document.activeElement, byAttribute(root, 'data-home-switch', 'ada:cottage'), 'the busy switch keeps the focus');
  panel.update({ residents: [entry({ cottage: world('house:ada', 'public') })] });
  ({ root, document } = paintInto(panel)); // ... and so does the server's answer
  assert.equal(document.activeElement, byAttribute(root, 'data-home-switch', 'ada:cottage'));
  panel.focusSection('ada', 'vault');
  ({ root, document } = paintInto(panel));
  assert.equal(document.activeElement, byAttribute(root, 'data-home-anchor', 'ada:vault'));
  panel.focusSection('ada', 'privacy');
  ({ root, document } = paintInto(panel));
  assert.equal(document.activeElement, byAttribute(root, 'data-home-anchor', 'ada:privacy'));
});

test('every state is written out and every control is labelled, so nothing depends on colour or a tooltip', () => {
  const { panel } = ready();
  const { root } = paintInto(panel);
  for (const node of root.collect().filter((item) => item.tag === 'button')) {
    assert.ok((node.getAttribute('aria-label') || node.textContent).trim().length > 3, 'a button has a name');
  }
  assert.equal(/\btitle\s*:|mouseover|mouseenter|:hover/.test(source.replace(/\/\/.*$/gm, '')), false, 'no hover-only information');
  for (const node of root.collect().filter((item) => item.getAttribute('role') === 'group')) assert.ok(node.getAttribute('aria-label') || node.getAttribute('aria-labelledby'), 'a group is named');
  assert.equal(byAttribute(root, 'data-home-panel', '1').getAttribute('aria-busy'), 'false');
});

test('the reduced-motion class is applied when the reader asks for it', () => {
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
  assert.equal(prefersReducedMotion(() => ({ matches: false })), false);
  assert.equal(prefersReducedMotion(), false);
  const calm = createHomePanel({ reducedMotion: () => true });
  calm.update({ residents: [entry()] });
  assert.match(byAttribute(paintInto(calm).root, 'data-home-panel', '1').getAttribute('class'), new RegExp(REDUCED_MOTION_CLASS));
  assert.match(css, /\.ui-home-reduced \*\{transition:none!important;animation:none!important\}/);
});

test('no server string is ever markup, and the module injects none', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { panel } = ready([entry({ resident: { id: 'ada', name: hostile, kind: 'agent' } })]);
  panel.update({ refusal: { agentId: 'ada', text: hostile } });
  const { root } = paintInto(panel);
  assert.ok(root.textContent.includes(hostile), 'shown as text');
  assert.equal(root.collect().some((node) => node.tag === 'img'), false);
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/.test(source), false);
  assert.equal(/\bfetch\(|XMLHttpRequest|localStorage|sessionStorage/.test(source), false, 'the panel sends and stores nothing');
});

test('the passport summary names the garden, the cottage and the vault, and links to both', () => {
  const summary = homeSummaryModel(entry());
  assert.equal(summary.garden, 'The garden is open: anyone can visit it.');
  assert.equal(summary.cottage, 'The cottage is closed: only your account and this resident can enter.');
  assert.match(summary.vault, /Sealed by the server\. 3 notes/);
  const opened = [];
  const document = fakeDocument();
  const root = new FakeElement('div', document);
  // The summary view is the same plain tree; mount it through the panel's own host.
  const panel = createHomePanel({});
  panel.update({ residents: [] });
  const tree = homeSummaryView(summary, { onVault: (id) => opened.push(['vault', id]), onPrivacy: (id) => opened.push(['privacy', id]) });
  assert.equal(tree.attrs['aria-label'], 'Your resident’s home');
  assert.equal(tree.children[0].text, 'Your resident’s home');
  const buttons = (function walk(node) { return [node, ...(node.children || []).flatMap(walk)]; }(tree)).filter((node) => node.tag === 'button');
  assert.deepEqual(buttons.map((node) => node.attrs['data-home-open']), ['vault', 'privacy']);
  buttons[0].on.click();
  buttons[1].on.click();
  assert.deepEqual(opened, [['vault', 'ada'], ['privacy', 'ada']]);
  assert.ok(root && panel);
});

test('the helpers state counts in words and never claim more than the server sent', () => {
  assert.equal(bytesText(0), '0 bytes');
  assert.equal(bytesText(1), '1 byte');
  assert.equal(bytesText(1536), '1.5 KiB');
  assert.equal(bytesText(131072), '128 KiB');
  assert.match(bytesText(null), /did not state/);
  assert.equal(vaultSentence(vaultModel(null)), 'The server has not described this vault yet.');
  assert.equal(vaultSentence(vaultModel(vaultStatus({ enrolled: false, mode: null }))), NO_VAULT_SENTENCE);
  assert.equal(TOUCH_TARGET_MIN, 44);
});

test('Home & vault is in the catalogue, the menu and the panel table, with a 44 px and phone-safe stylesheet', () => {
  const row = sectionById('home');
  assert.equal(row.label, 'Home & vault');
  assert.equal(row.group, 'residents');
  assert.equal(row.needs, 'account');
  assert.match(row.keywords, /vault/);
  assert.match(row.keywords, /cottage/);
  assert.equal(SECTIONS.filter((section) => section.id === 'home').length, 1);
  const signedIn = menuGroups({ account: true, game: true }).find((group) => group.title === 'YOUR RESIDENTS');
  assert.deepEqual(signedIn.items.map((item) => item.id), ['shop', 'coins', 'passport', 'home', 'workshop', 'characters', 'history']);
  assert.equal(menuGroups({ account: false, game: true }).flatMap((group) => group.items).some((item) => item.id === 'home'), false, 'a signed-out visitor is not offered it');
  assert.match(app, /home:renderHomeVault/);
  assert.match(app, /import \{createHomePanel,homeSummaryModel,homeSummaryView\} from '\.\/src\/ui\/home-panel\.js'/);
  assert.match(server, /'shop-panel', 'home-panel', 'command-deck'\]/);
  for (const selector of ['.ui-home-switch', '.ui-home-erase', '.ui-home-confirm-button']) assert.match(css, new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{[^}]*min-height:44px`), `${selector} is at least 44 px`);
  assert.match(css, /@media\(max-width:650px\)\{\.ui-home-resident\{padding:10px\}[^}]*width:100%/);
  assert.match(css, /\.ui-home-switch:focus|:focus-visible/, 'the shared focus ring covers the switches');
});

test('app.js sends the two visiting fields and the erase request exactly as the server documents them', () => {
  const block = app.slice(app.indexOf('Home & vault: each AI'), app.indexOf('The free personal space every resident'));
  assert.match(block, /api\(`\/agents\/\$\{encodeURIComponent\(agentId\)\}\/home`,'PATCH',patch\)/);
  assert.match(block, /api\('\/vault\/manage','POST',\{agent_id:agentId,action:'erase',confirm:true\}\)/);
  assert.match(block, /api\(`\/vault\?agent_id=\$\{id\}`\)/);
  assert.match(block, /refusal={agentId,text:error\.message/, 'the server’s own refusal wording is shown');
  assert.match(block, /homeHost\.addEventListener\('keydown'[^]*homePanel\.handleKey\('Escape'\)[^]*stopPropagation/, 'Escape cancels an armed erase before the shell closes the panel');
  assert.match(app, /parent\.append\(homeSummaryCard\(\)\)/, 'the passport carries the summary');
});
