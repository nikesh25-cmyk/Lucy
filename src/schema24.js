import content from './content.js';
import { FRONTIER_PALETTE } from './frontier.js';

// Schema 24 widens two sealed-content CHECK lists. SQLite cannot alter a CHECK in place, so copy
// both tables inside openDatabase's existing transaction. Keep every stored row and its identity.
export function widenWorldContentChecks(db) {
  const cropKinds = Object.keys(content.crops()).map((kind) => `'${kind}'`).join(',');
  const blockKinds = FRONTIER_PALETTE.map((kind) => `'${kind}'`).join(',');
  db.exec(`
    CREATE TABLE journey_crops_v24(agent_id TEXT NOT NULL REFERENCES agents(id),x INTEGER NOT NULL,y INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN (${cropKinds})),planted_at INTEGER NOT NULL,tended_at INTEGER,harvested_at INTEGER,PRIMARY KEY(agent_id,x,y));
    INSERT INTO journey_crops_v24 SELECT * FROM journey_crops;
    DROP TABLE journey_crops;
    ALTER TABLE journey_crops_v24 RENAME TO journey_crops;
    CREATE TABLE frontier_blocks_v24(id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES frontier_sectors(world_id),x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 47),y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 47),z INTEGER NOT NULL CHECK(z BETWEEN 0 AND 7),type TEXT NOT NULL CHECK(type IN (${blockKinds})),creator_agent_id TEXT NOT NULL REFERENCES agents(id),creator_account_id TEXT NOT NULL REFERENCES accounts(id),created_at TEXT NOT NULL,plot_id TEXT REFERENCES land_parcels(id),grant_id TEXT REFERENCES plot_grants(id),UNIQUE(world_id,x,y,z));
    INSERT INTO frontier_blocks_v24(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id,grant_id) SELECT id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id,grant_id FROM frontier_blocks;
    DROP TABLE frontier_blocks;
    ALTER TABLE frontier_blocks_v24 RENAME TO frontier_blocks;
    CREATE INDEX frontier_blocks_view ON frontier_blocks(world_id,x,y,z);
  `);
}

export function worldContentChecksCurrent(db) {
  const crops = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='journey_crops'").get()?.sql || '';
  const blocks = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='frontier_blocks'").get()?.sql || '';
  const values = (sql, field) => {
    const clause = sql.match(new RegExp(`\\b${field}\\s+TEXT\\s+NOT NULL\\s+CHECK\\(${field} IN \\(([^)]*)\\)\\)`, 'i'))?.[1];
    return clause ? clause.split(',').map((value) => value.trim().replace(/^'|'$/g, '')).sort() : null;
  };
  return JSON.stringify(values(crops, 'kind')) === JSON.stringify(Object.keys(content.crops()).sort())
    && JSON.stringify(values(blocks, 'type')) === JSON.stringify([...FRONTIER_PALETTE].sort());
}
