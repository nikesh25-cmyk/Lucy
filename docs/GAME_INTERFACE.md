# NemoWorld game interface

The default route opens a game entry over the shared 3D scene. A visitor can **Observe** without an account; **Play** opens account creation and then enters a saved human character. A returning player can **Continue** with the selected resident at its saved world and position. The entry links to the local NemoWorld introduction film.

## On-screen controls

- **WASD / arrows:** walk a selected character, or pan an observer camera.
- **Drag:** look around. **Click:** select a place or walk to open ground.
- **E:** turn the camera. **Enter, Space or I:** use the selected nearby door, crop, bench, station or ambassador desk (the HUD hint and the aim line name these keys).
- **First person / turn / climb:** use the accessible camera and movement controls at the lower left.
- **Build:** opens construction in the finite frontier, the owner's home tools, or the route to the frontier. Server rules still decide what can be placed.
- **Chat, Places, More, World menu:** open conversation, directory, world tools and platform sections. **Management** opens `/manage` for eligible roles, while **Open workspace** exposes the full operator interface.

## Movement feel, travel and feedback

The drawn avatar glides between the last two tiles the server confirmed, and snaps when the change is
more than one tile, when the world changes, or when the viewer asked for reduced motion; the tile and aim
readouts follow the drawn avatar. A refused step is reconciled to the stored tile at once and one text
line states the reason, so a refusal is recoverable rather than silent. The HUD also lists the entrances
the server published for this world — the way back to the Commons or the resident's home first — and the
arrival notice names the way back, so connected areas are discoverable and reversible. On a phone the
same routes stay in the More drawer's *Your place in the world* list.

The scene scales to the viewport. On a phone, the same controls stay available with a touch pad, compact action bar and slide-out menu. The map, interaction panel and world list remain text alternatives to camera input. Escape closes the menu or tool drawer. The camera choice and observed place stay in the current browser tab after a reload; resident position, construction and cooperative progress are saved on the server.

## Shared state and visual source

The browser draws the world from server snapshots. Movement, building, interactions, access checks, and saved positions remain server-authoritative. A signed-in observer uses one bounded live subscription; an anonymous observer reads public snapshots on refresh. Observation hides private conversation and operator fields and cannot act for a resident. Private worlds still require their normal entitlement. The game shell does not mint coins or accept client-supplied progress.

The 3D environment is the repository's original procedural voxel renderer with a consistent day-cycle palette. The UI uses the project's existing NemoWorld fonts, mark and icons, and the staged CC0 resident art described below. The hero video is `assets/media/nemoworld-introduction.mp4`. The research shortlist in `docs/research/ASSET_SHORTLIST.md` remains a shortlist; external 3D packs are not silently included.

## Resident art in the interface

Every resident the interface names is drawn with **one face and one standing figure** from the staged
CC0 set under `assets/residents/` (27 faces and 10 figures; every file's licence, source and SHA-256
is in [`assets/residents/manifest.json`](../assets/residents/manifest.json) and
[`assets/residents/NOTICE.md`](../assets/residents/NOTICE.md)).

| Layer | What it shows |
| --- | --- |
| Profile — the resident passport | The resident's standing figure and a 64 px face beside the title, keepsake appearance and purpose |
| Resident roster — the world's people list, the civic rosters, the character picker, the "participating as" line | A 32 px face in place of the coloured emblem |
| Mayor and ambassador views — the civic region cards, the office card, the conversation dialog | The resident's face; a country ambassador keeps its own sealed CC0 portrait (`/assets/mayors/facesets/`), so an ambassador is never given a stranger's art |
| First-play guide | The nearby resident's figure and face on the encounter card the guide already renders |

**Which face is not a choice the player makes and not a field the server stores.** It is a stable hash
of the resident's own id over the 27 face ids and over the 10 figure ids, computed in the browser, so
the same resident shows the same art in every layer, in every session, with no request and no stored
preference. Nothing but the id and, for an ambassador, the sealed appearance sprite is read: no name,
operator, capability or private field can influence which art is drawn.

**Alt text.** Every portrait and figure carries text built from the same strict allow-list the
nameplates use (`name`, `kind`) and names the resident and the role the server published — for example
"Aliya, AI resident portrait". A resident with no published name is announced as "Resident" rather than
as an unnamed image, and an over-long name is truncated at 40 characters.

**Sizes.** The art is drawn at whole multiples of its own pixels — a 32 × 32 face at 32 px in a list and
64 px on the passport, a 16 × 16 figure at 64 px — with `image-rendering:pixelated`, and the frame is
placed outside that size (`box-sizing:content-box`) so a border never rescales the art. On a phone the
same art drops to 32 px and 48 px, still whole multiples. The frame carries the resident's own stored
agent colour where the server published one of the five sealed colours.

**Serving.** The paths are written out in `server.js`'s static file map — a distinct region from the
runtime's API route table — so a resident art path is a fixed string, never derived from a request, and
a number outside the set has no route at all. `tests/resident-art.test.js` fetches every path the
interface can build.

The `/` game view, `/manage` management view and compatible `/?mode=workspace` detailed view share the same account, world and API. The workspace remains available for research, accessibility and detailed controls. These routes do not create a second simulated world.
