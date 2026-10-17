import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import {setIdentityProvider} from '../src/veloren-ext/identity.js';
import {VILLAGERS} from '../src/veloren-ext/villagers.js';
import {loadDiscoveries} from '../src/veloren-ext/world-life.js';
import {resetObserver} from '../src/veloren-ext/village.js';
import {PRINCIPLES, STEP_KINDS, dayNumber, evaluateMission, factsOf, loadMissions, missionLines, missionsFor, missionsForDay, validateMissions} from '../src/veloren-ext/story-missions.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const discoveries = loadDiscoveries();
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}, ...discoveries.map((d) => ({id: d.landmark_id, name: d.name, role: 'place'}))];
const at = (y, mo, d, h = 10) => new Date(y, mo - 1, d, h, 5).getTime();
const missions = loadMissions();
const R = VILLAGERS.slice(0, 7).map((v) => v.id);
const raw = () => JSON.parse(readFileSync(new URL('../content/veloren-story-missions.json', import.meta.url), 'utf8'));

function setup(t, now = at(2026, 10, 14)) {
  const clock = {now};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } setIdentityProvider(null); });
  resetObserver();
  const creds = new Map();
  let seq = 1000;
  const send = (resident, kind, player = ALICE, landmark = null, alias = 'Alice') => {
    if (!creds.has(resident)) creds.set(resident, link.issueCredential({resident_id: resident, scopes: ['events'], days: 1}));
    seq += 1;
    const e = {v: 1, server_id: 'missions', seq, kind, resident_id: resident, player_uuid: player, player_alias: alias, landmark_id: landmark, occurred_at: clock.now, ...{}};
    e.sig = signEvent(KEY, e);
    return link.ingest(link.authenticate(creds.get(resident).token, 'events'), [e])[0];
  };
  const meal = (player, n) => link.sql.run("INSERT INTO pantry_takes(cmd_id,order_id,player_uuid,player_alias,item,qty,day,created_at,state) VALUES(?,?,?,?,?,?,?,?,'delivered')", `cmd-${player}-${n}`, `ord-${player}-${n}`, player, 'x', 'apple', 1, '2026-10-14', clock.now);
  return {clock, link, send, meal};
}

test('the catalogue is 12 valid missions, two per principle, 3-4 steps, only the allowed kinds', () => {
  assert.equal(missions.length, 12);
  for (const p of PRINCIPLES) assert.equal(missions.filter((m) => m.principle === p).length, 2, p);
  for (const m of missions) {
    assert.ok(m.steps.length >= 3 && m.steps.length <= 4, m.id);
    for (const s of m.steps) assert.ok(STEP_KINDS.includes(s.kind), `${m.id}: ${s.kind}`);
  }
  assert.deepEqual([...STEP_KINDS].sort(), ['account.linked', 'landmark.together', 'landmark.visited', 'pantry.delivered', 'resident.met']);
  const bad = (mutate) => { const doc = raw(); mutate(doc); return doc; };
  assert.throws(() => validateMissions(bad((d) => { d.missions[0].steps[0].kind = 'command.applied'; })), /not allowed/);
  assert.throws(() => validateMissions(bad((d) => { d.missions[0].steps.pop(); d.missions[0].steps.pop(); })), /3 or 4/);
  assert.throws(() => validateMissions(bad((d) => { d.missions[0].steps[0].count = 99; })), /count/);
  assert.throws(() => validateMissions(bad((d) => { d.missions[1].principle = 'scholarship'; })), /exactly two/);
  assert.throws(() => validateMissions(bad((d) => { d.missions[1].id = d.missions[0].id; })), /repeated/);
});

test('missions are peaceful: no violent, competitive, money or contact words', () => {
  const text = readFileSync(new URL('../content/veloren-story-missions.json', import.meta.url), 'utf8').toLowerCase();
  const banned = /\b(kill|fight|attack|slay|weapon|enemy|battle|blood|dungeon|loot|raid|war|steal|theft|hunt\w*|danger\w*|scarc\w*|debt|conquer\w*|conquest|compet\w*|rival\w*|race|beat|win|lose|coins?|money|gold|price|cost|pay|buy)\b/;
  assert.equal(text.match(banned), null, text.match(banned)?.[0]);
  assert.equal(text.match(/https?:|www\.|@[a-z0-9.-]+\.[a-z]{2,}/), null);
});

test('counting is by distinct targets: the same person or place twice counts once', (t) => {
  const s = setup(t);
  s.send(R[0], 'resident.met');
  s.send(R[0], 'resident.met');
  s.send(R[0], 'resident.met');
  assert.equal(factsOf(s.link, ALICE)['resident.met'], 1);
  s.send(R[1], 'resident.met');
  s.send(R[2], 'resident.met');
  assert.equal(factsOf(s.link, ALICE)['resident.met'], 3);
  s.send('lw-lyra', 'landmark.visited', ALICE, 'disc-hidden-spring');
  s.send('lw-lyra', 'landmark.visited', ALICE, 'disc-hidden-spring');
  s.send('lw-lyra', 'landmark.visited', ALICE, 'lyra-post'); // not a discovery place: not a library find
  assert.equal(factsOf(s.link, ALICE)['landmark.visited'], 1);
  s.send('lw-lyra', 'landmark.visited', ALICE, 'disc-clay-bank');
  assert.equal(factsOf(s.link, ALICE)['landmark.visited'], 2);
  s.send('lw-lyra', 'landmark.together', ALICE, 'lyra-survey');
  s.send('lw-lyra', 'landmark.together', ALICE, 'lyra-survey');
  assert.equal(factsOf(s.link, ALICE)['landmark.together'], 1);
  s.send('lw-lyra', 'landmark.together', ALICE, 'lyra-post');
  assert.equal(factsOf(s.link, ALICE)['landmark.together'], 2);
  s.meal(ALICE, 1);
  s.meal(ALICE, 2);
  assert.equal(factsOf(s.link, ALICE)['pantry.delivered'], 2);
  assert.equal(factsOf(s.link, ALICE)['account.linked'], 0);
  setIdentityProvider(() => ({account_id: 'acc', agent_id: null, display_name: 'Alice'}));
  assert.equal(factsOf(s.link, ALICE)['account.linked'], 1);
});

test('steps are read in order: the chain stops at the first unfinished step and "next" points to it', () => {
  const mission = {id: 'order', title: 'Order', principle: 'growth', blurb: 'b', steps: [
    {kind: 'resident.met', count: 2, label: 'Meet two villagers please.'},
    {kind: 'landmark.visited', count: 1, label: 'Find one place for the library.'},
    {kind: 'resident.met', count: 5, label: 'Meet five villagers in all.'},
  ]};
  const none = evaluateMission(mission, {'resident.met': 0, 'landmark.visited': 0});
  assert.equal(none.chain, 0); assert.equal(none.next.index, 0); assert.equal(none.done, false);
  const skip = evaluateMission(mission, {'resident.met': 2, 'landmark.visited': 0});
  assert.equal(skip.chain, 1); assert.equal(skip.next.index, 1);
  // Step 3 is not satisfied by 2 meetings, and step 2 is the next one even if later steps were already met.
  const later = evaluateMission({...mission, steps: [mission.steps[1], mission.steps[0]]}, {'resident.met': 2, 'landmark.visited': 0});
  assert.equal(later.chain, 0); assert.equal(later.steps[1].done, true); assert.equal(later.next.index, 0);
  const all = evaluateMission(mission, {'resident.met': 9, 'landmark.visited': 4});
  assert.equal(all.done, true); assert.equal(all.next, null); assert.equal(all.chain, 3);
  assert.equal(all.steps[0].progress, 2, 'progress is capped at the target');
});

test('three missions a day rotate by the host date, cover four days of twelve and spread the principles', () => {
  const day = (d) => missionsForDay(missions, at(2026, 10, d)).map((m) => m.id);
  assert.equal(day(14).length, 3);
  assert.deepEqual(day(14), day(14), 'stable within a day');
  assert.deepEqual(missionsForDay(missions, at(2026, 10, 14, 0)).map((m) => m.id), missionsForDay(missions, new Date(2026, 9, 14, 23, 59).getTime()).map((m) => m.id), 'midnight to midnight');
  assert.notDeepEqual(day(14), day(15));
  assert.deepEqual(day(14), day(18), 'twelve missions, three a day: a four-day cycle');
  const seen = new Set();
  for (let d = 14; d < 18; d += 1) { const ids = day(d); ids.forEach((id) => seen.add(id)); assert.equal(new Set(ids).size, 3); }
  assert.equal(seen.size, 12, 'every mission appears within four days');
  for (let d = 1; d <= 28; d += 1) assert.equal(new Set(missionsForDay(missions, at(2026, 10, d)).map((m) => m.principle)).size, 3, `day ${d} offers three different principles`);
  assert.equal(dayNumber(at(2026, 10, 15)) - dayNumber(at(2026, 10, 14)), 1);
});

test('missionLines: bounded, peaceful, shows today\'s three, and follows the clock', (t) => {
  const s = setup(t);
  const lines = missionLines(s.link, ALICE);
  assert.ok(lines.length >= 4 && lines.length <= 10, `${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= 190, `line too long: ${l}`);
  const today = missionsFor(s.link, ALICE).map((m) => m.title);
  assert.equal(today.length, 3);
  for (const title of today) assert.ok(lines.some((l) => l.startsWith(title)), title);
  assert.match(lines[0], /0 of 3 done/);
  s.clock.now = at(2026, 10, 15);
  const tomorrow = missionLines(s.link, ALICE);
  assert.notDeepEqual(tomorrow, lines);
});

test('privacy: one player\'s facts never reach another, and lines carry no names, ids or aliases', (t) => {
  const s = setup(t);
  for (const r of R.slice(0, 6)) s.send(r, 'resident.met', BOB, null, 'Bobby-Tables');
  s.send('lw-lyra', 'landmark.visited', BOB, 'disc-high-view', 'Bobby-Tables');
  s.meal(BOB, 1);
  assert.equal(factsOf(s.link, ALICE)['resident.met'], 0);
  assert.equal(factsOf(s.link, ALICE)['pantry.delivered'], 0);
  assert.equal(factsOf(s.link, BOB)['resident.met'], 6);
  // Try every day of the cycle so every mission is rendered for both players.
  for (let d = 14; d < 18; d += 1) {
    s.clock.now = at(2026, 10, d);
    const forAlice = missionLines(s.link, ALICE).join('\n');
    const forBob = missionLines(s.link, BOB).join('\n');
    for (const text of [forAlice, forBob]) {
      assert.ok(!text.includes('Bobby'), 'no alias');
      assert.ok(!text.includes(ALICE) && !text.includes(BOB), 'no player id');
      assert.ok(!/lw-[a-z]+/.test(text), 'no resident id');
      assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:/i.test(text));
    }
  }
  assert.deepEqual(missionsFor(s.link, ALICE).map((m) => m.steps.map((x) => x.progress)).flat().filter((n) => n > 0), [], 'Alice has made no progress at all');
});

test('story missions are not an HTTP/HUD page yet: view.js does not call missionLines', () => {
  const view = readFileSync(new URL('../src/veloren-ext/view.js', import.meta.url), 'utf8');
  assert.ok(!view.includes('missionLines'), 'story-missions wiring is a documented ask (docs/STORIES_ASKS.md); the missions page is the engine catalogue');
});
