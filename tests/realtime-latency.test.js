import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createApp, EVENT_LIMITS } from '../server.js';
import { fixture } from './helpers.js';

// Measured update latency and frame behaviour for the event channel, on this machine and on a
// loopback fixture. This is a fixture measurement, not a supported-user count: it reports what one
// process, one SQLite writer and this hardware actually did for the concurrency named below.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

function openStream(base, token, worldId) {
  const url = new URL(base);
  const state = { frames: [], buffer: '', received: [] };
  const request = httpRequest({ host: url.hostname, port: Number(url.port), path: `/api/v1/events?world_id=${encodeURIComponent(worldId)}`, method: 'GET', headers: { Host: url.host, Authorization: `Bearer ${token}` } }, (response) => {
    assert.equal(response.statusCode, 200, `the measurement fixture must subscribe (got ${response.statusCode})`);
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      state.buffer += chunk;
      let index;
      while ((index = state.buffer.indexOf('\n\n')) !== -1) {
        const frame = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 2);
        if (!frame.startsWith('event: update')) continue;
        const at = Date.now();
        const body = JSON.parse(frame.split('\ndata: ')[1]);
        state.frames.push(body);
        if (Number.isFinite(body.t)) state.received.push({ sentAt: body.t, at });
      }
    });
  });
  request.end();
  state.close = () => request.destroy();
  return state;
}

test('measured update latency and frame rate on the loopback fixture', async (t) => {
  const f = await fixture(t);
  const app = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.stopEvents();
    await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
  });

  const mover = f.agent('alice', 'Alice walker');
  const worldId = f.platform.get('SELECT world_id FROM agents WHERE id=?', mover.id).world_id;
  // Four accounts at the per-account bound is the concurrency this measurement uses.
  const tokens = [f.credentials.alice.token, f.credentials.bob.token, f.credentials.reviewer.token, f.credentials.moderator.token];
  const streams = [];
  for (const token of tokens) for (let index = 0; index < EVENT_LIMITS.max_connections_per_account; index++) streams.push(openStream(base, token, worldId));
  await sleep(200);
  assert.equal(app.hub.size, streams.length, 'every fixture client must be subscribed');

  const MOVES = 20;
  const started = Date.now();
  for (let index = 0; index < MOVES; index++) {
    f.advance(200);
    const direction = ['up', 'down', 'left', 'right'][index % 4];
    const before = f.platform.get('SELECT x,y FROM agents WHERE id=?', mover.id);
    const response = await fetch(`${base}/api/v1/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credentials.alice.token}` }, body: JSON.stringify({ agent_id: mover.id, direction }) });
    assert.equal(response.status, 200);
    if (f.platform.get('SELECT x FROM agents WHERE id=?', mover.id).x === before.x && f.platform.get('SELECT y FROM agents WHERE id=?', mover.id).y === before.y) index -= 1;
    await sleep(70);
  }
  await sleep(200);
  const elapsedMs = Date.now() - started;

  const latencies = streams.flatMap((stream) => stream.received.map((frame) => frame.at - frame.sentAt));
  const perClientFrames = streams.map((stream) => stream.frames.length);
  const summary = {
    connections: streams.length, moves: MOVES, elapsed_ms: elapsedMs,
    frames_total: perClientFrames.reduce((sum, count) => sum + count, 0),
    frames_per_client: { min: Math.min(...perClientFrames), max: Math.max(...perClientFrames) },
    frames_per_client_per_second: Number((perClientFrames.reduce((sum, count) => sum + count, 0) / streams.length / (elapsedMs / 1000)).toFixed(2)),
    latency_ms: { min: Math.min(...latencies), median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
    limits: { frames_per_second: EVENT_LIMITS.frames_per_second, max_connections: EVENT_LIMITS.max_connections },
  };
  console.log(`    measured: ${JSON.stringify(summary)}`);

  assert.ok(perClientFrames.every((count) => count >= 1), 'every subscriber must receive at least one frame');
  assert.ok(summary.frames_per_client_per_second <= EVENT_LIMITS.frames_per_second + 1, 'no client may exceed the documented frame rate');
  assert.ok(summary.latency_ms.p95 <= 500, `the p95 delivery latency must stay inside half a second on loopback (was ${summary.latency_ms.p95} ms)`);
  assert.ok(summary.latency_ms.median <= 150, `the median delivery latency must stay inside 150 ms on loopback (was ${summary.latency_ms.median} ms)`);
  for (const stream of streams) stream.close();
});
