import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVING_ROSTER } from '../living-world.js';

// The village: scripted residents who give Harr a working population. They have a calling, a daily routine over the
// Harr places, and a few lines. They use no model, make no decisions for anyone and hold no authority.
// Loaded from content/veloren-villagers.json and validated hard, because ids and names become credentials and
// Veloren character names.

export const CALLINGS = Object.freeze(['cultivator', 'builder', 'explorer', 'researcher', 'artisan', 'host', 'mediator', 'steward']);
export const PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night']);
const ID = /^lw-[a-z]{2,20}$/;
const FIRST = /^[A-Z][a-z]{2,11}$/;
const clean = (text, max) => typeof text === 'string' && text.length >= 1 && text.length <= max && !/[\u0000-\u001f\u007f<>]/.test(text);

export function validateVillagers(doc, taken = LIVING_ROSTER) {
  if (!doc || doc.format !== 'veloren-villagers-v1' || !Array.isArray(doc.residents)) throw new Error('Not a veloren-villagers-v1 file.');
  const ids = new Set(taken.map((r) => r.id));
  const firsts = new Set(taken.map((r) => r.name.split(' ')[0].toLowerCase()));
  for (const r of doc.residents) {
    const where = r?.id || '(no id)';
    if (!ID.test(r.id || '') || ids.has(r.id)) throw new Error(`${where}: id is invalid or already used.`);
    const first = String(r.name || '').split(' ')[0];
    if (!FIRST.test(first) || firsts.has(first.toLowerCase()) || !clean(r.name, 40)) throw new Error(`${where}: name is invalid or its first name is already used.`);
    if (!CALLINGS.includes(r.calling)) throw new Error(`${where}: unknown calling.`);
    if (!clean(r.capabilities, 240) || !clean(r.limitations, 240)) throw new Error(`${where}: capabilities and limitations must be short single-line text.`);
    for (const phase of PHASES) if (!clean(r.destinations?.[phase]?.label, 40)) throw new Error(`${where}: no destination for ${phase}.`);
    if (!Array.isArray(r.barks) || r.barks.length < 1 || r.barks.length > 8 || r.barks.some((b) => !clean(b, 160))) throw new Error(`${where}: barks must be 1-8 short lines.`);
    ids.add(r.id); firsts.add(first.toLowerCase());
  }
  return doc.residents;
}

export function loadVillagers(path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'veloren-villagers.json')) {
  if (!existsSync(path)) return [];
  return Object.freeze(validateVillagers(JSON.parse(readFileSync(path, 'utf8'))).map((r) => Object.freeze(r)));
}

export const VILLAGERS = loadVillagers();
