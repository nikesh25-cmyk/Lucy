// The determinism proof the content brief calls "old saved worlds reopen correctly after a content
// update".
//
// The property is narrow and testable: adding definitions, changing the authored order, and resealing
// the layer must not move saved land, blocks, plots or placements, and every id a saved world stored
// must still resolve to the same kind, colour and builder afterwards. Reordering is included on
// purpose — it changes the sequence the resolver presents and nothing at all about what was saved.
//
// The update is performed for real: a mirror of content/ is edited, sealed by the same sealer, and the
// sealed bundle is loaded back with the same resolver the product uses. The working tree is never
// touched, so this test cannot leave the repository unsealed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import content, { createContent } from '../src/content.js';
import { validateContentFamilies } from '../src/content-manifest.js';
import { BUILD_PALETTE, GARDEN_PALETTE } from '../src/placement-policy.js';
import { FRONTIER_PALETTE, FRONTIER_SCHEMA } from '../src/frontier.js';
import { JOURNEY_SCHEMA } from '../src/journey.js';
import { WORLD_OBJECT_GUARDS } from '../src/placement-policy.js';
import { RECIPE_EXTENSIONS } from '../src/journey.js';
import { getWorldDefinition } from '../world.js';
import { fixture } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Every table a saved world keeps its land, blocks, plots and placements in. */
const SAVED = ['worlds', 'world_objects', 'frontier_sectors', 'frontier_blocks', 'land_parcels',
  'land_stewardships', 'land_events', 'plot_grants', 'journey_crops', 'journey_inventory'];
const snapshot = (platform) => digest(SAVED.map((table) => [table, platform.all(`SELECT * FROM ${table} ORDER BY rowid`)]))

/** A mirror of content/ with the staged change applied, sealed by the real sealer. */
function sealMirror(change) {
  const mirror = mkdtempSync(join(tmpdir(), 'content-determinism-'));
  cpSync(join(root, 'content'), join(mirror, 'content'), { recursive: true });
  mkdirSync(join(mirror, 'scripts'), { recursive: true });
  cpSync(join(root, 'scripts/seal-content.mjs'), join(mirror, 'scripts/seal-content.mjs'));
  for (const entry of content.entries()) {
    if (entry.license?.notice_file) copyInto(mirror, entry.license.notice_file);
    for (const asset of content.assets(entry.id, entry.kind)) copyInto(mirror, asset.path);
  }
  change(join(mirror, 'content'));
  execFileSync(process.execPath, [join(mirror, 'scripts', 'seal-content.mjs')], { cwd: mirror, stdio: 'pipe' });
  return mirror;
}
function copyInto(mirror, file) {
  if (!existsSync(join(root, file))) return;
  mkdirSync(join(mirror, file, '..'), { recursive: true });
  cpSync(join(root, file), join(mirror, file));
}
const readEntry = (directory, id) => JSON.parse(readFileSync(join(root, 'content', directory, `${id}.json`), 'utf8'));
const writeEntry = (contentRoot, directory, id, entry) => writeFileSync(join(contentRoot, directory, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');
const mirrorBundle = async (mirror) => (await import(pathToFileURL(join(mirror, 'content', 'index.js')).href)).default;

/** A brand-new definition of a shipped kind: the same envelope, no palette, no asset. */
const newDefinition = (id, kind, directory, extra) => ({
  schema_version: 1, id, kind, label: `${id} (mirror addition)`, since: '1.2.0', order: 99,
  license: {
    spdx: 'LicenseRef-NemoWorld-Project-Authored', author: 'NemoWorld project contributors',
    source: 'Original NemoWorld authored content: added by tests/content-determinism.test.js in a sealed mirror',
    commit: null, notice_file: 'content/THIRD_PARTY.md',
    notice_sha256: readEntry(directory, readdirSync(join(root, 'content', directory))[0].replace(/\.json$/, '')).license.notice_sha256,
    note: 'Added in a mirror to prove an additive content update moves nothing that was saved.',
  },
  appearance: { color: '#9fb39a', geometry: 'cube', transparent: false, emissive: null },
  ...extra,
});

test('a saved world reopens correctly after definitions are added, reordered and re-sealed', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice');

  // ---- 1. save land, blocks, plots and placements that reference sealed content ids ------------
  const home = f.platform.get("SELECT id FROM worlds WHERE kind='home' AND id LIKE ? ORDER BY id LIMIT 1", `%${alice.id}%`)?.id;
  assert.ok(home, 'the resident has a saved home world');
  const savedPlacements = [['bench', 4, 4], ['lantern', 5, 4], ['flowers', 6, 4], ['sundial', 7, 6]];
  for (const [index, [type, x, y]] of savedPlacements.entries()) {
    // The storage-layer guard derives its palette from the sealed content, so this insert only
    // succeeds because 'bench', 'lantern', 'flowers' and 'sundial' are sealed garden types.
    f.platform.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES (?,?,?,?,?,?)', `placement-${index}`, home, type, x, y, '2026-01-01T00:00:00.000Z');
  }
  assert.ok(savedPlacements.every(([type]) => GARDEN_PALETTE.includes(type)), 'the saved types are garden palette ids');
  // A saved planting and a saved shelf, both constrained by SQL derived from the sealed definitions.
  f.platform.run('INSERT INTO journey_crops(agent_id,x,y,kind,planted_at,tended_at,harvested_at) VALUES (?,?,?,?,?,?,?)', alice.id, 4, 7, 'herbs', 1_700_000_000_000, null, null);
  f.platform.run('INSERT INTO journey_crops(agent_id,x,y,kind,planted_at,tended_at,harvested_at) VALUES (?,?,?,?,?,?,?)', alice.id, 5, 7, 'resin', 1_700_000_100_000, null, null);
  f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES (?,?,?)', alice.id, 'herbs', 3);
  f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES (?,?,?)', alice.id, 'harvest_garland', 1);
  // Frontier land, a stewarded plot and a placed block column, through the product's own methods.
  const sector = 'frontier:0:0';
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', sector, 32, 32, alice.id);
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'A shared learning garden', description: 'An isolated determinism fixture.' });
  f.advance();
  const built = f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id: sector, x: 33, y: 32, z: 0, type: 'stone' });
  assert.equal(built.changed, true, 'a sealed frontier block type was placed');
  f.advance();
  f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id: sector, x: 34, y: 32, z: 0, type: 'clay' });

  const before = snapshot(f.platform);
  const storedTypes = {
    placements: f.platform.all('SELECT DISTINCT type FROM world_objects ORDER BY type').map((row) => row.type),
    blocks: f.platform.all('SELECT DISTINCT type FROM frontier_blocks ORDER BY type').map((row) => row.type),
    crops: f.platform.all('SELECT DISTINCT kind FROM journey_crops ORDER BY kind').map((row) => row.kind),
    inventory: f.platform.all('SELECT DISTINCT kind FROM journey_inventory ORDER BY kind').map((row) => row.kind),
  };
  // A saved shelf may hold a sealed crop or a crafted keepsake, and the crafted list is assembled by
  // src/journey.js from the sealed recipes plus its authored extensions. What matters for a saved
  // world is that the *set of holdable resources* does not change.
  const resourcesOf = (resolver) => [...new Set([
    ...Object.keys(resolver.crops()), ...resolver.recipes().map((recipe) => recipe.output), ...RECIPE_EXTENSIONS.map((recipe) => recipe.output),
  ])].sort();
  const resourcesBefore = resourcesOf(content);
  const storedWorldIds = f.platform.all('SELECT id FROM worlds ORDER BY id').map((row) => row.id);
  const derivedSql = { WORLD_OBJECT_GUARDS, FRONTIER_SCHEMA, JOURNEY_SCHEMA };
  const palettesBefore = { garden: [...GARDEN_PALETTE], house: [...content.palette('house')], frontier: [...FRONTIER_PALETTE], build: [...BUILD_PALETTE] };
  const shapesBefore = storedWorldIds.map((id) => JSON.stringify(getWorldDefinition(id)));
  const resolvedBefore = Object.fromEntries([...storedTypes.placements, ...storedTypes.blocks, ...storedTypes.crops].map((id) => {
    const entry = content.entry(id) ?? content.find(id)[0];
    return [id, JSON.stringify([entry?.kind, entry?.appearance.color, entry?.appearance.geometry])];
  }));

  // ---- 2. the content update: two definitions added, the authored order reversed, resealed ------
  const added = {
    furniture: 'orchard-lamp',
    block: 'mossstone',
  };
  const mirror = sealMirror((contentRoot) => {
    writeEntry(contentRoot, 'furniture', added.furniture, newDefinition(added.furniture, 'furniture', 'crops', {
      appearance: { color: '#9fb39a', geometry: 'prop', transparent: false, emissive: null },
      rules: { palettes: [], walkable: true, footprint: 'open', geometry: 'prop' },
    }));
    writeEntry(contentRoot, 'blocks', added.block, newDefinition(added.block, 'block', 'blocks', {
      rules: { palettes: [], walkable: false, stack: { requires_solid_below: true, z_min: 0, z_max: 7, supports_stacking: true }, path_only_z0: false },
    }));
    // Reverse the authored order of every shipped definition in both kinds. The ids, licences, rules
    // and assets are untouched: only the presentation sequence changes.
    for (const directory of ['furniture', 'blocks']) {
      const files = readdirSync(join(contentRoot, directory)).filter((name) => name.endsWith('.json'));
      const entries = files.map((name) => JSON.parse(readFileSync(join(contentRoot, directory, name), 'utf8')));
      const highest = Math.max(...entries.map((entry) => entry.order));
      for (const entry of entries) {
        entry.order = highest - entry.order;
        writeFileSync(join(contentRoot, directory, `${entry.id}.json`), JSON.stringify(entry, null, 2) + '\n');
      }
    }
  });
  t.after(() => rmSync(mirror, { recursive: true, force: true }));
  const mirrored = await mirrorBundle(mirror);
  const updated = createContent(mirrored);

  // ---- 3. the update happened ------------------------------------------------------------------
  assert.equal(mirrored.manifest.kinds.furniture, content.manifest().kinds.furniture + 1, 'the mirror added one furniture definition');
  assert.equal(mirrored.manifest.kinds.block, content.manifest().kinds.block + 1, 'the mirror added one block definition');
  assert.equal(mirrored.manifest.entries.length, content.manifest().entries.length + 2);
  // Reordering rewrites the *authored order field* and therefore the definition file's digest. What
  // must not change is everything the definition says: its id, its licence, its appearance and its
  // rules. Every kind the update did not touch must re-seal to byte-identical digests.
  const reordered = new Set(['furniture', 'block']);
  for (const entry of content.manifest().entries) {
    const sealed = mirrored.manifest.entries.find((item) => item.kind === entry.kind && item.id === entry.id);
    assert.ok(sealed, `${entry.kind}:${entry.id} is still sealed after the update`);
    const live = content.entry(entry.id, entry.kind);
    const updatedEntry = updated.entry(entry.id, entry.kind);
    assert.deepEqual(
      [updatedEntry.kind, updatedEntry.id, updatedEntry.license, updatedEntry.appearance, updatedEntry.rules],
      [live.kind, live.id, live.license, live.appearance, live.rules],
      `${entry.kind}:${entry.id} says exactly what it said before the update`);
    if (reordered.has(entry.kind)) assert.notEqual(sealed.sha256, entry.sha256, `${entry.file} was reordered, so its file digest changes while its content does not`);
    else assert.equal(sealed.sha256, entry.sha256, `${entry.file} re-sealed to the same digest when nothing about it changed`);
  }
  const furnitureBefore = content.entries('furniture').map((entry) => entry.id);
  const furnitureAfter = updated.entries('furniture').filter((entry) => furnitureBefore.includes(entry.id)).map((entry) => entry.id);
  assert.notDeepEqual(furnitureAfter, furnitureBefore, 'the authored reorder really changed the presented sequence');

  // ---- 4. nothing saved moved, and every stored id still resolves the same way -------------------
  assert.equal(snapshot(f.platform), before, 'every saved row is byte-identical after the content update');
  for (const [group, ids] of Object.entries(storedTypes)) {
    for (const id of ids) {
      if (group === 'inventory') continue;
      const entry = updated.entry(id) ?? updated.find(id)[0];
      assert.ok(entry, `the saved ${group} id ${id} still resolves after the update`);
      assert.equal(JSON.stringify([entry.kind, entry.appearance.color, entry.appearance.geometry]), resolvedBefore[id],
        `${id} resolves to the same kind, colour and builder it did before the update`);
    }
  }
  // Every holdable resource a saved shelf names is still holdable, and the list is the same list.
  assert.deepEqual(resourcesOf(updated), resourcesBefore, 'the set of resources a saved shelf can hold is unchanged');
  for (const id of storedTypes.inventory) assert.ok(resourcesBefore.includes(id), `${id} is a published resource before and after the update`);
  for (const id of storedWorldIds) assert.ok(updated.find(id) || getWorldDefinition(id), `${id} is still a resolvable world`);
  assert.deepEqual(storedWorldIds.map((id) => JSON.stringify(getWorldDefinition(id))), shapesBefore, 'every generated world shape is identical');
  // The SQL the storage layer enforces is derived from the sealed content and must not move either.
  assert.equal(WORLD_OBJECT_GUARDS, derivedSql.WORLD_OBJECT_GUARDS);
  assert.equal(FRONTIER_SCHEMA, derivedSql.FRONTIER_SCHEMA);
  assert.equal(JOURNEY_SCHEMA, derivedSql.JOURNEY_SCHEMA);
  assert.deepEqual({ garden: [...GARDEN_PALETTE], house: [...content.palette('house')], frontier: [...FRONTIER_PALETTE], build: [...BUILD_PALETTE] }, palettesBefore);
  // And the reordered layer still satisfies the manifest family validator over the whole bundle.
  const validation = validateContentFamilies({ entries: mirrored.entries, notices: mirrored.notices }, { content: updated });
  assert.equal(validation.ok, true, validation.refusals.map((refusal) => refusal.detail).join('\n'));
});

test('the safe update is additive and reordering; a removal or a collision is caught, not tolerated', async (t) => {
  // The boundary of the property above. Adding and reordering are safe; the two changes that would
  // actually break a saved world are refused by the layer rather than discovered later.
  const removed = sealMirror((contentRoot) => {
    rmSync(join(contentRoot, 'furniture', 'sundial.json'));
    const palettes = JSON.parse(readFileSync(join(contentRoot, 'palettes.json'), 'utf8'));
    for (const name of Object.keys(palettes.palettes)) palettes.palettes[name] = palettes.palettes[name].filter((id) => id !== 'sundial');
    writeFileSync(join(contentRoot, 'palettes.json'), JSON.stringify(palettes, null, 2) + '\n');
  });
  t.after(() => rmSync(removed, { recursive: true, force: true }));
  const withoutSundial = createContent(await mirrorBundle(removed));
  assert.equal(withoutSundial.entry('sundial', 'furniture'), undefined, 'a removed definition stops resolving, which is exactly why the update must be additive');
  assert.equal(withoutSundial.manifest().entries.some((item) => item.id === 'sundial'), false);
  // Every other garden type still resolves, so one removal does not corrupt the rest of the layer.
  for (const id of ['bench', 'lantern', 'flowers']) assert.ok(withoutSundial.entry(id, 'furniture'), `${id} still resolves`);
  assert.equal(GARDEN_PALETTE.includes('sundial'), true, 'the live palette is untouched by the mirror, because the mirror is not the tree');

  // A new authored-family definition whose id already belongs to a shipped kind is refused by the
  // validator. The resolver on its own tolerates it — it answers the ambiguous lookup in kind order —
  // and that tolerance is exactly why the extra rule exists.
  const colliding = sealMirror((contentRoot) => {
    // 'sundial' is a sealed garden furniture id. A resident of the same id would make the resolver's
    // no-kind lookup ambiguous between a placeable object and a role.
    writeEntry(contentRoot, 'residents', 'sundial', newDefinition('sundial', 'resident', 'residents', {
      appearance: { color: null, geometry: 'resident-role', transparent: false, emissive: null },
      rules: {
        palettes: [], family: 'residents', place: 'terrace-flight-venue', role: 'sundial keeper', appearance: 'mayor-3',
        schedule: { unit: 'tick', slots: [10, 40], ordering: 'authored' },
        dialogue_topics: ['which bund is which'],
        remit: 'Answers only from this fictional place. Holds no office, signs nothing, and speaks for no country, people or institution.',
        independence: {
          fictional: true, claims_endorsement: false, government_role: false, un_role: false,
          statement: 'A fictional NemoWorld space. It is not a government, ministry, embassy or United Nations office, and nothing here asserts endorsement, representation or official status.',
        },
      },
    }));
  });
  t.after(() => rmSync(colliding, { recursive: true, force: true }));
  const collidingBundle = await mirrorBundle(colliding);
  const resolver = createContent(collidingBundle);
  assert.deepEqual(resolver.find('sundial').map((entry) => entry.kind), ['furniture', 'resident'], 'the bare resolver answers the ambiguous lookup in kind order');
  const result = validateContentFamilies({ entries: collidingBundle.entries, notices: collidingBundle.notices }, { content: resolver });
  assert.equal(result.ok, false, 'a cross-kind id collision is refused');
  assert.ok(result.refusals.some((refusal) => refusal.code === 'id-collision' && refusal.detail.includes('sundial')));
  // A collision between two *shipped* kinds is not refused: 'wood' is a shipped block and a shipped
  // crop, and that predates this layer. The rule is about the authored families, not about history.
  assert.deepEqual(content.find('wood').map((entry) => entry.kind), ['block', 'crop']);
});

test('widening a palette is a different kind of change: it rewrites SQL the storage layer enforces', async (t) => {
  // Recorded rather than smoothed over. Adding a definition with palettes: [] is a purely additive
  // change (the test above). Adding one *to a palette* changes the guard text a database was created
  // with, which is a schema-shaped change and not something this slice may ship silently.
  const widened = sealMirror((contentRoot) => {
    const entry = newDefinition('orchard-lamp', 'furniture', 'crops', {
      appearance: { color: '#9fb39a', geometry: 'prop', transparent: false, emissive: null },
      rules: { palettes: ['garden'], walkable: true, footprint: 'open', geometry: 'prop' },
    });
    writeEntry(contentRoot, 'furniture', 'orchard-lamp', entry);
    const palettes = JSON.parse(readFileSync(join(contentRoot, 'palettes.json'), 'utf8'));
    palettes.palettes.garden = [...palettes.palettes.garden, 'orchard-lamp'];
    writeFileSync(join(contentRoot, 'palettes.json'), JSON.stringify(palettes, null, 2) + '\n');
  });
  t.after(() => rmSync(widened, { recursive: true, force: true }));
  const bundle = await mirrorBundle(widened);
  const runtime = createContent(bundle);
  assert.deepEqual(runtime.palette('garden').slice(-1), ['orchard-lamp'], 'the mirror palette really did widen');
  // The live tree is untouched by any of this, which is what keeps the shipped world stable.
  assert.equal(BUILD_PALETTE.includes('orchard-lamp'), false);
  assert.equal(GARDEN_PALETTE.includes('orchard-lamp'), false);
  const guardOf = (garden) => `CREATE TRIGGER IF NOT EXISTS world_objects_build_guard BEFORE INSERT ON world_objects
  WHEN NOT EXISTS(SELECT 1 FROM worlds w WHERE w.id=NEW.world_id AND NEW.x>=0 AND NEW.x<w.width AND NEW.y>=0 AND NEW.y<w.height
  AND ((w.kind='home' AND NEW.type IN (${garden.map((type) => `'${type}'`).join(',')})) OR (w.kind='house' AND NEW.type IN (${content.palette('house').map((type) => `'${type}'`).join(',')})))) BEGIN SELECT RAISE(ABORT,'Garden objects must use the build palette inside their own garden or cottage'); END;`;
  assert.notEqual(guardOf(runtime.palette('garden')), guardOf(GARDEN_PALETTE), 'a widened palette produces different guard SQL from the text the shipped database carries');
  assert.ok(!WORLD_OBJECT_GUARDS.includes('orchard-lamp'));
});
