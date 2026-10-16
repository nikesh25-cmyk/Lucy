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
// standing height (`src/footprints.js`), the same fifteen boxes in the same order. What varies is the
// participant's own sealed definition, never the species of object:
//
//   * the stored `color` (a #rrggbb hex or one of the seven sealed `agent_color` cosmetics);
//   * the sealed `skin_tone` cosmetic, chosen deterministically from the resident id;
//   * the explicit calling emblem, one of the eight sealed callings, plus that calling's silhouette
//     accent (a brim, a mantle, an apron, a satchel, a tool belt): the outline of a body now names
//     what its resident chose to do;
//   * the equipped `avatar` cosmetic the world already publishes — the sealed keepsakes and the
//     crafted decorations a resident can make from grown resources — drawn on the body;
//   * the NPC marker (a gold stand and three fins), which says "ambient civic resident" and nothing
//     about authority;
//   * for a country ambassador or a historic guide, the sealed CC0 appearance definition selected by
//     the stored numeric `sprite`, exposed as `appearance.sprite` for the portrait and the 2D atlas
//     route. The sealed sheets carry `color: null`, so an ambassador's body keeps the project's
//     default body colour: nothing is invented to make it look like a different kind of object.
//
// ## The body is authored in its own frame
//
// Every part is stated once, in local coordinates: `across` (the perpendicular), `forward` (the
// direction the resident faces) and `height` above the tile floor. `paintCharacter` turns that frame
// by the confirmed facing, so a resident drawn walking left looks left. No part is ever authored in
// world axes, and no part may leave the tile it is drawn on: `characterBoxes` clamps every box into
// the drawn tile column, and the tests prove the authored vocabulary never needs clamping.
//
// ## Confirmed state only
//
// Positions come from `src/character-animation.js`, which interpolates only between two confirmed
// tiles and never passes the newest one. The stance is the stored `posture`, an expression is the
// stored `emote` inside its stored `emote_until` window, and the walk cycle is the quantised progress
// of that interpolation. A participant that did not move is never drawn walking, and no pose is ever
// a function of a free-running clock.
//
// ## Integration
//
// `charactersScene(batch, participants, self, options)` takes the renderer's own cube batch (the
// object `cubeBatch(resources)` returns: `add(x, height, y, width, depth, length, color, pick, style)`
// and `finish()`) and returns exactly what `peopleScene` returned, so it replaces it one-for-one. See
// `docs/handoff/task-32-characters.md` for the wiring.

import content from './content.js';
import { RESIDENT_HEIGHT, RESIDENT_CLEARANCE } from './footprints.js';
import { characterPose, characterState, createMotionTracker, facingFrame, facingStep, LEANING_EXPRESSIONS, MOTION_TWEEN_MS, WALK_SWING } from './character-animation.js';

/** Every kind of participant shares this one construction. */
export const CHARACTER_FAMILY = 'resident';
/** The geometry every body box is built from: `appearance.geometry` in the sealed layer. */
export const CHARACTER_GEOMETRY = 'cube';
/** The body box count of one plain resident, before an emblem, a silhouette, a decoration or a marker. */
export const CHARACTER_BODY_BOXES = 15;
/** How many boxes each authored addition may draw, so no combination can surprise the renderer. */
export const CHARACTER_PART_BOXES = Object.freeze({ body: CHARACTER_BODY_BOXES, marker: 4, emblem: 3, silhouette: 2, decoration: 2 });
/** The half-width of the tile one resident is drawn on. No box may reach past it. */
export const CHARACTER_TILE_HALF = 0.5;
/** How far a leaning pose (a stored bow or a think) shifts the torso and head along the stored facing. */
export const LEAN_DISTANCE = 0.12;
/** A leg swings this far along the confirmed step at its peak: the animation's own stride figure. */
export const STRIDE = WALK_SWING;

export const CHARACTER_LIMITS = Object.freeze({
  /** Drawn participants: the same bound the renderer draws (`VOXEL_LIMITS.participants` in `src/voxel-geometry.js`). */
  participants: 220,
  /** How many nearby walkers get a limb-swinging walk cycle; the rest are drawn at rest. */
  animated: 24,
  /** The one body height and half-width every participant is drawn at (metres), from the shared footprint table. */
  height: RESIDENT_HEIGHT,
  clearance: RESIDENT_CLEARANCE,
  /**
   * Boxes one participant may draw. `DIORAMA_BUDGET.participant_instances` in `src/voxel-geometry.js`
   * is 220 x 22, so this is the ceiling that budget already pays for; the authored combinations below
   * reach exactly it and never pass it.
   */
  boxes: 22,
  /**
   * The top of the drawn *body* — the head and every limb. A calling accent or an equipped decoration
   * may occupy the head room above it, up to the shared 1.52 m resident height.
   */
  head: 1.38,
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

// The body's own palette: the project's flat-shaded cube colours, no texture and no mesh.
const DARK = '#324842';
const BOOT = '#42584f';
const CREAM = '#f1e9cb';
const CLAY = '#a8794f';
const COCOA = '#6b4f3a';
const LINEN = '#e8e0c8';
const FELT = '#7a6a8f';
const WICKER = '#c2a367';
const CLOTH = '#c9c2ae';
const WOOD = '#b58c58';
const GLASS = '#e5d9a8';
const WHISTLE = '#c8b184';
const PETAL = '#e6a5b4';
const LEAF = '#8fbf72';
const STEM = '#6d9552';

const hex = (value) => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : null;
const hash = (value) => { let result = 0; for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0; };
const name = (value, fallback) => typeof value === 'string' ? value : fallback;
const part = (across, forward, height, depth, width, length, color) => Object.freeze({ across, forward, height, depth, width, length, color });

/**
 * The measured body: the same dimensions for every participant, in metres from the tile floor, in the
 * body's own frame. `across` is the perpendicular, `forward` the facing direction, `height` the box
 * centre above the floor and `depth` its vertical size. `bottom` is the leg's own floor contact, so a
 * seated stance can shorten the leg without floating it.
 */
export const BODY = Object.freeze({
  ring: Object.freeze({ width: .62, depth: .06, length: .62, height: .04 }),
  foot: Object.freeze({ width: .17, depth: .11, length: .27, height: .065, across: .115, forward: .05 }),
  leg: Object.freeze({ width: .19, depth: .62, length: .2, bottom: .11, across: .115, forward: 0 }),
  hip: Object.freeze({ width: .36, depth: .14, length: .23, height: .79 }),
  chest: Object.freeze({ width: .46, depth: .28, length: .27, height: .94 }),
  arm: Object.freeze({ width: .13, depth: .44, length: .19, across: .31 }),
  hand: Object.freeze({ width: .14, depth: .14, length: .18, across: .31 }),
  head: Object.freeze({ width: .42, depth: .32, length: .4, height: 1.2 }),
  headwear: Object.freeze({ width: .44, depth: .1, length: .43, height: 1.33, forward: -.02 }),
  eye: Object.freeze({ width: .045, depth: .05, length: .035, height: 1.2, across: .09, forward: .195 }),
  emblem: Object.freeze({ width: .14, depth: .18, length: .052, height: .82, across: -.13, forward: .164 }),
  marker: Object.freeze({ width: .065, depth: .38, length: .045, height: .84, forward: .15 }),
  markerFin: Object.freeze({ width: .07, depth: .17, length: .07, height: 1.43, offsets: Object.freeze([-.14, 0, .14]) }),
});

/**
 * The arm poses an animation can name, each one a position in the body's own frame. Every one keeps
 * its own top and its hand below `CHARACTER_LIMITS.head`, so a raised arm can never be mistaken for a
 * taller body. `inward` moves the limb toward the body's centre line and may be negative to open it.
 */
export const ARM_POSES = Object.freeze({
  down: Object.freeze({ height: .82, depth: .44, hand: .53, inward: 0, forward: 0 }),
  rise: Object.freeze({ height: .98, depth: .44, hand: .7, inward: .02, forward: -.06 }),
  up: Object.freeze({ height: 1.14, depth: .48, hand: .92, inward: .02, forward: 0 }),
  head: Object.freeze({ height: 1.1, depth: .36, hand: 1.02, inward: .08, forward: .06 }),
  out: Object.freeze({ height: .92, depth: .38, hand: .68, inward: -.1, forward: .02 }),
  forward: Object.freeze({ height: .86, depth: .34, hand: .62, inward: 0, forward: .3 }),
  point: Object.freeze({ height: .96, depth: .34, hand: .72, inward: 0, forward: .34 }),
  lap: Object.freeze({ height: .66, depth: .4, hand: .42, inward: .06, forward: .2 }),
  clasp: Object.freeze({ height: .7, depth: .42, hand: .44, inward: .12, forward: .18 }),
});

/**
 * One silhouette accent per sealed calling: what a resident chose to do, worn on the outline. Each is
 * at most `CHARACTER_PART_BOXES.silhouette` boxes, so the calling never decides the body.
 */
export const CALLING_SILHOUETTES = Object.freeze({
  explorer: Object.freeze({ color: CLAY, parts: Object.freeze([
    part(0, 0, 1.3, .08, .56, .55, CLAY), part(.17, -.02, 1, .2, .07, .3, COCOA)]) }),
  builder: Object.freeze({ color: CLAY, parts: Object.freeze([
    part(0, 0, 1.05, .1, .62, .3, CLAY), part(0, .145, .74, .4, .32, .06, LINEN)]) }),
  cultivator: Object.freeze({ color: WICKER, parts: Object.freeze([
    part(0, 0, 1.31, .06, .58, .57, WICKER), part(0, .2, .8, .18, .22, .14, WICKER)]) }),
  researcher: Object.freeze({ color: FELT, parts: Object.freeze([
    part(0, -.17, 1.26, .2, .48, .12, FELT), part(0, .19, .86, .16, .21, .1, LINEN)]) }),
  steward: Object.freeze({ color: LINEN, parts: Object.freeze([
    part(0, 0, 1.09, .12, .52, .31, LINEN), part(-.14, .15, .8, .42, .11, .06, COCOA)]) }),
  mediator: Object.freeze({ color: FELT, parts: Object.freeze([
    part(0, 0, 1.08, .16, .56, .33, FELT), part(.13, .15, .86, .36, .09, .05, LINEN)]) }),
  artisan: Object.freeze({ color: FELT, parts: Object.freeze([
    part(0, 0, 1.34, .12, .46, .44, FELT), part(0, 0, .78, .09, .44, .29, COCOA)]) }),
  host: Object.freeze({ color: LINEN, parts: Object.freeze([
    part(0, 0, 1.13, .12, .34, .29, LINEN), part(0, .22, .86, .05, .22, .18, WOOD)]) }),
});

/**
 * The equipped `avatar` cosmetic, drawn on the body. The ids are exactly the two sealed groups the
 * world already publishes as a participant's `avatar`: the keepsake decorations
 * (`content/cosmetics('avatar')`) and the decorations a resident can craft from grown resources
 * (`content.recipes()`). Nothing here is a new definition — the module only decides what each sealed
 * id draws — and an id outside those two groups draws nothing rather than being echoed.
 */
export const DECORATIONS = Object.freeze({
  flower: Object.freeze({ color: PETAL, parts: Object.freeze([
    part(.1, .02, 1.42, .08, .11, .11, PETAL), part(.1, .02, 1.35, .08, .03, .03, STEM)]) }),
  leaf: Object.freeze({ color: LEAF, parts: Object.freeze([
    part(-.12, .02, 1.4, .05, .14, .09, LEAF), part(-.12, .02, 1.35, .07, .03, .03, STEM)]) }),
  sprout: Object.freeze({ color: LEAF, parts: Object.freeze([
    part(0, 0, 1.34, .12, .03, .03, STEM), part(0, 0, 1.44, .05, .16, .05, LEAF)]) }),
  star: Object.freeze({ color: CREAM, parts: Object.freeze([
    part(0, 0, 1.42, .05, .17, .05, CREAM), part(0, 0, 1.42, .18, .05, .05, CREAM)]) }),
  explorer_banner: Object.freeze({ color: CLOTH, parts: Object.freeze([
    part(0, -.2, 1.1, .8, .05, .05, WOOD), part(0, -.23, 1.22, .36, .2, .04, CLOTH)]) }),
  flower_crown: Object.freeze({ color: PETAL, parts: Object.freeze([
    part(0, 0, 1.32, .07, .48, .47, WICKER), part(.1, -.16, 1.41, .08, .1, .1, PETAL)]) }),
  herbal_wreath: Object.freeze({ color: LEAF, parts: Object.freeze([
    part(0, 0, 1.31, .08, .48, .47, WICKER), part(-.13, -.14, 1.4, .07, .12, .06, LEAF)]) }),
  garden_lantern: Object.freeze({ color: GLASS, parts: Object.freeze([
    part(.36, .06, .66, .2, .13, .13, GLASS), part(.36, .06, .8, .08, .05, .05, WOOD)]) }),
  reed_whistle: Object.freeze({ color: WHISTLE, parts: Object.freeze([
    part(.36, .1, .62, .1, .06, .2, WHISTLE), part(.36, .06, .72, .08, .07, .07, WOOD)]) }),
  woven_banner: Object.freeze({ color: CLOTH, parts: Object.freeze([
    part(0, -.19, 1.08, .78, .05, .05, WOOD), part(0, -.22, 1.16, .44, .22, .04, CLOTH)]) }),
  festival_banner: Object.freeze({ color: LEAF, parts: Object.freeze([
    part(0, -.19, 1.08, .86, .05, .05, WOOD), part(0, -.22, 1.2, .48, .24, .04, LEAF)]) }),
});

/** The sealed ids a stored `avatar` may name: the keepsakes and the crafted decoration outputs. */
const DECORATION_IDS = Object.freeze([...content.cosmetics('avatar'), ...content.recipes().map((recipe) => recipe.output)]);
const DECORATION_INDEX = Object.freeze(new Map(DECORATION_IDS.map((id) => [id, DECORATIONS[id] || null])));

/** The drawn decoration for a stored `avatar`, or null. An unsealed value is refused, never echoed. */
export const decorationFor = (item) => typeof item?.avatar === 'string' && DECORATION_INDEX.has(item.avatar) ? DECORATION_INDEX.get(item.avatar) : null;

/** The sealed ids that name a drawn silhouette, in the sealed calling order. */
export const SILHOUETTE_IDS = Object.freeze(Object.keys(CALLING_SILHOUETTES));

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

/** The authored silhouette accent for a calling, or null. */
export const silhouetteFor = (item) => {
  const id = item?.calling?.id;
  return typeof id === 'string' && Object.hasOwn(CALLING_SILHOUETTES, id) ? CALLING_SILHOUETTES[id] : null;
};

/**
 * The one appearance record the body builder and the nameplate both read. The four drawn additions
 * are mutually exclusive where the budget needs them to be: the ambient NPC marker *is* the authored
 * silhouette for an NPC, and an NPC holds no account-bound keepsake, so an NPC draws its marker,
 * its emblem and nothing else. That is what keeps the worst case inside `CHARACTER_LIMITS.boxes`.
 */
export function appearanceFor(item) {
  const id = name(item?.id, '');
  const kind = ['human', 'agent', 'npc'].includes(item?.kind) ? item.kind : 'unknown';
  const sprite = spriteAppearance(item?.sprite);
  const npc = kind === 'npc';
  return Object.freeze({
    id, kind, family: CHARACTER_FAMILY, geometry: CHARACTER_GEOMETRY,
    npc,
    height: CHARACTER_LIMITS.height, clearance: CHARACTER_LIMITS.clearance,
    body: hex(item?.color) || (typeof item?.color === 'string' && Object.hasOwn(AGENT_COLORS, item.color) ? AGENT_COLORS[item.color] : DEFAULT_BODY_COLOR),
    skin: SKIN_TONES[hash(id) % SKIN_TONES.length] || '#d4a17b',
    emblem: emblemFor(item), sprite,
    silhouette: npc ? null : silhouetteFor(item),
    decoration: npc ? null : decorationFor(item),
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
  const position = options.position || { x: Number.isFinite(item?.x) ? item.x : 0, y: Number.isFinite(item?.y) ? item.y : 0, z: Number.isInteger(item?.z) ? item.z : 0 };
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
  return people.slice(0, CHARACTER_LIMITS.participants).filter((item) => Number.isInteger(item?.x) && Number.isInteger(item?.y) && (item?.z === undefined || Number.isInteger(item.z)));
};

/** The nearby participants that get a limb-swinging walk cycle: at most `animated` of them. */
export function animatedCharacters(participants, viewer, limit = CHARACTER_LIMITS.animated) {
  const bound = Number.isInteger(limit) && limit > 0 ? limit : CHARACTER_LIMITS.animated;
  const origin = Number.isInteger(viewer?.x) && Number.isInteger(viewer?.y) ? viewer : null;
  const ordered = origin ? [...participants].sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y) || String(a.id).localeCompare(String(b.id))) : [...participants].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return new Set(ordered.slice(0, bound).map((item) => item.id));
}

const keyOf = (item, self, tracker, time, animated, reducedMotion) => {
  const appearance = appearanceFor(item);
  const state = characterState(item, { tracker, time, animated, reducedMotion });
  return [item.id ?? null, state.position.x, state.position.y, state.position.z, state.state, state.phase, state.expressionFrame,
    state.facing, appearance.kind, appearance.body, appearance.skin, appearance.emblem?.mark ?? null, appearance.emblem?.color ?? null,
    appearance.silhouette?.color ?? null, appearance.decoration?.color ?? null, appearance.decoration ? item.avatar : null,
    appearance.sprite?.id ?? null, item.id === self?.id ? 1 : 0];
};

/**
 * The stable batch key: every field the drawn geometry depends on, and no other. Refreshing
 * `last_seen`, re-ordering the roster, editing a curated profile field other than the equipped
 * decoration, renaming a resident or changing an operator does not rebuild the batch; the drawn tile,
 * elevation, stance, colour, emblem, calling silhouette, equipped decoration, sealed appearance and
 * animation frame do. A poll carrying an unknown or expired `emote_until` draws no expression, so it
 * changes nothing either.
 */
export function charactersVisualKey(participants, self, { tracker = null, time = Date.now(), animated = null, reducedMotion = false } = {}) {
  const people = renderableCharacters(participants, self);
  const moving = animated === null ? animatedCharacters(people, self) : animated;
  return JSON.stringify([self?.id || null, reducedMotion === true, people.map((item) => keyOf(item, self, tracker, time, moving.has(item.id), reducedMotion)).sort()]);
}

// ---------------------------------------------------------------------------------------------
// The body builder. Every participant is one body built from `BODY`, authored in its own frame and
// posed by the confirmed state.
// ---------------------------------------------------------------------------------------------

/**
 * Emit one character's boxes into the renderer's batch.
 *
 * The pick carries the **confirmed** tile, not the interpolated one, so a click or an interaction can
 * never address a position the server has not stored, while the drawn body may sit between its two
 * confirmed tiles.
 */
export function paintCharacter(batch, item, self, options = {}) {
  const appearance = appearanceFor(item);
  const state = characterState(item, options);
  const pick = { x: item.x, y: item.y, z: Number.isInteger(item.z) ? item.z : 0, type: 'participant', participant: item };
  const x = state.position.x + .5, y = state.position.y + .5, elevation = state.elevation;
  for (const box of characterBoxes(item, self, { ...options, state, appearance })) {
    batch.add(x + box.x, elevation + box.height, y + box.z, box.width, box.depth, box.length, box.color, pick, box.style);
  }
}

/**
 * The bounded box list of one participant, as world-axis sizes and offsets from the centre of the
 * tile it is drawn on. Every box is turned into the confirmed facing's frame, and every box is
 * clamped into that tile column: a pose can move a limb, never the tile the resident stands on.
 *
 * The groups are added in a fixed priority — body, marker, emblem, silhouette, decoration — and a
 * group that would pass `CHARACTER_LIMITS.boxes` is left out whole, so a payload no server can
 * produce degrades predictably instead of overrunning the renderer's instance budget.
 */
export function characterBoxes(item, self, options = {}) {
  const appearance = options.appearance || appearanceFor(item);
  const state = options.state || characterState(item, options);
  const pose = characterPose(state);
  const box = frameOf(state, pose);
  const boxes = [];
  for (const group of characterGroups(item, self, appearance, box, pose)) {
    if (boxes.length + group.length > CHARACTER_LIMITS.boxes) continue;
    boxes.push(...group);
  }
  return boxes.filter(insideTile);
}

/** True when a box stays inside the 1 x 1 tile it is drawn on, in both ground axes. */
const insideTile = (box) => Math.abs(box.x) + box.width / 2 <= CHARACTER_TILE_HALF + 1e-9 && Math.abs(box.z) + box.length / 2 <= CHARACTER_TILE_HALF + 1e-9;
/** Collapse a signed zero, so a mirrored box compares equal to its twin in the tests. */
const snapped = (value) => Math.abs(value) < 1e-9 ? 0 : value;

/**
 * The transform from the body's own frame to the drawn one: `across`/`forward` become world x/z, the
 * flat extents swap on a left/right facing, and the upper body's confirmed lift, sway and lean are
 * carried by every part that rides the torso (`true` below) rather than by the legs on the floor.
 */
function frameOf(state, pose) {
  const frame = state.frame;
  const place = (across, forward, height, torso) => ({
    x: frame.across.x * (across + (torso ? pose.sway : 0)) + frame.forward.x * (forward + (torso ? LEAN_DISTANCE * pose.lean : 0)),
    z: frame.across.y * (across + (torso ? pose.sway : 0)) + frame.forward.y * (forward + (torso ? LEAN_DISTANCE * pose.lean : 0)),
    height: height + (torso ? pose.lift : 0),
  });
  /** One authored part as a world-space box, relative to the centre of the tile it is drawn on. */
  const box = (spec, torso) => {
    const offset = place(spec.across, spec.forward, spec.height, torso);
    return { x: snapped(offset.x), height: snapped(offset.height), z: snapped(offset.z),
      width: frame.swap ? spec.length : spec.width, depth: spec.depth, length: frame.swap ? spec.width : spec.length,
      color: spec.color, style: 'solid' };
  };
  return box;
}

/**
 * The five authored groups, in the priority order the instance budget is spent in. Every part is
 * stated once in the body's own frame by `part(...)`; `box(spec, true)` marks the parts that ride the
 * confirmed lift, sway and lean of the upper body rather than sitting on the floor with the legs.
 */
function characterGroups(item, self, appearance, box, pose) {
  const stride = pose.swing * STRIDE;
  const legHeight = BODY.leg.bottom + pose.legDepth / 2;
  const body = [box(part(0, 0, BODY.ring.height, BODY.ring.depth, BODY.ring.width, BODY.ring.length, item.id === self?.id ? SELF_RING_COLOR : RESIDENT_RING_COLOR), false)];
  // The stride: the leading leg swings forward along the confirmed step and the other trails it.
  for (const [side, step] of [[-1, 1], [1, -1]]) {
    const swing = step * stride;
    body.push(
      box(part(side * (BODY.leg.across + pose.legAcross), pose.legForward + swing, legHeight, pose.legDepth, BODY.leg.width, BODY.leg.length, DARK), false),
      box(part(side * (BODY.foot.across + pose.footAcross), pose.footForward + swing, BODY.foot.height, BODY.foot.depth, BODY.foot.width, BODY.foot.length, BOOT), false));
  }
  // The waist joint: a narrower pelvis under a wider chest is what reads as a body at distance.
  body.push(
    box(part(0, 0, BODY.hip.height, BODY.hip.depth, BODY.hip.width, BODY.hip.length, appearance.body), true),
    box(part(0, 0, BODY.chest.height, BODY.chest.depth, BODY.chest.width, BODY.chest.length, appearance.body), true));
  // The shoulder joint: each arm swings opposite its own leg along the same confirmed step.
  for (const [side, step] of [[-1, -1], [1, 1]]) {
    const arms = ARM_POSES[side < 0 ? pose.arm.left : pose.arm.right] || ARM_POSES.down;
    const across = side * (BODY.arm.across - arms.inward), forward = arms.forward + step * stride;
    body.push(
      box(part(across, forward, arms.height, arms.depth, BODY.arm.width, BODY.arm.length, appearance.body), true),
      box(part(across, forward, arms.hand, BODY.hand.depth, BODY.hand.width, BODY.hand.length, appearance.skin), true));
  }
  body.push(
    box(part(0, 0, BODY.head.height, BODY.head.depth, BODY.head.width, BODY.head.length, appearance.skin), true),
    box(part(0, BODY.headwear.forward, BODY.headwear.height, BODY.headwear.depth, BODY.headwear.width, BODY.headwear.length, appearance.npc ? SELF_RING_COLOR : DARK), true));
  for (const side of [-1, 1]) body.push(box(part(side * BODY.eye.across, BODY.eye.forward, BODY.eye.height, BODY.eye.depth, BODY.eye.width, BODY.eye.length, DARK), true));
  const groups = [body];
  if (appearance.npc) groups.push([
    box(part(0, BODY.marker.forward, BODY.marker.height, BODY.marker.depth, BODY.marker.width, BODY.marker.length, SELF_RING_COLOR), true),
    ...BODY.markerFin.offsets.map((across) => box(part(across, 0, BODY.markerFin.height, BODY.markerFin.depth, BODY.markerFin.width, BODY.markerFin.length, SELF_RING_COLOR), true)),
  ]);
  if (appearance.emblem) groups.push(emblemBoxes(box, appearance.emblem));
  if (appearance.silhouette) groups.push(appearance.silhouette.parts.map((spec) => box(spec, true)));
  if (appearance.decoration) groups.push(appearance.decoration.parts.map((spec) => box(spec, true)));
  return groups;
}

/** The original emblem badge and its two-pixel glyph, drawn on the chest. */
function emblemBoxes(box, emblem) {
  const pixel = (across, height, width = .027, depth = .028) =>
    part(BODY.emblem.across + across, BODY.emblem.forward + .03, BODY.emblem.height + height, depth, width, .014, CREAM);
  const pixels = emblem.mark === 'arch' || emblem.mark === 'bridge' ? [pixel(-.03, 0, .022, .088), pixel(.03, 0, .022, .088)]
    : emblem.mark === 'sprout' ? [pixel(0, -.02, .022, .07), pixel(-.02, .026, .05, .024)]
      : emblem.mark === 'book' ? [pixel(-.023, 0, .027, .1), pixel(.023, 0, .027, .1)]
        : emblem.mark === 'diamond' ? [pixel(0, .032, .09, .024), pixel(0, -.032, .024, .09)]
          : [pixel(0, 0, .026, .1), pixel(0, 0, .09, .026)];
  return [box(part(BODY.emblem.across, BODY.emblem.forward, BODY.emblem.height, BODY.emblem.depth, BODY.emblem.width, BODY.emblem.length, emblem.color), true),
    ...pixels.map((spec) => box(spec, true))];
}

/**
 * The character batch: the drop-in replacement for the renderer's `peopleScene`. `batch` is the
 * renderer's own `cubeBatch(resources)`, and the return value is exactly what `batch.finish()`
 * returns (`{ group, pickables, cubes, batches }`).
 */
export function charactersScene(batch, participants, self, options = {}) {
  if (!batch || typeof batch.add !== 'function' || typeof batch.finish !== 'function') throw new Error('charactersScene needs the renderer cube batch: an object with add() and finish().');
  const { tracker = null, time = Date.now(), animated = CHARACTER_LIMITS.animated, reducedMotion = false } = options;
  const people = renderableCharacters(participants, self);
  const moving = animatedCharacters(people, self, animated);
  for (const item of people) paintCharacter(batch, item, self, { tracker, time, animated: moving.has(item.id), reducedMotion });
  return batch.finish();
}

export { createMotionTracker, characterPose, characterState, MOTION_TWEEN_MS, LEANING_EXPRESSIONS, facingFrame, facingStep };
export default Object.freeze({
  appearanceFor, spriteAppearance, charactersScene, charactersVisualKey, characterNameplate, characterNameplates,
  renderableCharacters, animatedCharacters, nameplateTier, createMotionTracker, characterPose, characterState,
  characterBoxes, paintCharacter, decorationFor, silhouetteFor, emblemFor,
  CHARACTER_LIMITS, NAMEPLATE_LIMITS, BODY,
});
