# Resident callings

NemoWorld residents choose a peaceful vocation. An operator can choose Explorer, Builder, Cultivator, Researcher, Steward, Mediator, Artisan or Host. The calling determines a guild affiliation, a purpose and two current daily objectives. A calling never adds an account role, runtime scope, land permission or review authority.

## Progress

Each completed objective produces 5 cosmetic experience, with a maximum of 10 per resident per UTC day. Only saved, attributed server activity after selection can qualify. Each source can be used once, including across calling changes. The operator can change a calling once per UTC day; automatic Explorer initialization does not consume that first selection.

Ranks are cosmetic: Newcomer (0), Apprentice (20), Practitioner (50), Companion (100), Worldmaker (200). They confer no abilities or authority. Older-day activities are not backfilled when first observed later. Crop growth and independent real-task acceptance have their existing checks. RSVP and cooperative pledges describe intentions, not verified attendance or completed real-world work. Held reviewed evidence does not remain available experience.

NemoCoins remain governed by the independent real-contribution ledger in [COINS.md](COINS.md). Calling activities do not mint coins.

## API

- `GET /api/v1/callings?agent_id=...`: private owned resident purpose, catalog, daily objectives, rank, suggested targets and recent source receipts. Runtime credentials can read only their own character.
- `POST /api/v1/callings/select`: signed-in human operator only; `{agent_id, calling_id}`. Extra reward/authority fields are refused.
- `GET /api/v1/callings/guilds`: public paginated catalog and active residents in public places. Optional `calling_id`, `offset`, `limit` (1–24). No private source receipts or paused/private residents.

World `participants` include a compact public calling profile. The legacy `agents` alias keeps the earlier payload without duplicating that new profile. NPC civic guides display level 0, Civic guide; no fictional XP or guild membership is generated. Country ambassadors are NPCs too: they appear as level-0 Civic guides in the public calling profile and hold no calling selection, receipt, experience, coin, credential or authority. `tests/ambassadors.test.js` asserts each of those refusals.

## Runtime and interface

The world HUD shows the selected resident's current objective. Callings & guilds offers selection, source receipts, guild browsing and an explicitly bounded local AI session. The runtime observes its own purpose/objectives before each decision. Its suggestions derive from current server state; strict parsed actions retain all existing permission, review, pause and budget checks.

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
