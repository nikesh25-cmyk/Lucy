// The scoped stylesheet for the touch controls: game-mobile.css.
//
// This file exists because game-mobile.css is a *new* stylesheet that the integration owner imports
// and the main stylesheets (style.css, nemo-theme.css, game-theme.css) are read-only. So the two
// things it must prove are (1) that nothing in it can reach the desktop interface, and (2) that the
// numbers it claims — 44-pixel targets, readable contrast, no width that forces horizontal
// scrolling — are actually in the file rather than in a hand-off document.
//
// Every value below is recomputed from the stylesheet text. Nothing here is a browser measurement;
// there is no browser automation in this repository's test runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AFFORDANCES, PAD_DIRECTIONS, TOUCH_TARGET_MIN } from '../src/ui/touch-controls.js';

const source = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const mobile = source('game-mobile.css');
const touchModule = source('src/ui/touch-controls.js');
const base = source('style.css');
const theme = source('nemo-theme.css');
const game = source('game-theme.css');
const page = source('index.html');

// --- a media-query-aware reader: each rule keeps the at-rules that wrap it -------------------------
function parseStylesheet(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const context = [];
  let buffer = '';
  for (let index = 0; index < clean.length;) {
    const char = clean[index];
    if (char === '{') {
      const head = buffer.trim();
      buffer = '';
      if (head.startsWith('@')) { context.push(head); index++; continue; }
      let depth = 1, body = '', cursor = index + 1;
      while (cursor < clean.length && depth > 0) {
        if (clean[cursor] === '{') depth++;
        else if (clean[cursor] === '}') { depth--; if (depth === 0) break; }
        body += clean[cursor]; cursor++;
      }
      rules.push({
        selectors: head.split(',').map((item) => item.trim()).filter(Boolean),
        declarations: [...body.matchAll(/([a-zA-Z-]+)\s*:\s*([^;]+)/g)].map((match) => [match[1].trim(), match[2].trim()]),
        context: [...context],
      });
      index = cursor + 1;
      continue;
    }
    if (char === '}') { context.pop(); buffer = ''; index++; continue; }
    buffer += char; index++;
  }
  return rules;
}
const rules = parseStylesheet(mobile);
const allSelectors = rules.flatMap((rule) => rule.selectors);
const allClasses = [...new Set(allSelectors.flatMap((selector) => selector.match(/\.nm-touch[a-z0-9-]*/gi) || []))];

function declarationsOf(selector, property) {
  const found = [];
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    for (const [name, value] of rule.declarations) if (name === property) found.push({ value, context: rule.context });
  }
  return found;
}
/** The last declaration in file order, which is the one a browser's equal-specificity cascade keeps. */
function effective(selector, property) {
  const found = declarationsOf(selector, property);
  return found.length ? found[found.length - 1].value : null;
}
const required = (selector, property) => {
  const value = effective(selector, property);
  assert.ok(value !== null, `${selector} must declare ${property} in game-mobile.css`);
  return value;
};

const colorOf = (value) => {
  const match = String(value ?? '').match(/#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?/);
  if (!match) return null;
  return { hex: `#${match[1]}`, alpha: match[2] ? parseInt(match[2], 16) / 255 : 1 };
};
const channels = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** A translucent colour composited over the surface behind it, so a ratio is measured, not assumed. */
const over = (value, background) => {
  const colour = colorOf(value);
  assert.ok(colour, `${value} must be a real colour`);
  if (colour.alpha >= 1) return colour.hex;
  const top = channels(colour.hex), bottom = channels(background);
  return `#${top.map((channel, index) => Math.round(channel * colour.alpha + bottom[index] * (1 - colour.alpha)).toString(16).padStart(2, '0')).join('')}`;
};
const round = (value) => Math.round(value * 100) / 100;
const px = (value) => Number.parseFloat(String(value));

// --- scoping --------------------------------------------------------------------------------------
test('every selector in this stylesheet is scoped to the controls container', () => {
  assert.ok(rules.length >= 15, `the stylesheet must actually style the controls (${rules.length} rules found)`);
  for (const selector of allSelectors) {
    assert.match(selector, /^\.nm-touch\b/, `${selector} must start with the .nm-touch container class`);
  }
  // No bare element selector, no id from the desktop shell and no utility class of another module.
  assert.doesNotMatch(mobile, /(^|[};])\s*(button|input|select|textarea|body|html|canvas|h1|h2|h3|p|div|span|a)\s*[{,:]/m, 'no bare element selector');
  for (const selector of allSelectors) assert.doesNotMatch(selector, /#/, `${selector} must not be an id selector`);
  for (const foreign of ['.game-', '.world-', '.tabs', '.card', '.sidebar', '.movement', '.welcome']) {
    assert.equal(allSelectors.some((selector) => selector.includes(foreign)), false, `${foreign} is not this stylesheet's to style`);
  }
  // Every media query is attached to this stylesheet's own selectors only.
  const contexts = [...new Set(rules.flatMap((rule) => rule.context))];
  assert.ok(contexts.length > 0, 'the responsive rules are inside media queries');
  for (const rule of rules.filter((item) => item.context.length > 0)) {
    for (const selector of rule.selectors) assert.match(selector, /^\.nm-touch\b/, `${selector} in ${rule.context.join(' ')} must stay scoped`);
  }
  // The controls never depend on hover, which a touch screen does not have. (`hover:hover` inside
  // the wide-screen media query is an input-device feature, not a selector, and is checked below.)
  for (const selector of allSelectors) {
    assert.doesNotMatch(selector, /:hover/, `${selector} must not depend on a hover state`);
    assert.doesNotMatch(selector, /:focus(?!-visible)/, `${selector} must use :focus-visible, not a bare :focus`);
  }
  // The comments explain the rule; the code must obey it. `hover:hover` is an input-device feature
  // inside the wide-screen query, not a hover state, so it is set aside before the check.
  const code = mobile.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\(hover:hover\)/g, '(hover:FEATURE)');
  assert.equal(/:hover/.test(code), false, 'no declaration is written for a hover state');
});

test('the stylesheet is a new file the main stylesheets do not import, so it cannot leak by being loaded', () => {
  for (const [name, text] of [['style.css', base], ['nemo-theme.css', theme], ['game-theme.css', game]]) {
    assert.equal(text.includes('game-mobile'), false, `${name} must not import or reference game-mobile.css`);
  }
  // Task 37 left the link tag to the integration owner; task 38 adds it, so index.html is now the one
  // place the layer is loaded from and the scoped stylesheet is still the only source of `.nm-touch`.
  assert.equal(page.includes('<link rel="stylesheet" href="/game-mobile.css">'), true, 'the integration owner links the mobile layer from index.html exactly once');
  assert.equal(page.split('game-mobile.css').length - 1, 1, 'the mobile layer is linked once, not twice');
  // The main stylesheets are untouched, so this stylesheet is the only new source of rules.
  assert.equal(/nm-touch/.test(base) || /nm-touch/.test(theme) || /nm-touch/.test(game), false, 'no touch selector exists in the main stylesheets');
});

test('the class names the module renders are the class names this stylesheet styles', () => {
  const staticClasses = ['nm-touch', 'nm-touch-pad', 'nm-touch-camera', 'nm-touch-actions', 'nm-touch-key', 'nm-touch-action', 'nm-touch-look', 'nm-touch-status', 'nm-touch-reduced'];
  for (const name of staticClasses) {
    assert.ok(touchModule.includes(name), `${name} must be rendered by src/ui/touch-controls.js`);
    assert.ok(allSelectors.some((selector) => selector.includes(`.${name}`)), `.${name} must be styled by game-mobile.css`);
  }
  // The dynamic names: one class per pad direction and per affordance.
  assert.match(touchModule, /`nm-touch-key nm-touch-\$\{direction\}`/, 'the pad key class is built from the direction');
  assert.match(touchModule, /`nm-touch-action nm-touch-\$\{item\.name\}`/, 'the affordance class is built from its name');
  for (const direction of PAD_DIRECTIONS) assert.ok(allSelectors.includes(`.nm-touch .nm-touch-${direction}`), `.nm-touch-${direction} must place the ${direction} key`);
  for (const item of AFFORDANCES) assert.ok(allSelectors.some((selector) => selector.includes(`.nm-touch-${item.name}`)), `.nm-touch-${item.name} must be styled`);
  // And nothing in the stylesheet is an orphan rule for a class nobody renders. The two exceptions
  // are the integration owner's documented placement classes.
  const ownerClasses = ['.nm-touch-floating', '.nm-touch-always'];
  for (const name of allClasses) {
    const known = staticClasses.includes(name.slice(1))
      || ownerClasses.includes(name)
      || PAD_DIRECTIONS.map((direction) => `nm-touch-${direction}`).includes(name.slice(1))
      || AFFORDANCES.map((item) => `nm-touch-${item.name}`).includes(name.slice(1));
    assert.ok(known, `${name} is not a class the module renders or the integration owner adds`);
  }
});

// --- measured target sizes ------------------------------------------------------------------------
test('measured touch targets in this stylesheet are at least the project’s 44 pixels', () => {
  const targets = {
    'pad key width': ['.nm-touch .nm-touch-key', 'min-width'],
    'pad key height': ['.nm-touch .nm-touch-key', 'min-height'],
    'action width': ['.nm-touch .nm-touch-action', 'min-width'],
    'action height': ['.nm-touch .nm-touch-action', 'min-height'],
    'pad column minimum': ['.nm-touch .nm-touch-pad', 'grid-template-columns'],
    'pad row minimum': ['.nm-touch .nm-touch-pad', 'grid-template-rows'],
    'camera button width': ['.nm-touch .nm-touch-look', 'min-width'],
  };
  const measured = {};
  for (const [label, [selector, property]] of Object.entries(targets)) {
    const value = required(selector, property);
    const numbers = [...String(value).matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    assert.ok(numbers.length > 0, `${label} (${selector} ${property}: ${value}) must resolve to pixels`);
    const smallest = Math.min(...numbers);
    measured[label] = smallest;
    assert.ok(smallest >= TOUCH_TARGET_MIN, `${label} is ${smallest}px and must reach ${TOUCH_TARGET_MIN}px`);
  }
  // The larger end of the range is also honest: a coarse pointer gets at least 48 pixels.
  assert.ok(measured['pad key height'] >= 48, 'a coarse pointer raises the pad key, not only the text');
  assert.ok(measured['pad column minimum'] >= 48, 'the grid columns raise with it');
  // The 44-pixel floor is not width-gated: the coarse-pointer query applies at every width, which is
  // what covers a wide tablet and a phone in landscape.
  const coarse = rules.filter((rule) => rule.context.some((item) => item === '@media(pointer:coarse)'));
  assert.ok(coarse.length > 0, 'a coarse-pointer block must exist');
  assert.ok(coarse.some((rule) => rule.declarations.some(([name, value]) => name === 'min-height' && px(value) >= 48)), 'the coarse-pointer block raises the key height');
  assert.ok(coarse.some((rule) => rule.declarations.some(([name, value]) => name === 'min-width' && px(value) >= 52)), 'the coarse-pointer block raises the key width');
  console.log(`        measured targets in game-mobile.css: ${Object.entries(measured).map(([label, value]) => `${label} ${value}px`).join('; ')}`);
});

test('measured text and non-text contrast in this stylesheet meets WCAG AA', () => {
  const keyColour = required('.nm-touch .nm-touch-key', 'color');
  const keyBackground = required('.nm-touch .nm-touch-key', 'background');
  const actionColour = required('.nm-touch .nm-touch-action', 'color');
  const actionBackground = required('.nm-touch .nm-touch-action', 'background');
  const pressedColour = required('.nm-touch .nm-touch-key[aria-pressed=true]', 'color');
  const pressedBackground = required('.nm-touch .nm-touch-key[aria-pressed=true]', 'background');
  const disabledColour = required('.nm-touch .nm-touch-key:disabled', 'color');
  const disabledBackground = required('.nm-touch .nm-touch-key:disabled', 'background');
  const statusColour = required('.nm-touch .nm-touch-status', 'color');
  const statusBackground = required('.nm-touch .nm-touch-status', 'background');
  const ring = colorOf(required('.nm-touch .nm-touch-key:focus-visible', 'outline')).hex;
  const keyEdge = required('.nm-touch .nm-touch-key', 'border');
  const worldBackground = source('game-theme.css').match(/body\.game-world\{[^}]*background:(#\w{6})/)?.[1] || '#071b19';

  const pairs = {
    'pad key label': [keyColour, over(keyBackground, worldBackground)],
    'action label': [actionColour, over(actionBackground, worldBackground)],
    'pressed key label': [pressedColour, over(pressedBackground, worldBackground)],
    'disabled key label': [disabledColour, over(disabledBackground, worldBackground)],
    'status text': [statusColour, over(statusBackground, worldBackground)],
  };
  const measured = {};
  for (const [label, [foreground, background]] of Object.entries(pairs)) {
    assert.ok(colorOf(foreground) && colorOf(background), `${label} must resolve to two real colours`);
    measured[label] = round(contrast(over(foreground, background), background));
    assert.ok(measured[label] >= 4.5, `${label} is ${measured[label]}:1 and must reach 4.5:1`);
  }
  // Non-text contrast: the focus ring and the key edge are graphic objects, so 3:1 is the bar.
  measured['focus ring on a key'] = round(contrast(ring, over(keyBackground, worldBackground)));
  measured['focus ring on the world'] = round(contrast(ring, worldBackground));
  measured['key edge on the world'] = round(contrast(over(keyEdge, worldBackground), worldBackground));
  for (const label of ['focus ring on a key', 'focus ring on the world', 'key edge on the world']) {
    assert.ok(measured[label] >= 3, `${label} is ${measured[label]}:1 and must reach 3:1`);
  }
  // The disabled state keeps its own legible colour instead of fading the shell's, because
  // nemo-theme.css already fades every disabled button and an inherited opacity would drop this
  // pair below the threshold.
  assert.equal(px(required('.nm-touch .nm-touch-key:disabled', 'opacity')), 1, 'the disabled control declares its own opacity rather than inheriting the shell’s fade');
  console.log(`        measured contrast in game-mobile.css: ${Object.entries(measured).map(([label, value]) => `${label} ${value}:1`).join('; ')}`);
});

// --- no horizontal scrolling ----------------------------------------------------------------------
test('no declared width can force horizontal scrolling on a small screen', () => {
  // 1. Nothing in the file declares a minimum or fixed width wider than the narrowest screen this
  //    release supports (320 px, the width a 390 px phone reflows to under zoom).
  const widest = [];
  for (const rule of rules) {
    for (const [name, value] of rule.declarations) {
      if (!['width', 'min-width', 'max-width', 'inline-size', 'min-inline-size'].includes(name)) continue;
      if (!/px\s*$/.test(value.trim())) continue;
      const pixels = px(value);
      if (pixels > 320) widest.push(`${rule.selectors.join(', ')} { ${name}: ${value} }`);
    }
  }
  assert.deepEqual(widest, [], 'no width declaration may exceed 320px');
  // 2. The container is a full-width, border-box, wrapping block.
  assert.equal(required('.nm-touch', 'width'), '100%');
  assert.equal(required('.nm-touch', 'max-width'), '100%');
  assert.equal(required('.nm-touch', 'box-sizing'), 'border-box');
  assert.equal(required('.nm-touch .nm-touch-camera', 'flex-wrap'), 'wrap', 'the camera row wraps instead of overflowing');
  assert.equal(required('.nm-touch .nm-touch-actions', 'flex-wrap'), 'wrap', 'the action row wraps instead of overflowing');
  assert.doesNotMatch(mobile, /overflow(-x)?\s*:\s*(scroll|auto|hidden)/, 'nothing is clipped or scrolled sideways');
  assert.doesNotMatch(mobile, /white-space\s*:\s*nowrap/, 'no line is forced to stay one line');
  // 3. The widest unflexible piece is the 3-column pad. Measured: columns x column minimum + gaps,
  //    plus the container's own horizontal padding, against a 320 px viewport.
  const columns = (() => {
    const value = required('.nm-touch .nm-touch-pad', 'grid-template-columns');
    const repeated = /repeat\((\d+)\s*,\s*minmax\((\d+(?:\.\d+)?)px/.exec(value);
    if (repeated) return Array.from({ length: Number(repeated[1]) }, () => Number(repeated[2]));
    return [...value.matchAll(/minmax\((\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  })();
  assert.equal(columns.length, 3, 'the pad is a three-column grid');
  const gap = px(required('.nm-touch .nm-touch-pad', 'gap'));
  const padding = px(String(required('.nm-touch', 'padding')).trim().split(/\s+/)[0]);
  const padMinimum = columns.reduce((total, value) => total + value, 0) + gap * (columns.length - 1);
  const total = padMinimum + padding * 2;
  assert.ok(total <= 320, `the pad needs ${total}px, which must fit a 320px viewport`);
  // The other two rows wrap, so their widest single control is the widest thing they can force.
  const widestControl = Math.max(...['.nm-touch .nm-touch-action', '.nm-touch .nm-touch-look'].map((selector) => px(required(selector, 'min-width'))));
  assert.ok(widestControl + padding * 2 <= 320, `a single control needs ${widestControl + padding * 2}px, which must fit a 320px viewport`);
  console.log(`        measured layout: pad minimum ${padMinimum}px (3 x ${columns[0]}px columns + ${gap}px gaps) + ${padding * 2}px container padding = ${total}px of a 320px viewport; widest single control ${widestControl}px; camera and action rows wrap`);
});

// --- reduced motion -------------------------------------------------------------------------------
test('animation is opt-in and suppressible, and no essential information is carried by motion', () => {
  const animated = rules.filter((rule) => rule.declarations.some(([name]) => name === 'transition' || name === 'animation'));
  assert.ok(animated.length > 0, 'the stylesheet declares the animated states it opts into');
  for (const rule of animated) {
    const asksForMotion = rule.context.some((item) => /prefers-reduced-motion\s*:\s*no-preference/.test(item));
    const suppresses = rule.declarations
      .filter(([name]) => name === 'transition' || name === 'animation')
      .every(([, value]) => String(value).replace(/\s*!important$/, '') === 'none');
    assert.ok(asksForMotion || suppresses, `${rule.selectors.join(', ')} must animate only under a no-preference query or suppress animation outright`);
    assert.ok(!asksForMotion || !suppresses, `${rule.selectors.join(', ')} must not both ask for and suppress motion in one rule`);
  }
  // The suppression exists three ways: the media query, and the class the module sets for a surface
  // whose stylesheet does not honour the query.
  const reduceContexts = rules.filter((rule) => rule.context.some((item) => /prefers-reduced-motion\s*:\s*reduce/.test(item)));
  assert.ok(reduceContexts.length > 0, 'a prefers-reduced-motion: reduce block must exist');
  for (const property of ['transition', 'animation']) {
    assert.ok(reduceContexts.some((rule) => rule.declarations.some(([name, value]) => name === property && value === 'none!important')), `${property} must be switched off under reduce`);
    // The container is covered, so a suppression cannot be added for one child and miss the rest.
    assert.ok(reduceContexts.some((rule) => rule.selectors.includes('.nm-touch')), '.nm-touch must be covered by the reduce block');
    assert.ok(reduceContexts.some((rule) => rule.selectors.includes('.nm-touch *')), 'every control inside must be covered too');
  }
  // The same suppression again, keyed on the class the module sets, for a surface whose stylesheet
  // does not honour the media query (an embedded viewer, a downloaded page, a nested shadow root).
  const reducedRules = rules.filter((rule) => rule.context.length === 0 && rule.selectors.some((selector) => selector.includes('nm-touch-reduced')));
  assert.ok(reducedRules.length > 0, '.nm-touch-reduced must have an unconditional suppression rule');
  assert.ok(reducedRules.some((rule) => rule.selectors.includes('.nm-touch.nm-touch-reduced')), 'the class the module sets on the container must be a selector here');
  assert.ok(reducedRules.some((rule) => rule.selectors.includes('.nm-touch.nm-touch-reduced *')), 'and the controls inside it must inherit the suppression');
  for (const property of ['transition', 'animation']) {
    assert.ok(reducedRules.some((rule) => rule.declarations.some(([name, value]) => name === property && value === 'none!important')), `.nm-touch-reduced must suppress ${property}`);
  }
  assert.match(touchModule, /nm-touch-reduced/, 'and that class is the one src/ui/touch-controls.js toggles');
  // State is never conveyed by colour or motion alone: the pressed key also changes its background,
  // and the state itself is announced by aria-pressed and by the live region.
  assert.ok(required('.nm-touch .nm-touch-key[aria-pressed=true]', 'background') !== required('.nm-touch .nm-touch-key', 'background'), 'a pressed key is visually distinct, not only announced');
  assert.match(touchModule, /setAttribute\('aria-pressed'/, 'the pressed state is a real attribute');
  assert.match(touchModule, /'aria-live', 'polite'/, 'the state is also spoken');
});

test('the only !important declarations are the reduced-motion suppression', () => {
  for (const rule of rules) {
    for (const [name, value] of rule.declarations) {
      if (!value.includes('!important')) continue;
      assert.ok(rule.context.some((item) => /prefers-reduced-motion\s*:\s*reduce/.test(item)) || rule.selectors.some((item) => item.includes('nm-touch-reduced')), `${rule.selectors.join(', ')} { ${name}: ${value} } must not need !important outside the reduced-motion suppression`);
    }
  }
});

test('the touch layer stands down where the desktop controls are the better ones', () => {
  const gate = rules.filter((rule) => rule.context.some((item) => item.includes('min-width:901px')));
  assert.ok(gate.length > 0, 'a wide-screen query must exist');
  assert.ok(gate.some((rule) => rule.selectors.includes('.nm-touch:not(.nm-touch-always)') && rule.declarations.some(([name, value]) => name === 'display' && value === 'none')), 'a wide fine-pointer screen hides the touch layer unless the owner marks it always-on');
  for (const query of gate.flatMap((rule) => rule.context)) {
    assert.match(query, /hover:hover|pointer:fine/, 'the gate must be about the input device, not only the width');
  }
});
