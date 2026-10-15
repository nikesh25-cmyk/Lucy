// The finite world and the existing plots are not moved by anything this slice adds: a content
// update, a map update and a restart all leave saved land, saved placements and saved blocks
// byte-identical, and every stored coordinate stays a local tile of the world that owns it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';
import { MAP_LAYOUT, fromGlobal, toGlobal } from '../src/global-map.js';
import { getWorldDefinition, walkable } from '../world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every row that names a place the world stores: a saved placement, a frontier sector and its blocks,
 * a land parcel and its stewardship, and the world registry itself. Read in a canonical order, so two
 * reads can be compared byte for byte. A civic resident is deliberately absent: a guide patrols, and
 * its tile is live state rather than saved land.
 */
function savedLand(platform) {
  return JSON.stringify({
    world_objects: platform.all('SELECT id,world_id,type,x,y,created_at FROM world_objects ORDER BY world_id,x,y').map((row) => ({ ...row })),
    frontier_sectors: platform.all('SELECT world_id,sector_x,sector_y,creator_account_id,creator_agent_id,created_at FROM frontier_sectors ORDER BY world_id').map((row) => ({ ...row })),
    frontier_blocks: platform.all('SELECT id,world_id,x,y,z,type,creator_account_id,created_at FROM frontier_blocks ORDER BY world_id,x,y,z').map((row) => ({ ...row })),
    land_parcels: platform.all('SELECT id,world_id,sector_x,sector_y,plot_x,plot_y,x,y,width,height,area_m2,buildable_cells,reserved,reserved_reason FROM land_parcels ORDER BY id').map((row) => ({ ...row })),
    land_stewardships: platform.all('SELECT plot_id,account_id,purpose,description,assigned_at FROM land_stewardships ORDER BY plot_id').map((row) => ({ ...row })),
    worlds: platform.all('SELECT id,name,kind,owner_agent_id,visibility,width,height FROM worlds ORDER BY id').map((row) => ({ ...row })),
  });
}

/** A garden placement, one assigned finite parcel and one block inside it: the whole fixture. */
async function plantSavedLand(f) {
  const alice = f.agent('alice');
  const garden = `home:${alice.id}`;
  f.tx('travel', f.actor('alice'), alice.id, { world_id: garden });
  const definition = getWorldDefinition(garden);
  const tiles = [];
  for (let y = 2; y < definition.rows - 2 && tiles.length < 4; y++) for (let x = 2; x < definition.columns - 2 && tiles.length < 4; x++) {
    if (walkable({ x, y }, definition) && Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) > 1) tiles.push({ x, y });
  }
  f.tx('build', f.actor('alice'), alice.id, { type: 'flowers', x: tiles[0].x, y: tiles[0].y });
  f.tx('build', f.actor('alice'), alice.id, { type: 'well', x: tiles[1].x, y: tiles[1].y });
  // One finite parcel: an opened starter area with a free, unbuilt parcel, assigned with a purpose.
  const parcel = f.platform.get(`SELECT p.id,p.world_id,p.x,p.y FROM land_parcels p JOIN frontier_sectors f ON f.world_id=p.world_id
    LEFT JOIN land_stewardships s ON s.plot_id=p.id WHERE p.world_id='frontier:0:0' AND p.reserved=0 AND s.plot_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM frontier_blocks b WHERE b.world_id=p.world_id AND b.x>=p.x AND b.x<p.x+6 AND b.y>=p.y AND b.y<p.y+6)
    ORDER BY p.plot_y,p.plot_x LIMIT 1`);
  assert.ok(parcel, 'the finite registry offers a free parcel in an opened area');
  f.tx('landAssign', f.actor('alice'), { plot_id: parcel.id, purpose: 'A measured fixture purpose', description: 'Planted by the preservation test.' });
  f.platform.run("UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0 WHERE id=?", parcel.world_id, parcel.x, parcel.y, alice.id);
  f.advance(2000);
  f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id: parcel.world_id, x: parcel.x + 1, y: parcel.y + 1, z: 0, type: 'stone' });
  return { alice, garden, tiles, parcel };
}

test('a saved placement, a frontier block and a land plot survive a content update byte for byte', async (t) => {
  const f = await fixture(t);
  const seeded = await plantSavedLand(f);
  const before = savedLand(f.platform);
  assert.ok(JSON.parse(before).world_objects.length >= 2, 'the fixture placed at least two objects');
  assert.equal(JSON.parse(before).frontier_blocks.filter((row) => row.world_id === seeded.parcel.world_id).length, 1, 'the fixture placed one block inside its own parcel');
  assert.equal(JSON.parse(before).land_stewardships.length, 1, 'the fixture assigned one parcel');

  // A content update is a boot that re-reads and re-seeds the authored content. These are exactly the
  // calls the platform's own constructor makes, so this is the shipped content path, not a stand-in.
  f.platform.seed();
  f.platform.seedSpaces();
  f.platform.initCommunity();
  f.platform.initJourney();
  f.platform.initCivic();
  f.platform.initVocations();
  f.platform.initQuests();
  f.platform.initGuilds();
  f.platform.initEvidence();
  assert.equal(savedLand(f.platform), before, 'a content update leaves every saved placement, block, parcel and world row byte-identical');
  const plan = f.platform.landPlot(f.actor('alice'), { plot_id: seeded.parcel.id });
  assert.equal(plan.plot.id, seeded.parcel.id, 'and the parcel is still the same parcel, with its purpose');
  assert.equal(f.platform.get('SELECT purpose FROM land_stewardships WHERE plot_id=?', seeded.parcel.id).purpose, 'A measured fixture purpose');
});

test('the map\'s global coordinates are derived, so a map update reinterprets nothing that is stored', async (t) => {
  const f = await fixture(t);
  const seeded = await plantSavedLand(f);
  const before = savedLand(f.platform);
  const coordinates = JSON.parse(before);

  // A map update is a rebuild of every world definition and of the stitched map: the same call the
  // server and the browser make when the map's code changes.
  for (const item of MAP_LAYOUT) getWorldDefinition(item.world);
  getWorldDefinition('map:core');

  assert.equal(savedLand(f.platform), before, 'a map rebuild writes nothing and moves nothing');
  // Every stored coordinate is a local tile of the world that owns it, so no map revision can
  // reinterpret one: there is no stored global coordinate to be stale.
  for (const row of coordinates.world_objects) {
    const definition = getWorldDefinition(row.world_id);
    assert.ok(row.x >= 0 && row.x < definition.columns && row.y >= 0 && row.y < definition.rows, `${row.id}: ${row.x},${row.y} is a tile of ${row.world_id}`);
    if (!MAP_LAYOUT.some((item) => item.world === row.world_id)) continue;
    const global = toGlobal(row.world_id, row.x, row.y);
    assert.deepEqual(fromGlobal(global.gx, global.gy), { world_id: row.world_id, x: row.x, y: row.y }, `${row.id}: the derived global tile projects back to the stored tile`);
  }
  for (const row of coordinates.frontier_blocks) {
    assert.ok(row.x >= 0 && row.x < 48 && row.y >= 0 && row.y < 48, `${row.id} is a tile of its own 48 by 48 sector`);
  }
  for (const row of coordinates.land_parcels) {
    assert.ok(row.x >= 0 && row.y >= 0 && row.width === 6 && row.height === 6, 'a parcel keeps its own six-by-six extent');
  }
  // A saved placement inside a rectangle of the map is not touched by the seam pass, which removes only
  // authored scenery from the built definition.
  const definition = getWorldDefinition('orchard');
  assert.ok(definition.objects.every((item) => Number.isInteger(item.x) && Number.isInteger(item.y)), 'the seam pass leaves only authored scenery in the definition it returns');
  const orchard = MAP_LAYOUT.find((item) => item.world === 'orchard');
  f.platform.run("UPDATE worlds SET kind='home' WHERE id='orchard'");
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES('map-update-probe','orchard','bench',?,?,?)", orchard.width - 2, orchard.height - 2, new Date(f.clock()).toISOString());
  const afterInsert = savedLand(f.platform);
  getWorldDefinition('orchard'); getWorldDefinition('map:core');
  assert.equal(savedLand(f.platform), afterInsert, 'a saved placement in a map rectangle survives a map rebuild');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM world_objects WHERE id='map-update-probe'").n, 1);
  assert.equal(seeded.parcel.id, JSON.parse(afterInsert).land_parcels.find((row) => row.id === seeded.parcel.id).id);
});


test('a restart leaves saved land, plots and blocks byte-identical and the parcels still correct', async (t) => {
  const f = await fixture(t);
  const seeded = await plantSavedLand(f);
  const before = savedLand(f.platform);
  const gardenBefore = f.platform.all('SELECT id,world_id,type,x,y FROM world_objects WHERE world_id=? ORDER BY x,y', seeded.garden).map((row) => ({ ...row }));

  // A real restart: the process image is replaced and the same database file is opened again.
  const app = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  app.stopEvents();
  await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
  await sleep(60);
  const reopened = new Platform(f.database);
  t.after(() => { try { reopened.close(); } catch { /* already closed. */ } });

  assert.equal(savedLand(reopened), before, 'every saved placement, block, parcel, stewardship and world row survives the restart byte for byte');
  assert.deepEqual(reopened.all('SELECT id,world_id,type,x,y FROM world_objects WHERE world_id=? ORDER BY x,y', seeded.garden).map((row) => ({ ...row })), gardenBefore, 'and the garden holds exactly the placements it held');
  const actor = reopened.authenticate(f.credentials.alice.token);
  const plot = reopened.landPlot(actor, { plot_id: seeded.parcel.id });
  assert.equal(plot.plot.id, seeded.parcel.id, 'the stewardship is still readable after the restart');
  assert.equal(plot.plot.purpose, 'A measured fixture purpose');
  assert.equal(plot.plot.state, 'assigned');
  // The derived map position of a stored row is recomputed, not remembered, and it is still valid.
  for (const row of reopened.all('SELECT id,world_id,x,y FROM world_objects ORDER BY id')) {
    if (!MAP_LAYOUT.some((item) => item.world === row.world_id)) continue;
    const global = toGlobal(row.world_id, row.x, row.y);
    assert.deepEqual(fromGlobal(global.gx, global.gy), { world_id: row.world_id, x: row.x, y: row.y }, `${row.id}: the derived global tile projects back to the stored tile`);
  }
});
