# NemoWorld — Batch 02 integration review

13 October 2026. Reviewed branch: `review/nemoworld-batch02`, based on `verify-batch02-wave-c` (`4333636`), following the previous reviewed release `4fbdff5`.

## Integrated work

| Task | Delivered branch tip | Included changes |
| --- | --- | --- |
| 15 | `ae88606` | Executable, isolated browser acceptance suite and CI job; dev-only Playwright dependency |
| 16 | `9d46dcb` | Bounded authenticated world event streams, live presence/build/public-chat updates and reconnect checks |
| 17 | `90e2abd` | Direct nearby door, crop, bench, crafting-station and ambassador-desk interactions with ownership, distance, permission and replay checks |
| 20 | `2dd2e7f` | Eight original country/area venue layouts, plus the earlier design brief `89ef2a6`; the remaining 240 keep the generic shape |
| 24 | `93a1fd7` | Scoped research concerns, substantive-question dedupe and retained proposal versions |
| 27 | `38f29c6` | Bounded private administrator diagnostics and disposable operational recovery drills |
| 28 | `14eaa58` | Deployment configuration, threat model, release checklist and capacity experiment artifacts |

These branches already formed a merge stack. The review preserved that history and added corrections on a separate branch. No installed source differences from the previous reviewed release were found before the update.

## Corrections made during integration

### Runtime database validation

The proposed Render pre-deploy command could not validate the mounted service database: [Render persistent disks are available only at runtime](https://render.com/docs/disks). A shell-only rehearsal did not exercise that boundary. The command was removed. Server startup now acquires the process lock, validates an existing database, then migrates/seeds and starts listening. Real entry-point tests prove corrupt, foreign and newer-schema databases are refused without their source bytes changing, and a valid world restarts with its audited records preserved.

### Retirement reaches the actual research workflow

The generator recorded consolidation, but the research desk still projected the original `proposed` status and allowed activation. The current desk now shows `consolidated` with its replacement, or `retired` when no scoped successor exists. Both are read-only historical proposals and activation answers 409. No baseline is falsely presented as a replacement for an unscoped applied question. Current catalog totals exclude this history; `retained_total` includes all retained rows. Meaningful regression coverage checks the server and the real browser UI.

### Browser acceptance waits for saved work

A release run failed `plot-and-blueprints` because it inferred saved stewardship from a disappearing button. An incremental repaint could remove that button before the write finished. The check now waits for the actual `land_stewardships` row before asserting its owner and purpose. The failed run is retained in `work/verification/batch02-release-browser.log`; it is not relabelled as passing. No server limit, assertion or permission was relaxed.

## Verification

- Full integrated suite: **513 tests, 513 pass, zero fail/skip** (`batch02-release-tests.log`).
- HTTP acceptance: **15/15 steps pass**, temporary workspace and process lock removed (`batch02-verified-e2e.log`).
- Browser acceptance: **22/22 scenarios pass**; final run evidence in `batch02-verified-browser.log` and the release verification JSON. Scenarios exercise actual UI actions and then confirm server/database effects.
- Syntax gate and content seal pass: **86 definitions**, 3 support files, 42 referenced notices/assets.
- Operational failure drills execute in the suite: backup recovery point, corrupt backups, migration rehearsal, interrupted workers, model queue saturation, full storage and diagnostics redaction.
- Manual disposable-browser inspection: Nepal and Fiji country venues load and pan in 3D; Fiji's lagoon, palms, boats and public landing visibly render. No captured console errors. Screenshot: `docs/images/batch02-fiji.png`. Temporary preview removed.

Logs and private backups are outside Git in `work/verification/`. The browser dependency is development-only; the production server retains zero npm runtime dependencies.

## Installed-data rehearsal and preservation

The previous installed source was `4fbdff5`, schema 18. The server was idle before shutdown and the stopped database was backed up to `pre-batch02-schema18.sqlite`. The update was rehearsed on a copy before application. Schema stays **18**; two proposal history tables are added idempotently.

Preservation checks compare every existing record in 53 non-research tables and the identities/states of every existing research row. Replaced proposed content must have an exact archived version; activated tasks are ineligible for replacement. Rehearsal results:

- All **2,998 existing proposal rows** retained.
- **748 revised proposals** have exact archived prior versions.
- **261** interchangeable templates consolidated into scoped replacements.
- **1,983** templates retired without inventing a scoped replacement.
- **1,015 current proposals**, **3,259 retained rows** including history.
- Existing account, world, plot, reward, quest, guild, conversation and audit records preserved; 248 ambassadors retained.

Application results and source-byte equality are recorded separately in `outputs/nemoworld-batch02-installed-verification.json`. Keep `data/`, backups, `.runtime/`, credentials and model weights private. Source archives contain tracked source only.

## Practical limits

Seven of the fourteen Batch 02 tasks are integrated. Tasks **18, 19, 21, 22, 23, 25 and 26** remain; begin Task 18 from this reviewed branch. No real beneficiary pilot, external adoption, outreach, coin trading, land sales or hosted deployment was activated.

Historical browser timing failures are preserved. Passing this review's gate is not a guarantee against all future timing failures. Remote avatars in 3D still step between whole tiles; interpolation is used for the pixel map and local camera. The live stream has explicit process/connection/buffer bounds, not a proven public user capacity. Interaction replay protection is bounded and process-local. Mature crop harvest was not newly browser-tested here. The threat model is a code review, not an independent security audit, and the host/database owner can still tamper with the installation.

GitHub and the main-branch download are unchanged by local integration.
