import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageHarrApp } from '../ops/package-harr-app.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harr-app-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['play/userdata', 'wt/veloren-integ/assets', 'wt/target/integ/release']) mkdirSync(join(root, dir), { recursive: true });
  const binary = join(root, 'wt/target/integ/release/veloren-voxygen');
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n%s\\n" "$VELOREN_ASSETS" "$VELOREN_USERDATA"\n', { mode: 0o700 });
  return { root, binary };
}
test('Mac app wraps the existing compiled client and uses the same world paths', t => {
  const f = fixture(t), app = packageHarrApp(f.root);
  assert.equal(readFileSync(join(app, 'Contents/MacOS/veloren-voxygen'), 'utf8'), readFileSync(f.binary, 'utf8'));
  const output = execFileSync(join(app, 'Contents/MacOS/Harr'), { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(output, [join(f.root, 'wt/veloren-integ/assets'), join(f.root, 'play/userdata')]);
  assert.match(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'), /org.nemoworld.harr/);
});
test('packaging refuses to overwrite an existing app', t => {
  const f = fixture(t), app = packageHarrApp(f.root);
  assert.throws(() => packageHarrApp(f.root), /exists/i);
  assert.ok(existsSync(join(app, 'Contents/Info.plist')));
});
test('a missing compiled client fails before creating an app', t => {
  const f = fixture(t); rmSync(f.binary);
  assert.throws(() => packageHarrApp(f.root));
  assert.equal(existsSync(join(f.root, 'play/Harr.app')), false);
});
