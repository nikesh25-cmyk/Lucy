import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Platform } from '../src/platform.js';

function start(t, database) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', LUCY_DATABASE: database, LUCY_BIND_HOST: '127.0.0.1',
      LUCY_PUBLIC_ORIGIN: '', RENDER_EXTERNAL_URL: '', LUCY_MODEL_NAME: '' },
  });
  const finished = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  t.after(async () => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); await finished; });
  return { child, finished, output: () => output };
}

test('startup refuses corrupt, foreign and newer worlds before writing or opening a listener', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'world-start-integrity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const kind of ['corrupt', 'foreign', 'newer']) {
    const database = join(directory, `${kind}.sqlite`);
    if (kind === 'corrupt') writeFileSync(database, 'This is not a world database.');
    else if (kind === 'foreign') { const db = new DatabaseSync(database); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close(); }
    else { const platform = new Platform(database); platform.db.exec('PRAGMA user_version=99'); platform.close(); }
    const before = readFileSync(database);
    const run = start(t, database);
    const [code, signal] = await run.finished;
    assert.equal(signal, null, run.output());
    assert.equal(code, 1, run.output());
    assert.doesNotMatch(run.output(), /NemoWorld is ready/);
    assert.deepEqual(readFileSync(database), before, `${kind} world must not be migrated or seeded`);
    assert.equal(existsSync(join(directory, 'server.lock')), false, 'failed startup releases its lock');
  }
});

test('a valid existing world starts after validation and retains its audited records', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'world-start-valid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'world.sqlite');
  const platform = new Platform(database);
  platform.run("INSERT INTO settings VALUES('startup-preservation','keep this operator setting')");
  platform.audit('fixture', 'startup.fixture.saved');
  const before = platform.all('SELECT * FROM audit'); platform.close();
  const run = start(t, database);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(run.output())), 15000);
    run.child.stdout.on('data', () => { const match = /NemoWorld is ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(run.output()); if (match) { clearTimeout(timer); resolve(match[1]); } });
    run.finished.then(() => { clearTimeout(timer); reject(Error(run.output())); });
  });
  assert.equal((await (await fetch(`${url}/api/v1/health`)).json()).status, 'ok');
  run.child.kill('SIGTERM'); assert.equal((await run.finished)[0], 0);
  const saved = new Platform(database);
  try {
    assert.deepEqual(saved.all('SELECT * FROM audit'), before);
    assert.equal(saved.get("SELECT value FROM settings WHERE key='startup-preservation'").value, 'keep this operator setting');
    assert.equal(saved.verifyAudit(), true);
  } finally { saved.close(); }
});
