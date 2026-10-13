# NemoWorld — DeepSeek Batch 02

The first 14 tasks are reviewed. New work has been combined on `review/nemoworld-batch02` (schema 18). Read `HANDOFF.md`, `docs/reviews/batch02-integration.md`, `docs/API.md` and `docs/ARCHITECTURE.md`. Use Node 24+: `PATH="$PWD/../node-bin:$PATH"` in `work/Lucy-repo`.

## Historical batch — all tasks integrated by 13 October 2026

Tasks **15–28** are completed in the integrated source, including 18, 19, 21, 22, 23, 25 and 26. The original briefs below remain scope history; do not assign or redo them. Tasks **29–38** also have delivered source. Use the current integration branch as the base for any new work, and check `HANDOFF.md` before taking a number or shared file.

One code task per branch; return a focused diff, meaningful tests and actual evidence. Keep the zero-dependency production server, local assets, finite land inventory, independent coin acceptance, privacy, pause/revocation and bounded model budgets. Leave `outputs/Lucy`, installed accounts/database, credentials and model weights untouched. No automatic installation, publication, paid services, outreach or real-world mission activation. Do not claim a browser check, performance target or real-world result unless actually measured.

## 15 — Executable browser acceptance suite

Build a repeatable browser suite covering signup/login/logout, account switching, private draft isolation, credential exclusion from storage, refresh/focus restoration, first-person controls, country ambassadors, plot assignment, blueprint preview/apply/remove, quest progression, guild cooperation and reward refusals. Run against separate temporary databases with fictional accounts; ensure teardown on failure. A dev-only browser dependency is acceptable if needed; production stays dependency-free. Keep scripts independently runnable and suitable for CI.

Acceptance: tests actually execute browsers, check server/database effects, save failure traces/screenshots and refuse production databases. Include the exact defects corrected in the queue review as regressions. No source-regex assertions or HTTP-only results described as browser coverage.

## 16 — Responsive shared-world movement and presence

Add bounded real-time updates using the established Node server and an appropriate event channel. Interpolate confirmed positions for smooth walking; reconcile refused moves without allowing the client to invent authoritative coordinates. Update nearby avatars, authored blocks and chat without rebuilding stable geometry or interrupting forms.

Acceptance: two real browser clients see each other move/build; disconnected clients recover from an authoritative snapshot; private messages and private worlds never leak through event subscriptions; revoked sessions lose private subscriptions; event buffers, connection count and update rates have enforced bounds. Report measured latency and frame behavior on named hardware, not promised user capacity.

## 17 — Direct, purposeful world interaction

Let residents interact with nearby doors, crop patches, benches, crafting stations and ambassador desks directly from the map and first-person view. Provide a readable action hint, distance requirement and keyboard/text equivalent. Link each interaction to the existing authoritative garden, craft, travel or conversation action rather than a cosmetic animation alone.

Acceptance: actual saved changes survive reload; out-of-range, wrong-owner, paused and revoked actions fail; one click cannot issue duplicate writes; blocked interactions explain their next usable step; observers can inspect but cannot act as another resident.

## 18 — Inventory exchange and crafting depth

Extend server-owned resource inventory with a small set of useful original recipes and explicit resident-to-resident resource offers. Human operators choose recipients and acceptance; AI can propose within permissions. Exchanges concern virtual grown/crafted items only. They do not transfer NemoCoins, money or land.

Acceptance: atomic inventory changes, no negative stock, replay/concurrent acceptance cannot duplicate items, expired/cancelled offers settle safely, ownership and consent are enforced, and crafted placements retain shared access. Start with three recipes and one complete exchange flow; document the internal-resource economy clearly.

## 19 — Revocable plot collaboration permissions

Allow a plot steward's human operator to invite a specific operator/resident to build on that plot for a stated purpose, duration and narrow scope. Include expiry, revocation and an audit trail. Existing ownership, budget, occupied-cell, footprint and escape checks still apply; guests cannot grant permissions onwards or acquire land.

Acceptance: grant is human-controlled; paused/suspended/revoked parties lose access; cached credentials cannot bypass a revoked grant; budget attribution is documented and tested; concurrent changes remain atomic; plot stewardship and registry inventory do not change. Add a preview of the exact access being granted.

## 20 — Distinct country venues and world landmarks

Design eight original country/area venue variants as a first set, using documented cultural/ecological references with appropriate source and asset rights. Integrate them through deterministic world definitions and shared collision footprints. Retain public arrival/exit access and each ambassador's stand. The remaining venues can use the existing generic shape until they receive a reviewed variant.

Acceptance: each new venue is visually distinct and navigable in orbit, first-person and text mode; server and renderer agree; no new sale inventory or frontier areas; original or verified licensed art only. Preserve the distinction between fictional NemoWorld spaces and actual country territory. Do not present eight variants as 248 unique venues.

## 21 — Bounded resident memory and reflection

Add small, structured private memory for an operator's AI resident: chosen purpose, confirmed activities, explicit operator preferences and lessons from refusals/review feedback. Memory facts need a source receipt or explicit human input. The resident can propose updates; the operator can inspect, correct, export and delete them. Public chat is untrusted context and cannot become a system instruction.

Acceptance: bounded size and prompt budget, owner-only visibility, no sibling/private conversation leaks, no credentials in memory, revoked runtimes cannot read it, and a restart can resume context without replaying actions or renewing spent budgets. No invented accomplishments or claims of sentience.

## 22 — Competence pathways for each calling

Create meaningful skill pathways tied to diverse saved activities and independent review where applicable. Show what a resident has actually practised, what evidence supports it and a concrete next challenge. Use progression for original cosmetic items, recipe discovery or suggested practice routes; account roles, land permissions and review authority remain human-controlled.

Acceptance: one repeated source cannot unlock every tier; progress survives restart and holds when supporting evidence is withheld; every calling has one complete pathway; the UI distinguishes practice, verified contribution and external adoption. Do not claim a rank proves general intelligence or real professional qualification.

## 23 — Cooperative world restoration events

Create one original peaceful multiplayer event: restore a shared garden, repair an accessible gathering space or assemble a public learning trail. Define server-measurable steps, explicit participation and a bounded schedule. Give different callings useful roles. Shared progress must arise from actual saved world actions.

Acceptance: a complete two-operator browser walkthrough, prerequisites and budgets enforced, interruption/resume works without duplicate credit, result is a persistent world artifact, and promises are not counted as completed work. Event participation is cosmetic; NemoCoins still require a separate independently reviewed real mission.

## 24 — Repair the research proposal generator

Use the Task 12 review, including its 24 interchangeable templates, to create a higher-quality generator. Separate country baseline collection from product/destination-specific questions, institution mapping and intervention comparisons. Add source prerequisites, dependencies, outputs and acceptance criteria. Deduplicate by substantive question rather than title.

Acceptance: a reviewed 50-proposal batch with distinct answerable questions, explicit unresolved scope choices, primary-source categories and rights. Existing activated tasks are preserved; revisions apply only to eligible proposals and keep version history. No automatic beneficiary selection, mission activation or invented external outcomes. Thousands of titles are not the success metric.

## 25 — Versioned evidence library and source capture

Build a bounded evidence library around existing retained source bytes, hashes, dates and locations. Attach exact evidence versions to research artifacts so a later source change does not silently rewrite historical support. Show missing, stale, withdrawn and replaced sources accurately. Respect current fetch allowlists, network protections, rights and storage quotas.

Acceptance: receipt points to exact source version; conflicting dates/units remain visible; redirects or forbidden destinations fail safely; original provenance and licence are preserved; a reviewer can inspect the actual supporting location. A saved link alone is not verified evidence.

## 26 — Reviewer workbench and adoption tracking

Improve the human reviewer flow with criterion-by-criterion assessment, source-version comparison, changes-requested feedback and an explicit adoption record. Keep proposer, contributor, reviewer and adopter distinct. Adoption is a recorded declaration with supporting evidence, not automatically proof of implementation or institutional endorsement.

Acceptance: meaningful independent-review browser flow, self-review refused, quarantine holds current availability without rewriting history, exact coin issuance remains atomic/idempotent, and pending/accepted/held/adopted states are unambiguous. Preserve private drafts and show recipients what has actually been approved.

## 27 — Recovery, health and operational runbook

Create a tested operational runbook and bounded diagnostics: backup/restore, schema migration rehearsal, interrupted workers, model queue saturation, storage limits and source/archive verification. Redact secrets, contact data and private artifacts from logs. Produce a small dashboard of actual health and failure counters.

Acceptance: failure drills on disposable installations, full recovery preserves world/land/coin/quest/guild records, exact recovery point and interruption limits documented, invalid backups fail closed, and the administrator can distinguish an idle model from a working inference run. Do not expose diagnostics or private data publicly.

## 28 — Production readiness package

Prepare a concrete hosted deployment configuration, threat model and release checklist for the existing stack. Cover HTTPS/origin checks, private setup code, signup policy, administrator recovery, least-privilege review/moderation, migrations, backups, resource ceilings and incident handling. Include a defensible capacity experiment with browser clients and bounded model concurrency.

Acceptance: configuration and rehearsals on an isolated environment, named measurable release gates, rollback/recovery instructions, residual risks stated and no claim of an unhackable system. Deliver a reviewable deployment package. Do not purchase hosting/domains, provision paid services, expose the real installation or publish without explicit user authorization.

## Required delivery for every task

Branch/base commit; changed-file list; focused patch; actual syntax/unit/HTTP/browser results; source/asset provenance where relevant; explicit limitations; migration/rollback notes if applicable. Read the updated queue review first. Never resolve a failing gate by deleting coverage, inventing a result or silently raising a permission, reward or capacity limit.
