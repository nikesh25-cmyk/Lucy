# Combined review — NemoWorld Tasks 02–14

Reviewed locally on 13 October 2026, branch `review/nemoworld-queue`, schema 18. The code stack follows reviewed Task 01 `dc61ad2` through Task 14's corrected tip `917ec71`. The four independent research branches were merged separately: asset shortlist, country packs, UN programme register and proposal review. Original delivery branches and patches remain available.

## Independent verification

- Syntax: `npm run check` passed.
- Suite: `npm test` — **448 tests, 448 pass, zero fail/skip**, 42.0 seconds in the recorded run. Includes the research-register test and three new regression cases beyond the delivered 444-test code stack.
- HTTP acceptance: `npm run e2e` — **15/15 steps PASS**, isolated workspace removed.
- Seal: **86 definitions**, 3 support files, 42 notices/assets.
- Focused session/resident/coin regression suites passed. Logs are outside Git in `work/verification/queue-*.log`.

## Corrections made during review

1. Logout now clears cached private quests, guilds, blueprint reports and land/world state. Character selection also clears the old blueprint preview.
2. Ordinary unfinished forms are opt-in and keyed by operator ID. Authentication forms do not persist credentials. Passwords, secrets, tokens, setup codes, invitations and consent fields are excluded. Onboarding and focus records are also scoped by operator or visitor.
3. Draft fields restore after their controls exist. Refresh returns to the right ordinary form and opens ancestor disclosures before focusing the saved field.
4. Interrupted resident jobs resume only with their remaining model, API and elapsed-time budgets. New credentials retain the original deadline. An expired run must start a separately bounded new run; caller-provided resume ancestry is ignored on fresh starts.
5. The Task 08 structural coin-receipt validation remains in the integrated source. It checks independent review provenance in addition to hash-chain consistency; this is not a claim that a database administrator cannot tamper with the entire installation.

## Browser verification actually executed

The disposable preview at `localhost:54840` used two fictional operators and a separate temporary database. Normal UI interactions proved:

- Login/logout and operator switching.
- Garden shelter preview (14 blocks) with zero writes, apply (14 saved blocks), remove (zero remaining blocks).
- First-person movement from tile 32,32 to 31,32, reflected by the authoritative aim line.
- Character draft survives reload, is absent for a second operator, and returns only for its owner.
- Quest author draft survives reload; its disclosure opens and the remembered title field has focus.
- A second operator sees the public guild project and cannot see the owner's private project; the owner can see it. The owner joined the public project as its second participant.
- The Quiet Harvest enrollment persists and shows the next real planting action, not a claimed completion.
- No captured browser console errors. Final disposable database proof: schema 18, zero blocks/coins, one quest enrollment, two guild projects. The preview database was removed.

Screenshots: `docs/images/queue-world.png` and `docs/images/queue-browser.png`. These depict fictional preview data. Mature crop harvest, all guild transitions, responsive layouts and every release flow were not browser-tested here. Task 15 adds a repeatable full browser suite.

## Research and performance boundaries

The asset shortlist is a rights/reuse research artifact, not an asset download or integration. Country packs and the 100-record UN register are dated research references; they do not establish official affiliation. Task 12 reviews 50 proposals and identifies 24 interchangeable templates; its proposed repairs were not automatically applied or activated. Task 24 addresses the generator.

Task 14's pathological grouped viewport query and window-count swap are absent: `src/spaces.js` matches Task 13. Retained changes bound visit/claim reads and group calling summaries. Delivered performance figures are machine/fixture results, not this review's independently measured simultaneous-user or live model capacity.

## Release handling

Preserve installed `data/`, backups, `.runtime/`, accounts and model weights. Stop the server and back up before each schema upgrade (15 to 16 to 17 to 18). Source archives exclude private data and runtime files. Local source integration does not update GitHub or the main-branch download.

## Next work

[Batch 02: Tasks 15–28](../deepseek/TASKS_BATCH_02.md). Begin Task 15 on this reviewed source; one bounded code task per branch.
