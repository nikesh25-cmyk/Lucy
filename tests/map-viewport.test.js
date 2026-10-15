// The viewport cover across the global map's seams: pure planning, no database and no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldDefinition, sharedWorldIds } from '../world.js';
import { MAP_COLUMNS, MAP_LAYOUT, MAP_ROWS, seams, worldRects } from '../src/global-map.js';
import { VIEWPORT_BOUNDS, VIEWPORT_COLUMNS, VIEWPORT_ROWS, viewportPlan, viewportWindow } from '../src/map-viewport.js';
test('the bound is stated, self-consistent and no larger than the layout allows', () => {
  assert.deepEqual({ columns: VIEWPORT_BOUNDS.max_window_columns, rows: VIEWPORT_BOUNDS.max_window_rows }, { columns: VIEWPORT_COLUMNS, rows: VIEWPORT_ROWS });
  assert.equal(VIEWPORT_BOUNDS.max_regions, MAP_LAYOUT.length, 'at most one read per placed world');
  assert.equal(VIEWPORT_BOUNDS.max_statements, 4 * VIEWPORT_BOUNDS.max_regions + 2, 'the exact worst case of the module\'s own query count');
  // The per-region caps must be able to fill the merged ceiling, or the ceiling would be unreachable.
  const reachable = VIEWPORT_BOUNDS.max_participants + VIEWPORT_BOUNDS.max_regions * (VIEWPORT_BOUNDS.max_objects_per_region + VIEWPORT_BOUNDS.max_scenery_per_region);
  assert.ok(reachable >= VIEWPORT_BOUNDS.max_rows_returned, `${reachable} rows of cap must cover the ${VIEWPORT_BOUNDS.max_rows_returned}-row ceiling`);
  assert.ok(VIEWPORT_BOUNDS.max_rows_returned < reachable, 'the merged ceiling must be a real bound, not the sum of the caps');
});

test('every rectangle of the layout is a shared world, so the cover adds no readability of its own', () => {
  for (const item of MAP_LAYOUT) {
    assert.ok(sharedWorldIds.includes(item.world), `${item.world} is one of the world's own shared worlds`);
    assert.deepEqual([getWorldDefinition(item.world).columns, getWorldDefinition(item.world).rows], [item.width, item.height]);
  }
});

test('the window is clamped to the stated bound and every origin is put back on the map', () => {
  assert.equal(viewportWindow({ world_id: 'hall' }), null, 'an interior is not a viewport of the map');
  assert.equal(viewportWindow({ world_id: 'home:someone' }), null, 'a garden is never a rectangle of the map');
  const arrival = viewportWindow({ world_id: 'commons' });
  assert.equal(arrival.source, 'arrival');
  assert.deepEqual([arrival.columns, arrival.rows], [VIEWPORT_COLUMNS, VIEWPORT_ROWS]);
  assert.equal(arrival.clamped, false);
  const camera = viewportWindow({ world_id: 'district:highlands', x: 5, y: 7 });
  assert.equal(camera.source, 'camera');
  assert.equal(camera.origin.gx, 101); assert.equal(camera.origin.gy, 43);
  const huge = viewportWindow({ gx: 10_000, gy: 10_000, columns: 900, rows: 900 });
  assert.deepEqual([huge.columns, huge.rows], [VIEWPORT_COLUMNS, VIEWPORT_ROWS], 'a large request is clamped to the bound');
  assert.equal(huge.clamped, true);
  assert.ok(huge.origin.gx + huge.columns <= MAP_COLUMNS && huge.origin.gy + huge.rows <= MAP_ROWS, 'a clamped window still lies on the map');
  const negative = viewportWindow({ gx: -40, gy: -40 });
  assert.deepEqual(negative.origin, { gx: 0, gy: 0 });
  // Centring on a global tile is the follower's window: it crosses whatever seam the tile is next to.
  const centred = viewportWindow({ world_id: 'commons', centre: { gx: 121, gy: 71 } });
  assert.equal(centred.source, 'centre');
  assert.deepEqual(centred.origin, { gx: 121 - Math.floor(VIEWPORT_COLUMNS / 2), gy: 71 - Math.floor(VIEWPORT_ROWS / 2) });
  const covered = viewportPlan(centred).regions.map((region) => region.world_id);
  assert.ok(covered.includes('commons') && covered.includes('district:highlands'), 'the centred window covers both sides of the seam the tile is on');
  assert.ok(covered.length <= VIEWPORT_BOUNDS.max_regions, 'and never more regions than the bound allows');
  assert.equal(viewportWindow({ world_id: 'commons', gx: 100, gy: 60, centre: { gx: 5, gy: 5 } }).origin.gx, 100, 'an explicit origin always wins');
});

test('a window that crosses a seam covers both sides, each read through its own local window', () => {
  const covered = seams().map((seam) => {
    // A window straddling the seam line, wide/tall enough to reach into both rectangles.
    const span = viewportWindow(seam.axis === 'v'
      ? { gx: seam.line - 8, gy: seam.from + 4, columns: 16, rows: 10 }
      : { gx: seam.from + 4, gy: seam.line - 8, columns: 10, rows: 16 });
    const plan = viewportPlan(span);
    const ids = plan.regions.map((region) => region.world_id);
    return { seam, plan, ids };
  });
  for (const { seam, plan, ids } of covered) {
    assert.ok(ids.includes(seam.a), `${seam.a}|${seam.b}: side a must be covered`);
    assert.ok(ids.includes(seam.b), `${seam.a}|${seam.b}: side b must be covered`);
    for (const region of plan.regions) {
      const rect = MAP_LAYOUT.find((item) => item.world === region.world_id);
      assert.ok(region.local.x >= 0 && region.local.y >= 0 && region.local.right <= rect.width && region.local.bottom <= rect.height,
        `${region.world_id}: the local window ${JSON.stringify(region.local)} must lie inside the rectangle`);
      // The local window is exactly the window's intersection with the rectangle, in local coordinates.
      assert.deepEqual([
        region.window.gx, region.window.gy, region.window.columns, region.window.rows,
      ], [
        rect.x + region.local.x, rect.y + region.local.y, region.local.right - region.local.x, region.local.bottom - region.local.y,
      ]);
      assert.ok(region.window.gx >= plan.window.gx && region.window.gx + region.window.columns <= plan.window.gx + plan.window.columns, `${region.world_id}: clipped in x`);
      assert.ok(region.window.gy >= plan.window.gy && region.window.gy + region.window.rows <= plan.window.gy + plan.window.rows, `${region.world_id}: clipped in y`);
      assert.equal(region.tiles, region.window.columns * region.window.rows, `${region.world_id}: tiles counted from the clipped window`);
    }
  }
});

test('the cover is the projection\'s own, never larger and never a repeat', () => {
  const probe = (gx, gy, columns, rows) => {
    const plan = viewportPlan({ origin: { gx, gy }, columns, rows, clamped: false });
    const expected = worldRects(gx, gy, columns, rows).map((place) => place.world_id).sort();
    assert.deepEqual(plan.regions.map((region) => region.world_id), expected, `the cover of (${gx},${gy}) ${columns}x${rows}`);
    assert.equal(new Set(plan.regions.map((region) => region.world_id)).size, plan.regions.length, 'a region is never read twice');
    assert.ok(plan.regions.length <= VIEWPORT_BOUNDS.max_regions, 'no more regions than the layout allows');
    return plan;
  };
  probe(0, 0, VIEWPORT_COLUMNS, VIEWPORT_ROWS);
  probe(95, 71, VIEWPORT_COLUMNS, VIEWPORT_ROWS);
  probe(190, 135, VIEWPORT_COLUMNS, VIEWPORT_ROWS);
  probe(240, 100, VIEWPORT_COLUMNS, VIEWPORT_ROWS);
  probe(48, 36, MAP_COLUMNS, MAP_ROWS);
  // The widest possible cover is the whole map, and it is still the bound's worth of regions.
  const whole = viewportPlan({ origin: { gx: 0, gy: 0 }, columns: MAP_COLUMNS, rows: MAP_ROWS, clamped: true });
  assert.equal(whole.regions.length, MAP_LAYOUT.length, 'one read per placed world is the whole map');
});

test('the plan is deterministic, so two clients can diff the same window', () => {
  const one = viewportPlan(viewportWindow({ gx: 110, gy: 66, columns: 20, rows: 14 }));
  const two = viewportPlan(viewportWindow({ gx: 110, gy: 66, columns: 20, rows: 14 }));
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  const ids = one.regions.map((region) => region.world_id);
  assert.deepEqual(ids, [...ids].sort(), 'regions are sorted by world id');
  assert.deepEqual(ids, ['commons', 'district:highlands'], 'a window across the north seam names both sides');
});
