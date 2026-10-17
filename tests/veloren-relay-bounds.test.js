import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { relayOnce } from '../src/veloren-relay.js';
function setup(t, text) {
  const root = mkdtempSync(join(tmpdir(), 'nemo-relay-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outbox = join(root, 'outbox'), offsetFile = join(root, 'offset');
  writeFileSync(outbox, text); writeFileSync(offsetFile, '0');
  return { outbox, offsetFile, url: 'http://127.0.0.1:1', token: 'fixture-only' };
}
const line = seq => JSON.stringify({ server_id: 'bounded', seq, resident_id: 'lw-lyra', padding: 'x'.repeat(100) }) + '\n';
test('a backlog does not allocate its whole unread tail before sending the first batch', async t => {
  const f = setup(t, Array.from({ length: 8000 }, (_, i) => line(i + 1)).join(''));
  let peak = 0; const allocate = Buffer.alloc;
  Buffer.alloc = function(size, ...rest) { peak = Math.max(peak, size); return allocate(size, ...rest); };
  try {
    const stats = await relayOnce({ ...f, fetchImpl: async () => ({ ok: false, status: 503 }) });
    assert.equal(stats.failed, 1); assert.equal(Number(readFileSync(f.offsetFile)), 0);
  } finally { Buffer.alloc = allocate; }
  assert.ok(peak <= 64 * 1024, `largest relay buffer was ${peak} bytes; expected at most 65536`);
});
test('many bounded reads preserve every id and consume exactly the complete lines', async t => {
  const text = Array.from({ length: 500 }, (_, i) => line(i + 1)).join('');
  const f = setup(t, text + '{"partial":'); const received = [];
  const stats = await relayOnce({ ...f, fetchImpl: async (_url, options) => {
    const events = JSON.parse(options.body).events; assert.ok(events.length <= 20);
    received.push(...events.map(e => e.seq));
    return { ok: true, status: 200, json: async () => ({ results: events.map(e => ({ event_id: `bounded:${e.seq}`, status: 'accepted' })) }) };
  } });
  assert.equal(stats.accepted, 500); assert.equal(stats.failed, 0);
  assert.deepEqual(received, Array.from({ length: 500 }, (_, i) => i + 1));
  assert.equal(Number(readFileSync(f.offsetFile)), Buffer.byteLength(text));
});
test('an oversized unbroken record is reported without consuming it or allocating its full size', async t => {
  const f = setup(t, 'x'.repeat(200_000)); const logs = [];
  const stats = await relayOnce({ ...f, fetchImpl: async () => { throw Error('must not send an incomplete record'); }, log: m => logs.push(m) });
  assert.equal(stats.failed, 1); assert.equal(Number(readFileSync(f.offsetFile)), 0);
  assert.ok(logs.some(m => /exceeds.*65536|oversized/i.test(m)));
});
