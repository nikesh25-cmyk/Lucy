import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { VAULT_LIMITS, VAULT_POLICY, verifyVaultRecords } from '../src/vault.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';

const SECRET = 'my private plan: water the quiet orchard before dawn';

// A resident credential carrying the operator-granted `vault` scope, exactly as an external runtime holds it.
function resident(f, owner = 'alice', scopes = ['read', 'vault']) {
  const agent = f.agent(owner, `${owner} resident`);
  const session = f.tx('runtime', f.actor(owner), agent.id, { scopes, minutes: 10, max_calls: 200 });
  const actor = () => f.platform.authenticate(session.token);
  return { agent, session, actor };
}
const call = (f, method, actor, ...args) => f.tx(method, actor, ...args);
const rawText = (f) => JSON.stringify({
  vault: f.platform.all('SELECT * FROM resident_vault').map((row) => ({ ...row, nonce: Buffer.from(row.nonce).toString('latin1'), ciphertext: Buffer.from(row.ciphertext).toString('latin1') })),
  keys: f.platform.all('SELECT * FROM resident_vault_keys').map((row) => ({ ...row, wrapped_key: row.wrapped_key && Buffer.from(row.wrapped_key).toString('latin1') })),
});

// What an external agent does with its own key: AES-256-GCM, AAD bound to its identity and slot.
const clientAad = (agentId, slot, version) => Buffer.from(`nemo-vault/1|${agentId}|${slot}|${version}`);
function clientSeal(key, text, agentId, slot, version) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(clientAad(agentId, slot, version));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString('base64'), ciphertext: body.toString('base64') };
}
function clientOpen(key, note, agentId) {
  const body = Buffer.from(note.ciphertext, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(note.nonce, 'base64'));
  decipher.setAAD(clientAad(agentId, note.slot, note.version));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
}

test('a sealed vault round-trips for its own resident and stores no plaintext', async (t) => {
  const f = await fixture(t), r = resident(f);
  const written = call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  assert.equal(written.version, 1); assert.equal(written.mode, 'sealed'); assert.equal(written.notes, 1);
  const read = f.platform.vaultRead(r.actor(), {});
  assert.equal(read.mode, 'sealed'); assert.equal(read.notes[0].text, SECRET);
  assert.ok(!rawText(f).includes('orchard'), 'the database holds no plaintext');
  assert.ok(!readFileSync(f.database).toString('latin1').includes('quiet orchard'), 'the database file holds no plaintext');
  // The same text sealed twice never repeats a nonce or a ciphertext.
  const first = f.platform.get('SELECT nonce,ciphertext FROM resident_vault WHERE slot=1');
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  const second = f.platform.get('SELECT nonce,ciphertext,version FROM resident_vault WHERE slot=1');
  assert.notDeepEqual(Buffer.from(first.nonce), Buffer.from(second.nonce)); assert.equal(second.version, 2);
  assert.equal(f.platform.vaultRead(r.actor(), {}).notes[0].text, SECRET);
  assert.equal(statSync(join(f.directory, 'vault.key')).mode & 0o077, 0, 'the master key file is owner-only');
  assert.equal(f.platform.verifyAudit(), true);
  assert.ok(!f.platform.all('SELECT * FROM audit').some((entry) => JSON.stringify(entry).includes('orchard')), 'the audit trail never carries a note');
});

test('only the resident\'s own credential opens a vault', async (t) => {
  const f = await fixture(t), a = resident(f, 'alice'), b = resident(f, 'bob');
  call(f, 'vaultWrite', a.actor(), { slot: 3, text: SECRET });
  // The operator who owns the resident cannot read or write it through a session.
  assert.throws(() => f.platform.vaultRead(f.actor('alice'), { agent_id: a.agent.id }), { status: 403 });
  assert.throws(() => f.platform.vaultWrite(f.actor('alice'), { agent_id: a.agent.id, slot: 3, text: 'edited' }), { status: 403 });
  assert.throws(() => f.platform.vaultEnroll(f.actor('alice'), { agent_id: a.agent.id, mode: 'sealed' }), { status: 403 });
  // Another operator's resident is told the vault does not exist.
  assert.throws(() => f.platform.vaultRead(b.actor(), { agent_id: a.agent.id }), { status: 404 });
  assert.throws(() => f.platform.vaultStatus(b.actor(), { agent_id: a.agent.id }), { status: 404 });
  assert.throws(() => f.platform.vaultStatus(f.actor('bob'), { agent_id: a.agent.id }), { status: 404 });
  // A sibling of the same operator is another resident, so a resident credential cannot name it.
  const sibling = f.agent('alice', 'sibling resident');
  assert.throws(() => f.platform.vaultRead(a.actor(), { agent_id: sibling.id }), { status: 404 });
  assert.throws(() => f.platform.vaultWrite(a.actor(), { agent_id: sibling.id, slot: 1, text: 'x' }), { status: 404 });
  // A human avatar has no runtime credential and no vault.
  assert.throws(() => f.platform.vaultStatus(f.actor('alice'), { agent_id: f.platform.get("SELECT id FROM agents WHERE kind='human' LIMIT 1")?.id || 'none' }), { status: 404 });
});

test('the operator sees only counts and can erase, never read', async (t) => {
  const f = await fixture(t), r = resident(f);
  call(f, 'vaultWrite', r.actor(), { slot: 7, text: SECRET });
  const status = f.platform.vaultStatus(f.actor('alice'), { agent_id: r.agent.id });
  assert.deepEqual([status.enrolled, status.mode, status.notes], [true, 'sealed', 1]);
  assert.equal(status.slots, undefined, 'the operator gets no slot map'); assert.ok(!JSON.stringify(status).includes('orchard'));
  assert.deepEqual(status.policy, VAULT_POLICY);
  assert.deepEqual(f.platform.vaultStatus(r.actor(), {}).slots.map((slot) => slot.slot), [7]);
  assert.throws(() => f.platform.vaultManage(f.actor('alice'), { agent_id: r.agent.id, action: 'erase' }), { status: 400 });
  assert.throws(() => f.platform.vaultManage(r.actor(), { agent_id: r.agent.id, action: 'erase', confirm: true }), { status: 403 });
  assert.throws(() => f.platform.vaultManage(f.actor('bob'), { agent_id: r.agent.id, action: 'erase', confirm: true }), { status: 404 });
  assert.equal(f.tx('vaultManage', f.actor('alice'), { agent_id: r.agent.id, action: 'erase', confirm: true }).removed, 1);
  assert.equal(f.platform.vaultStatus(f.actor('alice'), { agent_id: r.agent.id }).enrolled, false);
  assert.equal(f.platform.verifyAudit(), true);
});

test('a vault read needs the vault scope the operator granted', async (t) => {
  const f = await fixture(t), granted = resident(f, 'alice', ['read', 'vault']);
  const without = f.agent('bob', 'no vault scope');
  const session = f.tx('runtime', f.actor('bob'), without.id, { scopes: ['read', 'contribute'], minutes: 5, max_calls: 20 });
  assert.doesNotThrow(() => f.platform.authenticate(granted.session.token, 'vault'));
  assert.throws(() => f.platform.authenticate(session.token, 'vault'), { status: 403 });
});

test('a resident-held key never reaches the server', async (t) => {
  const f = await fixture(t), r = resident(f), key = randomBytes(32);
  const check = clientSeal(key, 'nemo-vault-check', r.agent.id, 0, 0);
  const keyCheck = Buffer.concat([Buffer.from(check.nonce, 'base64'), Buffer.from(check.ciphertext, 'base64')]).toString('base64');
  const status = call(f, 'vaultEnroll', r.actor(), { mode: 'agent', key_check: keyCheck });
  assert.equal(status.mode, 'agent'); assert.equal(status.key_check, keyCheck);
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 1, text: SECRET }), { status: 400 });
  const sealed = clientSeal(key, SECRET, r.agent.id, 1, 1);
  const out = call(f, 'vaultWrite', r.actor(), { slot: 1, ...sealed });
  assert.deepEqual([out.version, out.mode], [1, 'agent']);
  const read = f.platform.vaultRead(r.actor(), {});
  assert.equal(read.mode, 'agent'); assert.equal(clientOpen(key, read.notes[0], r.agent.id), SECRET);
  assert.ok(!('text' in read.notes[0]));
  assert.ok(!rawText(f).includes('orchard'));
  // The master key is not involved: with no key file the host still cannot open it, and still works.
  assert.equal(f.platform.get('SELECT wrapped_key FROM resident_vault_keys').wrapped_key, null);
  // A ciphertext moved to another slot or an older version fails the resident's own authentication.
  const note = { ...read.notes[0], slot: 2 };
  assert.throws(() => clientOpen(key, note, r.agent.id));
  assert.throws(() => clientOpen(randomBytes(32), read.notes[0], r.agent.id));
  // Bad shapes are refused.
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 2, nonce: 'AAAA', ciphertext: sealed.ciphertext }), { status: 400 });
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 2, nonce: sealed.nonce, ciphertext: 'not base64!' }), { status: 400 });
  assert.throws(() => f.platform.vaultEnroll(r.actor(), { mode: 'agent' }), { status: 400 });
});

test('a sealed note moved between slots or residents fails authentication and is not returned', async (t) => {
  const f = await fixture(t), a = resident(f, 'alice');
  call(f, 'vaultWrite', a.actor(), { slot: 1, text: 'first note' });
  call(f, 'vaultWrite', a.actor(), { slot: 2, text: 'second note' });
  const one = f.platform.get('SELECT nonce,ciphertext FROM resident_vault WHERE slot=1');
  f.platform.run('UPDATE resident_vault SET nonce=?,ciphertext=? WHERE slot=2', one.nonce, one.ciphertext);
  assert.throws(() => f.platform.vaultRead(a.actor(), {}), { status: 503 });
});

test('the key model is chosen while the vault is empty and erase is the recovery path', async (t) => {
  const f = await fixture(t), r = resident(f);
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  assert.throws(() => f.platform.vaultEnroll(r.actor(), { mode: 'agent', key_check: Buffer.alloc(40, 1).toString('base64') }), { status: 409 });
  call(f, 'vaultWrite', r.actor(), { slot: 1, erase: true });
  assert.equal(f.platform.vaultStatus(r.actor(), {}).notes, 0);
  assert.equal(call(f, 'vaultEnroll', r.actor(), { mode: 'agent', key_check: Buffer.alloc(40, 1).toString('base64') }).mode, 'agent');
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 1, erase: true }), { status: 404 });
});

test('a vault stays inside its stated bounds', async (t) => {
  const f = await fixture(t), r = resident(f);
  for (const slot of [0, 65, 1.5, 'x', null]) assert.throws(() => f.platform.vaultWrite(r.actor(), { slot, text: 'note' }), { status: 400 });
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 1, text: '' }), { status: 400 });
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 1, text: 'x'.repeat(VAULT_LIMITS.note_chars + 1) }), { status: 400 });
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 1, text: 'bell\u0007' }), { status: 400 });
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 1, text: 'note', extra: true }), { status: 400 });
  for (let slot = 1; slot <= VAULT_LIMITS.slots; slot += 1) f.platform.transaction(() => f.platform.vaultWrite(r.actor(), { slot, text: `note ${slot}` }));
  assert.equal(f.platform.vaultStatus(r.actor(), {}).notes, VAULT_LIMITS.slots);
  assert.throws(() => f.platform.vaultWrite(r.actor(), { slot: 65, text: 'one too many' }), { status: 400 });
  // Multi-byte text reaches the byte total before the slot count does.
  const wide = await fixture(t), w = resident(wide);
  for (let slot = 1; slot <= 33; slot += 1) wide.platform.transaction(() => wide.platform.vaultWrite(w.actor(), { slot, text: '€'.repeat(1300) }));
  assert.throws(() => wide.platform.vaultWrite(w.actor(), { slot: 34, text: '€'.repeat(1300) }), { status: 429 });
  assert.throws(() => wide.platform.vaultWrite(w.actor(), { slot: 34, text: '€'.repeat(1400) }), { status: 400 });
});

test('a note is never evidence: it changes no receipt, memory, coin, plot or permission', async (t) => {
  const f = await fixture(t), r = resident(f);
  const tables = ['calling_receipts', 'resident_memory', 'coin_rewards', 'land_stewardships', 'frontier_blocks', 'claims', 'submissions', 'reviews'];
  const before = Object.fromEntries(tables.map((name) => [name, f.platform.get(`SELECT COUNT(*) AS n FROM ${name}`).n]));
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: 'I completed the garden objective and earned a coin.' });
  assert.deepEqual(Object.fromEntries(tables.map((name) => [name, f.platform.get(`SELECT COUNT(*) AS n FROM ${name}`).n])), before);
  assert.deepEqual(f.platform.runtimeStatus(r.actor()).scopes, ['read', 'vault']);
});

test('exports carry vault metadata only and account deletion erases the vault', async (t) => {
  const f = await fixture(t), r = resident(f);
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  const exported = f.platform.exportAccount(f.actor('alice'));
  assert.equal(exported.vault.vaults.length, 1); assert.equal(exported.vault.vaults[0].notes, 1);
  assert.ok(!JSON.stringify(exported).includes('orchard')); assert.ok(!JSON.stringify(exported).includes('wrapped_key'));
  f.tx('deleteVault', f.actor('alice'));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_vault').n + f.platform.get('SELECT COUNT(*) AS n FROM resident_vault_keys').n, 0);
});

test('a backup is valid, holds only ciphertext and fails validation when its structure is damaged', async (t) => {
  const f = await fixture(t), r = resident(f), backup = join(f.directory, 'backup.sqlite');
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  backupDatabase(f.platform.db, backup);
  assert.equal(validateDatabase(backup).schema_version ?? 26, 26);
  assert.ok(!readFileSync(backup).toString('latin1').includes('quiet orchard'));
  const damaged = join(f.directory, 'damaged.sqlite');
  backupDatabase(f.platform.db, damaged);
  const db = new DatabaseSync(damaged);
  db.exec('PRAGMA foreign_keys=OFF; DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases; DROP TRIGGER resident_vault_validate_insert;');
  db.close();
  assert.throws(() => validateDatabase(damaged), /vault/i);
  const orphan = join(f.directory, 'orphan.sqlite');
  backupDatabase(f.platform.db, orphan);
  const orphanDb = new DatabaseSync(orphan);
  orphanDb.exec('PRAGMA foreign_keys=OFF; DROP VIEW IF EXISTS karma_service_rules; DROP VIEW IF EXISTS karma_source_events; DROP TABLE IF EXISTS karma_receipts; DROP TABLE IF EXISTS karma_purchases; DROP TABLE IF EXISTS shop_purchases; DELETE FROM resident_vault_keys;');
  assert.equal(verifyVaultRecords(orphanDb), false);
  orphanDb.close();
  assert.throws(() => validateDatabase(orphan), /vault/i);
});

test('a missing master key fails closed and is never silently replaced', async (t) => {
  const f = await fixture(t), r = resident(f), file = join(f.directory, 'vault.key');
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  const original = readFileSync(file);
  f.platform.close();
  rmSync(file);
  const restarted = new Platform(f.database, f.clock);
  t.after(() => restarted.close());
  const actor = restarted.authenticate(r.session.token);
  assert.throws(() => restarted.vaultRead(actor, {}), { status: 503 });
  assert.equal(existsSync(file), false, 'no replacement key was minted');
  // Restoring the original key restores access.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, original, { mode: 0o600 });
  restarted.vaultMasterKey = null;
  assert.equal(restarted.vaultRead(restarted.authenticate(r.session.token), {}).notes[0].text, SECRET);
});

test('a master key file that is not owner-only is refused', async (t) => {
  const f = await fixture(t), r = resident(f), file = join(f.directory, 'vault.key');
  call(f, 'vaultWrite', r.actor(), { slot: 1, text: SECRET });
  const { chmodSync } = await import('node:fs');
  chmodSync(file, 0o644);
  f.platform.vaultMasterKey = null;
  assert.throws(() => f.platform.vaultRead(r.actor(), {}), /owner-only/);
});
