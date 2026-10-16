import content from './content.js';
import { FRONTIER_PALETTE } from './frontier.js';
import { worldContentChecksCurrent } from './schema24.js';

export const WORLD_CONTENT_SCHEMA_VERSION = 27;

const tables = Object.freeze([
  { name: 'journey_crops', field: 'kind', kinds: () => Object.keys(content.crops()) },
  { name: 'frontier_blocks', field: 'type', kinds: () => [...FRONTIER_PALETTE] },
]);
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

function storedKinds(db, table) {
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table.name)?.sql || '';
  const clause = sql.match(new RegExp(`\\b${table.field}\\s+TEXT\\s+NOT NULL\\s+CHECK\\(${table.field} IN \\(([^)]*)\\)\\)`, 'i'))?.[1];
  if (!clause) return null;
  const values = clause.split(',').map((value) => value.trim());
  // The known legacy schema has a literal, nonempty IN list. Expressions, duplicate values and
  // unsealed kinds cannot be turned into a valid schema merely by opening the world.
  if (!values.length || values.some((value) => !/^'[a-z][a-z0-9_-]*'$/.test(value))) return null;
  const kinds = values.map((value) => value.slice(1, -1));
  return new Set(kinds).size === kinds.length ? kinds : null;
}

/** A legacy backup may have a narrower sealed list, but never an unknown or missing constraint. */
export function worldContentChecksUpgradeable(db) {
  return tables.every((table) => {
    const kinds = storedKinds(db, table), allowed = new Set(table.kinds());
    return kinds && kinds.every((kind) => allowed.has(kind));
  });
}

/**
 * Widen legacy content CHECKs inside openDatabase's existing transaction. All dependent views and
 * triggers are suspended and restored from their exact SQL so SQLite can reparse the rebuilt tables;
 * indexes attached to those tables are restored too. A failed copy or validation rolls back with the
 * caller's transaction, including the original tables, guards and user_version.
 */
export function upgradeWorldContentChecks(db) {
  if (worldContentChecksCurrent(db)) return false;
  if (!worldContentChecksUpgradeable(db)) throw new Error('Stored world content constraints cannot be upgraded without removing unsupported content.');
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Stored world content failed validation before migration.');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Stored world content has invalid references before migration.');

  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('view','trigger') AND sql IS NOT NULL ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END,name").all();
  const indexes = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name IN ('journey_crops','frontier_blocks') AND sql IS NOT NULL ORDER BY name").all();
  const definitions = tables.map((table) => {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table.name).sql;
    const values = table.kinds().map((kind) => `'${kind}'`).join(',');
    // Change only the existing list. Every other column, CHECK, foreign key and unique constraint
    // retains its original definition, including optional columns added by earlier migrations.
    const widened = sql.replace(new RegExp(`(\\b${table.field}\\s+TEXT\\s+NOT NULL\\s+CHECK\\(${table.field} IN \\()[^)]*(\\)\\))`, 'i'), `$1${values}$2`);
    const temporary = `${table.name}_v27`;
    if (db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(temporary)) throw new Error('Stored world content has an unexpected migration table.');
    const columns = db.prepare(`PRAGMA table_info(${identifier(table.name)})`).all().map((column) => identifier(column.name));
    return { ...table, temporary, widened, columns };
  });

  for (const object of objects) db.exec(`DROP ${object.type.toUpperCase()} ${identifier(object.name)}`);
  for (const table of definitions) {
    const create = table.widened.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)/i, `CREATE TABLE ${identifier(table.temporary)}`);
    db.exec(create);
    const columns = ['rowid', ...table.columns].join(',');
    db.exec(`INSERT INTO ${identifier(table.temporary)}(${columns}) SELECT ${columns} FROM ${identifier(table.name)}`);
    const differs = db.prepare(`SELECT 1 FROM (SELECT ${columns} FROM ${identifier(table.name)} EXCEPT SELECT ${columns} FROM ${identifier(table.temporary)}) LIMIT 1`).get()
      || db.prepare(`SELECT 1 FROM (SELECT ${columns} FROM ${identifier(table.temporary)} EXCEPT SELECT ${columns} FROM ${identifier(table.name)}) LIMIT 1`).get();
    if (differs) throw new Error('Stored world content migration did not preserve every saved row.');
    db.exec(`DROP TABLE ${identifier(table.name)}; ALTER TABLE ${identifier(table.temporary)} RENAME TO ${identifier(table.name)}`);
  }
  for (const index of indexes) db.exec(index.sql);
  for (const object of [...objects.filter((object) => object.type === 'view'), ...objects.filter((object) => object.type === 'trigger')]) db.exec(object.sql);
  if (!worldContentChecksCurrent(db) || db.prepare('PRAGMA foreign_key_check').get() || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Stored world content failed validation after migration.');
  return true;
}
