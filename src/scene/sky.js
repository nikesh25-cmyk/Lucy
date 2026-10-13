// The sky: the day-phase light, the shadows it casts, the distance fog that reads as depth, and the
// far markers that name the phase.
//
// The four phase names are the ones src/atmosphere.js publishes (dawn, day, dusk, night); this
// module never invents a phase, it only decides how an existing phase is lit. Every value here is a
// renderer-only tint or a light intensity: no saved tile, content definition or world rule changes
// with the phase, and the four published labels, activity lines and the 120-minute cycle are
// untouched.
//
// Two design rules keep the phase readable without ever hiding a world object:
//   1. The distance fog is derived from *how much the window's far corner should fade*, so the depth
//      cue is the same read at every orbit distance: the near field carries no fog at all, and no
//      drawn object is ever more than ~70% faded, so an obstacle keeps its silhouette.
//   2. The night phase raises its ambient light and exposure instead of darkening the world below
//      legibility, so a resident can still see the obstacle in front of them at 03:00.
import * as THREE from '../../assets/vendor/three-voxel.js';
import { hash } from './batch.js';

// The far cloud layer: four banks, each of three slabs. The pattern is the one the world has always
// used; only its tint follows the phase, which is why it is drawn here rather than with the ground.
export const CLOUD_BANKS = Object.freeze([Object.freeze([-12, -9, 1]), Object.freeze([9, -13, 1.3]), Object.freeze([-10, 13, .8]), Object.freeze([15, 8, 1.1])]);
export const CLOUD_SLABS = Object.freeze([Object.freeze([0, 0, 4.4]), Object.freeze([1.2, .8, 3]), Object.freeze([-1.1, -.4, 3.2])]);

/** The legacy alias the client may still send, mapped onto the published phase it means. */
export const PHASE_ALIASES = Object.freeze({ evening: 'dusk' });
/** Hard limits, stated once: a shadow map is never larger and a shadow frustum never wider. */
export const SHADOW_LIMITS = Object.freeze({ map_size: 1024, extent: 24, extent_min: 10, near: .5, far: 60 });

/**
 * One entry per phase. `sky`/`fog` are the background and the depth cue; `zenith`/`ground` are the
 * hemisphere light; `sun`/`sunLight`/`sunHeight`/`sunAzimuth` place the key light and therefore the
 * shadow direction; `exposure` is the one tone-mapping knob the phase moves; `edgeFade` is how
 * much of the window's far corner the depth cue dissolves; `disc`, `stars` and `horizon` are the
 * far markers.
 */
export const SKY_PHASES = Object.freeze({
  dawn: Object.freeze({ sky: '#d9c7a7', fog: '#c9c8aa', zenith: '#f8dfb3', ground: '#6e8069', sun: '#ffd79d', skyLight: 1.55,
    sunLight: 1.9, sunHeight: 16, sunAzimuth: -1.15, exposure: 1.14, edgeFade: .66, cloud: '#ecd9c0',
    disc: Object.freeze({ color: '#ffe0b0', glow: '#f0cfa2', size: 1.5 }), horizon: '#f6d7a8', stars: 0 }),
  day: Object.freeze({ sky: '#a9ccc5', fog: '#b6d1c0', zenith: '#eff7e7', ground: '#697f64', sun: '#fff0c9', skyLight: 1.9,
    sunLight: 2.35, sunHeight: 25, sunAzimuth: .42, exposure: 1.12, edgeFade: .6, cloud: '#e1ebe4',
    disc: Object.freeze({ color: '#fff6d6', glow: '#eaf2e4', size: 1.3 }), horizon: null, stars: 0 }),
  dusk: Object.freeze({ sky: '#c59e86', fog: '#c1a68d', zenith: '#f6d3ae', ground: '#667568', sun: '#ffbe78', skyLight: 1.4,
    sunLight: 1.75, sunHeight: 13, sunAzimuth: 1.05, exposure: 1.1, edgeFade: .66, cloud: '#e5c3a6',
    disc: Object.freeze({ color: '#ffcb8b', glow: '#edb086', size: 1.7 }), horizon: '#e8b98c', stars: 0 }),
  night: Object.freeze({ sky: '#334d57', fog: '#405b60', zenith: '#9ebbc0', ground: '#344841', sun: '#a9c7d8', skyLight: 1.05,
    sunLight: 1.15, sunHeight: 20, sunAzimuth: 2.4, exposure: 1.2, edgeFade: .72, cloud: '#46566a',
    disc: Object.freeze({ color: '#eef2e0', glow: '#cfe0e2', size: 1.1 }), horizon: null, stars: 44 }),
});

/** The phase table entry for a published name, the legacy alias, or an unknown phase (day). */
export function phaseLighting(name) {
  const resolved = PHASE_ALIASES[name] || name;
  return Object.hasOwn(SKY_PHASES, resolved) ? SKY_PHASES[resolved] : SKY_PHASES.day;
}
/** The phase name actually applied for a published or aliased input. */
export const resolvedPhase = (name) => Object.hasOwn(SKY_PHASES, PHASE_ALIASES[name] || name) ? PHASE_ALIASES[name] || name : 'day';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The far corner of the drawn window, relative to the viewer, for a 37 x 37 viewport. */
export const WINDOW_REACH = 18.5;

/**
 * The depth cue for one phase and one viewing distance. The band is derived from the falloff the
 * phase wants at the window's far corner, so the same depth reads at every orbit distance: the
 * band never starts inside the near field (`near >= 4`), so the tile a resident stands on and its
 * neighbours carry no fog at all; and nothing inside the window is ever more than ~70% faded, so an
 * obstacle is always still there to be seen. A denser phase is a shorter band, not a darker wall.
 */
export function fogFor(entry, distance = 0) {
  const span = clamp(Number.isFinite(distance) ? distance : 0, 0, 32), edge = span + WINDOW_REACH;
  const near = clamp(span * .5 + 4, 4, 22);
  return { near, far: Math.min(80, Math.max(near + 8, near + (edge - near) / entry.edgeFade)) };
}

/** The key light's position for one phase: the azimuth turns with the phase, so shadows turn too. */
export function sunPlacement(entry, target, radius = 16) {
  return { x: (target?.x ?? 0) + Math.sin(entry.sunAzimuth) * radius, y: entry.sunHeight,
    z: (target?.y ?? 0) + Math.cos(entry.sunAzimuth) * radius };
}

/**
 * The shadow frustum. It is fitted to the visible window instead of a fixed 48 m square, which
 * raises the shadow resolution at the same 1024 map: a 37-cell window needs a 19.5 m half-extent
 * where the shipped fixed value used 24, so one shadow texel covers 26.3 px/m instead of 21.3. The
 * limit is a cap, not a target: a larger window is clamped, never widened.
 */
export function shadowExtent(plan) {
  const area = plan?.window;
  const span = area ? Math.max(area.right - area.x, area.bottom - area.y) : 0;
  return clamp(span / 2 + 1, SHADOW_LIMITS.extent_min, SHADOW_LIMITS.extent);
}

/** The shadow texels per virtual metre this frustum gives, for the benchmark's report. */
export const shadowResolution = (extent) => SHADOW_LIMITS.map_size / (extent * 2);

/**
 * Applies one phase to the live scene and returns exactly what it set, so a test can read the
 * applied values back instead of re-deriving them.
 */
export function applyPhase({ scene, sky, sun, renderer, phase, position, distance = 0, plan }) {
  const entry = phaseLighting(phase), fog = fogFor(entry, distance), name = resolvedPhase(phase);
  if (scene.background) scene.background.set(entry.sky); else scene.background = new THREE.Color(entry.sky);
  if (!scene.fog) scene.fog = new THREE.Fog(entry.fog, fog.near, fog.far);
  scene.fog.color.set(entry.fog);
  scene.fog.near = fog.near; scene.fog.far = fog.far;
  sky.color.set(entry.zenith); sky.groundColor.set(entry.ground); sky.intensity = entry.skyLight;
  const placement = sunPlacement(entry, position);
  sun.color.set(entry.sun); sun.intensity = entry.sunLight;
  sun.position.set(placement.x, placement.y, placement.z); sun.target.position.set(position?.x ?? 0, 0, position?.y ?? 0);
  sun.target.updateMatrixWorld();
  const extent = shadowExtent(plan), camera = sun.shadow.camera;
  if (camera.right !== extent) {
    camera.left = -extent; camera.right = extent; camera.top = extent; camera.bottom = -extent;
    camera.near = SHADOW_LIMITS.near; camera.far = SHADOW_LIMITS.far; camera.updateProjectionMatrix();
  }
  if (sun.shadow.mapSize.x !== SHADOW_LIMITS.map_size) sun.shadow.mapSize.set(SHADOW_LIMITS.map_size, SHADOW_LIMITS.map_size);
  if (renderer) renderer.toneMappingExposure = entry.exposure;
  return { phase: name, background: entry.sky, fog: { ...fog }, skyLight: entry.skyLight,
    sunLight: entry.sunLight, sun: { ...placement }, extent, exposure: entry.exposure };
}

/**
 * The far sky layer of one phase: cloud banks, the phase disc and its halo, night stars and the dawn
 * and dusk horizon band. Everything here is scenery, not occupancy: no marker is ever drawn inside a
 * standing column (the lowest is 3.2 m), none carries a pick, and none casts or receives a shadow.
 */
export function skyScene({ resources, cubeBatch, plan, phase, layers }) {
  const entry = phaseLighting(phase), batch = cubeBatch(resources), area = plan.window;
  const centerX = (area.x + area.right) / 2, centerY = (area.y + area.bottom) / 2;
  const azimuth = entry.sunAzimuth, disc = entry.disc, discHeight = Math.max(8, entry.sunHeight * .8);
  const before = batch.size;
  for (const [dx, dy, size] of CLOUD_BANKS) for (const [cx, cy, length] of CLOUD_SLABS) {
    batch.add(centerX + dx + cx, 10 + cy * .1, centerY + dy + cy, length * size, .5 * size, 1.6 * size, entry.cloud, null, 'cloud');
  }
  const discX = centerX + Math.sin(azimuth) * 26, discY = centerY + Math.cos(azimuth) * 26;
  batch.add(discX, discHeight, discY, disc.size * 1.6, disc.size, disc.size * 1.6, disc.color, null, 'sun');
  batch.add(discX, discHeight + .1, discY, disc.size * 3.4, disc.size * 2.6, disc.size * 3.4, disc.glow, null, 'haze');
  for (let index = 0; index < entry.stars; index++) {
    const n = hash(`star:${index}`), spread = (value, span) => ((value % span) / span - .5) * 46;
    batch.add(centerX + spread(n % 997, 997), 15 + (n >> 5) % 7, centerY + spread((n >> 11) % 991, 991),
      .1 + (n % 3) * .04, .1 + (n % 3) * .04, .1 + (n % 3) * .04, (n >> 3) % 3 ? '#f2f4e2' : '#dfe8d4', null, 'star');
  }
  if (entry.horizon) for (const [spread, height, width] of [[-.52, 3.2, 9], [0, 5, 12], [.52, 6.6, 8]]) {
    const angle = azimuth + spread;
    batch.add(centerX + Math.sin(angle) * 28, height, centerY + Math.cos(angle) * 28, width, .6, 1.4, entry.horizon, null, 'haze');
  }
  const result = batch.finish(); result.group.name = 'voxel-sky';
  if (layers) layers.sky = (layers.sky || 0) + (batch.size - before);
  return result;
}
