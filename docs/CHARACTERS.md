# Characters — appearance, animation, nameplates and remote movement

Task 32's deliverable. Written 2026-10-13 on branch `task-32-characters`, based on
`verify-game-wave-a`.

| File | What it is |
| --- | --- |
| `src/characters.js` | The appearance system, the nameplate rules, the batch key and the body builder |
| `src/character-animation.js` | The confirmed-movement interpolation and the animation state machine |
| `tests/characters.test.js`, `tests/character-animation.test.js` | The module contract, driven with real server payloads |
| [`docs/handoff/task-32-characters.md`](handoff/task-32-characters.md) | The integration interface, the exact wiring steps and the honest limitations |

**The module is not wired into the game.** `src/voxel-world.js` and `src/scene/**` belong to a parallel
task and `app.js`/`index.html`/the stylesheets to the integration task, so this task delivers a module
with an explicit interface and demonstrates it with module tests. Nothing here is visible in a browser
yet, and no browser check was performed (see *What this does not claim*).

## 1. One appearance system

Every participant is drawn by **one body construction**. What changes between a human player, an AI
resident, a historic guide and a country ambassador is the participant's own sealed definition — never
the kind of object it is. An ambassador is therefore a resident with an ambassador's appearance, not a
different species of thing.

| Property | Value for every kind | Source |
| --- | --- | --- |
| Family | `resident` | `CHARACTER_FAMILY` |
| Geometry | `cube` (axis-aligned flat-shaded boxes, no texture, no mesh, no loader) | `appearance.geometry` in the sealed layer |
| Standing height | 1.52 m | `RESIDENT_HEIGHT`, `src/footprints.js` |
| Half-width | 0.38 m | `RESIDENT_CLEARANCE`, `src/footprints.js` |
| Body | 12 boxes, measured (ring, 2 legs, 2 arms, 2 hands, torso, head, headwear, 2 eyes) | `BODY`, `CHARACTER_BODY_BOXES` |
| Standing top | 1.38 m; with the NPC marker 1.515 m | measured from the module's own output |
| Tile footprint | every box inside the participant's own tile; a stride never widens it | asserted by the tests |

The variation comes from four sealed places, and from nowhere else:

1. **Body colour.** The stored `color`: a `#rrggbb` hex, or one of the seven sealed `agent_color`
   cosmetics resolved through `content.cosmetics('agent_color')`, or the project's default body colour
   `#649b8a` when the payload stores neither. A malformed value (`#123ab`, `not-a-colour`) is refused
   rather than echoed.
2. **Skin tone.** One of the four sealed `skin_tone` cosmetics, chosen deterministically from the
   resident id. The sealed order is exactly the four tones the shipped renderer hard-coded, so the
   look is unchanged and the colours now come from the content layer instead of from the renderer.
3. **Calling emblem.** One of the eight sealed callings, by `calling.id`, with the original badge and
   pixel glyph the renderer already draws. An unsupported or missing calling draws no emblem
   (`__proto__`, `administrator`, a number and an empty string are all refused).
4. **The sealed appearance sheet.** A country ambassador or a historic guide carries a numeric
   `sprite`, which resolves through `content.appearancesFor('civic-mayor')` to the sealed CC0
   definition: its atlas, its faceset, its 16 × 16 frame geometry and its **four walk rows**. The
   module exposes it as `appearance.sprite` for the portrait and the 2D atlas route and uses its four
   walk rows as the walk-cycle length. The 20 sheets are read, never re-sealed and never added to.

The **NPC marker** (a gold stand and three fins above the head) is the only structural addition an
ambient resident has, and it says "ambient civic resident" — not authority, rank or privilege. The
sealed sheets carry `color: null`, so an ambassador keeps the project's default body colour; nothing
is invented to make it look different, which is exactly the requirement that ambassadors must not look
like a different kind of object.

## 2. The animation state machine

The state is a function of **confirmed state only**: the stored `posture`, the stored
`emote`/`emote_until` window, and whether the display is currently between two confirmed tiles. There
is no client-authored position, no free-running animation clock, and no pose that implies an action
the server did not store.

```
                       stored posture ∈ {sitting, meditating}
   any state ────────────────────────────────────────────────► seated
                       else an active stored expression
                       (emote ∉ {none}, emote_until numeric and in the future)
                       else the display is between two confirmed tiles
                       else                                            interacting
                                                                       walking
                                                                       idle
```

Precedence is `seated` → `interacting` → `walking` → `idle`. A stored step rewrites `posture` to
`standing`, so a seated resident is never also drawn mid-stride.

| State | Trigger (confirmed) | Pose |
| --- | --- | --- |
| `idle` | no stored stance, no expression, no confirmed step | neutral; the twelve body boxes at their measured positions |
| `walking` | the display is on the segment between the previous and the newest confirmed tile | four-frame stride cycle (below) |
| `seated` | stored `posture` is `sitting` or `meditating` | body lowered by exactly **0.26 m** (the shipped amount), legs shortened from 0.40 m to 0.25 m |
| `interacting` | stored `emote` inside its stored `emote_until` window | two frames: the action pose for the first half of the window, the settled rest for the second |

**The walk cycle is interpolation progress, not a clock.** The four frames are the sealed sheets'
`walk_rows`. Frame *n* is `floor(t × 4)` for the interpolation parameter `t`, so a stride exists only
while a confirmed move is in flight and it ends exactly when the avatar reaches the newest confirmed
tile. The swing is `[+1, 0, −1, 0][frame] × 0.09 m` along the direction of the confirmed step, with
each arm swinging opposite its leg. At most **four** character-batch rebuilds per confirmed step come
from the stride, and at most **two** per stored expression.

**Facing** is the direction of the confirmed step (`up`/`down`/`left`/`right` in grid terms, matching
the sealed `directions` rows); when the participant has not stepped, the stored `yaw` is quantised to
the nearest cardinal; when neither exists the facing is neutral rather than invented.

**Expressions are the confirmed interaction animation.** `POST /api/v1/emotes` stores
`emote` and `emote_until = clock() + 10000` (`src/platform.js`), and the world payload publishes both.
The module draws an expression only while `emote` names one of the five sealed expressions **and**
`emote_until` is a finite number still in the future. A missing `emote_until`, a string, an unknown
`emote` or `none` draws no expression at all, so a stale or malformed value can never animate. Each of
the five has one authored pose: `wave` raises the right arm, `cheer` raises both, `think` brings the
right hand to the head, `heart` reaches both arms forward, and `bow` leans the torso and head along the
stored facing by 0.12 m.

**Every pose is bounded by the head.** No arm pose and no hand reaches above the 1.38 m standing head
top, so a raised arm can never be mistaken for a taller body and the seated measurement stays exact.

## 3. Nameplates

A nameplate shows the resident's stored **name** and a **bounded role label**, drawn above the head.

| Rule | Value |
| --- | --- |
| Fields read | a strict allowlist: `name`, `kind`, `calling.name`, `sprite` — and nothing else |
| Name | at most 24 characters, single line, an over-long value is truncated with `…` |
| Role | at most 28 characters; `Human player` / `AI resident` / `Country ambassador`, plus an authored calling name when it is a plain short token |
| Fallback | an empty name becomes `Resident`; an unrecognised `kind` becomes `Resident` rather than echoing the payload |
| Anchor | the drawn tile centre, at `elevation + 1.52 m + 0.35 m` — above the head, never on another body |
| Distance tiers | name + role up to 18 m, name only up to 40 m, nothing beyond |
| Bound | at most 24 labels at once, nearest first |
| Legibility | the smallest rendered text height for these camera distances is 12 px (`NAMEPLATE_LIMITS.min_text_px`); the label follows the project's `role="status"` plain-text convention (`textContent`, no markup) |
| Portrait | an ambassador's label carries the sealed faceset path for the existing portrait route |

**Nothing private can reach a label.** The allowlist is enforced in code and asserted by a test that
hands the module a payload carrying an operator email, capabilities, limitations, a memory record, a
private conversation and a private journal, and then checks that no part of any of them appears in the
label. A role label is assembled only from authored, server-sealed values; an unsafe calling name is
dropped instead of echoed.

## 4. Remote movement and its bounds

`createMotionTracker()` is the one place a confirmed position becomes a drawn one. Its rules are the
confirmed-position rules of task 16, restated so the renderer can use them:

1. **Confirmed only.** The first time an avatar is seen, its display *is* its confirmed tile. An avatar
   never slides in from an origin it was never at. A confirmed position must be a whole stored tile; a
   fractional or unplaced value is refused rather than tracked.
2. **Between two confirmed tiles.** When the confirmed tile changes, the avatar is drawn on the
   straight segment from where it is currently drawn to the new confirmed tile over
   `MOTION_TWEEN_MS = 180 ms` (just over the server's 120 ms step throttle) with a smoothstep ease. The
   parameter is clamped to `[0, 1]`, so the display can never pass the newest confirmed tile or
   extrapolate into one the server has not stored; at `t = 1` it *is* the confirmed tile.
3. **Never ahead of authority.** The pick a character carries is always the newest **confirmed** tile,
   even while the body is drawn mid-segment. A click, an aim or an interaction therefore can never
   address a position the server has not stored.
4. **Refusal reconciles.** `reconcile(id)` drops the tween and draws on the stored tile — the
   reconciliation the shell already performs when `POST /move` or `/climb` is refused.
5. **A jump snaps.** A confirmed change of more than one tile, more than one elevation layer, or into
   another world is drawn on the new tile immediately instead of gliding, so a teleport is never drawn
   as a walk across tiles the server never confirmed.
6. **A repeat poll changes nothing.** A poll that repeats the stored tile neither rebuilds the batch
   nor cancels a tween already in flight — the server repeats a position every poll while an avatar
   glides.
7. **Bounded.** At most **220** participants are tracked, matching the renderer's own viewport bound;
   beyond that the least recently confirmed record leaves first.
8. **Bounded animation.** At most **24** of the nearest participants get a limb-swinging walk cycle;
   the rest keep the interpolation but are drawn at rest, so a crowd does not multiply batch rebuilds.

## 5. Batch reuse: the stable visual key

`charactersVisualKey(participants, self, { tracker, time })` is the drop-in replacement for the
renderer's `peopleVisualKey`. It is a JSON projection onto **exactly the fields the drawn geometry
depends on**: id, the drawn tile and elevation, the animation state, the walk frame, the expression
frame, the facing, the kind, the body colour, the skin tone, the emblem, the sealed sprite, and which
participant is the one being played.

Everything else is deliberately out of the key, so a poll that only refreshes presence rebuilds
nothing: `last_seen`, `status`, `presence`, `name`, `title`, `avatar`, `operator`, `capabilities`,
`limitations`, `accepted_contributions`, `calling.rank`, `calling.current_objective`, roster order —
and an `emote`/`emote_until` pair that draws no expression (an expired window, a string, or a word that
is not a sealed expression).

The key includes the animation frame, so a walk frame and a settled pose are different drawn states
and the batch is rebuilt at most four times per confirmed step. This is the one place the module's key
is deliberately wider than the old `peopleVisualKey`, which ignored `emote` entirely — the module now
*draws* the expression, so it must be keyed. A payload whose `emote_until` is not a finite future
number still keys identically to a payload with no expression, which is why the renderer's existing
reuse test (which uses a string `emote_until`) keeps its meaning.

## 6. What this does not claim

- **Not wired, not visible.** No change to `src/voxel-world.js`, `src/scene/**`, `app.js`,
  `index.html`, `style.css`, `nemo-theme.css` or `src/camera-controls.js`. The module is exercised by
  module tests only.
- **No browser check, and no screenshot.** `npm run browser` cannot be used by this task: the suite's
  scenarios live in `scripts/browser-suite.mjs`, which this task does not own, and adding a scenario
  is outside its file ownership. No page was opened, no click was made, no frame was measured.
- **No FPS, latency or capacity claim.** Nothing here was run on a GPU or in a browser. The rebuild
  bounds below are arithmetic on the module's own behaviour, not measurements of a rendered scene.
- **Legibility is a contract, not a measurement.** The 12 px minimum, the 18 m/40 m tiers and the
  24-label bound are stated rules for the renderer that draws the labels; no contrast or pixel height
  was measured in a browser.
- **No texturing.** Nameplates are for the renderer's own label layer (DOM or 2D canvas). The pinned
  Three.js bundle has no image decoder and no font support, so the module deliberately does not try to
  draw text into WebGL.
- **Stride geometry is a pose, not a rig.** Four frames of limb offset, in the box grammar the rest of
  the family uses. There is no skeleton, no skinning, no imported animation and no engine asset.
