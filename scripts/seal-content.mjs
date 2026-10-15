#!/usr/bin/env node
// Seals the typed content definitions in content/**: it hashes every entry file and every asset a
// definition references, verifies the individual license notices, and regenerates
// content/content-manifest.json, content/notices.json and content/index.js.
//
// The output is deterministic. Nothing here records the current time, the entry files are never
// rewritten, and the key order of every generated document is fixed, so running the sealer twice
// leaves the working tree unchanged.
//
// Usage: node scripts/seal-content.mjs [--check]
//   --check  verify the sealed files on disk match what would be generated, instead of writing.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url);
const root = fileURLToPath(ROOT);
const KINDS = Object.freeze({ blocks: 'block', furniture: 'furniture', crops: 'crop', appearances: 'appearance', cosmetics: 'cosmetic',
  places: 'place', fixtures: 'fixture', activities: 'activity', residents: 'resident', ambient: 'ambient' });
// The five authored content families carry their own manifest shape (src/content-manifest.js). The
// sealer checks only the parts that must hold for every entry of a family: the family label, and the
// cross-family references the seal can resolve. The deep rules live in the validator, which the
// publication path runs before anything is written.
const FAMILY_OF_KIND = Object.freeze({ place: 'places', fixture: 'fixtures', activity: 'activities', resident: 'residents', ambient: 'ambient' });
const REFERENCE_FIELDS = Object.freeze({
  place: { fixtures: 'fixture', residents: 'resident', activities: 'activity', ambient: 'ambient' },
  fixture: { object: 'furniture' },
  activity: { place: 'place', residents: 'resident' },
  resident: { appearance: 'appearance' },
  ambient: { place: 'place' },
});
const article = (kind) => (/^[aeiou]/.test(kind) ? 'an' : 'a');
const KINDS_OF_FAMILY = Object.freeze({
  place: 'place', fixture: 'fixture', activity: 'activity', resident: 'resident', ambient: 'ambient',
  furniture: 'furniture', appearance: 'appearance', block: 'block', crop: 'crop', cosmetic: 'cosmetic',
});
const TEXT_FIELDS = Object.freeze({
  place: ['site.machinery', 'structure.kind', 'independence.statement'],
  fixture: ['provenance.derived_from', 'owner'],
  activity: ['clock', 'implements'],
  resident: ['role', 'remit'],
  ambient: ['provenance.derived_from'],
});
const HEX = /^[a-f0-9]{64}$/;
const check = process.argv.includes('--check');

const fail = (message) => { console.error(`seal-content: ${message}`); process.exit(1); };
const readJson = (relative) => {
  const path = join(root, relative);
  if (!existsSync(path)) fail(`missing ${relative}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`could not parse ${relative}: ${error.message}`); }
  return null;
};
const hashOf = (relative) => {
  const path = join(root, relative);
  if (!existsSync(path)) fail(`referenced file does not exist: ${relative}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};
// Sorted, stable stringify: object keys keep the order they were inserted in, arrays keep theirs.
const text = (value) => JSON.stringify(value, null, 2) + '\n';
const write = (relative, contents) => {
  const path = join(root, relative);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous === contents) return false;
  if (check) fail(`${relative} is out of date; run node scripts/seal-content.mjs`);
  writeFileSync(path, contents);
  return true;
};

const palettes = readJson('content/palettes.json');
if (palettes.schema_version !== 1) fail('content/palettes.json must use schema_version 1');

// ---- read and verify the definitions -------------------------------------------------------------
const entries = [];
const seen = new Set();
for (const [directory, kind] of Object.entries(KINDS)) {
  const folder = join(root, 'content', directory);
  if (!existsSync(folder)) fail(`missing content/${directory}/`);
  for (const name of readdirSync(folder).filter((file) => file.endsWith('.json')).sort()) {
    const file = `content/${directory}/${name}`;
    const entry = readJson(file);
    if (entry.schema_version !== 1) fail(`${file}: schema_version must be 1`);
    if (entry.kind !== kind) fail(`${file}: kind must be "${kind}" for content/${directory}/`);
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(entry.id)) fail(`${file}: invalid id`);
    if (typeof entry.label !== 'string' || !entry.label.trim()) fail(`${file}: a non-empty label is required`);
    if (typeof entry.since !== 'string' || !entry.since.trim()) fail(`${file}: a since version is required`);
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) fail(`${file}: duplicate definition ${key}`);
    seen.add(key);

    const license = entry.license;
    if (!license || typeof license !== 'object') fail(`${file}: a license record is required`);
    for (const field of ['spdx', 'author', 'source', 'notice_file']) {
      if (typeof license[field] !== 'string' || !license[field].trim()) fail(`${file}: license.${field} must be a non-empty string`);
    }
    if (!HEX.test(license.notice_sha256 || '')) fail(`${file}: license.notice_sha256 must be a sha256 hex digest`);
    if (license.notice_file.startsWith('/') || license.notice_file.split('/').includes('..')) fail(`${file}: license.notice_file must be a repository-relative path`);
    const noticeActual = hashOf(license.notice_file);
    if (noticeActual !== license.notice_sha256) {
      fail(`${file}: license.notice_sha256 does not match ${license.notice_file}\n  declared ${license.notice_sha256}\n  actual   ${noticeActual}\n  Update the notice hash and re-seal.`);
    }
    if (license.commit != null && !/^[a-f0-9]{40}$/.test(license.commit)) fail(`${file}: license.commit must be null or a 40 character commit id`);

    const appearance = entry.appearance;
    if (!appearance || typeof appearance !== 'object') fail(`${file}: an appearance record is required`);
    if (entry.kind !== 'cosmetic' && (typeof appearance.geometry !== 'string' || !appearance.geometry.trim())) fail(`${file}: appearance.geometry is required for kind ${entry.kind}`);
    if (appearance.color !== null && !/^#[a-f\d]{6}$/i.test(appearance.color || '')) fail(`${file}: appearance.color must be null or a #rrggbb colour`);
    if (appearance.emissive !== null && !/^#[a-f\d]{6}$/i.test(appearance.emissive || '')) fail(`${file}: appearance.emissive must be null or a #rrggbb colour`);
    if (typeof appearance.transparent !== 'boolean') fail(`${file}: appearance.transparent must be a boolean`);
    if (entry.kind === 'furniture' && appearance.geometry !== entry.rules?.geometry) fail(`${file}: rules.geometry must repeat the appearance.geometry builder`);

    const rules = entry.rules;
    if (!rules || typeof rules !== 'object') fail(`${file}: a rules record is required`);
    if (!Array.isArray(rules.palettes)) fail(`${file}: rules.palettes must be an array`);
    for (const palette of rules.palettes) if (!Object.hasOwn(palettes.palettes, palette)) fail(`${file}: rules.palettes names the unknown palette "${palette}"`);

    if (entry.kind === 'crop') {
      if (!Number.isInteger(rules.grow_ms) || rules.grow_ms <= 0) fail(`${file}: rules.grow_ms must be a positive integer`);
      if (!Number.isInteger(rules.max_growing) || rules.max_growing <= 0) fail(`${file}: rules.max_growing must be a positive integer`);
      if (rules.yield?.item !== entry.id || !Number.isInteger(rules.yield?.quantity) || rules.yield.quantity <= 0) fail(`${file}: rules.yield must name this crop and a positive quantity`);
    }
    if (entry.kind === 'cosmetic' && (typeof rules.cosmetic_kind !== 'string' || !rules.cosmetic_kind)) fail(`${file}: rules.cosmetic_kind is required`);
    if (entry.kind === 'cosmetic' && (typeof rules.earned_by !== 'string' || !rules.earned_by.trim())) fail(`${file}: rules.earned_by is required`);
    if (entry.kind === 'appearance' && (!Array.isArray(rules.roster_roles) || !rules.roster_roles.length)) fail(`${file}: rules.roster_roles is required`);

    // The five authored families declare which family they belong to, so a definition filed under the
    // wrong kind is refused at the seal instead of being indexed under a label that contradicts it.
    const family = FAMILY_OF_KIND[entry.kind];
    if (family) {
      if (rules.family !== family) fail(`${file}: rules.family must be "${family}" for kind ${entry.kind}`);
      for (const path of TEXT_FIELDS[entry.kind]) {
        const value = path.split('.').reduce((item, key) => item?.[key], rules);
        if (typeof value !== 'string' || !value.trim()) fail(`${file}: rules.${path} must be a non-empty string`);
      }
      for (const [field, kind] of Object.entries(REFERENCE_FIELDS[entry.kind] || {})) {
        const value = rules[field];
        if (Array.isArray(value) ? value.some((id) => typeof id !== 'string' || !id) : typeof value !== 'string' || !value) {
          fail(`${file}: rules.${field} must name at least one ${kind} id`);
        }
      }
    }

    const assets = [];
    for (const asset of entry.assets || []) {
      if (typeof asset.path !== 'string' || asset.path.startsWith('/') || asset.path.split('/').includes('..')) fail(`${file}: asset.path must be a repository-relative path`);
      const actual = hashOf(asset.path);
      if (asset.sha256 !== actual) fail(`${file}: declared sha256 for ${asset.path} is ${asset.sha256}, the file hashes to ${actual}`);
      assets.push({ path: asset.path, sha256: actual });
    }
    assets.sort((a, b) => a.path.localeCompare(b.path));

    entries.push({ id: entry.id, kind: entry.kind, file, sha256: hashOf(file), label: entry.label, since: entry.since, license, assets, rules });
  }
}
entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

// ---- cross checks: palettes and tile objects must resolve ----------------------------------------
const byId = (id) => entries.filter((entry) => entry.id === id);
for (const [name, ids] of Object.entries(palettes.palettes)) {
  if (!Array.isArray(ids) || !ids.length) fail(`palette ${name} must be a non-empty array`);
  if (new Set(ids).size !== ids.length) fail(`palette ${name} lists a duplicate id`);
  for (const id of ids) {
    const matches = byId(id);
    if (!matches.length) fail(`palette ${name} references the unknown id "${id}"`);
    if (!matches.some((entry) => entry.rules.palettes.includes(name))) fail(`palette ${name} references "${id}", which does not declare that palette in rules.palettes`);
    if (!matches.every((entry) => typeof entry.license.spdx === 'string' && entry.license.spdx.trim())) fail(`palette ${name} references "${id}", which carries no license identifier`);
  }
}
for (const entry of entries) {
  for (const palette of entry.rules.palettes) {
    if (!palettes.palettes[palette].includes(entry.id)) fail(`${entry.file}: declares palette ${palette} but the palette does not list "${entry.id}"`);
  }
  if (entry.kind === 'crop') {
    const tile = entry.rules.tile_object;
    if (!entries.some((item) => item.kind === 'furniture' && item.id === tile)) fail(`${entry.file}: rules.tile_object "${tile}" is not a furniture definition`);
  }
  for (const [field, kind] of Object.entries(REFERENCE_FIELDS[entry.kind] || {})) {
    for (const id of [].concat(entry.rules[field])) {
      if (!entries.some((item) => item.kind === kind && item.id === id)) fail(`${entry.file}: rules.${field} "${id}" is not ${article(kind)} ${kind} definition`);
    }
  }
}

// ---- generated documents ------------------------------------------------------------------------
const notices = {};
for (const entry of entries) notices[entry.license.notice_file] = entry.license.notice_sha256;
for (const asset of entries.flatMap((entry) => entry.assets)) notices[asset.path] = asset.sha256;
const noticeDocument = {
  schema_version: 1,
  generated_by: 'scripts/seal-content.mjs',
  notices: Object.fromEntries(Object.keys(notices).sort().map((path) => [path, notices[path]])),
};

const kinds = {};
for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] || 0) + 1;

// The generated index imports each definition by its own path, so the module never needs node:fs.
const imported = [...entries].sort((a, b) => a.file.localeCompare(b.file)).map((entry, index) => ({ entry, name: `entry${index}` }));
const moduleName = new Map(imported.map(({ entry, name }) => [`${entry.kind}:${entry.id}`, name]));
const indexDocument = [
  '// Generated by scripts/seal-content.mjs. Do not edit by hand.',
  '// Static JSON imports (import attributes) keep src/content.js free of node:fs and of the DOM.',
  "import palettes from './palettes.json' with { type: 'json' };",
  "import notices from './notices.json' with { type: 'json' };",
  "import manifest from './content-manifest.json' with { type: 'json' };",
  ...imported.map(({ entry, name }) => `import ${name} from './${entry.file.replace(/^content\//, '')}' with { type: 'json' };`),
  '',
  `const entries = Object.freeze([${entries.map((entry) => moduleName.get(`${entry.kind}:${entry.id}`)).join(', ')}]);`,
  '',
  'export default Object.freeze({ entries, palettes, notices, manifest });',
  '',
].join('\n');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const manifestDocument = {
  schema_version: 1,
  generated_by: 'scripts/seal-content.mjs',
  kinds,
  entries: entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    file: entry.file,
    sha256: entry.sha256,
    license: entry.license,
    assets: entry.assets,
  })),
  support: [
    { path: 'content/palettes.json', sha256: digest(readFileSync(join(root, 'content/palettes.json'))) },
    { path: 'content/notices.json', sha256: digest(text(noticeDocument)) },
    { path: 'content/index.js', sha256: digest(indexDocument) },
  ],
};

// ---- write -------------------------------------------------------------------------------------
const written = [
  write('content/notices.json', text(noticeDocument)),
  write('content/index.js', indexDocument),
  write('content/content-manifest.json', text(manifestDocument)),
].filter(Boolean);

const summary = Object.entries(kinds).sort().map(([kind, count]) => `${count} ${kind}`).join(', ');
console.log(`${check ? 'Verified' : written.length ? 'Sealed' : 'Unchanged'}: ${entries.length} definitions (${summary}); ${manifestDocument.support.length} support files; ${Object.keys(noticeDocument.notices).length} referenced notices and assets.`);
