# NemoWorld master-wave integration — 14 October 2026

## Source and scope

This integration starts from `integration/nemoworld-completed` at `5119e3c` (the reviewed schema-23 world/trade installation) and merges DeepSeek's clean `integration/deepseek-master-2026-10-14` at `c0d09fb`. The DeepSeek branch was built from an earlier schema-22 point; its own test totals and capacity measurements are evidence for that branch, not automatic evidence for the combined tree. No task branch was recreated.

The merge preserves both sides of three overlapping edits: `app.js` clears movement feedback **and** session-scoped quality state at sign-out; `server.js` serves both the trade-board and quality reads; `package.json` uses DeepSeek's tree-wide syntax checker. The quality browser scenario's hardcoded schema-22 assertion was replaced with a before/after schema comparison, which tests its actual promise: checking off an advisory signal cannot change the database. The current release checklist names schema 23 and distinguishes DeepSeek's historical schema-22 measurements.

DeepSeek's added work includes advisory mission-quality signals beside human review, three researched mission exemplars held as unactivated drafts, the longer two-human/one-AI two-gate shared-build journey, deterministic character-selection race coverage, syntax coverage of the whole source tree, and bounded capacity probes. The same authoritative server continues to own world state, coin receipts, mission records and the optional Luanti bridge.

## Independent verification on the combined tree

All test accounts and worlds were disposable; the installed database was not used as a fixture.

| Gate | Result |
| --- | --- |
| `npm run check` | 92 files parsed, 0 failed |
| `npm test` | 989 passed, 0 failed, 0 skipped |
| `npm run e2e` | 20/20 steps passed |
| `npm run browser` | 45/45 real-Chrome scenarios passed; shipped database untouched |
| `node scripts/seal-content.mjs --check` | 89 definitions, 3 support files, 42 notices/assets verified |
| `node scripts/ops-rehearsal.mjs` | 7/7 drills passed with localhost permission |
| Real Luanti 5.17 smokes | World/build/travel/restart, mission retry/revocation, private/public text conversation all passed against temporary worlds |

The first full browser run was 44/45 solely because the imported quality scenario expected `user_version=22` on a schema-23 world. The corrected scenario passed alone (1/1), then the whole gate passed 45/45. The first operations rehearsal was refused by the execution sandbox (`listen EPERM` on `127.0.0.1`); its permission-enabled rerun passed. These failures are retained as diagnostic history, not reclassified as passes.

## Capacity evidence and limits

One schema-23 combined-tree probe on Apple M5 / 16 GiB with Node 22 and a still-uncommitted merge tree completed within the experiment's bounds. The clean-commit Node 24 release probe remains to be recorded separately. On this fixture, 1 / 8 / 32 HTTP clients delivered 49.57 / 54.19 / 54.09 reads per second; p95 rose from 63.65 to 261.33 to 3500.66 ms. The isolated build-save workload reached 2068.68 saves/s with one client and 3652.02 with eight; eight event subscribers stayed connected. A stub model queue admitted 9 of 12 calls, refused three at its bound and never ran more than one inference at once. These workloads were separate; their throughputs cannot be added or read as supported-user counts.

This is a finite, tile-based local multiplayer prototype with an optional native Luanti projection. The native smokes invoke engine callbacks with synthetic players; they do not prove GUI input or production capacity. The three exemplar missions have not been approved by a human owner, reviewer or consenting beneficiary and are not live institutional projects. Quality signals are advisory and session-scoped dismissals are not durable. The shipped backup remains plaintext. Moderation/appeal and platform-pause recovery are not yet measured, and the third-operator private-message-by-id HTTP path still needs a direct test. No commercial land sale, MMO scale, external implementation, public launch, purchase or outreach is established by these gates.

## Installed copy

The installed `outputs/Lucy` has its own live account and world database. Update it only after a fresh verified backup, a controlled local-server restart and installed-file fingerprint verification; record the final source commit and post-upgrade health here. The code merge itself makes no schema change beyond the already installed version 23.
