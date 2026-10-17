// Seasonal and festival writing, chronicle milestone phrases and building captions (content/harr-season-stories.json).
//
// Data only and ADDITIVE: nothing here replaces the base library notes (veloren-discoveries.json), the event blurbs
// (veloren-events.json) or the project catalogue (veloren-projects.json). Callers ask for the extra text and fall
// back to the base text when this file is missing or invalid. Pure functions; no clock of their own.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, '..', '..', 'content');
export const SEASONS_PATH = join(CONTENT, 'harr-season-stories.json');
export const SEASON_IDS = Object.freeze(['spring', 'summer', 'autumn', 'winter']);
export const MILESTONE_KEYS = Object.freeze(['ground-broken', 'first-stage', 'second-stage', 'halfway', 'last-stage-near', 'finished', 'first-visit', 'opening-day', 'crew-of-two', 'crew-of-many', 'first-find', 'fifth-find', 'tenth-find', 'first-meal', 'hundredth-meal', 'market-held', 'circle-held', 'festival-held', 'tech-learned', 'season-turned']);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const idsOf = (rel, key) => readJson(join(CONTENT, rel))[key].map((x) => x.id);

export function validateStories(doc, { events = idsOf('veloren-events.json', 'events'), discoveries = idsOf('veloren-discoveries.json', 'discoveries'), projects = idsOf('veloren-projects.json', 'projects') } = {}) {
  if (!doc || doc.format !== 'harr-season-stories-v1' || !doc.seasons || !doc.chronicle || !doc.captions) throw new Error('Bad seasons file.');
  if (JSON.stringify(Object.keys(doc.seasons)) !== JSON.stringify(SEASON_IDS)) throw new Error('Seasons must be spring, summer, autumn, winter in order.');
  const months = new Set();
  const everyNote = new Set();
  for (const id of SEASON_IDS) {
    const s = doc.seasons[id];
    if (typeof s.name !== 'string' || !s.name) throw new Error(`${id}: name`);
    if (!Array.isArray(s.months) || s.months.length !== 3 || s.months.some((m) => !Number.isInteger(m) || m < 1 || m > 12 || months.has(m))) throw new Error(`${id}: months must be three unused calendar months`);
    s.months.forEach((m) => months.add(m));
    if (!Array.isArray(s.events) || s.events.length !== 3) throw new Error(`${id}: needs 3 event blurbs`);
    if (new Set(s.events.map((e) => e.event)).size !== 3 || s.events.some((e) => !events.includes(e.event))) throw new Error(`${id}: events must be three distinct known events`);
    for (const e of s.events) if (typeof e.blurb !== 'string' || e.blurb.length < 40 || e.blurb.length > 200) throw new Error(`${id}/${e.event}: blurb must be 40-200 characters`);
    if (!Array.isArray(s.notes) || s.notes.length !== 12) throw new Error(`${id}: needs 12 field notes`);
    for (const n of s.notes) {
      if (!discoveries.includes(n.discovery)) throw new Error(`${id}: unknown discovery ${n.discovery}`);
      if (typeof n.text !== 'string' || n.text.length <= 20 || n.text.length > 240) throw new Error(`${id}/${n.discovery}: note must be 21-240 characters`);
      if (everyNote.has(n.text)) throw new Error(`${id}: repeated note`);
      everyNote.add(n.text);
    }
    const covered = new Set(s.notes.map((n) => n.discovery));
    if (discoveries.some((d) => !covered.has(d))) throw new Error(`${id}: every discovery place needs a note`);
  }
  const ms = doc.chronicle.milestones || {};
  if (JSON.stringify(Object.keys(ms).sort()) !== JSON.stringify([...MILESTONE_KEYS].sort())) throw new Error('Chronicle needs exactly the 20 milestone keys.');
  for (const [k, v] of Object.entries(ms)) if (typeof v !== 'string' || v.length < 20 || v.length > 150) throw new Error(`milestone ${k}: 20-150 characters`);
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  for (const [where, map, max] of [['chronicle', doc.chronicle.projects, 150], ['caption', doc.captions.projects, 140]]) {
    if (!map || !same(Object.keys(map), projects)) throw new Error(`${where}: must cover exactly the ${projects.length} projects`);
    for (const [k, v] of Object.entries(map)) if (typeof v !== 'string' || v.length < 20 || v.length > max) throw new Error(`${where} ${k}: 20-${max} characters`);
  }
  return doc;
}

export const loadStories = (path = SEASONS_PATH) => (existsSync(path) ? Object.freeze(validateStories(readJson(path))) : null);

/** Northern-hemisphere meteorological season of the host's calendar date. Pure. */
export function seasonOf(now, doc = loadStories()) {
  const month = new Date(now).getMonth() + 1;
  return SEASON_IDS.find((id) => doc.seasons[id].months.includes(month));
}

export function seasonEventBlurb(eventId, now, doc = loadStories()) {
  return doc?.seasons[seasonOf(now, doc)].events.find((e) => e.event === eventId)?.blurb ?? null;
}

/** The base notes followed by this season's extra notes for one discovery place. Additive; base notes stay first. */
export function notesFor(discovery, now, doc = loadStories()) {
  const extra = doc ? doc.seasons[seasonOf(now, doc)].notes.filter((n) => n.discovery === discovery.id).map((n) => n.text) : [];
  return [...(discovery.notes || []), ...extra];
}

export const captionFor = (projectId, doc = loadStories()) => doc?.captions.projects[projectId] ?? null;
export const finishedPhrase = (projectId, doc = loadStories()) => doc?.chronicle.projects[projectId] ?? null;
export const milestonePhrase = (key, project, doc = loadStories()) => doc?.chronicle.milestones[key]?.replaceAll('{project}', project) ?? null;
