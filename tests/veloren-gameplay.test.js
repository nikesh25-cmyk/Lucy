import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VelorenLink} from '../src/veloren-link.js';
import {EXTENSIONS} from '../src/veloren-ext/index.js';
import * as hud from '../src/veloren-ext/view.js';
import {resetObserver} from '../src/veloren-ext/village.js';
import {VILLAGERS} from '../src/veloren-ext/villagers.js';
import {loadDiscoveries} from '../src/veloren-ext/world-life.js';
import {shelfNow, PANTRY_POLICY} from '../src/veloren-ext/pantry.js';
import {libraryNote, loadSeasons, pantryRate, seasonAt, seasonalBlurb, seasonLines, validateSeasons, RATE_MAX, RATE_MIN} from '../src/veloren-ext/seasons.js';
import {GRATITUDE_POLICY, gratitudeExtension, gratitudeLines, thank, wallEntries} from '../src/veloren-ext/gratitude.js';
import {apprenticeLines, apprenticeTaskLine, apprenticeshipCensus, chainFor, loadApprenticeship, mentorReply, validateApprenticeship} from '../src/veloren-ext/apprenticeship.js';
import {completedSurveys, loadExpeditions, recordsOnSheet, sheetFor, surveyFor, surveyLines, validateExpeditions, villageSurvey} from '../src/veloren-ext/expeditions.js';
import {levelFor, levelLines, loadGrowth, validateGrowth, villageLevel, withLevel} from '../src/veloren-ext/growth.js';
import {buildOverview} from '../src/veloren-ext/overview.js';
import {replyFor} from '../src/veloren-ext/npc-logic.js';
import {tasksFor, tasksLines} from '../src/veloren-ext/tasks.js';
import {loadMissions} from '../src/veloren-ext/missions.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CARA = '33333333-3333-4333-8333-333333333333';
const LANDMARKS = [{id: 'lyra-post', name: 'House', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}];
const discoveries = loadDiscoveries();
const DAY = 86_400_000;
// Local times so the tests hold in any time zone (the village runs on the host's clock).
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const NOW = at(2026, 10, 17, 10, 0); // a Saturday in autumn
const FORBIDDEN = /\b(kill|fight|attack|slay|weapon|enemy|battle|blood|dungeon|loot|raid|war|steal|hunt|danger|debt|scarce|scarcity)(?:s|ed|ing|er|ers)?\b/i;

let n = 0;
function setup(t, now = NOW) {
  const clock = {now};
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, extensions: EXTENSIONS});
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  resetObserver();
  return {clock, link};
}
/** A stored signed-event row, written directly (ingest and signatures are covered by veloren-link.test.js). */
function ev(s, kind, player, {resident = 'lw-lyra', landmark = null, alias = 'Alice', t = s.clock.now} = {}) {
  n += 1;
  s.link.sql.run('INSERT INTO link_events(event_id,server_id,seq,kind,resident_id,player_uuid,player_alias,landmark_id,occurred_at,received_at,credential_key_id,signature) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    `gp${n}`, 'gp', n, kind, resident, player, alias, landmark, t, t, 'k', 's');
}
const meet = (s, player, resident, t) => ev(s, 'resident.met', player, {resident, t});
const visit = (s, player, landmark, t, alias = 'Alice') => ev(s, 'landmark.visited', player, {landmark, t, alias});
function alias(s, uuid, name) { s.link.sql.run('INSERT OR REPLACE INTO link_players(player_uuid,alias,first_seen,last_seen) VALUES(?,?,?,?)', uuid, name, NOW, NOW); }
function meal(s, player, t, state = 'delivered') { n += 1; s.link.sql.run("INSERT INTO pantry_takes(cmd_id,order_id,player_uuid,player_alias,item,qty,day,created_at,state) VALUES(?,?,?,?,?,?,?,?,?)", `c${n}`, `o${n}`, player, 'A', 'apple', 2, 'd', t, state); return `c${n}`; }
function mark(s, key, kind, text, t) { s.link.sql.run('INSERT OR IGNORE INTO village_marks(key,kind,text,at) VALUES(?,?,?,?)', key, kind, text, t); }
const by = (role) => VILLAGERS.find((v) => v.role === role);
const disc = (id) => `disc-${id}`;

// ---- shared: peaceful, bounded, honest ---------------------------------------------------------------------------

test('the new content files are valid and use only peaceful words', () => {
  for (const f of ['harr-seasons', 'harr-apprenticeship', 'harr-expeditions', 'harr-growth']) {
    const raw = readFileSync(new URL(`../content/${f}.json`, import.meta.url), 'utf8');
    assert.doesNotMatch(raw, FORBIDDEN, f);
    assert.doesNotMatch(raw, /https?:|www\.|@\w/i, `${f}: no links or contacts`);
  }
  loadSeasons(); loadApprenticeship(); loadExpeditions(); loadGrowth();
});

test('every page and line the new systems produce is peaceful, plain and short', (t) => {
  const s = setup(t);
  meet(s, ALICE, by('builder').id, NOW - 1000);
  for (const name of hud.HUD_PAGES.filter((p) => ['thanks', 'apprentice', 'survey', 'season', 'level', 'tasks', 'library', 'today', 'chronicle'].includes(p))) {
    const view = hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name});
    assert.equal(view.open, true, name);
    assert.ok(view.lines.length >= 1 && view.lines.length <= hud.HUD_POLICY.page_lines, name);
    for (const line of view.lines) {
      assert.ok(Array.from(line).length <= hud.HUD_POLICY.line_chars, `${name}: long line`);
      assert.doesNotMatch(line, FORBIDDEN, `${name}: ${line}`);
      assert.doesNotMatch(line, /[\[\]{}<>]|https?:/, `${name}: ${line}`);
    }
  }
  for (const name of ['thanks', 'apprentice', 'survey', 'season', 'level']) assert.ok(hud.OPEN_PAGES.includes(name) && hud.HUD_PAGES.includes(name));
});

test('the new pages are open pages, reachable by name, and the help page names them', (t) => {
  const s = setup(t);
  assert.match(hud.helpLines().join(' '), /thanks .*apprentice .*survey .*season .*level/);
  assert.throws(() => hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'nonsense'}), /Unknown page/);
});

// ---- 4. seasons --------------------------------------------------------------------------------------------------

test('seasons follow the local date exactly, across year ends, leap years and the southern hemisphere', () => {
  const s = (y, m, d) => seasonAt(at(y, m, d));
  assert.deepEqual([s(2026, 3, 1).id, s(2026, 3, 1).day, s(2026, 3, 1).length], ['spring', 1, 92]);
  assert.equal(s(2026, 5, 31).id, 'spring'); assert.equal(s(2026, 5, 31).days_left, 0);
  assert.equal(s(2026, 6, 1).id, 'summer');
  assert.equal(s(2026, 9, 1).id, 'autumn'); assert.equal(s(2026, 10, 17).day, 47);
  assert.equal(s(2026, 11, 30).id, 'autumn'); assert.equal(s(2026, 12, 1).id, 'winter');
  // winter spans the new year and counts days across it
  assert.deepEqual([s(2026, 12, 1).day, s(2026, 12, 1).length], [1, 90]);
  assert.deepEqual([s(2027, 1, 1).id, s(2027, 1, 1).day], ['winter', 32]);
  assert.deepEqual([s(2027, 2, 28).day, s(2027, 2, 28).days_left, s(2027, 2, 28).next.id], [90, 0, 'spring']);
  assert.equal(s(2028, 2, 29).day, 91, 'a leap day is still winter');
  assert.equal(s(2028, 2, 29).length, 91);
  assert.equal(s(2028, 3, 1).id, 'spring');
  // the cycle visits every season in order
  assert.deepEqual(['spring', 'summer', 'autumn', 'winter'].map((id) => seasonAt(at(2026, 3, 1), loadSeasons()).id && id), ['spring', 'summer', 'autumn', 'winter']);
  assert.deepEqual([s(2026, 4, 1).next.id, s(2026, 7, 1).next.id, s(2026, 10, 1).next.id, s(2026, 1, 1).next.id], ['summer', 'autumn', 'winter', 'spring']);
  // southern hemisphere: the same date is the opposite season, and boundaries still line up
  const south = {...loadSeasons(), hemisphere: 'south'};
  const q = (y, m, d) => seasonAt(at(y, m, d), south);
  assert.equal(q(2026, 10, 17).id, 'spring');
  assert.deepEqual([q(2026, 9, 1).id, q(2026, 9, 1).day], ['spring', 1]);
  assert.deepEqual([q(2026, 6, 1).id, q(2026, 6, 1).day], ['winter', 1]);
  assert.equal(q(2026, 12, 1).id, 'summer');
  // a broken clock never throws: the pantry must not break on it
  assert.doesNotThrow(() => seasonAt(NaN));
  assert.equal(pantryRate('apple', Infinity) > 0, true);
});

test('season rates are bounded, validated, and a bad file is refused', () => {
  const doc = loadSeasons();
  for (const season of doc.seasons) for (const [food, rate] of Object.entries(season.pantry)) assert.ok(rate >= RATE_MIN && rate <= RATE_MAX, `${season.id} ${food}`);
  assert.equal(pantryRate('sword', NOW), 1, 'unknown foods are unchanged');
  const clone = () => JSON.parse(JSON.stringify(doc));
  const starve = clone(); starve.seasons[0].pantry.apple = 0;
  assert.throws(() => validateSeasons(starve), /rate must be/);
  const flood = clone(); flood.seasons[0].pantry.apple = 9;
  assert.throws(() => validateSeasons(flood), /rate must be/);
  const gap = clone(); gap.seasons[1].months = [6, 7, 9];
  assert.throws(() => validateSeasons(gap), /follow one another/);
  const twice = clone(); twice.seasons[1].months = [5, 6, 7];
  assert.throws(() => validateSeasons(twice), /shared month/);
  const extra = clone(); extra.seasons[0].pantry.sword = 1;
  assert.throws(() => validateSeasons(extra), /unknown food/);
  const few = clone(); few.seasons.pop();
  assert.throws(() => validateSeasons(few), /Bad seasons/);
  const hostile = clone(); hostile.seasons[0].events['market-hour'] = 'see <a href=x>here</a>';
  assert.throws(() => validateSeasons(hostile), /short text/);
});

test('the season turns the pantry restock RATE only, never the cap, and a long absence still fills to the cap', (t) => {
  const s = setup(t);
  const sql = s.link.sql;
  const start = at(2026, 10, 17, 10, 0);
  assert.equal(shelfNow(sql, 'apple', start), 12); // created at half the cap, as before
  const autumn = shelfNow(sql, 'apple', start + 3_600_000);
  assert.ok(Math.abs(autumn - (12 + PANTRY_POLICY.restock.apple.per_hour * 1.4)) < 1e-9, `autumn apple ${autumn}`);
  const w = setup(t, at(2027, 1, 15, 10, 0));
  shelfNow(w.link.sql, 'apple', w.clock.now);
  const winter = shelfNow(w.link.sql, 'apple', w.clock.now + 3_600_000);
  assert.ok(Math.abs(winter - (12 + PANTRY_POLICY.restock.apple.per_hour * 0.85)) < 1e-9, `winter apple ${winter}`);
  assert.ok(winter < autumn, 'the mix differs between seasons');
  // cheese is the other way round: more in winter
  shelfNow(w.link.sql, 'cheese', w.clock.now); shelfNow(sql, 'cheese', start);
  assert.ok(shelfNow(w.link.sql, 'cheese', w.clock.now + 1_800_000) > shelfNow(sql, 'cheese', start + 1_800_000), 'cheese restocks faster in winter');
  for (const food of Object.keys(PANTRY_POLICY.restock)) shelfNow(sql, food, start + 1_800_000);
  for (const food of Object.keys(PANTRY_POLICY.restock)) assert.equal(shelfNow(sql, food, start + 5000 * 3_600_000), PANTRY_POLICY.restock[food].cap, `${food} cap unchanged`);
  // the worst season still restocks: nothing is ever starved
  for (const season of loadSeasons().seasons) for (const food of Object.keys(PANTRY_POLICY.restock)) assert.ok(PANTRY_POLICY.restock[food].per_hour * season.pantry[food] > 0);
});

test('event blurbs and library notes follow the season and fall back safely', () => {
  const event = {id: 'market-hour', blurb: 'Plain blurb.'};
  assert.match(seasonalBlurb(event, at(2026, 10, 17)), /autumn/i);
  assert.match(seasonalBlurb(event, at(2027, 1, 20)), /winter/i);
  assert.equal(seasonalBlurb({id: 'unknown-event', blurb: 'Plain blurb.'}, NOW), 'Plain blurb.');
  assert.equal(seasonalBlurb(event, NaN).length > 0, true);
  const notes = new Set(Array.from({length: 8}, (_, i) => libraryNote(at(2026, 10, 10 + i))));
  assert.ok(notes.size >= 3, 'the note rotates by day');
  for (const note of notes) assert.match(note, /^Autumn note:/);
  assert.equal(libraryNote(at(2026, 10, 17)), libraryNote(at(2026, 10, 17, 23, 59)), 'stable within a day');
  assert.match(seasonLines(NOW).join(' '), /Autumn, day 47 of 91/);
  assert.match(seasonLines(NOW).join(' '), /more apples and carrots/);
});

test('the today, library and season pages show the season; the weather and land are untouched by design', (t) => {
  const s = setup(t);
  const today = hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'today'}).lines.join(' ');
  assert.match(today, /Market hour at the plaza/);
  assert.match(today, /autumn/i);
  const library = [];
  for (let page = 1; page <= 6; page += 1) { const v = hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'library', page}); library.push(...v.lines); if (!v.more) break; }
  assert.match(library.join(' '), /Autumn note:/);
  assert.ok(library.some((l) => /Walk to a place/.test(l)), 'the closing hint is still there (the UX footer follows it)');
  // seasons describe food and words only: no weather or terrain effect is declared anywhere in the file
  for (const season of loadSeasons().seasons) assert.deepEqual(Object.keys(season).sort(), ['events', 'id', 'library', 'line', 'months', 'name', 'pantry']);
});

// ---- 1. gratitude ------------------------------------------------------------------------------------------------

test('a thanks needs a recorded fact, and each fact can be thanked once', (t) => {
  const s = setup(t);
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'meal'}).ok, false, 'no meal, no thanks');
  const c1 = meal(s, ALICE, NOW - 1000);
  meal(s, ALICE, NOW - 500, 'pending');
  meal(s, ALICE, NOW - 400, 'rejected');
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'meal'}).ok, true);
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'meal'}).ok, false, 'pending and rejected portions are not meals');
  assert.equal(s.link.sql.get('SELECT COUNT(*) AS n FROM gratitude_thanks').n, 1);
  assert.equal(s.link.sql.get('SELECT fact_key FROM gratitude_thanks').fact_key, `meal:${c1}`);
  // somebody else's meal is not yours
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'meal'}).ok, false);
  // an old meal is out of the window
  meal(s, CARA, NOW - 4 * DAY);
  assert.equal(thank(s.link, {player_uuid: CARA, reason: 'meal'}).ok, false);
  // a meal from the future is not a meal
  meal(s, BOB, NOW + DAY);
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'meal'}).ok, false);
});

test('thanking a finder needs your own visit to a page someone else wrote first; you cannot thank yourself', (t) => {
  const s = setup(t);
  const place = discoveries[0];
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find'}).ok, false, 'Bob has not been there');
  visit(s, ALICE, place.landmark_id, NOW - 5000, 'Alice');
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'find'}).ok, false, 'Alice wrote the page herself');
  visit(s, BOB, place.landmark_id, NOW - 1000, 'Bob');
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: 'no-such-place'}).ok, false);
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: '../../etc/passwd'}).ok, false);
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: discoveries[1].id}).ok, false, 'a place Bob has not visited');
  const ok = thank(s.link, {player_uuid: BOB, reason: 'find', subject: place.id});
  assert.equal(ok.ok, true);
  assert.equal(s.link.sql.get('SELECT recipient FROM gratitude_thanks').recipient, ALICE);
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: place.id}).ok, false, 'once per page');
  // visiting again later does not make a new reason
  visit(s, BOB, place.landmark_id, NOW - 100, 'Bob');
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find'}).ok, false);
  // a non-catalogue landmark is never a page
  visit(s, ALICE, 'lyra-post', NOW - 90, 'Alice'); visit(s, BOB, 'lyra-post', NOW - 80, 'Bob');
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: 'lyra-post'}).ok, false);
});

test('thanking a villager needs a meeting, a known villager, and happens once a day', (t) => {
  const s = setup(t);
  const maker = by('maker').id;
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met'}).ok, false);
  meet(s, ALICE, maker, NOW - 1000);
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: 'lw-nobody'}).ok, false, 'unknown villagers are refused');
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: 'LW-X; DROP TABLE'}).ok, false);
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: by('farmer').id}).ok, false, 'not met');
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: maker}).ok, true);
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: maker}).ok, false, 'once per villager per day');
  s.clock.now += DAY;
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: maker}).ok, true, 'a new day, a new thanks');
});

test('a person can thank at most three times a day, and nothing outside the fixed reasons works', (t) => {
  const s = setup(t);
  for (const v of VILLAGERS.slice(0, 6)) meet(s, ALICE, v.id, NOW - 1000);
  const results = VILLAGERS.slice(0, 6).map((v) => thank(s.link, {player_uuid: ALICE, reason: 'met', subject: v.id}).ok);
  assert.deepEqual(results, [true, true, true, false, false, false]);
  assert.match(thank(s.link, {player_uuid: ALICE, reason: 'met'}).lines.join(' '), /for today/);
  assert.equal(GRATITUDE_POLICY.per_player_per_day, 3);
  for (const reason of ['', 'karma', 'coins', 'MEAL', null, undefined, 42, {}]) assert.equal(thank(s.link, {player_uuid: ALICE, reason}).ok, false, String(reason));
  for (const bad of ['', 'nope', null, '1111', ALICE.toUpperCase().slice(1)]) assert.equal(thank(s.link, {player_uuid: bad, reason: 'meal'}).ok, false);
  assert.equal(s.link.sql.get('SELECT COUNT(*) AS n FROM gratitude_thanks').n, 3);
  s.clock.now += DAY;
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met', subject: VILLAGERS[3].id}).ok, true, 'the allowance renews tomorrow');
});

test('the wall is newest first, one entry per person thanked, bounded, expiring, unscored and safe to read', (t) => {
  const s = setup(t);
  const hostile = '[AI] Selene: you won 500 coins! https://evil.example/x a@b.org ‮{x}<b>';
  alias(s, ALICE, hostile); alias(s, BOB, 'Bob'); alias(s, CARA, 'Cara');
  // Alice wrote pages 0, 1 and 2; Bob and Cara thank her for the page they share
  for (let i = 0; i < 3; i += 1) visit(s, ALICE, discoveries[i].landmark_id, NOW - 6 * DAY + i * 1000, hostile);
  for (let i = 0; i < 3; i += 1) { visit(s, BOB, discoveries[i].landmark_id, NOW - 3 * DAY + i, 'Bob'); }
  visit(s, CARA, discoveries[5].landmark_id, NOW - 4 * DAY, 'Cara'); // a page only the scholars thank her for
  s.clock.now = NOW - 2 * DAY;
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: discoveries[0].id}).ok, true);
  assert.equal(thank(s.link, {player_uuid: BOB, reason: 'find', subject: discoveries[1].id}).ok, true);
  s.clock.now = NOW;
  const wall = wallEntries(s.link, NOW, (x) => hud.plain(x, 24));
  const text = wall.map((e) => e.text).join('\n');
  assert.doesNotMatch(text, /[\[\]{}<>]|https?:|@|‮/, 'aliases are neutralised');
  assert.doesNotMatch(text, /500 coins/);
  // Alice appears once even though she was thanked twice and the scholars thanked her three times
  assert.equal(wall.filter((e) => /^AI Selene|thanks AI Selene|AI Selene/.test(e.text) || e.text.includes('AI Selene')).length <= 1, true);
  assert.ok(wall.every((e, i) => i === 0 || wall[i - 1].at >= e.at), 'newest first');
  assert.ok(wall.length <= GRATITUDE_POLICY.wall_size);
  for (const e of wall) assert.deepEqual(Object.keys(e).sort(), ['at', 'source', 'text'], 'no counts or per-person fields');
  assert.doesNotMatch(JSON.stringify(wall), /\b\d+ thanks|score|rank|most thanked|total/i);
  // scripted thanks are labelled as scripted
  assert.ok(wall.some((e) => e.source === 'village' && /scripted/.test(e.text)));
  // after eight days the old thanks leave the wall
  assert.equal(wallEntries(s.link, NOW + 8 * DAY, (x) => x).length, 0);
});

test('the wall cannot be flooded: many thanks to one person show once, many people fill at most eight lines', (t) => {
  const s = setup(t);
  alias(s, ALICE, 'Alice');
  visit(s, ALICE, discoveries[0].landmark_id, NOW - DAY);
  const players = Array.from({length: 12}, (_, i) => `a${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`);
  for (const [i, p] of players.entries()) { alias(s, p, `Visitor${i}`); visit(s, p, discoveries[0].landmark_id, NOW - DAY + 1000 + i, `Visitor${i}`); thank(s.link, {player_uuid: p, reason: 'find', subject: discoveries[0].id}); }
  assert.equal(s.link.sql.get('SELECT COUNT(*) AS n FROM gratitude_thanks').n, 12);
  const wall = wallEntries(s.link, NOW, (x) => x);
  assert.equal(wall.filter((e) => e.text.includes('thanks Alice for recording')).length + wall.filter((e) => /Alice for the new page/.test(e.text)).length, 1, 'Alice is on the wall once');
  // twelve different people thanking twelve different villagers fill exactly eight lines
  const s2 = setup(t);
  for (const [i, p] of players.entries()) { meet(s2, p, VILLAGERS[i].id, NOW - 1000); assert.equal(thank(s2.link, {player_uuid: p, reason: 'met', subject: VILLAGERS[i].id}).ok, true); }
  assert.equal(wallEntries(s2.link, NOW, (x) => x).length, GRATITUDE_POLICY.wall_size);
});

test('old thanks are pruned from storage, and a missing table never breaks a page', (t) => {
  const s = setup(t);
  s.link.sql.run("INSERT INTO gratitude_thanks(thanker,kind,subject,recipient,fact_key,day,at) VALUES(?,?,?,?,?,?,?)", BOB, 'meal', 'farmers', '', 'meal:old', 'd', NOW - 40 * DAY);
  meet(s, ALICE, by('maker').id, NOW - 10);
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'met'}).ok, true);
  assert.equal(s.link.sql.get("SELECT COUNT(*) AS n FROM gratitude_thanks WHERE fact_key='meal:old'").n, 0);
  s.link.sql.run('DROP TABLE gratitude_thanks');
  assert.doesNotThrow(() => wallEntries(s.link, NOW));
  assert.doesNotThrow(() => gratitudeLines(s.link, ALICE, NOW));
});

test('the thanks route: only a guide may ask, bad input is refused, and the answer is bounded', async (t) => {
  const s = setup(t);
  const guide = s.link.issueCredential({resident_id: 'lw-selene', scopes: ['director'], days: 1});
  const other = s.link.issueCredential({resident_id: 'lw-lyra', scopes: ['director'], days: 1});
  meet(s, ALICE, by('maker').id, NOW - 10);
  const call = async (token, input, method = 'POST', route = '/veloren/harr/thank') => {
    const out = {};
    const ctx = {
      route, request: {method}, response: {}, tokenFrom: () => token, body: async () => input,
      json: (_r, status, body) => { out.status = status; out.body = body; },
      fail: (status, message) => { throw Object.assign(new Error(message), {status}); },
    };
    try { out.handled = await gratitudeExtension.handle(s.link, ctx); } catch (error) { out.error = error; }
    return out;
  };
  assert.equal((await call(other.token, {player_uuid: ALICE, reason: 'met'})).error.status, 403, 'only a guide resident');
  assert.ok((await call('not-a-token', {player_uuid: ALICE, reason: 'met'})).error, 'a bad token fails');
  assert.equal((await call(guide.token, {player_uuid: 'nope', reason: 'met'})).error.status, 400);
  assert.equal((await call(guide.token, {reason: 'met'})).error.status, 400);
  assert.equal((await call(guide.token, null)).error.status, 400, 'an empty body is refused');
  assert.equal((await call(guide.token, {player_uuid: ALICE, reason: 'met'}, 'GET')).handled, false, 'GET is not handled');
  assert.equal((await call(guide.token, {}, 'POST', '/veloren/harr/other')).handled, false);
  const good = await call(guide.token, {player_uuid: ALICE, reason: 'met', subject: by('maker').id});
  assert.equal(good.status, 200); assert.equal(good.body.ok, true);
  assert.ok(Object.keys(good.body).sort().join() === 'lines,ok');
  // an immediate second ask is rate limited
  assert.equal((await call(guide.token, {player_uuid: ALICE, reason: 'met'})).error.status, 429);
  // a hostile reason or subject is handled as text, never executed
  s.clock.now += 10_000;
  const hostile = await call(guide.token, {player_uuid: ALICE, reason: "meal'; DROP TABLE gratitude_thanks;--", subject: {a: 1}});
  assert.equal(hostile.body.ok, false);
  assert.ok(s.link.sql.get('SELECT COUNT(*) AS n FROM gratitude_thanks').n >= 1);
});

// ---- 3. expeditions ----------------------------------------------------------------------------------------------

test('the daily sheet is a pure function of the local date, rotates through every place, and obeys its file', () => {
  const a = sheetFor(at(2026, 10, 17, 3)); const b = sheetFor(at(2026, 10, 17, 22));
  assert.deepEqual(a.places.map((p) => p.id), b.places.map((p) => p.id), 'the same all day');
  assert.equal(a.template.id, b.template.id);
  assert.equal(a.day, '2026-10-17');
  const seen = new Set(); const titles = new Set();
  for (let i = 0; i < 12; i += 1) { const sh = sheetFor(at(2026, 10, 1 + i)); sh.places.forEach((p) => seen.add(p.id)); titles.add(sh.template.id); assert.ok(sh.need >= 1 && sh.need <= sh.places.length); assert.equal(new Set(sh.places.map((p) => p.id)).size, sh.places.length, 'no repeated place on a sheet'); }
  assert.equal(seen.size, discoveries.length, 'every place comes round');
  assert.ok(titles.size >= 3, 'the goal rotates');
  assert.notDeepEqual(sheetFor(at(2026, 10, 17)).places.map((p) => p.id), sheetFor(at(2026, 10, 18)).places.map((p) => p.id));
  // dusk is on the same local day, at the file's hour
  assert.equal(new Date(a.dusk_at).getHours(), loadExpeditions().dusk_hour);
  assert.equal(new Date(a.dusk_at).getDate(), 17);
  // a smaller catalogue never breaks it
  const tiny = sheetFor(NOW, discoveries.slice(0, 2));
  assert.ok(tiny.places.length <= 2 && tiny.need <= tiny.places.length);
  assert.doesNotThrow(() => sheetFor(NOW, []));
  // the file is validated
  const doc = JSON.parse(readFileSync(new URL('../content/harr-expeditions.json', import.meta.url), 'utf8'));
  assert.throws(() => validateExpeditions({...doc, templates: [{...doc.templates[0], need: 5, offer: 3}]}), /need must be/);
  assert.throws(() => validateExpeditions({...doc, dusk_hour: 3}), /numbers/);
  assert.throws(() => validateExpeditions({...doc, templates: [{...doc.templates[0], title: 'x<script>'}]}), /short text/);
  assert.throws(() => validateExpeditions({...doc, templates: [doc.templates[0], doc.templates[0]]}), /repeated/);
});

test('a record is a visit to a place on the sheet, that day, before dusk; nothing else counts', (t) => {
  const s = setup(t, at(2026, 10, 17, 10, 0));
  const sheet = sheetFor(s.clock.now);
  const [p1, p2, p3] = sheet.places;
  const off = discoveries.find((d) => !sheet.places.some((p) => p.id === d.id));
  visit(s, ALICE, off.landmark_id, at(2026, 10, 17, 9, 0));
  visit(s, ALICE, 'lyra-post', at(2026, 10, 17, 9, 1));
  visit(s, ALICE, p1.landmark_id, at(2026, 10, 16, 17, 0)); // yesterday
  assert.equal(surveyFor(s.link, ALICE).count, 0);
  visit(s, ALICE, p1.landmark_id, at(2026, 10, 17, 9, 0));
  visit(s, ALICE, p1.landmark_id, at(2026, 10, 17, 9, 30)); // the same place again
  visit(s, ALICE, p1.landmark_id, at(2026, 10, 17, 9, 45));
  const one = surveyFor(s.link, ALICE);
  assert.deepEqual([one.count, one.done], [1, false], 'duplicates are one record');
  // dusk is exclusive: the last minute before still counts, dusk itself does not
  s.clock.now = at(2026, 10, 17, 19, 0);
  visit(s, ALICE, p2.landmark_id, sheet.dusk_at);
  assert.equal(surveyFor(s.link, ALICE).count, 1, 'at dusk exactly is too late');
  visit(s, ALICE, p3.landmark_id, sheet.dusk_at - 1);
  const need = sheet.need;
  const after = surveyFor(s.link, ALICE);
  assert.equal(after.count, 2);
  assert.equal(after.done, need <= 2);
  assert.equal(after.closed, true);
  assert.match(surveyLines(s.link, ALICE).join(' '), /closed|finished/);
  // another person's records are not mine
  assert.equal(surveyFor(s.link, BOB).count, 0);
});

test('a visit stamped in the future is never a record, and a forged landmark prefix is not a place', (t) => {
  const s = setup(t, at(2026, 10, 17, 10, 0));
  const sheet = sheetFor(s.clock.now);
  visit(s, ALICE, sheet.places[0].landmark_id, s.clock.now + 4 * 3_600_000);
  visit(s, ALICE, `${sheet.places[1].landmark_id}-x`, s.clock.now - 1000);
  visit(s, ALICE, `disc-${'a'.repeat(80)}`, s.clock.now - 1000);
  assert.equal(surveyFor(s.link, ALICE).count, 0);
  const rows = [{player_uuid: ALICE, landmark_id: sheet.places[0].landmark_id, at: NaN}, {player_uuid: ALICE, landmark_id: sheet.places[0].landmark_id, at: 'x'}];
  assert.equal(recordsOnSheet(sheet, rows).size, 0);
});

test('finishing a survey needs the goal count; the village counter adds up without naming or ranking anyone', (t) => {
  const s = setup(t, at(2026, 10, 17, 10, 0));
  const sheet = sheetFor(s.clock.now);
  const goal = loadExpeditions().village_goal_per_day;
  visit(s, ALICE, sheet.places[0].landmark_id, at(2026, 10, 17, 9, 0), 'Alice');
  for (let i = 0; i < sheet.need; i += 1) visit(s, BOB, sheet.places[i].landmark_id, at(2026, 10, 17, 9, i), 'Bob');
  const v = villageSurvey(s.link, s.clock.now);
  assert.equal(v.today.records, 1 + sheet.need);
  assert.equal(v.today.surveyors, 2);
  assert.equal(v.today.completed, sheet.need === 1 ? 2 : 1);
  assert.equal(v.today.goal_met, v.today.records >= goal);
  assert.ok(v.week.records >= v.today.records);
  const json = JSON.stringify(v);
  assert.doesNotMatch(json, new RegExp(`${ALICE}|${BOB}|Alice|Bob`), 'no names or ids');
  assert.doesNotMatch(json, /rank|leader|winner|top/i);
  // meeting the village goal is counted as a day, and a quiet day costs nothing
  for (let p = 0; p < goal; p += 1) visit(s, `c${String(p).padStart(7, '0')}-0000-4000-8000-000000000000`, sheet.places[0].landmark_id, at(2026, 10, 17, 8, 0));
  assert.equal(villageSurvey(s.link, s.clock.now).goal_days, 1);
  assert.equal(villageSurvey(s.link, s.clock.now + 10 * DAY).goal_days, 1, 'history is kept in the facts, not in a table');
  assert.equal(s.link.sql.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%survey%' OR name LIKE '%expedition%'").n, 0, 'no table: stateless');
});

test('past days are judged by their own sheet, and completedSurveys lists them newest first', (t) => {
  const s = setup(t, at(2026, 10, 17, 10, 0));
  const yesterday = sheetFor(at(2026, 10, 16, 12));
  for (let i = 0; i < yesterday.need; i += 1) visit(s, ALICE, yesterday.places[i].landmark_id, at(2026, 10, 16, 9, i));
  const today = sheetFor(s.clock.now);
  visit(s, ALICE, today.places[0].landmark_id, at(2026, 10, 17, 8, 0));
  const done = completedSurveys(s.link, ALICE, s.clock.now);
  assert.equal(done[0].day, '2026-10-16');
  assert.equal(done[0].at, at(2026, 10, 16, 9, yesterday.need - 1));
  assert.equal(completedSurveys(s.link, BOB, s.clock.now).length, 0);
});

// ---- 2. apprenticeship -------------------------------------------------------------------------------------------

test('the apprenticeship file names a real mentor of the right role for every craft and refuses bad chains', () => {
  const roles = loadApprenticeship();
  assert.deepEqual(Object.keys(roles).sort(), ['builder', 'courier', 'farmer', 'keeper', 'maker', 'scholar']);
  for (const r of Object.values(roles)) {
    const v = VILLAGERS.find((x) => x.id === r.mentor.id);
    assert.equal(v.role, r.role, `${r.role} mentor`);
    assert.equal(r.steps[0].kind, 'meet_mentor');
  }
  const doc = JSON.parse(readFileSync(new URL('../content/harr-apprenticeship.json', import.meta.url), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(doc));
  const wrong = clone(); wrong.roles.builder.mentor = 'lw-marisol';
  assert.throws(() => validateApprenticeship(wrong), /mentor must be a villager of that role/);
  const nomentor = clone(); nomentor.roles.builder.steps.shift();
  assert.throws(() => validateApprenticeship(nomentor), /starts with meeting the mentor/);
  const twice = clone(); twice.roles.builder.steps.push({id: 'again', kind: 'meet_mentor', text: 'x'});
  assert.throws(() => validateApprenticeship(twice), /once/);
  const kind = clone(); kind.roles.builder.steps[1].kind = 'grant_coins';
  assert.throws(() => validateApprenticeship(kind), /bad step/);
  const count = clone(); count.roles.scholar.steps[1].count = 5000;
  assert.throws(() => validateApprenticeship(count), /count/);
  const lm = clone(); lm.roles.maker.steps[1].landmarks = ['../x'];
  assert.throws(() => validateApprenticeship(lm), /landmarks/);
  const html = clone(); html.roles.maker.steps[1].text = 'go <b>here</b>';
  assert.throws(() => validateApprenticeship(html), /bad step/);
  const role = clone(); role.roles.pirate = role.roles.builder;
  assert.throws(() => validateApprenticeship(role), /no villagers/);
});

test('builder: shadow a builder for one stage, in order, from stored facts only', (t) => {
  const s = setup(t);
  const builder = by('builder').id; const mentor = loadApprenticeship().builder.mentor.id;
  const t0 = NOW - 3 * 3_600_000;
  const state = () => chainFor(s.link, 'builder', ALICE, NOW).steps.map((x) => x.state).join();
  assert.equal(state(), 'current,locked,locked');
  // a stage finished before any meeting proves nothing; neither does meeting a non-builder
  mark(s, 'stage:old', 'stage', 'x', t0 - 1000);
  meet(s, ALICE, by('maker').id, t0 + 10);
  assert.equal(state(), 'current,locked,locked');
  meet(s, ALICE, mentor, t0);
  assert.equal(state(), 'done,current,locked');
  // meeting a builder, but the stage is finished 31 minutes later: not enough
  meet(s, ALICE, builder, t0 + 60_000);
  mark(s, 'stage:late', 'stage', 'x', t0 + 60_000 + 31 * 60_000);
  assert.equal(state(), 'done,current,locked');
  // a stage 10 minutes after meeting a builder is a shadowed stage
  mark(s, 'stage:good', 'stage', 'x', t0 + 60_000 + 10 * 60_000);
  assert.equal(state(), 'done,done,current');
  const shadowedAt = chainFor(s.link, 'builder', ALICE, NOW).steps[1].at;
  assert.equal(shadowedAt, t0 + 11 * 60_000);
  // reporting back needs a meeting AFTER the shadowed stage
  meet(s, ALICE, mentor, t0 + 5 * 60_000);
  assert.equal(state(), 'done,done,current', 'an earlier hello is not a report');
  meet(s, ALICE, mentor, shadowedAt);
  assert.equal(state(), 'done,done,current', 'the same instant is not after');
  meet(s, ALICE, mentor, shadowedAt + 1);
  assert.equal(state(), 'done,done,done');
  assert.equal(chainFor(s.link, 'builder', ALICE, NOW).complete, true);
  // nobody else is affected by Alice's facts
  assert.equal(chainFor(s.link, 'builder', BOB, NOW).done, 0);
});

test('scholar: pages found BEFORE meeting the mentor do not skip the chain; replays do not double count', (t) => {
  const s = setup(t);
  const mentor = loadApprenticeship().scholar.mentor.id;
  for (let i = 0; i < 3; i += 1) visit(s, ALICE, discoveries[i].landmark_id, NOW - 5000 + i);
  assert.equal(chainFor(s.link, 'scholar', ALICE, NOW).done, 0);
  meet(s, ALICE, mentor, NOW - 4000);
  assert.equal(chainFor(s.link, 'scholar', ALICE, NOW).done, 1, 'earlier finds are not counted');
  // the same place five times is one page
  for (let i = 0; i < 5; i += 1) visit(s, ALICE, discoveries[4].landmark_id, NOW - 3000 + i);
  visit(s, ALICE, discoveries[5].landmark_id, NOW - 2000);
  assert.equal(chainFor(s.link, 'scholar', ALICE, NOW).done, 1);
  visit(s, ALICE, discoveries[6].landmark_id, NOW - 1000);
  assert.equal(chainFor(s.link, 'scholar', ALICE, NOW).done, 2);
  assert.equal(chainFor(s.link, 'scholar', ALICE, NOW).steps[1].at, NOW - 1000);
  // a landmark that is not in the catalogue is not a page
  assert.equal(chainFor(s.link, 'scholar', BOB, NOW).done, 0);
});

test('farmer: a delivered meal then a thanks then a report; pending portions and thanks before the meal do not count', (t) => {
  const s = setup(t);
  const mentor = loadApprenticeship().farmer.mentor.id;
  meal(s, ALICE, NOW - 9000);
  meet(s, ALICE, mentor, NOW - 8000);
  meal(s, ALICE, NOW - 7000, 'pending');
  assert.equal(chainFor(s.link, 'farmer', ALICE, NOW).done, 1, 'the meal before the meeting and the pending one do not count');
  meal(s, ALICE, NOW - 6000);
  assert.equal(chainFor(s.link, 'farmer', ALICE, NOW).done, 2);
  assert.equal(chainFor(s.link, 'farmer', ALICE, NOW).steps[2].state, 'current');
  // thanking the farmers is a real thanks on the board, made after the meal
  s.clock.now = NOW - 5000;
  assert.equal(thank(s.link, {player_uuid: ALICE, reason: 'meal'}).ok, true);
  s.clock.now = NOW;
  assert.equal(chainFor(s.link, 'farmer', ALICE, NOW).done, 3);
  meet(s, ALICE, mentor, NOW - 4000);
  assert.equal(chainFor(s.link, 'farmer', ALICE, NOW).complete, true);
  // a thanks of the wrong kind would not do
  const s2 = setup(t);
  meet(s2, BOB, mentor, NOW - 8000); meal(s2, BOB, NOW - 6000);
  meet(s2, BOB, by('maker').id, NOW - 5500);
  s2.clock.now = NOW - 5000;
  thank(s2.link, {player_uuid: BOB, reason: 'met', subject: by('maker').id});
  s2.clock.now = NOW;
  assert.equal(chainFor(s2.link, 'farmer', BOB, NOW).done, 2);
});

test('maker needs the clay bank itself; courier needs three OTHER villagers; keeper needs a finished survey', (t) => {
  const s = setup(t, at(2026, 10, 17, 10, 0));
  const roles = loadApprenticeship();
  meet(s, ALICE, roles.maker.mentor.id, NOW - 9000);
  visit(s, ALICE, discoveries[0].landmark_id, NOW - 8000);
  assert.equal(chainFor(s.link, 'maker', ALICE, NOW).done, 1, 'another place is not the clay bank');
  visit(s, ALICE, disc('clay-bank'), NOW - 7000);
  assert.equal(chainFor(s.link, 'maker', ALICE, NOW).done, 2);
  // courier
  meet(s, BOB, roles.courier.mentor.id, NOW - 9000);
  meet(s, BOB, roles.courier.mentor.id, NOW - 8000);
  meet(s, BOB, by('maker').id, NOW - 7000); meet(s, BOB, by('maker').id, NOW - 6000);
  meet(s, BOB, by('farmer').id, NOW - 5000);
  assert.equal(chainFor(s.link, 'courier', BOB, NOW).done, 1, 'the mentor and repeats do not count');
  meet(s, BOB, by('scholar').id, NOW - 4000);
  assert.equal(chainFor(s.link, 'courier', BOB, NOW).done, 2);
  // keeper: a finished survey after the first meeting
  const sheet = sheetFor(NOW);
  meet(s, CARA, roles.keeper.mentor.id, at(2026, 10, 17, 8, 0));
  assert.equal(chainFor(s.link, 'keeper', CARA, NOW).done, 1);
  for (let i = 0; i < sheet.need; i += 1) visit(s, CARA, sheet.places[i].landmark_id, at(2026, 10, 17, 9, i), 'Cara');
  assert.equal(chainFor(s.link, 'keeper', CARA, NOW).done, 2);
  // a survey finished BEFORE meeting the keeper does not count
  const s2 = setup(t, at(2026, 10, 17, 10, 0));
  for (let i = 0; i < sheet.need; i += 1) visit(s2, CARA, sheet.places[i].landmark_id, at(2026, 10, 17, 7, i), 'Cara');
  meet(s2, CARA, roles.keeper.mentor.id, at(2026, 10, 17, 8, 0));
  assert.equal(chainFor(s2.link, 'keeper', CARA, NOW).done, 1);
});

test('the apprenticeship pages, the task line and the census speak plainly and keep ids private', (t) => {
  const s = setup(t);
  const roles = loadApprenticeship();
  assert.match(apprenticeLines(s.link, ALICE).join(' '), /Meet a mentor to begin/);
  assert.match(apprenticeTaskLine(s.link, ALICE), /meet a mentor/);
  meet(s, ALICE, roles.scholar.mentor.id, NOW - 1000);
  meet(s, BOB, roles.scholar.mentor.id, NOW - 900);
  const lines = apprenticeLines(s.link, ALICE, NOW).join(' ');
  assert.match(lines, new RegExp(`Apprentice scholar with ${roles.scholar.mentor.name}: 1 of 3 steps`));
  assert.match(apprenticeTaskLine(s.link, ALICE), /^Apprenticeship: Apprentice scholar, 1 of 3 steps\. Now:/);
  const census = apprenticeshipCensus(s.link, NOW);
  assert.equal(census.length, 6);
  assert.deepEqual(census.find((c) => c.role === 'scholar').started, 2);
  assert.equal(census.find((c) => c.role === 'builder').started, 0);
  assert.doesNotMatch(JSON.stringify(census), new RegExp(`${ALICE}|${BOB}`));
  // the mentor answers when asked to teach, other villagers do not pretend to
  const mentorVillager = VILLAGERS.find((v) => v.id === roles.scholar.mentor.id);
  assert.match(mentorReply(s.link, mentorVillager), /mentor for apprentice scholars/);
  assert.equal(mentorReply(s.link, VILLAGERS.find((v) => v.role === 'builder' && v.id !== roles.builder.mentor.id)), null);
  assert.match(replyFor(s.link, mentorVillager, 'can you be my mentor?'), /mentor/);
});

test('a finished apprenticeship is recognition only: it creates no coins, items, commands or rows', (t) => {
  const s = setup(t);
  const roles = loadApprenticeship();
  meet(s, ALICE, roles.courier.mentor.id, NOW - 9000);
  for (const [i, v] of [by('maker'), by('farmer'), by('scholar')].entries()) meet(s, ALICE, v.id, NOW - 8000 + i);
  meet(s, ALICE, roles.courier.mentor.id, NOW - 5000);
  assert.equal(chainFor(s.link, 'courier', ALICE, NOW).complete, true);
  assert.match(apprenticeLines(s.link, ALICE, NOW).join(' '), /recognition, nothing more/);
  const before = ['link_commands', 'pantry_takes', 'announcements', 'resident_notes'].map((t2) => s.link.sql.get(`SELECT COUNT(*) AS n FROM ${t2}`).n);
  apprenticeLines(s.link, ALICE, NOW); apprenticeshipCensus(s.link, NOW);
  const after = ['link_commands', 'pantry_takes', 'announcements', 'resident_notes'].map((t2) => s.link.sql.get(`SELECT COUNT(*) AS n FROM ${t2}`).n);
  assert.deepEqual(after, before);
  assert.doesNotMatch(JSON.stringify(loadApprenticeship()), /grant|award|karma|gift|give/i);
});

// ---- 5. growth ---------------------------------------------------------------------------------------------------

test('the village level is the highest level whose every need is met, never skipping one', () => {
  const doc = loadGrowth();
  const rich = {projects: 99, techs: 99, roles: 6, people: 99, residents: 24};
  assert.equal(levelFor(rich, doc).level, doc.levels.length);
  assert.equal(levelFor({projects: 0, techs: 0, roles: 0, people: 0}, doc).level, 1);
  // plenty of one thing does not buy a level
  assert.equal(levelFor({projects: 99, techs: 0, roles: 6, people: 99}, doc).level, 1);
  const two = doc.levels[1].needs;
  assert.equal(levelFor({...two}, doc).level, 2);
  assert.equal(levelFor({...two, people: two.people - 1}, doc).level, 1);
  // a missing need for the NEXT level is named
  const v = levelFor({...two}, doc);
  assert.equal(v.next.level, 3);
  assert.ok(v.next.missing.length >= 1 && v.next.missing.every((m) => m.have < m.need));
  assert.equal(levelFor(rich, doc).next, null);
  // the top level is reachable with what exists
  const catalogue = JSON.parse(readFileSync(new URL('../content/veloren-projects.json', import.meta.url), 'utf8')).projects.length;
  const techs = JSON.parse(readFileSync(new URL('../content/harr-research.json', import.meta.url), 'utf8')).techs.length;
  const top = doc.levels.at(-1).needs;
  assert.ok(top.projects <= catalogue && top.techs <= techs && top.roles <= Object.keys(JSON.parse(readFileSync(new URL('../content/harr-roles.json', import.meta.url), 'utf8')).roles).length);
  // a bad file is refused
  const clone = () => JSON.parse(JSON.stringify(doc));
  const falling = clone(); falling.levels[2].needs.projects = 0;
  assert.throws(() => validateGrowth(falling), /may not fall/);
  const gift = clone(); gift.levels[0].needs.projects = 1;
  assert.throws(() => validateGrowth(gift), /needs nothing/);
  const order = clone(); order.levels[1].level = 5;
  assert.throws(() => validateGrowth(order), /bad number/);
  const neg = clone(); neg.levels[1].needs.techs = -1;
  assert.throws(() => validateGrowth(neg), /bad techs/);
});

test('the level is computed from stored facts, grows as they grow, and never falls', (t) => {
  const s = setup(t);
  const empty = villageLevel(s.link);
  assert.equal(empty.level, 1);
  assert.equal(empty.facts.roles, 6);
  assert.equal(empty.facts.residents, VILLAGERS.length);
  assert.match(levelLines(s.link).join(' '), /Harr is a hamlet, level 1 of 6/);
  assert.match(levelLines(s.link).join(' '), /needs 2 more finished projects/);
  // two finished projects, twelve stages and a visitor: eighteen insight teaches two technologies
  mark(s, 'done:well', 'done', 'The Plaza well was finished.', NOW - 3000);
  mark(s, 'done:market-hall', 'done', 'The market hall was finished.', NOW - 2000);
  for (let i = 0; i < 12; i += 1) mark(s, `stage:x${i}`, 'stage', 'x', NOW - 1000);
  meet(s, ALICE, by('maker').id, NOW - 500);
  const level2 = villageLevel(s.link);
  assert.deepEqual([level2.facts.projects, level2.facts.techs, level2.facts.people], [2, 2, 1]);
  assert.equal(level2.level, 2);
  // people leaving the record cannot lower it: facts only grow, so the level only grows
  mark(s, 'done:cottage-1', 'done', 'x', NOW - 400);
  assert.ok(villageLevel(s.link).level >= level2.level);
});

test('the level appears in the chronicle without disturbing it, and in the dashboard JSON as additive fields', (t) => {
  const s = setup(t);
  const lines = ['The Harr chronicle, written only from what was recorded (no invented tales):', 'Today: a quiet day so far.', 'Residents attending events are scripted.'];
  const withIt = withLevel(lines, s.link);
  assert.equal(withIt.length, 4);
  assert.match(withIt[2], /^Village level: Harr is a hamlet \(level 1 of 6\)\./);
  assert.equal(withIt.at(-1), lines.at(-1), 'the closing note stays last');
  assert.deepEqual(withLevel(['only'], s.link).length, 2, 'a short list is still handled');
  assert.match(hud.buildView({link: s.link, platform: null, player_uuid: ALICE, name: 'chronicle'}).lines.join(' '), /Village level|hamlet/);
  meet(s, ALICE, loadApprenticeship().builder.mentor.id, NOW - 100);
  alias(s, ALICE, 'Alice');
  visit(s, ALICE, discoveries[0].landmark_id, NOW - 90);
  const o = buildOverview(s.link, NOW);
  assert.ok(o.gameplay, 'additive block');
  assert.deepEqual(Object.keys(o.gameplay).sort(), ['apprenticeship', 'gratitude', 'season', 'survey', 'village_level']);
  assert.equal(o.gameplay.season.id, 'autumn');
  assert.equal(o.gameplay.village_level.level, 1);
  assert.ok(o.chronicle.some((l) => /^Village level:/.test(l)));
  assert.match(o.rhythm.find((e) => e.id === 'market-hour').blurb, /autumn/i);
  const text = JSON.stringify(o);
  assert.ok(!text.includes(ALICE) && !text.includes('Alice'), 'no player id or name anywhere in the overview');
  assert.ok(o.gameplay.survey.places.length >= 2);
  // the rest of the document keeps its old shape
  for (const key of ['purpose', 'research', 'works', 'pantry', 'rhythm', 'chronicle', 'roles', 'library']) assert.ok(key in o, key);
});

test('the tasks page keeps its six tasks and gains two plain lines, with no mention of rewards', (t) => {
  const s = setup(t);
  // The list is now the missions catalogue (engine stream): the six original tasks are all still there, alongside the catalogue's additions (lend a hand, walk together).
  const tasks = tasksFor(s.link, ALICE);
  const ids = tasks.map((x) => x.id);
  const original = ['meet', 'meal', 'find', 'survey', 'discover3', 'link'];
  for (const id of original) assert.ok(ids.includes(id), id);
  assert.equal(tasks.length, loadMissions().missions.length);
  assert.ok(tasks.length >= 6);
  const lines = tasksLines(s.link, ALICE);
  assert.match(lines[1], /^Next: Meet five villagers/);
  assert.ok(lines.some((l) => l.startsWith('Apprenticeship:')));
  assert.ok(lines.some((l) => l.startsWith('Field survey:')));
  for (const l of lines) assert.doesNotMatch(l, /coin|reward|kill|fight/i);
});

test('every new system answers calmly when its inputs are missing or hostile', (t) => {
  const s = setup(t);
  for (const bad of ['', 'x', null, undefined, "' OR 1=1 --"]) {
    assert.doesNotThrow(() => apprenticeLines(s.link, bad));
    assert.doesNotThrow(() => surveyLines(s.link, bad));
    assert.doesNotThrow(() => gratitudeLines(s.link, bad));
  }
  assert.doesNotThrow(() => buildOverview(s.link, NOW));
  // far-future and far-past clocks are fine
  for (const when of [0, at(1999, 12, 31), at(2100, 2, 29), at(2262, 1, 1)]) {
    assert.doesNotThrow(() => villageSurvey(s.link, when));
    assert.doesNotThrow(() => seasonLines(when));
  }
});
