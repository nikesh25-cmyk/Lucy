// Public observation mode — a dedicated spectator component.
//
// A visitor watches a public world with no account, no resident and no write of any kind. This module
// can only read the routes the server already answers without a session (`publicRoute` in `server.js`)
// and every intent that would change the world is refused before a request is made. The server stays
// the authority for every rule here: a private world, a missing world or a withdrawn permission is
// reported with the server's own sentence, never a blank screen, and the view model is built only from
// the public fields of `GET /world` and `GET /worlds`, so a private conversation or a resident memory
// fact has no path into anything this component renders or keeps.
//
// Two deliberate design points for the integration owner (task 38):
//
// 1. **Camera duplication.** `spectatorStep` and `spectatorFacingLabel` are copies of
//    `cameraWalkDirection` and `facingLabel` in `src/camera-controls.js`. That file is owned by a
//    parallel task, so this module neither edits nor imports it. Dedupe by injecting the real helpers
//    through `createSpectatorView({ camera: { step, facingLabel } })` when the branches meet — the
//    injected pair replaces both copies and nothing else changes.
// 2. **The live feed needs a session.** `GET /api/v1/events` (task 16) authenticates and refuses an
//    anonymous caller with 401, so a visitor with no account cannot hold the Server-Sent Events
//    channel. Observation therefore degrades honestly: without an injected `subscribe` the component
//    reports `from-snapshot` and keeps re-reading the public world; with one it reports `connected`
//    and, when the stream drops, `reconnecting` until it recovers from an authoritative snapshot. A
//    public anonymous feed would be a new server behaviour and is deliberately NOT added here.

/** The three honest connection states the status line may show. */
export const SPECTATOR_STATUS = Object.freeze({
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  SNAPSHOT: 'from-snapshot',
});

// The exact reads an observer may make. Every entry is a `GET` the server already answers without a
// session; anything outside this list is refused by the transport before a request could leave the
// browser. `/memory`, `/journey`, `/drafts`, `/export`, `/me` and the private conversation routes are
// absent on purpose: the observation view has no way to ask for them.
export const SPECTATOR_READS = Object.freeze(['/worlds', '/world']);

// The server window `GET /world` returns, used only to centre the camera on the world it sent.
export const SPECTATOR_VIEWPORT = Object.freeze({ columns: 20, rows: 14 });

/** The one refusal an observer meets when it asks for anything that would change the world. */
export const SPECTATOR_WRITE_RULE = Object.freeze({
  rule: 'observers_are_readers',
  message: 'Observing is read-only. A visitor cannot build, move a resident, speak as anyone or change a world.',
  hint: 'Only the signed-in operator who owns a resident can change the world.',
  next_step: 'To play, sign in and choose Play. Observing stays open without an account.',
});

const CARDINALS = Object.freeze(['up', 'down', 'left', 'right']);
const PUBLIC_WORLD_FIELDS = Object.freeze(['id', 'name', 'kind', 'visibility', 'agent_count']);
const PUBLIC_RESIDENT_FIELDS = Object.freeze(['id', 'name', 'kind', 'x', 'y', 'z', 'grounded', 'yaw', 'pitch', 'posture', 'presence', 'emote', 'emote_until', 'calling', 'title', 'avatar']);
const PUBLIC_MESSAGE_FIELDS = Object.freeze(['id', 'author', 'text', 'created_at', 'world_id', 'channel']);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const pick = (source, fields) => {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field];
  return out;
};

/** A refusal that names its rule and the next usable step, in the shape `docs/API.md` guarantees. */
export function spectatorRefusal(rule, message, extra = {}) {
  return { ok: false, refused: true, rule, message, hint: extra.hint || '', next_step: extra.next_step || '' };
}

/**
 * Turn a refused read into a visible refusal. The server's own sentence is kept as the message, so the
 * interface shows the rule that actually stopped it instead of a generic failure.
 */
export function spectatorRefusalFor(error) {
  const status = error?.status;
  const message = typeof error?.message === 'string' && error.message ? error.message : 'That public place could not be read.';
  if (status === 403) return spectatorRefusal('world_is_private', message, { hint: 'A private garden is readable only by its operator and its own resident.', next_step: 'Choose a public place from the world list.' });
  if (status === 404) return spectatorRefusal('world_not_found', message, { hint: 'The world identifier did not match any world.', next_step: 'Choose a public place from the world list.' });
  if (status === 401) return spectatorRefusal('read_needs_sign_in', message, { hint: 'This read needs an operator session.', next_step: 'Sign in to read it, or keep observing the public world.' });
  if (status === 429) return spectatorRefusal('read_throttled', message, { hint: 'The server asked the client to slow down.', next_step: 'Wait briefly; observing resumes on its own.' });
  return spectatorRefusal('read_failed', message, { hint: 'The read did not complete.', next_step: 'Try again; the last confirmed view stays on screen.' });
}

/** Wrap an angle into the renderer's [-π, π] facing range. */
export function wrapFacing(value) {
  const angle = finite(value, 0);
  return angle >= -Math.PI && angle <= Math.PI ? angle : ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

// Deliberate copy of `cameraWalkDirection` in `src/camera-controls.js` (see the header note). The
// renderer's forward vector on the ground is (-sin(yaw), -cos(yaw)).
export function spectatorStep(direction, yaw) {
  if (!CARDINALS.includes(direction) || !Number.isFinite(yaw)) throw new TypeError('Use a cardinal direction and a finite camera yaw.');
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const vectors = { up: [-sin, -cos], down: [sin, cos], right: [cos, -sin], left: [-cos, sin] };
  const [x, y] = vectors[direction];
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
}

// Deliberate copy of `facingLabel` in `src/camera-controls.js` (see the header note).
export function spectatorFacingLabel(yaw) {
  const points = ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east'];
  const index = Math.round(finite(yaw, 0) / (Math.PI / 4)) % 8;
  return points[(index + 8) % 8];
}

/**
 * A read-only transport: it can only issue the allow-listed `GET`s. There is no `post`, `put` or
 * `delete` here and no way to reach one, so the component cannot write even by mistake. Every read it
 * performs is recorded, which is what the tests audit.
 */
export function createReadonlyTransport({ fetch: fetcher, base = '/api/v1', allow = SPECTATOR_READS, credentials = 'same-origin' } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('A read-only transport needs a fetch function.');
  const allowed = new Set(allow);
  const reads = [];
  return {
    reads,
    async get(path, params = {}) {
      const route = String(path).split('?')[0];
      if (!allowed.has(route)) throw Object.assign(new Error(`The observation view may not read ${route}.`), { status: 403, rule: 'read_not_allowed' });
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) query.set(key, String(value));
      const suffix = query.toString();
      reads.push({ method: 'GET', path: route, at: Date.now() });
      const response = await fetcher(`${base}${route}${suffix ? `?${suffix}` : ''}`, { method: 'GET', credentials, headers: { Accept: 'application/json' } });
      const content = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(content?.error || `Request failed (${response.status}).`), { status: response.status, body: content });
      return content;
    },
  };
}

/**
 * The spectator camera. It never issues a request: panning moves the observer's own viewpoint inside
 * the world's bounds, turning stores a facing, and following targets one visible resident's confirmed
 * tile. A pan or a turn ends the follow — the camera has one target owner.
 */
export function createSpectatorCamera(initial = {}) {
  const start = initial.position || {};
  const math = initial.math || { step: spectatorStep, facingLabel: spectatorFacingLabel };
  let state = {
    x: Math.floor(finite(start.x, 0)), y: Math.floor(finite(start.y, 0)), z: finite(start.z, 0),
    yaw: wrapFacing(initial.yaw), pitch: clamp(finite(initial.pitch, 0), -1.4, 1.4),
    distance: clamp(finite(initial.distance, 17), 6, 32), mode: initial.mode === 'first-person' ? 'first-person' : 'orbit',
  };
  let bounds = { columns: Infinity, rows: Infinity };
  let follow = null;
  const stay = (x, y) => ({ x: clamp(x, 0, Math.max(0, bounds.columns - 1)), y: clamp(y, 0, Math.max(0, bounds.rows - 1)) });
  return {
    setBounds(value = {}) {
      bounds = { columns: finite(value.columns ?? value.width, Infinity), rows: finite(value.rows ?? value.height, Infinity) };
      state = { ...state, ...stay(state.x, state.y) };
      return this.view();
    },
    view() { return { ...state, follow: follow ? follow.id : null }; },
    /** The tile the camera is actually looking at: the followed resident's, or the observer's own. */
    target() { return follow ? { x: follow.x, y: follow.y, z: follow.z } : { x: state.x, y: state.y, z: state.z }; },
    place(position = {}, facing = {}) {
      const tile = stay(Math.floor(finite(position.x, state.x)), Math.floor(finite(position.y, state.y)));
      state = { ...state, x: tile.x, y: tile.y, z: finite(position.z, state.z), yaw: wrapFacing(facing.yaw ?? state.yaw), pitch: clamp(finite(facing.pitch, state.pitch), -1.4, 1.4) };
      return this.view();
    },
    /** One tile of observer movement. In first person the step is view-relative, exactly as walking is. */
    pan(direction) {
      const step = state.mode === 'first-person' ? math.step(direction, state.yaw) : direction;
      if (!CARDINALS.includes(step)) throw new TypeError('Use a cardinal direction to pan the observer view.');
      const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[step];
      const tile = stay(state.x + delta[0], state.y + delta[1]);
      follow = null;
      state = { ...state, x: tile.x, y: tile.y };
      return this.view();
    },
    turn({ yaw = 0, pitch = 0 } = {}) {
      follow = null;
      state = { ...state, yaw: wrapFacing(state.yaw + finite(yaw, 0)), pitch: clamp(state.pitch + finite(pitch, 0), -1.4, 1.4) };
      return this.view();
    },
    setMode(value) { state = { ...state, mode: value === 'first-person' ? 'first-person' : 'orbit' }; return this.view(); },
    zoom(delta = 0) { state = { ...state, distance: clamp(state.distance + finite(delta, 0), 6, 32) }; return this.view(); },
    /** Follow a resident the view can actually see, at its last server-confirmed tile. */
    followResident(resident) {
      follow = { id: resident.id, x: Math.floor(finite(resident.x, 0)), y: Math.floor(finite(resident.y, 0)), z: finite(resident.z, 0) };
      return this.view();
    },
    /** Track the followed resident from a confirmed frame. A different id is ignored. */
    moveResident(id, tile) {
      if (!follow || follow.id !== id) return false;
      follow = { id, x: Math.floor(finite(tile?.x, follow.x)), y: Math.floor(finite(tile?.y, follow.y)), z: finite(tile?.z, follow.z) };
      return true;
    },
    unfollow() { follow = null; return this.view(); },
    following() { return follow ? follow.id : null; },
  };
}

/**
 * The observation view. `read(path, params)` is a read-only transport (see `createReadonlyTransport`);
 * `subscribe(worldId, handlers)` is optional and injects the task-16 SSE channel, which needs a session.
 * `cameraMath` may replace the duplicated camera helpers; `camera` may replace the camera itself.
 */
export function createSpectatorView(options = {}) {
  const read = options.read;
  if (typeof read !== 'function') throw new TypeError('A spectator view needs a read function.');
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const math = options.cameraMath || { step: spectatorStep, facingLabel: spectatorFacingLabel };
  const camera = options.camera || createSpectatorCamera({ ...options.cameraStart, math: options.cameraMath });
  const subscribe = typeof options.subscribe === 'function' ? options.subscribe : null;

  let worldId = typeof options.world === 'string' && options.world ? options.world : 'commons';
  let snapshot = null;
  let live = null;
  let liveGeneration = 0;
  let lastRefusal = null;
  let frames = 0;
  let streams = 0;
  let status = {
    state: subscribe ? SPECTATOR_STATUS.RECONNECTING : SPECTATOR_STATUS.SNAPSHOT,
    world: worldId, at: now(), live: false, reason: 'not_open_yet',
    detail: subscribe ? 'Opening the live feed.' : 'No live feed without a session; showing the last public snapshot.',
  };
  const setStatus = (state, reason, detail) => {
    status = { state, world: worldId, at: now(), live: state === SPECTATOR_STATUS.CONNECTED, reason: reason || null, detail };
    return status;
  };
  const publicMessage = (message) => pick({ ...message, channel: message?.channel || 'public' }, PUBLIC_MESSAGE_FIELDS);
  const publicResident = (resident) => pick(resident, PUBLIC_RESIDENT_FIELDS);

  /** Build the render view from public fields only. No message recipient, mission or memory field is kept. */
  function buildSnapshot(payload = {}) {
    const world = payload.world || {};
    const columns = finite(world.width ?? world.columns, 0), rows = finite(world.height ?? world.rows, 0);
    return {
      world: { id: world.id || worldId, name: world.name || '', kind: world.kind || 'outdoors', visibility: world.visibility || 'public', width: columns, height: rows, description: world.description || '', ambiance: world.ambiance || '' },
      camera: payload.camera || { x: 0, y: 0 },
      bounds: { columns, rows },
      paused: payload.paused === true,
      residents: (payload.participants || []).filter((resident) => resident && resident.id && !['deleted', 'revoked'].includes(resident.status)).map(publicResident),
      objects: (payload.objects || []).map((object) => pick(object, ['id', 'x', 'y', 'type', 'kind'])),
      portals: (payload.portals || []).map((portal) => pick(portal, ['x', 'y', 'label', 'name', 'target_world_id'])),
      messages: (payload.messages || []).filter((message) => message?.channel === 'public').map(publicMessage),
      counts: payload.counts || null,
      atmosphere: payload.atmosphere || null,
    };
  }

  /** Where to put the observer when the world opens: the caller's start point, else the sent window's centre. */
  function openingPosition(next) {
    if (options.start) return options.start;
    const columns = next.bounds.columns || SPECTATOR_VIEWPORT.columns, rows = next.bounds.rows || SPECTATOR_VIEWPORT.rows;
    return { x: next.camera.x + Math.floor(Math.min(columns, SPECTATOR_VIEWPORT.columns) / 2), y: next.camera.y + Math.floor(Math.min(rows, SPECTATOR_VIEWPORT.rows) / 2), z: 0 };
  }

  function closeLive() {
    // Closing a feed also invalidates callbacks already queued by its EventSource. A late `closed`
    // from the previous world must never close the new world's connection.
    liveGeneration += 1;
    if (live?.close) { try { live.close(); } catch { /* already closed */ } }
    live = null;
  }

  function openLive() {
    if (!subscribe) return 'none';
    closeLive();
    const generation = liveGeneration, subscribedWorld = worldId;
    const current = () => generation === liveGeneration && subscribedWorld === worldId;
    let readyAttempt = 0, refreshing = false, queuedFrames = [], queueOverflow = false;
    streams += 1;
    const handlers = {
      onReady: () => {
        if (!current()) return;
        // `ready` follows both first connection and EventSource reconnect. The initial `/world`
        // read happened before subscribing, so an action in that gap would otherwise be missed.
        // Re-read over the established feed; buffer its frames until the snapshot has arrived.
        const attempt = ++readyAttempt;
        refreshing = true; queuedFrames = []; queueOverflow = false;
        setStatus(SPECTATOR_STATUS.RECONNECTING, 'synchronizing', 'Refreshing the authoritative world after the live feed opened.');
        void (async () => {
          try {
            const payload = await read('/world', { world_id: subscribedWorld, view: 'voxel' });
            if (!current() || attempt !== readyAttempt) return;
            if (queueOverflow) {
              closeLive();
              setStatus(SPECTATOR_STATUS.SNAPSHOT, 'snapshot_backlog', 'The live feed outran the snapshot. Refresh this view to reconnect.');
              return;
            }
            snapshot = buildSnapshot(payload);
            camera.setBounds(snapshot.bounds);
            const followed = camera.following();
            if (followed) {
              const resident = snapshot.residents.find((item) => item.id === followed);
              if (resident) camera.moveResident(followed, resident);
              else {
                camera.unfollow();
                lastRefusal = spectatorRefusal('resident_left', 'The followed resident left this world.', { next_step: 'Choose another visible resident to follow.' });
              }
            }
            const buffered = queuedFrames;
            queuedFrames = []; refreshing = false;
            for (const frame of buffered) {
              if (!current()) return;
              applyFrame(frame);
            }
            if (current()) setStatus(SPECTATOR_STATUS.CONNECTED, 'ready', 'Live: the world feed is open.');
          } catch (error) {
            if (!current() || attempt !== readyAttempt) return;
            const refusal = spectatorRefusalFor(error);
            lastRefusal = refusal;
            closeLive();
            setStatus(SPECTATOR_STATUS.SNAPSHOT, refusal.rule, refusal.message);
          }
        })();
      },
      onFrame: (frame) => {
        if (!current()) return;
        if (refreshing) {
          if (queuedFrames.length < 256) queuedFrames.push(frame);
          else queueOverflow = true;
        } else applyFrame(frame);
      },
      onClosed: (reason) => { if (current()) lose(reason || 'closed'); },
      onError: (error) => { if (current()) lose(error?.status === 401 ? 'no_session' : 'stream_error'); },
    };
    try {
      const opened = subscribe(worldId, handlers);
      live = { close: typeof opened?.close === 'function' ? opened.close : null };
      return 'opened';
    } catch (error) {
      live = null;
      lose(error?.status === 401 ? 'no_session' : 'stream_error');
      return 'refused';
    }
  }

  /** A bounded live frame: only public keys are read, and only public fields are kept. */
  function applyFrame(frame = {}) {
    if (!frame || frame.world_id !== worldId || !snapshot) return refuse(spectatorRefusal('frame_for_another_world', 'That live update belongs to another world and was ignored.', { next_step: 'Keep observing this world; the frame was not applied.' }));
    frames += 1;
    for (const agent of frame.agents || []) {
      if (!agent || typeof agent.id !== 'string') continue;
      const index = snapshot.residents.findIndex((resident) => resident.id === agent.id);
      if (agent.world_id && agent.world_id !== worldId) {
        if (index >= 0) snapshot.residents.splice(index, 1);
        if (camera.following() === agent.id) { camera.unfollow(); lastRefusal = spectatorRefusal('resident_left', 'The followed resident left this world.', { next_step: 'Choose another visible resident to follow.' }); }
        continue;
      }
      if (index >= 0) snapshot.residents[index] = { ...snapshot.residents[index], ...publicResident(agent) };
      else snapshot.residents.push(publicResident(agent));
      camera.moveResident(agent.id, agent);
    }
    for (const change of frame.objects || []) {
      const index = snapshot.objects.findIndex((object) => object.x === change.x && object.y === change.y);
      if (change.op === 'remove') { if (index >= 0) snapshot.objects.splice(index, 1); }
      else if (index >= 0) snapshot.objects[index] = { ...snapshot.objects[index], ...pick(change, ['x', 'y', 'type', 'kind']) };
      else snapshot.objects.push(pick(change, ['x', 'y', 'type', 'kind']));
    }
    for (const message of frame.messages || []) {
      // Only public conversation may enter the observation view; a private or nearby frame message is
      // dropped here even though the channel is documented never to publish one.
      if (!message?.id || (message.channel && message.channel !== 'public') || snapshot.messages.some((item) => item.id === message.id)) continue;
      snapshot.messages.push(publicMessage(message));
    }
    if (snapshot.messages.length > 200) snapshot.messages = snapshot.messages.slice(-200);
    if (frame.refresh) return recover();
    return { ok: true, frames };
  }

  const refuse = (refusal) => { lastRefusal = refusal; return refusal; };
  const welcome = () => ({ ok: true, snapshot, status: { ...status }, camera: camera.view() });

  /**
   * Read the public world. A private, missing or unreadable world comes back as a refusal and the
   * observer stays exactly where it was — a refusal never blanks a view the server did hand over.
   */
  async function open(id = worldId) {
    const wanted = typeof id === 'string' && id ? id : worldId;
    lastRefusal = null;
    let payload;
    try { payload = await read('/world', { world_id: wanted, view: 'voxel' }); }
    catch (error) {
      const refusal = spectatorRefusalFor(error);
      refusal.world = wanted;
      // Keep the connection state the observer already had; with nothing on screen it is a snapshot.
      setStatus(snapshot ? status.state : SPECTATOR_STATUS.SNAPSHOT, refusal.rule, refusal.message);
      return refuse(refusal);
    }
    worldId = wanted;
    snapshot = buildSnapshot(payload);
    camera.setBounds(snapshot.bounds);
    camera.place(openingPosition(snapshot), {});
    const liveState = openLive();
    if (liveState === 'none') setStatus(SPECTATOR_STATUS.SNAPSHOT, 'no_session', 'No live feed without a session; showing the last public snapshot.');
    else if (liveState === 'opened') setStatus(SPECTATOR_STATUS.RECONNECTING, 'opening', 'Opening the live feed; showing the last public snapshot.');
    return welcome();
  }

  /** The public world list an observer chooses a location from. Private gardens are never listed. */
  async function worldList(params = {}) {
    try {
      const payload = await read('/worlds', pick(params, ['q', 'limit', 'offset']));
      const worlds = (payload.worlds || []).filter((world) => world && world.visibility !== 'private').map((world) => pick(world, PUBLIC_WORLD_FIELDS));
      return { ok: true, worlds, total: payload.total ?? worlds.length, has_more: payload.has_more === true, shared_count: payload.shared_count ?? 0 };
    } catch (error) { return refuse(spectatorRefusalFor(error)); }
  }

  /** Follow a resident that is visible in the current public snapshot. */
  function follow(residentId) {
    lastRefusal = null;
    const resident = snapshot?.residents.find((item) => item.id === residentId);
    if (!resident) return refuse(spectatorRefusal('resident_not_visible', 'That resident is not in this world view.', { hint: 'Only residents the server reports in this world can be followed.', next_step: 'Pan the view or pick a resident from the list of those present.' }));
    camera.followResident(resident);
    return { ok: true, following: resident.id, camera: camera.view() };
  }

  /** Drop the live feed and say so honestly; recovery is an explicit, authoritative re-read. */
  function lose(reason = 'closed') {
    closeLive();
    // `no_session` means there is no live channel at all, so the honest state is a snapshot rather
    // than an endless "reconnecting" the visitor might read as a stall.
    const canRetry = Boolean(subscribe) && reason !== 'no_session';
    const next = canRetry ? SPECTATOR_STATUS.RECONNECTING : SPECTATOR_STATUS.SNAPSHOT;
    const detail = canRetry
      ? `The live feed stopped (${reason}). Showing the last confirmed snapshot while reconnecting.`
      : 'No live feed for this visitor; showing the last public snapshot.';
    return setStatus(next, reason, detail);
  }

  /** Re-read the authoritative world and, when a session allows it, reopen the live feed. */
  async function recover() {
    const result = await open(worldId);
    // Recovery puts the authoritative snapshot back on screen; the feed is only "connected" again
    // once the channel itself confirms it with a ready frame.
    if (result.ok && subscribe && status.state === SPECTATOR_STATUS.RECONNECTING) setStatus(SPECTATOR_STATUS.RECONNECTING, 'recovered', 'Reconnected to the world; showing the authoritative public snapshot until the live feed is ready.');
    return { ...result, status: { ...status } };
  }

  /**
   * The single entry the interface calls. A read intent is performed; anything that would change a
   * world or act for a resident is refused here and never reaches the transport.
   */
  async function intent(action = {}) {
    switch (action.kind) {
      case 'observe': return open(action.world_id || worldId);
      case 'world-list': return worldList(action.params || {});
      case 'choose-location': return open(action.world_id);
      case 'pan': { lastRefusal = null; return { ok: true, camera: camera.pan(action.direction) }; }
      case 'turn': { lastRefusal = null; return { ok: true, camera: camera.turn({ yaw: action.yaw, pitch: action.pitch }) }; }
      case 'follow': return follow(action.resident_id);
      case 'unfollow': { lastRefusal = null; return { ok: true, camera: camera.unfollow() }; }
      case 'set-mode': return { ok: true, camera: camera.setMode(action.mode) };
      case 'recover': return recover();
      default: return refuse(spectatorRefusal(SPECTATOR_WRITE_RULE.rule, SPECTATOR_WRITE_RULE.message, SPECTATOR_WRITE_RULE));
    }
  }

  return {
    anonymous: !subscribe,
    status: () => ({ ...status }),
    frames: () => frames,
    streams: () => streams,
    snapshot: () => snapshot,
    camera: () => camera.view(),
    target: () => camera.target(),
    facing: () => math.facingLabel(camera.view().yaw),
    following: () => camera.following(),
    lastRefusal: () => lastRefusal,
    worldId: () => worldId,
    open, recover, worldList, follow, intent,
    lose,
    applyFrame,
    close() { closeLive(); snapshot = null; return setStatus(SPECTATOR_STATUS.SNAPSHOT, 'closed', 'Observation closed.'); },
  };
}
