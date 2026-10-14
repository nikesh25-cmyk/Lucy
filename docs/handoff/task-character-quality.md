# Higher-quality characters in the 3D world

Branch **`task-character-quality`**, base commit **`1de1de3`** (*Merge DeepSeek master wave into
reviewed NemoWorld source*). Schema is unchanged at **23**; this pass adds no table, column,
migration, route, asset, dependency or content definition.

Deliverable: raise the fidelity of the procedurally drawn residents — better proportions and joints, a
torso and head that read at distance, a per-calling silhouette, cosmetics that are actually drawn, a
larger expression vocabulary, smoother idle/walk/sit/meditate/cheer motion with `prefers-reduced-motion`
honoured, and no pose that ever leaves the confirmed tile — **without a mesh loader** and without
re-bundling the pinned Three.js release.

## 1. Changed files

| File | What changed |
| --- | --- |
| `src/characters.js` | The body is re-proportioned to 15 authored joints, authored in the body's own frame and turned by the confirmed facing; the eight sealed callings gained a two-box silhouette accent; the sealed `avatar` cosmetic is now **drawn**; the emblem glyph is re-authored to two pixels; `characterBoxes()` is the new bounded, testable geometry entry point |
| `src/character-animation.js` | Four staged frames per stored expression (was two); a walk dip and a sway; the two seated stances are now two authored poses; `reducedMotion` added to `characterState`, `characterPose` and the batch key; `facingFrame()` and `expressionFrameAt()` exported |
| `tests/characters.test.js` | 13 tests (was 9): a 20 000-pose geometry sweep, a facing-turn test, the cosmetic vocabulary, the box budget, the expression sequence |
| `tests/character-animation.test.js` | 11 tests (was 10): the staged frames, the reduced-motion contract, the pose-function contract |
| `docs/CHARACTERS.md` | Rewritten: the new body, the cosmetic vocabulary, the animation table, the instance budget, the reduced-motion contract, and an honest limitations section |
| `docs/handoff/task-character-quality.md` | This file |

Nothing else was touched. In particular `app.js`, `server.js`, `src/platform.js`, `src/media.js`,
`src/voxel-world.js`, `src/voxel-geometry.js`, `src/footprints.js`, `src/spaces.js`, `runtime/**`,
`native/**`, `world.js`, `content/**` (including `content/content-manifest.json`), `assets/**`,
`scripts/**`, `package.json` and `outputs/Lucy` are all unchanged.

## 2. What was raised, and by how much

### 2.1 The body: 12 boxes to 15, and a frame of its own

| Before (12 boxes) | After (15 boxes) |
| --- | --- |
| ring, 2 legs, 2 arms, 2 hands, torso, head, headwear, 2 eyes | ring, **2 feet**, 2 legs, **pelvis**, chest, 2 arms, 2 hands, head, headwear, 2 eyes |

The torso is split into a narrow pelvis and a wide chest, which is what actually reads as a *body* at
camera distance rather than as a slab; feet give a ground contact; the leg is authored from its own
`bottom` so a seated stance can shorten it without floating the figure. The standing head top is
unchanged at **1.38 m** and the seated drop is unchanged at **0.26 m**, both measured from the module's
own output.

The bigger change is structural: every part is now authored **once, in the body's own frame** —
`across` (the perpendicular) and `forward` (the facing direction) — and `frameOf()` turns that frame by
the confirmed facing. Before this pass the eyes, the emblem and any hat always pointed the same world
direction no matter which way the resident was walking. A resident drawn walking left now *looks* left;
a left/right facing swaps each box's ground extents. The tile ring is the one part that never turns: it
is the tile, not the body.

### 2.2 Silhouettes: one per sealed calling

All eight sealed callings now carry an authored two-box accent: `explorer` a brim and a shoulder
strap, `builder` shoulder pads and an apron, `cultivator` a straw brim and a basket, `researcher` a
hood and a satchel, `steward` a mantle and a sash, `mediator` a shawl and a ribbon, `artisan` a cap and
a tool belt, `host` a collar and a serving tray. The outline of a resident therefore names what that
resident chose to do. An unsupported calling draws nothing.

### 2.3 Cosmetics that are actually drawn

The world already publishes each resident's equipped `avatar` (`src/spaces.js` projects
`journey_profiles.title` and `.avatar`, and `anonymousResidentFields` carries `avatar` to every
client). The renderer ignored it. It is now drawn, for **exactly** the sealed ids and no others: the
five keepsakes from `content.cosmetics('avatar')` and the six crafted decorations from
`content.recipes()`.

| Sealed id | What is drawn |
| --- | --- |
| `sprout`, `leaf`, `flower`, `star` | a head keepsake: a stem and a leaf, a blossom, a four-point star |
| `explorer_banner`, `woven_banner`, `festival_banner` | a back-worn banner: a pole and a cloth, the festival banner dressed in green |
| `flower_crown`, `herbal_wreath` | a hat: a band around the headwear plus a blossom or a leaf |
| `garden_lantern`, `reed_whistle` | a tool carried at the side: a lantern or a whistle on a wooden hook |

Skin tones (four) and body colours (seven named plus any hex) were already resolved from the content
layer; they are unchanged. An id outside the two sealed groups — `hat`, `__proto__`, a number — draws
nothing rather than being echoed. **No content definition was added or edited**: the drawn vocabulary
is derived at module load from `content.cosmetics('avatar')` and `content.recipes()`, so it cannot
drift from the sealed layer, and a test asserts the two lists are equal.

There is no backpack cosmetic in the sealed layer, so no backpack is drawn. Adding one would mean
adding a sealed definition, which requires re-sealing `content/content-manifest.json` — a file this
pass does not own.

### 2.4 The expression vocabulary

`src/platform.js` seals exactly five stored `emote` values plus `none` (`POST /api/v1/emotes` refuses a
sixth, and the in-game buttons offer the same five), so no module on this side of the API can add a
name. What this pass grew instead is the **drawn** vocabulary:

- each stored expression now plays **four staged frames** inside its own ten-second window — an
  anticipation, the action, the held action and the rest — instead of the previous two;
- the arm table behind it grew from **4 poses to 9** (`down`, `rise`, `up`, `head`, `out`, `forward`,
  `point`, `lap`, `clasp`), so the staged expressions and the two seated stances name real positions
  rather than inventing numbers inline;
- a test asserts that all five expressions play four *different* poses and reach the neutral body at
  the end of the window.

### 2.5 Smoother motion

| State | Before | After |
| --- | --- | --- |
| `walking` | 4 frames of limb swing | 4 frames of limb swing **plus** a body dip (`0 / −0.022 / 0 / −0.022 m`) and a lateral sway (`0 / +0.014 / 0 / −0.014 m`), each a function of the walk frame only |
| `seated` | `sitting` and `meditating` drew the identical pose | two authored poses: `sitting` folds the legs forward with the hands on the lap, `meditating` crosses them with the hands together |
| `interacting` | 2 frames | 4 staged frames |
| `idle` | still | still, deliberately: see below |

**Idle stays a pose, not a clock.** A resting animation driven by wall-clock time would change the
batch key on every poll and rebuild the character batch of every resident in the viewport forever. The
project's confirmed-state rule therefore keeps `idle` still; what makes a resting resident read is its
proportion, its silhouette and its cosmetics. This is stated in `docs/CHARACTERS.md` §2.

### 2.6 `prefers-reduced-motion`

Honoured twice. `src/voxel-world.js` (not changed here) already reconciles every confirmed step under
the preference, so residents are drawn on the stored tile and the scene reports nothing to animate.
This pass adds the same contract to the module itself: with `reducedMotion: true`, `characterState`
returns the **confirmed** tile as the drawn position, `walking` is false, and a stored expression holds
its single action frame for the whole window. The reduced-motion test samples the drawn boxes at four
instants across a stored window and asserts they are byte-identical.

### 2.7 Every pose stays inside its tile, and inside the instance budget

| Bound | Value | How it is enforced |
| --- | --- | --- |
| Boxes per participant | **22** | `CHARACTER_LIMITS.boxes`; the groups are added in a fixed priority (body, marker, emblem, silhouette, decoration) and a group that would pass the ceiling is left out whole |
| Ground reach from the drawn tile centre | **0.5 m** in x and z | `characterBoxes()` filters every box through `insideTile()` |
| Standing *body* top | **1.38 m** | no pose raises the body: `lift` is never positive |
| Head room | **1.52 m** (`RESIDENT_HEIGHT`) | a calling accent or a decoration may occupy it; nothing passes it |
| Floor | **0 m** | every box is at or above it |

`DIORAMA_BUDGET.participant_instances` in `src/voxel-geometry.js` is 220 × 22, so 22 is the figure that
budget already pays for and it is **not raised here**. The two combinations a server can actually
produce reach exactly it: an account resident with a calling and a decoration draws 15 + 3 + 2 + 2 =
22, and an NPC with a calling draws 15 + 3 + 4 = 22. The 20 000-pose sweep measures the widest authored
pose at **0.48 m** from the tile centre and the tallest at **1.515 m**, so the clamp never actually
fires.

The bound arithmetic, in one line: `CHARACTER_BODY_BOXES (15) + emblem (3) + silhouette (2) +
decoration (2) + marker (4, NPC only)`.

## 3. What was tested

### 3.1 `tests/characters.test.js` — 13 tests, all pass

| Test | What it asserts |
| --- | --- |
| one appearance system | real fixture payloads: one family, one geometry, one 1.52 m height, 15 body boxes, 3 emblem boxes, 2 silhouette boxes, 2 decoration boxes, a 1.515 m NPC marker, a 1.38 m standing head |
| the drawn body is authored in its own frame | the body turns with the confirmed facing: up is a point reflection of down, right is a quarter turn of it, the ring never turns, and every facing stays inside the tile |
| the appearance layer reads the sealed definitions | 20 appearance sheets, 7 agent colours, 4 skin tones, 8 emblems with 8 tints, one silhouette per sealed calling, the drawn decoration list **equals** the sealed keepsakes plus the crafted outputs, unknown values refused |
| every authored combination stays inside its own tile | **20 412 drawn poses** over kind × calling × decoration × stance × expression × frame: ≤ 22 boxes, ≥ 15 boxes, every box inside the tile, above the floor, under 1.52 m |
| no pose draws a body taller than its own head | every expression frame, both seated stances and all 181 walk instants: the top never exceeds the neutral standing body and the floor is never crossed; sitting/meditating are different poses; a profile or presence change is *not* a pose change |
| every sealed expression renders its whole staged sequence | all five expressions play four different poses, end at the neutral body, and draw no expression outside their stored window |
| nameplates are bounded, readable | unchanged rules, still asserted |
| a nameplate never leaks a field outside the public allowlist | unchanged, plus an equipped decoration in the payload |
| the visual key tracks every drawn field | the equipped decoration and `reducedMotion` are now visible fields; a profile or presence change still rebuilds nothing |
| a single body is a drop-in for the renderer scene builder | the 220-participant bound, the pick on the confirmed tile, the 22-box ceiling |
| the drawn body resolves through a real Three.js raycaster | unchanged |
| a seated stance lowers the body by exactly the shipped amount | 0.26 m for both stances, every arm pose is bounded below the head, above the floor and inside the tile |
| the sealed expression vocabulary | exactly the five sealed names, plus every staged pose is a real authored arm pose |

### 3.2 `tests/character-animation.test.js` — 11 tests, all pass

The five confirmed-position rules are unchanged and still asserted (first sight, glide between two
confirmed tiles, refuse/reconcile, jump snaps, repeat poll). Added:

| Test | What it asserts |
| --- | --- |
| an expression plays four staged frames | the authored frame boundaries `[0, 0.1, 0.55, 0.78]` are the only boundaries, `none` and malformed windows draw nothing |
| **reduced motion snaps** | the drawn position **is** the confirmed tile mid-tween; the walk is at rest; the four sampled poses of a stored cheer are identical; the drawn boxes are byte-identical at four instants; the seated drop is still exactly 0.26 m |
| every pose is a bounded function of the confirmed state | every staged frame is finite and bounded, every staged pose names a real arm pose, all five expressions play four different poses, `lift` is never positive, and the walk dip/sway/swing are functions of the walk frame |
| the facing is the confirmed step, else the stored yaw | plus the body frame is a rotation: unit axes, perpendicular, and a quarter turn swaps them |
| a real confirmed move, a real refusal and a real stored expression | a real Platform fixture: a real server step, a real 429 refusal, a real stored cheer read at its anticipation and its action frame, and a real stored seated stance |

### 3.3 Gates, real output

| Gate | Command | Result |
| --- | --- | --- |
| syntax | `npm run check` | `checked 92 files, 0 failed` — exit 0 |
| unit + integration | `npm test` | `tests 994 · pass 993 · fail 1` — the single failure is `tests/realtime-latency.test.js` ("every fixture client must be subscribed", 1 !== 16) |
| unit + integration, failing test focused | `node --test tests/realtime-latency.test.js` | `pass 1 · fail 0`; measured `{"connections":16,"moves":20,"elapsed_ms":1784,"latency_ms":{"min":0,"median":1,"p95":4,"max":5}}` |
| release acceptance | `npm run e2e` | `SUMMARY 20 steps passed, 0 failed` — exit 0 |
| real Chrome acceptance | `npm run browser` | `SUMMARY 39 passed, 6 failed` (45 scenarios) |

**The `realtime-latency` failure is a load flake, and both results are reported.**
`tests/realtime-latency.test.js` opens 16 Server-Sent Events subscriptions on the loopback fixture and
requires every one of them to be subscribed before its first frame. It succeeded on its own in 5.7 s.
The full-suite run that day was executing under `load average 49.01 / 45.51 / 76.96` with four other
agents on the same machine. The test touches neither `src/characters.js` nor
`src/character-animation.js`; it is reported rather than explained away.

### 3.4 The real `npm run browser` run, scenario by scenario

An earlier attempt at this gate was aborted mid-edit against a tree carrying a duplicate `const`
declaration, and its log is discarded; the run reported here is against the committed tree. The suite
run was made under `load average 49 / 46 / 77`.

**39 scenarios passed on the first pass:**

`hero-introduction-film` (8 647 ms) · `game-entry-and-observation` (5 065 ms) ·
`accounts-and-switching` (9 832 ms) · `world-sound-controls` (8 864 ms) · `signed-in-game-play`
(4 580 ms) · `credential-exclusion` (3 545 ms) · `private-draft-isolation` (8 674 ms) ·
`refresh-and-focus-restoration` (3 302 ms) · `first-person-controls` (4 294 ms) · `movement-latency`
(12 257 ms) · `country-ambassadors` (1 334 ms) · `plot-and-blueprints` (19 542 ms) ·
`character-switch-clears-preview` (5 427 ms) · `quest-progression` (27 638 ms) · `guild-cooperation`
(7 022 ms) · `reward-refusals` (9 689 ms) · `forged-coin-receipt-refused` (3 666 ms) ·
`resident-run-resume-refusal` (8 227 ms) · `shared-presence-two-clients` (24 832 ms) ·
`subscription-entitlement-and-revocation` (17 201 ms) · `interaction-hint-and-distance` (9 120 ms) ·
`game-hud-interaction-prompt-and-aim` (14 746 ms) · `next-passage-cue` (22 842 ms) ·
`hud-visible-while-building` (6 353 ms) · `interaction-saved-world-changes` (54 711 ms) ·
`interaction-door-and-crafting` (11 616 ms) · `interaction-ambassador-desk` (28 536 ms) ·
`interaction-state-refusals` (10 267 ms) · `consolidated-proposal-history` (2 444 ms) ·
`shared-build-and-restart` (33 215 ms) · `wave-b-two-gates` (251 178 ms) ·
`cooperative-restoration-two-operators` (38 164 ms) · `reviewer-workbench` (13 113 ms) ·
`review-states-and-refusals` (5 716 ms) · `mission-quality-advisory-signals` (31 745 ms) ·
`game-shell-entry-and-continue` (33 667 ms) · `selection-does-not-clobber-navigation` (9 802 ms) ·
`management-interface-and-roles` (18 048 ms) · `private-memory-and-journal-boundaries` (11 523 ms)

The scenarios that draw residents — `game-entry-and-observation`, `signed-in-game-play`,
`first-person-controls`, `movement-latency`, `shared-presence-two-clients`,
`shared-build-and-restart`, `wave-b-two-gates`, `cooperative-restoration-two-operators`,
`live-observation-readonly`, `game-shell-entry-and-continue`, `phone-conversation` — all exercise the
live character layer: every resident they draw goes through `charactersScene` in this module, at the
new 15-box proportions, in the turned frame, through the new batch key. Six of them assert the
resident's stored tile and the world payload beside the browser, and one (`phone-conversation`) asserts
that the shipped reduced-motion path still behaves on a phone viewport.

**6 scenarios failed on the first pass, and all 6 passed when re-run focused:**

| Scenario | First-pass reason | Focused re-run |
| --- | --- | --- |
| `live-observation-readonly` | `private conversation must not enter the observer view model` | **PASS** (33 244 ms) |
| `first-ten-minutes` | `page.reload: Timeout 25000ms exceeded` | **PASS** (93 502 ms) |
| `first-play-solo-ambassador` | `page.goto: Timeout 25000ms exceeded` | **PASS** (34 026 ms) |
| `restoration-two-clients` | `page.goto: Target page, context or browser has been closed` | **PASS** (75 488 ms) |
| `phone-conversation` | `page.goto: Target page, context or browser has been closed` | **PASS** (9 248 ms) |
| `signout-privacy` | `page.goto: Target page, context or browser has been closed` | **PASS** (45 138 ms) |

Five of the six are browser navigation timeouts or a browser-process closure with no code path in
common other than running under extreme load. The sixth, `live-observation-readonly`, is a privacy
assertion about which *messages* an observer's view model carries — a rule implemented in `app.js` and
`src/spaces.js`, neither of which this pass touches — and it passed unchanged and unfocused in 33 s on
its own. The focused command was
`LUCY_BROWSER_ONLY=… npm run browser`, reported as `SUMMARY 5 passed, 0 failed` and `SUMMARY 1 passed,
0 failed` respectively. Nothing was skipped, no timeout was raised and no limit was loosened.

## 4. Residual limits

1. **`reducedMotion` is not wired into the shipped call site.** `src/voxel-world.js` is owned by
   another task and was not changed: it forwards `{ tracker, time }` to `charactersScene` and honours
   the preference by reconciling the tracker instead. The module's own flag is the same contract for a
   caller that drives it directly, and it is what the reduced-motion test drives. **Until the renderer
   forwards the flag, the product's reduced-motion behaviour is the reconciliation the renderer
   already performs** — which is correct, but is not the module's own snap.
2. **Idle is still, by design.** No resting animation exists, because a wall-clock-driven pose would
   invalidate the batch key on every poll. This is a deliberate confirmed-state rule, not an omission.
3. **Four staged frames per expression raise the batch rebuilds per stored expression from two to
   four.** The renderer already repaints every 100 ms for the whole ten-second window, so the extra
   key changes are bounded by the window rather than by the frame rate, but the previously documented
   "at most two" is now "at most four" and `docs/CHARACTERS.md` says so. No test or budget was
   loosened to accommodate it.
4. **No new cosmetic.** There is no backpack in the sealed layer; adding one would require a new
   sealed definition and a re-seal of `content/content-manifest.json`, which this pass does not own.
5. **The decoration is per-resident, not per-role.** Every resident with a `journey_profiles` row draws
   its stored `avatar`; a resident with no row draws none, which is the server's own behaviour.
6. **Ambient residents draw no keepsake.** An NPC draws its marker and its emblem instead of a calling
   accent and a decoration. That is the documented rule that keeps the worst case at 22 boxes, and it
   is a deliberate choice rather than an omission.
7. **Still no measured crowd frame rate, long-session latency or nameplate contrast result.** The
   bounds here are contracts asserted by tests, not measurements taken from a browser.
8. **A joint is a named position, not a rotating transform.** The boxes stay axis-aligned and the walk
   is four authored limb offsets; there is no skeleton or skinning, and this pass did not add one.

## 5. Migration and rollback

**No migration.** The change is confined to two ES modules that the renderer imports, their two test
files and one document. No table, column, index, trigger, view, route, content definition, asset or
dependency was added, removed or altered, so no data migration, backup, restore or recovery step is
required and schema 23 is untouched.

**Rollback** is `git revert <commit>` (or checking out `1de1de3`): the two modules and their tests
return to the Task 32 implementation, the renderer's imports keep resolving, and the drawn residents
return to 12 boxes. Nothing persisted depends on the new geometry, so no operator action follows a
rollback — the next page load simply draws the previous bodies. The one asymmetry: a client and a
server running different revisions still agree on positions, picks and the world payload, because none
of that changed.
