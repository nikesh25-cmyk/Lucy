// Weather, animated water and the ambient clock: presentation only.
//
// Weather (src/scene/weather.js) is a second reading on top of the four published phases. These tests hold
// what makes that safe: it is deterministic from the shared clock, a room has none, it is air (no pick, no
// occupancy, bounded), it never rebuilds the diorama, reduced motion freezes the ambient clock at zero, and
// the whole thing stays inside the renderer's stated budgets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldDefinition } from '../world.js';
import { DIORAMA_BUDGET } from '../src/voxel-geometry.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { RAIN_LIMITS, WEATHERS, WEATHER_LOOK, WEATHER_SLOT_MS, knownWeather, resolveWeather, weatherAt } from '../src/scene/weather.js';

const commons = getWorldDefinition('commons');
const child = (scene, name) => scene.root.getObjectByName(name);

test('weather is a closed vocabulary, and each kind states how it lights the world', () => {
  assert.deepEqual([...WEATHERS], ['clear', 'mist', 'rain']);
  assert.deepEqual(Object.keys(WEATHER_LOOK).sort(), [...WEATHERS].sort());
  for (const name of WEATHERS) {
    assert.equal(knownWeather(name), name);
    const look = WEATHER_LOOK[name];
    assert.ok(look.sun > 0 && look.sun <= 1 && look.fogNear > 0 && look.fogNear <= 1 && look.fogFar > 0 && look.fogFar <= 1, `${name} only ever dims and thickens`);
  }
  for (const other of ['storm', '', null, undefined, 3, 'Rain']) assert.equal(knownWeather(other), null);
  assert.equal(WEATHER_LOOK.clear.rain, 0); assert.equal(WEATHER_LOOK.clear.mist, 0);
  assert.ok(WEATHER_LOOK.rain.rain > 0 && WEATHER_LOOK.mist.mist > 0);
});

test('the clock gives every client the same weather, in twenty-minute slots, and a missing clock is clear', () => {
  assert.equal(weatherAt(undefined), 'clear'); assert.equal(weatherAt(NaN), 'clear'); assert.equal(weatherAt('now'), 'clear');
  const seen = new Set(), base = Date.UTC(2026, 9, 15);
  for (let slot = 0; slot < 36; slot++) {
    const at = base + slot * WEATHER_SLOT_MS;
    assert.equal(weatherAt(at), weatherAt(at + WEATHER_SLOT_MS - 1), 'one slot is one weather');
    assert.equal(weatherAt(at), weatherAt(at), 'and it is deterministic');
    seen.add(weatherAt(at));
  }
  assert.deepEqual([...seen].sort(), ['clear', 'mist', 'rain'], 'a 12-hour stretch of slots visits every weather');
  let clear = 0; for (let slot = 0; slot < 1000; slot++) if (weatherAt(base + slot * WEATHER_SLOT_MS) === 'clear') clear++;
  assert.ok(clear > 620 && clear < 780, `most of the time is clear (${clear} of 1000)`);
});

test('explicit weather wins, then a published one, then the clock; a room never has any', () => {
  const atmosphere = { weather: 'mist', server_time: Date.UTC(2026, 9, 15) };
  assert.equal(resolveWeather({ weather: 'rain', atmosphere }), 'rain');
  assert.equal(resolveWeather({ atmosphere }), 'mist');
  assert.equal(resolveWeather({ atmosphere: { server_time: atmosphere.server_time } }), weatherAt(atmosphere.server_time));
  assert.equal(resolveWeather({ weather: 'storm' }), 'clear');
  assert.equal(resolveWeather({ weather: 'rain', interior: true }), 'clear');
  assert.equal(resolveWeather(), 'clear');
});

test('rain and mist are bounded air: no pick, no shadow, no obstacle, and a room draws none', () => {
  for (const kind of ['rain', 'mist']) {
    const scene = createVoxelScene(), stats = scene.update(commons, {}, { position: commons.start, weather: kind, dayPhase: 'day' });
    const group = child(scene, 'voxel-weather');
    assert.ok(group, `${kind} has a weather group`); assert.equal(stats.weather, kind); assert.equal(scene.weather, kind);
    assert.ok(stats.weatherCubes > 0 && stats.weatherCubes <= RAIN_LIMITS.drops + RAIN_LIMITS.banks, `${kind} draws ${stats.weatherCubes} instances, inside its bound`);
    for (const mesh of group.children) {
      assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
      assert.equal(Boolean(mesh.userData.picks?.some(Boolean)), false, 'weather is not clickable');
      assert.ok(!scene.pickables.includes(mesh), 'and a raycast never reads it');
    }
    assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `${kind} stays inside ${DIORAMA_BUDGET.draw_calls} draw calls (${stats.drawBatches})`);
    assert.ok(stats.cubes + stats.weatherCubes <= DIORAMA_BUDGET.instances, `${kind} stays inside the instance budget`);
    scene.destroy();
  }
  const room = getWorldDefinition('library'), scene = createVoxelScene(), stats = scene.update(room, {}, { position: room.start, weather: 'rain' });
  assert.equal(child(scene, 'voxel-weather'), undefined, 'a room has no weather'); assert.equal(stats.weather, 'clear'); assert.equal(scene.ambient, false);
  scene.destroy();
});

test('a change of weather rebuilds the weather and nothing else', () => {
  const scene = createVoxelScene(), options = { position: commons.start, dayPhase: 'day' };
  scene.update(commons, {}, { ...options, weather: 'clear' });
  assert.equal(child(scene, 'voxel-weather'), undefined, 'clear weather draws nothing');
  const terrain = child(scene, 'voxel-terrain'), sky = child(scene, 'voxel-sky');
  scene.update(commons, {}, { ...options, weather: 'rain' });
  const rain = child(scene, 'voxel-weather');
  assert.ok(rain && child(scene, 'voxel-terrain') === terrain && child(scene, 'voxel-sky') === sky, 'rain arrives over the same diorama and sky');
  scene.update(commons, {}, { ...options, weather: 'rain' });
  assert.equal(child(scene, 'voxel-weather'), rain, 'the same weather is not rebuilt on the next poll');
  scene.update(commons, {}, { ...options, weather: 'mist' });
  assert.notEqual(child(scene, 'voxel-weather'), rain); assert.equal(child(scene, 'voxel-terrain'), terrain);
  scene.update(commons, {}, { ...options, weather: 'clear' });
  assert.equal(child(scene, 'voxel-weather'), undefined);
  scene.destroy();
});

test('the ambient clock is a uniform, not a rebuild, and reduced motion keeps it at zero', () => {
  const scene = createVoxelScene(); scene.update(commons, {}, { position: commons.start, weather: 'rain' });
  assert.equal(scene.ambient, true, 'an outdoor scene has something that drifts');
  const terrain = child(scene, 'voxel-terrain'), meshes = [...terrain.children];
  scene.tick(12.5, { x: 10, y: 6 });
  assert.equal(scene.resources.motion.time.value, 12.5, 'a tick moves the clock');
  assert.equal(child(scene, 'voxel-terrain'), terrain); assert.ok(terrain.children.every((mesh, index) => mesh === meshes[index]), 'and rebuilds nothing');
  scene.tick(NaN); assert.equal(scene.resources.motion.time.value, 12.5, 'a non-number leaves the clock alone');
  scene.destroy();
  const still = createVoxelScene(); still.update(commons, {}, { position: commons.start, weather: 'rain', reducedMotion: true });
  assert.equal(still.ambient, false, 'a visitor who reduced motion schedules no ambient repaint');
  still.tick(99);
  assert.equal(still.resources.motion.time.value, 0, 'the clock stays at zero');
  assert.equal(still.resources.motion.wave.value, 0, 'and the water does not rise or fall');
  assert.ok(child(still, 'voxel-weather'), 'the weather is still drawn, as one still frame');
  still.destroy();
});

test('water draws as water with a wave, and every authored water world stays inside the budgets in every weather', () => {
  for (const id of ['commons', 'harbor', 'district:lakes', 'district:coast', 'district:islands']) {
    const definition = getWorldDefinition(id);
    for (const weather of WEATHERS) for (const dayPhase of ['dawn', 'night']) {
      const scene = createVoxelScene(), stats = scene.update(definition, {}, { position: definition.start, weather, dayPhase });
      assert.ok(stats.cubes <= DIORAMA_BUDGET.instances, `${id} ${weather} ${dayPhase}: ${stats.cubes} instances`);
      assert.ok(stats.drawBatches <= DIORAMA_BUDGET.draw_calls, `${id} ${weather} ${dayPhase}: ${stats.drawBatches} batches`);
      scene.destroy();
    }
  }
  const lake = getWorldDefinition('district:lakes'), scene = createVoxelScene(); scene.update(lake, {}, { position: lake.start });
  scene.tick(0); const calm = scene.resources.motion.wave.value; assert.ok(calm > 0, 'water has a wave height when motion is allowed');
  scene.destroy();
});
