// Apprenticeship: a newcomer learns a craft beside a named villager mentor, one short chain per role.
//
//   * STATELESS. There is no table and no "start" button. Every step is evaluated from stored facts about one
//     person, so a restart loses nothing and nothing can be marked done by hand or by chat.
//   * ORDERED. A step counts only facts that happened strictly AFTER the previous step was completed (the first
//     step, meeting the mentor, counts from the beginning). Doing things early does not skip the chain.
//   * Step kinds (content/harr-apprenticeship.json): meet_mentor, report_back (signed resident.met events with the
//     mentor), finds (signed landmark.visited at discovery places), meals (pantry portions the game delivered),
//     meet_residents (other villagers met), shadow_stage (met a villager of that role shortly before the game
//     server finished a building stage), thanked (a thanks on the Gratitude board), survey (a finished field survey).
//   * Finishing gives a title of recognition and nothing else: no coins, items or Karma.
// shadow_stage is honest about what it proves: that the person stood with a builder at the time a stage was finished.
// The game server does not yet tell NemoWorld who stood at the site (see docs/GAMEPLAY_NEW.md).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VILLAGERS } from './villagers.js';
import { loadDiscoveries } from './world-life.js';
import { observe } from './village.js';
import { completedSurveys } from './expeditions.js';

const here = dirname(fileURLToPath(import.meta.url));
export const APPRENTICESHIP_PATH = join(here, '..', '..', 'content', 'harr-apprenticeship.json');
const KINDS = ['meet_mentor', 'report_back', 'finds', 'meals', 'meet_residents', 'shadow_stage', 'thanked', 'survey'];
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
const SKEW_MS = 5 * 60_000;
const ROLES = new Set(VILLAGERS.map((v) => v.role));
const text = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f<>[\]|{}]/.test(v.replace('{mentor}', ''));

export function validateApprenticeship(doc, villagers = VILLAGERS) {
  if (doc?.format !== 'harr-apprenticeship-v1' || !doc.roles || typeof doc.roles !== 'object') throw new Error('Bad apprenticeship file.');
  const out = {};
  for (const [role, def] of Object.entries(doc.roles)) {
    if (!ROLES.has(role)) throw new Error(`${role}: no villagers have this role`);
    const mentor = villagers.find((v) => v.id === def.mentor && v.role === role);
    if (!mentor) throw new Error(`${role}: the mentor must be a villager of that role`);
    if (!text(def.title, 40)) throw new Error(`${role}: title`);
    if (!Array.isArray(def.steps) || def.steps.length < 2 || def.steps.length > 6) throw new Error(`${role}: 2-6 steps`);
    if (def.steps[0].kind !== 'meet_mentor' || def.steps.slice(1).some((s) => s.kind === 'meet_mentor')) throw new Error(`${role}: the chain starts with meeting the mentor, once`);
    const ids = new Set();
    for (const s of def.steps) {
      if (!SLUG.test(s.id || '') || ids.has(s.id) || !KINDS.includes(s.kind) || !text(s.text, 200)) throw new Error(`${role}: bad step ${s.id}`);
      ids.add(s.id);
      if (['finds', 'meals', 'meet_residents'].includes(s.kind) && !(Number.isInteger(s.count) && s.count >= 1 && s.count <= 10)) throw new Error(`${role}/${s.id}: count 1-10`);
      if (s.kind === 'finds' && s.landmarks !== undefined && !(Array.isArray(s.landmarks) && s.landmarks.length && s.landmarks.every((l) => /^disc-[a-z0-9-]{2,40}$/.test(l)))) throw new Error(`${role}/${s.id}: landmarks`);
      if (s.kind === 'shadow_stage' && (!ROLES.has(s.role) || !Number.isInteger(s.within_minutes) || s.within_minutes < 1 || s.within_minutes > 120)) throw new Error(`${role}/${s.id}: shadow_stage needs a role and 1-120 minutes`);
      if (s.kind === 'thanked' && !['meal', 'find', 'met'].includes(s.thanks)) throw new Error(`${role}/${s.id}: thanked needs a reason`);
    }
    out[role] = { role, title: def.title, mentor: { id: mentor.id, name: mentor.name }, steps: def.steps };
  }
  return out;
}

let cached = null;
export function loadApprenticeship(path = APPRENTICESHIP_PATH) {
  if (path === APPRENTICESHIP_PATH && cached) return cached;
  const doc = validateApprenticeship(JSON.parse(readFileSync(path, 'utf8')));
  if (path === APPRENTICESHIP_PATH) cached = doc;
  return doc;
}

// ---- evaluating a step from facts ----------------------------------------------------------------------------------
// Each evaluator returns the time (ms) the step was completed, or null. `since` is the previous completion (exclusive).
const nth = (times, n) => { const sorted = times.map(Number).filter(Number.isFinite).sort((a, b) => a - b); return sorted.length >= n ? sorted[n - 1] : null; };

function evaluate(link, def, step, player, since, now, mentorId) {
  const sql = link.sql;
  const after = since ?? -1;
  const limit = now + SKEW_MS;
  switch (step.kind) {
    case 'meet_mentor':
    case 'report_back': {
      const r = sql.get("SELECT MIN(occurred_at) AS t FROM link_events WHERE kind='resident.met' AND player_uuid=? AND resident_id=? AND occurred_at>? AND occurred_at<=?", player, mentorId, after, limit);
      return r?.t ?? null;
    }
    case 'finds': {
      const known = new Set(loadDiscoveries().map((d) => d.landmark_id));
      const allowed = step.landmarks ? new Set(step.landmarks) : null;
      const rows = sql.all("SELECT landmark_id, MIN(occurred_at) AS t FROM link_events WHERE kind='landmark.visited' AND player_uuid=? AND landmark_id LIKE 'disc-%' AND occurred_at>? AND occurred_at<=? GROUP BY landmark_id", player, after, limit);
      return nth(rows.filter((r) => known.has(r.landmark_id) && (!allowed || allowed.has(r.landmark_id))).map((r) => r.t), step.count);
    }
    case 'meals':
      return nth(sql.all("SELECT created_at AS t FROM pantry_takes WHERE player_uuid=? AND state='delivered' AND created_at>? AND created_at<=?", player, after, limit).map((r) => r.t), step.count);
    case 'meet_residents': {
      const rows = sql.all("SELECT resident_id, MIN(occurred_at) AS t FROM link_events WHERE kind='resident.met' AND player_uuid=? AND resident_id<>? AND occurred_at>? AND occurred_at<=? GROUP BY resident_id", player, mentorId, after, limit);
      return nth(rows.map((r) => r.t), step.count);
    }
    case 'shadow_stage': {
      const crew = VILLAGERS.filter((v) => v.role === step.role).map((v) => v.id);
      const met = sql.all(`SELECT occurred_at AS t FROM link_events WHERE kind='resident.met' AND player_uuid=? AND occurred_at>? AND occurred_at<=? AND resident_id IN (${crew.map(() => '?').join(',')}) ORDER BY occurred_at ASC LIMIT 200`, player, after, limit, ...crew);
      const marks = sql.all("SELECT at FROM village_marks WHERE kind='stage' AND at>? AND at<=? ORDER BY at ASC", after, limit).map((m) => m.at);
      for (const m of met) {
        const hit = marks.find((at) => at >= m.t && at <= m.t + step.within_minutes * 60_000);
        if (hit !== undefined) return hit;
      }
      return null;
    }
    case 'thanked': {
      try { return sql.get('SELECT MIN(at) AS t FROM gratitude_thanks WHERE thanker=? AND kind=? AND at>? AND at<=?', player, step.thanks, after, limit)?.t ?? null; } catch { return null; }
    }
    case 'survey': {
      const done = completedSurveys(link, player, now).map((d) => d.at).filter((at) => at > after).sort((a, b) => a - b);
      return done[0] ?? null;
    }
    default: return null;
  }
}

/** One role's chain for one person: { role, title, mentor, steps: [{ id, text, state, at }], done, total, started, complete }. */
export function chainFor(link, role, player, now = link.clock(), roles = loadApprenticeship()) {
  player = typeof player === 'string' ? player : '';
  const def = roles[role];
  const mentorName = def.mentor.name;
  let since = null;
  let blocked = false;
  const steps = def.steps.map((step) => {
    const base = { id: step.id, text: step.text.replace('{mentor}', mentorName) };
    if (blocked) return { ...base, state: 'locked', at: null };
    const at = evaluate(link, def, step, player, since, now, def.mentor.id);
    if (at === null) { blocked = true; return { ...base, state: 'current', at: null }; }
    since = Number(at);
    return { ...base, state: 'done', at: since };
  });
  const done = steps.filter((s) => s.state === 'done').length;
  return { role, title: def.title, mentor: def.mentor, steps, done, total: steps.length, started: done > 0, complete: done === steps.length };
}

/** Every role's chain for one person, in file order. */
export function apprenticeshipFor(link, player, now = link.clock()) {
  try { observe(link, now); } catch { /* the stage marks below are still true */ }
  const roles = loadApprenticeship();
  return Object.keys(roles).map((role) => chainFor(link, role, player, now, roles));
}

/** Aggregate for the dashboard: how many people have begun and finished each chain. No names, no ids. */
export function apprenticeshipCensus(link, now = link.clock()) {
  try { observe(link, now); } catch { /* ignore */ }
  const roles = loadApprenticeship();
  return Object.keys(roles).map((role) => {
    const def = roles[role];
    const players = link.sql.all("SELECT DISTINCT player_uuid FROM link_events WHERE kind='resident.met' AND resident_id=? LIMIT 200", def.mentor.id).map((r) => r.player_uuid);
    let completed = 0;
    for (const p of players) if (chainFor(link, role, p, now, roles).complete) completed += 1;
    return { role, title: def.title, mentor: def.mentor.name, steps: def.steps.length, started: players.length, completed };
  });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function apprenticeLines(link, player, now = link.clock()) {
  const chains = apprenticeshipFor(link, player, now);
  const active = chains.filter((c) => c.started && !c.complete);
  const finished = chains.filter((c) => c.complete);
  const out = [];
  if (!active.length && !finished.length) {
    out.push('Apprenticeship: any villager of Harr can teach you their craft. Meet a mentor to begin, then follow their short chain of steps.');
    out.push(`Mentors: ${chains.map((c) => `${c.mentor.name} (${c.role})`).join(', ')}.`);
  }
  for (const c of active) {
    const now_ = c.steps.find((s) => s.state === 'current');
    out.push(`${c.title} with ${c.mentor.name}: ${c.done} of ${plural(c.total, 'step')}. Now: ${now_.text}`);
  }
  for (const c of finished) out.push(`${c.title}: finished with ${c.mentor.name}. The title is yours; it is recognition, nothing more.`);
  if (active.length || finished.length) {
    const open = chains.filter((c) => !c.started);
    if (open.length) out.push(`Other mentors waiting: ${open.map((c) => `${c.mentor.name} (${c.role})`).join(', ')}.`);
  }
  out.push('Each step counts only what happened after the step before it, and comes from recorded facts. It gives recognition, never coins or items.');
  return out;
}

/** The one line for the tasks page: the chain in progress, or an invitation. */
export function apprenticeTaskLine(link, player, now = link.clock()) {
  const chains = apprenticeshipFor(link, player, now);
  const best = chains.filter((c) => c.started && !c.complete).sort((a, b) => b.done / b.total - a.done / a.total)[0];
  if (best) return `Apprenticeship: ${best.title}, ${best.done} of ${best.total} steps. Now: ${best.steps.find((s) => s.state === 'current').text}`;
  const finished = chains.filter((c) => c.complete);
  if (finished.length) return `Apprenticeship: ${finished.map((c) => c.title.toLowerCase()).join(', ')} complete. Another mentor is waiting whenever you like (whisper apprentice).`;
  return 'Apprenticeship: meet a mentor to learn a craft (whisper apprentice to see who).';
}

/** What a mentor says when asked to teach; null for anyone who is not a mentor. */
export function mentorReply(link, resident) {
  const roles = loadApprenticeship();
  const chain = Object.values(roles).find((r) => r.mentor.id === resident?.id);
  if (!chain) return null;
  return `I am the mentor for ${chain.title.toLowerCase()}s in Harr. ${chain.steps.length} small steps, starting with saying hello to me. Whisper apprentice to Selene to see where you are.`;
}
