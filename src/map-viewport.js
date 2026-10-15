// A bounded read of one *viewport* of the global map, across its seams.
//
// The map owner's `world?map=core` window is drawn around the resident being followed. This module
// also supplies that projection's neighbouring regions: given the global
// rectangle a client is actually drawing, what is in every region it overlaps? It returns the saved
// state of each region (residents and civic residents with their presence, and the placements stored
// in `world_objects`) plus the region's authored fixtures, each in the region's own coordinates
// beside its own `world_id`, and it states the work it did.
//
// Two properties are the point of the module, and both are asserted by tests:
//   - completeness of the cover   a viewport that crosses a seam reports every region it includes;
//   - a stated bound              at most VIEWPORT_BOUNDS.max_regions regions, at most
//                                 VIEWPORT_BOUNDS.max_statements SQL statements, and every query
//                                 LIMITed so no region can return more rows than its share.
//
// It adds no authority of its own. Every rectangle of MAP_LAYOUT is a public shared world, so the
// read serves the same information `/world` already serves anonymously, and a private garden is
// never a rectangle of the map. Nothing here is a storable world: it is a view, and a pick made from
// it has to be turned back into a stored (world_id, x, y) before anything is sent.

import { MAP_COLUMNS, MAP_LAYOUT, MAP_ROWS, mapEnabled, mapRect, onMap, toGlobal, worldRects } from './global-map.js';
import { getWorldDefinition } from '../world.js';
import { sceneryBlocks } from './footprints.js';

/** The largest viewport a read will answer: the widest window any shipped client draws. */
export const VIEWPORT_COLUMNS = 96;
export const VIEWPORT_ROWS = 64;

/**
 * The stated bound on a viewport read. `max_regions` is the size of the layout, so no placed world
 * can be read twice and none outside the layout can be read at all. `max_statements` is the exact
 * worst case of this module's own query count, not an estimate: one anchored access check, one
 * optional viewer lookup, and four windowed reads per region (residents, saved objects, regional
 * guides, country ambassadors). `max_rows_returned` is the ceiling after merging.
 */
export const VIEWPORT_BOUNDS = Object.freeze({
  max_window_columns: VIEWPORT_COLUMNS,
  max_window_rows: VIEWPORT_ROWS,
  max_regions: MAP_LAYOUT.length,
  max_statements: 4 * MAP_LAYOUT.length + 2,
  max_rows_returned: 1024,
  max_participants: 200,
  max_objects_per_region: 256,
  max_npcs_per_region: 64,
  max_scenery_per_region: 256,
});

const isInt = Number.isInteger;
const whole = (value, smallest, fallback) => (isInt(value) && value >= smallest ? value : fallback);
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * The global window a read is of. `input` may name the window's top-left in global tiles (`gx`,
 * `gy`), as a stored camera in one world (`world_id`, `x`, `y`), or as a global tile to centre the
 * window on (`centre`); with none of the three, the window starts at the anchor world's arrival tile.
 * The size is clamped to the stated bound and the origin is clamped so the window lies on the map, so
 * a caller cannot ask for unbounded work.
 */
export function viewportWindow(input = {}) {
  const anchor = String(input.world_id || 'commons');
  const rect = mapRect(anchor);
  if (!rect) return null;
  const arrival = toGlobal(anchor, getWorldDefinition(anchor).start.x, getWorldDefinition(anchor).start.y);
  const placed = isInt(Number(input.x)) && isInt(Number(input.y))
    ? toGlobal(anchor, clamp(Number(input.x), 0, rect.width - 1), clamp(Number(input.y), 0, rect.height - 1)) : null;
  const asked = isInt(Number(input.gx)) && isInt(Number(input.gy));
  const columns = Math.min(VIEWPORT_COLUMNS, whole(Number(input.columns), 1, VIEWPORT_COLUMNS));
  const rows = Math.min(VIEWPORT_ROWS, whole(Number(input.rows), 1, VIEWPORT_ROWS));
  // A window centred on a global tile is the one a follower wants: it crosses whatever seam the tile is
  // next to, whichever stored world the tile belongs to.
  const middle = asked || placed ? null : input.centre && isInt(input.centre.gx) && isInt(input.centre.gy) ? input.centre : null;
  const origin = asked ? { gx: Number(input.gx), gy: Number(input.gy) }
    : placed || (middle ? { gx: middle.gx - Math.floor(columns / 2), gy: middle.gy - Math.floor(rows / 2) } : arrival);
  const onMap = { gx: clamp(origin.gx, 0, MAP_COLUMNS - columns), gy: clamp(origin.gy, 0, MAP_ROWS - rows) };
  return {
    anchor, origin: onMap, columns, rows,
    source: asked ? 'global' : input.x !== undefined && placed ? 'camera' : middle ? 'centre' : 'arrival',
    clamped: origin.gx !== onMap.gx || origin.gy !== onMap.gy || Number(input.columns) > VIEWPORT_COLUMNS || Number(input.rows) > VIEWPORT_ROWS,
  };
}

/**
 * The regions a window covers, each with the local window to read them through. One pass over the
 * layout, so the cover is complete by construction and no region can appear twice. Sorted by world
 * id, so one window always produces one plan and a client can diff two payloads.
 */
export function viewportPlan(window) {
  if (!window) return null;
  const { gx, gy } = window.origin, width = window.columns, height = window.rows;
  const regions = worldRects(gx, gy, width, height).map((place) => ({
    world_id: place.world_id,
    window: { gx: place.rect.x + place.x, gy: place.rect.y + place.y, columns: place.right - place.x, rows: place.bottom - place.y },
    local: { x: place.x, y: place.y, right: place.right, bottom: place.bottom },
    tiles: (place.right - place.x) * (place.bottom - place.y),
  })).sort((left, right) => (left.world_id < right.world_id ? -1 : left.world_id > right.world_id ? 1 : 0));
  return { window: { gx, gy, columns: width, rows: height }, regions, tiles: width * height, clamped: Boolean(window.clamped) };
}

/**
 * One resident row as the public view of a world already serves it. Deliberately narrower than the
 * shipped anonymous projection: no operator identity, no capability or limitation copy, no accepted
 * contributions and no credential state leave this read.
 */
const publicActor = (row, now) => ({
  id: row.id, name: row.name, kind: row.kind, color: row.color, symbol: row.symbol, status: row.status, verified: row.verified,
  x: row.x, y: row.y, z: row.z, grounded: row.grounded, yaw: row.yaw, pitch: row.pitch, world_id: row.world_id, posture: row.posture,
  last_seen: row.last_seen, emote: row.emote, emote_until: row.emote_until,
  presence: row.status !== 'active' ? row.status
    : row.has_session && now - row.last_seen < 30000 ? 'connected'
      : now - row.last_seen < 30000 ? 'recent_visit' : 'offline',
});

const ACTOR_FIELDS = 'a.id,a.name,a.kind,a.color,a.symbol,a.status,a.verified,a.x,a.y,a.z,a.grounded,a.yaw,a.pitch,a.world_id,a.posture,a.last_seen,a.emote,a.emote_until';

/**
 * The read itself. `world_id` names the anchor (it decides the default window, and it is the world
 * whose readability is checked); `x`, `y`, `gx`, `gy`, `columns`, `rows` describe the window;
 * `agent_id` names the viewer, whose own resident is resolved when a session asks for it.
 */
export const viewportMethods = {
  mapViewport(actor, input = {}) {
    const anchorId = String(input.world_id || 'commons');
    if (!mapEnabled() || !onMap(anchorId)) fail(404, 'That world is not part of the shared map.');
    // One access check, on the anchor only. Every rectangle of the layout is a public shared world
    // (`tests/map-viewport.test.js` asserts that against the seeded registry), so the neighbouring
    // regions add no readability of their own, and a private garden is never one of them.
    this.space(actor, anchorId);
    const viewer = input.agent_id && actor ? this.ownedAgent(actor, input.agent_id)
      : actor?.kind === 'runtime' ? this.get('SELECT id,world_id,x,y FROM agents WHERE id=?', actor.agent.id) : null;
    const window = viewportWindow({
      ...input,
      // With no origin of its own, the window is centred on the viewer wherever the viewer is — across
      // any seam. This is the read a follower wants, and it is the reason the route is not anchored on
      // the anchor world's own camera.
      ...(viewer && input.gx === undefined && input.x === undefined && input.centre === undefined ? { centre: toGlobal(viewer.world_id, viewer.x, viewer.y) || undefined } : {}),
    });
    const plan = viewportPlan(window);
    // Only the server's mapWindow uses this boolean to avoid reading its already-loaded anchor.
    // HTTP query values are strings, so the public route keeps its complete viewport contract.
    const plannedRegions = input._exclude_anchor === true ? plan.regions.filter((region) => region.world_id !== anchorId) : plan.regions;
    const now = this.clock();
    const participants = [], objects = [], scenery = [], regions = [], truncated = [];
    let rows = 0;
    const room = (region, count) => {
      if (rows + count > VIEWPORT_BOUNDS.max_rows_returned) { if (!truncated.includes(region)) truncated.push(region); return false; }
      rows += count; return true;
    };
    // A followed resident must survive a crowded region's LIMIT and the aggregate
    // response budget, including while the subscription still names the old region.
    const readOrder = [...plannedRegions].sort((a, b) => Number(b.world_id === viewer?.world_id) - Number(a.world_id === viewer?.world_id));
    for (const region of readOrder) {
      const id = region.world_id, { x, y, right, bottom } = region.local;
      const definition = getWorldDefinition(id);
      const [left, top] = [Math.max(0, x), Math.max(0, y)];
      const [endX, endY] = [Math.min(definition.columns, right) - 1, Math.min(definition.rows, bottom) - 1];
      const residents = this.all(`SELECT ${ACTOR_FIELDS},
        EXISTS(SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.kind='runtime' AND t.revoked=0 AND t.expires_at>? AND t.used_calls<t.max_calls) AS has_session
        FROM agents a JOIN accounts o ON o.id=a.operator_id
        WHERE a.world_id=? AND a.x BETWEEN ? AND ? AND a.y BETWEEN ? AND ? AND a.status!='deleted' AND o.status='active'
        ORDER BY CASE WHEN a.id=? THEN 0 ELSE 1 END,a.last_seen DESC,a.id LIMIT ?`, now, id, left, endX, top, endY, viewer?.id || '', VIEWPORT_BOUNDS.max_participants);
      if (residents.length && room(id, residents.length)) for (const row of residents) participants.push(publicActor(row, now));
      const saved = this.all('SELECT id,type,x,y FROM world_objects WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? ORDER BY y,x LIMIT ?', id, left, endX, top, endY, VIEWPORT_BOUNDS.max_objects_per_region);
      if (saved.length && room(id, saved.length)) for (const row of saved) objects.push({ ...row, kind: row.type, world_id: id });
      const guides = this.all("SELECT id,name,sprite,direction,x,y,status FROM npc_mayors WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? ORDER BY name,id LIMIT ?", id, left, endX, top, endY, VIEWPORT_BOUNDS.max_npcs_per_region);
      if (guides.length && room(id, guides.length)) for (const row of guides) participants.push({ id: row.id, name: row.name, kind: 'npc', mode: 'rules', sprite: row.sprite, direction: row.direction, color: '#397f79', symbol: '✦', title: `Regional guide of ${definition.name}`, x: row.x, y: row.y, world_id: id, status: row.status, presence: row.status === 'active' ? 'resident' : 'paused' });
      const ambassadors = this.all("SELECT id,name,iso3,sprite,direction,x,y FROM npc_ambassadors WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND status='active' ORDER BY name,iso3 LIMIT ?", id, left, endX, top, endY, VIEWPORT_BOUNDS.max_npcs_per_region);
      if (ambassadors.length && room(id, ambassadors.length)) for (const row of ambassadors) participants.push({ id: row.id, name: row.name, kind: 'npc', mode: 'rules', iso3: row.iso3, sprite: row.sprite, direction: row.direction, color: '#397f79', symbol: '✦', title: `Country ambassador · ${row.name}`, x: row.x, y: row.y, world_id: id, status: 'active', presence: 'resident' });
      const authored = (definition.objects || []).filter((item) => item.x >= left && item.x <= endX && item.y >= top && item.y <= endY);
      for (const item of authored.slice(0, VIEWPORT_BOUNDS.max_scenery_per_region)) {
        if (!room(id, 1)) break;
        scenery.push({ x: item.x, y: item.y, type: item.type || item.kind, world_id: id, blocks: sceneryBlocks(item.type || item.kind) });
      }
      regions.push({
        world_id: id, name: definition.name, kind: definition.kind, window: region.window, tiles: region.tiles,
        counts: { participants: residents.length + guides.length + ambassadors.length, objects: saved.length, scenery: authored.length, scenery_returned: Math.min(authored.length, VIEWPORT_BOUNDS.max_scenery_per_region) },
      });
    }
    const seen = new Set();
    const unique = participants.filter((item) => { const key = `${item.world_id}|${item.id}`; return seen.has(key) ? false : (seen.add(key), true); })
      .sort((a, b) => Number(b.id === viewer?.id) - Number(a.id === viewer?.id)).slice(0, VIEWPORT_BOUNDS.max_participants);
    regions.sort((a, b) => a.world_id.localeCompare(b.world_id));
    const bounded = {
      map: 'core', world_id: anchorId, origin: mapRect(anchorId) ? { gx: mapRect(anchorId).x, gy: mapRect(anchorId).y } : null,
      window: plan.window, clamped: plan.clamped, source: window.source,
      regions, participants: unique, objects, scenery,
      presence: Object.fromEntries(unique.map((item) => [item.id, item.presence])),
      viewer_agent_id: viewer?.id || null,
      bounds: VIEWPORT_BOUNDS,
      work: { regions: plannedRegions.length, statements: 4 * plannedRegions.length + (viewer ? 2 : 1), rows_returned: rows, tiles: plan.tiles, truncated },
    };
    if (unique.length >= VIEWPORT_BOUNDS.max_participants && !bounded.work.truncated.includes('participants')) bounded.work.truncated.push('participants');
    return bounded;
  },
};

// The one failure shape every route in this world uses, declared here so the module stands alone.
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
