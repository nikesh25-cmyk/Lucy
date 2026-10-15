# Karma Coins, the shop and the comfort controls, ported onto schema 26

Branch `feat/karma-shop-integration`, cut from `feat/agent-homes-vault` (`32d8362`, schema 25). Source:
`integration/karma-shop-and-controls` (head `e224b97`, merge-base `c0d09fbd`, built against schema 23).
Nothing was merged wholesale: every file was ported by hand or by a three-way patch of the source
branch's own diff. The installed copy in `outputs/Lucy` was never touched, and `src/vault.js` and the
vault routes are unchanged.

## What landed

**Server (commit 1).**
- `src/karma.js`, `src/shop.js` as built. `src/database.js` creates `KARMA_SCHEMA` and `SHOP_SCHEMA`
  and writes `PRAGMA user_version=26`; it refuses a database above 26. A schema-25 world gains the
  additive tables on open and the migration mints nothing.
- `src/recovery.js` accepts 1–26 and, from version 26, checks every column, both views, all seven
  protection triggers and `verifyKarmaLedger` (both hash chains, every receipt against the saved row it
  cites, the per-service and per-operator daily bounds, a non-negative purse).
- `server.js`: `GET /karma`, `GET /shop`, `POST /karma/settle`, `POST /shop/purchase` (idempotency key),
  and the `shop-panel` browser module in the static table.
- Account export (`GET /export`) now carries `karma` and `shop`: the operator's own records only, with
  no chain hashes, purchase keys or fingerprints (the existing export test forbids a `"hash"` or
  `"token"` key, which is how this was found: the policy object has a `token:false` flag, so the export
  carries the policy version and sentence instead of the object).
- Account deletion needed no code: the ledgers are append-only and the account row is only blanked, so
  the chain keeps verifying; the wallet and the purse are unreachable afterwards and a deleted operator
  cannot spend. `tests/karma-integration.test.js` proves it.
- Docs: `docs/KARMA.md` (plus a "where it lives" section), `docs/API.md`, `docs/ARCHITECTURE.md`
  (version 26), `docs/COINS.md` cross-link, `docs/OPERATIONS.md` and `docs/RELEASE_CHECKLIST.md`
  (current schema), and the source branch's own task records under `docs/handoff/` (these still say
  "schema 23"; that is the historical number the module was first written under).

**UI and comfort (commit 2).** `src/ui/shop-panel.js`, the build-by-choosing-an-item interface
(`src/ui/build-interface.js`), touch controls (`src/ui/touch-controls.js`), camera comfort
(`src/camera-controls.js`, `src/voxel-geometry.js`: level view, wheel and pinch zoom, easing, hover
throttle), `nemo-theme.css`, and the matching `app.js` and `src/voxel-world.js` changes. The browser
scenario `karma-closed-loop` is in `scripts/browser-suite.mjs`.

## The closed-service-economy rules still hold

Re-proved on the current schema, not assumed (`tests/karma-ledger.test.js`, `tests/shop.test.js`,
`tests/karma-shop-http.test.js`, new `tests/karma-integration.test.js`):

- Karma is separate from the review-backed coins in `docs/COINS.md`: no Karma table reads or writes
  `coin_rewards`, and the only caller of the faucet is `karmaSettle`, which is session-only (a resident
  runtime credential gets 403). No request field names an amount, a source or a day.
- Earned only from rows the server already wrote: twelve services, one SQL fragment each, one receipt
  per saved row, two a day per service, sixty a day per operator, UTC day from the server clock, enforced
  in the method and again by `karma_receipts_validate_insert`.
- Spent only in the shop: the single debit is `karmaSpend`, inside the request transaction, so a failed
  grant returns the Karma. New here: a test that fills a shelf to its bound and shows the real ledger
  and the real shop roll back together.
- Private cottages (schema 25) are never a shared place: another operator cannot visit one, so it can
  never be the source of a `shared_space_visit` receipt.

## Things that changed while porting

- Renumbered **23 → 26** (the mainline used 23 for the trade board, 24 for sealed content, 25 for the
  vault). A database written by the unmerged branch under its own "schema 23" is **not** a supported
  input; it was never deployed.
- `tests/karma-ledger.test.js` visited another operator's garden *and cottage*. A cottage is private
  now, so the second visit uses a second resident's garden instead. The rule it proves is unchanged.
- About 30 tests pinned the schema number; they pin 26 now. Fixtures that fake an old database by
  dropping later tables also drop the Karma and shop objects first (`DROP ... IF EXISTS`), otherwise the
  schema-24 rebuild of `world_objects` trips over a trigger that names a table the fixture removed.
- Main already had a simple mouse-wheel zoom in `src/voxel-world.js`. It was replaced by the source
  branch's wheel and pinch handling (non-passive, inert over menus, dialogs and focused fields).
- Main had already fixed double camera drags by giving the touch layer no drag surface in the 3D view
  (`surface: null`). That stays; the source branch's `floating`, `coarsePointer`, `quickbar` and
  `viewport` options were added around it, and main's separate `nm-touch-floating` class line was
  dropped because `floating:true` now sets the same class.
- `game-theme.css`: only the two movement-button rules that still exist moved from 38 px to 44 px. The
  other two rules the source branch edited no longer exist on main.
- `scripts/browser-suite.mjs` keeps main's `schemaBefore` check; the source branch's version of that
  line was dropped.

## Could not be ported, or needs a decision

- **Nothing in the source branch was left out.** The only parts not carried over verbatim are the lines
  named above.
- Not run by me: the browser suite beyond what is listed under Verification, the operator's own
  walk-through of the shop on a real device, and any load or soak run.
- **Expected conflict with `feat/visual-upgrade-slice-1`:** exactly one, in `src/voxel-world.js` inside
  `paint()` at the `applyPhase({ ... })` call. This branch passes `distance: view.distance` (the eased
  distance) and the visual branch appends `interior: isInterior(...)`. Resolution is to keep both:
  `position: target, distance: view.distance, plan: { window: contents.stats.window }, interior: isInterior(...)`.
  `git merge-tree` against the visual branch's head (`7eb15fb`) reports no other conflict; `game-theme.css`
  and `server.js` merge cleanly.
- **Design observation, no change made:** a shop purchase puts herbs, fiber, wood or a keepsake on the
  buyer's own shelf, and the existing resource-offer and trade-board paths can move shelf items between
  operators. That moves goods, never Karma, and each purchase is bounded by the per-day allowance, but it
  means Karma can end up as goods in another account. The doc's "not transferable" statement is about
  the Karma Coin itself. If that matters, the cheapest guard is to refuse to list a purchased-and-unused
  keepsake on the trade board; it was not added because it changes the trade rules.
- The wallet read (`GET /karma`) is open to a resident's own runtime credential with read scope, the
  shop read and purchase are session-only. That is how the source branch built it and `docs/API.md` now
  says so; it is worth a second look if residents should not see their operator's purse.

## Verification

- `npm run check`: 101 files, 0 failed.
- `npm test`: 1146 of 1146 pass, including the new `karma-ledger`, `shop`, `karma-shop-http`,
  `karma-integration`, `shop-panel`, `build-interface-home`, `camera-comfort`,
  `touch-controls-comfort` and `ui-mount-listeners` tests.
- Real Chrome, focused run: `LUCY_BROWSER_ONLY=karma-closed-loop npm run browser` passes (sign-up, a
  built object, settle to 8 Karma Coins, one purchase, a real restart, and 390 px with reduced motion).

## Open: the full browser suite is NOT green

`npm run browser` (full): 31 passed, 15 failed. Not yet compared with the vault base (`32d8362`), so it is
unknown how many are caused by this port. The first failure, `signed-in-game-play`, is a phone check
("every phone movement, camera and action target must be visible and tappable"): the pad keys now
measure 52 px and the bar is lifted over the quickbar, so this is probably a real effect of the
touch-controls port and needs a look. Later failures (`cooperative-restoration-two-operators`,
`reviewer-workbench`, `review-states-and-refusals`, `mission-quality-advisory-signals`,
`live-observation-readonly`, `game-shell-entry-and-continue`, `selection-does-not-clobber-navigation`,
`management-interface-and-roles`, `private-memory-and-journal-boundaries`, `first-ten-minutes`,
`first-play-solo-ambassador`, `restoration-two-clients`, `phone-conversation`, `signout-privacy`) may be
a cascade or pre-existing. Next step: run the same suite in `work/karma-base` (a detached worktree of
`32d8362`, node_modules symlinked) and diff the failing set. `karma-closed-loop` passes.
