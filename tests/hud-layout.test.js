// The HUD layout rules of the first visual slice, read from the stylesheet text.
//
// The rules exist because panels shared pixels: the transient notice sat on the aim line, the interaction
// prompt sat on the Step-up and First-person toggles, the move-feedback line sat on the objective chips,
// and on a 390 px phone the stacked guide, aim line and prompt covered about three quarters of the world.
// There is no browser in this test runner. Keep the first slice's still-active notice, aim and prompt
// rules, then check the later one-action guide refinement separately: supporting records now live in
// native disclosures rather than four short, independently scrolling cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guideModel, guideView } from '../src/ui/first-play-guide.js';

const source = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const css = source('game-theme.css');
const guideRefinement = css.slice(css.indexOf('/* One useful action stays in view.'));
const block = css.slice(css.indexOf('HUD layout, first visual slice'),css.indexOf('/* One useful action stays in view.'));
const media = (query,text=block) => {
  const start = text.indexOf(`@media(${query}){`);
  assert.ok(start >= 0, `the block has a ${query} section`);
  let depth = 0, index = text.indexOf('{', start);
  const from = index;
  for (; index < text.length; index++) { if (text[index] === '{') depth++; else if (text[index] === '}' && --depth === 0) break; }
  return text.slice(from + 1, index);
};
const desktop = media('min-width:651px'), narrow = media('max-width:650px'), tablet = media('min-width:651px) and (max-width:1279px');
const guidePhone=media('max-width:650px',guideRefinement);

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
  assert.match(guideRefinement,/\.game-guide\{[^}]*mask-image:none/, 'the refined guide has one scroll surface and no mask clipping its disclosures');
});

test('phone: one guide scroll surface, a one-line aim line, a two-line place card, and a prompt above the pad', () => {
  assert.match(guidePhone,/\.game-guide\{top:164px;[^}]*max-height:min\(360px,calc\(100dvh - 440px\)\);display:grid;[^}]*overflow-x:hidden;overflow-y:auto/, 'the later guide rule bounds a single vertical surface above the controls');
  assert.match(guidePhone,/\.game-guide-card\{[^}]*max-height:none;overflow:visible/, 'cards do not introduce nested scrolling or clip their actions');
  assert.match(narrow, /\.world-reticle\{top:72px;[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, 'the aim line is one line');
  assert.doesNotMatch(narrow, /\.world-reticle\{[^}]*display:none/, 'and it is still there for assistive technology');
  assert.match(narrow, /\.game-place \.game-kicker\{display:none\}/);
  assert.match(narrow, /\.game-prompt-host\{bottom:284px\}/, 'the prompt sits above the pad\'s 274 px top edge');
  assert.match(guidePhone,/\.game-guide-next \.game-guide-button\{min-width:44px;min-height:44px\}/);
  // The dismiss control stays a 44 px target: the base rule gives it a 44 px minimum and this block does not shrink it.
  assert.match(css, /\.game-guide-button\{min-width:44px;min-height:44px;/);
  assert.doesNotMatch(narrow, /\.game-guide-button\{[^}]*min-height:[0-3]\d?px/);
});

test('supporting guide records remain operable disclosures, with chat owning its compact screen and touch styles untouched', () => {
  const hidden = [...`${block}${guideRefinement}`.matchAll(/([^{}]+)\{[^}]*display:none/g)].map((match) => match[1].trim()).filter((selector) => !selector.includes('::-webkit-scrollbar'));
  assert.deepEqual(hidden, ['body.game-world .game-place .game-kicker','body.game-world.game-chat-open .game-guide-details'], 'chat temporarily owns the screen; supporting records are available again when it closes');
  const tree=guideView(guideModel({next_step:{id:'meet',title:'Meet Mira',actions:[{id:'message',label:'Message Mira',route:'/messages'}]},encounter:{name:'Mira',actions:[]},resume:{character_name:'Rin',world_id:'commons',x:10,y:6}}));
  const details=tree.children.find(node=>node.tag==='details');
  assert.equal(tree.children[0].attrs['data-guide'],'next','the next action is outside the optional disclosure');
  assert.equal(details.children[0].tag,'summary','native summary supplies keyboard and touch operation');
  const records=details.children[1].children;
  assert.ok(records.some(node=>node.attrs['data-guide']==='encounter'));
  assert.ok(records.some(node=>node.attrs['data-guide']==='resume'));
  assert.equal(/nm-touch/.test(css), false, 'no touch rule is written in the main stylesheet');
  assert.equal(css.includes('game-mobile'), false);
  // The one exception answers an `!important` of its own: the base minimap rule fixes its padding that way.
  assert.deepEqual(block.match(/[^;{}]*!important/g).map((item) => item.trim()), ['padding:4px!important'], 'the block wins by order, not by force');
});
