// Serialize resident movement requests without building an unbounded input backlog.
// The caller owns world/session changes and must call reset() when that identity changes.

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

/**
 * Create a one-step movement queue.
 *
 * While a move is in flight, one latest direction is retained. A newer manual request replaces
 * that pending direction. A failed move clears the pending request, so a refusal or network error
 * can never replay an input against a changed world. reset() invalidates the current generation,
 * resolves queued callers as cancelled, and prevents the in-flight completion from starting work.
 */
export function createMovementQueue({ move, onError = () => {} } = {}) {
  if (typeof move !== 'function') throw new TypeError('createMovementQueue needs a move function.');
  if (typeof onError !== 'function') throw new TypeError('createMovementQueue needs an onError function.');

  let inFlight = null;
  let pending = null;
  let generation = 0;

  const cancelled = (reason) => ({ cancelled: true, reason });

  function settlePending(result) {
    const item = pending;
    pending = null;
    item?.resolve(result);
  }

  async function run(item, token) {
    inFlight = item;
    try {
      const result = await move(item.direction, item.context);
      // A reset during the request owns the remainder of this turn. Do not start a stale pending
      // direction in the old generation. A new-generation pending direction is safe to start now,
      // once the old server request has settled.
      if (token !== generation) {
        const next = pending;
        pending = null;
        if (next) void run(next, generation);
        return;
      }
      item.resolve(result);
      const next = pending;
      pending = null;
      if (next) void run(next, token);
    } catch (error) {
      // Reset owns stale failures too: do not surface an old-world error through the new session.
      // The replacement request, if any, starts only after this old request has settled.
      if (token !== generation) {
        const next = pending;
        pending = null;
        if (next) void run(next, generation);
        return;
      }
      item.reject(error);
      // A failure invalidates the pending direction as well. The caller can explicitly enqueue a
      // fresh action after presenting or handling the refusal.
      settlePending(cancelled('failure'));
      try { onError(error, item.direction); } catch { /* diagnostics must not break the queue */ }
    } finally {
      if (inFlight === item) inFlight = null;
    }
  }

  function enqueue(direction, context) {
    if (!DIRECTIONS.has(direction)) return Promise.reject(new TypeError('Invalid movement direction.'));
    const item = {};
    const promise = new Promise((resolve, reject) => Object.assign(item, { direction, context, resolve, reject }));
    if (inFlight) {
      if (pending) pending.resolve(cancelled('superseded'));
      pending = item;
    } else {
      void run(item, generation);
    }
    return promise;
  }

  function reset(reason = 'reset') {
    generation += 1;
    if (inFlight) {
      // Resolve the old caller immediately. The request itself cannot be aborted here, but its
      // eventual completion is ignored by the stale-generation branches above.
      inFlight.resolve(cancelled(reason));
    }
    settlePending(cancelled(reason));
    return { generation, inFlight: Boolean(inFlight), pending: false };
  }

  return Object.freeze({
    enqueue,
    reset,
    get inFlight() { return Boolean(inFlight); },
    get pending() { return Boolean(pending); },
    get generation() { return generation; },
  });
}

