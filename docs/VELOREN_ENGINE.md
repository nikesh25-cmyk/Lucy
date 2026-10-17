# Veloren engine: cooperation as a fact, research that gates the works, and missions from a catalogue

Stream `engine` of the Harr work (`wt/WORK_DIVISION.md`). Three things become real:

1. **A helping hand is recorded.** When a crew-gated stage of a public work is first built, every *visitor*
   standing in the crew earns a signed `project.helped` fact, named for the stage's `site-*` landmark.
2. **Research gates the works.** Some projects wait for a technology the village has not learned yet;
   NemoWorld issues a signed `works_unlock`, the server applies it once, keeps it in its record, and
   acknowledges it.
3. **Missions are a catalogue.** Eight missions across the charter's six principles, each checked only from
   facts recorded for that player, with three featured each day on the guide's new `missions` page.

The Quiet Survey (the practice quest) is untouched and keeps its tests. Nothing here awards coins, items or
power; no mission or line involves fighting, scarcity or conquest.

## How it fits together

```
players stand in a crew  --server signs-->  project.helped   --relay-->  NemoWorld stores it
                                                                    |--> research insight (+2 per helper per site)
                                                                    |--> the "Lend a hand" mission
                                                                    |--> the chronicle and the dashboard
research queue learns a technology  --NemoWorld signs-->  works_unlock {tech}  --server reads-->  the stage may build
```

Both facts travel the same signed channel as everything else: an HMAC-signed event, stored once by id; a
signed, expiring, once-only command with an acknowledgement. Nothing in chat or a model can create either.

## The server (`veloren/server/src/nemo/world/`)

* **`project.helped`** — emitted in `dress.rs` when `logic::decide` says a group is written for the **first**
  time (`reason="new"`, no record yet) and its stage is crew-gated (`crew > 0`) and names a site
  (`site: "site-*"`, required by the manifest validator for a crew-gated stage). The helpers are the
  *visitors* within the crew radius (20 blocks): configured residents are the village's own crew and earn
  nothing. At most 8 per stage, in uuid order, so the same crew always makes the same facts; one visitor's
  help for one project is not repeated within 5 minutes. The event's `landmark_id` is the site; its witness
  resident is the relay's resident (`ack_resident`), the same convention `landmark.visited` uses.
  **A restart that restores the town emits nothing**, and neither does a rewrite after a manifest change:
  only the first build is cooperation.
* **`works_unlock {tech}`** — the world system is the only claimant of that kind. The arguments must be
  exactly `{"tech":"<plain id>"}`; the technology must be one the loaded manifest actually gates
  (`needs_tech`), which is the allow-list; every command is acknowledged `unlocked`, `already_unlocked`,
  `unknown_tech` or `bad_arguments`. The unlocked set lives in `<outbox>.world.json` (`unlocked`), so a
  restart remembers what the village learned. A stage whose technology is not unlocked waits with the reason
  `waiting for research: <tech>` — it is never built, and the board shows exactly that.
* The shipped manifest gates five first stages: research tower → `field-notes`, vertical farm →
  `vertical-farming`, glass garden → `glasswork`, sky transit hub → `sky-transit`, open archive →
  `open-archive`.

Manifest fields (all additive, validated by `nemo-world-core`, 20 tests):

```json
{ "id": "gl…-1", "project": "glass-garden", "site": "site-garden", "crew": 2, "needs_tech": "glasswork" }
```

## NemoWorld (`nemoworld/src/veloren-ext/`)

* **`project.helped`** — `veloren-link.js` accepts the kind only with a `site-*` landmark (a help at a
  discovery or a house is refused: `site_required`). `research.js` counts *people who lent a hand at a work
  site* — one per (player, site) pair, because the signed fact names the site and not the stage, so this is
  the honest measure of participation — and adds `per_help: 2` insight each. The task **Lend a hand to the
  builders** is done by one recorded help; the chronicle says "N helpers stood with a building crew"; the
  dashboard shows `research.sources.helped`.
* **`works_unlock`** — `announceResearch(link)` runs from the director hook (the 30-second tick every
  resident's poll already drives). For each learned technology not yet announced it issues one signed
  `works_unlock` (120 s lifetime, `issuedBy: 'research'`) and records it in `village_marks` as
  `tech:<id>`. A pending or applied unlock is never asked again; one that expired unacknowledged is asked
  again; a refusal is not retried (the server logged why). The actor is `VILLAGE_ACTOR`
  (`00000000-0000-4000-8000-000000000000`): the unlock is the village's, not a player's.
* **Missions** — `content/veloren-missions.json` + `missions.js`: `validateMissions` (ids, principles from
  the charter, known kinds, counts 1–20, distinct only where meaningful, prefixes only on visits, bounded
  text, no violent vocabulary), `stepCount` (every query scoped to the player; distinct residents or
  landmarks; the link, pantry and practice quest read from their own records), `missionsFor` (steps are
  independent — a fact for one never credits another), `dailyRotation` (three a day, stable within the day,
  different across days), `missionsLines` (the guide's page). `tasks.js` is a thin view over the same
  catalogue, so the short task list and its wording are unchanged.

## Try it in the game

1. Ask the guide (whisper Selene) for `missions` — today's three first, then all eight, with one next step.
   `tasks` still shows the short list.
2. Whisper `works`: a stage that waits shows either *needs a crew* or *waiting for research: <tech>*. Walk
   to its site and stand with the builders until it is built; the village records that you helped.
3. Add insight by finding places and by lending a hand; when the queue learns a technology, a gated project
   stops waiting on its own (the game server is told by a signed command and acknowledges it).

## Tests

* `nemo-world-core`: 20 pass / 0 fail (`site` and `needs_tech` shapes and refusals, the good cases).
* `veloren-server --lib nemo_world`: 21 pass / 0 fail (crew counting, visitors-only helpers with cap and
  order, research gating and the argument parser, every existing test unchanged).
* `node --test tests/veloren-*.test.js`: 163 pass / 0 fail, including the new `veloren-missions.test.js`
  (catalogue validator with nine refusals, distinct counting, another player's facts never counting,
  wrong-target facts crediting nothing, replay, link/pantry/quest steps, page privacy and bounds, rotation).
* Live: `wt/evidence/engine/` — the two-bot scenario and its logs.

## Limits worth knowing

* **Presence proves that someone stood with a crew, not that they did useful work.** It is the same honest
  level as every other fact in this project.
* The server's help cooldown is 5 minutes per (player, project) and lives in memory; a restart could in
  principle credit the same visitor again for a *different* stage of the same project, which is legitimate
  (a different stage is new cooperation).
* `announceResearch` is driven by the director poll, so an unlock is issued within about 30 seconds of the
  queue learning a technology, not instantly.
* The generator (`nemoworld/tools/gen-harr-works.py`) is owned by `look`; it does not yet write `site` or
  `needs_tech`, so a regeneration would be refused by the validator (loudly, which is the safe failure).
