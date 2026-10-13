#!/usr/bin/env node
/**
 * Bounded, disposable multiplayer convergence probe.
 *
 * Two real account credentials write through the shipped HTTP server while two Server-Sent Events
 * clients observe one public garden. One observer disconnects during saved writes, reconciles from
 * `/world`, and both observers reconcile again after a full server-process restart. This is a
 * correctness probe for one Node/SQLite process on loopback, not a user-capacity or model benchmark.
 *
 * Run: node scripts/multiplayer-soak.mjs
 * No database or workspace path is accepted. The only database is created beneath the OS temp
 * directory and is removed even when the probe fails. An inherited LUCY_DATABASE is refused.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Platform } from '../src/platform.js';
import { getWorldDefinition, walkable } from '../world.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_MS = 30_000;
const state = { workspace: null, database: null, port: null, child: null, streams: new Set(), output: [], deadline: 0 };
const metrics = { requests: [], streams_opened: 0, streams_reconnected: 0, update_frames: 0, frame_latency_ms: [], checks: 0 };
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function remaining() {
  const left = state.deadline - Date.now();
  if (left <= 0) throw new Error(`The ${MAX_MS} ms probe deadline was reached.`);
  return left;
}
function check(condition, message) { assert.ok(condition, message); metrics.checks += 1; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); metrics.checks += 1; }

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

async function seed() {
  const platform = new Platform(state.database);
  try {
    const password = 'temporary-multiplayer-probe-password';
    const alice = await platform.register({ name: 'Probe Alice', email: 'alice@multiplayer-probe.test', password, consent: true });
    const bob = await platform.register({ name: 'Probe Bob', email: 'bob@multiplayer-probe.test', password, consent: true });
    const avatar = (credential, name) => platform.transaction(() => platform.createAgent(platform.authenticate(credential.token), { kind: 'human', name }));
    const a = avatar(alice, 'Alice probe avatar'), b = avatar(bob, 'Bob probe avatar');
    const world = `home:${a.id}`;
    const definition = getWorldDefinition(world);
    for (const [x, y] of [[15, 11], [18, 11], [17, 4], [18, 4]]) check(walkable({ x, y }, definition), `fixture tile ${x},${y} must be walkable`);
    platform.transaction(() => {
      platform.run('UPDATE agents SET world_id=?,x=15,y=11,z=0,grounded=1,last_move=0 WHERE id=?', world, a.id);
      platform.run('UPDATE agents SET world_id=?,x=18,y=11,z=0,grounded=1,last_move=0 WHERE id=?', world, b.id);
    });
    return { world, alice: { id: a.id, token: alice.token }, bob: { id: b.id, token: bob.token } };
  } finally { platform.close(); }
}

async function startServer() {
  const env = { ...process.env, PORT: String(state.port), LUCY_DATABASE: state.database, LUCY_BIND_HOST: '127.0.0.1' };
  for (const name of ['LUCY_PUBLIC_ORIGIN', 'RENDER_EXTERNAL_URL', 'LUCY_SETUP_CODE', 'LUCY_MODEL_URL', 'LUCY_MODEL_NAME', 'LUCY_LOCAL_PORT_FALLBACK']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  const collect = (chunk) => { state.output.push(chunk.toString('utf8').trim()); if (state.output.length > 12) state.output.shift(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  while (remaining() > 0) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}: ${state.output.join('\n')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/api/v1/health`, { signal: AbortSignal.timeout(Math.min(800, remaining())) });
      if (response.ok) return;
    } catch { /* Startup has not bound the port yet. */ }
    await sleep(80);
  }
}

async function stopServer() {
  for (const stream of state.streams) stream.close();
  state.streams.clear();
  const child = state.child;
  state.child = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), sleep(1500).then(() => false)]);
  if (!graceful) { child.kill('SIGKILL'); await Promise.race([exited, sleep(500)]); }
}

async function api(actor, method, path, body, status = 200) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${state.port}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.min(5000, remaining())),
  });
  const data = await response.json();
  metrics.requests.push({ method, path: path.replace(/\/agents\/[^/]+/, '/agents/:id'), status: response.status, ms: performance.now() - started });
  equal(response.status, status, `${method} ${path} must return HTTP ${status}: ${JSON.stringify(data)}`);
  return data;
}

function subscribe(actor, world) {
  const stream = { actor: actor.id, status: null, frames: [], buffer: '', error: null, ended: false, request: null, response: null };
  const path = `/api/v1/events?world_id=${encodeURIComponent(world)}`;
  const request = httpRequest({ host: '127.0.0.1', port: state.port, path, method: 'GET', headers: { Authorization: `Bearer ${actor.token}` } }, (response) => {
    stream.status = response.statusCode;
    stream.response = response;
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      stream.buffer += chunk;
      let boundary;
      while ((boundary = stream.buffer.indexOf('\n\n')) !== -1) {
        const raw = stream.buffer.slice(0, boundary);
        stream.buffer = stream.buffer.slice(boundary + 2);
        let event = '', data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!event) continue;
        try {
          const value = data ? JSON.parse(data) : null;
          stream.frames.push({ event, data: value });
          if (event === 'update') {
            metrics.update_frames += 1;
            if (Number.isFinite(value?.t)) metrics.frame_latency_ms.push(Math.max(0, Date.now() - value.t));
          }
        } catch (error) { stream.error = error; }
      }
    });
    response.on('end', () => { stream.ended = true; });
    response.on('error', (error) => { stream.error = error; stream.ended = true; });
  });
  request.on('error', (error) => { if (!stream.ended) stream.error = error; stream.ended = true; });
  request.end();
  stream.request = request;
  stream.close = () => { stream.ended = true; request.destroy(); stream.response?.destroy(); state.streams.delete(stream); };
  state.streams.add(stream);
  metrics.streams_opened += 1;
  return stream;
}

async function waitFor(stream, predicate, label) {
  const until = Date.now() + Math.min(2500, remaining());
  while (Date.now() < until) {
    if (stream.error) throw new Error(`${label}: ${stream.error.message}`);
    const found = stream.frames.find(predicate);
    if (found) { metrics.checks += 1; return found; }
    if (stream.ended) throw new Error(`${label}: event stream ended before delivery`);
    await sleep(20);
  }
  throw new Error(`${label}: no matching event frame within 2.5 seconds`);
}
const update = (stream, predicate, label) => waitFor(stream, (frame) => frame.event === 'update' && predicate(frame.data), label);

function stored(db, fixture) {
  const positions = db.prepare('SELECT id,world_id,x,y FROM agents WHERE id IN (?,?) ORDER BY id').all(fixture.alice.id, fixture.bob.id);
  const objects = db.prepare('SELECT type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x').all(fixture.world);
  const messages = db.prepare("SELECT id,agent_id,channel,text FROM messages WHERE world_id=? AND text LIKE 'Probe:%' ORDER BY id").all(fixture.world);
  return { positions, objects, messages };
}

async function reconcile(db, fixture, label) {
  const canonical = stored(db, fixture);
  equal(canonical.positions.length, 2, `${label}: both avatars must remain saved`);
  for (const actor of [fixture.alice, fixture.bob]) {
    const view = await api(actor, 'GET', `/world?world_id=${encodeURIComponent(fixture.world)}&agent_id=${actor.id}`);
    const shown = canonical.positions.map((position) => {
      const participant = view.participants.find((item) => item.id === position.id);
      return participant ? { id: participant.id, world_id: participant.world_id, x: participant.x, y: participant.y } : null;
    });
    equal(shown, canonical.positions.map((position) => ({ ...position })), `${label}: ${actor.id} must see both saved avatar tiles`);
    for (const object of canonical.objects) check(view.objects.some((item) => item.x === object.x && item.y === object.y && item.type === object.type), `${label}: ${actor.id} must see saved ${object.type} at ${object.x},${object.y}`);
    for (const message of canonical.messages) check(view.messages.some((item) => item.id === message.id && item.text === message.text && item.channel === 'public'), `${label}: ${actor.id} must see saved public message ${message.id}`);
  }
  return canonical;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(1));
}

async function run() {
  if (process.argv.length !== 2) throw new Error('No external path or option is accepted; this probe always creates a disposable database.');
  if (process.env.LUCY_DATABASE) throw new Error('Refusing inherited LUCY_DATABASE; unset it before this disposable probe.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NemoWorld requires Node 24 or newer.');
  state.deadline = Date.now() + MAX_MS;
  state.workspace = await mkdtemp(join(tmpdir(), 'nemoworld-multiplayer-'));
  state.database = join(state.workspace, 'probe.sqlite');
  check(resolve(dirname(state.database)) === resolve(state.workspace) && !existsSync(state.database), 'probe database must be new and inside its temporary workspace');
  state.port = await freePort();
  const fixture = await seed();
  await startServer();
  const db = new DatabaseSync(state.database, { readOnly: true });
  try {
    const aliceStream = subscribe(fixture.alice, fixture.world);
    let bobStream = subscribe(fixture.bob, fixture.world);
    await Promise.all([waitFor(aliceStream, (frame) => frame.event === 'ready', 'Alice ready'), waitFor(bobStream, (frame) => frame.event === 'ready', 'Bob ready')]);
    equal([aliceStream.status, bobStream.status], [200, 200], 'both event subscriptions must be admitted');

    // Different operators write concurrently. Every accepted effect must reach both live clients.
    const [moveA, hello] = await Promise.all([
      api(fixture.alice, 'POST', '/move', { agent_id: fixture.alice.id, direction: 'right' }),
      api(fixture.bob, 'POST', '/messages', { agent_id: fixture.bob.id, channel: 'public', text: 'Probe: Bob is here.' }),
    ]);
    equal([moveA.x, moveA.y, moveA.blocked], [16, 11, false], 'Alice must move one legal tile');
    check(db.prepare('SELECT id FROM messages WHERE id=?').get(hello.id), 'Bob’s message must be saved');
    for (const stream of [aliceStream, bobStream]) {
      await update(stream, (frame) => frame.agents?.some((item) => item.id === fixture.alice.id && item.x === 16 && item.y === 11), `${stream.actor} observes Alice move`);
      await update(stream, (frame) => frame.messages?.some((item) => item.id === hello.id), `${stream.actor} observes Bob chat`);
    }
    await api(fixture.alice, 'POST', `/agents/${fixture.alice.id}/build`, { type: 'flowers', x: 17, y: 4 }, 201);
    check(db.prepare('SELECT type FROM world_objects WHERE world_id=? AND x=17 AND y=4').get(fixture.world)?.type === 'flowers', 'first build must be saved');
    for (const stream of [aliceStream, bobStream]) await update(stream, (frame) => frame.objects?.some((item) => item.x === 17 && item.y === 4 && item.type === 'flowers'), `${stream.actor} observes first build`);

    // Bob misses these deltas. Reconnect must fetch canonical state; SSE is not a replay log.
    bobStream.close();
    await sleep(180);
    const [moveB, second, reply] = await Promise.all([
      api(fixture.bob, 'POST', '/move', { agent_id: fixture.bob.id, direction: 'left' }),
      api(fixture.alice, 'POST', `/agents/${fixture.alice.id}/build`, { type: 'flowers', x: 18, y: 4 }, 201),
      api(fixture.alice, 'POST', '/messages', { agent_id: fixture.alice.id, channel: 'public', text: 'Probe: the second flower is planted.' }),
    ]);
    equal([moveB.x, moveB.y, moveB.blocked], [17, 11, false], 'Bob must move one legal tile while unsubscribed');
    check(db.prepare('SELECT type FROM world_objects WHERE world_id=? AND x=18 AND y=4').get(fixture.world)?.type === 'flowers', 'second build must be saved');
    check(db.prepare('SELECT id FROM messages WHERE id=?').get(reply.id), 'Alice’s reply must be saved');
    await update(aliceStream, (frame) => frame.objects?.some((item) => item.x === 18 && item.y === 4 && item.type === 'flowers'), 'Alice observes second build');
    await update(aliceStream, (frame) => frame.messages?.some((item) => item.id === reply.id), 'Alice observes saved reply');
    await update(aliceStream, (frame) => frame.agents?.some((item) => item.id === fixture.bob.id && item.x === 17 && item.y === 11), 'Alice observes Bob move');

    bobStream = subscribe(fixture.bob, fixture.world);
    metrics.streams_reconnected += 1;
    await waitFor(bobStream, (frame) => frame.event === 'ready', 'Bob reconnect ready');
    equal(bobStream.status, 200, 'Bob’s reconnect must be admitted');
    const beforeRestart = await reconcile(db, fixture, 'after reconnect');
    equal(beforeRestart.objects.length, 2, 'both placed objects must be stored');
    equal(beforeRestart.messages.length, 2, 'both public messages must be stored');
    await sleep(180);
    const back = await api(fixture.alice, 'POST', '/move', { agent_id: fixture.alice.id, direction: 'left' });
    equal([back.x, back.y], [15, 11], 'Alice must move after Bob resubscribes');
    await update(bobStream, (frame) => frame.agents?.some((item) => item.id === fixture.alice.id && item.x === 15 && item.y === 11), 'Bob receives a live post-reconnect move');
    const exactBefore = stored(db, fixture);

    await stopServer();
    await startServer();
    equal(stored(db, fixture), exactBefore, 'a full process restart must preserve positions, builds, and messages');
    const restartedAlice = subscribe(fixture.alice, fixture.world), restartedBob = subscribe(fixture.bob, fixture.world);
    await Promise.all([waitFor(restartedAlice, (frame) => frame.event === 'ready', 'restarted Alice ready'), waitFor(restartedBob, (frame) => frame.event === 'ready', 'restarted Bob ready')]);
    await reconcile(db, fixture, 'after process restart');
    await sleep(180);
    const returned = await api(fixture.bob, 'POST', '/move', { agent_id: fixture.bob.id, direction: 'right' });
    equal([returned.x, returned.y], [18, 11], 'Bob must move after restart');
    await update(restartedAlice, (frame) => frame.agents?.some((item) => item.id === fixture.bob.id && item.x === 18 && item.y === 11), 'Alice receives a live post-restart move');
    await reconcile(db, fixture, 'final');

    const report = {
      result: 'PASS', failures: 0, elapsed_ms: MAX_MS - remaining(), checks: metrics.checks,
      workload: 'two operator credentials, two SSE observers, two builds, two public messages, four moves, one reconnect, one server restart',
      requests: { attempts: metrics.requests.length, statuses: Object.fromEntries([...new Set(metrics.requests.map((item) => item.status))].map((code) => [code, metrics.requests.filter((item) => item.status === code).length])), p50_ms: percentile(metrics.requests.map((item) => item.ms), 0.5), p95_ms: percentile(metrics.requests.map((item) => item.ms), 0.95) },
      events: { streams_opened: metrics.streams_opened, streams_reconnected: metrics.streams_reconnected, update_frames: metrics.update_frames, frame_latency_p50_ms: percentile(metrics.frame_latency_ms, 0.5), frame_latency_p95_ms: percentile(metrics.frame_latency_ms, 0.95) },
      stored: { avatars: 2, objects: 2, messages: 2 },
      scope: 'loopback correctness only; no model inference, network capacity, or production capacity measured',
    };
    console.log(JSON.stringify(report, null, 2));
  } finally { db.close(); }
}

try { await run(); }
catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', failures: 1, checks: metrics.checks, requests_completed: metrics.requests.length, error: error.message }, null, 2));
  console.error(error.stack || error.message);
  if (state.output.length) console.error(`Recent server output:\n${state.output.join('\n')}`);
  process.exitCode = 1;
} finally {
  await stopServer();
  if (state.workspace) await rm(state.workspace, { recursive: true, force: true });
  if (state.workspace) console.log(`temporary workspace removed: ${!existsSync(state.workspace)}`);
}
