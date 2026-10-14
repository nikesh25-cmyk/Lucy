import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '../src/platform.js';

test('a fresh hosted world admits its coded administrator, refuses public signup, and retains the policy', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nemoworld-initial-registration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.LUCY_INITIAL_REGISTRATION;
  t.after(() => {
    if (previous === undefined) delete process.env.LUCY_INITIAL_REGISTRATION;
    else process.env.LUCY_INITIAL_REGISTRATION = previous;
  });
  const database = join(directory, 'world.sqlite');
  process.env.LUCY_INITIAL_REGISTRATION = 'closed';
  let platform = new Platform(database);
  assert.equal(platform.registrationPolicy().mode, 'closed');
  platform.publicMode = true;
  platform.setupCode = 'private-disposable-setup-code-2026';
  const owner = { name: 'Owner', email: 'owner@example.test', password: 'disposable-test-password', consent: true };
  const administrator = await platform.register({ ...owner, setup_code: platform.setupCode });
  assert.equal(administrator.account.role, 'admin');
  await assert.rejects(platform.register({ ...owner, name: 'Visitor', email: 'visitor@example.test' }), { status: 403 });
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM accounts').n, 1);
  platform.close();
  process.env.LUCY_INITIAL_REGISTRATION = 'open';
  platform = new Platform(database);
  assert.equal(platform.registrationPolicy().mode, 'closed', 'a restart does not silently reopen signup');
  platform.close();
  process.env.LUCY_INITIAL_REGISTRATION = 'not-a-policy';
  assert.throws(() => new Platform(join(directory, 'invalid.sqlite')), /LUCY_INITIAL_REGISTRATION/);
});
