import { randomUUID } from 'node:crypto';
import { identityFor } from './identity.js';
import { nativeHomePlot, groundReport, defaultPlotsPath } from './home-site.js';

// Cottages and the vault, as a Veloren link extension: the in-game side of "a claimed plot with a
// cottage the player can enter".
//
// The keeper resident (Rowan Commonreach, `lw-rowan`) answers a linked player's short commands and asks
// the Veloren server to build or enter their cottage with a signed `home_*` command. What he may do is
// deliberately narrow, and every rule that matters already exists in NemoWorld:
//
//   * the PLOT is NemoWorld's own land record. `platform.land({mine})` names it, and `platform.landAssign`
//     (human-only, four assignments per account per UTC day, a pause between them, one plot per operator,
//     no price and no transfer) is the only way a plot is ever claimed. This module never claims, releases
//     or transfers land, and never copies those rules.
//   * ENTRY is the platform's own cottage rule: `platform.space(actor, 'house:<resident>')` refuses a
//     private cottage to anyone but its owner. The owner opens or closes it with the platform's own
//     `homeSettings` (`house_visibility`), in NemoWorld. This module only asks the platform and believes
//     the answer.
//   * the VAULT is never read here. `platform.vaultStatus` gives counts and a mode; `vaultRead` (which
//     needs the resident's own `vault` runtime scope) is never called, so no note text can ever reach a
//     game chat. A player is told how many notes they have and that they are read in NemoWorld.
//   * the signed commands name a plot address and a style only. They can never carry a coordinate, an
//     item, a price or another player's id, and the Veloren server decides what a plot's cottage is.
//
// The command channel is the one the link already provides: signed, expiring, allow-listed, claimed once,
// and acknowledged. Nothing here is "done" until the server's own acknowledgement says so.

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLOT = /^plot:-?\d+:-?\d+:\d+:\d+$/;   // sector x and y may be negative, plot x and y may not
const STYLE_MAX = 7;

/** The residents that may answer for cottages. One keeper, one credential. */
export const HOME_KEEPERS = Object.freeze(['lw-rowan']);
/** The resident command kinds this extension owns. */
export const HOME_COMMAND_KINDS = Object.freeze(['home_build', 'home_enter', 'home_leave']);

export const HOME_POLICY = Object.freeze({
  ask_gap_ms: 2_000,
  ask_chars: 300,
  line_chars: 190,
  reply_lines: 4,
  build_gap_ms: 30_000,
  enter_gap_ms: 5_000,
  command_ttl_ms: 60_000,
  build_ttl_ms: 180_000,
  notice_ttl_ms: 15 * 60_000,
  notices_per_poll: 10,
  history_lines: 4,
});

// ---- text ---------------------------------------------------------------------------------------

const cleanLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (value) => ` ${String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const has = (text, words) => words.some((word) => text.includes(` ${word} `));
const NUMBER_WORDS = new Map([['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10]]);
const STYLE_WORDS = new Map([['blue', 0], ['green', 1], ['red', 2], ['gold', 3], ['purple', 4], ['orange', 5], ['grey', 6], ['gray', 6], ['white', 7]]);

/**
 * What a player said, as one of a fixed set of intentions. Pure and deterministic: the words choose
 * among fixed answers and a bounded style number, and nothing else.
 */
export function parseIntent(raw) {
  const text = norm(raw);
  const words = text.trim().split(' ').filter(Boolean);
  let style = null;
  for (const word of words) {
    if (/^\d{1,2}$/.test(word) && Number(word) <= STYLE_MAX) style = Number(word);
    else if (STYLE_WORDS.has(word)) style = STYLE_WORDS.get(word);
  }
  if (has(text, ['notes', 'note', 'vault', 'journal'])) return { intent: 'notes' };
  // Whole phrases only: a bare "in" or "out" would swallow "build my home in style 3".
  if (has(text, ['leave', 'outside', 'goodbye', 'step out', 'get out', 'go out', 'let me out'])) return { intent: 'leave' };
  if (has(text, ['enter', 'inside', 'visit', 'door', 'step in', 'come in', 'go in', 'let me in'])) return { intent: 'enter' };
  if (has(text, ['build', 'cottage', 'house', 'home', 'cabin'])) {
    if (has(text, ['where', 'which', 'address'])) return { intent: 'where' };
    return { intent: 'build', style };
  }
  if (has(text, ['where', 'address', 'plot', 'land'])) return { intent: 'where' };
  return { intent: 'help' };
}

// ---- the service --------------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class HomeService {
  constructor(link, platform, { policy = HOME_POLICY, identity = identityFor, plotsPath = defaultPlotsPath() } = {}) {
    this.link = link;
    this.platform = platform;
    this.policy = policy;
    this.identity = identity;
    this.plotsPath = plotsPath;
    this.sql = link.sql;
  }

  get now() { return this.link.clock(); }

  linked(player_uuid) {
    const found = this.identity(this.link, player_uuid);
    if (!found || typeof found.account_id !== 'string' || typeof found.agent_id !== 'string') return null;
    return { account_id: found.account_id, agent_id: found.agent_id, display_name: String(found.display_name || '') };
  }

  // A READ-ONLY stand-in for the signed-in operator, so the platform's own read rules decide what this
  // module may see. It is never passed to a method that writes.
  #readActor(account_id) {
    const account = this.platform.get('SELECT * FROM accounts WHERE id=?', account_id);
    if (!account || account.status !== 'active') fail(403, 'That NemoWorld account is not active.');
    return Object.freeze({ account, agent: null, kind: 'session', credential: null, readOnly: true });
  }

  /** The account's own plot, exactly as the platform describes it, or null. */
  #mine(account_id) {
    try {
      const land = this.platform.land(this.#readActor(account_id), { mine: '1', limit: 1 });
      return land?.mine || null;
    } catch { return null; }
  }

  #plot(account_id, plot_id) {
    try { return this.platform.landPlot(this.#readActor(account_id), { plot_id }).plot; } catch { return null; }
  }

  /** Is this account allowed into that resident's cottage? The platform's own rule answers. */
  #mayEnter(account_id, agent_id) {
    try { this.platform.space(this.#readActor(account_id), `house:${agent_id}`); return true; } catch { return false; }
  }

  /** Counts only. `vaultRead` is deliberately never called from this module. */
  #vaultNote(account_id, agent_id) {
    const where = 'I cannot read a note here: open NemoWorld to read or write your own notes.';
    try {
      const status = this.platform.vaultStatus(this.#readActor(account_id), { agent_id });
      const notes = Number(status?.notes) || 0;
      if (!status) return `You have no vault here. ${where}`;
      if (!notes) return `Your vault holds no notes yet. ${where}`;
      return `Your vault holds ${plural(notes, 'note')} (${status.bytes || 0} bytes, ${status.mode || 'unnamed'} key). ${where}`;
    } catch {
      return `I cannot read your vault here. ${where}`;
    }
  }

  // ---- the commands ----------------------------------------------------------------------------

  #issue(kind, { player_uuid, plot_id, style, ttl_ms }, issuedBy) {
    if (!HOME_COMMAND_KINDS.includes(kind)) fail(500, 'Unknown home command.');
    if (typeof plot_id !== 'string' || !PLOT.test(plot_id)) fail(400, 'A canonical plot address is required.');
    const args = kind === 'home_build' ? { plot: plot_id, style: Number(style) } : { plot: plot_id };
    if (kind === 'home_build' && (!Number.isInteger(args.style) || args.style < 0 || args.style > STYLE_MAX)) fail(400, 'Choose a roof style from 0 to 7.');
    const command = this.link.issueCommand({ kind, player_uuid, args, ttl_ms, issuedBy });
    this.sql.run('INSERT INTO home_commands(cmd_id,kind,player_uuid,plot_id,issued_at,expires_at) VALUES(?,?,?,?,?,?)',
      command.cmd_id, kind, player_uuid, plot_id, command.issued_at, command.expires_at);
    return command;
  }

  /** The signed acknowledgement for one command, for that player only. */
  #outcome(cmd_id, player_uuid) {
    const acks = this.sql.all("SELECT kind,player_uuid FROM link_events WHERE landmark_id=? AND kind IN ('command.applied','command.rejected')", cmd_id);
    if (acks.some((ack) => ack.kind === 'command.applied' && ack.player_uuid === player_uuid)) return 'applied';
    if (acks.some((ack) => ack.kind === 'command.rejected' && ack.player_uuid === player_uuid)) return 'rejected';
    const row = this.sql.get('SELECT expires_at FROM home_commands WHERE cmd_id=?', cmd_id);
    return row && row.expires_at < this.now ? 'expired_unconfirmed' : 'pending';
  }

  /** What has been asked of the game for this player and plot: none | built | failed | unconfirmed. */
  buildState(plot_id, player_uuid) {
    const rows = this.sql.all("SELECT cmd_id FROM home_commands WHERE kind='home_build' AND plot_id=? AND player_uuid=? ORDER BY issued_at", plot_id, player_uuid);
    if (!rows.length) return { status: 'none', attempts: 0 };
    const outcomes = rows.map((row) => this.#outcome(row.cmd_id, player_uuid));
    if (outcomes.includes('applied')) return { status: 'built', attempts: rows.length, cmd_id: rows[outcomes.indexOf('applied')].cmd_id };
    const last = outcomes[outcomes.length - 1];
    return { status: last === 'rejected' ? 'failed' : last === 'pending' ? 'building' : 'unconfirmed', attempts: rows.length, cmd_id: rows[rows.length - 1].cmd_id, outcomes };
  }

  // ---- notices ---------------------------------------------------------------------------------

  #notice(player_uuid, text, dedupe) {
    this.sql.run('INSERT OR IGNORE INTO home_notices(id,player_uuid,text,created_at,expires_at,dedupe) VALUES(?,?,?,?,?,?)',
      randomUUID(), player_uuid, cleanLine(text, 400), this.now, this.now + this.policy.notice_ttl_ms, dedupe);
  }

  notices() {
    // Tell the player once about anything the game has now answered.
    for (const row of this.sql.all("SELECT DISTINCT plot_id, player_uuid FROM home_commands WHERE kind='home_build'")) {
      const state = this.buildState(row.plot_id, row.player_uuid);
      if (state.status === 'built') this.#notice(row.player_uuid, `Your cottage is built at ${row.plot_id}. Whisper me enter to step inside.`, `built:${row.plot_id}`);
      else if (state.status === 'failed') this.#notice(row.player_uuid, `The world refused to build at ${row.plot_id} (the ground may be too steep or wet). Ask me to build it again.`, `failed:${row.plot_id}:${state.cmd_id}`);
    }
    return this.sql.all('SELECT id,player_uuid,text FROM home_notices WHERE delivered_at IS NULL AND expires_at>? ORDER BY created_at LIMIT ?', this.now, this.policy.notices_per_poll);
  }

  ackNotices(ids) {
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !UUID.test(id))) fail(400, 'Send up to 50 notice ids.');
    let n = 0;
    for (const id of ids) n += Number(this.sql.run('UPDATE home_notices SET delivered_at=? WHERE id=? AND delivered_at IS NULL', this.now, id).changes);
    return { acknowledged: n };
  }

  // ---- what the keeper says --------------------------------------------------------------------

  #mayAsk(player_uuid) {
    const last = this.sql.get('SELECT last_at FROM home_asks WHERE player_uuid=?', player_uuid);
    if (last && this.now - last.last_at < this.policy.ask_gap_ms) fail(429, 'Please wait a moment before asking again.');
    this.sql.run('INSERT INTO home_asks(player_uuid,last_at) VALUES(?,?) ON CONFLICT(player_uuid) DO UPDATE SET last_at=excluded.last_at', player_uuid, this.now);
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
    if (!HOME_KEEPERS.includes(credential.resident_id)) fail(403, 'This credential does not belong to the home keeper.');
    const allowed = ['resident_id', 'player_uuid', 'player_alias', 'text'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) fail(400, 'Unexpected field in the request.');
    if (input.resident_id !== credential.resident_id) fail(403, 'This credential is scoped to another resident.');
    if (typeof input.player_uuid !== 'string' || !UUID.test(input.player_uuid)) fail(400, 'A Veloren player id is required.');
    const text = cleanLine(input.text, this.policy.ask_chars);
    if (!text) fail(400, 'Say something.');
    const alias = cleanLine(input.player_alias || 'traveller', 32) || 'traveller';
    this.#mayAsk(input.player_uuid);
    const answer = this.#answer(parseIntent(text), input.player_uuid);
    const lines = answer.lines.flatMap((line) => this.#wrap(line)).slice(0, this.policy.reply_lines);
    return { resident_id: credential.resident_id, source: 'scripted', intent: answer.intent, lines, reply: lines.join(' ') };
  }

  #answer(intent, player_uuid) {
    const who = this.linked(player_uuid);
    if (!who) {
      return { intent: intent.intent, lines: ['I keep the cottages at Harr. Link your Veloren character to a NemoWorld account first: say to Lyra "link my account". Then I can see your plot.'] };
    }
    const plot = this.#mine(who.account_id);
    switch (intent.intent) {
      case 'notes': return { intent: 'notes', lines: [this.#vaultNote(who.account_id, who.agent_id)] };
      case 'where': {
        if (!plot) return { intent: 'where', lines: ['You do not steward a plot yet. In NemoWorld open Land and claim one available plot; that is the only place a plot is ever claimed. Then whisper me and I will build your cottage there.'] };
        const state = this.buildState(plot.id, player_uuid);
        return { intent: 'where', lines: [`Your plot is ${plot.id} (${plot.state}), ${plot.block_count || 0} blocks on it, purpose: ${plot.purpose || 'none recorded'}.`, state.status === 'built' ? 'Your cottage stands on it. Whisper me enter to step inside.' : 'No cottage is built there yet. Whisper me build my home.'] };
      }
      case 'build': return this.#build(who, plot, player_uuid, intent.style);
      case 'enter': return this.#enter(who, plot, player_uuid);
      case 'leave': return this.#leave(who, plot, player_uuid);
      default:
        return { intent: 'help', lines: ['I am Rowan, the keeper of the cottages. You can say: where is my home, build my home (and a style 0 to 7), enter, leave, or my notes.', 'A plot is claimed in NemoWorld, never here. Your cottage door opens and closes in NemoWorld too.'] };
    }
  }

  #build(who, plot, player_uuid, style) {
    this.platform.active();
    this.#activeAvatar(who);
    if (!plot) return { intent: 'build', lines: ['You do not steward a plot yet. In NemoWorld open Land and claim one available plot, then whisper me again.'] };
    if (!nativeHomePlot(plot.id)) fail(409, 'This plot is outside the native cottage layout. Your claim is preserved; review supported Commons plots in City & my home.');
    if (plot.block_count) fail(409, 'Your plot contains saved construction. It is preserved; no native cottage command was issued.');
    const ground = groundReport(this.plotsPath);
    if (ground.state === 'unavailable') fail(503, 'The game’s plot survey is unavailable. Refresh after the native server starts.');
    if (ground.suitable && ground.suitable.get(plot.id) !== true) fail(409, 'The game’s ground survey marks this plot unsuitable. Your claim is preserved.');
    const state = this.buildState(plot.id, player_uuid);
    if (state.status === 'built') return { intent: 'build', lines: [`Your cottage already stands at ${plot.id}. Whisper me enter to step inside, or leave to step out.`] };
    if (state.status === 'building') return { intent: 'build', lines: ['I have already asked the world to build it; I will tell you when the world confirms.'] };
    const last = this.sql.get("SELECT issued_at FROM home_commands WHERE kind='home_build' AND plot_id=? ORDER BY issued_at DESC LIMIT 1", plot.id);
    if (last && this.now - last.issued_at < this.policy.build_gap_ms) fail(429, 'Please wait a moment before asking me to build again.');
    const chosen = Number.isInteger(style) ? style : 0;
    this.#issue('home_build', { player_uuid, plot_id: plot.id, style: chosen, ttl_ms: this.policy.build_ttl_ms }, `home:${who.account_id}`.slice(0, 60));
    return { intent: 'build', lines: [`I asked the world to build your cottage at ${plot.id} with roof style ${chosen}. I will only say it is built when the world confirms it.`] };
  }

  #enter(who, plot, player_uuid) {
    this.platform.active();
    this.#activeAvatar(who);
    if (!plot) return { intent: 'enter', lines: ['You have no plot, so there is no cottage to enter. Claim one in NemoWorld first.'] };
    const state = this.buildState(plot.id, player_uuid);
    if (state.status !== 'built') return { intent: 'enter', lines: ['No cottage stands there yet. Whisper me build my home first, and wait for my word that the world has built it.'] };
    if (!this.#mayEnter(who.account_id, who.agent_id)) {
      return { intent: 'enter', lines: ['NemoWorld does not allow you into that cottage just now, so nothing was sent to the game. Only its owner opens it, in NemoWorld, with the cottage switch.'] };
    }
    const last = this.sql.get("SELECT issued_at FROM home_commands WHERE kind='home_enter' AND player_uuid=? ORDER BY issued_at DESC LIMIT 1", player_uuid);
    if (last && this.now - last.issued_at < this.policy.enter_gap_ms) fail(429, 'You have just stepped in or out; give it a moment.');
    this.#issue('home_enter', { player_uuid, plot_id: plot.id, ttl_ms: this.policy.command_ttl_ms }, `home:${who.account_id}`.slice(0, 60));
    return { intent: 'enter', lines: ['Asking the world to let you in. If it refuses, you are still outside; nothing was moved without its word.'] };
  }

  #leave(who, plot, player_uuid) {
    if (!plot) return { intent: 'leave', lines: ['You have no plot here.'] };
    const last = this.sql.get("SELECT issued_at FROM home_commands WHERE kind='home_leave' AND player_uuid=? ORDER BY issued_at DESC LIMIT 1", player_uuid);
    if (last && this.now - last.issued_at < this.policy.enter_gap_ms) fail(429, 'You have just stepped in or out; give it a moment.');
    this.#issue('home_leave', { player_uuid, plot_id: plot.id, ttl_ms: this.policy.command_ttl_ms }, `home:${who.account_id}`.slice(0, 60));
    return { intent: 'leave', lines: ['Asking the world to set you down at your doorstep.'] };
  }

  #activeAvatar(who) {
    const avatar = this.platform.get('SELECT status FROM agents WHERE id=? AND operator_id=?', who.agent_id, who.account_id);
    if (!avatar || avatar.status !== 'active') fail(409, 'An active linked avatar is required for new construction or entry. Leaving remains available.');
  }

  /** The player's own view of their cottage, for tests and for a future page. Read-only. */
  view(player_uuid) {
    const who = this.linked(player_uuid);
    if (!who) return { linked: false };
    const plot = this.#mine(who.account_id);
    if (!plot) return { linked: true, plot: null, built: 'none', can_enter: false, vault: 'unread' };
    const state = this.buildState(plot.id, player_uuid);
    return { linked: true, plot: plot.id, state: plot.state, purpose: plot.purpose || '', blocks: plot.block_count || 0, built: state.status, can_enter: state.status === 'built' && this.#mayEnter(who.account_id, who.agent_id) };
  }
}

// ---- the extension ------------------------------------------------------------------------------

const SCHEMA = {
  version: 1,
  sql: `
    CREATE TABLE home_asks(player_uuid TEXT PRIMARY KEY, last_at INTEGER NOT NULL);
    CREATE TABLE home_commands(
      cmd_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('home_build','home_enter','home_leave')),
      player_uuid TEXT NOT NULL, plot_id TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX home_commands_plot ON home_commands(plot_id, kind);
    CREATE TABLE home_notices(
      id TEXT PRIMARY KEY, player_uuid TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, delivered_at INTEGER, dedupe TEXT NOT NULL UNIQUE);`,
};

const services = new WeakMap();
const serviceFor = (link, platform) => {
  let service = services.get(link);
  if (!service || service.platform !== platform) { service = new HomeService(link, platform); services.set(link, service); }
  return service;
};

export default {
  name: 'home',
  schema: SCHEMA,
  async handle(link, ctx) {
    const { route, request, response, json, body, platform } = ctx;
    if (!route.startsWith('/veloren/home/')) return false;
    if (!platform) fail(503, 'The cottage keeper needs the NemoWorld platform.');
    const home = serviceFor(link, platform);
    const keeper = () => {
      const credential = link.authenticate(ctx.tokenFrom(request), 'director');
      if (!HOME_KEEPERS.includes(credential.resident_id)) fail(403, 'Only the home keeper may answer for cottages.');
      return credential;
    };
    const method = request.method;
    if (method === 'POST' && route === '/veloren/home/ask') { json(response, 200, home.ask(keeper(), await body(request))); return true; }
    if (method === 'GET' && route === '/veloren/home/notices') { keeper(); json(response, 200, { notices: home.notices() }); return true; }
    if (method === 'POST' && route === '/veloren/home/notices/ack') { keeper(); json(response, 200, home.ackNotices((await body(request)).ids)); return true; }
    return false;
  },
};
