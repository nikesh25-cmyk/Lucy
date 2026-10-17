import test from 'node:test';
import assert from 'node:assert/strict';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import {setIdentityProvider} from '../src/veloren-ext/identity.js';
import {dailyRotation, loadMissions, missionsFor, missionsLines, stepCount, validateMissions} from '../src/veloren-ext/missions.js';
import {tasksFor, tasksLines} from '../src/veloren-ext/tasks.js';
import {loadDiscoveries} from '../src/veloren-ext/world-life.js';
import {resetObserver} from '../src/veloren-ext/village.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const discoveries = loadDiscoveries();
const LANDMARKS = [
  {id: 'lyra-post', name: 'House', role: 'post'},
  {id: 'lyra-survey', name: 'Field', role: 'survey'},
  {id: 'site-well', name: 'Well Site', role: 'work'},
  ...discoveries.map((d) => ({id: d.landmark_id, name: d.name, role: 'place'})),
];
const T0 = new Date(2026, 9, 17, 10, 5).getTime();

function setup(t) {
  const clock = {now: T0};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } setIdentityProvider(() => null); });
  resetObserver();
  // One credential per resident: the link is resident-scoped, so a fact about a resident can only come from
  // that resident's own credential. "Meet five villagers" therefore needs five of them, which is the point.
  const tokens = {};
  for (const id of ['lw-lyra', 'lw-kael', 'lw-selene', 'lw-rowan', 'lw-vaelen']) {
    tokens[id] = link.issueCredential({resident_id: id, scopes: ['events'], days: 1});
  }
  return {clock, link, tokens};
}
let seq = 5000;
const send = (s, kind, extra = {}, as = 'lw-lyra') => {
  seq += 1;
  const e = {v: 1, server_id: 'missions', seq, kind, resident_id: as, player_uuid: ALICE, player_alias: 'Alice', landmark_id: null, occurred_at: s.clock.now, ...extra};
  e.sig = signEvent(KEY, e);
  return s.link.ingest(s.link.authenticate(s.tokens[as].token, 'events'), [e])[0];
};
const byId = (missions, id) => missions.find((m) => m.id === id);

test('the catalogue is valid, peaceful, and every mission can be checked from a fact', () => {
  const doc = loadMissions();
  assert.ok(doc.missions.length >= 8);
  assert.equal(validateMissions(doc), doc);
  const principles = new Set(doc.missions.map((m) => m.principle));
  assert.deepEqual([...principles].sort(), ['abundance', 'cooperation', 'discovery', 'growth', 'research', 'scholarship']);
  const text = JSON.stringify(doc).toLowerCase();
  for (const word of ['kill', 'fight', 'attack', 'weapon', 'enemy', 'battle', 'blood', 'dungeon', 'loot', 'raid', 'steal', 'slay']) {
    assert.ok(!text.includes(word), word);
  }
  const bad = (patch, what) => {
    const copy = JSON.parse(JSON.stringify(doc));
    patch(copy);
    assert.throws(() => validateMissions(copy), what);
  };
  bad((d) => { d.missions[1].id = d.missions[0].id; }, /repeated mission id/);
  bad((d) => { d.missions[0].principle = 'conquest'; }, /unknown principle/);
  bad((d) => { d.missions[0].steps[0].kind = 'player.killed'; }, /unknown step kind/);
  bad((d) => { d.missions[0].steps[0].count = 0; }, /count must be 1-20/);
  bad((d) => { d.missions[0].steps[0].count = 21; }, /count must be 1-20/);
  bad((d) => { d.missions[0].title = 'Fight the enemy'; }, /violent vocabulary/);
  bad((d) => { d.missions[0].steps[0].distinct = 'player'; }, /distinct must be/);
  bad((d) => { d.missions[1].steps[0].prefix = 'site-'; }, /takes a prefix/);
  bad((d) => { d.missions[2].steps[0].distinct = 'resident'; }, /distinct residents/);
});

test('progress counts distinct targets, only for this player, only for its own facts', (t) => {
  const s = setup(t);
  // meet: five different people, not five meetings.
  for (const resident of ['lw-lyra', 'lw-kael', 'lw-selene', 'lw-rowan', 'lw-vaelen']) {
    send(s, 'resident.met', {}, resident);
  }
  send(s, 'resident.met', {});
  const meet = byId(missionsFor(s.link, ALICE), 'meet');
  assert.equal(meet.progress, 5);
  assert.equal(meet.done, true);
  // Another player's facts are never counted.
  send(s, 'resident.met', {player_uuid: BO, player_alias: 'Bo'});
  assert.equal(byId(missionsFor(s.link, ALICE), 'meet').progress, 5);
  assert.equal(byId(missionsFor(s.link, BO), 'meet').progress, 1);
  // A fact for the wrong target or kind credits nothing: a visit to the house is not a discovery, and
  // walking with a resident is not a discovery either.
  send(s, 'landmark.visited', {landmark_id: 'lyra-post'});
  send(s, 'landmark.together', {landmark_id: discoveries[0].landmark_id});
  const fresh = missionsFor(s.link, ALICE);
  assert.equal(byId(fresh, 'find').progress, 0);
  assert.equal(byId(fresh, 'together').progress, 1);
  // The same event replayed is a duplicate, and does not count twice.
  const replay = {v: 1, server_id: 'missions', seq: 7777, kind: 'project.helped', resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice', landmark_id: 'site-well', occurred_at: T0};
  replay.sig = signEvent(KEY, replay);
  const auth = () => s.link.authenticate(s.tokens['lw-lyra'].token, 'events');
  assert.equal(s.link.ingest(auth(), [replay])[0].status, 'accepted');
  assert.equal(s.link.ingest(auth(), [replay])[0].status, 'duplicate');
  assert.equal(byId(missionsFor(s.link, ALICE), 'help').progress, 1);
});

test('the account link, the pantry and the practice quest are steps, read from their own records', (t) => {
  const s = setup(t);
  const before = missionsFor(s.link, ALICE);
  assert.equal(byId(before, 'link').progress, 0);
  assert.equal(byId(before, 'meal').progress, 0);
  assert.equal(byId(before, 'survey').progress, 0);
  setIdentityProvider((link, uuid) => (uuid === ALICE ? {account_id: 'acct', agent_id: 'agent', display_name: 'Alice'} : null));
  s.link.sql.run("INSERT INTO pantry_takes(cmd_id,order_id,player_uuid,player_alias,item,qty,day,created_at,state) VALUES('c','o',?,'A','apple',2,'d',?,'delivered')", ALICE, T0);
  const after = missionsFor(s.link, ALICE);
  assert.equal(byId(after, 'link').progress, 1);
  assert.equal(byId(after, 'meal').progress, 1);
  // The pantry row alone does not complete the survey: the quest is its own record.
  assert.equal(byId(after, 'survey').progress, 0);
});

test('the short task list and the missions page keep their shape and stay private', (t) => {
  const s = setup(t);
  const tasks = tasksFor(s.link, ALICE);
  assert.equal(tasks.length, loadMissions().missions.length);
  assert.equal(tasksLines(s.link, ALICE)[1].startsWith('Next: Meet five villagers (0 of 5)'), true);
  const page = missionsLines(s.link, ALICE, T0);
  assert.match(page[0], /recorded facts/);
  assert.match(page.join('\n'), /Today \(2026-10-17\)/);
  // No player ids, names or aliases on any page line.
  for (const line of [...page, ...tasksLines(s.link, ALICE)]) {
    assert.ok(!line.includes(ALICE) && !line.includes('Alice'), line);
  }
  assert.ok(page.length <= 24, `page is bounded (${page.length} lines)`);
});

test('the daily rotation is stable within a day, different across days, and always three real missions', () => {
  const doc = loadMissions();
  const ids = new Set(doc.missions.map((m) => m.id));
  const monday = dailyRotation(doc, '2026-10-17');
  const mondayAgain = dailyRotation(doc, '2026-10-17');
  const tuesday = dailyRotation(doc, '2026-10-18');
  assert.deepEqual(monday, mondayAgain);
  assert.equal(monday.length, 3);
  assert.ok(monday.every((id) => ids.has(id)));
  assert.notDeepEqual(monday, tuesday, 'the next day offers a different three');
  // Over a week every mission appears at least once, so nothing is unreachable.
  const seen = new Set();
  for (const day of ['17', '18', '19', '20', '21', '22', '23']) for (const id of dailyRotation(doc, `2026-10-${day}`)) seen.add(id);
  assert.equal(seen.size, ids.size);
});
