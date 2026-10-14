// Resident art — the staged CC0 set under `assets/residents/` and the interface that requests it.
//
// The tests answer three questions, in the order a reader would ask them:
//   1. every file the manifest claims exists, hashes to the recorded digest, and is listed once;
//   2. every path `app.js` can build for a resident is actually served by the server's static map,
//      with the right type, and every path outside the set is a 404 rather than a guess;
//   3. the interface renders those images with alt text built from the same strict allowlist the
//      nameplates use, so no private payload field can reach a portrait's label.
// Two more keep the placement honest: the drawn sizes stay whole multiples of the art, and the set
// stays small enough to fetch from the page it appears on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path));
const source = (path) => readFileSync(join(root, path), 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(source('assets/residents/manifest.json'));
const app = source('app.js');
const ALLOWED_LICENCES = ['CC0-1.0', 'OFL-1.1', 'ISC', 'MIT', 'CC-BY-3.0', 'CC-BY-4.0'];

// The interface's own counts. `app.js` states how many faces and figures the set has; the staged
// files and the server's route list have to agree with that number, so a face added to the folder but
// never served, or a route added for a file that was never staged, fails here rather than in a browser.
const declared = {
  faces: Number(/RESIDENT_FACE_COUNT = (\d+)/.exec(app)?.[1]),
  figures: Number(/RESIDENT_FIGURE_COUNT = (\d+)/.exec(app)?.[1]),
};

function stillPngHeader(bytes) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
}

test('every staged resident art file matches its recorded licence and provenance', () => {
  assert.equal(manifest.set, 'resident-art');
  assert.ok(manifest.sources.length >= 2, 'a face set and a figure set are recorded');
  const packIds = new Set(manifest.sources.map((item) => item.id));
  for (const item of manifest.sources) {
    assert.ok(ALLOWED_LICENCES.includes(item.licence), `${item.id} must be released under an allow-listed licence`);
    assert.equal(item.licence_url, 'https://creativecommons.org/publicdomain/zero/1.0/', `${item.id} records the licence it was released under`);
    for (const field of ['author', 'home', 'file', 'sha256', 'bytes', 'notice', 'modification']) assert.ok(item[field], `${item.id} must record ${field}`);
    assert.equal(item.sha256.length, 64, `${item.id} must record a SHA-256 of its source`);
    // A source archive or sheet that the project claims to have read is pinned, and the pinned value is
    // the digest this suite would compute for the same bytes; here it is checked for shape and, where
    // the file is staged, against the staged copy below.
    assert.ok(item.bytes > 0);
  }
  assert.equal(new Set(manifest.files.map((file) => file.path)).size, manifest.files.length, 'no staged file is listed twice');
  assert.equal(manifest.counts.files, manifest.files.length);
  for (const file of manifest.files) {
    assert.ok(packIds.has(file.source), `${file.path} names a recorded source pack`);
    const bytes = read(`assets/residents/${file.path}`);
    assert.ok(stillPngHeader(bytes), `${file.path} must be a PNG`);
    assert.equal(digest(bytes), file.sha256, `${file.path} must match the manifest digest`);
    assert.equal(bytes.length, file.bytes, `${file.path} must match the recorded size`);
    assert.deepEqual(file.dimensions, file.kind === 'face' ? [32, 32] : [16, 16], `${file.path} keeps its recorded art size`);
    if (file.kind === 'face') {
      const [left, top, right, bottom] = file.crop;
      assert.equal(right - left, 32, `${file.path} crops a 32 px cell`);
      assert.equal(bottom - top, 32, `${file.path} crops a 32 px cell`);
      assert.ok(left >= 0 && top >= 0, `${file.path} crops inside its source sheet`);
    } else {
      assert.equal(file.crop, null, `${file.path} is copied whole, not cropped`);
    }
  }
  // The face set is one sheet cropped on a recorded grid; the grid has to describe as many cells as
  // there are face files, or the recipe in NOTICE.md is describing a different sheet.
  const faces = manifest.sources.find((item) => item.kind === 'portrait-faceset');
  const grid = faces.crop_grid;
  assert.equal(grid.columns * grid.rows, manifest.counts.faces, 'the recorded crop grid yields exactly the staged faces');
  assert.equal(grid.cell[0], 32);
  const lastFace = manifest.files.filter((file) => file.kind === 'face').at(-1);
  assert.ok(lastFace.crop[2] <= faces.dimensions[0] && lastFace.crop[3] <= faces.dimensions[1], 'the last crop stays inside the source sheet');
  // Every staged file is on disk and every file on disk is staged, so a face added by hand cannot drift
  // out of the manifest and an entry cannot point at nothing.
  for (const [folder, kind] of [['faces', 'face'], ['bodies', 'figure']]) {
    const onDisk = readdirSync(join(root, 'assets/residents', folder)).filter((name) => name.endsWith('.png')).sort();
    const listed = manifest.files.filter((file) => file.kind === kind).map((file) => file.path.split('/')[1]).sort();
    assert.deepEqual(onDisk, listed, `assets/residents/${folder} and the manifest must list the same files`);
  }
  const notice = source('assets/residents/NOTICE.md');
  assert.match(notice, /CC0 1\.0 Universal/);
  for (const item of manifest.sources) assert.ok(notice.includes(item.author), `NOTICE.md must credit ${item.author}`);
});

test('the licence notice the pack shipped is retained and hashed', () => {
  const kenney = manifest.sources.find((item) => item.notice_file);
  const bytes = read(`assets/residents/${kenney.notice_file}`);
  assert.equal(digest(bytes), kenney.notice_sha256, 'the retained notice must match its recorded digest');
  assert.match(bytes.toString('utf8'), /Creative Commons Zero, CC0/);
});

async function setup(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('every face and figure path the interface can build is served by the static map', async (t) => {
  const base = await setup(t);
  assert.equal(declared.faces, manifest.counts.faces, 'app.js must ask for exactly the staged faces');
  assert.equal(declared.figures, manifest.counts.figures, 'app.js must ask for exactly the staged figures');
  const served = [];
  for (const [folder, count] of [['faces', declared.faces], ['bodies', declared.figures]]) {
    for (let id = 1; id <= count; id += 1) {
      const path = `/assets/residents/${folder}/${String(id).padStart(2, '0')}.png`;
      const response = await fetch(base + path);
      assert.equal(response.status, 200, `${path} must be served to the client`);
      assert.equal(response.headers.get('content-type'), 'image/png', `${path} must be served as a PNG`);
      assert.ok(stillPngHeader(Buffer.from(await response.arrayBuffer())), `${path} must return the staged PNG`);
      served.push(path);
    }
  }
  assert.equal(served.length, manifest.counts.files, 'the routes cover the whole staged set');
  // The ambassador's sealed portrait still rides the route the sealed content layer names, so the two
  // sources of a face are both live and the sealed one was not replaced.
  assert.equal((await fetch(`${base}/assets/mayors/facesets/16.png`)).status, 200);
  // The map is a written-out allow-list: a number just outside it, a name that was never staged, a
  // case variant, an unserved repository document and a path that leaves the set all fail rather than
  // resolving to a file the interface never asked for.
  for (const path of ['/assets/residents/faces/28.png', '/assets/residents/faces/00.png', '/assets/residents/bodies/11.png',
    '/assets/residents/faces/01.PNG', '/assets/residents/manifest.json', '/assets/residents/../../server.js']) {
    assert.equal((await fetch(base + path)).status, 404, `${path} must not resolve to a file`);
  }
  assert.equal((await fetch(`${base}/assets/residents/faces/01.png`, { method: 'POST', headers: { Origin: base } })).status, 405);
});

test('the interface draws resident art with bounded alt text and no private payload field', () => {
  // The renderer is the only place a resident image is built, and it sets `src` from the resolver and
  // `alt` from the allow-listed label. A second, hand-built `img` for a resident would fail this.
  assert.match(app, /function residentFace\(resident, size = 'sm'\)/, 'app.js keeps one face renderer');
  assert.match(app, /function residentFigure\(resident\)/, 'app.js keeps one figure renderer');
  assert.match(app, /image\.alt = residentArtAlt\(resident\)/, 'a face carries the shared alt text');
  assert.match(app, /image\.alt = residentArtAlt\(resident, 'appearance'\)/, 'a figure carries the shared alt text');
  const alt = /function residentArtAlt\(resident, art = 'portrait'\) \{([\s\S]*?)\n\}/.exec(app)?.[1];
  assert.ok(alt, 'the alt-text builder is readable');
  // The label reads a strict allow-list and nothing else: a payload field outside it cannot reach the
  // text, which is what keeps an operator email or a private journal out of an `alt` attribute.
  for (const field of ['resident?.name', 'resident?.kind']) assert.ok(alt.includes(field), `the label reads ${field}`);
  for (const secret of ['resident?.operator', 'resident?.capabilities', 'resident?.limitations', 'resident?.bio', 'resident?.email']) {
    assert.equal(alt.includes(secret), false, `${secret} must not reach a portrait's alt text`);
  }
  // The face is the resident's own sealed portrait when the server published a sprite, and a hash of
  // the stored id otherwise; the hash reads the id alone.
  assert.match(app, /function residentFacePath\(resident\) \{ return Number\.isInteger\(resident\?\.sprite\) \? `\/assets\/mayors\/facesets\/\$\{resident\.sprite\}\.png`/);
  assert.match(app, /residentArtId\(resident\?\.id, RESIDENT_FACE_COUNT\)/, 'a plain resident is keyed by its own id');
  const hash = /const residentIdHash = \(value\) => \{[^\n]*\}/.exec(app)?.[0];
  assert.ok(hash?.includes('String(value ?? \'\')'), 'the hash reads the id string and nothing else');
  assert.ok(hash?.includes('Math.imul'), 'the hash is the project\'s own stable FNV-1a fold, not a random draw');
  // Every layer the task names is wired: the roster, the profile card, the character picker and the
  // first-play guide. Each of these call sites is what a reader sees, so a missing one is a missing face.
  for (const call of ['append(row, residentFace(agent), paragraph(agent.capabilities', 'append(row, residentFace(agent), bio)',
    'append(top, residentFace(agent), bio)', 'append(top,residentFace(agent,\'lg\'),bio)',
    'append(row,residentFace(selected())', 'append(cover,residentFigure(selected()),residentFace(selected(),\'lg\'))',
    'decorateFirstPlayEncounter(node)']) {
    assert.ok(app.includes(call), `app.js must keep the resident-art call ${call}`);
  }
  assert.match(app, /card\.prepend\(figure\)/, 'the first-play encounter card receives the resident art');
  assert.match(app, /node\.querySelector\('\[data-guide="encounter"\]'\)/, 'the guide card is found by the class the guide module sets');
  // The colour the frame carries is one of the five sealed agent colours, so a payload cannot inject
  // an arbitrary style value into the element: the value only ever selects one of five classes.
  assert.match(app, /if \(colors\[resident\.color\]\) image\.classList\.add\(`nm-\$\{colors\[resident\.color\]\}`\)/);
  assert.equal(app.includes('image.style'), false, 'no inline style is written, so the CSP needs no exception');
  const cssColours = source('game-theme.css');
  for (const colour of ['blue', 'purple', 'coral', 'teal', 'gold']) assert.ok(cssColours.includes(`.resident-face.nm-${colour}{--agent-color:`), `${colour} must have a frame tint`);
});

test('the art direction the set is placed in keeps its two whole-number sizes', () => {
  const css = source('game-theme.css');
  assert.match(css, /\.resident-face\{[^}]*box-sizing:content-box;width:32px;height:32px/, 'a face is drawn at 1x of its own 32 px art');
  assert.match(css, /\.resident-face-lg\{width:64px;height:64px/, 'a large face is drawn at 2x, a whole multiple');
  assert.match(css, /\.resident-figure\{[^}]*width:64px;height:64px/, 'a 16 px figure is drawn at 4x, a whole multiple');
  assert.match(css, /image-rendering:pixelated/);
  // The mobile overrides stay whole multiples too, and the touch stylesheet is not touched: it owns a
  // documented `.nm-touch`-only contract enforced by tests/mobile-styles.test.js.
  const mobile = /@media\(max-width:650px\)\{\.resident-face-lg\{width:32px;height:32px[^}]*\}\.resident-figure\{width:48px;height:48px/.exec(css);
  assert.ok(mobile, 'the phone sizes are whole multiples of the art (1x and 3x)');
  assert.equal(source('game-mobile.css').includes('resident-'), false, 'the touch stylesheet keeps its .nm-touch-only contract');
});

test('the staged set stays small enough to serve from the page it appears on', () => {
  // The set is fetched by an ordinary page alongside the world, so it is bounded here rather than
  // discovered as a slow first paint: 37 files, under 300 KiB in total, roughly 3 KiB each.
  assert.equal(manifest.counts.files, 37, `${manifest.counts.files} staged files`);
  const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(total < 300 * 1024, `the staged set is ${total} bytes`);
  assert.ok(statSync(join(root, 'assets/residents', 'faces')).isDirectory());
});
