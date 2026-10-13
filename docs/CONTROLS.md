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
