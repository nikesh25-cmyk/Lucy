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
  let pages = 0;
  for (const x of windowStarts(areaX.minimum, areaX.maximum, columns, width)) {
    for (const y of windowStarts(areaY.minimum, areaY.maximum, rows, height)) {
      const page = expectStatus(await get(`/world?world_id=${encodeURIComponent(worldId)}&x=${x}&y=${y}`), 200, `GET /world window ${x},${y}`);
      for (let row = 0; row < page.terrain.length; row++) for (let column = 0; column < page.terrain[row].length; column++) grid[page.camera.y + row][page.camera.x + column] = page.terrain[row][column];
      pages++;
    }
  }
  return { descriptor, grid, width, height, columns, rows, pages };
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

async function moveOnce(token, direction) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? MOVE_INTERVAL_MS : 400);
    response = await post('/move', { direction }, { token });
    if (response.status !== 429) return response;
  }
  return response;
}

async function walkTo(token, from, target, grid, blocked) {
  const path = pathTo(grid, from, target, blocked);
  expectThat(path !== null, `no walkable route from ${from.x},${from.y} to ${target.x},${target.y}`, { expected: 'a connected walkable route', actual: describe(grid[target.y]?.[target.x]) });
  let current = from;
  for (const next of path) {
    const direction = next.x > current.x ? 'right' : next.x < current.x ? 'left' : next.y > current.y ? 'down' : 'up';
    const response = await moveOnce(token, direction);
    expectStatus(response, 200, `POST /move ${direction} from ${current.x},${current.y}`);
    const body = response.body;
    expectThat(body.blocked === false, `POST /move ${direction} from ${current.x},${current.y} was blocked on a planned walkable tile`, { expected: `blocked=false arriving at ${next.x},${next.y}`, actual: `blocked=${describe(body.blocked)} at ${body.x},${body.y}`, request: response.request, response });
    expectThat(body.x === next.x && body.y === next.y, 'the server position must match the planned route', { expected: `${next.x},${next.y}`, actual: `${body.x},${body.y}`, request: response.request, response });
    current = { x: body.x, y: body.y };
  }
  return current;
}

// The collision refusal is proved on a real unwalkable tile: walk to the nearest
// reachable tile that touches one, then ask the server to step onto it.
async function proveCollisionRefusal(token, from, grid, blocked) {
  const distances = distancesFrom(grid, from, blocked);
  let probe = null;
  for (const [key, distance] of distances) {
    const [x, y] = key.split(',').map(Number);
    for (const [direction, [dx, dy]] of Object.entries({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] })) {
      if (blocked.has(`${x + dx},${y + dy}`)) continue;
      const type = grid[y + dy]?.[x + dx];
      if (typeof type !== 'string' || !UNWALKABLE.has(type)) continue;
      if (!probe || distance < probe.distance) probe = { x, y, distance, direction, type };
    }
  }
  expectThat(probe, 'the character must be able to reach a tile beside an unwalkable terrain tile', { expected: 'a reachable tile with an unwalkable neighbour', actual: `origin ${from.x},${from.y} with ${distances.size} reachable tiles` });
  const position = await walkTo(token, from, { x: probe.x, y: probe.y }, grid, blocked);
  const response = await moveOnce(token, probe.direction);
  expectStatus(response, 200, `POST /move ${probe.direction} onto an unwalkable ${probe.type} tile`);
  expectThat(response.body.blocked === true, `moving onto an unwalkable ${probe.type} tile must be refused`, { expected: 'blocked=true', actual: describe(response.body), request: response.request, response });
  expectThat(response.body.x === position.x && response.body.y === position.y, 'a refused move must leave the position unchanged', { expected: `${position.x},${position.y}`, actual: `${response.body.x},${response.body.y}`, request: response.request, response });
  return { position, probe };
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

    await step('7. the runtime walks to the frontier, is refused an unwalkable tile, and builds in the assigned plot', async () => {
      const commonsView = expectStatus(await get('/world?world_id=commons'), 200, 'GET /world?world_id=commons');
      const gateway = commonsView.portals.find((portal) => portal.target_world_id === 'frontier:0:0');
      expectThat(gateway, 'the Commons must publish the frontier gateway', { expected: 'a portal to frontier:0:0', actual: describe(commonsView.portals.map((portal) => portal.target_world_id)) });
      const commons = await readTerrain('commons', { minimumX: Math.min(world.position.x, gateway.x) - 4, maximumX: Math.max(world.position.x, gateway.x) + 4, minimumY: Math.min(world.position.y, gateway.y) - 4, maximumY: Math.max(world.position.y, gateway.y) + 4 });
      const distances = distancesFrom(commons.grid, world.position);
      let stand = null;
      for (const [dx, dy] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const distance = distances.get(`${gateway.x + dx},${gateway.y + dy}`);
        if (distance !== undefined && (!stand || distance < stand.distance)) stand = { x: gateway.x + dx, y: gateway.y + dy, distance };
      }
      expectThat(stand, 'the frontier gateway must be reachable from the character', { expected: 'a walkable tile beside the gateway', actual: `gateway ${gateway.x},${gateway.y}` });
      world.position = await walkTo(world.runtimeToken, world.position, { x: stand.x, y: stand.y }, commons.grid);

      await sleep(MOVE_INTERVAL_MS);
      const travelled = expectStatus(await post(`/agents/${world.agentId}/travel`, { world_id: 'frontier:0:0' }, { token: world.runtimeToken }), 200, 'POST /agents/:id/travel to frontier:0:0');
      expectThat(travelled.world_id === 'frontier:0:0' && travelled.entered === true && Number.isInteger(travelled.z), 'travel must enter the frontier with an elevation', { expected: 'world_id=frontier:0:0, entered=true, integer z', actual: describe(travelled) });
      world.position = { x: travelled.x, y: travelled.y, world: 'frontier:0:0' };
      const arrival = world.frontier.descriptor.landmarks.find((landmark) => landmark.name === 'Frontier Crossroads');
      if (!arrival || arrival.x !== travelled.x || arrival.y !== travelled.y) state.notes.push(`The frontier arrival ${travelled.x},${travelled.y} differs from the published crossroads ${arrival ? `${arrival.x},${arrival.y}` : 'landmark'}; the construction plan is still recomputed from the real position.`);

      const probe = await proveCollisionRefusal(world.runtimeToken, world.position, world.frontier.grid, world.frontier.blocked);
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
      return `200 travel to frontier:0:0; 200 refused move onto an unwalkable ${probe.probe.type} tile (blocked=true, position unchanged); 200 frontier build (plot_id=${block.plot_id}, ${block.type} at ${block.x},${block.y},z=${block.z}); read back from GET /world and GET /land/plot`;
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
