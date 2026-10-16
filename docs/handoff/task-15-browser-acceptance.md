# Task 15 — Executable browser acceptance suite

Branch `task-15-browser-suite`, based on `review/nemoworld-queue` at **4fbdff5**.
Task 15 of [Batch 02](../deepseek/TASKS_BATCH_02.md), following the queue review
([Tasks 02–14](../reviews/queue-tasks-02-14.md)).

## Changed files

| File | Change |
| --- | --- |
| `scripts/browser-suite.mjs` | New. The executable browser acceptance suite and its pure helpers. |
| `tests/browser-suite.test.js` | New. Pure unit checks for the production-database refusal rule and the scenario registry. No browser, no server. |
| `package.json` | New `browser` script; `scripts/e2e-smoke.mjs` and `scripts/browser-suite.mjs` added to the syntax gate; `playwright-core` as the one **devDependency**. |
| `package-lock.json` | New. Lockfile for the dev dependency (`playwright-core@1.64.0`). |
| `.github/workflows/ci.yml` | Separate `browser-acceptance` job; the existing `local-platform` (`npm run check`, `npm test`) job is unchanged. |

No source file, template, style, server route, schema or configuration outside that list was touched.

## What the suite is

`npm run browser` boots the shipped `server.js` as a real child process in a private temporary
workspace on a free port, points it at a temporary SQLite database, launches the **system Chrome**
build through `playwright-core`, drives the real interface, and after every browser action reads the
server's own records — over HTTP and directly in the temporary SQLite file — to confirm the database
changed as the interface claimed. A trace and a screenshot of every context are written to
`test-results/` (already gitignored) when a scenario fails, along with the captured page log and the
failed requests.

```
npm run browser                                  the whole suite
LUCY_BROWSER_ONLY=first-person-controls npm run browser    one or more named scenarios
LUCY_BROWSER_KEEP=1 npm run browser              keep the workspace, traces and screenshots
LUCY_CHROME_PATH=/path/to/chrome npm run browser use another Chrome binary
LUCY_BROWSER_CHANNEL=msedge npm run browser      use another installed channel
```

Exit code is non-zero when any scenario fails, is skipped, or leaves the process lock behind. Each
scenario prints one `PASS`/`FAIL` line plus a line per assertion with the value it observed, and a
final `SUMMARY` lists every scenario with its duration. Steps are bounded at 120 s, scenarios at
300 s and the CI job at 20 minutes; each page has a 25 s default action timeout.

## Isolation, refusal and teardown

- **Own server, own database.** The suite creates `mkdtemp()` workspace, writes `LUCY_DATABASE` and
  `PORT` itself, deletes any inherited `LUCY_PUBLIC_ORIGIN`, `RENDER_EXTERNAL_URL`,
  `LUCY_LOCAL_PORT_FALLBACK`, `LUCY_MODEL_NAME`, `LUCY_MODEL_URL` and `LUCY_SETUP_CODE`, and starts
  the server on loopback only. The server takes its process lock inside that workspace, which the
  suite asserts.
- **Production databases are refused.** Before anything starts, the runtime database path must pass
  `productionDatabaseRefusal(databasePath, projectRoot, workspace)`: it has to be inside the
  temporary workspace this process created and may not resolve into `data/`, `outputs/`,
  `outputs/Lucy`, `Lucy-repo`, `backups/` or `assets/`, nor name a `data/` or `outputs/` directory.
  The helper is unit-tested in `tests/browser-suite.test.js`. In addition the suite records the
  state of `data/world.sqlite` before the run and re-checks it afterwards, and the run fails if it
  changed.
- **Teardown always runs.** Browser close, `SIGTERM`, a 10 s grace period, `SIGKILL`, trace discard
  and workspace removal all sit in a `finally` block, so a failing or timed-out scenario still stops
  the server and removes the temporary world. `LUCY_BROWSER_KEEP=1` keeps them for inspection, the
  same escape hatch `scripts/e2e-smoke.mjs` uses.
- **Failure evidence.** On failure: `<scenario>-<actor>.png` and `<scenario>-<actor>-trace.zip` for
  every browser context the scenario used, plus `<scenario>.log` with the error, the expected and
  actual values, and the page's console errors, failed requests and refused API responses.

## Scenarios and what each proves at the database level

Every scenario drives the interface first and then reads the temporary SQLite file (or the server's
own JSON through the browser's own session) to confirm the claim.

| Scenario | Driven in the browser | Read back from the temporary database |
| --- | --- | --- |
| `accounts-and-switching` | First administrator signs up on the *Create first account* tab; signs out; a wrong password is refused; signs back in; a second operator registers on the *Create account* tab | `accounts` row with `role=admin` and exactly one account; the session token is `revoked=1` after sign-out with none live; the second actor is a `member` and its character list holds none of the administrator's characters |
| `credential-exclusion` | Types a password, an invitation code and consent into the authentication form and reloads; then signs in | `localStorage`/`sessionStorage` hold no value containing the password, the invitation code or the email, no `nemoworld-draft:*auth*` key, no entry named for a credential field, no 64-hex credential, and `document.cookie` carries no `world_session` (HttpOnly) |
| `private-draft-isolation` | Owner types into the *Create a character* form, reloads, sees it restored; a second operator opens the same form; the second operator saves a private research draft | The draft key is `nemoworld-draft:operator:<owner id>:character-create` and only in the owner's browser; the second operator's field is empty; `claim_drafts ⋈ claims` names the writer's `account_id`, and each operator's own `GET /drafts` shows only its own row |
| `refresh-and-focus-restoration` | Administrator opens *Author a quest chain*, types a title and steps, focuses the steps field, reloads | The interface returns to *Quest chains*, the ancestor `details` is open, and `document.activeElement` is the remembered `steps` control holding the saved text |
| `first-person-controls` | Selects the resident, opens *Open world*, switches to *First person*, drags on the canvas, then walks with a movement control | A pointer drag changes `agents.yaw` while `agents.x`, `y` and `z` stay identical, so rotation issues no movement; one movement control changes the tile by exactly one step; the `role="status"` aim line names the new facing and tile |
| `country-ambassadors` | Searches the directory, opens the Nepal profile, holds a conversation in the dialog, then posts a mismatched `country_code` from the page | When the conversation is sent, one `ambassador_conversations` row appears for that operator and `amb-NPL`, the other operator has none; the mismatched request answers 400 and adds no row |
| `plot-and-blueprints` | Enters the frontier as the resident, stewards the offered plot, walks to it, previews the blueprint, applies it, removes it | `land_stewardships` gains the row for the signed-in account with the typed purpose; preview leaves `frontier_blocks` at zero; apply writes one row per plan cell, all with that `plot_id` and `creator_agent_id`; remove returns the plot to zero blocks and keeps the stewardship |
| `character-switch-clears-preview` | Previews a blueprint, selects the other character, selects the steward again | `selected-agent` follows the selection; the cached report is gone and the panel is back to its placeholder, so the old preview is not restored |
| `quest-progression` | Administrator authors and publishes a two-step practice chain; the owner's resident begins it; a client completion is posted from the page; the resident is sent into a shared country venue through *Enter with my resident* | `quest_chains` is `published` with two `quest_steps`; `quest_enrollments` names the resident and operator; `/quests/complete` answers 400 and credits nothing; the recorded visit writes exactly one `calling_receipts` row (`quest:browser-shared-walk.reaching-out`, `source_kind=shared_visit`, 5 points, the operator's `account_id`), a second board read does not duplicate it, and the resident holds zero `coin_rewards` |
| `guild-cooperation` | Administrator creates a public and a private project on the board; the other operator loads the board, tries the private project and joins the public one | Two `guild_projects` rows with the requested visibility and the creating resident; the outsider's board omits the private project and `GET /guilds/project` answers 404; `guild_participants` gains a row whose `agents.operator_id` is the joining operator, with no `land_stewardships` and no `coin_rewards` |
| `reward-refusals` | The contributor's *Review* view is inspected and a self-review is posted from the page; a different operator accepts the work in the interface; an ambassador id and the human avatar are posted for credentials | The review card offers no control and the response is 403 with no `reviews` row and no coin; the independent acceptance writes the `reviews` row and exactly one 10-coin `coin_rewards` row; `amb-NPL` answers 404/403 with no `tokens` row, and the human avatar answers 403 with no token row |
| `forged-coin-receipt-refused` | Opens the coin wallet and reads the resident's balance | Two raw inserts bypass the application entirely — one receipt forged from a self-review and one with a broken hash chain — and SQLite refuses both (`Ineligible coin receipt`, `Coin chain mismatch`); the ledger count is unchanged and the wallet shows zero available coins with no receipt |
| `resident-run-resume-refusal` | After the server is restarted, the History view shows the interrupted run and its remaining decisions, and clicks *Resume this interrupted run* | Recovery classifies the run (`status=interrupted`, `interrupted=model_call_in_flight`, `stop_reason=process_restart`); the refused resume leaves the run untouched and mints no credential |
| `signout-privacy` | Signs in, previews a blueprint, creates a private guild project and authors a draft chain, then signs out and revisits the public pages | The private `guild_projects` and `quest_chains` rows still exist (sign-out deletes nothing); `selected-agent` is cleared; the private chain title, the private project title, the frontier panel, the blueprint report and the plot panel are all absent from the rendered pages |

## Regressions from the queue review

| Correction | Browser regression | State |
| --- | --- | --- |
| 1. Logout clears cached private quests, guilds, blueprint reports and land/world state; selecting another character clears the old blueprint preview | `signout-privacy`, `character-switch-clears-preview` | Encoded and passing |
| 2. Ordinary forms are opt-in and keyed by operator; authentication forms never persist credentials; passwords, secrets, tokens, setup codes, invitations and consent are excluded; onboarding and focus records are scoped by operator or visitor | `private-draft-isolation`, `credential-exclusion` | Encoded and passing. The private **setup-code** field is the one credential the suite cannot render: it exists only in public-origin mode, which pins the exact HTTPS origin and Host header and therefore cannot be served to a plain HTTP browser. The suite proves exclusion for the fields a browser does render (password, invitation, consent) and asserts that no credential-shaped value of any kind is in storage. |
| 3. Draft fields restore after their controls exist; refresh returns to the right form and opens ancestor disclosures before focusing | `refresh-and-focus-restoration` | Encoded and passing (the focused control is read back from `document.activeElement` after the render, with its ancestor disclosure open) |
| 4. An interrupted resident job resumes only within its remaining model/API/elapsed-time budgets; new credentials keep the original deadline; an expired run must start a separate bounded new run | `resident-run-resume-refusal` | **Partly encoded.** The browser proves the real recovery classification after a server restart, that the History view reports the recorded remaining decisions, and that a resume is refused with nothing started. The budget/deadline arithmetic itself cannot be reached in a browser here: `POST /residents/resume` requires a configured local model (`LUCY_MODEL_NAME`) and this environment has no model weights, which must not be downloaded or invented. That half stays covered by the process-level suites (`tests/resident-crash.test.js`, `tests/recovery.test.js`). |
| 5. The Task 08 structural coin-receipt validation remains present | `forged-coin-receipt-refused` | Encoded and passing as an **actual database refusal**: a receipt forged from the contributor's own review and a receipt with a broken hash chain are both written straight into SQLite, past the application, and the database rejects them. |

## The dev dependency, and why production is unaffected

`playwright-core@^1.64.0` is the only entry in `devDependencies`, and it drives the Chrome build that
is already installed (`channel: 'chrome'`); **no browser is downloaded** and no model runs.

- `package.json` still has no `dependencies` field, and `server.js`, `app.js`, `world.js`, `src/**`,
  `index.html` and the renderer never import it. The shipped server remains dependency-free.
- `npm test`, `npm run check` and `npm run e2e` do not touch it. `scripts/browser-suite.mjs` imports
  `playwright-core` lazily inside `launchBrowser()`, exports its pure helpers, and only runs when it
  is the entry point, so `npm test` passes with **no `node_modules` directory at all** — verified by
  running the suite in that state. `tests/browser-suite.test.js` covers the refusal rule and the
  scenario registry without a browser.
- CI installs it (`npm ci`) only inside the new `browser-acceptance` job; `npm run check` and
  `npm test` in the existing job still run with no install step.

## Teardown and refusal behaviour actually observed

```
TEARDOWN
  server stopped, process lock released: true
  temporary workspace removed: true
  shipped database untouched
```

## Actual gate output

`npm run check`

```
> nemoworld@1.0.0 check
> node --check server.js && node --check scripts/local-launch.mjs && node --check scripts/e2e-smoke.mjs
  && node --check scripts/browser-suite.mjs && node --check src/platform.js … 
(exit 0)
```

`npm test`

```
ℹ tests 454
ℹ suites 0
ℹ pass 454
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44512.545708
```

454 = the 448 tests of the reviewed queue plus the six new `tests/browser-suite.test.js` checks.
Zero fail, zero skip.

`npm run e2e`

```
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
```

`npm run browser`

```
NemoWorld browser acceptance suite
  project root      …/work/t15
  scenarios         accounts-and-switching, credential-exclusion, private-draft-isolation,
                    refresh-and-focus-restoration, first-person-controls, country-ambassadors,
                    plot-and-blueprints, character-switch-clears-preview, quest-progression,
                    guild-cooperation, reward-refusals, forged-coin-receipt-refused,
                    resident-run-resume-refusal, signout-privacy
  base URL          http://127.0.0.1:53749
  database          /var/folders/…/nemoworld-browser-rCqnx1/world.sqlite
  server ready      GET /api/v1/health -> 200 {"status":"ok","storage":"sqlite","model_configured":false,…}
  browser           155.0.8059.40
…
SUMMARY  14 passed, 0 failed
  PASS  accounts-and-switching (3067 ms)
  PASS  credential-exclusion (1188 ms)
  PASS  private-draft-isolation (2057 ms)
  PASS  refresh-and-focus-restoration (702 ms)
  PASS  first-person-controls (3852 ms)
  PASS  country-ambassadors (694 ms)
  PASS  plot-and-blueprints (15761 ms)
  PASS  character-switch-clears-preview (3748 ms)
  PASS  quest-progression (22269 ms)
  PASS  guild-cooperation (2272 ms)
  PASS  reward-refusals (2090 ms)
  PASS  forged-coin-receipt-refused (432 ms)
  PASS  resident-run-resume-refusal (789 ms)
  PASS  signout-privacy (4759 ms)
  result  PASS — the interface was driven in a real browser and the database agreed
```

Measured on this machine (macOS, Apple silicon, Chrome 155.0.8059.40, Node v24.19.0): the whole
suite runs in about 90 s wall clock and writes nothing to `test-results/` on a clean pass.
Representative observations from the run, as printed by the suite:

- first-person drag: `yaw 0.000 -> 1.201`, position `10,6` unchanged, aim line `First person · facing west · at 10, 6, layer 0 …`
- blueprint preview: `Garden shelter · 14 blocks`, `Every server rule passes for this position.`, `Inside your plot plot:0:0:0:0`; apply wrote 14 `frontier_blocks` rows and remove returned the plot to zero
- quest progression: `journey_visits recorded country:AFG; one receipt quest:browser-shared-walk.reaching-out from shared_visit; 0 coins; the board moved to step 2`
- forged receipts: `Ineligible coin receipt` and `Coin chain mismatch`, ledger unchanged
- recovery: `status=interrupted, interrupted=model_call_in_flight, stop_reason=process_restart`, then `refused: Configure a local model before running a resident.`

## Limitations

1. **Resident resume budgets (see the table above).** The suite proves the classification and the
   refusal; the remaining-budget and original-deadline arithmetic needs a configured local model and
   is left to the process-level tests. Nothing in this suite claims otherwise.
2. **The private setup-code field** is not exercised in a browser for the reason given above.
3. **Fixtures.** Accounts and characters used only as actors are created over the documented API
   (`POST /auth/register`, `/agents`, `/callings/select`, plus one invitation); the first
   administrator, the second operator, every sign-in, and every assertion are driven through the
   interface. This keeps each scenario short and lets one scenario fail without poisoning the rest.
4. **Blueprint anchors.** The panel's default anchor is the plot's own first cell, which can sit
   further than the six-tile build range from where the resident actually stops. The suite walks to
   the plot, reads the plotted footprint from the preview report, and re-anchors the blueprint beside
   the resident before previewing again. Both previews still write nothing; this is a property of the
   shipped default, recorded here rather than worked around silently.
5. **Headless WebGL.** Chrome is launched with `--enable-unsafe-swiftshader` (and `--no-sandbox`
   under CI). If the 3D renderer cannot start, the app falls back to the pixel map, the aim line
   never renders and the first-person scenario fails loudly instead of passing quietly.
6. **Console noise.** A signed-out page logs the expected `401 GET /api/v1/me` at boot; the suite
   records console errors, failed requests and refused API responses for the failure report but only
   fails on its own assertions. A clean run leaves no unexpected entries.
7. **Not covered.** Mature crop harvest, the second authored quest step, every guild transition
   (pause/resume/leave/verify), the responsive layouts, and the recovery/backup flows are not part of
   this suite — the same set the queue review listed as not browser-tested, minus those now covered.
8. **Trusted-database caveat.** The forged-receipt scenario proves the shipping database refuses a
   fabricated receipt. It does not claim an administrator with write access to the whole installation
   cannot tamper with it.

## Residual risks

- Timing: the walking steps depend on the shipped 120 ms movement throttle and one `GET /world` per
  step, so the frontier scenario is the longest (~16 s). On a much slower machine the per-step
  120 s bound could be reached.
- Authentication limiter: the suite signs in through the interface about ten times. The limiter
  allows 15 attempts per minute per peer, and `signIn` waits out a limiter refusal once and then
  retries rather than failing; a run that tripped it twice would fail honestly.
- The suite exercises one Chrome build on one platform here; the CI job runs the same suite on
  `ubuntu-latest` with the preinstalled Chrome, and uploads `test-results/` when it fails.

## Migration and rollback

**There is no schema change and no migration.** The suite reads whatever schema the shipped server
creates in its own temporary database (18 here), writes only through the documented API, and its one
direct write is a deliberately forged receipt that the database refuses. Deploying this change
touches no installed world.

Rollback: delete `scripts/browser-suite.mjs`, `tests/browser-suite.test.js`, `package-lock.json`,
`test-results/`, revert `package.json` (drop the `browser` script, the two extra `--check` entries
and the `devDependencies` block) and `.github/workflows/ci.yml` (drop the `browser-acceptance` job),
then remove `node_modules/`. Nothing in `src/`, `server.js`, `app.js`, `world.js`, `render.yaml`,
`outputs/Lucy` or any installed account or database is involved either way.
