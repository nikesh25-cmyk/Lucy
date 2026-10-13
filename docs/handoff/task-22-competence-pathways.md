# Task 22 — competence pathways for each calling

Branch `task-22-competence-pathways`, based on `verify-batch02-wave-f` (merge `c8d3f4c`, which
contains tasks 01–21, 24, 27, 28, the flake fix and the docs pass). **Schema stays 21**: this layer
stores nothing.

## What was asked, and what was built

One **derived competence pathway per calling** — eight in total — that advances only from diverse
saved server facts, shows what a resident has actually practised and what evidence supports it, names
a concrete next challenge, survives a restart, stops counting when its supporting evidence is withheld,
and unlocks original cosmetic membership, recipe discovery and suggested practice routes without ever
granting a role, a land right, review authority or a NemoCoin.

There is no new table, column, writer, endpoint or migration. `GET /callings` already returned the
resident's private calling view, so the pathway simply rides along in that payload.

## The pathway model

Each pathway is an ordered list of **tiers**. A tier names one or more **requirements**, and a
requirement states exactly two things: the kind of saved fact, and how many of it are needed. A
requirement is published in one of three **evidence states**:

| State | Proven by | Source of truth |
| --- | --- | --- |
| `practice` | A saved activity inside NemoWorld — placed block, saved path, home object, shared visit, planted or harvested crop, crafted keepsake, recorded thanks, circle membership, project pledge, RSVP, leased claim. | An **available** `calling_receipts` row: the ledger the calling objectives and quest steps already share. |
| `verified-contribution` | Real scoped work that a **different, authorized human reviewer accepted**. | `contributionSource` / `contributionEligibility` — the exact predicate the journey merit summary and the coin ledger use. |
| `external-adoption` | A mission owner's recorded declaration that accepted work was taken up. | The `adoptions` rows the journey merit summary already counts. |

Tiers report `complete` / `available` / `locked`. A saved fact is allocated to **one** tier in a read,
so no receipt credits two tiers — the same "one saved fact, one credit" rule the calling objectives and
quest steps already follow. Every requirement also carries the concrete `action` (kind, section, label,
saved fact) the interface already knows how to open, so "next challenge" is an instruction, not a score.

## The eight pathways

| Calling | Pathway | Tier 1 | Tier 2 | Tier 3 | Tier 4 (all callings) |
| --- | --- | --- | --- | --- | --- |
| Explorer | The Long Way Round | `shared_visit` | `shared_visit` + `circle_join` | `circle_join` + accepted work | adoption |
| Builder | Ground Held Open | `frontier_place` | `frontier_place` + `home_furnish` | `home_furnish` + accepted work | adoption |
| Cultivator | The Patient Season | `crop_plant` | `crop_plant` + `crop_harvest` | `crop_harvest` + accepted work | adoption |
| Researcher | The Evidence Ladder | `research_claim` | accepted work | adoption | — |
| Steward | The Open Way | `frontier_expand` | `frontier_expand` + `path_place` | `path_place` + accepted work | adoption |
| Mediator | Kindness Made Specific | `thanks` | `thanks` + `project_pledge` | `project_pledge` + accepted work | adoption |
| Artisan | Hand and Hearth | `craft` | `craft` + `home_furnish` | `home_furnish` + accepted work | adoption |
| Host | The Open Door | `event_rsvp` | `event_rsvp` + `circle_join` | `circle_join` + accepted work | adoption |

Tiers 1–3 use the calling's **own two daily objective sources**, so every pathway is reachable inside
one calling without a calling change. The reviewed and closing tiers use the two calling-independent
classes, which is what makes "independent review where applicable" meaningful for every calling rather
than only for the Researcher (whose own second practice source *is* the independent acceptance, so its
ladder is one tier shorter). A receipt counts by what it records, not by which calling credited it, so
practice is never lost across a calling change.

## The diversity rule, and how it is enforced

> Every tier after the first names at least two **different** kinds of saved fact — or rests entirely on
> an independent acceptance or a recorded adoption, which one activity cannot produce — and every tier
> names at least one kind **no earlier tier required**. One repeated activity therefore completes at
> most the first tier.

1. **At module load:** `pathwayDefects()` validates all eight ladders and the module throws if one could
   be walked by a repeated source, names an unknown fact kind, suggests an unknown sealed recipe,
   repeats a kind inside a tier, records an adoption anywhere but the closing tier, uses a requirement
   key other than `kind`/`min` (so no tier can carry a role, scope or reward field), opens with
   anything but the calling's own first objective source, or leaves a calling without a pathway.
   `PATHWAY_DEFECTS` is exported and asserted empty.
2. **At read:** requirements are consumed from a pool in tier order.
3. **In tests:** `tests/pathway.test.js` proves the property for every pathway over **every** source
   kind — sixty receipts of one kind, sixty contributions, or sixty adoptions complete at most the
   first tier — while supplying exactly the named evidence completes every tier. A live cultivator
   test plants the same crop four days running and asserts the ladder stops at tier 1.

## Withholding evidence

Nothing is copied, so nothing goes stale. Every read re-evaluates the ladder from receipts whose source
is still available, contributions that are still eligible, and adoptions that still sit on an eligible
accepted submission. Quarantining an accepted submission turns its receipt into held calling
experience, removes the contribution from the merit predicate and withdraws the adoption — so the tier
stops counting, reports `have: 0`, and waits for an independent reviewer again. Restoring the evidence
restores the tier. No row is rewritten or deleted, and `verifyCallingReceipts` stays true throughout.
`tests/pathway.test.js` asserts exactly this sequence, both for a held calling receipt and after a
close-and-reopen restart.

## Progression, unlocks and what it is not

- **Cosmetic unlock.** Two different kinds of saved *available* practice unlock the sealed
  `explorer_banner` avatar decoration, which until now only three shared discoveries unlocked. This is
  a real, additive eligibility route in `src/journey.js` (`practiceKindCount`) — nothing is removed and
  no new definition is written. Withheld practice closes the route again for a new selection; a
  decoration already chosen behaves exactly like the existing early-achievement cosmetics.
- **Recipe discovery.** Each pathway names the sealed recipes that suit its stages, with ingredients, and
  marks them earned as tiers complete. Every recipe stays craftable — the pathway *suggests* which one
  to try, and both the payload and the interface say so.
- **Suggested practice routes.** `pathway.next` names the missing saved fact, its count and the action
  to open.
- **No role, land, review authority, scope or coin.** `PATHWAY_POLICY.grants` is all-false/zero, the
  module writes nothing outside a read, and `POST /callings/select` stays session-only. The tests
  complete a whole pathway and assert the account role, `land_stewardships`, `frontier_blocks`, the
  self-review refusal and the runtime's refused calling selection are all unchanged, with exactly one
  10-coin receipt per independent acceptance (the ledger's own award, never the pathway's).
- **No qualification claim.** `PATHWAY_POLICY.disclosure` says a pathway is not a qualification, a
  professional credential, a certification or a measure of intelligence or capability; the interface
  prints that sentence verbatim, and `tests/pathway-http.test.js` asserts both.

## Changed files

- **Extended:** `src/vocations.js` (`PATHWAYS`, `PATHWAY_POLICY`, `PATHWAY_STATES`, `PATHWAY_DIVERSITY`,
  `PATHWAY_SOURCE_KINDS`, `PATHWAY_UNLOCK_BANNER`, `pathwayDefects()`/`PATHWAY_DEFECTS`,
  `pathwayProgress()`, and `pathway` on the `callings()` payload), `src/journey.js` (`practiceKindCount`
  and the second route to the sealed banner decoration in `cosmeticOptions`), `app.js`
  (`pathwayCard`, `pathwayTierCard`, `PATHWAY_STATE_KEYS`, the pathway card in `renderCallings` and a
  compact pathway line in the world calling card), `docs/API.md` (a *Competence pathways* section with
  the payload).
- **New:** `tests/pathway.test.js`, `tests/pathway-http.test.js`, `docs/PATHWAYS.md`,
  `docs/handoff/task-22-competence-pathways.md`.
- **Untouched on purpose:** `src/database.js`, `src/recovery.js`, `src/coins.js`, `src/quests.js`,
  `server.js`, `package.json`, `content/**` and its manifest, `scripts/ops-rehearsal.mjs`, the browser
  and e2e harnesses, `docs/CALLINGS.md` (owned by a parallel agent this wave) and `outputs/Lucy`.
- **No schema bump**, so no version assertion in any other test had to move.

Two ownership constraints shaped the design, and both are deliberate:

- `docs/CALLINGS.md` is owned by another agent this wave, so the calling documentation lives in the new
  `docs/PATHWAYS.md` and in the API reference instead.
- Adding new cosmetic definitions would have required editing the sealed drift guards
  (`tests/content.test.js`) and `docs/CONTENT_DEFINITIONS.md`, neither of which this task owns.
  Requirement 5 explicitly allows "recipe discovery or suggested practice routes" instead, so progression
  unlocks the one *existing* gated decoration, recipe discovery and suggested routes, and the sealed
  content layer is unchanged (89 definitions, 32 cosmetics).

## Verification

Node v24.19.0, in the task worktree.

```
$ npm run check
check exit=0            # every file in the gate parses, including app.js, src/vocations.js and src/journey.js

$ npm test
ℹ tests 567
ℹ pass 567
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 56393.883542
# baseline was 562; the five new cases are 4 in tests/pathway.test.js and 1 in tests/pathway-http.test.js

$ npm run e2e
PASS  15/15 steps, 0 failed   (step 15: one saved practice activity, one cosmetic receipt, zero coins)

$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files;
42 referenced notices and assets.        # unchanged: no content definition was added or edited

$ npm run browser
NemoWorld browser acceptance suite · 21 scenarios · Chrome 155.0.8059.40 via playwright-core
SUMMARY  21 passed, 0 failed
  PASS  accounts-and-switching, credential-exclusion, private-draft-isolation,
        refresh-and-focus-restoration, first-person-controls, country-ambassadors,
        plot-and-blueprints, character-switch-clears-preview, quest-progression,
        guild-cooperation, reward-refusals, forged-coin-receipt-refused,
        resident-run-resume-refusal, shared-presence-two-clients,
        subscription-entitlement-and-revocation, interaction-hint-and-distance,
        interaction-saved-world-changes, interaction-door-and-crafting,
        interaction-ambassador-desk, interaction-state-refusals, signout-privacy
browser exit=0
```

`tests/pathway.test.js` (4 cases): the authored shape of all eight pathways and the single-repeated-
source proof for every source kind; a live cultivator grinding one crop and then adding a second kind;
withheld evidence and the restart; a whole pathway completed with its restart, backup round-trip and the
no-role/no-land/no-coin assertions. `tests/pathway-http.test.js` (1 case): privacy (401/404/runtime),
the three distinct states in the payload, the concrete next challenge, the refusal to leak a pathway
through the public guild directory, and source-level wiring of the three states in `app.js`.

### Browser suite

**Run, and it passed.** The dev dependency the suite needs (`playwright-core`, already declared in
`package.json` and pinned in `package-lock.json`) was installed with `npm ci`, which writes only the
gitignored `node_modules/` and leaves the lock file and `package.json` untouched. The suite then drove
the real interface in the system Chrome (155.0.8059.40) against a private temporary workspace and
database: **21 scenarios passed, 0 failed**, exit code 0, workspace and traces removed. No scenario was
added — `scripts/browser-suite.mjs` belongs to another task — so the pathway card is covered by the
existing scenarios (which open the Callings & guilds section, switch characters and read the calling
payload) plus the payload- and source-level assertions above rather than by a dedicated new scenario.
`git status` after the run shows only the eight intended source/doc/test changes.

## UI verification

The pathway card renders three **separate** records for the three states — `data-pathway-state="practice"`,
`"verified-contribution"` and `"external-adoption"`, each with its own badge text, heading and detail
paragraph — above the next-challenge card (which names the missing saved fact, its count, and a button
that opens the existing calling action) and the per-tier list with the receipts behind each tier. The
card is built entirely with `document.createElement`/`textContent`; `app.js` still contains no
`innerHTML`, and the HTTP test asserts that. Everything is derived server-side, so no interface state
can credit a tier.

## What this deliberately did not do

- **No new storage.** No table, column, index, trigger or migration; the schema stays 21 and the account
  export stays `shared-world-account-v18`.
- **No new endpoint or server change.** `server.js` is untouched; the pathway rides on `GET /callings`.
- **No new content definition, and no drift-guard edit.** See above.
- **No replacement of the "held" semantics.** Withholding reuses the existing `available` rule for
  receipts, `contributionEligibility` for contributions and the merit adoption predicate — no parallel
  hold concept was invented.
- **No role, land, authority, scope or reward.** The layer never writes to `accounts`,
  `land_stewardships`, `frontier_blocks` or `coin_rewards`, and a completed pathway leaves all four
  exactly as they were.
- **No claim of intelligence or qualification.** Not in code, not in the payload, not in the interface,
  not in these docs.
- **No browser scenario added.** `scripts/browser-suite.mjs` belongs to another task this wave.

## Migration and rollback

None required. The pathway is computed on every read from rows that already exist, so there is nothing
to migrate, nothing to backfill and no `user_version` change. A pre-existing database opens, validates
and reports pathways immediately, and the existing backup/restore round-trip is unchanged
(`validateDatabase(backup).schema_version === 21`). Rolling back is reverting this branch: the schema,
the rows, the export format and every other feature are untouched.

## Residual risks

The full list is in [PATHWAYS.md](../PATHWAYS.md#limitations-and-residual-risks). In short: progress is
still reconciled on read like every other cosmetic record; the reviewed state is a merit-style
eligible-acceptance count rather than a receipt (deliberately, and asserted to agree with the merit
summary); `claims`/`submissions`/`reviews`/`adoptions` are stamped with the wall clock while the calling
ledger uses the platform clock, which is pre-existing and which the reviewed tiers avoid depending on; a
four-tier ladder needs at least two days of saved activity because of the existing ten-a-day cosmetic
budget; the evidence page is bounded at 400 receipts; the cosmetic unlock is one existing decoration
because new definitions would have needed files this task does not own; and nothing here is a security
proof.
