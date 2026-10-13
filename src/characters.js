// Characters: one appearance, animation and label system for human players, AI residents and country
// ambassadors.
//
// This module is the character half of the voxel renderer, extracted so it can be reviewed and driven
// on its own while the renderer and the application shell are owned by other tasks. It is deliberately
// independent of `src/voxel-world.js`: it does not import the renderer, and the renderer calls it.
//
// ## One appearance system
//
// Every participant is drawn with the *same body construction* — one 0.62 m footprint, one 1.52 m
// standing height (`src/footprints.js`), the same twelve boxes in the same order. What varies is the
// participant's own sealed definition, never the species of object:
//
//   * the stored `color` (a #rrggbb hex or one of the seven sealed `agent_color` cosmetics);
//   * the sealed `skin_tone` cosmetic, chosen deterministically from the resident id;
//   * the explicit calling emblem, one of the eight sealed callings;
//   * the NPC marker (a gold stand and three fins), which says "ambient civic resident" and nothing
//     about authority;
//   * for a country ambassador or a historic guide, the sealed CC0 appearance definition selected by
//     the stored numeric `sprite`, exposed as `appearance.sprite` for the portrait and the 2D atlas
//     route. The sealed sheets carry `color: null`, so an ambassador's body keeps the project's
//     default body colour: nothing is invented to make it look like a different kind of object.
//
// ## Confirmed state only
//
// Positions come from `src/character-animation.js`, which interpolates only between two confirmed
// tiles and never passes the newest one. The stance is the stored `posture`, an expression is the
// stored `emote` inside its stored `emote_until` window, and the walk cycle is the quantised progress
// of that interpolation. A participant that did not move is never drawn walking.
//
// ## Integration
//
// `charactersScene(batch, participants, self, options)` takes the renderer's own cube batch (the
// object `cubeBatch(resources)` returns: `add(x, height, y, width, depth, length, color, pick, style)`
// and `finish()`) and returns exactly what `peopleScene` returned, so it replaces it one-for-one. See
// `docs/handoff/task-32-characters.md` for the wiring.

import content from './content.js';
import { RESIDENT_HEIGHT, RESIDENT_CLEARANCE } from './footprints.js';
import { characterPose, characterState, createMotionTracker, facingStep, MOTION_TWEEN_MS, WALK_SWING } from './character-animation.js';

/** Every kind of participant shares this one construction. */
export const CHARACTER_FAMILY = 'resident';
/** The geometry every body box is built from: `appearance.geometry` in the sealed layer. */
export const CHARACTER_GEOMETRY = 'cube';
/** The body box count of one plain resident, before an emblem or an NPC marker. */
export const CHARACTER_BODY_BOXES = 12;

export const CHARACTER_LIMITS = Object.freeze({
  /** Drawn participants: the same bound the renderer draws (`VOXEL_LIMITS.participants` in `src/voxel-geometry.js`). */
  participants: 220,
  /** How many nearby walkers get a limb-swinging walk cycle; the rest are drawn at rest. */
  animated: 24,
  /** The one body height and half-width every participant is drawn at (metres), from the shared footprint table. */
  height: RESIDENT_HEIGHT,
  clearance: RESIDENT_CLEARANCE,
});

/** The default body colour a participant without a stored colour is drawn in. */
export const DEFAULT_BODY_COLOR = '#649b8a';
/** The ring under the character this browser is playing; the family's lantern-gold token. */
export const SELF_RING_COLOR = '#e2ca83';
/** The ring under every other resident. */
export const RESIDENT_RING_COLOR = '#607b65';

// The seven sealed agent colours (`content/cosmetics/agent-color-*.json`) and the four sealed skin
// tones, in their authored order. Nothing here is a new colour.
const AGENT_COLORS = Object.freeze(Object.fromEntries(content.cosmetics('agent_color').map((id) => [id, content.color(id, 'cosmetic')])));
const SKIN_TONES = Object.freeze(content.cosmetics('skin_tone').map((id) => content.color(id, 'cosmetic')));
/** The sealed expression cosmetics, in authored order: the vocabulary an animation may name. */
export const SEALED_EXPRESSIONS = Object.freeze(content.cosmetics('expression'));

// Original calling emblems: an explicit operator choice, never an account privilege. `mark` names the
// tiny pixel glyph drawn on the badge; the colours are the project's own emblem tints.
const CALLING_EMBLEMS = Object.freeze({
  explorer: Object.freeze({ color: '#7bc0c9', mark: 'cross' }), builder: Object.freeze({ color: '#d39170', mark: 'arch' }),
  cultivator: Object.freeze({ color: '#95c681', mark: 'sprout' }), researcher: Object.freeze({ color: '#ada6d7', mark: 'book' }),
  steward: Object.freeze({ color: '#d7c48a', mark: 'cross' }), mediator: Object.freeze({ color: '#e4dfbe', mark: 'bridge' }),
  artisan: Object.freeze({ color: '#d39bac', mark: 'diamond' }), host: Object.freeze({ color: '#88b7d0', mark: 'arch' }),
});

/** The measured body: the same dimensions for every participant, in metres from the tile floor. */
export const BODY = Object.freeze({
  ring: { width: .62, depth: .06, length: .62, height: .04 },
  leg: { width: .18, depth: .4, length: .21, height: .22, offset: .12 },
  torso: { width: .46, depth: .54, length: .26, height: .68 },
  arm: { width: .13, depth: .4, length: .19, height: .7, offset: .31 },
  hand: { width: .13, depth: .12, length: .18, height: .46 },
  head: { width: .42, depth: .4, length: .4, height: 1.12 },
  headwear: { width: .44, depth: .1, length: .43, height: 1.33, forward: -.025 },
  eye: { width: .045, depth: .05, length: .035, height: 1.13, offset: .09, forward: .205 },
  emblem: { width: .14, depth: .18, length: .052, height: .82, side: -.13, forward: .164 },
  marker: { width: .065, depth: .38, length: .045, height: .84, forward: .15 },
  markerFin: { width: .07, depth: .17, length: .07, height: 1.43, offsets: Object.freeze([-.14, 0, .14]) },
});

/** The four arm poses an animation can name. Every one stays below the drawn head. */
export const ARM_POSES = Object.freeze({
  down: Object.freeze({ height: .7, depth: .4, hand: .46, inward: 0, forward: 0 }),
  up: Object.freeze({ height: 1.02, depth: .46, hand: .84, inward: 0, forward: 0 }),
  head: Object.freeze({ height: 1, depth: .32, hand: .86, inward: .07, forward: .06 }),
  forward: Object.freeze({ height: .74, depth: .3, hand: .58, inward: 0, forward: .28 }),
});

/** How far a leaning body (a stored bow) shifts along its stored facing. */
export const LEAN_DISTANCE = 0.12;

const DARK = '#324842';
const CREAM = '#f1e9cb';
const hex = (value) => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : null;
const hash = (value) => { let result = 0; for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0; };
const name = (value, fallback) => typeof value === 'string' ? value : fallback;

/**
 * One sealed appearance definition, addressed by the numeric `sprite` the database stores in
 * `npc_mayors.sprite` / `npc_ambassadors.sprite`. This is the 20-sheet CC0 family the content layer
 * already carries; the module adds no art and re-seals nothing.
 */
const SPRITE_APPEARANCES = Object.freeze(content.appearancesFor('civic-mayor').reduce((all, definition) => {
  const sprite = definition.appearance.sprite;
  if (Number.isInteger(sprite) && !Object.hasOwn(all, sprite)) {
    all[sprite] = Object.freeze({ id: definition.id, label: definition.label, atlas: definition.appearance.atlas,
      faceset: definition.appearance.faceset, served: Object.freeze({ ...definition.appearance.served }),
      frame: Object.freeze({ ...definition.appearance.frame, walk_rows: Object.freeze([...(definition.appearance.frame?.walk_rows || [])]),
        directions: Object.freeze({ ...(definition.appearance.frame?.directions || {}) }) }),
      directions: Object.freeze({ ...definition.rules.directions }), walk_rows: Object.freeze([...definition.rules.walk_rows]) });
  }
  return all;
}, {}));

/** The sealed appearance definition for a stored sprite number, or null. */
export const spriteAppearance = (sprite) => Number.isInteger(sprite) && Object.hasOwn(SPRITE_APPEARANCES, sprite) ? SPRITE_APPEARANCES[sprite] : null;

/** The callings that have an authored emblem. */
export const emblemFor = (item) => {
  const id = item?.calling?.id;
  return typeof id === 'string' && Object.hasOwn(CALLING_EMBLEMS, id) ? CALLING_EMBLEMS[id] : null;
};

/** The one appearance record the body builder and the nameplate both read. */
export function appearanceFor(item) {
  const id = name(item?.id, '');
  const kind = ['human', 'agent', 'npc'].includes(item?.kind) ? item.kind : 'unknown';
  const sprite = spriteAppearance(item?.sprite);
  return Object.freeze({
    id, kind, family: CHARACTER_FAMILY, geometry: CHARACTER_GEOMETRY,
    npc: kind === 'npc',
    height: CHARACTER_LIMITS.height, clearance: CHARACTER_LIMITS.clearance,
    body: hex(item?.color) || (typeof item?.color === 'string' && Object.hasOwn(AGENT_COLORS, item.color) ? AGENT_COLORS[item.color] : DEFAULT_BODY_COLOR),
    skin: SKIN_TONES[hash(id) % SKIN_TONES.length] || '#d4a17b',
    emblem: emblemFor(item), sprite,
  });
}

// ---------------------------------------------------------------------------------------------
// Label rules. A nameplate shows the resident's stored name and a bounded role label. It reads a
// strict allowlist of public participant fields and nothing else, so private conversation content, a
// private journal, a memory record, capabilities/limits and an operator's contact details can never
// reach a label even if a caller hands the whole payload over.
// ---------------------------------------------------------------------------------------------
export const NAMEPLATE_LIMITS = Object.freeze({
  /** The longest name a label shows, and the longest role label. */
  name: 24, role: 28,
  /** How many labels may be drawn at once. */
  labels: 24,
  /** Name and role up to this camera distance, name only up to the next, nothing beyond it (metres). */
  full_m: 18, compact_m: 40,
  /** The smallest legible rendered text height for the game's camera distances, in pixels. */
  min_text_px: 12,
  /** How far above the drawn head the label anchor sits (metres). */
  anchor_above: 0.35,
});

const ROLE_LABELS = Object.freeze({ human: 'Human player', agent: 'AI resident', npc: 'Country ambassador' });
const SAFE_TOKEN = /^[A-Za-z][A-Za-z ]{0,15}$/;
const collapse = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
/** Bound one label field: never longer than `limit`, never a partial surrogate pair. */
function bounded(value, limit, fallback) {
  const text = collapse(value);
  if (!text) return fallback || '';
  if (text.length <= limit) return text;
  return `${[...text].slice(0, Math.max(1, limit - 1)).join('').trimEnd()}…`;
}

/** The label tier for a camera distance: `full`, `compact`, or hidden beyond the compact range. */
export function nameplateTier(distance, limits = NAMEPLATE_LIMITS) {
  if (!Number.isFinite(distance) || distance < 0) return 'full';
  if (distance <= limits.full_m) return 'full';
  if (distance <= limits.compact_m) return 'compact';
  return 'hidden';
}

/**
 * One readable nameplate. `text` is the single line a small screen shows; `name` and `role` are the
 * two lines a wide one shows. The role is derived from the public `kind` and an authored calling name
 * only; an unexpected value falls back to a neutral label instead of being echoed.
 */
export function characterNameplate(item, options = {}) {
  const appearance = options.appearance || appearanceFor(item);
  const label = bounded(item?.name, NAMEPLATE_LIMITS.name, 'Resident');
  const kindLabel = ROLE_LABELS[appearance.kind] || 'Resident';
  const calling = collapse(item?.calling?.name);
  const suffix = SAFE_TOKEN.test(calling) ? calling : '';
  const role = bounded(suffix ? `${kindLabel} · ${suffix}` : kindLabel, NAMEPLATE_LIMITS.role, kindLabel);
  const position = options.position || { x: Number.isFinite(item?.x) ? item.x : 0, y: Number.isFinite(item?.y) ? item.y : 0, z: Number.isFinite(item?.z) ? item.z : 0 };
  const distance = Number.isFinite(options.distance) ? options.distance : null;
  return Object.freeze({
    id: appearance.id, name: label, role, text: `${label} · ${role}`, kind: appearance.kind,
    tier: nameplateTier(distance),
    anchor: Object.freeze({ x: position.x + .5, y: position.z + appearance.height + NAMEPLATE_LIMITS.anchor_above, z: position.y + .5 }),
    distance,
    sprite: appearance.sprite ? appearance.sprite.faceset : null,
  });
}

/** The bounded nameplate set for a roster, nearest first, at most `NAMEPLATE_LIMITS.labels`. */
export function characterNameplates(participants, self = null, { tracker = null, time = Date.now(), limit = NAMEPLATE_LIMITS.labels } = {}) {
  const people = renderableCharacters(participants, self);
  const viewer = self && people.some((item) => item.id === self.id) ? self : null;
  const placed = people.map((item) => {
    const shown = characterState(item, { tracker, time }).position;
    return { item, shown, distance: viewer ? Math.hypot(shown.x - viewer.x, shown.y - viewer.y) : null };
  }).filter((entry) => entry.distance === null || nameplateTier(entry.distance) !== 'hidden')
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || String(a.item.id).localeCompare(String(b.item.id)))
    .slice(0, Number.isInteger(limit) && limit > 0 ? limit : NAMEPLATE_LIMITS.labels);
  return placed.map((entry) => characterNameplate(entry.item, { position: entry.shown, distance: entry.distance }));
}

// ---------------------------------------------------------------------------------------------
// The roster and the batch key.
// ---------------------------------------------------------------------------------------------

/** The participants the module draws: self appended when the roster omits it, then bounded and placed. */
export const renderableCharacters = (participants, self) => {
  const people = self && !(participants || []).some((item) => item.id === self.id) ? [...(participants || []), self] : participants || [];
  return people.slice(0, CHARACTER_LIMITS.participants).filter((item) => Number.isInteger(item?.x) && Number.isInteger(item?.y));
};

/** The nearby participants that get a limb-swinging walk cycle: at most `animated` of them. */
export function animatedCharacters(participants, viewer, limit = CHARACTER_LIMITS.animated) {
  const bound = Number.isInteger(limit) && limit > 0 ? limit : CHARACTER_LIMITS.animated;
  const origin = Number.isInteger(viewer?.x) && Number.isInteger(viewer?.y) ? viewer : null;
  const ordered = origin ? [...participants].sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y)) : [...participants];
  return new Set(ordered.slice(0, bound).map((item) => item.id));
}

const keyOf = (item, self, tracker, time, animated) => {
  const appearance = appearanceFor(item);
  const state = characterState(item, { tracker, time, animated });
  return [item.id ?? null, state.position.x, state.position.y, state.position.z, state.state, state.phase, state.expressionFrame,
    state.facing, appearance.kind, appearance.body, appearance.skin, appearance.emblem?.mark ?? null, appearance.emblem?.color ?? null,
    appearance.sprite?.id ?? null, item.id === self?.id ? 1 : 0];
};

/**
 * The stable batch key: every field the drawn geometry depends on, and no other. Refreshing
 * `last_seen`, re-ordering the roster, editing a curated profile field, renaming a resident or
 * changing an operator does not rebuild the batch; the drawn tile, elevation, stance, colour, emblem,
 * sealed appearance and animation frame do. A poll carrying an unknown or expired `emote_until` draws
 * no expression, so it changes nothing either.
 */
export function charactersVisualKey(participants, self, { tracker = null, time = Date.now(), animated = null } = {}) {
  const people = renderableCharacters(participants, self);
  const moving = animated === null ? animatedCharacters(people, self) : animated;
  return JSON.stringify([self?.id || null, people.map((item) => keyOf(item, self, tracker, time, moving.has(item.id))).sort()]);
}

// ---------------------------------------------------------------------------------------------
// The body builder. Every participant is one body built from `BODY` and posed by the confirmed state.
// ---------------------------------------------------------------------------------------------

/** The arm cube for one pose: position offset, vertical size and the matching hand height. */
function armGeometry(pose, side, direction) {
  const inward = pose.inward * (side < 0 ? 1 : -1);
  return { x: inward + pose.forward * direction.x, y: pose.forward * direction.y, depth: pose.depth, height: pose.height, hand: pose.hand };
}

/**
 * Emit one character's boxes into the renderer's batch. The pick carries the **confirmed** tile, not
 * the interpolated one, so a click or an interaction can never address a position the server has not
 * stored, while the drawn body may sit between its two confirmed tiles.
 */
export function paintCharacter(batch, item, self, { tracker = null, time = Date.now(), animated = true } = {}) {
  const appearance = appearanceFor(item);
  const state = characterState(item, { tracker, time, animated });
  const pose = characterPose(state);
  const x = state.position.x + .5, y = state.position.y + .5, elevation = state.elevation, height = elevation + pose.lift;
  const direction = facingStep(state.facing);
  const pick = { x: item.x, y: item.y, z: Number.isFinite(item.z) ? item.z : 0, type: 'participant', participant: item };
  const lean = pose.lean ? { x: direction.x * LEAN_DISTANCE, y: direction.y * LEAN_DISTANCE } : { x: 0, y: 0 };
  // The stride: a leg swings along the confirmed direction of travel, and the arm on that side moves
  // the other way. Both swings are zero unless the display is between two confirmed tiles.
  const stride = pose.swing * WALK_SWING;
  const offset = (dx, dy) => ({ x: direction.x * stride * dx, y: direction.y * stride * dy });
  const emit = (cx, cy, cz, width, depth, length, color, style) => batch.add(cx, cy, cz, width, depth, length, color, pick, style);

  emit(x, BODY.ring.height + elevation, y, BODY.ring.width, BODY.ring.depth, BODY.ring.length, item.id === self?.id ? SELF_RING_COLOR : RESIDENT_RING_COLOR);
  for (const [side, step] of [[-1, 1], [1, -1]]) {
    const leg = offset(step, step);
    emit(x + side * BODY.leg.offset + leg.x, BODY.leg.height + elevation, y + leg.y, BODY.leg.width, pose.legDepth, BODY.leg.length, DARK);
  }
  for (const [side, step] of [[-1, -1], [1, 1]]) {
    const arm = armGeometry(ARM_POSES[side < 0 ? pose.arm.left : pose.arm.right], side, direction), move = offset(step, step);
    const armX = x + side * BODY.arm.offset + arm.x + move.x + lean.x, armY = y + arm.y + move.y + lean.y;
    emit(armX, arm.height + height, armY, BODY.arm.width, arm.depth, BODY.arm.length, appearance.body);
    emit(armX, arm.hand + height, armY, BODY.hand.width, BODY.hand.depth, BODY.hand.length, appearance.skin);
  }
  emit(x + lean.x, BODY.torso.height + height, y + lean.y, BODY.torso.width, BODY.torso.depth, BODY.torso.length, appearance.body);
  emit(x + lean.x, BODY.head.height + height, y + lean.y, BODY.head.width, BODY.head.depth, BODY.head.length, appearance.skin);
  emit(x + lean.x, BODY.headwear.height + height, y + BODY.headwear.forward + lean.y, BODY.headwear.width, BODY.headwear.depth, BODY.headwear.length, appearance.npc ? SELF_RING_COLOR : DARK);
  for (const dx of [-BODY.eye.offset, BODY.eye.offset]) emit(x + dx + lean.x, BODY.eye.height + height, y + BODY.eye.forward + lean.y, BODY.eye.width, BODY.eye.depth, BODY.eye.length, DARK);
  if (appearance.emblem) paintEmblem(emit, appearance.emblem, x + lean.x, y + lean.y, BODY.emblem.height + height);
  if (appearance.npc) {
    emit(x, BODY.marker.height + height, y + BODY.marker.forward, BODY.marker.width, BODY.marker.depth, BODY.marker.length, SELF_RING_COLOR);
    for (const dx of BODY.markerFin.offsets) emit(x + dx, BODY.markerFin.height + height, y, BODY.markerFin.width, BODY.markerFin.depth, BODY.markerFin.length, SELF_RING_COLOR);
  }
}

/** The original emblem badge and its pixel glyph, drawn on the chest. */
function paintEmblem(emit, emblem, centreX, centreY, height) {
  const emblemX = centreX + BODY.emblem.side, emblemY = centreY + BODY.emblem.forward;
  emit(emblemX, height, emblemY, BODY.emblem.width, BODY.emblem.depth, BODY.emblem.length, emblem.color);
  const pixel = (dx, dy, width = .027, depth = .028) => emit(emblemX + dx, height + dy, emblemY + .03, width, depth, .014, CREAM);
  if (emblem.mark === 'cross') { pixel(0, 0, .026, .1); pixel(0, 0, .09, .026); }
  else if (emblem.mark === 'arch' || emblem.mark === 'bridge') { pixel(-.03, -.018, .022, .08); pixel(.03, -.018, .022, .08); pixel(0, .027, .084, .022); }
  else if (emblem.mark === 'sprout') { pixel(0, -.019, .022, .07); pixel(-.025, .025, .039, .025); pixel(.025, .041, .039, .025); }
  else if (emblem.mark === 'book') { pixel(-.023, 0, .027, .1); pixel(.023, 0, .027, .1); }
  else { pixel(0, .039); pixel(-.029, 0); pixel(.029, 0); pixel(0, -.039); }
}

/**
 * The character batch: the drop-in replacement for the renderer's `peopleScene`. `batch` is the
 * renderer's own `cubeBatch(resources)`, and the return value is exactly what `batch.finish()`
 * returns (`{ group, pickables, cubes, batches }`).
 */
export function charactersScene(batch, participants, self, options = {}) {
  if (!batch || typeof batch.add !== 'function' || typeof batch.finish !== 'function') throw new Error('charactersScene needs the renderer cube batch: an object with add() and finish().');
  const { tracker = null, time = Date.now(), animated = CHARACTER_LIMITS.animated } = options;
  const people = renderableCharacters(participants, self);
  const moving = animatedCharacters(people, self, animated);
  for (const item of people) paintCharacter(batch, item, self, { tracker, time, animated: moving.has(item.id) });
  return batch.finish();
}

export { createMotionTracker, characterPose, characterState, MOTION_TWEEN_MS };
export default Object.freeze({
  appearanceFor, spriteAppearance, charactersScene, charactersVisualKey, characterNameplate, characterNameplates,
  renderableCharacters, animatedCharacters, nameplateTier, createMotionTracker, characterPose, characterState,
  CHARACTER_LIMITS, NAMEPLATE_LIMITS, BODY,
});
