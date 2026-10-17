import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MILESTONE_KEYS, SEASON_IDS, captionFor, finishedPhrase, loadStories, milestonePhrase, notesFor, seasonEventBlurb, seasonOf, validateStories} from '../src/veloren-ext/stories.js';
import {loadDiscoveries} from '../src/veloren-ext/world-life.js';

const load = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const raw = () => load('../content/harr-seasons.json');
const doc = loadStories();
const projects = load('../content/veloren-projects.json').projects;
const at = (y, mo, d) => new Date(y, mo - 1, d, 12).getTime();

test('seasons: 4 seasons x 3 event blurbs x 12 field notes, covering all 10 places each season', () => {
  assert.deepEqual(Object.keys(doc.seasons), [...SEASON_IDS]);
  const known = load('../content/veloren-events.json').events.map((e) => e.id);
  let notes = 0;
  for (const id of SEASON_IDS) {
    const s = doc.seasons[id];
    assert.deepEqual(s.events.map((e) => e.event).sort(), [...known].sort());
    assert.equal(s.notes.length, 12);
    notes += s.notes.length;
    assert.equal(new Set(s.notes.map((n) => n.discovery)).size, 10, `${id} must cover every place`);
  }
  assert.equal(notes, 48);
  assert.equal(new Set(SEASON_IDS.flatMap((id) => doc.seasons[id].months)).size, 12, 'every month belongs to a season');
});

test('the extra notes sit beside the base notes and never repeat them', () => {
  const base = loadDiscoveries().flatMap((d) => d.notes);
  const extra = SEASON_IDS.flatMap((id) => doc.seasons[id].notes.map((n) => n.text));
  assert.equal(new Set(extra).size, extra.length);
  for (const t of extra) assert.ok(!base.includes(t));
  const d = loadDiscoveries()[0];
  const merged = notesFor(d, at(2026, 4, 10));
  assert.deepEqual(merged.slice(0, d.notes.length), d.notes, 'base notes come first and unchanged');
  assert.ok(merged.length > d.notes.length);
  assert.equal(notesFor(d, at(2026, 4, 10), null).length, d.notes.length, 'a missing file changes nothing');
});

test('season follows the host calendar', () => {
  assert.equal(seasonOf(at(2026, 3, 1)), 'spring');
  assert.equal(seasonOf(at(2026, 5, 31)), 'spring');
  assert.equal(seasonOf(at(2026, 7, 4)), 'summer');
  assert.equal(seasonOf(at(2026, 10, 17)), 'autumn');
  assert.equal(seasonOf(at(2026, 12, 21)), 'winter');
  assert.equal(seasonOf(at(2027, 1, 15)), 'winter');
  assert.equal(seasonOf(at(2027, 2, 28)), 'winter');
  assert.match(seasonEventBlurb('festival', at(2026, 12, 21)), /winter festival/);
  assert.equal(seasonEventBlurb('no-such-event', at(2026, 12, 21)), null);
});

test('chronicle: 20 milestone phrases and a finishing line for every one of the 36 projects', () => {
  assert.equal(projects.length, 36);
  assert.equal(MILESTONE_KEYS.length, 20);
  assert.equal(Object.keys(doc.chronicle.milestones).length, 20);
  for (const p of projects) {
    assert.ok(finishedPhrase(p.id), `chronicle phrase for ${p.id}`);
    assert.ok(captionFor(p.id), `caption for ${p.id}`);
    assert.ok(captionFor(p.id).length <= 140 && finishedPhrase(p.id).length <= 150);
  }
  assert.equal(milestonePhrase('finished', 'The market hall'), 'The market hall was finished, and the whole village came to see.');
  assert.equal(milestonePhrase('first-find', 'x'), doc.chronicle.milestones['first-find']);
  assert.equal(new Set(projects.map((p) => captionFor(p.id))).size, 36, 'captions are all different');
  assert.equal(new Set(projects.map((p) => finishedPhrase(p.id))).size, 36);
  for (const c of Object.values(doc.captions.projects)) assert.equal((c.match(/[.!?](\s|$)/g) || []).length, 1, `one sentence: ${c}`);
});

test('the validator refuses bad files', () => {
  const bad = (mutate) => { const d = raw(); mutate(d); return d; };
  assert.throws(() => validateStories(bad((d) => { d.seasons.winter.notes.pop(); })), /12 field notes/);
  assert.throws(() => validateStories(bad((d) => { d.seasons.winter.notes[0].discovery = 'nowhere'; })), /unknown discovery/);
  assert.throws(() => validateStories(bad((d) => { d.seasons.spring.notes.forEach((n) => { if (n.discovery === 'clay-bank') n.discovery = 'wind-ridge'; }); })), /every discovery place/);
  assert.throws(() => validateStories(bad((d) => { delete d.captions.projects.well; })), /exactly the 36/);
  assert.throws(() => validateStories(bad((d) => { d.chronicle.milestones.extra = 'An extra phrase that should not be here at all.'; })), /20 milestone/);
  assert.throws(() => validateStories(bad((d) => { d.seasons.summer.events[0].event = 'market-hour'; d.seasons.summer.events[1].event = 'market-hour'; })), /distinct known events/);
  assert.throws(() => validateStories(bad((d) => { d.seasons.autumn.months = [9, 10, 12]; })), /unused calendar months/);
  assert.throws(() => validateStories(bad((d) => { d.seasons.autumn.notes[1].text = d.seasons.autumn.notes[0].text; })), /repeated note/);
});

test('peaceful vocabulary: nothing violent, competitive, scarce, monetary or linked in the new writing', () => {
  const text = readFileSync(new URL('../content/harr-seasons.json', import.meta.url), 'utf8').toLowerCase();
  const banned = /\b(?:kill|fight|attack|slay|weapon|enemy|battle|blood|dungeon|loot|raid|war|steal|theft|hunt\w*|danger\w*|scarc\w*|debt|conquer\w*|conquest|compet\w*|rival\w*|prey|predator\w*|coins?|money|gold|price|cost|pay|buy|purchase)(?:s|ed|ing|er|ers)?\b/;
  assert.equal(text.match(banned), null, text.match(banned)?.[0]);
  assert.equal(text.match(/https?:\/\/|www\.|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/), null);
  assert.ok(!/\{[a-z]+\}/.test(JSON.stringify(doc.captions)) && !/\{[a-z]+\}/.test(JSON.stringify(doc.seasons)), 'no placeholders in captions or seasons');
});
