// Grid x/y stay compatible with movement APIs. Three.js uses its y axis for height.
import { frontierPlotId } from '../world.js';
export const VOXEL_LIMITS = Object.freeze({ radius: 18, cells: 1369, objects: 260, blocks: 2048, participants: 220, height: 8 });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function normalizeOrbit(value = {}) {
  const yaw = finite(value.yaw, Math.PI / 4);
  return { yaw: yaw >= -Math.PI && yaw <= Math.PI ? yaw : ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    pitch: clamp(finite(value.pitch, 0.62), 0.3, 1.22), distance: clamp(finite(value.distance, 17), 6, 32) };
}

const cameraMode = value => value === 'first-person' ? 'first-person' : 'orbit';
const normalizeCameraInput = (value, mode) => mode === 'first-person'
  ? { ...normalizeOrbit(value), pitch: clamp(finite(value.pitch, 0), -1.4, 1.4) }
  : normalizeOrbit(value);

/** One owner for orbit input. Only a real drag emits the already-applied absolute look state. */
export function createOrbitInput({ initial = {}, mode: initialMode = 'orbit', onLook } = {}) {
  let mode = cameraMode(initialMode), orbit = normalizeCameraInput(initial, mode);
  const set = value => { orbit = normalizeCameraInput({ ...orbit, ...value }, mode); return { ...orbit }; };
  return {
    get orbit() { return { ...orbit }; },
    get mode() { return mode; },
    setMode(value) { mode = cameraMode(value); orbit = normalizeCameraInput(orbit, mode); return mode; },
    set,
    rotate(yaw = 0, pitch = 0) { return set({ yaw: orbit.yaw + (Number.isFinite(yaw) ? yaw : 0), pitch: orbit.pitch + (Number.isFinite(pitch) ? pitch : 0) }); },
    zoom(distance = 0) { return set({ distance: orbit.distance + (Number.isFinite(distance) ? distance : 0) }); },
    drag(x = 0, y = 0) {
      const previous = orbit;
      const next = set({ yaw: orbit.yaw - (Number.isFinite(x) ? x : 0) * .008, pitch: orbit.pitch + (Number.isFinite(y) ? y : 0) * .006 });
      if (previous.yaw !== next.yaw || previous.pitch !== next.pitch) onLook?.({ ...next });
      return next;
    }
  };
}

/** True first-person eye and view direction; positive pitch looks down, as in orbit mode. */
export function firstPersonCamera(position, value = {}) {
  const facing = normalizeCameraInput(value, 'first-person');
  const eye = { x: finite(position?.x, 0) + .5, y: clamp(finite(position?.z, 0), 0, VOXEL_LIMITS.height) + 1.35, z: finite(position?.y, 0) + .5 };
  const horizontal = Math.cos(facing.pitch);
  return { eye, target: { x: eye.x - Math.sin(facing.yaw) * horizontal, y: eye.y - Math.sin(facing.pitch),
    z: eye.z - Math.cos(facing.yaw) * horizontal }, orbit: facing };
}

export function orbitCamera(position, value = {}) {
  const orbit = normalizeOrbit(value), x = finite(position?.x, 0) + 0.5, z = finite(position?.y, 0) + 0.5;
  const height = clamp(finite(position?.z, 0), 0, VOXEL_LIMITS.height) + 0.75;
  const horizontal = Math.cos(orbit.pitch) * orbit.distance;
  return { target: { x, y: height, z }, eye: { x: x + Math.sin(orbit.yaw) * horizontal,
    y: height + Math.sin(orbit.pitch) * orbit.distance, z: z + Math.cos(orbit.yaw) * horizontal }, orbit };
}

export function voxelWindow(definition, position) {
  const columns = clamp(Math.floor(finite(definition?.columns ?? definition?.width, 20)), 1, 4096);
  const rows = clamp(Math.floor(finite(definition?.rows ?? definition?.height, 14)), 1, 4096);
  const x = clamp(Math.floor(finite(position?.x, definition?.start?.x ?? 0)), 0, columns - 1);
  const y = clamp(Math.floor(finite(position?.y, definition?.start?.y ?? 0)), 0, rows - 1);
  return { x: Math.max(0, x - VOXEL_LIMITS.radius), y: Math.max(0, y - VOXEL_LIMITS.radius),
    right: Math.min(columns, x + VOXEL_LIMITS.radius + 1), bottom: Math.min(rows, y + VOXEL_LIMITS.radius + 1), columns, rows };
}

export const inVoxelWindow = (item, window) => Number.isInteger(item?.x) && Number.isInteger(item?.y) &&
  item.x >= window.x && item.x < window.right && item.y >= window.y && item.y < window.bottom;

/** Address a physical 6 × 6 plot without inferring ownership, availability, or permissions. */
export function voxelParcelAddress(worldId, position) {
  const id = frontierPlotId(worldId, position?.x, position?.y);
  if (!id) return null;
  const plotX = Math.floor(position.x / 6), plotY = Math.floor(position.y / 6);
  return { id, world_id: worldId, plot_x: plotX, plot_y: plotY,
    x: plotX * 6, y: plotY * 6, width: 6, height: 6, area_m2: 36 };
}

export function voxelParcels(definition, snapshot = {}, window = voxelWindow(definition, definition?.start)) {
  const parcels = [], seen = new Set();
  if (definition?.kind !== 'frontier' || !Array.isArray(snapshot.frontier?.parcels)) return parcels;
  for (const item of snapshot.frontier.parcels) {
    if (!Number.isInteger(item?.plot_x) || !Number.isInteger(item?.plot_y) || item.plot_x < 0 || item.plot_x > 7 || item.plot_y < 0 || item.plot_y > 7) continue;
    const position = { x: item?.plot_x * 6, y: item?.plot_y * 6 }, address = voxelParcelAddress(definition.id, position);
    if (!address || item.id !== address.id || item.world_id !== address.world_id || seen.has(address.id)) continue;
    seen.add(address.id);
    if (address.x >= window.right || address.y >= window.bottom || address.x + 6 <= window.x || address.y + 6 <= window.y) continue;
    parcels.push({ ...item, ...address });
    if (parcels.length === 64) break;
  }
  return parcels;
}

export function voxelParcelSelection(parcels, selection) {
  if (!selection) return null;
  const id = typeof selection === 'string' ? selection : selection.id;
  return parcels.find(parcel => id ? parcel.id === id : Number.isInteger(selection.plot_x) && Number.isInteger(selection.plot_y) &&
    parcel.plot_x === selection.plot_x && parcel.plot_y === selection.plot_y && (!selection.world_id || selection.world_id === parcel.world_id)) || null;
}

// A tile's type as voxelPlan resolves it: an observed tile wins over the retained map.
const resolvedCellType = (definition, snapshot, camera, x, y) => {
  const observed = snapshot?.terrain?.[y - camera.y]?.[x - camera.x];
  return typeof observed === 'string' ? observed : definition?.terrain?.[y]?.[x];
};

/**
 * The same resolution for a scene module: the snapshot's own camera origin is the observation
 * origin, so a water pass or a ground-cover pass reads exactly the tiles voxelPlan drew.
 */
export const cellTypeAt = (definition, snapshot, x, y) => resolvedCellType(definition, snapshot, snapshot?.camera || { x: 0, y: 0 }, x, y);

const OCCLUSION_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
// A water base sits at -0.82 instead of -0.5 and a bridge carries a deck, so neither is ever culled.
const BASE_ALWAYS_VISIBLE = new Set(['water', 'bridge']);

/**
 * Whole-node cull for the terrain base cube, the analogue of Luanti's `if (!faces) return;`.
 * A land cell whose four axis neighbours are all land cells inside the window has no exposed side:
 * every neighbour's base cube covers the shared face and the surface slab above is always drawn.
 * `water` never occludes because its base sits 0.32 lower, so a land/water seam keeps its side face.
 */
export function cellOccludedBelow(definition, snapshot, plan, x, y) {
  if (!plan?.window || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const camera = snapshot?.camera || { x: 0, y: 0 }, type = resolvedCellType(definition, snapshot, camera, x, y);
  if (typeof type !== 'string' || BASE_ALWAYS_VISIBLE.has(type)) return false;
  for (const [dx, dy] of OCCLUSION_NEIGHBOURS) {
    const nearX = x + dx, nearY = y + dy, near = inVoxelWindow({ x: nearX, y: nearY }, plan.window) ? resolvedCellType(definition, snapshot, camera, nearX, nearY) : undefined;
    if (typeof near !== 'string' || near === 'water') return false;
  }
  return true;
}

export function voxelPlan(definition, snapshot = {}, position = definition?.start) {
  const window = voxelWindow(definition, position), cells = [];
  const parcels = voxelParcels(definition, snapshot, window), byParcel = new Map(parcels.map(parcel => [parcel.id, parcel]));
  const sourceCamera = snapshot.camera || { x: 0, y: 0 };
  for (let y = window.y; y < window.bottom; y++) for (let x = window.x; x < window.right; x++) {
    const type = resolvedCellType(definition, snapshot, sourceCamera, x, y);
    if (typeof type === 'string') {
      const address = voxelParcelAddress(definition?.id, { x, y }), parcel = address ? byParcel.get(address.id) : null;
      cells.push({ x, y, type, ...(parcel ? { parcel } : {}) });
    }
  }
  const uniqueObjects = new Map();
  // Decorative definitions are local. Saved objects take precedence at the same coordinate.
  for (const item of [...(definition?.objects || []), ...(snapshot.objects || [])]) {
    if (inVoxelWindow(item, window)) uniqueObjects.set(`${item.x},${item.y},${item.type || item.kind}`, item);
  }
  const objects = [...uniqueObjects.values()].slice(0, VOXEL_LIMITS.objects);
  const portals = (snapshot.portals || definition?.portals || []).filter(item => inVoxelWindow(item, window)).slice(0, 80);
  const gates = (snapshot.frontier?.neighbors || []).filter(item => item.exists === false && inVoxelWindow(item, window)).slice(0, 4);
  const blocks = [], seenBlocks = new Set();
  for (const item of snapshot.blocks || []) {
    if (!inVoxelWindow(item, window) || !Number.isInteger(item.z) || item.z < 0 || item.z >= VOXEL_LIMITS.height) continue;
    const key = `${item.x},${item.y},${item.z}`;
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key); blocks.push(item);
    if (blocks.length === VOXEL_LIMITS.blocks) break;
  }
  const participants = [], seenPeople = new Set();
  for (const item of snapshot.participants || snapshot.agents || []) {
    if (!inVoxelWindow(item, window) || ['deleted', 'revoked'].includes(item.status) || seenPeople.has(item.id)) continue;
    seenPeople.add(item.id); participants.push(item);
    if (participants.length === VOXEL_LIMITS.participants) break;
  }
  return { window, cells, objects, portals, gates, blocks, participants, parcels };
}

/** Convert an actual Raycaster intersection, preserving server coordinates and cube face. */
export function voxelPick(intersection) {
  const data = intersection?.object?.userData;
  const record = Number.isInteger(intersection?.instanceId) ? data?.picks?.[intersection.instanceId] : data?.pick;
  if (!record || !Number.isInteger(record.x) || !Number.isInteger(record.y)) return null;
  const normal = intersection.face?.normal;
  const face = normal ? { x: Math.round(normal.x) || 0, y: Math.round(normal.z) || 0, z: Math.round(normal.y) || 0 } : { x: 0, y: 0, z: 1 };
  const z = record.z ?? 0;
  return { ...record, z, face, adjacent: record.type === 'block' ? { x: record.x + face.x, y: record.y + face.y, z: z + face.z } : { x: record.x, y: record.y, z: 0 } };
}
