# Task — multiplayer soak and reconnect resilience

Branch `task-deepseek-multiplayer-soak`, based on `codex/final-integration` @ `70359d0`.
Schema unchanged at **version 22**: this slice adds no table, column, trigger, migration or route.
**No file under `src/`, no `server.js`, no client asset and no `package.json` script was changed.**

## Goal

Build a repeatable soak harness that starts the shipped server against a temporary database and drives
many concurrent authenticated clients through the real HTTP and Server-Sent Events surface — connect,
move, build, chat, observe, disconnect, reconnect — while measuring ordered event delivery,
missed/duplicate frames, reconnect-from-snapshot correctness and server write load; hunt for a real
defect in that layer; pin the behaviour with tests; and report honest measured limits with no
supported-user or MMO claim.

## Changed files

| File | Change |
| --- | --- |
| `scripts/multiplayer-soak.mjs` | Rewritten from the two-client convergence probe into the soak harness. Still spawns the shipped `server.js` as a child process against a disposable database and still refuses an inherited `LUCY_DATABASE`; now seeds 16–32 fictional accounts, opens up to the documented 64 subscriptions, drives concurrent writers, reconnects part of the subscriber set mid-run, builds in a garden with an observer away, restarts the process, probes the process ceiling on real sockets, and prints a JSON report. Exports the client, the ordering oracle and the percentile helper for tests. |
| `tests/multiplayer-soak.test.js` | New. The soak's invariants at test scale, over the real HTTP/SSE surface, plus one `todo` case pinning the defect below. |
| `docs/PERFORMANCE.md` | New last section with the measured numbers, the defect and the limits; one `Not measured` bullet corrected (it said "no soak test"); the harness added to the instrument table and the reproduce block. |
| `docs/handoff/task-deepseek-multiplayer-soak.md` | This report. |

`tests/realtime-*.js` was deliberately left alone: the new invariants are pinned in the new
`multiplayer-*` file so the channel's existing cases keep their original meaning.

## What was tested

Harness assertions in `scripts/multiplayer-soak.mjs` (a run exits non-zero on any of them):

- every subscribed client opens its stream, is admitted with 200, receives `ready`, and its first
  `/world` snapshot contains the whole avatar cluster;
- every accepted public message reaches **every** open subscriber **exactly once, in stored insert
  order** (`ORDER BY rowid`, the order the channel publishes in, because the publish happens inside the
  same synchronous handler as the insert);
- no client ever observes an avatar tile the server had already superseded: each client's per-avatar
  tile history must be a subsequence of the accepted write order for that avatar;
- after quiescence every open subscriber's last observed tile equals the stored `agents` row;
- a subscriber that reconnected mid-write is live again, and a client rebuilding from `/world` holds
  exactly the stored garden `world_objects` rows and their types;
- a full process restart leaves `agents` and `world_objects` byte-identical, and the restarted process
  still streams;
- the process admits exactly 64 subscriptions and answers 503 to the 65th, leaving the admitted ones
  streaming.

Tests in `tests/multiplayer-soak.test.js` — names, and the database assertion each one makes:

| Test | Database assertion |
| --- | --- |
| `many concurrent subscribers receive every public message once, in the stored order` | 16 subscribers; 9 messages across 4 accounts; the stored id list (`messages … ORDER BY rowid`) is compared index-for-index with what each subscriber's frame stream delivered, and duplicates/foreign-world frames must be 0. |
| `no subscriber observes an avatar tile the server has already superseded` | 2 walkers, 4 witnesses; the per-walker accepted sequence is compared against each witness's tile history, and each witness's final tile is compared with `SELECT x,y FROM agents`. |
| `a reconnecting client is rebuilt from the snapshot and goes live again` | the avatar really moved while the client was away (`SELECT x,y FROM agents` equals the second missed step); the reconnected client's rebuilt view equals that row, then a further step is delivered live. |
| `the soak client holds the documented limits, not a test-only override` | none (it pins the harness constants: 145 ms pace, 512-frame client buffer, 64-subscription ceiling). |
| `a forced relocation publishes no delta yet, so the destination world never learns of it` (`todo`) | the visitor's stored row moves to `commons` and the Commons subscriber must receive that arrival. **Fails today** — see the defect below. |

## Gate output (real, on this machine)

Hardware: **Apple M5, 10 cores, 16 GiB, macOS 26.6.2 (25G83), Node v24.19.0** (`../node-bin/node`),
one HTTP process, one SQLite writer, loopback only, temporary databases throughout.

| Gate | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | exit 0 |
| Unit suite | `node --test` | **893 tests, 891 pass, 1 fail, 1 todo, 0 skipped** — 113.9 s on a quiet machine, 214.1 s on a busy one, identical counts |
| HTTP acceptance | `npm run e2e` | **17 steps passed, 0 failed**, exit 0 |
| New file, focused | `node --test tests/multiplayer-soak.test.js` | **4 pass, 1 todo (the pinned defect failing as designed), 0 fail** in 6.7–10.2 s |

The one suite failure is **pre-existing on the base commit and not in this slice's writable set**:
`tests/mobile-styles.test.js:137` — *"no touch selector exists in the main stylesheets"* — fails because
`game-theme.css:208` contains `body.game-world.game-chat-open .nm-touch{display:none}`. `git log -S
"nm-touch" -- game-theme.css` attributes that line to the base commit `70359d0` itself, and
`game-theme.css` is on this task's never-touch list. It is unrelated to multiplayer; the owner of that
file should either move the rule into `game-mobile.css` or relax that assertion deliberately.

`npm run browser` was not run: nothing browser-visible changed (no client code, stylesheet, route or
payload shape). The harness and tests are Node-only.

## Measured soak evidence

`node scripts/multiplayer-soak.mjs --accounts 8 --duration 8000` and
`node scripts/multiplayer-soak.mjs --accounts 16 --duration 12000` (they also write
`/tmp/soak-32.json` and `/tmp/soak-64.json`). Both runs **PASS** (32 checks each, 0 failures).

| | 32 subscribers | 64 subscribers |
| --- | --- | --- |
| Writing avatars / writer accounts | 8 | 16 |
| Write phase | 8.16 s | 12.17 s |
| Row-writing requests accepted | 410 (382 steps + 28 messages) = 50.2/s | 1,251 (1,162 steps + 89 messages) = 102.8/s |
| Refused / throttled requests | 0 / 0 | 0 / 0 |
| Request latency p50 / p95 / max | 3.01 / 7.88 / 66.33 ms | 2.78 / 5.96 / 23.30 ms |
| Frames received (all clients) | 4,755 (146–150 each) | 15,020 (232–236 each) |
| Update entries received (all clients) | 13,089 | 80,016 |
| Frame delivery latency p50 / p95 / p99 / max | 1 / 2 / 8 / 48 ms | 1 / 3 / 6 / 13 ms |
| Bytes received by subscribers | 2.00 MB | 11.19 MB |
| Duplicate / foreign-world / unparsed frames | 0 / 0 / 0 | 0 / 0 / 0 |
| Missed or out-of-order observations | 0 | 0 |
| Reconnect divergences | 0 | 0 |
| Database growth over the run | +16,384 B | +28,672 B |
| Mid-phase reconnects / snapshots applied | 8 / 42 | 16 / 82 |

Server write load is reported as **row-writing requests the server accepted and committed** (one HTTP
request = at least one committed row: an `agents` step, a `messages` insert, or an `agents` expression
update), plus the database byte growth measured against the same file before the run. It is **not** a
writes-per-second capacity figure: the pace is set by the server's own throttles (120 ms per step,
1,500 ms per account per message), so 50/s and 103/s are what *this* workload could offer.

The `frame delivery latency` figures are `client receive time − the server's own frame timestamp
(frame.t)`, so they measure the coalescing interval plus loopback transfer, not an end-to-end user
round trip. Frames per client (232–236 over 12.17 s ≈ 19.4/s) are at the channel's documented 20/s cap.

## The defect found (not fixed — out of this task's writable set)

`report.defects[0]` in every soak run, `silent_relocation_on_entitlement_change`:

> `PATCH /api/v1/agents/:id/home { "visibility": "private" }` moves every visitor of that garden back
> to the Commons. `homeSettings` (`src/spaces.js`) does that with a plain `UPDATE agents SET
> world_id='commons', …` and then calls `this.events?.revalidateNow?.()` — but it never calls
> `this.events.publish(...)`. Measured on a real run: the stored row moved to `commons,10,6`,
> `GET /world?world_id=commons` listed the avatar there (`listed=true`), and a live Commons subscriber
> received **0 update frames naming that avatar** within 600 ms, still holding no entry for it. The
> visitor's own garden subscription was correctly closed with `closed{reason:"access_revoked"}`.
>
> This contradicts `docs/ARCHITECTURE.md` line 37 — *"A world mutation (a step, an arrival, a saved
> object, a frontier block, a public message) publishes a bounded delta, the channel coalesces it, and
> every subscriber of that world receives it within one frame interval."* The relocation is an arrival
> in the Commons. It is also a stale view in the other direction: a client bound to the source world
> keeps a resident the server has already moved.
>
> Impact is bounded, not permanent: `app.js` polls `GET /world` every 3 s, so the wrong view lasts one
> poll interval for a browser and indefinitely for a pure-SSE client.
>
> Suggested fix for the owner of `src/spaces.js`: after the relocation `UPDATE`, publish one `agents`
> delta per relocated visitor to the Commons world (and, as `travel` already does, to the garden), with
> the new `world_id`, `x`, `y` and `z`.

It is pinned two ways: as `report.defects` in the harness (a run still passes, because the defect is
outside this task's files) and as a `{ todo: true }` case in `tests/multiplayer-soak.test.js`, which
lands the failing assertion in `npm test`'s output without turning the suite red. Node reports it as
`⚠ … # TODO` with the full `AssertionError: the Commons subscriber must receive the relocated
resident's arrival`; flipping `todo` off is the one-line change once the fix lands. **It is not
reported as a pass.**

Two things the soak exercised and found *correct*, against the obvious suspicion:

- an account holding its four subscriptions can close one and reopen **immediately** — 12 of 12
  attempts admitted, no 429 (measured with a separate disposable probe, not the soak): the dropped
  socket is reaped before the next request is handled;
- the mid-run reconnects do not disturb the other subscribers, and a client that reconnects late
  recovers all earlier messages from the `/world` snapshot rather than from a replay.

## Residual limits (honest)

- **No supported-user, capacity or MMO claim.** 64 is the process's own documented subscription
  ceiling (`EVENT_LIMITS.max_connections`), not a number of supported users. 16 is the most writing
  avatars this harness could drive, because one avatar steps at most once per 120 ms.
- **Seconds, not hours.** Each run is 8–12 s. No memory-growth, WAL-growth, disk-exhaustion or
  multi-hour stability profile.
- **The 256-update / 64 KiB buffer bounds were not reached from real sockets.** Doing so needs more
  than 256 distinct publishing entities in one world; this workload tops out at 16 moving avatars plus
  one world's messages. Those bounds remain covered by `tests/realtime-bounds.test.js` and
  `tests/realtime-channel.test.js`, which drive the hub directly, not by this harness.
- **No hostile or stalled readers.** Every client in the soak reads normally.
- **No model throughput or model queue.** No model is configured, so no model call is made and the
  model queue is not exercised.
- **Loopback only.** No TLS, reverse proxy, packet loss or real network latency. One process, one
  SQLite writer, no horizontal scale.
- **Latency is not a user-visible round trip.** Frame latency is measured against the server's own
  `frame.t`; request latency is harness wall-clock and includes the harness's own event loop.
- **Numbers move.** The same 64-subscriber run measured frame p95 21 ms / max 81 ms while the machine
  was busy with another agent's suite, and 3 ms / 13 ms on a quiet machine. The shapes (frame counts,
  ordering results, zero duplicates, zero divergence) are stable; the milliseconds are not.

## Migration and rollback

- **Migration:** none. No schema change, no route change, no stored data change, no dependency added.
  `docs/PERFORMANCE.md`, the harness and the test file are additive. The only edit inside the existing
  document is one `Not measured` bullet that asserted "No soak test" and now describes this bounded one.
- **Rollback:** revert the commit. Nothing outside the four files listed above is affected, and no
  runtime artefact (database, backup, `.runtime/`) is written by the harness: it always creates and
  removes its own workspace under the OS temp directory, refuses an inherited `LUCY_DATABASE`, and
  prints the workspace path only when `--keep` is passed.

## How to reproduce

```sh
export PATH="../node-bin:$PATH"                       # Node v24.19.0
node --check scripts/multiplayer-soak.mjs
node --test tests/multiplayer-soak.test.js            # 4 pass, 1 todo
node scripts/multiplayer-soak.mjs --accounts 8  --duration 8000  --json /tmp/soak-32.json
node scripts/multiplayer-soak.mjs --accounts 16 --duration 12000 --json /tmp/soak-64.json
npm run check && npm run e2e && node --test
```
