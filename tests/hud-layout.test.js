// The HUD layout rules of the first visual slice, read from the stylesheet text.
//
// The rules exist because panels shared pixels: the transient notice sat on the aim line, the interaction
// prompt sat on the Step-up and First-person toggles, the move-feedback line sat on the objective chips,
// and on a 390 px phone the stacked guide, aim line and prompt covered about three quarters of the world.
// There is no browser in this test runner, so this holds the numbers the browser measurement
// (`scripts/visual-capture.mjs`, reported in docs/handoff/visual-slice-1/) rests on: each fix is present, in
// the width range it was measured for, and the touch layer's own stylesheet contract is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const css = source('game-theme.css');
const block = css.slice(css.indexOf('HUD layout, first visual slice'));
const media = (query) => {
  const start = block.indexOf(`@media(${query}){`);
  assert.ok(start >= 0, `the block has a ${query} section`);
  let depth = 0, index = block.indexOf('{', start);
  const from = index;
  for (; index < block.length; index++) { if (block[index] === '{') depth++; else if (block[index] === '}' && --depth === 0) break; }
  return block.slice(from + 1, index);
};
const desktop = media('min-width:651px'), narrow = media('max-width:650px'), tablet = media('min-width:651px) and (max-width:1279px');

test('the block exists once, after the rules it refines', () => {
  assert.ok(block.length > 2000, 'the slice is present');
  assert.equal(css.split('HUD layout, first visual slice').length - 1, 1);
  assert.ok(css.indexOf('body.game-world .game-guide{position:fixed') < css.indexOf('HUD layout, first visual slice'), 'it follows the guide rule it moves');
  assert.ok(source('nemo-theme.css').indexOf('.game-prompt-host{position:absolute') >= 0, 'the prompt host it moves is still defined in nemo-theme.css, which loads first');
  assert.ok(source('index.html').indexOf('nemo-theme.css') < source('index.html').indexOf('game-theme.css'), 'and game-theme.css loads after it');
});

test('desktop: the notice drops under the aim line, the prompt moves right, the feedback lifts above the chips', () => {
  assert.match(desktop, /#notice:not\(\[hidden\]\)\{top:152px\}/, 'the notice sits below the 84-141 px aim line');
  assert.match(tablet, /#notice:not\(\[hidden\]\)\{top:252px\}/, 'and below the aim line that moves down to 120 px under 1280 px');
  assert.match(desktop, /\.game-prompt-host\{left:auto;right:20px;bottom:160px;/, 'the prompt leaves the left column');
  assert.match(desktop, /\.game-feedback\{bottom:200px\}/, 'the feedback clears the 195 px control band');
  assert.match(desktop, /\.game-building \.game-feedback\{bottom:auto;top:152px\}/, 'and gives the build tools their place while building');
  assert.match(desktop, /mask-image:linear-gradient/, 'the guide fades at its scroll edge instead of cutting a line');
});

test('phone: a short guide strip, a one-line aim line, a two-line place card, and a prompt above the pad', () => {
  assert.match(narrow, /\.game-guide\{top:164px;bottom:auto;[^}]*max-height:116px;display:flex;flex-direction:row;[^}]*overflow-x:auto;overflow-y:hidden/, 'the guide is one card high and scrolls sideways');
  assert.match(narrow, /\.game-guide-card\{[^}]*flex:0 0 min\(86vw,330px\);max-height:116px;overflow-y:auto/, 'each card scrolls inside itself, so no paragraph is lost');
  assert.match(narrow, /\.world-reticle\{top:72px;[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, 'the aim line is one line');
  assert.doesNotMatch(narrow, /\.world-reticle\{[^}]*display:none/, 'and it is still there for assistive technology');
  assert.match(narrow, /\.game-place \.game-kicker\{display:none\}/);
  assert.match(narrow, /\.game-prompt-host\{bottom:284px\}/, 'the prompt sits above the pad\'s 274 px top edge');
  assert.match(narrow, /\.game-guide-next \.game-guide-button\{width:auto;min-width:88px;padding:8px 10px\}/);
  // The dismiss control stays a 44 px target: the base rule gives it a 44 px minimum and this block does not shrink it.
  assert.match(css, /\.game-guide-button\{min-width:44px;min-height:44px;/);
  assert.doesNotMatch(narrow, /\.game-guide-button\{[^}]*min-height:[0-3]\d?px/);
});

test('nothing is hidden outright except the decorative kicker, and the touch stylesheet contract is untouched', () => {
  const hidden = [...block.matchAll(/([^{}]+)\{[^}]*display:none/g)].map((match) => match[1].trim()).filter((selector) => !selector.includes('::-webkit-scrollbar'));
  assert.deepEqual(hidden, ['body.game-world .game-place .game-kicker'], 'only the "LIVE WORLD" kicker is hidden, on a phone (and a scrollbar, which is not content)');
  assert.equal(/nm-touch/.test(css), false, 'no touch rule is written in the main stylesheet');
  assert.equal(css.includes('game-mobile'), false);
  // The one exception answers an `!important` of its own: the base minimap rule fixes its padding that way.
  assert.deepEqual(block.match(/[^;{}]*!important/g).map((item) => item.trim()), ['padding:4px!important'], 'the block wins by order, not by force');
});
