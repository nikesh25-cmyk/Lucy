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

The clean-commit schema-23 probe at `1de1de3` ran on Apple M5 / 16 GiB with Node 24.19.0. On this fixture, 1 / 8 / 32 HTTP clients delivered 50.65 / 53.35 / 52.18 reads per second; p95 rose from 61.9 to 272.34 to 3638.36 ms. The isolated build-save workload reached 2377 saves/s with one client and 3646.41 with eight; eight event subscribers stayed connected. Both concurrent browser-suite levels passed. A stub model queue admitted 9 of 12 calls, refused three at its bound and never ran more than one inference at once. These workloads were separate; their throughputs cannot be added or read as supported-user counts.

This is a finite, tile-based local multiplayer prototype with an optional native Luanti projection. The native smokes invoke engine callbacks with synthetic players; they do not prove GUI input or production capacity. The three exemplar missions have not been approved by a human owner, reviewer or consenting beneficiary and are not live institutional projects. Quality signals are advisory and session-scoped dismissals are not durable. The shipped backup remains plaintext. Moderation/appeal and platform-pause recovery are not yet measured, and the third-operator private-message-by-id HTTP path still needs a direct test. No commercial land sale, MMO scale, external implementation, public launch, purchase or outreach is established by these gates.

## Installed copy

The installed `outputs/Lucy` was updated after stopping its `org.nemoworld.local` server and creating the verified `data/backups/pre-master-wave-2026-10-14.sqlite` backup **after** the administrator credential reset. The installed source manifest was checked against every prior tracked file; `Start World.command` was the sole missing file and was restored from reviewed source. The installer copied only changed tracked files, preserved `data/` and `.runtime/`, and verified all 965 installed fingerprints. The local launch service was restarted, `/api/v1/health` and `/` both returned HTTP 200, and the backup and live database both reported schema 23. All 70 application-table row counts matched; the account credential record matched exactly. The application code came from `101a7c1`; the final installed manifest records the later handoff-only commit containing this paragraph. No database migration ran during this installation.
