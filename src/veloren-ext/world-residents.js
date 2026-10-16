import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVING_ROSTER } from '../living-world.js';
import { loadLandmarks } from '../veloren-link.js';
import { PLACES } from './world-manifest.js';

// NemoWorld's side of the eight residents' world: which real Veloren structure each of them walks to
// at each of the four schedule phases, and which credentials may carry what.
//
// The split is the same as the manifest's, and deliberate:
//   * THIS module knows NemoWorld: the roster (`src/living-world.js`), the places NemoWorld may
//     dress (`content/veloren-world-places.json`) and the ids the Quiet Survey already names
//     (`content/veloren-landmarks.json`). It is the authority on "is this a place we asked for, in
//     the residents' own words?".
//   * The Veloren server knows the world: `server/src/sys/nemo_link.rs` turns a `site` + `plot` +
//     `nth` into a position from world generation and logs every landmark it resolved. Nothing here
//     invents a coordinate, and nothing here is copied from the game's vocabulary.
//
// Three facts decide the shape of the data, and all three come from the game rather than from taste:
//   1. The bridge picks a landmark by its **label** alone (`nemo-bridge/src/main.rs`,
//      `landmarks.iter().find(|l| l.label == label)`), so one label is one place for every resident on
//      that server, and a label with no landmark is marked unmapped rather than guessed.
//   2. The server matches a resident to a character by **alias** (`Config::residents`), and the bridge
//      creates a character named the first word of the resident's name, so the link config's
//      `residents` map needs one entry per resident (`linkConfigResidents`).
//   3. A landmark is positional only after the game resolves it, so this module can check *what* was
//      asked for (a real plot of a real Harr, in the roster's own words) but never *where* it is.
//      The server logs every resolved landmark at startup (`nemo_link.rs:233`).

const here = dirname(fileURLToPath(import.meta.url));
export const LANDMARKS_PATH = join(here, '..', '..', 'content', 'veloren-world-landmarks.json');
/** The link's landmark roles: the ids the Quiet Survey names, which this file must not change. */
export const ROLES_PATH = join(here, '..', '..', 'content', 'veloren-landmarks.json');
export const ROLES = loadLandmarks(ROLES_PATH);

export const FORMAT = 'veloren-world-landmarks-v1';
/** The four schedule phases, in the roster's own order and spelling. */
export const PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night']);
/** Exactly the keys the Veloren server's link config reads for one landmark (`LandmarkSpec`). */
export const CONFIG_KEYS = Object.freeze(['id', 'label', 'name', 'site', 'plot', 'nth', 'radius']);
export const LIMITS = Object.freeze({
  max_nth: 7,
  min_radius: 1,
  max_radius: 24,
  max_label: 64,
  max_name: 80,
  max_explanation: 400,
});

/** What one resident's bridge credential may carry: enough to talk and to be told where to go. */
export const BRIDGE_SCOPES = Object.freeze(['talk', 'director']);
/** What a relay credential may carry: facts in, nothing else. One credential per resident. */
export const RELAY_SCOPES = Object.freeze(['events']);
/**
 * A scope whose name promises authority NemoWorld keeps for a signed-in human. No link credential may
 * ever carry one: purchases, confirmations, minting and account changes are human actions.
 */
export const FORBIDDEN_SCOPE_WORDS = Object.freeze(['karma', 'coin', 'mint', 'purchase', 'confirm', 'admin', 'operator', 'owner', 'vault', 'human', 'grant']);

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const configEntry = (landmark) => Object.fromEntries(CONFIG_KEYS.map((key) => [key, landmark[key]]));

/** The character a resident logs in as: the first word of her name, as the bridge creates it. */
export const characterName = (resident) => String(resident.name).split(/\s+/)[0];

/**
 * Check the residents' world against NemoWorld's own rules and the roster. Returns a list of
 * problems; an empty list means the file is one NemoWorld is willing to hand to the game.
 */
export function validateWorldLandmarks(data, { places = PLACES, roster = LIVING_ROSTER, roles = ROLES } = {}) {
  const errors = [];
  const bad = (why) => errors.push(why);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['a landmark manifest must be an object'];
  if (data.format !== FORMAT) bad(`format must be ${FORMAT}`);
  if (data.note !== undefined && typeof data.note !== 'string') bad('note must be text');
  const site = data.site;
  if (!isText(site, 60)) bad('site must be a name');
  else if (!places.sites.has(site)) bad(`site ${site} is not one NemoWorld may dress`);

  const landmarks = Array.isArray(data.landmarks) ? data.landmarks : [];
  if (!Array.isArray(data.landmarks) || !landmarks.length) bad('landmarks must be a non-empty list');
  const byId = new Map();
  const byLabel = new Map();
  const allowed = new Set([...CONFIG_KEYS, 'note', 'shared_with']);
  for (const [index, landmark] of landmarks.entries()) {
    const where = `landmark ${landmark?.id ?? index}`;
    if (!landmark || typeof landmark !== 'object' || Array.isArray(landmark)) { bad(`${where}: must be an object`); continue; }
    for (const key of Object.keys(landmark)) if (!allowed.has(key)) bad(`${where}: ${key} is not a landmark field`);
    if (typeof landmark.id !== 'string' || !SLUG.test(landmark.id)) bad(`${where}: id must be a short lower-case slug`);
    else if (byId.has(landmark.id)) bad(`${where}: id is used twice`);
    if (!isText(landmark.label, LIMITS.max_label)) bad(`${where}: label is required`);
    else if (byLabel.has(landmark.label)) bad(`${where}: label ${landmark.label} is already carried by ${byLabel.get(landmark.label)}; the bridge looks a landmark up by label, so one label is one place`);
    if (!isText(landmark.name, LIMITS.max_name)) bad(`${where}: name is required`);
    if (landmark.site !== site) bad(`${where}: site must be ${site}`);
    else if (!places.sites.get(site)?.includes(landmark.plot)) bad(`${where}: plot ${landmark.plot} is not one of ${site}'s known plots`);
    if (!inRange(landmark.nth, 0, LIMITS.max_nth)) bad(`${where}: nth must be 0 to ${LIMITS.max_nth}`);
    if (typeof landmark.radius !== 'number' || !(landmark.radius >= LIMITS.min_radius && landmark.radius <= LIMITS.max_radius))
      bad(`${where}: radius must be ${LIMITS.min_radius} to ${LIMITS.max_radius}`);
    if (landmark.note !== undefined && typeof landmark.note !== 'string') bad(`${where}: note must be text`);
    if (landmark.shared_with !== undefined) {
      const twin = landmarks.find((other) => other?.id === landmark.shared_with);
      if (!isText(landmark.shared_with, 40) || landmark.shared_with === landmark.id) bad(`${where}: shared_with must name another landmark`);
      else if (!twin) bad(`${where}: shared_with names ${landmark.shared_with}, which is not in this file`);
      else if (twin.site !== landmark.site || twin.plot !== landmark.plot || twin.nth !== landmark.nth)
        bad(`${where}: shared_with ${landmark.shared_with} is a different structure (${twin.plot} ${twin.nth})`);
    }
    if (typeof landmark.id === 'string' && SLUG.test(landmark.id) && !byId.has(landmark.id)) {
      byId.set(landmark.id, landmark);
      if (isText(landmark.label, LIMITS.max_label) && !byLabel.has(landmark.label)) byLabel.set(landmark.label, landmark.id);
    }
  }

  // Two entries may name the same structure - NemoWorld has two names for the one square Harr has -
  // but only when one of them says so. An undeclared duplicate would be an accident, and then which
  // of the two a resident stands in would depend only on the order of this file.
  for (const a of landmarks) {
    for (const b of landmarks) {
      if (a === b || !a?.id || !b?.id) continue;
      if (a.site !== b.site || a.plot !== b.plot || a.nth !== b.nth) continue;
      if (a.shared_with === b.id || b.shared_with === a.id) continue;
      bad(`landmarks ${a.id} and ${b.id} name the same structure (${b.plot} ${b.nth}) without shared_with`);
    }
  }

  // The ids the Quiet Survey already names must survive, with the same place and name behind them.
  for (const role of roles) {
    const landmark = byId.get(role.id);
    if (!landmark) bad(`the link's landmark ${role.id} (${role.role}) is missing from this file`);
    else if (landmark.name !== role.name) bad(`the link's landmark ${role.id} is named ${role.name}, not ${landmark.name}`);
  }

  const residents = data.residents;
  if (!residents || typeof residents !== 'object' || Array.isArray(residents)) bad('residents must be an object');
  else {
    const wanted = new Set(roster.map((resident) => resident.id));
    for (const id of Object.keys(residents)) if (!wanted.has(id)) bad(`resident ${id} is not one of NemoWorld's living roster`);
    for (const resident of roster) {
      const slots = residents[resident.id];
      if (!slots || typeof slots !== 'object' || Array.isArray(slots)) { bad(`resident ${resident.id} has no schedule`); continue; }
      for (const phase of Object.keys(slots)) if (!PHASES.includes(phase)) bad(`resident ${resident.id} has a phase ${phase}, which no schedule has`);
      for (const phase of PHASES) {
        const where = `${resident.id} ${phase}`;
        const slot = slots[phase];
        if (!slot || typeof slot !== 'object' || Array.isArray(slot)) { bad(`${where}: no destination`); continue; }
        const wanted_label = resident.destinations[phase]?.label;
        if (slot.label !== wanted_label) bad(`${where}: the roster says ${JSON.stringify(wanted_label)}, the file says ${JSON.stringify(slot.label)}`);
        if (slot.unmapped === true) {
          if (slot.landmark !== undefined) bad(`${where}: unmapped, so it may not name a landmark`);
          if (!isText(slot.reason, LIMITS.max_explanation)) bad(`${where}: an unmapped label needs a reason`);
          if (!isText(slot.needed, LIMITS.max_explanation)) bad(`${where}: an unmapped label needs to say what would be needed`);
        } else if (slot.unmapped !== undefined) bad(`${where}: unmapped must be true or absent`);
        else if (!isText(slot.landmark, 40)) bad(`${where}: needs a landmark or an explicit unmapped marker`);
        else if (!byId.has(slot.landmark)) bad(`${where}: landmark ${slot.landmark} is not in this file`);
        else if (byId.get(slot.landmark).label !== slot.label)
          bad(`${where}: landmark ${slot.landmark} is labelled ${byId.get(slot.landmark).label}, so the bridge would never find it for ${slot.label}`);
        const extra = Object.keys(slot).filter((key) => !['label', 'landmark', 'unmapped', 'reason', 'needed'].includes(key));
        if (extra.length) bad(`${where}: ${extra.join(', ')} is not part of a destination`);
      }
    }
    const used = new Set();
    for (const slots of Object.values(residents)) for (const slot of Object.values(slots || {})) if (slot?.landmark) used.add(slot.landmark);
    for (const id of byId.keys()) if (!used.has(id)) bad(`landmark ${id} is not on any resident's schedule`);
  }
  return errors;
}

/** Read and check the checked-in file, the way a caller (or its own test) wants it. */
export function loadWorldLandmarks(path = LANDMARKS_PATH, options = {}) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateWorldLandmarks(data, options);
  if (errors.length) throw new Error(`Refused: ${errors.join('; ')}`);
  return Object.freeze(data);
}

export const LANDMARKS = loadWorldLandmarks();

/** The array the Veloren link config takes, with exactly the keys the server reads. */
export function linkConfigLandmarks(data = LANDMARKS) {
  return data.landmarks.map(configEntry);
}

/** Character name -> resident id, the map the server matches signed events against. */
export function linkConfigResidents(roster = LIVING_ROSTER) {
  return Object.fromEntries(roster.map((resident) => [characterName(resident), resident.id]));
}

/**
 * Where one resident should be at each phase, in the roster's words. A phase she cannot walk to is
 * present and empty, never dropped, and says what is missing.
 */
export function scheduleFor(residentId, data = LANDMARKS) {
  const resident = LIVING_ROSTER.find((item) => item.id === residentId);
  if (!resident) throw new Error(`Unknown resident: ${residentId}`);
  const slots = data.residents?.[residentId] || {};
  return Object.fromEntries(PHASES.map((phase) => {
    const slot = slots[phase];
    if (!slot) return [phase, { label: null, landmark: null, unmapped: null }];
    const landmark = slot.landmark ? data.landmarks.find((item) => item.id === slot.landmark) || null : null;
    return [phase, {
      label: slot.label,
      landmark: landmark ? configEntry(landmark) : null,
      unmapped: slot.unmapped === true ? { reason: slot.reason, needed: slot.needed } : null,
    }];
  }));
}

/** Every destination of every resident that this world cannot honour, with what would be needed. */
export function unmapped(data = LANDMARKS) {
  const found = [];
  for (const resident of LIVING_ROSTER) {
    for (const phase of PHASES) {
      const slot = data.residents?.[resident.id]?.[phase];
      if (slot?.unmapped === true) found.push({ resident_id: resident.id, phase, label: slot.label, reason: slot.reason, needed: slot.needed });
    }
  }
  return found;
}

/** Every label the roster schedules, once each, with the landmark that carries it or null. */
export function labelsInUse(data = LANDMARKS) {
  const found = new Map();
  for (const resident of LIVING_ROSTER) {
    for (const phase of PHASES) {
      const slot = data.residents?.[resident.id]?.[phase];
      if (!slot || found.has(slot.label)) continue;
      found.set(slot.label, slot.unmapped === true ? null : slot.landmark);
    }
  }
  return found;
}

/**
 * What each credential of this world may carry, and why. One bridge credential per resident (scoped
 * to that resident, so it can only ever speak for her), and one relay credential per resident too:
 * the link stores a fact against the credential's own resident and refuses one that names another
 * (`src/veloren-link.js`, `#validateEvent` → `resident_out_of_scope`), so a single relay credential
 * cannot carry eight residents' facts, and each resident's credential stops at her own.
 */
export function credentialPlan(roster = LIVING_ROSTER) {
  return {
    bridge: {
      scopes: [...BRIDGE_SCOPES],
      per: 'resident',
      may: ['answer a player who speaks to her (POST /veloren/talk)', 'be told where she should be (GET /veloren/director)'],
      may_not: [
        'sign facts into NemoWorld: POST /veloren/events needs the events scope, which a bridge credential does not get',
        'speak or be directed as another resident: the link checks the resident id as well as the scope',
        'mint Karma, confirm a purchase, change an account or a plot: no link scope exists for that and no route on the link does it',
      ],
    },
    relay: {
      scopes: [...RELAY_SCOPES],
      per: 'resident',
      why: 'a signed fact is stored against the credential\'s own resident; a credential for one resident is refused for another',
      may: ['hand NemoWorld signed facts about its own resident, and only in that direction'],
      may_not: ['talk', 'be directed', 'anything a bridge credential may do'],
    },
    residents: roster.map((resident) => ({
      resident_id: resident.id,
      character: characterName(resident),
      scopes: [...BRIDGE_SCOPES],
      destinations: PHASES.map((phase) => ({
        phase,
        label: LANDMARKS.residents?.[resident.id]?.[phase]?.label ?? null,
        landmark: LANDMARKS.residents?.[resident.id]?.[phase]?.landmark ?? null,
      })),
    })),
  };
}

/** How a person puts this file's landmarks and residents into a stream's link config. */
export function linkConfigNote() {
  return [
    `landmarks: copy the array from ${LANDMARKS_PATH} into the link config's "landmarks", keeping the ids`,
    `residents: the link config's "residents" needs all of them: ${JSON.stringify(linkConfigResidents())}`,
  ].join('\n');
}
