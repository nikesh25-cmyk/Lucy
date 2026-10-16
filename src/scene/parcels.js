// The stewardship overlay: the visible edges and states of the 6 x 6 plots in this window.
//
// The overlay draws no mass and holds no pick, so it can never be mistaken for an obstacle: every
// box is at most 0.08 m tall, below the floor-decal height in src/footprints.js, and the shared
// renderer test asserts that no unpicked box above 0.10 m stands anywhere in a tile. It is rebuilt
// only when the parcel list, the window, the selection or the hover changes.
export function parcelScene({ resources, plan, selection, hover, cubeBatch, parcelSelection }) {
  const batch = cubeBatch(resources), edges = new Map(), selected = parcelSelection(plan.parcels, selection), hovered = parcelSelection(plan.parcels, hover);
  const { window } = plan;
  const palette = { reserved: '#799e99', assigned: '#87bfa3', available: '#cbbb83', unopened: '#94a49b' };
  const priority = { reserved: 2, assigned: 3, available: 1, unopened: 0 };
  function footprint(parcel, width, color, style) {
    const x0 = Math.max(window.x, parcel.x), y0 = Math.max(window.y, parcel.y), x1 = Math.min(window.right, parcel.x + 6), y1 = Math.min(window.bottom, parcel.y + 6);
    const height = style === 'parcel-boundary' ? .025 : .08;
    if (parcel.x >= window.x) batch.add(parcel.x, height, (y0 + y1) / 2, width, .03, y1 - y0, color, null, style);
    if (parcel.x + 6 <= window.right) batch.add(parcel.x + 6, height, (y0 + y1) / 2, width, .03, y1 - y0, color, null, style);
    if (parcel.y >= window.y) batch.add((x0 + x1) / 2, height, parcel.y, x1 - x0, .03, width, color, null, style);
    if (parcel.y + 6 <= window.bottom) batch.add((x0 + x1) / 2, height, parcel.y + 6, x1 - x0, .03, width, color, null, style);
  }
  for (const parcel of plan.parcels) {
    const state = Object.hasOwn(palette, parcel.state) ? parcel.state : 'unopened', color = palette[state];
    for (const [axis, fixed, start, end] of [['v', parcel.x, parcel.y, parcel.y + 6], ['v', parcel.x + 6, parcel.y, parcel.y + 6], ['h', parcel.y, parcel.x, parcel.x + 6], ['h', parcel.y + 6, parcel.x, parcel.x + 6]]) {
      const low = axis === 'v' ? window.y : window.x, high = axis === 'v' ? window.bottom : window.right;
      const visibleFixed = axis === 'v' ? fixed >= window.x && fixed <= window.right : fixed >= window.y && fixed <= window.bottom;
      if (!visibleFixed) continue;
      const clippedStart = Math.max(start, low), clippedEnd = Math.min(end, high), key = `${axis}:${fixed}:${clippedStart}:${clippedEnd}`, old = edges.get(key);
      if (!old || priority[state] > old.priority) edges.set(key, { axis, fixed, start: clippedStart, end: clippedEnd, color, priority: priority[state] });
    }
  }
  for (const edge of edges.values()) batch.add(edge.axis === 'v' ? edge.fixed : (edge.start + edge.end) / 2, .025,
    edge.axis === 'v' ? (edge.start + edge.end) / 2 : edge.fixed, edge.axis === 'v' ? .025 : edge.end - edge.start, .025,
    edge.axis === 'v' ? edge.end - edge.start : .025, edge.color, null, 'parcel-boundary');
  // The protected crossroads have a separate visible lane edge within reserved plots.
  if (plan.parcels.length) for (const coordinate of [23, 26]) {
    if (coordinate >= window.x && coordinate <= window.right) batch.add(coordinate, .05, (window.y + window.bottom) / 2, .07, .035, window.bottom - window.y, '#a6cbc0', null, 'parcel-boundary');
    if (coordinate >= window.y && coordinate <= window.bottom) batch.add((window.x + window.right) / 2, .05, coordinate, window.right - window.x, .035, .07, '#a6cbc0', null, 'parcel-boundary');
  }
  if (hovered && hovered.id !== selected?.id) footprint(hovered, .065, hovered.state === 'reserved' ? '#aad3ce' : '#ddd0a4', 'parcel-hover');
  if (selected) {
    const color = selected.state === 'reserved' ? '#b2dbd4' : '#f2d891'; footprint(selected, .11, color, 'parcel-selected');
    const x0 = Math.max(window.x, selected.x), y0 = Math.max(window.y, selected.y), x1 = Math.min(window.right, selected.x + 6), y1 = Math.min(window.bottom, selected.y + 6);
    batch.add((x0 + x1) / 2, .01, (y0 + y1) / 2, x1 - x0, .008, y1 - y0, color, null, 'parcel-fill');
  }
  const result = batch.finish(); result.group.name = 'parcel-overlay'; result.group.userData = { selectedParcel: selected?.id || null, hoveredParcel: hovered?.id || null, parcels: plan.parcels.length };
  for (const mesh of result.group.children) { mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 8; }
  return result;
}
