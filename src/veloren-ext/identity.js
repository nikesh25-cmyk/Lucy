import { createHmac, randomInt } from 'node:crypto';

// Contract: who is this Veloren player in NemoWorld? Owned by the link stream; every other feature only
// imports `identityFor` (and, to refuse an unlinked player, `requireIdentity`).
//
//   identityFor(link, player_uuid) -> { account_id, agent_id, display_name } | null
//
// `player_uuid` must come from the Veloren server (a signed event, or the server's own player list in
// the bridge), never from what a player says. `agent_id` is the account's human avatar (or null if the
// account has none yet). `null` means "not linked": the caller must refuse, not guess.
//
// ---- How an account gets linked --------------------------------------------------------------------
//
//   1. In game, the player tells Lyra "link my account". The bridge reads WHO spoke from the server's
//      player list (not from the text) and asks us for a one-time code (link credential, scope director).
//   2. The bridge delivers the code to that player with Veloren's private /tell. Nothing public.
//   3. The player, signed in to NemoWorld as a human (cookie or operator session, same-origin only),
//      enters the code. The code is proof that the signed-in person controls that Veloren character.
//   4. We store the link. A bot, a runtime credential or a link credential can never redeem a code.
//
// Rules this module enforces:
//   * A code is 10 symbols from a 30-symbol alphabet without look-alikes (about 49 bits), single use,
//     valid for 10 minutes, and kept only as an HMAC (keyed with the event key), so a copy of the
//     database cannot be used to guess or read codes. A new code replaces the player's previous one.
//   * Redeeming is rate limited per account, per network peer and globally (failures only), issuing is
//     limited per player and per bridge credential.
//   * One Veloren player maps to at most one NemoWorld account and the reverse. To change a link, remove
//     it first (in game: "unlink"; in NemoWorld: the Remove button). We never silently replace a link.
//   * A code that is spoken in public chat is cancelled by the bridge (`/veloren/identity/leaked`).

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 8 digits and 22 letters; no 0, 1, O, I, L, U (look-alikes). 30^10 is about 5.9e14, which is 49 bits.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{10}$`);

export const IDENTITY_POLICY = Object.freeze({
  code_length: 10,
  code_ttl_ms: 10 * 60_000,
  redeem_path: '/veloren-link',
  // Issuing (bridge): per player and per bridge credential.
  issue_player_gap_ms: 15_000,
  issue_player: Object.freeze({ window_ms: 10 * 60_000, max: 3 }),
  issue_source: Object.freeze({ window_ms: 60 * 60_000, max: 120 }),
  // Redeeming and checking (human): failures only, so a legitimate user is never throttled by success.
  fail_account: Object.freeze({ window_ms: 10 * 60_000, max: 8 }),
  fail_peer: Object.freeze({ window_ms: 10 * 60_000, max: 40 }),
  fail_global: Object.freeze({ window_ms: 10 * 60_000, max: 200 }),
  keep_codes_ms: 24 * 3_600_000,
  notice_ttl_ms: 10 * 60_000,
  notice_batch: 10,
  alias_chars: 32,
});

export const IDENTITY_SCHEMA = Object.freeze({
  version: 1,
  sql: `
    CREATE TABLE ident_links(
      player_uuid TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE,
      alias TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      linked_at INTEGER NOT NULL);
    CREATE TABLE ident_codes(
      code_hash TEXT PRIMARY KEY,
      player_uuid TEXT NOT NULL,
      alias TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      issued_by TEXT NOT NULL,
      used_at INTEGER,
      used_by TEXT,
      revoked_at INTEGER,
      revoked_reason TEXT);
    CREATE INDEX ident_codes_player ON ident_codes(player_uuid);
    CREATE TABLE ident_attempts(bucket TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX ident_attempts_bucket ON ident_attempts(bucket, at);
    CREATE TABLE ident_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      player_uuid TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL);
    CREATE TABLE ident_notices(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_uuid TEXT NOT NULL,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      delivered_at INTEGER);`,
});

// ---- text and code helpers ---------------------------------------------------------------------

// A Veloren server started without account checks accepts any text as a player name, so a name can carry
// control characters, direction overrides or markup. Names are only ever displayed as text, but they are
// cleaned anyway so a name can never spoof the confirmation a human reads or break a log line.
export function cleanAlias(value) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, IDENTITY_POLICY.alias_chars).join('').trim();
}

export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 32) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

export const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

// randomInt draws without modulo bias.
export function generateCode() {
  let code = '';
  for (let i = 0; i < IDENTITY_POLICY.code_length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// Keyed with the event key and domain separated from event signatures (those start with the digit "1").
const codeHash = (link, code) => createHmac('sha256', link.eventKey).update(`veloren-identity-code-v1\n${code}`).digest('hex');

const refusal = (status, reason, message, extra = {}) => Object.assign(new Error(message), { status, reason, extra });

// ---- the contract: identityFor -----------------------------------------------------------------

function missingTable(error) { return /no such table/i.test(error?.message || ''); }

function readLink(link, player_uuid) {
  try { return link.sql.get('SELECT player_uuid,account_id,alias,display_name,linked_at FROM ident_links WHERE player_uuid=?', player_uuid) || null; }
  catch (error) { if (missingTable(error)) return null; throw error; }
}

function readLinkOfAccount(link, account_id) {
  try { return link.sql.get('SELECT player_uuid,account_id,alias,display_name,linked_at FROM ident_links WHERE account_id=?', account_id) || null; }
  catch (error) { if (missingTable(error)) return null; throw error; }
}

// Resolve a stored link against the live account. An account that no longer exists, was deleted or is
// suspended resolves to nothing, so features stop working for it at once.
function resolve(link, row) {
  const platform = link.platform;
  if (!platform) return { account_id: row.account_id, agent_id: null, display_name: row.display_name || 'Player', live: false };
  const account = platform.get('SELECT id,name,status FROM accounts WHERE id=?', row.account_id);
  if (!account || account.status !== 'active') return null;
  const avatar = platform.get("SELECT id,name FROM agents WHERE operator_id=? AND kind='human' AND status!='deleted' ORDER BY created_at LIMIT 1", account.id);
  return { account_id: account.id, agent_id: avatar?.id ?? null, display_name: cleanAlias(avatar?.name || account.name) || 'Player', live: true };
}

function realProvider(link, player_uuid) {
  if (typeof player_uuid !== 'string' || !UUID.test(player_uuid)) return null;
  const row = readLink(link, player_uuid);
  if (!row) return null;
  const who = resolve(link, row);
  return who ? { account_id: who.account_id, agent_id: who.agent_id, display_name: who.display_name } : null;
}

let provider = realProvider;
// Tests of other features install a fake; `setIdentityProvider(null)` restores the real one.
export function setIdentityProvider(fn) { provider = typeof fn === 'function' ? fn : realProvider; }
export function identityFor(link, player_uuid) { return provider(link, player_uuid); }

// For features that need a linked player: returns the identity or refuses with 403 `not_linked`.
export function requireIdentity(link, player_uuid) {
  const who = identityFor(link, player_uuid);
  if (!who) throw refusal(403, 'not_linked', 'Link your NemoWorld account first: tell Lyra "link my account" in game.');
  return who;
}

// ---- rate limits -------------------------------------------------------------------------------

function windowed(link, bucket, window_ms) {
  const now = link.clock();
  return link.sql.get('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM ident_attempts WHERE bucket=? AND at>?', bucket, now - window_ms);
}

function limited(link, bucket, rule) {
  const row = windowed(link, bucket, rule.window_ms);
  if (row.n < rule.max) return null;
  return Math.max(1, Math.ceil((row.oldest + rule.window_ms - link.clock()) / 1000));
}

function guard(link, bucket, rule) {
  const wait = limited(link, bucket, rule);
  if (wait !== null) throw refusal(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.', { retry_after_s: wait });
}

const hit = (link, bucket) => link.sql.run('INSERT INTO ident_attempts(bucket,at) VALUES(?,?)', bucket, link.clock());

function prune(link) {
  const now = link.clock();
  link.sql.run('DELETE FROM ident_attempts WHERE at<?', now - 2 * 3_600_000);
  link.sql.run('DELETE FROM ident_codes WHERE expires_at<?', now - IDENTITY_POLICY.keep_codes_ms);
  link.sql.run('DELETE FROM ident_notices WHERE created_at<?', now - 3_600_000);
}

// A private message the bridge delivers in game ("you are now linked", "your link was removed in
// NemoWorld"). Only a fixed kind and a cleaned display name travel; the bridge writes the words.
function notify(link, player_uuid, kind, display_name = '') {
  link.sql.run('INSERT INTO ident_notices(player_uuid,kind,display_name,created_at) VALUES(?,?,?,?)', player_uuid, kind, cleanAlias(display_name), link.clock());
}

// Handed over once each; a notice nobody collected within ten minutes is dropped.
export function takeNotices(link) {
  const now = link.clock();
  return link.sql.tx(() => {
    const rows = link.sql.all('SELECT id,player_uuid,kind,display_name FROM ident_notices WHERE delivered_at IS NULL AND created_at>? ORDER BY id LIMIT ?', now - IDENTITY_POLICY.notice_ttl_ms, IDENTITY_POLICY.notice_batch);
    for (const row of rows) link.sql.run('UPDATE ident_notices SET delivered_at=? WHERE id=?', now, row.id);
    return rows.map((row) => ({ id: row.id, player_uuid: row.player_uuid, kind: row.kind, display_name: row.display_name }));
  });
}

// ---- operations --------------------------------------------------------------------------------

function history(link, event, player_uuid, account_id = '') {
  link.sql.run('INSERT INTO ident_history(event,player_uuid,account_id,at) VALUES(?,?,?,?)', event, player_uuid, account_id, link.clock());
}

// Drop a link whose account is gone, so the player can link again.
function purgeDead(link, row) {
  if (!row || !link.platform || resolve(link, row)) return row;
  link.sql.run('DELETE FROM ident_links WHERE player_uuid=?', row.player_uuid);
  history(link, 'dead_link_removed', row.player_uuid, row.account_id);
  return null;
}

export function issueCode(link, { player_uuid, player_alias, source }) {
  if (typeof player_uuid !== 'string' || !UUID.test(player_uuid)) throw refusal(400, 'bad_player', 'A Veloren player id is required.');
  const alias = cleanAlias(player_alias) || 'player';
  const now = link.clock();
  prune(link);
  const existing = purgeDead(link, readLink(link, player_uuid));
  if (existing) throw refusal(409, 'already_linked', 'This Veloren player is already linked to a NemoWorld account. Say "unlink" first to link a different account.');

  const last = link.sql.get("SELECT MAX(at) AS at FROM ident_attempts WHERE bucket=?", `issue:p:${player_uuid}`);
  if (last?.at && now - last.at < IDENTITY_POLICY.issue_player_gap_ms) {
    throw refusal(429, 'rate_limited', 'A code was just sent. Wait a few seconds before asking again.', { retry_after_s: Math.ceil((last.at + IDENTITY_POLICY.issue_player_gap_ms - now) / 1000) });
  }
  guard(link, `issue:p:${player_uuid}`, IDENTITY_POLICY.issue_player);
  guard(link, `issue:s:${source}`, IDENTITY_POLICY.issue_source);

  const code = link.sql.tx(() => {
    link.sql.run("UPDATE ident_codes SET revoked_at=?, revoked_reason='superseded' WHERE player_uuid=? AND used_at IS NULL AND revoked_at IS NULL", now, player_uuid);
    let candidate;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      candidate = generateCode();
      const inserted = link.sql.run('INSERT OR IGNORE INTO ident_codes(code_hash,player_uuid,alias,issued_at,expires_at,issued_by) VALUES(?,?,?,?,?,?)',
        codeHash(link, candidate), player_uuid, alias, now, now + IDENTITY_POLICY.code_ttl_ms, String(source).slice(0, 40));
      if (Number(inserted.changes) === 1) break;
      candidate = null;
    }
    if (!candidate) throw refusal(503, 'try_again', 'Could not create a code; try again.');
    hit(link, `issue:p:${player_uuid}`);
    hit(link, `issue:s:${source}`);
    history(link, 'code_issued', player_uuid);
    return candidate;
  });
  return { code: formatCode(code), expires_at: now + IDENTITY_POLICY.code_ttl_ms, expires_in_s: IDENTITY_POLICY.code_ttl_ms / 1000, redeem_path: IDENTITY_POLICY.redeem_path, player_alias: alias };
}

// Reading a code is the same for `check` and `redeem`; every failure counts against the limits.
function openCode(link, input, peer, account_id) {
  const now = link.clock();
  guard(link, `fail:a:${account_id}`, IDENTITY_POLICY.fail_account);
  guard(link, `fail:i:${peer}`, IDENTITY_POLICY.fail_peer);
  guard(link, 'fail:g', IDENTITY_POLICY.fail_global);
  const normalized = normalizeCode(input);
  const row = normalized ? link.sql.get('SELECT * FROM ident_codes WHERE code_hash=?', codeHash(link, normalized)) : null;
  if (!row || row.used_at || row.revoked_at || row.expires_at <= now) {
    hit(link, `fail:a:${account_id}`); hit(link, `fail:i:${peer}`); hit(link, 'fail:g');
    throw refusal(400, 'invalid_code', 'That code is not valid. A code works once and expires after 10 minutes. Ask Lyra in game for a new one.');
  }
  return row;
}

export function checkCode(link, { code, account_id, peer }) {
  const row = openCode(link, code, peer, account_id);
  return { valid: true, player_alias: row.alias, expires_at: row.expires_at };
}

export function redeemCode(link, { code, expect_alias, account_id, peer }) {
  const row = openCode(link, code, peer, account_id);
  if (typeof expect_alias !== 'string' || expect_alias !== row.alias) {
    throw refusal(400, 'alias_mismatch', 'Check the code first, so you can see which Veloren character it links.', { player_alias: row.alias });
  }
  const platform = link.platform;
  const account = platform?.get('SELECT id,name,status FROM accounts WHERE id=?', account_id);
  if (platform && (!account || account.status !== 'active')) throw refusal(403, 'inactive_account', 'This account cannot be linked.');
  const avatar = platform?.get("SELECT name FROM agents WHERE operator_id=? AND kind='human' AND status!='deleted' ORDER BY created_at LIMIT 1", account_id);
  const display = cleanAlias(avatar?.name || account?.name || '') || 'Player';

  const now = link.clock();
  link.sql.tx(() => {
    const fresh = link.sql.get('SELECT used_at, revoked_at FROM ident_codes WHERE code_hash=?', row.code_hash);
    if (!fresh || fresh.used_at || fresh.revoked_at) throw refusal(400, 'invalid_code', 'That code is not valid. A code works once and expires after 10 minutes. Ask Lyra in game for a new one.');
    if (purgeDead(link, readLink(link, row.player_uuid))) {
      throw refusal(409, 'already_linked', 'That Veloren character is already linked to a NemoWorld account.');
    }
    if (purgeDead(link, readLinkOfAccount(link, account_id))) {
      throw refusal(409, 'account_has_link', 'Your account is already linked to a Veloren character. Remove that link first.');
    }
    link.sql.run('INSERT INTO ident_links(player_uuid,account_id,alias,display_name,linked_at) VALUES(?,?,?,?,?)', row.player_uuid, account_id, row.alias, display, now);
    link.sql.run('UPDATE ident_codes SET used_at=?, used_by=? WHERE code_hash=?', now, account_id, row.code_hash);
    link.sql.run("UPDATE ident_codes SET revoked_at=?, revoked_reason='linked' WHERE player_uuid=? AND used_at IS NULL AND revoked_at IS NULL", now, row.player_uuid);
    history(link, 'linked', row.player_uuid, account_id);
    notify(link, row.player_uuid, 'linked', display);
  });
  try { platform?.audit(account_id, 'veloren.linked', row.player_uuid); } catch { /* the link stands; the audit chain is best effort here */ }
  return { linked: true, player_uuid: row.player_uuid, player_alias: row.alias, display_name: display, linked_at: now };
}

// Used by the bridge when a code is spoken in public chat. Returns whether an active code was cancelled.
export function cancelLeakedCode(link, input) {
  const code = normalizeCode(input);
  if (!code) return { revoked: false };
  const now = link.clock();
  const result = link.sql.run("UPDATE ident_codes SET revoked_at=?, revoked_reason='spoken_in_chat' WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL", now, codeHash(link, code));
  if (Number(result.changes) === 1) history(link, 'code_cancelled_leak', '');
  return { revoked: Number(result.changes) === 1 };
}

function removeLink(link, row, who) {
  const now = link.clock();
  link.sql.tx(() => {
    link.sql.run('DELETE FROM ident_links WHERE player_uuid=?', row.player_uuid);
    link.sql.run("UPDATE ident_codes SET revoked_at=?, revoked_reason='unlinked' WHERE player_uuid=? AND used_at IS NULL AND revoked_at IS NULL", now, row.player_uuid);
    history(link, who === 'player' ? 'unlinked_by_player' : 'unlinked_by_account', row.player_uuid, row.account_id);
    // The player who unlinks in game is answered directly; one removed in NemoWorld is told in game.
    if (who !== 'player') notify(link, row.player_uuid, 'unlinked_in_nemoworld');
  });
  try { link.platform?.audit(row.account_id, 'veloren.unlinked', row.player_uuid); } catch { /* best effort */ }
}

export function unlinkPlayer(link, player_uuid) {
  if (typeof player_uuid !== 'string' || !UUID.test(player_uuid)) throw refusal(400, 'bad_player', 'A Veloren player id is required.');
  const row = readLink(link, player_uuid);
  if (!row) return { unlinked: false };
  removeLink(link, row, 'player');
  return { unlinked: true };
}

export function unlinkAccount(link, account_id) {
  const row = readLinkOfAccount(link, account_id);
  if (!row) return { removed: false };
  removeLink(link, row, 'account');
  return { removed: true };
}

// ---- HTTP --------------------------------------------------------------------------------------

function humanSession(ctx, { write = false } = {}) {
  const { platform } = ctx;
  if (!platform) throw refusal(503, 'unavailable', 'Accounts are not available here.');
  const actor = platform.authenticate(ctx.tokenFrom(ctx.request));
  // Only a signed-in person. A runtime credential belongs to an AI character and may never link or unlink.
  if (actor.kind !== 'session') throw refusal(403, 'human_required', 'A signed-in human operator session is required.');
  if (write) platform.active();
  return actor;
}

const peerOf = (request) => String(request.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '').slice(0, 64);

function describe(row, who) {
  return { linked: true, player_uuid: row.player_uuid, player_alias: row.alias, display_name: who?.display_name ?? row.display_name, linked_at: row.linked_at };
}

async function route(link, ctx) {
  const { request, response, url, json } = ctx;
  const key = `${request.method} ${ctx.route}`;
  const reply = (status, value) => { json(response, status, value); return true; };
  const bridge = () => link.authenticate(ctx.tokenFrom(request), 'director');

  // ---- bridge (link credential with the director scope) ----
  if (key === 'GET /veloren/identity') {
    bridge();
    const player = url.searchParams.get('player_uuid') || '';
    if (!UUID.test(player)) throw refusal(400, 'bad_player', 'A Veloren player id is required.');
    const who = identityFor(link, player);
    if (!who) return reply(200, { linked: false });
    return reply(200, { linked: true, ...who });
  }
  if (key === 'POST /veloren/identity/code') {
    const credential = bridge();
    const input = await ctx.body(request);
    return reply(200, issueCode(link, { player_uuid: input.player_uuid, player_alias: input.player_alias, source: credential.key_id }));
  }
  if (key === 'POST /veloren/identity/unlink') {
    bridge();
    const input = await ctx.body(request);
    return reply(200, unlinkPlayer(link, input.player_uuid));
  }
  if (key === 'GET /veloren/identity/notices') {
    bridge();
    return reply(200, { notices: takeNotices(link) });
  }
  if (key === 'POST /veloren/identity/leaked') {
    bridge();
    const input = await ctx.body(request);
    return reply(200, cancelLeakedCode(link, input.code));
  }

  // ---- the signed-in human ----
  if (key === 'GET /veloren/identity/me') {
    const actor = humanSession(ctx);
    const row = readLinkOfAccount(link, actor.account.id);
    if (!row) return reply(200, { linked: false });
    return reply(200, describe(row, resolve(link, row)));
  }
  if (key === 'POST /veloren/identity/check') {
    const actor = humanSession(ctx, { write: true });
    const input = await ctx.body(request);
    return reply(200, checkCode(link, { code: input.code, account_id: actor.account.id, peer: peerOf(request) }));
  }
  if (key === 'POST /veloren/identity/redeem') {
    const actor = humanSession(ctx, { write: true });
    const input = await ctx.body(request);
    return reply(200, redeemCode(link, { code: input.code, expect_alias: input.expect_alias, account_id: actor.account.id, peer: peerOf(request) }));
  }
  if (key === 'POST /veloren/identity/remove') {
    const actor = humanSession(ctx, { write: true });
    await ctx.body(request);
    return reply(200, unlinkAccount(link, actor.account.id));
  }
  if (key === 'GET /veloren/identity/progress') {
    const actor = humanSession(ctx);
    const row = readLinkOfAccount(link, actor.account.id);
    if (!row || !resolve(link, row)) throw refusal(404, 'not_linked', 'No Veloren character is linked to this account.');
    const notes = link.sql.all('SELECT note,created_at FROM resident_notes WHERE player_uuid=? ORDER BY id', row.player_uuid);
    return reply(200, { player_alias: row.alias, progress: link.progress(row.player_uuid), notes });
  }
  return false;
}

export const identityExtension = {
  name: 'identity',
  schema: IDENTITY_SCHEMA,
  async handle(link, ctx) {
    if (ctx.route !== '/veloren/identity' && !ctx.route.startsWith('/veloren/identity/')) return false;
    try {
      const handled = await route(link, ctx);
      if (handled === true) return true;
      ctx.json(ctx.response, 404, { error: 'Not found.' });
      return true;
    } catch (error) {
      if (!error.reason) throw error;
      if (error.extra?.retry_after_s) ctx.response.setHeader('Retry-After', String(error.extra.retry_after_s));
      ctx.json(ctx.response, error.status, { error: error.message, reason: error.reason, ...(error.extra || {}) });
      return true;
    }
  },
};
