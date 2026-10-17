# Harr corrective integration — 17 October 2026

## Absorbed and verified

Read `wt/PROJECT_SUMMARY.md` and checked both repositories directly. Every completed feature branch is an ancestor of `integration/all`; no extra feature cherry-picks were needed. NemoWorld base `d929aa9`; Veloren base `622dfde`. Both integration worktrees were clean before this work.

The combined content includes the peaceful village, construction/research, missions, account link, shop, pantry, atlas, cottages, resident routines, dashboard and client H panel. Some supplied content remains deliberately staged: the twelve story arcs are distinct from the guide's canonical mission catalogue. Branch ancestry is not proof that every staged feature is exposed in the game.

## Corrective changes

- Integrated the prepared relay acknowledgement and bounded-read fix, retaining per-resident filters and independent offsets. No unread-tail allocation, no advancement without a terminal result per event. Oversized records block explicitly for repair.
- Correlated command acknowledgements to a stored issued command and its player. Unknown commands and wrong players are refused. The existing five-minute clock-skew allowance also bounds pre-issuance acknowledgements; conflicting terminal outcomes are refused. `commandStatus` filters older inconsistent rows without rewriting them. No protocol format/schema change or reward authority change.
- Updated the QA alias fixture to issue an actual command. Corrected the shop simulator so a wrong-player response targets the current unanswered delivery, rather than a previously answered preflight. It now asserts ingestion refusal and retains the no-charge/no-double-delivery coverage.
- Added the coordinated encrypted recovery rehearsal previously prepared in isolation. It uses disposable databases and journal fixtures, not a second live-world restore.
- Added a versioned copy of the existing play launcher at `ops/play-local.sh`. It supports an actual villager count, defaults to eight core residents plus twelve villagers, retains `VILLAGE=all` for the full roster, generates IPv4/IPv6 loopback sockets and refuses a nonlocal unauthenticated start. Existing `VILLAGE=1` keeps its old full-roster meaning for compatibility. This file is installed as `play/play.sh`.

## Maintenance and preservation

The live server was listening on `0.0.0.0`/`[::]` despite the documented local-only promise. Actual program files already matched the latest compiled server/bridge artifacts; a running old process cannot be identified solely by hashing its overwritten executable, so the release restarts from the verified artifacts.

Stopped only 70 processes whose executable and working directory matched the Harr installation. The server's configured `SIGUSR1` shutdown performs a two-minute save countdown; it was allowed to finish, with no forced kill. Other AI tools, build workers and the older NemoWorld :3000 installation were left running.

The stopped databases passed SQLite integrity checks: world schema 27, link schema 1, one saved account, one avatar and 111 accepted link events at the recorded point. Per-table counts are in the private evidence directory.

Created a stopped-state archive of data, full userdata, existing Node source, server/bridge binaries and public launcher/configuration. Encrypted it using the shipped AES-256-GCM module, decrypted it into temporary staging, verified the complete plaintext hash, and removed plaintext staging. The key is stored separately owner-only under `play/secrets/`; its value is never logged. The private `rollback.json` receipt locates both files. Existing secrets are retained in place.

## Verification and remaining bounds

The unmodified combined integration suite passed 253 tests. The three new correlation cases failed before the fix and then passed. Launcher tests reproduced the count and wildcard-address defects before the fixes.

Exact final full-suite, syntax/seal, install, row-preservation and live health evidence is recorded in `work/verification/harr-integration-20261017/` under the original task root. Do not substitute the earlier failed run for the final results. The full suite's first run exposed a shop-simulator selection error; its targeted repair retained every acceptance assertion.

This work does not claim that arbitrary authenticated internet hosting is ready, all 60 residents run cheaply on this Mac, all decorative terrain is walkable, the new sky/HUD has been fully reviewed by a human, or every staged story/transport feature is enabled. The release remains local-only. GUI and live acceptance results are appended separately when actually observed.

## Verified code gates

- Full Node suite: **1,763 passed, zero failed/skipped**, 235.77 seconds, concurrency three (`full-suite-final.log`).
- Desktop packaging and local-launcher tests: **7 passed, zero failed**, including actual fixture setup and socket inspection.
- Syntax: **166 files, zero failures**; package helper additionally parsed and executed by its tests; shell launcher passes `bash -n`.
- Seal: **136 definitions**, three support files, 42 referenced notices/assets.
- Mac wrapper: `ops/package-harr-app.mjs` packages the existing compiled client as `play/Harr.app`, using the same assets and userdata. It introduces no engine build, world, account or credential. Existing app destinations are refused rather than overwritten.

## Live acceptance and follow-up

The verified release was installed across **1,640 tracked files**, preserving all stopped table counts exactly. The source install changes no schema. Database integrity passes again after restart: one account, one avatar, 111 link facts, schema 27 / link schema 1. The dashboard at `http://127.0.0.1:3100/harr` was inspected through the browser and its saved works/research/pantry/library sections were visible; a screenshot is retained in the private evidence folder.

One actual restart issue was caught: this shell inherited `RUST_LOG=warn`, hiding the CLI readiness line while the server was already ticking. A read-only process sample confirmed the server's game loop. The launcher now explicitly enables the CLI readiness log; a disposable end-to-end launcher fixture verifies this even under a warning-only parent environment. Its first short fixture polling window raced process startup; the fixture now waits a bounded period for its fake child (the production 300-second limit was not loosened).

The existing server was retained and its residents/relays resumed using their existing scoped credentials. All eight core residents/relays and twelve additional villagers are up; resident bridge ticks are six per second, separate from the engine's simulation. Local inference is disabled in this light run, so dialogue uses the labelled scripted fallback. Future starts default to twelve additional villagers; `VILLAGE=all` requests the full set.

Socket inspection confirms TCP `127.0.0.1:14004`, TCP `[::1]:14004`, UDP `127.0.0.1:14006`, and Node `127.0.0.1:3100`. No wildcard game listener remains.

The Mac application registered successfully and its actual main menu was captured/inspected. Native window control was interrupted before Multiplayer could be entered reliably, so **no in-world GUI, H-panel or mouse-building pass is claimed**. The broader visual/terrain review in the supplied summary remains pending. The client wrapper uses the same assets and userdata; it does not create a second game or require new credentials.

Follow-up launcher tests: **5 passed, zero failed** (including inherited logging); app packaging tests: **3 passed**. The full 1,763-test code gate preceded this shell-only logging/tick follow-up; API/relay/recovery implementation is unchanged since that full passing run. No new Rust build or full browser suite was run in this corrective integration.
