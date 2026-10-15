import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getWorldDefinition, walkable, sharedWorldIds, regionFacts } from '../world.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { LIVING_ROSTER } from '../src/living-world.js';
import { ensureLivingWorld } from '../src/living-world.js';
import { Platform } from '../src/platform.js';

function hashWorld(def) {
  const content = JSON.stringify({
    id: def.id,
    kind: def.kind,
    columns: def.columns,
    rows: def.rows,
    start: def.start,
    terrain: def.terrain,
    objects: def.objects,
    portals: def.portals,
    landmarks: def.landmarks,
  });
  return createHash('sha256').update(content).digest('hex');
}

test('world definitions, terrain and authored fixtures are deterministic across processes', () => {
  const sampleWorldIds = [
    'commons',
    'hall',
    'pavilion',
    'gallery',
    'meditation',
    'library',
    'workshop',
    'observatory',
    'orchard',
    'harbor',
    'district:coast',
    'district:highlands',
    'district:snowline',
    'country:NPL',
    'home:00000000-0000-0000-0000-000000000001',
    'house:00000000-0000-0000-0000-000000000001',
    'frontier:0:0',
  ];

  for (const id of sampleWorldIds) {
    const defA = getWorldDefinition(id);
    const hashA = hashWorld(defA);

    const defB = getWorldDefinition(id);
    const hashB = hashWorld(defB);

    assert.equal(hashA, hashB, `World definition for ${id} must produce identical deterministic hashes`);
    assert.ok(defA.columns > 0 && defA.rows > 0, `${id} must have positive dimensions`);
    assert.ok(Array.isArray(defA.terrain) && defA.terrain.length === defA.rows, `${id} terrain row count must match rows`);
    assert.ok(defA.terrain[0].length === defA.columns, `${id} terrain column count must match columns`);
    assert.ok(walkable(defA.start, defA), `Start position for ${id} (${defA.start.x}, ${defA.start.y}) must be walkable`);
  }

  const script = `import {createHash} from 'node:crypto'; import {getWorldDefinition} from './world.js';
    const ids=${JSON.stringify(sampleWorldIds)};
    const hashes=ids.map(id=>{const d=getWorldDefinition(id);const content=JSON.stringify({id:d.id,kind:d.kind,columns:d.columns,rows:d.rows,start:d.start,terrain:d.terrain,objects:d.objects,portals:d.portals,landmarks:d.landmarks});return createHash('sha256').update(content).digest('hex')});
    console.log(JSON.stringify(hashes));`;
  const childHashes = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
  }));
  assert.deepEqual(childHashes, sampleWorldIds.map(id => hashWorld(getWorldDefinition(id))));
});

test('representative saved resident schedule waypoints resolve to in-bounds walkable tiles', () => {
  const commons = getWorldDefinition('commons');

  for (const resident of LIVING_ROSTER) {
    for (const [phase, dest] of Object.entries(resident.destinations)) {
      const destPos = { x: dest.x, y: dest.y };
      assert.ok(destPos.x >= 0 && destPos.x < commons.columns, `Resident ${resident.name} ${phase} dest out of bounds`);
      assert.ok(destPos.y >= 0 && destPos.y < commons.rows, `Resident ${resident.name} ${phase} dest out of bounds`);
      assert.ok(
        walkable(destPos, commons),
        `Resident ${resident.name} ${phase} dest (${destPos.x}, ${destPos.y}) at ${dest.label} must be walkable`
      );
    }
  }

  // Common confirmed walkable destinations: Central Plaza (20,18) and Meeting Hall (11,7)
  assert.ok(walkable({ x: 20, y: 18 }, commons), 'Central Plaza destination (20,18) must be walkable');
  assert.ok(walkable({ x: 11, y: 7 }, commons), 'Meeting Hall destination (11,7) must be walkable');
});

test('resident initial start tile walkability check and collision boundary validation', () => {
  const commons = getWorldDefinition('commons');

  for (const resident of LIVING_ROSTER) {
    const pos = { x: resident.startX, y: resident.startY };
    assert.ok(pos.x >= 0 && pos.x < commons.columns);
    assert.ok(pos.y >= 0 && pos.y < commons.rows);
    assert.equal(
      walkable(pos, commons),
      true,
      `Resident ${resident.name} (${pos.x}, ${pos.y}) must be walkable`
    );
  }

  const bram = LIVING_ROSTER.find((resident) => resident.id === 'lw-bram');
  const rowan = LIVING_ROSTER.find((resident) => resident.id === 'lw-rowan');
  assert.deepEqual({ x: bram.startX, y: bram.startY }, regionFacts.harbor.door);
  assert.deepEqual({ x: bram.destinations.dawn.x, y: bram.destinations.dawn.y }, regionFacts.harbor.door);
  assert.deepEqual({ x: rowan.destinations.dusk.x, y: rowan.destinations.dusk.y }, regionFacts.harbor.door);
  assert.deepEqual({ x: bram.destinations.dusk.x, y: bram.destinations.dusk.y }, regionFacts.observatory.door);
});

test('a legacy resident on a solid spawn is repaired once without moving a valid saved resident', () => {
  const platform = new Platform(':memory:');
  try {
    ensureLivingWorld(platform, { bootstrap: true });
    platform.run('UPDATE agents SET x=50,y=40 WHERE id=?', 'lw-bram');
    ensureLivingWorld(platform, { bootstrap: true });
    const repaired = platform.get('SELECT x,y FROM agents WHERE id=?', 'lw-bram');
    assert.equal(repaired.x, regionFacts.harbor.door.x);
    assert.equal(repaired.y, regionFacts.harbor.door.y);
    assert.equal(platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.position_repaired' AND record_id='lw-bram'").n, 1);
    platform.run('UPDATE agents SET x=20,y=18 WHERE id=?', 'lw-bram');
    ensureLivingWorld(platform, { bootstrap: true });
    const moved = platform.get('SELECT x,y FROM agents WHERE id=?', 'lw-bram');
    assert.equal(moved.x, 20);
    assert.equal(moved.y, 18);
    assert.equal(platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.position_repaired' AND record_id='lw-bram'").n, 1);
  } finally {
    platform.close();
  }
});

test('walkability and collision agreement across server definitions and client voxel scene', () => {
  // Test representative zones: Commons, District, Home, Country, Frontier
  const testCases = [
    {
      worldId: 'commons',
      standable: [{ x: 10, y: 6 }, { x: 20, y: 18 }, { x: 42, y: 25 }, { x: 11, y: 7 }],
      solid: [{ x: 0, y: 0 }, { x: 1, y: 1 }], // Perimeter water tiles
    },
    {
      worldId: 'district:coast',
      standable: [{ x: 10, y: 10 }, { x: 15, y: 15 }],
      solid: [{ x: 0, y: 0 }],
    },
    {
      worldId: 'home:00000000-0000-0000-0000-000000000001',
      standable: [{ x: 10, y: 10 }],
      solid: [{ x: 0, y: 0 }],
    },
    {
      worldId: 'country:NPL',
      standable: [{ x: 12, y: 12 }],
      solid: [{ x: 1, y: 9 }], // Authored booth/perimeter barrier
    },
    {
      worldId: 'frontier:0:0',
      standable: [{ x: 30, y: 30 }],
      solid: [{ x: 7, y: 0 }], // Frontier perimeter tree
    },
  ];

  for (const { worldId, standable, solid } of testCases) {
    const worldDef = getWorldDefinition(worldId);

    for (const pos of standable) {
      const serverWalkable = walkable(pos, worldDef);
      assert.equal(serverWalkable, true, `Expected tile (${pos.x}, ${pos.y}) in ${worldId} to be walkable on server`);
    }

    for (const pos of solid) {
      const serverWalkable = walkable(pos, worldDef);
      assert.equal(serverWalkable, false, `Expected tile (${pos.x}, ${pos.y}) in ${worldId} to be solid/unwalkable on server`);
    }

    // Verify client scene generator accepts the world definition without error
    const scene = createVoxelScene(worldDef);
    assert.ok(scene, `Client voxel scene must instantiate for ${worldId}`);
  }
});
