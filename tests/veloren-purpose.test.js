import test from 'node:test';
import assert from 'node:assert/strict';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import * as hud from '../src/veloren-ext/view.js';
import {gatherFacts, goalStatus, insightOf, loadCharter, loadResearch, loadRoles, researchStatus, validateResearch} from '../src/veloren-ext/research.js';
import {tasksFor, tasksLines} from '../src/veloren-ext/tasks.js';
import {factsFor, replyFor} from '../src/veloren-ext/npc-logic.js';
import {buildOverview} from '../src/veloren-ext/overview.js';
import {VILLAGERS} from '../src/veloren-ext/villagers.js';
import {loadDiscoveries} from '../src/veloren-ext/world-life.js';
import {resetObserver} from '../src/veloren-ext/village.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const discoveries = loadDiscoveries();
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}, ...discoveries.map((d) => ({id: d.landmark_id, name: d.name, role: 'place'}))];
const T0 = new Date(2026, 9, 14, 10, 5).getTime();
function setup(t) {
  const clock = {now: T0};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  resetObserver();
  const lyra = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  return {clock, link, lyra};
}
let seq = 100;
const send = (s, kind, extra = {}) => {
  seq += 1;
  const e = {v: 1, server_id: 'purpose', seq, kind, resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice', landmark_id: null, occurred_at: s.clock.now, ...extra};
  e.sig = signEvent(KEY, e);
  return s.link.ingest(s.link.authenticate(s.lyra.token, 'events'), [e])[0];
};

test('the charter, research queue and role logic are valid, ordered and peaceful', () => {
  const research = loadResearch();
  assert.ok(research.techs.length >= 8);
  assert.throws(() => validateResearch({format: 'harr-research-v1', techs: [{id: 'aa', name: 'A', cost: 5, needs: ['bb'], text: 't', effects: {}}]}), /must come earlier/);
  assert.throws(() => validateResearch({format: 'harr-research-v1', techs: [{id: 'aa', name: 'A', cost: 5, needs: [], text: 't', effects: {pantry_rate: 99}}]}), /unsafe effect/);
  assert.throws(() => validateResearch({format: 'harr-research-v1', techs: [{id: 'aa', name: 'A', cost: 5, needs: [], text: 't', effects: {grant_coins: 1}}]}), /unknown or unsafe/);
  const charter = loadCharter();
  assert.deepEqual(charter.principles.map((p) => p.id), ['scholarship', 'research', 'cooperation', 'growth', 'discovery', 'abundance']);
  const roles = loadRoles();
  for (const role of new Set(VILLAGERS.map((v) => v.role))) assert.ok(roles[role], `${role} has job logic`);
  const text = JSON.stringify([charter, research, roles]).toLowerCase();
  for (const word of ['kill', 'fight', 'attack', 'weapon', 'enemy', 'battle', 'blood', 'dungeon', 'loot', 'raid', 'steal', 'slay']) assert.ok(!text.includes(word), word);
});

test('insight comes from recorded facts and the queue learns in order, with prerequisites', () => {
  const research = loadResearch();
  const facts = (o) => ({finds: 0, places: 0, stages: 0, projectsDone: new Set(), events: 0, meals: 0, ...o});
  assert.equal(researchStatus(facts({}), research).unlocked.length, 0);
  assert.equal(insightOf(facts({finds: 2, stages: 3, projectsDone: new Set(['well']), events: 4}), research), 2 * 2 + 3 + 3 + 4);
  const s = researchStatus(facts({finds: 3}), research); // 6 insight = field notes
  assert.deepEqual(s.unlocked.map((t) => t.id), ['field-notes']);
  assert.ok(s.insight >= 6);
  // learning field notes makes later finds worth more
  assert.equal(insightOf(facts({finds: 3}), research, s.unlocked), 3 * 3);
  const more = researchStatus(facts({finds: 50, stages: 30, events: 30}), research);
  assert.ok(more.unlocked.length >= 6);
  assert.ok(more.effects.pantry_rate > 1 && more.effects.pantry_cap > 0);
  assert.equal(researchStatus(facts({finds: 3}), research).current.id, 'soil-science');
  const goals = goalStatus(facts({places: 10, meals: 40, projectsDone: new Set(['well', 'cottage-1'])}), more, loadCharter());
  assert.deepEqual(goals.filter((g) => g.done).map((g) => g.id).sort(), ['catalogue', 'water']);
  assert.equal(goals.find((g) => g.id === 'homes').progress, 1);
});

test('facts are gathered from stored events only, and the research page and pantry boost follow them', (t) => {
  const s = setup(t);
  assert.equal(gatherFacts(s.link).finds, 0);
  for (const d of discoveries.slice(0, 3)) send(s, 'landmark.visited', {landmark_id: d.landmark_id});
  const facts = gatherFacts(s.link);
  assert.equal(facts.finds, 3); assert.equal(facts.places, 3);
  const page = hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'research'});
  assert.equal(page.open, true);
  assert.match(page.lines.join(' '), /3 finds/);
  assert.match(page.lines.join(' '), /Field notes/);
  assert.match(hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'purpose'}).lines[0], /scholars, makers and neighbours/);
});

test('a newcomer gets a short task list with exactly one next step, derived from facts', (t) => {
  const s = setup(t);
  let tasks = tasksFor(s.link, ALICE);
  assert.equal(tasks.length, 6);
  assert.equal(tasks.filter((x) => x.done).length, 0);
  assert.match(tasksLines(s.link, ALICE)[1], /^Next: Meet five villagers \(0 of 5\)/);
  for (const r of ['lw-lyra']) send(s, 'resident.met');
  send(s, 'landmark.visited', {landmark_id: discoveries[0].landmark_id});
  tasks = tasksFor(s.link, ALICE);
  assert.equal(tasks.find((x) => x.id === 'find').done, true);
  assert.equal(tasks.find((x) => x.id === 'meet').progress, 1);
  s.link.sql.run("INSERT INTO pantry_takes(cmd_id,order_id,player_uuid,player_alias,item,qty,day,created_at,state) VALUES('c','o',?,'A','apple',2,'d',?,'delivered')", ALICE, T0);
  assert.equal(tasksFor(s.link, ALICE).find((x) => x.id === 'meal').done, true);
  for (const line of tasksLines(s.link, ALICE)) assert.ok(!/coin|reward|kill|fight/i.test(line));
});

test('villagers answer about their work from live facts and the purpose from the charter', (t) => {
  const s = setup(t);
  const by = (role) => VILLAGERS.find((v) => v.role === role);
  assert.match(replyFor(s.link, by('farmer'), 'what do you do?'), /pantry holds \d+ apples/);
  assert.match(replyFor(s.link, by('scholar'), 'tell me about your research'), /insight/);
  assert.match(replyFor(s.link, by('keeper'), 'when is the story circle?'), /Market hour|Story circle/);
  assert.match(replyFor(s.link, by('builder'), 'what are you building?'), /raising|finished/);
  assert.match(replyFor(s.link, by('maker'), 'why harr?'), /scholars, makers and neighbours/);
  assert.equal(replyFor(s.link, by('maker'), 'nice weather'), null);
  assert.ok(factsFor(s.link, by('farmer')).includes('pantry'));
  // wired into the scripted reply path
  assert.match(s.link.scriptedReply(by('farmer'), 'what is your work?', ALICE), /pantry/);
});

test('the dashboard overview carries everything in one document and no private data', (t) => {
  const s = setup(t);
  send(s, 'landmark.visited', {landmark_id: discoveries[1].landmark_id});
  const o = buildOverview(s.link, T0);
  assert.deepEqual(Object.keys(o).sort(), ['chronicle', 'gameplay', 'generated_at', 'library', 'pantry', 'purpose', 'research', 'rhythm', 'roles', 'works']);
  assert.equal(o.purpose.principles.length, 6);
  assert.equal(o.library.length, discoveries.length);
  assert.equal(o.library.filter((l) => l.found).length, 1);
  assert.ok(o.works.length >= 8 && o.roles.length === 6 && o.rhythm.length === 3);
  const text = JSON.stringify(o);
  assert.ok(!text.includes(ALICE) && !text.includes('Alice'), 'no player id or name');
});
