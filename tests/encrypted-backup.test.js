import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '../src/platform.js';
import { acquireProcessLock, validateDatabase } from '../src/recovery.js';

const cli = new URL('../scripts/recovery.js', import.meta.url).pathname;
const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }));
const refused = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('encrypted export restores a validated world and rejects a wrong key or changed ciphertext', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nemoworld-sealed-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = join(directory, 'world.sqlite'), sealed = join(directory, 'off-install.nemoenc');
  const key = join(directory, 'recovery.key'), wrong = join(directory, 'wrong.key');
  const platform = new Platform(world);
  platform.transaction(() => platform.audit('system', 'saved.before.backup'));
  platform.close();
  assert.equal(run('keygen', key).path, key);
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(refused('keygen', key).status, 1, 'a key may not be replaced');
  assert.equal(run('backup-encrypted', world, sealed, key).format, 'NEMOBK01');
  assert.equal(statSync(sealed).mode & 0o777, 0o600);
  const bytes = readFileSync(sealed);
  assert.equal(bytes.subarray(0, 8).toString(), 'NEMOBK01');
  assert.equal(bytes.includes(Buffer.from('SQLite format 3')), false);
  assert.equal(run('verify-encrypted', sealed, key).schema_version, 25);
  assert.equal(readdirSync(directory).some((item) => item.includes('encrypted-stage')), false);
  run('keygen', wrong);
  const wrongTarget = join(directory, 'wrong-target.sqlite');
  assert.equal(refused('restore-encrypted', sealed, wrongTarget, wrong).status, 1);
  assert.equal(existsSync(wrongTarget), false, 'a wrong key must not create a destination');
  const before = createHash('sha256').update(readFileSync(world)).digest('hex');
  assert.equal(refused('restore-encrypted', sealed, world, wrong).status, 1);
  assert.equal(createHash('sha256').update(readFileSync(world)).digest('hex'), before, 'a wrong key leaves the existing world byte-identical');
  const release = acquireProcessLock(join(directory, 'server.lock'));
  try {
    assert.equal(refused('backup-encrypted', world, join(directory, 'locked.nemoenc'), key).status, 1);
    assert.equal(existsSync(join(directory, 'locked.nemoenc')), false);
  } finally { release(); }
  const changed = join(directory, 'changed.nemoenc');
  const tampered = Buffer.from(bytes); tampered[32] ^= 1; writeFileSync(changed, tampered);
  assert.equal(refused('verify-encrypted', changed, key).status, 1);
  const target = join(directory, 'restored.sqlite');
  const restored = run('restore-encrypted', sealed, target, key);
  assert.equal(restored.schema_version, 25);
  assert.equal(validateDatabase(target).schema_version, 25);
  const reopened = new Platform(target);
  try { assert.equal(reopened.get("SELECT COUNT(*) AS n FROM audit WHERE event='saved.before.backup'").n, 1); }
  finally { reopened.close(); }
  const retained = join(directory, 'already-there.nemoenc');
  copyFileSync(sealed, retained);
  assert.equal(refused('backup-encrypted', world, retained, key).status, 1);
  assert.deepEqual(readFileSync(retained), bytes, 'an existing encrypted copy must not be overwritten or deleted');
});
