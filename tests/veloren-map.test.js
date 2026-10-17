// Harr's map: the roads, gateways and landscaping appended to the world manifest by tools/gen-harr-network.py.
//
// The gate is twofold. tools/check-harr-map.py (shared geometry in tools/harr_layout.py) checks every group, works
// and map together: limits, area, 3D voxel overlaps between projects, flush paving with a foundation, lamps, one
// connected network, every work site reached, six district colours and six gateways. This file runs it, repeats the
// overlap and budget arithmetic independently in JavaScript, and runs NemoWorld's validator and (when the binary
// exists) the game's checker over the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, MANIFEST_LIMITS } from '../src/veloren-ext/world-manifest.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const MANIFEST = join(root, 'content', 'veloren-world-harr.json');
const CHECKER = join(here, '..', '..', 'target', 'world', 'release', 'nemo-world-check');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const catalogue = JSON.parse(readFileSync(join(root, 'content', 'veloren-projects.json'), 'utf8'));
const isMap = (g) => String(g.project || '').startsWith('map-');
const PLOTS = { 'Plaza:0': [0, 0], 'House:0': [12, 30], 'Workshop:0': [-6, 18], 'FarmField:0': [18, 48], 'FarmField:1': [12, 6] };

function python() {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

test('the map adds roads, gateways and lawns as many staged projects, none needing a crew', () => {
  const groups = manifest.groups.filter(isMap);
  const projects = new Map();
  for (const g of groups) projects.set(g.project, [...(projects.get(g.project) || []), g]);
  assert.ok(projects.size >= 40, `map projects: ${projects.size}`);
  for (const [id, stages] of projects) {
    assert.ok(stages.length >= 2, `${id} has stages`);
    const times = stages.map((g) => g.release_after_minutes);
    assert.deepEqual([...times].sort((a, b) => a - b), times, `${id} is released in order`);
    assert.ok(times[0] > 0, `${id} appears progressively, not at once`);
    assert.ok(stages.every((g) => !g.crew), `${id} needs no crew`);
    assert.ok(catalogue.projects.some((p) => p.id === id && p.stages === stages.length), `${id} is on the works board`);
  }
  for (const district of ['learning', 'making', 'living', 'gathering', 'energy', 'transport']) {
    assert.ok(projects.has(`map-gate-${district}`), `a gateway for ${district}`);
  }
  assert.ok(projects.has('map-plaza') && [...projects.keys()].some((id) => id.startsWith('map-road-')) && [...projects.keys()].some((id) => id.startsWith('map-path-')), 'plaza, roads and site paths');
  const spread = groups.map((g) => g.release_after_minutes);
  assert.ok(Math.max(...spread) - Math.min(...spread) >= 120, 'the roads appear over hours, not minutes');
});

test('paving is pale Rock flush with the ground, teal-edged, lit, and every group respects the limits (independent JavaScript check)', () => {
  const claims = new Map();
  let total = 0;
  const conflicts = [];
  for (const g of manifest.groups) {
    const [px, py] = PLOTS[`${g.anchor.plot}:${g.anchor.nth || 0}`];
    const bx = px + (g.anchor.dx || 0);
    const by = py + (g.anchor.dy || 0);
    const key = g.project || g.id;
    const cells = new Map();
    let found = 0;
    for (const op of g.ops) {
      if (op.op === 'foundation') {
        found += (Math.abs(op.to[0] - op.from[0]) + 1) * (Math.abs(op.to[1] - op.from[1]) + 1);
        assert.ok(op.depth >= 1 && op.depth <= 12, `${g.id} foundation depth`);
        continue;
      }
      const [a, b] = op.op === 'sprite' ? [op.at, op.at] : [op.from, op.to];
      for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) {
        for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) {
          for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) {
            cells.set(`${bx + x},${by + y},${z}`, op.op === 'fill' ? `B${op.kind}${op.rgb}` : op.op === 'clear' ? 'A' : `S${op.sprite}`);
          }
        }
      }
    }
    assert.ok(cells.size <= 6000, `${g.id} blocks per group`);
    total += cells.size + found;
    for (const [cell, what] of cells) {
      const prev = claims.get(cell);
      if (prev && prev.key !== key && !(prev.what === 'A' && what === 'A') && prev.what !== what) conflicts.push(`${key} vs ${prev.key} at ${cell}`);
      claims.set(cell, { key, what });
    }
  }
  assert.deepEqual(conflicts, [], 'no two projects write the same voxel');
  assert.ok(total <= MANIFEST_LIMITS.max_blocks_total, `${total} blocks in total`);
  assert.ok(manifest.groups.length <= MANIFEST_LIMITS.max_groups, `${manifest.groups.length} groups`);
  // every map group that lays paving does it at z=0 in Rock and has a foundation of depth 1-2 under it
  for (const g of manifest.groups.filter(isMap)) {
    const floors = g.ops.filter((op) => op.op === 'fill' && op.kind === 'Rock' && op.from[2] === 0 && op.to[2] === 0);
    if (!floors.length) continue;
    assert.ok(g.ops.some((op) => op.op === 'foundation' && op.depth >= 1 && op.depth <= 2), `${g.id} has a foundation`);
    assert.ok(g.ground_at.every((v) => v === 0), `${g.id} measures its ground at its own anchor`);
  }
  const lamps = manifest.groups.flatMap((g) => g.ops).filter((op) => op.op === 'sprite' && /^StreetLamp/.test(op.sprite));
  assert.ok(lamps.length >= 35, `street lamps: ${lamps.length}`);
  const signs = manifest.groups.filter(isMap).flatMap((g) => g.ops).filter((op) => op.op === 'sprite' && /^Sign/.test(op.sprite));
  assert.ok(signs.length >= 10, `signposts: ${signs.length}`);
});

test('tools/check-harr-map.py: every group, one connected network, every site reached, lit, six districts, six gateways', (t) => {
  if (!python()) return t.skip('python3 is not installed');
  const run = spawnSync('python3', [join(root, 'tools', 'check-harr-map.py'), '--json'], { cwd: root, encoding: 'utf8' });
  const out = JSON.parse(run.stdout);
  assert.deepEqual([out.errors, out.overlaps], [[], []], 'no errors and no overlaps');
  assert.equal(run.status, 0);
  assert.equal(out.stats.network_components, 1, 'one connected road network');
  assert.deepEqual(out.stats.unreached_sites, [], 'every work site is on the road network');
  assert.ok(out.stats.worst_lamp_distance <= 12, 'lit');
  assert.ok(out.stats.total_blocks <= 60000);
});

test('the map keeps NemoWorld and the game satisfied, and stays peaceful', (t) => {
  assert.deepEqual(validateManifest(manifest), [], 'NemoWorld accepts the manifest');
  if (existsSync(CHECKER)) {
    const run = spawnSync(CHECKER, [MANIFEST], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } else t.diagnostic('nemo-world-check is not built here; the Rust cross-check was skipped');
  const text = JSON.stringify(manifest.groups.filter(isMap)).toLowerCase() + JSON.stringify(catalogue.projects.filter((p) => p.id.startsWith('map-'))).toLowerCase();
  for (const word of ['kill', 'fight', 'attack', 'weapon', 'enemy', 'battle', 'blood', 'dungeon', 'loot', 'raid', 'steal', 'slay', 'danger']) assert.ok(!text.includes(word), `no "${word}" in the map`);
});
