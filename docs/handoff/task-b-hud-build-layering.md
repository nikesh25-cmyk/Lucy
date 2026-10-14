# Task B — the frontier build tools over the HUD's next-action band

`task-b-next-passage-hud.md` shipped the cue and then recorded, in its own limitations section, a
defect it was not allowed to fix: with build mode open in a frontier sector, `.game-build-host` draws
over the HUD's bottom band. This task reproduces that defect from the shipped tree, fixes it in the
stylesheet that owns the element, and pins it with a browser assertion that asks the occlusion
question directly.

- Base commit: `78491f8` (`Show the next passage a resident can walk to in the HUD (Wave B)`) on
  `integration/deepseek-master-2026-10-14`
- Files changed: `nemo-theme.css`, `scripts/browser-suite.mjs`, `tests/browser-suite.test.js`
  (scenario count 41 → 42), and this file
- Patch: `git format-patch` to `../task-b-hud-build-layering.patch` (see "How this was verified")

## The defect, reproduced before anything was changed

Everything below is measured in the real game shell in headless Chrome 155.0.8059.40, driven through
the suite's own harness (a temporary workspace and a temporary SQLite database), with a fixture
resident placed in `frontier:0:0` and build mode toggled on with the HUD's own `Build` control.
Viewport 1440 × 900; the world stage runs from y = 66 (the masthead) to y = 900.

| Element | Measured box (viewport y) | Notes |
|---|---|---|
| `.game-hud-bottom` (the band) | **705 – 882**, 177 px tall | `bottom:18px`, four children, three 8 px gaps |
| `#game-next-action` ("Discover a shared place") | 705 – 736 | `elementFromPoint` at its centre → **`INPUT`** inside `.ui-placement` |
| `#game-next-passage` ("Return to the Commons · 3 steps") | 744 – 775 | `elementFromPoint` at its centre → **`SECTION.ui-placement`** |
| `#game-control-hint` | 783 – 811 | inside the covered range |
| `.game-quickbar` | 819 – 882 | outside it |
| `#game-build-host` | **252 – 796**, 544 px tall | `bottom:104px`, `z-index:11`; `.ui-hotbar` 252–394, `.ui-placement` 400–796 |

Read as offsets from the bottom edge — the frame the previous slice used — the same host is
**104 – 648 px**, and the two lines are 164–195 px and 125–156 px. That is a 91 px overlap between the
tool host and the band, and it covers both next-action lines.

**The band's own growth was confirmed by hiding the cue line and re-measuring**: with
`#game-next-passage` hidden the band is **138 px** tall (744 – 882). So the passage line added exactly
**39 px**, taking the band from 138 px to 177 px — the numbers the previous slice reported. Because
the tool host starts at 104 px from the bottom, the objective line was already covered before the cue
existed: the band's objective pill then sat at 125–156 px from the bottom, inside 104–648.

**The report and the measurements agree, in full.** The only apparent disagreement is a frame of
reference: the reported "104–648 px" is the host expressed as offsets from the bottom edge
(`bottom:104px`, 544 px tall), not viewport coordinates (252–796). Every material claim reproduced:
the element, the anchor, the layer, the 104 px start, the 177 px band, the 39 px growth, and both
lines being covered.

At 390 × 844 the same defect is present: the band is 669–834 (165 px tall), the host 121–694, and
`elementFromPoint` at the centre of the objective line returns an `INPUT` inside the placement panel.

Before-state of the tool host at a range of stage heights. The band is bottom-anchored at 18 px and
177 px tall, so its top is always `height − 195`, and the host lay over it by the same 91 px at every
one of them:

| Viewport height | Host box (measured, before) | Band top | Overlap |
|---|---|---|---|
| 900 | 252 – 796 | 705 | 91 px |
| 768 | 178 – 664 | 573 | 91 px |
| 700 | 140 – 596 | 505 | 91 px |
| 600 | 84 – 496 | 405 | 91 px |
| 500 | 28 – 396 | 305 | 91 px |

## The fix, and why this one

`nemo-theme.css:170` (desktop) and `nemo-theme.css:207` (≤ 650 px) — the rule was at line 163 before
the explanatory comment was added:

```diff
-body.game-world .game-build-host{position:absolute;z-index:11;bottom:104px;…}
+body.game-world .game-build-host{position:absolute;z-index:11;bottom:210px;…}
-  body.game-world .game-build-host{bottom:150px;max-width:calc(100vw - 20px)}
+  body.game-world .game-build-host{bottom:203px;max-width:calc(100vw - 20px)}
```

210 px is the band's own geometry plus one gap: **18 px** (the band's bottom offset) **+ 177 px**
(the band's height) **+ 15 px** (clearance). 203 px is the same rule at phone width, where the band
sits at 10 px and measured 178 px in the full acceptance run (the control hint wraps to a second line
there), so 10 + 178 + 15.

The three candidate fixes were weighed against what the surrounding rules are actually for:

- **Raising the band** was rejected. `.game-hud` is `z-index:9` with `pointer-events:none`
  (`game-theme.css:47`): it is deliberately the *lowest* layer of the overlay ladder in this
  stylesheet — `.world-bottom` and the minimap sit at 8, the band at 9, the prompt host and reticle at
  10, the guide and the build host at 11, the overlay host and conversation at 13, the masthead and
  drawers above that. Lifting the band past 10 would put it over `.game-prompt-host`
  (`nemo-theme.css:144`, `bottom:172px`), which is the interaction prompt the HUD exists to show. The
  band takes no pointer events at all, so it cannot be made opaque to the tool without also taking
  clicks away from the world underneath.
- **Reserving space inside the band** was rejected. The band is bottom-anchored and shrink-wrapped:
  adding padding moves the whole band (including the quickbar, the one part that *does* take the
  pointer) up into the tool's box, which hides a control instead of a line.
- **Re-anchoring the tool host** is what the code supports and what the layering permits. The host
  keeps `z-index:11` and stays above the band; it simply no longer lies on it. Nothing in the ladder,
  no colour, no size and no wording changed.

The 104 px anchor is the thing that was wrong, and it is answerable: it mirrors the *workspace*
frontier hotbar's `bottom:100px` (`game-theme.css:75`), where no HUD band exists. The game shell
reuses the build interface, and the band was added under it afterwards — first 138 px, then 177 px —
each time eating into the host's space from below.

## What the fix measures after the change

| | Before | After |
|---|---|---|
| 1440 × 900 host | 252 – 796 | **146 – 690** |
| 1440 × 900 band | 705 – 882 | 705 – 882 (unchanged) |
| gap between them | −91 px (overlap) | **+15 px** |
| objective line at its own centre | `INPUT` (covered) | **the line itself** |
| passage line at its own centre | `SECTION.ui-placement` (covered) | **the line itself** |
| 390 × 844 host | 121 – 694 | **68 – 641** (at the band height of the full run, host 68–641 vs band 656–834, +15 px) |
| 390 × 844 objective / passage | `INPUT` / covered | **both the line itself** |

The band itself is untouched: no declaration that styles it was edited, so it has the same box, the
same 177 px, the same children and the same words. The tool host is
fully inside the stage at both widths (asserted), every one of its controls is on screen and is the
topmost element at its own centre (asserted), its target fields still accept a real pointer
interaction (asserted), and the band's five quickbar controls each keep their own click (asserted).

This is the minimal change that satisfies the requirement: two numbers, each of which is the measured
geometry of the element it has to clear, with the reason it was wrong written down in the stylesheet.

## The assertion, and why it is robust

New scenario **`hud-visible-while-building`** in `scripts/browser-suite.mjs`, registered between
`next-passage-cue` and `interaction-saved-world-changes`; `tests/browser-suite.test.js`'s count
assertion moves 41 → 42 (the registry's own assertion, nothing deleted or weakened). It is placed next
to `next-passage-cue` because the covered lines are that scenario's subject.

The check is **a hit test, not a z-index comparison**:

1. `#game-next-action` and `#game-next-passage` must each have a non-zero bounding box, inside the
   viewport, that is not `hidden`;
2. `document.elementFromPoint` at the centre of each box must resolve to that line or a descendant;
3. `.game-build-host`'s box must not intersect `.game-hud-bottom`'s box at all;
4. at 390 × 844 the same three checks are repeated.

One wrinkle makes the naive version of check 2 silently useless, and it is worth recording: `.game-hud`
is `pointer-events:none` **by design**, so the world keeps its drag and its clicks, and only
`.game-quickbar` inside the band takes the pointer. Hit testing therefore skips the band entirely — in
the before state, the *uncovered* passage line on the phone resolved to `CANVAS.voxel-canvas`, i.e.
`elementFromPoint` returned the world underneath rather than reporting the line. The check gives each
line its own `pointer-events:auto` **for the single measurement** and removes the inline style in a
`finally` immediately afterwards. That is the same mechanism `.game-quickbar` already relies on, it
changes no layout and no paint order, and it does not soften the test: if anything really does cover a
line, the hit test returns the covering element. That is exactly how the before state fails —
`INPUT is on top at {"top":705,…}`.

Checks 1 and 3 are the belt to the hit test's braces: a non-zero box and a clean separation of the two
boxes, so a future restyle that moves the band or the tool is caught even if the hit test would pass
by accident.

**The assertion was proved to catch the defect.** With the two anchors temporarily restored to
`bottom:104px` / `bottom:150px`, the scenario fails on its first hit test, exactly as the defect was
reported:

```
FAIL  hud-visible-while-building
        reason    the objective line must not be covered by the build tools
        expected  the topmost element at the centre of “Discover a shared place” is that line
        actual    INPUT is on top at {"top":705,"bottom":736,"left":645,"right":795,"width":149,"height":31}
```

The anchors were then restored and the same scenario passes.

## The 390 px phone case

**It holds, and it is the tightest of the three rules.** At 390 × 844 after the fix the tool host is
68 – 641 and the band 656 – 834 in the full acceptance run (669 – 834 when the control hint does not
wrap), so the gap is 15 px or 28 px and both lines hit-test to themselves. The assertion checks the
phone width explicitly rather than assuming the desktop result carries over, because the phone band is
a *different* geometry: it sits at 10 px instead of 18 px, its control hint wraps, and the palette
wraps to more rows (196 px tall instead of 142 px), so the host is 573 px tall instead of 544 px.

It is also at the edge of what 390 × 844 can hold. The tools (573 px) and a wrapped band (178 px) plus
the 15 px gap and the band's own 10 px offset fill 776 px of the 784 px stage, which is why the phone
rule has no room left to spend and the host's top lands 8 px below the masthead. That is recorded as a
residual risk below rather than hidden.

## What was deliberately not changed

- **No colour, size, spacing, font or wording.** The only declarations touched are the two `bottom`
  values. The band is unchanged in every property.
- **No z-index.** The host stays at 11 and the HUD stays at 9. The ladder is intact, so the reason the
  element is layered that way is not regressed.
- **No server file, no `app.js`, no `index.html`.** The build host's anchor is a stylesheet concern;
  the tool's own DOM, its palette and its placement panel are untouched.
- **No other build surface.** The workspace's own `.frontier-hotbar` (`bottom:100px`, `z-index:8`) is a
  different element with no HUD band beneath it; it was not moved, so the workspace build scenarios
  exercise exactly the geometry they did before.
- **No scenario deleted or weakened.** The only existing assertion that changed is the suite's
  scenario count, 41 → 42, which is the registry's own truth.
- **No new file outside this task's ownership.** `docs/specs/world-hud.md` was *not* edited: the specs
  describe the HUD, and this change adds and removes nothing from it.

## Residual risks and limits

- **The band is content-driven and the gap is not infinite.** 177 px = objective 31 + cue 31 + hint 28
  + quickbar 63 + three 8 px gaps. If a next-action line ever wraps to a second line the band grows by
  about 31 px and the 15 px desktop gap is spent: that state would re-cover roughly 16 px of the lower
  line. The scenario's fixture has short one-line text, so this state is not exercised. Fixing it
  properly means either a dynamic anchor or a fixed-height band, both of which are more than this
  defect asks for; the assertion would fail loudly if the shipped content reached that size.
- **Below about 815 px of viewport height the tool's top reaches the world reticle.** The host grows
  upward from its anchor, and its height is the palette plus a placement panel capped at `44vh`. At
  1440 × 900 its top is 146 px, five px clear of the reticle's 84–141; at 800 px it is 90 and covers
  the reticle's lower half; below about 640 px its top leaves the stage. This is a real, if minor, new
  overlap — `.world-reticle` is `pointer-events:none` informational text whose tile information is
  repeated by `.game-target` beside the band — and it is the cost of moving the host up. It does not
  affect the suite's two viewports. Verified by measurement at 1000, 900, 800, 768, 720, 660, 620 and
  600 px: the band gap is 15 px at every one of them, and the host top is 202, 146, 90, 72, 45, 12, −11
  and −22 px respectively.
- **The 390 × 844 phone has no headroom left.** See above; the host slides to 8 px below the masthead.
  A shorter phone (for example 390 × 740) would put the host's top off the stage, which is the phone
  analogue of the short-desktop case and is not covered by the suite.
- **No pixel comparison.** The check is geometry and hit testing, not image diffing; it proves the
  lines are the topmost elements at their own centres, not that they are legible against the panel.
- **The tool host is not exercised end-to-end for a real placement here.** The scenario proves the
  palette, the target fields and the confirm control are reachable and interactive where they now sit;
  the server-side building rules are the workspace build scenarios' subject
  (`shared-build-and-restart`, `plot-and-blueprints`, `character-switch-clears-preview`), which pass
  unchanged in the same run.
- **`npm test` has one clock-sensitive test on this tip** (`tests/vocations.test.js`, pre-existing and
  not owned by this task) — see "How this was verified". It fails only in the 20 minutes before UTC
  midnight.

## How this was verified

All figures are from runs on the final tree, in this worktree, with Node v24.19.0.

- **`npm run check`** — exits 0 (no output beyond the script echo).
- **`npm test`** — **881 tests, 881 pass, 0 fail** on the final tree (run after 00:00 UTC).
  Three earlier runs on this same tree reported **880 pass, 1 fail**, always the same test:
  `tests/vocations.test.js` *"cultivator credits actual planting and server-checked harvest, capped per
  objective and day"*, failing at `tests/vocations.test.js:56:147`
  (`today.objectives.every(o => o.complete)` is false, with the lifetime total already 10). That is
  **not this change's**: with this task's three changed files stashed
  (`git stash push -- nemo-theme.css scripts/browser-suite.mjs tests/browser-suite.test.js`), the same
  test failed identically on the untouched `78491f8`.

  It is a **wall-clock** sensitivity in that test, and it was isolated. `tests/helpers.js` seeds the
  fixture clock from `Date.now()` (`currentTime = Date.now()`), and this test advances it by 20 minutes
  before harvesting. When a run starts less than 20 minutes before UTC midnight the plant's receipt
  lands on the previous `earned_day` and the harvest's on the next — the `calling_receipts` trigger
  compares `substr(occurred_at,1,10)` against `earned_day` — so the lifetime total is 10 while
  `today.objectives` no longer contains both objectives. Shimmed to reproduce it deterministically
  (`Date.now` shifted so "now" is 23:55 UTC, then `node --import … --test tests/vocations.test.js`),
  the same assertion fails at the same `:56:147`. The three failing runs were all inside that window
  and every run after the boundary passes. The file is outside this task's ownership and was left
  alone.
- **`npm run e2e`** — `SUMMARY 17 steps passed, 0 failed`, `result PASS — the shipped server serves
  this scenario end to end over its own HTTP API`.
- **`npm run browser`** — **`SUMMARY 42 passed, 0 failed`** on the final tree, with
  `result PASS — the interface was driven in a real browser and the database agreed` and the teardown
  line `server stopped, process lock released: true / temporary workspace removed: true / shipped
  database untouched`. The run's own notes recorded the two measurements this task turns on:

  ```
  build tools and HUD band at 1440x900: host 146-690, band 705-882; objective “Discover a shared
    place” {top 705, bottom 736, left 645, right 795, width 149, height 31},
    passage “Return to the Commons · 3 steps” {top 744, bottom 775, left 623, right 817, width 195, height 31}
  build tools and HUD band at 390x844: host 68-641, band 656-834
  ```

  The new scenario's own step output in that run:
  `hud-visible-while-building (2513 ms)` — `host 146-690 px, band 705-882 px (177 px tall)`;
  `host ends at 690px, band starts at 705px; “Discover a shared place” and “Return to the Commons ·
  3 steps” both unobscured`; `12 build controls each inside the viewport and taking their own click;
  the tool answered a click; 5 quickbar controls still reachable; host inside 66-900`;
  `390x844: host 68-641 px, band 656-834 px, both lines readable`.
- The scenario passes in isolation as well:
  `LUCY_BROWSER_ONLY=hud-visible-while-building npm run browser` → `SUMMARY 1 passed, 0 failed`.
- The suite's guarantees held in every run: `server stopped, process lock released: true`,
  `temporary workspace removed: true`, `shipped database untouched`. The temporary-database refusal,
  the production-database refusal, teardown-on-failure and the trace behaviour are untouched.

Three full runs were made in total on this branch: one before the phone anchor was widened
(`SUMMARY 42 passed, 0 failed`) and two after. Of those two, one was clean (42/42, quoted above) and
one failed a single unrelated scenario; see the flake note.

### Flake note

One full run on the final tree reported `SUMMARY 41 passed, 1 failed`, failing `first-ten-minutes` at
`openGuideComposer`'s wait for `#world-chat-card [name="text"]` to become visible, after 40 s against
a 25 s timeout, with the machine's load average at 21. Re-run in isolation on the same tree the same
scenario passes in 15.5 s, and it passed in the other two full runs on this branch. The flake is in
the guide's asynchronous drawer handoff — not in anything this task touched: the failing wait is on
the chat composer's visibility, and neither the chat host nor the guide depends on `.game-build-host`,
its anchor, or the new scenario. The failing step is the one *after* the keyboard walk step, and the
new scenario runs 14 positions earlier and touches none of that fixture operator.
