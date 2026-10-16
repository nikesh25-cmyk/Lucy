import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture, PASSWORD} from './helpers.js';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {
  CODE_ALPHABET, IDENTITY_POLICY, cleanAlias, normalizeCode, generateCode, formatCode,
  identityFor, setIdentityProvider, requireIdentity, issueCode, checkCode, redeemCode, unlinkPlayer, unlinkAccount, cancelLeakedCode,
} from '../src/veloren-ext/identity.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const LANDMARKS = [{id: 'lyra-post', name: 'the Old Library', role: 'post'}, {id: 'lyra-survey', name: 'Mill Hill', role: 'survey'}];
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const MIN = 60_000;

// A world with an account that has a human avatar, a second plain account, and a link database that
// shares the same clock and the real extension list (so the identity tables exist).
async function world(t, {dbPath} = {}) {
  const f = await fixture(t);
  const link = new VelorenLink({dbPath: dbPath || ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: f.clock});
  link.platform = f.platform;
  t.after(() => { try { link.close(); } catch { /* closed by the test */ } });
  const avatar = f.tx('createAgent', f.actor('alice'), {name: 'Alice Walker', kind: 'human', capabilities: 'Walks', limitations: 'Human'});
  const alice = f.actor('alice').account.id;
  const bob = f.actor('bob').account.id;
  const bridge = link.issueCredential({resident_id: 'lw-lyra', scopes: ['talk', 'director'], days: 1});
  const relay = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  return {f, link, avatar, alice, bob, bridge, relay, source: link.authenticate(bridge.token, 'director').key_id,
    issue: (uuid = P1, alias = 'Tester') => issueCode(link, {player_uuid: uuid, player_alias: alias, source: 'bridge-key'}),
    redeem: (account, issued, extra = {}) => redeemCode(link, {code: issued.code, expect_alias: issued.player_alias, account_id: account, peer: '127.0.0.1', ...extra})};
}
const codeOf = (issued) => issued.code;
const refused = (status, reason) => (error) => error.status === status && (reason === undefined || error.reason === reason);

// ---- pure helpers --------------------------------------------------------------------------------

test('codes use an unambiguous alphabet and carry well over 40 bits', () => {
  assert.equal(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length, 'no repeated symbols');
  assert.ok(CODE_ALPHABET.length >= 30);
  for (const ambiguous of '01OILU') assert.equal(CODE_ALPHABET.includes(ambiguous), false, `${ambiguous} is excluded`);
  const bits = IDENTITY_POLICY.code_length * Math.log2(CODE_ALPHABET.length);
  assert.ok(bits >= 40, `entropy ${bits.toFixed(1)} bits`);
  const seen = new Set(), codes = new Set();
  for (let i = 0; i < 3000; i += 1) {
    const code = generateCode();
    assert.match(code, new RegExp(`^[${CODE_ALPHABET}]{10}$`));
    for (const ch of code) seen.add(ch);
    codes.add(code);
  }
  assert.equal(seen.size, CODE_ALPHABET.length, 'every symbol is used');
  assert.equal(codes.size, 3000, 'no collisions in 3000 draws');
  assert.match(formatCode('ABCDEFGHJK'), /^ABCDE-FGHJK$/);
});

test('normalizeCode is forgiving about case and separators and strict about everything else', () => {
  assert.equal(normalizeCode('abcde-fghjk'), 'ABCDEFGHJK');
  assert.equal(normalizeCode(' ABCDE FGHJK '), 'ABCDEFGHJK');
  for (const bad of ['', 'ABCDE-FGHJ', 'ABCDE-FGHJKM', 'ABCDE-FGHJ0', 'ABCDE-FGHJO', 'ABCDE-FGHJI', 'ABCDE-FGHJL', 'ABCDE-FGHJU', null, undefined, 12345, {}, [], 'A'.repeat(500), 'ABCDE-FGHJK\n; DROP'])
    assert.equal(normalizeCode(bad), null, JSON.stringify(bad)?.slice(0, 30));
});

test('player names with control characters, direction overrides or markup are made harmless', () => {
  assert.equal(cleanAlias('Bob\n\r\t\u001b[31mRed'), 'Bob [31mRed');
  assert.equal(cleanAlias('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(cleanAlias('a\u202Eevil\u202C\u200Bname'), 'a evil name');
  assert.equal(cleanAlias('x'.repeat(100)).length, 32);
  assert.equal(cleanAlias('"quoted" & \'single\' `tick` \\slash'), 'quoted single tick slash');
  assert.equal(cleanAlias(null), '');
  assert.equal(cleanAlias({toString: () => 'x'}), '');
  assert.doesNotMatch(cleanAlias('\u0000\u0007\u007f\u0085\u2028name\u2029'), /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
});

// ---- the flow ------------------------------------------------------------------------------------

test('a player links through a code and identityFor returns the account, its human avatar and its name', async t => {
  const w = await world(t);
  assert.equal(identityFor(w.link, P1), null, 'not linked yet');
  const issued = w.issue(P1, 'Tester');
  assert.match(issued.code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/);
  assert.equal(issued.expires_in_s, 600);
  assert.deepEqual(checkCode(w.link, {code: issued.code, account_id: w.alice, peer: 'p'}), {valid: true, player_alias: 'Tester', expires_at: issued.expires_at});
  assert.equal(identityFor(w.link, P1), null, 'checking does not link');
  const result = w.redeem(w.alice, issued);
  assert.equal(result.linked, true);
  assert.deepEqual(identityFor(w.link, P1), {account_id: w.alice, agent_id: w.avatar.id, display_name: 'Alice Walker'});
  assert.equal(identityFor(w.link, P2), null, 'other players stay unlinked');
});

test('a code is only ever stored as a keyed hash', async t => {
  const w = await world(t);
  const issued = w.issue();
  const plain = issued.code.replace('-', '');
  const dump = JSON.stringify(w.link.sql.all('SELECT * FROM ident_codes')) + JSON.stringify(w.link.sql.all('SELECT * FROM ident_history')) + JSON.stringify(w.link.sql.all('SELECT * FROM ident_attempts'));
  assert.equal(dump.includes(plain), false);
  assert.equal(dump.includes(issued.code), false);
  assert.match(w.link.sql.get('SELECT code_hash FROM ident_codes').code_hash, /^[a-f0-9]{64}$/);
  // The hash depends on the secret key: another key cannot recompute it.
  const other = new VelorenLink({dbPath: ':memory:', eventKey: Buffer.from('another-key-another-key-another-1'), landmarks: LANDMARKS});
  t.after(() => other.close());
  other.platform = w.f.platform;
  assert.throws(() => redeemCode(other, {code: issued.code, expect_alias: 'Tester', account_id: w.alice, peer: 'p'}), refused(400, 'invalid_code'));
});

test('replay: a code works once', async t => {
  const w = await world(t);
  const issued = w.issue();
  w.redeem(w.alice, issued);
  assert.throws(() => w.redeem(w.bob, issued), refused(400, 'invalid_code'), 'a second account cannot reuse it');
  unlinkAccount(w.link, w.alice);
  assert.throws(() => w.redeem(w.alice, issued), refused(400, 'invalid_code'), 'even the same account cannot, after unlinking');
  assert.equal(identityFor(w.link, P1), null);
});

test('an expired code is refused, exactly at ten minutes', async t => {
  const w = await world(t);
  const issued = w.issue();
  w.f.advance(IDENTITY_POLICY.code_ttl_ms - 1);
  assert.equal(checkCode(w.link, {code: issued.code, account_id: w.alice, peer: 'p'}).valid, true, 'valid until the last millisecond');
  w.f.advance(1);
  assert.throws(() => w.redeem(w.alice, issued), refused(400, 'invalid_code'));
  assert.equal(identityFor(w.link, P1), null);
});

test('asking again replaces the earlier code, so only one code per player is live', async t => {
  const w = await world(t);
  const first = w.issue();
  w.f.advance(IDENTITY_POLICY.issue_player_gap_ms + 1);
  const second = w.issue();
  assert.notEqual(first.code, second.code);
  assert.throws(() => w.redeem(w.alice, first), refused(400, 'invalid_code'));
  assert.equal(w.redeem(w.alice, second).linked, true);
});

test('a code spoken in public chat is cancelled when the bridge reports it', async t => {
  const w = await world(t);
  const issued = w.issue();
  assert.deepEqual(cancelLeakedCode(w.link, 'not a code'), {revoked: false});
  assert.deepEqual(cancelLeakedCode(w.link, 'ZZZZZ-ZZZZZ'), {revoked: false}, 'an unknown code changes nothing');
  assert.deepEqual(cancelLeakedCode(w.link, issued.code.toLowerCase()), {revoked: true});
  assert.throws(() => w.redeem(w.alice, issued), refused(400, 'invalid_code'));
  assert.deepEqual(cancelLeakedCode(w.link, issued.code), {revoked: false}, 'reporting twice is harmless');
});

test('nobody can bind their own account to another player: they need that player\'s code, and a linked player gets none', async t => {
  const w = await world(t);
  // Victim P1 links to alice. Attacker bob cannot get a code for P1 (the bridge refuses a linked player)
  // and cannot invent one.
  w.redeem(w.alice, w.issue(P1, 'Victim'));
  assert.throws(() => w.issue(P1, 'Victim'), refused(409, 'already_linked'));
  assert.throws(() => redeemCode(w.link, {code: 'ABCDE-FGHJK', expect_alias: 'Victim', account_id: w.bob, peer: 'p'}), refused(400, 'invalid_code'));
  assert.equal(identityFor(w.link, P1).account_id, w.alice);
  // A code issued for P2 links P2 and nobody else, whoever redeems it.
  const forP2 = w.issue(P2, 'Other');
  const result = w.redeem(w.bob, forP2);
  assert.equal(result.player_uuid, P2);
  assert.equal(identityFor(w.link, P1).account_id, w.alice, 'P1 is untouched');
  // The confirmation must name the character that the code is for.
  const forP3 = w.issue(P3, 'Third');
  assert.throws(() => w.redeem(w.alice, forP3), refused(409, 'account_has_link'), 'alice already has P1');
  unlinkAccount(w.link, w.alice);
  assert.throws(() => redeemCode(w.link, {code: forP3.code, expect_alias: 'Victim', account_id: w.alice, peer: 'p'}), refused(400, 'alias_mismatch'));
  assert.throws(() => redeemCode(w.link, {code: forP3.code, account_id: w.alice, peer: 'p'}), refused(400, 'alias_mismatch'), 'no preview, no link');
  assert.equal(identityFor(w.link, P3), null);
});

test('one player maps to one account and one account to one player, and nothing is replaced silently', async t => {
  const w = await world(t);
  w.redeem(w.alice, w.issue(P1));
  w.f.advance(MIN);
  const second = w.issue(P2, 'Second');
  assert.throws(() => w.redeem(w.alice, second), refused(409, 'account_has_link'));
  assert.equal(identityFor(w.link, P2), null);
  // The refused attempt did not burn the code: bob can still use it.
  assert.equal(w.redeem(w.bob, second).linked, true);
  assert.equal(identityFor(w.link, P1).account_id, w.alice);
  assert.equal(identityFor(w.link, P2).account_id, w.bob);
  assert.equal(w.link.sql.get('SELECT COUNT(*) AS n FROM ident_links').n, 2);
});

test('brute force: guesses are limited per account, per peer and overall, and a correct code is refused while locked out', async t => {
  const w = await world(t);
  const issued = w.issue();
  const guess = (account, peer = 'attacker') => () => checkCode(w.link, {code: generateCode(), account_id: account, peer});
  for (let i = 0; i < IDENTITY_POLICY.fail_account.max; i += 1) assert.throws(guess(w.bob), refused(400, 'invalid_code'));
  assert.throws(guess(w.bob), refused(429, 'rate_limited'), 'locked out');
  assert.throws(() => checkCode(w.link, {code: issued.code, account_id: w.bob, peer: 'attacker'}), refused(429, 'rate_limited'), 'even the right code, while locked out');
  // Another account on another peer is not affected by bob's lockout.
  assert.equal(checkCode(w.link, {code: issued.code, account_id: w.alice, peer: 'friend'}).valid, true);
  // A peer that rotates through accounts is stopped by the per-peer limit.
  let stopped = null;
  for (let i = 0; i < IDENTITY_POLICY.fail_peer.max + 5 && !stopped; i += 1) {
    try { checkCode(w.link, {code: generateCode(), account_id: `sock-${i}`, peer: 'rotator'}); } catch (error) { if (error.status === 429) stopped = i; }
  }
  assert.ok(stopped !== null && stopped <= IDENTITY_POLICY.fail_peer.max, `peer stopped after ${stopped} guesses`);
  // The lock lifts when the window passes.
  w.f.advance(IDENTITY_POLICY.fail_account.window_ms + 1);
  assert.equal(checkCode(w.link, {code: issued.code, account_id: w.bob, peer: 'attacker'}).valid, false || true);
});

test('a global ceiling stops a swarm of accounts and peers', async t => {
  const w = await world(t);
  let stopped = null;
  for (let i = 0; i < IDENTITY_POLICY.fail_global.max + 10 && stopped === null; i += 1) {
    try { checkCode(w.link, {code: generateCode(), account_id: `acct-${i}`, peer: `peer-${i}`}); } catch (error) { if (error.status === 429) stopped = i; }
  }
  assert.ok(stopped !== null && stopped <= IDENTITY_POLICY.fail_global.max);
});

test('issuing is limited per player and per bridge credential', async t => {
  const w = await world(t);
  w.issue(P1);
  assert.throws(() => w.issue(P1), refused(429, 'rate_limited'), 'a second code within seconds');
  for (let i = 1; i < IDENTITY_POLICY.issue_player.max; i += 1) { w.f.advance(IDENTITY_POLICY.issue_player_gap_ms + 1); w.issue(P1); }
  w.f.advance(IDENTITY_POLICY.issue_player_gap_ms + 1);
  assert.throws(() => w.issue(P1), refused(429, 'rate_limited'), 'more than three in ten minutes');
  w.f.advance(IDENTITY_POLICY.issue_player.window_ms);
  assert.ok(w.issue(P1).code);
  // Per source: 120 different players in an hour is the ceiling for one bridge credential.
  const many = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let refusedAt = null;
  for (let i = 0; i < IDENTITY_POLICY.issue_source.max + 5 && refusedAt === null; i += 1) {
    try { issueCode(w.link, {player_uuid: many(i), player_alias: 'p', source: 'one-bridge'}); } catch (error) { if (error.status === 429) refusedAt = i; }
  }
  assert.ok(refusedAt !== null && refusedAt <= IDENTITY_POLICY.issue_source.max);
  assert.ok(issueCode(w.link, {player_uuid: many(9999), player_alias: 'p', source: 'another-bridge'}).code, 'another source is unaffected');
});

test('an unlinked player gets nothing: identityFor is null and requireIdentity refuses', async t => {
  const w = await world(t);
  assert.equal(identityFor(w.link, P1), null);
  assert.equal(identityFor(w.link, 'not-a-uuid'), null);
  assert.equal(identityFor(w.link, undefined), null);
  assert.equal(identityFor(w.link, "' OR 1=1 --"), null);
  assert.throws(() => requireIdentity(w.link, P1), refused(403, 'not_linked'));
  w.redeem(w.alice, w.issue());
  assert.equal(requireIdentity(w.link, P1).account_id, w.alice);
  unlinkPlayer(w.link, P1);
  assert.throws(() => requireIdentity(w.link, P1), refused(403, 'not_linked'), 'unlinking takes effect at once');
});

test('identityFor stops working when the account is suspended or deleted, and the player can link again later', async t => {
  const w = await world(t);
  w.redeem(w.alice, w.issue());
  assert.ok(identityFor(w.link, P1));
  w.f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", w.alice);
  assert.equal(identityFor(w.link, P1), null);
  w.f.platform.run("UPDATE accounts SET status='active' WHERE id=?", w.alice);
  assert.ok(identityFor(w.link, P1));
  w.f.platform.run("UPDATE accounts SET status='deleted' WHERE id=?", w.alice);
  assert.equal(identityFor(w.link, P1), null);
  w.f.advance(MIN);
  const fresh = w.issue(P1, 'Tester');   // the dead link does not block a new one
  assert.equal(w.redeem(w.bob, fresh).linked, true);
  assert.equal(identityFor(w.link, P1).account_id, w.bob);
});

test('unlink works from the game and from NemoWorld, and relinking needs a fresh code', async t => {
  const w = await world(t);
  const first = w.issue();
  w.redeem(w.alice, first);
  assert.deepEqual(unlinkPlayer(w.link, P1), {unlinked: true});
  assert.deepEqual(unlinkPlayer(w.link, P1), {unlinked: false});
  assert.equal(identityFor(w.link, P1), null);
  w.f.advance(IDENTITY_POLICY.issue_player_gap_ms + 1);
  w.redeem(w.alice, w.issue());
  assert.deepEqual(unlinkAccount(w.link, w.alice), {removed: true});
  assert.deepEqual(unlinkAccount(w.link, w.alice), {removed: false});
  assert.equal(identityFor(w.link, P1), null);
  assert.throws(() => unlinkPlayer(w.link, 'nope'), refused(400, 'bad_player'));
  assert.ok(w.f.platform.verifyAudit(), 'the audit chain stays valid');
  const events = w.f.platform.all("SELECT event FROM audit WHERE event LIKE 'veloren.%' ORDER BY seq").map(row => row.event);
  assert.deepEqual(events, ['veloren.linked', 'veloren.unlinked', 'veloren.linked', 'veloren.unlinked']);
});

test('player names with markup or control characters cannot reach a human unchanged', async t => {
  const w = await world(t);
  const issued = w.issue(P1, '<img src=x onerror=alert(1)>\u202E\u001b[2J\nVictim');
  assert.doesNotMatch(issued.player_alias, /[<>"'&\u0000-\u001f\u202e\u007f]/);
  const checked = checkCode(w.link, {code: issued.code, account_id: w.alice, peer: 'p'});
  assert.equal(checked.player_alias, issued.player_alias);
  const linked = w.redeem(w.alice, issued);
  assert.doesNotMatch(JSON.stringify(linked), /[<>\u0000-\u001f\u202e]/);
  const empty = issueCode(w.link, {player_uuid: P2, player_alias: '\u0000\u0001<>', source: 's'});
  assert.equal(empty.player_alias, 'player', 'a name that cleans to nothing gets a neutral label');
  assert.throws(() => issueCode(w.link, {player_uuid: 'x', player_alias: 'a', source: 's'}), refused(400, 'bad_player'));
});

test('links, used codes and rate limits survive a restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-restart-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const dbPath = join(directory, 'link.sqlite');
  const w = await world(t, {dbPath});
  const issued = w.issue();
  w.redeem(w.alice, issued);
  w.link.close();
  const reopened = new VelorenLink({dbPath, eventKey: KEY, landmarks: LANDMARKS, clock: w.f.clock});
  reopened.platform = w.f.platform;
  t.after(() => reopened.close());
  assert.equal(identityFor(reopened, P1).account_id, w.alice);
  assert.throws(() => redeemCode(reopened, {code: issued.code, expect_alias: 'Tester', account_id: w.bob, peer: 'p'}), refused(400, 'invalid_code'), 'the used code is still dead');
  assert.throws(() => issueCode(reopened, {player_uuid: P1, player_alias: 'Tester', source: 'k'}), refused(409, 'already_linked'));
});

test('other features can install a fake identity provider and put the real one back', async t => {
  const w = await world(t);
  setIdentityProvider(() => ({account_id: 'fake', agent_id: null, display_name: 'Fake'}));
  try {
    assert.equal(identityFor(w.link, P1).account_id, 'fake');
  } finally { setIdentityProvider(null); }
  assert.equal(identityFor(w.link, P1), null, 'the real provider is back');
  // A link whose extension tables were never created simply has no links.
  const bare = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, extensions: []});
  t.after(() => bare.close());
  assert.equal(identityFor(bare, P1), null);
});

// ---- over HTTP -----------------------------------------------------------------------------------

async function server(t, options = {}) {
  const w = await world(t, options);
  const app = createApp({platform: w.f.platform, backupDir: join(w.f.directory, 'backups'), velorenLink: w.link, mayorModel: null});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, {token, cookie, input, method = input === undefined ? 'GET' : 'POST', headers = {}} = {}) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(cookie ? {Cookie: `world_session=${cookie}`} : {}),
        ...(input !== undefined ? {'Content-Type': 'application/json'} : {}), ...headers},
      ...(input !== undefined ? {body: JSON.stringify(input)} : {}),
    });
    return {status: response.status, data: await response.json().catch(() => ({})), headers: response.headers};
  };
  return {...w, origin, call, alice_session: w.f.credentials.alice.token, bob_session: w.f.credentials.bob.token};
}

test('over HTTP: the bridge asks for a code, the signed-in human redeems it, and every route enforces who may call it', async t => {
  const s = await server(t);
  const bridge = {token: s.bridge.token};
  // Who may ask for a code, or learn an identity: only a director-scope link credential.
  assert.equal((await s.call('/veloren/identity?player_uuid=' + P1)).status, 401);
  assert.equal((await s.call('/veloren/identity?player_uuid=' + P1, {token: s.relay.token})).status, 403, 'an events-only credential is not enough');
  assert.equal((await s.call('/veloren/identity/code', {input: {player_uuid: P1, player_alias: 'Tester'}})).status, 401);
  assert.equal((await s.call('/veloren/identity/code', {token: s.relay.token, input: {player_uuid: P1, player_alias: 'Tester'}})).status, 403);
  assert.equal((await s.call('/veloren/identity/code', {token: s.alice_session, input: {player_uuid: P1, player_alias: 'Tester'}})).status, 401, 'a human session is not a bridge credential');
  assert.equal((await s.call('/veloren/identity?player_uuid=nope', bridge)).status, 400);
  assert.deepEqual((await s.call('/veloren/identity?player_uuid=' + P1, bridge)).data, {linked: false});

  const code = await s.call('/veloren/identity/code', {...bridge, input: {player_uuid: P1, player_alias: 'Tester'}});
  assert.equal(code.status, 200);
  assert.match(code.data.code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/);
  assert.equal(code.data.redeem_path, '/veloren-link');
  assert.equal(code.headers.get('cache-control'), 'no-store');

  // The human page's two steps, with the signed-in session as a Bearer operator token.
  const operator = {token: s.alice_session};
  const checked = await s.call('/veloren/identity/check', {...operator, input: {code: code.data.code.toLowerCase()}});
  assert.equal(checked.status, 200); assert.equal(checked.data.player_alias, 'Tester');
  assert.equal((await s.call('/veloren/identity/redeem', {...operator, input: {code: code.data.code}})).data.reason, 'alias_mismatch');
  const redeemed = await s.call('/veloren/identity/redeem', {...operator, input: {code: code.data.code, expect_alias: 'Tester'}});
  assert.equal(redeemed.status, 200); assert.equal(redeemed.data.linked, true);

  const identity = await s.call('/veloren/identity?player_uuid=' + P1, bridge);
  assert.deepEqual(identity.data, {linked: true, account_id: s.alice, agent_id: s.avatar.id, display_name: 'Alice Walker'});
  assert.deepEqual(identityFor(s.link, P1), {account_id: s.alice, agent_id: s.avatar.id, display_name: 'Alice Walker'});
  const me = await s.call('/veloren/identity/me', operator);
  assert.equal(me.data.linked, true); assert.equal(me.data.player_alias, 'Tester'); assert.equal(me.data.player_uuid, P1);
  assert.deepEqual((await s.call('/veloren/identity/me', {token: s.bob_session})).data, {linked: false}, 'bob sees no link');

  // Replay and a stranger.
  assert.equal((await s.call('/veloren/identity/redeem', {token: s.bob_session, input: {code: code.data.code, expect_alias: 'Tester'}})).status, 400);
  // The bridge refuses a second code for a linked player and answers "unlink" for the player.
  assert.equal((await s.call('/veloren/identity/code', {...bridge, input: {player_uuid: P1, player_alias: 'Tester'}})).data.reason, 'already_linked');
  assert.deepEqual((await s.call('/veloren/identity/unlink', {...bridge, input: {player_uuid: P1}})).data, {unlinked: true});
  assert.deepEqual((await s.call('/veloren/identity?player_uuid=' + P1, bridge)).data, {linked: false});
  assert.deepEqual((await s.call('/veloren/identity/me', operator)).data, {linked: false});
  assert.equal((await s.call('/veloren/identity/nothing', bridge)).status, 404);
});

test('over HTTP: only a signed-in human can redeem; runtime credentials, link credentials and strangers cannot', async t => {
  const s = await server(t);
  const agent = s.f.agent('bob', 'Bob bot');
  const runtime = s.f.platform.runtime(s.f.actor('bob'), agent.id, {minutes: 5, max_calls: 50});
  const issue = async (uuid = P1) => (await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: uuid, player_alias: 'Tester'}})).data;
  const code = await issue();
  const body = {code: code.code, expect_alias: 'Tester'};

  assert.equal((await s.call('/veloren/identity/redeem', {input: body, headers: {Origin: s.origin}})).status, 401, 'no credential');
  assert.equal((await s.call('/veloren/identity/redeem', {token: runtime.token, input: body})).status, 403, 'an AI runtime credential');
  assert.equal((await s.call('/veloren/identity/check', {token: runtime.token, input: body})).status, 403);
  assert.equal((await s.call('/veloren/identity/remove', {token: runtime.token, input: {}})).status, 403);
  assert.equal((await s.call('/veloren/identity/me', {token: runtime.token})).status, 403);
  assert.equal((await s.call('/veloren/identity/redeem', {token: s.bridge.token, input: body})).status, 401, 'the bridge\'s own link credential');
  assert.equal((await s.call('/veloren/identity/redeem', {token: s.relay.token, input: body})).status, 401, 'the relay\'s link credential');
  assert.equal((await s.call('/veloren/identity/redeem', {token: '0'.repeat(64), input: body})).status, 401);
  assert.equal((await s.call('/veloren/identity/redeem', {token: 'not-a-token', input: body})).status, 401);
  assert.equal((await s.call('/veloren/identity?player_uuid=' + P1, {token: runtime.token})).status, 401, 'a runtime cannot ask the bridge route');
  assert.equal(identityFor(s.link, P1), null, 'nothing above linked anyone');

  // A browser (cookie) must send this site\'s Origin: a cross-site page and a script without Origin are refused.
  assert.equal((await s.call('/veloren/identity/redeem', {cookie: s.alice_session, input: body})).status, 403, 'cookie without Origin');
  assert.equal((await s.call('/veloren/identity/redeem', {cookie: s.alice_session, input: body, headers: {Origin: 'https://evil.example'}})).status, 403, 'cross-origin');
  assert.equal(identityFor(s.link, P1), null);
  const ok = await s.call('/veloren/identity/redeem', {cookie: s.alice_session, input: body, headers: {Origin: s.origin}});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(identityFor(s.link, P1).account_id, s.alice);

  // A suspended operator cannot link; a paused platform refuses writes.
  const other = await issue(P2);
  s.f.platform.run("UPDATE accounts SET status='suspended' WHERE id=?", s.bob);
  assert.equal((await s.call('/veloren/identity/redeem', {token: s.bob_session, input: {code: other.code, expect_alias: 'Tester'}})).status, 403);
});

test('over HTTP: a human who guesses codes is locked out with Retry-After', async t => {
  const s = await server(t);
  const real = (await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: P1, player_alias: 'Tester'}})).data;
  let last;
  for (let i = 0; i <= IDENTITY_POLICY.fail_account.max; i += 1) last = await s.call('/veloren/identity/check', {token: s.bob_session, input: {code: generateCode()}});
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
  assert.equal((await s.call('/veloren/identity/check', {token: s.bob_session, input: {code: real.code}})).status, 429, 'the right code is refused while locked out');
  assert.equal((await s.call('/veloren/identity/check', {token: s.alice_session, input: {code: real.code}})).status, 200, 'the owner is not locked out by someone else\'s guesses');
});

test('over HTTP: the bridge cancels a code that was spoken in public', async t => {
  const s = await server(t);
  const code = (await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: P1, player_alias: 'Tester'}})).data;
  assert.deepEqual((await s.call('/veloren/identity/leaked', {token: s.bridge.token, input: {code: code.code}})).data, {revoked: true});
  assert.equal((await s.call('/veloren/identity/check', {token: s.alice_session, input: {code: code.code}})).status, 400);
  assert.equal((await s.call('/veloren/identity/leaked', {token: s.alice_session, input: {code: code.code}})).status, 401, 'a human cannot call the bridge route');
});

test('the signed-in account reads its linked player\'s Quiet Survey progress, and nobody else\'s', async t => {
  const s = await server(t);
  const code = (await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: P1, player_alias: 'Tester'}})).data;
  const operator = {token: s.alice_session};
  assert.equal((await s.call('/veloren/identity/progress', operator)).status, 404, 'not linked yet: nothing to read');
  assert.equal((await s.call('/veloren/identity/progress')).status, 401);
  await s.call('/veloren/identity/redeem', {...operator, input: {code: code.code, expect_alias: 'Tester'}});

  // Facts come from signed server events, exactly as for any player.
  const credential = s.link.authenticate(s.relay.token, 'events');
  const signed = (overrides) => { const e = {v: 1, server_id: 't', seq: Math.floor(Math.random() * 1e9) + 1, kind: 'resident.met', resident_id: 'lw-lyra', player_uuid: P1, player_alias: 'Tester', landmark_id: null, occurred_at: s.f.clock(), ...overrides}; e.sig = signEvent(KEY, e); return e; };
  s.link.ingest(credential, [signed({})]);
  s.f.advance(1000);
  s.link.ingest(credential, [signed({kind: 'landmark.together', landmark_id: 'lyra-survey', occurred_at: s.f.clock()})]);
  s.f.advance(1000);
  s.link.ingest(credential, [signed({kind: 'resident.met', landmark_id: 'lyra-post', occurred_at: s.f.clock()})]);
  // Another player's progress exists too.
  s.link.ingest(credential, [signed({player_uuid: P2, player_alias: 'Other'})]);

  const mine = await s.call('/veloren/identity/progress', operator);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.player_alias, 'Tester');
  assert.equal(mine.data.progress.complete, true);
  assert.deepEqual(mine.data.progress.steps.map(step => step.state), ['done', 'done', 'done']);
  assert.ok(mine.data.progress.steps.every(step => /^t:\d+$/.test(step.source_event_id)), 'each step names the server event that proved it');
  assert.ok(mine.data.notes.length >= 1);
  // The route takes no player from the caller: a query cannot read someone else's.
  const sneaky = await s.call(`/veloren/identity/progress?player_uuid=${P2}`, operator);
  assert.equal(sneaky.data.player_alias, 'Tester');
  assert.equal(sneaky.data.progress.complete, true);
  // An account with no link reads nothing; so does a runtime.
  assert.equal((await s.call('/veloren/identity/progress', {token: s.bob_session})).status, 404);
  const agent = s.f.agent('bob', 'Bob bot');
  assert.equal((await s.call('/veloren/identity/progress', {token: s.f.platform.runtime(s.f.actor('bob'), agent.id, {minutes: 5, max_calls: 5}).token})).status, 403);
});

test('over HTTP: a hostile player name arrives as harmless text', async t => {
  const s = await server(t);
  const nasty = '<script>alert(1)</script>\u001b[31m\r\nSet-Cookie: x=1\u202E';
  const code = await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: P1, player_alias: nasty}});
  assert.equal(code.status, 200);
  assert.doesNotMatch(code.data.player_alias, /[<>\u0000-\u001f\u202e]/);
  const checked = await s.call('/veloren/identity/check', {token: s.alice_session, input: {code: code.data.code}});
  assert.doesNotMatch(JSON.stringify(checked.data), /[<>\u001b\r\n\u202e]/);
  assert.equal((await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: P2, player_alias: 12345}})).data.player_alias, 'player');
  assert.equal((await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: 'bad'}})).status, 400);
  assert.equal((await s.call('/veloren/identity/code', {token: s.bridge.token, input: []})).status, 400);
});

test('a code is never written to a log, the audit chain or any error text', async t => {
  const captured = [];
  const spies = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    spies.push([stream, original]);
    stream.write = (chunk, ...rest) => { captured.push(String(chunk)); return original(chunk, ...rest); };
  }
  const consoleOriginals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) { consoleOriginals[name] = console[name]; console[name] = (...args) => captured.push(args.join(' ')); }
  let issued;
  try {
    const s = await server(t);
    issued = (await s.call('/veloren/identity/code', {token: s.bridge.token, input: {player_uuid: P1, player_alias: 'Tester'}})).data;
    await s.call('/veloren/identity/check', {token: s.bob_session, input: {code: 'BADBA-DBADB'}});
    await s.call('/veloren/identity/redeem', {token: s.alice_session, input: {code: issued.code, expect_alias: 'Tester'}});
    await s.call('/veloren/identity/redeem', {token: s.alice_session, input: {code: issued.code, expect_alias: 'Tester'}});
    const dump = JSON.stringify(s.f.platform.all('SELECT * FROM audit')) + JSON.stringify(s.link.sql.all('SELECT * FROM ident_history'));
    captured.push(dump);
  } finally {
    for (const [stream, original] of spies) stream.write = original;
    for (const [name, fn] of Object.entries(consoleOriginals)) console[name] = fn;
  }
  assert.ok(issued?.code);
  assert.equal(captured.join('\n').includes(issued.code.replace('-', '')), false);
  assert.equal(captured.join('\n').includes(issued.code), false);
});

test('the link page is served, accessible and uses no inline script, style or HTML insertion', async t => {
  const s = await server(t);
  const page = await fetch(`${s.origin}/veloren-link`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await page.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<label for="code">/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'no inline script');
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i, 'no inline style or handler');
  const source = readFileSync(new URL('../veloren-link.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, 'text only');
  for (const path of ['/veloren-link.js', '/veloren-link.css']) assert.equal((await fetch(s.origin + path)).status, 200);
});
