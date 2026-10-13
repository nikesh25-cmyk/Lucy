# Shared world and introduction film integration

13 October 2026. Branch: `review/nemoworld-shared-world`. Based on the previously installed review `8c984ac`.

## Completed work integrated

- Task 19: explicitly scoped and revocable plot collaboration (`0322af8`), schema 19.
- Browser movement/subscription corrections (`4a98518`). The suite resumes only documented movement-throttle refusals within explicit budgets.
- Task 18: named-recipient resource offers, atomic escrow and idempotent settlement (`6fe4485`), schema 20; 89 sealed definitions.
- Documentation consistency (`0e4ba39`).
- Task 21: typed, private AI resident memory with provenance and operator approval (`500f146`), schema 21. Merged after the user confirmed completion and its worktree was clean.

Tasks **22, 23, 25 and 26** remain with their existing workers. No worktree belonging to those tasks was edited. No new agent or duplicate feature task was started.

## Integration defects corrected

The grant preview previously discarded filled confirmation fields. It now replaces only its report. Guests now see access they hold even when they already own another plot. Resource offer candidates omit NPCs and the operator’s own residents, and acceptance includes its required idempotency key. Human calling screens no longer request the AI-only memory endpoint. Research generation uses scope-based copy rather than an obsolete promised count. Destructive offer-table rollback instructions were replaced with matching-code backup restoration guidance.

The owner-supplied film is the hero video and is also available to signed-in users through “Watch introduction”. Native controls, a same-film poster, no autoplay/preload, byte-range streaming and immediate close-button pause are included. The phone layout shows the film first. The supplied original was not changed. See `docs/HERO_FILM.md`.

## Acceptance evidence

- Real Chrome: **24/24** scenarios, no failures or skips on the final run. Film decodes as 92.76 seconds, 1280×720; 390px screen has no horizontal overflow.
- `shared-build-and-restart`: two humans in separate browser sessions and a scoped AI runtime place three individually attributed blocks in one plot. Preview writes no grant; confirmation preserves its intended guest and purpose. One herb is escrowed and accepted once. The operator records an AI purpose; the other operator is refused access. A full process restart preserves the exact blocks, grant/event history, offer/event history, inventories and approved memory. Both clients reconnect. Revoking a grant refuses the guest’s cached credential and preserves the three completed blocks. Starter inventory and initial positions are explicitly prepared fixtures, not claimed harvests or walking proof.
- HTTP acceptance: **15/15** steps. Syntax and sealed-content gates pass: **89 definitions**.
- Full merged tests: **565/565**; runtime, memory-prompt and accessibility checks also passed after the final copy/close corrections. Final candidate full-suite log is `work/verification/shared21-candidate-tests.log`.
- A separate, actual Qwen3-4B local-model smoke check chose and saved one wood block beside two human builds. Reopening the database preserved all three, schema validation passed and no coins were issued. Its next decision used an invalid placeholder and stopped before dispatch; the run receipt honestly says failed after one saved action. This exposed an ambiguous prompt example, now replaced with a literal `wood` example. That qualitative smoke check does not establish general model reliability or autonomous project completion.

## Installation and preservation

The migration rehearsal checked all **56** existing tables and **23,226** prior records with no changes, using prior columns when additive columns were introduced. Verified backups were made before upgrades 19, 20 and 21. The installed migration is checked separately by `shared21-install-preservation.json`; the installed source and live health/media checks are recorded in `outputs/shared-installed-verification.json`. Account data, historical proposals, land and world records, and the verified local model/runtime are preserved. No production test account was created.

Source packages contain tracked code/content only, never the installed database, account credentials, runtime or model weights. Paid hosting, public deployment, GitHub publishing and plot sales were not performed. The deployment Blueprint no longer selects an instance resize; provider setup still requires an explicit plan decision.
