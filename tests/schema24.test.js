import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { widenWorldContentChecks, worldContentChecksCurrent } from '../src/schema24.js';

test('schema 24 widens old world CHECK lists while preserving planted crops and parcel blocks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE agents(id TEXT PRIMARY KEY);
      CREATE TABLE accounts(id TEXT PRIMARY KEY);
      CREATE TABLE frontier_sectors(world_id TEXT PRIMARY KEY);
      CREATE TABLE land_parcels(id TEXT PRIMARY KEY);
      CREATE TABLE plot_grants(id TEXT PRIMARY KEY);
      INSERT INTO agents VALUES('resident'); INSERT INTO accounts VALUES('operator');
      INSERT INTO frontier_sectors VALUES('frontier:0:0'); INSERT INTO land_parcels VALUES('plot:0:0:0:0');
      CREATE TABLE journey_crops(agent_id TEXT NOT NULL REFERENCES agents(id),x INTEGER NOT NULL,y INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('herbs','fiber','wood')),planted_at INTEGER NOT NULL,tended_at INTEGER,harvested_at INTEGER,PRIMARY KEY(agent_id,x,y));
      CREATE TABLE frontier_blocks(id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES frontier_sectors(world_id),x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 47),y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 47),z INTEGER NOT NULL CHECK(z BETWEEN 0 AND 7),type TEXT NOT NULL CHECK(type IN ('stone','wood','glass','brick','sand','grass','path')),creator_agent_id TEXT NOT NULL REFERENCES agents(id),creator_account_id TEXT NOT NULL REFERENCES accounts(id),created_at TEXT NOT NULL,plot_id TEXT REFERENCES land_parcels(id),grant_id TEXT REFERENCES plot_grants(id),UNIQUE(world_id,x,y,z));
      CREATE INDEX frontier_blocks_view ON frontier_blocks(world_id,x,y,z);
      INSERT INTO journey_crops VALUES('resident',2,3,'herbs',100,110,NULL);
      INSERT INTO frontier_blocks VALUES('saved-block','frontier:0:0',1,2,0,'wood','resident','operator','2026-10-14T00:00:00.000Z','plot:0:0:0:0',NULL);
    `);
    const beforeCrop = db.prepare('SELECT * FROM journey_crops').get();
    const beforeBlock = db.prepare('SELECT * FROM frontier_blocks').get();
    assert.equal(worldContentChecksCurrent(db), false);
    db.exec('BEGIN IMMEDIATE');
    try { widenWorldContentChecks(db); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    assert.equal(worldContentChecksCurrent(db), true);
    assert.deepEqual(db.prepare('SELECT * FROM journey_crops').get(), beforeCrop);
    assert.deepEqual(db.prepare('SELECT * FROM frontier_blocks').get(), beforeBlock);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.prepare("INSERT INTO journey_crops VALUES('resident',4,5,'blossom',120,NULL,NULL)").run();
    db.prepare("INSERT INTO frontier_blocks VALUES('new-block','frontier:0:0',2,2,0,'clay','resident','operator','2026-10-14T00:00:01.000Z','plot:0:0:0:0',NULL)").run();
    assert.throws(() => db.prepare("INSERT INTO journey_crops VALUES('resident',6,7,'invented',120,NULL,NULL)").run(), /CHECK constraint/);
    assert.throws(() => db.prepare("INSERT INTO frontier_blocks VALUES('bad-block','frontier:0:0',3,2,0,'invented','resident','operator','2026-10-14T00:00:01.000Z','plot:0:0:0:0',NULL)").run(), /CHECK constraint/);
  } finally { db.close(); }
});
