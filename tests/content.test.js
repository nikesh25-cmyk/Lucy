import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import bundle from '../content/index.js';
import content, { SCHEMA_VERSION, CONTENT_KINDS, createContent, palette, palettes, color, geometry, crops, recipes,
  cosmetics, appearancesFor, rules, manifest, entry, find, entries, licenses, notices, assets } from '../src/content.js';
import { parseAction } from '../runtime/agent.js';
import { FRONTIER_PALETTE, FRONTIER_LIMITS } from '../src/frontier.js';
import { JOURNEY_SCHEMA } from '../src/journey.js';
import { FRONTIER_BLOCK_COLORS } from '../world.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path));
const source = (path) => readFileSync(join(root, path), 'utf8');
const digest = (value) => createHash('sha256').update(value).digest('hex');
// The arrays the content layer mirrors are module-local in src/spaces.js, so they are read from the
// source text rather than imported. A rename or reorder in either place fails these tests.
const unwrap = (text) => text.replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/,(\s*[}\]])/g, '$1');
const literal = (text, pattern, label) => {
  const match = pattern.exec(text);
  assert.ok(match, `could not extract ${label} from the source it mirrors`);
  return JSON.parse(unwrap(match[1]));
};
const tampered = (change) => {
  const copy = JSON.parse(JSON.stringify(bundle));
  change(copy);
  return copy;
};
const KINDS = Object.freeze({ blocks: 'block', furniture: 'furniture', crops: 'crop', appearances: 'appearance', cosmetics: 'cosmetic' });

test('the content layer, its palettes and every definition declare schema version 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(content.schemaVersion, 1);
  assert.equal(manifest().schema_version, 1);
  assert.equal(bundle.palettes.schema_version, 1);
  assert.equal(bundle.notices.schema_version, 1);
  for (const definition of entries()) assert.equal(definition.schema_version, 1, `${definition.kind}:${definition.id} must declare schema version 1`);
  assert.deepEqual(CONTENT_KINDS, ['block', 'furniture', 'crop', 'appearance', 'cosmetic']);
  assert.deepEqual(manifest().kinds, { appearance: 20, block: 7, cosmetic: 32, crop: 3, furniture: 27 });
  assert.equal(entries().length, 89);
  assert.deepEqual(palettes(), ['garden', 'house', 'frontier']);
  for (const kind of CONTENT_KINDS) assert.equal(entries(kind).length, manifest().kinds[kind], `${kind} count must match the sealed manifest`);
});

test('every definition file and every referenced asset matches the sealed manifest', () => {
  const manifestData = manifest();
  assert.equal(manifestData.generated_by, 'scripts/seal-content.mjs');
  for (const item of manifestData.entries) {
    const file = read(item.file);
    assert.equal(digest(file), item.sha256, `${item.file} must hash to the sealed digest`);
    for (const asset of item.assets) assert.equal(digest(read(asset.path)), asset.sha256, `${asset.path} must hash to the digest recorded for ${item.id}`);
  }
  for (const file of manifestData.support) assert.equal(digest(read(file.path)), file.sha256, `${file.path} must hash to the sealed digest`);
  // Every definition file on disk must be indexed: an unsealed definition cannot hide in content/.
  for (const [directory, kind] of Object.entries(KINDS)) {
    for (const name of readdirSync(join(root, 'content', directory))) {
      const path = `content/${directory}/${name}`;
      assert.ok(name.endsWith('.json'), `${path} is not a JSON definition`);
      const indexed = manifestData.entries.find((item) => item.file === path);
      assert.ok(indexed, `${path} is not indexed by the manifest`);
      assert.equal(indexed.kind, kind, `${path} must be indexed as a ${kind}`);
      assert.ok(entries(kind).some((definition) => definition.id === indexed.id), `${path} must correspond to a ${kind} definition`);
    }
  }
});

test('every definition carries its own license and a resolvable notice', () => {
  // An allow-list of identifiers actually evidenced in this repository. A standard licence this
  // project has no right to claim (MIT, Apache-2.0, OFL-1.1) must not appear on a definition.
  const permitted = /^(CC0-1\.0|LicenseRef-NemoWorld-Project-Authored)$/;
  for (const definition of entries()) {
    const license = definition.license;
    assert.match(license.spdx, permitted, `${definition.id} must carry an evidenced license identifier`);
    for (const field of ['author', 'source', 'notice_file', 'notice_sha256']) assert.ok(license[field], `${definition.id} must record license.${field}`);
    assert.equal(license.notice_file.startsWith('/') || license.notice_file.includes('..'), false, `${definition.id} must use a repository-relative notice path`);
    const notice = read(license.notice_file);
    assert.equal(digest(notice), license.notice_sha256, `${definition.id}: ${license.notice_file} must hash to the recorded notice digest`);
    assert.equal(notices()[license.notice_file], license.notice_sha256, `${definition.id} must agree with content/notices.json`);
    if (license.spdx === 'CC0-1.0') {
      assert.match(license.commit, /^[a-f0-9]{40}$/, `${definition.id} must pin the commit its CC0 asset came from`);
      assert.ok(license.source.includes(license.commit), `${definition.id} must cite the pinned commit in its source`);
    } else {
      assert.equal(license.commit, null, `${definition.id} is project-authored and has no upstream commit to cite`);
      assert.equal(license.notice_file, 'content/THIRD_PARTY.md');
    }
  }
  const mayor = entries('appearance')[0];
  assert.equal(mayor.license.spdx, 'CC0-1.0');
  assert.equal(mayor.license.author, 'Pixel-boy / Sparklin Labs');
  assert.equal(mayor.license.commit, 'e8674a03ab4456802f71f848c4df79eccca23f7a');
  assert.equal(mayor.license.notice_file, 'assets/mayors/LICENSE.txt');
  assert.equal(mayor.license.notice_sha256, '36ffd9dc085d529a7e60e1276d73ae5a030b020313e6c5408593a6ae2af39673');
  assert.equal(entries('block')[0].license.spdx, 'LicenseRef-NemoWorld-Project-Authored');
});

test('palettes resolve and never reference an unlicensed definition', () => {
  for (const name of palettes()) {
    const ids = palette(name);
    assert.deepEqual(ids, bundle.palettes.palettes[name], `palette ${name} must match its sealed order`);
    for (const id of ids) {
      const definition = entry(id);
      assert.ok(definition, `palette ${name} references the unknown id ${id}`);
      assert.ok(definition.license.spdx.trim(), `palette ${name} references ${id}, which carries no license identifier`);
      assert.ok(definition.rules.palettes.includes(name), `${id} must declare the palette ${name}`);
    }
    assert.equal(new Set(ids).size, ids.length, `palette ${name} must not repeat an id`);
  }
  // Every declaration runs both ways: no definition may claim a palette that does not list it.
  for (const definition of entries().filter((item) => item.rules.palettes.length)) {
    for (const name of definition.rules.palettes) assert.ok(palette(name).includes(definition.id), `${definition.id} claims palette ${name}`);
  }
  assert.throws(() => palette('banquet'), /unknown palette/);
  assert.throws(() => content.palette(''), /unknown palette/);
});

test('the retained asset manifests are pinned and their files verified', () => {
  // These two manifests were previously described only in prose (docs/OPEN_SOURCE.md). Pinning the
  // manifest bytes stops the description, the hashes and the bundled files drifting apart silently.
  const pinned = {
    'assets/manifest.json': 'e07b1cec8f5d861d3c597d544109b9dc3231f28f06beb277dc26ab78a0abcf5b',
    'assets/mayors/manifest.json': 'cc17dc7bdc3879a360c7ffda54a2db4dbd77099fca06b68496438fefaf31c101',
  };
  for (const [path, sha256] of Object.entries(pinned)) assert.equal(digest(read(path)), sha256, `${path} changed; update the pinned hash deliberately`);
  const assetsManifest = JSON.parse(source('assets/manifest.json'));
  assert.equal(assetsManifest.files.length, 20);
  for (const file of assetsManifest.files) {
    const body = read(`assets/${file.path}`);
    assert.equal(digest(body), file.sha256, `assets/${file.path} must match the bundled asset manifest`);
  }
  const mayors = JSON.parse(source('assets/mayors/manifest.json'));
  assert.equal(mayors.license, 'CC0-1.0');
  assert.equal(mayors.commit, 'e8674a03ab4456802f71f848c4df79eccca23f7a');
  assert.equal(mayors.files.length, 48);
  for (const file of mayors.files) {
    const body = read(`assets/mayors/${file.file}`);
    assert.equal(body.length, file.bytes, `assets/mayors/${file.file} must keep its recorded size`);
    assert.equal(digest(body), file.sha256, `assets/mayors/${file.file} must match the mayor pack manifest`);
  }
  // The content layer's appearance assets must be files the pack manifest records. The pack lays the
  // portrait out at characters/faceset/<n>.png while the client loads assets/mayors/facesets/<n>.png;
  // both vendored copies must hash to the same recorded digest.
  const recorded = new Map(mayors.files.map((file) => [file.file, file.sha256]));
  for (const definition of entries('appearance')) {
    const sprite = definition.appearance.sprite;
    const portrait = recorded.get(`characters/faceset/${sprite}.png`);
    assert.equal(recorded.get(`characters/${sprite}.png`), definition.assets[0].sha256, `sprite ${sprite} must match the pack character sheet`);
    assert.equal(portrait, definition.assets[1].sha256, `sprite ${sprite} must match the pack portrait`);
    assert.equal(digest(read(`assets/mayors/characters/faceset/${sprite}.png`)), portrait, `the retained pack copy of portrait ${sprite} must be unchanged`);
  }
});

test('renderer colours and palettes cannot drift from the content layer', () => {
  const voxel = source('src/voxel-world.js');
  const characters = source('src/characters.js');
  // Frontier blocks and the extracted character renderer each resolve their own sealed colours.
  // These guards fail if either replaces that wiring with a parallel literal palette.
  assert.ok(voxel.includes("import content from './content.js'") && voxel.includes("content.palette('frontier')"),
    'src/voxel-world.js must resolve block colours from the content layer');
  assert.ok(voxel.includes("import { charactersScene") && characters.includes("content.cosmetics('agent_color')")
    && characters.includes('AGENT_COLORS[item.color]') && characters.includes("content.cosmetics('skin_tone')")
    && characters.includes('SKIN_TONES[hash(id) % SKIN_TONES.length]'),
  'the live character builder must resolve named agent colours and skin tones');
  const LOCAL_COLORS = literal(voxel, /const LOCAL_COLORS = Object\.freeze\((\{[\s\S]*?\})\);/, 'LOCAL_COLORS');
  const COLORS = { ...LOCAL_COLORS, ...Object.fromEntries(palette('frontier').map((id) => [id, color(id, 'block')])) };
  for (const id of [...palette('frontier'), ...palette('garden'), ...palette('house')]) {
    assert.equal(Object.hasOwn(LOCAL_COLORS, id), false, `${id} must resolve from the content layer, not the local renderer palette`);
  }
  // The one documented exception: the renderer's lantern glow keeps the name `gold`, while the agent
  // cosmetic of that name is a deeper tone. They are different colours, so neither may stand in.
  assert.equal(LOCAL_COLORS.gold, '#e2ca83');
  assert.equal(color('gold', 'cosmetic'), '#cbb46c');
  const spaces = source('src/spaces.js');
  // The palettes are resolved once, in src/placement-policy.js, which also builds the storage trigger
  // that mirrors the build method. build() consumes those constants instead of a local literal.
  const placement = source('src/placement-policy.js');
  assert.ok(placement.includes("content.palette('garden')") && placement.includes("content.palette('house')"),
    'src/placement-policy.js must resolve both build palettes from the content layer');
  assert.ok(spaces.includes("from './placement-policy.js'") && spaces.includes('const palette = GARDEN_PALETTE') && spaces.includes('const housePalette = HOUSE_PALETTE'),
    'src/spaces.js must build from the placement policy palettes');
  assert.deepEqual(palette('frontier'), [...FRONTIER_PALETTE]);
  for (const id of palette('frontier')) {
    const definition = entry(id, 'block');
    assert.equal(color(id), COLORS[id], `${id} must keep the voxel material colour`);
    assert.equal(definition.appearance.color_2d, FRONTIER_BLOCK_COLORS[id], `${id} must keep the tile renderer colour`);
    assert.equal(definition.rules.stack.z_max, FRONTIER_LIMITS.maximum_z, `${id} must use the frontier layer limit`);
    assert.equal(definition.rules.stack.z_min, 0);
  }
  const AGENT_COLORS = Object.fromEntries(cosmetics('agent_color').map((id) => [id, color(id, 'cosmetic')]));
  assert.deepEqual(cosmetics('agent_color'), Object.keys(AGENT_COLORS));
  for (const [name, hex] of Object.entries(AGENT_COLORS)) assert.equal(color(name), hex, `${name} must keep its agent colour`);
  // Furniture: every named builder must exist in the renderer, and every colour must be one the
  // builder that draws it actually paints -- a colour borrowed from a different builder fails.
  // "prop" is the generic fallback branch, which has no literal of its own.
  const region = voxel.slice(voxel.indexOf('function tree(batch'), voxel.indexOf('function terrainScene'));
  const builders = new Set([
    ...[...region.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((match) => match[1]),
    ...[...region.matchAll(/function ([a-zA-Z]+)\(/g)].map((match) => match[1].toLowerCase()),
  ]);
  const body = (name) => {
    const start = voxel.indexOf(`function ${name}(batch`);
    assert.ok(start > 0, `could not find ${name}() in src/voxel-world.js`);
    return voxel.slice(start, voxel.indexOf('function ', start + 10));
  };
  const paints = (text) => new Set([
    ...[...text.matchAll(/#[a-f\d]{6}/gi)].map((match) => match[0].toLowerCase()),
    ...[...text.matchAll(/COLORS\.([a-z]+)/g)].map((match) => COLORS[match[1]].toLowerCase()),
  ]);
  const furniturePaint = new Set([...paints(body('furniture')), ...paints(source('world.js'))]);
  const painterOf = (id) => ['cottage', 'shelter', 'civic-building'].includes(id) ? paints(body('house'))
    : ['tree', 'fruit', 'palm', 'cactus', 'mountain'].includes(id) ? paints(body('tree')) : furniturePaint;
  for (const definition of entries('furniture')) {
    assert.equal(definition.rules.geometry, definition.appearance.geometry);
    assert.ok(builders.has(definition.rules.geometry) || definition.rules.geometry === 'prop',
      `${definition.id} must name a builder implemented by src/voxel-world.js (found ${definition.rules.geometry})`);
    const painted = painterOf(definition.id);
    assert.ok(painted.has(definition.appearance.color.toLowerCase()), `${definition.id} must use a colour its own builder paints (${definition.appearance.color})`);
    if (definition.appearance.emissive) assert.ok(painted.has(definition.appearance.emissive.toLowerCase()), `${definition.id} must use an emissive colour its own builder paints`);
    assert.ok(['occupied', 'open'].includes(definition.rules.footprint));
  }
  for (const definition of entries('crop')) assert.ok(furniturePaint.has(definition.appearance.color.toLowerCase()), `${definition.id} must use a colour the farm tile paints`);
  const everywhere = new Set([...furniturePaint, ...paints(voxel), ...paints(characters)]);
  // The extracted character builder resolves these sealed colours without repeating their hex.
  // The wiring guard above is what keeps the renderer and the content entries in step.
  for (const category of ['agent_color', 'skin_tone'])
    for (const id of cosmetics(category)) everywhere.add(color(id, 'cosmetic').toLowerCase());
  for (const definition of entries('cosmetic')) if (definition.appearance.color) assert.ok(everywhere.has(definition.appearance.color.toLowerCase()), `${definition.id} must use an authored colour`);
});

test('crop, recipe, cosmetic and appearance definitions cannot drift from the code', () => {
  const journey = source('src/journey.js');
  // The journey constants are resolved from the content layer, so the guard is the wiring itself
  // plus the one place the code still repeats a content value in SQL: the crop kind CHECK clause,
  // which must be generated from the sealed crops rather than written out by hand.
  assert.ok(journey.includes("import content from './content.js'") && journey.includes('content.crops()')
    && journey.includes('content.recipes()') && journey.includes("content.cosmetics('title')") && journey.includes("content.cosmetics('avatar')"),
    'src/journey.js must resolve crops, recipes, titles and avatars from the content layer');
  const clause = /CHECK\(kind IN \(([^)]*)\)\)/.exec(JOURNEY_SCHEMA);
  assert.ok(clause, 'journey_crops must keep a crop kind CHECK clause');
  assert.deepEqual(clause[1].replaceAll(' ', '').split(',').sort(), Object.keys(crops()).map((kind) => `'${kind}'`).sort(),
    'the journey_crops CHECK clause must list exactly the sealed crops');
  const agent = source('runtime/agent.js');
  assert.deepEqual(cosmetics('expression'), literal(agent, /const EMOTES = new Set\((\[[^\]]*\])\);/, 'EMOTES'));
  const civic = source('src/civic-engine.js');
  assert.ok(civic.includes("import content from './content.js'") && civic.includes("content.appearancesFor('civic-mayor')")
    && civic.includes("content.appearancesFor('civic-ambassador')"),
    'src/civic-engine.js must resolve both the historic guide roster and the country ambassador roster from the content layer');
  const roster = appearancesFor('civic-mayor').map((definition) => definition.appearance.sprite);
  assert.deepEqual(JSON.parse(source('assets/mayors/manifest.json')).recommendedAnimatedRoster, roster);
  // The same 20 sealed sheets serve both roles, so the two rosters are one roster. The country
  // ambassadors reuse these sheets; no new art is introduced and 248 ambassadors share 20 portraits.
  assert.deepEqual(appearancesFor('civic-ambassador').map((definition) => definition.appearance.sprite), roster);
  for (const definition of appearancesFor('civic-mayor')) {
    const { sprite, served, frame } = definition.appearance;
    assert.equal(served.atlas, `/assets/mayors/characters/${sprite}.png`);
    assert.equal(served.faceset, `/assets/mayors/facesets/${sprite}.png`);
    assert.equal(frame.columns, 4);
    assert.ok(frame.walk_rows.includes(frame.idle_row) && frame.walk_rows.length === 4, `${definition.id} must keep the four-row walk layout`);
    assert.deepEqual(definition.rules.roster_roles, ['civic-mayor', 'civic-ambassador']);
  }
  const app = source('app.js');
  assert.ok(app.includes('/assets/mayors/characters/') && app.includes('/assets/mayors/facesets/'), 'app.js must keep loading the guide atlas and portrait routes');
  // The client still preloads the character sheets by their sheet number, so that list is the one
  // remaining copy of the roster and it must stay the sealed roster in the sealed order.
  assert.deepEqual(literal(app, /for\(const id of (\[\d+(?:,\d+)*\])\)\{const image=new Image/, 'guide sprite preload'), roster);
  assert.deepEqual(appearancesFor('resident'), [], 'the guide sheets are assigned to the historic guides and the country ambassadors only');
  for (const definition of entries('appearance')) assert.deepEqual(definition.rules.roster_roles, ['civic-mayor', 'civic-ambassador']);
});

test('the runtime agent resolves its allow-lists from the content layer', () => {
  const agent = source('runtime/agent.js');
  const literals = [...agent.matchAll(/\[\s*'stone','wood','glass','brick','sand','grass','path'\s*\]|\[\s*'herbs', 'fiber', 'wood'\s*\]/g)];
  assert.deepEqual(literals.map((match) => match[0]), [], 'runtime/agent.js must not carry a hardcoded block or crop allow-list');
  assert.ok(agent.includes("import content from '../src/content.js'") && agent.includes("content.palette('frontier')")
    && agent.includes('content.crops()'), 'runtime/agent.js must resolve its block and crop types from the content layer');
  // The parsed action surface must match the sealed definitions exactly, in both directions.
  for (const type of palette('frontier')) assert.equal(parseAction({ action: 'build_block', type, x: 1, y: 1, z: 0 }).type, type);
  assert.throws(() => parseAction({ action: 'build_block', type: 'coin', x: 1, y: 1, z: 0 }));
  for (const kind of Object.keys(crops())) assert.equal(parseAction({ action: 'garden', intent: 'plant', kind, x: 1, y: 1 }).kind, kind);
  assert.throws(() => parseAction({ action: 'garden', intent: 'plant', kind: 'invented', x: 1, y: 1 }));
  // A garden and a cottage build both parse, because the runtime cannot know which world it observes.
  for (const type of new Set([...palette('garden'), ...palette('house')])) assert.equal(parseAction({ action: 'build', type, x: 1, y: 1 }).type, type);
  assert.throws(() => parseAction({ action: 'build', type: 'not-a-palette-entry', x: 1, y: 1 }));
  assert.equal(parseAction({ action: 'build_block', type: palette('frontier')[0], x: 1, y: 1, z: rules('block')[0].rules.stack.z_max }).z,
    rules('block')[0].rules.stack.z_max, 'the runtime must accept the sealed layer ceiling');
  assert.throws(() => parseAction({ action: 'build_block', type: palette('frontier')[0], x: 1, y: 1, z: rules('block')[0].rules.stack.z_max + 1 }));
});

test('the loader rejects unlicensed, unindexed or unresolvable definitions', () => {
  assert.equal(createContent(JSON.parse(JSON.stringify(bundle))).crops().herbs, crops().herbs);
  assert.throws(() => createContent(tampered((copy) => { copy.entries.find((item) => item.id === 'wood' && item.kind === 'block').license.spdx = ''; })), /license\.spdx/);
  assert.throws(() => createContent(tampered((copy) => { copy.entries[0].license.notice_file = 'content/NOT-A-NOTICE.md'; })), /does not resolve to a notice/);
  assert.throws(() => createContent(tampered((copy) => { copy.entries[0].license.notice_sha256 = '0'.repeat(64); })), /notice_sha256/);
  assert.throws(() => createContent(tampered((copy) => { copy.palettes.palettes.garden[0] = 'unlicensed-statue'; })), /unknown id unlicensed-statue/);
  assert.throws(() => createContent(tampered((copy) => { copy.manifest.schema_version = 2; })), /schema_version/);
  assert.throws(() => createContent(tampered((copy) => { copy.entries.find((item) => item.kind === 'crop').rules.tile_object = 'sofa'; })), /tile_object/);
  assert.throws(() => createContent(tampered((copy) => { copy.entries.find((item) => item.kind === 'furniture').appearance.geometry = 'invented-builder'; })), /rules\.geometry/);
  assert.throws(() => createContent(tampered((copy) => { copy.manifest.entries.pop(); })), /not index|does not index/);
  assert.throws(() => createContent(tampered((copy) => { copy.entries.push({ ...copy.entries[0] }); })), /duplicate definition/);
  assert.throws(() => createContent(tampered((copy) => { delete copy.notices; })), /notices\.json/);
});

test('the resolvers expose the sealed definitions', () => {
  assert.deepEqual(entries('block').map((definition) => definition.id).sort(), [...palette('frontier')].sort());
  assert.equal(entry('wood', 'crop').rules.grow_ms, 1_800_000);
  assert.equal(entry('wood', 'block').kind, 'block');
  assert.deepEqual(find('wood').map((definition) => definition.kind), ['block', 'crop'], 'an ambiguous id resolves in CONTENT_KINDS order');
  assert.equal(geometry('pond'), entry('pond', 'furniture').rules.geometry);
  assert.equal(color('teal'), '#448c87');
  assert.equal(color('mayor-1'), null, 'an appearance takes its colour from its own sheet');
  assert.equal(color('not-a-definition'), null);
  assert.equal(entry('not-a-definition'), undefined);
  assert.deepEqual(assets('mayor-1').map((asset) => asset.path), ['assets/mayors/characters/1.png', 'assets/mayors/facesets/1.png']);
  assert.deepEqual(assets('wood', 'block'), []);
  assert.ok(Object.keys(notices()).includes('content/THIRD_PARTY.md'));
  assert.equal(licenses().length, entries().length);
  assert.equal(rules('crop').length, 3);
  assert.equal(rules('crop').every((item) => item.rules.max_growing === 20 && item.rules.yield.quantity === 2), true);
  assert.equal(cosmetics().title.length + cosmetics().avatar.length + cosmetics().craft.length + cosmetics().agent_color.length + cosmetics().skin_tone.length + cosmetics().expression.length,
    manifest().kinds.cosmetic);
  assert.throws(() => cosmetics('banquet'), /unknown cosmetic kind/);
  assert.throws(() => rules('banquet'), /unknown kind/);
  assert.equal(Object.isFrozen(content), true);
});
