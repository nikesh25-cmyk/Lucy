import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, copyFile, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Platform } from '../src/platform.js';

test('local launcher selects a free loopback port, ignores hosted origin settings, and saves first-run state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'world-launch-test-'));
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  const database = join(directory, 'world.sqlite');
  // The bundled local AI runtime is unrelated to this launcher test and re-verifies a 2.5 GB model
  // on every start, so skip it (the launcher's own supported no-AI switch) instead of racing it.
  const child = spawn('bash', ['scripts/start-mac.sh'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: String(occupied.address().port), LUCY_DATABASE: database,
      LUCY_PUBLIC_ORIGIN: 'https://example.org', RENDER_EXTERNAL_URL: 'https://example.org', LUCY_OPEN_BROWSER: '0', LUCY_LOCAL_AI: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const finished = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await finished;
    await new Promise((resolve) => occupied.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let output = '', errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Launcher not ready: ${errors}`)), 60000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /Your world: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    finished.then(([code]) => { clearTimeout(timeout); reject(new Error(`Launcher exited ${code}: ${errors}`)); }, reject);
  });
  assert.notEqual(Number(new URL(url).port), occupied.address().port);
  const health = await fetch(`${url}/api/v1/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.storage, 'sqlite');
  const setup = await fetch(`${url}/api/v1/bootstrap`).then((response) => response.json());
  assert.equal(setup.setup_required, true);
  assert.equal(setup.setup_code_required, false);
  assert.equal((await fetch(`${url}/api/v1/worlds`).then((response) => response.json())).shared_count, 30);
  child.kill('SIGTERM');
  assert.equal((await finished)[0], 0);
  const saved = new Platform(database);
  try { assert.equal(saved.get('PRAGMA user_version').user_version, 26); assert.equal(saved.verifyAudit(), true); }
  finally { saved.close(); }
});

test('Mac setup detects Apple Silicon through Rosetta and rejects an unverified runtime before extraction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'world-mac-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project with spaces'), bin = join(directory, 'bin');
  await mkdir(join(project, 'scripts'), { recursive: true }); await mkdir(bin);
  await copyFile(new URL('../scripts/start-mac.sh', import.meta.url), join(project, 'scripts', 'start-mac.sh'));
  const stubs = {
    node: '#!/bin/sh\nexit 1\n',
    uname: '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo x86_64;; esac\n',
    sysctl: '#!/bin/sh\necho 1\n',
    curl: '#!/bin/sh\nprintf "%s\\n" "$*" > "$LOCAL_WORLD_FIXTURE_TRACE"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf "invalid fixture" > "$1"; exit 0; fi; shift; done\nexit 1\n',
    tar: '#!/bin/sh\ntouch "$LOCAL_WORLD_FIXTURE_UNPACKED"\nexit 0\n',
  };
  for (const [name, content] of Object.entries(stubs)) await writeFile(join(bin, name), content, { mode: 0o755 });
  const trace = join(directory, 'trace'), unpacked = join(directory, 'unpacked');
  const child = spawn('bash', [join(project, 'scripts', 'start-mac.sh')], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCAL_WORLD_FIXTURE_TRACE: trace, LOCAL_WORLD_FIXTURE_UNPACKED: unpacked },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  assert.equal((await once(child, 'exit'))[0], 1);
  assert.match(errors, /checksum does not match/);
  assert.match(await readFile(trace, 'utf8'), /node-v24\.19\.0-darwin-arm64\.tar\.gz/);
  await assert.rejects(access(unpacked), { code: 'ENOENT' });
});
