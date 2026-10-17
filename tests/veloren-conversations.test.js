import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VelorenLink} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import {PLACEHOLDERS, ROLE_IDS, conversationReply, fillTemplate, loadConversations, matchAnswer, placeholdersIn, validateConversations, valuesFor} from '../src/veloren-ext/conversations.js';
import {loadRoles} from '../src/veloren-ext/research.js';
import {replyFor} from '../src/veloren-ext/npc-logic.js';
import {VILLAGERS} from '../src/veloren-ext/villagers.js';
import {loadDiscoveries} from '../src/veloren-ext/world-life.js';
import {resetObserver} from '../src/veloren-ext/village.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const raw = () => JSON.parse(readFileSync(new URL('../content/harr-conversations.json', import.meta.url), 'utf8'));
const doc = loadConversations();
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}, ...loadDiscoveries().map((d) => ({id: d.landmark_id, name: d.name, role: 'place'}))];
const link = (t) => {
  const l = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => new Date(2026, 9, 14, 10, 5).getTime(), extensions: EXTENSIONS});
  t.after(() => { try { l.close(); } catch { /* closed */ } });
  resetObserver();
  return l;
};
const villager = (role) => VILLAGERS.find((v) => v.role === role);

test('six roles, eight answers each, with 2-4 keywords and only the four allowed placeholders', () => {
  assert.deepEqual(Object.keys(doc.roles).sort(), [...ROLE_IDS]);
  const used = new Set();
  for (const role of ROLE_IDS) {
    assert.equal(doc.roles[role].length, 8, role);
    for (const e of doc.roles[role]) {
      assert.ok(e.keywords.length >= 2 && e.keywords.length <= 4);
      for (const p of placeholdersIn(e.answer)) { assert.ok(PLACEHOLDERS.includes(p)); used.add(p); }
    }
  }
  assert.deepEqual([...used].sort(), [...PLACEHOLDERS].sort(), 'every placeholder is used somewhere');
  assert.deepEqual([...PLACEHOLDERS].sort(), ['insight', 'pantry', 'project', 'stage']);
});

test('keywords never collide with the role topics npc-logic answers first, nor within a role', () => {
  const roles = loadRoles();
  for (const role of ROLE_IDS) {
    const all = doc.roles[role].flatMap((e) => e.keywords);
    assert.equal(new Set(all).size, all.length, `${role}: repeated keyword`);
    for (const k of all) for (const topic of roles[role].topics) assert.ok(!k.includes(topic), `${role}: "${k}" contains topic "${topic}"`);
  }
});

test('the validator refuses unknown placeholders, clashing keywords, wrong counts and long answers', () => {
  const bad = (mutate) => { const d = raw(); mutate(d); return d; };
  assert.throws(() => validateConversations(bad((d) => { d.roles.farmer[0].answer = 'Plenty of {coins} here for everyone to see, said the farmer kindly.'; })), /not available/);
  assert.throws(() => validateConversations(bad((d) => { d.roles.farmer[0].keywords[0] = 'harvest time'; })), /caught first/);
  assert.throws(() => validateConversations(bad((d) => { d.roles.builder.pop(); })), /8 answers/);
  assert.throws(() => validateConversations(bad((d) => { d.roles.maker[0].answer = 'x'.repeat(201); })), /40-200/);
  assert.throws(() => validateConversations(bad((d) => { d.roles.keeper[1].keywords[0] = d.roles.keeper[0].keywords[0]; })), /twice/);
  assert.throws(() => validateConversations(bad((d) => { delete d.roles.courier; })), /six roles/);
  assert.throws(() => validateConversations(bad((d) => { d.roles.scholar[0].answer += ' {project'; })), /stray brace|40-200/);
});

test('peaceful vocabulary: nothing violent, competitive, scarce, monetary or linked', () => {
  const text = readFileSync(new URL('../content/harr-conversations.json', import.meta.url), 'utf8').toLowerCase();
  const banned = /\b(?:kill|fight|attack|slay|weapon|enemy|battle|blood|dungeon|loot|raid|war|steal|theft|hunt\w*|danger\w*|scarc\w*|debt|conquer\w*|conquest|compet\w*|rival\w*|prey|predator\w*|coins?|money|gold|price|cost|pay|buy|purchase)(?:s|ed|ing|er|ers)?\b/;
  assert.equal(text.match(banned), null, text.match(banned)?.[0]);
  assert.equal(text.match(/https?:\/\/|www\.|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/), null);
});

test('matching and filling are pure and fall back to plain words', () => {
  assert.equal(matchAnswer('farmer', 'tell me about the bees').id, 'bees');
  assert.equal(matchAnswer('farmer', 'anything about hovercraft'), null);
  assert.equal(matchAnswer('nobody', 'bees'), null);
  assert.equal(fillTemplate('We hold {pantry} and {insight}.', {pantry: '3 apples', insight: 12}), 'We hold 3 apples and 12.');
  assert.equal(fillTemplate('No {holes} here', {}), 'No {holes} here', 'unknown braces are left alone, never executed');
});

test('villagers answer from the facts: pantry, insight and the works board are filled in', (t) => {
  const l = link(t);
  const farmer = conversationReply(l, villager('farmer'), 'what do you cook with your recipe?');
  assert.match(farmer, /apples/);
  assert.ok(!/[{}]/.test(farmer));
  const scholar = conversationReply(l, villager('scholar'), 'is there a school?');
  assert.match(scholar, /\d+ insight/);
  const builder = conversationReply(l, villager('builder'), 'show me the plan');
  assert.ok(!/[{}]/.test(builder));
  assert.match(builder, /The plans for /);
  assert.equal(conversationReply(l, villager('builder'), 'hovercraft'), null);
  assert.equal(conversationReply(l, {id: 'x'}, 'bees'), null);
  const v = valuesFor(l, '{project} {stage} {insight} {pantry}');
  for (const key of PLACEHOLDERS) assert.ok(String(v[key]).length > 0, key);
});

test('every one of the 48 answers fills to a bounded chat line for a villager of that role', (t) => {
  const l = link(t);
  for (const role of ROLE_IDS) for (const e of doc.roles[role]) {
    const out = conversationReply(l, villager(role), e.keywords[0]);
    assert.ok(out && out.length <= 260 && out.length > 30, `${role}/${e.id}: ${out}`);
    assert.ok(!/[{}]/.test(out));
  }
});

test('npc-logic still answers work-topics first, and uses these answers only afterwards', (t) => {
  const l = link(t);
  const farmer = villager('farmer');
  assert.match(replyFor(l, farmer, 'what is in the pantry?'), /pantry|grow/i, 'the base topic wins');
  assert.match(replyFor(l, farmer, 'tell me about the orchard'), /orchard/i);
  assert.equal(replyFor(l, farmer, 'tell me about hovercraft'), null);
  assert.match(replyFor(l, villager('scholar'), 'what is a telescope for?'), /star meadow/i);
});
