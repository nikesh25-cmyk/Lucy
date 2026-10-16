// The authored content families: places, fixtures, activities, residents and ambient details.
//
// This module is the *schema plus the callable validator* for a content manifest. It is pure: it
// reads no file, imports no file system and touches no DOM, so the publication script, the tests and
// any future operator tool all run exactly the same rules. It imports `./footprints.js` — the one
// table the server, the renderer and pathfinding already share — and takes the sealed content
// resolver as an argument instead of importing it, so there is no cycle with `./content.js`.
//
// A refusal is a named reason, never a bare boolean. Every refusal carries:
//
//   code    one of REFUSAL_CODES — the category the operator sees
//   rule    the concrete rule inside that category (e.g. 'contrast-text', 'order-tiebreak')
//   source  where the rule comes from, when it comes from an existing project document
//   path    family/id/field, so the message points at the exact value
//   detail  what was found, in the operator's own data
//
// The validator never throws for a content problem: it collects refusals and returns them, so a
// preview can show *every* reason at once rather than the first one. It throws only for a caller
// error (a manifest that is not a document at all, or a bundle check with no resolver to check it
// against).
//
// Usage:
//   import content from './content.js';
//   import { validateContentFamilies, formatRefusal } from './content-manifest.js';
//   const result = validateContentFamilies(bundle, { content, worlds, occupied });
//   if (!result.ok) for (const refusal of result.refusals) console.error(formatRefusal(refusal));

import { SCENERY_CLASSES, TERRAIN_BLOCKING } from './footprints.js';

export const MANIFEST_SCHEMA_VERSION = 1;

/** The five families, in the order they are presented. */
export const CONTENT_FAMILIES = Object.freeze(['places', 'fixtures', 'activities', 'residents', 'ambient']);
/** Family → the `kind` its entries declare. */
export const FAMILY_KIND = Object.freeze({
  places: 'place', fixtures: 'fixture', activities: 'activity', residents: 'resident', ambient: 'ambient',
});
/** Kind → family, the inverse lookup the sealer and the bundle validator use. */
export const KIND_FAMILY = Object.freeze(Object.fromEntries(Object.entries(FAMILY_KIND).map(([family, kind]) => [kind, family])));

/**
 * Every refusal category the validator can name, and the one sentence an operator is shown for it.
 * The codes are the contract: tests/content-manifest.test.js reaches each one from a real manifest.
 */
export const REFUSAL_CODES = Object.freeze({
  'unknown-family': 'The manifest claims a family that is not one of the five authored families.',
  'schema-version': 'The manifest or one of its entries declares a schema version this validator does not speak.',
  'missing-field': 'A field the family requires is absent or empty.',
  'malformed-field': 'A field is present but is not the shape, type or range the family requires.',
  'missing-license': 'The entry carries no usable licence record, or a licence that contradicts its own provenance.',
  'missing-provenance': 'The entry does not record where its value came from, so its terms cannot be checked.',
  'unresolved-reference': 'A cross-family reference names an id that does not resolve to the kind it promises.',
  'duplicate-id': 'Two entries in the same manifest share one kind and id.',
  'id-collision': 'The id is already used by another kind, so a resolver could not promise which one it means.',
  'footprint-collision': 'A placed object, footprint or declared site disagrees with the space it claims, or collides with saved land, a plot, a block column or venue space.',
  accessibility: 'A declared accessibility value is below the rule this repository already enforces, or a route is unreachable.',
  nondeterminism: 'A value would differ between runs: a clock reading, a generated id, or an order that depends on the runtime locale.',
  'independence-claim': 'Text asserts endorsement, representation or official status, or the required independence statement is absent or vacuous.',
});

/**
 * The accessibility rules this validator enforces, each with the project document it comes from. A
 * declared value below a rule's minimum is refused; the number here is the floor, not a suggestion.
 */
export const ACCESSIBILITY_RULES = Object.freeze({
  'contrast-text': Object.freeze({
    minimum: 4.5, unit: 'ratio',
    source: 'WCAG 2.1 AA 1.4.3, the bar this repository already holds its mobile layer to (docs/MOBILE_ACCESSIBILITY.md, measured in tests/mobile-styles.test.js)',
  }),
  'contrast-nontext': Object.freeze({
    minimum: 3, unit: 'ratio',
    source: 'WCAG 2.1 AA 1.4.11, the bar the focus ring and the key edge are held to (docs/MOBILE_ACCESSIBILITY.md, tests/mobile-styles.test.js)',
  }),
  'hit-target': Object.freeze({
    minimum: 44, unit: 'px',
    source: 'the 44-pixel control floor stated and measured in docs/MOBILE_ACCESSIBILITY.md and asserted by tests/mobile-styles.test.js',
  }),
  'layout-390': Object.freeze({
    minimum: 390, unit: 'px',
    source: 'the 390-pixel phone width the atlas, the globe and the mobile layer must reflow to (docs/COUNTRY_ATLAS.md, docs/COUNTRY_GLOBE.md, docs/MOBILE_ACCESSIBILITY.md)',
  }),
  'reduced-motion': Object.freeze({
    source: 'animation is opt-in under prefers-reduced-motion: no-preference, and every animated declaration has a suppression (docs/MOBILE_ACCESSIBILITY.md §, docs/CONTROLS.md, tests/mobile-styles.test.js)',
  }),
  'walkable-route': Object.freeze({
    source: 'a country venue keeps its arrival, its return portal and the 16 x 16 plaza band walkable and free of mass scenery (world.js countryApproach and countryScenery, asserted by tests/country-venues.test.js)',
  }),
});

/**
 * The terrain vocabulary a place may author with. Two project sources, kept here as one list so a
 * mistyped tile is refused at validation rather than falling through the renderer's default branch:
 * `TERRAIN_BLOCKING` from src/footprints.js (the terrain a resident may not stand on) and the
 * walkable surfaces world.js paints (`meadow`, `path`, `plaza`, `garden`, `floor`, `rug`, `bridge`).
 */
export const TERRAIN_TYPES = Object.freeze([
  ...TERRAIN_BLOCKING, 'meadow', 'path', 'plaza', 'garden', 'floor', 'rug', 'bridge', 'farm',
]);
/** The site kinds a place may claim, and the machinery each one reuses. */
export const SITE_KINDS = Object.freeze(['country-variant', 'district', 'venue-plan']);

/** Key names that would make a manifest differ between two runs. Matched inside `rules` only. */
const NONDETERMINISTIC_KEYS = Object.freeze(new Set([
  'timestamp', 'timestamps', 'created_at', 'updated_at', 'generated_at', 'generated_by', 'now', 'date', 'datetime',
  'random', 'seed', 'uuid', 'guid', 'nonce', 'hostname', 'pid', 'epoch', 'epoch_ms', 'wall_clock',
]));
/** Values that are a clock reading rather than authored data. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/;
const EPOCH_DIGITS = /^\d{12,16}$/;
const GENERATED_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const GENERATOR_CALL = /Math\.random|Date\.now|randomUUID/;

/** Text that would claim endorsement, representation or official status. The disclaimer is exempt. */
const ENDORSEMENT = /\b(endorse\w*|accredit\w*|official status|official(?:ly)? represent\w*|appointed by|mandated by|acting for|on behalf of (?:the )?(?:government|ministry|state|united nations)|ministry of|united nations|u\.n\.)\b/i;
const DISCLAIMER_OPPOSITE = /\b(?:not|never|no)\b[^.]{0,80}\b(?:government|ministry|embassy|united nations)\b/i;
/** The text a reader sees, and only that: an id, a file path or a key name is not a claim. */
const SCANNED_TEXT = Object.freeze(new Set(['label', 'role', 'remit', 'machinery', 'clock', 'implements', 'note', 'notes', 'reuse']));

const HEX = /^#[0-9a-f]{6}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,100}$/;
const NOTICE_PATH = /^[A-Za-z0-9._/-]+$/;
const LICENSE_ALLOWLIST = Object.freeze(['LicenseRef-NemoWorld-Project-Authored', 'CC0-1.0']);

/** The structural fields every entry of a family must carry. Deeper values are checked per family. */
const REQUIRED = Object.freeze({
  place: ['site', 'structure', 'fixtures', 'activities', 'residents', 'ambient', 'independence', 'motion'],
  fixture: ['object', 'footprint', 'scenery_class', 'blocks_route', 'arrangement', 'tiles', 'owner', 'placement', 'provenance'],
  activity: ['place', 'residents', 'participants', 'cadence', 'duration_ticks', 'relates_to', 'motion', 'reduced_motion', 'ordering', 'clock', 'implements'],
  resident: ['place', 'role', 'appearance', 'schedule', 'dialogue_topics', 'remit', 'independence'],
  ambient: ['place', 'profile', 'time_of_day', 'layers', 'motion', 'reduced_motion', 'provenance'],
});
/** The families whose entries must record where the value came from, beyond the licence record. */
const PROVENANCE_REQUIRED = Object.freeze(['fixture', 'ambient']);
/** Which kind each reference field of a family must resolve to. */
const KIND_OF_REFERENCE = Object.freeze({
  place: [['fixtures', 'fixture'], ['activities', 'activity'], ['residents', 'resident'], ['ambient', 'ambient']],
  fixture: [['object', 'furniture'], ['owner', 'place']],
  activity: [['place', 'place'], ['residents', 'resident']],
  resident: [['place', 'place'], ['appearance', 'appearance']],
  ambient: [['place', 'place']],
});
/**
 * Fields which must resolve into the sealed layer but may name any kind. `relates_to` is the subject
 * an activity concerns — a grown crop, a crafted keepsake or a block — so it is deliberately not
 * pinned to one kind, and the ambiguity of `wood` (a shipped block and a shipped crop) is tolerated
 * here exactly because the activity makes no claim about which of the two it means.
 */
const SEALED_REFERENCES = Object.freeze({ activity: ['relates_to'] });

const has = (value, key) => Object.hasOwn(value, key);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const channels = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** The WCAG relative-contrast ratio, computed here rather than trusted from the manifest. */
export function contrastRatio(foreground, background) {
  if (!HEX.test(foreground || '') || !HEX.test(background || '')) return null;
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const round = (value) => Math.round(value * 100) / 100;

/** Freezes a refusal list into a deterministic order: code, then path, so two runs print the same report. */
function refuse(refusals) {
  return Object.freeze(refusals
    .map((refusal) => Object.freeze({ rule: null, source: null, ...refusal }))
    .sort((a, b) => a.code.localeCompare(b.code) || String(a.path).localeCompare(String(b.path))));
}

/** The one line an operator reads for a refusal. */
export function formatRefusal(refusal) {
  const where = refusal.path ? `${refusal.path}: ` : '';
  const rule = refusal.rule ? ` [${refusal.rule}]` : '';
  return `${refusal.code}${rule} — ${where}${refusal.detail}`;
}

/**
 * Validates one family manifest: `{ schema_version, family, entries: [...] }`, or any document with
 * an `entries` array whose family is inferred from its first entry.
 *
 * @param {object} manifest
 * @param {object} [options]
 * @param {object} [options.content]   the resolver from createContent(); without it, references are not resolved
 * @param {Map|object} [options.worlds] live world shapes by id: { columns, rows, start, portals }
 * @param {Map|object} [options.places] place definitions by id, for fixture geometry
 * @param {Set|string[]} [options.occupied] saved tiles that must not be taken, as `worldId|x,y`
 * @param {object} [options.notices]   the sealed notice map, for licence resolution
 * @param {string} [options.family]    overrides the inferred family
 * @returns {{ ok: boolean, family: string|null, refusals: readonly object[], checked: { entries: number } }}
 */
export function validateContentManifest(manifest, options = {}) {
  if (!isPlainObject(manifest)) throw new TypeError('content-manifest: a manifest document is required');
  if (!Array.isArray(manifest.entries)) {
    return Object.freeze({ ok: false, family: null, checked: { entries: 0 }, refusals: refuse([
      { code: 'missing-field', path: 'entries', detail: 'a content manifest must carry an entries array' },
    ]) });
  }
  const entries = manifest.entries;
  const family = options.family ?? manifest.family ?? (KIND_FAMILY[entries[0]?.kind] ?? null);
  if (!CONTENT_FAMILIES.includes(family)) {
    return Object.freeze({ ok: false, family: null, checked: { entries: entries.length }, refusals: refuse([
      { code: 'unknown-family', path: 'family', detail: `family is ${JSON.stringify(family)}; the five authored families are ${CONTENT_FAMILIES.join(', ')}` },
    ]) });
  }
  const refusals = [];
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    refusals.push({ code: 'schema-version', path: `${family}/schema_version`, detail: `a manifest must declare schema_version ${MANIFEST_SCHEMA_VERSION}, found ${JSON.stringify(manifest.schema_version)}` });
  }
  const seen = new Set();
  for (const [index, entry] of entries.entries()) checkEntry(entry, index, family, options, refusals, seen);
  checkOrderTiebreak(entries, family, refusals);
  return Object.freeze({ ok: refusals.length === 0, family, checked: { entries: entries.length }, refusals: refuse(refusals) });
}

/**
 * Validates every authored family in a sealed bundle at once, plus the collisions *between* families
 * and the five shipped kinds. This is the call the publication path makes before it writes anything.
 * `options.content` is required: a bundle check without a resolver would silently skip every
 * reference, which is exactly the failure this gate exists to prevent.
 */
export function validateContentFamilies(bundle, options = {}) {
  const list = Array.isArray(bundle?.entries) ? bundle.entries : null;
  if (!list) throw new TypeError('content-manifest: a bundle with an entries array is required');
  if (!options.content || typeof options.content.find !== 'function') throw new TypeError('content-manifest: options.content (the resolver from createContent) is required');
  const notices = options.notices ?? bundle?.notices?.notices ?? null;
  const places = new Map(options.places ? [...(options.places instanceof Map ? options.places : Object.entries(options.places))] : []);
  for (const entry of list) if (entry?.kind === 'place') places.set(entry.id, entry);
  const shared = { ...options, notices, places };
  const refusals = [];
  let checked = 0;
  for (const family of CONTENT_FAMILIES) {
    const entries = list.filter((entry) => KIND_FAMILY[entry?.kind] === family);
    const result = validateContentManifest({ schema_version: MANIFEST_SCHEMA_VERSION, family, entries }, { ...shared, family });
    checked += result.checked.entries;
    refusals.push(...result.refusals);
  }
  checkIdCollisions(list, refusals);
  return Object.freeze({
    ok: refusals.length === 0, family: null,
    checked: { entries: checked, families: CONTENT_FAMILIES.length },
    refusals: refuse(refusals),
  });
}

// ---------------------------------------------------------------------------------------------
// Per-entry rules
// ---------------------------------------------------------------------------------------------
function checkEntry(entry, index, family, options, refusals, seen) {
  const kind = FAMILY_KIND[family];
  const path = (field) => `${family}/${isPlainObject(entry) && text(entry.id) ? entry.id : `entries[${index}]`}${field ? `/${field}` : ''}`;
  const push = (code, field, detail, rule, source) => refusals.push({ code, path: path(field), detail, rule, source });
  if (!isPlainObject(entry)) { push('malformed-field', `entries[${index}]`, 'an entry must be an object'); return; }

  // ---- envelope -------------------------------------------------------------------------------
  if (!text(entry.id) || !IDENTIFIER.test(entry.id)) push('malformed-field', 'id', `id ${JSON.stringify(entry.id)} is not a bounded identifier`);
  else if (seen.has(entry.id)) push('duplicate-id', 'id', `id ${JSON.stringify(entry.id)} appears more than once in this manifest`);
  else seen.add(entry.id);
  if (entry.kind !== kind) push('malformed-field', 'kind', `a ${family} entry must declare kind "${kind}", found ${JSON.stringify(entry.kind)}`);
  if (entry.schema_version !== MANIFEST_SCHEMA_VERSION) push('schema-version', 'schema_version', `every entry must declare schema_version ${MANIFEST_SCHEMA_VERSION}, found ${JSON.stringify(entry.schema_version)}`);
  if (!text(entry.label)) push('missing-field', 'label', 'a non-empty label is required');
  if (!text(entry.since)) push('missing-field', 'since', 'a since version is required');
  if (!Number.isInteger(entry.order)) push('malformed-field', 'order', 'the authored order must be an integer, not null and not derived');
  if (!isPlainObject(entry.appearance)) push('missing-field', 'appearance', 'an appearance record is required');
  if (!isPlainObject(entry.rules) || !Array.isArray(entry.rules?.palettes)) push('missing-field', 'rules.palettes', 'rules must be an object carrying a palettes array');
  const rules = isPlainObject(entry.rules) ? entry.rules : {};

  checkLicense(entry, push, options);
  for (const field of REQUIRED[kind]) {
    if (!has(rules, field)) push('missing-field', `rules.${field}`, `a ${kind} requires rules.${field}`);
  }
  if (PROVENANCE_REQUIRED.includes(kind) && (!isPlainObject(rules.provenance) || !text(rules.provenance.derived_from))) {
    push('missing-provenance', 'rules.provenance', `a ${kind} must record rules.provenance.derived_from, so a reader can tell which sealed value it reuses`);
  }

  // ---- non-determinism ------------------------------------------------------------------------
  scanForNondeterminism(rules, path('rules'), refusals);
  if (rules.ordering !== undefined && rules.ordering !== 'authored') {
    push('nondeterminism', 'rules.ordering', `ordering must be "authored" so the presentation order is fixed by the definition, found ${JSON.stringify(rules.ordering)}`, 'authored-order');
  }
  if (isPlainObject(rules.cadence)) {
    const { jitter, offset, interval } = rules.cadence;
    if (!Number.isInteger(interval) || interval <= 0) push('malformed-field', 'rules.cadence.interval', 'a cadence interval must be a positive integer count of ticks');
    if (!Number.isInteger(offset) || offset < 0) push('malformed-field', 'rules.cadence.offset', 'a cadence offset must be a non-negative integer');
    if (!Number.isInteger(jitter) || jitter < 0) push('malformed-field', 'rules.cadence.jitter', 'a cadence jitter must be a non-negative integer');
    else if (jitter > 0 && !text(rules.jitter_source)) push('nondeterminism', 'rules.cadence.jitter', `jitter ${jitter} needs rules.jitter_source naming the authored input it is derived from`, 'authored-jitter');
  }
  if (Array.isArray(rules.schedule?.slots)) {
    const slots = rules.schedule.slots;
    if (slots.some((slot) => !Number.isInteger(slot) || slot < 0)) push('malformed-field', 'rules.schedule.slots', 'every slot must be a non-negative integer tick index');
    else if (slots.some((slot, at) => at > 0 && slot <= slots[at - 1])) push('nondeterminism', 'rules.schedule.slots', 'slots must strictly increase, so the loop cannot depend on the order a map happens to iterate in', 'ordered-slots');
  } else if (has(rules, 'schedule')) push('malformed-field', 'rules.schedule', 'a resident schedule must be an authored list of slot indices');

  // ---- per family -----------------------------------------------------------------------------
  if (kind === 'place') { checkPlace(entry, push, options); checkAccessibility(entry, push); checkIndependence(entry, push); }
  if (kind === 'fixture') checkFixture(entry, push, options);
  if (kind === 'activity') { checkActivity(entry, push); checkReducedMotion(entry, push); }
  if (kind === 'resident') { checkResident(entry, push); checkIndependence(entry, push); }
  if (kind === 'ambient') { checkAmbient(entry, push); checkReducedMotion(entry, push); }

  // ---- references -----------------------------------------------------------------------------
  for (const field of ['fixtures', 'activities', 'residents', 'relates_to', 'dialogue_topics']) {
    const ids = rules[field];
    if (ids === undefined || !Array.isArray(ids)) continue;
    if (ids.some((id) => typeof id === 'string' && id === entry.id)) push('unresolved-reference', `rules.${field}`, `a ${kind} cannot reference itself`);
  }
  for (const [field, expected] of KIND_OF_REFERENCE[kind] || []) {
    const value = rules[field];
    if (value == null) continue;
    const ids = [].concat(value);
    if (!ids.length) { push('malformed-field', `rules.${field}`, `rules.${field} must list at least one id`); continue; }
    if (new Set(ids).size !== ids.length) push('duplicate-id', `rules.${field}`, `rules.${field} lists a duplicate id`);
    for (const id of ids) {
      if (!text(id)) { push('malformed-field', `rules.${field}`, `rules.${field} must name ids`); continue; }
      if (!options.content) continue;
      const matches = options.content.find(id);
      if (!matches.length) push('unresolved-reference', `rules.${field}`, `${id} resolves to no definition in the sealed layer`);
      else if (!matches.some((item) => item.kind === expected)) push('unresolved-reference', `rules.${field}`, `${id} resolves to ${matches.map((item) => item.kind).join(', ')}, not a ${expected}`);
      else if (matches.length > 1) push('id-collision', `rules.${field}`, `${id} is used by more than one kind (${matches.map((item) => item.kind).join(', ')}), so a resolver cannot promise which one a ${expected} reference means`);
    }
  }
  for (const field of SEALED_REFERENCES[kind] || []) {
    const ids = [].concat(rules[field] ?? []);
    for (const id of ids) {
      if (!text(id)) { push('malformed-field', `rules.${field}`, `rules.${field} must name ids`); continue; }
      if (options.content && !options.content.find(id).length) push('unresolved-reference', `rules.${field}`, `${id} resolves to no definition in the sealed layer`);
    }
  }
  if (options.content && text(entry.id) && IDENTIFIER.test(entry.id)) {
    const matches = options.content.find(entry.id).filter((item) => item.kind !== entry.kind);
    if (matches.length) push('id-collision', 'id', `id ${JSON.stringify(entry.id)} is already used by ${matches.map((item) => item.kind).join(', ')} in the sealed layer`);
  }
}

function checkLicense(entry, push, options) {
  const license = entry.license;
  if (!isPlainObject(license)) { push('missing-license', 'license', 'a licence record is required on every entry'); return; }
  if (!LICENSE_ALLOWLIST.includes(license.spdx)) push('missing-license', 'license.spdx', `${JSON.stringify(license.spdx)} is not one of the evidenced identifiers ${LICENSE_ALLOWLIST.join(', ')}`);
  for (const field of ['author', 'source', 'notice_file']) if (!text(license[field])) push('missing-license', `license.${field}`, `license.${field} must be a non-empty string`);
  if (!text(license.note)) push('missing-provenance', 'license.note', 'the licence note must state how this value was obtained');
  if (text(license.notice_file) && (!NOTICE_PATH.test(license.notice_file) || license.notice_file.startsWith('/') || license.notice_file.includes('..'))) {
    push('malformed-field', 'license.notice_file', 'the notice file must be a repository-relative path');
  }
  if (!DIGEST.test(license.notice_sha256 || '')) push('missing-license', 'license.notice_sha256', 'the notice digest must be a sha256 hex digest');
  if (options.notices) {
    if (text(license.notice_file) && !has(options.notices, license.notice_file)) push('missing-license', 'license.notice_file', `no sealed notice is recorded for ${license.notice_file}, so the entry's terms cannot be resolved`);
    else if (text(license.notice_file) && license.notice_sha256 !== options.notices[license.notice_file]) push('missing-license', 'license.notice_sha256', `the recorded notice digest does not match the sealed digest for ${license.notice_file}`);
  }
  if (license.spdx === 'CC0-1.0' && !/^[a-f0-9]{40}$/.test(license.commit || '')) push('missing-provenance', 'license.commit', 'a CC0 value must pin the 40-character commit it was taken from');
  if (license.spdx === 'LicenseRef-NemoWorld-Project-Authored' && license.commit != null) push('missing-provenance', 'license.commit', 'project-authored work must have commit null, because it comes from no upstream revision');
  if (text(license.source) && !/^[a-z]+:/i.test(license.source) && !/^Original /.test(license.source)) push('missing-provenance', 'license.source', 'the source must name a URL or state plainly that the work is original to this project');
}

function checkPlace(entry, push, options) {
  const { site, structure } = entry.rules;
  if (!isPlainObject(site)) { push('missing-field', 'rules.site', 'a place must declare the site it occupies'); return; }
  for (const field of ['kind', 'world', 'columns', 'rows', 'arrival', 'portal', 'plaza', 'band_rule', 'registers_land', 'machinery']) {
    if (!has(site, field)) push('missing-field', `rules.site.${field}`, `a place site declares ${field}`);
  }
  if (!SITE_KINDS.includes(site.kind)) push('malformed-field', 'rules.site.kind', `a site kind is one of ${SITE_KINDS.join(', ')}; found ${JSON.stringify(site.kind)}`);
  if (!IDENTIFIER.test(site.world || '') || !site.world.includes(':')) push('malformed-field', 'rules.site.world', `site.world must name the world id the site reuses, found ${JSON.stringify(site.world)}`);
  for (const field of ['columns', 'rows']) if (!Number.isInteger(site[field]) || site[field] <= 0) push('malformed-field', `rules.site.${field}`, `${field} must be a positive integer`);
  if (!['clear-of-mass', 'none'].includes(site.band_rule)) push('malformed-field', 'rules.site.band_rule', 'band_rule is clear-of-mass or none');
  if (site.registers_land !== false) push('footprint-collision', 'rules.site.registers_land', 'a shared venue or district registers no land; a place that claims it does would move the plot registry');
  if (site.kind === 'country-variant' && !(site.venue && site.iso3 === String(site.world).split(':')[1])) push('malformed-field', 'rules.site.iso3', `a country variant names the venue shape it reuses and the catalog entry it is assigned to; found venue ${JSON.stringify(site.venue)} for ${JSON.stringify(site.world)}`);
  if (site.kind === 'district' && !text(site.region)) push('missing-field', 'rules.site.region', 'a district site names the region record it reuses');
  if (site.kind === 'venue-plan' && !text(site.plan)) push('missing-field', 'rules.site.plan', 'a venue plan site names the public venue plan it reuses');
  if (!text(site.machinery)) push('missing-field', 'rules.site.machinery', 'a place must state the venue machinery it reuses');
  if (!isPlainObject(structure) || !text(structure.kind)) push('missing-field', 'rules.structure.kind', 'a place must name the structure it authors');
  else {
    if (!Array.isArray(structure.terrain) || !structure.terrain.length) push('missing-field', 'rules.structure.terrain', 'a place must list the terrain vocabulary it uses');
    else for (const type of structure.terrain) if (!TERRAIN_TYPES.includes(type)) push('malformed-field', 'rules.structure.terrain', `${JSON.stringify(type)} is not a terrain type the shared table and world.js know`);
    if (typeof structure.water !== 'boolean') push('malformed-field', 'rules.structure.water', 'structure.water must be a boolean');
    if (!Number.isInteger(structure.elevation_steps) || structure.elevation_steps < 1) push('malformed-field', 'rules.structure.elevation_steps', 'a structure has at least one elevation step');
    if (!isPlainObject(structure.approach) || !Array.isArray(structure.approach.at)) push('missing-field', 'rules.structure.approach', 'a place must declare the public approach its mass scenery keeps off');
  }
  for (const field of ['arrival', 'portal']) {
    if (!isPlainObject(site[field])) { push('missing-field', `rules.site.${field}`, `${field} must be a point`); continue; }
    if (site[field].x < 0 || site[field].y < 0 || site[field].x >= site.columns || site[field].y >= site.rows) {
      push('footprint-collision', `rules.site.${field}`, `${field} (${site[field].x}, ${site[field].y}) is outside the ${site.columns} x ${site.rows} site`);
    }
  }
  if (isPlainObject(site.arrival) && isPlainObject(site.portal) && site.kind !== 'district') {
    // A country venue and a public venue plan both open onto their own arrival, so the return portal
    // is on that tile or the one beside it. A district is the regional case: `makeDistrict` roads in
    // from its south edge and puts the return portal there, so its portal is legitimately far from
    // the arrival and only has to be inside the site.
    const distance = Math.abs(site.arrival.x - site.portal.x) + Math.abs(site.arrival.y - site.portal.y);
    if (distance > 1) {
      push('accessibility', 'rules.site.portal', `a ${site.kind} returns from its own arrival, so the portal must stand on the arrival tile or the tile beside it; found it ${distance} tiles away`, 'walkable-route', ACCESSIBILITY_RULES['walkable-route'].source);
    }
  }
  const live = lookup(options.worlds, site.world);
  if (live) {
    if (Number.isInteger(live.columns) && site.columns !== live.columns) push('footprint-collision', 'rules.site.columns', `the live world ${site.world} is ${live.columns} wide; a place that republishes it differently would move saved placements`, 'live-world-shape');
    if (Number.isInteger(live.rows) && site.rows !== live.rows) push('footprint-collision', 'rules.site.rows', `the live world ${site.world} is ${live.rows} tall; a place that republishes it differently would move saved placements`, 'live-world-shape');
    if (live.start && site.arrival && (site.arrival.x !== live.start.x || site.arrival.y !== live.start.y)) {
      push('footprint-collision', 'rules.site.arrival', `the live world ${site.world} starts at (${live.start.x}, ${live.start.y}); a content update may not move a saved arrival`, 'live-arrival');
    }
    const first = live.portals?.[0];
    if (first && site.portal && (site.portal.x !== first.x || site.portal.y !== first.y)) {
      push('footprint-collision', 'rules.site.portal', `the live world ${site.world} returns from (${first.x}, ${first.y})`, 'live-portal');
    }
  }
  if (options.occupied) {
    const taken = options.occupied instanceof Set ? options.occupied : new Set(options.occupied);
    for (const point of [site.arrival, site.portal]) {
      if (!isPlainObject(point)) continue;
      const key = `${site.world}|${point.x},${point.y}`;
      if (taken.has(key)) push('footprint-collision', 'rules.site', `${key} is already held by a saved plot or block column`, 'saved-land');
    }
  }
}

function checkFixture(entry, push, options) {
  const rules = entry.rules;
  const object = rules.object;
  const expectedClass = text(object) && has(SCENERY_CLASSES, object) ? SCENERY_CLASSES[object] : null;
  if (expectedClass === null) push('unresolved-reference', 'rules.object', `${JSON.stringify(object)} is not a type in the shared footprint table`);
  else if (rules.scenery_class !== expectedClass) {
    push('footprint-collision', 'rules.scenery_class', `${object} is classed ${expectedClass} by src/footprints.js; the fixture declares ${JSON.stringify(rules.scenery_class)}`, 'shared-footprint-table');
  }
  if (rules.blocks_route !== (rules.scenery_class === 'mass')) {
    push('footprint-collision', 'rules.blocks_route', `blocks_route must be true exactly when the fixture is a mass, found ${JSON.stringify(rules.blocks_route)} for class ${JSON.stringify(rules.scenery_class)}`, 'shared-footprint-table');
  }
  if (!['occupied', 'open'].includes(rules.footprint)) push('malformed-field', 'rules.footprint', 'footprint is occupied or open');
  if (!['ground', 'water'].includes(rules.placement?.on)) push('malformed-field', 'rules.placement.on', 'placement.on is ground or water');
  if (!text(rules.owner)) push('missing-field', 'rules.owner', 'a fixture must name the place it belongs to');
  if (options.content && text(object)) {
    const furniture = options.content.entry(object, 'furniture');
    if (furniture) {
      if (rules.footprint !== furniture.rules?.footprint) push('footprint-collision', 'rules.footprint', `${object} declares footprint ${JSON.stringify(furniture.rules?.footprint)} in its own definition; the fixture repeats ${JSON.stringify(rules.footprint)}`, 'sealed-furniture-rule');
      if (entry.appearance?.geometry !== furniture.appearance?.geometry) push('malformed-field', 'appearance.geometry', `a fixture draws the sealed builder ${JSON.stringify(furniture.appearance?.geometry)}, not ${JSON.stringify(entry.appearance?.geometry)}`, 'sealed-furniture-geometry');
    }
  }
  if (!Array.isArray(rules.tiles) || !rules.tiles.length) { push('malformed-field', 'rules.tiles', 'a fixture must list the tiles it occupies'); return; }
  const keys = new Set();
  for (const tile of rules.tiles) {
    if (!Array.isArray(tile) || tile.length !== 2 || tile.some((value) => !Number.isInteger(value))) { push('malformed-field', 'rules.tiles', `${JSON.stringify(tile)} is not an integer [x, y] tile`); continue; }
    const key = `${tile[0]},${tile[1]}`;
    if (keys.has(key)) push('footprint-collision', 'rules.tiles', `tile ${key} is claimed twice by one fixture`, 'self-overlap');
    keys.add(key);
  }
  if (!isPlainObject(rules.arrangement)) push('missing-field', 'rules.arrangement', 'a fixture must declare how its tiles are arranged');
  else {
    if (!Number.isInteger(rules.arrangement.count) || rules.arrangement.count <= 0) push('malformed-field', 'rules.arrangement.count', 'count must be a positive integer');
    else if (rules.arrangement.count !== rules.tiles.length) push('malformed-field', 'rules.arrangement.count', `count ${rules.arrangement.count} does not match the ${rules.tiles.length} authored tiles`, 'count-matches-tiles');
    if (!Number.isInteger(rules.arrangement.spacing) || rules.arrangement.spacing < 0) push('malformed-field', 'rules.arrangement.spacing', 'spacing must be a non-negative integer');
  }

  // Geometry against the place the fixture belongs to: bounds, the walkable band, the approach road
  // and the arrival, and whether the tile it claims is water.
  const place = options.content && text(rules.owner) ? options.content.entry(rules.owner, 'place') : null;
  const authored = place ? null : lookup(options.places, rules.owner);
  const site = (place ?? authored)?.rules?.site;
  if (text(rules.owner) && !place && !authored) push('unresolved-reference', 'rules.owner', `${rules.owner} is not a place definition`);
  if (!site) return;
  const water = waterTiles((authored ?? place)?.rules?.structure, site);
  const inBand = isPlainObject(site.plaza) && (([x, y]) => x >= site.plaza.x && x < site.plaza.x + site.plaza.width && y >= site.plaza.y && y < site.plaza.y + site.plaza.height);
  for (const tile of rules.tiles) {
    if (!Array.isArray(tile) || tile.some((value) => !Number.isInteger(value))) continue;
    const [x, y] = tile;
    if (x < 0 || y < 0 || x >= site.columns || y >= site.rows) {
      push('footprint-collision', 'rules.tiles', `tile ${x},${y} is outside the ${site.columns} x ${site.rows} site of ${rules.owner}`, 'site-bounds');
      continue;
    }
    if (site.arrival && site.arrival.x === x && site.arrival.y === y) push('footprint-collision', 'rules.tiles', `tile ${x},${y} is the arrival of ${rules.owner}`, 'arrival-occupied');
    if (site.portal && site.portal.x === x && site.portal.y === y) push('footprint-collision', 'rules.tiles', `tile ${x},${y} is the return portal of ${rules.owner}`, 'portal-occupied');
    const isWater = water.has(`${x},${y}`);
    if (rules.scenery_class === 'mass' && site.band_rule === 'clear-of-mass' && inBand(tile)) {
      push('footprint-collision', 'rules.tiles', `tile ${x},${y} is inside the walkable plaza band of ${rules.owner}, which a country venue keeps clear of mass scenery`, 'plaza-band-clear');
    }
    if (rules.scenery_class === 'mass' && rules.placement?.on === 'ground' && isWater) {
      push('footprint-collision', 'rules.tiles', `tile ${x},${y} is declared water, so a ground mass may not stand on it`, 'water-occupied');
    }
    if (rules.placement?.on === 'water' && !isWater) {
      push('footprint-collision', 'rules.tiles', `tile ${x},${y} is not declared water, so a mooring may not claim it`, 'mooring-not-on-water');
    }
    if (options.occupied) {
      const taken = options.occupied instanceof Set ? options.occupied : new Set(options.occupied);
      if (taken.has(`${site.world}|${x},${y}`)) push('footprint-collision', 'rules.tiles', `${site.world}|${x},${y} is already held by a saved plot or block column`, 'saved-land');
    }
  }
  // The approach corridor a country venue roads from its north edge must stay passable.
  const approach = (authored ?? place)?.rules?.structure?.approach;
  if (rules.scenery_class === 'mass' && isPlainObject(approach) && Array.isArray(approach.at)) {
    for (const tile of rules.tiles) {
      if (!Array.isArray(tile)) continue;
      const [x, y] = tile;
      const onCorridor = approach.axis === 'y' ? approach.at.includes(x) && y >= approach.from && y <= approach.to
        : approach.at.includes(y) && x >= approach.from && x <= approach.to;
      if (onCorridor) push('footprint-collision', 'rules.tiles', `tile ${x},${y} blocks the public approach corridor of ${rules.owner}`, 'approach-blocked');
    }
  }
}

/** The tiles the structure declares as water: the channels it names and its shore strip. */
function waterTiles(structure, site) {
  const keys = new Set();
  if (!isPlainObject(structure)) return keys;
  for (const channel of structure.channels || []) {
    if (!isPlainObject(channel) || !Array.isArray(channel.at)) continue;
    if (channel.axis === 'y') for (const x of channel.at) for (let y = 0; y < site.rows; y++) keys.add(`${x},${y}`);
    if (channel.axis === 'x') for (const y of channel.at) for (let x = 0; x < site.columns; x++) keys.add(`${x},${y}`);
  }
  const shore = structure.shore;
  if (isPlainObject(shore) && Number.isInteger(shore.below)) {
    if (shore.axis === 'x') for (let x = 0; x < shore.below; x++) for (let y = 0; y < site.rows; y++) keys.add(`${x},${y}`);
    if (shore.axis === 'y') for (let y = 0; y < shore.below; y++) for (let x = 0; x < site.columns; x++) keys.add(`${x},${y}`);
  }
  return keys;
}

function checkActivity(entry, push) {
  const rules = entry.rules;
  if (!Number.isInteger(rules.duration_ticks) || rules.duration_ticks <= 0) push('malformed-field', 'rules.duration_ticks', 'duration_ticks must be a positive integer');
  if (!isPlainObject(rules.participants)) push('missing-field', 'rules.participants', 'an activity declares how many residents take part');
  else {
    const { min, max } = rules.participants;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) push('malformed-field', 'rules.participants', `participants need 1 <= min <= max, found ${JSON.stringify(min)} and ${JSON.stringify(max)}`);
    else if (max > 4) push('malformed-field', 'rules.participants', `an authored activity holds at most four residents, found ${max}`);
  }
  if (!Array.isArray(rules.relates_to)) push('missing-field', 'rules.relates_to', 'an activity lists the sealed ids it concerns, even when the list is empty');
  if (!['none', 'drift'].includes(rules.motion)) push('malformed-field', 'rules.motion', 'motion is none or drift');
  if (!text(rules.implements)) push('missing-field', 'rules.implements', 'an activity must state the machinery it is expected to run through');
}

function checkResident(entry, push) {
  const rules = entry.rules;
  if (!text(rules.role) || rules.role.length > 60) push('malformed-field', 'rules.role', 'role must be a short non-empty label');
  if (!text(rules.remit)) push('missing-field', 'rules.remit', 'a resident must state its remit, so what it may answer for is checkable');
  if (!Array.isArray(rules.dialogue_topics) || !rules.dialogue_topics.length) push('missing-field', 'rules.dialogue_topics', 'a resident lists the topics it accepts');
  else for (const topic of rules.dialogue_topics) if (!text(topic) || topic.length > 80) push('malformed-field', 'rules.dialogue_topics', `${JSON.stringify(topic)} is not a bounded topic label`);
}

function checkAmbient(entry, push) {
  const rules = entry.rules;
  if (!text(rules.profile)) push('missing-field', 'rules.profile', 'an ambient profile names the layer family it belongs to');
  const slotWindow = rules.time_of_day;
  if (!isPlainObject(slotWindow) || slotWindow.unit !== 'tick' || !Number.isInteger(slotWindow.start) || !Number.isInteger(slotWindow.end) || slotWindow.start < 0 || slotWindow.end <= slotWindow.start) {
    push('malformed-field', 'rules.time_of_day', 'time_of_day must be an ordered tick window: { unit: "tick", start, end } with 0 <= start < end');
  }
  if (!Array.isArray(rules.layers) || !rules.layers.length) { push('missing-field', 'rules.layers', 'an ambient profile needs at least one layer'); return; }
  const seen = new Set();
  for (const layer of rules.layers) {
    if (!isPlainObject(layer) || !text(layer.key)) { push('malformed-field', 'rules.layers', 'every layer needs a key'); continue; }
    if (seen.has(layer.key)) push('duplicate-id', 'rules.layers', `layer ${layer.key} appears twice`);
    seen.add(layer.key);
    if (!HEX.test(layer.color || '')) push('malformed-field', 'rules.layers.color', `layer ${layer.key} needs a #rrggbb colour, found ${JSON.stringify(layer.color)}`);
    if (typeof layer.opacity !== 'number' || !(layer.opacity > 0 && layer.opacity <= 1)) push('malformed-field', 'rules.layers.opacity', `layer ${layer.key} opacity must be above 0 and at most 1`);
    if (!['none', 'drift'].includes(layer.motion)) push('malformed-field', 'rules.layers.motion', `layer ${layer.key} motion is none or drift`);
    else if (layer.motion === 'drift' && rules.motion === 'none') push('accessibility', 'rules.layers.motion', `layer ${layer.key} drifts while the profile declares no motion, so the profile understates what it does`, 'reduced-motion', ACCESSIBILITY_RULES['reduced-motion'].source);
  }
}

/** The independence rule: a fictional host never becomes an office, and the disclaimer must not be vacuous. */
function checkIndependence(entry, push) {
  const independence = entry.rules?.independence;
  if (!isPlainObject(independence)) { push('independence-claim', 'rules.independence', 'the entry must record its independence explicitly'); return; }
  if (independence.fictional !== true) push('independence-claim', 'rules.independence.fictional', 'fictional must be true');
  if (independence.claims_endorsement !== false) push('independence-claim', 'rules.independence.claims_endorsement', 'claims_endorsement must be false: nothing in this content may assert endorsement');
  if (independence.government_role !== false) push('independence-claim', 'rules.independence.government_role', 'government_role must be false: a host is never a government or ministry role');
  if (independence.un_role !== false) push('independence-claim', 'rules.independence.un_role', 'un_role must be false: a host is never a United Nations role');
  if (!text(independence.statement)) { push('independence-claim', 'rules.independence.statement', 'the disclaimer must be stated in words'); return; }
  if (!DISCLAIMER_OPPOSITE.test(independence.statement)) {
    push('independence-claim', 'rules.independence.statement', 'the disclaimer must actually negate an institution: it has to say that the space is not a government, ministry, embassy or United Nations office', 'non-vacuous-disclaimer');
  }
  for (const [where, value] of visibleText(entry)) {
    if (where === 'independence.statement') continue;
    if (ENDORSEMENT.test(value)) {
      push('independence-claim', `rules.${where}`, `${JSON.stringify(value.slice(0, 90))} claims endorsement, representation or official status`, 'no-endorsement-claim');
    }
  }
}

function checkAccessibility(entry, push) {
  const access = entry.rules?.accessibility;
  if (!isPlainObject(access)) { push('missing-field', 'rules.accessibility', 'a place must declare the accessibility floor it is authored against'); return; }
  if (!Number.isInteger(access.hit_target_px) || access.hit_target_px < ACCESSIBILITY_RULES['hit-target'].minimum) {
    push('accessibility', 'rules.accessibility.hit_target_px', `hit target ${JSON.stringify(access.hit_target_px)} is below the ${ACCESSIBILITY_RULES['hit-target'].minimum} px floor`, 'hit-target', ACCESSIBILITY_RULES['hit-target'].source);
  }
  if (!Number.isInteger(access.min_viewport_px) || access.min_viewport_px < ACCESSIBILITY_RULES['layout-390'].minimum) {
    push('accessibility', 'rules.accessibility.min_viewport_px', `minimum viewport ${JSON.stringify(access.min_viewport_px)} is below the ${ACCESSIBILITY_RULES['layout-390'].minimum} px width the layout must reflow to`, 'layout-390', ACCESSIBILITY_RULES['layout-390'].source);
  }
  if (!text(access.route)) push('missing-field', 'rules.accessibility.route', 'a place must name the non-pointer route to it');
  if (!Array.isArray(access.contrast) || !access.contrast.length) { push('missing-field', 'rules.accessibility.contrast', 'a place must declare the colour pairs it is read in'); checkReducedMotion(entry, push, access); return; }
  for (const pair of access.contrast) {
    const role = pair?.role === 'text' ? 'text' : pair?.role === 'nontext' ? 'nontext' : null;
    if (!role) { push('malformed-field', 'rules.accessibility.contrast', `role is text or nontext, found ${JSON.stringify(pair?.role)}`); continue; }
    const name = role === 'text' ? 'contrast-text' : 'contrast-nontext';
    const bar = ACCESSIBILITY_RULES[name];
    if (typeof pair.target !== 'number' || pair.target < bar.minimum) {
      push('accessibility', 'rules.accessibility.contrast', `the declared ${role} target ${JSON.stringify(pair.target)} is below the ${bar.minimum}:1 this repository enforces; relaxing the bar is refused`, name, bar.source);
    }
    const measured = contrastRatio(pair.foreground, pair.background);
    if (measured === null) { push('malformed-field', 'rules.accessibility.contrast', `${JSON.stringify(pair.foreground)} on ${JSON.stringify(pair.background)} is not a pair of #rrggbb colours`); continue; }
    if (measured < bar.minimum) push('accessibility', 'rules.accessibility.contrast', `${pair.foreground} on ${pair.background} measures ${round(measured)}:1 for ${role}, below the ${bar.minimum}:1 minimum`, name, bar.source);
  }
  checkReducedMotion(entry, push, access);
}

/**
 * Reduced motion is a biconditional: a profile that moves must state the still equivalent it holds,
 * and one that does not move must not claim an equivalent it does not have.
 */
function checkReducedMotion(entry, push, access = entry.rules?.accessibility) {
  const declared = entry.rules.reduced_motion ?? access?.reduced_motion;
  const moves = entry.rules.motion !== undefined ? entry.rules.motion !== 'none'
    : Array.isArray(entry.rules.layers) && entry.rules.layers.some((layer) => layer?.motion === 'drift');
  if (declared === undefined) { push('missing-field', 'rules.reduced_motion', 'every authored profile states what happens under a reduced-motion preference'); return; }
  if (moves && declared !== 'equivalent-still') {
    push('accessibility', 'rules.reduced_motion', `the profile moves (${JSON.stringify(entry.rules.motion ?? 'layer drift')}), so it must state "equivalent-still" or the motion has no suppression`, 'reduced-motion', ACCESSIBILITY_RULES['reduced-motion'].source);
  }
  if (!moves && declared !== 'not-needed') {
    push('accessibility', 'rules.reduced_motion', `the profile does not move, so it must state "not-needed" rather than claiming an equivalent it does not have; found ${JSON.stringify(declared)}`, 'reduced-motion', ACCESSIBILITY_RULES['reduced-motion'].source);
  }
}

/** Rejects a value that would differ between two runs of the same manifest. */
function scanForNondeterminism(value, where, refusals, depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) scanForNondeterminism(item, `${where}[${index}]`, refusals, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    const path = `${where}.${key}`;
    if (NONDETERMINISTIC_KEYS.has(key.toLowerCase())) refusals.push({ code: 'nondeterminism', path, detail: `"${key}" reads a clock or a generator, so the manifest would differ between runs`, rule: 'no-clock-field' });
    if (typeof item === 'string') {
      if (ISO_DATE.test(item)) refusals.push({ code: 'nondeterminism', path, detail: `${JSON.stringify(item)} is a date, not authored data`, rule: 'no-date-value' });
      else if (EPOCH_DIGITS.test(item)) refusals.push({ code: 'nondeterminism', path, detail: `${JSON.stringify(item)} looks like an epoch reading`, rule: 'no-epoch-value' });
      else if (GENERATED_ID.test(item)) refusals.push({ code: 'nondeterminism', path, detail: `${JSON.stringify(item.slice(0, 40))} is a generated id or digest rather than authored data`, rule: 'no-generated-id' });
      if (GENERATOR_CALL.test(item)) refusals.push({ code: 'nondeterminism', path, detail: `${JSON.stringify(item.slice(0, 60))} names a generator, so the value would differ between runs`, rule: 'no-generator-call' });
    }
    if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) >= 1e12) refusals.push({ code: 'nondeterminism', path, detail: `${item} is in the millisecond-epoch range`, rule: 'no-epoch-value' });
    scanForNondeterminism(item, path, refusals, depth + 1);
  }
}

/**
 * Two definitions of one family may not share an `order`. The resolver in src/content.js breaks that
 * tie with String.prototype.localeCompare, whose result depends on the runtime locale — 'a-umlaut'
 * sorts before 'z' in an English collation and after it in a Swedish one. A shared order would
 * present the family in a different sequence on a different machine, so it is refused rather than
 * left to the environment.
 */
function checkOrderTiebreak(entries, family, refusals) {
  const byOrder = new Map();
  for (const entry of entries) {
    if (!Number.isInteger(entry?.order)) continue;
    const seen = byOrder.get(entry.order);
    if (seen) {
      refusals.push({
        code: 'nondeterminism', path: `${family}/${entry.id}/order`, rule: 'order-tiebreak',
        detail: `order ${entry.order} is also used by ${seen}; the resolver would break the tie with localeCompare, whose result depends on the runtime locale`,
      });
    } else byOrder.set(entry.order, entry.id);
  }
}

/** One id, one kind. Two kinds sharing an id make the resolver's no-kind lookup ambiguous. */
function checkIdCollisions(list, refusals) {
  const byId = new Map();
  for (const entry of list) {
    if (typeof entry?.id !== 'string') continue;
    if (!byId.has(entry.id)) byId.set(entry.id, new Set());
    byId.get(entry.id).add(entry.kind);
  }
  for (const [id, kinds] of byId) {
    if (kinds.size < 2) continue;
    const authored = [...kinds].filter((kind) => KIND_FAMILY[kind]);
    if (!authored.length) continue; // 'wood' is a shipped block and a shipped crop; that predates this layer.
    refusals.push({ code: 'id-collision', path: `id/${id}`, detail: `${id} is used by ${[...kinds].sort().join(', ')}; an authored family id must not collide with another kind` });
  }
}

const lookup = (map, key) => !map || key == null ? undefined : map instanceof Map ? map.get(key) : map[key];

/** Every string a reader sees, as `[path, value]`, so a claim cannot hide in a nested label. */
function visibleText(entry) {
  const found = [];
  const walk = (value, path, depth) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      const leaf = path.split('.').pop();
      if (SCANNED_TEXT.has(leaf)) found.push([path, value]);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, path, depth + 1); return; }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key, depth + 1);
  };
  walk(entry.rules ?? {}, '', 0);
  walk(entry.notes ?? [], 'notes', 0);
  return found;
}

export default Object.freeze({
  MANIFEST_SCHEMA_VERSION, CONTENT_FAMILIES, FAMILY_KIND, KIND_FAMILY, REFUSAL_CODES, ACCESSIBILITY_RULES,
  TERRAIN_TYPES, SITE_KINDS, contrastRatio, formatRefusal, validateContentManifest, validateContentFamilies,
});
