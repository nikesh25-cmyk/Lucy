# Observation mode — a public spectator view

**Task 36. Module tests only; no browser check was performed by this task.**

Observation mode lets anyone look at the shared world **without an account**. It is implemented as one
dedicated component, `src/ui/spectator.js`, which this task owns. It is not yet wired into the game
shell: that is task 38's job, and the exact steps are in [Wiring](#wiring-the-integration-owner-must-do)
below.

The design rule is simple and repeated everywhere in the component: **the server is the authority**.
The component reads only what the server already answers without a session, renders only fields the
server returned, and refuses — locally, before a request is made — anything that would change a world
or act for a resident.

## What observation is, and is not

| Observation **is** | Observation **is not** |
| --- | --- |
| Reading a public world and the public world directory | Playing as a character |
| Moving a read-only camera inside the world the server sent | Writing progress, coins, land or objects |
| Following a resident the server reports in that world | Controlling, steering or speaking as that resident |
| Choosing a public place from the public world list | Opening a private garden or another operator's home |
| Seeing public conversation | Reading private, nearby or mission conversation, or any resident memory |

## The component API

`src/ui/spectator.js` exports:

| Export | Purpose |
| --- | --- |
| `createSpectatorView(options)` | The component. |
| `createReadonlyTransport({ fetch, base, allow })` | A transport that can only issue the allow-listed public `GET`s. It records every read it performs. |
| `createSpectatorCamera(initial)` | The observer camera (pan, turn, follow). It never issues a request. |
| `SPECTATOR_STATUS` | `connected` · `reconnecting` · `from-snapshot`. |
| `SPECTATOR_READS` | The allow-list: `['/worlds', '/world']`. |
| `SPECTATOR_WRITE_RULE` | The one refusal an observer meets when it asks for a write. |
| `spectatorRefusal`, `spectatorRefusalFor` | Build a refusal, or turn a server error into one. |
| `spectatorStep`, `spectatorFacingLabel`, `wrapFacing` | Camera maths (see [the duplication note](#camera-duplication-note)). |

### `createSpectatorView(options)`

| Option | Meaning |
| --- | --- |
| `read(path, params)` | **Required.** A read-only transport, normally `createReadonlyTransport({fetch}).get`. |
| `subscribe(worldId, handlers)` | Optional. The task-16 live channel, injected only when a session exists. Returns `{close}`. Handlers: `onReady`, `onFrame`, `onClosed(reason)`, `onError(error)`. |
| `world` | The world to open first. Default `'commons'`. |
| `start` | The arrival tile to place the camera on. Otherwise the view centres on the window the server sent. |
| `camera` / `cameraStart` / `cameraMath` | Replace the camera, its start state, or the duplicated camera helpers. |
| `now` | A clock, for testability. |

Methods:

| Method | Returns | Notes |
| --- | --- | --- |
| `open(worldId)` | `{ok, snapshot, status, camera}` or a refusal | Reads `/world`. A private or missing world is a refusal with the server's sentence; it never blanks a view the observer already had. |
| `worldList({q,limit,offset})` | `{ok, worlds, total, has_more, shared_count}` | Reads `/worlds`; a private garden is filtered out even if the server were to return it. |
| `follow(residentId)` | `{ok, following, camera}` or a refusal (`resident_not_visible`) | Only a resident the current snapshot reports can be followed. |
| `intent(action)` | varies | The single interface entry point. See the intent table below. |
| `applyFrame(frame)` | `{ok, frames}` or a refusal | Applies one live frame; only public keys and fields are kept. |
| `lose(reason)` | the new status | Drops the feed and says so. |
| `recover()` | `{ok, snapshot, status, camera}` | Re-reads the authoritative world and reopens the feed. |
| `status()` | `{state, world, at, live, reason, detail}` | The visible status line. |
| `snapshot()` | the public view model or `null` | Public fields only. |
| `camera()`, `target()`, `facing()`, `following()` | camera state | Read-only. |
| `frames()`, `streams()`, `lastRefusal()`, `worldId()`, `anonymous` | diagnostics | `anonymous` is true when no `subscribe` was injected. |
| `close()` | the status | Ends observation. |

Intents accepted by `intent(action)`:

| `kind` | Effect |
| --- | --- |
| `observe`, `choose-location` | Read a public world (`/world`). |
| `world-list` | Read the public directory (`/worlds`). |
| `pan`, `turn`, `unfollow`, `set-mode` | Move the read-only camera. No request. |
| `follow` | Target a visible resident. No request. |
| `recover` | Re-read the world and reopen the feed. |
| anything else (`build`, `move`, `chat`, `interact`, `travel`, `memory`, `write`, …) | **Refused** with `SPECTATOR_WRITE_RULE`, and no request is ever made. |

### The connection status is honest

| State | When | What the line says |
| --- | --- | --- |
| `connected` | The live channel reported `ready`. | Live: the world feed is open. |
| `reconnecting` | The channel was open and dropped (`buffer_overflow`, `access_revoked`, `session_revoked`, a stream error), or recovery reopened it and it is not ready yet. | The live feed stopped (reason). Showing the last confirmed snapshot while reconnecting. |
| `from-snapshot` | There is no live channel at all: a visitor with no session, or a refused subscription. | No live feed without a session; showing the last public snapshot. |

A lost feed never freezes the view silently: the last authoritative snapshot stays on screen, the
reason is named, and `recover()` re-reads `GET /world` so the view is a fresh server snapshot rather
than a guess.

## What an anonymous visitor may read — with the server evidence

Everything an observer needs is already public. No route was added by this task.

| Read | Server evidence |
| --- | --- |
| `GET /world?world_id=…` | `publicRoute` (`server.js:472`) includes `/world` for `GET`, so a session-less caller is served as an anonymous actor (`server.js:475`). `platform.world()` then returns only what an anonymous reader may see: public conversation in that world, avatars in the window, saved objects, portals and counts. |
| `GET /worlds` | `/worlds` is in the same `publicRoute` list; `worldList()` (`src/spaces.js:308`) lists the thirty shared worlds and only **public** homes for an anonymous caller. |
| `POST` of any kind | Not public: every write route needs a credential. `/move`, `/agents/:id/look`, `/agents/:id/build`, `/agents/:id/travel`, `/interact`, `/messages`, `/frontier/build` and `/memory/propose` all answer `401 {"error":"Authentication required."}` without a session, and a browser write without the same `Origin` is refused with `403` even earlier (`src/hosting.js`, `validateRequestOrigin`). |
| `GET /memory`, `GET /journey`, `GET /drafts`, `GET /export`, `GET /me` | Not public: `401` for an anonymous caller. None is in `SPECTATOR_READS`, so the component cannot even ask. |
| `GET /events` (the live channel) | **Authenticated only.** `server.js:442` refuses a caller with no credential with `401 {"error":"Sign in to subscribe to world events."}`. |

### What a visitor with no account can and cannot see

**Can see:** the public world it chooses (avatars in the viewport, saved objects, portals, public
conversation in that world, the day phase), and the public world directory.

**Cannot see:** private and nearby conversation; any resident's memory; private journals, inventories
and drafts; account data; another operator's home. Cannot hold the live push channel — an anonymous
visitor observes from repeated authoritative snapshots, which is exactly what the `from-snapshot`
status says.

**A gap worth reporting, not patching here.** The task-16 live channel authenticates every
subscription, so there is no anonymous push path today. Making the channel public for public worlds
would be a server change (a route/permission decision) and this task was told not to add one. The
component therefore treats honesty as the requirement: it reports `from-snapshot` for an anonymous
visitor instead of pretending to be live. The integration owner can decide whether to widen the
channel later; the component needs no change to accept it (inject `subscribe` whenever a session
exists).

## Privacy assertions

The privacy behaviour is asserted, not asserted-in-prose:

- `tests/spectator.test.js` builds a `/world` payload containing a private message and an operator
  field, then asserts the view model keeps **no** `recipients`, `mission_id`, `account_id`, `memory`,
  `facts`, `proposals`, `journal`, `bio`, `email`, `token` or `credential` key anywhere, and that a
  live frame carrying a `private` message or an `operator_id` cannot smuggle one in either.
- `tests/spectator-http.test.js` writes a real private conversation and a real resident memory fact,
  then reads the public world anonymously: **the raw response text** contains neither the private
  message nor the memory value, and does not contain `"recipients"` at all. `GET /memory` and
  `GET /journey` answer `401` for the anonymous caller, and the component's transport refuses `/memory`
  locally with `read_not_allowed` before a request leaves.
- A private garden is refused with the server's own sentence (`This garden is private.`) and never
  appears in the public directory — asserted over real HTTP by making a garden private and re-reading
  `/worlds`.

## The no-write proof

Observation cannot write, and that is shown two ways:

1. **Locally.** `createReadonlyTransport` has no `post`, `put` or `delete` and can only issue the
   allow-listed `GET`s; `intent()` refuses every write-ish kind with `SPECTATOR_WRITE_RULE` before
   touching the transport. `tests/spectator.test.js` drives the whole public surface and then asserts
   every recorded request is an allow-listed `GET`.
2. **At the server.** `tests/spectator-http.test.js` sends eight anonymous writes (step, look, build,
   travel, interact, message, frontier block, memory proposal). Each is refused, and afterwards the
   resident's tile, the message count, the object count, the block count and the audit chain length
   are all unchanged — a refused observer leaves no trace of a write.

## Camera duplication note

`src/camera-controls.js` is owned by a parallel task, so `src/ui/spectator.js` **does not edit or
import it**. Instead it re-implements exactly two of that file's pure helpers:

| In `src/ui/spectator.js` | Duplicates | Behaviour kept identical |
| --- | --- | --- |
| `spectatorStep(direction, yaw)` | `cameraWalkDirection` (`src/camera-controls.js:4`) | first-person view-relative cardinal step; throws `TypeError` on a non-cardinal or non-finite yaw |
| `spectatorFacingLabel(yaw)` | `facingLabel` (`src/camera-controls.js:83`) | the eight-point compass, `north` at yaw 0 |
| `wrapFacing(value)` | `wrapFacing` in `app.js:340` | wraps a facing into `[-π, π]` |

`tests/spectator.test.js` asserts the copies agree with the first-person walking rule on all four
sides of the world and on wrapped yaw.

**Dedupe at integration:** pass the real helpers in, and delete the copies:

```js
import { cameraWalkDirection, facingLabel } from '../camera-controls.js';
createSpectatorView({ ..., cameraMath: { step: cameraWalkDirection, facingLabel } });
```

Nothing else in the module depends on the duplicated code, so this is a self-contained change.

## Wiring the integration owner must do

Task 38 owns the shell. The component needs:

1. **Serve the module.** Add `src/ui/spectator.js` to the static `files` map in `server.js`
   (`server.js:33`), as `['/src/ui/spectator.js', ['src/ui/spectator.js', 'text/javascript; charset=utf-8']]`.
   `server.js` is not owned by this task, so this line is left for the integrator. Without it the
   module is not reachable from the browser.
2. **Open it from the Observe control.** `observeWorld()` (`app.js:462`) currently re-uses the ordinary
   world view. Replace its body with:
   ```js
   const transport = createReadonlyTransport({ fetch: (path) => fetch(path) }); // same-origin, no credential needed
   const spectator = createSpectatorView({
     read: transport.get,
     start: getWorldDefinition(id).start,           // the arrival tile the map already knows
     subscribe: state.account ? subscribeLive : undefined,  // task-16 SSE only when signed in
   });
   await spectator.open('commons');
   ```
3. **Feed the camera.** The renderer already accepts a target and facing:
   `renderer.render(snapshot, { position: spectator.target(), facing: spectator.camera() })`, driven by
   `pan`/`turn`/`follow` intents in the key and pointer handlers. The voxel renderer's own
   `rotate`/`zoom`/`setOrbit` are presentation; the component's camera is what the interface should
   read for the aim line and the follow target.
4. **Subscribe only with a session.** `GET /events` is authenticated. Build `subscribeLive` from
   `EventSource` exactly as `syncEventStream()` (`app.js:234`) already does, and pass it only when
   `state.account` exists; otherwise leave `subscribe` undefined and the component will honestly show
   `from-snapshot`.
5. **Show the status and the refusal.** Render `status().detail` in a `role="status"` live region, and
   `lastRefusal().message`/`.hint`/`.next_step` as a `role="alert"` line. A refusal names its rule and
   the next step, matching the interaction route's contract (`docs/API.md:278`).
6. **Do not add a write path.** Nothing in the interface for observation may call a `POST`.

## Limitations and residual risks

- **No browser check.** This task ran module and HTTP tests only. `npm run browser` was **not** run,
  because no scenario could be added without editing `app.js`, which is not owned here. No visual or
  keyboard-interaction claim is made.
- **No anonymous live feed.** The task-16 channel is authenticated; an anonymous visitor sees
  snapshots. This is a server-level gap, reported rather than patched.
- **Camera duplication is real until integrated.** The duplicated helpers are asserted equal in
  behaviour but are still two copies.
- **The `from-snapshot` fallback polls.** The component does not schedule polls itself; the integrator
  must keep the shipped three-second poll (or an equivalent) while status is `from-snapshot`. The
  module exposes `open()`/`recover()` for that purpose.
- **The public payload is bounded by the server**, not by the component: the viewport is what
  `GET /world` returns, and public chat is the last 200 messages. Following a resident who walks out of
  the returned window ends the follow (the frame removes them), not a wider read.
- **Atmosphere/phase is passed through** as the server sent it (`worldAtmosphere`); the component does
  not derive lighting.
- **Resident `operator` and `operator_id` are dropped** from the view model. They are not needed to
  observe, and dropping them is a deliberate part of the privacy posture. If the shell needs the
  operator name for a label, that is an explicit, reviewable change to `PUBLIC_RESIDENT_FIELDS`.

## Migration and rollback

**No schema change.** This task adds no table, column, index, trigger or migration; `src/database.js`
and `src/recovery.js` are untouched. The schema stays where the branch left it.

Rollback is a plain revert of the source. The component is additive: no existing file was modified
except this task's own new files, so removing `src/ui/spectator.js`, `tests/spectator*.test.js` and the
two documents returns the tree to its baseline with nothing to undo — no stored state, no background
job, no credential and no configuration to reset.
