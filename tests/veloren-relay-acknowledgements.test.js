import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { relayOnce } from '../src/veloren-relay.js';
const events = [1, 2].map(seq => ({ server_id: 'acceptance', seq }));
const good = events.map(e => ({ event_id: `${e.server_id}:${e.seq}`, status: 'accepted' }));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nemo-independent-relay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outbox = join(dir, 'events.jsonl'), offsetFile = join(dir, 'offset');
  writeFileSync(outbox, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(offsetFile, '0\n');
  return { outbox, offsetFile, url: 'http://127.0.0.1:1', token: 'disposable-offline-fixture',
    offset: () => Number(readFileSync(offsetFile, 'utf8')) };
}

const invalid = [
  ['missing results', {}], ['null body', null], ['null results', { results: null }],
  ['empty results', { results: [] }], ['partial results', { results: good.slice(0, 1) }],
  ['duplicate acknowledgement', { results: [good[0], good[0]] }],
  ['wrong event id', { results: [good[0], { ...good[1], event_id: 'other:2' }] }],
  ['unknown status', { results: [good[0], { ...good[1], status: 'queued' }] }],
  ['extra result', { results: [...good, { event_id: 'other:3', status: 'accepted' }] }],
  ['non-object result', { results: [good[0], null] }],
];
for (const [label, body] of invalid) {
  test(`HTTP 200 with ${label} cannot consume saved events`, async t => {
    const f = fixture(t);
    const stats = await relayOnce({ ...f, fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }) });
    assert.equal(f.offset(), 0, 'unacknowledged batch must remain available after restart');
    assert.equal(stats.failed, 1);
    const retry = await relayOnce({ ...f, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: good }) }) });
    assert.equal(retry.accepted, 2);
    assert.equal(f.offset(), readFileSync(f.outbox).length);
  });
}
test('invalid JSON acknowledgement is a retryable failure', async t => {
  const f = fixture(t);
  const result = await relayOnce({ ...f, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw Error('fixture JSON failure'); } }) });
  assert.equal(result.failed, 1); assert.equal(f.offset(), 0);
});
test('complete reordered terminal acknowledgements may advance', async t => {
  const f = fixture(t);
  const result = await relayOnce({ ...f, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [
    { ...good[1], status: 'rejected', reason: 'bad_signature' }, { ...good[0], status: 'duplicate' },
  ] }) }) });
  assert.equal(result.failed, 0); assert.equal(result.rejected, 1); assert.equal(result.duplicate, 1);
  assert.equal(f.offset(), readFileSync(f.outbox).length);
});
test('repeated copies of the same event are acknowledged individually', async t => {
  const f = fixture(t);
  writeFileSync(f.outbox, [events[0], events[0]].map(JSON.stringify).join('\n') + '\n');
  const result = await relayOnce({ ...f, fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ results: [good[0], { ...good[0], status: 'duplicate' }] }) }) });
  assert.equal(result.failed, 0); assert.equal(result.accepted, 1); assert.equal(result.duplicate, 1);
  assert.equal(f.offset(), readFileSync(f.outbox).length);
});
test('a server-rejected JSON event without an id does not poison the queue', async t => {
  const f = fixture(t);
  writeFileSync(f.outbox, 'null\n' + JSON.stringify(events[0]) + '\n');
  const result = await relayOnce({ ...f, fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ results: [{ event_id: null, status: 'rejected', reason: 'malformed' }, good[0]] }) }) });
  assert.equal(result.failed, 0); assert.equal(result.rejected, 1); assert.equal(result.accepted, 1);
  assert.equal(f.offset(), readFileSync(f.outbox).length);
});
test('two resident relays preserve independent cursors and deliver only their own facts', async t => {
  const f = fixture(t);
  const mixed = events.map((e, i) => ({ ...e, resident_id: i ? 'lw-aria' : 'lw-lyra' }));
  writeFileSync(f.outbox, mixed.map(JSON.stringify).join('\n') + '\n');
  for (const resident of ['lw-lyra', 'lw-aria']) {
    const cursor = f.offsetFile + '-' + resident;
    writeFileSync(cursor, '0\n');
    const stats = await relayOnce({ ...f, offsetFile: cursor, resident, fetchImpl: async (_url, options) => {
      const submitted = JSON.parse(options.body).events;
      assert.equal(submitted.length, 1); assert.equal(submitted[0].resident_id, resident);
      return { ok: true, status: 200, json: async () => ({ results: submitted.map(e => ({ event_id: `${e.server_id}:${e.seq}`, status: 'accepted' })) }) };
    } });
    assert.equal(stats.accepted, 1); assert.equal(stats.skipped, 1);
    assert.equal(Number(readFileSync(cursor, 'utf8')), readFileSync(f.outbox).length);
  }
  assert.equal(f.offset(), 0, 'the unrelated cursor remains unchanged');
});
test('a filtered relay cannot advance its cursor past its own unacknowledged fact', async t => {
  const f = fixture(t);
  writeFileSync(f.outbox, events.map((e, i) => JSON.stringify({ ...e, resident_id: i ? 'lw-lyra' : 'lw-aria' })).join('\n') + '\n');
  const stats = await relayOnce({ ...f, resident: 'lw-lyra', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }) });
  assert.equal(stats.failed, 1); assert.equal(f.offset(), 0);
});
