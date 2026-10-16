# Veloren world: eight residents, their real places, and what the server can light

NemoWorld's eight living residents are meant to live in the Veloren world, each walking her own daily
schedule to a real structure of the hamlet Harr. This stream's job in NemoWorld is the part that does not
need the game running: **where each resident goes, in the roster's own words, checked before the game is
ever asked**, plus the credential plan that keeps eight residents from turning into one shared privilege
and the honest answer to "what can the server set for lighting?".

```
NemoWorld src/living-world.js LIVING_ROSTER (eight residents, four phases each)
        |
        v
content/veloren-world-landmarks.json  --validated by src/veloren-ext/world-residents.js-->
        |                                    (roster, places, the Quiet Survey's own ids)
        v
wt/run/<stream>/veloren-link.json     "landmarks": [site + plot + nth, never a coordinate]
        |                             "residents": {"Aria": "lw-aria", ...}
        v
Veloren server: resolves each landmark from world generation, logs every one it resolved,
                matches a resident to her character by alias, signs what it observes
        |
        v
nemo-bridge --resident lw-theron: walks her to the landmark labelled with the phase, answers players
```

## What this stream does today, and what is not here

| Piece | Where | State |
|---|---|---|
| The places NemoWorld may dress and the plots it knows by name | `content/veloren-world-places.json` | in this tree, committed (`42180ad`) |
| NemoWorld's own validator for a world manifest | `src/veloren-ext/world-manifest.js` | in this tree, cross-checked against the game's Rust checker by `tests/veloren-world.test.js` |
| The eight residents' schedule, as real Harr structures | `content/veloren-world-landmarks.json` | in this tree |
| The validator for that schedule, and the credential plan | `src/veloren-ext/world-residents.js` | in this tree |
| Schedule mapping and credential scoping tests | `tests/veloren-world-residents.test.js`, `tests/veloren-world-scopes.test.js` | in this tree, 20 tests |
| The world-dressing system (props, a furnished interior) | would be `server/src/sys/nemo_world.rs` **and does not exist** | **not here, not anywhere** |
| The `nemo-world-core` crate (manifest vocabulary, the checker binary, the sky model) | `wt/veloren-world/nemo-world-core/` | the other half of this stream, in the owner's tree, not applied by any server system |
| The eight residents actually running | eight `nemo-bridge` processes | **not run by this work** - see "In the game" |
| A new link scope, a new route, or a new table | - | **none**: this stream adds data and a validator, never a privilege |

## The eight residents' places

`content/veloren-world-landmarks.json` holds two things: the six landmarks, in exactly the shape the
Veloren link config takes (`id`, `label`, `name`, `site`, `plot`, `nth`, `radius`), and the schedule that
maps each of the roster's 32 destinations to one of them - or marks it unmapped, with a reason and what
would be needed.

The mapping is not a matter of taste. Harr's plots were read from the server itself during the home and
atlas streams' live runs (`wt/run/home/logs/veloren-server.log`:
`site Harr (origin Vec2 { x: 15216, y: 16016 }) has 5 plots: House@(15225,16007) FarmField@(15231,16025)
Workshop@(15207,15995) FarmField@(15225,15983) Plaza@(15213,15977)`), and a landmark is chosen by
`site` + `plot` + `nth`, where `nth` counts a site's plots **of that kind**, nearest the site's origin
first (`server/src/sys/nemo_link.rs:221-227`). So the far farm field is `nth: 1`, and that is a real
field, not a guess.

| NemoWorld label | Landmark id | Real structure | Resolved position |
|---|---|---|---|
| Library | `lyra-house` | `House` 0 | (15225, 16007) |
| Peace Pavilion | `lyra-field` | `FarmField` 0 | (15231, 16025) |
| Meeting Hall | `lyra-plaza` | `Plaza` 0 | (15213, 15977) |
| Central Plaza | `harr-central-plaza` | `Plaza` 0 (the same square) | (15213, 15977) |
| Workshop | `harr-workshop` | `Workshop` 0 | (15207, 15995) |
| Orchard | `harr-orchard` | `FarmField` 1 | (15225, 15983) |

Three things about this table are deliberate:

* **`lyra-house`, `lyra-field` and `lyra-plaza` keep their labels, plots and names**, because
  `content/veloren-landmarks.json` (the link's `post`/`survey`/`place` roles), the link configs of the
  link, home, hud and atlas streams and the Quiet Survey's own objective text all name them. A test
  pins the three exactly, and the validator refuses a file that renames or drops one.
* **"Central Plaza" and "Meeting Hall" are the same square.** Harr has one open plaza and NemoWorld has
  two names for that kind of place. The bridge looks a landmark up by its label alone
  (`nemo-bridge/src/main.rs`, `landmarks.iter().find(|l| l.label == label)`), so two names need two
  entries at the same structure - and the file says so (`shared_with`), which the validator requires for
  any repeated structure.
* **Four of the 32 destinations are honestly unmapped.** Harr has no harbour, no observatory and no
  gateway, and the world site snapshot (`wt/nemoworld-atlas/content/veloren-atlas-sites.json`, 148 sites)
  has no harbour, dock, lighthouse, tower or lookout kind at all: the nearest water-side structure is the
  Bridge of Ning, 2534 blocks away, and the nearest raised site is Corasi Palace, 1880 blocks away. Rather
  than invent a place:

| Resident | Phase | Label | What would be needed |
|---|---|---|---|
| Bram Wayfarer | dawn | Harbor | a dock or harbour built at a Harr plot by the (missing) world-dressing system, or an owner decision to send him to the nearest bridge - a 2534-block walk |
| Bram Wayfarer | dusk | Observatory | a lookout or observatory built on high Harr ground |
| Rowan Commonreach | dawn | Gateway | a gate or boundary marker at a Harr plot, or a Veloren change letting a landmark name a whole site: today a link-config landmark must give a `plot` as well as a `site` (`server/src/sys/nemo_link.rs:216-228`), so Harr's own arrival field cannot be used |
| Rowan Commonreach | dusk | Harbor | the same harbour structure |

A resident whose phase is unmapped stands still and the bridge logs
`no landmark for phase <phase> ("Harbor"); standing still`. She still answers players; she just does not
walk. That is visible and honest, which is what the brief asked for instead of a guessed destination.

## Credentials: eight residents, minimal scopes

The plan is in `src/veloren-ext/world-residents.js` (`credentialPlan()`), and `tests/veloren-world-scopes.test.js`
proves it against the real link surface and the real issuing command, not against a mock:

| Credential | Scopes | May | May not |
|---|---|---|---|
| one per resident's bridge | `talk,director` | answer a player who speaks to her; be told where she should be | sign facts into NemoWorld; speak or be directed as another resident; mint Karma; confirm a purchase; change an account or a plot |
| one per resident's relay | `events` | hand NemoWorld signed facts **about its own resident** | talk, be directed, or anything else |

* `src/veloren-link.js:33` (`LINK_SCOPES`) is `events`, `talk`, `director` - and no scope's name promises
  authority (`credentialPlan()`'s forbidden words are checked against the list, so a future `karma` or
  `purchase` scope would fail the test rather than pass unnoticed).
* A credential is bound to **one resident**: a validly signed fact about another resident is refused with
  `resident_out_of_scope` (`src/veloren-link.js:359`) and stored nowhere, and the talk route refuses a
  `resident_id` that is not the credential's own (`src/veloren-link.js:461`).
* Eight credentials are independent: revoking one leaves the other seven working, and expiry is per
  credential (proven in the test).
* **A route a link credential must never reach** - confirm/decline/retry a purchase, redeem a link code,
  mint Karma, assign land, unlock a vault - is refused for every combination of link scopes, and the
  link's own surface never touches NemoWorld's economy while answering one.

### The one thing eight residents expose (a decision for the owner)

`wt/stack.sh world start` runs **one** relay with **one** `events` credential. That credential is bound to
one resident, and the relay treats a rejection as final: it advances its offset past it
(`src/veloren-relay.js:89-91`), logging only `event <server>:<seq> rejected: resident_out_of_scope`. So
with eight residents in the link config, **facts about the other seven are dropped, once, silently**, and
never retried. The world stream is the first stream with more than one resident, so it is the first to hit
this; `tests/veloren-world-scopes.test.js` proves it end to end with the real relay code.
Options, cheapest first: a filtered relay (skip lines whose `resident_id` is not this credential's), one
relay credential per resident with one relay process per resident (works today, wasteful: each relay sends
the whole outbox and is refused for seven eighths of it), or a `relay` scope the link core does not have.
See `wt/evidence/world/REMAINING.md`.

## Lighting: what the server can set, and what is client-only

Nothing in this section was guessed; every claim cites the line in the owner's Veloren tree that proves
it. Nothing was built or run to write it.

### The day cycle

| Question | Answer | Proof |
|---|---|---|
| Where does the time of day live? | A resource, `TimeOfDay(f64)` seconds since day 0, plus `Time` (physics ticks) | `common/src/resources.rs:11`, `common/src/resources.rs:47` |
| Where does the world's starting time come from? | The server setting `world.start_time`, applied once at startup | `server/src/lib.rs:547`; `veloren/userdata/server/server_config/settings.ron:35` (`start_time: 32400.0`, i.e. 09:00) |
| How long is a day? | The server setting `day_length`, in **real minutes per in-game day** | `server/src/settings/mod.rs:187` (the field), `:341` (`day_cycle_coefficient() = 1440.0 / day_length`); `settings.ron:15` (`day_length: 30.0` - a 30-minute day) |
| Does it advance by itself? | Yes: `TimeOfDay += dt * day_cycle_coefficient * time_scale` every tick | `common/state/src/state.rs:869` |
| Can it be changed at run time? | Only by an **admin chat command**: `/time <midnight\|night\|dawn\|morning\|day\|HH:MM\|seconds>` writes the resource directly, and `/time_scale <f64>` (clamped 0.0001-1000) changes the rate | `server/src/cmd.rs:1512` (the values), `:1678` (the write), `:1714` (`/time_scale`); both are `Admin`-only (`common/src/cmd.rs:1007-1016`) and gated by the role check at `server/src/cmd.rs:136-140` |
| What are the phases? | `DayPeriod` is derived from the seconds: Night before 06:00, Morning to 11:00, Noon to 16:00, Evening to 19:00, Night after - which is what the bridge's `--phase`/schedule reads | `common/src/time.rs:11-26`; the bridge maps them to `dawn`/`day`/`dusk`/`night` (`nemo-bridge/src/main.rs`, `phase_name`) |
| Is there a NemoWorld-facing way to set it? | **No.** The resource is a plain `TimeOfDay` any server system could write, but nothing on the link reads or writes it today: a `world` section in the link config, and a server system that follows it, would be needed | `server/src/sys/nemo_link.rs` (no `TimeOfDay` at all); the draft's `nemo-world-core/src/sky.rs:106-129` already computes the time of day for a NemoWorld phase, and `:158-181` the weather, but no server system calls it |

NemoWorld already owns a clock, and it is the one the schedule follows: a 120-minute cycle of four
30-minute phases, measured from the Unix epoch, so every client computes the same phase without talking
to anyone (`src/atmosphere.js:1-19`), and a deterministic 20-minute weather slot on top
(`src/scene/weather.js:11-14`). Mapping that onto Veloren needs the write above plus a decision about
`day_length`: NemoWorld's four phases take two real hours, and 30 in-game minutes per real minute is the
current setting.

### Light-emitting props

| Question | Answer | Proof |
|---|---|---|
| Does the game know which blocks are lit? | Yes, in the shared source: `Block::get_glow()` returns a glow level for 57 block kinds and sprite kinds - `Lantern` 24, `StreetLamp`/`StreetLampTall` 24, `BonfireMLit` 24, `Candle`/`WallSconce`/`WallLamp` 16, `GlowingRock` 10, `GlowingMushroom` 20, and so on | `common/src/terrain/block.rs:414-470` |
| Who actually reads it? | **Only the client.** The three callers are all in `voxygen`, the game client's terrain meshing | `voxygen/src/mesh/terrain.rs:270`, `voxygen/src/mesh/greedy.rs:830`, `voxygen/src/mesh/segment.rs:206`; no server system reads it |
| So what is a "lit prop" on the server? | A block whose kind or sprite name the *client* knows how to light. Placing it is a terrain write; being lit is rendering | as above |
| Can the server place one? | Yes: `/make_block <kind> [r g b]` writes the block into the live terrain and the persistence store, and `/make_sprite <sprite>` sets a sprite on the block under a target | `server/src/cmd.rs:816` (`handle_make_block`), `:828` and `:836` (terrain + persistence), `:993` (`handle_make_sprite`), `:1021-1025` (the sprite write); both `Admin`-only (`common/src/cmd.rs:805-814`, `:828-832`) |
| Can the server put a light *entity* somewhere? | Yes, but it is a runtime entity, not terrain, and nothing persists it: `/light [r g b] [x y z] [strength]` spawns an entity carrying the `LightEmitter` component, `/lantern <strength> [r g b]` adjusts one, `/remove_lights` takes them away | `server/src/cmd.rs:3701`, `:3767`, `:4871`, `:3743` (`create_entity_synced`); the component is `common/src/comp/visual.rs:6`; the only entity persistence is for player characters (`server/src/sys/persistence.rs:15-35`) |
| Do placed blocks survive a restart? | **Only if terrain persistence is switched on.** It is off by default and absent from the shipped settings, so `/make_block` edits live terrain and is lost when the world is regenerated | `server/src/settings/mod.rs:200` (the field) and `:234` (`false` by default); `server/src/lib.rs:404-424` (the store is inserted only when the setting is true); `settings.ron` (no such key) |
| How would it persist if switched on? | The store keeps only *modified* blocks per chunk, writes a chunk on unload, and overlays them onto the chunk world generation produces again | `server/src/terrain_persistence.rs:215` (`set_block`), `:163-199` (`unload_chunk`), `:64-87` (`apply_changes`); the feature is compiled by default (`server/Cargo.toml:19`) |
| Does the draft's crate agree? | Its `LIGHT_SPRITES` list (14 sprite names) is a subset of the 57 in `block.rs`, and it counts them in the checker's summary (`lit_sprites`) instead of setting anything | `wt/veloren-world/nemo-world-core/src/manifest.rs:72-79`, `:540-560`; all 14 names appear in `block.rs`'s table (checked against the source; the crate's own comment claims that test but it does not exist) |

### Weather

Weather **is** server-side, unlike block glow: `WeatherSim::tick(time_of_day, …)` advances a
`WeatherGrid`, which the server sizes and publishes to clients (`SharedWeatherGrid`), and an admin can
force a zone with `/weather_zone <clear|cloudy|rain> [radius] [time]`
(`server/src/weather/sim.rs:92`, `server/src/weather/tick.rs`, `common/src/weather.rs:79,120`,
`server/src/cmd.rs:6214`). Rain, mist and lightning are simulated on the server and drawn on the client.

### What is client-only

Rendering: the sun, the moon, the sky, the light that a glow level produces, shadows, fog, rain and the
lightning flash. That is why the answer above is "the server places blocks and entities, the client
lights them", and why the draft's sky model stops at *times and weather values* (`sky.rs`) instead of
trying to set a light level. A different *look* for Harr (warmer lanterns, a night that is brighter)
would need `voxygen` - the 45-minute, 10 GB build the rules forbid - and is therefore out of scope.

## Where the pieces live

| Piece | File |
|---|---|
| The places NemoWorld may dress, and NemoWorld's manifest validator | `content/veloren-world-places.json`, `src/veloren-ext/world-manifest.js` |
| The residents' landmarks and schedule, the validator, the credential plan | `content/veloren-world-landmarks.json`, `src/veloren-ext/world-residents.js` |
| Tests | `tests/veloren-world.test.js` (+4), `tests/veloren-world-residents.test.js` (+9), `tests/veloren-world-scopes.test.js` (+11) |
| The game's half (not this tree) | `wt/veloren-world/nemo-world-core/` (`manifest.rs`, `sky.rs`, `bin/nemo-world-check.rs`), the bridge's `--survey`/`--dump` probes, `nemo-bridge/roster.json` |

This stream adds **no** route, no scope, no table and no line in `src/veloren-ext/index.js`: nothing here
needs to answer a request at run time. NemoWorld's authority over the roster, the places and the
credentials is data plus a validator, and the game keeps its own vocabulary
(`nemo-world-core` decides what it can build; the link config takes a `site` + `plot`, never a block).

## In the game

The residents can be run today - the bridge, `roster.json` (all eight residents) and the server's
landmark resolution all exist - but the world-dressing part cannot: there is nothing new to *see* in the
world. What a person can do, honestly:

```bash
# 1. the landmarks and the residents this stream owns, into the stack's link config
#    (wt/run/world/veloren-link.json): copy content/veloren-world-landmarks.json's "landmarks" array
#    into "landmarks", and set "residents" to the eight characters:
#      {"Aria":"lw-aria","Theron":"lw-theron","Bram":"lw-bram","Lyra":"lw-lyra",
#       "Kael":"lw-kael","Selene":"lw-selene","Vaelen":"lw-vaelen","Rowan":"lw-rowan"}
#    (node -e "import('./src/veloren-ext/world-residents.js').then(m=>console.log(m.linkConfigNote()))")
wt/stack.sh world init && wt/stack.sh world build      # server + bridge, 7-25 minutes
wt/stack.sh world start                                # the server logs every landmark it resolved:
grep "landmark .* is at" wt/run/world/logs/veloren-server.log

# 2. a second resident, with her own credential (never Lyra's, never a shared one)
wt/stack.sh world issue-credential lw-theron talk,director theron.token
wt/stack.sh world resident-start lw-theron theron.token
tail -f wt/run/world/logs/resident-lw-theron.log       # status: phase=day mode=schedule
                                                       #   going to 'Workshop' (harr-workshop) ...
```

In the game, as the home, shop and hud streams did in their live runs: whisper him -
`/tell Theron who are you` answers with his calling, `/tell Theron where are you` answers "At this hour
you will find me near Harr's workshop" once he is at the landmark for the phase, and everything he says
is scripted unless it starts with `[AI]`. What you will **not** see: a lantern, a furnished interior, a
different sky, or a gate at the frontier - none of that exists yet.

## Tests

```
node --test tests/veloren-world.test.js tests/veloren-world-residents.test.js tests/veloren-world-scopes.test.js
```

* `tests/veloren-world-residents.test.js` (9 tests): the checked-in manifest passes NemoWorld's own
  validator; 28 named mutations are each refused with the reason (a plot Harr does not have, an `nth` the
  world does not have, a duplicate id or label, two entries on one structure without saying so, a label
  that is not the roster's word, a resident the roster does not have, an unmapped label with no reason or
  with a landmark, a dropped or renamed Quiet Survey landmark, …); every one of the eight residents has
  all four phases, with the roster's own label and a real Harr plot, or an explicit explanation; the three
  legacy ids keep their exact labels, plots and names; the emitted array has exactly the seven keys the
  server reads and unique labels; the character map is the eight characters; and the game's own resolution
  of Harr - read from the last live server log - confirms every plot and `nth` exists and that no
  landmark centre sits inside another landmark's radius.
* `tests/veloren-world-scopes.test.js` (11 tests): the plan is minimal and every scope in it is one the
  link knows; a talk-only credential may speak and is refused for events, director, progress and status;
  a director-only one the reverse; an events-only one may hand in its own resident's facts only; a
  credential cannot speak or sign for another resident (`resident_out_of_scope`); eight credentials are
  independent under revocation and expiry; **no** scope combination reaches a route that confirms a
  purchase, redeems a link, mints Karma, assigns land or unlocks a vault, and the link never touches
  NemoWorld's economy while answering one; a scope promising authority cannot be issued by the real
  `scripts/veloren-link.mjs`; and one relay credential silently drops the other seven residents' facts.

## Limits and what is missing

1. **The world-dressing system does not exist.** No system applies a manifest: no props have ever been
   placed in Harr, no interior exists, and `nemo-world-core` is called by nothing but its own checker
   binary and the bridge. Finishing it needs a server system (`server/src/sys/`) that reads the
   manifest from a `world` section of the link config, expands it through `nemo-world-core`, writes
   blocks through the same path `/make_block` uses, records what it applied next to the outbox so a
   restart re-applies identically instead of duplicating or fighting the reconciler, and acknowledges.
   A prototype command that proves the terrain write end to end would be `make_block`-shaped and small;
   a durable version also needs terrain persistence switched on (see the table above), or the
   re-apply-on-startup record.
2. **Nothing in this stream has been run live.** No build, no stack, no server, no bridge was started for
   this work (the rules reserved those for the owner while another stream was building). The manifest is
   checked against the *last* live run's own resolution of Harr, which is real evidence, but this
   manifest has never been in a running server's config.
3. **Eight live processes are still a plan.** The roster, the schedule, the credentials and the commands
   are written and tested; the running of eight bridges is not, and it needs the relay decision above,
   plus one credential per resident and a check that eight characters can actually log in at once.
4. **The lighting questions are answered only as far as the source can answer them.** No `/time`,
   `/time_scale`, `/light` or `/weather_zone` was run, and `voxygen` was never built, so "the client
   lights a lantern" is read from the code (`get_glow` and its three callers), not observed. Nothing
   about how bright a night looks has been measured, and NemoWorld's four-phase clock has never been
   mapped onto a running server's day.
5. **The unmapped four stay unmapped** until a structure exists or the owner chooses an alternative
   (see the table above). Four of 32 destinations, affecting Bram and Rowan.
