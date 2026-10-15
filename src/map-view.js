// The browser's view of the global map: the stored world's observation plus the neighbouring worlds the
// server read for the same window (`world.map`), re-expressed in global coordinates for the renderer, the
// pathfinder and the minimap. Pure and DOM-free, so the same translation is tested in node.
//
// Nothing here is authority. A pick or a route is turned back into a stored (world_id, x, y) before it is
// sent anywhere, and the server judges every step.
import { MAP_ID, fromGlobal, onMap, toGlobal } from './global-map.js';

/** True when this observation is of a world on the global map and the server returned the map window. */
export const mapActive = (world) => Boolean(world?.map && onMap(world?.world?.id));

/** One resident, object or portal moved into global coordinates; `world_id` becomes the map's so a step across a seam is not a world change. */
export function toMapItem(item, fallbackWorldId) {
  const worldId = item?.world_id || fallbackWorldId;
  const place = toGlobal(worldId, item?.x, item?.y);
  if (!place) return item;
  return { ...item, x: place.gx, y: place.gy, local_x: item.x, local_y: item.y, home_world_id: worldId, world_id: MAP_ID };
}

/** A stored position of this agent in the global frame (or the position unchanged off the map). */
export const mapPoint = (point, worldId) => {
  const place = toGlobal(point?.world_id || worldId, point?.x, point?.y);
  return place ? { x: place.gx, y: place.gy } : point;
};

/**
 * Everything the renderer needs for one frame in global coordinates. `world` is the observation as the
 * server sent it, `agent` the followed resident, `definition` the stitched map definition.
 */
export function mapSnapshot(world, agent, definition) {
  const stored = world.world.id, map = world.map;
  const lift = (item) => toMapItem(item, stored);
  const participants = [...(world.participants || []), ...(map.participants || [])].map(lift);
  const objects = [...(world.objects || []).map((item) => ({ ...item, world_id: stored })), ...(map.objects || [])].map(lift);
  const blocks = (world.blocks || []).map(lift);
  const self = agent ? lift(agent) : null;
  return {
    snapshot: { ...world, participants, agents: participants, objects, blocks, portals: definition.portals, terrain: undefined, camera: { x: 0, y: 0 }, frontier: undefined,
      world: { ...world.world, id: MAP_ID, kind: 'outdoors' } },
    self, definition, position: self ? { x: self.x, y: self.y, z: self.z || 0 } : null,
  };
}

/** A global tile back to the stored world it belongs to, for every API call that names a tile. */
export const localTile = (gx, gy) => fromGlobal(gx, gy);

/**
 * A tracker point in its stored region's coordinates, for diagnostics and persistence comparisons.
 * Rendering keeps the continuous global frame. A display point can lie between confirmed tiles, so
 * resolve its containing tile first and retain the fractional offset instead of rounding its motion.
 * The tracker owns its frame: changing the currently viewed world must not re-project older records.
 */
export function storedPresencePoint(point, frame) {
  if (!point || frame !== MAP_ID || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return point ? { ...point } : point;
  const tileX = Math.floor(point.x), tileY = Math.floor(point.y);
  const place = fromGlobal(tileX, tileY);
  if (!place) return { ...point };
  return { ...point, x: place.x + point.x - tileX, y: place.y + point.y - tileY, world_id: place.world_id };
}
