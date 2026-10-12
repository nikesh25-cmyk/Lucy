// Typed content definitions: a resolver layer over content/**, with no file system and no DOM, so
// the browser client (app.js) and the server (server.js) can both import it.
//
// Every definition carries its own license record, and load-time validation refuses to resolve a
// definition that has no license identifier, no resolvable notice file or a palette reference that
// points at nothing. The definitions themselves are data: this module never writes them.
//
// Usage:
//   import { palette, color, crops, recipes, appearancesFor } from './content.js';
//   palette('frontier');            // ['stone', 'wood', ...]
//   color('wood');                  // '#b58c58'
//   appearancesFor('civic-mayor');  // the 20 roster appearances, in roster order
//
// A caller that already holds the definitions (a fetch in the browser, a read in Node) can inject
// them instead of using the bundled default: createContent({ entries, palettes, notices, manifest }).

import bundle from '../content/index.js';

export const SCHEMA_VERSION = 1;
export const CONTENT_KINDS = Object.freeze(['block', 'furniture', 'crop', 'appearance', 'cosmetic']);

const HEX = /^#[a-f\d]{6}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,100}$/;

const fail = (message) => { throw new Error(`content: ${message}`); };
const has = (value, key) => Object.hasOwn(value, key);
const sorted = (items) => [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
};

/** Throws a descriptive error when the definitions are unusable. Pure: no files are read. */
export function validateBundle(input) {
  if (!input || typeof input !== 'object') fail('a bundle with entries, palettes, notices and manifest is required');
  const { entries, palettes, notices, manifest } = input;
  if (!Array.isArray(entries) || !entries.length) fail('the bundle must contain definition entries');
  if (!palettes?.palettes || typeof palettes.palettes !== 'object') fail('the bundle must contain palettes.json');
  if (!notices?.notices || typeof notices.notices !== 'object') fail('the bundle must contain notices.json');
  if (!Array.isArray(manifest?.entries)) fail('the bundle must contain content-manifest.json');
  for (const [name, document] of [['content-manifest.json', manifest], ['palettes.json', palettes], ['notices.json', notices]]) {
    if (document.schema_version !== SCHEMA_VERSION) fail(`${name} must declare schema_version ${SCHEMA_VERSION}, found ${JSON.stringify(document.schema_version)}`);
  }

  const record = new Map();
  for (const item of manifest.entries) {
    if (typeof item?.id !== 'string' || !CONTENT_KINDS.includes(item.kind)) fail(`content-manifest.json: invalid entry ${JSON.stringify(item?.id)}`);
    const key = `${item.kind}:${item.id}`;
    if (record.has(key)) fail(`content-manifest.json: duplicate index entry ${key}`);
    if (typeof item.file !== 'string' || !item.file.endsWith('.json')) fail(`${item.file}: the manifest must record the definition file`);
    if (!DIGEST.test(item.sha256 || '')) fail(`${item.file}: the manifest must record a sha256 digest`);
    for (const asset of item.assets || []) if (!DIGEST.test(asset.sha256 || '')) fail(`${item.file}: asset ${asset.path} has no sha256 digest`);
    record.set(key, item);
  }

  const byKind = new Map(CONTENT_KINDS.map((kind) => [kind, new Map()]));
  for (const entry of entries) {
    if (entry?.schema_version !== SCHEMA_VERSION) fail(`${entry?.id}: every definition must declare schema_version ${SCHEMA_VERSION}`);
    if (!CONTENT_KINDS.includes(entry.kind)) fail(`${entry?.id}: unknown kind ${JSON.stringify(entry?.kind)}`);
    if (typeof entry.id !== 'string' || !IDENTIFIER.test(entry.id)) fail(`${JSON.stringify(entry?.id)}: invalid definition id`);
    if (typeof entry.label !== 'string' || !entry.label.trim()) fail(`${entry.id}: a non-empty label is required`);
    const key = `${entry.kind}:${entry.id}`;
    if (byKind.get(entry.kind).has(entry.id)) fail(`${key}: duplicate definition`);
    byKind.get(entry.kind).set(entry.id, entry);
    const indexed = record.get(key);
    if (!indexed) fail(`${key}: the manifest does not index this definition`);
    if (!indexed.file.startsWith('content/') || !indexed.file.toLowerCase().includes(entry.id.toLowerCase())) fail(`${entry.id}: manifest file ${indexed.file} does not name the definition`);

    const license = entry.license;
    if (!license || typeof license !== 'object') fail(`${entry.id}: a license record is required`);
    for (const field of ['spdx', 'author', 'source', 'notice_file']) {
      if (typeof license[field] !== 'string' || !license[field].trim()) fail(`${entry.id}: license.${field} must be a non-empty string`);
    }
    if (license.notice_file.startsWith('/') || license.notice_file.split('/').includes('..')) fail(`${entry.id}: license.notice_file must be a repository-relative path`);
    if (!has(notices.notices, license.notice_file)) fail(`${entry.id}: license.notice_file ${license.notice_file} does not resolve to a notice`);
    if (license.notice_sha256 !== notices.notices[license.notice_file]) fail(`${entry.id}: license.notice_sha256 does not match the recorded notice for ${license.notice_file}`);

    const appearance = entry.appearance;
    if (!appearance || typeof appearance !== 'object') fail(`${entry.id}: an appearance record is required`);
    if (entry.kind === 'cosmetic' ? appearance.geometry != null && typeof appearance.geometry !== 'string' : typeof appearance.geometry !== 'string' || !appearance.geometry.trim()) {
      fail(`${entry.id}: appearance.geometry must name the builder for kind ${entry.kind}`);
    }
    if (appearance.color != null && !HEX.test(appearance.color)) fail(`${entry.id}: appearance.color must be null or a #rrggbb colour`);
    if (appearance.emissive != null && !HEX.test(appearance.emissive)) fail(`${entry.id}: appearance.emissive must be null or a #rrggbb colour`);
    if (typeof appearance.transparent !== 'boolean') fail(`${entry.id}: appearance.transparent must be a boolean`);

    const rules = entry.rules;
    if (!rules || typeof rules !== 'object') fail(`${entry.id}: a rules record is required`);
    if (!Array.isArray(rules.palettes)) fail(`${entry.id}: rules.palettes must be an array`);
    for (const name of rules.palettes) if (!has(palettes.palettes, name)) fail(`${entry.id}: rules.palettes names the unknown palette ${name}`);

    if (entry.kind === 'furniture') {
      if (rules.geometry !== appearance.geometry) fail(`${entry.id}: rules.geometry must repeat the appearance.geometry builder`);
      if (!['occupied', 'open'].includes(rules.footprint)) fail(`${entry.id}: furniture rules.footprint must be "occupied" or "open"`);
    }
    if (entry.kind === 'block') {
      const stack = rules.stack;
      if (!stack || typeof stack.requires_solid_below !== 'boolean' || !Number.isInteger(stack.z_min) || !Number.isInteger(stack.z_max) || stack.z_min > stack.z_max) {
        fail(`${entry.id}: a block needs rules.stack with requires_solid_below and an ordered z_min/z_max`);
      }
    }
    if (entry.kind === 'crop') {
      if (!Number.isInteger(rules.grow_ms) || rules.grow_ms <= 0) fail(`${entry.id}: crop rules.grow_ms must be a positive integer`);
      if (!Number.isInteger(rules.max_growing) || rules.max_growing <= 0) fail(`${entry.id}: crop rules.max_growing must be a positive integer`);
      if (rules.yield?.item !== entry.id || !Number.isInteger(rules.yield?.quantity) || rules.yield.quantity <= 0) fail(`${entry.id}: crop rules.yield must name this crop and a positive quantity`);
    }
    if (entry.kind === 'cosmetic') {
      if (typeof rules.cosmetic_kind !== 'string' || !rules.cosmetic_kind.trim()) fail(`${entry.id}: cosmetic rules.cosmetic_kind is required`);
      if (typeof rules.earned_by !== 'string' || !rules.earned_by.trim()) fail(`${entry.id}: cosmetic rules.earned_by is required`);
      if (rules.cosmetic_kind === 'craft' && (!rules.output || !rules.name || !rules.ingredients || typeof rules.ingredients !== 'object')) {
        fail(`${entry.id}: a craft cosmetic needs a name, an ingredient list and an output`);
      }
    }
    if (entry.kind === 'appearance') {
      if (!Array.isArray(rules.roster_roles) || !rules.roster_roles.length || rules.roster_roles.some((role) => typeof role !== 'string' || !role)) fail(`${entry.id}: appearance rules.roster_roles must list at least one role`);
      if (typeof appearance.atlas !== 'string' || !appearance.atlas || typeof appearance.faceset !== 'string' || !appearance.faceset) fail(`${entry.id}: an appearance needs atlas and faceset asset paths`);
      if (!Array.isArray(entry.assets) || !entry.assets.length) fail(`${entry.id}: an appearance must reference its asset files`);
    }
  }
  for (const item of manifest.entries) if (!byKind.get(item.kind)?.has(item.id)) fail(`${item.file}: the manifest indexes a definition that is not in the bundle`);

  for (const [name, ids] of Object.entries(palettes.palettes)) {
    if (!Array.isArray(ids) || !ids.length) fail(`palette ${name} must be a non-empty array of definition ids`);
    if (new Set(ids).size !== ids.length) fail(`palette ${name} lists a duplicate id`);
    for (const id of ids) {
      const matches = CONTENT_KINDS.flatMap((kind) => byKind.get(kind).get(id) ? [byKind.get(kind).get(id)] : []);
      if (!matches.length) fail(`palette ${name} references the unknown id ${id}`);
      if (!matches.some((entry) => entry.rules.palettes.includes(name))) fail(`palette ${name} references ${id}, which does not declare that palette`);
      if (!matches.every((entry) => typeof entry.license.spdx === 'string' && entry.license.spdx.trim())) fail(`palette ${name} references ${id}, which carries no license identifier`);
    }
  }
  for (const kind of CONTENT_KINDS) {
    for (const entry of byKind.get(kind).values()) {
      for (const name of entry.rules.palettes) if (!palettes.palettes[name].includes(entry.id)) fail(`${entry.id}: declares palette ${name} but the palette does not list it`);
      if (entry.kind === 'crop' && !byKind.get('furniture').has(entry.rules.tile_object)) {
        fail(`${entry.id}: crop rules.tile_object ${JSON.stringify(entry.rules.tile_object)} is not a furniture definition`);
      }
    }
  }
  return input;
}

/**
 * Builds the resolver API. The definitions are taken as an argument so the layer stays testable and
 * usable in both environments; createContent() freezes them, so a resolver never hands back
 * something a caller can mutate.
 */
export function createContent(input) {
  const bundle = freeze(validateBundle(input));
  const byKind = new Map(CONTENT_KINDS.map((kind) => [kind, sorted([...bundle.entries].filter((entry) => entry.kind === kind))]));
  const indexed = new Map(bundle.manifest.entries.map((item) => [`${item.kind}:${item.id}`, item]));

  /** The definition for an id. Without a kind, the first match in CONTENT_KINDS order wins. */
  const entry = (id, kind) => {
    if (kind !== undefined) return byKind.get(kind)?.find((item) => item.id === id);
    for (const candidate of CONTENT_KINDS) {
      const found = byKind.get(candidate).find((item) => item.id === id);
      if (found) return found;
    }
    return undefined;
  };
  /** Every definition that uses an id. Only "wood" is shared today: a frontier block and a crop. */
  const find = (id) => CONTENT_KINDS.flatMap((kind) => byKind.get(kind).filter((item) => item.id === id));

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    manifest: () => bundle.manifest,
    notices: () => bundle.notices.notices,
    entry,
    find,
    entries: (kind) => kind === undefined ? CONTENT_KINDS.flatMap((name) => byKind.get(name)) : [...(byKind.get(kind) || [])],
    licenses: () => bundle.entries.map((item) => ({ id: item.id, kind: item.kind, license: item.license })),
    assets: (id, kind) => indexed.get(`${entry(id, kind)?.kind}:${entry(id, kind)?.id}`)?.assets || [],
    palettes: () => Object.keys(bundle.palettes.palettes),
    palette: (name) => {
      if (!has(bundle.palettes.palettes, name)) fail(`unknown palette ${JSON.stringify(name)}; known palettes are ${Object.keys(bundle.palettes.palettes).join(', ')}`);
      return [...bundle.palettes.palettes[name]];
    },
    color: (id, kind) => entry(id, kind)?.appearance.color ?? null,
    geometry: (id, kind) => entry(id, kind)?.appearance.geometry ?? null,
    /** Growth times in milliseconds, shaped like src/journey.js crops. */
    crops: () => Object.fromEntries(byKind.get('crop').map((item) => [item.id, item.rules.grow_ms])),
    /** Decoration recipes, shaped like src/journey.js recipes. */
    recipes: () => byKind.get('cosmetic').filter((item) => item.rules.cosmetic_kind === 'craft')
      .map((item) => ({ id: item.id, name: item.rules.name, ingredients: { ...item.rules.ingredients }, output: item.rules.output })),
    /** Cosmetic ids for one category, or every category keyed by name. */
    cosmetics: (kind) => {
      const groups = {};
      for (const item of byKind.get('cosmetic')) (groups[item.rules.cosmetic_kind] ||= []).push(item.id);
      if (kind !== undefined) {
        if (!has(groups, kind)) fail(`unknown cosmetic kind ${JSON.stringify(kind)}; known kinds are ${Object.keys(groups).sort().join(', ')}`);
        return groups[kind];
      }
      return Object.fromEntries(Object.keys(groups).sort().map((name) => [name, groups[name]]));
    },
    /** Appearance definitions assigned to a role, in roster order. */
    appearancesFor: (role) => byKind.get('appearance').filter((item) => item.rules.roster_roles.includes(role)),
    /** The rules of every definition of a kind, keyed by id. */
    rules: (kind) => {
      if (!byKind.has(kind)) fail(`unknown kind ${JSON.stringify(kind)}; known kinds are ${CONTENT_KINDS.join(', ')}`);
      return byKind.get(kind).map((item) => ({ id: item.id, kind: item.kind, rules: item.rules }));
    },
  });
}

const content = createContent(bundle);

export const { manifest, notices, entry, find, entries, licenses, assets, palettes, palette, color, geometry, crops, recipes, cosmetics, appearancesFor, rules } = content;
export default content;
