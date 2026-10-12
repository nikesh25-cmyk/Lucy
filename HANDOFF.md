# NemoWorld development handoff — 12 October 2026

## Current source and evidence

The authoritative development source is this Git checkout (`work/Lucy-repo`). `outputs/Lucy` is the installed local copy, with its own private database and local AI runtime. Implement in the checkout; install reviewed source only after gates and backup. Do not edit an installed copy and assume GitHub has changed.

Current database schema: **15**. Current source gates: **351 tests, 351 pass, zero fail/skip**; syntax gate passes; isolated HTTP acceptance harness **10/10**. Content seal: **86 definitions**, 3 support files and 42 referenced notices/assets. The complete suite includes calling API, country-ambassador migration/API and real HTTP runtime tests. Gate logs remain outside this repository in `work/verification/`.

A disposable browser preview independently verified fictional account creation, human walking, true first-person drag/stored look, calling selection, crop-patch placement, planting, 5 cosmetic experience, and persistence after reload. Its database had exactly one calling receipt and zero coin rewards. Browser proof is `docs/images/callings.png`; it shows a fictional test player, not an installed account.

The 10,001-agent storage fixture retains a 200-avatar viewport and a 229,917-byte response in the measured run. This is not concurrent-client capacity. Renderer fixture improvements retain the prior measured terrain culling and unchanged-geometry reuse; no live FPS claim is made.

## Implemented in this release

- Imported the independently verified schema 13 handoff, including authored elevation, typed/sealed content, renderer culling/reuse and HTTP acceptance harness. Preserved three tests missing from that installed copy.
- Eight peaceful resident callings, public guild affiliations, private source receipts, cosmetic ranks and two daily objectives. Human chooses; agents cannot select a calling or author reward values. See `docs/CALLINGS.md`.
- Calling-aware bounded runtime actions and navigation: actual saved activities, at most 24 checked movement/climb steps per decision, existing scope/time/API budgets, revocation stop.
- True first-person camera, camera-relative cardinal walking, one pointer-drag owner, refreshed participant pick metadata and original calling emblems.
- Fixed elevated-resident connectivity checks that could incorrectly block unrelated building, true entrapment and unsafe support removal.
- Added SQL UPDATE placement palette/bounds protections and matching recovery validation.
- Schema 14 migration, owned progress privacy, export/deletion, receipt dedupe/daily limits, held evidence and real-review coin separation are tested.
- **Task 01 — country ambassadors (schema 15).** One `npc_ambassadors` row per catalog entry (`id = amb-<iso3>`, 248 rows, idempotent), each standing in its own generated `country:<iso3>` venue that registers no frontier sector, land parcel or block. Additive migration with the recorded `ambassador_legacy_map` from the 20 historic guides to their replacements; `npc_mayors` and `mayor_conversations` rows are never rewritten and their history stays readable. New `/ambassadors`, `/ambassador`, `/ambassadors/talk`, `/ambassadors/control` routes with a paginated/searchable directory and an enforced country-mismatch refusal; `/mayors*` kept as documented compatibility aliases. Ambassadors hold a fixed stand, so the 3-second patrol tick never pays 248 writes. Visible mayor wording replaced with ambassador terminology in the navigation, guide text, portraits, conversation panel and introductory copy. Design, manual browser walkthrough and residual risks: `docs/handoff/task-01-country-ambassadors.md`.

## User's latest direction — pending work

1. **Replace regional mayor framing with a country ambassador for every country.** Delivered as task 01 on branch `task-01-country-ambassadors` (see above and `docs/handoff/task-01-country-ambassadors.md`). The catalog's 248 countries AND areas keep that distinction in every label. The 20 historic guide identities and their conversation records are retained as compatibility aliases rather than replaced in place, and the browser walkthrough in that handoff has not been run by an automated harness.
2. **Conserve Codex credits using DeepSeek.** The ready-to-copy packet is `docs/deepseek/START_HERE.md` plus `docs/deepseek/TASKS.md`: 14 bounded tasks, first the ambassador migration. Run one code task at a time; return small diffs and actual gate evidence.
3. The larger narrative is a purposeful peaceful world for humans and AI, with callings guiding useful work. The Sword Art Online comparison is inspiration for immersion; this code does not implement full-dive VR or that proprietary game's world/assets.

## Boundaries that remain

No real producer/municipality pilot selected; no verified external adoption, trade, institutional endorsement or automatic outreach. Research catalog counts remain proposals. No paid land sales, cash-out, coin transfers or blockchain. No continuous airborne physics/jumping, mature multiplayer capacity evidence, or production security assurance. A system cannot honestly be called unhackable.

NemoCoins still require independently accepted real scoped agent contributions. Human players and NPCs do not earn agent contribution coins. Cosmetic calling XP is not currency, land or permission. Opening frontier areas stays inside the fixed 16 x 16 perimeter and does not enlarge the land inventory.

Preserve `data/`, backups, `.runtime/` and model weights. Never put credentials or account databases into Git, source archives, research packets or model prompts. Tests use separate temporary databases.

## Previous handoff

The schema 13 report is retained as historical evidence at `docs/handoff/2026-10-12-schema13.md`. Its 300-test figure and old live-server warning describe that earlier state; use the current evidence above.
