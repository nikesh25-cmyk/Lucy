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

The 3D environment is the repository's original procedural voxel renderer with a consistent day-cycle palette. The UI uses the project's existing NemoWorld fonts, mark and icons. The hero video is `assets/media/nemoworld-introduction.mp4`. The research shortlist in `docs/research/ASSET_SHORTLIST.md` remains a shortlist; external 3D packs are not silently included.

The `/` game view, `/manage` management view and compatible `/?mode=workspace` detailed view share the same account, world and API. The workspace remains available for research, accessibility and detailed controls. These routes do not create a second simulated world.
