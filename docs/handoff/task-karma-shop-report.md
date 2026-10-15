# Karma Coins, the shop and the friendlier world — objective handoff

**Branch** `integration/deepseek-master-2026-10-14` in `work/integ` · **started from** `c0d09fb` ·
**tip** `cadb73d` · branch tree clean · schema **23**

This is the handoff for the objective: make the browser control system and in-game UI materially
friendlier, give every account a complimentary personal build space, and build the closed in-world
economy loop — service earns **Karma Coins** in a ledger separate from NemoCoins, and a shop spends
them. Five agents worked in parallel on disjoint files; every wiring change below was made by the
integrator, who alone owns `app.js`, `index.html`, the stylesheets, `server.js` route maps,
`src/platform.js` and the schema files.

## What is on the branch

| Commit | What it delivers |
| --- | --- |
| `84bc1f8` | The Karma Coin ledger and the shop engine, integrated: schema 23, recovery validation, platform mixins, four routes, and `tests/karma-shop-http.test.js` proving the loop over real HTTP |
| `c224d4b` | The shop in the interface: a **Karma & shop** section, the **Your space** card, hover-into-the-aim-line, camera suspension while a menu owns the screen, the floating phone bar, 44 px controls. The generated catalogue lost its furniture category, because the free palette already gives that furniture away |
| `e1d3129` | **Dead buttons fixed**: a function-form `on` was never wired by the render tree's `renderNode`, so Craft, Accept/Decline/Cancel and "Remove my block" did nothing in the game shell. Regression test proven non-vacuous |
| `cadb73d` | **Building your own space by choosing an item**, the HUD's Build action opening the palette in a garden, and `karma-closed-loop`, the browser walkthrough of the whole loop |

## The closed loop, proved in a browser

`karma-closed-loop` (46th scenario) drives Chrome against its own disposable database:

1. a brand-new operator signs up through the dialog and creates its first resident through the overlay;
2. the resident **already owns** `home:<id>` and `house:<id>`, not a land parcel, with no stewardship,
   and the server's own world payload publishes 15 buildable object kinds there;
3. the world tools drawer carries the resident into its space, and the **HUD's Build action** opens the
   object palette and the placement preview there;
4. a bench is saved through that palette and preview at a named tile; the same tile stays **one**
   object and a placement on the resident is refused **409**;
5. four saved acts settle into **8 Karma Coins** with **no NemoCoin minted**, and the recorded receipts
   name the acts they came from;
6. the cheapest good is bought through the panel's choose-then-confirm flow for exactly its price —
   one debit, two herbs granted, and the journey read offers the bought resource as a recipe ingredient;
7. a **real process restart** keeps the space, the object, the shelf, the receipts and the purchase
   byte-for-byte, and the panel states the purse again;
8. at **390 px with reduced motion**, the shop fits the viewport with no horizontal scroll, keeps a
   44 px buy control and drops its transition.

The keyboard path is exercised inside the same walkthrough (the placement target is set through the
preview's own labelled fields) and the pointer path by the palette and the confirm button.

## Gates, on a quiet machine (load 2.2–3.5)

| Command | Result |
| --- | --- |
| `npm run check` | **93 files, 0 failed** |
| `npm test` | **976 tests, 976 pass, 0 fail** |
| `npm run e2e` | **17 steps passed, 0 failed** |
| `npm run browser` | **46 scenarios, 46 passed, 0 failed** |
| `node scripts/seal-content.mjs --check` | **89 definitions**, 3 support files, 42 referenced notices and assets |

Earlier full-suite runs on this machine produced failures while unrelated tooling pushed the load to
**26–246**; every scenario that failed in any of those runs passed when re-run in isolation, and the
figures above are from the quiet run.

## Decisions worth reviewing

1. **Karma Coins are a second ledger, not a rename of NemoCoins.** NemoCoins keep their exact rule
   (10 per independently accepted real contribution, 100 per operator per UTC day, no transfer, no
   cash value, no conversion). `CREDIT_UNITS` still holds **four** units; `KARMA_POLICY` is separate
   and states 17 explicit no-value booleans.
2. **Human avatars and AI residents both earn Karma.** The bounds sit on the work — one receipt per
   saved row, two a day per service, sixty a day per operator, and the six larger services require a
   **different operator** as the counterparty.
3. **The shop stocks no furniture.** The free build palette already lets a resident place that bench
   or lantern at no cost, so charging Karma for it would sell nothing. Eight goods remain: four grown
   resources and four crafted keepsakes, both genuinely time-gated. The placement-entitlement path
   stays validated and tested for a good that is genuinely scarce.
4. **The personal space is provisioned with the account's first character.** A world is owned by a
   resident, so an account with no character has no space to own — and the interface sends a new
   account to character creation as its next step. Every resident therefore has a garden and a cottage
   from the moment it exists, confirmed by a startup backfill.

## Known limits, honestly

- The walkthrough buys a resource good; a **keepsake** costs 20 Karma Coins, which a fresh account
  cannot reach without waiting for a crop to mature (20–30 minutes) or a frontier plot, so the
  cosmetic-category purchase is not exercised in a browser.
- The garden's 200-object cap and its arrival tiles are refusals at write time, not in the payload, so
  the hotbar shows no remaining count there and cannot warn before the write.
- Clicking the ground while building places at the tile **beside** the clicked face; there is no
  one-click "place exactly here", and a solid object cannot stand on the resident's own tile.
- The `object` placement-entitlement path in `src/shop.js` is tested but unstocked, so nothing
  consumes an entitlement today.
- Nothing here was published, deployed, purchased or sent. The installed application in
  `outputs/Lucy` was never opened for writing.
