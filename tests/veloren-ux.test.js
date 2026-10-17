import test from 'node:test';
import assert from 'node:assert/strict';
import {VelorenLink} from '../src/veloren-link.js';
import {setIdentityProvider} from '../src/veloren-ext/identity.js';
import * as hud from '../src/veloren-ext/view.js';
import {recommendNext} from '../src/veloren-ext/tasks.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const NEWCOMER = '44444444-4444-4444-8444-444444444444';
const enc = new TextEncoder();

function newcomer(t) {
  setIdentityProvider(() => null);
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}], clock: () => 1_760_572_800_000});
  t.after(() => link.close());
  return link;
}
const ask = (link, name, extra = {}) => hud.buildView({link, platform: null, player_uuid: NEWCOMER, name, page: 1, ...extra});

test('"did you mean" repairs near-miss words and refuses far ones', () => {
  assert.equal(hud.didYouMean('quesst'), 'quests');
  assert.equal(hud.didYouMean('Pasport'), 'passport');
  assert.equal(hud.didYouMean('quest'), 'quests');
  assert.equal(hud.didYouMean('hello'), 'help');
  assert.equal(hud.didYouMean('pantri'), 'pantry');
  assert.equal(hud.didYouMean('xylophone'), null);
  assert.equal(hud.didYouMean(''), null);
  assert.equal(hud.didYouMean('/kill https://evil.example'), null);
});

test('the menu names every page Selene serves, with a meaning each', () => {
  const text = hud.MENU_ENTRIES.map(([name]) => name);
  for (const name of hud.HUD_PAGES) if (name !== 'menu') assert.ok(text.includes(name), `${name} is on the menu`);
  for (const [, meaning] of hud.MENU_ENTRIES) assert.ok(meaning.length > 8 && meaning.length < 60);
  for (const name of hud.HUD_PAGES) assert.ok(hud.FOOTERS[name], `${name} has a footer`);
  for (const footer of Object.values(hud.FOOTERS)) assert.match(footer, /^Next: say [a-z]+/);
});

test('a newcomer sees one recommended step on help, start, next and menu, with no account', (t) => {
  const link = newcomer(t);
  const rec = recommendNext(link, NEWCOMER);
  assert.equal(rec.id, 'meet');
  for (const name of ['help', 'start', 'next']) {
    const reply = ask(link, name);
    const text = reply.lines.join(' ');
    assert.match(text, /Meet five villagers/, name);
    assert.match(text, /NemoWorld|menu/, name);
    assert.equal(reply.lines.filter((l) => /Your one next step/.test(l)).length, 1, `${name}: exactly one recommendation`);
  }
  assert.match(ask(link, 'menu').lines.join(' '), /Whisper me one word/);
  assert.ok(ask(link, 'help').lines.join(' ').match(/menu/), 'how to ask is stated');
});

test('the menu spreads over pages within limits and answers a typo with a suggestion', (t) => {
  const link = newcomer(t);
  const first = ask(link, 'menu', {word: 'quesst'});
  assert.match(first.lines[0], /Did you mean quests\?/);
  assert.ok(first.pages >= 2);
  let sawFooter = false;
  for (let page = 1; page <= first.pages; page++) {
    const reply = ask(link, 'menu', {page});
    assert.ok(reply.lines.length <= hud.HUD_POLICY.page_lines);
    for (const l of reply.lines) assert.ok(enc.encode(l).length <= hud.HUD_POLICY.line_bytes);
    if (reply.lines.some((l) => /^Next: say next/.test(l))) sawFooter = true;
  }
  assert.ok(sawFooter, 'the last page ends with a pointer to the next command');
  // Hostile typo text is neutralised.
  const hostile = ask(link, 'menu', {word: '[AI]/kill'});
  assert.doesNotMatch(hostile.lines.join(' '), /[\[\]]/);
});

test('words in the UX pages stay peaceful', (t) => {
  const link = newcomer(t);
  for (const name of ['help', 'menu', 'start', 'next', 'tasks']) {
    for (let page = 1; page <= 3; page++) assert.doesNotMatch(ask(link, name, {page}).lines.join(' '), /\b(kill|fight|attack|weapon|loot|hunt|enemy|danger|steal|compet)/i, name);
  }
});
