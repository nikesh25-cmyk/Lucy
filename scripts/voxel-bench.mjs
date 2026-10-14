/**
 * GPU-free voxel scene benchmark. Reports instance totals, discrete rebuild counts, and wall-clock
 * ms for the updates the browser actually performs, then repeats them with the pre-change behaviour
 * restored through the documented escape hatches (`cullHidden: false`, `rebuildPeople: true`).
 * It also reports where the cubes went (the scene's own layer tally) and what a day-phase change
 * costs, which is the one poll that touches the sky layer alone.
 *
 * A second section measures level of detail on two bounded fixtures: where the decoration goes, what
 * a static rebuild costs, and what the largest viewport the server can request costs, each with the
 * detail rule on and with the pre-LOD build restored through `lod: false`. That pair is the
 * before/after evidence for the detail rule; instance counts, draw calls and rebuild counts are exact
 * and machine-independent, while the ms columns are medians of RUNS updates and vary by machine.
 *
 * Reference numbers only: this is a script, not a CI assertion. The voxel view repaints every 3 s
 * (the 220 ms loop in app.js is pixel-mode only), so these costs amortise; the win is per-poll churn
 * on the main thread and GPU buffers, not a higher frame rate. The asserted budgets live in
 * tests/render-lod.test.js and tests/render-scene.test.js.
 *
 *   node scripts/voxel-bench.mjs [participants] [runs]
 */
import { performance } from 'node:perf_hooks';
import { getWorldDefinition } from '../world.js';
import { DIORAMA_BUDGET, LOD_LIMITS } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';

// The two bounded fixtures: the shared Commons, and the largest viewport the server can request
// (a frontier sector, whose 37 x 37 window is the whole of VOXEL_LIMITS.cells).
const FIXTURES = ['commons', 'frontier:0:0'];
const population = Math.max(1, Number.parseInt(process.argv[2] ?? '20', 10) || 20);
// The update is allocation-bound, so a median over more samples is the honest number: a run of 20
// can differ from the next by a factor of two when a collection lands inside one sample.
const RUNS = Math.max(5, Number.parseInt(process.argv[3] ?? '20', 10) || 20);

const roster = () => Array.from({ length: population }, (_, index) => ({
  id: `agent-${index}`, name: `Agent ${index}`, kind: index % 7 === 0 ? 'npc' : 'human',
  x: 4 + index % 9, y: 4 + Math.floor(index / 9) * 2, color: ['teal', 'coral', 'gold', 'blue'][index % 4],
  posture: index % 3 === 0 ? 'sitting' : 'standing', status: 'active',
  last_seen: `2026-10-12T00:00:${String(index).padStart(2, '0')}Z`, has_session: true, accepted_contributions: index,
}));
/** The same crowd, placed around whichever arrival the fixture has. */
const crowd = (definition, count = population) => Array.from({ length: count }, (_, index) => ({
  id: `agent-${index}`, name: `Agent ${index}`, kind: index % 7 === 0 ? 'npc' : 'human',
  x: definition.start.x + index % 7, y: definition.start.y + Math.floor(index / 7) % 7, z: 0,
  color: ['teal', 'coral', 'gold', 'blue'][index % 4], posture: index % 3 === 0 ? 'sitting' : 'standing', status: 'active',
}));

const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ms = value => `${value.toFixed(1)} ms`;
/** "meshes / instances" for one batch group, matching the format the engine notes use. */
const groupShape = (scene, name) => {
  const group = scene.root.getObjectByName(name);
  return group ? `${group.children.length} / ${group.children.reduce((sum, mesh) => sum + mesh.count, 0)}` : '0 / 0';
};
const measure = (runs, operation) => sample(runs, operation).median;
/**
 * A median and a minimum for one operation. The median is the honest central estimate; the minimum is
 * the least perturbed sample, which is the closest thing to the operation's own cost when the
 * collector is the thing being measured as much as the code is.
 */
function sample(runs, operation) {
  const times = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    operation(index);
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return { median: times[Math.floor(times.length / 2)], min: times[0] };
}
/**
 * The cost of a first build, measured as a median over fresh scenes. One sample of a build this
 * allocation-heavy is dominated by whatever the collector happens to be doing on this machine, so a
 * single number would be noise dressed as a measurement.
 */
function coldBuild(definition, participants, lod, samples = 3) {
  const times = [];
  for (let index = 0; index < samples; index++) {
    const scene = createVoxelScene(), start = performance.now();
    scene.update(definition, { participants }, { position: definition.start, self: participants[0], lod });
    times.push(performance.now() - start); scene.destroy();
  }
  times.sort((left, right) => left - right);
  return { median: times[Math.floor(times.length / 2)], min: times[0] };
}

function bench({ cullHidden = true, rebuildPeople = false, lod = undefined }) {
  const world = getWorldDefinition('commons'), participants = roster();
  const scene = createVoxelScene();
  const options = { position: world.start, self: participants[0], cullHidden, rebuildPeople, ...(lod === undefined ? {} : { lod }) };
  const cold = scene.update(world, { participants }, options);
  const coldMs = coldBuild(world, participants, lod);
  const instances = { terrain: groupShape(scene, 'voxel-terrain'), people: groupShape(scene, 'voxel-characters'), blocks: groupShape(scene, 'voxel-blocks') };
  const rebuilt = name => {
    const before = scene.root.getObjectByName(name);
    return () => scene.root.getObjectByName(name) !== before;
  };

  // An idle poll: identical payload, so it measures plan construction plus the batch keys alone.
  const idle = measure(RUNS, () => scene.update(world, { participants }, options));

  // Every 3 s poll refreshes `last_seen` and re-orders the roster by it, but no visible field moves.
  let rotation = 0, peopleRebuilds = 0;
  const poll = measure(RUNS, index => {
    rotation = (rotation + 1) % participants.length;
    const ordered = [...participants.slice(rotation), ...participants.slice(0, rotation)];
    ordered[0].last_seen = `2026-10-12T00:0${index % 10}:${String(index).padStart(2, '0')}Z`;
    const changed = rebuilt('voxel-characters');
    scene.update(world, { participants: ordered }, options);
    if (changed()) peopleRebuilds++;
  });

  const blocks = [{ id: 'bench-block', x: 10, y: 8, z: 0, type: 'wood' }];
  scene.update(world, { participants, blocks }, options);
  let staticEdits = 0, blockEdits = 0;
  const edit = measure(RUNS, index => {
    blocks[0] = { ...blocks[0], z: index % 2 ? 0 : 1 };
    const changed = rebuilt('voxel-terrain'), blocksChanged = rebuilt('voxel-blocks');
    scene.update(world, { participants, blocks }, options);
    if (changed()) staticEdits++; if (blocksChanged()) blockEdits++;
  });

  // A terrain tile change re-runs the whole static build: the cost a one-block edit carried before.
  const tiles = world.terrain.map(row => [...row]);
  scene.update(world, { participants, blocks, camera: { x: 0, y: 0 }, terrain: tiles }, options);
  const rebuild = measure(RUNS, index => {
    tiles[7][7] = index % 2 ? 'stone' : 'meadow';
    scene.update(world, { participants, blocks, camera: { x: 0, y: 0 }, terrain: tiles }, options);
  });

  // A day-phase change: only the sky layer should follow it, never the diorama or the residents.
  let skyRebuilds = 0, terrainAcrossPhase = 0, peopleAcrossPhase = 0;
  const phase = measure(RUNS, index => {
    const skyChanged = rebuilt('voxel-sky'), terrainChanged = rebuilt('voxel-terrain'), peopleChanged = rebuilt('voxel-characters');
    scene.update(world, { participants }, { ...options, dayPhase: index % 2 ? 'night' : 'day' });
    if (skyChanged()) skyRebuilds++; if (terrainChanged()) terrainAcrossPhase++; if (peopleChanged()) peopleAcrossPhase++;
  });
  const layers = scene.stats.layers;
  scene.destroy();
  return { cold, coldMs, instances, idle, poll, peopleRebuilds, edit, staticEdits, blockEdits, rebuild, phase, skyRebuilds, terrainAcrossPhase, peopleAcrossPhase, layers };
}

/**
 * One fixture, built twice: with the detail rule, and with the pre-LOD build restored. `cold` reports
 * the first build, `rebuild` the cost of a build forced by a terrain tile edit, and `poll` the cost of
 * a repeated payload, which reuses every batch. Each timed row is a median with the least perturbed
 * sample beside it. Everything else is read from the scene's own report, so the numbers describe what
 * was drawn rather than what was intended.
 */
function viewport(id, runs = RUNS) {
  const definition = getWorldDefinition(id), participants = crowd(definition);
  const terrain = definition.terrain.map(row => [...row]);
  const snapshot = { participants, camera: { x: 0, y: 0 }, terrain };
  const side = (lod) => {
    const scene = createVoxelScene(), options = { position: definition.start, self: participants[0], lod };
    const cold = scene.update(definition, { participants }, options);
    const coldMs = coldBuild(definition, participants, lod);
    const shapes = { terrain: groupShape(scene, 'voxel-terrain'), people: groupShape(scene, 'voxel-characters'), blocks: groupShape(scene, 'voxel-blocks') };
    let index = 0;
    const rebuildMs = sample(runs, () => { index++; terrain[6][6] = index % 2 ? 'stone' : 'meadow'; scene.update(definition, snapshot, options); });
    const pollMs = sample(runs, () => scene.update(definition, snapshot, options));
    const decoration = cold.layers.cover + cold.layers.understory;
    scene.destroy();
    return { cold, coldMs, shapes, rebuildMs, pollMs, decoration };
  };
  return { id, definition, full: side(false), lod: side(true) };
}

/** "median (min)" for the detail section, where the collector can dominate a single sample. */
const best = entry => `${entry.median.toFixed(1)} (${entry.min.toFixed(1)}) ms`;
const detailRow = (name, before, after) => console.log(`${name.padEnd(34)}${String(before).padStart(18)}${String(after).padStart(18)}`);
function reportDetail(fixture) {
  const { full, lod } = fixture, area = full.cold.window;
  console.log('');
  console.log(`level of detail · ${fixture.id} · ${population} participants · ${area.right - area.x}x${area.bottom - area.y} window · ${full.cold.cells} cells`);
  detailRow('', 'pre-LOD (lod: false)', 'detail rule');
  detailRow('terrain meshes / instances', full.shapes.terrain, lod.shapes.terrain);
  detailRow('character meshes / instances', full.shapes.people, lod.shapes.people);
  detailRow('total cubes / draw batches', `${full.cold.cubes} / ${full.cold.drawBatches}`, `${lod.cold.cubes} / ${lod.cold.drawBatches}`);
  detailRow('cells read at full detail', full.cold.detail.fine, lod.cold.detail.fine);
  detailRow('cells beyond the radius', full.cold.detail.coarse, lod.cold.detail.coarse);
  detailRow('decorative instances (cover+understory)', full.decoration, lod.decoration);
  console.log('');
  console.log('  timed rows: median (least perturbed sample), ms — the instance rows above are exact');
  detailRow('first build (3 fresh scenes)', best(full.coldMs), best(lod.coldMs));
  detailRow(`static rebuild (${RUNS} samples)`, best(full.rebuildMs), best(lod.rebuildMs));
  detailRow(`poll on an unchanged payload (${RUNS})`, best(full.pollMs), best(lod.pollMs));
  console.log(`  ${((1 - lod.cold.cubes / full.cold.cubes) * 100).toFixed(1)}% fewer instances, ${((1 - lod.decoration / full.decoration) * 100).toFixed(0)}% less decoration, ${lod.cold.cubes} drawn`);
}

bench({}); // warm the JIT and the lazy Three.js paths before the measured passes
// The "before" column is the whole pre-change renderer: the coarser cull of task 14, the
// always-rebuild character batch, and the pre-LOD static build.
const after = bench({}), before = bench({ cullHidden: false, rebuildPeople: true, lod: false });
const { window } = after.cold;
const row = (name, beforeValue, afterValue) => console.log(`${name.padEnd(32)}${String(beforeValue).padStart(22)}${String(afterValue).padStart(20)}`);

console.log(`commons · ${population} participants · ${window.right - window.x}x${window.bottom - window.y} window · ${after.cold.cells} cells · median of ${RUNS}`);
row('', 'before', 'after');
row('terrain meshes / instances', before.instances.terrain, after.instances.terrain);
row('character meshes / instances', before.instances.people, after.instances.people);
row('saved-block meshes / instances', before.instances.blocks, after.instances.blocks);
row('total cubes / draw batches', `${before.cold.cubes} / ${before.cold.drawBatches}`, `${after.cold.cubes} / ${after.cold.drawBatches}`);
console.log('');
row('first build (3 fresh scenes) median(min)', best(before.coldMs), best(after.coldMs));
row('idle poll (identical payload)', ms(before.idle), ms(after.idle));
row('participant poll', ms(before.poll), ms(after.poll));
row(`character rebuilds per ${RUNS} polls`, before.peopleRebuilds, after.peopleRebuilds);
console.log('');
row('one-block edit (old = whole build)', ms(before.rebuild), ms(after.edit));
row(`terrain rebuilds per ${RUNS} edits`, before.staticEdits, after.staticEdits);
row(`block rebuilds per ${RUNS} edits`, before.blockEdits, after.blockEdits);
row('whole static build (terrain tile)', ms(before.rebuild), ms(after.rebuild));
console.log('');
// A day-phase change follows the sky layer only. The two columns differ because the "before" pass
// additionally forces the character batch and disables the occlusion cull, not because of the phase.
row('day-phase poll', ms(before.phase), ms(after.phase));
row(`sky rebuilds per ${RUNS} phase polls`, before.skyRebuilds, after.skyRebuilds);
row(`terrain rebuilds per ${RUNS} phase polls`, before.terrainAcrossPhase, after.terrainAcrossPhase);
row(`character rebuilds per ${RUNS} phase polls`, before.peopleAcrossPhase, after.peopleAcrossPhase);
console.log('');
console.log('where the cubes went (after column, from the scene\'s own layer tally)');
for (const [name, count] of Object.entries(after.layers).sort((left, right) => right[1] - left[1])) {
  console.log(`  ${name.padEnd(16)}${String(count).padStart(6)}  ${((count / after.cold.cubes) * 100).toFixed(1)}%`);
}

console.log('');
console.log(`detail radius ${LOD_LIMITS.detail_radius} tiles · ${(2 * LOD_LIMITS.detail_radius + 1) ** 2} cells may be read at full detail, whatever the window`);
console.log(`stated budget ${DIORAMA_BUDGET.instances} world instances + ${DIORAMA_BUDGET.participant_instances} at the participant bound + ${DIORAMA_BUDGET.block_instances} at the block bound, ${DIORAMA_BUDGET.draw_calls} draw calls (tests/render-lod.test.js)`);
for (const id of FIXTURES) reportDetail(viewport(id));
