// Small client-side orchestration for entering a world through an existing portal.
// Movement and travel remain injected so the server keeps ownership of both actions.
import { frontierCoordinates, frontierGates } from '../world.js';

export const PORTAL_JOURNEY_REASONS = Object.freeze({
  invalid: 'invalid',
  cancelled: 'cancelled',
  stale: 'stale',
  unreachable: 'unreachable',
  refused: 'refused',
  error: 'error',
  unopened: 'unopened',
  out_of_bounds: 'out_of_bounds',
  limit: 'limit',
});

export const MAX_FRONTIER_ROUTE_SECTORS = 256;

const targetOf = (portal) => portal?.target_world_id || portal?.targetWorldId || '';
const manhattan = (x, y, portal) => Number.isInteger(x) && Number.isInteger(y)
  ? Math.abs(portal.x - x) + Math.abs(portal.y - y) : Infinity;
const aborted = (signal) => Boolean(signal?.aborted);
const cancellationError = (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
const refusedError = (error) => Number.isInteger(error?.status) && [401, 403, 409, 429].includes(error.status);

const result = (ok, reason, extra = {}) => ({ ok, ...(reason ? { reason } : {}), ...extra });

/**
 * Create a portal journey using the app's existing route walker and travel request.
 *
 * `readState` should return the current `{ actor, worldId, sessionId }` snapshot.  The
 * snapshot is checked before walking and again after walking, so a late route completion
 * cannot travel a replacement character or a character that has changed worlds.
 */
export function createPortalJourney({ walkTo, travelAgent, readState, isCancelled } = {}) {
  if (typeof walkTo !== 'function' || typeof travelAgent !== 'function') {
    throw new TypeError('Portal journey requires walkTo and travelAgent functions.');
  }

  return async function journeyToPortal({ portal, actor, sessionId, signal } = {}) {
    const targetWorldId = targetOf(portal);
    if (!portal || !Number.isInteger(portal.x) || !Number.isInteger(portal.y) || !targetWorldId || !actor?.id || !actor?.world_id) {
      return result(false, PORTAL_JOURNEY_REASONS.invalid);
    }
    const expected = { actorId: actor.id, worldId: actor.world_id, sessionId };
    const current = () => {
      const snapshot = typeof readState === 'function' ? readState() : { actor, worldId: actor.world_id, sessionId };
      const currentActor = snapshot?.actor;
      return {
        actorId: currentActor?.id,
        worldId: snapshot?.worldId ?? currentActor?.world_id,
        sessionId: snapshot?.sessionId,
        x: currentActor?.x,
        y: currentActor?.y,
      };
    };
    const isStale = () => {
      if (aborted(signal) || isCancelled?.()) return PORTAL_JOURNEY_REASONS.cancelled;
      const snapshot = current();
      if (snapshot.actorId !== expected.actorId || snapshot.worldId !== expected.worldId ||
          expected.sessionId !== undefined && snapshot.sessionId !== expected.sessionId) return PORTAL_JOURNEY_REASONS.stale;
      return null;
    };

    const before = isStale();
    if (before) return result(false, before, { stage: 'before-walk' });
    const startingPosition = current();
    let walked;
    if (manhattan(startingPosition.x, startingPosition.y, portal) <= 1) {
      walked = true;
    } else {
      try {
        // Existing walkTo(x, y) accepts the first two arguments; the optional third argument
        // gives newer callers a cancellation signal without changing the established contract.
        walked = await walkTo(portal.x, portal.y, { signal, actorId: expected.actorId, worldId: expected.worldId });
      } catch (error) {
        if (aborted(signal) || cancellationError(error) || isCancelled?.()) return result(false, PORTAL_JOURNEY_REASONS.cancelled, { stage: 'walk' });
        return result(false, refusedError(error) ? PORTAL_JOURNEY_REASONS.refused : PORTAL_JOURNEY_REASONS.error, { stage: 'walk', error });
      }
    }
    const afterWalk = isStale();
    if (afterWalk) return result(false, afterWalk, { stage: 'after-walk' });
    if (walked === false || walked?.ok === false) return result(false, PORTAL_JOURNEY_REASONS.unreachable, { stage: 'walk' });

    const arrival = current();
    if (manhattan(arrival.x, arrival.y, portal) > 1) return result(false, PORTAL_JOURNEY_REASONS.unreachable, { stage: 'arrival' });
    const beforeTravel = isStale();
    if (beforeTravel) return result(false, beforeTravel, { stage: 'before-travel' });
    try {
      await travelAgent(targetWorldId);
      return result(true, null, { target_world_id: targetWorldId });
    } catch (error) {
      if (aborted(signal) || cancellationError(error) || isCancelled?.()) return result(false, PORTAL_JOURNEY_REASONS.cancelled, { stage: 'travel' });
      return result(false, refusedError(error) ? PORTAL_JOURNEY_REASONS.refused : PORTAL_JOURNEY_REASONS.error, { stage: 'travel', error });
    }
  };
}

const frontierIdOf = (entry) => {
  if (typeof entry === 'string') return entry;
  if (!entry || entry.opened === false || entry.state === 'unopened' || entry.status === 'unopened') return '';
  return entry.world_id || entry.id || '';
};
const frontierStep = (fromWorldId, toWorldId) => {
  const gate = frontierGates(fromWorldId).find((item) => item.targetWorldId === toWorldId);
  const targetGate = frontierGates(toWorldId).find((item) => item.targetWorldId === fromWorldId);
  if (!gate || !targetGate) return null;
  return {
    from_world_id: fromWorldId,
    to_world_id: toWorldId,
    direction: gate.direction,
    gate: { x: gate.x, y: gate.y },
    target_gate: { x: targetGate.x, y: targetGate.y },
  };
};

/**
 * Find a route through already-opened finite frontier sectors.
 *
 * This is a read-only planner. It never expands a sector, assigns a plot, or writes a
 * block. Directory entries may be strings or records carrying `world_id`/`id`.
 */
export function planFrontierRoute(fromWorldId, toWorldId, openedSectors) {
  const from = frontierCoordinates(fromWorldId), to = frontierCoordinates(toWorldId);
  if (!from || !to) return result(false, PORTAL_JOURNEY_REASONS.out_of_bounds);
  const opened = new Set((Array.isArray(openedSectors) ? openedSectors : []).map(frontierIdOf).filter(Boolean));
  if (opened.size > MAX_FRONTIER_ROUTE_SECTORS) return result(false, PORTAL_JOURNEY_REASONS.limit, { limit: MAX_FRONTIER_ROUTE_SECTORS });
  if (!opened.has(fromWorldId) || !opened.has(toWorldId)) return result(false, PORTAL_JOURNEY_REASONS.unopened);
  if (fromWorldId === toWorldId) return result(true, null, { worlds: [fromWorldId], steps: [] });

  const queue = [fromWorldId], previous = new Map([[fromWorldId, null]]);
  for (let index = 0; index < queue.length && previous.size <= MAX_FRONTIER_ROUTE_SECTORS; index += 1) {
    const current = queue[index];
    for (const gate of frontierGates(current)) {
      const next = gate.targetWorldId;
      if (!opened.has(next) || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
      if (next === toWorldId) break;
    }
    if (previous.has(toWorldId)) break;
  }
  if (!previous.has(toWorldId)) return result(false, PORTAL_JOURNEY_REASONS.unreachable);
  const worlds = [];
  for (let current = toWorldId; current; current = previous.get(current)) worlds.push(current);
  worlds.reverse();
  const steps = [];
  for (let index = 1; index < worlds.length; index += 1) {
    const step = frontierStep(worlds[index - 1], worlds[index]);
    if (!step) return result(false, PORTAL_JOURNEY_REASONS.unreachable);
    steps.push(step);
  }
  return result(true, null, { worlds, steps });
}

