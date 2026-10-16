// Contextual interaction prompt.
//
// A small prompt beside the aim/focus names the nearest fixture a resident can use — a doorway, a
// crop patch, a bench, a crafting station, a country ambassador desk, or a nearby resident — and the
// keys that use it. Conversations (an ambassador desk, a nearby resident) and activities (a crop
// patch, a crafting station) open in compact overlays that are dismissible by Escape and by an
// explicit control, never trap focus, and suspend the gameplay shortcuts while they are open.
//
// The component is a reader, never an authority. Every read is the server's own `GET /interact`
// view, every action is a shipment route the world already owns (`POST /interact`, which delegates
// to travel/garden/posture/craft/talk, or `POST /messages` for a nearby resident), and a refusal is
// rendered exactly as the server sent it — status, `hint` and `next_step`. Nothing here decides a
// distance, an owner, a permission or a prerequisite, and a refusal can never appear as an
// accomplished action.
//
// Nothing in this module touches a global: the DOM, the transport and the keyboard interface are
// injected, so it runs under `node --test` with a tiny fake document and against the real HTTP
// routes, and the integration owner can wire it to the shipped `app.js` shell without this module
// importing any other UI file.

export const INTERACTION_KEYS = Object.freeze(['Enter', ' ', 'i']);
export const DISMISS_KEY = 'Escape';
export const CYCLE_KEYS = Object.freeze({ next: 'ArrowDown', previous: 'ArrowUp' });
export const RESIDENT_NEARBY = 6;
export const NEARBY_LIMIT = 4;
// One gesture keeps one Idempotency-Key inside this window, so a double click replays instead of
// acting twice. It mirrors the shipped interface's own coalescing constant.
export const COALESCE_MS = 700;

/**
 * Every interaction the prompt offers, keyed by the server's own fixture kind, and mapped to the
 * shipped action that performs it. `overlay` names the compact overlay the kind opens, or null when
 * the key press performs the action directly. A resident is not a server fixture — it is read from
 * the world's published participants — so it carries the `message` action instead of a `POST
 * /interact` one.
 */
export const FIXTURE_KEYBOARD = Object.freeze({
  door: Object.freeze({ action: 'travel', route: 'POST /api/v1/agents/:id/travel', overlay: null, label: 'Enter the doorway' }),
  crop_patch: Object.freeze({ action: 'garden', route: 'POST /api/v1/journey/garden', overlay: 'activity', label: 'Use the crop patch' }),
  bench: Object.freeze({ action: 'posture', route: 'POST /api/v1/agents/:id/posture', overlay: null, label: 'Sit on the bench' }),
  crafting_station: Object.freeze({ action: 'craft', route: 'POST /api/v1/journey/craft', overlay: 'activity', label: 'Use the crafting station' }),
  ambassador_desk: Object.freeze({ action: 'talk', route: 'POST /api/v1/ambassadors/talk', overlay: 'conversation', label: 'Talk to the ambassador' }),
  resident: Object.freeze({ action: 'message', route: 'POST /api/v1/messages', overlay: 'conversation', label: 'Speak to the resident' }),
});

/** The keyboard map as a table, so the parity claim is one data structure rather than scattered keys. */
export function keyboardMap() {
  return Object.entries(FIXTURE_KEYBOARD).map(([kind, spec]) => ({
    kind,
    action: spec.action,
    route: spec.route,
    overlay: spec.overlay,
    keys: [...INTERACTION_KEYS],
    use: `Press ${INTERACTION_KEYS.join(', ')} with the ${kind.replace('_', ' ')} focused`,
    submit: spec.overlay ? 'Enter submits the overlay form' : `Enter performs the action directly`,
  }));
}

export const isInteractionKey = (key, keys = INTERACTION_KEYS) => keys.includes(key);

const manhattan = (left, right) => Math.abs(left.x - right.x) + Math.abs(left.y - right.y);

/**
 * What a single key press asks this component to do. While an overlay is open it owns the keyboard:
 * Escape dismisses it and every other key stays inside it, so a world shortcut (walk, turn, block
 * palette) can never fire underneath an open overlay. When no overlay is open, Enter, Space or I use
 * the focused fixture, the arrows move the focus between nearby entries, and every other key is
 * returned as null so walking, turning and building keep their shipped meaning untouched.
 */
export function keyIntent(key, { focused = false, overlayOpen = false, keys = INTERACTION_KEYS } = {}) {
  if (overlayOpen) {
    if (key === DISMISS_KEY) return { kind: 'dismiss' };
    // Tab keeps its native meaning, so the overlay never traps the keyboard even while every other
    // key stays inside it.
    if (key === 'Tab') return null;
    return { kind: 'overlay', key };
  }
  if (focused && isInteractionKey(key, keys)) return { kind: 'activate' };
  if (key === CYCLE_KEYS.next) return { kind: 'cycle', direction: 1 };
  if (key === CYCLE_KEYS.previous) return { kind: 'cycle', direction: -1 };
  return null;
}

/** The stable value a server option stands for: a recipe id, a `plant:<kind>` pair, or the verb. */
export function optionValue(option) {
  if (!option) return null;
  if (option.recipe_id) return option.recipe_id;
  if (option.action === 'plant') return `plant:${option.kind}`;
  return option.action;
}

/** The option the interface offers first, from the server's own list — never a client-side rule. */
export function defaultChoice(fixture) {
  const options = fixture?.action?.options || [];
  if (fixture?.kind === 'crop_patch') {
    const option = options.find((item) => item.action === 'harvest' && item.available) || options.find((item) => item.action === 'tend') || options[0];
    return optionValue(option);
  }
  if (fixture?.kind === 'crafting_station') return options.find((item) => item.available)?.recipe_id || options[0]?.recipe_id || null;
  return null;
}

/**
 * The `POST /interact` body for a fixture, built only from the server's own fixture description: the
 * tile it named, the action it named, and one of the options it returned. The server validates every
 * field, so this is intent, never a claim.
 */
export function payloadFor(fixture, { choice = null, question = '' } = {}) {
  const kind = fixture.kind, action = FIXTURE_KEYBOARD[kind]?.action || fixture.action?.id;
  const tile = { x: fixture.x, y: fixture.y, action };
  if (kind === 'crop_patch') {
    const [verb, planted] = String(choice || defaultChoice(fixture) || '').split(':');
    return { ...tile, action: 'garden', garden_action: verb, ...(planted ? { kind: planted } : {}) };
  }
  if (kind === 'crafting_station') return { ...tile, action: 'craft', recipe_id: choice || defaultChoice(fixture) || '' };
  if (kind === 'bench') return { ...tile, action: 'posture', posture: 'sitting' };
  if (kind === 'ambassador_desk') return { ...tile, action: 'talk', question: String(question || '') };
  return tile;
}

/** The `POST /messages` body for a nearby resident: the shipped nearby channel, nothing invented. */
export function messagePayload(text) {
  return { channel: 'nearby', text: String(text || '') };
}

/** Combined nearby entries: the server's fixture list plus residents the integration owner supplied. */
export function nearbyEntries(view, residents = [], { limit = NEARBY_LIMIT } = {}) {
  const fixtures = (view?.nearby || []).slice(0, limit).map((near) => ({
    type: 'fixture', kind: near.kind, label: near.label, name: near.name, x: near.x, y: near.y,
    distance: near.distance, in_range: Boolean(near.in_range),
  }));
  const people = (residents || []).map((person) => ({
    type: 'resident', id: person.id, kind: 'resident', label: 'Resident', name: person.name,
    x: person.x, y: person.y, distance: person.distance, in_range: true,
    ...(person.calling ? { calling: person.calling } : {}),
  }));
  return [...fixtures, ...people];
}

const placement = () => Object.freeze({ anchor: 'aim', offset: Object.freeze({ x: 0, y: 0 }), pointerEvents: 'none', maxLines: 1 });

/** Only tile positions can be measured, so a resident list is filtered to the entries that carry one. */
const normalizeResidents = (list) => Array.isArray(list)
  ? list.filter((person) => person && Number.isInteger(person.x) && Number.isInteger(person.y)).map((person) => ({ ...person }))
  : [];

/**
 * The small, readable prompt: one line naming the fixture and its action with the distance
 * requirement, as plain text. `role="status"` with `aria-live="polite"` makes it a live region, and
 * `tabIndex` 0 makes it focusable; a refusal turns it into a `role="alert"`. The text is the server's
 * own `hint` by default. The game shell can opt into an action-sized ordinary hint; the complete
 * server hint remains in the workspace, and blocked states and refusals retain their exact text.
 */
export function promptModel(view, { focused = null, focusKind = 'fixture', keys = INTERACTION_KEYS, refusal = null, compact = false } = {}) {
  const base = { role: 'status', ariaLive: 'polite', tabIndex: 0, placement: placement(), keys: [...keys], refusal: null };
  if (refusal) return { ...base, visible: true, kind: refusal.kind || 'fixture', role: 'alert', ariaLive: 'assertive', refusal, in_range: false, blocked_by: 'refused', next_step: refusal.next_step, action: null, fixture: refusal.fixture || null, text: [refusal.hint, refusal.next_step].filter(Boolean).join(' ') };
  if (focusKind === 'resident' && focused) {
    const keysLabel = keys.join(', ');
    return {
      ...base, visible: true, kind: 'resident', in_range: true, blocked_by: null, next_step: '',
      text: compact ? `Speak to ${focused.name} · Interact` : `Resident ${focused.name} at ${focused.x}, ${focused.y} · ${focused.distance} tile${focused.distance === 1 ? '' : 's'} away · speak with ${keysLabel}`,
      action: { id: 'message', label: `Speak to ${focused.name}`, route: FIXTURE_KEYBOARD.resident.route, scope: 'chat', options: [] },
      fixture: { kind: 'resident', label: 'Resident', name: focused.name, x: focused.x, y: focused.y, distance: focused.distance },
      requirement: 'stand near the resident',
    };
  }
  const fixture = focused || view?.fixture || null;
  if (!fixture) {
    return { ...base, visible: false, kind: 'none', in_range: false, blocked_by: null, next_step: '', action: null, fixture: null, text: view?.hint || 'Pick a tile in the world to read what it offers.' };
  }
  const ordinary = fixture.can_act && fixture.in_range && !fixture.blocked_by;
  const approach = fixture.blocked_by === 'out_of_range';
  const text = compact && fixture.action?.label && (ordinary || approach)
    ? `${fixture.action.label} · ${approach ? 'Move closer' : 'Interact'}` : fixture.hint || '';
  return {
    ...base, visible: true, kind: fixture.kind, in_range: Boolean(fixture.in_range), blocked_by: fixture.blocked_by || null,
    text, next_step: fixture.next_step || '',
    action: fixture.action ? { id: fixture.action.id, label: fixture.action.label, route: fixture.action.route, scope: fixture.action.scope, options: fixture.action.options || [] } : null,
    fixture: { kind: fixture.kind, label: fixture.label, name: fixture.name, x: fixture.x, y: fixture.y, distance: fixture.distance },
    requirement: fixture.requirement || '',
  };
}

/**
 * A compact overlay for a conversation or an activity. It is a non-modal `dialog`: it never traps
 * focus, Escape and a labelled Close both dismiss it, and `suspendsShortcuts` tells the integration
 * owner to route the world keyboard to the overlay while it is open. Every control is a labelled
 * field or a labelled submit, so the overlay is completable by keyboard alone.
 */
export function overlayModel(source, { resident = false, keys = INTERACTION_KEYS } = {}) {
  const isResident = source.kind === 'resident';
  const spec = FIXTURE_KEYBOARD[source.kind] || {};
  const title = isResident ? `Speak nearby · ${source.name}` : source.name && source.name !== source.label ? `${source.label} · ${source.name}` : `${source.label} · ${source.x}, ${source.y}`;
  // The server's nearby channel reaches every active resident within three tiles, so the overlay
  // says so rather than implying a private line to one person.
  const note = isResident ? 'A nearby message reaches every active resident within three tiles.' : '';
  const controls = [];
  if (isResident) {
    controls.push({ type: 'text', name: 'text', label: `Message for residents near ${source.name}`, max: 500, full: true });
    controls.push({ type: 'submit', name: 'submit', label: 'Say this nearby', disabled: !resident });
  } else if (source.kind === 'ambassador_desk') {
    controls.push({ type: 'text', name: 'question', label: 'Your question', max: 500, full: true, hint: `Country context stays fixed to ${source.name}.` });
    controls.push({ type: 'submit', name: 'submit', label: source.action?.label || `Talk to ${source.name}`, disabled: !resident });
  } else {
    const options = (source.action?.options || []).map((option) => ({ value: optionValue(option), label: option.label, disabled: option.available === false }));
    controls.push({ type: 'choice', name: 'choice', label: source.kind === 'crop_patch' ? 'Crop patch action' : 'Recipe', options, value: defaultChoice(source) });
    controls.push({ type: 'submit', name: 'submit', label: source.action?.label || spec.label, disabled: !resident });
  }
  return {
    open: true, kind: spec.overlay || 'activity', role: 'dialog', modal: false, ariaModal: 'false',
    suspendsShortcuts: true, dismissKeys: [DISMISS_KEY], keys: [...keys],
    dismiss: { label: 'Close', keys: [DISMISS_KEY] }, focus: { initial: 'first-control', returnTo: 'prompt' },
    title, note, prompt: source.hint || '', controls,
    source: { type: isResident ? 'resident' : 'fixture', kind: source.kind, label: source.label, name: source.name, x: source.x, y: source.y, action: spec.action },
  };
}

/**
 * A refusal rendered from the server's own body. The status, the `hint` and the `next_step` are the
 * server's; `accomplished` is always false, so a refused interaction can never be shown as an
 * outcome. The next step already names what to do — approach, resume, the garden's owner, or the
 * missing ingredients — because the server classified it.
 */
export function refusalModel(error, source = null) {
  const body = error?.body || {};
  const message = body.error || error?.message || 'This interaction could not be completed.';
  const nextStep = body.next_step || '';
  const hint = body.hint || message;
  return {
    ok: false, accomplished: false, status: Number(error?.status) || 0,
    kind: source?.kind || null, label: source?.label || null, x: source?.x ?? null, y: source?.y ?? null,
    message, hint, next_step: nextStep, role: 'alert', ariaLive: 'assertive',
    fixture: source ? { kind: source.kind, label: source.label, name: source.name, x: source.x, y: source.y } : null,
  };
}

/** The confirmation a resident sees after a real, server-accepted interaction — server fields only. */
export function confirmationMessage(confirmed) {
  const info = confirmed?.interaction || {}, result = confirmed?.result || {};
  if (info.kind === 'door') return `Entered ${result.world_id || 'the doorway'}.`;
  if (info.kind === 'bench') return `Sitting on the bench at ${info.x}, ${info.y}.`;
  if (info.kind === 'crafting_station') return `Crafted ${result.crafted || 'a keepsake'}.`;
  if (info.kind === 'crop_patch') {
    if (result.crop?.harvested_at) return 'Harvest gathered into your shelf.';
    if (result.crop?.tended_at) return `Tended the ${result.crop.kind || 'crop'}; its growth is shorter now.`;
    return `Planted ${result.crop?.kind || 'a crop'} at ${info.x}, ${info.y}.`;
  }
  if (info.kind === 'ambassador_desk') return `Asked ${info.name || 'the ambassador'}.`;
  if (info.kind === 'resident') return 'Said that to the residents nearby.';
  return 'The world accepted the interaction.';
}

/**
 * The controller. It holds the last server view, the resident's position and the nearby residents,
 * and turns focus or activation into one server call. The transport is injected and narrow:
 *
 *   transport.interactRead(query)          -> GET  /interact          (the server's own view)
 *   transport.interactWrite(payload, key)  -> POST /interact          (throws { status, body })
 *   transport.sendMessage(payload)         -> POST /messages          (nearby residents only)
 *
 * A `query` carries only the fields the caller has: `{ world_id, x?, y?, agent_id? }`.
 */
export function createInteractionPrompt({
  transport, world = 'commons', agent = null, keys = INTERACTION_KEYS, residents = [], position = null, compact = false,
  clock = () => Date.now(), coalesceMs = COALESCE_MS, randomKey = defaultRandomKey,
} = {}) {
  if (!transport || typeof transport.interactRead !== 'function' || typeof transport.interactWrite !== 'function') {
    throw new TypeError('The interaction prompt needs a transport with interactRead and interactWrite.');
  }
  const state = {
    world, agent, keys: [...keys], view: null, position, residents: normalizeResidents(residents), aim: null, residentFocus: null,
    overlay: null, refusal: null, confirmed: null, error: null, busy: false, flight: null, intent: null,
  };
  let sequence = 0;

  const tilesFrom = (person) => ({ x: person.x, y: person.y });

  function residentsNear() {
    if (!state.position) return [];
    return state.residents
      .map((person) => ({ ...person, type: 'resident', kind: 'resident', distance: manhattan(state.position, tilesFrom(person)) }))
      .filter((person) => person.distance <= RESIDENT_NEARBY)
      .sort((left, right) => left.distance - right.distance);
  }

  function entries() { return nearbyEntries(state.view, residentsNear()); }

  function focused() {
    if (state.residentFocus) return residentsNear().find((person) => person.id === state.residentFocus) || state.residentFocus;
    return state.view?.fixture || null;
  }

  function focusTile(entry) {
    if (entry.type === 'resident') { state.residentFocus = entry.id; state.aim = null; return null; }
    state.residentFocus = null;
    return { x: entry.x, y: entry.y };
  }

  /** One transaction at a time: a second activation while a request is in flight joins the first. */
  function perform(task) {
    if (state.busy) return state.flight;
    state.busy = true;
    const run = Promise.resolve().then(task).finally(() => { state.busy = false; state.flight = null; });
    state.flight = run;
    return run;
  }

  /** One intent keeps one key inside the coalescing window, so a double click replays, not doubles. */
  function keyFor(payload) {
    const target = [payload.x, payload.y, payload.action, payload.garden_action || '', payload.kind || '', payload.recipe_id || '', payload.question || ''].join('|');
    const now = clock();
    const reused = state.intent && state.intent.target === target && now - state.intent.at < coalesceMs;
    const key = reused ? state.intent.key : randomKey(sequence++);
    state.intent = { target, key, at: now };
    return key;
  }

  async function commit(payload, source) {
    state.refusal = null; state.error = null; state.confirmed = null;
    const body = { ...payload, ...(state.agent ? { agent_id: state.agent } : {}) };
    try {
      const result = await transport.interactWrite(body, keyFor(body));
      state.confirmed = {
        ok: true, accomplished: true, replay: Boolean(result?.replay),
        interaction: result?.interaction || null, result: result?.result ?? null,
      };
      state.overlay = null;
    } catch (error) {
      state.refusal = refusalModel(error, source);
    }
    // Re-read either way: a success shows the world's new state, and a refusal keeps the prompt beside
    // the fixture the resident just tried, with the server's own next step still on screen.
    await controller.refresh({ x: payload.x, y: payload.y }).catch(() => {});
    return state.refusal || state.confirmed;
  }

  async function commitMessage(payload, source) {
    state.refusal = null; state.error = null; state.confirmed = null;
    if (typeof transport.sendMessage !== 'function') {
      state.refusal = refusalModel({ status: 0, message: 'Speaking to a nearby resident is not wired yet.', body: { next_step: 'The integration owner must supply transport.sendMessage.' } }, source);
      return state.refusal;
    }
    const body = { ...payload, ...(state.agent ? { agent_id: state.agent } : {}) };
    try {
      const result = await transport.sendMessage(body);
      state.confirmed = { ok: true, accomplished: true, replay: Boolean(result?.replay), interaction: { kind: 'resident', name: source?.name || null, x: source?.x ?? null, y: source?.y ?? null }, result };
      state.overlay = null;
      return state.confirmed;
    } catch (error) {
      state.refusal = refusalModel(error, source);
      return state.refusal;
    }
  }

  const controller = {
    get view() { return state.view; },
    get busy() { return state.busy; },
    get suspendsShortcuts() { return Boolean(state.overlay); },
    setWorld(id) { state.world = String(id); state.aim = null; state.view = null; return controller; },
    setAgent(id) { state.agent = id || null; return controller; },
    setKeys(list) { state.keys = [...list]; return controller; },
    /** The resident's tile, reported as it moves; the next read re-ranks the nearby fixtures. */
    setPosition(tile) { state.position = tile && Number.isInteger(tile.x) && Number.isInteger(tile.y) ? { x: tile.x, y: tile.y } : null; return controller; },
    /** The world's published participants the integration owner read from `GET /world`. */
    setResidents(list) { state.residents = normalizeResidents(list); return controller; },

    entries,
    focused: () => focused(),
    nearby: () => residentsNear(),

    /**
     * Read what the tile offers (or the nearest fixtures when no tile is named) from the server. The
     * read writes nothing and is the same call a visitor may make, so discovery by approach never
     * acts for anybody.
     */
    async refresh({ x = null, y = null } = {}) {
      state.aim = Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
      const query = { world_id: state.world };
      if (state.aim) { query.x = state.aim.x; query.y = state.aim.y; }
      if (state.agent) query.agent_id = state.agent;
      let view = null;
      try { view = await transport.interactRead(query); state.error = null; }
      catch (error) { state.error = error?.message || 'This world could not be read.'; }
      if (view) state.view = view;
      state.residentFocus = null;
      return controller.prompt();
    },

    /** Discovery by approach: read with no tile named so the server ranks the nearby fixtures. */
    approach() { return controller.refresh({}); },

    /** Focus a nearby entry: a fixture tile is re-read in full, a resident becomes the focus. */
    async focus(entry) {
      if (!entry) return controller.prompt();
      const tile = focusTile(entry);
      if (!tile) return controller.prompt();
      return controller.refresh(tile);
    },

    /** Move the focus between the nearby entries with the arrow keys. */
    async cycle(direction = 1) {
      const list = entries();
      if (!list.length) return controller.prompt();
      const current = list.findIndex((entry) => (entry.type === 'resident' ? state.residentFocus === entry.id : state.aim && state.aim.x === entry.x && state.aim.y === entry.y));
      const index = (current + direction + list.length) % list.length;
      return controller.focus(list[index]);
    },

    prompt: () => promptModel(state.view, { focused: focused(), focusKind: state.residentFocus ? 'resident' : 'fixture', keys: state.keys, refusal: state.refusal, compact: typeof compact === 'function' ? compact() : compact }),
    get refusal() { return state.refusal; },
    get confirmed() { return state.confirmed; },
    overlay: () => state.overlay,
    openOverlay(source) { state.refusal = null; state.overlay = overlayModel(source, { resident: Boolean(state.agent), keys: state.keys }); return state.overlay; },
    closeOverlay() { state.overlay = null; return null; },

    /**
     * Use the focused entry. A fixture whose kind needs a choice or a typed turn opens its compact
     * overlay; a door or a bench performs directly. A nearby resident always opens the conversation
     * overlay. Nothing is written until the overlay is submitted or the direct action is committed.
     */
    async activate(override = {}) {
      const focus = focused();
      if (!focus) return null;
      const kind = state.residentFocus ? 'resident' : focus.kind;
      const spec = FIXTURE_KEYBOARD[kind];
      if (!spec) return null;
      if (spec.overlay) return controller.openOverlay(focus);
      return perform(() => commit(payloadFor(focus, override), focus));
    },

    /** Submit the open overlay with the values its own controls collected. */
    async submitOverlay(values = {}) {
      const overlay = state.overlay;
      if (!overlay) return null;
      const source = overlay.source;
      if (overlay.kind === 'conversation' && source.kind === 'resident') return perform(() => commitMessage(messagePayload(values.text), source));
      return perform(() => commit(payloadFor(source, { choice: values.choice, question: values.question }), source));
    },

    /** Direct activation of a specific fixture (a programmatic call from the integration owner). */
    async use(fixture, override = {}) { return perform(() => commit(payloadFor(fixture, override), fixture)); },

    /**
     * Route one key press. Escape dismisses an open overlay; Enter, Space or I activate the focus;
     * the arrows cycle; any key that is not ours returns null so the world keeps its own controls.
     * While an overlay is open every key is returned as an overlay intent, which is how the gameplay
     * shortcuts are suspended. The triggered work is attached as `pending` for the caller to await.
     */
    handleKey(key) {
      const intent = keyIntent(key, { focused: Boolean(focused()), overlayOpen: Boolean(state.overlay), keys: state.keys });
      if (!intent) return null;
      if (intent.kind === 'dismiss') { controller.closeOverlay(); return intent; }
      if (intent.kind === 'activate') return { ...intent, pending: controller.activate() };
      if (intent.kind === 'cycle') return { ...intent, pending: controller.cycle(intent.direction) };
      return intent;
    },

    reset() {
      state.view = null; state.aim = null; state.residentFocus = null; state.overlay = null;
      state.refusal = null; state.confirmed = null; state.error = null; state.intent = null;
      return controller;
    },

    /** Paint the prompt and any overlay into hosts the integration owner supplies. */
    paint(dom, { promptHost = null, overlayHost = null } = {}) {
      if (promptHost) paintPrompt(promptHost, controller.prompt(), { document: dom });
      if (overlayHost) paintOverlay(overlayHost, state.overlay, { document: dom, refusal: state.refusal, onDismiss: () => controller.closeOverlay(), onSubmit: (values) => controller.submitOverlay(values) });
      return controller;
    },
  };
  return controller;
}

/** A key that is unique per gesture, falling back to a counter when the platform has no UUID source. */
function defaultRandomKey(sequence = 0) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `interaction-${Date.now()}-${sequence}`;
}

const setText = (node, text) => { node.textContent = String(text ?? ''); };

/**
 * Paint the small prompt. It creates plain nodes and sets `textContent` only — it never injects
 * markup — so the
 * hint is text, and the live region is the element itself: `role="status"` (or `role="alert"` for a
 * refusal), `aria-live`, `aria-atomic` and a focusable `tabindex`.
 */
export function paintPrompt(host, model, { document: dom } = {}) {
  if (!host || !dom) throw new TypeError('Painting the prompt needs a host element and a document.');
  host.replaceChildren();
  if (!model?.visible) { host.hidden = true; return host; }
  const node = dom.createElement('p');
  node.id = 'interaction-prompt';
  node.className = 'interaction-prompt';
  node.setAttribute('role', model.role);
  node.setAttribute('aria-live', model.ariaLive);
  node.setAttribute('aria-atomic', 'true');
  node.setAttribute('aria-label', 'Available interaction');
  node.setAttribute('tabindex', String(model.tabIndex));
  setText(node, model.text);
  host.hidden = false;
  host.append(node);
  return node;
}

/**
 * Paint a compact overlay. It is a non-modal `section role="dialog"` — no `showModal()` — with a
 * labelled title, a labelled Close control, the labelled fields, a labelled submit, and a
 * `role="alert"` region for a refusal. Escape is handled by the controller; the Close control is the
 * explicit, pointer-reachable dismissal.
 */
export function paintOverlay(host, model, { document: dom, refusal = null, onDismiss = () => {}, onSubmit = () => {} } = {}) {
  if (!host || !dom) throw new TypeError('Painting an overlay needs a host element and a document.');
  host.replaceChildren();
  if (!model?.open) { host.hidden = true; return host; }
  const panel = dom.createElement('section');
  panel.className = 'interaction-overlay';
  panel.setAttribute('role', model.role);
  panel.setAttribute('aria-modal', model.ariaModal);
  panel.setAttribute('aria-label', model.title);
  const heading = dom.createElement('h3');
  setText(heading, model.title);
  const close = dom.createElement('button');
  close.type = 'button';
  close.className = 'interaction-overlay-close';
  close.setAttribute('aria-label', `${model.dismiss.label} ${model.title}`);
  setText(close, model.dismiss.label);
  close.addEventListener('click', () => onDismiss());
  panel.append(heading, close);
  const form = dom.createElement('form');
  form.className = 'interaction-overlay-form';
  form.setAttribute('aria-label', model.title);
  const fields = {};
  for (const control of model.controls) {
    const label = dom.createElement('label');
    setText(label, control.label);
    if (control.type === 'choice') {
      const select = dom.createElement('select');
      select.name = control.name;
      select.setAttribute('aria-label', control.label);
      for (const option of control.options) {
        const item = dom.createElement('option');
        item.value = option.value;
        item.disabled = Boolean(option.disabled);
        setText(item, option.label);
        select.append(item);
      }
      select.value = control.value ?? '';
      fields[control.name] = select;
      form.append(label, select);
    } else if (control.type === 'text') {
      const input = dom.createElement('input');
      input.type = 'text';
      input.name = control.name;
      input.maxLength = control.max;
      input.value = '';
      input.setAttribute('aria-label', control.label);
      fields[control.name] = input;
      form.append(label, input);
    } else {
      const submit = dom.createElement('button');
      submit.type = 'submit';
      submit.className = 'interaction-overlay-submit';
      submit.disabled = Boolean(control.disabled);
      submit.setAttribute('aria-label', control.label);
      setText(submit, control.label);
      form.append(submit);
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const [name, field] of Object.entries(fields)) values[name] = field.value;
    onSubmit(values);
  });
  panel.append(form);
  if (model.note) {
    const note = dom.createElement('p');
    note.className = 'interaction-overlay-note';
    setText(note, model.note);
    panel.append(note);
  }
  if (refusal) {
    const alert = dom.createElement('p');
    alert.className = 'interaction-overlay-refusal';
    alert.setAttribute('role', 'alert');
    alert.setAttribute('aria-live', 'assertive');
    setText(alert, [refusal.hint, refusal.next_step].filter(Boolean).join(' '));
    panel.append(alert);
  }
  host.hidden = false;
  host.append(panel);
  return panel;
}
