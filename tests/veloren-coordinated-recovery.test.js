// Offline acceptance rehearsal, NOT a production backup/restore command.
// Every path and key is created below; there are no live stack inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Platform } from '../src/platform.js';
import { VelorenLink, signEvent } from '../src/veloren-link.js';
import { issueCode, redeemCode, identityFor } from '../src/veloren-ext/identity.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';
import { encryptBackupFile, decryptBackupFile } from '../src/encrypted-backup.js';

const PLAYER = '11111111-1111-4111-8111-111111111111';
const LANDMARKS = [{ id: 'post', name: 'Post', role: 'post' }, { id: 'field', name: 'Field', role: 'survey' }];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const REQUIRED = ['world.sqlite', 'link.sqlite', 'events.jsonl', 'commands.jsonl', 'commands.claimed'];
function inventory(directory) {
  for (const name of REQUIRED) assert.ok(existsSync(join(directory, name)), `Missing coordinated component: ${name}`);
  return Object.fromEntries(REQUIRED.map(name => [name, hash(join(directory, name))]));
}

test('coordinated stopped-state recovery rehearsal on disposable real NemoWorld records', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nemo-coordinated-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = join(dir, 'fixture'), backup = join(dir, 'backup'), restored = join(dir, 'restored');
  for (const path of [live, backup, restored]) mkdirSync(path, { mode: 0o700 });
  const eventKey = randomBytes(32), backupKey = randomBytes(32); // Fixture-only; never printed or bundled.
  let now = Date.now(), sequence = 0;
  const options = path => ({ dbPath: join(path, 'link.sqlite'), eventKey, landmarks: LANDMARKS,
    commandsPath: join(path, 'commands.jsonl'), clock: () => now });
  let platform = new Platform(join(live, 'world.sqlite'), () => now);
  let link = new VelorenLink(options(live));
  t.after(() => { try { link.close(); } catch {} try { platform.close(); } catch {} });
  link.platform = platform;
  const credentials = await platform.register({ name: 'Recovery fixture', email: 'recovery@example.org',
    password: 'disposable-recovery-fixture-2026', consent: true });
  const actor = platform.authenticate(credentials.token);
  const avatar = platform.transaction(() => platform.createAgent(actor, { name: 'Saved human', kind: 'human' }));
  const code = issueCode(link, { player_uuid: PLAYER, player_alias: 'FixturePlayer', source: 'rehearsal' });
  redeemCode(link, { code: code.code, expect_alias: 'FixturePlayer', account_id: actor.account.id, peer: 'fixture' });
  const cred = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
  const auth = link.authenticate(cred.token, 'events');
  function save(kind, landmark_id) {
    now += 1000;
    const event = { v: 1, server_id: 'recovery-fixture', seq: ++sequence, kind, resident_id: 'lw-lyra',
      player_uuid: PLAYER, player_alias: 'FixturePlayer', landmark_id, occurred_at: now };
    event.sig = signEvent(eventKey, event);
    assert.equal(link.ingest(auth, [event])[0].status, 'accepted');
    return event;
  }
  const events = [save('resident.met', null), save('landmark.together', 'field'), save('resident.met', 'post')];
  assert.equal(link.progress(PLAYER).complete, true);
  const command = link.issueCommand({ kind: 'echo', player_uuid: PLAYER });
  events.push(save('command.applied', command.cmd_id));
  writeFileSync(join(live, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n', { mode: 0o600 });
  // Server journal fixture only: this is NOT evidence a Veloren effect was applied.
  writeFileSync(join(live, 'commands.claimed'), command.cmd_id + '\n', { mode: 0o600 });
  const expected = { identity: identityFor(link, PLAYER), progress: link.progress(PLAYER), status: link.status() };
  assert.equal(expected.identity.agent_id, avatar.id);
  link.close(); platform.close(); // Coordinated stop, all writers owned by this test.

  await t.test('main-world backup alone is detectably incomplete', () => {
    const db = new DatabaseSync(join(live, 'world.sqlite'));
    try { backupDatabase(db, join(backup, 'world.sqlite')); } finally { db.close(); }
    assert.throws(() => inventory(backup), /Missing coordinated component: link.sqlite/);
  });
  await t.test('both SQLite snapshots and replay files form one inventory', () => {
    const db = new DatabaseSync(join(live, 'link.sqlite'));
    try { db.prepare('VACUUM INTO ?').run(join(backup, 'link.sqlite')); } finally { db.close(); }
    for (const name of REQUIRED.slice(2)) copyFileSync(join(live, name), join(backup, name));
    inventory(backup);
    const db2 = new DatabaseSync(join(backup, 'link.sqlite'), { readOnly: true });
    try { assert.equal(db2.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db2.prepare('PRAGMA foreign_key_check').all(), []); } finally { db2.close(); }
    assert.equal(validateDatabase(join(backup, 'world.sqlite')).schema_version, 27);
  });
  const manifest = inventory(backup);
  await t.test('existing encryption protects every coordinated component', async () => {
    for (const name of REQUIRED) await encryptBackupFile(join(backup, name), join(backup, name + '.enc'), backupKey);
    const plainManifest = join(backup, 'manifest.json');
    writeFileSync(plainManifest, JSON.stringify({ format: 'rehearsal-v1', files: manifest }), { mode: 0o600 });
    await encryptBackupFile(plainManifest, join(backup, 'manifest.enc'), backupKey);
    for (const name of [...REQUIRED, 'manifest.json']) rmSync(join(backup, name));
    assert.ok(readdirSync(backup).every(name => name.endsWith('.enc')));
  });
  await t.test('wrong key and modified ciphertext fail without leaving a restored file', async () => {
    const output = join(restored, 'wrong.sqlite');
    await assert.rejects(decryptBackupFile(join(backup, 'link.sqlite.enc'), output, randomBytes(32)), /authentication failed/);
    assert.equal(existsSync(output), false);
    const damaged = join(backup, 'damaged.enc'), bytes = readFileSync(join(backup, 'link.sqlite.enc'));
    bytes[32] ^= 1; writeFileSync(damaged, bytes);
    await assert.rejects(decryptBackupFile(damaged, output, backupKey), /authentication failed/);
    assert.equal(existsSync(output), false); rmSync(damaged);
  });
  await t.test('restoration stages into a fresh directory and verifies the full inventory', async () => {
    await decryptBackupFile(join(backup, 'manifest.enc'), join(restored, 'manifest.json'), backupKey);
    const stored = JSON.parse(readFileSync(join(restored, 'manifest.json')));
    assert.equal(stored.format, 'rehearsal-v1');
    for (const name of REQUIRED) await decryptBackupFile(join(backup, name + '.enc'), join(restored, name), backupKey);
    assert.deepEqual(inventory(restored), stored.files);
    await assert.rejects(decryptBackupFile(join(backup, 'world.sqlite.enc'), join(restored, 'world.sqlite'), backupKey), /EEXIST/);
    assert.deepEqual(inventory(restored), stored.files, 'existing restored files were not overwritten');
  });
  await t.test('reopened services preserve account, human identity, completed quest, notes and replay safety', () => {
    platform = new Platform(join(restored, 'world.sqlite'), () => now);
    link = new VelorenLink(options(restored)); link.platform = platform;
    assert.equal(platform.authenticate(credentials.token).account.id, actor.account.id);
    assert.deepEqual(identityFor(link, PLAYER), expected.identity);
    assert.deepEqual(link.progress(PLAYER), expected.progress);
    assert.deepEqual(link.status(), expected.status);
    assert.equal(link.commandStatus(command.cmd_id).status, 'applied');
    const restoredAuth = link.authenticate(cred.token, 'events');
    for (const event of events) assert.equal(link.ingest(restoredAuth, [event])[0].status, 'duplicate');
    assert.deepEqual(link.status(), expected.status);
    assert.equal(readFileSync(join(restored, 'commands.claimed'), 'utf8'), command.cmd_id + '\n');
    assert.equal(platform.verifyAudit(), true);
  });
});
