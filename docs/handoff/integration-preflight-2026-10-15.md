# NemoWorld integration preflight — 15 October 2026

This note records evidence for the isolated `review/antigravity-2026-10-15` line. It does not describe the installed world, GitHub `main`, or an approved public launch.

## Completed integration

The finished visual slice `feat/visual-upgrade-slice-1` at `7eb15fb` is merged as `9df194e`, on top of the reviewed world-life/Antigravity line. The merge resolved automatically. It adds scene interiors and lights, readable night lighting, HUD positioning, asset/content definitions, capture evidence and focused tests. The vault and community work remain in the tree. `server.js` adds only the two scene modules to its static-file table. The schema stays at 25.

DeepSeek's handed-off `framework-wave1-contract` at `ef0bfcc` is now merged as `6ff6c49`. It adds a declared write-route contract, focused HTTP/DB tests and the two draft-write corrections described in its handoff. The merge had no content conflict; one trailing blank line in the new contract module was removed to satisfy `git diff --check`. No schema or route was added. Later framework waves remain with DeepSeek.

Gates on this combined commit: `npm run check` checked 103 files, zero failures; sealed content verified 98 definitions and 42 notices/assets; `npm test` passed 1,092 of 1,092 tests on disposable data; `npm run e2e` passed 20 of 20 steps. The first sandboxed unit run was stopped after `listen EPERM` denied local test-server ports; the valid run used localhost permission and passed.

The full real-Chrome run finished **44 passed, 1 failed**. The sole failure was `cooperative-restoration-two-operators`: after two saved sowings, `page.reload({waitUntil:'domcontentloaded'})` timed out at 25 seconds on the 31st scenario. The later `restoration-two-clients` scenario passed in the same run. A fresh disposable, focused rerun of `cooperative-restoration-two-operators` passed **1/1** in 30 seconds, including the garden completion and restart. The evidence points to a load-sensitive navigation timeout, but does not identify its cause or make the full gate green. The combined commit is therefore **not yet a fully green release candidate**. Full-run log: `/private/tmp/nemoworld-visual-merge-browser.log`; focused-run log: `/private/tmp/nemoworld-visual-merge-restoration-focus.log` (temporary, local files).

On the newer `6ff6c49` tree, `npm run check` checked 104 files with zero failures; the seal remained 98 definitions and 42 notices/assets; Wave 1's focused HTTP/contract tests passed **11/11**; `npm test` passed **1,103/1,103**; `npm run e2e` passed **20/20**; and the Chrome `private-draft-isolation,refresh-and-focus-restoration` focused run passed **2/2**. A new full Chrome run has not been made on `6ff6c49`; the 44/45 result above belongs to `9df194e`.

## Read-only preflight of the next lines

`git merge-tree --write-tree` against `9df194e` returned a textual merge for `framework-wave1-contract`, `feat/in-game-command-surface`, `feat/visual-upgrade-slice-2`, and the current `feat/global-map-phase1`. Wave 1 has since been merged. For the other branches this remains a text check only, not a proof of semantic compatibility or a decision to integrate unfinished work. The active source tips may change.

`feat/karma-shop-integration` has one text conflict in `src/voxel-world.js`; both the current visual/camera path and the Karma interaction path must survive. The branch handoff also reports 15 failing full-browser scenarios, with baseline comparison still pending. Do not merge it merely because a conflict can be resolved.

The command-surface handoff explicitly labels that branch unfinished: it had not completed a final full test run or read the new browser-scenario result. The visual slice 2 handoff is also WIP. Later DeepSeek framework waves are ongoing; integration needs frozen source tips so the declared write contract can be updated to cover the final route map.

The earlier master report called a third-party `GET` of a private message by id an unclear sub-path. The current `server.js` `gets` set has **no** `/messages` read route or message-by-id dynamic route: `/messages` is `POST` only. There is therefore no such HTTP fetch path to test on this tree. Private-message checks should continue against the actual `GET /world`, account export and event-stream surfaces; if a message-by-id read is later added, it needs a third-operator refusal test before release.

## Visual review of the delivered captures

The night orbit captures show improved building and character readability. They also show the remaining game-feel cost clearly: the Commons' dense, uniform tree canopies can hide the ground and characters in orbit view, and the 390 px view gives a large fraction of its height to the guide and two control clusters. The visual-slice-1 handoff measures this honestly and notes that a collapsible touch pad is the next gain. These are input for the active scene/control owners, not a reason to change their files in parallel.

## Release conditions still open

One branch must eventually combine the completed framework, game UI, visual, global-map, Karma, and gameplay-acceptance work. On that exact tree, validate migrations and backup/restore against a disposable copy; run `check`, full unit tests, e2e, content seal and full Chrome suite; inspect desktop and 390 px play; run a fresh-account shared human/AI action and restart; and verify the Mac launcher against a disposable installation. No percentage of the long-range MMO vision is implied by these gates.

## Antigravity AG-01–03 audit and integration

AG-01 conversation fixtures were cherry-picked as `2159718` and corrected in `92312ac`. The 8/8 fixture matrix drives real `/ambassadors/talk` and `/messages` HTTP/storage paths, but uses the scripted `mode: rules` ambassador response. It is **not** a model inference or general prompt-injection evaluation. The focused integration test passed 1/1 on this review line.

AG-02 was cherry-picked as `286558d`. The recorder was repaired before accepting its claims: it samples 120 valid browser rAF intervals after warmup, requires each movement to be stored and reflected in reticle text, removes the fixed observer sleep, and fails rather than recording success on a timeout. A fresh four-setting disposable Chrome run produced 20/20 saved/reticle movement samples and four observed second-client updates; details and limits are in `docs/BROWSER_RENDER_PERF_REPORT.md`. The prior “30 FPS renderer lock” and reduced-motion speed claim were withdrawn. These are exploratory client timings, not canvas FPS, touch latency, SSE-only latency, or launch capacity.

AG-03 was cherry-picked as `2428bc5` and its recovery behavior was corrected. A local coordinate read cannot prove whether an unkeyed `/move` was committed, delayed, or reversed. The worker now retains an interrupted intent and blocks all further moves for operator resolution, regardless of observed origin, target, or another coordinate. State writes use a synced temporary file and rename; corrupt state fails closed. Its test exercises committed-then-crashed, origin, diverged, and corrupt-journal cases. This is an example client, not an exactly-once worker or an automatic recovery protocol. Server-side idempotency or receipts for `/move` remain an open backend task.

The refreshed 390 px performance capture was visually inspected. The scene is visible and the compact controls are present, but the guide/encounter overlays crowd the top half, the right encounter card is clipped, and controls obscure much of the lower scene. This is a concrete phone game-feel issue for the active frontend owner; AG-02 did not edit the renderer or shell.

Final AG-01–03 integration checks on `459ec72`: `npm run check` checked 106 files, zero failed; `git diff --check` clean; sealed content verified 98 definitions and 42 notices/assets; focused Node integration tests passed 2/2 after the worker retry guard. The four-quadrant recorder completed on a disposable server/DB and real Chrome. A full `npm test` run was started but stopped after test 368 because this machine's concurrent workload made the suite much slower than the prior verified baseline; it was not reported as a pass. The earlier 1,103/1,103 full-suite result belongs to `4feac4e`, before these three additions. No new full e2e or full Chrome suite was run for this docs/example-only batch.
