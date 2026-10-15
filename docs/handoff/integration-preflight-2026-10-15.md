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
