// Atmosphere: the phase model, the light it applies, the depth cue, the shadow frustum and the sky
// layer. Every number here is read back from what was actually applied, not re-derived, so the test
// fails if the renderer's sky and the phase model ever disagree.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { ATMOSPHERE_PHASES, worldAtmosphere } from '../src/atmosphere.js';
import { RESIDENT_HEIGHT, GROUND_DETAIL } from '../src/footprints.js';
import { VOXEL_LIMITS, voxelPlan } from '../src/voxel-geometry.js';
import { RENDER_CAPS, createVoxelScene } from '../src/voxel-world.js';
import { PHASE_ALIASES, SHADOW_LIMITS, SKY_PHASES, WINDOW_REACH, applyPhase, fogFor, phaseLighting, resolvedPhase, shadowExtent, shadowResolution } from '../src/scene/sky.js';

const commons = getWorldDefinition('commons');
const plan = voxelPlan(commons, {}, commons.start);
const rig = () => {
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog('#000000', 1, 2);
  return { scene, sky: new THREE.HemisphereLight(), sun: new THREE.DirectionalLight() };
};

test('the sky keys every phase src/atmosphere.js can publish, and invents none', () => {
  assert.deepEqual(Object.keys(SKY_PHASES).sort(), [...ATMOSPHERE_PHASES].sort());
  for (const phase of ATMOSPHERE_PHASES) {
    assert.equal(phaseLighting(phase), SKY_PHASES[phase], `${phase} resolves its own entry`);
    assert.equal(resolvedPhase(phase), phase);
    for (const key of ['sky', 'fog', 'zenith', 'ground', 'sun', 'cloud', 'exposure', 'edgeFade']) assert.ok(Object.hasOwn(SKY_PHASES[phase], key), `${phase} declares ${key}`);
    assert.ok(SKY_PHASES[phase].sunLight > 0 && SKY_PHASES[phase].skyLight > 0, `${phase} lights the world it draws`);
    assert.ok(SKY_PHASES[phase].sunHeight > 0);
  }
  // The client may still send the legacy name; an unknown phase falls back to day rather than dark.
  assert.deepEqual(PHASE_ALIASES, { evening: 'dusk' });
  assert.equal(resolvedPhase('evening'), 'dusk');
  assert.equal(phaseLighting('evening'), SKY_PHASES.dusk);
  assert.equal(phaseLighting('midnight-special'), SKY_PHASES.day);
  assert.equal(resolvedPhase(undefined), 'day');
  // The published phase model itself is untouched: four phases, four labels, one 120-minute cycle.
  const day = 24 * 60 * 60_000, seen = new Set();
  for (let minute = 0; minute < 120; minute += 5) {
    const atmosphere = worldAtmosphere(day + minute * 60_000);
    seen.add(atmosphere.phase);
    assert.equal(atmosphere.cycle_minutes, 120);
    assert.deepEqual(Object.keys(atmosphere), ['phase', 'label', 'activity', 'cycle_minutes', 'server_time', 'next_phase_at']);
    assert.ok(ATMOSPHERE_PHASES.includes(atmosphere.phase) && atmosphere.label && atmosphere.activity);
    assert.ok(atmosphere.next_phase_at > day + minute * 60_000);
  }
  assert.deepEqual([...seen].sort(), [...ATMOSPHERE_PHASES].sort(), 'a full cycle visits every phase');
});

test('the depth cue reads as distance without ever erasing a nearby obstacle', () => {
  for (const phase of ATMOSPHERE_PHASES) {
    const entry = phaseLighting(phase);
    for (const distance of [0, 6, 17, 24, 32]) {
      const { near, far } = fogFor(entry, distance), fadeAt = (metres) => Math.max(0, Math.min(1, (metres - near) / (far - near)));
      assert.ok(near >= 4, `${phase} at ${distance}: the near field is never fogged (near ${near})`);
      assert.ok(near < far && far <= 80, `${phase} at ${distance}: the band is a band (${near} -> ${far})`);
      // The tile a resident stands on and the tiles they interact with are unfogged, always.
      assert.equal(fadeAt(1), 0, `${phase} at ${distance}: the tile underfoot is clear`);
      assert.equal(fadeAt(4), 0, `${phase} at ${distance}: so is anything within four tiles`);
      assert.ok(fadeAt(8) <= .3, `${phase} at ${distance}: eight tiles are only barely faded (${(fadeAt(8) * 100).toFixed(0)}%)`);
      // The far corner of the window dissolves into the horizon by exactly the phase's own falloff,
      // and nothing inside the window is ever fully erased.
      const edge = distance + WINDOW_REACH;
      assert.ok(Math.abs(fadeAt(edge) - entry.edgeFade) < 1e-9, `${phase} at ${distance}: the window edge fades by its own ${entry.edgeFade}`);
      assert.ok(entry.edgeFade >= .5 && entry.edgeFade <= .75, `${phase} keeps an obstacle's silhouette (${entry.edgeFade})`);
      assert.ok(fadeAt(edge + 40) > fadeAt(edge), 'and distance still reads as distance');
    }
  }
  // Night is denser than day at the same distance, as a night should be.
  assert.ok(fogFor(phaseLighting('night'), 17).far < fogFor(phaseLighting('day'), 17).far);
});

test('a phase is applied to the live scene, inside the shadow caps and never darker than legible', () => {
  for (const phase of ATMOSPHERE_PHASES) {
    const { scene, sky, sun } = rig(), renderer = { toneMappingExposure: 1 };
    const applied = applyPhase({ scene, sky, sun, renderer, phase, position: { x: 10, y: 6 }, distance: 17, plan });
    const entry = phaseLighting(phase);
    assert.equal(applied.phase, phase);
    assert.equal(scene.background.getHexString(), entry.sky.replace('#', ''));
    assert.equal(scene.fog.color.getHexString(), entry.fog.replace('#', ''));
    assert.equal(scene.fog.near, applied.fog.near); assert.equal(scene.fog.far, applied.fog.far);
    assert.equal(sky.intensity, entry.skyLight); assert.equal(sky.color.getHexString(), entry.zenith.replace('#', ''));
    assert.equal(sun.intensity, entry.sunLight); assert.equal(sun.color.getHexString(), entry.sun.replace('#', ''));
    assert.equal(sun.position.y, entry.sunHeight);
    assert.equal(renderer.toneMappingExposure, applied.exposure);
    // The caps: the map size is the shipped 1024 and the frustum is fitted, never widened past 24 m.
    assert.equal(sun.shadow.mapSize.x, SHADOW_LIMITS.map_size); assert.equal(sun.shadow.mapSize.y, SHADOW_LIMITS.map_size);
    assert.equal(SHADOW_LIMITS.map_size, 1024);
    assert.equal(sun.shadow.camera.right, applied.extent);
    assert.ok(applied.extent <= SHADOW_LIMITS.extent && applied.extent >= SHADOW_LIMITS.extent_min);
    assert.ok(sun.shadow.camera.far <= SHADOW_LIMITS.far);
    // NIGHT STAYS LEGIBLE: the phase that darkens the sky also raises exposure and ambient light, so
    // an obstacle in front of a resident is still visible at night rather than a black silhouette.
    if (phase === 'night') {
      assert.ok(entry.skyLight >= 1 && entry.sunLight >= 1, 'night keeps a visible ambient floor');
      assert.ok(entry.exposure >= phaseLighting('day').exposure, 'night is not simply dimmed');
    }
  }
  // The fitted frustum is the measured shadow win: the widest window the renderer builds (a frontier
  // sector's 37 cells) needs a 19.5 m half-extent where the shipped value was a fixed 24, so one
  // shadow texel covers 26.3 px/m instead of 21.3, at the same 1024 map. A smaller world gets a
  // tighter frustum still, and anything larger is clamped rather than widened.
  const sector = getWorldDefinition('frontier:0:0'), sectorPlan = voxelPlan(sector, {}, sector.start);
  const extent = shadowExtent(sectorPlan);
  assert.equal(Math.max(sectorPlan.window.right - sectorPlan.window.x, sectorPlan.window.bottom - sectorPlan.window.y), 37);
  assert.equal(extent, 19.5);
  assert.ok(shadowExtent(plan) < 24 && shadowExtent(plan) >= SHADOW_LIMITS.extent_min, 'a narrower window keeps a narrower frustum');
  assert.ok(shadowResolution(extent) > shadowResolution(24));
  assert.equal(shadowExtent({ window: { x: 2000, y: 0, right: 4000, bottom: 60 } }), SHADOW_LIMITS.extent, 'a wider window is clamped, never widened');
  assert.equal(shadowExtent(null), SHADOW_LIMITS.extent_min);
  // The phase turns the key light, so shadows turn with the phase instead of always falling one way.
  const headings = ATMOSPHERE_PHASES.map((phase) => { const { scene, sky, sun } = rig(); applyPhase({ scene, sky, sun, phase, position: { x: 10, y: 6 }, distance: 17, plan }); return `${sun.position.x.toFixed(2)},${sun.position.z.toFixed(2)}`; });
  assert.equal(new Set(headings).size, ATMOSPHERE_PHASES.length, `every phase lights from its own bearing (${headings.join(' | ')})`);
});

test('the sky layer names the phase from overhead and never becomes an obstacle', () => {
  const counts = {};
  for (const phase of ATMOSPHERE_PHASES) {
    const scene = createVoxelScene();
    scene.update(commons, {}, { position: commons.start, dayPhase: phase });
    const group = scene.root.getObjectByName('voxel-sky');
    assert.ok(group, `${phase} draws a sky layer`);
    for (const mesh of group.children) {
      assert.equal(mesh.userData.picks.some(Boolean), false, 'no sky marker is clickable');
      assert.equal(mesh.castShadow, false, 'the sky never casts a shadow');
      assert.equal(mesh.receiveShadow, false);
      const matrix = new THREE.Matrix4();
      for (let index = 0; index < mesh.count; index++) {
        mesh.getMatrixAt(index, matrix);
        const top = matrix.elements[13] - Math.abs(matrix.elements[5]) / 2;
        assert.ok(top >= RESIDENT_HEIGHT, `a sky box is never inside a standing column (lowest ${top.toFixed(2)} m)`);
      }
    }
    counts[phase] = group.children.reduce((sum, mesh) => sum + mesh.count, 0);
    scene.destroy();
  }
  assert.ok(counts.night > counts.day, `the night sky is the starry one (${counts.night} vs ${counts.day} markers)`);
  assert.ok(counts.dawn > counts.day && counts.dusk > counts.day, 'dawn and dusk add a horizon band');
  // An interior room has no sky over it.
  const room = getWorldDefinition('house:sample'), scene = createVoxelScene();
  scene.update(room, {}, { position: room.start });
  assert.equal(scene.root.getObjectByName('voxel-sky'), undefined);
  scene.destroy();
});

test('the renderer bounds and the resident numbers are the shipped ones, not raised', () => {
  assert.deepEqual(VOXEL_LIMITS, { radius: 18, cells: 1369, objects: 260, blocks: 2048, participants: 220, height: 8 });
  assert.deepEqual(RENDER_CAPS, { pixel_ratio: 1.5, render_width: 1440, render_height: 900 });
  assert.equal(SHADOW_LIMITS.map_size, 1024);
  assert.equal(RESIDENT_HEIGHT, 1.52);
  assert.equal(GROUND_DETAIL, 0.1);
});
