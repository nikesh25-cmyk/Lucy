// The rhythm and the memory of Harr: scheduled village events and the chronicle.
//
// * EVENTS: content/veloren-events.json lists scripted gatherings (market hour, story circle, a weekly festival)
//   on the host computer's clock. While one is on, NemoWorld's director tells the listed residents to walk to
//   its place (the bridge already follows a director order). Nothing is replayed after downtime and nothing is
//   backfilled: whether an event is on is a pure function of the clock now.
// * CHRONICLE: a log built ONLY from stored facts: the director calls that actually sent residents to an event,
//   stages the game server has built (read from its own record), places people found (signed events) and meals
//   the pantry delivered (acknowledged commands). No model text, no invented attendance, no names beyond the
//   neutralised alias of a finder.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiscoveries, loadRecord, loadWorks } from './world-life.js';
import { VILLAGERS } from './villagers.js';
import { LIVING_ROSTER } from '../living-world.js';

const here = dirname(fileURLToPath(import.meta.url));
export const EVENTS_PATH = join(here, '..', '..', 'content', 'veloren-events.json');
const ROLES = new Map([...LIVING_ROSTER, ...VILLAGERS].map((r) => [r.id, r.role || r.calling]));
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;

export function validateEvents(doc) {
  if (!doc || doc.format !== 'nemo-village-events-v1' || !Array.isArray(doc.events) || !doc.events.length || doc.events.length > 12) throw new Error('Bad village events file.');
  const seen = new Set();
  for (const e of doc.events) {
    if (!SLUG.test(e.id || '') || seen.has(e.id)) throw new Error(`Bad or repeated event id ${e.id}`);
    seen.add(e.id);
    if (typeof e.title !== 'string' || !e.title || e.title.length > 40 || typeof e.place !== 'string' || e.place.length > 40) throw new Error(`${e.id}: title and place must be short text.`);
    if (!/^[a-z0-9._-]{1,40}$/.test(e.landmark_id || '')) throw new Error(`${e.id}: bad landmark id.`);
    if (typeof e.blurb !== 'string' || e.blurb.length > 200) throw new Error(`${e.id}: blurb too long.`);
    const w = e.when || {};
    if (!Number.isInteger(w.length) || w.length < 1 || w.length > 180) throw new Error(`${e.id}: length must be 1-180 minutes.`);
    if (w.every === 'hour') { if (!Number.isInteger(w.minute) || w.minute < 0 || w.minute > 59 || w.minute + w.length > 60) throw new Error(`${e.id}: an hourly event must fit inside its hour.`); }
    else if (w.every === 'week') {
      if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start || '')) throw new Error(`${e.id}: a weekly event needs a weekday 0-6 and a start HH:MM.`);
    } else throw new Error(`${e.id}: every must be hour or week.`);
    const who = e.who || {};
    if (!who.all && !(Array.isArray(who.roles) && who.roles.length) && !(Array.isArray(who.ids) && who.ids.length)) throw new Error(`${e.id}: says nobody goes.`);
  }
  return doc.events;
}

export function loadEvents(path = EVENTS_PATH) {
  if (!existsSync(path)) return [];
  return Object.freeze(validateEvents(JSON.parse(readFileSync(path, 'utf8'))));
}

const startMinute = (w) => (w.every === 'hour' ? w.minute : Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3)));

/** The start (ms) of the slot of `event` that is on at `now`, or null. Pure; local time of the host. */
export function activeSlot(event, now) {
  const d = new Date(now);
  const w = event.when;
  if (w.every === 'hour') {
    const minute = d.getMinutes() + d.getSeconds() / 60;
    if (minute < w.minute || minute >= w.minute + w.length) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), w.minute).getTime();
  }
  if (d.getDay() !== w.weekday) return null;
  const start = startMinute(w);
  const minute = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  if (minute < start || minute >= start + w.length) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, start).getTime();
}

/** Minutes until the next slot of `event` starts (0 = on now is handled by activeSlot). Pure. */
export function minutesToNext(event, now) {
  const w = event.when;
  const d = new Date(now);
  for (let step = 0; step <= 8 * 24 * 60; step += 1) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() + step, 0, 0);
    if (t.getTime() <= now) continue;
    if (w.every === 'hour' ? t.getMinutes() === w.minute : t.getDay() === w.weekday && t.getHours() * 60 + t.getMinutes() === startMinute(w)) return Math.ceil((t.getTime() - now) / 60_000);
  }
  return null;
}

export function takesPart(event, resident_id) {
  const who = event.who;
  if (who.all) return true;
  if ((who.ids || []).includes(resident_id)) return true;
  return (who.roles || []).includes(ROLES.get(resident_id));
}

/** Which event, if any, should this resident be at right now? Pure. */
export function eventFor(events, resident_id, now) {
  for (const event of events) {
    const slot = activeSlot(event, now);
    if (slot !== null && takesPart(event, resident_id)) return { event, slot };
  }
  return null;
}

const minutesText = (m) => (m < 60 ? `${m} min` : m < 24 * 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);

export function todayLines(events, now) {
  const out = ["Harr's rhythm (scripted, on this computer's clock):"];
  for (const event of events) {
    const slot = activeSlot(event, now);
    if (slot !== null) out.push(`${event.title} at ${event.place}: on now, ends in ${Math.max(1, Math.ceil((slot + event.when.length * 60_000 - now) / 60_000))} min. ${event.blurb}`);
    else {
      const next = minutesToNext(event, now);
      out.push(`${event.title} at ${event.place}: in ${next === null ? 'a while' : minutesText(next)}. ${event.blurb}`);
    }
  }
  out.push('Walk over and join in; everyone is welcome. The villagers go there by schedule, whether or not anyone watches.');
  return out;
}

// ---- storage -----------------------------------------------------------------------------------------------------

export const villageSchema = {
  version: 1,
  sql: `CREATE TABLE village_attendance(
          event_id TEXT NOT NULL, slot_start INTEGER NOT NULL, resident_id TEXT NOT NULL, first_at INTEGER NOT NULL,
          PRIMARY KEY(event_id, slot_start, resident_id));
        CREATE TABLE village_marks(
          key TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX village_marks_at ON village_marks(at);`,
};

let lastObserved = 0;
export const resetObserver = () => { lastObserved = 0; };

/** Record new facts the chronicle will tell: stages and finished projects in the game server's record. At most every 30 s. */
export function observe(link, now = link.clock(), recordPath = process.env.NEMO_WORLD_RECORD) {
  if (now - lastObserved < 30_000 && now >= lastObserved) return;
  lastObserved = now;
  const record = loadRecord(recordPath);
  if (!record?.groups) return;
  let projects;
  try { projects = loadWorks(); } catch { return; }
  for (const project of projects) {
    let built = 0;
    let lastBuilt = 0;
    for (const stage of project.stages) {
      if (!record.groups[stage.id]) continue;
      built += 1;
      // Dated when the game server built it, not when this process first noticed (a restart of NemoWorld, or a new
      // link database, must not turn a month of building into "today").
      const builtAt = Number(record.groups[stage.id]?.applied_at);
      const at = Number.isFinite(builtAt) && builtAt > 0 && builtAt <= now ? builtAt : now;
      lastBuilt = Math.max(lastBuilt, at);
      link.sql.run('INSERT OR IGNORE INTO village_marks(key,kind,text,at) VALUES(?,?,?,?)', `stage:${stage.id}`, 'stage', `${project.name}: ${stage.title.toLowerCase()}.`, at);
    }
    if (project.stages.length && built === project.stages.length) {
      link.sql.run('INSERT OR IGNORE INTO village_marks(key,kind,text,at) VALUES(?,?,?,?)', `done:${project.id}`, 'done', `${project.name} was finished.`, lastBuilt || now);
    }
  }
}

/** The director hook: send a resident to a running event, and remember that it did. */
export function directorHook(link, resident_id, events = loadEvents(), now = link.clock()) {
  try { observe(link, now); } catch { /* the chronicle must never break a resident's walk */ }
  const hit = eventFor(events, resident_id, now);
  if (!hit) return null;
  link.sql.run('INSERT OR IGNORE INTO village_attendance(event_id,slot_start,resident_id,first_at) VALUES(?,?,?,?)', hit.event.id, hit.slot, resident_id, now);
  return { mode: 'gather', target_landmark_id: hit.event.landmark_id, event_id: hit.event.id };
}

const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Local midnight `back` days before the day of `ms`. Built from the calendar date, never by subtracting 24 hours, which
// is wrong on the two days a year the clocks change (a day is then 23 or 25 hours long).
const dayStartBack = (ms, back = 0) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime(); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The chronicle: one line per recent day, and the milestones. Built only from stored facts. */
export function chronicleLines(link, events = loadEvents(), now = link.clock(), clean = (s) => s) {
  try { observe(link, now); } catch { /* ignore */ }
  const sql = link.sql;
  const days = 3;
  const from = dayStartBack(now, days - 1);
  const out = ['The Harr chronicle, written only from what was recorded (no invented tales):'];
  const marks = sql.all('SELECT kind, at FROM village_marks WHERE at>=?', from);
  // One row per recorded find; a person finding a place counts once per DAY (below), not once per window.
  const finds = sql.all("SELECT occurred_at AS at, player_uuid, landmark_id FROM link_events WHERE kind='landmark.visited' AND occurred_at>=? ORDER BY occurred_at LIMIT 20000", from);
  const meals = sql.all("SELECT created_at AS at, qty FROM pantry_takes WHERE state='delivered' AND created_at>=?", from);
  const runs = sql.all('SELECT event_id, slot_start, COUNT(*) AS residents FROM village_attendance WHERE slot_start>=? GROUP BY event_id, slot_start', from);
  const titles = new Map(events.map((e) => [e.id, e.title.toLowerCase()]));
  for (let i = 0; i < days; i += 1) {
    const start = dayStartBack(now, i);
    const end = dayStartBack(now, i - 1);
    const within = (at) => at >= start && at < end;
    const stages = marks.filter((m) => m.kind === 'stage' && within(m.at)).length;
    const done = marks.filter((m) => m.kind === 'done' && within(m.at)).length;
    const found = new Set(finds.filter((f) => within(Number(f.at))).map((f) => `${f.player_uuid}|${f.landmark_id}`)).size;
    const shared = meals.filter((m) => within(m.at)).reduce((n, m) => n + m.qty, 0);
    const held = new Map();
    for (const r of runs.filter((x) => within(x.slot_start))) held.set(r.event_id, (held.get(r.event_id) || 0) + 1);
    const bits = [];
    if (stages) bits.push(`${plural(stages, 'building stage')} finished`);
    if (done) bits.push(`${plural(done, 'project')} completed`);
    if (found) bits.push(`${plural(found, 'discovery', 'discoveries')} recorded`);
    if (shared) bits.push(`${plural(shared, 'portion')} of food shared`);
    for (const [id, n] of held) bits.push(`${titles.get(id) || id} held ${n === 1 ? 'once' : `${n} times`}`);
    const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : dayKey(start);
    if (bits.length) out.push(`${label}: ${bits.join('; ')}.`);
    else if (i === 0) out.push('Today: a quiet day so far.');
  }
  const done = sql.all("SELECT text, at FROM village_marks WHERE kind='done' ORDER BY at DESC LIMIT 4");
  for (const d of done) out.push(`Milestone, ${dayKey(d.at)}: ${d.text}`);
  const firsts = sql.all("SELECT player_alias, landmark_id, MIN(occurred_at) AS at FROM link_events WHERE kind='landmark.visited' GROUP BY landmark_id ORDER BY at DESC LIMIT 2");
  const names = new Map(loadDiscoveries().map((d) => [d.landmark_id, d.name]));
  for (const f of firsts) if (names.has(f.landmark_id)) out.push(`First page, ${dayKey(f.at)}: ${clean(f.player_alias || 'a traveller')} recorded ${names.get(f.landmark_id)}.`);
  out.push('Residents attending events are scripted; stages come from the game server; finds and meals from signed, acknowledged facts.');
  return out;
}

export const villageExtension = {
  name: 'village',
  schema: villageSchema,
  director: (link, resident_id) => directorHook(link, resident_id),
  async handle() { return false; },
};
