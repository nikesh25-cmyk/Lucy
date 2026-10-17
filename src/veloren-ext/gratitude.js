// The Gratitude board: a small wall of recent thanks in the village square.
//
//   POST /veloren/harr/thank  { player_uuid, reason: 'meal' | 'find' | 'met', subject? }   scope director, guide credential
//
// Thanks rest on recorded facts, never on chat:
//   * meal : you had a pantry portion DELIVERED (the game acknowledged it) in the last 3 days -> thank the farmers.
//   * find : you stood at a discovery place (signed event) whose page was first written by someone else -> thank
//            that first finder by name.
//   * met  : you met a villager (signed event) -> thank them for the welcome. Once per villager per day.
// Each fact can be thanked once (UNIQUE(thanker, fact_key)) and a person may thank at most 3 times a day, so the
// wall cannot be flooded and nothing can be farmed. Thanks are templated: no free text ever reaches the wall, so
// nobody can use it to insult, advertise or hide a link. The villagers also thank people, scripted and labelled:
// the village's scholars thank the finder of a new page and the builders thank everyone when a project is finished.
//
// The wall is NOT a score: it shows the newest thanks first, at most one per person thanked, for 7 days, and nobody
// has a count. Thanking grants nothing to anyone (no coins, Karma or items); being thanked grants nothing either.
import { LIVING_ROSTER } from '../living-world.js';
import { VILLAGERS } from './villagers.js';
import { GUIDE_RESIDENTS, plain, spendRate } from './view.js';
import { loadDiscoveries } from './world-life.js';
import { dayKeyOf } from './seasons.js';

export const GRATITUDE_POLICY = Object.freeze({
  per_player_per_day: 3,
  wall_size: 8,
  wall_days: 7,
  keep_days: 30,
  meal_window_days: 3,
  gap_ms: 4_000,
  per_hour: 20,
});
export const REASONS = Object.freeze(['meal', 'find', 'met']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESIDENT = /^lw-[a-z]{2,20}$/;
const DAY_MS = 86_400_000;
const RESIDENTS = new Map([...LIVING_ROSTER, ...VILLAGERS].map((r) => [r.id, r]));

export const gratitudeSchema = {
  version: 1,
  sql: `CREATE TABLE gratitude_thanks(
          id INTEGER PRIMARY KEY AUTOINCREMENT, thanker TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
          recipient TEXT NOT NULL DEFAULT '', fact_key TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL,
          UNIQUE(thanker, fact_key));
        CREATE INDEX gratitude_thanks_at ON gratitude_thanks(at);
        CREATE INDEX gratitude_thanks_day ON gratitude_thanks(thanker, day);`,
};

const aliasOf = (sql, uuid) => sql.get('SELECT alias FROM link_players WHERE player_uuid=?', uuid)?.alias || '';
const placeName = (landmark_id) => loadDiscoveries().find((d) => d.landmark_id === landmark_id)?.name || null;

// ---- what a person may thank, from facts --------------------------------------------------------------------------
/** Pantry portions the game delivered to this person recently and that they have not yet thanked. */
export function mealsToThank(sql, player, now) {
  return sql.all(`SELECT cmd_id, created_at FROM pantry_takes
                  WHERE player_uuid=? AND state='delivered' AND created_at>=? AND created_at<=?
                    AND ('meal:' || cmd_id) NOT IN (SELECT fact_key FROM gratitude_thanks WHERE thanker=?)
                  ORDER BY created_at DESC LIMIT 20`, player, now - GRATITUDE_POLICY.meal_window_days * DAY_MS, now, player);
}

/** Places this person has stood at whose first page was written by somebody else, not yet thanked. */
export function findsToThank(sql, player, now) {
  const mine = sql.all("SELECT landmark_id, MAX(occurred_at) AS at FROM link_events WHERE kind='landmark.visited' AND player_uuid=? AND landmark_id LIKE 'disc-%' AND occurred_at<=? GROUP BY landmark_id ORDER BY at DESC LIMIT 50", player, now + 300_000);
  const thanked = new Set(sql.all("SELECT fact_key FROM gratitude_thanks WHERE thanker=? AND kind='find'", player).map((r) => r.fact_key));
  const out = [];
  for (const m of mine) {
    if (!placeName(m.landmark_id) || thanked.has(`find:${m.landmark_id}`)) continue;
    const first = sql.get("SELECT player_uuid FROM link_events WHERE kind='landmark.visited' AND landmark_id=? ORDER BY occurred_at ASC, seq ASC LIMIT 1", m.landmark_id);
    if (!first || first.player_uuid === player) continue; // you cannot thank yourself
    out.push({ landmark_id: m.landmark_id, recipient: first.player_uuid, at: Number(m.at) });
  }
  return out;
}

/** Villagers this person has met (known residents only), not yet thanked today. */
export function residentsToThank(sql, player, now) {
  const day = dayKeyOf(now);
  const thanked = new Set(sql.all("SELECT fact_key FROM gratitude_thanks WHERE thanker=? AND kind='met'", player).map((r) => r.fact_key));
  return sql.all("SELECT resident_id, MAX(occurred_at) AS at FROM link_events WHERE kind='resident.met' AND player_uuid=? AND occurred_at<=? GROUP BY resident_id ORDER BY at DESC LIMIT 50", player, now + 300_000)
    .filter((r) => RESIDENTS.has(r.resident_id) && !thanked.has(`met:${r.resident_id}:${day}`));
}

// ---- giving thanks -------------------------------------------------------------------------------------------------
/**
 * Record one thanks if the facts allow it. `subject` may be omitted (the newest eligible fact is used), or names a
 * discovery id / landmark id (find) or a resident id (met). Returns { ok, lines }. Never throws on bad input.
 */
export function thank(link, { player_uuid, reason, subject = '' }, now = link.clock()) {
  const sql = link.sql;
  if (!UUID.test(String(player_uuid || ''))) return { ok: false, lines: ['I need a player to record a thanks for.'] };
  if (!REASONS.includes(reason)) return { ok: false, lines: ['You can thank the farmers for a meal (thank meal), the finder of a place you visited (thank find) or a villager you met (thank met).'] };
  const day = dayKeyOf(now);
  const used = sql.get('SELECT COUNT(*) AS n FROM gratitude_thanks WHERE thanker=? AND day=?', player_uuid, day).n;
  if (used >= GRATITUDE_POLICY.per_player_per_day) return { ok: false, lines: ['You have already said your thanks for today. Gratitude is best given a little at a time; come back tomorrow.'] };
  const subj = String(subject || '').trim().toLowerCase().slice(0, 40);
  let row = null;
  let lines;
  if (reason === 'meal') {
    const meal = mealsToThank(sql, player_uuid, now)[0];
    if (!meal) return { ok: false, lines: ['Take something from the pantry first (whisper take apple), then you can thank the farmers who grew it.'] };
    row = { kind: 'meal', subject: 'farmers', recipient: '', fact_key: `meal:${meal.cmd_id}` };
    lines = ['Your thanks to the farmers is on the wall in the square. They will be glad to hear it.'];
  } else if (reason === 'find') {
    const options = findsToThank(sql, player_uuid, now);
    if (subj && !/^[a-z0-9._-]{1,40}$/.test(subj)) return { ok: false, lines: ['I do not know that place.'] };
    const hit = subj ? options.find((o) => o.landmark_id === subj || o.landmark_id === `disc-${subj}`) : options[0];
    if (!hit) return { ok: false, lines: [subj ? 'You can only thank someone for a place you have visited yourself, and only for a page somebody else wrote first.' : 'Visit a place in the library that somebody else found first, then you can thank them for the page.'] };
    row = { kind: 'find', subject: hit.landmark_id, recipient: hit.recipient, fact_key: `find:${hit.landmark_id}` };
    lines = [`Your thanks for the page on ${placeName(hit.landmark_id).toLowerCase()} is on the wall.`];
  } else {
    if (subj && !RESIDENT.test(subj)) return { ok: false, lines: ['I do not know that villager.'] };
    const options = residentsToThank(sql, player_uuid, now);
    const hit = subj ? options.find((o) => o.resident_id === subj) : options[0];
    if (!hit) return { ok: false, lines: ['Meet a villager first (stand beside them for a moment), then you can thank them. One thanks per villager per day.'] };
    row = { kind: 'met', subject: hit.resident_id, recipient: '', fact_key: `met:${hit.resident_id}:${day}` };
    lines = [`Your thanks to ${RESIDENTS.get(hit.resident_id).name} is on the wall.`];
  }
  const done = sql.tx(() => {
    const r = sql.run('INSERT OR IGNORE INTO gratitude_thanks(thanker,kind,subject,recipient,fact_key,day,at) VALUES(?,?,?,?,?,?,?)', player_uuid, row.kind, row.subject, row.recipient, row.fact_key, day, now);
    sql.run('DELETE FROM gratitude_thanks WHERE at<?', now - GRATITUDE_POLICY.keep_days * DAY_MS);
    return r.changes > 0;
  });
  return done ? { ok: true, lines } : { ok: false, lines: ['You have already thanked for that one. Thank you for the thought.'] };
}

// ---- the wall ------------------------------------------------------------------------------------------------------
/**
 * The newest thanks, derived from stored rows and facts. At most one entry per person (or group) thanked, newest first,
 * no counts. `clean` neutralises every alias (the overview passes a constant). Returns [{ at, source, text }].
 */
export function wallEntries(link, now = link.clock(), clean = (s) => s, size = GRATITUDE_POLICY.wall_size) {
  const sql = link.sql;
  const from = now - GRATITUDE_POLICY.wall_days * DAY_MS;
  const name = (uuid) => clean(aliasOf(sql, uuid) || 'a traveller') || 'a traveller';
  const entries = [];
  let rows = [];
  try { rows = sql.all('SELECT thanker, kind, subject, recipient, at FROM gratitude_thanks WHERE at>=? AND at<=? ORDER BY at DESC LIMIT 200', from, now); } catch { /* extension not installed */ }
  for (const r of rows) {
    const who = name(r.thanker);
    if (r.kind === 'meal') entries.push({ at: r.at, source: 'player', who: 'farmers', text: `${who} thanks the farmers for a meal from the pantry.` });
    else if (r.kind === 'find' && placeName(r.subject)) entries.push({ at: r.at, source: 'player', who: `p:${r.recipient}`, text: `${who} thanks ${name(r.recipient)} for recording ${placeName(r.subject)}.` });
    else if (r.kind === 'met' && RESIDENTS.has(r.subject)) entries.push({ at: r.at, source: 'player', who: `r:${r.subject}`, text: `${who} thanks ${RESIDENTS.get(r.subject).name} for the welcome.` });
  }
  // The scholars thank whoever wrote a new page (scripted; the scholar is chosen from the place's id).
  const scholars = VILLAGERS.filter((v) => v.role === 'scholar');
  const firsts = sql.all("SELECT landmark_id, player_uuid, MIN(occurred_at) AS at FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' GROUP BY landmark_id");
  for (const f of firsts) {
    if (!(f.at >= from && f.at <= now) || !placeName(f.landmark_id) || !scholars.length) continue;
    const who = scholars[[...f.landmark_id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % scholars.length];
    const first = sql.get("SELECT player_uuid FROM link_events WHERE kind='landmark.visited' AND landmark_id=? ORDER BY occurred_at ASC, seq ASC LIMIT 1", f.landmark_id);
    entries.push({ at: Number(f.at), source: 'village', who: `p:${first.player_uuid}`, text: `${who.name} (a scripted villager) thanks ${name(first.player_uuid)} for the new page on ${placeName(f.landmark_id)}.` });
  }
  // The builders thank everyone when a project is finished.
  for (const m of sql.all("SELECT text, at FROM village_marks WHERE kind='done' AND at>=? AND at<=? ORDER BY at DESC LIMIT 20", from, now)) {
    entries.push({ at: m.at, source: 'village', who: `m:${m.text}`, text: `The builders (scripted) thank everyone who lent a hand. ${m.text}` });
  }
  entries.sort((a, b) => b.at - a.at || (a.text < b.text ? -1 : 1));
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.who)) continue; // one entry per person thanked: nobody can fill the wall
    seen.add(e.who);
    out.push({ at: e.at, source: e.source, text: e.text });
    if (out.length >= size) break;
  }
  return out;
}

export function gratitudeLines(link, player_uuid, now = link.clock(), clean = (s) => s) {
  const wall = wallEntries(link, now, clean);
  const out = ['The Gratitude board in the square: the newest thanks, with nobody counted or ranked.'];
  if (wall.length) for (const e of wall.slice(0, 5)) out.push(e.text);
  else out.push('Nothing on the wall yet. Be the first to say thank you.');
  let left = GRATITUDE_POLICY.per_player_per_day;
  const ways = [];
  try {
    left = Math.max(0, left - link.sql.get('SELECT COUNT(*) AS n FROM gratitude_thanks WHERE thanker=? AND day=?', player_uuid, dayKeyOf(now)).n);
    if (mealsToThank(link.sql, player_uuid, now).length) ways.push('thank meal (the farmers)');
    if (findsToThank(link.sql, player_uuid, now).length) ways.push('thank find (whoever wrote a library page you visited)');
    if (residentsToThank(link.sql, player_uuid, now).length) ways.push('thank met (a villager you met)');
  } catch { /* nothing to offer */ }
  out.push(ways.length && left > 0 ? `You can say: ${ways.join(', ')}. ${left} more today.` : left > 0 ? 'Share a meal, visit a place in the library or meet a villager, and you can thank them here.' : 'You have said your thanks for today; come back tomorrow.');
  out.push('Thanks are short, fixed sentences built from what really happened. They give nothing to anyone and cost nothing.');
  return out;
}

export const gratitudeExtension = {
  name: 'gratitude',
  schema: gratitudeSchema,
  async handle(link, ctx) {
    if (ctx.route !== '/veloren/harr/thank' || ctx.request.method !== 'POST') return false;
    const credential = link.authenticate(ctx.tokenFrom(ctx.request), 'director');
    if (!GUIDE_RESIDENTS.includes(credential.resident_id)) ctx.fail(403, 'Only a guide resident may ask on a player\'s behalf.');
    const input = await ctx.body(ctx.request);
    const player = typeof input?.player_uuid === 'string' && UUID.test(input.player_uuid) ? input.player_uuid : ctx.fail(400, 'A Veloren player id is required.');
    spendRate(link, '*thanks', { gapMs: 0, perHour: 600 });
    spendRate(link, `thanks:${player}`, { gapMs: GRATITUDE_POLICY.gap_ms, perHour: GRATITUDE_POLICY.per_hour });
    ctx.json(ctx.response, 200, thank(link, { player_uuid: player, reason: typeof input.reason === 'string' ? input.reason : '', subject: typeof input.subject === 'string' ? plain(input.subject, 40) : '' }));
    return true;
  },
};
