/**
 * GPU-free voxel scene benchmark. Reports instance totals, discrete rebuild counts, and wall-clock
 * ms for the updates the browser actually performs, then repeats them with the pre-change behaviour
 * restored through the documented escape hatches (`cullHidden: false`, `rebuildPeople: true`).
 *
 * Reference numbers only: this is a script, not a CI assertion, because timings vary by machine.
 * The voxel view repaints every 3 s (the 220 ms loop in app.js is pixel-mode only), so these costs
 * amortise; the win is per-poll churn on the main thread and GPU buffers, not a higher frame rate.
 * Rebuild counts are machine-independent; the ms columns are medians of RUNS updates.
 *
 *   node scripts/voxel-bench.mjs [participants]
 */
import { performance } from 'node:perf_hooks';
import { getWorldDefinition } from '../world.js';
import { createVoxelScene } from '../src/voxel-world.js';

const world = getWorldDefinition('commons');
const population = Math.max(1, Number.parseInt(process.argv[2] ?? '20', 10) || 20);
const RUNS = 20;

const roster = () => Array.from({ length: population }, (_, index) => ({
  id: `agent-${index}`, name: `Agent ${index}`, kind: index % 7 === 0 ? 'npc' : 'human',
  x: 4 + index % 9, y: 4 + Math.floor(index / 9) * 2, color: ['teal', 'coral', 'gold', 'blue'][index % 4],
  posture: index % 3 === 0 ? 'sitting' : 'standing', status: 'active',
  last_seen: `2026-10-12T00:00:${String(index).padStart(2, '0')}Z`, has_session: true, accepted_contributions: index,
}));

const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ms = value => `${value.toFixed(1)} ms`;
/** "meshes / instances" for one batch group, matching the format the engine notes use. */
const groupShape = (scene, name) => {
  const group = scene.root.getObjectByName(name);
  return group ? `${group.children.length} / ${group.children.reduce((sum, mesh) => sum + mesh.count, 0)}` : '0 / 0';
};
const measure = (runs, operation) => {
  const times = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    operation(index);
    times.push(performance.now() - start);
  }
  return median(times);
};

function bench({ cullHidden = true, rebuildPeople = false }) {
  const scene = createVoxelScene(), participants = roster();
  const options = { position: world.start, self: participants[0], cullHidden, rebuildPeople };
  const coldMs = measure(1, () => scene.update(world, { participants }, options));
  const cold = scene.stats;
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
  const rebuild = measure(RUNS, index => {
    tiles[7][7] = index % 2 ? 'stone' : 'meadow';
    scene.update(world, { participants, blocks, camera: { x: 0, y: 0 }, terrain: tiles }, options);
  });
  scene.destroy();
  return { cold, coldMs, instances, idle, poll, peopleRebuilds, edit, staticEdits, blockEdits, rebuild };
}

bench({}); // warm the JIT and the lazy Three.js paths before the measured passes
const after = bench({}), before = bench({ cullHidden: false, rebuildPeople: true });
const { window } = after.cold;
const row = (name, beforeValue, afterValue) => console.log(`${name.padEnd(32)}${String(beforeValue).padStart(22)}${String(afterValue).padStart(20)}`);

console.log(`commons · ${population} participants · ${window.right - window.x}x${window.bottom - window.y} window · ${after.cold.cells} cells · median of ${RUNS}`);
row('', 'before', 'after');
row('terrain meshes / instances', before.instances.terrain, after.instances.terrain);
row('character meshes / instances', before.instances.people, after.instances.people);
row('saved-block meshes / instances', before.instances.blocks, after.instances.blocks);
row('total cubes / draw batches', `${before.cold.cubes} / ${before.cold.drawBatches}`, `${after.cold.cubes} / ${after.cold.drawBatches}`);
console.log('');
row('first build (cold)', ms(before.coldMs), ms(after.coldMs));
row('idle poll (identical payload)', ms(before.idle), ms(after.idle));
row('participant poll', ms(before.poll), ms(after.poll));
row('character rebuilds per 20 polls', before.peopleRebuilds, after.peopleRebuilds);
console.log('');
row('one-block edit (old = whole build)', ms(before.rebuild), ms(after.edit));
row('terrain rebuilds per 20 edits', before.staticEdits, after.staticEdits);
row('block rebuilds per 20 edits', before.blockEdits, after.blockEdits);
row('whole static build (terrain tile)', ms(before.rebuild), ms(after.rebuild));
