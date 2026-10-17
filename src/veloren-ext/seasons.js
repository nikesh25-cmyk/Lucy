// Harr's slow calendar: four seasons derived ONLY from the host computer's local date.
//
//   * A season is a pure function of the date. Nothing is stored, nothing is replayed after downtime, nothing
//     can be set from chat.
//   * It changes three things and nothing else: the pantry's restock RATES (a multiplier per food, bounded to
//     0.8 - 1.5, never the caps, so no shelf can be starved), the wording of village event blurbs, and one
//     library note a day. No weather, no terrain, no light, no buildings, nothing a person owns.
//   * Words and numbers live in content/harr-seasons.json and are validated hard on load.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SEASONS_PATH = join(here, '..', '..', 'content', 'harr-seasons.json');
export const PANTRY_FOODS = Object.freeze(['apple', 'carrot', 'cheese', 'lettuce']);
export const RATE_MIN = 0.8;
export const RATE_MAX = 1.5;
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const text = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f<>[\]]/.test(v);

export function validateSeasons(doc) {
  if (doc?.format !== 'harr-seasons-v1' || !['north', 'south'].includes(doc.hemisphere) || !Array.isArray(doc.seasons) || doc.seasons.length !== 4) throw new Error('Bad seasons file.');
  const used = new Set();
  const ids = new Set();
  for (const s of doc.seasons) {
    if (!SLUG.test(s.id || '') || ids.has(s.id)) throw new Error(`Bad or repeated season ${s.id}`);
    ids.add(s.id);
    if (!text(s.name, 20) || !text(s.line, 160)) throw new Error(`${s.id}: name and line must be short text.`);
    if (!Array.isArray(s.months) || s.months.length !== 3) throw new Error(`${s.id}: a season is exactly three months.`);
    s.months.forEach((m, i) => {
      if (!Number.isInteger(m) || m < 1 || m > 12 || used.has(m)) throw new Error(`${s.id}: bad or shared month ${m}`);
      if (i > 0 && m !== (s.months[i - 1] % 12) + 1) throw new Error(`${s.id}: months must follow one another`);
      used.add(m);
    });
    for (const food of PANTRY_FOODS) {
      const v = s.pantry?.[food];
      if (!Number.isFinite(v) || v < RATE_MIN || v > RATE_MAX) throw new Error(`${s.id}: ${food} rate must be ${RATE_MIN} to ${RATE_MAX}`);
    }
    for (const key of Object.keys(s.pantry)) if (!PANTRY_FOODS.includes(key)) throw new Error(`${s.id}: unknown food ${key}`);
    if (!s.events || Object.entries(s.events).some(([id, b]) => !SLUG.test(id) || !text(b, 120))) throw new Error(`${s.id}: event lines must be short text`);
    if (!Array.isArray(s.library) || s.library.length < 3 || s.library.length > 12 || s.library.some((n) => !text(n, 170))) throw new Error(`${s.id}: 3-12 short library notes`);
  }
  if (used.size !== 12) throw new Error('The four seasons must cover all twelve months.');
  return doc;
}

let cached = null;
export function loadSeasons(path = SEASONS_PATH) {
  if (path === SEASONS_PATH && cached) return cached;
  const doc = Object.freeze(validateSeasons(JSON.parse(readFileSync(path, 'utf8'))));
  if (path === SEASONS_PATH) cached = doc;
  return doc;
}

// ---- calendar (local time of the host) -----------------------------------------------------------------------------
/** A whole-number day count for a local calendar date, free of daylight-saving jumps. */
export const dayNumber = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000); };
export const localDayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
export const dayKeyOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * The season at `now`: { id, name, line, day, length, days_left, next: { id, name }, rates }. Pure.
 * A non-finite `now` falls back to the first season rather than throwing: the pantry must never break on a bad clock.
 */
export function seasonAt(now, doc = loadSeasons()) {
  const d = new Date(Number.isFinite(now) ? now : 0);
  const shift = doc.hemisphere === 'south' ? 6 : 0;
  const realMonth = d.getMonth() + 1;
  const nominal = ((realMonth - 1 + shift) % 12) + 1; // the month as the file's (northern) seasons name it
  const season = doc.seasons.find((s) => s.months.includes(nominal));
  const startMonth = ((season.months[0] - 1 - shift + 12) % 12) + 1; // real month the season begins in
  const startYear = d.getFullYear() - (realMonth < startMonth ? 1 : 0);
  const startDay = Math.round(Date.UTC(startYear, startMonth - 1, 1) / 86_400_000);
  const endDay = Math.round(Date.UTC(startYear, startMonth - 1 + 3, 1) / 86_400_000);
  const day = dayNumber(d.getTime()) - startDay + 1;
  const ordered = [...doc.seasons].sort((a, b) => ((a.months[0] - 1 - shift + 12) % 12) - ((b.months[0] - 1 - shift + 12) % 12));
  const next = ordered[(ordered.findIndex((s) => s.id === season.id) + 1) % 4];
  return {
    id: season.id, name: season.name, line: season.line, day, length: endDay - startDay, days_left: endDay - startDay - day,
    next: { id: next.id, name: next.name }, rates: { ...season.pantry }, season,
  };
}

/** The restock multiplier for one food at `now`; 1 for anything unknown. Pure. */
export function pantryRate(food, now, doc) {
  try {
    const r = seasonAt(now, doc ?? loadSeasons()).rates[food];
    return Number.isFinite(r) ? Math.min(RATE_MAX, Math.max(RATE_MIN, r)) : 1;
  } catch { return 1; }
}

/** An event's blurb in the season's words (a short replacement, so HUD pages keep their size). Falls back to the plain blurb. Pure. */
export function seasonalBlurb(event, now, doc) {
  try {
    const extra = seasonAt(now, doc ?? loadSeasons()).season.events[event.id];
    return extra || event.blurb;
  } catch { return event.blurb; }
}

/** One library note for today, rotating by calendar day. Pure. */
export function libraryNote(now, doc) {
  try {
    const s = seasonAt(now, doc ?? loadSeasons()).season;
    return s.library[((dayNumber(now) % s.library.length) + s.library.length) % s.library.length];
  } catch { return ''; }
}

const FOOD_PLURAL = { apple: 'apples', carrot: 'carrots', cheese: 'cheese', lettuce: 'lettuce' };
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** The season page: what time of year it is and what it changes. Built from the date only. */
export function seasonLines(now, doc) {
  const s = seasonAt(now, doc ?? loadSeasons());
  const more = PANTRY_FOODS.filter((f) => s.rates[f] > 1.05).map((f) => FOOD_PLURAL[f]);
  const less = PANTRY_FOODS.filter((f) => s.rates[f] < 0.95).map((f) => FOOD_PLURAL[f]);
  const out = [`Season: ${s.name}, day ${s.day} of ${s.length}. ${s.line}`];
  if (more.length || less.length) {
    out.push(`On the farms: the pantry restocks more ${list(more)} now${less.length ? `, and a little less ${list(less)}` : ''}. Nothing runs out for good; it is only the mix that turns.`);
  }
  out.push(`${s.next.name} begins in ${s.days_left + 1} ${s.days_left + 1 === 1 ? 'day' : 'days'}.`);
  out.push('Seasons follow the calendar date on the host computer. They change only the pantry mix and the village words: never the weather, the land or anything you own.');
  return out;
}
