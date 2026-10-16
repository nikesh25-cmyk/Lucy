import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// NemoWorld's side of the world manifest: which places it is allowed to dress, and its own checks on a
// manifest before the Veloren server is ever asked to apply one.
//
// The two halves have different jobs, and the split is deliberate:
//   * THIS module knows NemoWorld: which of *its* places may be dressed, and the budgets it will not
//     exceed. It is the authority on "is this something NemoWorld asked for?".
//   * `nemo-world-core` (Rust) knows Veloren: which block kinds and sprites exist and are safe, what the
//     terrain allows, how a manifest becomes blocks and sprites. It is the authority on "can the game do
//     this?".
// Neither copies the other's vocabulary. `tests/veloren-world.test.js` runs the Rust checker against the
// same file, so a manifest NemoWorld accepts must also be one the game accepts.

const here = dirname(fileURLToPath(import.meta.url));
export const PLACES_PATH = join(here, '..', '..', 'content', 'veloren-world-places.json');

export const FORMAT = 'veloren-world-v1';
/** The same ceilings the Rust side enforces; NemoWorld refuses anything above them before it asks. */
export const MANIFEST_LIMITS = Object.freeze({
  max_area_radius: 150,
  max_groups: 300,
  max_ops_per_group: 600,
  max_extent: 48,
  min_dz: -12,
  max_dz: 24,
  max_fill_volume: 4096,
  max_blocks_per_group: 6_000,
  max_blocks_total: 60_000,
  max_foundation_depth: 12,
  max_foundation_columns: 1_200,
  max_sprite_text: 64,
});

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^[0-9a-f]{6}$/;

/** The places NemoWorld may dress: a Veloren site name and the plots of it it knows by name. */
export function loadPlaces(path = PLACES_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format !== 'nemo-world-places-v1') throw new Error(`Unsupported world places format: ${data.format}`);
  if (!Array.isArray(data.sites) || !data.sites.length) throw new Error('The world places file lists no sites.');
  const sites = new Map();
  for (const site of data.sites) {
    if (typeof site.name !== 'string' || !site.name.trim()) throw new Error('A site needs a name.');
    if (sites.has(site.name)) throw new Error(`Site listed twice: ${site.name}`);
    if (!Array.isArray(site.plots) || !site.plots.length) throw new Error(`Site ${site.name} lists no plots.`);
    for (const plot of site.plots) if (typeof plot !== 'string' || !plot.trim()) throw new Error(`Site ${site.name} has a bad plot name.`);
    sites.set(site.name, Object.freeze([...site.plots]));
  }
  return Object.freeze({ format: data.format, note: String(data.note || ''), sites });
}
export const PLACES = loadPlaces();

const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * Check one manifest against NemoWorld's own rules. Returns a list of problems; an empty list means
 * NemoWorld will ask the game to apply it (which is where the game's own rules decide).
 */
export function validateManifest(manifest, places = PLACES, limits = MANIFEST_LIMITS) {
  const errors = [];
  const bad = (why) => errors.push(why);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['a manifest must be an object'];
  if (manifest.format !== FORMAT) bad(`format must be ${FORMAT}`);
  if (!isText(manifest.site, 60)) bad('site must be a name');
  else if (!places.sites.has(manifest.site)) bad(`site ${manifest.site} is not one NemoWorld may dress`);
  if (!manifest.area || typeof manifest.area !== 'object') bad('area is required');
  else if (typeof manifest.area.radius !== 'number' || !(manifest.area.radius > 0 && manifest.area.radius <= limits.max_area_radius))
    bad(`area.radius must be greater than 0 and at most ${limits.max_area_radius}`);
  if (!Array.isArray(manifest.groups) || !manifest.groups.length) bad('groups must be a non-empty list');
  else if (manifest.groups.length > limits.max_groups) bad(`at most ${limits.max_groups} groups`);

  const plots = places.sites.get(manifest.site) || [];
  const seen = new Set();
  let total = 0;
  for (const [index, group] of (manifest.groups || []).entries()) {
    const where = `group ${group?.id ?? index}`;
    if (!group || typeof group !== 'object') { bad(`${where}: must be an object`); continue; }
    if (typeof group.id !== 'string' || !SLUG.test(group.id)) bad(`${where}: id must be a short lower-case slug`);
    else if (seen.has(group.id)) bad(`${where}: id is used twice`);
    else seen.add(group.id);
    const anchor = group.anchor || {};
    if (typeof anchor.plot !== 'string' || !anchor.plot) bad(`${where}: needs an anchored plot`);
    else if (!plots.includes(anchor.plot)) bad(`${where}: plot ${anchor.plot} is not one of ${manifest.site}'s known plots`);
    if (anchor.nth !== undefined && !inRange(anchor.nth, 0, 7)) bad(`${where}: anchor.nth must be 0 to 7`);
    for (const axis of ['dx', 'dy']) {
      const value = anchor[axis] ?? 0;
      if (!inRange(value, -limits.max_extent, limits.max_extent)) bad(`${where}: anchor.${axis} must be within ±${limits.max_extent}`);
    }
    if (group.note !== undefined && typeof group.note !== 'string') bad(`${where}: note must be text`);
    if (!Array.isArray(group.ops) || !group.ops.length) { bad(`${where}: needs ops`); continue; }
    if (group.ops.length > limits.max_ops_per_group) bad(`${where}: at most ${limits.max_ops_per_group} ops`);
    let blocks = 0;
    let columns = 0;
    for (const op of group.ops) {
      if (!op || typeof op !== 'object') { bad(`${where}: an op must be an object`); continue; }
      const kind = op.op;
      if (!['fill', 'clear', 'sprite', 'foundation'].includes(kind)) { bad(`${where}: op ${JSON.stringify(kind)} is not one NemoWorld writes`); continue; }
      const point = (value, axis) => {
        if (!Array.isArray(value) || value.length !== 3) { bad(`${where}: ${op.op}.${axis} must be three numbers`); return false; }
        const [x, y, z] = value;
        if (!inRange(x, -limits.max_extent, limits.max_extent) || !inRange(y, -limits.max_extent, limits.max_extent)) { bad(`${where}: ${op.op}.${axis} is outside ±${limits.max_extent}`); return false; }
        if (!inRange(z, limits.min_dz, limits.max_dz)) { bad(`${where}: ${op.op}.${axis} height must be ${limits.min_dz} to ${limits.max_dz}`); return false; }
        return true;
      };
      if (kind === 'fill' || kind === 'clear') {
        if (!point(op.from, 'from') || !point(op.to, 'to')) continue;
        const [x0, y0, z0] = op.from;
        const [x1, y1, z1] = op.to;
        if (x1 < x0 || y1 < y0 || z1 < z0) { bad(`${where}: ${op.op} corners are the wrong way round`); continue; }
        const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
        if (kind === 'fill') {
          blocks += volume;
          if (volume > limits.max_fill_volume) bad(`${where}: a fill of ${volume} blocks exceeds ${limits.max_fill_volume}`);
          if (typeof op.kind !== 'string' || !op.kind) bad(`${where}: a fill needs a block kind`);
        }
      } else if (kind === 'sprite') {
        if (!point(op.at, 'at')) continue;
        if (!isText(op.sprite, limits.max_sprite_text)) bad(`${where}: a sprite needs a short name`);
      } else {
        if (!Array.isArray(op.from) || !Array.isArray(op.to) || op.from.length !== 2 || op.to.length !== 2) { bad(`${where}: foundation corners are two numbers each`); continue; }
        for (const [corner, label] of [[op.from, 'from'], [op.to, 'to']]) {
          if (!inRange(corner[0], -limits.max_extent, limits.max_extent) || !inRange(corner[1], -limits.max_extent, limits.max_extent)) bad(`${where}: foundation.${label} is outside ±${limits.max_extent}`);
        }
        const width = Math.abs(op.to[0] - op.from[0]) + 1;
        const height = Math.abs(op.to[1] - op.from[1]) + 1;
        columns += width * height;
        if (columns > limits.max_foundation_columns) bad(`${where}: more than ${limits.max_foundation_columns} foundation columns`);
        if (!inRange(op.depth, 1, limits.max_foundation_depth)) bad(`${where}: foundation.depth must be 1 to ${limits.max_foundation_depth}`);
        if (typeof op.kind !== 'string' || !op.kind) bad(`${where}: a foundation needs a block kind`);
      }
      if (op.rgb !== undefined && !(Array.isArray(op.rgb) && op.rgb.length === 3 && op.rgb.every((part) => inRange(part, 0, 255)))) bad(`${where}: rgb must be three bytes`);
    }
    if (blocks > limits.max_blocks_per_group) bad(`${where}: ${blocks} blocks exceeds ${limits.max_blocks_per_group} in one group`);
    total += blocks;
  }
  if (total > limits.max_blocks_total) bad(`${total} blocks exceeds ${limits.max_blocks_total} in one manifest`);
  return errors;
}

/** Convenience: read and check a file, the way a caller (or a test) wants it. */
export function checkManifestFile(path, places = PLACES) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return { manifest, errors: validateManifest(manifest, places) };
}
