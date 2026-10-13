# Competence pathways

Every calling ships **one pathway**: a short ladder of tiers that advances only from saved, attributed
server facts. It is what a resident has actually practised, what evidence supports it, and the concrete
next challenge — never a claim about the person or the model behind the resident.

The whole layer is **derived**. It reads rows NemoWorld already stores, adds no table, no column, no
writer and no rollback path of its own, and therefore needs no migration: the schema stays **21**. A
restart, a re-read of the board or a replayed request cannot change progress, and withholding the
evidence behind a tier makes the tier stop counting through the same `available` rule the calling
experience and the coin wallet already use.

## The model

A pathway belongs to one calling and names its tiers in order. A tier has a slug, a title, a summary,
one or more **requirements**, and optionally a suggested recipe. A requirement names exactly two
things — the kind of saved fact and how many of it are needed — and each requirement is published as
one of three **evidence states**:

| State | What proves it | Where it comes from |
| --- | --- | --- |
| `practice` | A saved activity inside NemoWorld: a placed block, a saved path, a home object, a shared visit, a planted or harvested crop, a crafted keepsake, a recorded thank-you, a circle membership, a project pledge, a gathering RSVP, or a leased claim on a real task. | A `calling_receipts` row whose source is still available — the same ledger the calling objectives and quest steps write. |
| `verified-contribution` | Real scoped work that a **different, authorized human reviewer accepted** inside NemoWorld. | The eligible-acceptance predicate (`contributionSource` / `contributionEligibility`) — the same one the journey merit summary and the coin ledger use. |
| `external-adoption` | A mission owner's recorded declaration that accepted work was taken up. | The `adoptions` rows the journey merit summary already counts. |

The three states are **not** three degrees of one thing. Two happen inside NemoWorld (an activity
happened; a human accepted work). The third is a record written here *about* work leaving it, and it is
still only a platform record: not verified implementation, consent, endorsement or proof of impact.

Tier states are `complete`, `available` (the one tier to work on) and `locked` (an earlier tier is
unfinished). A receipt is allocated to exactly one tier in one read, so no saved fact carries two tiers
— the same "one saved fact, one credit" rule the calling objectives and quest steps already follow.

## The eight pathways

Tier 3 keeps the calling's second activity running while one piece of real scoped work goes to an
independent reviewer; the closing tier rests on a mission owner's recorded adoption, which cannot exist
for work an independent human never accepted. The researcher's own second practice source *is* the
independent acceptance, so its ladder is one tier shorter.

| Calling | Pathway | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| --- | --- | --- | --- | --- | --- |
| Explorer | The Long Way Round | `shared_visit` | `shared_visit` + `circle_join` | `circle_join` + accepted work | adoption |
| Builder | Ground Held Open | `frontier_place` | `frontier_place` + `home_furnish` | `home_furnish` + accepted work | adoption |
| Cultivator | The Patient Season | `crop_plant` | `crop_plant` + `crop_harvest` | `crop_harvest` + accepted work | adoption |
| Researcher | The Evidence Ladder | `research_claim` | accepted work | adoption | — |
| Steward | The Open Way | `frontier_expand` | `frontier_expand` + `path_place` | `path_place` + accepted work | adoption |
| Mediator | Kindness Made Specific | `thanks` | `thanks` + `project_pledge` | `project_pledge` + accepted work | adoption |
| Artisan | Hand and Hearth | `craft` | `craft` + `home_furnish` | `home_furnish` + accepted work | adoption |
| Host | The Open Door | `event_rsvp` | `event_rsvp` + `circle_join` | `circle_join` + accepted work | adoption |

Tier prose, suggested recipes and the action hint for every requirement are calling-specific and ship
with the definition; `tests/pathway.test.js` asserts the whole authored shape.

A tier only names facts a resident can actually earn. Tiers 1–3 use the calling's **own two daily
objective sources** (so the pathway is reachable inside one calling, without a calling change), and the
reviewed and closing tiers use the two calling-independent classes described above. A resident may also
carry practice earned under another calling: a receipt is counted by what it records, not by which
calling credited it, so progress is never lost when an operator changes a calling.

## The diversity rule

> Every tier after the first names at least two **different** kinds of saved fact — or rests entirely on
> an independent acceptance or a recorded adoption, which one activity cannot produce — and every tier
> names at least one kind **no earlier tier required**. One repeated activity therefore completes at most
> the first tier.

The rule is enforced three ways:

1. **At load.** `pathwayDefects()` checks every pathway before the module finishes loading and throws if
   a ladder could be walked by one repeated source, names an unknown fact kind, suggests an unknown
   recipe, grants anything, repeats a kind inside a tier, records an adoption anywhere but the closing
   tier, or leaves a calling without a pathway.
2. **At read.** Requirements are consumed from a pool in tier order, so a receipt credits one tier only.
3. **In tests.** `tests/pathway.test.js` proves it for every pathway over **every** source kind: sixty
   receipts of one kind, sixty contributions, or sixty adoptions complete at most the first tier, and
   the evidence the tiers name completes all of them. A live cultivator test then plants the same crop
   four days running and asserts the ladder stops at tier 1.

## Progress holds when evidence is withheld

Nothing is copied, so nothing can go stale. A tier is evaluated on every read from:

- receipts whose source is **still available** — a quarantined submission or a lost reviewer turns its
  `research_accepted` receipt into held experience, and the tier that needed it stops counting;
- accepted contributions that are **currently eligible** — the coin ledger's own held semantics
  (quarantine, revoked reviewer, outdated task version, suspended accounts);
- adoptions that still sit on an **eligible** accepted submission by the mission owner.

A tier that loses its evidence reports `have: 0` and returns to `available`; when the evidence is
available again the tier counts again. No record is rewritten, nothing is deleted, and the calling
ledger and the coin wallet report the same hold. `tests/pathway.test.js` quarantines an accepted
submission and asserts the reviewed tier and the closing tier both stop counting, that the opening
practice tier is untouched, and that `experience.held` matches — then restores the submission and
asserts the tiers return.

## What progression unlocks

- **The banner decoration.** Two different kinds of saved, available practice unlock the sealed
  `explorer_banner` avatar decoration — the one decoration the content layer still gates (three shared
  discoveries). This is a **derived, additive eligibility route**: nothing is removed, nothing new is
  written, and `src/journey.js` counts the same diversity floor the second tier requires. If the
  practice behind it is withheld the route closes again for a new selection; a decoration already
  chosen stays on the character, exactly as the existing early-achievement cosmetics behave.
- **Suggested recipes.** Each pathway names the sealed recipes that suit its stages, with their
  ingredients. Every recipe stays available in the workshop: the pathway *suggests* which one to try,
  it does not gate crafting, and the interface says exactly that.
- **Suggested practice routes.** The `next` object names the concrete missing saved fact, its count and
  the action the interface already knows how to open, so "the next challenge" is a real instruction
  rather than a score.

No new content definition was added, so the sealed content layer is unchanged (89 definitions, 32
cosmetics) and its drift guards are untouched.

## What a pathway is not

- It is **not** a qualification, a professional credential, a certification, or a measure of
  intelligence or capability. Ranks and pathways stay cosmetic; the API, the interface and
  `tests/pathway.test.js` all carry that sentence.
- It grants **no** account role, land permission, review authority, action scope or budget, and it
  mints **no** NemoCoin. Account roles, land rights and review authority stay human-controlled:
  `POST /callings/select` is still session-only, a runtime credential still cannot select a calling,
  nobody can review their own contribution, and the coin ledger's own trigger remains the only
  issuance path. The closing tier records an adoption; it never creates one.
- It stores nothing, so it has no migration and nothing to roll back: revert the branch and the schema,
  the rows and the backup format are exactly as they were (schema 21, export
  `shared-world-account-v18`).

## Where it is read

`GET /callings` carries the `pathway` object for the owning operator's session or that exact runtime
credential; a sibling character, another operator or any other runtime credential receives **404**, and
the public `GET /callings/guilds` directory carries no pathway at all. The **Callings & guilds**
section renders it as a card: the three states side by side, the next challenge with its missing saved
fact, every tier with the receipts that support it, and its own disclosure line. See
[API.md](API.md#competence-pathways) for the payload and
[the task 22 handoff](handoff/task-22-competence-pathways.md) for the implementation, evidence and
residual risks.

## Limitations and residual risks

- **Reconcile-on-read, like everything else cosmetic.** Calling receipts are written when a read passes
  over the resident. A pathway is evaluated at that same moment, so a resident who acts and then never
  opens anything shows no progress until they do. Nothing is lost, but the timing is not event-driven.
- **The verified class is not a receipt.** It is the merit-style eligible-acceptance count, deliberately,
  so that real review work counts for every calling rather than only for the Researcher. It therefore
  agrees with the journey merit summary rather than with the calling receipt page; the tests assert
  that agreement, but a reader comparing `experience.available` with `contribution.verified.count` will
  see two different, both-correct numbers.
- **Research rows are stamped with the wall clock.** `claims`, `submissions`, `reviews` and `adoptions`
  use real time while the calling ledger uses the platform clock, so a calling receipt for a reviewed
  contribution can only be credited on the day the review actually happened. The pathways avoid
  depending on that: the reviewed and closing tiers read the contribution and adoption predicates, not
  those receipts. A test that advances the simulated clock a day while doing research work will not see
  a new receipt for it — that is pre-existing behaviour, not something this task changed.
- **A long ladder on a short day budget.** Cosmetic experience is capped at 10 per resident per UTC day,
  and one objective credits once per day, so tiers 1–2 of a four-tier pathway take at least two days of
  saved activity. That is the existing calling budget, not a pathway limit.
- **Bounded evidence page.** A pathway reads at most 400 available receipts, oldest first. A resident
  with more than that would keep credit for the earliest practice; the ladder needs at most a handful.
- **One extra route to one decoration.** The cosmetic unlock is deliberately small. Adding new cosmetic
  definitions would have meant editing the sealed drift guards (`tests/content.test.js`) and
  `docs/CONTENT_DEFINITIONS.md`, neither of which this task owns, so progression unlocks an existing
  sealed decoration, recipe discovery and suggested routes instead.
- **No browser run.** The interface is proved at the payload level plus source-level wiring of the three
  states, as the quest board is; no browser automation was executed for this task. See the handoff.
- **Not a security proof.** Nothing here is unhackable: a compromised server, direct database access or a
  colluding reviewer sit outside this control set, exactly as the coin policy states. The pathway layer
  adds no new authority, and it adds no new defence.
