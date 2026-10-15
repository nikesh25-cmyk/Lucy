# Camera comfort — a level-and-upward orbit, wheel/pinch zoom, a hover channel, presentation-only easing

The player said the game is difficult and uncomfortable to control. This packet owns the four causes the
audit found in the camera: an orbit pinned between `0.3` and `1.22` rad (the horizon and the sky were
unreachable), no wheel or pinch zoom, aiming conflated with moving (hover existed but nothing consumed
it), and drag-only look with a presentation that snapped between values.

- **Files owned and changed:** `src/voxel-geometry.js`, `src/voxel-world.js`, `src/camera-controls.js`.
- **New files:** `tests/camera-comfort.test.js`, `docs/handoff/task-camera-comfort.md`.
- **No dependency, no schema change, no server change.** `package.json` / `package-lock.json`
  untouched. `app.js`, `index.html`, the stylesheets and `server.js` were **read, never edited**.
- **`tests/voxel-world.test.js` contradicts this packet in three assertions** (it pins the old orbit
  clamp, `0.3..1.22`) and I could not fix it — it is not one of my files. See section 2: that is the one
  decision this packet needs.

## 1. What was delivered, against the four requirements

| Requirement | Delivery |
|---|---|
| 1. A comfortable viewing range | `ORBIT_PITCH` widened from `[0.3, 1.22]` to `[-0.9, 1.4]`, so level (`0`) and upward (`< 0`) are real values. The boom stops at the resident's own footing (`ORBIT_EYE_DROP`) instead of sinking into terrain, and the aim point rises by the refused drop so a continued push keeps tilting the view up. The existing `createViewBlocker` / `cameraView` third-person boom and the first-person pitch clamp are untouched. |
| 2. Zoom | The renderer binds its own non-passive `wheel` listener on the world canvas; `wheelZoom` maps a normalised delta onto the existing 6..32 distance clamp. One clamped number drives both cameras: the orbit boom, and the first-person field of view (`fovForDistance`). `setEnabled(boolean)` gates it, and a wheel over an open panel/dialog/focused field never reaches the camera. Pinch has no entry point in `src/ui/touch-controls.js` (it implements only tap-vs-drag look), so `pinch(scale, { from })` is exposed for the shell to call — see section 5. |
| 3. A hover channel that costs nothing | `onHover` now reports the hovered tile **with its cube face and, where the renderer knows one, the named block/participant/portal**, at a bounded 75 ms rate (≈13 readings/s, at most one raycast per window), only when the reading changed, and dropped with a `null` the moment the pointer leaves the canvas. No network call exists in the module; a click still only selects and walks. |
| 4. Smoother feel without faking movement | The camera glides to the stored orbit (`approachOrbit`, ≈30 % of the remaining turn per 16.7 ms frame) instead of snapping. It is presentation only: the stored facing/distance are what the shell sent and what the server stores, no position is derived from an eased number, and no local animation invents a coordinate. See section 6. |

## 2. The one conflict: `tests/voxel-world.test.js` pins the old orbit clamp

That file is **not** in the packet's "must not break" list and **not** in its run list, and it is not one
of my five files, so I did not edit it. It nevertheless asserts the *old* clamp in three places, and
those three assertions cannot survive the widening that requirement 1 demands — the widening is exactly
"`normalizeOrbit({pitch: 0})` must stay `0`" and one of the assertions is "`normalizeOrbit({pitch: 0})`
must be `0.3`". There is no implementation that satisfies both.

I did not run that file (the packet restricts the commands I may run), so this is not a test log. It is
the three expressions the test performs, evaluated against the shipped module:

| `tests/voxel-world.test.js` | Asserts | Now yields |
|---|---|---|
| `:219` `input.drag(0, 10000); assert.equal(input.orbit.pitch, 1.22)` | `1.22` | `1.4` (= `ORBIT_PITCH.max`) |
| `:227` `input.setMode('orbit'); assert.equal(input.orbit.pitch, .3)` (arriving from first person at `-1.4`) | `.3` | `-0.9` (= `ORBIT_PITCH.min`) |
| `:349` `assert.deepEqual(normalizeOrbit({ pitch: 0, distance: 400 }), { yaw: Math.PI/4, pitch: .3, distance: 32 })` | `pitch: .3` | `pitch: 0` |

Everything else in that file is unaffected — I checked the surrounding assertions too:
`:143` `orbitCamera({x:10,y:6,z:3}).target.y` is still `3.75`, `:144` still `8.75`, `:347`/`:348` still
return distance `6` and a wrapped yaw, and every `createVoxelScene` assertion is in a code path this
packet does not touch.

**The three deliberate updates the integrator (or that file's owner) must make**, if the widening is
accepted:

```js
// :219  the steep end of the widened range
assert.equal(input.orbit.pitch, 1.4);
// :227  a facing stored below the orbit floor arrives clamped to the new floor
assert.equal(input.orbit.pitch, -0.9); assert.equal(input.orbit.yaw, .7);
// :349  level is a real orbit pitch now
assert.deepEqual(normalizeOrbit({ pitch: 0, distance: 400 }), { yaw: Math.PI / 4, pitch: 0, distance: 32 });
```

If the decision is instead "keep `[0.3, 1.22]`", requirement 1 cannot be delivered: the player's
complaint is caused by that clamp, and no presentation trick changes it honestly.

## 3. New exported functions

All of them are pure, synchronous and dependency-free, so a test asserts numbers rather than a DOM.

### `src/voxel-geometry.js`

| Export | What it answers |
|---|---|
| `ORBIT_PITCH` `{ min: -0.9, max: 1.4, default: 0.62 }` | the orbit pitch range, in one place |
| `ORBIT_DISTANCE` `{ min: 6, max: 32, default: 17 }` | the shipped boom range, unchanged, now named |
| `ORBIT_EYE_DROP` `0.45` | how far below the pivot the eye may sink (the resident's footing) |
| `clampOrbitPitch(value)` / `clampOrbitDistance(value)` | the two clamps `normalizeOrbit` uses |
| `orbitCamera(position, value)` | now also returns `look` (the aim point; equals `target` unless the boom was floored) and `floored` (the ground stopped the descent) |
| `WHEEL_TILES_PER_PIXEL` `0.04`, `WHEEL_LINE_PIXELS` `16`, `WHEEL_PAGE_PIXELS` `320` | the wheel scale |
| `normalizedWheelDelta(deltaY, deltaMode)` | a wheel delta in CSS pixels, whatever mode the wheel reports |
| `wheelZoom(distance, pixels)` | the distance a wheel asks for, always inside 6..32 |
| `pinchDistance(startDistance, scale)` | the distance a two-finger pinch asks for |
| `FOV_LIMITS` `{ min: 30, max: 68, base: 48 }`, `fovForDistance(distance)` | the first-person zoom, derived from the same distance |
| `LOOK_EASE` `{ rate: .3, period: 16.7, epsilon: .002 }`, `approach`, `easeRate`, `shortestTurn`, `approachOrbit` | presentation-only easing maths |
| `hoverKey(pick)` | the identity of a hovered target (tile, layer, kind, face, named object) |

### `src/camera-controls.js`

| Export | What it answers |
|---|---|
| `HOVER_INTERVAL_MS` `75`, `createHoverThrottle({ interval, now })` | the bounded hover rate; `claim()` is one reading, `drop()` discards one when the pointer leaves |
| `zoomSuspended({ enabled, tagName, isContentEditable, dialogOpen, menuOpen })` | whether a wheel or pinch must be inert right now |

Changed inside existing exports (no signature changes): `normalizeOrbit` (the widened clamps),
`orbitCamera` (see above), `reticleText` (its last line now reads "drag to orbit, level or up · click
open ground to walk · arrow keys or WASD walk · wheel or pinch to zoom" / "… · wheel or pinch to zoom"):
`CONTROL_HINTS` and `INTERACTION_KEY_LABEL` are byte-for-byte unchanged, so the shipped hints and the
`E`-key resolution still read as before.

## 4. Before and after

| | Before | After |
|---|---|---|
| Orbit pitch | `[0.3, 1.22]` — level and upward impossible | `[-0.9, 1.4]` — level is exactly level, upward to ≈−51°, downward to ≈+80° |
| Orbit eye vs. the pivot | eye `sin(pitch) · distance` above it | still above, but never more than `0.45` below it; below that the aim point rises instead (`floored: true`) |
| Orbit distance | `[6, 32]`, default `17` | unchanged |
| Zoom input | two buttons (`zoom(±3)`) | buttons unchanged, plus a wheel (0.04 tiles per pixel, line mode ×16, page mode ×320: one 100 px notch = 4 tiles) and `pinch(scale, { from })` |
| First-person zoom | none | the same distance narrows the field of view: 30° at distance 6 (closest) to 68° at 32 (farthest); 17 ≈ 46°; the base 48° applies in the orbit view |
| Hover | a 75 ms timestamp gate that emitted **only when the parcel changed** — a tile with no parcel never reported at all, and `pointerleave` did not emit when nothing was hovered | 75 ms bounded, emitted when the tile/face/object changed, `null` on `pointerleave`, raycast skipped entirely inside the window (≈13 raycasts/s at most) |
| Camera update | every value snapped | drag is 1:1 (direct manipulation); a stored value (`setOrbit`, `rotate`, `zoom`, `setDistance`, `pinch`, a wheel, a mode switch's pitch re-clamp) glides: ≈30 % of the remaining turn per 16.7 ms frame — 18 frames (≈300 ms) for a 0.62 rad tilt, 27 frames (≈450 ms) for 17→32 tiles; a mode switch and a drag reach for the value instead of panning |

## 5. The wiring the integrator must add in `app.js` (I did not touch it)

`voxelView = createVoxelWorld(canvas, { … })` is created once, in `paintWorld()` (`app.js:278`).

**a. The aim line (`onHover`) — the callback and the host element.** `onHover` is a constructor option,
exactly like the `onPick` already passed there. The host element is the existing `#world-reticle`
paragraph (`app.js:934`, written in `syncWorldControls` at `app.js:1102`). Add a hover state that is
*not* the picked tile, so a click keeps selecting and walking:

```js
// app.js:278, next to onPick
onHover: pick => { state.voxelHover = pick; updateReticle(); },
// state.voxelHover:null added with state.voxelSelection:null (app.js:47)
// app.js:1102's reticle block moves into one small function both callers share, so a hover costs one
// string assignment instead of a whole HUD refresh:
function updateReticle(){
  const reticle=$('#world-reticle');if(!reticle)return;
  const player=viewedAgent(),world=definition(),pick=state.voxelSelection||state.voxelHover;
  reticle.textContent=reticleText({firstPerson:Boolean(player&&state.firstPerson),facing:state.facing,position:worldPosition(),
    selection:pick,blocked:pick?!(walkable(pick,world)&&!solidSceneryAt(pick,state.world.objects||[])):null,
    fixture:state.interaction?.fixture||null});
}
// syncWorldControls() (app.js:1100) then calls updateReticle() where its inline block was.
```

`pickWorld(pick)` (`app.js:1087`) is unchanged: a click still sets `state.voxelSelection` and walks.
`onHover` never fires a request and never carries a command — a reading the shell may throw away.

**b. Zoom inert while a panel holds focus — `setEnabled(false)`.** Call it wherever the shell already
recomputes suspension, with the predicate `app.js:108` already passes as `isSuspended`:

```js
// in syncWorldControls() (app.js:1100), which paintWorld already calls
voxelView?.setEnabled(!(state.gameMenuOpen || state.gameDrawer || document.querySelector('dialog[open]') || interactionPrompt.suspendsShortcuts));
```

The renderer *also* self-guards the wheel against a focused field/button and an open `dialog`, so
`setEnabled` only has to carry what it alone knows: the game menu and the drawers. While it is off the
event is left alone, so the panel scrolls normally and the camera does not move.

**c. Pinch — the touch layer has no pinch, so the shell owns the gesture.** `src/ui/touch-controls.js`
implements only tap-vs-drag look; it exports `gestureFor`, `DRAG_THRESHOLD`, `LOOK_PER_PIXEL`,
`PITCH_PER_PIXEL` and nothing about two pointers (re-checked against the working copy at hand-off time;
that file is being edited by another agent in this tree and declared no pinch or zoom input then, so if
it grows one, wire it to `setDistance`/`pinch` below rather than adding a second zoom path). The
renderer therefore exposes `voxelView.pinch(scale, { from })` (`scale` = current span ÷ span at gesture
start, `from` = the distance at gesture start, read as `voxelView.orbit.distance`). Wire it beside
`mountTouchControls` (`app.js:3411`) — a small two-pointer handler on the same canvas, leaving the touch
layer's single-pointer look alone:

```js
const pointers = new Map(); let pinch = null;
const span = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) pinch = { span: span(), distance: voxelView?.orbit.distance ?? 17 };
}, { passive: true });
canvas.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size === 2 && pinch.span > 0) voxelView?.pinch(span() / pinch.span, { from: pinch.distance });
}, { passive: true });
for (const end of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(end, event => { pointers.delete(event.pointerId); if (pointers.size < 2) pinch = null; }, { passive: true });
```

Zoom is camera-only in both cameras: it never sends a position, and the server payloads are untouched.
Note the one rough edge: `src/ui/touch-controls.js` ignores a second finger but keeps turning the camera
on the first one, so a pinch also turns the view while both fingers are down. If that is not acceptable,
have that file's owner add the gesture (an `input.zoom` callback handed the scale, wired to
`setDistance`) instead of wiring it here — the renderer needs no change either way.

**d. Docs and the accessible label (not my files).** `docs/CONTROLS.md` needs two new rows (wheel/pinch
zoom; the orbit can look level and upward) and a note in "What the client sends" that zoom changes only
the camera. The canvas `aria-label` at `app.js:926` should mention the wheel/pinch zoom for pointer
parity (the reticle's own hint line already does). The `#world-reticle` line is the one place the new
controls are announced, and it now says "wheel or pinch to zoom" in both modes.

## 6. The presentation-only contract (stated as required)

- `state.facing` and the renderer's stored `orbit` are the only look/zoom values that exist. They are
  what `queueLook` sends to `POST /agents/:id/look`, and the server's answer is copied back verbatim.
- The glide (`view` in `createVoxelWorld`) is read **only** by `camera.fov`, `camera.position`,
  `camera.lookAt` and the existing depth-cue distance in `applyPhase`. Nothing else in the module reads
  it; `get orbit` returns the stored value, not the eased one.
- No eased number is ever compared, stored, logged or sent. The most it can do is make a drawn frame
  differ from the stored value for ≈300 ms.
- A drag bypasses the glide entirely (`settle()` before `paint()`), so direct manipulation stays 1:1.
- Where no animation frame exists, or `prefers-reduced-motion: reduce` matches, the glide is skipped and
  the stored value is applied immediately — the same numbers, one frame.
- The interpolation of *confirmed* positions between poll answers (`displayed()` in `app.js`, and
  `createMotionTracker` in `src/characters.js`) is untouched.

## 7. Commands run, with real output

```sh
cd work/integ && export PATH="$PWD/../node-bin:$PATH"
for f in src/voxel-geometry.js src/voxel-world.js src/camera-controls.js tests/camera-comfort.test.js; do node --check "$f" && echo "ok  $f"; done
ok  src/voxel-geometry.js
ok  src/voxel-world.js
ok  src/camera-controls.js
ok  tests/camera-comfort.test.js

node --test tests/camera-comfort.test.js tests/camera-controls.test.js tests/game-input.test.js tests/game-input-capture.test.js tests/content.test.js
ℹ tests 46
ℹ pass 46
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 236.552875
```

(The duration moves between runs — five agents share this tree — so the counts are what to read.)

`node --test tests/camera-comfort.test.js` alone: 7 tests, 7 pass, 0 fail. `tests/content.test.js`
passes unchanged, so `peopleScene`, the colour constants and the sealed-palette guards are intact.
`npm test`, `npm run browser` and `npm run e2e` were **not run** (the packet forbids them: five agents
share this tree). `tests/world-walk.test.js` was not run — this packet cannot reach `src/world-walk.js`,
`world.js` or any movement path; the only shared surface is `controlIntent`, whose contract is asserted
in `tests/camera-controls.test.js` (green).

The three conflicting expressions in `tests/voxel-world.test.js` (section 2) were checked by evaluating
the shipped module directly — that file itself was **not** run, per the packet's command list:

```sh
node -e "import('./src/voxel-geometry.js').then(({ createOrbitInput, normalizeOrbit, orbitCamera }) => { … })"
voxel-world.test.js:219 drag(0,10000).pitch = 1.4 (test expects 1.22)
voxel-world.test.js:227 setMode(orbit).pitch = -0.9 yaw = 0.7 (test expects pitch .3, yaw .7)
voxel-world.test.js:349 normalizeOrbit({pitch:0,distance:400}) = {"yaw":0.7853981633974483,"pitch":0,"distance":32} (test expects pitch .3)
voxel-world.test.js:343/347 unchanged: 3.75 6
line 143 target.y / 144: 3.75 8.75
```

The frame counts in section 4 come from the same kind of direct evaluation (`approachOrbit` +
`easeRate` stepped until `settled`).

## 8. Limitations (honest)

1. **No browser and no phone was driven by me.** Every claim about a rendered frame, a real wheel event,
   a real pinch, or a panel keeping its own scroll is a reading of the code, not an observation. What is
   verified is the arithmetic and the wiring: the pure functions in section 3 against their numbers, and
   source-level guards in `tests/camera-comfort.test.js` that the wheel listener is registered
   non-passive, is gated by `zoomSuspended` before anything moves, and that the hover is throttled before
   the raycast. The three places that can only be seen in a page are: the wheel over a drawer, the pinch
   on a real screen, and the glide's feel.
2. **`tests/voxel-world.test.js` would fail three assertions and I did not touch it** — section 2. I did
   not run it either, so this is a direct evaluation of its three expressions, not a test log. This is the
   decision the packet needs.
3. **`createVoxelWorld` cannot be instantiated without WebGL**, so the renderer's own paths (the glide
   loop, the wheel listener, the ease loop's teardown) are exercised by no test here. I kept them
   deliberately small: an rAF callback that settles in ≤≈30 frames, a null-`frame` fallback that applies
   the stored value at once, and a `destroy()` that cancels the pending frame and removes the wheel
   listener with the same options object it was added with.
4. **The orbit boom's ground stop is the resident's own footing, not terrain-aware collision.** The
   floor is `pivot.y − 0.45` — the tile the resident stands on — so the eye can never descend into the
   column under them. A *neighbouring* hill taller than the resident's own layer is still not tested
   against the orbit boom; that is what `createViewBlocker`/`cameraView` do for the third-person camera,
   and both are untouched and still green in `tests/game-input.test.js`.
5. **First-person zoom is a field-of-view change, not a new camera.** It is the honest reading of "zoom"
   in a camera whose eye is inside the resident's column; it changes no position. The mapping is linear
   over the distance range rather than a physically matched magnification, and the value survives a
   switch to the orbit view (the same distance then sizes the boom).
6. **Ctrl-wheel is taken by the world**, not the page, whenever the pointer is over the canvas and no
   panel holds focus. That is what makes a trackpad pinch (which browsers report as ctrl+wheel) work; a
   user who wanted browser page zoom has to move off the canvas first.
7. **The hover channel reports nothing for a finger.** Touch `pointermove` is skipped exactly as it was,
   because the touch layer owns that gesture; a tap is still a pick.
8. **`setEnabled` is a shell switch, not a rule the module can enforce.** The renderer self-guards on the
   focused element and `dialog[open]`, but a menu or a drawer is app state it cannot see, so zoom stays
   live over an open drawer until `app.js` calls `setEnabled(false)` (section 5b). No `app.js` edit was
   made or is included here.
9. **`reticleText`'s last line changed** (new wording in section 3). It is asserted by regex in
   `tests/camera-controls.test.js` and `tests/interaction-controls.test.js` and still matches; the exact
   strings in `CONTROL_HINTS` are untouched.
10. **The pinch wiring in section 5c is a suggestion I could not run.** Besides the untested-in-a-page
    caveat, it shares the canvas with the touch layer's own drag, which ignores a second finger but keeps
    turning the camera on the first — so a pinch also turns the view slightly. The renderer's side
    (`pinch`, `setDistance`, `orbit.distance`) is verified arithmetic; the gesture plumbing is the
    integrator's call.

## 9. Reproducing

```sh
cd work/integ && export PATH="$PWD/../node-bin:$PATH"
for f in src/voxel-geometry.js src/voxel-world.js src/camera-controls.js tests/camera-comfort.test.js; do node --check "$f"; done
node --test tests/camera-comfort.test.js tests/camera-controls.test.js tests/game-input.test.js tests/game-input-capture.test.js tests/content.test.js
```
