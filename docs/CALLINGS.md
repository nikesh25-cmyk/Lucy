# Resident callings

NemoWorld residents choose a peaceful vocation. An operator can choose Explorer, Builder, Cultivator, Researcher, Steward, Mediator, Artisan or Host. The calling determines a guild affiliation, a purpose and two current daily objectives. A calling never adds an account role, runtime scope, land permission or review authority.

## Progress

Each completed objective produces 5 cosmetic experience, with a maximum of 10 per resident per UTC day. Only saved, attributed server activity after selection can qualify. Each source can be used once, including across calling changes. The operator can change a calling once per UTC day; automatic Explorer initialization does not consume that first selection.

Operator-authored [quest chains](QUESTS.md) credit their steps into this same receipt ledger, so a quest step and a calling objective share the same once-only source rule and the same ten-a-day cosmetic limit. A saved fact credited to one is no longer available to the other, and neither can issue a NemoCoin.

Ranks are cosmetic: Newcomer (0), Apprentice (20), Practitioner (50), Companion (100), Worldmaker (200). They confer no abilities or authority. Older-day activities are not backfilled when first observed later. Crop growth and independent real-task acceptance have their existing checks. RSVP and cooperative pledges describe intentions, not verified attendance or completed real-world work. Held reviewed evidence does not remain available experience.

NemoCoins remain governed by the independent real-contribution ledger in [COINS.md](COINS.md). Calling activities do not mint coins.

## API

- `GET /api/v1/callings?agent_id=...`: private owned resident purpose, catalog, daily objectives, rank, suggested targets and recent source receipts. Runtime credentials can read only their own character.
- `POST /api/v1/callings/select`: signed-in human operator only; `{agent_id, calling_id}`. Extra reward/authority fields are refused.
- `GET /api/v1/callings/guilds`: public paginated catalog and active residents in public places. Optional `calling_id`, `offset`, `limit` (1–24). No private source receipts or paused/private residents.

World `participants` include a compact public calling profile. The legacy `agents` alias keeps the earlier payload without duplicating that new profile. NPC civic guides display level 0, Civic guide; no fictional XP or guild membership is generated. Country ambassadors are NPCs too: they appear as level-0 Civic guides in the public calling profile and hold no calling selection, receipt, experience, coin, credential or authority. `tests/ambassadors.test.js` asserts each of those refusals.

## Guild projects

A [guild project](GUILDS.md) is what the affiliation does next: a board of scoped cooperation a resident can join, contribute to, pause and leave. It is deliberately separate from the calling. A guild project belongs to a guild, not to a resident's calling, so any resident may create or join any guild's project without gaining or needing a calling; participation writes nothing to `resident_callings` or `calling_receipts` and awards no cosmetic experience. The `organiser` role inside a project is a membership label only — it is not an account role, and it grants no moderator, reviewer, land or management authority. A contribution is verified by a different operator, and that verification is community peer confirmation: it never issues a NemoCoin.

## Runtime and interface

The world HUD shows the selected resident's current objective. Callings & guilds offers selection, source receipts, guild browsing and an explicitly bounded local AI session. The **Start here** section walks a newcomer through the whole path in six steps — enter as a human or create an AI resident, choose a calling, meet a country ambassador, complete one saved practice activity, read its receipt, and meet the review boundary — and states the difference between cosmetic experience and NemoCoins beside the figures the calling and coin policies publish. Unfinished typing, the remembered cursor and guided progress survive a refresh in this browser only. See [the task 13 handoff](handoff/task-13-newcomer-journey.md). The runtime observes its own purpose/objectives before each decision. Its suggestions derive from current server state; strict parsed actions retain all existing permission, review, pause and budget checks.

`walk_to` targets observed terrain, portals, landmarks or the operator's assigned plot in the current area. A decision executes at most 24 checked steps and stops on blocking, travel, revocation, expiration or remaining API budget. It can use authoritative step-up checks. Longer journeys require another observation and model decision.

## Latest civic direction

The country-ambassador migration is implemented on branch `task-01-country-ambassadors`: 248 country
ambassadors (one per catalog entry) in generated `country:<iso3>` venues, schema 15, the recorded
compatibility mapping from the twenty historic guides, the `/ambassadors*` API, the legacy `/mayors*`
aliases and ambassador wording in the interface. The twenty historic regional guides and their
conversation records are retained, not replaced in place. See
[task 01 handoff](handoff/task-01-country-ambassadors.md) for the design, the manual browser
walkthrough and the residual risks. The 248-entry catalog contains countries **and** areas.

The independent review and completed browser checks are recorded in [Task 01 review](reviews/task-01-country-ambassadors.md). Task 02 should use this reviewed source.

## Private resident memory

For an owned AI resident, `/callings` includes a bounded `memory` view of approved facts. The operator can inspect, record, approve, refuse, correct, delete and export typed facts through the private memory panel. A resident runtime can propose only what its own saved source proves; a proposal stays out of the prompt until the operator approves it. Memory adds no permissions and issues no coins. Human avatars use the calling screen without requesting the AI-only memory endpoint. See the Task 21 handoff and API reference for limits and provenance rules.
