#!/usr/bin/env node
/**
 * NemoWorld multiplayer soak and reconnect probe.
 *
 * It starts the shipped server (`server.js`) as a real child process against a **temporary** SQLite
 * database and drives many concurrent authenticated clients through the server's own HTTP and
 * Server-Sent Events surface: connect, move, build, chat, express, observe, disconnect, reconnect.
 * Nothing is mocked, no request is replayed from a fixture, and the installed data directory is never
 * touched. The only database is created beneath the OS temp directory and is removed even on failure.
 *
 * What it measures — kept separate, because they answer different questions:
 *   1. completion        accepted writes versus throttles and refusals, per route
 *   2. delivery          frames, update entries and bytes each subscriber actually received
 *   3. ordering          each subscriber's per-avatar tile history against the accepted write order
 *   4. reconnection      a rebuilt `/world` snapshot against the stored rows, then live deltas again
 *   5. write load        the rows and bytes this workload added to the disposable database
 *   6. latency           per-request and per-frame wall clock, as nearest-rank percentiles
 *
 * The invariants a run asserts (any violation fails the run):
 *   - every accepted public message reaches every open subscriber once, none missing, stored order;
 *   - no subscriber ever observes an avatar's *older* tile after a newer one, and the observed history
 *     is always a subsequence of the accepted write order for that avatar;
 *   - after quiescence every open subscriber's last observed tile equals the stored row;
 *   - a client reconnecting through the documented protocol (open the stream, re-read `/world` on
 *     `ready`, apply that snapshot, then the frames buffered while it was in flight) has no divergence
 *     and is live again;
 *   - a full process restart preserves every stored row and the restarted process still streams;
 *   - the process admits its documented 64 subscriptions, refuses the next with 503 and keeps the
 *     admitted ones streaming.
 *
 * Explicit limits (each is enforced and printed in the report):
 *   --accounts       writer accounts, one writing avatar each
 *   --subscriptions  subscriptions per account; accounts x subscriptions is the observer count
 *   --duration       how long the concurrent write phase runs
 *   --json           write the machine-readable report to this path
 *   --keep           keep the temporary database for inspection
 *
 * What it does NOT measure: model throughput or the model queue (no local model is configured, so no
 * model call is made), real network latency, TLS, a proxy, packet loss, multiple server processes,
 * multiple SQLite writers, memory growth over hours or disk exhaustion. One Node process on one SQLite
 * writer, loopback only. A client count here is **not** a count of supported users.
 *
 *   node scripts/multiplayer-soak.mjs [--accounts 8] [--subscriptions 4] [--duration 6000]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Platform } from '../src/platform.js';
import { getWorldDefinition, walkable } from '../world.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'multiplayer-soak-password-2026';
const CARDINALS = ['up', 'right', 'down', 'left'];
// Every `/world` snapshot read is centred here so the returned window holds the whole soak cluster
// instead of only the residents standing beside the world's own arrival tile.
const WINDOW = Object.freeze({ x: 8, y: 2 });
const SERVER_READY_TIMEOUT_MS = 120_000;
const OK = 200;
const CREATED = 201;
const THROTTLED = 429;

// ---------------------------------------------------------------------------------------------
// Limits. Every one is enforced by the run and printed in its report.
// ---------------------------------------------------------------------------------------------
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const positive = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const JSON_PATH = option('json', null);
export const SOAK_LIMITS = Object.freeze({
  accounts: positive(option('accounts', '8'), 8),
  subscriptions_per_account: positive(option('subscriptions', '4'), 4),
  phase_ms: positive(option('duration', '6000'), 6000),
  // The server's own throttles: 120 ms between one avatar's steps (`src/spaces.js`), 1500 ms between
  // one account's messages and 5000 ms between its expressions (`src/platform.js`). The harness paces
  // above them, so a 429 means the bound was reached rather than the harness being too fast.
  move_pace_ms: 145,
  chat_every_moves: 12,
  emote_every_moves: 40,
  quiesce_ms: 400,
  // The client's own bound while a snapshot is in flight. The server's channel ceiling is 256 pending
  // updates (`EVENT_LIMITS.max_pending_updates`); exceeding the client's own bound is reported, not
  // silently accepted.
  client_buffer_frames: 512,
  process_subscription_ceiling: 64,
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))].toFixed(2));
}
const spread = (values) => values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: null, max: null };
const round = (value, places = 2) => value === null || value === undefined ? null : Number(value.toFixed(places));

/**
 * Greedy subsequence test. `observed` is one client's tile history for one avatar in arrival order;
 * `accepted` is the order the server confirmed the writes in. Two things are legitimate and must not
 * be reported as defects:
 *   - coalescing skips entries, so the observed sequence is a *subsequence*, never an equality;
 *   - any frame may republish the avatar's stored tile — an expression or a posture change carries
 *     the position too — so a consecutive repeat of the tile already matched is always allowed.
 * What is rejected is the real defect: a tile that the server had already superseded, i.e. a value
 * whose only occurrences all precede the last one matched.
 */
export function subsequenceIndex(observed, accepted) {
  let cursor = 0, current = null;
  for (const entry of observed) {
    if (current && current.x === entry.x && current.y === entry.y) continue;
    let found = -1;
    for (let index = cursor; index < accepted.length; index++) {
      if (accepted[index].x === entry.x && accepted[index].y === entry.y) { found = index; break; }
    }
    if (found === -1) return { ok: false, at: entry };
    cursor = found + 1;
    current = entry;
  }
  return { ok: true, at: null };
}

/**
 * The documented reconnect protocol as one client. A subscriber's only source of truth is the server:
 * it opens the stream, re-reads `/world` on `ready`, replaces its state with that snapshot, and then
 * applies — in arrival order — the frames that arrived while the snapshot was in flight. Applying a
 * buffered frame *before* the snapshot, or not buffering at all, is what turns a reconnect into
 * divergence, so this is the protocol `src/ui/spectator.js` already implements.
 */
export function createSoakClient({ base, token, worldId, name = 'client' }) {
  const client = {
    name, base, token, worldId,
    stream: null, generation: 0, streams: 0,
    status: null, connects: 0, snapshots: 0, readyFrames: 0,
    frames: 0, entries: 0, bytes: 0, comments: 0, refreshes: 0, foreign: 0, parseErrors: 0,
    latency: [], buffered: 0, bufferOverflowed: false,
    residents: new Map(), objects: new Map(), messages: new Map(), messageOrder: [],
    history: new Map(), wireMessages: new Map(),
    duplicates: 0, closed: [], errors: [], refused: null,
    ready: false, buffering: true, queueFrame: null,
  };

  function buildSnapshot(payload) {
    client.residents = new Map();
    client.objects = new Map();
    for (const resident of payload?.participants || []) {
      if (!resident?.id) continue;
      client.residents.set(resident.id, { x: resident.x, y: resident.y, z: resident.z, world_id: resident.world_id });
    }
    for (const object of payload?.objects || []) client.objects.set(`${object.x},${object.y}`, { x: object.x, y: object.y, type: object.type });
    for (const message of payload?.messages || []) if (message?.id && !client.messages.has(message.id)) {
      client.messages.set(message.id, message);
      client.messageOrder.push(message.id);
    }
  }

  function applyFrame(frame) {
    if (!frame || typeof frame !== 'object') { client.parseErrors += 1; return; }
    if (frame.world_id !== client.worldId) { client.foreign += 1; return; }
    client.frames += 1;
    if (Number.isFinite(frame.t)) client.latency.push(Math.max(0, Date.now() - frame.t));
    for (const agent of frame.agents || []) {
      if (!agent?.id) continue;
      client.entries += 1;
      // A delta naming another world is how the channel reports that an avatar left this one.
      if (agent.world_id && agent.world_id !== client.worldId) { client.residents.delete(agent.id); continue; }
      client.residents.set(agent.id, { ...(client.residents.get(agent.id) || {}), x: agent.x, y: agent.y, z: agent.z, world_id: client.worldId });
      const seen = client.history.get(agent.id) || [];
      seen.push({ x: agent.x, y: agent.y, at: frame.t });
      client.history.set(agent.id, seen);
    }
    for (const change of frame.objects || []) {
      if (!Number.isInteger(change?.x) || !Number.isInteger(change?.y)) continue;
      client.entries += 1;
      const key = `${change.x},${change.y}`;
      if (change.op === 'remove') client.objects.delete(key);
      else client.objects.set(key, { x: change.x, y: change.y, type: change.type });
    }
    for (const message of frame.messages || []) {
      if (!message?.id) continue;
      client.entries += 1;
      const occurrences = client.wireMessages.get(message.id) || 0;
      client.wireMessages.set(message.id, occurrences + 1);
      if (occurrences) client.duplicates += 1;
      if (!client.messages.has(message.id)) { client.messages.set(message.id, message); client.messageOrder.push(message.id); }
    }
    if (frame.refresh) client.refreshes += 1;
  }

  async function refresh(generation, settle, timeoutMs) {
    const queued = [];
    let overflowed = false;
    client.buffering = true;
    client.queueFrame = (frame) => { if (queued.length < SOAK_LIMITS.client_buffer_frames) queued.push(frame); else overflowed = true; };
    let snapshot = null;
    try {
      const response = await fetch(`${base}/api/v1/world?world_id=${encodeURIComponent(worldId)}&x=${WINDOW.x}&y=${WINDOW.y}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (!response.ok) client.errors.push(`snapshot HTTP ${response.status}: ${payload?.error || ''}`);
      else snapshot = payload;
    } catch (error) { client.errors.push(`snapshot ${error.message}`); }
    if (generation !== client.generation) return;
    client.queueFrame = null;
    client.buffering = false;
    client.buffered = queued.length;
    client.bufferOverflowed = client.bufferOverflowed || overflowed;
    if (snapshot) { buildSnapshot(snapshot); client.snapshots += 1; client.ready = true; }
    else client.ready = false;
    for (const frame of queued) if (generation === client.generation) applyFrame(frame);
    settle(client.ready);
  }

  function open(timeoutMs = 15_000) {
    return new Promise((resolveOpen) => {
      client.ready = false;
      client.status = null;
      client.refused = null;
      client.closed = [];
      client.wireMessages = new Map();
      client.streams += 1;
      const generation = ++client.generation;
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; resolveOpen(value); } };
      const url = new URL(base);
      const request = httpRequest({
        host: url.hostname, port: url.port, method: 'GET',
        path: `/api/v1/events?world_id=${encodeURIComponent(worldId)}`,
        headers: { Host: url.host, Authorization: `Bearer ${token}` },
      }, (response) => {
        client.status = response.statusCode;
        if (response.statusCode !== 200) {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            client.refused = { status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') };
            settle(false);
          });
          return;
        }
        client.connects += 1;
        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk) => {
          client.bytes += Buffer.byteLength(chunk);
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let event = '', data = '', comment = false;
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) comment = true;
              else if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (comment) { client.comments += 1; continue; }
            if (!event) continue;
            let payload = null;
            if (data) { try { payload = JSON.parse(data); } catch { client.parseErrors += 1; } }
            if (event === 'ready') { client.readyFrames += 1; void refresh(generation, settle, timeoutMs); }
            else if (event === 'update') { if (client.queueFrame) client.queueFrame(payload); else applyFrame(payload); }
            else if (event === 'closed') client.closed.push(payload?.reason || 'closed');
          }
        });
        response.on('end', () => settle(false));
        response.on('error', (error) => { client.errors.push(`stream ${error.message}`); settle(false); });
      });
      request.on('error', (error) => { client.errors.push(`request ${error.code || error.message}`); settle(false); });
      request.end();
      client.stream = { close: () => { try { request.destroy(); } catch { /* The peer is already gone. */ } } };
    });
  }

  async function close() {
    client.generation += 1;
    client.ready = false;
    client.buffering = true;
    client.queueFrame = null;
    client.stream?.close();
    client.stream = null;
    client.status = null;
    await sleep(25);
  }

  return {
    name,
    state: () => client,
    connect: () => open(),
    // A reconnect is the same protocol as a first connection: a new `ready` restarts the snapshot.
    reconnect: () => open(),
    close,
    applyFrame,
    historyOf: (agentId) => client.history.get(agentId) || [],
    messageOrder: () => client.messageOrder,
  };
}

// ---------------------------------------------------------------------------------------------
// Server lifecycle against a disposable database.
// ---------------------------------------------------------------------------------------------
const processState = { workspace: null, database: null, port: null, child: null, output: [] };

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
  });
}

async function startServer() {
  const env = { ...process.env, PORT: String(processState.port), LUCY_DATABASE: processState.database, LUCY_BIND_HOST: '127.0.0.1' };
  for (const name of ['LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_SETUP_CODE', 'LUCY_MODEL_URL', 'LUCY_MODEL_NAME', 'LUCY_LOCAL_PORT_FALLBACK']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  processState.child = child;
  const collect = (chunk) => { processState.output.push(chunk.toString('utf8').trimEnd()); if (processState.output.length > 40) processState.output.shift(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited with code ${child.exitCode} before becoming ready.\n${processState.output.join('\n')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${processState.port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* The port is not bound yet. */ }
    await sleep(80);
  }
  throw new Error(`The server did not become ready within ${SERVER_READY_TIMEOUT_MS} ms.\n${processState.output.join('\n')}`);
}

async function stopServer() {
  const child = processState.child;
  processState.child = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

/** A standable tile inside the snapshot window: `walkable` already excludes solid authored scenery. */
export function seatTiles(definition, count) {
  const tiles = [];
  for (let y = WINDOW.y; y < WINDOW.y + 14 && tiles.length < count * 4; y++) {
    for (let x = WINDOW.x; x < WINDOW.x + 19 && tiles.length < count * 4; x++) {
      if (walkable({ x, y }, definition)) tiles.push({ x, y });
    }
  }
  if (tiles.length < count) throw new Error(`The fixture offers ${tiles.length} standable tiles for ${count} avatars.`);
  return Array.from({ length: count }, (_, index) => tiles[Math.floor(index * tiles.length / count)]);
}

async function seed({ writers, others }) {
  const platform = new Platform(processState.database);
  try {
    const definition = getWorldDefinition('commons');
    const seats = seatTiles(definition, writers);
    const admin = await platform.register({ name: 'Soak admin', email: 'admin@soak.test', password: PASSWORD, consent: true });
    const adminActor = platform.authenticate(admin.token);
    const invites = platform.transaction(() => Array.from({ length: writers + others }, (_, index) => platform.invite(adminActor, { role: 'member' }).code));
    // scrypt is deliberately expensive, so the digests are computed concurrently; each registration's
    // own transaction still runs alone, because its database work happens after its digest resolves.
    const accounts = await Promise.all(invites.map((code, index) => platform.register({ name: `Soak account ${index}`, email: `soak-${index}@soak.test`, password: PASSWORD, consent: true, invite: code })));
    const created = platform.transaction(() => accounts.map((account, index) => ({
      token: account.token,
      account_id: platform.authenticate(account.token).account.id,
      agent: index < writers ? platform.createAgent(platform.authenticate(account.token), { kind: 'human', name: `Soak resident ${index}` }) : null,
    })));
    platform.transaction(() => {
      for (const [index, item] of created.entries()) {
        if (!item.agent) continue;
        const seat = seats[index];
        platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0 WHERE id=?', 'commons', seat.x, seat.y, item.agent.id);
      }
    });
    return {
      admin: { token: admin.token, account_id: adminActor.account.id },
      writers: created.slice(0, writers).map((item, index) => ({ token: item.token, account_id: item.account_id, agent_id: item.agent.id, seat: seats[index] })),
      others: created.slice(writers),
      seats,
    };
  } finally { platform.close(); }
}

// ---------------------------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------------------------
function createRecorder() {
  const failures = [];
  let passed = 0;
  return {
    failures,
    get passed() { return passed; },
    check(condition, message) { if (condition) passed += 1; else failures.push(message); return Boolean(condition); },
    equal(actual, expected, message) { return this.check(Object.is(actual, expected), `${message} (expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)})`); },
  };
}

const KNOWN_OPTIONS = new Set(['accounts', 'subscriptions', 'duration', 'json', 'keep']);
function assertArguments() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith('--')) throw new Error(`Unexpected argument "${args[index]}"; only the documented --options are accepted.`);
    const name = args[index].slice(2);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`Unknown option --${name}.`);
    if (name !== 'keep') index += 1;
  }
  if (process.env.LUCY_DATABASE) throw new Error('Refusing an inherited LUCY_DATABASE; unset it before this disposable probe.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NemoWorld requires Node 24 or newer.');
}

async function run() {
  assertArguments();
  const limits = SOAK_LIMITS;
  const writers = limits.accounts;
  const others = writers;                                   // one observer account per writer account
  const subscriptions = writers * limits.subscriptions_per_account;
  const ceiling = limits.process_subscription_ceiling;
  const accounts = writers + others;
  if (subscriptions > ceiling) {
    throw new Error(`--accounts ${writers} x --subscriptions ${limits.subscriptions_per_account} is ${subscriptions} subscriptions, above the documented ceiling of ${ceiling}.`);
  }
  // The bound probe opens the ceiling exactly, from the same accounts, after the soak has released
  // them; that needs enough account slots to reach 64.
  if (accounts * limits.subscriptions_per_account < ceiling) {
    throw new Error(`Reaching the documented ${ceiling}-subscription ceiling needs at least ${Math.ceil(ceiling / limits.subscriptions_per_account)} accounts; ${accounts} are configured.`);
  }

  processState.workspace = await mkdtemp(join(tmpdir(), 'nemoworld-soak-'));
  processState.database = join(processState.workspace, 'soak.sqlite');
  processState.port = await freePort();
  const recorder = createRecorder();
  const requests = [];
  const accepted = new Map();
  const messages = [];
  const clients = [];
  const byRoute = new Map();

  const api = async (actor, method, path, body, expected = OK) => {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${processState.port}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${actor.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    const route = `${method} ${path.replace(/\/agents\/[^/]+/, '/agents/:id').replace(/\?.*$/, '')}`;
    const record = { route, status: response.status, ms: performance.now() - started };
    requests.push(record);
    if (!byRoute.has(route)) byRoute.set(route, []);
    byRoute.get(route).push(record);
    if (expected !== null && response.status !== expected && response.status !== THROTTLED) {
      recorder.failures.push(`${route} must return ${expected}, saw ${response.status}: ${String(payload?.error || '').slice(0, 120)}`);
    }
    return { status: response.status, payload };
  };
  const seeded = await seed({ writers, others });
  const base = `http://127.0.0.1:${processState.port}`;
  for (const item of seeded.writers) accepted.set(item.agent_id, []);

  await startServer();
  let restartSnapshot = null;
  let placed = [];
  let compared = 0;
  let phaseElapsedMs = 0;
  let storageBefore = null;
  const defects = [];
  try {
    storageBefore = await storageBytes(processState.database);
    // ---- Phase 1: every observer connects through the documented protocol ----------------------
    for (let index = 0; index < subscriptions; index++) {
      const actor = seeded.writers[index % seeded.writers.length];
      clients.push(createSoakClient({ base, token: actor.token, worldId: 'commons', name: `subscriber-${index}` }));
    }
    const connected = await Promise.all(clients.map((client) => client.connect()));
    recorder.equal(connected.filter(Boolean).length, subscriptions, 'every client must open its stream and apply an authoritative snapshot');
    recorder.check(clients.every((client) => client.state().status === 200), 'every subscription must be admitted with HTTP 200');
    recorder.check(clients.every((client) => client.state().readyFrames >= 1), 'every subscription must deliver a ready frame');
    recorder.check(clients.every((client) => client.state().residents.size >= writers), `every snapshot must contain the whole avatar cluster (${writers})`);
    recorder.equal(clients.reduce((sum, client) => sum + client.state().foreign, 0), 0, 'no frame may name a world the subscriber did not subscribe to');

    // ---- Phase 2: concurrent writers, one avatar each, paced above every server throttle --------
    const deadline = Date.now() + limits.phase_ms;
    const stopped = { value: false };
    const stable = clients.filter((_, index) => index % 4 === 0);
    const writer = async (participant, index) => {
      let step = 0, sinceChat = 0, sinceEmote = 0;
      let direction = CARDINALS[index % CARDINALS.length];
      // Stagger the writers so they do not publish in lockstep: a synchronized burst would coalesce
      // into one frame per tick and understate both the frame rate and the channel's own load.
      await sleep((index * 37) % limits.move_pace_ms);
      while (!stopped.value && Date.now() < deadline) {
        const move = await api(participant, 'POST', '/move', { agent_id: participant.agent_id, direction });
        if (move.status === OK) {
          accepted.get(participant.agent_id).push({ x: move.payload.x, y: move.payload.y });
          if (step % 5 === 4) direction = CARDINALS[(CARDINALS.indexOf(direction) + 1) % CARDINALS.length];
        }
        step += 1;
        sinceChat += 1;
        sinceEmote += 1;
        if (sinceChat >= limits.chat_every_moves) {
          sinceChat = 0;
          // The message route answers 200 with the stored id, not 201.
          const chat = await api(participant, 'POST', '/messages', { agent_id: participant.agent_id, channel: 'public', text: `Soak ${index}: step ${step}` });
          if (chat.status === OK) messages.push({ id: chat.payload.id });
        }
        if (sinceEmote >= limits.emote_every_moves) {
          sinceEmote = 0;
          await api(participant, 'POST', '/emotes', { agent_id: participant.agent_id, emote: ['wave', 'bow', 'cheer', 'think', 'heart'][step % 5] });
        }
        await sleep(limits.move_pace_ms + (index * 11) % 40);
      }
    };
    const reconnector = async () => {
      await sleep(Math.floor(limits.phase_ms / 3));
      for (const client of stable) { await client.close(); await client.reconnect(); }
    };
    const phaseStarted = performance.now();
    await Promise.all([...seeded.writers.map((participant, index) => writer(participant, index)), reconnector()]);
    phaseElapsedMs = performance.now() - phaseStarted;
    stopped.value = true;
    await sleep(limits.quiesce_ms);
    recorder.check(stable.every((client) => client.state().ready), 'every subscriber that reconnected during the writes must be live again');

    // ---- Phase 3: convergence, ordering and message delivery ------------------------------------
    const canonical = readCanonical();
    const stored = new Map(canonical.agents.map((row) => [row.id, row]));
    let orderingViolations = 0, convergenceMismatches = 0, convergences = 0;
    for (const client of clients) {
      const view = client.state();
      if (!view.ready) continue;
      for (const [agentId, acceptedTiles] of accepted) {
        if (!acceptedTiles.length) continue;
        const verdict = subsequenceIndex(client.historyOf(agentId), acceptedTiles);
        if (!verdict.ok) {
          orderingViolations += 1;
          if (orderingViolations <= 3) recorder.failures.push(`${client.name} observed avatar ${agentId} at ${verdict.at.x},${verdict.at.y} after a later accepted tile (stale overwrite or out-of-order frame); observed=${JSON.stringify(client.historyOf(agentId).map((tile) => `${tile.x},${tile.y}`))} accepted=${JSON.stringify(acceptedTiles.map((tile) => `${tile.x},${tile.y}`))}`);
        }
        const row = stored.get(agentId), last = view.residents.get(agentId);
        if (row && last && last.x === row.x && last.y === row.y) convergences += 1;
        else { convergenceMismatches += 1; if (convergenceMismatches <= 3) recorder.failures.push(`${client.name} ended at ${last?.x},${last?.y} for ${agentId} but the stored row is ${row?.x},${row?.y}`); }
      }
    }
    recorder.equal(orderingViolations, 0, 'no subscriber may observe an avatar tile the server had already superseded');
    recorder.equal(convergenceMismatches, 0, 'after quiescence every open subscriber must agree with the stored rows');

    const openClients = clients.filter((client) => client.state().ready);
    const canonicalIds = canonical.messages.map((row) => row.id);
    const indexOf = new Map(canonicalIds.map((id, index) => [id, index]));
    const delivery = { compared: openClients.length, complete: 0, missing: 0, unordered: 0, duplicates: 0 };
    for (const client of openClients) {
      delivery.duplicates += client.state().duplicates;
      const indices = client.messageOrder().map((id) => indexOf.get(id)).filter((index) => index !== undefined);
      const monotone = indices.every((index, position) => position === 0 || index > indices[position - 1]);
      const contiguous = indices.every((index, position) => position === 0 || index === indices[position - 1] + 1);
      const expected = indices.length ? canonicalIds.length - indices[0] : 0;
      if (!monotone) { delivery.unordered += 1; recorder.failures.push(`${client.name} received stored messages out of order`); }
      else if (contiguous && indices.length === expected) delivery.complete += 1;
      else { delivery.missing += 1; recorder.failures.push(`${client.name} received ${indices.length} of the ${expected} stored messages published after its first (a frame was missed)`); }
    }
    recorder.equal(delivery.duplicates, 0, 'no subscriber may receive the same message twice on the wire');
    recorder.equal(delivery.missing, 0, 'no open subscriber may miss a stored public message');
    recorder.equal(delivery.unordered, 0, 'no open subscriber may receive stored messages out of stored order');

    // The garden phase needs subscriptions of its own. At the documented ceiling there is no headroom,
    // so a few soak subscriptions are released now that they have been compared.
    compared = openClients.length;
    for (const client of clients.slice(-4)) await client.close();
    await sleep(200);

    // ---- Phase 4: build in a garden, with one observer away for the writes ----------------------
    const builder = seeded.writers[0];
    const gardenId = `home:${builder.agent_id}`;
    const travel = await api(builder, 'POST', `/agents/${builder.agent_id}/travel`, { world_id: gardenId });
    recorder.equal(travel.status, OK, 'the builder must be able to walk into its own garden');
    const gardenDefinition = getWorldDefinition(gardenId);
    const buildTiles = [];
    for (let y = 2; y < gardenDefinition.rows - 2 && buildTiles.length < 12; y++) {
      for (let x = 2; x < gardenDefinition.columns - 2 && buildTiles.length < 12; x++) {
        if (!walkable({ x, y }, gardenDefinition)) continue;
        const nearStart = Math.abs(x - gardenDefinition.start.x) + Math.abs(y - gardenDefinition.start.y) <= 1;
        const nearPortal = (gardenDefinition.portals || []).some((portal) => Math.abs(portal.x - x) + Math.abs(portal.y - y) <= 1);
        if (!nearStart && !nearPortal) buildTiles.push({ x, y });
      }
    }
    recorder.check(buildTiles.length >= 8, 'the garden fixture must offer at least eight buildable tiles');
    const gardenObservers = [0, 1].map((index) => createSoakClient({ base, token: seeded.others[index % seeded.others.length].token, worldId: gardenId, name: `garden-observer-${index}` }));
    recorder.check((await Promise.all(gardenObservers.map((client) => client.connect()))).every(Boolean), 'garden observers must subscribe to the public garden');

    placed = [];
    for (const tile of buildTiles.slice(0, 6)) {
      const result = await api(builder, 'POST', `/agents/${builder.agent_id}/build`, { type: 'flowers', x: tile.x, y: tile.y }, CREATED);
      if (result.status === CREATED) placed.push(tile);
    }
    await gardenObservers[0].close();
    await api(builder, 'POST', `/agents/${builder.agent_id}/build`, { type: 'bench', x: buildTiles[6].x, y: buildTiles[6].y }, CREATED);
    await api(builder, 'POST', `/agents/${builder.agent_id}/build`, { remove: true, x: buildTiles[0].x, y: buildTiles[0].y }, CREATED);
    await sleep(limits.quiesce_ms);
    await gardenObservers[0].reconnect();
    const gardenRows = readGarden(gardenId);
    for (const client of gardenObservers) {
      const keys = [...client.state().objects.keys()].sort();
      recorder.check(JSON.stringify(keys) === JSON.stringify(gardenRows.map((row) => `${row.x},${row.y}`).sort()), `${client.name} must hold exactly the stored garden objects after reconciling`);
      recorder.check(gardenRows.every((row) => client.state().objects.get(`${row.x},${row.y}`)?.type === row.type), `${client.name} must hold the stored type for every garden object`);
    }
    for (const client of gardenObservers) await client.close();

    // ---- Phase 4b: an entitlement change that relocates residents -------------------------------
    // `PATCH /agents/:id/home {visibility:'private'}` moves every visitor of that garden back to the
    // Commons. That relocation is a world mutation and an arrival, so the channel's documented
    // contract says the Commons subscribers must receive it. This measures whether they do.
    const host = seeded.writers[2];
    const visitor = seeded.writers[3];
    const hostGarden = `home:${host.agent_id}`;
    const walked = await api(visitor, 'POST', `/agents/${visitor.agent_id}/travel`, { world_id: hostGarden });
    recorder.equal(walked.status, OK, 'the visitor must be able to enter the public garden');
    const hostObserver = createSoakClient({ base, token: host.token, worldId: hostGarden, name: 'host-garden' });
    // The host's account already holds its share of the soak subscriptions; free one slot so the
    // owner can hold one more subscription, on its own garden.
    const hostHeld = clients.filter((client) => client.state().token === host.token && client.state().ready);
    if (hostHeld.length >= limits.subscriptions_per_account) await hostHeld[0].close();
    recorder.check(await hostObserver.connect(), `the owning operator must be able to observe its own public garden (${JSON.stringify(hostObserver.state().refused)})`);
    const witness = clients.find((client) => client.state().ready);
    recorder.check(Boolean(witness), 'at least one Commons subscriber must still be live for the relocation phase');
    await sleep(limits.quiesce_ms);
    const departuresBefore = witness.historyOf(visitor.agent_id).length;
    const privacy = await api(host, 'PATCH', `/agents/${host.agent_id}/home`, { visibility: 'private' });
    recorder.equal(privacy.status, OK, 'the garden owner must be able to make the garden private');
    const relocated = readAgent(visitor.agent_id);
    await sleep(600);
    const arrivalFrames = witness.historyOf(visitor.agent_id).length - departuresBefore;
    const witnessKnowsVisitor = witness.state().residents.get(visitor.agent_id) || null;
    const worldView = await api(visitor, 'GET', `/world?world_id=commons&x=${WINDOW.x}&y=${WINDOW.y}`);
    const listedInCommons = (worldView.payload?.participants || []).some((item) => item.id === visitor.agent_id);
    // The owner keeps its subscription: a garden is readable by its own operator even when private.
    recorder.check(hostObserver.state().ready, 'the owner’s subscription must survive its garden becoming private');
    recorder.equal(hostObserver.state().closed.length, 0, 'the owner must not be disconnected by its own privacy change');
    if (relocated.world_id === 'commons' && arrivalFrames === 0) {
      defects.push({
        id: 'silent_relocation_on_entitlement_change',
        severity: 'missed delta (lost arrival)',
        trigger: `PATCH /agents/${host.agent_id}/home { visibility: 'private' } while avatar ${visitor.agent_id} visited ${hostGarden}`,
        evidence: [
          `the stored row moved to ${relocated.world_id},${relocated.x},${relocated.y} and GET /world?world_id=commons lists it there (listed=${listedInCommons})`,
          `a Commons subscriber received ${arrivalFrames} update frames naming that avatar in the 600 ms after the change`,
          `that subscriber’s own state has no entry for the avatar (${witnessKnowsVisitor === null ? 'absent' : `stale at ${witnessKnowsVisitor.x},${witnessKnowsVisitor.y}`})`,
          'the visitor’s garden subscription was closed with access_revoked, which is correct',
        ],
        impact: 'A subscriber of the destination world never learns that a resident arrived there, so its view stays wrong until its next GET /world poll (the browser polls every 3 s). The same client also keeps a resident the server has already moved when the client is bound to the source world.',
        owner: 'src/spaces.js homeSettings — the relocation UPDATE runs without events.publish',
        contract: 'docs/ARCHITECTURE.md: “A world mutation (a step, an arrival, a saved object, a frontier block, a public message) publishes a bounded delta … and every subscriber of that world receives it within one frame interval.”',
        suggested_fix: 'publish one agents delta per relocated visitor to the Commons world (and to the garden) after the UPDATE, exactly as travel does.',
      });
    }
    await hostObserver.close();

    // ---- Phase 5: a full process restart --------------------------------------------------------
    restartSnapshot = JSON.stringify(readStored());
    await stopServer();
    await startServer();
    recorder.equal(JSON.stringify(readStored()), restartSnapshot, 'a full process restart must preserve every avatar tile and placed object');
    for (const client of clients) await client.close();
    const revived = clients.slice(0, 2);
    recorder.check((await Promise.all(revived.map((client) => client.reconnect()))).every(Boolean), 'subscriptions must open again against the restarted process');
    const mover = seeded.writers[1];
    const afterRestart = await api(mover, 'POST', '/move', { agent_id: mover.agent_id, direction: CARDINALS[0] });
    if (afterRestart.status === OK) accepted.get(mover.agent_id).push({ x: afterRestart.payload.x, y: afterRestart.payload.y });
    await sleep(limits.quiesce_ms);
    recorder.check(revived.every((client) => client.historyOf(mover.agent_id).length >= 1), 'a restarted process must still stream live deltas to its subscribers');
    for (const client of revived) await client.close();
    // Let the server notice every closed socket before the ceiling is measured; opening exactly 64
    // would silently fail if a previous subscription were still held.
    await sleep(500);

    // ---- Phase 6: the documented process ceiling, on real sockets -------------------------------
    const pool = [...seeded.writers, ...seeded.others];
    const bound = [];
    for (let index = 0; index < ceiling; index++) {
      const actor = pool[index % pool.length];
      bound.push(createSoakClient({ base, token: actor.token, worldId: 'commons', name: `bound-${index}` }));
    }
    recorder.check(pool.every((actor) => bound.filter((client) => client.state().token === actor.token).length <= limits.subscriptions_per_account), `no account may be offered more than its documented ${limits.subscriptions_per_account} subscriptions`);
    const admitted = await Promise.all(bound.map((client) => client.connect()));
    recorder.equal(admitted.filter(Boolean).length, ceiling, `the process must admit every subscription up to its documented ceiling of ${ceiling}`);
    const overflow = createSoakClient({ base, token: seeded.others[0].token, worldId: 'commons', name: 'overflow' });
    const overflowOpened = await overflow.connect();
    recorder.equal(overflowOpened, false, 'a subscription past the process ceiling must be refused');
    recorder.equal(overflow.state().refused?.status, 503, 'the process ceiling must answer 503');
    const survivor = bound[0];
    const before = survivor.historyOf(mover.agent_id).length;
    const probe = await api(mover, 'POST', '/move', { agent_id: mover.agent_id, direction: CARDINALS[1] });
    if (probe.status === OK) accepted.get(mover.agent_id).push({ x: probe.payload.x, y: probe.payload.y });
    await sleep(limits.quiesce_ms);
    recorder.check(survivor.historyOf(mover.agent_id).length > before, 'a refused subscription must not disturb the admitted ones');
    await overflow.close();
    for (const client of bound) await client.close();
  } finally {
    await stopServer();
  }

  // ---- Report -----------------------------------------------------------------------------------
  const allLatency = clients.flatMap((client) => client.state().latency);
  const latencies = requests.filter((row) => row.status < 400).map((row) => row.ms);
  const report = {
    generated_at: new Date().toISOString(),
    hardware: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model || 'unknown', cpus: cpus().length, memory_bytes: totalmem(), node: process.version },
    limits,
    concurrency: { writer_accounts: writers, observer_accounts: seeded.others.length, subscriptions, process_ceiling: limits.process_subscription_ceiling },
    workload_ms: limits.phase_ms,
    requests: {
      attempts: requests.length,
      accepted: requests.filter((row) => row.status === OK || row.status === CREATED).length,
      throttled: requests.filter((row) => row.status === THROTTLED).length,
      refused: requests.filter((row) => row.status >= 400 && row.status !== THROTTLED).length,
      latency_p50_ms: percentile(latencies, 0.5),
      latency_p95_ms: percentile(latencies, 0.95),
      latency_max_ms: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : null,
      by_route: Object.fromEntries([...byRoute.entries()].map(([route, rows]) => [route, {
        attempts: rows.length,
        accepted: rows.filter((row) => row.status === OK || row.status === CREATED).length,
        throttled: rows.filter((row) => row.status === THROTTLED).length,
        p50_ms: percentile(rows.filter((row) => row.status < 400).map((row) => row.ms), 0.5),
        p95_ms: percentile(rows.filter((row) => row.status < 400).map((row) => row.ms), 0.95),
      }])),
    },
    events: {
      subscriptions: clients.length,
      opens: clients.reduce((sum, client) => sum + client.state().connects, 0) + limits.process_subscription_ceiling,
      snapshots_applied: clients.reduce((sum, client) => sum + client.state().snapshots, 0),
      frames_total: clients.reduce((sum, client) => sum + client.state().frames, 0),
      frames_per_client: spread(clients.map((client) => client.state().frames)),
      update_entries_total: clients.reduce((sum, client) => sum + client.state().entries, 0),
      bytes_total: clients.reduce((sum, client) => sum + client.state().bytes, 0),
      heartbeats: clients.reduce((sum, client) => sum + client.state().comments, 0),
      foreign_frames: clients.reduce((sum, client) => sum + client.state().foreign, 0),
      wire_duplicate_messages: clients.reduce((sum, client) => sum + client.state().duplicates, 0),
      parse_errors: clients.reduce((sum, client) => sum + client.state().parseErrors, 0),
      client_buffer_overflows: clients.filter((client) => client.state().bufferOverflowed).length,
      delivery_latency_ms: { samples: allLatency.length, ...Object.fromEntries(['p50', 'p95', 'p99'].map((key, index) => [key, percentile(allLatency, [0.5, 0.95, 0.99][index])])), max: allLatency.length ? Math.max(...allLatency) : null },
      live_at_quiescence: compared,
    },
    writes: {
      accepted_steps: [...accepted.values()].reduce((sum, list) => sum + list.length, 0),
      public_messages: messages.length,
      garden_builds: placed.length + 2,
      phase_ms: round(phaseElapsedMs, 1),
      // Row-writing requests the server accepted and stored during the soak phase. Each is one
      // HTTP request that committed at least one row (a step, a message or an expression).
      per_second: phaseElapsedMs ? round((messages.length + [...accepted.values()].reduce((sum, list) => sum + list.length, 0)) / (phaseElapsedMs / 1000), 1) : null,
      storage_before_bytes: storageBefore,
      storage_after_bytes: await storageBytes(processState.database),
      stored: { agents: readStored().agents.length, objects: readStored().objects.length, commit_messages: readCanonical().messages.length },
    },
    correctness: {
      subscribers_compared: compared,
      ordering_violations: recorder.failures.filter((line) => line.includes('superseded')).length,
      message_delivery: 'every open subscriber received every stored public message once, in stored order',
      reconnect_divergence: recorder.failures.filter((line) => line.includes('reconciling')).length,
      checks_passed: recorder.passed,
    },
    server_event_counters: 'not exposed: `/operations` builds the hub counters but `diagnostics()` does not include them, so they are read on the client side instead',
    storage_bytes: await storageBytes(processState.database),
    result: recorder.failures.length ? 'FAIL' : 'PASS',
    failures: recorder.failures,
    // Behaviour this run reproduced that contradicts the shipped documentation. Kept apart from
    // `failures`: these are defects in files outside this task's writable set, so the run does not
    // fail on them, but they are measured, not asserted from reading the source.
    defects,
    scope: 'One Node process and one SQLite writer on loopback. Correctness and load of this workload at this client count only; no supported-user, capacity or model claim.',
    not_measured: [
      'model throughput and the model queue (no model is configured, so no model call is made)',
      'real network latency, TLS, a reverse proxy or packet loss',
      'multiple server processes or multiple SQLite writers',
      'memory growth and disk exhaustion over hours',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${report.result}  ${subscriptions} subscribers ${limits.subscriptions_per_account}/account, ${writers} writing avatars, ${limits.phase_ms} ms write phase`);
  console.log(`  frames      ${report.events.frames_total} total, ${report.events.frames_per_client.min}-${report.events.frames_per_client.max} per client, ${report.events.update_entries_total} update entries, ${report.events.heartbeats} heartbeats, ${report.events.wire_duplicate_messages} duplicate messages`);
  console.log(`  latency     frames p50 ${report.events.delivery_latency_ms.p50} ms · p95 ${report.events.delivery_latency_ms.p95} ms · max ${report.events.delivery_latency_ms.max} ms · requests p95 ${report.requests.latency_p95_ms} ms`);
  console.log(`  requests    ${report.requests.attempts} attempts · ${report.requests.accepted} accepted · ${report.requests.throttled} throttled · ${report.requests.refused} refused`);
  console.log(`  writes      ${report.writes.accepted_steps} accepted steps, ${report.writes.public_messages} public messages, ${report.writes.garden_builds} garden builds over ${report.writes.phase_ms} ms = ${report.writes.per_second} row-writing requests/s`);
  console.log('  channel     server-side hub counters are not exposed on /operations; delivery is counted on the client side');
  console.log(`  checks      ${report.correctness.checks_passed} passed, ${report.failures.length} failed`);
  for (const failure of report.failures.slice(0, 12)) console.log(`    FAIL ${failure}`);
  for (const defect of report.defects) console.log(`  DEFECT      ${defect.id}: ${[].concat(defect.evidence).join(' | ')}`);
  if (JSON_PATH) { await writeFile(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`); console.log(`  wrote       ${JSON_PATH}`); }
  if (report.failures.length) process.exitCode = 1;

  function readCanonical() {
    const reader = new DatabaseSync(processState.database, { readOnly: true });
    try {
      return {
        agents: reader.prepare('SELECT id,world_id,x,y FROM agents WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(seeded.writers.map((item) => item.agent_id))),
        // Insert order is publish order: the channel publishes inside the same synchronous handler
        // that inserts the row, so `rowid` is the order every subscriber must reproduce.
        messages: reader.prepare("SELECT id FROM messages WHERE world_id='commons' AND channel='public' AND text LIKE 'Soak %' ORDER BY rowid").all(),
      };
    } finally { reader.close(); }
  }
  function readGarden(worldId) {
    const reader = new DatabaseSync(processState.database, { readOnly: true });
    try { return reader.prepare('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x').all(worldId); } finally { reader.close(); }
  }
  function readAgent(agentId) {
    const reader = new DatabaseSync(processState.database, { readOnly: true });
    try { return reader.prepare('SELECT world_id,x,y FROM agents WHERE id=?').get(agentId); } finally { reader.close(); }
  }
  function readStored() {
    const reader = new DatabaseSync(processState.database, { readOnly: true });
    try {
      return {
        agents: reader.prepare('SELECT id,world_id,x,y FROM agents WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(seeded.writers.map((item) => item.agent_id))),
        objects: reader.prepare('SELECT world_id,type,x,y FROM world_objects ORDER BY world_id,y,x').all(),
      };
    } finally { reader.close(); }
  }
}

async function storageBytes(database) {
  const files = {};
  for (const suffix of ['', '-wal', '-shm']) {
    try { files[suffix || 'main'] = (await stat(`${database}${suffix}`)).size; } catch { files[suffix || 'main'] = null; }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await run();
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    if (processState.output.length) console.error(`recent server output:\n${processState.output.slice(-10).join('\n')}`);
    process.exitCode = 1;
  } finally {
    await stopServer();
    if (processState.workspace && !process.argv.includes('--keep')) await rm(processState.workspace, { recursive: true, force: true });
    if (processState.workspace && existsSync(processState.workspace)) console.log(`temporary workspace: ${processState.workspace}`);
  }
}
