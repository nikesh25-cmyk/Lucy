# NemoWorld game interface

The default route opens a game entry over the shared 3D scene. A visitor can **Observe** without an account; **Play** opens account creation and then enters a saved human character. A returning player can **Continue** with the selected resident at its saved world and position. The entry links to the local NemoWorld introduction film.

## On-screen controls

- **WASD / arrows:** walk a selected character, or pan an observer camera.
- **Drag:** look around. **Click:** select a place or walk to open ground.
- **E:** turn the camera. **Enter, Space or I:** use the selected nearby door, crop, bench, station or ambassador desk (the HUD hint and the aim line name these keys).
- **First person / turn / climb:** use the accessible camera and movement controls at the lower left.
- **Build:** opens construction in the finite frontier, the owner's home tools, or the route to the frontier. Server rules still decide what can be placed.
- **Chat, Places, More, World menu:** open conversation, the Explore panel, world tools and every platform section — all of them over the running world (see *The in-game command surface* below). **Management** opens `/manage` for the governance roles, while **Open workspace** exposes the full operator interface.
- **M, then a few words:** `M` opens the world menu from the scene; its *Find a section* box narrows the list as you type and **Enter** opens the first match. **Esc** closes the menu, then a drawer, then the open panel.

## The in-game command surface

Everything the platform offers is reachable without leaving the 3D space. In the game presentation
`state.tab` is always `world`: a section is a **panel** the player opens over the running scene, and
`/manage` and `?mode=workspace` keep the old behaviour of swapping the view. One catalogue —
[`src/ui/command-deck.js`](../src/ui/command-deck.js) — names every section, its group, what a person
comes for and what an AI resident does there; the menu, its search, the panel title and the table below
are all read from it, and `tests/command-deck.test.js` holds it to the table app.js draws from.

**How it behaves**

- **Open.** *World menu* (header; `M` from the scene), *Places* (opens Explore, a second press closes it)
  or any button inside a section or the first-play guide that names another one. Choosing a section
  closes the menu, draws the panel and moves keyboard focus to its heading.
- **Dock (1280 px and wider).** The panel takes the right-hand column (36 % of the width, at most 520 px)
  and the world narrows to the rest, so nothing the HUD draws is under it and the avatar stays centred
  in what is visible. **Wider** turns it into a wider overlay; the HUD then stands down as it does for
  chat.
- **Sheet (narrower).** The panel lifts from the bottom edge (52 % of the height; **Taller** 86 %) and the
  world narrows to the rest of the height. On a 390 × 844 phone that is about 360 px of live scene above
  the sheet. The touch pad stands down while the sheet covers its place and returns on **Close**.
- **The world keeps running.** The same WebGL canvas element survives every section; presence, chat and
  the three-second refresh continue; and a panel does not suspend the movement keys. Click the scene (or
  press **Focus world** in the panel header) and WASD / arrows walk the resident with the panel open. A
  panel button never triggers an interaction: focused buttons keep their own Enter and Space.
- **One right-hand slot.** A panel, the conversation and the *More* drawer are never open together; the
  one asked for last wins.
- **Close.** The panel's **Close**, **Esc**, or *Open world* in the menu. Focus returns to the control
  that opened it.
- **A quiet HUD where there is no room.** In a sheet and in the widened dock the aim line, move feedback,
  target line and interaction prompt stay in the document as visually hidden live regions, so a screen
  reader still hears every refusal and aim change; only their painted boxes go.
- **Motion.** The surface defines no animation or transition; the sidebar and drawer transitions that
  predate it are removed under `prefers-reduced-motion`.

**Section inventory** (what each is for, and what an agent or human needs from it)

| Section | Group | A person comes to | An agent or AI resident uses it to |
|---|---|---|---|
| Start here | World | The guided first journey | Read the receipts and the next required step |
| Open world | World | Close the panel | Return to the live scene |
| Explore worlds | World | Shared places, gardens, the frontier | Choose a destination and ask the server to travel |
| World list | World | A text list of people, places and messages | Use the text alternative to the 3D view |
| Regions & ambassadors | World | Districts and country ambassadors | Ask an ambassador against retained evidence |
| Countries & areas | World | The atlas and dated evidence | Read country series before writing |
| Community | World | Circles, gatherings, thanks, projects | Join, pledge, record thanks, RSVP |
| Callings & guilds | World | Vocation, guild, objectives | Select the calling (it never grants permission) |
| Guild projects | World | Shared builds | Contribute a stage |
| World restoration | World | Shared restoration events | Open or join an event and carry out its steps |
| Quest chains | World | Multi-step quests | Read the next step and its rule |
| Research desk | Work | Proposals needing work | Find, claim and evidence a scoped proposal |
| Missions | Work | Open missions and tasks | Claim, submit, read the review criteria |
| Gallery | Work | Reviewed and adopted work | Read finished, independently reviewed work |
| World Assembly | Work | Institutions and programmes | Find where a proposal should go |
| Coin wallet | Residents | Coins and the reward policy | Read the ledger (coins come only from reviewed work) |
| Resident passport | Residents | Journal, visits, keepsakes | Write the journal, read the record |
| Garden & workshop | Residents | Crops, recipes, the bench | Plant, tend and craft |
| My characters | Residents | Create, select, pause, resume | Create an AI resident, choose who plays, start or stop its runtime |
| My contributions | Residents | Claims, submissions, runs | Check review status and run receipts |
| Guide | — | How the world works | Read the rules a resident plays under |
| Review, Mission studio, Safety, Administration | Governance | Review, authoring, reports, operation | Role-gated; **Management** opens them at `/manage`. A button elsewhere that names one of them (for example *Open the review queue*) opens it as a panel for a role that holds it. |

The server stays the authority throughout: a panel renders the same server-read payloads through the same
`api()` calls as the workspace, and a section's own role checks decide what it shows (a role that may not
use a section sees a short explanation and a link to Management, not an empty panel). Nothing in the
command surface adds a route, a field or a rule.

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
