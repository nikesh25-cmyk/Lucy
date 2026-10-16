# Task 36 — public observation mode

Branch `task-36-observation-mode`, base commit `d07814d591d273d646d5e5bcb9222c3c1d1e4bac` (the
`verify-game-wave-b` tip: "Merge branch 'task-32-characters' into verify-game-wave-b"). Worktree
`work/t36`. Schema is unchanged; this task adds no table, column, trigger or migration.

**No browser check was performed.** `npm run browser` was **not** run: no scenario can be added
without `app.js`, which this task does not own. Verification is module tests plus HTTP acceptance over
the real server.

## What was asked, and what was built

Visitors can observe public activity **without creating an account**. `src/ui/spectator.js` is a
dedicated spectator component: it reads a public world, moves a read-only camera, follows a visible
resident, chooses a public location from the public world list, shows an honest connection status, and
refuses — locally and with the server's own sentence — everything an observer may not do.

| Goal | Where it is delivered |
| --- | --- |
| Camera movement, follow a resident, choose a public location — all read-only | `createSpectatorCamera` and `createSpectatorView.intent({kind:'pan'/'turn'/'follow'/'choose-location'})` |
| Observers cannot build or control residents | `createReadonlyTransport` (no write verb) + `intent()` refusing every write kind; asserted against the real server in `tests/spectator-http.test.js` |
| Private worlds, conversations and memory stay inaccessible | the view model keeps public fields only; a private target is a refusal with the server's sentence |
| Connection loss shown clearly | `SPECTATOR_STATUS` = `connected` / `reconnecting` / `from-snapshot`, with recovery from an authoritative snapshot |
| No account required | observation works with no session; the component reports what an anonymous visitor can and cannot see |

## Changed files

This task **created four files and modified none**:

| File | Change |
| --- | --- |
| `src/ui/spectator.js` | **New.** The spectator component, the read-only transport, the observer camera, the status model and the refusal shape. 407 lines. |
| `tests/spectator.test.js` | **New.** 17 module tests: camera, status transitions, refusal shape, the no-write proof, the privacy of the view model, the transport allow-list, and that a refused location never blanks a good view. |
| `tests/spectator-http.test.js` | **New.** 7 real-HTTP tests: anonymous public reads, eight refused writes with no stored effect, a private garden refusal, the public directory hiding a private garden, no private message/memory read, the authenticated-only live channel, and a full live/follow/lose/recover cycle. |
| `docs/SPECTATOR.md` | **New.** The component API, the server evidence for every allowed read, the privacy assertions, the camera-duplication note, wiring steps, limitations and rollback. |
| `docs/handoff/task-36-observation-mode.md` | **New.** This file. |

Untouched, as required: `app.js`, `index.html`, `style.css`, `nemo-theme.css`, `server.js`,
`src/spaces.js`, `src/platform.js`, `src/camera-controls.js`, `src/voxel-world.js`, `src/scene/**`,
`src/characters.js`, `content/**`, `assets/**`, `scripts/browser-suite.mjs`, `package.json`,
`.github/`, `HANDOFF.md`, `docs/VERIFICATION.md`, `outputs/Lucy`. `src/ui/` did not previously exist;
this task created it with the single module.

## Gates actually run (verbatim)

Baseline on the frozen base commit `d07814d`, in this worktree, before any change:

- `npm test` — the suite ran to completion with **one failure**, which is a load artefact and not a
  target of this task: under a machine load average above 130 (four task agents running their suites at
  once) `tests/realtime-latency.test.js` reported `8 !== 16` subscribed clients. Re-run alone it passes:
  `measured: {"connections":16,"moves":20,"elapsed_ms":1923,"frames_total":320,"frames_per_client":{"min":20,"max":20},"frames_per_client_per_second":10.4,"latency_ms":{"min":0,"median":1,"p95":7,"max":13}}`.
  The baseline total is **600 tests** as stated, and no other test failed.
- `npm run e2e` — **15/15 steps pass** (also re-run on the delivered tree below).

On the delivered tree:

- `npm run check` — **exit 0** (`server.js`, `app.js`, `src/platform.js`, `src/spaces.js`,
  `scripts/browser-suite.mjs` and the rest of the checked list all parse). **Note:** the new
  `src/ui/spectator.js` is **not** in the `check` list — `package.json` is not owned by this task. The
  module parses, shown directly with `node --check src/ui/spectator.js` (exit 0). The integration owner
  should add it to the `check` script.
- `npm test` — **exit 0**, running the whole suite:
  ```
  ℹ tests 624
  ℹ pass 624
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 149113
  ```
  624 = the 600-test baseline plus the 24 new tests in the two suites below. No baseline test was
  changed, removed or skipped.
- `npm run e2e` — **exit 0, 15 steps passed, 0 failed**:
  ```
  SUMMARY  15 steps passed, 0 failed
  ... result  PASS — the shipped server serves this scenario end to end over its own HTTP API
  ```
- `npm run browser` — **not run**, and no browser check is claimed.

### The two new suites in isolation

```
$ node --test tests/spectator.test.js
ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ duration_ms 297

$ node --test tests/spectator-http.test.js
ℹ tests 7
ℹ pass 7
ℹ fail 0
ℹ duration_ms 19174
```

## The public reads, and the server evidence

No route was added. Every read the component may make is already public:

- `GET /world` and `GET /worlds` are in `publicRoute` (`server.js:472`) for `GET`, and a session-less
  caller is resolved as an anonymous actor (`server.js:475`).
- `space(actor, id)` (`src/spaces.js:301`) refuses a private world to a caller with no right to it with
  `403 "This garden is private."`, and `worldList` (`src/spaces.js:308`) lists only public homes for an
  anonymous caller. The spectator never asks for anything else.
- `GET /events` (`server.js:442`) is **authenticated only** — `401 "Sign in to subscribe to world
  events."` for a visitor with no session. This is the one gap: there is no anonymous push path, so an
  anonymous visitor observes from `from-snapshot` reads. It is reported here rather than patched, as
  the task required, because widening the channel would be a new server behaviour.

## The privacy and no-write assertions

- **Private world → visible refusal.** Making a garden private and reading it anonymously returns
  `403 "This garden is private."`; the component turns it into `{rule:'world_is_private', message:'This
  garden is private.', next_step:…}` and sets the status line to that sentence, leaving **no** half-built
  view. A missing world is `world_not_found`.
- **No private message or memory is ever read.** A real private conversation and a real resident memory
  fact exist in the database; the anonymous `/world` **raw response text** contains neither value and
  no `"recipients"` field. `GET /memory` and `GET /journey` answer `401`; the transport refuses
  `/memory` locally with `read_not_allowed`; and the view model is asserted to carry no
  `recipients`/`memory`/`facts`/`proposals`/`journal`/`bio`/`email`/`token`/`credential` key.
- **No write, at either layer.** `createReadonlyTransport` has no write verb and can only issue the
  allow-listed `GET`s; `intent()` refuses every write kind before the transport. Over real HTTP, eight
  anonymous writes (`/move`, `/agents/:id/look`, `/agents/:id/build`, `/agents/:id/travel`, `/interact`,
  `/messages`, `/frontier/build`, `/memory/propose`) are refused, and afterwards the resident's tile,
  the message count, the object count, the block count and the audit chain length are all **unchanged**.
  A browser write with no `Origin` is refused even earlier with `403`.

## Camera duplication

`src/camera-controls.js` is owned by a parallel task, so it is neither edited nor imported here.
`spectatorStep` and `spectatorFacingLabel` are deliberate copies of `cameraWalkDirection`
(`src/camera-controls.js:4`) and `facingLabel` (`src/camera-controls.js:83`); `wrapFacing` copies
`app.js:340`. `tests/spectator.test.js` asserts the copies agree with the first-person walking rule on
all four sides and on wrapped yaw. **Dedupe at integration** by injecting the real helpers —
`createSpectatorView({ cameraMath: { step: cameraWalkDirection, facingLabel } })` — and deleting the
copies; nothing else depends on them.

## Wiring the integration owner must do

1. Serve the module: add `src/ui/spectator.js` to the static `files` map (`server.js:33`).
2. Open it from `observeWorld()` (`app.js:462`): build `createReadonlyTransport({fetch})`, then
   `createSpectatorView({read, start: getWorldDefinition(id).start, subscribe: state.account ? subscribeLive : undefined})`.
3. Feed the camera from `target()`/`camera()` into `renderer.render(...)`, and drive `pan`/`turn`/
   `follow` from the key and pointer handlers.
4. Pass `subscribe` **only when a session exists** (the channel is authenticated).
5. Render `status().detail` in a `role="status"` region and `lastRefusal()` as a `role="alert"` line.
6. Keep the shipped three-second poll while the status is `from-snapshot`.

Full detail is in [SPECTATOR.md](../SPECTATOR.md).

## Limitations and residual risks

- **No browser check.** Module and HTTP evidence only; no visual, pointer or keyboard claim.
- **No anonymous live feed** (the authenticated `GET /events`), reported not patched.
- **The camera helpers are duplicated** until the integrator injects the real pair.
- **Polling is the integrator's job**: the component does not schedule its own refreshes; it exposes
  `open()`/`recover()` for the shell's timer.
- **`operator`/`operator_id` are dropped** from the view model on purpose; a shell that needs the
  operator name must widen `PUBLIC_RESIDENT_FIELDS` explicitly.
- **Bounded by the server**: the viewport and the last 200 public messages are whatever `GET /world`
  returns. Following a resident who leaves the returned window ends the follow rather than widening a read.

## Migration and rollback

No schema change; `src/database.js` and `src/recovery.js` are untouched. Rollback is a plain revert:
the change is purely additive, so removing the four new files returns the tree to baseline with no
stored state, job, credential or configuration to reset.
