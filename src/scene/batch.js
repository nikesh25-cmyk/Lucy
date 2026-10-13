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
//   glow    — a self-lit lantern or window pane
//   haze    — a very transparent sky or horizon band, unfogged and depth-write free
//   star    — a bright unfogged sky speck (night)
//   sun     — the unfogged phase disc
//   parcel-* — the flat plot-boundary overlay (see src/scene/parcels.js)
import * as THREE from '../../assets/vendor/three-voxel.js';

/** Styles that never cast or receive a shadow: sky, haze, decals and foliage specks. */
export const SHADOWLESS_STYLES = Object.freeze(['cloud', 'detail', 'haze', 'star', 'sun']);
/** Styles that ignore distance fog, so a far sky marker is not swallowed by the depth cue. */
const UNFOGGED_STYLES = Object.freeze(['haze', 'star', 'sun']);

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

export function createResources() {
  const geometry = new THREE.BoxGeometry(1, 1, 1), materials = new Map();
  function material(color, style = 'solid') {
    const key = `${color}:${style}`;
    if (!materials.has(key)) materials.set(key, style.startsWith('parcel-')
      ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: style === 'parcel-fill' ? .08 : style === 'parcel-hover' ? .65 : .88,
        depthWrite: false, depthTest: style === 'parcel-boundary' })
      : new THREE.MeshLambertMaterial({ color, flatShading: true,
        ...(UNFOGGED_STYLES.includes(style) ? { fog: false } : {}),
        ...(style === 'glass' ? { transparent: true, opacity: 0.58, depthWrite: false } : {}),
        ...(style === 'cloud' ? { transparent: true, opacity: 0.74, depthWrite: false } : {}),
        ...(style === 'haze' ? { transparent: true, opacity: 0.19, depthWrite: false } : {}),
        ...(style === 'glow' ? { emissive: color, emissiveIntensity: 0.28 } : {}),
        ...(style === 'star' ? { emissive: color, emissiveIntensity: 0.92 } : {}),
        ...(style === 'sun' ? { emissive: color, emissiveIntensity: 0.8 } : {}) }));
    return materials.get(key);
  }
  return { geometry, material, dispose() { geometry.dispose(); for (const item of materials.values()) item.dispose(); materials.clear(); } };
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
