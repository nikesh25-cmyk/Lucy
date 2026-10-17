# Running Harr on this Mac: operations runbook

For the owner. Plain steps, what to expect, what to do when it goes wrong. It covers the Harr world (Veloren game server, NemoWorld and the 32 residents) as started by `play/`. The NemoWorld application itself (schema migrations, its own backups, drills) is in [OPERATIONS.md](OPERATIONS.md); hosting for other people is in [VELOREN_HOSTING.md](VELOREN_HOSTING.md).

Status of this document: it describes the proposal in `ops/` (branch `infra/main`). Nothing in `ops/` is installed yet. Every command below that starts with `ops/` becomes `play/ops/` after you copy the folder (see "Installing the proposal").

## 1. What runs

| Piece | Count | Port | Files |
|---|---|---|---|
| NemoWorld (Node, SQLite) | 1 | 3100 | `play/logs/nemo.log`, `play/data/world.sqlite`, `play/data/veloren-link.sqlite` |
| Veloren game server | 1 | 14004 game, 14005 web, 14006 query | `play/logs/server.log`, `play/userdata/server/saves`, `.../rtsim` |
| Relays (Node), one per core resident | 8 | none | `play/logs/relay-lw-*.log` |
| Residents (`nemo-bridge`): 8 core + 24 villagers | 32 | none (connect to 14004) | `play/logs/resident-lw-*.log` |
| Optional local AI model | 0 or 1 | loopback | started by NemoWorld; about 2.5 GB of weights |

Secrets are in `play/secrets` (credentials, event key). Process ids are in `play/pids`. The works record (what is built, what waits) is `play/data/veloren-outbox.jsonl.world.json`, rewritten by the game server about once a minute.

## 2. Start, stop, look

```
ops/play-next.sh preflight            check the Mac first; changes nothing
ops/play-next.sh start --dry-run      show exactly what would start (secrets are never printed)
ops/play-next.sh start                pre-flight, then staged start, then a summary
ops/play-next.sh start --lite         no local AI model and 12 villagers: for a busy Mac
ops/play-next.sh start --lite --light-stack     also half the resident tick rate and capped Node heaps
ops/play-next.sh status [--json]
ops/play-next.sh watch                one line every 30 s: load, memory, processes, works, new errors
ops/play-next.sh stop
ops/verify.sh                         smoke test of a running world (PASS/FAIL per check)
```

The old `play/play.sh start|stop|status` still works and uses the same pid and log files, so you can start with one and stop with the other. `setup`, `client`, `admin`, `logs` and `reset-world` are handed to `play.sh` unchanged.

What a start does, in order, and what it checks before the next step:

1. **Pre-flight** (see section 4). A FAIL stops the start with a plain message; `--force` overrides.
2. **NemoWorld**: waits for `/api/v1/health` (up to 240 s).
3. **Game server**: waits for "ready to accept" in `server.log` (up to 420 s; world generation takes about a minute on a quiet Mac). If it never says so, the start stops what it started (use `--keep` to leave things for inspection).
4. **Relays**, checked alive after 3 s.
5. **Core residents**, then **villagers in batches of 4**, pausing between batches while the load average is above 0.9 per core (at most 180 s per pause). At least 6 of 8 core residents must be up.
6. **Summary**: processes, works progress, load and memory, warnings, and the next step.

`VILLAGE=N` starts the first N villagers (0 = none). `--lite` sets `VILLAGE=12` unless you set it yourself. The chosen mode is remembered in `play/pids/mode.json`, so `status` knows that 12 of 24 villagers is expected, not a failure.

Residents and relays are children of the launching shell's session; closing Terminal does not stop them (they use `nohup`), but a reboot does.

### Keep the Mac awake

The world only advances while the Mac is awake. For a long run: `caffeinate -i -w $(cat play/pids/veloren) &` keeps it awake for as long as the game server lives.

### Running as a service (optional)

```
ops/launchd/install.sh --world-args "--lite"            dry run: prints what it would do
ops/launchd/install.sh --world-args "--lite" --apply    writes ~/Library/LaunchAgents/com.harr.*.plist and loads them
launchctl kickstart gui/$(id -u)/com.harr.world         start the world now (RunAtLoad is off unless you pass --run-at-load)
ops/launchd/uninstall.sh --apply                        unload and remove
```

Three agents: `com.harr.world` (a foreground supervisor; restarts only when the world fails, at most once a minute, raises the open-file limit, `Nice 5`), `com.harr.backup` (daily 04:30, refuses below 5 GB free) and `com.harr.hygiene` (daily 04:50: fix permissions, rotate logs, check for leaked tokens). If the Mac is asleep at the scheduled time, launchd runs the job when it wakes. If you stop the world with `launchctl bootout`, the supervisor stops it cleanly and it stays stopped. Do not run `play.sh start` and the agent at the same time.

## 3. Backup and restore

```
play/backup.sh make        snapshot to play/backups/harr-YYYYmmdd-HHMMSS.tgz (newest ten kept)
play/backup.sh list
play/backup.sh restore NAME     stops the world, takes a safety snapshot of the current state, restores NAME
```

What is in a snapshot: `play/data` (NemoWorld database, link database, works record), the Veloren saves and rtsim state, the server config. What is not: `play/secrets`, the programs in `play/bin`, the NemoWorld snapshot in `play/nemoworld`, logs.

Things to know:

* A snapshot taken while the world runs copies SQLite files that may be mid-write. It is good enough for "yesterday's Harr", not a guarantee. For a quiet snapshot: `ops/play-next.sh stop`, `play/backup.sh make`, start again. (The daily agent takes the live kind.)
* Snapshots contain player data (aliases, positions at events). `ops/hygiene.sh fix --apply` sets the folder to 700 and files to 600; the backup agent does the same after each run.
* Copy a snapshot off this Mac now and then (an external disk or another machine). A backup on the same disk does not survive the disk.
* Restore: `play/backup.sh restore NAME`, then `ops/play-next.sh start --lite`, then `ops/verify.sh`. The works record is part of the snapshot, so the build clock and stages come back with it. After restoring onto a different machine, run `play/play.sh setup` first (credentials are re-issued there).
* To test a restore without touching the real world, extract into an empty folder: `mkdir /tmp/restore-test && tar -xzf play/backups/NAME.tgz -C /tmp/restore-test` and open `data/world.sqlite` there with `sqlite3 ... "PRAGMA integrity_check"`.

## 4. Resource budget for this Mac

This Mac: Apple silicon, 16 GB memory, 10 cores, about 26 GB free on the disk that holds `play/` (measured 2026-10-17).

**Measured today, before any start:** while other work was compiling (cargo and rustc running, plus other test stacks), the load average was 24 to 46 on 10 cores, 7 to 11 GB of swap was in use and 2.6 GB of memory was available. The pre-flight refuses a start in that state, and it is right to: a game server and 32 bots on top of that would crawl, and the residents would time out.

Rough costs. The per-process figures for bridges and Node processes were read from the running test stacks on this Mac today (about 25 to 35 MB for one `nemo-bridge`, about 30 MB for one small Node relay). The game server and NemoWorld figures are **not measured on Harr**; run `ops/soak.sh 30` during a normal session and replace them.

| Part | Rough memory | CPU |
|---|---|---|
| Veloren server, world loaded | unmeasured; expect 1 to 3 GB | one to two cores busy while players or residents move |
| 32 residents (`nemo-bridge`) | about 1 GB together | low each, but 32 of them at 12 ticks a second add up; `--light-stack` halves the rate |
| 8 relays + NemoWorld (Node) | about 0.5 GB | low |
| Local AI model | weights are 2.5 GB, so plan 3 to 4 GB resident | heavy bursts while a resident answers; this is what `--lite` removes |
| Game client (Voxygen) | 2 GB or more | one to two cores plus the GPU |

**Close before starting:** every `cargo` or `rustc` job (check with `ops/play-next.sh preflight`, it names them), other stacks started with `wt/stack.sh <stream> start` (stop each with `wt/stack.sh <stream> stop`), browsers with many tabs (one Chrome alone held 500 MB today), the Claude, ChatGPT and Codex desktop apps if memory is tight, Xcode and simulators, and any second copy of the world (`dev/dev.sh stop`). Start the game client last, after `verify.sh` passes.

**Which mode:**

| Available memory | Load | Use |
|---|---|---|
| over 5 GB | calm | `start` (model on, 24 villagers) |
| 2.5 to 5 GB | calm | `start --lite` |
| 1.8 to 2.5 GB | any | `start --lite --light-stack`, and close apps |
| under 1.8 GB or swap over 8 GB | any | do not start; free memory first (a reboot clears swap) |

Thresholds are editable through `HARR_MEM_WARN_MB`, `HARR_MEM_FAIL_MB`, `HARR_SWAP_WARN_MB` and the other `HARR_*` variables listed at the top of `ops/lib/harr_ops.py`.

Disk: a snapshot is about 2 MB today and grows with the world; logs were 5.7 MB. Below 15 GB free the pre-flight warns, below 5 GB it refuses.

## 5. Common failures

**"Not starting: the Mac cannot take Harr right now."** Read the FAIL lines. Memory or swap: close apps, or `--lite --light-stack`. Load or compilers: wait for the build to finish (`ps -Ao pcpu,comm -r | head`). Port in use: see below. `--force` starts anyway; expect a slow start and timeouts.

**The server did not come up** ("The game server was not ready within 420 s"). The start prints the last lines of `server.log`.
* A panic or "Address already in use": another server holds 14004 (`lsof -nP -iTCP:14004 -sTCP:LISTEN`). Stop that stack, then retry.
* Nothing but generation messages and a very high load: the Mac is starved. Retry with `--lite --light-stack` after closing apps, or raise the wait: `HARR_T_SERVER=900 ops/play-next.sh start`.
* A panic about the world or saves after a crash: restore the last snapshot (section 3), or if the world is disposable, `play/play.sh reset-world`.
* NemoWorld did not answer: `play/play.sh logs nemo`. A missing credential or key file means `play/play.sh setup` has not been run on this folder.

**Load storm** (load average several times the core count, residents lagging or dropping). `ops/play-next.sh watch` shows it as it happens. In order: close the heaviest app, stop the game client, `stop` and `start --lite --light-stack`. A previous start under heavy load can leave residents half connected; a clean stop and start is better than waiting. Check for a stray compiler first.

**Disk full.** Symptoms: NemoWorld or the server log write errors, SQLite "database or disk is full". Steps: `ops/play-next.sh stop` (a full disk can corrupt a half-written save); `ops/hygiene.sh rotate --apply` and delete old snapshots in `play/backups` you have copied elsewhere; check `df -h`; start again; run `ops/verify.sh`. If a database reports corruption, restore the newest snapshot that opens with `PRAGMA integrity_check`.

**Stale record** (verify says "works record ... stale", or the Selene `works` page never changes). The game server rewrites `veloren-outbox.jsonl.world.json` about every minute while it runs. If its age keeps growing: is the server alive (`status`)? Is `server.log` still growing (`tail -f`)? Stages also legitimately wait ("chunks_not_loaded") while no one is near the site; that is not stale, it is the record saying nobody is there. A server that is alive but silent for 10 minutes: stop and start it. The record itself is safe to keep; do not delete it, the build clock lives there.

**Residents or relays down.** `status` names them. Look at `play/logs/resident-lw-NAME.log`. A 401 means the credential expired (they last 30 days): delete the token file in `play/secrets` for that resident and run `play/play.sh setup` (it issues only missing files and refreshes the program snapshot), then restart.

**verify.sh: guide credential HTTP 401.** Same cause: `play/secrets/bridge-lw-selene.token` expired or was revoked.

**Panics in logs.** `ops/verify.sh` fails the "no panics" check and names the files. A panic in a resident log is one resident; the others carry on. A panic in `server.log` means the world should be treated as suspect: take a snapshot, then read the lines around it before running for hours. Panics from a previous run stay in the old log: a new start moves the previous log to `NAME.log.prev`.

**A token in a log or in git.** `ops/hygiene.sh check` prints file names only. Treat the credential as spent: delete the token file, re-run `play/play.sh setup`, restart, and remove the log. If it is committed, rewrite the history before sharing the repository.

**The Mac slept.** Harr paused; that is by design. The residents reconnect with a back-off after a server restart (shown in `evidence/RESULTS.md`); after a wake, check with `status`, and if the server logged errors, restart it.

## 6. Upgrading from integration/all

`play.sh setup` copies the programs from `wt/target/integ/release` and unpacks branch `integration/all` of `nemoworld` into `play/nemoworld`. It keeps the world, the data and the credentials that already exist, but it rewrites the Veloren settings and the link config from their templates (so hand edits to `settings.ron` or `veloren-link.json` are lost: note them first). It replaces the programs without keeping the old ones, so keep them yourself:

1. `ops/verify.sh` on the running world, so you know it was healthy before. Save the output.
2. Review what changes: `git -C nemoworld log --oneline <deployed>..integration/all` (the deployed commit is the one `play/nemoworld` was archived from; a `git archive` has no history, so note the commit hash when you run setup, for example in `play/DEPLOYED.txt`).
3. Run the tests for the new commit: `node --test tests/veloren-*.test.js` in a worktree of `integration/all` (the Node binary is under `Lucy/.runtime`). Do not build or test on the Mac while the world runs; the load will hide real problems.
4. `ops/play-next.sh stop`, then `play/backup.sh make` (quiet snapshot).
5. Keep a way back: `cp -R play/bin play/bin.prev && cp -R play/nemoworld play/nemoworld.prev`.
6. Build (cargo, your decision when the Mac is quiet), then `play/play.sh setup`.
7. `ops/play-next.sh start --lite`, then `ops/verify.sh`. Only then start the game client and bring the model and villagers back with a normal `start`.
8. Roll back if verify fails: `ops/play-next.sh stop`, `rm -rf play/nemoworld play/bin && mv play/nemoworld.prev play/nemoworld && mv play/bin.prev play/bin`, `play/backup.sh restore <the snapshot from step 4>`, start, verify.
9. After a week without trouble delete `play/bin.prev` and `play/nemoworld.prev`.

The health endpoint (`GET /api/v1/veloren/harr/health`) exists only in builds that contain `src/veloren-ext/health.js`. Until `infra/main` is merged into `integration/all` and set up, `verify.sh` reports that check as SKIP, not FAIL.

## 7. Installing the proposal

1. Read `ops/play-next.sh`, `ops/lib/harr_ops.py`, `ops/hygiene.sh` once. They are short.
2. `ops/play-next.sh preflight` and `ops/play-next.sh start --dry-run` from the worktree work against the real folder in read-only fashion. The dry run prints no secrets.
3. `cp -R ops play/ops` (leave `play.sh` as it is until you trust the new one).
4. First real start: `play/ops/play-next.sh start --lite`, then `play/ops/verify.sh`.
5. Only then consider `ops/launchd/install.sh ... --apply`.

Exit codes: `play-next.sh` 0 ok, 1 a stage failed, 2 refused by pre-flight, 64 bad usage. `verify.sh` 0 no FAIL, 1 a FAIL, 3 world not running. `hygiene.sh` 0 clean, 1 a FAIL.

## 8. What has and has not been tested

Tested without starting anything: shell syntax of every script (`bash -n`), `python3 -m py_compile`, the pre-flight against the real machine and against faked readings, `start --dry-run` in several modes (including a check that no secret value appears in the output), `status` and `status --json` on the stopped world, `watch` and `soak.sh` on the stopped world, `verify.sh` against a mock HTTP server with a copy of the real works record (passing, old build without the health endpoint, a wrong overview shape, a wrong credential, a panic in a log), the launchd plists (rendered, `plutil -lint` OK), and the NemoWorld health endpoint with its unit tests.

Not tested because the world was not started: a real staged start and its timings, `watch` and `soak.sh` against a running world, `--light-stack` effects (the bridge `--tps 6` and `RUST_LOG=error` options are assumed to behave as their names say), launchd loading and KeepAlive behaviour, live log rotation of a running world, and `verify.sh` against the real NemoWorld. The first real run should be `start --lite` while you watch.
