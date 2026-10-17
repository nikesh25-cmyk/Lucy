// Missions: small peaceful arcs of three or four steps, each step one recorded fact with a count of DISTINCT targets.
//
// Like tasks.js this only READS facts the game server and NemoWorld already stored for one player; it never
// writes, awards or unlocks anything. Three missions are shown per day (a rotation by the host computer's date).
// Not wired into view.js yet: see docs/STORIES_ASKS.md for the two edits that expose it as the `missions` page.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFor } from './identity.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MISSIONS_PATH = join(here, '..', '..', 'content', 'veloren-missions.json');

export const STEP_KINDS = Object.freeze(['resident.met', 'landmark.visited', 'pantry.delivered', 'account.linked', 'landmark.together']);
export const PRINCIPLES = Object.freeze(['scholarship', 'research', 'cooperation', 'growth', 'discovery', 'abundance']);
export const MISSIONS_PER_DAY = 3;
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const MAX_COUNT = { 'resident.met': 30, 'landmark.visited': 10, 'pantry.delivered': 10, 'account.linked': 1, 'landmark.together': 10 };

export function validateMissions(doc) {
  if (!doc || doc.format !== 'harr-missions-v1' || !Array.isArray(doc.missions) || doc.missions.length !== 12) throw new Error('Bad missions file: expected 12 missions.');
  const seen = new Set();
  const perPrinciple = new Map();
  for (const m of doc.missions) {
    if (!SLUG.test(m.id || '') || seen.has(m.id)) throw new Error(`Bad or repeated mission ${m.id}`);
    seen.add(m.id);
    if (!PRINCIPLES.includes(m.principle)) throw new Error(`${m.id}: unknown principle`);
    perPrinciple.set(m.principle, (perPrinciple.get(m.principle) || 0) + 1);
    if (typeof m.title !== 'string' || !m.title || m.title.length > 40) throw new Error(`${m.id}: title must be 1-40 characters`);
    if (typeof m.blurb !== 'string' || !m.blurb || m.blurb.length > 120) throw new Error(`${m.id}: blurb must be 1-120 characters`);
    if (!Array.isArray(m.steps) || m.steps.length < 3 || m.steps.length > 4) throw new Error(`${m.id}: needs 3 or 4 steps`);
    let last = new Map();
    for (const s of m.steps) {
      if (!STEP_KINDS.includes(s.kind)) throw new Error(`${m.id}: step kind ${s.kind} is not allowed`);
      if (!Number.isInteger(s.count) || s.count < 1 || s.count > MAX_COUNT[s.kind]) throw new Error(`${m.id}: count for ${s.kind} must be 1-${MAX_COUNT[s.kind]}`);
      if ((last.get(s.kind) ?? 0) > s.count) throw new Error(`${m.id}: counts of ${s.kind} may not go down`);
      last.set(s.kind, s.count);
      if (typeof s.label !== 'string' || s.label.length < 10 || s.label.length > 110) throw new Error(`${m.id}: step label must be 10-110 characters`);
    }
  }
  for (const p of PRINCIPLES) if (perPrinciple.get(p) !== 2) throw new Error(`Principle ${p} must have exactly two missions.`);
  return doc.missions;
}

export const loadMissions = (path = MISSIONS_PATH) => Object.freeze(validateMissions(JSON.parse(readFileSync(path, 'utf8'))));

/**
 * The distinct-target counts for one player, read from stored facts (the same SQL as tasks.js). Every query is
 * bound to this player's uuid, so nothing about anyone else can leak into the answer.
 */
export function factsOf(link, player_uuid) {
  const sql = link.sql;
  const n = (query, ...args) => Number(sql.get(query, ...args)?.n ?? 0);
  let linked = 0;
  try { linked = identityFor(link, player_uuid) ? 1 : 0; } catch { /* not linked */ }
  return {
    'resident.met': n("SELECT COUNT(DISTINCT resident_id) AS n FROM link_events WHERE kind='resident.met' AND player_uuid=?", player_uuid),
    'landmark.visited': n("SELECT COUNT(DISTINCT landmark_id) AS n FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' AND player_uuid=?", player_uuid),
    'landmark.together': n("SELECT COUNT(DISTINCT landmark_id) AS n FROM link_events WHERE kind='landmark.together' AND landmark_id IS NOT NULL AND player_uuid=?", player_uuid),
    'pantry.delivered': n("SELECT COUNT(*) AS n FROM pantry_takes WHERE state='delivered' AND player_uuid=?", player_uuid),
    'account.linked': linked,
  };
}

/**
 * Pure. Steps are read in order: `chain` is how many steps from the start are done in a row, and the first step
 * not done is `next`. A later step may already be satisfied by older facts; it is shown as done but a mission is
 * complete only when every step is. Counts are lifetime totals, so a step never goes backwards.
 */
export function evaluateMission(mission, facts) {
  const steps = mission.steps.map((s, i) => {
    const have = Math.max(0, Number(facts[s.kind]) || 0);
    return { index: i, kind: s.kind, label: s.label, target: s.count, progress: Math.min(s.count, have), done: have >= s.count };
  });
  let chain = 0;
  while (chain < steps.length && steps[chain].done) chain += 1;
  return { id: mission.id, title: mission.title, principle: mission.principle, blurb: mission.blurb, steps, chain, done: steps.every((s) => s.done), next: steps.find((s) => !s.done) || null };
}

/** Local calendar day number of the host clock (the same day for everyone on this computer). */
export function dayNumber(now) {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** Three consecutive missions from the catalogue, starting 3 further along each day. Pure. */
export function missionsForDay(missions, now, perDay = MISSIONS_PER_DAY) {
  const n = missions.length;
  const start = (((dayNumber(now) * perDay) % n) + n) % n;
  return Array.from({ length: Math.min(perDay, n) }, (_, i) => missions[(start + i) % n]);
}

/** Facts for one player, evaluated against today's three missions. */
export function missionsFor(link, player_uuid, now = link.clock(), missions = loadMissions()) {
  const facts = factsOf(link, player_uuid);
  return missionsForDay(missions, now).map((m) => evaluateMission(m, facts));
}

/** The `missions` page: short lines, about ten, for the chat-sized window. Open to everyone; an account is optional. */
export function missionLines(link, player_uuid) {
  const today = missionsFor(link, player_uuid);
  const done = today.filter((m) => m.done).length;
  const out = [`Today's missions: ${done} of ${today.length} done. They change each day, are all peaceful, and nobody can miss one.`];
  for (const m of today) {
    out.push(`${m.title} (${m.principle}): ${m.done ? 'done, well done.' : `step ${m.chain + 1} of ${m.steps.length}.`} ${m.blurb}`);
    if (m.next) out.push(`Next: ${m.next.label} (${m.next.progress} of ${m.next.target}).`);
  }
  out.push('Say tasks for your first steps, or library and works for places to go. Missions only point the way.');
  return out;
}
