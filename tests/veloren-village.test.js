import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import * as hud from '../src/veloren-ext/view.js';
import {activeSlot, chronicleLines, eventFor, loadEvents, minutesToNext, observe, resetObserver, todayLines, validateEvents} from '../src/veloren-ext/village.js';
import {VILLAGERS} from '../src/veloren-ext/villagers.js';
import {loadDiscoveries, loadWorks} from '../src/veloren-ext/world-life.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const events = loadEvents();
const byId = (id) => events.find((e) => e.id === id);
const discoveries = loadDiscoveries();
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}, ...discoveries.map((d) => ({id: d.landmark_id, name: d.name, role: 'place'}))];
// Local times, so the tests hold in any time zone.
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const SUNDAY = at(2026, 10, 18, 0, 0); // 18 Oct 2026 is a Sunday

function setup(t, now = at(2026, 10, 14, 10, 5)) {
  const clock = {now};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  resetObserver();
  return {clock, link};
}

test('the shipped events are valid, peaceful and fit the clock', () => {
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.id), ['market-hour', 'story-circle', 'festival']);
  const text = JSON.stringify(events).toLowerCase();
  for (const word of ['kill', 'fight', 'attack', 'weapon', 'enemy', 'battle', 'blood', 'dungeon', 'loot', 'raid', 'steal']) assert.ok(!text.includes(word), word);
  assert.throws(() => validateEvents({format: 'nemo-village-events-v1', events: [{...byId('market-hour'), when: {every: 'hour', minute: 55, length: 12}}]}), /inside its hour/);
  assert.throws(() => validateEvents({format: 'nemo-village-events-v1', events: [{...byId('market-hour'), who: {}}]}), /nobody/);
  assert.throws(() => validateEvents({format: 'nemo-village-events-v1', events: [byId('market-hour'), byId('market-hour')]}), /repeated/);
});

test('hourly and weekly slots are on exactly in their window, with no backfill', () => {
  const market = byId('market-hour');
  assert.equal(activeSlot(market, at(2026, 10, 14, 10, 0)), at(2026, 10, 14, 10, 0));
  assert.equal(activeSlot(market, at(2026, 10, 14, 10, 11, 59)), at(2026, 10, 14, 10, 0));
  assert.equal(activeSlot(market, at(2026, 10, 14, 10, 12)), null);
  assert.equal(activeSlot(market, at(2026, 10, 14, 9, 59, 59)), null);
  const story = byId('story-circle');
  assert.equal(activeSlot(story, at(2026, 10, 14, 10, 30)), at(2026, 10, 14, 10, 30));
  assert.equal(activeSlot(story, at(2026, 10, 14, 10, 42)), null);
  const festival = byId('festival');
  assert.equal(activeSlot(festival, at(2026, 10, 18, 15, 0)), at(2026, 10, 18, 15, 0));
  assert.equal(activeSlot(festival, at(2026, 10, 18, 15, 59)), at(2026, 10, 18, 15, 0));
  assert.equal(activeSlot(festival, at(2026, 10, 18, 16, 0)), null);
  assert.equal(activeSlot(festival, at(2026, 10, 17, 15, 30)), null, 'not on a Saturday');
  assert.equal(minutesToNext(market, at(2026, 10, 14, 10, 5)), 55);
  assert.equal(minutesToNext(story, at(2026, 10, 14, 10, 5)), 25);
  assert.equal(minutesToNext(festival, at(2026, 10, 14, 10, 5)), 4 * 1440 + 5 * 60 - 5); // Wed 10:05 -> Sun 15:00
});

test('the right residents go to the right place, and the festival takes everyone', () => {
  const maker = VILLAGERS.find((v) => v.role === 'maker').id;
  const scholar = VILLAGERS.find((v) => v.role === 'scholar').id;
  const builder = VILLAGERS.find((v) => v.role === 'builder').id;
  const noon = at(2026, 10, 14, 10, 3);
  assert.equal(eventFor(events, maker, noon).event.id, 'market-hour');
  assert.equal(eventFor(events, scholar, noon), null);
  assert.equal(eventFor(events, builder, noon), null);
  const half = at(2026, 10, 14, 10, 31);
  assert.equal(eventFor(events, scholar, half).event.landmark_id, 'site-pavilion');
  assert.equal(eventFor(events, 'lw-lyra', half).event.id, 'story-circle');
  assert.equal(eventFor(events, maker, half), null);
  assert.equal(eventFor(events, builder, at(2026, 10, 18, 15, 10)).event.id, 'festival');
  assert.equal(eventFor(events, 'lw-selene', at(2026, 10, 18, 15, 10)).event.id, 'festival');
});

test('the director sends a free resident to the event, a quest keeps priority, and attendance is recorded once', (t) => {
  const s = setup(t, at(2026, 10, 14, 10, 3));
  const maker = VILLAGERS.find((v) => v.role === 'maker').id;
  const plan = s.link.director(maker);
  assert.equal(plan.mode, 'gather');
  assert.equal(plan.target_landmark_id, 'harr-central-plaza');
  s.link.director(maker); s.link.director(maker);
  assert.equal(s.link.sql.get('SELECT COUNT(*) AS n FROM village_attendance').n, 1);
  s.clock.now = at(2026, 10, 14, 10, 20);
  assert.equal(s.link.director(maker).mode, 'work', 'after the slot a maker returns to the active works site, then the routine');
  // Lyra with an active quest keeps her quest order even when her story circle starts
  const cred = s.link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  s.clock.now = at(2026, 10, 14, 10, 31);
  const e = {v: 1, server_id: 'v', seq: 1, kind: 'resident.met', resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice', landmark_id: null, occurred_at: s.clock.now};
  e.sig = signEvent(KEY, e);
  s.link.ingest(s.link.authenticate(cred.token, 'events'), [e]);
  assert.equal(s.link.director('lw-lyra').mode, 'escort');
});

test('the chronicle is built only from stored facts and tells nothing it did not record', (t) => {
  const s = setup(t, at(2026, 10, 14, 10, 3));
  const directory = mkdtempSync(join(tmpdir(), 'village-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const maker = VILLAGERS.find((v) => v.role === 'maker').id;
  const quiet = chronicleLines(s.link, events, s.clock.now).join('\n');
  assert.match(quiet, /Today: a quiet day so far/);
  assert.doesNotMatch(quiet, /held|finished|completed/);
  s.link.director(maker);
  const projects = loadWorks();
  const well = projects.find((p) => p.id === 'well');
  const groups = Object.fromEntries(well.stages.map((st) => [st.id, {}]));
  const recordPath = join(directory, 'world.json');
  writeFileSync(recordPath, JSON.stringify({groups}));
  resetObserver(); observe(s.link, s.clock.now, recordPath);
  // a discovery and a meal
  const cred = s.link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  const v = {v: 1, server_id: 'v', seq: 2, kind: 'landmark.visited', resident_id: 'lw-lyra', player_uuid: ALICE, player_alias: 'Alice [x]', landmark_id: discoveries[0].landmark_id, occurred_at: s.clock.now};
  v.sig = signEvent(KEY, v);
  s.link.ingest(s.link.authenticate(cred.token, 'events'), [v]);
  s.link.sql.run("INSERT INTO pantry_takes(cmd_id,order_id,player_uuid,player_alias,item,qty,day,created_at,state) VALUES('c1','o1',?, 'Alice','apple',2,'d',?,'delivered')", ALICE, s.clock.now);
  const text = chronicleLines(s.link, events, s.clock.now, (a) => hud.plain(a, 24)).join('\n');
  assert.match(text, new RegExp(`Today: ${well.stages.length} building stages finished; 1 project completed; 1 discovery recorded; 2 portions of food shared; market hour held once\\.`));
  assert.match(text, /Milestone, \d{4}-\d{2}-\d{2}: The Plaza well was finished\./);
  assert.match(text, /First page, .*Alice x recorded /);
  assert.ok(!text.includes('['));
  // observing again changes nothing
  resetObserver(); observe(s.link, s.clock.now + 60_000, recordPath);
  assert.equal(s.link.sql.get("SELECT COUNT(*) AS n FROM village_marks WHERE kind='stage'").n, well.stages.length);
});

test('today and chronicle are open pages and the schedule page tells what is on now and what is next', (t) => {
  const s = setup(t, at(2026, 10, 14, 10, 5));
  const today = hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'today'});
  assert.equal(today.open, true);
  const text = today.lines.join('\n');
  assert.match(text, /Market hour at the plaza: on now, ends in 7 min/);
  assert.match(text, /Story circle at the field pavilion: in 25 min/);
  assert.match(text, /Harr festival at the plaza: in 4 d 4 h\./);
  assert.equal(hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'chronicle'}).command, 'chronicle');
  assert.ok(todayLines(events, at(2026, 10, 18, 15, 30)).join(' ').includes('Harr festival at the plaza: on now'));
});
