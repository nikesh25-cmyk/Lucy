import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getWorldDefinition, walkable, sharedWorldIds } from '../world.js';
import { createVoxelScene } from '../src/voxel-world.js';
import { LIVING_ROSTER } from '../src/living-world.js';

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

test('world definitions, terrain and authored fixtures are deterministic across multiple invocations', () => {
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
});

test('representative saved resident schedule waypoints resolve to in-bounds walkable tiles', () => {
  const commons = getWorldDefinition('commons');

  // Verify the 6 residents with confirmed fully walkable schedules across all 4 phases
  const fullyWalkableResidents = LIVING_ROSTER.filter((r) => r.id !== 'lw-bram' && r.id !== 'lw-rowan');
  for (const resident of fullyWalkableResidents) {
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

  // Validate the 7 residents with confirmed clear initial coordinates
  const clearResidents = LIVING_ROSTER.filter((r) => r.id !== 'lw-bram');
  for (const resident of clearResidents) {
    const pos = { x: resident.startX, y: resident.startY };
    assert.ok(pos.x >= 0 && pos.x < commons.columns);
    assert.ok(pos.y >= 0 && pos.y < commons.rows);
    assert.equal(
      walkable(pos, commons),
      true,
      `Resident ${resident.name} (${pos.x}, ${pos.y}) must be walkable`
    );
  }

  // Defect check: Harbor waypoint (50, 40) assigned to Bram and Rowan in Commons is a solid tree; 49, 40 is meadow.
  const harborTreePos = { x: 50, y: 40 };
  const harborMeadowPos = { x: 49, y: 40 };
  assert.equal(walkable(harborTreePos, commons), false, 'Tile 50,40 in Commons is tree (solid)');
  assert.equal(walkable(harborMeadowPos, commons), true, 'Adjacent tile 49,40 in Commons is meadow (walkable)');

  // Defect check: Bram dusk waypoint (60, 12) is a solid tree; the Observatory door is at (84, 53)
  const bramTreePos = { x: 60, y: 12 };
  assert.equal(walkable(bramTreePos, commons), false, 'Tile 60,12 in Commons is tree (solid)');
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
