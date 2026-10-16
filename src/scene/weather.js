// Weather: rain, mist and a drifting cloud shadow, as presentation only.
//
// The sky already has four published phases (src/atmosphere.js). Weather is a second, independent
// reading on top of them: `clear`, `mist` or `rain`. It changes how the world is lit and what drifts
// through the air, and nothing else — no saved tile, object, permission, deadline or world rule reads it,
// no pick is added, and no occupancy changes. A rain streak is air, not a mass: it has no pick, lives in
// its own group that no obstacle test or raycast reads, and is bounded to `RAIN_LIMITS.drops`.
//
// Where it comes from, in order: an explicit `options.weather` (tests and the capture script), then a
// `weather` field on the shared atmosphere payload if the server ever publishes one, then a deterministic
// reading of the atmosphere's own clock — the same twenty-minute slot gives every client the same sky.
// A room has no weather. Under `prefers-reduced-motion` the same weather is drawn, still: the clock never
// advances, so the streaks and the mist banks are one frame and nothing moves.
import * as THREE from '../../assets/vendor/three-voxel.js';
import { hash, fxMaterial } from './batch.js';

export const WEATHERS = Object.freeze(['clear', 'mist', 'rain']);
/** Twenty minutes of the shared clock is one weather slot: six per phase, thirty-six per 120-minute cycle. */
export const WEATHER_SLOT_MS = 20 * 60_000;
/** The hard bounds on what weather may draw. */
export const RAIN_LIMITS = Object.freeze({ drops: 520, span: 26, height: 12, speed: 11, width: .018, length: .5, banks: 3 });

/**
 * How each weather lights the world. Multipliers on the phase's own values, plus a tint the fog and the
 * horizon are mixed toward, so a rainy dusk is still a dusk. `cloud` is the strength of the drifting cloud
 * shadow; an overcast sky is darker and its shadows are broad.
 */
export const WEATHER_LOOK = Object.freeze({
  clear: Object.freeze({ sun: 1, sky: 1, fogNear: 1, fogFar: 1, tint: '#ffffff', mix: 0, cloud: .2, mist: 0, rain: 0 }),
  mist: Object.freeze({ sun: .78, sky: 1.06, fogNear: .42, fogFar: .56, tint: '#cdd7d4', mix: .6, cloud: .06, mist: 1, rain: 0 }),
  rain: Object.freeze({ sun: .5, sky: .94, fogNear: .55, fogFar: .62, tint: '#8e9ca4', mix: .55, cloud: .3, mist: .35, rain: 1 }),
});

/** The weather name for an explicit value, or null when the value names none. */
export const knownWeather = (value) => typeof value === 'string' && Object.hasOwn(WEATHER_LOOK, value) ? value : null;

/**
 * The deterministic weather of one moment of the shared clock: roughly one slot in seven rains and one in
 * six is misty. A missing clock is clear, so a payload without one never gets a surprise.
 */
export function weatherAt(timestamp) {
  if (!Number.isFinite(timestamp)) return 'clear';
  const roll = hash(`weather:${Math.floor(timestamp / WEATHER_SLOT_MS)}`) % 100;
  return roll < 14 ? 'rain' : roll < 30 ? 'mist' : 'clear';
}

/** The weather in force for one render: explicit, then published, then the clock; never inside a room. */
export function resolveWeather({ weather, atmosphere, interior = false } = {}) {
  if (interior) return 'clear';
  return knownWeather(weather) || knownWeather(atmosphere?.weather) || weatherAt(Number(atmosphere?.server_time));
}

// A tiny deterministic generator, so the streaks of a given weather are the same in every session.
const lcg = (seed) => { let state = seed >>> 0 || 1; return () => (state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 4294967296; };

/**
 * The airborne part of a weather: one instanced batch of rain streaks and one of mist banks. It is built
 * once per weather and never rebuilt when a resident walks: the streaks wrap around the weather centre in
 * the vertex program and the banks follow it, both read from the shared motion uniforms.
 */
export function weatherScene({ resources, kind }) {
  const group = new THREE.Group(); group.name = 'voxel-weather'; group.userData.air = true; group.userData.kind = kind;
  const look = WEATHER_LOOK[kind] || WEATHER_LOOK.clear, motion = resources.motion, parts = [];
  if (look.rain) {
    const material = fxMaterial(new THREE.MeshBasicMaterial({ color: '#cfe1ea', transparent: true, opacity: .5, depthWrite: false }), motion,
      { rain: true, params: { uRainSpan: { value: RAIN_LIMITS.span }, uRainHeight: { value: RAIN_LIMITS.height }, uRainSpeed: { value: RAIN_LIMITS.speed } } });
    const mesh = new THREE.InstancedMesh(resources.geometry, material, RAIN_LIMITS.drops), dummy = new THREE.Object3D(), next = lcg(hash(`rain:${kind}`));
    for (let index = 0; index < RAIN_LIMITS.drops; index++) {
      dummy.position.set(next() * RAIN_LIMITS.span, next() * RAIN_LIMITS.height, next() * RAIN_LIMITS.span);
      dummy.scale.set(RAIN_LIMITS.width, RAIN_LIMITS.length * (.7 + next() * .6), RAIN_LIMITS.width); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false; mesh.name = 'voxel-rain';
    group.add(mesh); parts.push(mesh);
  }
  if (look.mist) {
    // Three thin slabs at knee, waist and head height, each with its own noise through the same field, so
    // the mist reads as patches drifting at ground level instead of a flat veil. They are air: no pick.
    const heights = [.22, .6, 1.05].slice(0, RAIN_LIMITS.banks);
    const mesh = new THREE.InstancedMesh(resources.geometry, fxMaterial(new THREE.MeshBasicMaterial({ color: kind === 'rain' ? '#aab6bc' : '#dfe6e3', transparent: true, opacity: 1, depthWrite: false }), motion,
      { world: true, mist: true, params: { uMistDensity: { value: .55 * look.mist } } }), heights.length), dummy = new THREE.Object3D();
    heights.forEach((height, index) => { dummy.position.set(0, height, 0); dummy.scale.set(RAIN_LIMITS.span * 2, .02, RAIN_LIMITS.span * 2); dummy.rotation.y = index * .6; dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix); });
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false; mesh.name = 'voxel-mist';
    mesh.userData.followsCenter = true;
    group.add(mesh); parts.push(mesh);
  }
  return { group, kind, cubes: group.children.reduce((total, mesh) => total + mesh.count, 0), batches: group.children.length,
    /** Moves the mist slabs under the weather centre; the rain follows it in its own program. */
    follow(center) { for (const mesh of group.children) if (mesh.userData.followsCenter) mesh.position.set(center.x, 0, center.y); } };
}

export const disposeWeather = (weather) => {
  if (!weather) return;
  for (const mesh of weather.group.children) { mesh.material.dispose(); mesh.dispose(); }
  weather.group.clear();
};
