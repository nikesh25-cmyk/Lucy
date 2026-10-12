import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CALLING_POLICY } from '../src/vocations.js';
import { COIN_POLICY } from '../src/coins.js';

// This repository has no browser automation, so the newcomer flow is checked three ways: the
// renderer's wiring is asserted from source, the accessibility figures are recomputed from the two
// shipped stylesheets, and the client-side draft/focus logic is evaluated on its own with a stub
// localStorage. No assertion here claims a human clicked through a browser.

const source = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const app = source('app.js');
const page = source('index.html');
const base = source('style.css');
const theme = source('nemo-theme.css');

// --- a small cascade reader over the two stylesheets -------------------------------------------
// Selectors are matched verbatim and the last declaration in file order wins, which is exactly how
// an equal-specificity override in nemo-theme.css (loaded after style.css) resolves. Declarations
// inside a media query are read as if the query matched, which is the small-screen case this task
// cares about and the strictest one for target sizes.
function rules(text) {
  const found = [];
  const clean = withoutPrint(text).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = [...block[2].matchAll(/([a-zA-Z-]+)\s*:\s*([^;]+)/g)].map((declaration) => [declaration[1].trim(), declaration[2].trim()]);
    for (const selector of block[1].split(',').map((item) => item.trim()).filter(Boolean)) found.push({ selector, declarations });
  }
  return found;
}
// Print rules never reach a screen, so they are removed before the cascade is read.
function withoutPrint(text) {
  let clean = text;
  for (;;) {
    const start = clean.indexOf('@media print{');
    if (start < 0) return clean;
    let depth = 0;
    for (let index = clean.indexOf('{', start); index < clean.length; index++) {
      if (clean[index] === '{') depth++;
      else if (clean[index] === '}' && --depth === 0) { clean = clean.slice(0, start) + clean.slice(index + 1); break; }
    }
  }
}
const cascade = [...rules(base), ...rules(theme)];
function declaration(selector, property) {
  let value = null;
  for (const rule of cascade) if (rule.selector === selector) for (const [name, found] of rule.declarations) if (name === property) value = found;
  return value;
}
const rootValue = (name) => declaration(':root', name);
function resolve(value) {
  return String(value ?? '').replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => rootValue(name) ?? '');
}
const firstHex = (value) => (String(value ?? '').match(/#[0-9a-fA-F]{6}/) || [null])[0];
function channels(color) {
  const hex = firstHex(color).slice(1);
  return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
}
function luminance(color) {
  const [r, g, b] = channels(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(foreground, background) {
  const a = luminance(resolve(foreground)), b = luminance(resolve(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function blend(foreground, alpha, background) {
  const top = channels(foreground), bottom = channels(background);
  return `#${top.map((value, index) => Math.round(value * alpha + bottom[index] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}
const round = (value) => Math.round(value * 100) / 100;

test('the guided newcomer flow states each of the six steps and keeps every control textual', () => {
  for (const name of ['renderStartJourney', 'newcomerJourneyCard', 'newcomerSteps', 'newcomerStepsList', 'newcomerReceiptCard', 'newcomerBoundaryCard', 'newcomerControlsCard', 'markNewcomerStep', 'walkToTileForm', 'attachLocalDraft', 'restoreRememberedFocus', 'resumePendingWork']) {
    assert.match(app, new RegExp(`function ${name}\\(`), `${name} must exist in app.js`);
  }
  // The six steps the task names, in order, as list items with a status each.
  const steps = app.slice(app.indexOf('function newcomerSteps()'), app.indexOf('function newcomerStepsList()'));
  const titles = [...steps.matchAll(/title: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(titles, [
    'Enter as a human, or create an AI resident',
    'Choose a calling',
    'Meet a country ambassador',
    'Complete one saved practice activity',
    'Read its receipt',
    'Understand how real contribution review works',
  ]);
  assert.match(app, /element\('ol', null, 'newcomer-steps'\)/, 'the journey is an ordered list');
  assert.match(app, /newcomer-step \$\{standing\}/, 'each step carries a machine-readable state');
  assert.match(app, /item\.setAttribute\('aria-label', `Step \$\{index \+ 1\} of \$\{steps\.length\}/, 'each step is named for assistive technology');
  assert.match(app, /const views = \{ start: renderStartJourney,/, 'the guided start is a rendered section');
  assert.match(app, /\[\['start','Start here','◇'\]/, 'the navigation lists the guided start');
  assert.match(app, /names=\{[\s\S]*?start:'book-open'\}/, 'the navigation entry borrows an existing shipped icon');
  assert.doesNotMatch(app, /innerHTML/, 'app.js must never inject markup');
  assert.doesNotMatch(app, /\$\([^)]*\)\.html\s*=/, 'app.js must never assign markup');
  // Every step offers at least one labelled button and one paragraph of honest explanation.
  assert.match(app, /controls: actions\(/, 'each step carries concrete controls');
  assert.match(app, /const target = document\.getElementById\('newcomer-review'\); if \(target\) target\.scrollIntoView\(/, 'the flow can jump to the boundary card, or open it when it is on another section');
  assert.match(app, /item\.append\(paragraph\(step\.detail, 'privacy'\)\)/, 'each step explains itself in text');
  // The home page carries only the waiting step; the whole path lives in the guided section.
  assert.match(app, /const next = steps\.findIndex\(\(step\) => !step\.done\);/, 'the compact card finds the waiting step');
  assert.match(app, /if \(next >= 0\) node\.append\(newcomerStepsList\(next\)\);/, 'the compact card renders one step only');
});

test('the flow explains the first-person controls and the map fallback in the flow itself', () => {
  assert.match(app, /const NEWCOMER_CONTROLS = 'Controls, in both views\./, 'the controls note is authored copy, not an afterthought');
  assert.match(app, /W A S D or the arrow keys to walk/, 'the 3D keyboard path is named');
  assert.match(app, /the aim line under the view names the tile you face/, 'the aim line is explained as the text equivalent');
  assert.match(app, /falls back to the pixel map/, 'the pixel map fallback is explained');
  assert.match(app, /Walk to a tile plans a route from typed coordinates/, 'the typed coordinates path is named');
  assert.match(app, /the World list is a text view of every place and participant/, 'the text alternative is named');
  assert.match(app, /Nothing in this journey needs a mouse, a drag or a hover\./, 'the promise is stated plainly');
  assert.match(app, /node\.append\(paragraph\(NEWCOMER_CONTROLS\)/, 'the note is rendered by the journey');
  // The fallback is real, not just described: the world view offers a typed-coordinate walk.
  assert.match(app, /if \(agent\) journey\.append\(walkToTileForm\(agent, world\)\);/, 'the world view renders the text-mode walk form');
  assert.match(app, /await walkTo\(x, y\)\) notice\(`Walked to \$\{x\}, \$\{y\}\.`\)/, 'the typed route uses the same planner as the map');
});

test('cosmetic calling experience and NemoCoins are described separately and agree with the server policy', () => {
  // The rendered figures are checked against the server constants rather than trusted as copy.
  const xp = app.match(/const NEWCOMER_XP = Object\.freeze\(\{ per_objective: (\d+), daily_limit: (\d+) \}\)/);
  const coins = app.match(/const NEWCOMER_COINS = Object\.freeze\(\{ award: (\d+), operator_daily_limit: (\d+) \}\)/);
  assert.ok(xp && coins, 'both fallback policy literals must exist');
  assert.equal(Number(xp[1]), CALLING_POLICY.experience_per_objective, 'the stated per-objective experience must equal CALLING_POLICY');
  assert.equal(Number(xp[2]), CALLING_POLICY.daily_experience_limit, 'the stated daily experience limit must equal CALLING_POLICY');
  assert.equal(Number(coins[1]), COIN_POLICY.award, 'the stated coin amount must equal COIN_POLICY');
  assert.equal(Number(coins[2]), COIN_POLICY.operator_daily_limit, 'the stated operator daily limit must equal COIN_POLICY');
  assert.equal(CALLING_POLICY.currency, false, 'cosmetic experience is not a currency on the server');
  assert.equal(COIN_POLICY.transferable, false, 'coins are not transferable on the server');
  // The renderer prefers the live payload over the fallback, so the numbers cannot drift silently.
  assert.match(app, /const policy = state\.callings\?\.policy;/, 'the experience figures prefer the calling payload');
  assert.match(app, /const policy = state\.journey\?\.coins\?\.policy;/, 'the coin figures prefer the wallet payload');
  // The wording itself.
  assert.match(app, /Cosmetic calling experience \(XP\)/, 'the cosmetic lane is named');
  assert.match(app, /NemoCoins/, 'the coin lane is named');
  assert.match(app, /What reaching the review boundary means: your submitted evidence waits for that independent human\./, 'the review boundary is stated');
  assert.match(app, /You cannot accept your own work, a sibling character of your operator cannot accept it, and an approval is not proof of external impact\./, 'the independence rule is stated without overclaiming');
  assert.match(app, /Practice activity mints nothing, so a practice-only resident stays at zero\./, 'a practice activity is not a coin path');
  assert.match(app, /Calling experience never becomes a NemoCoin\./, 'the two records are never conflated');
  assert.match(app, /It cannot be transferred, spent, sold or exchanged, and it creates no authority/, 'cosmetic experience claims no value or authority');
  assert.match(app, /the only route from this world to a real reward is an independent human acceptance of a real task/, 'the only coin route is named');
  // A practice activity is credited from a saved server fact, and the receipt shown is that fact.
  assert.match(app, /It is credited only from that saved fact, and it mints no coins\./, 'the practice step names its source');
  assert.match(app, /function practiceReceipt\(\)/, 'the receipt card reads the real ledger view');
  assert.match(app, /return receipt\.source_kind !== 'research_accepted';/, 'an independently accepted real contribution is never counted as the newcomer’s practice receipt');
  assert.match(app, /\)\?\.practice === true;/, 'only a step of an authored practice chain counts as practice');
  assert.match(app, /receipt\.source_kind\} · \$\{receipt\.source_id/, 'the receipt shows the saved source');
});

test('the dialog contract holds: every dialog is named, escapable and marks what is required', () => {
  // index.html: each dialog is a native modal with an accessible name and a labelled close control.
  const dialogs = [...page.matchAll(/<dialog[^>]*>/g)].map((match) => match[0]);
  assert.equal(dialogs.length, 2, 'the shell ships two dialogs');
  for (const dialog of dialogs) assert.match(dialog, /aria-labelledby="[^"]+"/, `${dialog} must be named by a heading`);
  assert.match(page, /id="close-auth" class="icon-button" aria-label="Close account dialog"/, 'the account dialog has a labelled close button');
  assert.match(page, /id="close-credential"/, 'the credential dialog has a close button');
  // app.js must never trap the keyboard inside a dialog: no cancel interception, no world shortcut
  // that steals a key while a dialog is open, and an explicit close control on each dialog.
  assert.doesNotMatch(app, /addEventListener\(['"]cancel['"]/, 'a dialog cancel must never be intercepted');
  assert.doesNotMatch(app, /preventDefault\(\)[^;]{0,80}\.close\(\)/, 'a close must never be cancelled from a handler');
  assert.match(app, /document\.querySelector\('dialog\[open\]'\)/, 'the world keyboard map stands down while any dialog is open');
  assert.match(app, /\$\('#close-auth'\)\.addEventListener\('click',\(\)=>\$\('#auth-dialog'\)\.close\(\)\);/, 'Escape or the labelled button closes the account dialog');
  assert.match(app, /\$\('#credential-dialog'\)\.addEventListener\('close', \(\) => \{ \$\('#credential-value'\)\.textContent = ''; \}\);/, 'the credential dialog clears its one-time value when it closes');
  assert.match(app, /const close=button\('Close',\(\)=>dialog\.close\(\),'secondary small'\)/, 'the ambassador dialog can be closed without a pointer');
  // Required fields are visible, not hidden behind a failed submit.
  assert.match(app, /input\.required = required;/, 'the native required flag is still set');
  assert.match(app, /label\.append\(element\('small', \[required \? 'Required\.' : 'Optional\.', hint\]\.filter\(Boolean\)\.join\(' '\), 'hint field-requirement'\)\);/, 'every control states whether it is required');
  assert.match(app, /input\.setAttribute\('aria-label', labelText\)/, 'every control is named');
});

test('focus, drafts and guided progress are persisted in this browser and restored after a refresh', () => {
  assert.match(app, /\/\/ newcomer-persistence:start/, 'the persistence block is marked for this test');
  assert.match(app, /const DRAFT_PREFIX = 'nemoworld-draft:'/);
  assert.match(app, /const NEWCOMER_KEY = 'nemoworld-newcomer'/);
  assert.match(app, /const FOCUS_KEY = 'nemoworld-focus'/);
  // Wiring: the two account forms and any form that opts in keep a local draft, and a successful
  // submit clears it; the client also remembers which control had the cursor.
  assert.match(app, /const inputs = form\(login, 'Sign in',[\s\S]*?'auth-login'\);/, 'the sign-in form keeps a local draft');
  assert.match(app, /const register = form\(signup,[\s\S]*?'auth-register'\);/, 'the account-creation form keeps a local draft');
  assert.match(app, /if \(section\) \{ node\.dataset\.draftSection = section; attachLocalDraft\(node, section\); \}/, 'opt-in forms attach the draft');
  assert.match(app, /node\.addEventListener\('focusin', \(event\) => \{ if \(event\.target\?\.name\) rememberFocus\(section, event\.target\.name\); \}\);/, 'focus memory follows the cursor');
  assert.match(app, /if \(section\) \{ clearDraftValues\(section\); forgetFocus\(\); \}/, 'a successful submit clears its own draft');
  assert.match(app, /await refresh\(\);render\(\);resumePendingWork\(\);/, 'boot restores the remembered work');
  assert.match(app, /if \(!state\.account && \['auth-login', 'auth-register'\]\.includes\(remembered\.section\)\) openAuth\(/, 'a half-finished account form is reopened');
  assert.match(app, /if \(!remembered\.section \|\| !Object\.keys\(draftValues\(remembered\.section\)\)\.length\) return false;/, 'nothing is reopened without a draft');
  // Guided progress is remembered, and the review acknowledgement is explicit.
  assert.match(app, /function newcomerComplete\(id, acknowledged = null\)/, 'guided progress is written to this browser only');
  assert.match(app, /newcomerComplete\('ambassador'\)/, 'meeting an ambassador is remembered');
  assert.match(app, /markNewcomerStep\('review', next\)/, 'the review acknowledgement is remembered');
});

// The block between the markers is evaluated on its own with a stub store, so the restore rules are
// proved as logic rather than as text.
function persistence() {
  const start = app.indexOf('// newcomer-persistence:start'), end = app.indexOf('// newcomer-persistence:end');
  assert.ok(start > 0 && end > start, 'the persistence block must be delimited');
  const block = app.slice(start, end);
  const factory = new Function('localStorage', `return (() => { ${block}\n return { draftValues, saveDraftValues, clearDraftValues, rememberFocus, rememberedFocus, forgetFocus, newcomerProgress, saveNewcomerProgress, newcomerComplete }; })()`);
  const store = () => { const data = new Map(); return { data, getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key) }; };
  return { factory, store };
}

test('a stub store proves the draft round-trip, the field isolation and the corrupt-value fallback', () => {
  const { factory, store } = persistence();
  const local = store(), api = factory(local);
  assert.deepEqual(api.draftValues('auth-register'), {}, 'a missing draft is empty, not an error');
  assert.deepEqual(api.saveDraftValues('auth-register', { name: 'A newcomer', email: 'a@example.org', invite: '' }), { name: 'A newcomer', email: 'a@example.org' });
  assert.deepEqual(api.draftValues('auth-register'), { name: 'A newcomer', email: 'a@example.org' }, 'a refresh restores exactly what was typed');
  assert.deepEqual(api.draftValues('auth-login'), {}, 'one form never restores another form’s values');
  // Clearing every value removes the record instead of leaving an empty shell behind.
  api.saveDraftValues('auth-register', { name: '' });
  assert.deepEqual(api.draftValues('auth-register'), {});
  assert.equal(local.data.has('nemoworld-draft:auth-register'), false, 'an emptied form leaves no draft');
  // A hand-edited store must never break the client.
  local.setItem('nemoworld-draft:auth-register', '{not json');
  assert.deepEqual(api.draftValues('auth-register'), {}, 'corrupt JSON falls back to empty');
  local.setItem('nemoworld-draft:auth-register', '["a list, not a draft"]');
  assert.deepEqual(api.draftValues('auth-register'), {}, 'a non-object value falls back to empty');
  local.setItem('nemoworld-draft:auth-register', '{"name":7,"email":"a@example.org"}');
  assert.deepEqual(api.draftValues('auth-register'), { email: 'a@example.org' }, 'only string values are restored');
  api.clearDraftValues('auth-register');
  assert.deepEqual(api.draftValues('auth-register'), {});
});

test('a stub store proves the focus memory and the guided progress, including in a private window', () => {
  const { factory, store } = persistence();
  const local = store(), api = factory(local);
  assert.deepEqual(api.rememberedFocus(), { section: '', field: '' }, 'no remembered control by default');
  api.rememberFocus('auth-register', 'email');
  assert.equal(api.rememberedFocus().section, 'auth-register');
  assert.equal(api.rememberedFocus().field, 'email', 'the cursor returns to the field it left');
  api.forgetFocus();
  assert.deepEqual(api.rememberedFocus(), { section: '', field: '' }, 'a completed form forgets its own cursor');

  assert.deepEqual(api.newcomerProgress(), { completed: [], acknowledged: false });
  api.newcomerComplete('ambassador');
  api.newcomerComplete('ambassador');
  assert.deepEqual(api.newcomerProgress().completed, ['ambassador'], 'a completed step is recorded once');
  api.newcomerComplete('review', true);
  assert.equal(api.newcomerProgress().acknowledged, true, 'the review acknowledgement is remembered');
  api.newcomerComplete('review', false);
  assert.equal(api.newcomerProgress().acknowledged, false, 'and can be taken back');
  api.newcomerComplete('review', false);
  assert.deepEqual(api.newcomerProgress().completed, ['ambassador', 'review'], 'repeating a step adds no duplicate');
  local.setItem('nemoworld-newcomer', 'null');
  assert.deepEqual(api.newcomerProgress(), { completed: [], acknowledged: false }, 'a null record is tolerated');

  // A private window (or a full quota) must degrade to "no draft", never to a thrown error.
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('blocked'); } };
  const blocked = factory(throwing);
  assert.equal(blocked.saveDraftValues('auth-register', { name: 'x' }).name, 'x', 'the caller still gets its own values back');
  assert.deepEqual(blocked.draftValues('auth-register'), {}, 'and nothing is restored when storage is unavailable');
  assert.deepEqual(blocked.newcomerProgress(), { completed: [], acknowledged: false });
});

test('measured text contrast in these stylesheets meets WCAG AA, including the values that were fixed', () => {
  // Every pair is read out of the shipped stylesheets and resolved through the same cascade the
  // browser applies, so a later edit that lowers a ratio fails this test.
  const panel = rootValue('--panel'), background = rootValue('--bg');
  const pairs = {
    'body text on the page': [rootValue('--ink'), background],
    'body text on a panel': [rootValue('--ink'), panel],
    'secondary text on the page': [rootValue('--muted'), background],
    'secondary text on a panel': [rootValue('--muted'), panel],
    'secondary text on the world footer': ['#bccbc0', declaration('.world-bottom', 'background')],
    'gold heading on the page': [rootValue('--gold'), background],
    'gold heading on a panel': [rootValue('--gold'), panel],
    'primary button label': [declaration('button', 'color'), declaration('button', 'background')],
    'input value': [declaration('input', 'color'), declaration('input', 'background')],
    'input placeholder': [declaration('input::placeholder', 'color'), declaration('input', 'background')],
    'field hint': [declaration('.privacy', 'color'), panel],
    'badge label': [declaration('.badge', 'color'), blend(declaration('.badge', 'background'), 0.09, panel)],
    'error message': [declaration('.error', 'color'), blend(declaration('.error', 'background'), 0.16, panel)],
    'calling objective mark': [declaration('.objective-mark', 'color'), declaration('.calling-story', 'background')],
    'completed objective mark': [declaration('.calling-objective.complete .objective-mark', 'color'), declaration('.calling-story', 'background')],
    'calling HUD text': [declaration('.calling-hud', 'color'), declaration('.calling-hud', 'background')],
    'aim line text': [declaration('.world-reticle', 'color'), declaration('.world-reticle', 'background')],
    'land plot tile': [declaration('.plot-grid .plot-cell', 'color'), declaration('.plot-grid .plot-cell', 'background')],
    'land atlas area': [declaration('.land-atlas .land-area', 'color'), declaration('.land-atlas .land-area', 'background')],
    'newcomer lane text': [declaration('.newcomer-lane', 'color'), declaration('.newcomer-lane', 'background')],
    'skip link': [declaration('.skip', 'color'), declaration('.skip', 'background')],
  };
  const measured = {};
  for (const [label, [foreground, background_]] of Object.entries(pairs)) {
    assert.ok(firstHex(resolve(foreground)) && firstHex(resolve(background_)), `${label} must resolve to two real colours`);
    const ratio = round(contrast(foreground, background_));
    measured[label] = ratio;
    assert.ok(ratio >= 4.5, `${label} is ${ratio}:1 and must reach 4.5:1`);
  }
  // The four corrections this task made started below the threshold and must stay above it.
  assert.ok(measured['calling objective mark'] >= 4.5 && measured['completed objective mark'] >= 4.5, 'the objective marks must stay readable');
  assert.ok(measured['land plot tile'] >= 4.5 && measured['land atlas area'] >= 4.5, 'the light land tiles must stay readable');
  // Non-text contrast: the focus ring and the primary button edge are at least 3:1 against the page.
  const focus = firstHex(resolve(declaration(':focus-visible', 'outline')));
  assert.ok(round(contrast(focus, background)) >= 3, 'the focus ring must reach 3:1');
  assert.ok(round(contrast(focus, panel)) >= 3, 'the focus ring must stay visible on a panel');
  console.log(`        measured contrast: ${Object.entries(measured).map(([label, ratio]) => `${label} ${ratio}:1`).join('; ')}; focus ring ${round(contrast(focus, background))}:1`);
});

test('measured touch targets in these stylesheets are at least 44 pixels on the supported sizes', () => {
  const targets = {
    'primary button': ['button', 'min-height'],
    'secondary small button': ['button.small', 'min-height'],
    'navigation tab': ['.tabs button', 'min-height'],
    'movement control': ['.movement button', 'min-height'],
    'frame-relative control': ['.movement button', 'min-width'],
    'text field': ['input', 'min-height'],
    'session control on a small screen': ['#session-bar button', 'min-height'],
    'dialog close control': ['.icon-button', 'min-height'],
    'dialog close control width': ['.icon-button', 'min-width'],
    'frontier hotbar button': ['.frontier-hotbar button', 'min-height'],
    'land plot tile': ['.plot-grid .plot-cell', 'min-height'],
    'land atlas area': ['.land-atlas .land-area', 'min-height'],
  };
  const measured = {};
  for (const [label, [selector, property]] of Object.entries(targets)) {
    const value = declaration(selector, property);
    assert.ok(value, `${selector} must declare ${property}`);
    const pixels = Number.parseFloat(value);
    measured[label] = pixels;
    assert.ok(pixels >= 44, `${label} is ${pixels}px and must reach 44px`);
  }
  // The password reveal sits inside a 44-pixel field: it stays above the 24-pixel AA floor even
  // though it is deliberately smaller than the primary targets.
  const reveal = Number.parseFloat(declaration('.password-reveal', 'min-height'));
  measured['password reveal (inline)'] = reveal;
  assert.ok(reveal >= 24, 'the inline password reveal must stay above the 24px WCAG 2.2 AA minimum');
  assert.match(theme, /@media\(pointer:coarse\)\{button\.small\{min-height:44px\}/, 'a coarse pointer raises the small targets at any width, not only on a narrow screen');
  console.log(`        measured targets: ${Object.entries(measured).map(([label, pixels]) => `${label} ${pixels}px`).join('; ')}`);
});

test('the shipped copy promised by the flow is also the behaviour the routes implement', async () => {
  // The countdown sentence in the flow must match the number of steps the renderer builds.
  assert.match(app, /Six steps take a newcomer from arriving to understanding how real work is reviewed:/, 'the intro promises six steps');
  assert.match(app, /const NEWCOMER_INTRO = 'Six steps/, 'and the promise is the rendered string');
  // The interface says a practice chain needs no review and mints nothing; the quest module says the
  // same thing, so the wording and the behaviour come from one rule rather than two.
  const quests = source('src/quests.js');
  assert.match(quests, /coins_awarded: 0|coins_awarded:0/, 'the quest policy publishes that no coin is awarded');
  assert.match(app, /A quest chain cannot mint them/, 'the interface repeats that rule to the reader');
  assert.match(app, /Guild projects/, 'the guild section keeps its own coinless statement');
  assert.match(app, /Practice tasks, duplicate work, social activity and gardening do not earn coins\./, 'the guide keeps the coin exclusion list');
});
