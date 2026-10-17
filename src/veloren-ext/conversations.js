// "Ask me about" depth for the six village roles (content/harr-conversations.json).
//
// Each role has eight scripted answers. A villager tries them only AFTER the role's own work-topics (npc-logic.js)
// found nothing to say, so these never change an existing answer. Templates may use only four placeholders, and each
// is filled from recorded facts: {project} and {stage} from the works board, {insight} from the research status and
// {pantry} from the pantry shelves. A failed fact falls back to plain words; a villager never fails to answer.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherFacts, loadRoles, researchStatus } from './research.js';
import { loadRecord, loadWorks, worksStatus } from './world-life.js';
import { shelfSummary } from './pantry.js';

const here = dirname(fileURLToPath(import.meta.url));
export const CONVERSATIONS_PATH = join(here, '..', '..', 'content', 'harr-conversations.json');
export const ROLE_IDS = Object.freeze(['builder', 'courier', 'farmer', 'keeper', 'maker', 'scholar']);
export const PLACEHOLDERS = Object.freeze(['project', 'stage', 'insight', 'pantry']);
const SLUG = /^[a-z][a-z0-9-]{1,30}$/;
// What replyFor in npc-logic.js already answers; no keyword here may contain one of these.
const GENERIC = ['what are you doing', 'your work', 'what do you do', 'your job', 'purpose', 'why harr', 'why are we', 'charter', 'what is harr', 'greater'];

export function placeholdersIn(template) {
  const found = [];
  for (const m of String(template).matchAll(/\{([^{}]*)\}/g)) found.push(m[1]);
  return found;
}

export function validateConversations(doc, roleTopics = loadRoles()) {
  if (!doc || doc.format !== 'harr-conversations-v1' || !doc.roles) throw new Error('Bad conversations file.');
  if (JSON.stringify(Object.keys(doc.roles).sort()) !== JSON.stringify([...ROLE_IDS])) throw new Error('Needs exactly the six roles.');
  for (const role of ROLE_IDS) {
    const entries = doc.roles[role];
    if (!Array.isArray(entries) || entries.length !== 8) throw new Error(`${role}: needs 8 answers`);
    const ids = new Set();
    const words = new Set();
    const blocked = [...GENERIC, ...(roleTopics[role]?.topics || [])];
    for (const e of entries) {
      if (!SLUG.test(e.id || '') || ids.has(e.id)) throw new Error(`${role}: bad or repeated id ${e.id}`);
      ids.add(e.id);
      if (!Array.isArray(e.keywords) || e.keywords.length < 2 || e.keywords.length > 4) throw new Error(`${role}/${e.id}: 2-4 keywords`);
      for (const k of e.keywords) {
        if (typeof k !== 'string' || !/^[a-z][a-z ]{2,22}[a-z]$/.test(k)) throw new Error(`${role}/${e.id}: keyword "${k}" must be 4-24 lower-case letters`);
        if (words.has(k)) throw new Error(`${role}/${e.id}: keyword "${k}" is used twice in ${role}`);
        words.add(k);
        const clash = blocked.find((b) => k.includes(b));
        if (clash) throw new Error(`${role}/${e.id}: keyword "${k}" would be caught first by "${clash}"`);
      }
      if (typeof e.answer !== 'string' || e.answer.length < 40 || e.answer.length > 200) throw new Error(`${role}/${e.id}: answer must be 40-200 characters`);
      for (const p of placeholdersIn(e.answer)) if (!PLACEHOLDERS.includes(p)) throw new Error(`${role}/${e.id}: placeholder {${p}} is not available`);
      if (/[{}]/.test(e.answer.replace(/\{(project|stage|insight|pantry)\}/g, ''))) throw new Error(`${role}/${e.id}: stray brace`);
    }
  }
  return doc;
}

let cached = null;
export function loadConversations(path = CONVERSATIONS_PATH) {
  if (path === CONVERSATIONS_PATH && cached) return cached;
  const doc = Object.freeze(validateConversations(JSON.parse(readFileSync(path, 'utf8'))));
  if (path === CONVERSATIONS_PATH) cached = doc;
  return doc;
}

/** The first answer of this role whose keyword appears in the (lower-case) question, or null. Pure. */
export function matchAnswer(role, lower, doc = loadConversations()) {
  const text = String(lower || '');
  return doc.roles[role]?.find((e) => e.keywords.some((k) => text.includes(k))) ?? null;
}

export function fillTemplate(template, values) {
  return String(template).replace(/\{(project|stage|insight|pantry)\}/g, (_, key) => String(values[key] ?? ''));
}

const lead = (text) => text.replace(/^The /, 'the ');

/** The four placeholder values, each from recorded facts, each with a plain fallback. Only reads what the template needs. */
export function valuesFor(link, template) {
  const need = new Set(placeholdersIn(template));
  const values = { project: 'the next public work', stage: 'the next stage', insight: 'some', pantry: 'plenty of plain food' };
  if (need.has('project') || need.has('stage')) {
    try {
      const status = worksStatus(loadWorks(), loadRecord(process.env.NEMO_WORLD_RECORD), link.clock());
      const active = status.find((p) => !p.complete && p.done > 0) || status.find((p) => !p.complete);
      if (active) {
        values.project = lead(active.name);
        if (active.next?.title) values.stage = lead(active.next.title.charAt(0).toLowerCase() + active.next.title.slice(1));
      }
    } catch { /* keep the plain words */ }
  }
  if (need.has('insight')) { try { values.insight = String(researchStatus(gatherFacts(link)).insight); } catch { /* keep */ } }
  if (need.has('pantry')) { try { values.pantry = shelfSummary(link); } catch { /* keep */ } }
  return values;
}

/** A filled answer for this villager's role and question, or null when no keyword matches. */
export function conversationReply(link, resident, lower) {
  const role = resident?.role || null;
  if (!role) return null;
  const entry = matchAnswer(role, lower);
  return entry ? fillTemplate(entry.answer, valuesFor(link, entry.answer)) : null;
}
