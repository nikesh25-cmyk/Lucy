// Harr's greater purpose, its goals and its research queue, all derived from recorded facts.
//
//   * The CHARTER (content/harr-charter.json) states why the village exists and lists measurable goals.
//   * INSIGHT is earned from facts only: places found (signed events), building stages and finished projects
//     (the game server's record), village events held (director calls). Nothing is invented and nothing is spent.
//   * RESEARCH (content/harr-research.json) is a queue: as insight accumulates the village learns the next
//     technology. Effects are small, scripted and listed; today they affect only the pantry's restocking.
// Nothing here gives coins, items, power or anything that could be competed for.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe } from './village.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, '..', '..', 'content');
export const CHARTER_PATH = join(CONTENT, 'harr-charter.json');
export const RESEARCH_PATH = join(CONTENT, 'harr-research.json');
export const ROLES_PATH = join(CONTENT, 'harr-roles.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;

export function validateResearch(doc) {
  if (doc?.format !== 'harr-research-v1' || !Array.isArray(doc.techs) || !doc.techs.length || doc.techs.length > 40) throw new Error('Bad research file.');
  const seen = new Set();
  for (const t of doc.techs) {
    if (!SLUG.test(t.id || '') || seen.has(t.id)) throw new Error(`Bad or repeated tech ${t.id}`);
    if (!Number.isInteger(t.cost) || t.cost < 1 || t.cost > 10_000) throw new Error(`${t.id}: cost`);
    for (const n of t.needs || []) if (!seen.has(n)) throw new Error(`${t.id}: needs ${n}, which must come earlier`);
    if (typeof t.name !== 'string' || t.name.length > 40 || typeof t.text !== 'string' || t.text.length > 200) throw new Error(`${t.id}: text too long`);
    for (const [k, v] of Object.entries(t.effects || {})) {
      const max = { pantry_rate: 4, pantry_cap: 100, insight_per_find: 10 }[k];
      if (max === undefined || !Number.isFinite(v) || v < 0 || v > max) throw new Error(`${t.id}: unknown or unsafe effect ${k}`);
    }
    seen.add(t.id);
  }
  // The weights that turn facts into insight are bounded too: an insight block is data, and data must not be
  // able to promise an unbounded amount of progress.
  for (const [k, v] of Object.entries(doc.insight || {})) {
    const max = { per_find: 20, per_stage: 10, per_project: 20, per_event: 10, per_help: 10 }[k];
    if (max === undefined || !Number.isInteger(v) || v < 0 || v > max) throw new Error(`insight.${k} is unknown or out of bounds`);
  }
  return doc;
}
export const loadResearch = () => validateResearch(readJson(RESEARCH_PATH));
export const loadCharter = () => {
  const doc = readJson(CHARTER_PATH);
  if (doc.format !== 'harr-charter-v1' || !Array.isArray(doc.principles) || !Array.isArray(doc.goals)) throw new Error('Bad charter.');
  return doc;
};
export const loadRoles = () => readJson(ROLES_PATH).roles;

/** The recorded facts the village's progress is made of. Reads stored data only. */
export function gatherFacts(link) {
  try { observe(link); } catch { /* the facts below are still true */ }
  const sql = link.sql;
  const n = (query, ...args) => Number(sql.get(query, ...args)?.n ?? 0);
  const done = new Set(sql.all("SELECT key FROM village_marks WHERE kind='done'").map((r) => r.key.slice(5)));
  return {
    finds: n("SELECT COUNT(*) AS n FROM (SELECT 1 FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%' GROUP BY player_uuid, landmark_id)"),
    places: n("SELECT COUNT(DISTINCT landmark_id) AS n FROM link_events WHERE kind='landmark.visited' AND landmark_id LIKE 'disc-%'"),
    // Visitors who stood with a building crew, one per person per work site: helping again at the same
    // place is the same act of participation (the signed fact names the site, not the stage).
    helps: n("SELECT COUNT(*) AS n FROM (SELECT 1 FROM link_events WHERE kind='project.helped' GROUP BY player_uuid, landmark_id)"),
    stages: n("SELECT COUNT(*) AS n FROM village_marks WHERE kind='stage'"),
    projectsDone: done,
    events: n('SELECT COUNT(*) AS n FROM (SELECT 1 FROM village_attendance GROUP BY event_id, slot_start HAVING COUNT(*)>=2)'),
    meals: n("SELECT COALESCE(SUM(qty),0) AS n FROM pantry_takes WHERE state='delivered'"),
  };
}

const sumEffect = (techs, key, base = 0) => techs.reduce((acc, t) => acc + (t.effects?.[key] ?? 0), base);
const mulEffect = (techs, key) => techs.reduce((acc, t) => acc * (t.effects?.[key] ?? 1), 1);

export function insightOf(facts, research, unlocked = []) {
  const i = research.insight;
  const perFind = i.per_find + sumEffect(unlocked, 'insight_per_find');
  return facts.finds * perFind + facts.stages * i.per_stage + facts.projectsDone.size * i.per_project
    + (facts.helps ?? 0) * (i.per_help ?? 0) + facts.events * i.per_event;
}

/** The queue as it stands: what is learned, what is being learned and how far along. Pure. */
export function researchStatus(facts, research = loadResearch()) {
  let unlocked = [];
  let insight = 0;
  for (let round = 0; round < 12; round += 1) { // learning something can raise insight, which can teach more
    insight = insightOf(facts, research, unlocked);
    const next = [];
    let spent = 0;
    for (const t of research.techs) {
      if (insight >= spent + t.cost && (t.needs || []).every((id) => next.some((u) => u.id === id))) { next.push(t); spent += t.cost; } else break;
    }
    if (next.length === unlocked.length) break;
    unlocked = next;
  }
  const spent = unlocked.reduce((s, t) => s + t.cost, 0);
  const current = research.techs[unlocked.length] || null;
  return {
    insight, spent, unlocked, current,
    progress: current ? Math.max(0, Math.min(current.cost, insight - spent)) : 0,
    queue: research.techs.slice(unlocked.length + 1).map((t) => t.id),
    effects: { pantry_rate: mulEffect(unlocked, 'pantry_rate'), pantry_cap: sumEffect(unlocked, 'pantry_cap') },
  };
}

export function goalStatus(facts, status, charter = loadCharter()) {
  return charter.goals.map((g) => {
    let progress = 0; let target = g.target || 1;
    if (g.measure === 'project_done') progress = facts.projectsDone.has(g.project) ? 1 : 0;
    else if (g.measure === 'projects_done_of') { target = g.of.length; progress = g.of.filter((id) => facts.projectsDone.has(id)).length; }
    else if (g.measure === 'places_found') progress = Math.min(target, facts.places);
    else if (g.measure === 'meals') progress = Math.min(target, facts.meals);
    else if (g.measure === 'events_held') progress = Math.min(target, facts.events);
    else if (g.measure === 'techs') progress = Math.min(target, status.unlocked.length);
    return { id: g.id, title: g.title, why: g.why, progress, target, done: progress >= target };
  });
}

/** Effects other parts of the village use (the pantry). Cheap enough to ask on every call. */
export function effectsOf(link) {
  try { return researchStatus(gatherFacts(link)).effects; } catch { return { pantry_rate: 1, pantry_cap: 0 }; }
}

export function purposeLines(link, clean = (s) => s) {
  const charter = loadCharter();
  const facts = gatherFacts(link);
  const status = researchStatus(facts);
  const goals = goalStatus(facts, status, charter);
  const out = [charter.purpose];
  out.push(`We value ${charter.principles.map((p) => p.name.toLowerCase()).join(', ')}.`);
  for (const g of goals) out.push(`${g.done ? 'Done' : 'Goal'}: ${g.title}, ${g.progress} of ${g.target}.`);
  out.push('Whisper research to see what we are learning, or open the Harr dashboard in your browser (NemoWorld, port 3100, page /harr) for everything at once.');
  return out.map(clean);
}

export function researchLines(link) {
  const facts = gatherFacts(link);
  const s = researchStatus(facts);
  const out = [`Harr research: ${s.insight} insight earned from ${facts.finds} finds, ${facts.stages} building stages, ${facts.projectsDone.size} finished projects, ${facts.helps} people who lent a hand at a work site and ${facts.events} village events.`];
  if (s.unlocked.length) out.push(`Learned (${s.unlocked.length}): ${s.unlocked.map((t) => t.name).join(', ')}.`);
  if (s.current) out.push(`Now learning: ${s.current.name}, ${s.progress} of ${s.current.cost} insight. ${s.current.text}`);
  else out.push('Every technology in the queue has been learned. The village is ready to write the next chapter.');
  if (s.queue.length) out.push(`Next in the queue: ${research_names(s.queue)}.`);
  out.push('You add insight by finding places (library), by standing with a building crew (works) and by joining village events (today). It is never spent or competed for.');
  return out;
}
const research_names = (ids) => { const byId = new Map(loadResearch().techs.map((t) => [t.id, t.name])); return ids.slice(0, 3).map((id) => byId.get(id) || id).join(', '); };
