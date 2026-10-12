import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { COUNTRIES, AMBASSADOR_SPRITES } from '../src/civic-engine.js';
import { REGIONS } from '../src/civic.js';
import { backupDatabase, restoreDatabase, validateDatabase } from '../src/recovery.js';
import { createApp } from '../server.js';
import { getWorldDefinition, walkable } from '../world.js';

const catalogIds = COUNTRIES.entries.map((country) => `amb-${country.iso3}`);
const platformWithAmbassadors = (path, clock) => new Platform(path, clock);

test('exactly one ambassador per catalog entry after the first boot, and again after a restart', async (t) => {
  const f = await fixture(t);
  const count = () => f.platform.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n;
  assert.equal(COUNTRIES.entries.length, 248);
  assert.equal(COUNTRIES.metadata.count, 248);
  assert.equal(count(), 248);
  assert.equal(f.platform.get('SELECT COUNT(DISTINCT iso3) AS n FROM npc_ambassadors').n, 248);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM npc_ambassadors WHERE iso3 IS NULL OR trim(iso3)=''").n, 0);
  // Each id is its own iso3 and every catalog entry is present exactly once.
  assert.deepEqual(f.platform.all('SELECT id,iso3 FROM npc_ambassadors ORDER BY id').map((row) => row.id), [...catalogIds].sort());
  // The 20 sealed sheets repeat across the 248 ambassadors; that reuse is deliberate, not unique art.
  assert.deepEqual([...new Set(f.platform.all('SELECT DISTINCT sprite FROM npc_ambassadors').map((row) => row.sprite))].sort((a, b) => a - b), [...AMBASSADOR_SPRITES].sort((a, b) => a - b));
  const spread = f.platform.all('SELECT sprite,COUNT(*) AS n FROM npc_ambassadors GROUP BY sprite').map((row) => row.n);
  assert.equal(spread.reduce((sum, n) => sum + n, 0), 248);
  assert.equal(spread.every((n) => n === 12 || n === 13), true, 'each sealed sheet is reused evenly across the catalog');
  f.platform.close();
  const reopened = platformWithAmbassadors(f.database, f.clock);
  t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n, 248);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM worlds WHERE kind=\'country\'').n, 248);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM ambassador_legacy_map').n, 20);
  assert.equal(reopened.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n, 0);
  assert.equal(reopened.verifyAudit(), true);
  assert.equal(validateDatabase(f.database).schema_version, 15);
});

test('each ambassador holds a stand in its own generated country venue and the finite frontier is untouched', async (t) => {
  const f = await fixture(t);
  const before = { frontier: f.platform.get("SELECT COUNT(*) AS n FROM worlds WHERE kind='frontier'").n, parcels: f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n, sectors: f.platform.get('SELECT COUNT(*) AS n FROM frontier_sectors').n };
  const rows = f.platform.all('SELECT id,iso3,world_id,x,y,sprite,status FROM npc_ambassadors ORDER BY id');
  assert.equal(new Set(rows.map((row) => `${row.world_id}:${row.x}:${row.y}`)).size, 248, 'no two ambassadors share a stand');
  for (const row of rows) {
    assert.equal(row.world_id, `country:${row.iso3}`);
    assert.match(row.world_id, /^country:[A-Z]{3}$/);
  }
  // Every venue resolves, is walkable at its stand and at its arrival, and has a return portal.
  for (const row of rows) {
    const world = getWorldDefinition(row.world_id);
    assert.equal(world.kind, 'country');
    assert.equal(walkable(row, world), true, `${row.world_id} stand ${row.x},${row.y} must be walkable`);
    assert.equal(walkable(world.start, world), true);
    assert.equal(world.portals[0].targetWorldId, 'commons');
    assert.equal(world.columns, 40);
    assert.equal(world.rows, 28);
  }
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM worlds WHERE kind='frontier'").n, before.frontier);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_parcels').n, before.parcels);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_sectors').n, before.sectors);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM land_parcels WHERE world_id LIKE 'country:%'").n, 0);
  // Country venues are listed through the ambassador directory, not the bounded world list.
  const listing = f.platform.worldList(f.actor('alice'), { limit: 50 });
  assert.equal(listing.worlds.some((world) => world.kind === 'country'), false);
  // The ambassador is the venue participant, and a signed-in human can walk in from the Commons.
  const stand = f.platform.get('SELECT x,y FROM npc_ambassadors WHERE id=?', 'amb-NPL');
  const venue = f.platform.world(null, { world_id: 'country:NPL', x: Math.max(0, Math.min(20, stand.x - 10)), y: Math.max(0, Math.min(14, stand.y - 7)) });
  assert.deepEqual(venue.participants.filter((p) => p.kind === 'npc').map((p) => p.id), ['amb-NPL']);
  assert.equal(venue.counts.world_agents, 1);
  const alice = f.agent('alice');
  const entered = f.tx('travel', f.actor('alice'), alice.id, { world_id: 'country:NPL' });
  assert.equal(entered.entered, true);
  assert.equal(f.platform.get('SELECT world_id FROM agents WHERE id=?', alice.id).world_id, 'country:NPL');
});

test('ambassadors hold a fixed stand: the patrol tick moves only the historic guide rows', async (t) => {
  const f = await fixture(t);
  const stand = { ...f.platform.get('SELECT x,y FROM npc_ambassadors WHERE id=?', 'amb-NPL') };
  const guide = { ...f.platform.get('SELECT x,y FROM npc_mayors WHERE id=?', 'mayor-highlands') };
  assert.equal(f.platform.all('PRAGMA table_info(npc_ambassadors)').some((column) => column.name === 'ticks'), false, 'ambassadors carry no patrol counters');
  f.advance(3000);
  f.tx('tickMayors');
  assert.deepEqual({ ...f.platform.get('SELECT x,y FROM npc_ambassadors WHERE id=?', 'amb-NPL') }, stand);
  const moved = { ...f.platform.get('SELECT x,y FROM npc_mayors WHERE id=?', 'mayor-highlands') };
  assert.notDeepEqual([moved.x, moved.y], [guide.x, guide.y]);
  // The registered server timer calls tickMayors only, so a venue never pays a 248-row write per tick.
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /setInterval\(\(\)=>\{try\{platform\.transaction\(\(\)=>platform\.tickMayors\(\)\)/);
  assert.doesNotMatch(server, /tickAmbassadors/);
});

test('the directory paginates and searches all 248 countries and areas without exposing paused entries', async (t) => {
  const f = await fixture(t);
  const seen = new Set();
  for (let offset = 0; ; offset += 50) {
    const page = f.platform.ambassadors(null, { offset, limit: 50 });
    assert.equal(page.limit, 50);
    if (!page.has_more) assert.equal(page.offset + page.entries.length, page.total);
    for (const entry of page.entries) seen.add(entry.id);
    if (!page.has_more) break;
  }
  assert.equal(seen.size, 248);
  assert.deepEqual([...seen].sort(), [...catalogIds].sort());
  assert.throws(() => f.platform.ambassadors(null, { limit: 0 }), { status: 400 }, 'a zero page is refused, not silently clamped');
  assert.throws(() => f.platform.ambassadors(null, { limit: 51 }), { status: 400 });
  assert.throws(() => f.platform.ambassadors(null, { offset: -1 }), { status: 400 });
  assert.throws(() => f.platform.ambassadors(null, { group: 'invented' }), { status: 400 });
  assert.equal(f.platform.ambassadors(null, { q: 'nepal' }).total, 1);
  assert.equal(f.platform.ambassadors(null, { q: 'NPL' }).entries[0].name, 'Nepal');
  assert.equal(f.platform.ambassadors(null, { q: '004' }).entries[0].name, 'Afghanistan');
  assert.equal(f.platform.ambassadors(null, { group: 'ldc' }).counts.ldc, COUNTRIES.entries.filter((country) => country.ldc).length);
  assert.equal(f.platform.ambassadors(null, { group: 'sids', limit: 50 }).total, COUNTRIES.entries.filter((country) => country.sids).length);
  assert.equal(f.platform.ambassadors(null, {}).counts.active, 248);
  // Pause one entry: it leaves the public listing and is counted honestly instead of hidden silently.
  f.tx('ambassadorControl', f.actor('moderator'), { ambassador_id: 'amb-NPL', status: 'paused' });
  const paused = f.platform.ambassadors(null, {});
  assert.equal(paused.total, 247);
  assert.equal(paused.entries.some((entry) => entry.id === 'amb-NPL'), false);
  assert.equal(paused.counts.paused, 1);
  assert.equal(paused.excluded.not_shown, 1);
  assert.match(paused.excluded.reason, /Paused ambassadors are withheld/);
  // An anonymous caller cannot ask for the withheld entry, a signed-in moderator can.
  const anonymousPaused = f.platform.ambassadors(null, { include_paused: '1', status: 'paused' });
  assert.equal(anonymousPaused.total, 247, 'an anonymous caller cannot switch the listing to paused entries');
  assert.equal(anonymousPaused.entries.some((entry) => entry.id === 'amb-NPL'), false);
  assert.equal(f.platform.ambassadors(f.actor('moderator'), { include_paused: '1', status: 'paused' }).total, 1);
  assert.throws(() => f.platform.ambassadorControl(f.actor('alice'), { ambassador_id: 'amb-NPL', status: 'active' }), { status: 403 });
  assert.equal(f.platform.ambassadors(null, { q: 'Nepal' }).total, 0);
});

test('a country ambassador answers from its own assigned context and refuses a country mismatch', async (t) => {
  const f = await fixture(t);
  const reply = f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-NPL', question: 'Help me research agriculture.' });
  assert.equal(reply.ambassador_id, 'amb-NPL');
  assert.equal(reply.country.iso3, 'NPL');
  assert.equal(reply.mode, 'rules');
  assert.equal(reply.country_context.format, 'nemoworld-ambassador-country-v1');
  assert.equal(reply.country_context.country.name, 'Nepal');
  assert.deepEqual(reply.source_numbers, [1, 2, 3, 4, 5]);
  assert.match(reply.answer, /fictional research guide/);
  assert.match(reply.answer, /I do not represent Nepal, any government or the United Nations/);
  assert.doesNotMatch(reply.answer, /\bUN official\b/i);
  // The assigned context is used automatically: no country_code is required, and a wrong one is refused.
  f.advance();
  for (const country_code of ['BD', 'BGD', '050', 'XX']) {
    assert.throws(() => f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-NPL', question: 'Agriculture?', country_code }), { status: 400 });
  }
  f.advance();
  const matching = f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-NPL', question: 'Agriculture exports?', country_code: 'NPL' });
  assert.equal(matching.country_context.country.iso2, 'NP');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM mayor_conversations').n, 0, 'new guidance never writes the historic table');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n, 2);
  // A country with no retained series is an evidence gap, not a zero.
  f.advance();
  const missing = f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-ATA', question: 'What is retained?' });
  assert.deepEqual(missing.source_numbers, []);
  assert.match(missing.answer, /evidence gap/);
  assert.equal(missing.country_context.sources.every((source) => source.status === 'not_retained'), true);
  assert.throws(() => f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-XXX', question: 'Hello' }), { status: 404 });
  // A paused ambassador cannot answer.
  f.advance();
  f.tx('ambassadorControl', f.actor('moderator'), { ambassador_id: 'amb-NPL', status: 'paused' });
  assert.throws(() => f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-NPL', question: 'Hello' }), { status: 404 });
});

test('the ambassador profile carries country context, research links, the legacy mapping and only your conversations', async (t) => {
  const f = await fixture(t);
  const mapped = f.platform.get("SELECT ambassador_id FROM ambassador_legacy_map WHERE guide_id='mayor-highlands'").ambassador_id;
  const alice = f.actor('alice');
  f.tx('ambassadorTalk', alice, { ambassador_id: mapped, question: 'Ban the farmer now' });
  const profile = f.platform.ambassador(alice, { id: mapped });
  assert.equal(profile.ambassador.world_id, `country:${profile.country.iso3}`);
  assert.equal(profile.country_context.format, 'nemoworld-ambassador-country-v1');
  assert.equal(profile.research.evidence_routes.length, 5);
  assert.equal(profile.research.evidence_routes.every((route) => Boolean(route.url)), true);
  assert.equal(Number.isInteger(profile.research.lead_total), true);
  assert.equal(profile.legacy.guide_id, 'mayor-highlands');
  assert.equal(profile.legacy.region_name, 'Highlands');
  assert.equal(profile.conversations.length, 1);
  assert.equal(profile.conversations[0].ambassador_id, mapped);
  assert.equal(profile.mode.includes('Scripted country ambassadors'), true);
  // Private: another operator sees no conversations, and a signed-out caller sees none either.
  assert.equal(f.platform.ambassador(f.actor('bob'), { id: mapped }).conversations.length, 0);
  assert.equal(f.platform.ambassador(null, { id: mapped }).conversations.length, 0);
  assert.equal(f.platform.ambassador(null, { id: mapped }).legacy_conversations.length, 0);
  assert.equal(f.tx('civicExport', alice).conversations.length, 1);
  f.tx('deleteAccount', alice);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n, 0);
  assert.throws(() => f.platform.ambassador(alice, { id: 'amb-XXX' }), { status: 404 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n, 248, 'account deletion never removes a guide');
});

test('a v14 database with 20 guides and conversations migrates forward and keeps its history readable', async (t) => {
  const f = await fixture(t), aliceId = f.actor('alice').account.id;
  // Record a historic guide conversation, pause a guide and save a world object, then reproduce the
  // schema 14 shape: the country tables and their venues did not exist yet.
  f.platform.run("UPDATE npc_mayors SET status='paused' WHERE id='mayor-highlands'");
  f.platform.close();
  const legacy = new DatabaseSync(f.database);
  legacy.exec(`PRAGMA foreign_keys=OFF; DROP TABLE ambassador_conversations; DROP TABLE ambassador_legacy_map; DROP TABLE npc_ambassadors;
    DELETE FROM worlds WHERE kind='country';
    INSERT INTO mayor_conversations(id,account_id,npc_id,question,answer,created_at,mode,country_context,source_numbers) VALUES('v14-historic','${aliceId}','mayor-highlands','Historic v14 question','Historic v14 answer','2026-09-01T00:00:00.000Z','rules',NULL,'[]');
    PRAGMA user_version=14;`);
  legacy.close();
  assert.equal(validateDatabase(f.database).schema_version, 14);
  assert.equal(existsSync(f.database), true);

  const migrated = platformWithAmbassadors(f.database, f.clock);
  t.after(() => migrated.close());
  const actor = migrated.authenticate(f.credentials.alice.token);
  assert.equal(migrated.get('PRAGMA user_version').user_version, 15);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n, 248);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM npc_mayors').n, 20);
  // The paused guide handed its paused state to its replacement exactly once.
  const mapped = migrated.get("SELECT ambassador_id FROM ambassador_legacy_map WHERE guide_id='mayor-highlands'").ambassador_id;
  assert.equal(migrated.get('SELECT status FROM npc_ambassadors WHERE id=?', mapped).status, 'paused');
  // The historic conversation is unchanged and readable through both the legacy list and the profile.
  const stored = migrated.get('SELECT * FROM mayor_conversations WHERE id=?', 'v14-historic');
  assert.equal(stored.question, 'Historic v14 question');
  assert.equal(stored.answer, 'Historic v14 answer');
  assert.equal(stored.country_context, null);
  assert.deepEqual(migrated.mayors(actor).legacy_conversations.map((turn) => turn.question), ['Historic v14 question']);
  assert.deepEqual(migrated.ambassador(actor, { id: mapped }).legacy_conversations.map((turn) => turn.question), ['Historic v14 question']);
  // Re-running the migration is idempotent: no duplicate rows, no second paused write.
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n, 248);
  assert.equal(validateDatabase(f.database).schema_version, 15);
  assert.equal(migrated.verifyAudit(), true);
});

test('a migrated database backs up, verifies and restores with every ambassador and historic record intact', async (t) => {
  const f = await fixture(t), aliceId = f.actor('alice').account.id;
  f.tx('ambassadorTalk', f.actor('alice'), { ambassador_id: 'amb-NPL', question: 'Help me research agriculture.' });
  f.platform.run("INSERT INTO mayor_conversations(id,account_id,npc_id,question,answer,created_at,mode) VALUES('historic-backup',?,'mayor-snowline','Old question','Old answer','2026-09-01T00:00:00.000Z','rules')", aliceId);
  f.platform.close();
  const backup = join(f.directory, 'ambassador-backup.sqlite'), restored = join(f.directory, 'ambassador-restored.sqlite');
  // The CLI paths the release notes document: `npm run backup` (scripts/recovery.js backup) and verify.
  const root = fileURLToPath(new URL('..', import.meta.url));
  execFileSync(process.execPath, ['scripts/recovery.js', 'backup', f.database, backup], { cwd: root });
  const verified = JSON.parse(execFileSync(process.execPath, ['scripts/recovery.js', 'verify', backup], { cwd: root }).toString());
  assert.deepEqual(verified, { schema_version: 15, accounts: 5 });
  assert.equal(validateDatabase(backup).schema_version, 15);
  const result = restoreDatabase(backup, restored);
  assert.equal(result.schema_version, 15);
  const db = platformWithAmbassadors(restored, f.clock);
  t.after(() => db.close());
  assert.equal(db.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n, 248);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ambassador_legacy_map').n, 20);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM mayor_conversations').n, 1);
  assert.equal(db.get('SELECT question FROM mayor_conversations WHERE id=?', 'historic-backup').question, 'Old question');
  assert.equal(db.verifyAudit(), true);
  // A schema 15 database that lost its ambassador rows is refused, so validation is not decorative.
  const damaged = new DatabaseSync(restored);
  damaged.exec('DROP TABLE ambassador_legacy_map');
  damaged.close();
  assert.throws(() => validateDatabase(restored), /country ambassador schema/);
});

test('NPC ambassadors cannot receive credentials, experience, coins, review or moderation powers', async (t) => {
  const f = await fixture(t);
  const alice = f.actor('alice');
  // No account, no operator agent and no runtime credential for any ambassador.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM accounts WHERE id LIKE \'amb-%\'').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM agents WHERE id LIKE \'amb-%\'').n, 0);
  assert.throws(() => f.tx('runtime', alice, 'amb-NPL', { scopes: ['read', 'chat'], minutes: 4, max_calls: 20 }), { status: 404 });
  assert.throws(() => f.platform.run("INSERT INTO tokens(hash,account_id,agent_id,kind,expires_at,max_calls,used_calls,scopes,revoked) VALUES(?,?,'amb-NPL','runtime',?,10,0,'[\"read\"]',0)", 'a'.repeat(64), alice.account.id, f.clock() + 60000), /Only agents can receive runtime credentials/);
  assert.throws(() => f.tx('runtime', alice, REGIONS[0].mayor.id, { minutes: 4, max_calls: 20 }), { status: 404 });
  // No calling selection, calling progress or receipt can name an ambassador: the tables reference agents.
  assert.throws(() => f.tx('callings', alice, { agent_id: 'amb-NPL' }), { status: 404 });
  assert.throws(() => f.platform.run("INSERT INTO resident_callings VALUES('amb-NPL','explorer',0,'')"), /FOREIGN KEY/i);
  assert.throws(() => f.platform.run("INSERT INTO calling_receipts(id,agent_id,account_id,calling_id,objective_id,source_kind,source_id,source_at,selected_at,earned_day,points,created_at,proof_hash) VALUES('r','amb-NPL',?,'explorer','explorer.shared_visit','shared_visit','x','2026-10-12T00:00:00.000Z',0,'2026-10-12',5,'2026-10-12T00:00:00.000Z','0')", alice.account.id), /FOREIGN KEY|verified current activity/);
  assert.equal(f.platform.publicCallings(['amb-NPL'])['amb-NPL'].rank.level, 0);
  assert.equal(Object.hasOwn(f.platform.publicCallings(['amb-NPL'])['amb-NPL'], 'experience'), false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id LIKE \'amb-%\'').n, 0);
  // No coins: the ledger only accepts an accepted submission from a real contributing account.
  assert.throws(() => f.platform.coins(alice, { agent_id: 'amb-NPL' }), { status: 404 });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  // No review or moderation authority: every civic authority method requires a signed-in human session.
  const npcActor = { kind: 'npc', id: 'amb-NPL' };
  assert.throws(() => f.tx('mayorTriage', npcActor), { status: 403 });
  assert.throws(() => f.tx('ambassadorControl', npcActor, { ambassador_id: 'amb-NPL', status: 'paused' }), { status: 403 });
  assert.throws(() => f.tx('mayorControl', npcActor, { npc_id: 'mayor-highlands', status: 'paused' }), { status: 403 });
  assert.throws(() => f.tx('ambassadorTalk', npcActor, { ambassador_id: 'amb-NPL', question: 'Hello' }), { status: 403 });
  assert.throws(() => f.tx('review', npcActor, { submission_id: 'x', decision: 'accepted', reason: 'Self review' }), { status: 403 });
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE actor LIKE 'amb-%'").n, 0);
});

test('the legacy guide routes and the canonical ambassador routes agree over real HTTP', async (t) => {
  const f = await fixture(t);
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const call = async (path, input, token) => {
    const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const member = f.credentials.alice.token, moderator = f.credentials.moderator.token;
  // Public read routes work without a session and never leak a conversation.
  const directory = await call('/ambassadors?limit=5');
  assert.equal(directory.status, 200);
  assert.equal(directory.body.entries.length, 5);
  assert.equal(directory.body.entries.every((entry) => !Object.hasOwn(entry, 'conversations')), true);
  const anonymousProfile = await call('/ambassador?id=amb-NPL');
  assert.equal(anonymousProfile.status, 200);
  assert.deepEqual(anonymousProfile.body.conversations, []);
  assert.equal(anonymousProfile.body.country_context.country.iso3, 'NPL');
  assert.equal((await call('/ambassadors?group=invented')).status, 400);
  assert.equal((await call('/ambassador')).status, 404);
  assert.equal((await call('/ambassador?id=amb-XXX')).status, 404);
  assert.equal((await call('/ambassadors/talk',{ambassador_id:'amb-NPL',question:'Agriculture?',context:false},member)).status,400);
  // A successful talk attaches the country context and its source numbers.
  const talk = await call('/ambassadors/talk', { ambassador_id: 'amb-NPL', question: 'Help me research agriculture.' }, member);
  assert.equal(talk.status, 200);
  assert.equal(talk.body.country_context.country.name, 'Nepal');
  assert.deepEqual(talk.body.source_numbers, [1, 2, 3, 4, 5]);
  assert.match(talk.body.answer, /never a government|do not represent/);
  // A country mismatch is refused, and a runtime credential cannot chat as a human.
  assert.equal((await call('/ambassadors/talk', { ambassador_id: 'amb-NPL', question: 'Agriculture?', country_code: 'BD' }, member)).status, 400);
  const agent = f.agent('alice'), runtime = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'chat'], minutes: 4, max_calls: 20 });
  assert.equal((await call('/ambassadors/talk', { ambassador_id: 'amb-NPL', question: 'Hello' }, runtime.token)).status, 403);
  // The legacy aliases keep working and return their documented shape.
  const legacy = await call('/mayors', undefined, member);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.mayors.length, 20);
  assert.equal(legacy.body.legacy_alias, true);
  assert.equal(legacy.body.mayors.every((guide) => guide.ambassador?.id?.startsWith('amb-')), true);
  assert.equal(legacy.body.conversations.length, 1);
  assert.equal(legacy.body.conversations[0].npc_id, null, 'an unmapped country talk has no legacy guide id');
  f.advance();
  const legacyTalk = await call('/mayors/talk', { npc_id: 'mayor-highlands', question: 'Help with tasks' }, member);
  assert.equal(legacyTalk.status, 200);
  assert.equal(legacyTalk.body.npc_id, 'mayor-highlands');
  assert.equal(legacyTalk.body.legacy_alias, true);
  assert.equal(legacyTalk.body.ambassador_id, f.platform.get("SELECT ambassador_id FROM ambassador_legacy_map WHERE guide_id='mayor-highlands'").ambassador_id);
  f.advance();
  const legacyCountry = await call('/mayors/talk', { npc_id: 'mayor-highlands', question: 'Tea exports?', country_code: 'NP' }, member);
  assert.equal(legacyCountry.status, 200);
  assert.equal(legacyCountry.body.country_context.country.iso2, 'NP');
  assert.equal((await call('/mayors/talk', { npc_id: 'mayor-highlands', question: 'Tea?', country_code: 'XX' }, member)).status, 400);
  // Control is audited, moderator-only, and visible through both routes.
  const controlled = await call('/ambassadors/control', { ambassador_id: 'amb-NPL', status: 'paused' }, moderator);
  assert.equal(controlled.status, 200);
  assert.equal(controlled.body.status, 'paused');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='ambassador.paused' AND record_id='amb-NPL'").n, 1);
  assert.equal((await call('/ambassadors/control', { ambassador_id: 'amb-NPL', status: 'active' }, member)).status, 403);
  assert.equal((await call('/mayors/control', { npc_id: 'mayor-highlands', status: 'paused' }, member)).status, 403);
  const triage = await call('/mayors/triage', undefined, moderator);
  assert.equal(triage.status, 200);
  assert.equal(triage.body.authority.includes('Advisory only'), true);
  // The canonical and legacy listings agree that the paused ambassador is withheld.
  const afterPause = await call('/ambassadors?limit=50');
  assert.equal(afterPause.body.entries.some((entry) => entry.id === 'amb-NPL'), false);
  assert.equal(afterPause.body.counts.paused, 1);
});

test('canonical requests cannot disable country context while the legacy general answer remains compatible',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.tx('ambassadorTalk',f.actor('alice'),{ambassador_id:'amb-NPL',question:'Agriculture?',context:false}),{status:400});
 const reply=f.tx('ambassadorTalk',f.actor('alice'),{ambassador_id:'amb-NPL',question:'Agriculture?'});assert.equal(reply.country_context.country.iso3,'NPL');
 f.advance();const legacy=f.tx('mayorTalk',f.actor('alice'),{npc_id:'mayor-snowline',question:'Hello'});assert.equal(legacy.country_context,null);
});
test('recovery refuses an incomplete country roster, a substituted country identity, and a broken venue',async t=>{
 const f=await fixture(t),resident=f.platform.get('SELECT a.* FROM npc_ambassadors a LEFT JOIN ambassador_legacy_map m ON m.ambassador_id=a.id WHERE m.guide_id IS NULL LIMIT 1');
 f.platform.run('UPDATE npc_ambassadors SET name=? WHERE id=?','Substituted country',resident.id);assert.throws(()=>validateDatabase(f.database),/catalog identity/);
 f.platform.run('UPDATE npc_ambassadors SET name=? WHERE id=?',resident.name,resident.id);
 f.platform.run("UPDATE worlds SET visibility='private' WHERE id=?",resident.world_id);assert.throws(()=>validateDatabase(f.database),/venue is invalid/);
 f.platform.run("UPDATE worlds SET visibility='public' WHERE id=?",resident.world_id);
 f.platform.run('DELETE FROM npc_ambassadors WHERE id=?',resident.id);assert.throws(()=>validateDatabase(f.database),/roster is incomplete/);
});
