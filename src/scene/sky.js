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
//
// Light contrast. A flat-shaded world only reads when its lit faces and its shaded faces are clearly
// different, so every phase keeps the key light well above the hemisphere light (a `sunLight` to
// `skyLight` ratio of about 1.5 to 2) and the phase table below states that ratio instead of leaving it
// implied. The per-face tone and the contact shade that finish the job live in src/scene/batch.js.
import * as THREE from '../../assets/vendor/three-voxel.js';
import { fxMaterial, hash } from './batch.js';
import { WEATHER_LOOK } from './weather.js';

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
  dawn: Object.freeze({ sky: '#d9bda0', fog: '#d9bda0', zenith: '#fae3c6', ground: '#6d7d66', sun: '#ffc98a', skyLight: 1.3,
    sunLight: 2.55, sunHeight: 15, sunAzimuth: -1.15, exposure: 1.14, edgeFade: .66, cloud: '#ecd9c0', glow: .5,
    disc: Object.freeze({ color: '#ffe0b0', glow: '#f0cfa2', size: 1.5 }), horizon: '#f6d7a8', stars: 0, top: '#7d93c0', halo: .62 }),
  day: Object.freeze({ sky: '#8ab4c4', fog: '#8ab4c4', zenith: '#eaf4f7', ground: '#5c7558', sun: '#fff2ce', skyLight: 1.85,
    sunLight: 3.05, sunHeight: 25, sunAzimuth: .42, exposure: 1.14, edgeFade: .6, cloud: '#eaf2ee', glow: .28,
    disc: Object.freeze({ color: '#fff6d6', glow: '#eaf2e4', size: 1.3 }), horizon: null, stars: 0, top: '#4a84b3', halo: .24 }),
  dusk: Object.freeze({ sky: '#b8836e', fog: '#b8836e', zenith: '#f6bca0', ground: '#625b5c', sun: '#ff9d5c', skyLight: 1.15,
    sunLight: 2.3, sunHeight: 12, sunAzimuth: 1.05, exposure: 1.14, edgeFade: .66, cloud: '#e5c3a6', glow: .85,
    disc: Object.freeze({ color: '#ffcb8b', glow: '#edb086', size: 1.7 }), horizon: '#e8b98c', stars: 0, top: '#4f5a92', halo: .72 }),
  // Night keeps a legible floor by *colour*, not by flattening: a pale blue moon on the lit faces, a
  // clearly darker bounce on the shaded ones, and lamps and windows burning at full strength so they
  // become the brightest things in view.
  night: Object.freeze({ sky: '#1b2a3d', fog: '#223348', zenith: '#9dbbe0', ground: '#3a4f62', sun: '#c4d9ff', skyLight: 1.4,
    sunLight: 2.3, sunHeight: 20, sunAzimuth: 2.4, exposure: 1.34, edgeFade: .72, cloud: '#3d4d5e', glow: 1.25,
    disc: Object.freeze({ color: '#eef2e0', glow: '#cfe0e2', size: 1.1 }), horizon: null, stars: 44, top: '#0a1424', halo: .14 }),
});

/**
 * The light of a room. An interior has no sky and no hour, so it is lit the same way at every phase: a
 * warm window-and-lamp key from one side, a soft warm bounce, and a dark warm backdrop so the room
 * reads as a lit stage instead of a floor floating in daylight. Not a fifth phase: `SKY_PHASES` stays
 * the four published names, and this entry is only ever chosen by an interior world.
 */
export const INTERIOR_LIGHTING = Object.freeze({ sky: '#201c1a', fog: '#2a2420', zenith: '#fff1d8', ground: '#8f7b63', sun: '#ffe2b4',
  skyLight: 1.45, sunLight: 2.7, sunHeight: 22, sunAzimuth: .8, exposure: 1.2, edgeFade: .66, cloud: '#3a322c', glow: 1.0,
  disc: null, horizon: null, stars: 0, top: '#2a2420', halo: 0 });

/** The phase table entry for a published name, the legacy alias, or an unknown phase (day). */
export function phaseLighting(name) {
  const resolved = PHASE_ALIASES[name] || name;
  return Object.hasOwn(SKY_PHASES, resolved) ? SKY_PHASES[resolved] : SKY_PHASES.day;
}
/** The phase name actually applied for a published or aliased input. */
export const resolvedPhase = (name) => Object.hasOwn(SKY_PHASES, PHASE_ALIASES[name] || name) ? PHASE_ALIASES[name] || name : 'day';

/** How much of its daylight tint a weather keeps in each phase: a night mist is dark, not grey-white. */
const PHASE_BRIGHTNESS = Object.freeze({ dawn: .85, day: 1, dusk: .7, night: .26, interior: 1 });
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
export function applyPhase({ scene, sky, sun, renderer, phase, position, distance = 0, plan, interior = false, weather = 'clear', dome = null, firstPerson = false }) {
  const entry = interior ? INTERIOR_LIGHTING : phaseLighting(phase), name = interior ? 'interior' : resolvedPhase(phase);
  const look = interior ? WEATHER_LOOK.clear : WEATHER_LOOK[weather] || WEATHER_LOOK.clear, mixed = (hex) => look.mix ? new THREE.Color(hex).lerp(new THREE.Color(look.tint).multiplyScalar(PHASE_BRIGHTNESS[name] ?? 1), look.mix) : new THREE.Color(hex);
  // A first-person view looks along the ground, where the depth cue does the most work: it hazes a little earlier.
  const base = fogFor(entry, distance), haze = firstPerson && !interior ? .86 : 1;
  const fog = { near: base.near * look.fogNear, far: base.far * look.fogFar * haze };
  const horizon = mixed(entry.fog);
  if (scene.background) scene.background.copy(mixed(entry.sky)); else scene.background = mixed(entry.sky);
  if (!scene.fog) scene.fog = new THREE.Fog(horizon, fog.near, fog.far);
  scene.fog.color.copy(horizon);
  scene.fog.near = fog.near; scene.fog.far = fog.far;
  sky.color.set(entry.zenith); sky.groundColor.set(entry.ground); sky.intensity = entry.skyLight * look.sky;
  const placement = sunPlacement(entry, position);
  sun.color.set(entry.sun); sun.intensity = entry.sunLight * look.sun;
  sun.position.set(placement.x, placement.y, placement.z); sun.target.position.set(position?.x ?? 0, 0, position?.y ?? 0);
  sun.target.updateMatrixWorld();
  const extent = shadowExtent(plan), camera = sun.shadow.camera;
  if (camera.right !== extent) {
    camera.left = -extent; camera.right = extent; camera.top = extent; camera.bottom = -extent;
    camera.near = SHADOW_LIMITS.near; camera.far = SHADOW_LIMITS.far; camera.updateProjectionMatrix();
  }
  if (sun.shadow.mapSize.x !== SHADOW_LIMITS.map_size) sun.shadow.mapSize.set(SHADOW_LIMITS.map_size, SHADOW_LIMITS.map_size);
  if (renderer) renderer.toneMappingExposure = entry.exposure;
  if (dome) dome.update({ horizon, top: mixed(entry.top), glowColor: new THREE.Color(entry.sun), glow: entry.halo * (look.mix ? 1 - look.mix * .7 : 1),
    sunDirection: { x: placement.x - (position?.x ?? 0), y: placement.y, z: placement.z - (position?.y ?? 0) }, hidden: interior });
  return { phase: name, weather: interior ? 'clear' : weather, background: entry.sky, fog: { ...fog }, skyLight: sky.intensity,
    sunLight: sun.intensity, sun: { ...placement }, extent, exposure: entry.exposure, glow: entry.glow, cloud: cloudShadow(phase, weather, interior) };
}

/** The strength of the drifting cloud shadow: none in a room, a third of it at night, and the weather's own overcast. */
export const cloudShadow = (phase, weather = 'clear', interior = false) => interior ? 0
  : (WEATHER_LOOK[weather] || WEATHER_LOOK.clear).cloud * (resolvedPhase(phase) === 'night' ? .3 : 1);

/**
 * The sky gradient: a large inside-out box around the camera whose fragment colour is a function of the
 * viewing direction only — horizon colour at the horizon (the same colour the depth cue fades to, so far
 * geometry dissolves into it), a deeper top, and a warm glow toward the sun. It is not scene geometry: it
 * is one render-only draw call with no pick that follows the camera, draws first and writes no depth.
 */
export function createSkyDome(resources) {
  const uniforms = { uHorizon: { value: new THREE.Color('#8ab4c4') }, uTop: { value: new THREE.Color('#4a84b3') }, uGlowColor: { value: new THREE.Color('#fff2ce') },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uGlow: { value: 0 } };
  const material = fxMaterial(new THREE.MeshBasicMaterial({ color: '#8ab4c4', side: 1, fog: false, depthWrite: false, depthTest: false, toneMapped: false }), resources.motion, { dome: true, params: uniforms });
  const geometry = new THREE.BoxGeometry(2, 2, 2), mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'voxel-sky-dome'; mesh.scale.setScalar(DOME_RADIUS); mesh.renderOrder = -1000; mesh.frustumCulled = false; mesh.userData.renderOnly = true;
  return { mesh,
    update({ horizon, top, glowColor, glow, sunDirection, hidden }) {
      uniforms.uHorizon.value.copy(horizon); uniforms.uTop.value.copy(top); uniforms.uGlowColor.value.copy(glowColor); uniforms.uGlow.value = glow;
      uniforms.uSunDir.value.set(sunDirection.x, sunDirection.y, sunDirection.z).normalize(); mesh.visible = !hidden;
    },
    follow(camera) { mesh.position.copy(camera.position); },
    dispose() { geometry.dispose(); material.dispose(); } };
}
/** The dome's half-extent: inside the camera's 100 m far plane, outside everything the window draws. */
export const DOME_RADIUS = 48;

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
