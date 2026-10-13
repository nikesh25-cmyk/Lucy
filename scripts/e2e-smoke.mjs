#!/usr/bin/env node
// NemoWorld release-acceptance harness.
//
// It starts the shipped server as a real child process in a private temporary
// workspace, points it at a temporary SQLite database through LUCY_DATABASE,
// runs the public-deployment first-administrator scenario over its own HTTP
// API, and then stops the server and removes the workspace. The shipped data
// directory and any world already running on this machine are never touched,
// no module from src/ is imported, and no request is mocked.
//
// Run it with:  npm run e2e
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Public hosting is defined by an exact external HTTPS origin; the process still
// binds loopback only, and every request carries that origin's Host header.
const PUBLIC_ORIGIN = 'https://acceptance.nemoworld.test';
const PUBLIC_HOST = 'acceptance.nemoworld.test';
const SETUP_CODE = 'nemoworld-e2e-private-setup-code-2026';
const PASSWORD = 'e2e-acceptance-password-2026';
const ADMIN = { name: 'Acceptance administrator', email: 'admin@e2e.test' };
const REVIEWER = { name: 'Acceptance reviewer', email: 'reviewer@e2e.test' };
const REQUEST_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 180_000;
// Server-side throttles: one step per 120 ms, one frontier action per 200 ms.
const MOVE_INTERVAL_MS = 150;
const FRONTIER_ACTION_INTERVAL_MS = 300;
// Mirrors the collision legend published by world.js walkable(): water, trees,
// buildings, fountains and walls are not walkable. Paths and bridges are.
const UNWALKABLE = new Set(['water', 'tree', 'building', 'fountain', 'wall']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) => JSON.stringify(value);
const describe = (value) => (value === undefined ? 'undefined' : typeof value === 'string' ? value : json(value));
const redactRequest = (request) => ({
  method: request.method,
  path: request.path,
  headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, ['authorization', 'cookie'].includes(key.toLowerCase()) ? '<redacted>' : value])),
  body: request.body,
});

class AcceptanceFailure extends Error {
  constructor({ message, expected, actual, request, response }) {
    super(message);
    this.expected = expected;
    this.actual = actual;
    this.request = request;
    this.response = response;
  }
}

function failCheck(label, { expected, actual, request, response }) {
  throw new AcceptanceFailure({ message: label, expected, actual, request, response });
}

function expectStatus(response, statuses, label) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(response.status)) {
    failCheck(label, { expected: `HTTP ${allowed.join(' or ')}`, actual: `HTTP ${response.status} ${response.raw || ''}`, request: response.request, response });
  }
  return response.body;
}

function expectThat(condition, label, evidence = {}) {
  if (!condition) failCheck(label, evidence);
}

function headerOf(response, name) {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join('; ') : value ?? null;
}

const state = { workspace: null, database: null, port: null, child: null, notes: [], results: [] };
let serverOutput = [];

function apiRequest(path, options = {}) {
  const { method = 'GET', token, cookie, body: payload, headers = {}, apiClient } = options;
  const data = payload === undefined ? null : Buffer.from(json(payload));
  const sent = { Host: PUBLIC_HOST, ...headers };
  if (data) { sent['Content-Type'] = 'application/json'; sent['Content-Length'] = String(data.length); sent.Origin = PUBLIC_ORIGIN; }
  if (token) sent.Authorization = `Bearer ${token}`;
  if (cookie) sent.Cookie = cookie;
  if (apiClient) sent['X-API-Client'] = apiClient;
  const record = { method, path: `/api/v1${path}`, headers: sent, body: payload ?? null };
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: state.port, path: record.path, method, headers: sent, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        resolve({ status: response.statusCode, headers: response.headers, raw, body, request: record });
      });
    });
    request.on('error', (error) => reject(new AcceptanceFailure({ message: `request ${record.method} ${record.path} failed: ${error.message}`, request: record })));
    if (data) request.write(data);
    request.end();
  });
}

const get = (path, options) => apiRequest(path, options);
const post = (path, payload, options = {}) => apiRequest(path, { ...options, method: 'POST', body: payload });

async function step(name, action) {
  const started = Date.now();
  const detail = await action();
  const elapsed = Date.now() - started;
  state.results.push({ name, ok: true });
  console.log(`PASS  ${name}${detail ? `\n        ${detail}` : ''}  (${elapsed} ms)`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const env = { ...process.env, PORT: String(state.port), LUCY_DATABASE: state.database, LUCY_PUBLIC_ORIGIN: PUBLIC_ORIGIN, LUCY_SETUP_CODE: SETUP_CODE, LUCY_BIND_HOST: '127.0.0.1' };
  for (const name of ['LUCY_LOCAL_PORT_FALLBACK', 'RENDER_EXTERNAL_URL', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const collect = (chunk) => { serverOutput.push(chunk.toString('utf8').trimEnd()); if (serverOutput.length > 40) serverOutput = serverOutput.slice(-40); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('exit', (code, signal) => { serverOutput.push(`[server exited] code=${code} signal=${signal}`); });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited before becoming ready (code ${child.exitCode}).\n${serverOutput.join('\n')}`);
    try {
      const response = await apiRequest('/health');
      if (response.status === 200) return response.body;
      last = `HTTP ${response.status} ${response.raw}`;
    } catch (error) { last = error.message; }
    await sleep(250);
  }
  throw new Error(`The server did not become ready within ${READY_TIMEOUT_MS} ms; last observation: ${last}`);
}

async function stopServer() {
  const child = state.child;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited, sleep(10_000).then(() => false)]);
    if (!graceful) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); }
  }
  state.child = null;
  const lock = join(state.workspace, 'server.lock');
  const keep = process.env.LUCY_E2E_KEEP === '1';
  if (!keep) await rm(state.workspace, { recursive: true, force: true });
  return { lockReleased: !existsSync(lock), workspaceRemoved: !existsSync(state.workspace), kept: keep };
}

/**
 * Stops the running server and starts it again against the *same* temporary database. This is the
 * restart-persistence probe: unlike `stopServer`, it never removes the workspace, so the restored
 * garden, the pledges and the guide reads can be compared before and after a real process restart.
 */
async function restartServer() {
  const child = state.child;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited, sleep(10_000).then(() => false)]);
    if (!graceful) { child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); }
  }
  state.child = null;
  serverOutput = [];
  await sleep(500);
  return startServer();
}

function walkableTile(grid, x, y) {
  const type = grid[y]?.[x];
  return typeof type === 'string' && !UNWALKABLE.has(type);
}

function windowStarts(minimum, maximum, size, limit) {
  const starts = [];
  for (let value = Math.max(0, minimum - 3); value < Math.min(maximum + 3, limit); value += size) starts.push(Math.max(0, Math.min(limit - size, value)));
  const last = Math.max(0, Math.min(limit - size, maximum));
  if (!starts.includes(last)) starts.push(last);
  return [...new Set(starts)].sort((a, b) => a - b);
}

// The world view publishes 20 x 14 terrain windows placed by their camera origin.
async function readTerrain(worldId, area) {
  const descriptor = expectStatus(await get(`/world?world_id=${encodeURIComponent(worldId)}`), 200, `GET /world?world_id=${worldId}`);
  const width = descriptor.bounds.columns, height = descriptor.bounds.rows;
  const rows = descriptor.terrain.length, columns = descriptor.terrain[0].length;
  const areaX = { minimum: area?.minimumX ?? 0, maximum: area?.maximumX ?? width - 1 };
  const areaY = { minimum: area?.minimumY ?? 0, maximum: area?.maximumY ?? height - 1 };
  const grid = Array.from({ length: height }, () => new Array(width).fill(undefined));
  const solid = new Set(), decorative = new Set();
  let pages = 0;
  const collectScenery = (page) => { for (const item of page.scenery || []) { if (!Number.isInteger(item?.x) || !Number.isInteger(item?.y)) continue; (item.blocks === true ? solid : decorative).add(`${item.x},${item.y}`); } };
  collectScenery(descriptor);
  for (const x of windowStarts(areaX.minimum, areaX.maximum, columns, width)) {
    for (const y of windowStarts(areaY.minimum, areaY.maximum, rows, height)) {
      const page = expectStatus(await get(`/world?world_id=${encodeURIComponent(worldId)}&x=${x}&y=${y}`), 200, `GET /world window ${x},${y}`);
      for (let row = 0; row < page.terrain.length; row++) for (let column = 0; column < page.terrain[row].length; column++) grid[page.camera.y + row][page.camera.x + column] = page.terrain[row][column];
      collectScenery(page);
      pages++;
    }
  }
  return { descriptor, grid, width, height, columns, rows, pages, solid, decorative };
}

function distancesFrom(grid, origin, blocked = new Set()) {
  const distances = new Map();
  const key = (x, y) => `${x},${y}`;
  if (!walkableTile(grid, origin.x, origin.y)) failCheck(`the starting tile ${key(origin.x, origin.y)} is not walkable`, { expected: 'a walkable terrain tile', actual: describe(grid[origin.y]?.[origin.x]) });
  distances.set(key(origin.x, origin.y), 0);
  const queue = [origin];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const x = current.x + dx, y = current.y + dy, next = key(x, y);
      if (distances.has(next) || blocked.has(next) || !walkableTile(grid, x, y)) continue;
      distances.set(next, distances.get(key(current.x, current.y)) + 1);
      queue.push({ x, y });
    }
  }
  return distances;
}

function pathTo(grid, origin, target, blocked = new Set()) {
  const key = (x, y) => `${x},${y}`;
  const cameFrom = new Map([[key(origin.x, origin.y), null]]);
  const queue = [origin];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.x === target.x && current.y === target.y) break;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const x = current.x + dx, y = current.y + dy, next = key(x, y);
      if (cameFrom.has(next) || blocked.has(next) || !walkableTile(grid, x, y)) continue;
      cameFrom.set(next, current);
      queue.push({ x, y });
    }
  }
  if (!cameFrom.has(key(target.x, target.y))) return null;
  const path = [];
  for (let node = target; node; node = cameFrom.get(key(node.x, node.y))) path.unshift(node);
  return path.slice(1);
}

async function moveOnce(token, direction, extra = {}) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? MOVE_INTERVAL_MS : 400);
    response = await post('/move', { ...extra, direction }, { token });
    if (response.status !== 429) return response;
  }
  return response;
}

async function walkTo(token, from, target, grid, blocked, extra = {}) {
  const path = pathTo(grid, from, target, blocked);
  expectThat(path !== null, `no walkable route from ${from.x},${from.y} to ${target.x},${target.y}`, { expected: 'a connected walkable route', actual: describe(grid[target.y]?.[target.x]) });
  let current = from;
  for (const next of path) {
    const direction = next.x > current.x ? 'right' : next.x < current.x ? 'left' : next.y > current.y ? 'down' : 'up';
    const response = await moveOnce(token, direction, extra);
    expectStatus(response, 200, `POST /move ${direction} from ${current.x},${current.y}`);
    const body = response.body;
    expectThat(body.blocked === false, `POST /move ${direction} from ${current.x},${current.y} was blocked on a planned walkable tile`, { expected: `blocked=false arriving at ${next.x},${next.y}`, actual: `blocked=${describe(body.blocked)} at ${body.x},${body.y}`, request: response.request, response });
    expectThat(body.x === next.x && body.y === next.y, 'the server position must match the planned route', { expected: `${next.x},${next.y}`, actual: `${body.x},${body.y}`, request: response.request, response });
    current = { x: body.x, y: body.y };
  }
  return current;
}

// The collision refusal is proved on a real unwalkable tile: walk to the nearest
// reachable tile that touches one, then ask the server to step onto it. A solid
// scenery tile is preferred when one is reachable, so the shared footprint table
// (src/footprints.js) is proved at the release gate as well as the terrain legend.
async function proveCollisionRefusal(token, from, grid, blocked, scenery = new Set()) {
  const distances = distancesFrom(grid, from, blocked);
  let probe = null;
  for (const [key, distance] of distances) {
    const [x, y] = key.split(',').map(Number);
    for (const [direction, [dx, dy]] of Object.entries({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] })) {
      const neighbour = `${x + dx},${y + dy}`;
      // A gate or passage neighbour is unreachable; a solid-scenery neighbour is the refusal we want.
      const solidScenery = scenery.has(neighbour);
      if (!solidScenery && blocked.has(neighbour)) continue;
      const type = grid[y + dy]?.[x + dx];
      if (!solidScenery && (typeof type !== 'string' || !UNWALKABLE.has(type))) continue;
      if (!probe || (solidScenery && !probe.solidScenery) || (solidScenery === probe.solidScenery && distance < probe.distance)) {
        probe = { x, y, distance, direction, type: solidScenery ? `solid ${describe(type)} scenery` : type, solidScenery };
      }
    }
  }
  expectThat(probe, 'the character must be able to reach a tile beside an unwalkable or solid-scenery tile', { expected: 'a reachable tile with a refused neighbour', actual: `origin ${from.x},${from.y} with ${distances.size} reachable tiles` });
  const position = await walkTo(token, from, { x: probe.x, y: probe.y }, grid, blocked);
  const response = await moveOnce(token, probe.direction);
  expectStatus(response, 200, `POST /move ${probe.direction} onto an unwalkable ${probe.type} tile`);
  expectThat(response.body.blocked === true, `moving onto an unwalkable ${probe.type} tile must be refused`, { expected: 'blocked=true', actual: describe(response.body), request: response.request, response });
  expectThat(response.body.x === position.x && response.body.y === position.y, 'a refused move must leave the position unchanged', { expected: `${position.x},${position.y}`, actual: `${response.body.x},${response.body.y}`, request: response.request, response });
  return { position, probe };
}

// The other half of the same rule: a decorative scenery tile stays walkable, so a
// resident is never fenced out of the ground cover the renderer draws as flat.
async function proveDecorationWalk(token, from, grid, solid, decorative) {
  const distances = distancesFrom(grid, from, solid);
  // The step that lands on the decoration is the reverse of the offset from it to its stand tile.
  const reverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
  let candidate = null;
  for (const key of decorative) {
    const [x, y] = key.split(',').map(Number);
    for (const [direction, [dx, dy]] of Object.entries({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] })) {
      const distance = distances.get(`${x + dx},${y + dy}`);
      if (distance === undefined) continue;
      if (!candidate || distance < candidate.distance) candidate = { x, y, direction: reverse[direction], distance, stand: { x: x + dx, y: y + dy } };
    }
  }
  expectThat(candidate, 'a decorative scenery tile must border a reachable tile', { expected: 'a reachable tile beside decorative scenery', actual: `${decorative.size} decorative tiles` });
  const position = await walkTo(token, from, candidate.stand, grid, solid);
  const response = await moveOnce(token, candidate.direction);
  expectStatus(response, 200, `POST /move ${candidate.direction} onto a decorative scenery tile`);
  expectThat(response.body.blocked === false, 'a decorative scenery tile must stay walkable', { expected: 'blocked=false', actual: describe(response.body), request: response.request, response });
  expectThat(response.body.x === candidate.x && response.body.y === candidate.y, 'the resident must reach the decorative tile', { expected: `${candidate.x},${candidate.y}`, actual: `${response.body.x},${response.body.y}`, request: response.request, response });
  return response.body;
}

// Candidate construction sites: every walkable tile of an available parcel,
// paired with the cheapest reachable tile to build from within the published
// build range. Passages, arrivals and gates live in permanently reserved
// parcels, so an available parcel never contains a protected tile.
function constructionOptions({ grid, parcels, origin, buildRange, blocked = new Set() }) {
  const distances = distancesFrom(grid, origin, blocked);
  const options = [];
  for (const parcel of parcels) {
    if (parcel.state !== 'available' || parcel.permanent_reserved) continue;
    const cells = [];
    for (let y = parcel.y; y < parcel.y + parcel.height; y++) {
      for (let x = parcel.x; x < parcel.x + parcel.width; x++) {
        if (!walkableTile(grid, x, y)) continue;
        let stand = null;
        for (let dy = -buildRange; dy <= buildRange; dy++) {
          for (let dx = -buildRange; dx <= buildRange; dx++) {
            const reach = Math.abs(dx) + Math.abs(dy);
            if (reach === 0 || reach > buildRange) continue;
            const distance = distances.get(`${x + dx},${y + dy}`);
            if (distance === undefined) continue;
            if (!stand || distance < stand.distance) stand = { x: x + dx, y: y + dy, distance };
          }
        }
        if (stand) cells.push({ parcel, tile: { x, y }, stand, distance: stand.distance, standsInside: stand.x >= parcel.x && stand.x < parcel.x + parcel.width && stand.y >= parcel.y && stand.y < parcel.y + parcel.height });
      }
    }
    cells.sort((a, b) => (a.standsInside - b.standsInside) || a.distance - b.distance || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
    options.push(...cells);
  }
  options.sort((a, b) => a.distance - b.distance || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
  const inside = options.filter((option) => option.standsInside);
  const chosen = inside.length ? inside[0] : options[0];
  return { chosen, options: [chosen, ...options.filter((option) => option !== chosen)] };
}

// A free, walkable tile in a resident's own garden: inside the published window, away from the
// arrival and every doorway (the build method refuses trips and doorways), and not already built on.
function gardenFarmSite(descriptor, agentId) {
  const resident = descriptor.participants.find((entry) => entry.id === agentId) || descriptor.camera;
  const away = (point, x, y) => Math.abs(point.x - x) + Math.abs(point.y - y) > 1;
  const sites = [];
  for (let row = 0; row < descriptor.terrain.length; row++) {
    for (let column = 0; column < descriptor.terrain[row].length; column++) {
      if (!walkableTile(descriptor.terrain, column, row)) continue;
      const x = descriptor.camera.x + column, y = descriptor.camera.y + row;
      if (!away(resident, x, y) || descriptor.portals.some((portal) => !away(portal, x, y))) continue;
      if ((descriptor.objects || []).some((object) => object.x === x && object.y === y)) continue;
      sites.push({ x, y, distance: Math.abs(resident.x - x) + Math.abs(resident.y - y) });
    }
  }
  sites.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  return sites[0] || null;
}

/**
 * Walks a resident already standing in a garden to a target tile, using only the shipped movement
 * route. The garden is read in full first, so the path planner runs on the server's own terrain and
 * the walk proves the same walkable/blocked rules the browser drives.
 */
async function walkActorIntoGarden(token, agentId, garden, target) {
  const terrain = await readTerrain(garden, null);
  const participant = (terrain.descriptor.participants || []).find((entry) => entry.id === agentId);
  expectThat(participant, 'the resident must appear in the garden the world read publishes', { expected: `participant ${agentId}`, actual: describe((terrain.descriptor.participants || []).map((entry) => entry.id)) });
  return walkTo(token, { x: participant.x, y: participant.y }, target, terrain.grid, terrain.solid, { agent_id: agentId });
}

async function main() {
  state.workspace = await mkdtemp(join(tmpdir(), 'nemoworld-e2e-'));
  state.database = join(state.workspace, 'world.sqlite');
  state.port = await freePort();

  console.log('NemoWorld end-to-end acceptance harness');
  console.log(`  base URL          http://127.0.0.1:${state.port} (public Host ${PUBLIC_HOST})`);
  console.log(`  public origin     ${PUBLIC_ORIGIN}`);
  console.log(`  temporary data    ${state.workspace}`);
  console.log('');

  const world = {};
  let failure = null;

  try {
    const health = await startServer();
    console.log(`  server ready      GET /api/v1/health -> 200 ${json(health)}`);
    console.log('');

    expectThat(existsSync(join(state.workspace, 'server.lock')), 'the server must take its process lock inside the temporary workspace', { expected: `a lock at ${join(state.workspace, 'server.lock')}`, actual: 'no lock file' });
    expectThat(!state.database.startsWith(join(ROOT, 'data')), 'the harness must never point at the shipped data directory', { expected: 'a temporary database path', actual: state.database });

    await step('1. bootstrap reports the public first-administrator gate', async () => {
      const response = await get('/bootstrap');
      const body = expectStatus(response, 200, 'GET /bootstrap on an empty public installation');
      expectThat(body.setup_required === true, 'setup_required must be true before the first administrator exists', { expected: 'setup_required=true', actual: describe(body), request: response.request, response });
      expectThat(body.setup_code_required === true, 'a public installation without an administrator must require the private setup code', { expected: 'setup_code_required=true', actual: describe(body), request: response.request, response });
      expectThat(body.registration_open === true, 'registration_open must report the open registration policy', { expected: 'registration_open=true', actual: describe(body), request: response.request, response });
      expectThat(body.registration?.mode === 'open' && body.registration?.public_signup === false && body.registration?.first_admin_required === true, 'the registration object must report the first-administrator state', { expected: 'registration={mode:open,public_signup:false,first_admin_required:true}', actual: describe(body.registration), request: response.request, response });
      expectThat(!response.raw.includes(SETUP_CODE), 'the API must never return the private setup code', { expected: 'no setup code in the response', actual: 'the setup code appeared in the response body', request: response.request, response });
      return `200 {setup_required:true, setup_code_required:true, registration_open:true, registration.mode:open, registration.public_signup:false}`;
    });

    await step('2. first administrator is refused without, and accepted with, the setup code', async () => {
      const withoutCode = await post('/auth/register', { ...ADMIN, password: PASSWORD, consent: true });
      expectStatus(withoutCode, 403, 'POST /auth/register without setup_code');
      const wrongCode = await post('/auth/register', { ...ADMIN, password: PASSWORD, consent: true, setup_code: 'wrong-private-setup-code-2026' });
      expectStatus(wrongCode, 403, 'POST /auth/register with a wrong setup code');
      const created = await post('/auth/register', { ...ADMIN, password: PASSWORD, consent: true, setup_code: SETUP_CODE }, { apiClient: 'operator' });
      const account = expectStatus(created, 201, 'POST /auth/register with the setup code');
      expectThat(account.account?.role === 'admin', 'the first account must become the administrator', { expected: 'role=admin', actual: describe(account.account), request: created.request, response: created });
      expectThat(/^[a-f0-9]{64}$/.test(account.token || ''), 'registration must return the one-time login token', { expected: 'a 64-character hexadecimal token', actual: describe(account.token), request: created.request, response: created });
      const cookie = headerOf(created, 'set-cookie');
      expectThat(cookie && /world_session=/.test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Secure/.test(cookie), 'public mode must set a Secure HttpOnly SameSite session cookie', { expected: 'Set-Cookie: world_session=…; HttpOnly; SameSite=Strict; Secure', actual: describe(cookie), request: created.request, response: created });
      expectThat(headerOf(created, 'strict-transport-security') === 'max-age=31536000', 'public mode must send the transport-security header', { expected: 'Strict-Transport-Security: max-age=31536000', actual: describe(headerOf(created, 'strict-transport-security')), request: created.request, response: created });
      world.adminToken = account.token;
      world.adminId = account.account.id;
      const sessionCookie = cookie.split(';')[0];
      const me = expectStatus(await get('/me', { cookie: sessionCookie }), 200, 'GET /me with the returned session cookie');
      expectThat(me.account?.email === ADMIN.email, 'the session cookie must authenticate the new administrator', { expected: `account.email=${ADMIN.email}`, actual: describe(me.account) });
      const after = expectStatus(await get('/bootstrap'), 200, 'GET /bootstrap after the first administrator');
      expectThat(after.setup_required === false && after.setup_code_required === false && after.registration?.public_signup === true, 'the setup gate must close once the administrator exists', { expected: 'setup_required=false, setup_code_required=false, registration.public_signup=true', actual: describe(after) });
      return '403 without the setup code, 403 with a wrong code, 201 with the code (role=admin, HttpOnly+Secure cookie verified through GET /me)';
    });

    await step('3. the administrator creates an agent character', async () => {
      const response = await post('/agents', { kind: 'agent', name: 'Acceptance resident', color: '#397f79', symbol: '✦', capabilities: 'Explores the shared world and reads approved sources', limitations: 'No browser or external tools' }, { token: world.adminToken });
      const agent = expectStatus(response, 201, 'POST /agents');
      expectThat(agent.kind === 'agent' && agent.status === 'active' && typeof agent.id === 'string', 'the character must be created as an active agent', { expected: 'kind=agent, status=active', actual: describe(agent), request: response.request, response });
      world.agentId = agent.id;
      return `201 {id:${agent.id.slice(0, 8)}…, kind:agent, status:active}`;
    });

    await step('4. the world reports the participant with z/grounded and the move changes its position', async () => {
      const before = expectStatus(await get(`/world?agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'GET /world for the created character');
      expectThat(before.terrain.length === 14 && before.terrain[0].length === 20, 'the world view must return a 20 x 14 terrain window', { expected: 'terrain 14 x 20', actual: describe({ rows: before.terrain?.length, columns: before.terrain?.[0]?.length }) });
      const participant = before.participants.find((entry) => entry.id === world.agentId);
      expectThat(participant, 'the created character must appear as a participant', { expected: `participant ${world.agentId}`, actual: describe(before.participants.map((entry) => entry.id)) });
      expectThat(Number.isInteger(participant.z) && Number.isInteger(participant.grounded), 'each participant must carry the elevation fields z and grounded', { expected: 'integer z and grounded', actual: describe({ z: participant.z, grounded: participant.grounded }) });
      expectThat(participant.world_id === 'commons', 'a new character starts in the Commons', { expected: 'world_id=commons', actual: describe(participant.world_id) });
      world.position = { x: participant.x, y: participant.y };
      const moved = expectStatus(await post('/move', { agent_id: world.agentId, direction: 'right' }, { token: world.adminToken }), 200, 'POST /move');
      expectThat(moved.blocked === false, 'a walkable tile must not be reported as blocked', { expected: 'blocked=false', actual: describe(moved) });
      expectThat(moved.x === world.position.x + 1 && moved.y === world.position.y, 'the character must move exactly one tile', { expected: `${world.position.x + 1},${world.position.y}`, actual: `${moved.x},${moved.y}` });
      expectThat(Number.isInteger(moved.z) && typeof moved.grounded === 'boolean', 'the move response must carry z and grounded', { expected: 'integer z and boolean grounded', actual: describe({ z: moved.z, grounded: moved.grounded }) });
      world.position = { x: moved.x, y: moved.y };
      const after = expectStatus(await get(`/world?agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'GET /world after the move');
      const updated = after.participants.find((entry) => entry.id === world.agentId);
      expectThat(updated.x === moved.x && updated.y === moved.y, 'the participant payload must report the new position', { expected: `${moved.x},${moved.y}`, actual: `${updated.x},${updated.y}` });
      expectThat(Number.isInteger(updated.z) && Number.isInteger(updated.grounded), 'the participant payload must keep z and grounded after moving', { expected: 'integer z and grounded', actual: describe({ z: updated.z, grounded: updated.grounded }) });
      const probe = await post(`/agents/${world.agentId}/move`, { direction: 'right' }, { token: world.adminToken });
      state.notes.push(`POST /api/v1/agents/:id/move is not a route in this build: it answered HTTP ${probe.status} ${probe.raw}. The documented operator form is POST /api/v1/move with {agent_id, direction} (docs/API.md section 4), which this harness uses and asserts.`);
      return `200 participant {x:${updated.x}, y:${updated.y}, z:${updated.z}, grounded:${updated.grounded}}; move from ${world.position.x - 1},${world.position.y} to ${updated.x},${updated.y}`;
    });

    await step('5. the finite land registry offers a plot and stewardship is recorded', async () => {
      const registry = expectStatus(await get('/land?limit=25'), 200, 'GET /land');
      expectThat(registry.counts.gross === 16384 && registry.catalog_total === 16384, 'the registry must expose the finite 16,384-plot inventory', { expected: 'counts.gross=16384, catalog_total=16384', actual: describe({ gross: registry.counts?.gross, catalog_total: registry.catalog_total }) });
      expectThat(registry.world?.total_areas === 256 && registry.areas.length === 256, 'the registry must expose the 256-area grid', { expected: 'world.total_areas=256 and 256 area rows', actual: describe({ total_areas: registry.world?.total_areas, areas: registry.areas?.length }) });
      expectThat(registry.policy?.stewardships_per_operator === 1, 'the policy must limit each account to one stewardship', { expected: 'stewardships_per_operator=1', actual: describe(registry.policy) });
      expectThat(registry.mine === null, 'a fresh account must hold no stewardship', { expected: 'mine=null', actual: describe(registry.mine) });

      const frontier = await readTerrain('frontier:0:0', { minimumX: 0, maximumX: 47, minimumY: 0, maximumY: 47 });
      const crossroads = frontier.descriptor.landmarks.find((landmark) => landmark.name === 'Frontier Crossroads') ?? frontier.descriptor.landmarks[0];
      expectThat(crossroads, 'the frontier must publish its crossroads landmark', { expected: 'a frontier landmark', actual: describe(frontier.descriptor.landmarks) });
      const frontierMap = frontier.descriptor.frontier;
      expectThat(frontierMap.limits.build_range > 0, 'the frontier must publish its build range', { expected: 'limits.build_range', actual: describe(frontierMap.limits) });
      // Stepping onto a frontier passage tile in its direction crosses into the
      // neighbouring area; the planner treats those four tiles as blocked.
      const gates = new Set(frontierMap.neighbors.map((gate) => `${gate.x},${gate.y}`));
      const buildRange = frontierMap.limits.build_range;
      const options = constructionOptions({ grid: frontier.grid, parcels: frontierMap.parcels, origin: { x: crossroads.x, y: crossroads.y }, buildRange, blocked: gates });
      frontier.blocked = gates;
      expectThat(options.options.length > 0, 'an available unreserved plot must be reachable from the frontier arrival', { expected: 'reachable available parcels', actual: describe(frontierMap.parcels.filter((parcel) => parcel.state === 'available').length) });
      world.frontier = frontier;
      world.buildRange = buildRange;

      const chosen = options.chosen;
      world.plot = chosen.parcel;
      world.buildPlan = chosen;
      const purpose = 'A shared learning garden for acceptance checks';
      const assigned = expectStatus(await post('/land/assign', { plot_id: chosen.parcel.id, purpose, description: 'Claimed by the end-to-end acceptance harness.' }, { token: world.adminToken }), 200, `POST /land/assign ${chosen.parcel.id}`);
      expectThat(assigned.assigned === true, 'the parcel must be assigned', { expected: 'assigned=true', actual: describe(assigned.assigned) });
      expectThat(assigned.plot?.state === 'assigned' && assigned.plot?.id === chosen.parcel.id, 'the assigned plot must report the assigned state', { expected: `plot.id=${chosen.parcel.id}, state=assigned`, actual: describe({ id: assigned.plot?.id, state: assigned.plot?.state }) });
      expectThat(assigned.plot?.purpose === purpose && assigned.plot?.is_mine === true, 'the plot must record the purpose and the caller’s stewardship', { expected: `purpose=${purpose}, is_mine=true`, actual: describe({ purpose: assigned.plot?.purpose, is_mine: assigned.plot?.is_mine }) });
      const mine = expectStatus(await get('/land?mine=1', { token: world.adminToken }), 200, 'GET /land?mine=1');
      expectThat(mine.plots.length === 1 && mine.plots[0].id === chosen.parcel.id, 'the stewardship must appear in the caller’s own registry view', { expected: `one plot ${chosen.parcel.id}`, actual: describe(mine.plots.map((plot) => plot.id)) });
      return `200 counts.gross=${registry.counts.gross}; assigned ${chosen.parcel.id} (${chosen.parcel.address}) purpose="${purpose}"`;
    });

    await step('6. the agent runtime credential is scoped and refused outside its scopes', async () => {
      const scopes = ['read', 'move', 'build', 'contribute'];
      const response = await post('/runtime/start', { agent_id: world.agentId, minutes: 20, max_calls: 500, scopes }, { token: world.adminToken });
      const session = expectStatus(response, 201, 'POST /runtime/start');
      expectThat(/^[a-f0-9]{64}$/.test(session.token || ''), 'the runtime token must be returned once', { expected: 'a 64-character hexadecimal token', actual: describe(session.token), request: response.request, response });
      expectThat(session.agent_id === world.agentId && session.max_calls === 500 && json(session.scopes) === json(scopes), 'the runtime session must describe its character, budget and scopes', { expected: `agent_id=${world.agentId}, max_calls=500, scopes=${json(scopes)}`, actual: describe({ agent_id: session.agent_id, max_calls: session.max_calls, scopes: session.scopes }) });
      expectThat(Number.isInteger(session.expires_at) && session.expires_at > Date.now(), 'the expiry must be a real future epoch timestamp', { expected: 'a future epoch millisecond timestamp', actual: describe(session.expires_at) });
      world.runtimeToken = session.token;
      const status = expectStatus(await get('/runtime/status', { token: world.runtimeToken }), 200, 'GET /runtime/status with the runtime token');
      expectThat(status.agent_id === world.agentId && status.remaining_calls === 500 && status.paused === false, 'the runtime status must report its own character and budget', { expected: `agent_id=${world.agentId}, remaining_calls=500, paused=false`, actual: describe(status) });
      const read = expectStatus(await get('/world', { token: world.runtimeToken }), 200, 'GET /world with the runtime read scope');
      expectThat(read.viewer_agent_id === world.agentId, 'a runtime read must stay bound to its own character', { expected: `viewer_agent_id=${world.agentId}`, actual: describe(read.viewer_agent_id) });
      const chat = await post('/messages', { text: 'Out-of-scope chat attempt.' }, { token: world.runtimeToken });
      expectStatus(chat, 403, 'POST /messages with a runtime token that has no chat scope');
      expectThat(/scope|permit/i.test(chat.body?.error || ''), 'the refusal must explain the missing scope', { expected: 'an error naming the scope', actual: describe(chat.body), request: chat.request, response: chat });
      const invites = await post('/invites', { role: 'member' }, { token: world.runtimeToken });
      expectStatus(invites, 403, 'POST /invites with a runtime credential');
      return `201 runtime session (scopes read/move/build/contribute, 500 calls); 200 read; 403 POST /messages (scope: ${describe(chat.body?.error)}); 403 POST /invites`;
    });

    await step('7. the runtime walks to the frontier, is refused unwalkable terrain and solid scenery, and builds in the assigned plot', async () => {
      const commonsView = expectStatus(await get('/world?world_id=commons'), 200, 'GET /world?world_id=commons');
      const gateway = commonsView.portals.find((portal) => portal.target_world_id === 'frontier:0:0');
      expectThat(gateway, 'the Commons must publish the frontier gateway', { expected: 'a portal to frontier:0:0', actual: describe(commonsView.portals.map((portal) => portal.target_world_id)) });
      // The Commons window is widened east to the authored tree belt and south to the theatre so the
      // harness can prove a solid-scenery refusal as well as the terrain legend.
      const commons = await readTerrain('commons', { minimumX: Math.min(world.position.x, gateway.x) - 4, maximumX: 38, minimumY: 0, maximumY: 20 });
      const commonsBlocked = new Set([...commons.solid]);
      expectThat(commons.solid.size > 0 && commons.decorative.size > 0, 'the Commons must publish both solid and decorative scenery', { expected: 'both classes present', actual: describe({ solid: commons.solid.size, decorative: commons.decorative.size }) });
      const commonsProbe = await proveCollisionRefusal(world.runtimeToken, world.position, commons.grid, commonsBlocked, commons.solid);
      expectThat(commonsProbe.probe.solidScenery === true, 'the nearest refusal must be solid authored scenery, not only terrain', { expected: 'a reachable tile beside solid scenery', actual: describe(commonsProbe.probe) });
      world.position = commonsProbe.position;
      const decorated = await proveDecorationWalk(world.runtimeToken, world.position, commons.grid, commons.solid, commons.decorative);
      world.position = { x: decorated.x, y: decorated.y };
      const distances = distancesFrom(commons.grid, world.position, commonsBlocked);
      let stand = null;
      for (const [dx, dy] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const distance = distances.get(`${gateway.x + dx},${gateway.y + dy}`);
        if (distance !== undefined && (!stand || distance < stand.distance)) stand = { x: gateway.x + dx, y: gateway.y + dy, distance };
      }
      expectThat(stand, 'the frontier gateway must be reachable from the character', { expected: 'a walkable tile beside the gateway', actual: `gateway ${gateway.x},${gateway.y}` });
      world.position = await walkTo(world.runtimeToken, world.position, { x: stand.x, y: stand.y }, commons.grid, commonsBlocked);

      await sleep(MOVE_INTERVAL_MS);
      const travelled = expectStatus(await post(`/agents/${world.agentId}/travel`, { world_id: 'frontier:0:0' }, { token: world.runtimeToken }), 200, 'POST /agents/:id/travel to frontier:0:0');
      expectThat(travelled.world_id === 'frontier:0:0' && travelled.entered === true && Number.isInteger(travelled.z), 'travel must enter the frontier with an elevation', { expected: 'world_id=frontier:0:0, entered=true, integer z', actual: describe(travelled) });
      world.position = { x: travelled.x, y: travelled.y, world: 'frontier:0:0' };
      const arrival = world.frontier.descriptor.landmarks.find((landmark) => landmark.name === 'Frontier Crossroads');
      if (!arrival || arrival.x !== travelled.x || arrival.y !== travelled.y) state.notes.push(`The frontier arrival ${travelled.x},${travelled.y} differs from the published crossroads ${arrival ? `${arrival.x},${arrival.y}` : 'landmark'}; the construction plan is still recomputed from the real position.`);

      const probe = await proveCollisionRefusal(world.runtimeToken, world.position, world.frontier.grid, world.frontier.blocked, world.frontier.solid);
      world.position = probe.position;

      const target = world.buildPlan;
      world.position = await walkTo(world.runtimeToken, world.position, { x: target.stand.x, y: target.stand.y }, world.frontier.grid, world.frontier.blocked);
      await sleep(FRONTIER_ACTION_INTERVAL_MS);
      const built = await post('/frontier/build', { world_id: 'frontier:0:0', x: target.tile.x, y: target.tile.y, z: 0, type: 'wood' }, { token: world.runtimeToken });
      const block = expectStatus(built, 200, `POST /frontier/build at ${target.tile.x},${target.tile.y}`);
      expectThat(block.changed === true && block.plot_id === world.plot.id, 'the block must be created inside the assigned plot', { expected: `changed=true, plot_id=${world.plot.id}`, actual: describe({ changed: block.changed, plot_id: block.plot_id }) });
      expectThat(block.x === target.tile.x && block.y === target.tile.y && block.z === 0 && block.type === 'wood', 'the block must match the requested tile, layer and type', { expected: `${target.tile.x},${target.tile.y},z=0,type=wood`, actual: describe({ x: block.x, y: block.y, z: block.z, type: block.type }) });

      const view = expectStatus(await get(`/world?world_id=frontier:0:0&view=voxel&agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'read the frontier back');
      const persisted = (view.blocks || []).find((entry) => entry.id === block.id);
      expectThat(persisted && persisted.x === block.x && persisted.y === block.y && persisted.z === block.z, 'the built block must persist in the world view', { expected: `block ${block.id}`, actual: describe((view.blocks || []).map((entry) => entry.id)) });
      const plotRead = expectStatus(await get(`/land/plot?plot_id=${world.plot.id}`), 200, `GET /land/plot?plot_id=${world.plot.id}`);
      expectThat(plotRead.plot.block_count === 1, 'the plot must report its construction', { expected: 'block_count=1', actual: describe(plotRead.plot.block_count) });
      return `Commons: 200 refused move onto ${commonsProbe.probe.type} (blocked=true, position unchanged); 200 walked onto decorative scenery at ${decorated.x},${decorated.y}; 200 travel to frontier:0:0; 200 refused move onto an unwalkable ${probe.probe.type} tile (blocked=true, position unchanged); 200 frontier build (plot_id=${block.plot_id}, ${block.type} at ${block.x},${block.y},z=${block.z}); read back from GET /world and GET /land/plot`;
    });

    await step('8. a second account reviews independently and the contribution earns Nemo Coins', async () => {
      const invite = expectStatus(await post('/invites', { role: 'reviewer' }, { token: world.adminToken }), 201, 'POST /invites as administrator');
      expectThat(invite.role === 'reviewer' && typeof invite.code === 'string' && invite.expires_at > Date.now(), 'the invitation must be a single-use reviewer code with an expiry', { expected: 'role=reviewer with code and expiry', actual: describe({ role: invite.role, code: typeof invite.code, expires_at: invite.expires_at }) });
      const registration = expectStatus(await post('/auth/register', { ...REVIEWER, password: PASSWORD, consent: true, invite: invite.code }, { apiClient: 'operator' }), 201, 'POST /auth/register with the reviewer invitation');
      expectThat(registration.account?.role === 'reviewer', 'the invitation must grant the reviewer role', { expected: 'role=reviewer', actual: describe(registration.account) });
      world.reviewerToken = registration.token;
      world.reviewerId = registration.account.id;

      const mission = expectStatus(await post('/missions', { title: 'Acceptance evidence register', area: 'Climate', summary: 'Record one traceable public source for the acceptance run.', beneficiary: 'Acceptance community', owner_id: world.adminId, reviewer_id: world.reviewerId, rubric: 'Check the exact source, its date, its rights and the remaining uncertainty.' }, { token: world.adminToken }), 201, 'POST /missions');
      const task = expectStatus(await post('/tasks', { mission_id: mission.id, title: 'Record one source', instructions: 'Provide the source, its exact location, rights and uncertainty.', rights: 'Public material with attribution.', allowed_domains: ['example.org'] }, { token: world.adminToken }), 201, 'POST /tasks');
      expectStatus(await post('/missions/status', { mission_id: mission.id, status: 'open' }, { token: world.adminToken }), 200, 'POST /missions/status (open)');

      const listing = expectStatus(await get('/missions'), 200, 'GET /missions');
      const claimable = listing.tasks.find((entry) => entry.id === task.id);
      const listedMission = listing.missions.find((entry) => entry.id === mission.id);
      expectThat(claimable && claimable.status === 'open' && claimable.allowed_domains.includes('example.org'), 'the created task must be listed as claimable with its approved source domain', { expected: 'task status=open with allowed_domains [example.org]', actual: describe(claimable) });
      expectThat(listedMission?.status === 'open' && listedMission?.demo === 0, 'the mission must be a real open mission, not the practice catalogue', { expected: 'mission status=open, demo=0', actual: describe({ status: listedMission?.status, demo: listedMission?.demo }) });

      const claim = expectStatus(await post('/claims', { task_id: task.id }, { token: world.runtimeToken, headers: { 'Idempotency-Key': 'e2e-claim-1' } }), 201, 'POST /claims with the runtime credential');
      expectThat(claim.task_id === task.id && claim.agent_id === world.agentId && claim.status === 'leased', 'the claim must be leased to the runtime character', { expected: `task_id=${task.id}, agent_id=${world.agentId}, status=leased`, actual: describe({ task_id: claim.task_id, agent_id: claim.agent_id, status: claim.status }) });
      const submission = expectStatus(await post('/submissions', { claim_id: claim.id, artifact: 'A plain text acceptance record with one attributed source.', mime: 'text/plain', sources: [{ url: 'https://example.org/report', location: 'Section 2, paragraph 3', date: '2026-10-11' }], method: 'Read the published report and recorded the exact supporting section.', limitations: 'Acceptance fixture; the facts and rights need human verification.', rights: 'Public material recorded with attribution.' }, { token: world.runtimeToken, headers: { 'Idempotency-Key': 'e2e-submit-1' } }), 201, 'POST /submissions with the runtime credential');
      expectThat(submission.status === 'pending_review' && submission.version === 1, 'the submission must be pending review at version one', { expected: 'status=pending_review, version=1', actual: describe({ status: submission.status, version: submission.version }) });

      const selfReview = await post('/reviews', { submission_id: submission.id, decision: 'accepted', reason: 'Attempting to approve my own contribution.' }, { token: world.adminToken });
      expectStatus(selfReview, 403, 'POST /reviews by the contributor');
      expectThat(/own|agents/i.test(selfReview.body?.error || ''), 'the refusal must state the independence rule', { expected: 'an error about own or agents’ contributions', actual: describe(selfReview.body), request: selfReview.request, response: selfReview });

      const review = expectStatus(await post('/reviews', { submission_id: submission.id, decision: 'accepted', reason: 'Independent acceptance after checking the fixture rubric.' }, { token: world.reviewerToken }), 201, 'POST /reviews by the independent reviewer');
      expectThat(review.decision === 'accepted', 'the independent reviewer must be able to accept', { expected: 'decision=accepted', actual: describe(review.decision) });
      expectThat(review.coin_reward?.status === 'awarded' && review.coin_reward.amount === 10, 'an independently accepted real-task contribution must award exactly 10 Nemo Coins', { expected: 'coin_reward={status:awarded, amount:10}', actual: describe(review.coin_reward) });

      const wallet = expectStatus(await get(`/coins?agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'GET /coins for the contributing character');
      expectThat(wallet.balance === 10 && wallet.issued === 10 && wallet.receipt_count === 1, 'the wallet must hold the single fixed receipt', { expected: 'balance=10, issued=10, receipt_count=1', actual: describe({ balance: wallet.balance, issued: wallet.issued, receipt_count: wallet.receipt_count }) });
      expectThat(wallet.policy?.award === 10 && wallet.integrity_valid === true, 'the wallet must publish the fixed policy and a valid ledger', { expected: 'policy.award=10, integrity_valid=true', actual: describe({ award: wallet.policy?.award, integrity_valid: wallet.integrity_valid }) });
      expectThat(wallet.receipts[0].submission_id === submission.id && wallet.receipts[0].amount === 10, 'the receipt must point at the accepted submission', { expected: `receipt for submission ${submission.id}`, actual: describe(wallet.receipts[0]) });
      return `201 invite; 201 reviewer registration (role=reviewer); 201 claim; 201 submission; 403 self-review; 201 independent acceptance; GET /coins balance=10 (one 10-coin receipt)`;
    });

    await step('9. documented refusals hold: no building outside the plot, no runtime land acquisition', async () => {
      const planned = constructionOptions({ grid: world.frontier.grid, parcels: world.frontier.descriptor.frontier.parcels, origin: { x: world.position.x, y: world.position.y }, buildRange: world.buildRange, blocked: world.frontier.blocked });
      const outside = planned.options.find((option) => option.parcel.id !== world.plot.id);
      expectThat(outside, 'a walkable neighbouring plot must be reachable outside the assigned plot', { expected: 'a reachable tile in another parcel', actual: describe({ position: world.position, options: planned.options.length }) });
      world.position = await walkTo(world.runtimeToken, world.position, { x: outside.stand.x, y: outside.stand.y }, world.frontier.grid, world.frontier.blocked);
      await sleep(FRONTIER_ACTION_INTERVAL_MS);
      const refusal = await post('/frontier/build', { world_id: 'frontier:0:0', x: outside.tile.x, y: outside.tile.y, z: 0, type: 'wood' }, { token: world.runtimeToken });
      expectStatus(refusal, 403, `POST /frontier/build outside the assigned plot (${outside.parcel.id} at ${outside.tile.x},${outside.tile.y})`);
      expectThat(/assigned land plot|stewardship/i.test(refusal.body?.error || ''), 'the refusal must name the land stewardship rule', { expected: 'an error naming the assigned land plot', actual: describe(refusal.body), request: refusal.request, response: refusal });

      const acquisition = await post('/land/assign', { plot_id: outside.parcel.id, purpose: 'Runtime land acquisition attempt' }, { token: world.runtimeToken });
      expectStatus(acquisition, 403, 'POST /land/assign with a runtime credential');
      expectThat(/human operator session/i.test(acquisition.body?.error || ''), 'a runtime must be told that a human session is required', { expected: 'an error naming the human operator session', actual: describe(acquisition.body), request: acquisition.request, response: acquisition });

      const plotRead = expectStatus(await get(`/land/plot?plot_id=${world.plot.id}`), 200, 'GET /land/plot after the refusals');
      expectThat(plotRead.plot.block_count === 1 && plotRead.plot.state === 'assigned', 'refused writes must not change the plot', { expected: 'block_count=1, state=assigned', actual: describe({ block_count: plotRead.plot.block_count, state: plotRead.plot.state }) });
      return `403 build in ${outside.parcel.id} at ${outside.tile.x},${outside.tile.y} (${describe(refusal.body?.error)}); 403 runtime land acquisition; assigned plot unchanged (block_count=1)`;
    });

    await step('10. country ambassadors: a paginated directory, a country-context answer and a refused mismatch', async () => {
      // Walk every page over the shipped HTTP API and prove the union is exactly the catalog.
      const seen = new Set();
      let offset = 0, page = null;
      for (;;) {
        page = expectStatus(await get(`/ambassadors?limit=50&offset=${offset}`), 200, `GET /ambassadors?limit=50&offset=${offset}`);
        expectThat(page.entries.length > 0, 'a directory page inside the catalog must not be empty', { expected: 'a non-empty page', actual: describe({ offset, total: page.total }) });
        for (const entry of page.entries) seen.add(entry.id);
        if (!page.has_more) break;
        offset += 50;
      }
      expectThat(page.catalog.total === 248 && seen.size === 248, 'every catalog entry must be reachable through pagination', { expected: 'catalog.total=248 and 248 distinct ids', actual: describe({ catalog_total: page.catalog?.total, walked: seen.size }) });
      expectThat([...seen].includes('amb-NPL'), 'the paginated directory must contain the Nepal ambassador', { expected: 'amb-NPL in the directory', actual: describe([...seen].slice(0, 4)) });

      const profile = expectStatus(await get('/ambassador?id=amb-NPL'), 200, 'GET /ambassador?id=amb-NPL');
      expectThat(profile.country_context?.country?.iso3 === 'NPL' && profile.ambassador?.world_id === 'country:NPL', 'the profile must carry the assigned country context and its own generated venue', { expected: 'country_context NPL with venue country:NPL', actual: describe({ country: profile.country_context?.country, world_id: profile.ambassador?.world_id }) });
      expectThat(profile.venue?.kind === 'country' && profile.research?.evidence_routes?.length === 5, 'the venue must be a generated country venue and the research routes must resolve', { expected: 'kind=country with five registered routes', actual: describe({ kind: profile.venue?.kind, routes: profile.research?.evidence_routes?.length }) });

      const talk = expectStatus(await post('/ambassadors/talk', { ambassador_id: 'amb-NPL', question: 'Help me research agriculture.' }, { token: world.adminToken }), 200, 'POST /ambassadors/talk for the Nepal ambassador');
      expectThat(talk.country_context?.country?.name === 'Nepal', 'the answer must use the ambassador’s assigned country context automatically', { expected: 'country_context.country.name=Nepal', actual: describe(talk.country_context?.country) });
      expectThat(Array.isArray(talk.source_numbers) && talk.source_numbers.length === 5, 'the answer must cite the retained source numbers without being asked', { expected: 'source_numbers=[1..5]', actual: describe(talk.source_numbers) });
      expectThat(/fictional research guide/i.test(talk.answer || '') && !/\bUN official\b/.test(talk.answer || ''), 'the answer must state it is a fictional guide and never a UN official', { expected: 'a fictional-guide statement and no official claim', actual: describe(talk.answer) });

      const mismatch = await post('/ambassadors/talk', { ambassador_id: 'amb-NPL', question: 'Agriculture exports?', country_code: 'BD' }, { token: world.adminToken });
      expectStatus(mismatch, 400, 'POST /ambassadors/talk with a country_code that is not the ambassador’s country');
      expectThat(/mismatch/i.test(mismatch.body?.error || ''), 'the refusal must name the country mismatch', { expected: 'an error naming the country mismatch', actual: describe(mismatch.body), request: mismatch.request, response: mismatch });

      const legacy = expectStatus(await get('/mayors'), 200, 'GET /mayors (compatibility alias)');
      expectThat(legacy.mayors.length === 20 && legacy.legacy_alias === true, 'the legacy guide listing must keep 20 historic guides and announce itself', { expected: 'mayors=20 with legacy_alias=true', actual: describe({ mayors: legacy.mayors?.length, legacy_alias: legacy.legacy_alias }) });
      expectThat(legacy.mayors.every((guide) => String(guide.ambassador?.id || '').startsWith('amb-')), 'every historic guide must name its replacement ambassador', { expected: 'each guide with an ambassador id', actual: describe(legacy.mayors?.[0]?.ambassador) });
      return `248 ambassadors walked over ${offset / 50 + 1} pages; GET /ambassador?id=amb-NPL -> 200 (country:NPL, 5 routes); 200 talk with country_context=Nepal and source_numbers=[1..5]; 400 country mismatch; legacy GET /mayors -> 20 guides mapped`;
    });

    await step('11. an authored quest chain advances only from saved facts, once, and mints no coins', async () => {
      // A second resident follows a calling whose own objectives touch none of this chain's facts, so
      // the day's shared cosmetic limit is spent on the chain itself rather than on a calling reward.
      const steward = expectStatus(await post('/agents', { kind: 'agent', name: 'Steward of the plot', color: '#3d5875', symbol: '◆', capabilities: 'Walks authored routes', limitations: 'No external tools and no real-world claims' }, { token: world.adminToken }), 201, 'POST /agents (second resident)');
      const selection = expectStatus(await post('/callings/select', { agent_id: steward.id, calling_id: 'researcher' }, { token: world.adminToken }), 200, 'POST /callings/select for the second resident');
      expectThat(selection.calling?.id === 'researcher' && selection.today?.earned === 0 && selection.experience?.cosmetic === true, 'choosing a calling must grant no experience, coin or authority by itself', { expected: 'calling=researcher, today.earned=0, cosmetic experience', actual: describe({ calling: selection.calling?.id, earned: selection.today?.earned, cosmetic: selection.experience?.cosmetic }) });
      const directory = expectStatus(await get('/me', { token: world.adminToken }), 200, 'GET /me');
      const start = directory.agents.find((agent) => agent.id === steward.id);
      expectThat(typeof start?.x === 'number' && start.world_id === 'commons', 'the second resident must start in the Commons', { expected: 'a Commons position', actual: describe(start) });

      const authored = expectStatus(await post('/quests/author', {
        slug: 'plot-path', title: 'A path inside the plot', route: 'world_building', practice: true,
        summary: 'Two saved frontier steps inside one steward plot: a ground path, then one raised block.',
        narrative: 'Written for the acceptance run. The first step leaves a path the plot can keep and the second raises one block beside it. Both are things the server already records, so no one has to be believed about them.',
        steps: [
          { slug: 'ground-path', title: 'Lay a saved ground path', instructions: 'Place a path block on the ground inside your operator’s plot.', output_name: 'One saved ground path', source_kind: 'path_place' },
          { slug: 'raised-block', title: 'Raise one saved block', instructions: 'Place a permitted block on its own tile inside the same plot.', output_name: 'One saved frontier block', source_kind: 'frontier_place', prerequisite: 'ground-path' },
        ],
      }, { token: world.adminToken }), 201, 'POST /quests/author as the administrator');
      expectThat(authored.status === 'draft' && authored.steps.length === 2 && authored.steps[0].prerequisite === null && authored.steps[1].prerequisite === 'ground-path', 'the authored chain must publish ordered steps with explicit prerequisites', { expected: 'a draft with two ordered steps', actual: describe(authored.steps?.map((step) => ({ slug: step.slug, prerequisite: step.prerequisite }))) });
      expectThat(authored.steps.every((step) => step.output?.name && step.output?.requires_review === false), 'a practice chain must name every step output and claim no real review', { expected: 'named outputs with no review boundary', actual: describe(authored.steps?.map((step) => step.output)) });
      const published = expectStatus(await post('/quests/manage', { chain_id: 'plot-path', action: 'publish' }, { token: world.adminToken }), 200, 'POST /quests/manage publish');
      expectThat(published.status === 'published', 'the authorized author must be able to publish the chain', { expected: 'status=published', actual: describe(published.status) });
      const catalogue = expectStatus(await get('/quests/catalog'), 200, 'GET /quests/catalog');
      expectThat(catalogue.chains.some((chain) => chain.slug === 'plot-path') && catalogue.policy.coins_awarded === 0 && catalogue.policy.client_completion === false, 'the public catalogue must list the chain and state that coins and client completion are impossible', { expected: 'plot-path listed with coins_awarded=0', actual: describe({ listed: catalogue.chains.map((chain) => chain.slug), policy: catalogue.policy }) });

      const spoof = await post('/quests/complete', { agent_id: steward.id, chain_id: 'plot-path' }, { token: world.adminToken });
      expectStatus(spoof, 400, 'POST /quests/complete');
      expectThat(/saved server fact/.test(spoof.body?.error || ''), 'a client completion claim must be refused with the derived-fact rule', { expected: 'an error naming the saved server fact', actual: describe(spoof.body), request: spoof.request, response: spoof });

      const joined = expectStatus(await post('/quests/join', { agent_id: steward.id, chain_id: 'plot-path' }, { token: world.adminToken, headers: { 'Idempotency-Key': 'e2e-quest-join-1' } }), 201, 'POST /quests/join');
      const repeated = expectStatus(await post('/quests/join', { agent_id: steward.id, chain_id: 'plot-path' }, { token: world.adminToken, headers: { 'Idempotency-Key': 'e2e-quest-join-1' } }), 201, 'POST /quests/join with the same idempotency key');
      expectThat(joined.repeated === false && repeated.repeated === true, 'repeating the join key must return the same enrolment instead of a second one', { expected: 'repeated=false then repeated=true', actual: describe({ first: joined.repeated, second: repeated.repeated }) });
      expectThat(joined.next_action?.step_slug === 'ground-path' && joined.next_action?.output?.source_kind === 'path_place' && joined.next_action?.action?.section === 'world', 'the board must show the concrete next action with its named output', { expected: 'ground-path with a path_place output and a world action', actual: describe(joined.next_action) });

      // Walk the second resident to the frontier gateway, then leave two saved blocks in the plot.
      const commonsView = expectStatus(await get('/world?world_id=commons'), 200, 'GET /world?world_id=commons');
      const gateway = commonsView.portals.find((portal) => portal.target_world_id === 'frontier:0:0');
      expectThat(gateway, 'the Commons must publish the frontier gateway', { expected: 'a portal to frontier:0:0', actual: describe(commonsView.portals.map((portal) => portal.target_world_id)) });
      const commons = await readTerrain('commons', { minimumX: Math.min(start.x, gateway.x) - 4, maximumX: 38, minimumY: 0, maximumY: 20 });
      const commonsBlocked = new Set(commons.solid);
      const distances = distancesFrom(commons.grid, { x: start.x, y: start.y }, commonsBlocked);
      let doorway = null;
      for (const [dx, dy] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const distance = distances.get(`${gateway.x + dx},${gateway.y + dy}`);
        if (distance !== undefined && (!doorway || distance < doorway.distance)) doorway = { x: gateway.x + dx, y: gateway.y + dy, distance };
      }
      expectThat(doorway, 'the frontier gateway must be reachable from the second resident', { expected: 'a walkable tile beside the gateway', actual: `gateway ${gateway.x},${gateway.y}` });
      await walkTo(world.adminToken, { x: start.x, y: start.y }, { x: doorway.x, y: doorway.y }, commons.grid, commonsBlocked, { agent_id: steward.id });
      await sleep(MOVE_INTERVAL_MS);
      const travelled = expectStatus(await post(`/agents/${steward.id}/travel`, { world_id: 'frontier:0:0' }, { token: world.adminToken }), 200, 'POST /agents/:id/travel for the second resident');
      expectThat(travelled.entered === true && travelled.world_id === 'frontier:0:0', 'the second resident must arrive in the frontier', { expected: 'entered=true in frontier:0:0', actual: describe({ entered: travelled.entered, world_id: travelled.world_id }) });
      const occupied = new Set([...world.frontier.blocked, `${world.buildPlan.tile.x},${world.buildPlan.tile.y}`]);
      const sites = constructionOptions({ grid: world.frontier.grid, parcels: world.frontier.descriptor.frontier.parcels, origin: { x: travelled.x, y: travelled.y }, buildRange: world.buildRange, blocked: occupied }).options.filter((option) => option.parcel.id === world.plot.id && `${option.tile.x},${option.tile.y}` !== `${world.buildPlan.tile.x},${world.buildPlan.tile.y}`);
      expectThat(sites.length >= 2, 'the stewarded plot must offer two more buildable tiles', { expected: 'two free plot tiles', actual: describe(sites.map((site) => `${site.tile.x},${site.tile.y}`)) });
      const [pathSite, blockSite] = sites;
      const pathPosition = await walkTo(world.adminToken, { x: travelled.x, y: travelled.y }, pathSite.stand, world.frontier.grid, world.frontier.blocked, { agent_id: steward.id });
      await sleep(FRONTIER_ACTION_INTERVAL_MS);
      const pathBlock = expectStatus(await post('/frontier/build', { agent_id: steward.id, world_id: 'frontier:0:0', x: pathSite.tile.x, y: pathSite.tile.y, z: 0, type: 'path' }, { token: world.adminToken }), 200, `POST /frontier/build path at ${pathSite.tile.x},${pathSite.tile.y}`);
      expectThat(pathBlock.type === 'path' && pathBlock.plot_id === world.plot.id, 'the ground path must be saved inside the stewarded plot', { expected: `type=path in ${world.plot.id}`, actual: describe({ type: pathBlock.type, plot_id: pathBlock.plot_id }) });
      const blockPosition = await walkTo(world.adminToken, pathPosition, blockSite.stand, world.frontier.grid, world.frontier.blocked, { agent_id: steward.id });
      await sleep(FRONTIER_ACTION_INTERVAL_MS);
      const raisedBlock = expectStatus(await post('/frontier/build', { agent_id: steward.id, world_id: 'frontier:0:0', x: blockSite.tile.x, y: blockSite.tile.y, z: 0, type: 'wood' }, { token: world.adminToken }), 200, `POST /frontier/build wood at ${blockSite.tile.x},${blockSite.tile.y}`);
      expectThat(raisedBlock.changed === true && raisedBlock.plot_id === world.plot.id, 'the raised block must be saved inside the stewarded plot', { expected: `changed=true in ${world.plot.id}`, actual: describe({ changed: raisedBlock.changed, plot_id: raisedBlock.plot_id }) });

      const settled = expectStatus(await get(`/quests?agent_id=${steward.id}`, { token: world.adminToken }), 200, 'GET /quests after the saved facts');
      const settledChain = settled.chains.find((chain) => chain.slug === 'plot-path');
      expectThat(settledChain.steps.every((step) => step.state === 'complete') && settled.progress[0].complete === true && settled.next_action === null, 'two saved facts must complete the two ordered steps', { expected: 'both steps complete with no next action', actual: describe(settled.progress) });
      expectThat(settledChain.steps[0].saved_facts.length === 1 && settledChain.steps[1].saved_facts.length === 1, 'each step must be credited from exactly one saved fact', { expected: 'one saved fact per step', actual: describe(settledChain.steps.map((step) => step.saved_facts.length)) });
      const replayed = expectStatus(await get(`/quests?agent_id=${steward.id}`, { token: world.adminToken }), 200, 'GET /quests again');
      const replayedChain = replayed.chains.find((chain) => chain.slug === 'plot-path');
      expectThat(replayedChain.steps.every((step) => step.saved_facts.length === 1), 'reading the board again must not credit the same saved block twice', { expected: 'one saved fact per step after a replay', actual: describe(replayedChain.steps.map((step) => step.saved_facts.length)) });
      const calling = expectStatus(await get(`/callings?agent_id=${steward.id}`, { token: world.adminToken }), 200, 'GET /callings for the quest resident');
      expectThat(calling.experience.available === 10 && calling.today.earned === 10 && calling.experience.cosmetic === true, 'the chain must credit cosmetic calling experience up to the shared daily limit', { expected: '10 cosmetic experience, none of it currency', actual: describe(calling.experience) });

      const questWallet = expectStatus(await get(`/coins?agent_id=${steward.id}`, { token: world.adminToken }), 200, 'GET /coins for the quest resident');
      expectThat(questWallet.balance === 0 && questWallet.issued === 0 && questWallet.receipt_count === 0, 'a completed practice chain must award no coins at all', { expected: 'zero coins', actual: describe({ balance: questWallet.balance, issued: questWallet.issued, receipts: questWallet.receipt_count }) });
      const contributionWallet = expectStatus(await get(`/coins?agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'GET /coins for the contribution resident');
      expectThat(contributionWallet.balance === 10 && contributionWallet.receipt_count === 1 && contributionWallet.integrity_valid === true, 'the only coin receipt must still be the independently accepted contribution', { expected: 'one 10-coin receipt from independent review', actual: describe({ balance: contributionWallet.balance, receipts: contributionWallet.receipt_count, valid: contributionWallet.integrity_valid }) });
      return `201 author draft; 200 publish; 400 refused client completion; 201 join (idempotent repeat); 200 travel; saved facts path ${pathBlock.x},${pathBlock.y} and wood ${raisedBlock.x},${raisedBlock.y} in ${world.plot.id} (block position ${blockPosition.x},${blockPosition.y}); both ordered steps complete once each (10 cosmetic experience); 0 coins from the chain, 10 coins still held by the independently accepted contribution`;
    });

    await step('12. a guild project board keeps participation explicit, verification independent and guild activity coinless', async () => {
      // A third operator is needed: the administrator owns the project and the reviewer makes the
      // contribution, so only an unrelated operator can verify it independently.
      const invite = expectStatus(await post('/invites', { role: 'member' }, { token: world.adminToken }), 201, 'POST /invites for a third operator');
      const neighbor = expectStatus(await post('/auth/register', { name: 'Acceptance neighbor', email: 'neighbor@e2e.test', password: PASSWORD, consent: true, invite: invite.code }, { apiClient: 'operator' }), 201, 'POST /auth/register with the third operator invitation');
      expectThat(neighbor.account?.role === 'member', 'the third operator must hold the ordinary member role', { expected: 'role=member', actual: describe(neighbor.account) });
      world.neighborToken = neighbor.token;
      const reviewerAgent = expectStatus(await post('/agents', { kind: 'agent', name: 'Reviewer resident', color: '#8c6ab1', symbol: '▲', capabilities: 'Joins bounded cooperative work', limitations: 'No external tools and no real-world claims' }, { token: world.reviewerToken }), 201, 'POST /agents for the reviewer');
      const neighborAgent = expectStatus(await post('/agents', { kind: 'human', name: 'Neighbor player' }, { token: world.neighborToken }), 201, 'POST /agents (human player) for the third operator');
      expectThat(neighborAgent.kind === 'human', 'a human player must be able to take part in a guild project', { expected: 'kind=human', actual: describe(neighborAgent) });

      const plan = [{ id: 'walk', title: 'Walk one accessible route', output_name: 'A traced route', scope: 'Walk and record one accessible route' }];
      const project = expectStatus(await post('/guilds/projects', { agent_id: world.agentId, guild_id: 'cultivator', title: 'A shared growing plan', summary: 'One bounded piece of cooperative work for the acceptance run.', visibility: 'public', plan }, { token: world.adminToken }), 201, 'POST /guilds/projects as the administrator');
      expectThat(project.guild_name === 'Living Gardens' && project.participants.length === 1 && project.participants[0].role === 'organiser', 'the creating resident must be the organiser of the guild project', { expected: 'the Living Gardens guild with one organiser participant', actual: describe({ guild_name: project.guild_name, participants: project.participants }) });
      expectThat(project.policy?.coins_awarded === 0 && project.policy?.grants_land === false && project.policy?.grants_reviewer === false, 'the guild policy must state that no coin, plot or reviewer right is granted', { expected: 'coins_awarded=0, grants_land=false, grants_reviewer=false', actual: describe(project.policy) });
      const hidden = expectStatus(await post('/guilds/projects', { agent_id: world.agentId, guild_id: 'cultivator', title: 'A private plan', summary: 'Kept to its creator until shared.', visibility: 'private', plan }, { token: world.adminToken }), 201, 'POST /guilds/projects (private)');

      const outsider = await get('/guilds', { token: world.reviewerToken });
      const outsiderBoard = expectStatus(outsider, 200, 'GET /guilds as another operator');
      expectThat(!outsiderBoard.projects.some((item) => item.id === hidden.id) && !outsider.raw.includes('A private plan'), 'a private guild project must not be listed for an outsider', { expected: 'the private project absent from the listing', actual: describe(outsiderBoard.projects.map((item) => item.title)) });
      expectStatus(await get(`/guilds/project?id=${hidden.id}`, { token: world.reviewerToken }), 404, 'GET /guilds/project for an outsider');
      expectStatus(await get(`/guilds/project?id=${hidden.id}`), 404, 'GET /guilds/project anonymously');
      expectStatus(await get(`/guilds/project?id=${project.id}`), 200, 'GET /guilds/project anonymously for a public project');

      expectStatus(await post('/guilds/participation', { agent_id: reviewerAgent.id, project_id: project.id, action: 'join' }, { token: world.reviewerToken }), 200, 'POST /guilds/participation join');
      expectStatus(await post('/guilds/participation', { agent_id: neighborAgent.id, project_id: project.id, action: 'join' }, { token: world.neighborToken }), 200, 'POST /guilds/participation join (human player)');
      const pledged = expectStatus(await post('/guilds/contributions', { agent_id: reviewerAgent.id, project_id: project.id, workstream_id: 'walk', action: 'pledge', commitment: 'I will walk and record one route.' }, { token: world.reviewerToken }), 200, 'POST /guilds/contributions pledge');
      expectThat(pledged.contributions[0].status === 'pledged' && pledged.contributions[0].outcome.completed === false && pledged.shared_status.totals.verified_contributions === 0, 'a pledge must never be displayed as a completed outcome', { expected: 'a pledged intention with nothing verified', actual: describe(pledged.contributions[0].outcome) });
      const submitted = expectStatus(await post('/guilds/contributions', { agent_id: reviewerAgent.id, project_id: project.id, workstream_id: 'walk', action: 'submit', evidence: 'A route recorded on the server with its own limits.', sources: [{ url: 'https://example.org/route', location: 'Section 1' }] }, { token: world.reviewerToken }), 200, 'POST /guilds/contributions submit');
      expectThat(submitted.contributions[0].status === 'submitted' && submitted.contributions[0].outcome.completed === false, 'a submitted contribution must stay an unverified claim until a different operator verifies it', { expected: 'submitted with completed=false', actual: describe(submitted.contributions[0].outcome) });
      const contributionId = submitted.contributions[0].id;

      expectStatus(await post('/guilds/verify', { agent_id: reviewerAgent.id, project_id: project.id, contribution_id: contributionId, action: 'approve', reason: 'Approving my own contribution.' }, { token: world.reviewerToken }), 403, 'POST /guilds/verify by the contributing operator');
      expectStatus(await post('/guilds/verify', { agent_id: world.agentId, project_id: project.id, contribution_id: contributionId, action: 'approve', reason: 'Approving inside my own project.' }, { token: world.adminToken }), 403, 'POST /guilds/verify by the project creator');
      const verified = expectStatus(await post('/guilds/verify', { agent_id: neighborAgent.id, project_id: project.id, contribution_id: contributionId, action: 'approve', reason: 'Checked the recorded route independently.' }, { token: world.neighborToken }), 200, 'POST /guilds/verify by a third, independent operator');
      expectThat(verified.contributions[0].outcome.completed === true && verified.contributions[0].outcome.verified === true && verified.shared_status.totals.verified_contributions === 1, 'only an independent verification may read as a completed outcome', { expected: 'one verified contribution and completed=true', actual: describe({ outcome: verified.contributions[0].outcome, totals: verified.shared_status.totals }) });

      const participationView = expectStatus(await get(`/guilds?agent_id=${reviewerAgent.id}`, { token: world.reviewerToken }), 200, 'GET /guilds for the participating resident');
      const listed = participationView.projects.find((item) => item.id === project.id);
      expectThat(listed?.participation.joined === true && listed?.shared_status.totals.verified_contributions === 1, 'the board must report the resident’s own participation with its verified total', { expected: 'joined with one verified contribution', actual: describe(listed?.shared_status?.totals) });
      expectThat(expectStatus(await get('/land?mine=1', { token: world.neighborToken }), 200, 'GET /land?mine=1 for the verifying operator').plots.length === 0, 'taking part in a guild project must grant no stewarded plot', { expected: 'no plot', actual: 'a stewardship appeared' });
      const neighborWallet = expectStatus(await get(`/coins?agent_id=${neighborAgent.id}`, { token: world.neighborToken }), 200, 'GET /coins for the verifying operator');
      expectThat(neighborWallet.balance === 0 && neighborWallet.issued === 0, 'verifying a guild contribution must issue no NemoCoins', { expected: 'zero coins', actual: describe({ balance: neighborWallet.balance, issued: neighborWallet.issued }) });

      const left = expectStatus(await post('/guilds/participation', { agent_id: reviewerAgent.id, project_id: project.id, action: 'leave' }, { token: world.reviewerToken }), 200, 'POST /guilds/participation leave');
      expectThat(left.left === true, 'a participant must be able to leave', { expected: 'left=true', actual: describe(left) });
      const afterLeave = expectStatus(await get(`/guilds/project?id=${project.id}&agent_id=${reviewerAgent.id}`, { token: world.reviewerToken }), 200, 'GET /guilds/project after leaving');
      expectThat(afterLeave.contributions[0].participant.state === 'left' && afterLeave.shared_status.totals.verified_contributions === 1, 'leaving must keep the recorded work as attributed history', { expected: 'a left participant with the verified contribution retained', actual: describe({ state: afterLeave.contributions[0].participant.state, verified: afterLeave.shared_status.totals.verified_contributions }) });

      const guildWallet = expectStatus(await get(`/coins?agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'GET /coins after the whole guild flow');
      expectThat(guildWallet.balance === 10 && guildWallet.receipt_count === 1 && guildWallet.integrity_valid === true, 'the only coin receipt must still be the independently accepted contribution', { expected: 'the same single 10-coin receipt', actual: describe({ balance: guildWallet.balance, receipts: guildWallet.receipt_count, valid: guildWallet.integrity_valid }) });
      return `201 invite + 201 third operator (role=member) + 201 reviewer resident + 201 human player; 201 public project (Living Gardens, one organiser) and 201 private project; 404 private project for an outsider and anonymously; 200 join for an AI resident and for a human player; 200 pledge (intention, nothing verified); 200 submit (unverified claim); 403 self-verification and 403 creator verification; 200 verification by a third operator (completed=true, 1 verified); 200 leave (the verified record stays attributed); 0 coins from the whole guild flow, the earlier 10-coin acceptance intact`;
    });

    await step('13. a newcomer registers, creates an AI resident and chooses a calling', async () => {
      // An ordinary member account through public signup, with no invitation: the newcomer path.
      const registration = expectStatus(await post('/auth/register', { name: 'Journey newcomer', email: 'newcomer@e2e.test', password: PASSWORD, consent: true }, { apiClient: 'operator' }), 201, 'POST /auth/register as a newcomer with no invitation');
      expectThat(registration.account?.role === 'member', 'open public signup must create an ordinary member account', { expected: 'role=member', actual: describe(registration.account), request: registration.request, response: registration });
      world.newcomerToken = registration.token;
      world.newcomerId = registration.account.id;

      const resident = expectStatus(await post('/agents', { kind: 'agent', name: 'Journey resident', color: '#aa7845', symbol: '◆', capabilities: 'Walks the guided newcomer path', limitations: 'No external tools and no real-world claims' }, { token: world.newcomerToken }), 201, 'POST /agents for the newcomer');
      expectThat(resident.kind === 'agent' && resident.status === 'active' && typeof resident.id === 'string', 'the newcomer must be able to create an active AI resident', { expected: 'kind=agent, status=active with an id', actual: describe(resident), request: resident.request, response: resident });
      world.newcomerAgent = resident.id;
      const startingPlace = expectStatus(await get(`/world?agent_id=${resident.id}`, { token: world.newcomerToken }), 200, 'GET /world for the newcomer resident');
      const newcomerParticipant = startingPlace.participants.find((entry) => entry.id === resident.id);
      expectThat(newcomerParticipant?.world_id === 'commons', 'a new resident must start in the Commons', { expected: 'world_id=commons', actual: describe(newcomerParticipant?.world_id) });

      const chosen = expectStatus(await post('/callings/select', { agent_id: resident.id, calling_id: 'explorer' }, { token: world.newcomerToken }), 200, 'POST /callings/select as the newcomer');
      expectThat(chosen.calling?.id === 'explorer' && chosen.calling?.guild_name === 'Wayfarers', 'the newcomer must be able to select the calling and its guild', { expected: 'explorer in Wayfarers', actual: describe(chosen.calling), request: chosen.request, response: chosen });
      expectThat(chosen.today?.earned === 0 && chosen.experience?.available === 0 && chosen.experience?.cosmetic === true, 'choosing a calling must grant no experience by itself', { expected: '0 experience, cosmetic', actual: describe({ today: chosen.today, experience: chosen.experience }) });
      expectThat(chosen.policy?.experience_per_objective === 5 && chosen.policy?.daily_experience_limit === 10, 'the calling policy must publish the fixed five-per-objective and ten-per-day rule', { expected: 'per_objective=5, daily_limit=10', actual: describe(chosen.policy) });
      expectThat(chosen.policy?.cosmetic === true && chosen.policy?.currency === false && chosen.policy?.transferable === false, 'the calling policy must state that experience is cosmetic, not a currency and not transferable', { expected: 'cosmetic=true, currency=false, transferable=false', actual: describe(chosen.policy) });
      const emptyWallet = expectStatus(await get(`/coins?agent_id=${resident.id}`, { token: world.newcomerToken }), 200, 'GET /coins for the newcomer resident');
      expectThat(emptyWallet.balance === 0 && emptyWallet.receipt_count === 0, 'choosing a calling must issue no NemoCoin at all', { expected: 'balance=0, receipt_count=0', actual: describe({ balance: emptyWallet.balance, receipt_count: emptyWallet.receipt_count }) });
      expectThat(emptyWallet.policy?.award === 10 && emptyWallet.policy?.operator_daily_limit === 100 && emptyWallet.policy?.transferable === false, 'the wallet must publish the fixed coin policy beside the zero balance', { expected: 'award=10, operator_daily_limit=100, transferable=false', actual: describe(emptyWallet.policy) });
      return `201 newcomer member account (no invitation); 201 AI resident ${resident.id.slice(0, 8)}… in the Commons; 200 calling explorer · Wayfarers with 0 experience (policy: 5 per objective, 10 per day, cosmetic, not a currency); wallet 0 coins beside the fixed 10-coin policy`;
    });

    await step('14. the newcomer meets a country ambassador and begins the shipped practice chain', async () => {
      const profile = expectStatus(await get('/ambassador?id=amb-KEN'), 200, 'GET /ambassador?id=amb-KEN as a visitor');
      expectThat(profile.country_context?.country?.iso3 === 'KEN' && profile.venue?.kind === 'country', 'the ambassador must answer from its own registered country context and venue', { expected: 'country_context KEN in a country venue', actual: describe({ country: profile.country_context?.country, kind: profile.venue?.kind }) });
      expectThat(/^A fictional NemoWorld research guide\./.test(profile.remit?.fictional || '') && profile.research?.evidence_routes?.length === 5, 'the ambassador must stay a fictional guide with its registered research routes', { expected: 'a fictional-guide remit and five registered routes', actual: describe({ remit: profile.remit?.fictional, routes: profile.research?.evidence_routes?.length }) });

      const catalogue = expectStatus(await get('/quests/catalog'), 200, 'GET /quests/catalog');
      const practice = catalogue.chains.find((chain) => chain.slug === 'quiet-harvest');
      expectThat(practice?.practice === true && practice.steps.length === 3, 'the shipped Quiet Harvest chain must be a three-step practice chain', { expected: 'a three-step practice chain', actual: describe({ practice: practice?.practice, steps: practice?.steps?.length }) });
      expectThat(practice.steps.every((steps) => steps.output.requires_review === false), 'no practice step may claim a review boundary', { expected: 'requires_review=false on every step', actual: describe(practice.steps.map((item) => item.output.requires_review)) });
      expectThat(catalogue.policy?.coins_awarded === 0 && catalogue.policy?.client_completion === false, 'the public catalogue must state that a chain awards no coins and cannot be completed by a client', { expected: 'coins_awarded=0, client_completion=false', actual: describe(catalogue.policy) });

      const joined = expectStatus(await post('/quests/join', { agent_id: world.newcomerAgent, chain_id: 'quiet-harvest' }, { token: world.newcomerToken, headers: { 'Idempotency-Key': 'e2e-newcomer-join-1' } }), 201, 'POST /quests/join for the practice chain');
      expectThat(joined.next_action?.step_slug === 'first-sowing' && joined.next_action?.action?.kind === 'garden', 'the board must show the concrete next action for the newcomer', { expected: 'first-sowing with a garden action', actual: describe(joined.next_action) });
      expectThat(joined.next_action?.output?.source_kind === 'crop_plant' && joined.next_action?.output?.name === 'One planted crop in your own garden', 'the next action must name the saved fact and its output', { expected: 'a crop_plant output named in full', actual: describe(joined.next_action?.output) });
      expectThat(joined.next_action?.requires_human_review === false, 'the first practice step must need no independent review, and say so', { expected: 'requires_human_review=false', actual: describe(joined.next_action?.requires_human_review) });
      const opened = expectStatus(await get(`/quests?agent_id=${world.newcomerAgent}`, { token: world.newcomerToken }), 200, 'GET /quests for the newly enrolled newcomer');
      const enrolled = opened.progress.find((item) => item.chain_slug === 'quiet-harvest');
      expectThat(opened.enrolled_count === 1 && enrolled?.complete === false && enrolled.steps[0].state === 'available', 'joining must record one enrolment with no completed step', { expected: 'one enrolment, first step available, nothing complete', actual: describe({ enrolled: opened.enrolled_count, progress: enrolled }) });
      return `200 GET /ambassador?id=amb-KEN (country:KEN, five registered routes, fictional-guide remit); 200 catalogue lists the practice chain (coins_awarded=0, client_completion=false, no review on any step); 201 join returns next action first-sowing (crop_plant, no review), 1 enrolment, 0 complete`;
    });

    await step('15. the newcomer completes one saved practice activity, reads its receipt and meets the review boundary', async () => {
      const home = `home:${world.newcomerAgent}`;
      await sleep(MOVE_INTERVAL_MS);
      const travelled = expectStatus(await post(`/agents/${world.newcomerAgent}/travel`, { world_id: home }, { token: world.newcomerToken }), 200, `POST /agents/:id/travel to ${home}`);
      expectThat(travelled.entered === true && travelled.world_id === home, 'the newcomer resident must reach its own garden', { expected: `entered=true in ${home}`, actual: describe({ entered: travelled.entered, world_id: travelled.world_id }), request: travelled.request, response: travelled });

      const garden = expectStatus(await get(`/world?world_id=${home}&agent_id=${world.newcomerAgent}`, { token: world.newcomerToken }), 200, 'GET the newcomer’s personal garden');
      const site = gardenFarmSite(garden, world.newcomerAgent);
      expectThat(site, 'the personal garden must offer a free walkable tile away from the arrival and doorways', { expected: 'a buildable garden tile', actual: describe({ camera: garden.camera, portals: garden.portals?.length }) });
      const built = expectStatus(await post(`/agents/${world.newcomerAgent}/build`, { type: 'farm', x: site.x, y: site.y }, { token: world.newcomerToken }), 201, `POST build a crop patch at ${site.x},${site.y}`);
      expectThat(built.world_id === home && built.x === site.x && built.y === site.y && built.removed === false, 'the crop patch must be saved in the newcomer’s own garden', { expected: `a saved farm at ${site.x},${site.y}`, actual: describe(built), request: built.request, response: built });
      const planted = expectStatus(await post('/journey/garden', { agent_id: world.newcomerAgent, action: 'plant', kind: 'herbs', x: site.x, y: site.y }, { token: world.newcomerToken }), 200, 'POST /journey/garden plant as the operator');
      expectThat(planted.crop?.kind === 'herbs' && planted.crop?.harvested_at === null && planted.crop?.ready === false, 'planting must save one growing crop on the patch', { expected: 'one growing herbs crop', actual: describe(planted.crop), request: planted.request, response: planted });

      const board = expectStatus(await get(`/quests?agent_id=${world.newcomerAgent}`, { token: world.newcomerToken }), 200, 'GET /quests after the saved planting');
      const chain = board.chains.find((item) => item.slug === 'quiet-harvest');
      expectThat(chain.steps[0].state === 'complete' && chain.steps[0].saved_facts.length === 1, 'the saved planting must complete the first practice step exactly once', { expected: 'step one complete with one saved fact', actual: describe({ state: chain.steps[0]?.state, facts: chain.steps[0]?.saved_facts }) });
      expectThat(chain.steps[1].state !== 'complete' && board.next_action?.step_slug === 'patient-tending', 'the practice chain must offer its own next concrete step, never a shortcut', { expected: 'patient-tending waiting', actual: describe({ state: chain.steps[1]?.state, next: board.next_action?.step_slug }) });

      const calling = expectStatus(await get(`/callings?agent_id=${world.newcomerAgent}`, { token: world.newcomerToken }), 200, 'GET /callings to read the newcomer’s receipt');
      expectThat(calling.receipts.length === 1 && calling.receipts[0].objective_id === 'quest:quiet-harvest.first-sowing', 'the practice activity must leave exactly one receipt, named for its authored step', { expected: 'one receipt for quest:quiet-harvest.first-sowing', actual: describe(calling.receipts.map((receipt) => receipt.objective_id)), request: calling.request, response: calling });
      expectThat(calling.receipts[0].points === 5 && calling.receipts[0].source_kind === 'crop_plant' && calling.receipts[0].available === true, 'the receipt must record its saved source and five cosmetic experience', { expected: 'points=5 from a crop_plant source', actual: describe(calling.receipts[0]) });
      expectThat(calling.receipts[0].earned_day === calling.today.day && calling.today.earned === 5 && calling.today.limit === 10 && calling.experience.available === 5 && calling.experience.held === 0, 'the receipt must count against the same ten-a-day cosmetic limit', { expected: '5 of 10 cosmetic experience today', actual: describe({ today: calling.today, experience: calling.experience }) });

      const wallet = expectStatus(await get(`/coins?agent_id=${world.newcomerAgent}`, { token: world.newcomerToken }), 200, 'GET /coins after the practice receipt');
      expectThat(wallet.balance === 0 && wallet.issued === 0 && wallet.held === 0 && wallet.receipt_count === 0, 'a completed practice activity must mint no NemoCoin at all, while the cosmetic receipt stands', { expected: 'zero coins beside one cosmetic receipt', actual: describe({ balance: wallet.balance, issued: wallet.issued, receipts: wallet.receipt_count }) });
      expectThat(wallet.integrity_valid === true, 'the ledger must stay valid with no practice receipt in it', { expected: 'integrity_valid=true', actual: describe(wallet.integrity_valid) });

      const spoof = await post('/quests/complete', { agent_id: world.newcomerAgent, chain_id: 'quiet-harvest' }, { token: world.newcomerToken });
      expectStatus(spoof, 400, 'POST /quests/complete as the newcomer');
      expectThat(/saved server fact/.test(spoof.body?.error || ''), 'the newcomer must be told that a step advances only from a saved server fact', { expected: 'an error naming the saved server fact', actual: describe(spoof.body), request: spoof.request, response: spoof });
      const selfReview = await post('/reviews', { submission_id: 'not-a-real-submission', decision: 'accepted', reason: 'A newcomer trying to accept work.' }, { token: world.newcomerToken });
      expectStatus(selfReview, 403, 'POST /reviews as an ordinary member account');
      expectThat(/authorized human/i.test(selfReview.body?.error || ''), 'the review boundary must name the missing authorized human account', { expected: 'an error naming the authorized human account', actual: describe(selfReview.body), request: selfReview.request, response: selfReview });
      const acceptance = expectStatus(await get(`/coins?agent_id=${world.agentId}`, { token: world.adminToken }), 200, 'GET /coins for the earlier contributor after the whole newcomer path');
      expectThat(acceptance.balance === 10 && acceptance.receipt_count === 1, 'the only coin receipt must still be the independently accepted contribution', { expected: 'the same single 10-coin receipt', actual: describe({ balance: acceptance.balance, receipts: acceptance.receipt_count, valid: acceptance.integrity_valid }) });
      return `200 travel to ${home}; saved crop patch at ${site.x},${site.y}; 200 plant; first practice step complete from one saved crop_plant fact; one receipt (quest:quiet-harvest.first-sowing, 5 of 10 cosmetic experience today, available); 0 coins from the practice path (balance 0, no receipt, ledger valid); 400 refused client completion; 403 refused self-review (authorized human account required); the earlier independent acceptance still holds its single 10-coin receipt`;
    });

    await step('16. one shared restoration step with two actors', async () => {
      // Two operators, each with a resident, on a garden no earlier step touched. The plan is read
      // from the API, so no tile and no object type is hard-coded here.
      const restorer = expectStatus(await post('/agents', { kind: 'agent', name: 'Groundskeeper A', color: '#397f79', symbol: '✦', capabilities: 'Carries and places the plan’s own objects', limitations: 'No external tools and no real-world claims' }, { token: world.adminToken }), 201, 'POST /agents (Groundskeeper A)');
      const helper = expectStatus(await post('/agents', { kind: 'agent', name: 'Groundskeeper B', color: '#aa7845', symbol: '✿', capabilities: 'Carries and places the plan’s own objects', limitations: 'No external tools and no real-world claims' }, { token: world.newcomerToken }), 201, 'POST /agents (Groundskeeper B)');
      expectStatus(await post('/callings/select', { agent_id: restorer.id, calling_id: 'builder' }, { token: world.adminToken }), 200, 'POST /callings/select for actor A');
      expectStatus(await post('/callings/select', { agent_id: helper.id, calling_id: 'builder' }, { token: world.newcomerToken }), 200, 'POST /callings/select for actor B');

      const garden = `home:${restorer.id}`;
      const eventId = `restoration:${garden}`;
      expectStatus(await apiRequest(`/agents/${restorer.id}/home`, { method: 'PATCH', token: world.adminToken, body: { visibility: 'public' } }), 200, 'PATCH the garden open to visitors');

      const opened = expectStatus(await post('/restoration/open', { agent_id: restorer.id, hours: 3 }, { token: world.adminToken }), 200, `POST /restoration/open for ${garden}`);
      expectThat(opened.id === eventId && opened.phase === 'open' && opened.site?.open_to_visitors === true, 'the restoration must open on the operator’s own public garden', { expected: `${eventId} open on a public garden`, actual: describe({ id: opened.id, phase: opened.phase, site: opened.site }) });
      const ground = opened.progress.steps.find((item) => item.id === 'ground');
      const [firstSlot, secondSlot] = ground.slots;
      expectThat(firstSlot && secondSlot && !firstSlot.filled && !secondSlot.filled, 'the plan must publish its waiting ground tiles', { expected: 'at least two waiting planned slots', actual: describe(ground.slots) });

      // Actor A walks into its own garden — the recorded visit a pledge requires — then pledges and
      // places the first planned object from beside its tile.
      await sleep(MOVE_INTERVAL_MS);
      expectStatus(await post(`/agents/${restorer.id}/travel`, { world_id: garden }, { token: world.adminToken }), 200, 'POST travel into the garden for actor A');
      expectStatus(await post('/restoration/join', { agent_id: restorer.id, event_id: eventId }, { token: world.adminToken }), 200, 'POST /restoration/join for actor A');
      await walkActorIntoGarden(world.adminToken, restorer.id, garden, { x: firstSlot.x, y: firstSlot.y - 1 });
      const placedA = expectStatus(await post('/restoration/place', { agent_id: restorer.id, event_id: eventId, x: firstSlot.x, y: firstSlot.y }, { token: world.adminToken }), 200, `POST /restoration/place ${firstSlot.type} for actor A`);
      expectThat(placedA.placed?.type === firstSlot.type && placedA.placed?.x === firstSlot.x && placedA.placed?.y === firstSlot.y, 'actor A’s saved object must be the plan’s object on its own tile', { expected: `${firstSlot.type} at ${firstSlot.x},${firstSlot.y}`, actual: describe(placedA.placed) });

      // Actor B travels in, pledges and places the second planned object.
      await sleep(MOVE_INTERVAL_MS);
      expectStatus(await post(`/agents/${helper.id}/travel`, { world_id: garden }, { token: world.newcomerToken }), 200, 'POST travel into the garden for actor B');
      expectStatus(await post('/restoration/join', { agent_id: helper.id, event_id: eventId }, { token: world.newcomerToken }), 200, 'POST /restoration/join for actor B');
      await walkActorIntoGarden(world.newcomerToken, helper.id, garden, { x: secondSlot.x, y: secondSlot.y - 1 });
      const placedB = expectStatus(await post('/restoration/place', { agent_id: helper.id, event_id: eventId, x: secondSlot.x, y: secondSlot.y }, { token: world.newcomerToken }), 200, `POST /restoration/place ${secondSlot.type} for actor B`);
      expectThat(placedB.placed?.type === secondSlot.type && placedB.placed?.x === secondSlot.x, 'actor B’s saved object must be the plan’s second object on its own tile', { expected: `${secondSlot.type} at ${secondSlot.x},${secondSlot.y}`, actual: describe(placedB.placed) });

      // The saved rows, read back over HTTP: one occurrence, two pledges, both objects, and the
      // guide’s own attribution of each counted step to the operator who saved it.
      const read = expectStatus(await get(`/restoration?event_id=${encodeURIComponent(eventId)}`), 200, 'GET /restoration for the shared occurrence');
      expectThat(read.event.participants.length === 2, 'exactly two residents must have pledged', { expected: 'two participants', actual: describe(read.event.participants.map((participant) => participant.name)) });
      expectThat(read.events.filter((item) => item.id === eventId && item.status === 'scheduled').length === 1, 'the occurrence must be one scheduled row', { expected: 'one scheduled occurrence', actual: describe(read.events.filter((item) => item.id === eventId)) });
      const measured = read.event.progress.steps.find((item) => item.id === 'ground');
      expectThat(measured.progress === 2 && measured.target === 3, 'two placed objects must measure two of the three planned tiles', { expected: 'ground 2 of 3', actual: describe(measured) });
      const objects = expectStatus(await get(`/world?world_id=${encodeURIComponent(garden)}`), 200, 'GET /world for the worked garden').objects;
      expectThat(objects.some((object) => object.x === firstSlot.x && object.y === firstSlot.y && object.type === firstSlot.type), 'actor A’s object must stand in the garden', { expected: `${firstSlot.type}@${firstSlot.x},${firstSlot.y}`, actual: describe(objects) });
      expectThat(objects.some((object) => object.x === secondSlot.x && object.y === secondSlot.y && object.type === secondSlot.type), 'actor B’s object must stand in the garden', { expected: `${secondSlot.type}@${secondSlot.x},${secondSlot.y}`, actual: describe(objects) });

      const guide = expectStatus(await get(`/first-play?agent_id=${restorer.id}&world_id=${encodeURIComponent(garden)}`, { token: world.adminToken }), 200, 'GET /first-play for actor A');
      const mine = guide.restoration?.actors?.find((actor) => actor.agent_id === restorer.id);
      const other = guide.restoration?.actors?.find((actor) => actor.agent_id === helper.id);
      expectThat(mine && mine.operator_distinct === false && mine.contributions.some((entry) => entry.step_id === 'ground' && entry.counted >= 1), 'the guide must attribute actor A’s counted ground step to A itself', { expected: 'A counted on ground with operator_distinct=false', actual: describe(mine) });
      expectThat(other && other.operator_distinct === true && other.contributions.some((entry) => entry.step_id === 'ground' && entry.counted >= 1), 'the guide must attribute actor B’s counted ground step to the other operator', { expected: 'B counted on ground with operator_distinct=true', actual: describe(other) });
      expectThat(guide.restoration.remaining.some((item) => item.step_id === 'beds') && guide.restoration.remaining.some((item) => item.step_id === 'keep'), 'the guide must report the surviving steps', { expected: 'beds and keep still remaining', actual: describe(guide.restoration.remaining.map((item) => item.step_id)) });

      world.restoration = { restorerId: restorer.id, helperId: helper.id, garden, eventId, firstSlot, secondSlot, ground: `${measured.progress} of ${measured.target}`, remaining: guide.restoration.remaining.map((item) => item.step_id) };
      return `occurrence ${eventId} scheduled; ${read.event.participants.map((participant) => participant.name).join(' and ')} pledged from two operators; ground ${measured.progress}/${measured.target} placed; guide: A counted ${mine.contributions.find((entry) => entry.step_id === 'ground').counted}, B counted ${other.contributions.find((entry) => entry.step_id === 'ground').counted} (operator_distinct), ${guide.restoration.remaining.length} steps remaining`;
    });

    await step('17. restart persistence', async () => {
      const { restorerId, helperId, garden, eventId, firstSlot, secondSlot } = world.restoration;
      const snapshot = async () => {
        const read = expectStatus(await get(`/restoration?event_id=${encodeURIComponent(eventId)}`), 200, 'GET /restoration for the snapshot');
        const objects = expectStatus(await get(`/world?world_id=${encodeURIComponent(garden)}`), 200, 'GET /world for the snapshot').objects;
        const guide = expectStatus(await get(`/first-play?agent_id=${restorerId}&world_id=${encodeURIComponent(garden)}`, { token: world.adminToken }), 200, 'GET /first-play for the snapshot');
        const places = {};
        for (const [name, id, token] of [['A', restorerId, world.adminToken], ['B', helperId, world.newcomerToken]]) {
          const view = expectStatus(await get(`/world?world_id=${encodeURIComponent(garden)}&agent_id=${id}`, { token }), 200, `GET /world for actor ${name}`);
          const me = (view.participants || []).find((entry) => entry.id === id);
          places[name] = me ? { world_id: me.world_id, x: me.x, y: me.y, z: me.z } : null;
        }
        return {
          participants: read.event.participants.map((participant) => participant.name).sort(),
          progress: read.event.progress.steps.map((step) => [step.id, step.progress, step.target]),
          objects: objects.map((object) => `${object.type}@${object.x},${object.y}`).sort(),
          actors: guide.restoration.actors.map((actor) => [actor.name, actor.operator_distinct, actor.contributions.map((entry) => [entry.step_id, entry.counted])]).sort(),
          remaining: guide.restoration.remaining.map((step) => step.step_id).sort(),
          places,
        };
      };
      const before = await snapshot();
      await restartServer();
      const after = await snapshot();
      expectThat(describe(before) === describe(after), 'the restored garden, both pledges, the guide attribution and both saved places must be identical after a real restart', { expected: describe(before), actual: describe(after) });
      expectThat(after.objects.includes(`${firstSlot.type}@${firstSlot.x},${firstSlot.y}`) && after.objects.includes(`${secondSlot.type}@${secondSlot.x},${secondSlot.y}`), 'both placed objects must still stand after the restart', { expected: 'both placed objects', actual: describe(after.objects) });
      expectThat(after.participants.length === 2, 'both pledges must survive the restart', { expected: 'two pledges', actual: describe(after.participants) });
      expectThat(after.remaining.includes('beds') && after.remaining.includes('keep'), 'the guide’s surviving steps must survive the restart', { expected: 'the same remaining steps', actual: describe(after.remaining) });
      world.firstPlay = { ground: world.restoration.ground, remaining: after.remaining };
      return `after the restart: the same ${after.objects.length} objects, ${after.participants.length} pledges and ${after.remaining.length} remaining guide steps, byte-for-byte`;
    });

    const shutdown = await stopServer();
    expectThat(shutdown.lockReleased, 'a graceful shutdown must release the process lock', { expected: `no ${join(state.workspace, 'server.lock')}`, actual: 'the lock file remained after shutdown' });
    expectThat(shutdown.workspaceRemoved, 'the temporary workspace must be removed', { expected: 'workspace removed', actual: state.workspace });
    console.log('');
    console.log('PASS  cleanup: server stopped, process lock released, temporary workspace removed');
  } catch (error) {
    failure = error;
  }

  if (failure) {
    const shutdown = state.child ? await stopServer() : { kept: false };
    reportFailure(failure, shutdown);
    state.results.push({ name: failure.message, ok: false });
    console.log('');
    console.log(`SUMMARY  ${state.results.filter((result) => result.ok).length} steps passed, 1 failed`);
    console.log(`  failed step      ${String(failure.message).split('\n')[0]}`);
    console.log('  result           FAIL — see the request, response and expected-versus-actual above');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`SUMMARY  ${state.results.length} steps passed, 0 failed`);
  console.log('  coins            one fixed 10-coin receipt for an independently accepted contribution; ledger integrity verified');
  console.log('  newcomer         a member account with one AI resident, one chosen calling, one country ambassador read, one saved practice activity with one cosmetic receipt (5 of 10 today) and zero coins');
  console.log(`  first-ten-minutes one shared garden restored by two operators (${world.firstPlay?.ground ?? 'n/a'} ground tiles placed, the guide attributing each counted step to its own operator with ${world.firstPlay?.remaining?.length ?? 0} steps remaining); every saved row, both pledges and both saved places survived a real server restart`);
  if (state.notes.length) {
    console.log('  notes');
    for (const note of state.notes) console.log(`    - ${note}`);
  }
  console.log('  result           PASS — the shipped server serves this scenario end to end over its own HTTP API');
}

function reportFailure(error, shutdown = {}) {
  console.error('');
  console.error(`FAIL  ${error.message}`);
  if (error.expected !== undefined) console.error(`      expected  ${describe(error.expected)}`);
  if (error.actual !== undefined) console.error(`      actual    ${describe(error.actual)}`);
  if (error.request) console.error(`      request   ${error.request.method} ${error.request.path} ${json(redactRequest(error.request))}`);
  if (error.response) console.error(`      response  HTTP ${error.response.status} ${error.response.raw}`);
  console.error(`      steps passed before the failure: ${state.results.length}`);
  if (serverOutput.length) { console.error('      server output:'); for (const line of serverOutput.slice(-10)) console.error(`        ${line}`); }
  if (shutdown.kept) console.error(`      temporary workspace kept for inspection (LUCY_E2E_KEEP=1): ${state.workspace}`);
  else if (state.workspace) console.error(`      cleanup           server stopped and temporary workspace ${shutdown.workspaceRemoved === false ? 'left in place' : 'removed'}`);
}

process.on('SIGINT', () => { state.child?.kill('SIGTERM'); process.exitCode = 130; });
process.on('unhandledRejection', (error) => { reportFailure(error); process.exitCode = 1; });

await main();
