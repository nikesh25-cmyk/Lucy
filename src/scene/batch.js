// Instanced-batch primitives shared by every scene module under src/scene/.
//
// One `InstancedMesh` per colour and material style means a scene's cost is cubes, not draw calls.
// `src/voxel-world.js` keeps the reuse policy (a batch is rebuilt only when its own key changes);
// this module only knows how to add boxes and how to finish them into real GPU batches.
//
// Style vocabulary, all renderer-only tints with no sealed definition:
//   solid   — an opaque flat-shaded box that casts and receives shadow
//   glass   — translucent, no depth write
//   cloud   — translucent, never casts or receives shadow
//   detail  — opaque floor decal or ground speck: never casts or receives shadow
//   glow    — a self-lit lantern or window pane; its emissive strength follows the phase (see `setGlow`)
//   haze    — a very transparent sky or horizon band, unfogged and depth-write free
//   light   — lamp light: an unlit, additive, depth-write-free glow, so it brightens whatever it lies over
//   water   — the water surface: toned like a solid, its top vertices ride a slow wave and it glints
//   foam    — a shore break that laps in and out
//   contact — a soft dark footprint under a mass, so it stands on the ground instead of floating
//   star    — a bright unfogged sky speck (night)
//   sun     — the unfogged phase disc
//   parcel-* — the flat plot-boundary overlay (see src/scene/parcels.js)
import * as THREE from '../../assets/vendor/three-voxel.js';

/** Styles that never cast or receive a shadow: sky, haze, decals, foam and foliage specks. */
export const SHADOWLESS_STYLES = Object.freeze(['cloud', 'detail', 'haze', 'star', 'sun', 'light', 'foam', 'contact']);
/** Styles that ignore distance fog, so a far sky marker is not swallowed by the depth cue. */
const UNFOGGED_STYLES = Object.freeze(['haze', 'star', 'sun', 'light']);

/** Deterministic per-tile hash. The same tile always draws the same variant, in every session. */
export const hash = (value) => { let result = 0; for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0; };

/** A deterministic ±9% tint of `base`, so neighbouring tiles are distinguishable without a texture. */
export const variant = (base, x, y) => new THREE.Color(base).multiplyScalar(0.91 + ((x * 47 + y * 91) % 7) * 0.025).getHex();

/**
 * A brighter or darker tone of an existing family colour. Depth and phase shading are derived from
 * the palette already in the repository instead of introducing a new token, so the asset family's
 * one-palette claim stays true.
 */
export const shade = (base, factor) => new THREE.Color(base).multiplyScalar(factor).getHex();

/**
 * How the box faces are toned. The flat-shaded Lambert material already lights a face by its angle to
 * the sun, but that is the *only* cue, so when the sun is high or the camera looks along the light every
 * face of a big mass reads the same colour — the "muddy" first-person view. This adds a fixed per-face
 * tone on top: the top of a box is brightest, the four sides step down by compass direction, the
 * underside is darkest, and a side face darkens a little toward the ground (contact shade). The tone
 * is computed in the vertex shader from the world-space normal, so a box reads the same from any camera.
 * It multiplies the albedo only: emissive panes keep their own light, and sky, haze and glass styles
 * are never patched.
 */
export const FACE_TONES = Object.freeze({ top: 1.08, south: .96, east: .89, west: .83, north: .76, bottom: .58, contact: .22, contact_height: .55 });
const TONED_STYLES = Object.freeze(['solid', 'detail', 'water']);

/**
 * The shared, animated state of one scene. Every value is a uniform *object* handed to each patched
 * program by reference, so moving the clock costs no rebuild and no material recompile.
 *   time    seconds on the ambient clock; it stays 0 under `prefers-reduced-motion`, so every animated
 *           surface is drawn as one still frame
 *   wave    how far a water top vertex may rise or fall, in metres (0 when motion is reduced)
 *   cloud   how much a drifting cloud shadow darkens the tops of the world (0 outdoors in a room or at night)
 *   center  the tile the weather volume follows, so rain and mist never need a rebuild when a resident walks
 */
export const createMotion = () => ({ time: { value: 0 }, wave: { value: 0 }, cloud: { value: 0 }, center: { value: new THREE.Vector3() } });

// The cloud-shadow field. Two crossed sine families drift slowly across the world; the smoothstep keeps
// roughly a fifth of the ground in shade at any time, in soft-edged blobs about ten tiles across.
const GLSL_FIELDS = `
float cloudField(vec2 p, float t) {
  vec2 q = p * .12 + vec2(t * .045, t * .02);
  float v = sin(q.x * 2.1 + sin(q.y * 1.7) * 1.5) * sin(q.y * 1.9 - sin(q.x * 1.3) * 1.2);
  return smoothstep(.12, .7, v);
}
float waveAt(vec2 p, float t) {
  return sin(p.x * 1.7 + t * 1.3) * .5 + sin(p.y * 1.3 - t * 1.1 + p.x * .4) * .5;
}
float mistField(vec2 p, float t) {
  vec2 q = p * .09 + vec2(t * .03, -t * .012);
  float v = sin(q.x * 2.3 + sin(q.y * 2.1) * 1.6) * .5 + sin(q.y * 1.7 - q.x * 1.1) * .5;
  return smoothstep(-.25, .65, v);
}`;

/**
 * One program patch, selected by flags. All the lit styles share the world-space face tone; a `water`
 * surface additionally moves its top vertices and glints; `foam` lap in and out; `cloud` shadow drifts
 * over any top face; a `rain` streak falls and wraps around the weather centre; `mist` is a drifting,
 * noisy translucent slab; a `dome` is the sky gradient. Each combination has its own program cache key,
 * because a patched program is not the stock Lambert or Basic program.
 */
function patchProgram(material, motion, flags) {
  const t = FACE_TONES, f = (value) => value.toFixed(3);
  const key = `voxel-fx-3-${Object.keys(flags).filter((name) => flags[name]).sort().join('+')}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = motion.time; shader.uniforms.uWave = motion.wave; shader.uniforms.uCloud = motion.cloud;
    shader.uniforms.uCenter = motion.center;
    if (flags.params) for (const [name, uniform] of Object.entries(flags.params)) shader.uniforms[name] = uniform;
    let vertexHead = 'varying vec3 vFxWorld;', fragmentHead = `varying vec3 vFxWorld;\nuniform float uTime;\nuniform float uWave;\nuniform float uCloud;\nuniform vec3 uCenter;\n${GLSL_FIELDS}`;
    vertexHead += '\nuniform float uTime;\nuniform float uWave;\nuniform vec3 uCenter;\n' + GLSL_FIELDS;
    if (flags.tone) { vertexHead += '\nvarying float vFaceTone;\nvarying float vFaceSide;\nvarying float vFaceHeight;\nvarying float vFaceTop;'; fragmentHead += '\nvarying float vFaceTone;\nvarying float vFaceSide;\nvarying float vFaceHeight;\nvarying float vFaceTop;'; }
    if (flags.rain) { vertexHead += '\nuniform float uRainSpan;\nuniform float uRainHeight;\nuniform float uRainSpeed;'; }
    if (flags.dome) { vertexHead += '\nvarying vec3 vDomeDir;'; fragmentHead += '\nvarying vec3 vDomeDir;\nuniform vec3 uHorizon;\nuniform vec3 uTop;\nuniform vec3 uGlowColor;\nuniform vec3 uSunDir;\nuniform float uGlow;'; }
    if (flags.mist) { fragmentHead += '\nuniform float uMistDensity;'; }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexHead}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragmentHead}`);
    if (flags.tone) shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
      vec3 faceN = normalize(inverseTransformDirection(transformedNormal, viewMatrix));
      vFaceSide = abs(faceN.y) < .5 ? 1.0 : 0.0;
      vFaceTop = faceN.y > .5 ? 1.0 : 0.0;
      vFaceTone = faceN.y > .5 ? ${f(t.top)} : faceN.y < -.5 ? ${f(t.bottom)}
        : abs(faceN.x) > abs(faceN.z) ? (faceN.x > 0.0 ? ${f(t.east)} : ${f(t.west)}) : (faceN.z > 0.0 ? ${f(t.south)} : ${f(t.north)});`);
    if (flags.world) shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 faceWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
      faceWorld = instanceMatrix * faceWorld;
      #endif
      vec4 faceWorldM = modelMatrix * faceWorld;
      ${flags.tone ? 'vFaceHeight = faceWorldM.y;' : ''}
      vFxWorld = faceWorldM.xyz;
      ${flags.wave ? 'if (position.y > 0.0) transformed.y += waveAt(faceWorldM.xz, uTime) * uWave;' : ''}`);
    if (flags.rain) shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec3 rainBase = instanceMatrix[3].xyz;
      vec3 rainLocal = (instanceMatrix * vec4(transformed, 1.0)).xyz - rainBase;
      vec3 rainAt;
      rainAt.x = uCenter.x - uRainSpan * .5 + mod(rainBase.x - uCenter.x + uRainSpan * .5, uRainSpan);
      rainAt.z = uCenter.z - uRainSpan * .5 + mod(rainBase.z - uCenter.z + uRainSpan * .5, uRainSpan);
      rainAt.y = mod(rainBase.y - uTime * uRainSpeed, uRainHeight);
      rainAt.x += rainAt.y * .12;
      vec4 mvPosition = modelViewMatrix * vec4(rainAt + rainLocal, 1.0);
      gl_Position = projectionMatrix * mvPosition;`);
    if (flags.dome) {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vDomeDir = position;`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        vec3 dir = normalize(vDomeDir);
        float rise = smoothstep(-.08, .62, dir.y);
        vec3 sky = mix(uHorizon, uTop, pow(rise, .85));
        float towards = max(dot(dir, normalize(uSunDir)), 0.0);
        sky = mix(sky, uGlowColor, uGlow * (pow(towards, 5.0) * .55 + pow(towards, 40.0) * .45) * (1.0 - rise * .55));
        sky = mix(sky, uHorizon, smoothstep(.0, -.2, dir.y));
        diffuseColor.rgb = sky;`);
    }
    if (flags.tone) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= vFaceTone * (1.0 - vFaceSide * ${f(t.contact)} * (1.0 - smoothstep(0.0, ${f(t.contact_height)}, vFaceHeight)));
      diffuseColor.rgb *= 1.0 - uCloud * vFaceTop * cloudField(vFxWorld.xz, uTime);
      ${flags.shimmer ? `float glide = sin(vFxWorld.x * 1.1 + vFxWorld.z * .9 + uTime * .8);
      diffuseColor.rgb *= .95 + .07 * glide;
      float glint = sin(vFxWorld.x * 3.1 + uTime * 1.9) * sin(vFxWorld.z * 2.7 - uTime * 1.5);
      diffuseColor.rgb += vec3(.5, .58, .56) * pow(max(glint, 0.0), 12.0) * vFaceTop;` : ''}`);
    if (flags.foam) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.a *= .3 + .7 * (sin(uTime * 1.5 + vFxWorld.x * .9 + vFxWorld.z * 1.1) * .5 + .5);`);
    if (flags.mist) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float edgeZ = 1.0 - smoothstep(12.0, 22.0, abs(vFxWorld.z - uCenter.z));
      float edgeX = 1.0 - smoothstep(12.0, 22.0, abs(vFxWorld.x - uCenter.x));
      diffuseColor.a *= mistField(vFxWorld.xz, uTime) * uMistDensity * edgeX * edgeZ;`);
  };
  material.customProgramCacheKey = () => key;
  material.userData.patched = key;
  return material;
}

export function createResources() {
  const geometry = new THREE.BoxGeometry(1, 1, 1), materials = new Map(), motion = createMotion();
  // The emissive strength every `glow` material is drawn at. A phase moves it (lamps and windows are
  // brighter after dark) without rebuilding a single batch: it is a material property, not geometry.
  let glow = .28;
  function material(color, style = 'solid') {
    const key = `${color}:${style}`;
    if (!materials.has(key)) {
      // `blending: 2` is three.js's AdditiveBlending; the retained bundle does not export the constant.
      const created = style === 'light'
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .24, depthWrite: false, fog: false, blending: 2 })
        : style === 'contact'
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .2, depthWrite: false })
        : style.startsWith('parcel-')
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: style === 'parcel-fill' ? .08 : style === 'parcel-hover' ? .65 : .88,
          depthWrite: false, depthTest: style === 'parcel-boundary' })
        : new THREE.MeshLambertMaterial({ color, flatShading: true,
          ...(UNFOGGED_STYLES.includes(style) ? { fog: false } : {}),
          ...(style === 'glass' ? { transparent: true, opacity: 0.58, depthWrite: false } : {}),
          ...(style === 'cloud' ? { transparent: true, opacity: 0.74, depthWrite: false } : {}),
          ...(style === 'haze' ? { transparent: true, opacity: 0.19, depthWrite: false } : {}),
          ...(style === 'foam' ? { transparent: true, opacity: .9, depthWrite: false } : {}),
          ...(style === 'glow' ? { emissive: color, emissiveIntensity: glow } : {}),
          ...(style === 'star' ? { emissive: color, emissiveIntensity: 0.92 } : {}),
          ...(style === 'sun' ? { emissive: color, emissiveIntensity: 0.8 } : {}) });
      // Which programs are patched, and with what: see `patchProgram`.
      const patch = style === 'water' ? { tone: true, world: true, wave: true, shimmer: true }
        : TONED_STYLES.includes(style) ? { tone: true, world: true }
        : style === 'foam' ? { world: true, foam: true } : null;
      materials.set(key, patch ? patchProgram(created, motion, patch) : created);
      if (patch) created.userData.faceToning = !!patch.tone;
    }
    return materials.get(key);
  }
  return { geometry, material, motion,
    /** Sets the emissive strength of every glow material, existing and future; returns the value in force. */
    setGlow(value) {
      if (!Number.isFinite(value)) return glow;
      glow = Math.max(0, Math.min(2, value));
      for (const [key, item] of materials) if (key.endsWith(':glow')) item.emissiveIntensity = glow;
      return glow;
    },
    get glow() { return glow; },
    /** Advances the ambient clock. `reduced` freezes it at zero, so animated surfaces are one still frame. */
    setMotion({ time = 0, reduced = false, cloud = 0, center = null } = {}) {
      motion.time.value = reduced ? 0 : time; motion.wave.value = reduced ? 0 : .028; motion.cloud.value = cloud;
      if (center) motion.center.value.set(center.x, 0, center.y);
    },
    dispose() { geometry.dispose(); for (const item of materials.values()) item.dispose(); materials.clear(); } };
}

/** Compiles the given flags into a patched material of any kind; the weather and the sky dome use it. */
export const fxMaterial = (material, motion, flags) => patchProgram(material, motion, flags);

/** A six-digit `#rrggbb` string, or null. Used for authored landmark and participant colours. */
export const validColor = (value) => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : null;

/**
 * A batch collector. Instances are grouped by colour and style, then finished into one
 * `InstancedMesh` each. `size` is the running instance count, so a caller can account for the
 * cubes its own pass contributed without splitting a batch.
 */
export function cubeBatch(resources) {
  const batches = new Map(); let cubes = 0;
  const add = (x, height, y, width, depth, length, color, pick = null, style = 'solid') => {
    const key = `${color}:${style}`;
    if (!batches.has(key)) batches.set(key, { material: resources.material(color, style), style, instances: [] });
    batches.get(key).instances.push({ x, height, y, width, depth, length, pick }); cubes++;
  };
  function finish() {
    const group = new THREE.Group(), pickables = [], dummy = new THREE.Object3D();
    for (const batch of batches.values()) {
      const mesh = new THREE.InstancedMesh(resources.geometry, batch.material, batch.instances.length);
      mesh.userData.picks = []; mesh.userData.style = batch.style;
      batch.instances.forEach((item, index) => {
        dummy.position.set(item.x, item.height, item.y); dummy.scale.set(item.width, item.depth, item.length); dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix); mesh.userData.picks[index] = item.pick;
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
      const shadowed = !SHADOWLESS_STYLES.includes(batch.style);
      mesh.castShadow = shadowed; mesh.receiveShadow = shadowed;
      group.add(mesh); if (mesh.userData.picks.some(Boolean)) pickables.push(mesh);
    }
    return { group, pickables, cubes, batches: batches.size };
  }
  return { add, finish, get size() { return cubes; } };
}

export const disposeBatch = (batch) => { if (!batch) return; for (const mesh of batch.group.children) mesh.dispose(); batch.group.clear(); };

/** Adds `count` cubes to a named layer tally, so a benchmark can report what a pass costs. */
export const accountLayer = (layers, name, count) => { layers[name] = (layers[name] || 0) + count; };
