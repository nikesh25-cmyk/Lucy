# Task 13 — newcomer journey and accessibility

Branch `task-13-newcomer-journey`, based on `task-08-coin-abuse` (schema **18**, 429 tests, 12 HTTP
acceptance steps). Delivered on schema **18**, **439 tests**, **15 HTTP acceptance steps**. The schema,
`src/database.js` and `src/recovery.js` are untouched: task 14 runs next on this same base and needs
a stable schema. Nothing in tasks 01–08 was re-litigated.

## Honesty note first

**This repository has no browser automation.** There is no headless browser, no Playwright or
Puppeteer, and the project rule is no npm dependencies, so **I did not click through this flow, and I
did not execute the manual walkthrough below.** UI evidence for this task is:

1. **HTTP acceptance over the real server** (`scripts/e2e-smoke.mjs` steps 13–15) on a disposable
   database: a member account, an AI resident, a chosen calling, a country ambassador read, a saved
   practice activity, its receipt and the review boundary, with exact payload assertions.
2. **Source-level assertions on what the renderer reads** (`tests/newcomer-journey.test.js`), the same
   approach tasks 06 and 07 used: the six steps, the copy, the navigation entry, the dialog contract,
   the absence of `innerHTML`, and the persistence wiring.
3. **Measured contrast and target values recomputed from `style.css` and `nemo-theme.css`** by that
   test — the numbers are read out of the stylesheets through a small cascade reader, not restated.
4. **The client-side draft/focus logic executed on its own** with a stub `localStorage`, including a
   store that throws (private window / quota).

No claim in this document is a browser observation.

## What was asked, and what was built

The task asked for a concise onboarding flow — enter as a human or create an AI, choose a calling,
meet a country ambassador, complete one saved practice activity, see its receipt, understand how real
contribution review works — with account creation, controls and every essential workflow usable in
keyboard/text mode and on small screens, drafts and focus surviving a refresh, no trapping modal, no
hidden required field, measured contrast and touch targets, the first-person/map fallback explained,
and XP distinguished accurately from NemoCoins.

What changed:

- **`app.js`** — a guided **Start here** section (new navigation entry, first in *THE WORLD*), a
  compact version of it on the common home page and in the Guide, the receipt card, the review
  boundary card, the controls card, a text-mode **Walk to a tile** form in the world view, visible
  "Required./Optional." markers on every form control, and a client-side persistence layer (drafts,
  remembered focus, guided progress).
- **`nemo-theme.css`** — styles for the guided path in the existing language, four measured contrast
  corrections and the small-target corrections below.
- **`scripts/e2e-smoke.mjs`** — steps 13, 14 and 15.
- **`tests/newcomer-journey.test.js`** — 10 new tests (the four gates counted 429 before, 439 after).
- **Docs** — this file, a section in `docs/NEMOWORLD.md`, and cross-references in `docs/CALLINGS.md`,
  `docs/COINS.md` and `docs/PEACEFUL_WORLD.md`.

## The flow

| # | Step | How it reads as complete | What it offers |
| --- | --- | --- | --- |
| 1 | Enter as a human, or create an AI resident | a signed-in account **and** a selected resident | Create an account · Sign in · Create an AI resident · Play as myself |
| 2 | Choose a calling | the resident has a calling (Explorer is the default until one is chosen) | Review or change the calling |
| 3 | Meet a country ambassador | the operator opened an ambassador profile or talked to one (remembered in this browser) | Meet the country ambassadors |
| 4 | Complete one saved practice activity | one calling receipt exists (5 cosmetic experience) | Open the calling objectives · Open the quest chains |
| 5 | Read its receipt | a receipt exists; the card renders it field by field | Open my experience receipts |
| 6 | Understand how real contribution review works | the operator pressed the acknowledgement (remembered in this browser) | Open a real mission · Read the review boundary again |

Steps 1, 2, 4 and 5 are derived from **real server state** (the session, the resident, the calling
view, `calling_receipts`). Only steps 3 and 6 are local: the server records nothing that means "this
person read the ambassador page", so inventing a server fact for it would have been dishonest.

Where the flow lives: a **Start here** navigation entry renders the whole path, the receipt, the
review boundary and the controls note (`renderStartJourney`). The common home page and the Guide
render the compact card, which shows **only the step that is waiting** rather than repeating all six,
so a returning resident is not lectured. The receipt card and the boundary card are one section each;
neither opens a dialog.

## Accessibility findings

### What the flow does

- Six ordered `li` items in an `ol`, each with an `aria-label` naming its number, title and state
  ("Step 3 of 6: Meet a country ambassador. This is your next step."), a visible badge and at least
  one labelled button.
- A `progress` element with an `aria-label` ("n of 6 guided steps complete").
- The review boundary is a two-column comparison of cosmetic XP and NemoCoins, then an explicit
  acknowledgement button with `aria-pressed`, so "understood" is a stated act rather than an
  assumption.
- Nothing in the flow needs a drag, a hover or a pointer. The whole path is buttons, links, form
  fields and disclosures, created with `document.createElement` and `textContent` (`app.js` still
  contains no `innerHTML`).

### What was broken, and what was fixed

Four text colours in the shipped stylesheets failed WCAG 2.2 AA (4.5:1) for normal text. All four are
in surfaces this task touches or reaches from the flow. Measured values, recomputed from the
stylesheets by the test:

| Surface | Was | Now | Where |
| --- | --- | --- | --- |
| Calling objective mark (`◇` / `✓`) on the calling story | `#77914e` on `#163c30` = **3.45:1** | `#bdd2a8` on `#163c30` = **7.51:1** | `nemo-theme.css` |
| Completed objective mark | `#216744` on `#163c30` = **1.79:1** | `var(--gold)` `#ded6a5` = **8.28:1** | `nemo-theme.css` |
| Land plot tile label | `#697a73` on `#eef1ed` = **3.98:1** | `#3f5548` on `#eef1ed` = **7.08:1** | `nemo-theme.css` |
| Land atlas area label | `#8a958b` on `#eef1ed` = **2.73:1** | `#4a5c52` on `#eef1ed` = **6.26:1** | `nemo-theme.css` |

The plot grid and the atlas grid were the only light surfaces left in the dark theme; their labels
were carried over from the earlier light palette and were unreadable in the dark language. The fix
keeps the same restrained green/gold palette and changes no geometry.

Touch targets below the project's own 44-pixel convention were raised. Measured before → after:

| Control | Was | Now |
| --- | --- | --- |
| `button.small` (secondary actions everywhere) | 38 px | 44 px on any coarse pointer and at ≤650 px |
| Navigation tab | 40 px at ≤1050 px | 44 px at ≤1050 px |
| Frontier hotbar button | 38 px at ≤650 px | 44 px on a coarse pointer and at ≤650 px |
| Dialog close button (`.icon-button`) | 32 px | 44 px on a coarse pointer and at ≤650 px |
| Session button (`Sign in` / `Create account`) | 33 px at ≤600 px | 44 px on a coarse pointer and at ≤650 px |
| Account-dialog tab (`Sign in` / `Create account`) | 37 px | 44 px on a coarse pointer and at ≤650 px |
| World-directory action button | 36 px | 44 px on a coarse pointer and at ≤650 px |
| Land plot tile | 34 px at ≤600 px | 44 px at ≤600 px and on a coarse pointer |
| Land atlas area | 36 px at ≤600 px | 44 px at ≤600 px and on a coarse pointer |
| Password reveal (`Show` / `Hide`) | 26 px | 32 × ≥36 px (see below) |

The password reveal is deliberately **not** 44 px: it is an inline control inside a 44-pixel field,
and enlarging it would either overflow the field or overlap the value. It is reported at 32 px, above
the 24 × 24 px WCAG 2.2 AA minimum, and that is the only sub-44 target left in the flow.

Already adequate and left alone: primary `button` (44 px), `.movement` controls (44 × 44 px),
`.landmark-list button` (58 px), `input/select/textarea` (44 px).

### Contrast measured across the palette (recomputed from the stylesheets)

`body text on the page 15.28:1 · body text on a panel 11.2:1 · secondary text on the page 10.41:1 ·
secondary text on a panel 7.63:1 · secondary text on the world footer 8.48:1 · gold heading on the
page 11.94:1 · gold heading on a panel 8.75:1 · primary button label 11.94:1 · input value 13.41:1 ·
input placeholder 7.64:1 · field hint 7.63:1 · badge label 8.19:1 · error message 7.68:1 · calling
objective mark 7.51:1 · completed objective mark 8.28:1 · calling HUD text 12.12:1 · aim line text
4.82:1 · land plot tile 7.08:1 · land atlas area 6.26:1 · newcomer lane text 11.23:1 · skip link
11.94:1 · focus ring 11.94:1`

Every text pair is at or above 4.5:1 (the aim line, a light panel with greenish text, is the lowest at
4.82:1), and the focus ring is 11.94:1 against the page and 8.75:1 against a panel, well above the
3:1 non-text minimum. The test asserts each pair, so a later colour edit that lowers a ratio fails the
suite.

### The dialog contract

- Both shipped dialogs (`#auth-dialog`, `#credential-dialog`) are native `<dialog>` elements opened
  with `showModal()` and named by a heading (`aria-labelledby`), each with a labelled close button
  ("Close account dialog" has an explicit `aria-label`).
- Nothing intercepts `cancel`, and no handler cancels a close: Escape closes every dialog, including
  the dynamically created ambassador conversation, which also carries a visible **Close** button.
- The world keyboard map stands down while any dialog is open
  (`document.querySelector('dialog[open]')`), so a stray key can neither move a resident nor be
  swallowed while the user is reading a dialog.
- **No hidden required field:** every control now renders "Required." or "Optional." next to its
  hint, every control keeps its native `required` flag and an `aria-label`, and the account form's
  consent checkbox, invitation field and setup-code field were already visible. A contract test
  asserts all of it.

### First-person and map fallback, explained in the flow

The controls card states, in the flow itself: in the 3D world, drag to look and use W A S D or the
arrow keys to walk; the aim line under the view names the tile you face and whether it is solid;
**First person**, **Turn mode** and **Step-up mode** are ordinary buttons with announced state. If 3D
graphics are unavailable, the same world falls back to the pixel map, where the arrow buttons move one
tile at a time, **Walk to a tile** plans a route from typed coordinates, and the World list is a text
view of every place and participant. It closes with "Nothing in this journey needs a mouse, a drag or
a hover."

The fallback is real, not just described: `walkToTileForm` renders in the world view for a selected
resident and calls the same `walkTo` planner the map click path uses (`planWalk`), refusing
out-of-bounds coordinates and reporting a blocked route in words.

## Cosmetic XP versus NemoCoins — the correctness requirement

The two are described as separate records, and the numbers are read from the server policy rather
than typed twice:

| | Cosmetic calling experience (XP) | NemoCoins |
| --- | --- | --- |
| Records | bounded world participation | one real scoped contribution |
| Credited from | a saved server fact: a calling objective or an authored quest step | an independent, authorized human's acceptance of a real task on a real (non-demo) mission |
| Amount | 5 per objective or step | a fixed 10 per accepted task |
| Limit | 10 per resident per UTC day | 100 per operator per UTC day |
| Can it be spent or moved? | no — cosmetic rank titles only | no transfers, no cash value |
| Authority | none | none — approval is not proof of external impact |

The renderer reads `CALLING_POLICY` and `COIN_POLICY` from the live payloads
(`state.callings.policy`, `state.journey.coins.policy`) and falls back to two literals for a
signed-out visitor. The test asserts those literals equal the imported server constants
(`CALLING_POLICY.experience_per_objective === 5`, `…daily_experience_limit === 10`,
`COIN_POLICY.award === 10`, `…operator_daily_limit === 100`), so the wording cannot drift from the
behaviour. It also asserts `CALLING_POLICY.currency === false` and `COIN_POLICY.transferable === false`.

The behaviour is asserted end to end in the harness: the newcomer's practice receipt exists (5 of 10
today, `available: true`, from one saved `crop_plant` fact) **and** the same resident's wallet holds
`balance: 0`, `issued: 0`, `receipt_count: 0`, with the ledger valid — while the earlier
independently accepted contribution still holds its single 10-coin receipt.

## Persistence: what survives a refresh

All of it is `localStorage` in this browser; nothing is sent to the server and no table was added.

| Key | Contents | Written when | Cleared when |
| --- | --- | --- | --- |
| `nemoworld-draft:<section>` | the text values of an opted-in form | on `input` and `change` | on a **successful** submit, or when every value is empty |
| `nemoworld-focus` | `{section, field}` | on `focusin` | on a successful submit (`forgetFocus`) |
| `nemoworld-newcomer` | `{completed[], acknowledged}` | meeting an ambassador; the review acknowledgement | never (it is the newcomer's own progress) |

Both account forms opt in (`auth-login`, `auth-register`), so a half-finished registration survives a
refresh: `resumePendingWork()` runs at the end of `boot()`, reopens the account dialog **only if a
draft actually exists**, and refocuses the control the cursor was in. A missing, empty or corrupt
record degrades to "no draft"; a `localStorage` that throws (private window, quota) is swallowed and
the forms still work — all of that is executed in the tests, not just asserted as text.

## Manual walkthrough — written, not executed

On a **disposable** database only (never the installed copy):

```sh
LUCY_DATABASE=/tmp/newcomer-check.sqlite PORT=3311 node server.js
```

1. Open `http://127.0.0.1:3311`. The header offers **Create account**; the home page shows **Start
   here: your first six steps** with five of six waiting and step 1 highlighted.
2. Press **Create an operator account**. The dialog opens with focus in the first field. Press
   **Escape**: the dialog closes and focus returns to the button that opened it. Reopen it: with no
   invitation needed, fill the name, a private email, a 12-character password and the consent
   checkbox, then choose **Play as myself** or **Create AI agents**.
3. Refresh the page mid-form. Expect the dialog to reopen on the same tab with the typed values
   restored and the cursor back in the field you left.
4. Create an AI resident under **My characters**, then select it. The **Start here** card advances to
   step 2.
5. Open **Start here**, press **Choose a calling**, pick one (for a Cultivator, Explorer or Artisan
   the calling objectives touch different saved facts than the shipped practice chain does) and
   confirm the calling and its guild appear. Step 2 completes.
6. Open **Regions & ambassadors**, search a country and press **Open profile** or **Talk to this
   ambassador**. Step 3 completes and stays complete after a refresh.
7. Open **Quest chains**, begin **The Quiet Harvest** (badged *practice · cosmetic only*) and read
   the next actual action: *Sow a first row*, output *One planted crop in your own garden*, credited
   from a saved `crop plant`, no review required.
8. Follow **Open this step** to the world, travel home, start building, choose **Crop patch** and
   place it on a free tile — or use the **Walk to a tile** form and the tile coordinates to do the
   whole thing from the keyboard. Then open **Garden & workshop** and plant herbs on that patch.
9. Return to **Start here**: step 4 and step 5 are complete and the receipt card shows the objective,
   the saved source, the UTC day, 5 cosmetic experience and its state, above the sentence that
   practice mints nothing. The coin wallet for the same resident still shows 0 coins and 0 receipts.
10. Read the **Cosmetic progress, and real contribution review** card and press **I have read the
    review boundary**: step 6 completes and the state survives a refresh. The card states that a
    submission waits for a different authorized human, that you cannot accept your own work, and that
    approval is not proof of external impact.
11. Keyboard and screen-reader pass: tab through the whole page. Every control is a labelled button or
    field; the navigation menu button reports `aria-expanded`; section headings receive focus when a
    section opens; each step announces its number, title and state; no dialog traps focus and Escape
    always closes one; every field says whether it is required.
12. Narrow the window to 390 px: the menu collapses to a single button, the step list becomes one
    column, and the buttons stay at 44 px. Map and text controls both remain available.
13. Delete the disposable database (`/tmp/newcomer-check.sqlite`) when finished.

## Verification

All four release gates on this worktree, Node v24.19.0:

```
$ npm run check
> nemoworld@1.0.0 check
> node --check server.js && … && node --check src/content.js && node --check src/placement-policy.js
(no output; every file parses)

$ npm test
ℹ tests 439
ℹ suites 0
ℹ pass 439
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37713.078792

$ npm run e2e
PASS  13. a newcomer registers, creates an AI resident and chooses a calling
        201 newcomer member account (no invitation); 201 AI resident 9347bf17… in the Commons;
        200 calling explorer · Wayfarers with 0 experience (policy: 5 per objective, 10 per day,
        cosmetic, not a currency); wallet 0 coins beside the fixed 10-coin policy  (50 ms)
PASS  14. the newcomer meets a country ambassador and begins the shipped practice chain
        200 GET /ambassador?id=amb-KEN (country:KEN, five registered routes, fictional-guide remit);
        200 catalogue lists the practice chain (coins_awarded=0, client_completion=false, no review
        on any step); 201 join returns next action first-sowing (crop_plant, no review), 1 enrolment,
        0 complete  (5 ms)
PASS  15. the newcomer completes one saved practice activity, reads its receipt and meets the review
        boundary
        200 travel to home:9347bf17-9198-4b86-bb4b-ed04e85bb9dc; saved crop patch at 4,7; 200 plant;
        first practice step complete from one saved crop_plant fact; one receipt
        (quest:quiet-harvest.first-sowing, 5 of 10 cosmetic experience today, available); 0 coins from
        the practice path (balance 0, no receipt, ledger valid); 400 refused client completion;
        403 refused self-review (authorized human account required); the earlier independent
        acceptance still holds its single 10-coin receipt  (171 ms)

PASS  cleanup: server stopped, process lock released, temporary workspace removed

SUMMARY  15 steps passed, 0 failed
  coins            one fixed 10-coin receipt for an independently accepted contribution; ledger
                   integrity verified
  newcomer         a member account with one AI resident, one chosen calling, one country ambassador
                   read, one saved practice activity with one cosmetic receipt (5 of 10 today) and
                   zero coins
  notes
    - POST /api/v1/agents/:id/move is not a route in this build: it answered HTTP 404 … (unchanged
      from earlier releases; the harness uses the documented POST /api/v1/move)
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ node scripts/seal-content.mjs --check
Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support
files; 42 referenced notices and assets.
```

The new test file reports its own measurements when it runs:

```
        measured contrast: body text on the page 15.28:1; body text on a panel 11.2:1; … focus ring 11.94:1
        measured targets: primary button 44px; secondary small button 44px; … password reveal (inline) 32px
```

## Changed files

- **`app.js`** — the persistence block (marked `newcomer-persistence:start`/`:end`), `attachLocalDraft`,
  `restoreRememberedFocus`, `resumePendingWork`, the requirement marker in `field()`, the optional
  draft section in `form()`, the two account forms' section names, `NEWCOMER_XP`/`NEWCOMER_COINS`,
  `newcomerSteps`, `newcomerStepsList`, `newcomerReceiptCard`, `newcomerBoundaryCard`,
  `newcomerControlsCard`, `newcomerJourneyCard`, `renderStartJourney`, `walkToTileForm`, the compact
  card on the home and Guide pages, the `start` navigation entry and icon, the `start` view, and the
  two `newcomerComplete('ambassador')` calls.
- **`nemo-theme.css`** — the guided-path styles, four contrast corrections and the target corrections.
- **`scripts/e2e-smoke.mjs`** — `gardenFarmSite()`, steps 13–15 and one summary line.
- **`tests/newcomer-journey.test.js`** — new, 10 tests.
- **`docs/handoff/task-13-newcomer-journey.md`** — new (this file).
- **`docs/NEMOWORLD.md`**, **`docs/CALLINGS.md`**, **`docs/COINS.md`**, **`docs/PEACEFUL_WORLD.md`** —
  product documentation of the flow and its boundary.
- **Not touched:** `index.html` (both dialogs already satisfied the contract), `server.js`,
  `src/**`, `docs/HANDOFF.md`, `docs/VERIFICATION.md`, and every schema file.

## What this deliberately did not do

- **No schema change, no new table, no server route.** Drafts, focus and guided progress live in
  `localStorage`, as `selected-agent` and `nemoworld-graphics` already do. Task 14 runs next on this
  base and needs a stable schema 18.
- **No redesign.** The flow reuses `card`, `heading`, `badge`, `actions`, `disclosure`, `form`,
  `field`, `metrics` and the existing palette; the home page shows one step, not six, to stay
  restrained.
- **No new content definitions and no new dependency.** The seal still reports 86 definitions; there
  is no framework, no icon library and no new asset — the navigation entry borrows the shipped
  `book-open` icon.
- **No change to calling or coin behaviour.** `src/vocations.js`, `src/quests.js`, `src/coins.js`,
  `src/guilds.js` and `src/platform.js` are untouched. The flow only reads and reports what they
  already do.
- **No invented server fact for reading a page.** Meeting an ambassador and acknowledging the review
  boundary are stored locally and described as such; they are never presented as server records.
- **No modal rewrite.** The existing native dialogs were already escapable and named, so `index.html`
  is unchanged apart from nothing at all; the contract is asserted instead of assumed.
- **No completion claim for the UI in a browser.** See the honesty note.

## Residual risks

- **The walkthrough is unexecuted.** Everything in the manual walkthrough above is a written
  expectation. A real browser could still reveal a layout problem at an unusual width, a focus order I
  did not anticipate, or a screen-reader announcement that is technically present but awkward. This is
  the largest gap in this task.
- **The cascade reader in the test is a simplification.** It matches selectors verbatim, ignores
  specificity and reads media-query declarations as if they applied. It is a good enough model for the
  corrections it guards (equal-specificity overrides in a later stylesheet), but it is not a browser's
  cascade, so a *higher-specificity* rule elsewhere could in principle win over a corrected value
  without failing the test.
- **Contrast was checked for the surfaces this flow and its neighbours use,** not for every colour in
  the application. The four failures found suggest other light-palette leftovers may exist in
  surfaces I did not reach (for example the plot and atlas legends use the same light values and were
  checked, but a full sweep of every selector was not performed).
- **Local progress is per browser, not per account.** Guided-step completion and the review
  acknowledgement live in `localStorage`, so they do not follow the operator to another device, and
  clearing site data forgets them. This is deliberate (no new table, no server fact), but it is a
  real limitation.
- **Draft restoration covers two forms.** Only the sign-in and account-creation forms opt into local
  drafts. Mission, community, guild and quest forms still rely on the server-side draft mechanism or
  on the user retyping; the same helper is available to them but was not applied, to keep the diff
  bounded.
- **`resumePendingWork()` reopens the account dialog on load** when a draft exists. That is the
  requested "pending work survives a refresh" behaviour, but a user who abandoned a registration on
  purpose will see the dialog again until the draft is cleared or submitted.
- **The 44-pixel rule is applied on coarse pointers and small screens,** not at every width. A
  wide-screen touch device is covered by `@media(pointer:coarse)`; a wide screen with a mouse keeps
  the existing 38-pixel secondary buttons, which is unchanged behaviour rather than a new risk.
- **No security claim.** Nothing here is claimed to be unhackable, and the flow grants no authority:
  it reports the existing calling, quest, coin and review rules and adds no new path to any of them.
