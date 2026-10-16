// What may stand where. This is one policy with two enforcement points: the palette the build
// method validates against, and the SQLite trigger that protects garden and cottage storage from a
// writer that bypasses that method. Both read the sealed content palettes, so a route-level check
// and a direct write cannot drift apart, and a database that lost the trigger fails recovery.
import content from './content.js';

export const GARDEN_PALETTE = Object.freeze(content.palette('garden'));
export const HOUSE_PALETTE = Object.freeze(content.palette('house'));
/** Everything either palette may build; the runtime cannot know which of the two it will observe. */
export const BUILD_PALETTE = Object.freeze([...new Set([...GARDEN_PALETTE, ...HOUSE_PALETTE])]);

const listed = (palette) => palette.map((type) => `'${type}'`).join(',');
/**
 * The storage-layer twin of build(): an object may only enter its own garden or cottage, inside the
 * world bounds, using the palette that world kind may build with. A direct insert therefore fails
 * closed rather than quietly furnishing a world. database.js installs this trigger; recovery.js
 * requires it from schema version 13.
 */
const validPlacement = `EXISTS(SELECT 1 FROM worlds w WHERE w.id=NEW.world_id AND NEW.x>=0 AND NEW.x<w.width AND NEW.y>=0 AND NEW.y<w.height
  AND ((w.kind='home' AND NEW.type IN (${listed(GARDEN_PALETTE)})) OR (w.kind='house' AND NEW.type IN (${listed(HOUSE_PALETTE)}))))`;
export const WORLD_OBJECT_GUARDS = `CREATE TRIGGER IF NOT EXISTS world_objects_build_guard BEFORE INSERT ON world_objects
  WHEN NOT ${validPlacement} BEGIN SELECT RAISE(ABORT,'Garden objects must use the build palette inside their own garden or cottage'); END;
  CREATE TRIGGER IF NOT EXISTS world_objects_update_guard BEFORE UPDATE OF world_id,type,x,y ON world_objects
  WHEN NOT ${validPlacement} BEGIN SELECT RAISE(ABORT,'Garden objects must use the build palette inside their own garden or cottage'); END;`;
