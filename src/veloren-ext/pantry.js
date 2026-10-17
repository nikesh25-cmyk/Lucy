// The Harr pantry: plain food that anyone may take, restocked by the village farms.
//
//   POST /veloren/pantry/take  { player_uuid, item }    scope director, guide credential
//
// The point is abundance without scarcity games: nobody earns it, nobody needs an account, nobody can
// hoard it (a few takes per person per day, a pause between takes), and it never costs Karma.
//
//   * The stock is a SCRIPTED model, and says so: each food has a restock rate and a cap, computed from
//     the time since it was last looked at. Being away never stacks up more than the cap, and a restart
//     replays nothing.
//   * Taking only issues a signed `pantry_give` command. The game server chooses the food from its own
//     allow-list (server/src/nemo/pantry), puts it in the bag once, and acknowledges. Until then the
//     take is "pending" and the food is reserved; a rejection (full bag, player gone) costs nothing and
//     returns the reservation. The stock goes down only when the game says it delivered.
//   * Chat never names an item: the bridge sends one word from a fixed list, checked again here.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_RESIDENTS, plain, spendRate } from './view.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PANTRY_PATH = join(here, '..', '..', 'content', 'veloren-pantry.json');

export const PANTRY_POLICY = Object.freeze({
  per_player_per_day: 4,
  take_gap_ms: 15_000,
  take_per_hour: 12,
  command_ttl_ms: 60_000,
  // What the farms bring in: units per hour and the most the shelf holds. Scripted, not a model.
  restock: Object.freeze({ apple: { per_hour: 8, cap: 24 }, carrot: { per_hour: 6, cap: 18 }, cheese: { per_hour: 3, cap: 6 }, lettuce: { per_hour: 6, cap: 18 } }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function loadPantry(path = PANTRY_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format !== 'nemo-pantry-manifest-v1') throw new Error('Unsupported pantry manifest.');
  const items = new Map();
  for (const entry of data.items) {
    if (!/^[a-z]{3,12}$/.test(entry.key) || !String(entry.item).startsWith('common.items.food.')) throw new Error(`Bad pantry entry ${entry.key}`);
    if (!Number.isInteger(entry.qty) || entry.qty < 1 || entry.qty > data.max_qty) throw new Error(`Bad quantity for ${entry.key}`);
    if (!PANTRY_POLICY.restock[entry.key]) throw new Error(`No restock rule for ${entry.key}`);
    items.set(entry.key, Object.freeze({ key: entry.key, item: entry.item, qty: entry.qty }));
  }
  return Object.freeze({ max_qty: data.max_qty, items });
}
const PANTRY = loadPantry();

export const pantrySchema = {
  version: 1,
  sql: `CREATE TABLE pantry_shelf(item TEXT PRIMARY KEY, units REAL NOT NULL, as_of INTEGER NOT NULL);
        CREATE TABLE pantry_takes(
          cmd_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, player_uuid TEXT NOT NULL, player_alias TEXT NOT NULL DEFAULT '',
          item TEXT NOT NULL, qty INTEGER NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
        CREATE INDEX pantry_takes_player ON pantry_takes(player_uuid, day);`,
};

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Bring one shelf up to date: restock for the time passed, never above the cap, never before it existed. */
export function shelfNow(sql, key, now) {
  const rule = PANTRY_POLICY.restock[key];
  const row = sql.get('SELECT units, as_of FROM pantry_shelf WHERE item=?', key);
  if (!row) {
    const units = Math.floor(rule.cap / 2);
    sql.run('INSERT INTO pantry_shelf(item,units,as_of) VALUES(?,?,?)', key, units, now);
    return units;
  }
  const hours = Math.max(0, now - row.as_of) / 3_600_000;
  const units = Math.min(rule.cap, row.units + hours * rule.per_hour);
  if (units !== row.units) sql.run('UPDATE pantry_shelf SET units=?, as_of=? WHERE item=?', units, now, key);
  return units;
}

/** Settle takes the game has answered: delivered ones leave the shelf, rejected or lost ones simply stop reserving. */
export function settle(link) {
  const sql = link.sql;
  for (const take of sql.all("SELECT cmd_id, item, qty FROM pantry_takes WHERE state='pending' LIMIT 100")) {
    const { status } = link.commandStatus(take.cmd_id);
    if (status === 'applied') {
      sql.tx(() => {
        const units = shelfNow(sql, take.item, link.clock());
        sql.run('UPDATE pantry_shelf SET units=? WHERE item=?', Math.max(0, units - take.qty), take.item);
        sql.run("UPDATE pantry_takes SET state='delivered' WHERE cmd_id=?", take.cmd_id);
      });
    } else if (status === 'rejected' || status === 'expired_unconfirmed' || status === 'unknown') {
      sql.run("UPDATE pantry_takes SET state=? WHERE cmd_id=?", status === 'rejected' ? 'rejected' : 'unconfirmed', take.cmd_id);
    }
  }
}

function reserved(sql, key) {
  return sql.get("SELECT COALESCE(SUM(qty),0) AS n FROM pantry_takes WHERE item=? AND state='pending'", key).n;
}

export function pantryLines(link, player_uuid, clean = plain) {
  settle(link);
  const now = link.clock();
  const sql = link.sql;
  const shelves = [...PANTRY.items.values()].map((i) => `${Math.max(0, Math.floor(shelfNow(sql, i.key, now) - reserved(sql, i.key)))} ${i.key === 'cheese' ? 'cheese' : `${i.key}s`}`);
  const used = sql.get("SELECT COUNT(*) AS n FROM pantry_takes WHERE player_uuid=? AND day=? AND state IN ('pending','delivered')", player_uuid, dayOf(now)).n;
  const left = Math.max(0, PANTRY_POLICY.per_player_per_day - used);
  const out = [
    `The Harr pantry holds ${shelves.join(', ')}. It is free for everyone and never costs coins.`,
    left > 0 ? `Whisper take apple, carrot, cheese or lettuce. You may take ${left} more today; a few each keeps it fair for all.` : 'You have taken your share for today. The farms restock the pantry through the day; come back tomorrow.',
  ];
  const recent = sql.all("SELECT player_alias, item FROM pantry_takes WHERE state='delivered' ORDER BY created_at DESC LIMIT 2");
  for (const r of recent) out.push(`Recently, ${clean(r.player_alias || 'a traveller', 24)} took ${r.item}. Thank you to the farmers who stocked it.`);
  out.push('The restocking is a scripted schedule, not a person counting. Your bag needs room; if it is full, nothing is taken from the shelf.');
  return out;
}

function guideOnly(link, ctx) {
  const credential = link.authenticate(ctx.tokenFrom(ctx.request), 'director');
  if (!GUIDE_RESIDENTS.includes(credential.resident_id)) ctx.fail(403, 'Only a guide resident may ask on a player\'s behalf.');
}

export function take(link, { player_uuid, item, alias = '' }) {
  const entry = PANTRY.items.get(item);
  if (!entry) return { issued: false, lines: ['The pantry has apples, carrots, cheese and lettuce. Say take and one of those.'] };
  settle(link);
  const now = link.clock();
  const sql = link.sql;
  const day = dayOf(now);
  const used = sql.get("SELECT COUNT(*) AS n FROM pantry_takes WHERE player_uuid=? AND day=? AND state IN ('pending','delivered')", player_uuid, day).n;
  if (used >= PANTRY_POLICY.per_player_per_day) return { issued: false, lines: ['You have taken your share for today. Come back tomorrow; the farms restock all day.'] };
  const available = shelfNow(sql, entry.key, now) - reserved(sql, entry.key);
  if (available < entry.qty) return { issued: false, lines: [`The ${entry.key} shelf is empty for now. The farms restock it through the day; try something else or come back soon.`] };
  const order = randomUUID();
  const command = link.issueCommand({ kind: 'pantry_give', player_uuid, args: { order, item: entry.key, qty: entry.qty }, ttl_ms: PANTRY_POLICY.command_ttl_ms, issuedBy: 'pantry' });
  sql.run('INSERT INTO pantry_takes(cmd_id,order_id,player_uuid,player_alias,item,qty,day,created_at) VALUES(?,?,?,?,?,?,?,?)', command.cmd_id, order, player_uuid, plain(alias, 24), entry.key, entry.qty, day, now);
  return { issued: true, cmd_id: null, lines: [`Sent: ${entry.qty} ${entry.key}${entry.qty > 1 && entry.key !== 'cheese' ? 's' : ''} from the pantry. They reach your bag in a moment if there is room.`] };
}

export const pantryExtension = {
  name: 'pantry',
  schema: pantrySchema,
  async handle(link, ctx) {
    const { route, request } = ctx;
    if (route === '/veloren/pantry/take' && request.method === 'POST') {
      guideOnly(link, ctx);
      const input = await ctx.body(request);
      const player = typeof input?.player_uuid === 'string' && UUID.test(input.player_uuid) ? input.player_uuid : ctx.fail(400, 'A Veloren player id is required.');
      spendRate(link, '*pantry', { gapMs: 0, perHour: 600 });
      spendRate(link, `pantry:${player}`, { gapMs: PANTRY_POLICY.take_gap_ms, perHour: PANTRY_POLICY.take_per_hour });
      const alias = link.sql.get('SELECT alias FROM link_players WHERE player_uuid=?', player)?.alias || '';
      ctx.json(ctx.response, 200, take(link, { player_uuid: player, item: String(input.item || ''), alias }));
      return true;
    }
    return false;
  },
};
