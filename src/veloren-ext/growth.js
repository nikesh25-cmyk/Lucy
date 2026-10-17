// Village census and growth: Harr's "village level", computed from recorded facts.
//
//   * The level is DERIVED, never awarded or stored: the highest level whose every requirement is met, checked in
//     order (so a lower level can never be skipped). Requirements are in content/harr-growth.json.
//   * Facts: finished projects (the game server's record, via the chronicle marks), technologies learned (the
//     research queue), kinds of villagers established (the roster), people welcomed (distinct players in signed events).
//   * It only DESCRIBES the village. It unlocks nothing and gives nothing to anyone, so nobody has a reason to
//     chase it except to see Harr grow.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherFacts, loadResearch, loadRoles, researchStatus } from './research.js';
import { VILLAGERS } from './villagers.js';

const here = dirname(fileURLToPath(import.meta.url));
export const GROWTH_PATH = join(here, '..', '..', 'content', 'harr-growth.json');
export const NEEDS = Object.freeze(['projects', 'techs', 'roles', 'people']);
const text = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f<>[\]{}]/.test(v);

export function validateGrowth(doc) {
  if (doc?.format !== 'harr-growth-v1' || !Number.isInteger(doc.min_per_role) || doc.min_per_role < 1 || doc.min_per_role > 10 || !Array.isArray(doc.levels) || doc.levels.length < 2 || doc.levels.length > 12) throw new Error('Bad growth file.');
  let previous = null;
  doc.levels.forEach((l, i) => {
    if (l.level !== i + 1 || !text(l.name, 40) || !text(l.text, 160)) throw new Error(`Level ${i + 1}: bad number, name or text`);
    for (const k of NEEDS) {
      const v = l.needs?.[k];
      if (!Number.isInteger(v) || v < 0 || v > 1000) throw new Error(`Level ${l.level}: bad ${k}`);
      if (previous && v < previous.needs[k]) throw new Error(`Level ${l.level}: ${k} may not fall below the level before`);
    }
    if (i === 0 && NEEDS.some((k) => l.needs[k] !== 0)) throw new Error('Level 1 needs nothing.');
    previous = l;
  });
  return doc;
}

let cached = null;
export function loadGrowth(path = GROWTH_PATH) {
  if (path === GROWTH_PATH && cached) return cached;
  const doc = Object.freeze(validateGrowth(JSON.parse(readFileSync(path, 'utf8'))));
  if (path === GROWTH_PATH) cached = doc;
  return doc;
}

/** The facts the level is computed from. Reads stored data only. */
export function censusFacts(link, doc = loadGrowth()) {
  const facts = gatherFacts(link);
  const status = researchStatus(facts, loadResearch());
  const counts = new Map();
  for (const v of VILLAGERS) counts.set(v.role, (counts.get(v.role) || 0) + 1);
  const roles = Object.keys(loadRoles()).filter((r) => (counts.get(r) || 0) >= doc.min_per_role).length;
  const people = Number(link.sql.get("SELECT COUNT(DISTINCT player_uuid) AS n FROM link_events WHERE kind IN ('resident.met','landmark.visited','landmark.together')")?.n ?? 0);
  return { projects: facts.projectsDone.size, techs: status.unlocked.length, roles, people, residents: VILLAGERS.length };
}

/** The level for a set of facts. Pure. */
export function levelFor(facts, doc = loadGrowth()) {
  let current = doc.levels[0];
  for (const l of doc.levels) {
    if (NEEDS.every((k) => facts[k] >= l.needs[k])) current = l; else break;
  }
  const next = doc.levels[current.level] || null;
  const missing = next ? NEEDS.filter((k) => facts[k] < next.needs[k]).map((k) => ({ what: k, have: facts[k], need: next.needs[k] })) : [];
  return { level: current.level, of: doc.levels.length, name: current.name, text: current.text, next: next ? { level: next.level, name: next.name, missing } : null, facts };
}

export const villageLevel = (link) => levelFor(censusFacts(link));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const HAVE = { projects: (n) => plural(n, 'project', 'projects'), techs: (n) => plural(n, 'technology', 'technologies'), roles: (n) => plural(n, 'established craft', 'established crafts'), people: (n) => plural(n, 'person welcomed', 'people welcomed') };
const MORE = { projects: (n) => `${plural(n, 'more finished project', 'more finished projects')}`, techs: (n) => `${plural(n, 'more technology learned', 'more technologies learned')}`, roles: (n) => `${plural(n, 'more established craft', 'more established crafts')}`, people: (n) => `${plural(n, 'more person welcomed', 'more people welcomed')}` };

export function levelLines(link) {
  const v = villageLevel(link);
  const f = v.facts;
  const out = [`Harr is a ${v.name.toLowerCase()}, level ${v.level} of ${v.of}. ${v.text}`];
  out.push(`The census: ${plural(f.projects, 'project', 'projects')} finished, ${plural(f.techs, 'technology', 'technologies')} learned, ${f.residents} villagers in ${plural(f.roles, 'established craft', 'established crafts')}, ${HAVE.people(f.people)}.`);
  if (v.next) out.push(`To become a ${v.next.name.toLowerCase()}, Harr needs ${v.next.missing.map((m) => MORE[m.what](m.need - m.have)).join(', ')}.`);
  else out.push('Every level is reached. Harr is ready to write its next chapter.');
  out.push('The level is worked out from recorded facts. It describes Harr; it gives nothing to anyone.');
  return out;
}

/** One short chronicle line: "Village level: ...". */
export function levelChronicleLine(link) {
  const v = villageLevel(link);
  return `Village level: Harr is a ${v.name.toLowerCase()} (level ${v.level} of ${v.of}).`;
}

/** Add the level to the chronicle's lines (before its closing note). Pure apart from reads; never throws. */
export function withLevel(lines, link) {
  try {
    const out = [...lines];
    out.splice(Math.max(1, out.length - 1), 0, levelChronicleLine(link));
    return out;
  } catch { return lines; }
}
