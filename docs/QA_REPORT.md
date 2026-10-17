# Harr QA report

Reviewer: skeptical read of the merged `integration/all` (nemoworld `50d4ce2`, veloren `e273dba`), on branch `qa/main`
of each repo (worktrees `wt/nemoworld-qa`, `wt/veloren-qa`). Nothing was compiled or run in-game: cargo was off limits,
so **every Rust change below is uncompiled and untested** and must be built by the owner. Node tests were run:
162 passing before, 175 after (13 new in `tests/veloren-qa.test.js`; they were written failing first, see commit order).

"Confirmed" means shown by reading the code and, where noted, by running the algorithm or the live record
(`play/data/veloren-outbox.jsonl.world.json`, `play/logs/server.log`). "Suspected" means plausible from the code but
not reproduced.

## Fixed (with a test where the language allowed one)

| # | Sev | Status | Where | What was wrong | Fix |
|---|-----|--------|-------|----------------|-----|
| F1 | High | confirmed by simulation | veloren `world/logic.rs` `sentinel_without` | Stage one of a building clears its whole footprint, so its "is it still standing" sample cells were mostly *air* cells. Stages two to four then build inside that footprint. The first stage's air sentinel found a wall, called the stage "not standing" and wrote it again, which cleared the whole building; the later stages saw their own cells missing and rebuilt, round and round until each cell had been "lost" three times and was recorded in `removed` as if the game had deleted it. I replayed the Rust selection rule over the shipped manifest: 11 groups sample a cell a later group overwrites (well-1, library-annex-1, solar-array-1, transit-hub-1, data-archive-1, glass-garden-1, schoolhouse-1, seminar-pavilion-1, amphitheatre-1, research-tower-2, lantern-path-3). `gone`/`misses` are in memory only, so it replays after **every restart**. Players see a finished building vanish and rebuild for a few seconds. | Air cells are only sentinels when a group has nothing else. Rust unit test added (`a_cleared_cell_is_not_a_sentinel_...`). Residual: research-tower-2 vs -3 (two different blocks in one cell) and lantern-path-3 vs glass-garden-1 are real block conflicts and still converge only after three rounds. |
| F2 | Medium | confirmed on live data | veloren `world/dress.rs` | `waiting` reasons were only cleared when a group was written. The live record lists all 20 built groups under `waiting: chunks_not_loaded`, and every later stage keeps the first-pass reason until it is overtaken. The works board and `waiting` JSON therefore lie. | Cleared when the ground is measured and when a group passes all its gates. |
| F3 | Medium | confirmed | nemoworld `veloren-link.js` | The server tags `resident.met` / `landmark.together` with whichever configured landmark the resident stands in. `play.sh` configures 45 landmarks (workshop, orchard, 29 work sites), but NemoWorld only accepted `lyra-*` and `disc-*`; any other tag is `unknown_landmark`, and the relay treats that refusal as final. Facts at the workshop (Kael, Theron), the orchard (Aria) and every work site were silently dropped. | `withConfiguredLandmarks` accepts everything in `veloren-world-landmarks.json` and `veloren-landmarks-extra.json` (role `place`). QA-03. |
| F4 | Medium | confirmed (query plans) | nemoworld `veloren-link.js` | `link_events` had no index except its keys. `commandStatus` (one scan per pending pantry take, up to 100 per call), `gatherFacts` (3 scans), `tasksFor` (3 scans), the chronicle and the overview all scanned a table that only grows. | Two indexes added through an extension schema (`event_index`). QA-05. |
| F5 | Medium | confirmed | nemoworld `pantry.js` `shelfNow` | When a shelf sat at its cap the stored `as_of` never moved, so the next take was "restocked" at once for all the time it had sat full: a full shelf could never be emptied. | `as_of` advances when the shelf is at its cap. QA-01. |
| F6 | Low | confirmed | `veloren-link.js` `ingest` | Every `command.applied/rejected` ack (empty alias) overwrote `link_players.alias` with `''`; the pantry then showed "a traveller" for the next take. | Empty alias never overwrites. QA-02. |
| F7 | Low | confirmed | `village.js` `chronicleLines` | (a) Day windows were built by subtracting 24 h from local midnight, wrong on the two clock-change days (a 25 h day put 00:30 in the wrong day). (b) Discoveries were `GROUP BY player, landmark` over the whole 3-day window with a bare column, so a find repeated on another day was counted once, on an arbitrary day. | Calendar-date arithmetic; one row per find, deduplicated per person, place and day. QA-04 (runs with `TZ=America/New_York`). |
| F8 | Low | confirmed | `village.js` `observe` | A stage mark was dated when NemoWorld first noticed it, so a new link database or a restart turned old building into "today". `lastObserved` was one variable for the whole process. | Dated by the record's `applied_at`; observer clock kept per link. QA-08, QA-11. |
| F9 | Low | confirmed | `world-life.js` `worksLines` | A catalogue project with no stages in the manifest threw on `p.next.title` (500 from `/works`). | Guarded. QA-06. |
| F10 | Low | confirmed | `veloren-link.js` `#advance` | A player alias beginning with `/` or `!` became the first characters of a line a resident speaks (`"${alias}, Walk with Lyra..."`). The only guard was Veloren's own alias rules. | Alias neutralised like `plain`. QA-07. |
| F11 | Low | confirmed | `pantry.js` `settle` | A take whose ack arrived after the 60 s command lifetime (relay down, NemoWorld restarted) was marked `unconfirmed` for ever: never counted toward the shelf or the player's four daily takes, so the player could take again. | `unconfirmed` takes younger than a day are re-checked and settled if the ack shows up. QA-09. |
| F12 | Low | confirmed | `overview.js` | The unauthenticated `/veloren/harr/overview` recomputed everything (6 event-log queries, record read, chronicle, pantry writes) per request. | Result kept 5 s per link. QA-10. (The shared `*overview` rate bucket is untouched, see R9.) |
| F13 | Low | confirmed | `village.js` `validateEvents` | A weekly event running past midnight was accepted although `activeSlot` looks at one calendar day, so it would stop at 00:00. None ship today. | Refused with a clear error. QA-12. |
| F14 | Low | confirmed | veloren `sys/nemo_link.rs` | `last` (cooldown keys per person x resident x place) was never pruned. | Pruned past the longest cooldown. |
| F15 | Low (perf) | confirmed | veloren `world/dress.rs` | `logic::digest` formatted and hashed every cell of every group (about 25k cells for the full manifest) twice a second on the tick thread. | Digest cached per group (plan and ground never change once measured). |

## Open findings (not fixed)

Ranked. "Confirmed" = shown from the code or data; "Suspected" = needs a running server.

1. **Medium, confirmed. Villagers cannot be met in NemoWorld.** `play.sh` starts a relay (with an `events` credential) only
   for the 8 roster residents. The 24 villagers are in the server's resident list, so `resident.met` for them goes to the
   outbox, but no relay forwards it. "Meet five villagers" can only ever count roster residents. Needs either a relay
   per villager or a multi-resident relay; this is infrastructure, not a one-line fix.
2. **Medium, confirmed by code, impact depends on deployment. Residents are recognised by *account alias*.**
   `Config::residents` is keyed by `player.alias`. `play.sh` runs `--no-auth`; there anyone who logs in as "Lyra" is treated
   as the resident (their presence is excluded from visitors and they can be the witness of meets). Fine on a closed
   LAN, wrong on any public server. Check against the character name or require auth.
3. **Medium, confirmed by arithmetic. Several sites depend on exactly two bodies.** Using the real plot positions from the
   server log and the landmark offsets, 23 of 35 crew-gated projects have at least one phase (dawn/day/dusk/night) in
   which fewer than two of the 32 scripted residents are within the 20-block crew radius; none has zero phases.
   Worst: cottage-4 and cottage-5 have exactly two, in `day` only. Full gaps: research-tower (dusk, night), solar-array
   (day, night), glass-garden (dusk, night), schoolhouse, seminar-pavilion, cottage-4/5/6 (only day, and 6 also dusk),
   cottage-7/8/9 (dawn and dusk only), amphitheatre and festival-lawn (day and dusk), wind-array (dusk only), solar-field-2,
   field-pavilion, water-tower, light-fountain (no night), transit-hub, data-archive, sky-walk, guesthouse (no dawn).
   Stages only build when the bots are online (they are the crew and also what loads the chunks). A stage whose only
   covered phase is 30 of every 120 minutes builds in that window and not otherwise; with the villagers off, only human
   visitors can complete a crew. The existing test (`veloren-pantry.test.js`) only checks the busiest of dawn/day/dusk.
4. **Medium, confirmed (content). Unmapped roster labels:** `Harbor` (Bram dawn, Rowan dusk), `Gateway` (Rowan dawn) and
   `Observatory` (Bram dusk) have no landmark; the observatory now exists as `Observatory Site` under a different
   label, and the bridge looks landmarks up by label alone. Bram never walks to the observatory.
5. **Low, confirmed. Cross-project overlap the generator cannot see:** `lantern-path-3` lamps at (29,2) and (35,2) lie
   inside `glass-garden-1`'s cleared footprint. `gen-harr-works.py` checks fills and sprites against other projects,
   not `clear` volumes or foundation columns, and compares cells at relative height (the assumed plot offsets in the
   script match the live server log exactly: House +12,+30, FarmField +18,+48 and +12,+6, Workshop -6,+18 from the plaza).
   All columns are within 87 blocks of the origin (area radius 110); the Rust total is 24.8k of 60k blocks.
6. **Low, confirmed. `play/veloren-link.json` is stale:** 31 of the 45 landmarks. `play.sh` regenerates it on `start`, but a
   server started by other means does not know 14 work sites (the bridge then marks those villagers unmapped).
7. **Low, confirmed. Command acknowledgements carry no reason.** `ack(command, applied, reason)` only logs the reason; the
   signed event has `command.applied` / `command.rejected` and the command id. NemoWorld cannot tell "inventory full"
   from "player offline".
8. **Low, suspected. `landmark.visited` re-fires every 30 min for a player who stays in the place** (the `visiting` entry
   persists, the cooldown expires). Insight is unaffected (finds are distinct per person and place) but the outbox grows.
   The place check ignores height, so a glider passing over for four seconds counts.
9. **Low, confirmed. The overview and tasks routes share one rate bucket (`*overview`, 7200/h) and need no credential.**
   Anyone who can reach the page can exhaust it and make the dashboard answer 429. The document is now cached, but the
   bucket is not split.
10. **Low, suspected.** Server state that grows without bound: the outbox, the `.claimed` file and `link_events` (nothing
   rotates; `last_seq` reads the whole outbox at startup); `hud_last` keeps a row per player.
11. **Low, suspected.** `ingest_commands` keeps a byte offset in memory: a commands file that is truncated or rotated is never
    read again until restart, and a non-UTF-8 byte makes `read_to_string` fail on every poll.
12. **Low, suspected.** `load_record` returns `None` for an unparsable record, and the next save overwrites it: the works
    clock restarts from zero and every built stage is rebuilt. Keep a `.bak` of an unreadable record.
13. **Low, suspected.** `gone`/`misses` are not persisted. After each restart a stage with a vetoed sprite (a lantern with no
    support) is written three times before it is accepted, and the record's `removed` list is rebuilt.
14. **Low, design.** The works clock counts every second the server is up, including with nobody online. Crew counting
    uses every `Player` entity (spectators, admins, a flyer 100 blocks overhead; radius is 2-D).
15. **Low, suspected.** Pantry day limit uses UTC (`toISOString`) while the chronicle uses local time; in Nepal the daily share
    resets at 05:45. `ack_resident` falls back to an arbitrary HashMap entry when the config omits it (the play config sets it).
16. **Low, suspected.** Pantry and shop "once only" files are flushed but not fsynced; a power cut (not a process crash)
    can lose the last order id and allow a repeat. The issue-then-insert order in `take()` leaves a food gift with no
    reservation if the process dies between the two statements (both are synchronous, so the window is tiny).
17. **Low, suspected. Peace system.** It kills the rtsim actor with `killer: None` and deletes the entity every 2 s within
    600 blocks of a person; whether rtsim's respawn logic then churns (spawn, delete, spawn) was not examined in the rtsim
    rules. Residents (Player entities), tame and owned animals and passive animals are excluded by `is_hostile`; a
    training dummy or any `Alignment::Enemy` prop would be removed.
18. **Info.** Import cycle `view.js` <-> `pantry.js` is benign today (nothing touches the other's exports at module load) but
    one top-level use would break it. `directorHook` re-reads and validates the events file on every call.

## What I could not verify

* Any Rust at all: compile, borrow check, or run tests. The four edits are small and were re-read twice, but the
  `logic.rs` test (`CLEARED` manifest) and the `dress.rs` field/borrow changes are the ones to build first.
* That the game really rewrites a stage in the way F1 describes. The selection rule and the decision rule were replayed
  in Python from `logic.rs`; the live record has only stage-one groups built (`removed` all empty), so the symptom has not
  yet been seen in play. It will appear the first time a second stage of a project is built.
* Whether bridge movement honours the phase schedule exactly (coverage numbers use landmark centres and a 20-block radius;
  residents stand anywhere in the landmark's radius, so real coverage is somewhat worse than counted).
* Sprite adjacency vetoes (`Lantern` needs support) across the whole manifest.
* Terrain persistence, chunk loading around work sites with nobody near, and rtsim behaviour (item 17).

## Prioritised risks for the owner

1. Build `veloren-qa` and run the world tests before anything else; four files changed (`logic.rs`, `dress.rs`, `nemo_link.rs`).
2. Decide on villager relays (open item 1): the "Meet five villagers" task and any chronicle line about villagers depend on it.
3. Do not expose the server with `--no-auth` while residents are keyed by alias (open item 2).
4. Treat the crew gate as a liveness risk: with the bots off, no stage after the first of a project builds. Add a second
   body at the two-body sites (open item 3) or lower `CREW` for cottages 4-6.
5. Watch the first multi-stage build in play for the F1 symptom (a building flickering); if it persists, the remaining
   cause is research-tower-2/3 and lantern-path-3 vs glass-garden-1 (fix the content, open item 5).
6. Restart the stack through `play.sh` (not by hand) so the landmark list is complete (open item 6).
7. Split the overview rate bucket or put the dashboard behind loopback (open item 9).
8. Back up the world record; make `load_record` refuse to overwrite a record it could not parse (open item 12).
