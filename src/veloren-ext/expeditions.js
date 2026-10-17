// Field surveys: a daily, peaceful, rotating goal drawn from the discovery catalogue.
//
//   * The SHEET (which places, which goal) is a pure function of the host's local date: no storage, nothing to
//     reset, nothing to miss. A restart changes nothing.
//   * A RECORD is a signed `landmark.visited` event at a place on the sheet, made on that local day before dusk
//     (content/harr-expeditions.json). Chat cannot make one. Standing at a known place again counts, so the
//     sheet gives old finds a reason to be revisited.
//   * A person's survey is DONE when they hold `need` distinct records on that day's sheet.
//   * The VILLAGE COUNTER only adds records up (today, this week, days the village goal was met). It names nobody,
//     ranks nobody, and a quiet day costs nothing.
// Nothing here grants coins, Karma or items.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDiscoveries } from './world-life.js';
import { dayKeyOf, dayNumber, localDayStart } from './seasons.js';

const here = dirname(fileURLToPath(import.meta.url));
export const EXPEDITIONS_PATH = join(here, '..', '..', 'content', 'harr-expeditions.json');
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const DAY_MS = 86_400_000;
const SKEW_MS = 5 * 60_000; // the link refuses events further ahead than this; a record is never from the future
const text = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f<>[\]]/.test(v);

export function validateExpeditions(doc) {
  if (doc?.format !== 'harr-expeditions-v1' || !Array.isArray(doc.templates) || !doc.templates.length || doc.templates.length > 12) throw new Error('Bad expeditions file.');
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(doc.dusk_hour, 12, 23) || !int(doc.stride, 1, 50) || !int(doc.village_goal_per_day, 1, 500) || !int(doc.history_days, 7, 60)) throw new Error('Bad expeditions numbers.');
  const seen = new Set();
  for (const t of doc.templates) {
    if (!SLUG.test(t.id || '') || seen.has(t.id)) throw new Error(`Bad or repeated template ${t.id}`);
    seen.add(t.id);
    if (!text(t.title, 60) || !text(t.blurb, 160)) throw new Error(`${t.id}: title and blurb must be short text.`);
    if (!int(t.need, 1, 6) || !int(t.offer, 1, 8) || t.need > t.offer) throw new Error(`${t.id}: need must be 1-6 and no more than offer`);
  }
  return doc;
}

let cached = null;
export function loadExpeditions(path = EXPEDITIONS_PATH) {
  if (path === EXPEDITIONS_PATH && cached) return cached;
  const doc = Object.freeze(validateExpeditions(JSON.parse(readFileSync(path, 'utf8'))));
  if (path === EXPEDITIONS_PATH) cached = doc;
  return doc;
}

/** The sheet for the local day containing `now`. Pure; the same date always gives the same sheet. */
export function sheetFor(now, catalogue = loadDiscoveries(), doc = loadExpeditions()) {
  const places = [...catalogue].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = places.length;
  const dn = dayNumber(now);
  const template = doc.templates[((dn % doc.templates.length) + doc.templates.length) % doc.templates.length];
  const offer = Math.min(template.offer, n);
  const need = Math.min(template.need, offer);
  const start = n ? (((dn * doc.stride) % n) + n) % n : 0;
  const chosen = [];
  for (let i = 0; i < offer; i += 1) chosen.push(places[(start + i) % n]);
  const dayStart = localDayStart(now);
  return {
    day: dayKeyOf(now), day_start: dayStart, dusk_at: new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate(), doc.dusk_hour).getTime(),
    template: { id: template.id, title: template.title, blurb: template.blurb }, need, places: chosen,
  };
}

/** Records on a day's sheet from event rows: [{ player_uuid, landmark_id, at }] -> Map(player -> Map(landmark -> first at)). Pure. */
export function recordsOnSheet(sheet, rows) {
  const ids = new Set(sheet.places.map((p) => p.landmark_id));
  const byPlayer = new Map();
  for (const r of rows) {
    const at = Number(r.at);
    if (!ids.has(r.landmark_id) || !Number.isFinite(at) || at < sheet.day_start || at >= sheet.dusk_at) continue;
    if (!byPlayer.has(r.player_uuid)) byPlayer.set(r.player_uuid, new Map());
    const mine = byPlayer.get(r.player_uuid);
    if (!mine.has(r.landmark_id) || at < mine.get(r.landmark_id)) mine.set(r.landmark_id, at);
  }
  return byPlayer;
}

const finishedAt = (records, need) => { const times = [...records.values()].sort((a, b) => a - b); return times.length >= need ? times[need - 1] : null; };

function rowsSince(sql, from, now) {
  // disc-* places only; a bounded read so a busy server cannot make this slow.
  return sql.all("SELECT player_uuid, landmark_id, occurred_at AS at FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at ASC LIMIT 20000", from, now + SKEW_MS);
}

/** Today's sheet and what one person has recorded on it. */
export function surveyFor(link, player_uuid, now = link.clock()) {
  const sheet = sheetFor(now);
  const mine = recordsOnSheet(sheet, rowsSince(link.sql, sheet.day_start, now)).get(player_uuid) || new Map();
  const done = finishedAt(mine, sheet.need) !== null;
  return { sheet, recorded: [...mine.keys()], count: mine.size, need: sheet.need, done, closed: now >= sheet.dusk_at };
}

/** The village counter: records and finished surveys, today and over the history window. No names. */
export function villageSurvey(link, now = link.clock(), doc = loadExpeditions()) {
  const days = doc.history_days;
  const firstDay = localDayStart(now) - (days - 1) * DAY_MS;
  const rows = rowsSince(link.sql, firstDay - DAY_MS, now);
  let todayOut = null; let week = { records: 0, completed: 0 }; let goalDays = 0;
  for (let i = 0; i < days; i += 1) {
    const probe = localDayStart(now) - i * DAY_MS + 12 * 3_600_000; // noon: safe from DST edges
    const sheet = sheetFor(probe);
    const per = recordsOnSheet(sheet, rows);
    let records = 0; let completed = 0;
    for (const m of per.values()) { records += m.size; if (finishedAt(m, sheet.need) !== null) completed += 1; }
    if (i === 0) todayOut = { title: sheet.template.title, records, surveyors: per.size, completed, goal: doc.village_goal_per_day, goal_met: records >= doc.village_goal_per_day, closed: now >= sheet.dusk_at };
    if (i < 7) { week.records += records; week.completed += completed; }
    if (records >= doc.village_goal_per_day) goalDays += 1;
  }
  return { today: todayOut, week, goal_days: goalDays, history_days: days };
}

/** Local-day completions for one person over recent days: [{ day, at }] (newest first). Used by the apprenticeship. */
export function completedSurveys(link, player_uuid, now = link.clock(), days = 14) {
  const firstDay = localDayStart(now) - (days - 1) * DAY_MS;
  const rows = rowsSince(link.sql, firstDay - DAY_MS, now).filter((r) => r.player_uuid === player_uuid);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const sheet = sheetFor(localDayStart(now) - i * DAY_MS + 12 * 3_600_000);
    const mine = recordsOnSheet(sheet, rows).get(player_uuid);
    const at = mine ? finishedAt(mine, sheet.need) : null;
    if (at !== null) out.push({ day: sheet.day, at });
  }
  return out;
}

const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function surveyLines(link, player_uuid, now = link.clock(), doc = loadExpeditions()) {
  const mine = surveyFor(link, player_uuid, now);
  const village = villageSurvey(link, now, doc);
  const names = new Map(mine.sheet.places.map((p) => [p.landmark_id, p.name]));
  const out = [`Field survey for ${mine.sheet.day}: ${mine.sheet.template.title}. ${mine.sheet.template.blurb}`];
  out.push(`Today's sheet: ${mine.sheet.places.map((p) => `${p.name} (${p.hint})`).join('; ')}.`);
  if (mine.done) out.push(`You have finished today's survey with ${plural(mine.count, 'record')}. Thank you; the page is fuller for it.`);
  else if (mine.closed) out.push(`Dusk (${hhmm(doc.dusk_hour)}) has passed, so today's sheet is closed with ${mine.count} of ${mine.need} records from you. A new sheet is posted tomorrow.`);
  else out.push(`You have recorded ${mine.count} of ${mine.need}${mine.recorded.length ? ` (${mine.recorded.map((id) => names.get(id)).join(', ').toLowerCase()})` : ''}. Walk to a place on the sheet and stay a few seconds; the sheet closes at dusk (${hhmm(doc.dusk_hour)}).`);
  out.push(`The village today: ${plural(village.today.records, 'record')} of ${village.today.goal}, from ${plural(village.today.surveyors, 'surveyor')}. This week: ${plural(village.week.records, 'record')}, ${plural(village.week.completed, 'finished survey')}.`);
  out.push('Records come from signed events at the places; they bring recognition and a line in the chronicle, never coins. Nobody is ranked.');
  return out;
}
