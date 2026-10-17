import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityFor } from './identity.js';

// One global map: NemoWorld places mapped to real Veloren places, and travel between them.
//
// The keeper resident (Vaelen Kindred, `lw-vaelen`) answers a linked player's short commands — where am I,
// what is near me, travel to <place> — and asks the Veloren server to move them with a signed `teleport`
// command. What he may do is deliberately narrow:
//
//   * the ALLOW-LIST is this module's own atlas file (`veloren-atlas-server-v1`): every place is a real
//     site or plot *name* the Veloren server can resolve from world generation. A command names a place id
//     and the atlas file's manifest hash, never a coordinate — and the server refuses a place or a hash
//     that is not in the atlas it was given.
//   * the player's own position is never guessed here: "where am I" is answered from the last *signed*
//     landmark event NemoWorld stored for that player, and says so.
//   * travel is bounded: one place per ask, one travel per cooldown (mirroring the server's own), the
//     player must be linked and online, and the server's acknowledgement is what makes it "arrived".
//   * nothing here writes land, currency, progress or permissions.

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The residents that may answer for the atlas. One keeper, one credential. */
export const ATLAS_KEEPERS = Object.freeze(['lw-vaelen']);
/** The command kinds this extension owns (the server parses exactly these argument shapes). */
export const ATLAS_COMMAND_KINDS = Object.freeze(['teleport', 'atlas_look', 'atlas_mark']);
export const ATLAS_FORMAT = 'veloren-atlas-server-v1';

export const ATLAS_POLICY = Object.freeze({
  ask_gap_ms: 2_000,
  ask_chars: 300,
  line_chars: 190,
  reply_lines: 4,
  // Mirrors nemo-link-proto's TELEPORT_COOLDOWN_SECS: the server refuses sooner than this anyway.
  teleport_gap_ms: 20_000,
  look_gap_ms: 5_000,
  command_ttl_ms: 60_000,
  notice_ttl_ms: 15 * 60_000,
  notices_per_poll: 10,
  name_chars: 60,
});

// ---- the atlas file -----------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const ATLAS_PATH = process.env.NEMO_LINK_ATLAS || join(here, '..', '..', 'content', 'veloren-atlas-places.json');
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const cleanText = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Parse and check an atlas file: the allow-list every travel command is judged against. */
export function loadAtlas(path = ATLAS_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format !== ATLAS_FORMAT) fail(500, `Unsupported atlas format: ${data.format}`);
  if (typeof data.manifest_hash !== 'string' || !HEX64.test(data.manifest_hash)) fail(500, 'The atlas needs a 64-hex manifest hash.');
  if (!Number.isSafeInteger(data.world_seed)) fail(500, 'The atlas needs the world seed it was built for.');
  if (!Array.isArray(data.places) || data.places.length < 1 || data.places.length > 200) fail(500, 'An atlas holds 1 to 200 places.');
  const places = new Map();
  for (const place of data.places) {
    if (!SLUG.test(place.id || '')) fail(500, `Bad place id: ${place.id}`);
    if (places.has(place.id)) fail(500, `Place listed twice: ${place.id}`);
    if (!cleanText(place.name, 60) || !cleanText(place.short, 160)) fail(500, `Place ${place.id} needs a name and a short line.`);
    if (!['site', 'plot'].includes(place.kind)) fail(500, `Place ${place.id} must be a site or a plot.`);
    if (!cleanText(place.site, 60)) fail(500, `Place ${place.id} needs a site name.`);
    if (place.kind === 'plot' && !cleanText(place.plot, 40)) fail(500, `Place ${place.id} is a plot and needs its plot kind.`);
    if (place.plot !== undefined && place.kind !== 'plot') fail(500, `Place ${place.id} names a plot but is not a plot.`);
    if (place.nth !== undefined && (!Number.isSafeInteger(place.nth) || place.nth < 0)) fail(500, `Place ${place.id} has a bad nth.`);
    if (typeof place.arrive_radius !== 'number' || !(place.arrive_radius > 0 && place.arrive_radius <= 200)) fail(500, `Place ${place.id} needs an arrive radius.`);
    if (place.landmark_id !== undefined && !SLUG.test(place.landmark_id)) fail(500, `Place ${place.id} has a bad landmark id.`);
    places.set(place.id, Object.freeze({ ...place }));
  }
  return Object.freeze({ format: data.format, manifest_hash: data.manifest_hash, world_seed: data.world_seed, source: String(data.source || ''), places });
}
export const ATLAS = loadAtlas();

// ---- words --------------------------------------------------------------------------------------

const cleanLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (value) => ` ${String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const has = (text, words) => words.some((word) => text.includes(` ${word} `));
const FILLER = new Set(['travel', 'go', 'to', 'the', 'a', 'an', 'take', 'me', 'there', 'please', 'can', 'you', 'i', 'want', 'would', 'like']);

/** The place a line names, if any: the longest place name (or id) the atlas knows. */
export function placeInText(text, atlas = ATLAS) {
  const haystack = norm(text);
  let best = null;
  for (const place of atlas.places.values()) {
    for (const candidate of [place.name, place.id, place.short]) {
      const needle = norm(candidate);
      if (needle.trim().length >= 3 && haystack.includes(needle) && (!best || needle.length > norm(best.name).length)) best = { place, needle };
    }
  }
  return best?.place ?? null;
}

/**
 * What a player said, as one of a fixed set of intentions. Pure and deterministic: the words choose among
 * fixed answers and a place the atlas already knows.
 */
export function parseIntent(raw, atlas = ATLAS) {
  const text = norm(raw);
  if (has(text, ['near', 'around', 'nearby', 'close'])) return { intent: 'near' };
  if (has(text, ['where', 'am', 'position', 'lost'])) {
    const place = placeInText(raw, atlas);
    return { intent: 'where', place };
  }
  if (has(text, ['travel', 'teleport', 'go', 'take', 'visit', 'walk'])) {
    const place = placeInText(raw, atlas);
    return place ? { intent: 'travel', place } : { intent: 'travel', place: null, unknown: wordsOf(raw) };
  }
  const place = placeInText(raw, atlas);
  if (place) return { intent: 'where', place };
  if (has(text, ['map', 'atlas', 'places', 'where can i go', 'destinations'])) return { intent: 'list' };
  return { intent: 'help' };
}

function wordsOf(raw) {
  return String(raw || '').split(/\s+/).filter((word) => !FILLER.has(word.toLowerCase())).slice(0, 4).join(' ');
}

// ---- the service --------------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class AtlasService {
  constructor(link, platform, { atlas = ATLAS, policy = ATLAS_POLICY, identity = identityFor } = {}) {
    this.link = link;
    this.platform = platform;
    this.atlas = atlas;
    this.policy = policy;
    this.identity = identity;
    this.sql = link.sql;
  }

  get now() { return this.link.clock(); }

  linked(player_uuid) {
    const found = this.identity(this.link, player_uuid);
    if (!found || typeof found.account_id !== 'string' || typeof found.agent_id !== 'string') return null;
    return { account_id: found.account_id, agent_id: found.agent_id, display_name: String(found.display_name || '') };
  }

  /** Where NemoWorld last *observed* this player: the newest signed landmark event, or none. */
  lastSeen(player_uuid) {
    // Only the two kinds that carry a landmark: a command's acknowledgement reuses `landmark_id` for its
    // own command id, so it must never be read as a place.
    const row = this.sql.get("SELECT landmark_id, kind, occurred_at FROM link_events WHERE player_uuid=? AND landmark_id IS NOT NULL AND kind IN ('resident.met','landmark.together') ORDER BY occurred_at DESC LIMIT 1", player_uuid);
    if (!row || !row.landmark_id) return null;
    const place = [...this.atlas.places.values()].find((item) => item.landmark_id === row.landmark_id) || null;
    return { landmark_id: row.landmark_id, at: row.occurred_at, place };
  }

  // ---- commands ------------------------------------------------------------------------------

  #issue(kind, { player_uuid, place_id, mode }, issuedBy) {
    if (!ATLAS_COMMAND_KINDS.includes(kind)) fail(500, 'Unknown atlas command.');
    const args = kind === 'teleport'
      ? { place_id, m: this.atlas.manifest_hash.slice(0, 16) }
      : kind === 'atlas_look' ? { mode, m: this.atlas.manifest_hash.slice(0, 16) }
        : { place_id, m: this.atlas.manifest_hash.slice(0, 16) };
    const command = this.link.issueCommand({ kind, player_uuid, args, ttl_ms: this.policy.command_ttl_ms, issuedBy });
    this.sql.run('INSERT INTO atlas_commands(cmd_id,kind,player_uuid,place_id,issued_at,expires_at) VALUES(?,?,?,?,?,?)',
      command.cmd_id, kind, player_uuid, place_id ?? '', command.issued_at, command.expires_at);
    return command;
  }

  #outcome(cmd_id, player_uuid) {
    const acks = this.sql.all("SELECT kind,player_uuid FROM link_events WHERE landmark_id=? AND kind IN ('command.applied','command.rejected')", cmd_id);
    if (acks.some((ack) => ack.kind === 'command.applied' && ack.player_uuid === player_uuid)) return 'applied';
    if (acks.some((ack) => ack.kind === 'command.rejected' && ack.player_uuid === player_uuid)) return 'rejected';
    const row = this.sql.get('SELECT expires_at FROM atlas_commands WHERE cmd_id=?', cmd_id);
    return row && row.expires_at < this.now ? 'expired_unconfirmed' : 'pending';
  }

  /** What NemoWorld has asked of the world for this player and place: none | travelling | arrived | failed | unconfirmed. */
  travelState(player_uuid, place_id) {
    const rows = this.sql.all("SELECT cmd_id FROM atlas_commands WHERE kind='teleport' AND player_uuid=? AND place_id=? ORDER BY issued_at", player_uuid, place_id);
    if (!rows.length) return { status: 'none', attempts: 0 };
    const outcomes = rows.map((row) => this.#outcome(row.cmd_id, player_uuid));
    if (outcomes.includes('applied')) return { status: 'arrived', attempts: rows.length, cmd_id: rows[outcomes.indexOf('applied')].cmd_id };
    const last = outcomes[outcomes.length - 1];
    return { status: last === 'rejected' ? 'failed' : last === 'pending' ? 'travelling' : 'unconfirmed', attempts: rows.length, cmd_id: rows[rows.length - 1].cmd_id };
  }

  // ---- notices -------------------------------------------------------------------------------

  #notice(player_uuid, text, dedupe) {
    this.sql.run('INSERT OR IGNORE INTO atlas_notices(id,player_uuid,text,created_at,expires_at,dedupe) VALUES(?,?,?,?,?,?)',
      randomUUID(), player_uuid, cleanLine(text, 400), this.now, this.now + this.policy.notice_ttl_ms, dedupe);
  }

  notices() {
    for (const row of this.sql.all("SELECT DISTINCT place_id, player_uuid FROM atlas_commands WHERE kind='teleport'")) {
      const place = this.atlas.places.get(row.place_id);
      const state = this.travelState(row.player_uuid, row.place_id);
      if (state.status === 'arrived') this.#notice(row.player_uuid, `You are at ${place?.name || row.place_id}. Look around.`, `arrived:${row.place_id}:${state.cmd_id}`);
      else if (state.status === 'failed') this.#notice(row.player_uuid, `The world would not take you to ${place?.name || row.place_id}. Ask me where you can go.`, `failed:${row.place_id}:${state.cmd_id}`);
    }
    return this.sql.all('SELECT id,player_uuid,text FROM atlas_notices WHERE delivered_at IS NULL AND expires_at>? ORDER BY created_at LIMIT ?', this.now, this.policy.notices_per_poll);
  }

  ackNotices(ids) {
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !UUID.test(id))) fail(400, 'Send up to 50 notice ids.');
    let n = 0;
    for (const id of ids) n += Number(this.sql.run('UPDATE atlas_notices SET delivered_at=? WHERE id=? AND delivered_at IS NULL', this.now, id).changes);
    return { acknowledged: n };
  }

  // ---- what the keeper says ------------------------------------------------------------------

  #mayAsk(player_uuid) {
    const last = this.sql.get('SELECT last_at FROM atlas_asks WHERE player_uuid=?', player_uuid);
    if (last && this.now - last.last_at < this.policy.ask_gap_ms) fail(429, 'Please wait a moment before asking again.');
    this.sql.run('INSERT INTO atlas_asks(player_uuid,last_at) VALUES(?,?) ON CONFLICT(player_uuid) DO UPDATE SET last_at=excluded.last_at', player_uuid, this.now);
  }

  #wrap(line) {
    const max = this.policy.line_chars;
    if (line.length <= max) return [line];
    const out = [];
    let current = '';
    for (const word of line.split(' ')) {
      if (current && current.length + 1 + word.length > max) { out.push(current); current = word; }
      else current = current ? `${current} ${word}` : word;
    }
    if (current) out.push(current);
    return out;
  }

  ask(credential, input) {
    if (!ATLAS_KEEPERS.includes(credential.resident_id)) fail(403, 'This credential does not belong to the atlas keeper.');
    const allowed = ['resident_id', 'player_uuid', 'player_alias', 'text'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) fail(400, 'Unexpected field in the request.');
    if (input.resident_id !== credential.resident_id) fail(403, 'This credential is scoped to another resident.');
    if (typeof input.player_uuid !== 'string' || !UUID.test(input.player_uuid)) fail(400, 'A Veloren player id is required.');
    const text = cleanLine(input.text, this.policy.ask_chars);
    if (!text) fail(400, 'Say something.');
    this.#mayAsk(input.player_uuid);
    const answer = this.#answer(parseIntent(text, this.atlas), input.player_uuid);
    const lines = answer.lines.flatMap((line) => this.#wrap(line)).slice(0, this.policy.reply_lines);
    return { resident_id: credential.resident_id, source: 'scripted', intent: answer.intent, lines, reply: lines.join(' ') };
  }

  #answer(intent, player_uuid) {
    const who = this.linked(player_uuid);
    if (!who) return { intent: intent.intent, lines: ['I keep the map. Link your Veloren character to a NemoWorld account first: say to Lyra "link my account". Then I can travel with you.'] };
    const seen = this.lastSeen(player_uuid);
    switch (intent.intent) {
      case 'list': {
        const names = [...this.atlas.places.values()].slice(0, 8).map((place) => place.name).join(', ');
        return { intent: 'list', lines: [`I can take you to ${plural(this.atlas.places.size, 'place')}: ${names}.`, 'Say travel to a place, and I will ask the world to move you there.'] };
      }
      case 'where': {
        if (intent.place) {
          const place = intent.place;
          const state = this.travelState(player_uuid, place.id);
          return { intent: 'where', lines: [`${place.name}: ${place.short}`, `It is a ${place.kind} at ${place.site}${place.plot ? ` (${place.plot})` : ''}.`, state.status === 'arrived' ? 'You have travelled there.' : 'Say travel to it and I will ask the world to move you.'] };
        }
        return { intent: 'where', lines: [seen ? `The last place the world saw you at is ${seen.place?.name || seen.landmark_id}.` : 'The world has not seen you at any of our places yet. Stand beside a resident for a moment, or travel to a place you know.', 'I only repeat what the game server signed; I cannot see a player who has never been observed here.'] };
      }
      case 'near': {
        const landmark = seen?.landmark_id;
        const near = [...this.atlas.places.values()].filter((place) => place.landmark_id && place.landmark_id === landmark).concat(
          seen?.place ? [] : [...this.atlas.places.values()].filter((place) => place.site === (seen?.place?.site)) );
        if (!near.length) return { intent: 'near', lines: ['I do not know what is near you: the world has not signed a landmark for you yet.', 'Say travel to a place, or stand beside a resident and ask again.'] };
        return { intent: 'near', lines: [`Near ${seen?.place?.name || landmark}: ${near.slice(0, 4).map((place) => place.name).join(', ')}.`, 'Say travel to a place and I will ask the world to move you there.'] };
      }
      case 'travel': {
        if (!intent.place) return { intent: 'travel', lines: [`I do not know "${intent.unknown || 'that'}" as a place. Say places to hear where I can take you.`] };
        const place = intent.place;
        const state = this.travelState(player_uuid, place.id);
        if (state.status === 'travelling') return { intent: 'travel', lines: [`I have already asked the world to take you to ${place.name}; I will tell you when the world confirms.`] };
        const last = this.sql.get("SELECT issued_at FROM atlas_commands WHERE kind='teleport' AND player_uuid=? ORDER BY issued_at DESC LIMIT 1", player_uuid);
        if (last && this.now - last.issued_at < this.policy.teleport_gap_ms) fail(429, 'You have travelled very recently; give it a moment.');
        this.#issue('teleport', { player_uuid, place_id: place.id }, `atlas:${who.account_id}`.slice(0, 60));
        return { intent: 'travel', lines: [`Asking the world to take you to ${place.name} at ${place.site}${place.plot ? ` (${place.plot})` : ''}.`, 'I will only say you have arrived when the world confirms it.'] };
      }
      default:
        return { intent: 'help', lines: ['I am Vaelen, the keeper of the map. Say: where am I, what is near me, places, or travel to <a place>.', 'Travel is a signed request to the game server: it moves only you, only to a place on the map, and only when it confirms.'] };
    }
  }

  /** The player's own view, for tests and a future page. Read-only. */
  view(player_uuid) {
    const who = this.linked(player_uuid);
    if (!who) return { linked: false };
    const seen = this.lastSeen(player_uuid);
    return { linked: true, at: seen?.place?.id || null, landmark_id: seen?.landmark_id || null, places: [...this.atlas.places.keys()] };
  }
}

// ---- the extension -----------------------------------------------------------------------------

const SCHEMA = {
  version: 1,
  sql: `
    CREATE TABLE atlas_asks(player_uuid TEXT PRIMARY KEY, last_at INTEGER NOT NULL);
    CREATE TABLE atlas_commands(
      cmd_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('teleport','atlas_look','atlas_mark')),
      player_uuid TEXT NOT NULL, place_id TEXT NOT NULL DEFAULT '', issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX atlas_commands_player ON atlas_commands(player_uuid, kind);
    CREATE TABLE atlas_notices(
      id TEXT PRIMARY KEY, player_uuid TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, delivered_at INTEGER, dedupe TEXT NOT NULL UNIQUE);`,
};

const services = new WeakMap();
const serviceFor = (link, platform) => {
  let service = services.get(link);
  if (!service || service.platform !== platform) { service = new AtlasService(link, platform); services.set(link, service); }
  return service;
};

export default {
  name: 'atlas',
  schema: SCHEMA,
  async handle(link, ctx) {
    const { route, request, response, json, body, platform } = ctx;
    if (!route.startsWith('/veloren/atlas')) return false;
    if (!platform) fail(503, 'The atlas needs the NemoWorld platform.');
    const atlas = serviceFor(link, platform);
    const keeper = () => {
      const credential = link.authenticate(ctx.tokenFrom(request), 'director');
      if (!ATLAS_KEEPERS.includes(credential.resident_id)) fail(403, 'Only the atlas keeper may answer for travel.');
      return credential;
    };
    const method = request.method;
    // The map itself: the places NemoWorld will name in a command. No player data at all.
    if (method === 'GET' && route === '/veloren/atlas') {
      keeper();
      json(response, 200, { format: atlas.atlas.format, manifest_hash: atlas.atlas.manifest_hash, world_seed: atlas.atlas.world_seed, source: atlas.atlas.source, places: [...atlas.atlas.places.values()] });
      return true;
    }
    if (method === 'POST' && route === '/veloren/atlas/ask') { json(response, 200, atlas.ask(keeper(), await body(request))); return true; }
    if (method === 'GET' && route === '/veloren/atlas/notices') { keeper(); json(response, 200, { notices: atlas.notices() }); return true; }
    if (method === 'POST' && route === '/veloren/atlas/notices/ack') { keeper(); json(response, 200, atlas.ackNotices((await body(request)).ids)); return true; }
    return false;
  },
};
