// Harr's missions: a catalogue, checked only against facts that were recorded for that player.
//
// A mission is a small, peaceful piece of guidance (content/veloren-missions.json). Every step names the
// fact that proves it — a signed event kind, an acknowledged pantry delivery, the practice quest, or the
// account link — and a `count` of DISTINCT targets, so "meet five villagers" means five different people
// and "three pages" means three different places. Nothing here can be completed by chatting, nothing awards
// coins or items, and another player's facts are never counted.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFor } from './identity.js';
import { loadDiscoveries } from './world-life.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MISSIONS_PATH = join(here, '..', '..', 'content', 'veloren-missions.json');
const CHARTER_PATH = join(here, '..', '..', 'content', 'harr-charter.json');

/** The fact kinds a step may name. Three are signed events; the others are NemoWorld's own records. */
export const STEP_KINDS = Object.freeze([
  'resident.met', 'landmark.visited', 'landmark.together', 'project.helped',
  'pantry.taken', 'linked', 'quest.quiet-survey',
]);
const DISTINCT = Object.freeze([null, 'resident', 'landmark']);
const SLUG = /^[a-z][a-z0-9-]{1,31}$/;
/** Words that must never appear in guidance about a peaceful village (word-boundary, so "shared" is fine). */
const VIOLENT = /\b(kill|kills|killed|fight|fights|attack|attacks|slay|weapon|weapons|enemy|enemies|battle|blood|dungeon|dungeons|loot|raid|war|steal|steals)\b/i;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function loadMissions() {
  return validateMissions(readJson(MISSIONS_PATH));
}

/** Reject a catalogue that is malformed, unsafe or not about this village's peaceful purposes. */
export function validateMissions(doc) {
  if (doc?.format !== 'veloren-missions-v1' || !Array.isArray(doc.missions)) throw new Error('Bad missions file.');
  if (!doc.missions.length || doc.missions.length > 40) throw new Error('A missions file needs 1 to 40 missions.');
  const principles = new Set((readJson(CHARTER_PATH).principles || []).map((p) => p.id));
  const seen = new Set();
  for (const m of doc.missions) {
    if (!SLUG.test(m?.id || '') || seen.has(m.id)) throw new Error(`Bad or repeated mission id ${m?.id}`);
    seen.add(m.id);
    if (!principles.has(m.principle)) throw new Error(`${m.id}: unknown principle ${m.principle}`);
    for (const field of ['title', 'purpose', 'how']) {
      if (typeof m[field] !== 'string' || !m[field].length || m[field].length > 240) throw new Error(`${m.id}: ${field} must be 1-240 characters`);
      if (VIOLENT.test(m[field])) throw new Error(`${m.id}: ${field} uses violent vocabulary`);
    }
    // `short` is optional: the one-line hint the guide's recommendation shows (help, start, next, menu).
    if (m.short != null) {
      if (typeof m.short !== 'string' || !m.short.length || m.short.length > 120) throw new Error(`${m.id}: short must be 1-120 characters`);
      if (VIOLENT.test(m.short)) throw new Error(`${m.id}: short uses violent vocabulary`);
    }
    if (!Array.isArray(m.steps) || !m.steps.length || m.steps.length > 6) throw new Error(`${m.id}: needs 1 to 6 steps`);
    for (const step of m.steps) {
      if (!STEP_KINDS.includes(step?.kind)) throw new Error(`${m.id}: unknown step kind ${step?.kind}`);
      if (!Number.isInteger(step.count) || step.count < 1 || step.count > 20) throw new Error(`${m.id}: step count must be 1-20`);
      if (!DISTINCT.includes(step.distinct ?? null)) throw new Error(`${m.id}: distinct must be resident, landmark or absent`);
      if (step.prefix != null && (typeof step.prefix !== 'string' || !/^[a-z-]{2,8}$/.test(step.prefix))) throw new Error(`${m.id}: bad landmark prefix`);
      if (step.prefix != null && step.kind !== 'landmark.visited') throw new Error(`${m.id}: only landmark.visited takes a prefix`);
      if (step.distinct === 'resident' && step.kind !== 'resident.met') throw new Error(`${m.id}: only resident.met counts distinct residents`);
    }
  }
  return doc;
}

/**
 * How many distinct facts of this step's kind this player has. Stored data only; every query is scoped to
 * the player, so one person's progress is never another's.
 */
export function stepCount(link, player_uuid, step) {
  const sql = link.sql;
  const n = (query, ...args) => Number(sql.get(query, ...args)?.n ?? 0);
  if (step.kind === 'linked') {
    try { return identityFor(link, player_uuid) ? 1 : 0; } catch { return 0; }
  }
  if (step.kind === 'quest.quiet-survey') {
    try { return link.progress(player_uuid).complete ? 1 : 0; } catch { return 0; }
  }
  if (step.kind === 'pantry.taken') {
    return n("SELECT COUNT(*) AS n FROM pantry_takes WHERE state='delivered' AND player_uuid=?", player_uuid);
  }
  const where = ['kind=?', 'player_uuid=?'];
  const args = [step.kind, player_uuid];
  if (step.prefix) { where.push('landmark_id LIKE ?'); args.push(`${step.prefix}%`); }
  const filter = `WHERE ${where.join(' AND ')}`;
  if (step.distinct === 'resident') return n(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM link_events ${filter} GROUP BY resident_id)`, ...args);
  if (step.distinct === 'landmark') return n(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM link_events ${filter} GROUP BY landmark_id)`, ...args);
  return n(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM link_events ${filter})`, ...args);
}

/** Fill the placeholders a mission's `how` may use ({place} is the first place worth finding). */
function fill(how, discoveries) {
  const first = discoveries[0];
  return how.replaceAll('{place}', first ? first.name.toLowerCase() : 'a place on the list');
}

/**
 * Every mission with this player's progress. Steps are independent (the page says "take them in any order"),
 * so a fact for one step never credits another; a mission's single (progress, target) is its first unfinished
 * step, which is what the short task list shows.
 */
export function missionsFor(link, player_uuid, { catalogue = null, discoveries = null } = {}) {
  const missions = catalogue || loadMissions();
  const places = discoveries || loadDiscoveries();
  return missions.missions.map((m) => {
    const steps = m.steps.map((step) => ({ ...step, progress: Math.min(step.count, stepCount(link, player_uuid, step)) }));
    const open = steps.find((s) => s.progress < s.count) || null;
    return {
      id: m.id, title: m.title, principle: m.principle, purpose: m.purpose, how: fill(m.how, places),
      ...(m.short ? { short: fill(m.short, places) } : {}),
      steps, done: !open,
      progress: open ? open.progress : steps.reduce((a, s) => a + s.count, 0),
      target: open ? open.count : steps.reduce((a, s) => a + s.count, 0),
    };
  });
}

/** A tiny deterministic hash, so the same day always offers the same three missions and the next day differs. */
const hash = (text) => {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
};

/** Today's three, drawn from the catalogue by the day key (stable within a day, different across days). */
export function dailyRotation(missions, dayKey) {
  return [...missions.missions]
    .sort((a, b) => hash(`${dayKey}:${a.id}`) - hash(`${dayKey}:${b.id}`))
    .slice(0, 3)
    .map((m) => m.id);
}

const dayKeyOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The guide's `missions` page: today's three, then the rest, with one honest next step. Bounded by the pager. */
export function missionsLines(link, player_uuid, now = link.clock()) {
  const catalogue = loadMissions();
  const all = missionsFor(link, player_uuid, { catalogue });
  const today = new Set(dailyRotation(catalogue, dayKeyOf(now)));
  const out = [`Harr missions. Every one is checked from recorded facts, awards nothing, and can be taken in any order.`];
  out.push(`Today (${dayKeyOf(now)}): ${all.filter((m) => today.has(m.id)).map((m) => `${m.done ? 'done' : 'open'} ${m.title.toLowerCase()}`).join('; ')}.`);
  for (const m of all) {
    const mark = today.has(m.id) ? '*' : ' ';
    out.push(`${mark}${m.done ? 'Done' : 'Open'}: ${m.title}${m.done ? '' : `, ${m.progress} of ${m.target}`}. ${m.purpose}`);
  }
  const next = all.find((m) => !m.done);
  if (next) out.push(`Next: ${next.title} (${next.progress} of ${next.target}). ${next.how}`);
  else out.push('Every mission is done. Lend a hand to the next stage, or see what the village is learning with research.');
  return out;
}
