// Authored frontier blocks, batched apart from the terrain so placing or moving one block never
// rebuilds the diorama.
//
// A block column is solid unless it is a sealed thin surface (`blockOccupiesTile` in
// src/footprints.js). The thin surface is drawn as a floor decal at *every* layer, not only at layer
// zero, because that is how the server's own column collision reads it: `blockLayers` in
// src/elevation.js ignores a `path` block at any layer. The single-block build route refuses a path
// above layer zero ("paths belong on the ground"), so this only closes the drawn side of a legacy or
// imported row that the movement model would already treat as open.
import { blockOccupiesTile } from '../footprints.js';

export function blocksScene({ resources, definition, plan, colors, cubeBatch, withParcel }) {
  const batch = cubeBatch(resources);
  for (const item of plan.blocks) {
    const material = item.material || item.type || item.kind, thin = !blockOccupiesTile(material);
    batch.add(item.x + .5, thin ? item.z + .045 : item.z + .5, item.y + .5, .99, thin ? .09 : .99, .99,
      colors[material] || colors.stone, withParcel({ x: item.x, y: item.y, z: item.z, type: 'block', block: item }), material === 'glass' ? 'glass' : 'solid');
  }
  const result = batch.finish(); result.group.name = 'voxel-blocks';
  return result;
}
