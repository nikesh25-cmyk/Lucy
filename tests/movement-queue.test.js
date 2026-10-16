import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovementQueue } from '../src/movement-queue.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('keeps only the latest pending manual direction and runs it after the first move', async () => {
  const first = deferred();
  const calls = [];
  const queue = createMovementQueue({ move: async direction => { calls.push(direction); if (calls.length === 1) return first.promise; return `${direction}-done`; } });
  const firstResult = queue.enqueue('up');
  const replaced = queue.enqueue('left');
  const latest = queue.enqueue('right');
  assert.equal(queue.inFlight, true);
  assert.equal(queue.pending, true);
  assert.deepEqual(await replaced, { cancelled: true, reason: 'superseded' });
  first.resolve('up-done');
  assert.equal(await firstResult, 'up-done');
  assert.equal(await latest, 'right-done');
  assert.deepEqual(calls, ['up', 'right']);
  assert.equal(queue.inFlight, false);
  assert.equal(queue.pending, false);
});

test('reset cancels pending work and prevents stale completion from replaying it', async () => {
  const first = deferred();
  const calls = [];
  const queue = createMovementQueue({ move: async direction => { calls.push(direction); return first.promise; } });
  const running = queue.enqueue('up');
  const pending = queue.enqueue('down');
  const reset = queue.reset('world-change');
  assert.equal(reset.inFlight, true);
  assert.deepEqual(await pending, { cancelled: true, reason: 'world-change' });
  assert.deepEqual(await running, { cancelled: true, reason: 'world-change' });
  first.resolve('old-world');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['up']);
  assert.equal(queue.pending, false);
});

test('a new-generation move waits for the stale request, then runs after reset', async () => {
  const old = deferred();
  const calls = [];
  const queue = createMovementQueue({ move: async direction => { calls.push(direction); return calls.length === 1 ? old.promise : `${direction}-new`; } });
  const stale = queue.enqueue('up');
  queue.reset('character-change');
  const fresh = queue.enqueue('right');
  assert.deepEqual(await stale, { cancelled: true, reason: 'character-change' });
  assert.deepEqual(calls, ['up']);
  old.resolve('old-result');
  assert.equal(await fresh, 'right-new');
  assert.deepEqual(calls, ['up', 'right']);
});

test('a stale failure does not call onError or cancel the new-generation move', async () => {
  const old = deferred();
  const errors = [];
  const calls = [];
  const queue = createMovementQueue({ move: async direction => { calls.push(direction); return calls.length === 1 ? old.promise : 'fresh-result'; }, onError: error => errors.push(error) });
  const stale = queue.enqueue('left');
  queue.reset('session-change');
  const fresh = queue.enqueue('down');
  const failure = new Error('old session failed');
  old.reject(failure);
  assert.deepEqual(await stale, { cancelled: true, reason: 'session-change' });
  assert.equal(await fresh, 'fresh-result');
  assert.deepEqual(calls, ['left', 'down']);
  assert.deepEqual(errors, []);
});

test('a failed move clears the pending direction and reports the error once', async () => {
  const failure = new Error('blocked');
  const errors = [];
  const first = deferred();
  const calls = [];
  const queue = createMovementQueue({ move: async direction => { calls.push(direction); return first.promise; }, onError: error => errors.push(error) });
  const running = queue.enqueue('left');
  const pending = queue.enqueue('right');
  first.reject(failure);
  await assert.rejects(running, /blocked/);
  assert.deepEqual(await pending, { cancelled: true, reason: 'failure' });
  assert.deepEqual(calls, ['left']);
  assert.deepEqual(errors, [failure]);
  assert.equal(queue.inFlight, false);
  assert.equal(queue.pending, false);
});

test('does not accumulate a backlog and rejects invalid directions', async () => {
  const first = deferred();
  const queue = createMovementQueue({ move: () => first.promise });
  queue.enqueue('up');
  const pending = [];
  for (const direction of ['left', 'down', 'right', 'up', 'left']) pending.push(queue.enqueue(direction));
  assert.equal(queue.pending, true);
  await assert.rejects(queue.enqueue('north'), /Invalid movement direction/);
  for (const promise of pending.slice(0, -1)) assert.deepEqual(await promise, { cancelled: true, reason: 'superseded' });
  queue.reset();
  assert.deepEqual(await pending.at(-1), { cancelled: true, reason: 'reset' });
  first.resolve('done');
});

test('each queued direction keeps the character context from the input event', async () => {
  let finish;
  const calls = [];
  const queue = createMovementQueue({ move: (direction, context) => {
    calls.push({ direction, context });
    if (calls.length === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve('saved');
  }});
  const first = queue.enqueue('up', { actorId: 'human-a', worldId: 'commons' });
  const second = queue.enqueue('right', { actorId: 'human-b', worldId: 'hall' });
  finish('saved');
  assert.equal(await first, 'saved');
  assert.equal(await second, 'saved');
  assert.deepEqual(calls, [
    { direction: 'up', context: { actorId: 'human-a', worldId: 'commons' } },
    { direction: 'right', context: { actorId: 'human-b', worldId: 'hall' } },
  ]);
});

