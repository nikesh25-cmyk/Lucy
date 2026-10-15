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
//   star    — a bright unfogged sky speck (night)
//   sun     — the unfogged phase disc
//   parcel-* — the flat plot-boundary overlay (see src/scene/parcels.js)
import * as THREE from '../../assets/vendor/three-voxel.js';

/** Styles that never cast or receive a shadow: sky, haze, decals and foliage specks. */
export const SHADOWLESS_STYLES = Object.freeze(['cloud', 'detail', 'haze', 'star', 'sun', 'light']);
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
const TONED_STYLES = Object.freeze(['solid', 'detail']);

function faceToning(material) {
  material.onBeforeCompile = (shader) => {
    const t = FACE_TONES, f = (value) => value.toFixed(3);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFaceTone;\nvarying float vFaceSide;\nvarying float vFaceHeight;')
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
      vec3 faceN = normalize(inverseTransformDirection(transformedNormal, viewMatrix));
      vFaceSide = abs(faceN.y) < .5 ? 1.0 : 0.0;
      vFaceTone = faceN.y > .5 ? ${f(t.top)} : faceN.y < -.5 ? ${f(t.bottom)}
        : abs(faceN.x) > abs(faceN.z) ? (faceN.x > 0.0 ? ${f(t.east)} : ${f(t.west)}) : (faceN.z > 0.0 ? ${f(t.south)} : ${f(t.north)});`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 faceWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
      faceWorld = instanceMatrix * faceWorld;
      #endif
      vFaceHeight = (modelMatrix * faceWorld).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFaceTone;\nvarying float vFaceSide;\nvarying float vFaceHeight;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      diffuseColor.rgb *= vFaceTone * (1.0 - vFaceSide * ${f(t.contact)} * (1.0 - smoothstep(0.0, ${f(t.contact_height)}, vFaceHeight)));`);
  };
  // The patched program is not the stock Lambert program, so it must not share its cache entry.
  material.customProgramCacheKey = () => 'voxel-face-tone-1';
  material.userData.faceToning = true;
  return material;
}

export function createResources() {
  const geometry = new THREE.BoxGeometry(1, 1, 1), materials = new Map();
  // The emissive strength every `glow` material is drawn at. A phase moves it (lamps and windows are
  // brighter after dark) without rebuilding a single batch: it is a material property, not geometry.
  let glow = .28;
  function material(color, style = 'solid') {
    const key = `${color}:${style}`;
    if (!materials.has(key)) {
      // `blending: 2` is three.js's AdditiveBlending; the retained bundle does not export the constant.
      const created = style === 'light'
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .24, depthWrite: false, fog: false, blending: 2 })
        : style.startsWith('parcel-')
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: style === 'parcel-fill' ? .08 : style === 'parcel-hover' ? .65 : .88,
          depthWrite: false, depthTest: style === 'parcel-boundary' })
        : new THREE.MeshLambertMaterial({ color, flatShading: true,
          ...(UNFOGGED_STYLES.includes(style) ? { fog: false } : {}),
          ...(style === 'glass' ? { transparent: true, opacity: 0.58, depthWrite: false } : {}),
          ...(style === 'cloud' ? { transparent: true, opacity: 0.74, depthWrite: false } : {}),
          ...(style === 'haze' ? { transparent: true, opacity: 0.19, depthWrite: false } : {}),
          ...(style === 'glow' ? { emissive: color, emissiveIntensity: glow } : {}),
          ...(style === 'star' ? { emissive: color, emissiveIntensity: 0.92 } : {}),
          ...(style === 'sun' ? { emissive: color, emissiveIntensity: 0.8 } : {}) });
      materials.set(key, TONED_STYLES.includes(style) ? faceToning(created) : created);
    }
    return materials.get(key);
  }
  return { geometry, material,
    /** Sets the emissive strength of every glow material, existing and future; returns the value in force. */
    setGlow(value) {
      if (!Number.isFinite(value)) return glow;
      glow = Math.max(0, Math.min(2, value));
      for (const [key, item] of materials) if (key.endsWith(':glow')) item.emissiveIntensity = glow;
      return glow;
    },
    get glow() { return glow; },
    dispose() { geometry.dispose(); for (const item of materials.values()) item.dispose(); materials.clear(); } };
}

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
      mesh.userData.picks = [];
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
