# Veloren world: a dressed Harr, eight residents, and what the server can light

NemoWorld's eight living residents are meant to live in the Veloren world, each walking her own daily
schedule to a real structure of the hamlet Harr, and Harr is meant to *look* like a place: props on the
square, a workshop's yard, and at least one furnished interior. This stream builds both halves:

* **the Veloren half** — a server system that turns a **manifest** into real blocks in Harr,
  idempotently, and follows NemoWorld's clock for the time of day (`wt/veloren-world`,
  `server/src/nemo/world/`, branch `nemo/world`);
* **the NemoWorld half** — the manifest itself, the eight residents' schedule mapped to real Harr
  structures, the credential plan, and the validators that refuse a bad manifest before the game is
  ever asked (`wt/nemoworld-world`, branch `nw/world`).

```
NemoWorld content/veloren-world-harr.json          the manifest: groups of ops, anchored on a plot
        |                                           + the hours of NemoWorld's clock
        v  link config "world": {"path": ..., "site": "Harr"}
Veloren server, server/src/nemo/world/dress.rs
        |  1. Manifest::parse + plan (nemo-world-core): the whole manifest, or nothing
        |  2. anchor = site origin, or the nth plot of a kind, FROM WORLD GENERATION
        |  3. ground measured like the home stream's cottage (retry until the chunks are loaded)
        |  4. BlockChange writes: foundation, then every cell; only cells that differ
        |  5. <outbox>.world.json: fingerprints, anchors, grounds, what was written, what was refused
        |  6. every pass: 8 sentinel cells per group; a group that no longer stands is written again
        v
<outbox>.world.json        the record a human reads        PROBE_SPRITE/PROBE_BLOCK  what a client sees
```

## Where everything lives

| Piece | File | What it is |
|---|---|---|
| The system | `wt/veloren-world/server/src/nemo/world/dress.rs` | anchors, ground, writes, record, NemoWorld's clock |
| The pure rules, unit tested | `wt/veloren-world/server/src/nemo/world/logic.rs` | config, the crate's vocabulary against the game's, fingerprints, idempotence, refusals, the removal rule |
| Wiring | `wt/veloren-world/server/src/sys/mod.rs` (a `#[path]` module + one `dispatch`), `server/src/lib.rs` (one resource), `server/Cargo.toml` (`nemo-world-core`) | the same three shared lines the atlas and shop streams use |
| The manifest | `wt/nemoworld-world/content/veloren-world-harr.json` | props, the furnished interior, the atmosphere hours |
| NemoWorld's own checks | `wt/nemoworld-world/src/veloren-ext/world-manifest.js`, `test/veloren-world.test.js` | places, budgets, ops; cross-checked against the game's checker |
| The eight residents' places and schedule | `wt/nemoworld-world/content/veloren-world-landmarks.json`, `src/veloren-ext/world-residents.js` | six real Harr structures, 32 scheduled phases |
| The relay fix | `wt/nemoworld-world/scripts/veloren-relay.mjs --resident`, `src/veloren-relay.js` | one relay per resident, its own credential and offset |
| The live-run recipe | `wt/run/world/run-live.sh` | credentials, residents, relays, meet probes, survey/dump |

## The world-dressing system

**Switch.** The link config's `world` section, off unless present:

```json
"world": { "path": "/…/content/veloren-world-harr.json", "site": "Harr" }
```

`"enabled": false` turns it off; `site` says which site this server dresses, so a manifest for another
site is refused whole.

**The manifest** is data with a fixed vocabulary (`nemo-world-core::manifest`): a `format`, one `site`,
an `area.radius`, an `atmosphere`, and `groups`. Each group has an `id`, an `anchor` (`plot` + `nth`
+ `dx`/`dy`), a `ground_at` column and `ops` of four kinds — `fill`, `clear`, `sprite`, `foundation` —
in coordinates relative to the ground at the anchor. Block kinds are a six-name allow-list and sprites
one of 115 furniture, light and window names; nothing that flows, burns, spreads or can be picked is
allowed, and every limit (extent 48, heights −12..24, a 4096-cell box, 6000 cells per group, 60000 in
total) is checked before anything is written. **One problem refuses the whole manifest**, never just
the offending group.

**What it places today.** Four groups: the meeting corner on Harr's square (three benches, a lantern,
a signboard), the market end of the square (crates, a barrel, a bucket, a basket, a sack, a handcart
and a lanternpost with a lantern on top), the workshop's yard (forge, anvil, bellows, carpenter's
table, coal, tanning rack, cauldron, a lantern), and the **furnished interior**: the surveyor's hut on
the farm field where the Quiet Survey begins — a 9×7 room with a wooden floor, rock walls, a two-block
doorway, four windows, a rock roof, and inside it a bed, a table with two chairs, a bookshelf, a
hearth, a cooking pot, two lanterns, a crate, a barrel, a drawer, a cushion and a flowerpot, plus a
lanternpost, a crate, a barrel and a signboard outside the door. 204 blocks and 54 sprites, six of
which are light-emitting.

**Anchors come from world generation, never from a coordinate.** A group's anchor is the site's origin
or the `nth` plot of a kind, nearest the origin first — the same resolution the atlas
(`server/src/nemo/atlas/mod.rs:195-207`) and the link's landmarks (`nemo_link.rs:214-230`) use. The
live run logs the result:

```
NemoWorld world dressing is on: site Harr at (15216, 16016), 4 groups, 204 blocks, 54 sprites (6 of them lit), 116 foundation columns
NemoWorld world dressing placed a group's anchor group=plaza-meeting-corner anchor=(15213, 15977)
NemoWorld world dressing placed a group's anchor group=plaza-market-props anchor=(15213, 15985)
NemoWorld world dressing placed a group's anchor group=workshop-yard anchor=(15207, 15995)
NemoWorld world dressing placed a group's anchor group=field-hut anchor=(15231, 16025)
```

**The ground** is measured the way the home stream's cottage is (`nemo_home.rs:224-236`): the highest
solid, non-foliage block near the world's own altitude estimate, at the group's `ground_at` column.
Nothing is written until the chunks around the group are loaded, so a group whose terrain nobody has
generated yet simply waits (`waiting: {"<group>": "chunks_not_loaded"}` in the record), and a group
whose ground is water or missing is refused with a reason rather than built on water.

**The write path** is `BlockChange` — the resource behind the admin `/make_block` and `/make_sprite`
(`server/src/cmd.rs:816-840`) — one group per pass so a big manifest cannot stall a frame. Only cells
whose block differs are written.

**The record** (`<outbox>.world.json`) is the acknowledgement, and it only claims what happened:

```json
{ "format": "veloren-world-applied-v1", "site": "Harr", "origin": [15216, 16016],
  "groups": { "field-hut": { "digest": "ded04b3440239aaa", "anchor": [15231, 16025], "ground": 413,
                             "cells": 321, "blocks": 204, "sprites": 28,
                             "foundation_columns": 73, "written": 238, "removed": [] } },
  "waiting": {}, "refused": [], "ignored": [], "orphans": [] }
```

`written` is how many cells that application really changed (0 when it found the group standing),
`waiting` names groups the terrain is not ready for, `refused` carries every reason a manifest was
thrown out, `ignored` records what the manifest asked for that this server does not do, and `orphans`
names groups an earlier run applied that the manifest no longer asks for.

**Idempotence** is a property of the design and is proven twice.

*In the unit tests*, over an in-memory terrain implementing the same `Voxel` trait the live
`TerrainGrid` does: applying a group twice writes **0** cells and leaves the world byte-for-byte
identical; a "restart" (the terrain thrown away and world generation put back) plans the same
fingerprint, is written again and lands on exactly the same world, and the pass after it does nothing.

*Live*, in this stream's own stack: after the four groups were stamped, the log shows exactly four
writes and no more for the rest of the run; then the server was stopped and started, terrain
persistence being off (`server/src/settings/mod.rs:234`) so the regenerated world had no props at all,
and the system re-applied every group — the same fingerprints, anchors and grounds — and a client's
`--dump` of the hut box came back identical in every cell we wrote (only the game's own radish crops
had moved, as regenerated farmland does). Evidence: `wt/evidence/world/restart-idempotence.log`,
`server-log-first-application.log`, `server-log-restart-reapplication.log`,
`world-record-before-restart.json`, `world-record-after-restart.json`.

**A cell the game removes again** is handled honestly. A sprite written where its adjacency
requirement is not met is turned back into air by the game in the same tick
(`common/state/src/state.rs:765-815`; the requirements are `common/src/terrain/sprite/mod.rs:925-945`
— a lanternpost's lantern needs a wall beside it, a lantern needs solid ground under it). The first
live run showed the cost: one such sprite was written, removed and written again 395 times in three
minutes. The system now counts how often a cell it wrote is gone again, and after three tries it stops
counting that cell as part of the group, stops rewriting the group for it, and records the cell in
`removed` with a warning that says why. The rest of the group keeps standing and keeps being repaired.

**What it will not do.** It does not *undo*: the record says where a group was applied but not what
was there before, so a group removed from the manifest leaves its blocks in the world and is reported
as an orphan. It does not set the weather (see Lighting). It does not touch anything outside the
manifest's area, and it never writes a block kind or sprite the game does not have — every name in the
crate's allow-lists is turned into a real `Block` through the game's own parsers by a unit test.

## The eight residents' places

`content/veloren-world-landmarks.json` holds the six landmarks, in exactly the shape the Veloren link
config takes (`id`, `label`, `name`, `site`, `plot`, `nth`, `radius`), and the schedule that maps each
of the roster's 32 destinations to one of them — or marks it unmapped, with a reason and what would be
needed. The mapping is read from the server, not invented: Harr's five plots were reported by a live
server (`site Harr (origin Vec2 { x: 15216, y: 16016 }) has 5 plots: House@(15225,16007)
FarmField@(15231,16025) Workshop@(15207,15995) FarmField@(15225,15983) Plaza@(15213,15977)`), and a
landmark is chosen by `site` + `plot` + `nth`, `nth` counting plots of that kind nearest the origin
first.

| NemoWorld label | Landmark id | Real structure | Resolved position |
|---|---|---|---|
| Library | `lyra-house` | `House` 0 | (15225, 16007) |
| Peace Pavilion | `lyra-field` | `FarmField` 0 | (15231, 16025) |
| Meeting Hall | `lyra-plaza` | `Plaza` 0 | (15213, 15977) |
| Central Plaza | `harr-central-plaza` | `Plaza` 0 (the same square) | (15213, 15977) |
| Workshop | `harr-workshop` | `Workshop` 0 | (15207, 15995) |
| Orchard | `harr-orchard` | `FarmField` 1 | (15225, 15983) |

`lyra-house`, `lyra-field` and `lyra-plaza` keep their labels and plots, because the link, home, hud
and atlas streams and the Quiet Survey's own text name them. "Central Plaza" and "Meeting Hall" are two
names for the one square Harr has, declared as `shared_with`; the bridge looks a landmark up by its
label alone, so both names need an entry. Four of the 32 destinations are honestly unmapped (Bram's
Harbor and Observatory, Rowan's Gateway and Harbor) because Harr has no harbour, observatory or
gateway and the world's site snapshot has no such kind anywhere; a resident with an unmapped phase
stands still, and the bridge logs `no landmark for phase <phase> ("Harbor"); standing still`.

## Lighting: what the server sets, and what is client-only

### The day cycle — the server now sets it

The system reads the manifest's `atmosphere` and pins the absolute time of day,
`common/resources::TimeOfDay`, to NemoWorld's published clock (`nemo-world-core::sky`, the Rust twin of
NemoWorld's `src/atmosphere.js`: a 120-minute cycle of four 30-minute phases measured from the Unix
epoch). It writes the resource every half second, so:

* **the time of day follows NemoWorld** — the sun is where NemoWorld says it is, on every server and
  every client, with no client change (`common/src/resources.rs:11`; the resource is a plain
  `TimeOfDay(f64)` that any server system can write, and `sys::entity_sync` sends it to clients
  every 100 ticks);
* **the day length follows NemoWorld too, not the settings**: `TimeOfDay` advances by
  `dt * day_cycle_coefficient * time_scale` (`common/state/src/state.rs:869`) with
  `day_cycle_coefficient = 1440.0 / day_length` (`server/src/settings/mod.rs:341`), but because the
  system re-pins the absolute value every half second the advance is irrelevant: an in-game day lasts
  NemoWorld's 120 real minutes. (Before this, the shipped `day_length: 30.0` meant a 30-minute day.)
* **the four phases land on Veloren's own day boundaries**, which is why the manifest's hours are
  6/11/16/19: Veloren names the day period by the clock — Night before 06:00, Morning to 11:00, Noon
  to 16:00, Evening to 19:00, Night after (`common/src/time.rs:11-26`) — and the bridge turns that into
  the schedule's phase (`nemo-bridge/src/main.rs`, `phase_name`). With those hours each of NemoWorld's
  phases falls entirely inside the Veloren period the bridge names the same way, so a resident walks
  the row of her schedule that NemoWorld's clock says she should. A test walks the whole cycle and
  refuses hours that would break that, and the live run confirms it:

  ```
  NemoWorld world dressing: it is night in NemoWorld; the Veloren clock is at 04:34
  lw-aria     status: phase=night mode=schedule going to 'Meeting Hall'
  … eight residents, all eight on the night row, none of them given --phase
  NemoWorld's own module at the same moment: {"phase":"night","label":"Starlight", …}
  ```

* **What the server cannot do**: `/time_scale` (an admin command, `server/src/cmd.rs:1714`) still
  speeds up *both* `Time` and `TimeOfDay`, but a non-1.0 scale would fight the pin, and the system does
  not touch it. A manifest with `"time": false` leaves the clock entirely alone (the record says so
  under `ignored`).

### Light-emitting props

| Question | Answer | Proof |
|---|---|---|
| Does the game know which blocks are lit? | Yes: `Block::get_glow()` returns a glow level for 57 block kinds and sprite kinds — `Lantern` 24, `StreetLamp`/`StreetLampTall` 24, `BonfireMLit` 24, `Candle`/`WallSconce`/`WallLamp` 16, `GlowingRock` 10, `GlowingMushroom` 20 | `common/src/terrain/block.rs:414-470` |
| Who reads it? | **Only the client.** The three callers are all in `voxygen`'s terrain meshing | `voxygen/src/mesh/terrain.rs:270`, `greedy.rs:830`, `segment.rs:206` |
| So what is a lit prop on the server? | A block whose sprite the client knows how to light. Placing it is a terrain write; being lit is rendering | as above |
| Can the server place one? | Yes, and this system does: the manifest's six light sprites are placed as terrain, and a client's `--survey` reports the glow the game will draw for them: `PROBE_SPRITE Lantern 15211 15977 412 glow=Some(24)` | `wt/evidence/world/probe-survey-plaza.log` |
| Can the server spawn a light *entity*? | Yes (`/light`, `LightEmitter`), but it is a runtime entity nothing persists | `server/src/cmd.rs:3701`, `common/src/comp/visual.rs:6` |
| Do placed blocks survive a restart? | Only if terrain persistence is on — it is off by default and the store is written by `/make_block`, not by `BlockChange` | `server/src/settings/mod.rs:234`, `server/src/lib.rs:404-424`; `grep terrain_persistence.set_block` finds only `server/src/cmd.rs` |

### Weather

Weather **is** server-side (`server/src/weather/sim.rs:92`, `/weather_zone` at `server/src/cmd.rs:6214`),
but **this system does not set it**: a zone is queued through a `WeatherJob` that lives in a
`Write<Option<WeatherJob>>` resource the weather system itself owns, exists only with the `worldgen`
feature, and takes a duration, so a system that kept re-queueing one would have to reason about that
job's lifecycle to avoid piling zones up. The manifest's `weather` flag is therefore recorded under
`ignored` — with a warning in the log — instead of being silently pretended, and the shipped manifest
sets `"weather": false` and says so in its own note. Doing it properly is a small, honest follow-up:
`queue_zone(weather, pos / CELL_SIZE, radius / CELL_SIZE, time)`.

### What is client-only

Rendering: the sun, the moon, the sky, the light a glow level produces, shadows, fog, rain and the
lightning flash. That is why the answer is "the server sets the clock and places blocks and entities,
the client lights them", and why a different *look* for Harr (warmer lanterns, a brighter night) would
need `voxygen` — the 45-minute, 10 GB build the rules forbid — and is therefore out of scope.

## Credentials: eight residents, minimal scopes, and one relay each

The plan is in `src/veloren-ext/world-residents.js` (`credentialPlan()`), and
`tests/veloren-world-scopes.test.js` proves it against the real link surface and the real issuing
command: each resident's bridge gets `talk,director`; each relay gets one `events` credential of its
own; no scope promises authority (the forbidden words are checked against `LINK_SCOPES` at test time);
a credential is bound to one resident, so a validly signed fact about another is refused with
`resident_out_of_scope`; eight credentials are independent under revocation and expiry; and no
combination of link scopes reaches a purchase confirmation, a link redeem, a Karma mint, a land
assignment or a vault unlock.

**The relay limit the eight residents exposed is fixed in this tree.**
`scripts/veloren-relay.mjs` takes `--resident <id>` (or `NEMO_LINK_RESIDENT`): a filtered relay hands
NemoWorld only its own resident's facts and keeps its own offset
(`<outbox>.offset.<resident>`). Without the flag it behaves exactly as before. Two tests cover it: one
runs eight filtered relays over one outbox with the real link and shows every resident's facts stored
and **zero** refusals; the other starts the real script on the command line and checks the filter and
the per-resident offset. Both the before and the after were then observed in the live run, in one
outbox:

```
# the relay `wt/stack.sh world start` runs: one credential, no --resident
[relay] event local-dev:1792137368 rejected: resident_out_of_scope      (8 of them)
# the eight relays `wt/run/world/run-live.sh relays` starts, one resident each
relay-lw-aria.log: 0 rejections   …   relay-lw-rowan.log: 0 rejections
# and what NemoWorld stored: link_events by resident
[('lw-aria', 1), ('lw-bram', 1), ('lw-kael', 1), ('lw-lyra', 4), ('lw-rowan', 1), ('lw-selene', 2),
 ('lw-theron', 1), ('lw-vaelen', 1)]
```

`wt/stack.sh` has no `relay-start` and cannot be edited from a stream, so the eight relays are started
by `wt/run/world/run-live.sh relays`, with their pids named `pids/res-relay-<resident>` so that
`wt/stack.sh world stop` stops them (`stop` only knows `pids/res-*`, `lyra`, `relay`, `veloren`,
`nemo`).

## In the game: how a person tries it

```bash
# 1. build (server + bridge; the rules forbid building voxygen, so this is not seen by eye)
cd outputs/lyra-integration
./wt/stack.sh world build

# 2. the run config: eight residents, six landmarks, the world manifest
#    (wt/run/world/veloren-link.json - written by the world stream; "world" points at the manifest)
./wt/stack.sh world start          # NemoWorld :3206, Veloren :14160; logs in wt/run/world/logs
grep "world dressing" wt/run/world/logs/veloren-server.log      # what it placed, and where
cat wt/run/world/data/veloren-outbox.jsonl.world.json           # the record: what is in the world

# 3. one credential per resident, then the seven residents the stack does not start itself
./wt/run/world/run-live.sh creds
./wt/run/world/run-live.sh residents      # each walks the row of her schedule for NemoWorld's phase

# 4. one relay per resident, so every resident's facts reach NemoWorld
./wt/run/world/run-live.sh relays

# 5. meet them (one probe player per resident, which is what makes the server sign a fact), and look
./wt/run/world/run-live.sh meet lw-aria lw-selene lw-lyra
./wt/stack.sh world probe --probe Tester --phase day --survey 15213,15981,16,2   # the square
./wt/stack.sh world probe --probe Tester --phase day --dump 15229,16023,412,15241,16033,419  # the hut
```

What a person standing there would see: on Harr's square, three benches, a lantern burning beside them,
a signboard, crates and barrels and a handcart at the market end and a lanternpost with a lantern on
top; in the workshop's yard, a forge, an anvil, a bellows and the carpenter's table; and on the farm
field, the surveyor's hut — walls, a doorway, four windows, a roof, and inside it a bed, a table with
chairs, a bookshelf, a hearth, a cooking pot, two lanterns, a crate, a barrel, a drawer, a cushion and
a flowerpot, with a signboard and a lanternpost outside the door. Six of those props are lights the
client will draw as light. Eight residents walk their day, and the sky follows NemoWorld's phase.

What they would *not* see: any warmer light, any different sky colour (that is `voxygen`), any harbour,
observatory or gateway (Harr has none), and any prop that the game itself removes again (a
lanternpost's lantern in open ground, for example: it needs a wall beside it, and the manifest puts a
plain lantern on the post instead).

## Tests

```
# the Rust half (the pure rules, including the idempotence property)
cd wt/veloren-world
CARGO_TARGET_DIR=wt/target/world cargo test --release -p veloren-server --lib     # 25 pass, 0 fail
CARGO_TARGET_DIR=wt/target/world cargo test --release -p nemo-world-core --lib    # the crate's own
# the NemoWorld half
cd wt/nemoworld-world
node --test tests/veloren-world.test.js tests/veloren-world-residents.test.js \
            tests/veloren-world-scopes.test.js tests/veloren-relay.test.js
```

* `server/src/nemo/world/logic.rs` (15 tests): the world section is opt-in and a broken one is refused
  with its reason; a manifest for another site; an unusable manifest refused with **every** reason and
  nothing applied; every name in the crate's allow-lists is a name the game can place, and a name it
  does not have refuses the manifest; what one application writes; the foundation stops at the first
  solid block; **a second application writes nothing and the world is unchanged**; **a restart converges
  on the same world**; a changed manifest is re-applied with the reason `changed`; a cell the game keeps
  removing stops being checked after three tries and the rest of the group is kept; sentinels are
  deterministic; a record from an unknown format is ignored rather than trusted.
* `tests/veloren-world.test.js` (5 tests): NemoWorld's places and budgets; a manifest that asks for
  anything else is refused whole; the game's checker agrees with NemoWorld's validator; and **the
  shipped manifest passes both**, with hours that keep the phases aligned.
* `tests/veloren-world-residents.test.js` (9) and `tests/veloren-world-scopes.test.js` (11): the
  schedule, the landmarks against the server's own resolution of Harr, and the credential plan.
* `tests/veloren-relay.test.js` (6): the relay's at-least-once delivery and replay safety, the filter
  that carries one resident per relay, and the real script's `--resident` and per-resident offset.

## Limits and what is missing

1. **Nothing was ever seen by eye.** No `voxygen` was built (the rules forbid it), so every in-game
   observation here is a bot's `--survey`/`--dump` or a server log, not a person looking at a screen.
2. **Weather is not set** by the system, though the server could (see above); the manifest's flag is
   reported under `ignored`.
3. **Day length is set only as a side effect** of pinning the clock; `/time_scale` is untouched, and a
   non-1.0 scale set by an admin would fight the pin until the next pass.
4. **A manifest edit re-applies, but a group *removed* from a manifest is not undone** — its blocks
   stay and are reported as orphans.
5. **The four unmapped destinations stay unmapped** unless the owner chooses a structure or an
   alternative; Bram and Rowan stand still at dawn and dusk.
6. **Two structures carry two labels each** (the square, and the two fields): that is the roster's own
   shape, not a defect, but "every resident has her own place" is not true.
7. **The relay fix is in this tree, not in the shared `wt/stack.sh`**, so an operator must start the
   per-resident relays by hand (`wt/run/world/run-live.sh relays`) until the launcher learns about them.
8. **The record's `removed` list is the honest alternative to an undo**: it says which cells the game
   will not keep, not what was there before.
