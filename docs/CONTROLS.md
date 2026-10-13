# Controls — camera, movement, interaction and building

This is the current key map for the playable world. It covers the wired game input, first-person
and third-person cameras, movement queue, portal entry, interaction, building and shortcut suspension.

The controls are wired into the game shell. Movement requests are serialized so a burst of input keeps
only the latest pending direction, while character, session and world changes cancel stale work.
Portal actions walk the resident to an entrance, re-check the current character and world, then ask the
server to travel. A refused or stale journey never becomes a teleport.

## The key map

| Action | Keys or control | Result |
|---|---|---|
| Walk one tile | `W` `A` `S` `D`, or arrow keys | Sends one cardinal move. In first person, the direction is relative to the view. |
| Turn left or right | `Q` / `E` | Rotates the resident's facing. |
| Tilt up or down | `R` / `F` | Changes the resident's facing pitch. |
| Mouse look | Drag on the world canvas | Rotates the view; the pointer is captured during the drag. |
| Switch camera mode | `V`, or the **First person** button | Switches between first-person and third-person view. |
| Use the aimed fixture | `Enter`, `Space` or `I` | Performs the server-authorized interaction. |
| Choose a frontier block | `1`–`7` while building | Selects a block type. Placement still requires a picked face or typed coordinates. |
| Climb one authored layer | **Step-up mode**, then movement keys | Sends a server-authorized step-up request. |
| Release capture or stand down | `Escape` | Releases pointer capture or pointer lock when one is active. |
| Rotate in turn mode | **Turn mode**, then `W`/`A`/`S`/`D` | Turns instead of walking. |

`E` turns the camera. The interaction keys are `Enter`, `Space` and `I`; the HUD and target prompt use
the same wording.

## Movement feel, and the refusal recovery

The server stays authoritative: a movement control sends one cardinal direction and the client never
authors a position. What the drawn avatar does between two stored tiles is presentation only.

- **The drawn avatar glides, and never diverges.** A one-tile step is interpolated over 180 ms
  (`DISPLAY_TWEEN_MS`) along the segment from the tile the avatar was drawn at to the tile the server
  just confirmed. The eased point is clamped to that segment, so it can never pass the newest
  confirmed tile or claim a tile the server has not stored. The position readout and the aim line name
  the tile the avatar is *drawn* at, so text and picture never disagree.
- **A long jump snaps.** A confirmed change farther than one tile, or any change of world, is drawn at
  the stored tile immediately — a travel or a teleport cannot glide across the map.
- **Reduced motion snaps.** When the viewer asks for `prefers-reduced-motion: reduce`, every step is
  drawn at the stored tile at once and there is nothing left to animate.
- **A refusal is visible, readable and recoverable.** When the server refuses a step it keeps the
  stored tile and returns a blocked result, or the request itself fails. Either way the drawn avatar is
  reconciled to the stored tile at once, and one line of input feedback states the reason and where the
  player still stands, for example *"The way up is blocked by water. Restored to 10, 6 — choose another
  direction."* The line names the obstacle from the terrain and scenery the client already holds (water,
  a tree, a building, a wall, the fountain, a solid object, or the edge of the world) and the server's
  own message when a request failed. The pending direction is cleared, so the next press is a fresh
  step and play continues. An accepted step replaces the line with *"Stepped up to 10, 5."*

## Travel between connected areas

Every authored world publishes its entrances in `GET /world`'s `portals`, and the game HUD lists up to
three of them, the way back first:

- each route button names the entrance, its tile and its distance, and one press walks the resident to
  the entrance and asks the server to travel (the shipped portal journey — a refused or stale journey is
  never a teleport);
- the portal whose target is the shared Commons, or the resident's own home, is marked **the way back**
  and sorted first, so a journey is reversible in one action;
- the arrival notice names the way back, so the route home is stated, not only offered;
- on a phone the HUD has no free column, so the same routes stay in the **More** drawer's *Your place in
  the world* list, which names every entrance and the way back.

## Input feedback

One polite live region in the game HUD reports the last movement outcome: the accepted step, the
refusal and its reason, or the reconcile after a failure. It carries the same wording the movement path
produced, so it can never describe a step the server did not take, and it is a text `role="status"`
region, so the state is announced and not carried by colour or motion alone.

## Text and pointer parity

The **Walk to a tile** form plans a route through the saved world and walks it one checked step at a
time. The interaction panel can read a tile by coordinates and offers an **Approach** action when a
fixture is out of reach. Crop, recipe, posture, ambassador and portal controls remain ordinary labelled
buttons.

Portal buttons use the same journey path as a picked portal: a resident is walked to the entrance when
needed, arrival is checked, and only then is travel requested. Visitors can inspect an available world
without moving a resident.

## Camera modes

| Mode | View |
|---|---|
| `first-person` | The camera is inside the resident's column, at the stored elevation layer. |
| `third-person` | The camera follows from behind at the same height and stops before blocked or too-high columns. |

First-person is the default for play. The third-person camera cannot look over a blocking elevation or
through a solid tile. If there is no clear space behind the resident, it falls back to the resident's
own eye position. Switching modes is client-side and does not move the resident or write a position.

## Suspension rules

Gameplay shortcuts stand down when the key belongs to another control:

- focus is in an input, select, textarea, button or content-editable element;
- a dialog is open;
- `Ctrl`, `Meta` or `Alt` is held; or
- the game menu or a drawer is open.

The focused control keeps the key. Pointer look also stands down while a dialog or drawer is open.
Suspension is counted, so independent callers can resume without releasing another caller's hold.

## What the client sends

- Movement sends a direction; it does not author an `x`, `y` or `z` position.
- Looking sends the facing that the server stores for the resident.
- Interaction and building send an action or requested block; the server checks reach, ownership,
  permissions, limits, throttles and refusals.
- Portal travel is accepted only after the resident is at the entrance and the journey's identity
  checks still match.

## Verification

The shipped controls have been verified through focused unit tests and observed browser flows for
signed-in play, first-person movement and drag-look, shared frontier building, adjacent area opening,
portal travel, and restart persistence.

The movement feel is verified by `tests/presence-interpolation.test.js` (the glide, the snap on a long
jump or world change, the reduced-motion snap, and the reconcile), `tests/movement-feedback.test.js`
(step, refusal, reconcile wording and the obstacle names) and `tests/travel-affordance.test.js` (the
way back sorted first, only published portals, deterministic order). A real Chrome run of
`npm run browser` drives the shell at 1440 px and at 390 px, and with `prefers-reduced-motion`
emulated, against a temporary database.
