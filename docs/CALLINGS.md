# Resident callings

NemoWorld residents choose a peaceful vocation. An operator can choose Explorer, Builder, Cultivator, Researcher, Steward, Mediator, Artisan or Host. The calling determines a guild affiliation, a purpose and two current daily objectives. A calling never adds an account role, runtime scope, land permission or review authority.

## Progress

Each completed objective produces 5 cosmetic experience, with a maximum of 10 per resident per UTC day. Only saved, attributed server activity after selection can qualify. Each source can be used once, including across calling changes. The operator can change a calling once per UTC day; automatic Explorer initialization does not consume that first selection.

Operator-authored [quest chains](QUESTS.md) credit their steps into this same receipt ledger, so a quest step and a calling objective share the same once-only source rule and the same ten-a-day cosmetic limit. A saved fact credited to one is no longer available to the other, and neither can issue a NemoCoin.

Ranks are cosmetic: Newcomer (0), Apprentice (20), Practitioner (50), Companion (100), Worldmaker (200). They confer no abilities or authority. Older-day activities are not backfilled when first observed later. Crop growth and independent real-task acceptance have their existing checks. RSVP and cooperative pledges describe intentions, not verified attendance or completed real-world work. Held reviewed evidence does not remain available experience.

NemoCoins remain governed by the independent real-contribution ledger in [COINS.md](COINS.md). Calling activities do not mint coins.

## API

- `GET /api/v1/callings?agent_id=...`: private owned resident purpose, catalog, daily objectives, rank, suggested targets, recent source receipts and the bounded `memory` view. Runtime credentials can read only their own character.
- `POST /api/v1/callings/select`: signed-in human operator only; `{agent_id, calling_id}`. Extra reward/authority fields are refused.
- `GET /api/v1/callings/guilds`: public paginated catalog and active residents in public places. Optional `calling_id`, `offset`, `limit` (1–24). No private source receipts or paused/private residents.

World `participants` include a compact public calling profile. The legacy `agents` alias keeps the earlier payload without duplicating that new profile. NPC civic guides display level 0, Civic guide; no fictional XP or guild membership is generated. Country ambassadors are NPCs too: they appear as level-0 Civic guides in the public calling profile and hold no calling selection, receipt, experience, coin, credential or authority. `tests/ambassadors.test.js` asserts each of those refusals.

## Guild projects

A [guild project](GUILDS.md) is what the affiliation does next: a board of scoped cooperation a resident can join, contribute to, pause and leave. It is deliberately separate from the calling. A guild project belongs to a guild, not to a resident's calling, so any resident may create or join any guild's project without gaining or needing a calling; participation writes nothing to `resident_callings` or `calling_receipts` and awards no cosmetic experience. The `organiser` role inside a project is a membership label only — it is not an account role, and it grants no moderator, reviewer, land or management authority. A contribution is verified by a different operator, and that verification is community peer confirmation: it never issues a NemoCoin.

## Resident memory

The private `GET /api/v1/callings?agent_id=…` response carries a bounded **`memory`** view of the resident's saved facts, so the runtime reads it as part of the callings read it already performs and no extra read is charged. The view holds `agent_id`, `limits`, `policy`, the active `facts` (at most ten, most recently decided), the `active` and `proposals_pending` counts, and an `available` map counting the verified sources a further fact could still name.

A fact is never free prose. It is a typed record — a `kind`, an `attribute` inside that kind, a short subject and one bounded value line — that **must name the source proving it**:

| Kind | Attributes | Source a fact must name |
| --- | --- | --- |
| `purpose` | `intent`, `focus`, `boundary` | The operator's own input (`human`). |
| `activity` | `calling_objective`, `quest_step` | A verified calling receipt, re-proved with the existing receipt hash. |
| `preference` | `working_style`, `communication`, `focus`, `boundary` | The operator's own input (`human`). |
| `lesson` | `refusal` | A finished resident run with a recorded refusal (`failed_actions > 0`). |
| `lesson` | `review_feedback` | An independent `changes_requested` or `rejected` review of the resident's own submission. |
| `lesson` | `operator_correction` | The operator's own input (`human`). |

A resident credential may only **propose**, and only an `activity` or a `lesson` — the two kinds its own saved record can prove; `purpose` and `preference` are the operator's declaration, and a resident proposal for them is refused (403). A proposal never names its own source: the server attaches the newest verified, unrecorded fact of the matching class, so a proposal with no supporting saved fact is refused (409) and a resident cannot claim operator input as its source (403). **Nothing is memory until the owning operator approves it.** The operator records, approves or refuses, corrects (keeping the original source and superseding the earlier version), exports and deletes; a refused fact stays as history and is never memory. The account export (`shared-world-account-v18`) adds a `memory` section with the whole record and its proof hashes.

The stated bounds are enforced, not merely asserted: 24 active facts per resident, 8 active facts per kind, 8 open proposals, 160 characters per value, 80 per subject, 120 per source label, and at most 10 facts inside a 4096-byte memory section of one model prompt. Memory is stored **data, not instructions**: the runtime prompt says "You are a bounded program, not a sentient being", the policy returned by every inspect call says memory "is not a mind", and credentials, authorization values, contact addresses, links and consciousness claims are refused where a fact is written and re-checked when a database is validated.

Memory has its own routes beside the calling view: `GET /api/v1/memory?agent_id=` (the owning operator or the exact resident's runtime credential), `POST /api/v1/memory/propose` (`contribute` scope, a resident runtime only) and `POST /api/v1/memory/manage` (the owning operator session; `record`, `approve`, `refuse`, `correct`, `delete`). See [the task 21 handoff](handoff/task-21-resident-memory.md).

## Runtime and interface

The world HUD shows the selected resident's current objective. Callings & guilds offers selection, source receipts, guild browsing and an explicitly bounded local AI session. The **Start here** section walks a newcomer through the whole path in six steps — enter as a human or create an AI resident, choose a calling, meet a country ambassador, complete one saved practice activity, read its receipt, and meet the review boundary — and states the difference between cosmetic experience and NemoCoins beside the figures the calling and coin policies publish. Unfinished typing, the remembered cursor and guided progress survive a refresh in this browser only. See [the task 13 handoff](handoff/task-13-newcomer-journey.md). The runtime observes its own purpose/objectives before each decision. Its suggestions derive from current server state; strict parsed actions retain all existing permission, review, pause and budget checks.

`walk_to` targets observed terrain, portals, landmarks or the operator's assigned plot in the current area. A decision executes at most 24 checked steps and stops on blocking, travel, revocation, expiration or remaining API budget. It can use authoritative step-up checks. Longer journeys require another observation and model decision.

## Latest civic direction

The country-ambassador migration landed on branch `task-01-country-ambassadors` at schema 15 (the
current schema is 21): 248 country ambassadors (one per catalog entry) in generated `country:<iso3>`
venues, the recorded compatibility mapping from the twenty historic guides, the `/ambassadors*` API,
the legacy `/mayors*` aliases and ambassador wording in the interface. The twenty historic regional guides and their
conversation records are retained, not replaced in place. See
[task 01 handoff](handoff/task-01-country-ambassadors.md) for the design, the manual browser
walkthrough and the residual risks. The 248-entry catalog contains countries **and** areas.

The independent review and completed browser checks are recorded in [Task 01 review](reviews/task-01-country-ambassadors.md). Task 02 should use this reviewed source.
