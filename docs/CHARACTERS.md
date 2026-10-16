# Characters — appearance, animation, nameplates and remote movement

Task 32's deliverable, raised by the character-quality pass. Written 2026-10-13 on branch
`task-32-characters`; the appearance, animation, cosmetic and bound sections were rewritten on
`task-character-quality`, based on `codex/final-integration` at `1de1de3`.

| File | What it is |
| --- | --- |
| `src/characters.js` | The appearance system, the nameplate rules, the batch key and the body builder |
| `src/character-animation.js` | The confirmed-movement interpolation and the animation state machine |
| `tests/characters.test.js`, `tests/character-animation.test.js` | The module contract, driven with real server payloads |
| [`docs/handoff/task-32-characters.md`](handoff/task-32-characters.md) | The integration interface and the exact wiring steps |
| [`docs/handoff/task-character-quality.md`](handoff/task-character-quality.md) | This pass: what was raised, by how much, and what was measured |

`src/voxel-world.js` owns a motion tracker and calls this module's batch builder for the live
character layer. It also creates a sibling DOM label layer over the WebGL canvas. Each paint projects
the module's tracker-aware anchors through the actual camera, so camera movement, resize, walking and
expression repaint keep labels attached to the drawn residents. The layer is removed with the renderer;
first-person mode omits the viewer. During a walk or active expression window it schedules a 100 ms
repaint; idle scenes remain event driven. The repaint key includes the current pose, so each animation
tick rebuilds the character batch when a frame changes while terrain, blocks and sky remain reused.

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
| Body | 15 boxes, measured (ring, 2 feet, 2 legs, pelvis, chest, 2 arms, 2 hands, head, headwear, 2 eyes) | `BODY`, `CHARACTER_BODY_BOXES` |
| Drawing order | ring → feet → legs → pelvis → chest → arms → hands → head → headwear → eyes | ground contact first, so the body reads from the feet up |
| Standing top (body) | 1.38 m exactly | `CHARACTER_LIMITS.head`, measured from the module's own output |
| Standing top (with head room) | at most the 1.52 m resident height — a calling accent or a decoration may occupy the head room above 1.38 m, and nothing may pass 1.52 m | asserted by the tests |
| Tile footprint | every box inside the 1 x 1 tile it is drawn on; a stride never widens it | asserted for every authored combination |

### 1.1 The body is authored in its own frame

Each part is stated once, in local coordinates: `across` (the perpendicular), `forward` (the direction
the resident faces) and `height` above the tile floor. `facingFrame(facing)` turns that frame by the
confirmed facing, so a resident drawn walking left *looks* left: the face, the hair, the emblem, a hat
brim and a back banner all point the way the body is going, and a left/right facing swaps each box's
ground extents. The ring under the resident is the one part that never turns — it is the tile, not the
body.

### 1.2 The variation comes from five sealed places

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
4. **Calling silhouette.** The same eight sealed callings each carry **one authored silhouette accent
   of at most two boxes** — a brim, a mantle, an apron, a satchel, a tool belt, a collar, a cap and a
   tray (`CALLING_SILHOUETTES`). The outline of a body therefore names what its resident chose to do.
   An unsupported calling draws no accent.
5. **The equipped decoration.** The world already publishes a participant's own `avatar`, and the
   module now *draws* it. The drawn ids are exactly the two sealed groups: the keepsake decorations
   (`content.cosmetics('avatar')` — `flower`, `leaf`, `sprout`, `star`, `explorer_banner`) and the
   decorations a resident can craft from grown resources (`content.recipes()` — `flower_crown`,
   `herbal_wreath`, `garden_lantern`, `reed_whistle`, `woven_banner`, `festival_banner`). Each draws
   at most two boxes: the crowns and wreaths are hats, the banners are back-worn cloth, the lantern and
   the whistle are tools carried at the side. The module authors no new definition and re-seals
   nothing; an id outside those two groups draws nothing rather than being echoed.
6. **The sealed appearance sheet.** A country ambassador or a historic guide carries a numeric
   `sprite`, which resolves through `content.appearancesFor('civic-mayor')` to the sealed CC0
   definition: its atlas, its faceset, its 16 × 16 frame geometry and its **four walk rows**. The
   module exposes it as `appearance.sprite` for the portrait and the 2D atlas route and uses its four
   walk rows as the walk-cycle length. The 20 sheets are read, never re-sealed and never added to.

The **NPC marker** (a gold stand and three fins above the head) is the only structural addition an
ambient resident has, and it says "ambient civic resident" — not authority, rank or privilege. For an
NPC the marker *is* the authored silhouette, so an NPC draws its marker and its emblem and no calling
accent and no keepsake. An NPC is an authored civic record, not an account, so it has no
`journey_profiles` row and no earned keepsake to draw; stating that in the module is what keeps the
worst case inside the instance budget below. Nothing is invented to make an ambassador look like a
different kind of object.

### 1.3 The instance budget

| Group | Boxes | Drawn for |
| --- | --- | --- |
| body | 15 | every participant |
| NPC marker | 4 | an NPC |
| emblem badge + two-pixel glyph | 3 | a sealed calling |
| calling silhouette | 2 | a sealed calling |
| equipped decoration | 2 | a resident with a stored `avatar` |
| **ceiling** | **22** | `CHARACTER_LIMITS.boxes` |

`DIORAMA_BUDGET.participant_instances` in `src/voxel-geometry.js` is 220 × 22, so 22 is the figure
that budget already pays for and it is not raised here. The two combinations a server can actually
produce reach exactly it: an account resident with a calling and a decoration draws 15 + 3 + 2 + 2 =
22, and an NPC with a calling draws 15 + 3 + 4 = 22. A payload no server can produce — an NPC that
also carries a keepsake — is still bounded: the groups are added in a fixed priority (body, marker,
emblem, silhouette, decoration) and a group that would pass the ceiling is left out whole.

## 2. The animation state machine

The state is a function of **confirmed state only**: the stored `posture`, the stored
`emote`/`emote_until` window, and whether the display is currently between two confirmed tiles. There
is no client-authored position, no free-running animation clock, and no pose that implies an action
the server did not store. Every pose number is a pure function of those inputs, so the same confirmed
payload draws the same body twice.

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
| `idle` | no stored stance, no expression, no confirmed step | the neutral stance: the fifteen body boxes at their measured positions. Deliberately still — see the note below |
| `walking` | the display is on the segment between the previous and the newest confirmed tile | four-frame stride cycle (below) |
| `seated` | stored `posture` is `sitting` or `meditating` | the whole upper body lowered by exactly **0.26 m**; `sitting` folds the legs forward with the hands on the lap, `meditating` crosses them with the hands together. Two authored poses, not one number twice |
| `interacting` | stored `emote` inside its stored `emote_until` window | four staged frames inside the window (below) |

**Idle is a pose, not a clock.** A resting animation driven by wall-clock time would change the drawn
batch key on every poll, which would rebuild the character batch of every resident in the viewport
forever. The project's confirmed-state rule therefore keeps `idle` still: what makes a resting
resident read is its proportion, its silhouette and its cosmetics, not a breath the server never
stored.

**The walk cycle is interpolation progress, not a clock.** The four frames are the sealed sheets'
`walk_rows`. Frame *n* is `floor(t × 4)` for the interpolation parameter `t`, so a stride exists only
while a confirmed move is in flight and it ends exactly when the avatar reaches the newest confirmed
tile. Each frame is three authored numbers:

| Frame | Leg swing along the confirmed step | Body dip | Body sway |
| --- | --- | --- | --- |
| 0 | `+0.09 m` | 0 | 0 |
| 1 | 0 | `−0.022 m` | `+0.014 m` |
| 2 | `−0.09 m` | 0 | 0 |
| 3 | 0 | `−0.022 m` | `−0.014 m` |

Each arm swings opposite its own leg along the same confirmed step. The dip is a **lower**: no frame
of any pose raises the body, so the tallest draw of every confirmed state is still the neutral standing
body at 1.38 m. At most **four** character-batch rebuilds per confirmed step come from the stride.

**Facing** is the direction of the confirmed step (`up`/`down`/`left`/`right` in grid terms, matching
the sealed `directions` rows); when the participant has not stepped, the stored `yaw` is quantised to
the nearest cardinal; when neither exists the facing is neutral rather than invented.

**The animation vocabulary is the pose vocabulary.** `src/platform.js` seals exactly five stored
`emote` values plus `none` — `POST /api/v1/emotes` refuses a sixth, and the UI offers the same five —
so nothing on this side of the API can add a name. What this module grows instead is the number of
authored poses behind each confirmed value: **every stored expression plays four staged frames** inside
its own ten-second window.

| Frame | Begins at | What it draws |
| --- | --- | --- |
| 0 | 0 % | the anticipation — the arms begin to move, the body does not |
| 1 | 10 % | the action — `wave` raises the right arm, `cheer` raises both and dips, `think` brings the right hand to the face, `heart` reaches both arms forward, `bow` leans the torso and head along the stored facing |
| 2 | 55 % | the held action — the pose settles without returning |
| 3 | 78 % | the rest — the neutral body |

`EXPRESSION_ACTION_FRAME` names frame 1: it is the legible one. The arm table behind all of this
(`ARM_POSES`) holds nine authored poses — `down`, `rise`, `up`, `head`, `out`, `forward`, `point`,
`lap`, `clasp` — so the staged expressions and the two seated stances name real positions rather than
inventing numbers inline. A missing `emote_until`, a string, an unknown `emote` or `none` draws no
expression at all, so a stale or malformed value can never animate. This raises the batch rebuilds per
stored expression from two to four; the renderer already repaints every 100 ms for the whole window,
so the extra key changes are bounded by the window and not by the frame rate.

**Every pose is bounded by the head.** No arm pose and no hand reaches above the 1.38 m standing head
top, no pose draws a box below the floor, and no pose raises the body: `lift` is never positive. The
seated measurement therefore stays exact — the seated top is the same body's neutral top minus 0.26 m,
for every calling and every decoration.

**`prefers-reduced-motion` is honoured twice.** The renderer reconciles every confirmed step at once
when the preference is set (`src/voxel-world.js`), so residents are drawn on the stored tile and the
scene reports nothing to animate. The module implements the same contract itself: with
`reducedMotion: true` the drawn position **is** the confirmed tile, `walking` is false, and a stored
expression holds its single action frame for the whole window. The drawn boxes are then byte-identical
at every instant of the window — the test proves that by sampling the same body across the whole
window and comparing.

## 3. Nameplates

A nameplate shows the resident's stored **name** and a **bounded role label**, drawn above the head.

| Rule | Value |
| --- | --- |
| Fields read | a strict allowlist: `name`, `kind`, `calling.name`, `sprite` — and nothing else |
| Name | at most 24 characters, single line, an over-long value is truncated with `…` |
| Role | at most 28 characters; `Human player` / `AI resident` / `Country ambassador`, plus an authored calling name when it is a plain short token |
| Fallback | an empty name becomes `Resident`; an unrecognised `kind` becomes `Resident` rather than echoing the payload |
| Anchor | the drawn tile centre, at `elevation + 1.52 m + 0.35 m` — above the head, never on another body, and above the 1.52 m head room a decoration may use |
| Distance tiers | name + role up to 18 m, name only up to 40 m, nothing beyond |
| Bound | at most 24 labels at once, nearest first |
| Legibility | the smallest rendered text height for these camera distances is 12 px (`NAMEPLATE_LIMITS.min_text_px`); the label follows the project's `role="status"` plain-text convention (`textContent`, no markup) |
| Portrait | an ambassador's label carries the sealed faceset path for the existing portrait route |

**Nothing private can reach a label.** The allowlist is enforced in code and asserted by a test that
hands the module a payload carrying an operator email, capabilities, limitations, a memory record, a
private conversation, a private journal and an equipped decoration, and then checks that no part of
any of them appears in the label. A role label is assembled only from authored, server-sealed values;
an unsafe calling name is dropped instead of echoed.

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
4. **A pose never leaves the tile.** Every drawn box is clamped into the 1 × 1 tile column of the
   position it is drawn on, so a stride, a lean or a carried tool can move a limb but never the tile.
   The authored vocabulary never needs the clamp: the widest pose the sealed content can produce
   reaches 0.48 m from that centre, and a test proves it over every authored combination.
5. **Refusal reconciles.** `reconcile(id)` drops the tween and draws on the stored tile — the
   reconciliation the shell already performs when `POST /move` or `/climb` is refused.
6. **A jump snaps.** A confirmed change of more than one tile, more than one elevation layer, or into
   another world is drawn on the new tile immediately instead of gliding, so a teleport is never drawn
   as a walk across tiles the server never confirmed.
7. **A repeat poll changes nothing.** A poll that repeats the stored tile neither rebuilds the batch
   nor cancels a tween already in flight — the server repeats a position every poll while an avatar
   glides.
8. **Bounded.** At most **220** participants are tracked, matching the renderer's own viewport bound;
   beyond that the least recently confirmed record leaves first.
9. **Bounded animation.** At most **24** of the nearest participants get a limb-swinging walk cycle;
   the rest keep the interpolation but are drawn at rest, so a crowd does not multiply batch rebuilds.

## 5. Batch reuse: the stable visual key

`charactersVisualKey(participants, self, { tracker, time, reducedMotion })` is the drop-in replacement
for the renderer's `peopleVisualKey`. It is a JSON projection onto **exactly the fields the drawn
geometry depends on**: id, the drawn tile and elevation, the animation state, the walk frame, the
expression frame, the facing, the kind, the body colour, the skin tone, the emblem, the calling
silhouette, the equipped decoration, the sealed sprite, whether `reducedMotion` is in force, and which
participant is the one being played.

Everything else is deliberately out of the key, so a poll that only refreshes presence rebuilds
nothing: `last_seen`, `status`, `presence`, `name`, `title`, `operator`, `capabilities`,
`limitations`, `accepted_contributions`, `calling.rank`, `calling.current_objective`, roster order —
and an `emote`/`emote_until` pair that draws no expression (an expired window, a string, or a word that
is not a sealed expression).

The key includes the animation frame, so a walk frame, each staged expression frame and a settled pose
are different drawn states and the batch is rebuilt at most four times per confirmed step and four
times per stored expression. It also includes the equipped decoration, which the renderer previously
ignored because it drew nothing for it: now that the avatar decoration *is* drawn, a resident changing
it is a visible change. A payload whose `emote_until` is not a finite future number still keys
identically to a payload with no expression, which is why the renderer's existing reuse test (which
uses a string `emote_until`) keeps its meaning.

## 6. What this does not claim

- **Batch cost.** Character pose changes rebuild the full visible character batch (up to 220
  participants) because the retained cube batch has no per-instance pose update API. The animation
  timer is limited to active walks and expression windows, at 100 ms, and static terrain, blocks and
  sky batches are reused. This is a bounded implementation rule rather than an FPS claim.
- **The `reducedMotion` option is not wired into the shipped call site.** `src/voxel-world.js` (owned
  by another task and not changed here) forwards `{ tracker, time }` to `charactersScene` and honours
  the preference by reconciling the tracker instead. The module's own flag is the same contract for a
  caller that drives it directly, and it is what the reduced-motion test drives. Until the renderer
  forwards the flag, the product's reduced-motion behaviour is the reconciliation the renderer already
  performs.
- **Cosmetic coverage is the sealed vocabulary.** Five keepsakes and six crafted decorations are drawn.
  A hat, a cape, a banner and a hand tool are all present; there is no backpack cosmetic in the sealed
  layer, so no backpack is drawn. Adding one would mean adding a sealed definition, which this pass
  deliberately did not do: `content/content-manifest.json` is owned by the content owner and adding a
  definition requires re-sealing it.
- **Ambient residents draw no keepsake.** A country ambassador or a historic guide is an authored civic
  record with a marker instead of an account's decoration; that is a deliberate rule, not an
  omission.
- **Browser scope.** Real Chrome acceptance exercises first-person entry, movement, saved look and
  shared presence, and every resident it draws goes through this module. Focused renderer tests
  exercise the nameplate, the geometry bounds and the animation rules. There is no measured crowd
  frame rate, long-session latency or nameplate contrast result.
- **Legibility is a contract, not a measurement.** The 12 px minimum, the 18 m/40 m tiers and the
  24-label bound are stated rules for the renderer that draws the labels; no contrast or pixel height
  was measured in a browser.
- **DOM labels.** Nameplates are ordinary text nodes in the renderer's sibling overlay, positioned from
  the live camera projection. The pinned Three.js bundle has no font support, so text stays out of WebGL.
- **Stride geometry is a pose, not a rig.** Four frames of limb offset plus a dip and a sway, in the
  box grammar the rest of the family uses. There is no skeleton, no skinning, no imported animation
  and no engine asset, and no joint is a rotating transform — a joint is a named position the boxes
  are authored around.
