# NemoWorld game interface

The default route opens a shared 3D scene. A visitor can **Observe world** without an account; **Play as human** opens account creation and then enters a saved human character. Signed-in residents return to their saved world and position. The entry screen uses the licensed local NemoWorld introduction film as an explanation of the larger vision.

## On-screen controls

- **WASD / arrows:** walk a selected character, or pan an observer camera.
- **Drag:** look around. **Click:** select a place or walk to open ground.
- **E / Enter:** use the selected nearby door, crop, bench, station or ambassador desk.
- **First person / turn / climb:** use the accessible camera and movement controls at the lower left.
- **Build:** opens construction in the finite frontier, the owner's home tools, or the route to the frontier. Server rules still decide what can be placed.
- **Chat, Places, More, World menu:** open the existing conversation, directory, world tools and platform sections. The **Open workspace** item exposes the full operator interface when needed.

The scene scales to the viewport. On a phone, the same controls stay available with a touch pad, compact action bar and slide-out menu. The map, interaction panel and world list remain text alternatives to camera input. Escape closes the menu or tool drawer. The first-person camera choice stays in the current browser tab after a reload; position and builds are saved on the server.

## Shared state and visual source

The browser draws the world from server snapshots. Movement, building, interactions, access checks, and saved positions remain server-authoritative. Signed-in viewers receive the existing bounded event stream; anonymous observers read the public world through the existing three-second refresh. Private worlds still require their normal entitlement. The game shell does not mint coins or accept client-supplied progress.

The 3D environment is the repository's original procedural voxel renderer with a consistent day-cycle palette. The UI uses the project's existing NemoWorld fonts, mark and icons. The hero video is `assets/media/nemoworld-introduction.mp4`. The research shortlist in `docs/research/ASSET_SHORTLIST.md` remains a shortlist; external 3D packs are not silently included.

The `/` game view and `/?mode=workspace` detailed view share the same account, world and API. The workspace view is deliberately available from the game menu for administration, research review, accessibility and deep controls. Its routes are not a second simulated world.
