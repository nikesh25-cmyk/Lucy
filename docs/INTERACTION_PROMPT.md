# The contextual interaction prompt

**Component: `src/ui/interaction-prompt.js`. No browser check was performed by this task.** The
component is delivered with module tests and HTTP tests only; wiring it into the shell is task 38's
step, and the acceptance browser suite cannot gain a scenario without `app.js`.

This document describes one component: the small prompt that appears beside the aim/focus when a
resident is near something it can use, the compact overlays a conversation or an activity opens, and
the refusals that always name the next usable step. It is a **reader and a router**, never a second
authority.

## 1. What it is, and what it is not

| The component does | The component never does |
|---|---|
| Reads `GET /interact` — the server's own view of the focused or nearest fixture — and renders it | Decide a distance, an owner, a permission, a budget or a prerequisite |
| Sends intent to the shipped routes (`POST /interact`, which delegates to travel / garden / posture / craft / talk; `POST /messages` for a nearby resident) | Send an outcome, or a body the server did not ask for |
| Renders the server's `hint` and `next_step` verbatim | Rewrite a refusal into a softer message, or claim an action succeeded |
| Offers a keyboard equivalent for every interaction | Require a pointer |

The one rule the whole component keeps: **a displayed interaction is one the server confirmed, and a
refusal never appears as an accomplished action.** `controller.confirmed` is set only from a `2xx`
response body; a refusal sets `controller.refusal` and leaves `confirmed` null.

## 2. The API

One factory and a set of pure helpers. Every export lives in `src/ui/interaction-prompt.js`.

### 2.1 `createInteractionPrompt(options)` → controller

| Option | Meaning |
|---|---|
| `transport` **(required)** | A narrow injected interface — see §2.2. The component names no route outside it and holds no credential. |
| `world` | The current world id for reads (default `'commons'`). |
| `agent` | The acting resident id, sent as `agent_id` (a visitor passes `null`). |
| `keys` | The interaction keys; defaults to `['Enter', ' ', 'i']`. Injected so a parallel UI owner can change them without touching this module. |
| `residents` | Nearby residents from the world payload — `[{ id, name, x, y, calling? }]`. |
| `position` | The acting resident's tile — `{ x, y }`. Discovery ranks the nearby fixtures from it. |
| `coalesceMs` | One gesture keeps one `Idempotency-Key` inside this window (default 700 ms). |
| `clock`, `randomKey` | Injectable for deterministic tests. |

| Method | Behaviour |
|---|---|
| `approach()` | **Discovery by approach.** Reads `GET /interact` with no tile named, so the server ranks the fixtures within six tiles and focuses the nearest. |
| `refresh({ x, y })` | Reads a specific tile (the aim tile) or the nearest fixtures when no tile is named. Writes nothing. |
| `focus(entry)` | Focuses one nearby entry: a fixture tile is re-read in full, a resident becomes the focus. |
| `cycle(direction)` | Moves the focus between the nearby entries (arrow keys). |
| `prompt()` | The prompt view model — one line, `role="status"`, plain text. |
| `activate(override)` | Uses the focused entry: a door or a bench commits directly; a crop patch, a crafting station, an ambassador desk or a resident opens its overlay. |
| `submitOverlay(values)` | Submits the open overlay from its own controls' values. |
| `overlay()` / `openOverlay(source)` / `closeOverlay()` | The compact overlay model and its lifecycle. |
| `use(fixture, override)` | Directly uses a specific fixture (a programmatic call from the integration owner). |
| `handleKey(key)` | Routes one key press through the keyboard map; attaches the triggered work as `.pending`. |
| `entries()` / `nearby()` | The combined nearby list (server fixtures + residents) and the nearby residents alone. |
| `view` / `refusal` / `confirmed` / `busy` / `suspendsShortcuts` | Read-only state getters. |
| `setWorld(id)` / `setAgent(id)` / `setPosition(tile)` / `setResidents(list)` / `setKeys(list)` | Update the inputs as the resident moves or the world changes. |
| `paint(document, { promptHost, overlayHost })` | Paints the prompt and any overlay into hosts the caller supplies, using the module's own DOM painters. |
| `reset()` | Clears the view, focus, overlay, refusal and intent. |

### 2.2 The injected transport

```js
const transport = {
  async interactRead(query)          { /* GET  /api/v1/interact?... -> the server's view; throw {status,body} */ },
  async interactWrite(payload, key)  { /* POST /api/v1/interact, Idempotency-Key: key; throw {status,body} */ },
  async sendMessage(payload)         { /* POST /api/v1/messages — nearby residents only */ },
};
```

`query` carries only the fields the caller has: `{ world_id, x?, y?, agent_id? }`. A refusal must be
thrown as an `Error` carrying `{ status, body }`, where `body` is the server's refusal JSON
(`error`, `hint`, `next_step`). The component never inspects the route strings — this is the only
place that knows them, and it is the integration owner's, not the module's.

### 2.3 Pure helpers (exported, unit-tested directly)

| Export | Purpose |
|---|---|
| `INTERACTION_KEYS`, `DISMISS_KEY`, `CYCLE_KEYS`, `RESIDENT_NEARBY`, `NEARBY_LIMIT`, `COALESCE_MS` | The keyboard and discovery contract. |
| `FIXTURE_KEYBOARD` | Per fixture kind: the server action, the route, the overlay, the label. |
| `keyboardMap()` | The keyboard map as a data table (asserted in the tests). |
| `keyIntent(key, { focused, overlayOpen, keys })` | What one key press asks for, or `null` when the key is not ours. |
| `optionValue` / `defaultChoice` / `payloadFor` / `messagePayload` | Build the intent from the server's own fixture description. |
| `nearbyEntries(view, residents, { limit })` | Combine the server's fixtures with the caller's residents. |
| `promptModel` / `overlayModel` / `refusalModel` / `confirmationMessage` | The view models. |
| `paintPrompt(host, model, { document })` / `paintOverlay(host, model, options)` | The accessible DOM painters. |

## 3. Fixtures covered, and the server source of each

Every fixture is resolved by the server, never by the client. The component's `FIXTURE_KEYBOARD` maps
each **server kind** to the action the server already owns.

| Fixture | Server kind | Server source (fixture → action) | Runtime scope | Overlay? |
|---|---|---|---|---|
| Door | `door` | `src/spaces.js` `interactionFixtures` (`:90`) reads the authored portal → `POST /api/v1/agents/:id/travel` (`src/spaces.js:606`) | `move` | no — acts directly |
| Crop patch | `crop_patch` | a `farm` object / authored farm tile (`interactionScenery`, `src/spaces.js:79`) → `POST /api/v1/journey/garden` (`src/spaces.js:607`) | `build` | **activity** (plant / tend / harvest) |
| Bench | `bench` | a `bench` object / authored bench tile → `POST /api/v1/agents/:id/posture` (`src/spaces.js:608`) | `move` | no — acts directly |
| Crafting station | `crafting_station` | a `workbench` (`src/spaces.js:82`) → `POST /api/v1/journey/craft` (`src/spaces.js:609`) | `build` | **activity** (recipe choice) |
| Country ambassador desk | `ambassador_desk` | an `npc_ambassadors` stand, or an `npc_mayors` guide stand (`src/spaces.js:95-96`) → `POST /api/v1/ambassadors/talk` (`src/spaces.js:616-618`) | `chat` | **conversation** (typed question) |
| Nearby resident | `resident` | the world payload's participants — **not** a server fixture; the action is `POST /api/v1/messages` (`src/platform.js:276`), the shipped `nearby` channel | `chat` | **conversation** (nearby message) |

The five server fixtures are exactly those `GET /interact` returns in `fixture` and `nearby`
(`docs/API.md:253-259`). The resident is the component's own addition, and it is honest about it: it
is read from the published participant list, and its action is the world's existing nearby channel.

## 4. The prompt — a small, readable, accessible line

`promptModel(view, { focused, focusKind, keys, refusal })` returns the model the integration owner
renders. It carries:

- `text` — the **server's own `hint`**, verbatim. The hint already names the fixture, the available
  interaction, the requirement ("Manhattan distance 1") and the measured distance
  (`src/spaces.js:174`, `docs/API.md:267`). Nothing is composed in the client.
- `role: 'status'`, `ariaLive: 'polite'`, `ariaAtomic`, `tabIndex: 0` — a focusable live region.
  A refusal flips it to `role: 'alert'` with `aria-live: 'assertive'`.
- `placement` — `{ anchor: 'aim', offset, pointerEvents: 'none', maxLines: 1 }`. The prompt is
  positioned near the aim/focus and never intercepts pointer events, so it does not cover the world.
- `keys` — the interaction keys, so the prompt names the key that actually works.

`paintPrompt(host, model, { document })` creates a `<p id="interaction-prompt" role="status"
aria-live="polite" aria-atomic="true" tabindex="0">` and sets its **`textContent`** — the module never
injects markup (asserted in `tests/interaction-prompt.test.js` with an injected fake document, and by
a source scan for `innerHTML`). This is the same accessibility shape the shipped aim line uses
(`app.js:721`, `src/camera-controls.js:97-113`, `docs/specs/world-hud.md:129-139`).

## 5. Compact overlays for conversations and activities

`overlayModel(source, { resident, keys })` returns a non-modal overlay model:

| Property | Value | Why |
|---|---|---|
| `kind` | `conversation` (ambassador desk, resident) or `activity` (crop patch, crafting station) | The two overlay shapes the goal names. |
| `role` / `ariaModal` | `dialog` / `false` | The integration owner must **not** call `showModal()` and must not trap focus. |
| `dismissKeys` | `['Escape']` | Escape always dismisses. |
| `dismiss` | `{ label: 'Close', keys: ['Escape'] }` | An explicit, pointer-reachable control as well. |
| `focus` | `{ initial: 'first-control', returnTo: 'prompt' }` | Focus moves in on open and back to the prompt on dismiss. |
| `suspendsShortcuts` | `true` | While open, the world keyboard stands down (`keyIntent` returns an overlay intent for every key). |
| `controls` | labelled `choice` (crop action / recipe), `text` (question / nearby message) and `submit` | Every control is a labelled field or a labelled submit — the overlay is keyboard-completable. |
| `note` | resident overlays only | States the server's own rule: a nearby message reaches every active resident within three tiles. |

`paintOverlay(host, model, { document, refusal, onDismiss, onSubmit })` paints a non-modal
`<section role="dialog" aria-modal="false">` with a labelled title, a labelled Close button, the
labelled fields and a `role="alert"` refusal region. It handles its own `submit` and `click` events.

## 6. Refusals explain the next usable step

The server classifies every refusal and returns `hint` + `next_step` (`src/spaces.js:191-215`,
`src/spaces.js:575-600`, `docs/API.md:278`). `refusalModel(error, source)` renders exactly that,
with `accomplished: false`. The classes the tests assert:

| Class | Server term | What the next step names |
|---|---|---|
| Out of range | `blocked_by: 'out_of_range'` / 409 | How to approach: "Step onto or beside `x, y` — within 1 tile of it". |
| Paused / revoked | `blocked_by: 'paused' \| 'revoked'` / 403 | The resident's state and how to resume it in *My characters*. |
| Wrong owner | 403 from the garden rules | Who owns the garden: "… is in `alice avatar`'s garden …". Surfaced in the prompt **before** the action, through the server's `cropOwnershipNote` (`src/spaces.js:144-151`). |
| Missing prerequisite | 409 from craft / garden | What to get: "… still needs 2 more herbs and 1 more fiber". |
| Another world / visitor | `another_world` / `inspect_only` | Where the resident is, or that a visitor may only inspect. |

The component renders the server's own wording and never substitutes its own.

## 7. Keyboard map — every interaction has a key

`keyboardMap()` is the assertion surface, and the tests pin it:

| Fixture | Action | Keys | Overlay path |
|---|---|---|---|
| Door | `travel` | Enter, Space, `i` | none — the key performs the action |
| Crop patch | `garden` | Enter, Space, `i` | opens the activity overlay; arrows choose the crop action, Enter submits |
| Bench | `posture` | Enter, Space, `i` | none — the key performs the action |
| Crafting station | `craft` | Enter, Space, `i` | opens the activity overlay; arrows choose the recipe, Enter submits |
| Ambassador desk | `talk` | Enter, Space, `i` | opens the conversation overlay; type the question, Enter submits |
| Nearby resident | `message` | Enter, Space, `i` | opens the conversation overlay; type the message, Enter submits |

`keyIntent` also maps `ArrowDown` / `ArrowUp` to focus cycling, and `Escape` to dismissal. Every key
that is not one of those returns `null`, so **walking, turning and the frontier block palette keep
their shipped meaning untouched** (`src/camera-controls.js:20-25,35-47`; asserted in
`tests/interaction-prompt.test.js`). These keys are the component's own defaults and can be replaced
through the injected `keys` option, so a parallel UI owner can change them without editing this file.

## 8. Server authority and one gesture, one write

Three layers, in order:

1. **Single flight.** A second activation while a request is in flight joins the first; the tests
   assert one `interactWrite` for two synchronous activations.
2. **One gesture, one `Idempotency-Key`.** A repeat of the same intent inside the coalescing window
   (700 ms by default) sends the *same* key; the server replays the recorded response with
   `replay: true` and writes nothing.
3. **The server's own replay ledger.** `POST /interact` keeps a bounded ledger and keeps each world
   action's own throttle on top (`src/spaces.js:251-258`, `:560-570`, `docs/API.md:276`).

## 9. Wiring steps for the integration owner (task 38)

This module imports **no** other UI file and does not touch `camera-controls.js`, `game-input.js`,
`build-interface.js`, `inventory-panel.js`, `spectator.js` or `touch-controls.js`. To wire it:

1. **Serve the module.** Add to the static file list in `server.js` (beside `files.set('/src/footprints.js', …)`, line 77):
   ```js
   files.set('/src/ui/interaction-prompt.js', ['src/ui/interaction-prompt.js', 'text/javascript; charset=utf-8']);
   ```
2. **Import it** in `app.js`:
   ```js
   import { createInteractionPrompt, confirmationMessage, paintPrompt, paintOverlay } from './src/ui/interaction-prompt.js';
   ```
3. **Build the transport** from the shipped `api()` helper:
   ```js
   const transport = {
     interactRead: (query) => api(`/interact?${new URLSearchParams(query)}`),
     interactWrite: (payload, key) => api('/interact', 'POST', payload, false, key),
     sendMessage: (payload) => api('/messages', 'POST', { ...payload, world_id: currentWorldId() }),
   };
   ```
   `api()` already throws an error carrying `.body` for a refusal; pass `error.status` and
   `error.body` through (the transport contract expects `{ status, body }`).
4. **Create the controller** when a world is selected, and update it as the resident moves:
   `setPosition({ x, y })`, `setResidents(world.participants.filter(p => p.id !== selected))`,
   `setWorld(currentWorldId())`, `setAgent(viewedAgent()?.id)`.
5. **Read on approach.** Call `approach()` after a move (or `refresh({ x, y })` on an aim/click). The
   read writes nothing and is a public GET.
6. **Paint** into two hosts — one beside the aim line for the prompt, one for overlays:
   `controller.paint(document, { promptHost, overlayHost })`.
7. **Route the input.** Feed key events to `controller.handleKey(key)`. When it returns a non-null
   intent, call `event.preventDefault()` and **do not** pass the key to the world handler; when it
   returns `null`, the world keyboard keeps the key. While `controller.suspendsShortcuts` is true the
   world's own `keydown` handler must stand down (the same way it does for `dialog[open]`,
   `app.js:1110`).
8. **Announce confirmations** with `confirmationMessage(controller.confirmed)` and paint refusals from
   `controller.refusal` (the overlay painter already renders the refusal region).
9. **CSS contract** (task 38 owns the stylesheets): the prompt host anchors near the aim line with
   `pointer-events: none`; the overlay reuses the existing `dialog`/`aside` treatment. The model's
   `placement` and `dismiss` fields name everything the styling needs.

## 10. Migration and rollback

**No schema change.** The component stores nothing: it reads `GET /interact` and writes only through
the actions the world already owned (travel, `journey_crops`, `journey_inventory`,
`journey_profiles`, `agents.posture`, `ambassador_conversations`, `messages`, `audit`). There is no
new table, column, index, trigger, view or `PRAGMA user_version` value — the database stays at
**schema 21**. A rollback is a checkout of the base commit, or deleting the new module, its two test
files and this document; because the module is unimported by any shipped file, removing it changes
nothing that shipped before.

## 11. Limitations and residual risks

- **No browser check.** The acceptance browser suite (`npm run browser`) cannot gain a scenario
  without `app.js`, which is not this task's file. The component is verified by module tests and by
  HTTP tests against the real server routes; a real-browser click-through remains for task 38.
- **The syntax gate does not list the new file.** `npm run check` checks a fixed list in
  `package.json`, and that file is not this task's to edit. The module is checked directly with
  `node --check src/ui/interaction-prompt.js` and is exercised by `npm test`. Whoever owns
  `package.json` should add it to the gate.
- **The component is not yet reachable from the shipped UI.** Until task 38 wires it, it is a
  library with tests, not a visible surface.
- **A resident message is the nearby channel.** `POST /messages` with `channel: 'nearby'` reaches
  every active resident within three tiles (`src/platform.js:294`), not only the one approached; the
  overlay's `note` says so rather than implying a private line.
- **A resident conversation has no idempotency key.** `/messages` is not in the shipped idempotency
  list, so a rapid repeat is bounded by the world's own 1.5-second per-account message throttle, not
  by the interaction ledger. The test asserts the throttle is the bound.
- **No live position feed.** Discovery re-reads only when the integration owner calls `approach()` or
  `refresh()` after a move; the component does not poll. A stale prompt between moves is possible if
  the owner does not re-read, and is the owner's responsibility.
- **Distance is the server's.** The component defaults nothing about distance: the prompt's
  requirement text and the write's `409` both come from the server, and `required_distance` is read
  from the payload, never hard-coded.
