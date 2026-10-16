import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { manifest } from '../src/content.js';
import { fixture } from './helpers.js';

async function setup(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the sealed content manifest is served as read-only public data', async (t) => {
  const base = await setup(t);
  const response = await fetch(`${base}/api/v1/content`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), manifest(), 'the route returns the sealed manifest');
  assert.equal((await fetch(`${base}/api/v1/content`, { method: 'POST', headers: { Origin: base } })).status, 405);
  // An unregistered path 404s in this hand-maintained route table.
  assert.equal((await fetch(`${base}/api/v1/not-a-content-route`)).status, 404);
});

test('every module and definition the browser imports is served with the right type', async (t) => {
  const base = await setup(t);
  // src/voxel-world.js is a browser module that imports src/content.js, which statically imports the
  // sealed bundle. Walking the real module graph from /app.js proves the hand-maintained static route
  // table serves everything the client needs; a missing file would otherwise only 404 in a browser.
  const seen = new Set(), queue = ['/app.js'];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await fetch(base + path);
    assert.equal(response.status, 200, `${path} must be served to the client`);
    if (path.endsWith('.json')) assert.match(response.headers.get('content-type'), /application\/json/, `${path} must be served as JSON for a JSON module import`);
    if (!path.endsWith('.js')) continue;
    const text = await response.text();
    for (const [, specifier] of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) queue.push(new URL(specifier, `http://localhost${path}`).pathname);
    }
  }
  for (const path of ['/src/content.js', '/content/index.js', '/content/content-manifest.json',
    ...manifest().entries.map((item) => `/${item.file}`), ...manifest().support.map((file) => `/${file.path}`)]) {
    assert.ok(seen.has(path), `${path} must be reachable from the client module graph`);
  }
  assert.equal((await fetch(`${base}/content/index.js`, { method: 'POST', headers: { Origin: base } })).status, 405);
  assert.equal((await fetch(`${base}/content/NOT-A-DEFINITION.json`)).status, 404);
});
