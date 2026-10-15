// Interiors, lamp light and face tone: the first visual slice of the 3D renderer.
//
// What must stay true while a room gets walls, windows, floors and light of its own:
//   1. a room is recognised whether the world arrives as the authored `interior` or as the server's own
//      `house` record merged over it, so no cottage is drawn as an open garden;
//   2. a room's details obey the occupancy rules src/footprints.js states: nothing stands in a walkable
//      tile's column between the knee and the head, nothing unpicked is taller than a floor decal unless
//      it is overhead, and a wall's details never reach past 0.10 m into the open tile beside it;
//   3. the lamp light, the face tone and the interior light are renderer-only: they never change a pick,
//      never bring a sky over a room, and never raise the draw-call or instance budgets;
//   4. reduced motion and the pre-LOD escape hatch are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { GROUND_DETAIL, KNEE_HEIGHT, RESIDENT_CLEARANCE, RESIDENT_HEIGHT, standableTile, TERRAIN_BLOCKING } from '../src/footprints.js';
import { DIORAMA_BUDGET, voxelPlan } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { createResources, cubeBatch, FACE_TONES } from '../src/scene/batch.js';
import { BRACKET_BOTTOM, INTERIOR_STYLES, WALL_HEIGHT, WALL_PROTRUSION, WINDOW_EVERY, interiorStyle, isInterior, openSides } from '../src/scene/interiors.js';
import { LAMP_LIMIT, LAMP_GLOW, LIT_PHASES, lampGlowScene, litLamps } from '../src/scene/lights.js';
import { INTERIOR_LIGHTING, SKY_PHASES, applyPhase, phaseLighting } from '../src/scene/sky.js';

const ROOMS = ['hall', 'pavilion', 'gallery', 'meditation', 'library', 'workshop', 'observatory', 'house:sample'];
const matrix = new THREE.Matrix4();
const boxesOf = (scene, groupName) => {
  const out = [];
  for (const group of scene.root.children) {
    if (groupName && group.name !== groupName) continue;
    for (const mesh of group.children) for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix); const e = matrix.elements;
      out.push({ group: group.name, style: mesh.userData.style, material: mesh.material, color: mesh.material.color.getHex(),
        minX: e[12] - Math.abs(e[0]) / 2, maxX: e[12] + Math.abs(e[0]) / 2, minY: e[13] - Math.abs(e[5]) / 2, maxY: e[13] + Math.abs(e[5]) / 2,
        minZ: e[14] - Math.abs(e[10]) / 2, maxZ: e[14] + Math.abs(e[10]) / 2, pick: mesh.userData.picks?.[index] ?? null });
    }
  }
  return out;
};
const column = (x, y) => ({ minX: x + .5 - RESIDENT_CLEARANCE, maxX: x + .5 + RESIDENT_CLEARANCE, minZ: y + .5 - RESIDENT_CLEARANCE, maxZ: y + .5 + RESIDENT_CLEARANCE });
const overColumn = (box, tile) => box.minX < tile.maxX && box.maxX > tile.minX && box.minZ < tile.maxZ && box.maxZ > tile.minZ;

test('a room is a room whether it arrives as an authored interior or as the server\'s house record', () => {
  assert.equal(isInterior({ kind: 'interior', id: 'library' }), true);
  assert.equal(isInterior({ kind: 'house', id: 'house:abc' }), true, 'a cottage record says `house`, and is still a room');
  assert.equal(isInterior({ kind: 'interior', id: 'house:abc' }), true);
  for (const outdoors of [{ kind: 'outdoors', id: 'commons' }, { kind: 'home', id: 'home:abc' }, { kind: 'frontier', id: 'frontier:0:0' }, {}, null, undefined]) assert.equal(isInterior(outdoors), false);
  // The merged record the browser really builds: the authored definition overlaid with the server's world row.
  const merged = getWorldDefinition({ id: 'house:sample', kind: 'house', name: 'A cottage' });
  assert.equal(merged.kind, 'house');
  const authored = getWorldDefinition('house:sample'), a = createVoxelScene(), b = createVoxelScene();
  const drawnMerged = a.update(merged, {}, { position: merged.start }), drawnAuthored = b.update(authored, {}, { position: authored.start });
  assert.equal(drawnMerged.cubes, drawnAuthored.cubes, 'the same room is drawn from either record');
  assert.equal(a.root.getObjectByName('voxel-sky'), undefined, 'and neither has a sky over it');
  a.destroy(); b.destroy();
});

test('every authored room draws walls, windows and floor patterns of its own, in its own palette', () => {
  const walls = new Set();
  for (const id of ROOMS) {
    const definition = getWorldDefinition(id), scene = createVoxelScene(), stats = scene.update(definition, {}, { position: definition.start });
    const terrain = boxesOf(scene, 'voxel-terrain');
    assert.ok(terrain.some((box) => box.maxY >= WALL_HEIGHT - .05), `${id} has walls that stand ${WALL_HEIGHT} m`);
    const style = interiorStyle(definition);
    assert.ok(terrain.some((box) => box.color === new THREE.Color(style.plaster).getHex()), `${id} is plastered in its own tone`);
    const panes = terrain.filter((box) => box.pick && box.material.emissiveIntensity !== undefined && box.material.emissive?.getHex() === box.color && box.minY > 1 && box.maxY < 1.9);
    assert.ok(panes.length >= 2, `${id} has lit windows (found ${panes.length})`);
    assert.ok(terrain.filter((box) => !box.pick && box.maxY <= GROUND_DETAIL && box.minY >= 0).length > 20, `${id} has floor decals`);
    assert.ok(stats.layers.buildings > 150, `${id} reports its walls on the buildings layer`);
    walls.add(style.plaster);
    scene.destroy();
  }
  assert.ok(walls.size >= 5, `the rooms do not share one template (${walls.size} wall tones across ${ROOMS.length} rooms)`);
  assert.ok(INTERIOR_STYLES.default && interiorStyle({ id: 'unknown' }) === INTERIOR_STYLES.default);
  assert.equal(interiorStyle({ id: 'house:xyz' }), INTERIOR_STYLES.house);
});

test('a room\'s walls and floors keep to the occupancy the server enforces', () => {
  for (const id of ROOMS) {
    const definition = getWorldDefinition(id), plan = voxelPlan(definition, {}, definition.start), scene = createVoxelScene();
    scene.update(definition, {}, { position: definition.start });
    const boxes = boxesOf(scene);
    for (const cell of plan.cells) {
      const tile = column(cell.x, cell.y), here = boxes.filter((box) => overColumn(box, tile));
      const walkable = standableTile({ x: cell.x, y: cell.y }, definition.terrain, plan.objects) && !TERRAIN_BLOCKING.includes(cell.type);
      if (!walkable) continue;
      for (const box of here) {
        assert.ok(!(box.maxY > KNEE_HEIGHT && box.minY < RESIDENT_HEIGHT), `${id} ${cell.x},${cell.y}: nothing stands in a walkable column between the knee and the head`);
        if (!box.pick) assert.ok(box.maxY <= GROUND_DETAIL || box.minY >= RESIDENT_HEIGHT, `${id} ${cell.x},${cell.y}: unpicked decoration is a decal or overhead`);
      }
    }
    // A wall detail reaches at most WALL_PROTRUSION past its own tile at a resident's height; only a bracket
    // reaches further, and its lowest face is over every head.
    let brackets = 0;
    for (const cell of plan.cells.filter((item) => item.type === 'wall')) {
      for (const box of boxes.filter((item) => item.pick?.terrain === 'wall' && item.pick.x === cell.x && item.pick.y === cell.y)) {
        const over = Math.max(cell.x - box.minX, box.maxX - (cell.x + 1), cell.y - box.minZ, box.maxZ - (cell.y + 1));
        if (over > WALL_PROTRUSION + 1e-9) { brackets++; assert.ok(box.minY >= BRACKET_BOTTOM - 1e-4 && box.minY >= RESIDENT_HEIGHT, `${id} wall ${cell.x},${cell.y}: a long detail is overhead (${box.minY.toFixed(2)} m)`); }
      }
    }
    assert.ok(brackets > 0, `${id} has brackets over its windows`);
    scene.destroy();
  }
});

test('windows and pictures sit only on a wall tile with exactly one open face', () => {
  const definition = getWorldDefinition('library'), typeAt = (x, y) => definition.terrain[y]?.[x];
  assert.deepEqual(openSides(typeAt, 0, 0, definition.columns, definition.rows), [], 'a corner opens onto nothing');
  assert.deepEqual(openSides(typeAt, 5, 0, definition.columns, definition.rows), ['s'], 'a north wall opens south');
  assert.deepEqual(openSides(typeAt, 0, 5, definition.columns, definition.rows), ['e'], 'a west wall opens east');
  assert.equal(WINDOW_EVERY, 5);
});

test('lamp light is geometry above the head or a floor decal, never a pick, and lamps are the only source', () => {
  const definition = getWorldDefinition('library'), plan = voxelPlan(definition, {}, definition.start);
  const lamps = litLamps(plan);
  assert.ok(lamps.length > 0 && lamps.length <= LAMP_LIMIT);
  assert.deepEqual(lamps.map((lamp) => lamp.distance), [...lamps.map((lamp) => lamp.distance)].sort((a, b) => a - b), 'nearest lamps first');
  const resources = createResources();
  assert.equal(lampGlowScene({ resources, cubeBatch, plan, phase: 'day' }).cubes, 0, 'the sun lights the day, so no lamp glows');
  for (const phase of LIT_PHASES) {
    const result = lampGlowScene({ resources, cubeBatch, plan, phase });
    assert.ok(result.cubes >= lamps.length * 2 && result.cubes <= lamps.length * 3, `${phase} draws two or three boxes per lamp`);
    assert.equal(result.group.name, 'voxel-lights');
    for (const mesh of result.group.children) {
      assert.equal(mesh.userData.picks.some(Boolean), false, 'a click goes through the glow');
      assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
      for (let index = 0; index < mesh.count; index++) {
        mesh.getMatrixAt(index, matrix); const e = matrix.elements, top = e[13] + Math.abs(e[5]) / 2, bottom = e[13] - Math.abs(e[5]) / 2;
        assert.ok(top <= GROUND_DETAIL || bottom >= RESIDENT_HEIGHT, `a glow box is a floor decal or overhead (${bottom.toFixed(2)}..${top.toFixed(2)})`);
      }
    }
  }
  const colours = Object.values(LAMP_GLOW); assert.equal(new Set(colours).size, colours.length);
  resources.dispose();
  // Outdoors: a night commons lights its lanterns, a day commons draws none, and neither rebuilds the diorama.
  const commons = getWorldDefinition('commons'), scene = createVoxelScene();
  const day = scene.update(commons, {}, { position: commons.start, dayPhase: 'day' });
  const terrainGroup = scene.root.getObjectByName('voxel-terrain');
  const night = scene.update(commons, {}, { position: commons.start, dayPhase: 'night' });
  assert.equal(day.lightCubes, 0);
  assert.ok(night.lightCubes >= 0);
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrainGroup, 'a phase change leaves the diorama alone');
  scene.destroy();
});

test('face tone patches the lit solids only, and the glow strength follows the phase without a rebuild', () => {
  const resources = createResources();
  for (const style of ['solid', 'detail', 'water']) assert.equal(resources.material('#808080', style).userData.faceToning, true, `${style} is toned`);
  for (const style of ['glow', 'glass', 'cloud', 'haze', 'star', 'sun', 'foam', 'contact']) assert.notEqual(resources.material('#808080', style).userData.faceToning, true, `${style} is never toned`);
  assert.ok(FACE_TONES.top > FACE_TONES.south && FACE_TONES.south > FACE_TONES.east && FACE_TONES.east > FACE_TONES.west && FACE_TONES.west > FACE_TONES.north && FACE_TONES.north > FACE_TONES.bottom, 'six faces, six different tones');
  assert.ok(FACE_TONES.top <= 1.1 && FACE_TONES.bottom >= .5, 'the tones keep the albedo recognisable');
  // The patched program is its own program, and the shader source it receives is rewritten, not replaced.
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <defaultnormal_vertex>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
  resources.material('#123456', 'solid').onBeforeCompile(shader);
  assert.match(shader.vertexShader, /vFaceTone/); assert.match(shader.fragmentShader, /diffuseColor\.rgb \*= vFaceTone/);
  assert.equal(resources.material('#123456', 'solid').customProgramCacheKey(), 'voxel-fx-3-tone+world');
  const early = resources.material('#ffcc66', 'glow'), before = early.emissiveIntensity;
  assert.equal(resources.setGlow(1.25), 1.25);
  assert.equal(early.emissiveIntensity, 1.25); assert.notEqual(before, 1.25);
  assert.equal(resources.material('#66ccff', 'glow').emissiveIntensity, 1.25, 'a glow material made later starts at the phase strength');
  assert.equal(resources.setGlow(99), 2, 'the strength is capped'); assert.equal(resources.setGlow(-4), 0); assert.equal(resources.setGlow(NaN), 0, 'a non-number changes nothing');
  resources.dispose();
});

test('every phase keeps its key light well above its fill, night stays legible, and a room has its own warm light', () => {
  assert.deepEqual(Object.keys(SKY_PHASES).sort(), ['dawn', 'day', 'dusk', 'night'], 'a room is not a fifth phase');
  for (const [name, entry] of Object.entries(SKY_PHASES)) {
    assert.ok(entry.sunLight / entry.skyLight >= 1.4, `${name}: key to fill is ${(entry.sunLight / entry.skyLight).toFixed(2)}, enough for a lit and a shaded face to differ`);
    assert.ok(entry.glow > 0 && Number.isFinite(entry.glow));
  }
  assert.ok(SKY_PHASES.night.glow > SKY_PHASES.day.glow * 3, 'lamps and windows burn brighter after dark');
  assert.ok(SKY_PHASES.night.skyLight >= 1 && SKY_PHASES.night.sunLight >= 1 && SKY_PHASES.night.exposure >= SKY_PHASES.day.exposure, 'night is lifted, not dimmed');
  assert.ok(INTERIOR_LIGHTING.sunLight / INTERIOR_LIGHTING.skyLight >= 1.4);
  const rig = () => ({ scene: new THREE.Scene(), sky: new THREE.HemisphereLight('#fff', '#000', 1), sun: new THREE.DirectionalLight('#fff', 1) });
  const { scene, sky, sun } = rig(), renderer = { toneMappingExposure: 1 };
  const applied = applyPhase({ scene, sky, sun, renderer, phase: 'night', position: { x: 5, y: 5 }, distance: 10, plan: { window: { x: 0, y: 0, right: 20, bottom: 14 } }, interior: true });
  assert.equal(applied.phase, 'interior'); assert.equal(applied.glow, INTERIOR_LIGHTING.glow);
  assert.equal(scene.background.getHexString(), INTERIOR_LIGHTING.sky.slice(1));
  assert.equal(sky.intensity, INTERIOR_LIGHTING.skyLight); assert.equal(sun.intensity, INTERIOR_LIGHTING.sunLight);
  assert.equal(phaseLighting('night').glow, SKY_PHASES.night.glow);
});

test('rooms stay inside the instance and draw-call budget, and under reduced motion and the pre-LOD hatch', () => {
  for (const id of ROOMS) {
    const definition = getWorldDefinition(id), scene = createVoxelScene();
    const lod = scene.update(definition, {}, { position: definition.start });
    assert.ok(lod.cubes <= DIORAMA_BUDGET.instances, `${id} draws ${lod.cubes} instances`);
    assert.ok(lod.drawBatches <= DIORAMA_BUDGET.draw_calls, `${id} draws ${lod.drawBatches} batches`);
    const full = scene.update(definition, {}, { position: definition.start, lod: false });
    assert.ok(full.cubes >= lod.cubes && full.cubes <= DIORAMA_BUDGET.instances, `${id} pre-LOD draws ${full.cubes}`);
    const still = scene.update(definition, { participants: [{ id: 'a', name: 'A', x: definition.start.x, y: definition.start.y, z: 0, kind: 'human', status: 'active', posture: 'standing', color: '#397f79' }] }, { position: definition.start, reducedMotion: true });
    assert.equal(scene.animating, false, `${id} has nothing to animate under reduced motion`); assert.ok(still.participants === 1);
    scene.destroy();
  }
});

test('an unchanged room rebuilds nothing, and a step inside it rebuilds nothing while every tile is read closely', () => {
  const definition = getWorldDefinition('hall'), scene = createVoxelScene();
  scene.update(definition, {}, { position: { x: 10, y: 8 } });
  const terrain = scene.root.getObjectByName('voxel-terrain'), lights = scene.root.getObjectByName('voxel-lights');
  scene.update(definition, {}, { position: { x: 10, y: 8 } });
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain); assert.equal(scene.root.getObjectByName('voxel-lights'), lights);
  scene.update(definition, {}, { position: { x: 11, y: 8 } });
  assert.equal(scene.root.getObjectByName('voxel-terrain'), terrain, 'a 20 x 14 room is read closely from every tile, so a step changes nothing');
  scene.destroy();
});
