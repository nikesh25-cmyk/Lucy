# Task 16 — responsive shared-world movement and presence

Branch `task-16-realtime-presence`, based on `verify-batch02-wave-a` (base commit `0db8f7f`, the
reviewed Tasks 02–14 queue plus 01, 15, 20-brief, 24 and 27). Schema is unchanged at **version 18**;
this task adds no table, column, trigger or migration.

## What was delivered

Residents now see each other live. `GET /api/v1/events` holds one authenticated **Server-Sent Events**
subscription per client, bound to the one world that client is showing. A world mutation — a step, an
arrival, a saved garden object, a frontier block, a public message — publishes a bounded delta, the
channel coalesces it into the next frame, and every subscriber of that world receives it within one
frame interval instead of waiting for the next three-second poll.

The channel is `text/event-stream` on the existing `node:http` server. **No new production
dependency was added**: the whole thing is `node:http`, `node:crypto` and the SQLite layer the server
already had. The browser uses its built-in `EventSource`.

## Changed files

| File | Change |
| --- | --- |
| `server.js` | `EVENT_LIMITS`, `createEventHub`, the `GET /events` route, the hub's wiring to `platform.events`, the frontier build/expand deltas, the `events` counters in the administrator diagnostics, and an ordered shutdown that ends live streams before `server.close()`. |
| `src/platform.js` | `authenticate` split into `authenticate` + `authorize(hash)` so a subscription can re-check a stored credential hash without retaining the secret; new `canReadWorld`; publish hooks in `emote` and `agentControl`; public-chat publish in `message`. |
| `src/spaces.js` | Publish hooks in `stepAgent`, `travel`, `build`, `posture` and `homeSettings`. |
| `app.js` | The `EventSource` client, the presence/interpolation layer, incremental world deltas, the chat-list refresh that never touches a focused form, refused-move reconciliation, and the read-only `window.__nemoworld` introspection hook. |
| `scripts/browser-suite.mjs` | Two new scenarios (`shared-presence-two-clients`, `subscription-entitlement-and-revocation`), an `apiPatch` fixture helper and a client animation-frame sampler. |
| `tests/realtime-bounds.test.js` | New. The enforced channel bounds, proven directly against `createEventHub`. |
| `tests/realtime-channel.test.js` | New. The channel over real HTTP: authentication, entitlement, move/build/chat delivery, privacy, revocation, reconnect snapshot and both connection bounds. |
| `tests/realtime-latency.test.js` | New. The measured latency and frame-rate fixture reported below. |
| `tests/browser-suite.test.js` | One existing assertion updated: the unit test enumerates the scenario registry, so adding the two mandated scenarios changes its count from 14 to 16. No coverage was removed. This is the only file outside the task's declared ownership that was touched, and it was touched only because extending the suite (a hard requirement) changes that registry. |
| `docs/API.md` | New section 11, *Shared-world event channel*. |
| `docs/ARCHITECTURE.md` | The "toward 10,000 live agents" section now describes the shipped push path and its bounds. |

Nothing else was touched. `world.js`, `src/footprints.js`, `src/civic-engine.js`, `catalog/`,
`scripts/e2e-smoke.mjs`, `package.json`, `.github/`, `render.yaml`, `HANDOFF.md`,
`docs/VERIFICATION.md`, `docs/VOXEL_WORLD.md` and `outputs/Lucy` are unchanged.

## The channel

### One subscription, one world

```
GET /api/v1/events?world_id=commons          Cookie: world_session=…
GET /api/v1/events?world_id=home:<id>        Authorization: Bearer <operator or runtime token>
```

Frames are `ready`, `update` and `closed`, plus a `: ping` comment every 15 s. An `update` frame
carries `{ world_id, t, agents?, objects?, blocks?, messages?, refresh? }` and only the keys that have
something in them; `t` is the server's own send time, so a client can measure its own delivery
latency. `refresh: true` is used for the one change (opening a neighbouring frontier area) that the
client is expected to re-read authoritatively.

### The auth and entitlement check on every subscription

The route authenticates first and writes **no stream header until the checks pass**, so a refusal is
an ordinary JSON response:

| Condition | Answer |
| --- | --- |
| No credential | `401 {"error":"Sign in to subscribe to world events."}` |
| Malformed bearer header | `401` |
| Revoked, expired or suspended credential | `401`/`403` from the shared `authenticate` |
| A world the caller may not read (private garden, another operator's home) | `403` |
| A world identifier that is not a world | `404` |
| More than 4 subscriptions for one account | `429` |
| More than 64 subscriptions in the process | `503` |

The read check is `platform.canReadWorld`, which is the same `space()` decision `GET /world` makes,
so a subscription can never be wider than the world view. A runtime credential additionally needs the
`read` scope, exactly as `/world` does.

**The check is repeated, not just performed once.** Every subscription is re-authorized on a
`revalidate_ms` (1 s) cadence: the stored credential hash is resolved again, and the world is read
again. If either fails, the subscription is closed with a `closed` frame naming `session_revoked` or
`access_revoked`. Two server-side consequences therefore reach a client without any client request:

- revoking a session token (logout, an administrator suspending an account, a resident being paused)
  ends the feed within a second;
- a garden that has just become private ends an outsider's feed within a second, and the owning
  operator can also force it immediately (`homeSettings` calls `revalidateNow`).

**What is never published.** The hub only ever emits a *public* message for a world, and only to
subscribers of that world. `nearby`, `private` and `mission` conversations are never handed to
`publish` at all, so no bug in the delivery path can leak them. Presence, object and block deltas are
matched by `world_id`, so a subscriber of the Commons can never receive a private garden's delta.

### Enforced bounds and what happens when each is hit

Declared once in `EVENT_LIMITS` (`server.js`) and asserted by `tests/realtime-bounds.test.js`:

| Bound | Number | Behaviour at the limit |
| --- | --- | --- |
| Concurrent subscriptions per process | 64 | New subscriptions are refused with `503`; existing ones keep streaming. |
| Concurrent subscriptions per account | 4 | The next is refused with `429`. |
| Buffered updates for one slow client | 256 coalesced entries | The client is closed with `closed{reason:"buffer_overflow"}`. |
| Buffered payload bytes for one slow client | 65 536 | The client is closed with `closed{reason:"buffer_overflow"}`. |
| Update frames per client | 20 per second | Extra changes are coalesced into the next frame; nothing is dropped or invented. |
| Re-authorization interval | 1 000 ms | The longest a revoked credential can keep a private feed. |
| Heartbeat | 15 000 ms | A `: ping` comment keeps an idle connection alive. |

Coalescing is what keeps the buffer small and is the property that matters most in a crowd: five
thousand steps of one avatar between two frames collapse to **one** pending entry carrying the newest
confirmed position, so an ordinary busy world never approaches the buffer bound. A client reaches the
bound only by genuinely not reading its socket — the hub stops writing once `write()` reports
backpressure and resumes on `drain`, so Node's own unbounded stream buffer is never used as the
queue. `publish` merges and then checks both bounds; a breach closes the subscriber with an explicit
reason instead of growing memory.

`buffer_overflow` is measured, not assumed: `tests/realtime-bounds.test.js` drives a response double
whose `write` refuses, and shows that a client that falls behind by 257 distinct updates — or by one
65 KiB update — is dropped exactly once and told why.

## Interpolation and reconciliation rules

The authoritative position is always the server's. `state.world.participants` and the selected agent
hold exactly what the server stored; interpolation is a render-time transform that never writes back.

1. **Confirmed only.** Every participant the server reports is recorded by id with its confirmed
   `{x, y, z}`. The first time an avatar is seen its display equals its confirmed tile — no avatar
   ever slides in from an origin it was never at.
2. **Between two confirmed tiles.** When the confirmed tile changes, the avatar is drawn on the
   straight segment from where it is currently drawn to the new confirmed tile, over
   `DISPLAY_TWEEN_MS` = **180 ms** (just over the server's 120 ms step throttle), with a smoothstep
   ease. The interpolation parameter is clamped to `[0,1]`, so the display can never pass beyond the
   newest confirmed tile or extrapolate into a tile the server has not confirmed.
3. **Reconciliation of a refused move.** The client never moves optimistically: `moveAgent` and
   `climbAgent` apply only the server's answer. When the server refuses a step (`blocked: true`, or
   an error), `reconcilePresence` drops the tween and snaps the avatar back to its stored tile, so no
   phantom position survives. `walkTo` re-plans from the stored tile for the same reason.
4. **Convergence.** A tween always ends on the confirmed tile, so a display that stops being updated
   converges by itself; there is no drift to correct.
5. **Presentation only in the renderer.** Where the active renderer accepts a sub-tile position (the
   pixel map) the interpolated position is drawn directly. The voxel renderer places avatars on whole
   tiles by its own contract, so it receives confirmed tiles for the avatars and the interpolated
   position for the **camera target** of the local player, which is what makes the local walk glide in
   first person.

## Incremental updates without rebuilding geometry and without interrupting forms

A frame is applied in place:

- **Avatars**: the participant is upserted by id; one whose `world_id` is no longer the current world
  is removed (this is how an arrival is broadcast to both the world left and the world entered).
- **Objects and blocks**: a saved object or frontier block is upserted or removed by its tile key, so
  the renderer's cached terrain diorama is untouched and only its small block/object batch is rebuilt.
- **Chat**: only a public message is appended, de-duplicated by id and bounded to the last 200.
- **Forms**: the chat list is replaced only when the focused element is not inside a form and not
  inside the message list — the same guard the poll already used. A repaint is `paintWorld()`, never a
  full `renderView()`, so a field someone is typing in is never thrown away.
- **Unknown participants**: if a frame names a participant this client has never seen, the client
  re-reads the authoritative `GET /world` instead of drawing a half-known avatar. That is also what
  happens on every `ready`, which is why a reconnect always converges.

A read-only `window.__nemoworld` object exposes `presence()`, `stream()`, `lastClosed()`, `world()`,
`worldId()` and `selected()` for the browser acceptance suite. It reports only data the page already
renders; it exposes no credential.

## Measured latency and frame behaviour

Hardware and software, read from this machine:

- **Apple M5** (`Mac17,3`), 10 CPU cores, 16 GB memory, macOS 26.6.2 (build 25G83), arm64.
- Node **v24.19.0**.
- One server process, one SQLite writer, all traffic on loopback (`127.0.0.1`).
- Browser: **Google Chrome 155.0.8059.40** driven headless by `playwright-core` (software renderer,
  `--enable-unsafe-swiftshader`).

### Channel latency fixture (automated, `tests/realtime-latency.test.js`)

Fixture: one temporary SQLite database, one resident in the Commons, **16 concurrent subscriptions**
(4 accounts × the 4-per-account bound), 20 confirmed steps. Measured run:

```json
{"connections":16,"moves":20,"elapsed_ms":1690,"frames_total":320,
 "frames_per_client":{"min":20,"max":20},"frames_per_client_per_second":11.83,
 "latency_ms":{"min":0,"median":1,"p95":1,"max":1},
 "limits":{"frames_per_second":20,"max_connections":64}}
```

So each step reached all sixteen subscribers as **one frame each** (320 frames for 20 steps), and the
delivery latency from the server writing the frame to the fixture client reading it was **0–1 ms**
(median 1 ms, p95 1 ms). The measured per-client frame rate was ~12 frames/s, under the enforced
20/s, because each step produced its own frame.

### Two real browsers (automated, `scripts/browser-suite.mjs`)

Two isolated Chrome contexts, both subscribed to the same world, one driving the interface and the
other observed:

- A click on the mover's movement control reached **the other client's view in 490–969 ms**
  (490 ms focused; 944–969 ms in the full-suite runs under load), while the channel frame delivery
  measured in the receiving page was **0–1 ms**. The click-to-view figure is dominated by the
  client's own 160 ms motion throttle, the server round trip and the acceptance suite's polling, not
  by the channel.
- Placing a saved object in the garden reached the other client with a frame delivery latency of
  **0–1 ms**.
- Client animation-frame cadence sampled in the observing page while an interpolation ran:
  **median 16.7 ms over 28–29 animation frames, maximum 16.7–33.3 ms across runs** — a normal 60 Hz
  cadence with an occasional scheduling hiccup under the suite's own load. That is the cadence the
  presence tween rides on, not a measure of the rendered scene's cost.

### What was not measured

- **No supported-user capacity is claimed.** 16 subscriptions on one machine is a fixture, not a
  capacity figure. The architecture note is unchanged: one process and one SQLite writer are the
  constraint, and a larger deployment needs partitioned world workers and a multi-worker database.
- **No real GPU frame rate.** The browser ran headless with a software renderer; the animation-frame
  cadence above is the browser's frame clock, not the render cost of a crowded voxel scene on a
  player's GPU. No FPS claim is made for a busy world.
- **No wide-area latency.** Every measurement is loopback. No internet, mobile-network or
  cross-region latency was measured.
- **No long soak.** The channel was exercised for seconds at a time, not for hours, and no
  multi-hour connection-stability or memory-growth run was performed.
- **The 10,001-agent fixture was not re-run** for this task; the stored-population behaviour in
  `docs/PERFORMANCE.md` still describes that separate fixture.

## Tests and gates actually run

Every gate below was run on the frozen tree that this branch commits, in this order, with the exit
codes recorded:

- `npm run check` — **exit 0** (server.js, app.js, src/platform.js, src/spaces.js and
  scripts/browser-suite.mjs all parse).
- `npm test` — **exit 0, 493 tests, 493 pass, 0 fail, 0 skipped** in 57.5 s (the 23 new real-time
  tests included).
- `npm run e2e` — **exit 0, 15/15 steps pass**.
- `npm run browser` — **exit 0, 16/16 scenarios pass**, including `shared-presence-two-clients` and
  `subscription-entitlement-and-revocation`.

Every scenario passed; none is reported as failing or skipped.

Two defects found by these gates were fixed rather than worked around: `GET /events` initially
intercepted `POST /events` as well, which would have hung the community-event write (caught by the
existing `expansion-http` timeout), and the revocation scenario assumed the observing page still
showed the garden after the full suite had moved its resident, so it now asserts any live
subscription instead of a named world.

The browser suite's own teardown asserts that the shipped `data/world.sqlite` was not touched.

### What the new tests prove

`tests/realtime-bounds.test.js` (13 cases): the documented numbers are the shipped numbers; 200 rapid
updates coalesce to one frame carrying the newest state; a client never exceeds 20 frames/s; 5 000
repeats of one avatar never overflow while 257 distinct updates or one 65 KiB update do; the global
and per-account connection bounds; the heartbeat; and that a failed re-authorization or a lost world
read closes the stream with the right reason.

`tests/realtime-channel.test.js` (9 cases, real HTTP): an anonymous caller, an unentitled caller and
an invalid world are refused before a stream opens; a subscriber sees another resident's confirmed
move and the database agrees; a public message is pushed while a private and a nearby message are
never present anywhere in the received bytes; a garden turning private revokes an outsider's
subscription mid-stream; a revoked session's stream closes and receives nothing afterwards; a
reconnecting client is rebuilt from the authoritative `/world` snapshot with no divergence; a saved
object is pushed; one account cannot exceed 4 subscriptions; the process refuses the 65th.

`scripts/browser-suite.mjs` — `shared-presence-two-clients`: two real browsers subscribe, one walks
(and the other's view follows with the database agreeing), a private message never reaches the other
client while a public one does, one returns home and the other follows, and one builds an object the
other's view picks up. `subscription-entitlement-and-revocation`: a public garden streams to an
outsider, making it private closes the subscription with `access_revoked` and a direct resubscription
is refused with 403, and a session revoked mid-subscription closes the feed with `session_revoked`.

## Limitations and residual risks

- **The process-wide connection bound is per process.** 64 subscriptions are admitted by one process;
  a multi-instance deployment would need a shared or per-instance accounting decision, which was not
  built.
- **Re-authorization costs a database read per subscriber per second.** At the measured scale this is
  negligible, but a very large subscriber population on one process would make the 1 s cadence the
  dominant read load. The cadence is the lever, and it is configurable in `EVENT_LIMITS`.
- **Up to one second of private data could be delivered after a credential or permission is
  withdrawn**, bounded by `revalidate_ms`. A tighter number costs more reads. The browser test
  observed closure within a second; the write that withdraws access does not push a synchronous
  eviction for a revoke performed outside the API (a direct database edit, for example), though
  `homeSettings` does force an immediate re-check.
- **The hub re-checks the credential hash, not the account's sibling state.** A resident paused
  through `agentControl` publishes a status delta and forces a re-check, which is what closes a
  runtime subscription; a manual database edit of an agent's status would wait for the next cadence.
- **A revoked subscription ends the stream but the client keeps its session.** The receiving page
  shows an explanatory notice and its ordinary polls continue; recovery is a sign-in or a new
  subscription, not an automatic credential refresh.
- **Interpolation is sub-tile only where the renderer accepts it.** The voxel renderer places avatars
  on whole tiles by its own contract (`src/voxel-world.js` is not owned by this task), so a remote
  avatar in the 3D view steps at event latency rather than gliding; the gliding applies to the local
  camera target in 3D and to all avatars in the pixel map. Smooth remote motion in 3D needs a change
  to the renderer's participant contract.
- **Chat delivery is bounded to the last 200 messages** in client state, matching the `/world`
  bound; a client that falls far behind cannot recover older chat from the channel (a fresh
  `GET /world` returns the same 200).
- **No encryption.** The channel is plaintext over the same origin; it changes nothing about the
  documented "private means access control, not end-to-end encryption" boundary.

## Migration and rollback

**The schema did not change: it remains version 18.** No table, column, index, trigger or view was
added, and no migration is required for an existing installation. The database is only read through
the queries it already used.

Rollback is a plain revert of the source: with the channel removed, the client falls back to the
three-second poll it already had (the `EventSource` is opened only when `typeof EventSource ===
'function'`, and the poll was never removed). There is no stored state to undo, no background job to
drain, and no credential or configuration to reset. Nothing about a subscriber is persisted, so a
restart simply drops the in-memory subscriptions and clients reconnect.
