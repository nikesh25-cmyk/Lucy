// Level of detail, the instance budget it exists to respect, and the reduced-motion contract.
//
// The renderer draws one window of terrain around the resident the camera follows. Far from that
// resident, a tile keeps every instance that decides *what it is* — its surface, its obstacle, its
// pick — and loses the instances that only decide *how its ground reads*. These tests hold the four
// things that must stay true when detail stops:
//
//   1. the near field is untouched, and every dropped instance is unpicked decoration on a coarse tile;
//   2. a coarse tile is still drawn as exactly the tile src/footprints.js says the server enforces,
//      in both directions — walkable stays clear, refused stays visible;
//   3. the decoration cost is bounded by the detail radius and therefore does not grow with the
//      window, so the largest viewport the server can request stays inside the stated budget;
//   4. `prefers-reduced-motion` is honoured: residents are drawn on their confirmed tile and the
//      renderer is told it has nothing to animate.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { REGIONS } from '../src/civic.js';
import { GROUND_DETAIL, KNEE_HEIGHT, RESIDENT_CLEARANCE, RESIDENT_HEIGHT, TERRAIN_BLOCKING, solidTileKeys, standableTile } from '../src/footprints.js';
import { DIORAMA_BUDGET, LOD_LIMITS, VOXEL_LIMITS, detailTier, inDetail, prefersReducedMotion, reducedMotionPreference, voxelAnchor, voxelPlan } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';

const commons = getWorldDefinition('commons');
const widestFine = (2 * LOD_LIMITS.detail_radius + 1) ** 2;
const worlds = ['commons', 'frontier:0:0', 'frontier:-3:5', 'country:NPL', 'home:sample', 'house:sample',
  ...REGIONS.slice(0, 3).map((region) => `district:${region.id}`)];

/** The real instance matrices the GPU would receive, with the box each occupies and its pick. */
function drawn(scene) {
  const boxes = [], matrix = new THREE.Matrix4();
  for (const group of scene.root.children) for (const mesh of group.children) {
    if (!mesh.userData.picks) continue;
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix);
      const e = [...matrix.elements];
      boxes.push({ group: group.name, color: mesh.material.color.getHexString(), matrix: e.map((value) => value.toFixed(5)),
        centreX: e[12], height: e[13], centreY: e[14],
        halfWidth: Math.abs(e[0]) / 2, halfHeight: Math.abs(e[5]) / 2, halfLength: Math.abs(e[10]) / 2,
        pick: mesh.userData.picks[index] ?? null });
    }
  }
  return boxes;
}
const tileOf = (box) => ({ x: Math.floor(box.centreX), y: Math.floor(box.centreY) });
const keyOf = (box) => `${box.color}|${box.matrix.join(',')}`;
const multiset = (boxes) => boxes.map(keyOf).sort();
const column = (x, y) => ({ minX: x + .5 - RESIDENT_CLEARANCE, maxX: x + .5 + RESIDENT_CLEARANCE, minY: y + .5 - RESIDENT_CLEARANCE, maxY: y + .5 + RESIDENT_CLEARANCE });
const overColumn = (box, tile) => box.centreX - box.halfWidth < tile.maxX && box.centreX + box.halfWidth > tile.minX &&
  box.centreY - box.halfLength < tile.maxY && box.centreY + box.halfLength > tile.minY;
/** A box a standing resident would be inside: it reaches above the floor decal and below the head. */
const entersStanding = (box, tile) => overColumn(box, tile) && box.height + box.halfHeight > GROUND_DETAIL && box.height - box.halfHeight < RESIDENT_HEIGHT;
const overKnee = (box, tile) => overColumn(box, tile) && box.height + box.halfHeight > KNEE_HEIGHT && box.height - box.halfHeight < RESIDENT_HEIGHT;
/**
 * The body ring of one participant, read from the real instance matrix. It is the one body box drawn
 * at the tile centre with no limb offset, so it reports exactly where the renderer placed the resident.
 */
const ringOf = (scene, id) => drawn(scene).find((box) => box.pick?.participant?.id === id && box.color === 'e2ca83');
const anchorsOf = (definition) => [definition.start, { x: 1, y: 1 }, { x: Math.max(0, definition.columns - 2), y: Math.max(0, definition.rows - 2) }];

test('the detail tier is a pure function of the anchor, and Infinity is the documented pre-LOD view', () => {
  const anchor = { x: 10, y: 6 };
  assert.equal(detailTier(10, 6, anchor), 'fine', 'the tile the resident stands on is read at full detail');
  assert.equal(detailTier(10 + LOD_LIMITS.detail_radius, 6, anchor), 'fine', 'the radius is inclusive');
  assert.equal(detailTier(10 + LOD_LIMITS.detail_radius + 1, 6, anchor), 'coarse');
  assert.equal(detailTier(6, 6 + LOD_LIMITS.detail_radius + 1, anchor), 'coarse', 'the distance is Chebyshev, not Manhattan');
  assert.equal(detailTier(-3, -7, anchor), 'coarse');
  // Fail safe: without a tile anchor nothing may lose detail, and a radius that is not a number falls
  // back to the shipped one instead of turning every tile coarse.
  for (const missing of [null, undefined, {}, { x: 1.5, y: 2 }, { x: 1, y: null }]) assert.equal(detailTier(0, 0, missing), 'fine', `${JSON.stringify(missing)} leaves every tile fine`);
  assert.equal(detailTier(1.5, 2, anchor), 'fine', 'only integer cells are addressed');
  assert.equal(detailTier(9999, 9999, anchor, NaN), 'coarse', 'a NaN radius means the shipped one');
  assert.equal(detailTier(9999, 9999, anchor, 'wide'), 'coarse', 'so does a radius that is not a number');
  assert.equal(detailTier(9999, 9999, anchor, -1), 'coarse', 'a negative radius cannot make a tile finer');
  assert.equal(detailTier(9999, 9999, anchor, Infinity), 'fine', 'Infinity is the escape hatch the benchmark uses');
  assert.equal(inDetail(10, 6, anchor), true);
  assert.equal(inDetail(10, 6, anchor), detailTier(10, 6, anchor) === 'fine');
  // The plan carries the rule's two inputs, and the escape hatch is a number its caller chose.
  const plan = voxelPlan(commons, {}, commons.start);
  assert.deepEqual(plan.anchor, voxelAnchor(commons, commons.start));
  assert.equal(plan.detailRadius, LOD_LIMITS.detail_radius);
  assert.equal(voxelPlan(commons, {}, commons.start, Infinity).detailRadius, Infinity);
  const island = { columns: 4, rows: 4, start: { x: 0, y: 0 } };
  assert.deepEqual(voxelAnchor(island, { x: -5, y: 99 }), { x: 0, y: 3 }, 'an anchor outside the authored world is clamped to it');
  assert.deepEqual(voxelAnchor(island, undefined), { x: 0, y: 0 });
});

test('the near field is untouched: only unpicked decoration on a coarse tile is dropped', () => {
  for (const id of ['commons', 'frontier:0:0', 'frontier:-3:5', 'home:sample']) {
    const definition = getWorldDefinition(id), scene = createVoxelScene(), anchor = definition.start;
    const full = scene.update(definition, {}, { position: anchor, lod: false });
    const before = drawn(scene);
    const lod = scene.update(definition, {}, { position: anchor });
    const after = drawn(scene);
    assert.equal(full.detail.radius, Infinity); assert.equal(full.detail.coarse, 0);
    assert.equal(full.detail.fine, full.cells);
    assert.equal(lod.detail.radius, LOD_LIMITS.detail_radius);
    assert.equal(lod.detail.fine + lod.detail.coarse, lod.cells);
    assert.ok(lod.detail.coarse > 0, `${id} has a coarse ring to test`);
    // Every instance inside the radius is byte-identical, including its pick: the art direction of
    // the near field is not a judgement call, it is the same matrices.
    const fineOf = (boxes) => boxes.filter((box) => inDetail(tileOf(box).x, tileOf(box).y, anchor));
    assert.deepEqual(multiset(fineOf(after)), multiset(fineOf(before)), `${id}: the near field is identical`);
    // What was lost is what the rule says may be lost: unpicked, on a coarse tile, below the knee.
    const present = new Map(); for (const box of after) present.set(keyOf(box), (present.get(keyOf(box)) || 0) + 1);
    const lost = before.filter((box) => { const key = keyOf(box); const count = present.get(key) || 0; if (count > 0) { present.set(key, count - 1); return false; } return true; });
    assert.ok(lost.length > 0, `${id} drops decoration beyond the radius`);
    for (const box of lost) {
      const tile = tileOf(box);
      assert.equal(box.pick, null, `${id}: a pickable instance was dropped at ${tile.x},${tile.y}`);
      assert.equal(inDetail(tile.x, tile.y, anchor), false, `${id}: ${tile.x},${tile.y} is inside the radius and lost geometry`);
      assert.ok(box.height + box.halfHeight <= KNEE_HEIGHT, `${id}: ${tile.x},${tile.y} lost a box above the knee (${(box.height + box.halfHeight).toFixed(3)} m)`);
    }
    // Exactly the lost instances account for the instance difference the benchmark reports, and not
    // one pickable instance is lost in either direction.
    assert.equal(before.length - after.length, lost.length, `${id}: the cube delta is the dropped decoration`);
    const picks = (boxes) => boxes.filter((box) => box.pick).length;
    const scenePicks = scene.pickables.reduce((sum, mesh) => sum + mesh.userData.picks.filter(Boolean).length, 0);
    assert.equal(picks(after), picks(before), `${id}: every pickable instance survives the detail tier`);
    assert.equal(picks(after), scenePicks, `${id}: every pick resolves through the scene's own pickable meshes`);
    scene.destroy();
  }
});

test('a coarse tile is still drawn as exactly the tile the server refuses or allows', () => {
  let coarseTiles = 0;
  for (const id of ['frontier:0:0', 'frontier:-3:5', 'commons']) {
    const definition = getWorldDefinition(id), plan = voxelPlan(definition, {}, definition.start);
    const scene = createVoxelScene(); scene.update(definition, {}, { position: definition.start });
    const boxes = drawn(scene), ground = boxes.filter((box) => box.group === 'voxel-terrain'), solids = solidTileKeys(plan.objects);
    // This test is about the ring the detail rule simplified, so it fails if that ring is empty.
    const coarse = plan.cells.filter((cell) => !inDetail(cell.x, cell.y, plan.anchor, plan.detailRadius));
    assert.ok(coarse.length > 100, `${id} has a real coarse ring (${coarse.length} cells)`);
    for (const cell of coarse) {
      const { x, y, type } = cell, key = `${x},${y}`, tile = column(x, y);
      const columns = boxes.filter((box) => overColumn(box, tile));
      const walkable = standableTile({ x, y }, definition.terrain, plan.objects) && !TERRAIN_BLOCKING.includes(type) && !solids.has(key);
      coarseTiles++;
      if (walkable) {
        assert.equal(columns.filter((box) => overKnee(box, tile)).length, 0, `${id} coarse ${key} is walkable, so nothing may stand in its column`);
        // Stronger than the global obstacle rule on purpose: the *ground pass* past the radius carries
        // no unpicked obstruction at all, so this clause cannot be satisfied by decoration. A floor
        // decal at or below `GROUND_DETAIL` may still graze a neighbouring column by a few centimetres,
        // which is the same tolerance the shipped rule gives the understory litter; the sky's own batch
        // and the overhead landmark pennant are out of scope, because the detail rule never touches them.
        assert.equal(ground.filter((box) => overColumn(box, tile) && !box.pick && box.height + box.halfHeight > GROUND_DETAIL).length, 0,
          `${id} coarse ${key} must have lost every unpicked obstruction`);
        continue;
      }
      // A refused tile stays refused to the eye: it is visibly solid, or it is the one declared
      // exception — water, drawn as water below ground level.
      assert.ok(columns.some((box) => entersStanding(box, tile)) || type === 'water', `${id} coarse ${key} (${type}) must still be drawn as an obstacle`);
    }
    scene.destroy();
  }
  assert.ok(coarseTiles > 1700, `the sweep covers a real ring (${coarseTiles} coarse cells)`);
});

test('the decorative reading is bounded by the detail radius, not by the window', () => {
  let guarded = 0;
  for (const id of worlds) {
    const definition = getWorldDefinition(id), scene = createVoxelScene();
    for (const anchor of anchorsOf(definition)) {
      const stats = scene.update(definition, {}, { position: anchor });
      assert.equal(stats.detail.fine + stats.detail.coarse, stats.cells);
      assert.ok(stats.detail.fine <= widestFine, `${id} at ${anchor.x},${anchor.y} reads ${stats.detail.fine} cells at full detail, over the ${widestFine} the radius encloses`);
      // Every unpicked ground read the diorama draws sits inside the radius. This is the assertion
      // that fails if a future decoration pass forgets the tier; the overhead markers (the pennant, the
      // sky's own batch) are out of scope, because the detail rule never touches them.
      for (const box of drawn(scene)) {
        if (box.group !== 'voxel-terrain' || box.pick || box.height + box.halfHeight > KNEE_HEIGHT) continue;
        guarded++;
        const tile = tileOf(box);
        assert.ok(inDetail(tile.x, tile.y, anchor, stats.detail.radius), `${id}: unpicked decoration at ${tile.x},${tile.y} is beyond the detail radius`);
      }
    }
    scene.destroy();
  }
  assert.ok(guarded > 200, `the sweep reads a real ground covering (${guarded} boxes)`);
  // The measured consequence, on the largest viewport: the escape hatch pays for the reading of all
  // 1,369 cells, the shipped rule pays only for the square the radius encloses.
  const frontier = getWorldDefinition('frontier:0:0'), scene = createVoxelScene();
  const full = scene.update(frontier, {}, { position: frontier.start, lod: false });
  const lod = scene.update(frontier, {}, { position: frontier.start });
  const decoration = (stats) => stats.layers.cover + stats.layers.understory;
  assert.ok(decoration(full) > 600, `the escape hatch pays for the whole window (${decoration(full)} decorative instances)`);
  assert.ok(decoration(lod) < decoration(full) / 2, `${decoration(full)} -> ${decoration(lod)} decorative instances`);
  assert.ok(full.cubes > lod.cubes, `${full.cubes} -> ${lod.cubes} instances`);
  assert.ok(full.detail.fine > widestFine, 'the escape hatch really does read more cells than the radius encloses');
  assert.ok(decoration(lod) <= widestFine * 5, `the decorative ceiling is the radius, not the window (${decoration(lod)})`);
  scene.destroy();
});

test('the largest viewport stays inside the stated instance and draw-call budget', () => {
  let worstInstances = 0, worstBatches = 0;
  for (const id of worlds) {
    const definition = getWorldDefinition(id);
    for (const anchor of anchorsOf(definition)) {
      const scene = createVoxelScene();
      const stats = scene.update(definition, {}, { position: anchor });
      assert.ok(stats.cubes <= DIORAMA_BUDGET.instances, `${id} at ${anchor.x},${anchor.y} draws ${stats.cubes} instances over the ${DIORAMA_BUDGET.instances} budget`);
      assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `${id} at ${anchor.x},${anchor.y} draws ${stats.drawBatches} batches`);
      worstInstances = Math.max(worstInstances, stats.cubes); worstBatches = Math.max(worstBatches, stats.drawBatches);
      scene.destroy();
    }
  }
  // A budget nothing approaches is not a budget: the sweep must reach a real viewport.
  assert.ok(worstInstances > DIORAMA_BUDGET.instances * .5, `the sweep measures a real viewport (worst ${worstInstances} instances)`);
  assert.ok(worstBatches > 50, `and a real batch count (worst ${worstBatches} batches)`);
});

test('a viewport carrying the participant and block bounds still fits the stated budget', () => {
  const definition = getWorldDefinition('frontier:0:0'), scene = createVoxelScene(), start = definition.start;
  const participants = Array.from({ length: VOXEL_LIMITS.participants }, (_, index) => ({
    id: `resident-${index}`, name: `Resident ${index}`, x: start.x + index % 7, y: start.y + Math.floor(index / 7) % 7,
    z: 0, kind: index % 2 ? 'npc' : 'human', status: 'active', posture: index % 3 ? 'standing' : 'sitting', color: '#397f79',
  }));
  // 2,048 distinct layers across a 21 x 21 field: every stored block the bound allows, all in window.
  const blocks = Array.from({ length: VOXEL_LIMITS.blocks }, (_, index) => ({
    id: `block-${index}`, x: start.x - 10 + index % 21, y: start.y - 10 + Math.floor(index / 21) % 21, z: index % VOXEL_LIMITS.height, type: 'stone',
  }));
  const stats = scene.update(definition, { participants, blocks }, { position: start });
  assert.equal(stats.participants, VOXEL_LIMITS.participants);
  assert.equal(stats.blocks, VOXEL_LIMITS.blocks);
  const ceiling = DIORAMA_BUDGET.instances + DIORAMA_BUDGET.participant_instances + DIORAMA_BUDGET.block_instances;
  assert.ok(stats.cubes <= ceiling, `a bounded-full viewport draws ${stats.cubes} instances over the ${ceiling} budget`);
  assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `${stats.drawBatches} batches`);
  // Each term is a ceiling on its own input, or the sum would be arithmetic rather than a budget.
  assert.ok(stats.blocks <= DIORAMA_BUDGET.block_instances && stats.participants * 22 <= DIORAMA_BUDGET.participant_instances);
  scene.destroy();
});

test('reduced motion is honoured: the confirmed tile is drawn and nothing is animated', () => {
  // The preference is read through an injected matcher, so this is the test's own input and never the
  // machine's: absent, throwing, unmatched and null all mean "no preference stated".
  assert.equal(prefersReducedMotion(undefined), false);
  assert.equal(prefersReducedMotion('(prefers-reduced-motion: reduce)'), false);
  assert.equal(prefersReducedMotion(() => { throw new Error('no matchMedia'); }), false);
  assert.equal(prefersReducedMotion(() => ({ matches: false })), false);
  assert.equal(prefersReducedMotion(() => null), false);
  assert.equal(prefersReducedMotion((query) => ({ matches: query === '(prefers-reduced-motion: reduce)' })), true);
  assert.equal(reducedMotionPreference(true), true);
  assert.equal(reducedMotionPreference(false), false);
  assert.equal(reducedMotionPreference(() => true), true);
  assert.equal(reducedMotionPreference(() => false), false);
  assert.equal(reducedMotionPreference(undefined), false, 'a runtime with no matchMedia states no preference');
  assert.equal(typeof globalThis.matchMedia, 'undefined', 'this suite runs where the environment cannot answer');

  // `time: 0` makes the tween parameter exactly 0, so the drawn tile is deterministic: a glide starts
  // on the tile it came from, and a reconciled step is already on the tile it arrived at.
  const world = getWorldDefinition('commons'), options = { position: { x: 10, y: 6 }, time: 0, self: null };
  const walker = { id: 'walker', x: 10, y: 6, z: 0, kind: 'human', status: 'active', color: '#cb725f' };
  options.self = walker;
  const gliding = createVoxelScene();
  gliding.update(world, { participants: [walker] }, options);
  assert.equal(gliding.animating, false, 'the first sight of a resident is a snap, not a tween');
  walker.x = 11;
  const beforeSettle = gliding.update(world, { participants: [walker] }, options);
  assert.equal(beforeSettle.participants, 1);
  assert.equal(gliding.animating, true, 'without the preference the step is a tween that must be repainted');
  assert.equal(gliding.isAnimating(), true);
  assert.equal(ringOf(gliding, 'walker').centreX, 10.5, 'and the drawn body is still on the tile it left');

  const still = createVoxelScene();
  still.update(world, { participants: [walker] }, options);
  walker.x = 12;
  const snapped = still.update(world, { participants: [walker] }, { ...options, reducedMotion: true });
  assert.equal(snapped.participants, 1);
  assert.equal(still.animating, false, 'the renderer reports nothing to animate, so no timer is scheduled');
  assert.equal(still.isAnimating(), false);
  assert.equal(ringOf(still, 'walker').centreX, 12.5, 'the body is drawn on the tile the server confirmed');
  // The reduced-motion view is still a live view: a repeated payload reuses every batch, and the
  // reconciliation path a refused move already used still answers.
  const people = still.root.getObjectByName('voxel-characters'), meshes = [...people.children];
  assert.equal(still.update(world, { participants: [walker] }, { ...options, reducedMotion: true }).participants, 1);
  assert.equal(still.root.getObjectByName('voxel-characters'), people);
  assert.ok(meshes.every((mesh, index) => people.children[index] === mesh), 'a repeated payload rebuilds nothing');
  assert.equal(still.reconcileCharacter('walker'), true);
  assert.equal(still.isAnimating(), false);
  gliding.destroy(); still.destroy();
});
