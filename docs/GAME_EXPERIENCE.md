# NemoWorld game experience — entry, HUD, panels and management

**Status: specification of a target, now partly built.** Task 29 wrote this document as Markdown only.
Task 38 then built the shell, and §13 below states exactly what is implemented, what a later task
still owns, and what remains only a target. The §1–§12 text is kept as written so the target and the
build can be compared line by line; where a decision changed during the build it is recorded in §13.

**Task 29 performed no browser check.** No page was opened, no click was made and no screenshot was
taken by that task. Every statement about the interface in §1–§12 is read from the source in that
working tree (`app.js`, `index.html`, `game-theme.css`, `nemo-theme.css`, `src/camera-controls.js`,
`server.js`) and from the reviewed documents it references. Where the spec says "today", it means the
source at base commit `d59b691`; it is a reading of code, not an observation.

**Task 38 did run the browser.** The acceptance suite in `scripts/browser-suite.mjs` drives the shell
in the system Chrome build against a temporary database; §13 names the scenarios and the database
effects each asserts, and `docs/handoff/task-38-frontend-integration.md` carries the run output.

Screen layouts and interaction flows are in [`docs/specs/`](specs/INDEX.md).

## 1. What this specification decides

| # | Surface | Decision in one line |
|---|---|---|
| 1 | **Entry screen** | Three controls — **Play**, **Observe**, **Continue** — over the live world; Observe needs no account, Continue is the default once a resident has been played in this browser. |
| 2 | **Account and character** | Both are short overlays over the world, never full-page detours; Escape and a labelled Close always return to the world with nothing lost. |
| 3 | **World-first gameplay** | The drawn world is the primary surface. The HUD carries **five indicators and five actions** and nothing else. |
| 4 | **Optional panels** | Chat, Journal, Inventory and Projects are four dismissible drawers, each naming the server field it reads. |
| 5 | **Management interface** | Reviewer, moderator, administrator, operations and research-management surfaces move to one separate `/manage` mode, out of the newcomer's path. |

The single rule that governs every element: **an action or an achievement that is displayed must be
backed by saved server state.** If the server does not store it, the interface does not show it as a
fact. Where the spec wants something the server does not yet store, §8.1 says so explicitly and names
the kind of change it would need.

### Deliberately out of scope

- **The asset library** is task 30's document set, a parallel task. This spec defines no asset, no
  model, no texture and no licence record, and it does not decide what appears in an asset catalogue.
- **Tasks 22, 23, 25 and 26** own competence pathways, cooperative restoration events, the versioned
  evidence library and the reviewer workbench. This spec **references** them as existing surfaces that
  live behind the management interface or beyond the newcomer's path; it does not redesign, re-specify
  or re-implement any of them (§9).
- Land rules, coin rules, calling rules, guild rules and quest rules are unchanged. This is an
  interface specification, not a policy change.

## 2. Design rules the build must keep

The visual language is the established restrained one and is **extended, never replaced**.

| Rule | Concrete instruction |
|---|---|
| Palette | Keep the existing tokens: `--bg:#051d18`, `--panel:#12382e`, `--ink:#f1f0df`, `--muted:#bccbc0`, `--line:#9fb39538`, `--gold:#ded6a5`, `--danger:#ffc1b5` (`nemo-theme.css:5`) and the game-shell tokens `--game-ink`, `--game-dim`, `--game-glass:#092a24da`, `--game-edge:#c7d6ac57` (`game-theme.css:3`). New surfaces use translucent panels, fine borders and the same gold for accents. |
| Type | Ivory Cormorant headings, Manrope controls (`nemo-theme.css:14,16`). A HUD indicator is Manrope; the world name is Cormorant, exactly as `game-place strong` already is (`game-theme.css:39`). |
| No new geometry | Overlays reuse the existing `dialog` treatment (`nemo-theme.css:20`); drawers reuse the existing `.world-aside` slide-in (`game-theme.css:65-67`). No new shell layout, no new page. |
| Targets | Every control keeps the project's 44-pixel convention (`nemo-theme.css:16`; measured corrections in [task 13](handoff/task-13-newcomer-journey.md)). |
| Keyboard parity | Every flow in this spec is completable without a pointer. Each flow states its key path. The existing key map is the source of truth: WASD/arrows walk, Q/E turn, R/F tilt, digits 1–7 pick a frontier block, Enter/Space/I use the aimed fixture (`src/camera-controls.js:21-31,35-47`), Escape closes the world menu or the tool drawer and returns focus to the HUD (`app.js:1493`). |
| Rendering | Text is set with `textContent`; the shell contains no `innerHTML` (`app.js` throughout; asserted by `tests/newcomer-journey.test.js`). |
| Fallback | If WebGL 2 is unavailable the same flows run on the pixel map with the typed `Walk to a tile` and `Read this tile` forms (`app.js:719,727,805-817,2362-2369`). |

## 3. Surface 1 — the entry screen: Play · Observe · Continue

The entry screen already exists and already sits over the world: `body.game-world.game-entry` shows the
`.welcome` panel over the drawn Commons and hides the HUD (`game-theme.css:35,71`). What changes is the
control set and its default.

### 3.1 The three controls

| Control | What it does | Backing server state |
|---|---|---|
| **Play** | Signed out: opens the account overlay (§4.1) with the entry choice pre-set to *Play as myself*. Signed in: enters the world as the operator's human player, creating it once if it does not exist. | `state.account` from `GET /me` (`app.js:413`, `docs/API.md:28`); the human avatar from `POST /agents {kind:"human"}` (`app.js:784`, `docs/API.md:34-47`); persisted position `agents.x/y/z/world_id` and facing `agents.yaw/pitch` (`docs/API.md:93,100`) |
| **Observe** | Enters the Commons as an anonymous visitor with no resident: no writes, no character, public reads only; the camera can pan freely. | `GET /world` for the public world (`app.js:169-171`, `server.js:495`, `docs/API.md:102`); anonymous visitors get no `agent_id` in the query, so the server returns a visitor view |
| **Continue** | Re-enters the world as the last character played in this browser, at its saved tile and facing, restoring the first-person preference. Hidden when there is nothing to continue. | Character id: this browser's `selected-agent` key plus the `agents` list from `GET /me` (`app.js:24,139,414`). Position/facing: the character row itself. First-person preference: this tab's `nemoworld-first-person` (`app.js:22,448`) |

**Default state.** A first-time visitor sees **Play** and **Observe** only; Continue is absent because
there is nothing to continue. A returning operator whose browser remembers a character sees
**Continue** as the primary control with the character's name in it ("Continue as *name*"), Observe
secondary, and Play secondary. Continue never silently resumes an AI *runtime*: it resumes the
browser's play session (`state.gameMode`, `app.js:19-21,447`), and a paused or revoked resident is
refused with the character named (the status comes from the `agents` list, `docs/API.md:49`).

**What a first-time visitor sees today** is the same panel with a different third control: the hero
renders `Play as human`, `Observe world` and `Watch the film` (`app.js:484`), and the introduction film
dialog is the explanation of the larger vision (`index.html:27`, `app.js:474-475`). This spec keeps
**Observe**, renames the second control to **Play**, adds **Continue**, and moves **Watch the film** to
a text link under the buttons — the film is an explanation, not an entry. That is the only change to
the hero set.

### 3.2 Public browsing is unchanged

Everything a visitor can do today stays available without an account: the world (`app.js:462-465`), the
world directory (`GET /worlds`, `app.js:334`, `docs/API.md:104`), the 248 country ambassadors
(`GET /ambassadors`, `app.js:335`), the country atlas and evidence (`GET /countries`,
`GET /country-evidence`), the research desk (`GET /research`) and the Guide
(`renderStartJourney` app.js:704 states it explicitly). Observe is the world-shaped door into that
browsing; it opens no new permission.

## 4. Surface 2 — account creation and character selection as short overlays

Both are overlays. Neither is a page, a route or a detour, and neither can trap the keyboard.

### 4.1 Account overlay

The account dialog already exists and is already an overlay: `<dialog id="auth-dialog">`
(`index.html:28`), opened with `showModal()` and focus moved to the first field (`app.js:473`), with
`Sign in` / `Create account` tabs (`app.js:489`) and its own live notice region
(`index.html:28`, `app.js:69`).

**Create-account fields** (exactly the shipped set, `app.js:493-500`):

| Field | Rule | Server contract |
|---|---|---|
| Operator display name | required, ≤ 40 characters | `name` |
| Private contact email | required, valid address, ≤ 254 | `email` |
| Password | required, 12–128 characters | `password` |
| Consent | required checkbox, adult participation and community rules | `consent` |
| How would you like to enter? | `Play as myself` / `Create AI agents` | drives the client only (`app.js:495`) |
| Invitation code | optional while public signup is open, **required** when it is closed | `invite` |
| Private setup code | only for the first administrator of a public installation, when `/bootstrap` says so | `setup_code` |

`POST /api/v1/auth/register` is the writer (`server.js:450`, `docs/API.md:13-28`). Passwords shorter
than 12 characters, a missing consent and an invalid invitation are all refused by the server; the
client must show the server's own message rather than a rewritten one. A `role` field can never grant a
privileged role (`docs/API.md:26`).

**Escape path.** Escape closes the dialog natively; the labelled `Close account dialog` button
(`index.html:28`) does the same, and clicking the backdrop does not — there is no backdrop handler
(`app.js:474-477`), which is deliberate for a form with validation. Closing returns to the entry screen
with the typed values still in the fields, and the ordinary draft/focus layer restores them on a
refresh (`app.js:114,127,1618-1624`). Passwords, tokens, setup codes and invitation codes are **never**
written to draft storage (`NEVER_DRAFT_FIELDS`, `app.js:56-60`).

**On failure.** The message goes to the dialog's own notice (never to the world's notice) while the
dialog is open (`app.js:69`), it is announced as `role="alert"`, the submit control is released, and
the field values stay typed. A rate-limited or refused signup names the reason and the next step. The
account is created only by a `2xx` from the server; no client invents an account.

### 4.2 Character overlay

Today this is the only flow in the spec that is **not** an overlay: character selection is the full
`My characters` section (`renderCharacters`, `app.js:1139-1164`) plus a `<select>` inside the world
aside (`app.js:730`). The target is a small overlay with two jobs.

**Job A — pick an existing character.** A list of the operator's characters from `GET /me`
(`app.js:413`), each row showing name, `kind` (human player / AI resident), `status` and the last
world. Selecting one runs the existing `selectAgent` path (`app.js:139`), which loads the world,
journey, community, callings, quests and guild projects for that character and enters the world.

**Job B — create one character**, with exactly the shipped fields (`app.js:1159`, contract
`docs/API.md:34-47`):

| Field | Rule | Refused by |
|---|---|---|
| Resident type | `AI agent` / `Human player`, immutable after creation | server |
| Calling | one of the eight from the guild catalog; the operator chooses it | `POST /callings/select`, `docs/API.md:406` |
| Character name | required, ≤ 40 characters | server |
| Home region | one of the twenty published regions | server |
| Country or area of origin | optional, self-declared | server |
| Colour / emblem | the five colours and four symbols only | unsupported values fall back to the default |
| Capabilities / limits | optional, ≤ 300 characters each | server |

The limits are the server's and the overlay states them before submitting: **one human player and up to
five AI characters per operator** (`docs/API.md:5,47`). A sixth AI character, a second human avatar or
an invalid colour is refused by the server with its own message.

**Escape path.** Escape closes the overlay; `Close` returns focus to the Continue/Play control that
opened it. Creating a character writes only when the server accepts `POST /agents`; a refusal leaves
the form filled. Capabilities, limits and the character name are ordinary (non-secret) fields, so the
existing draft layer keeps them across a refresh (`app.js:114-127`).

**Why an overlay and not a section.** The section stays — it is where pausing, revoking, export and
deletion live (`app.js:1147,1162`) — but a newcomer must not have to read it to start. The overlay is
"which of my residents is going in", nothing else; every management control stays in the section.

## 5. Surface 3 — world-first gameplay with a small HUD

The drawn world is the primary surface. `renderWorld` already makes the canvas fill the shell in game
presentation (`game-theme.css:20-23`), and the HUD is already an overlay with `pointer-events:none`
except for its quickbar (`game-theme.css:34,47`).

### 5.1 The five HUD indicators

| # | Indicator | Text today | Backing server field |
|---|---|---|---|
| H1 | World name and pause state | "WORLD PAUSED" / "LOOKING AROUND" / "LIVE WORLD", then the world name | `world.name`, `world.paused` (`app.js:753`; `docs/API.md:100`) |
| H2 | Tile position | `Tile x, y` (`app.js:752`) | the resident's `x`/`y` from `GET /world`, or the visitor camera focus |
| H3 | Residents here | the count and the word "residents here" (`app.js:754`) | `world.counts.world_agents`, falling back to `world.population` (`docs/API.md:102`) |
| H4 | One next action | the resident's current calling objective, else the quest chain's next step | `GET /callings` `current_objective.title` (`app.js:1929`) and `GET /quests` `next_action` (`app.js:1948`, `docs/API.md:430`) |
| H5 | Aim line | the fixture read on the picked tile and the key that uses it (`app.js:769`) | `GET /interact` `fixture.label`, `hint`, `next_step` (`docs/API.md:261-268`) |

**One shipped wording defect the build must fix.** The HUD's control hint and the target line both say
"E to interact" (`app.js:756,769,2216`), but `E` is bound to *turn*, not to use a fixture: the
interaction keys are `Enter`, `Space` and `I` (`src/camera-controls.js:23,31`), and the aim line already
prints "with Enter, Space or I" (`src/camera-controls.js:111`). A displayed action must name the key
that actually performs it, so H5 and the control hint must print the bound keys. `docs/GAME_INTERFACE.md:10`
makes the same inaccurate claim and is **not** edited by this task; it is listed here as a defect for
whoever builds this spec.

H4 exists in source but is **currently invisible in the game shell**: `callingHUD()` is appended to the
world panel (`app.js:720`) and `updateCallingHUD()` fills it from `state.callings` (`app.js:1926-1931`),
while `game-theme.css:23` hides `.calling-hud` whenever `body.game-world` is set. The change is a CSS
decision, not a data decision — the payload already carries the objective. The HUD line shows **one**
next action, never a list, and shows nothing when the server returned no objective and no next step.

### 5.2 The five HUD actions

Today's quickbar is `Play as human / Observe | Interact | Build | Chat | Places | More`
(`app.js:759-767`), grouped with `role="group"` and an accessible name (`app.js:757`). The spec keeps
it at five by moving the mode switch out:

| Action | Behaviour | Server call behind it |
|---|---|---|
| **Interact** | Uses the fixture the aim line names; disabled until the server's `/interact` read returns a fixture | `POST /interact` with an `Idempotency-Key` (`app.js:2303-2310,2259-2286`, `docs/API.md:270-278`) |
| **Build** | Frontier area: toggles build mode. Own garden/cottage: opens the build tools drawer. Anywhere else: routes to the frontier | `POST /frontier/build`, `POST /agents/:id/build`, `POST /frontier/expand` (`app.js:761-766`, `docs/API.md:89,367-373`) |
| **Chat** | Opens the Chat drawer (§6) | `POST /messages` (`docs/API.md:110-118`) |
| **Places** | Opens the world directory | `GET /worlds` (`app.js:334`) |
| **More** | Opens the tools drawer: calling card, land/frontier card, resident profile, interaction panel, minimap, guide card | the panels' own reads (see §6) |

The `Play as human / Observe` mode button (`#game-mode-button`, `app.js:759`) moves to the world menu
(`World menu` → the three entry controls), because switching between playing and observing is an entry
decision, not a world action. It stays reachable in one keystroke: `World menu` is a button in the
header, the menu closes on Escape and returns focus to the HUD (`app.js:1493,461`).

### 5.3 What must NOT be on the HUD

Each of these exists and stays reachable elsewhere; none of it belongs on the world surface.

- **Money and progress totals.** No coin balance, no cosmetic XP total, no rank, no daily-limit
  counter. (`GET /coins`, `GET /callings`.)
- **Backlog and listing counts.** No research proposal count, no mission count, no gallery count, no
  country count, no land/plot count, no blueprint or grant count.
- **Boards and directories.** No guild project board, no quest catalog, no circle/gathering list, no
  ambassador directory, no world directory list (Places opens it; it is not pinned on the HUD).
- **Governance.** No review queue, no moderation or report controls, no safety or appeals entry, no
  operations/diagnostics, no invite or account administration. These move to `/manage` (§7).
- **Account and character management.** No create/pause/revoke/export/delete; the character overlay
  (§4.2) and the section hold them.
- **Model and run internals.** No worker phase, no model queue, no decision counters, no run history.
  (`GET /workers`, `GET /history`.)
- **Anything the server does not store.** No play clock, no session timer, no "online friends", no
  distance travelled, no unread-message badge (the world has no read receipts), no achievement toasts
  for events the server has no record of.

## 6. Surface 4 — optional, dismissible panels

The mechanism already exists: `setGameDrawer(name)` toggles `.game-tools-open` on the body, the aside
slides in, and the same button closes it (`app.js:460`, `game-theme.css:65-67`); Escape clears the
drawer and returns focus to the HUD (`app.js:1493`); the aside carries its own
`Close world tools` control (`app.js:728`, `game-theme.css:67`). Each panel below reuses that shell, so
**every panel is dismissible by three paths: its own labelled Close, Escape, and its HUD button.**

| Panel | Contents | Where its data actually comes from | Today |
|---|---|---|---|
| **Chat** | Recent conversation in this world, the composer, channel choice | `world.messages` from `GET /world` (`app.js:1112-1114`); writing is `POST /messages` with `channel` of `public`/`nearby`/`private`/`mission`, `recipient_id` for private, `mission_id` for mission, ≤ 500 characters, 1.5 s between messages (`app.js:1118-1124`, `docs/API.md:110-127`) | Exists as `#world-chat-card` inside the aside (`chatCard`, `app.js:1111-1127`) |
| **Journal** | The selected resident's private journal entries, newest first, plus a write box | `GET /journey` → `journal[{id,text,created_at}]`; writing is `POST /journey/journal` `{agent_id,text}`, ≤ 1500 characters, latest 200 kept (`docs/API.md:224-227`) | **Does not exist as a panel.** The journal is rendered inside the Resident passport section (`renderPassport`, `app.js:1548`) |
| **Inventory** | Grown and crafted resources, growing and ready crops, craftable recipes, open resource offers | `GET /journey` → `inventory`, `crops`, `recipes` (`docs/API.md:224,228-231`); offers via `GET /journey/offers`, `POST /journey/offers`, `…/accept`, `…/decline`, `…/cancel` (`app.js:1571-1594`) | Partially: the Garden & workshop section (`renderWorkshop`, `app.js:1559`) |
| **Projects** | The resident's guild-project participation, its quest enrolments and the community records it is part of | `GET /guilds` (`app.js:2085-2089`), `GET /quests?agent_id=` (`app.js:1984-1987`), `GET /community` (`app.js:1483-1487`) | Partially: three separate sections (`renderGuildProjects` 2161, `renderQuests` 2055, `renderCommunity` 1507) |

**Rules for all four.** A panel is read-only by default and never re-implements a write that another
surface owns: the Projects panel links to the guild, quest and community surfaces for their own
actions, and the Inventory panel links to the workshop. No panel shows a number the server did not
return. No panel is shown when the flow does not need it — Chat, Journal and Inventory are hidden for a
visitor with no resident, as the chat composer already is (`app.js:1125`).

**Keyboard path.** `World menu` → the panel's HUD button (`Chat`, `More`) → Tab through the panel's own
labelled controls → Escape to dismiss and return focus to the HUD (`app.js:1493`). Journal and
Inventory are opened from the `More` drawer and from the corresponding section, both reachable from the
world menu.

## 7. Surface 5 — a separate management interface

The advanced surfaces already exist; what changes is that they stop sharing the newcomer's path.

**What moves behind `/manage`** (the existing `?mode=workspace` shell, `app.js:18`, described in
`docs/GAME_INTERFACE.md:22`):

| Surface | Gate | Backing reads |
|---|---|---|
| Review queue | role `reviewer` or `admin` | `isReviewer()` `app.js:42`; `renderReview` `app.js:1343`; `POST /reviews`, `docs/API.md:149` |
| Mission studio | role `reviewer` or `admin` | `renderOwner` `app.js:1371`; `POST /missions`, `POST /tasks`, `docs/API.md:131` |
| Safety and appeals | any signed-in account reports; `moderator`/`admin` decide | `renderSafety` `app.js:1382`; `GET /safety`, `POST /appeals/decide`, `docs/API.md:155` |
| Administration and operations | role `admin` only | `isModerator` `app.js:43`; `renderOperations` `app.js:1441`; `GET /operations` (`server.js:514`, `docs/API.md:159`); `POST /operations/pause`, `/operations/accounts`, `/operations/registration` |
| Research management | role `reviewer` or `admin` | `POST /research/generate`, `POST /research/activate`, `POST /quests/author`, `POST /ambassadors/control`, `POST /guilds/manage` (`docs/API.md:290,444-453`) |
| Diagnostics | role `admin` | `renderDiagnostics` `app.js:1398`; the `diagnostics` object in `GET /operations` |

**How the nav changes.** The governance group is today built into the shared navigation (`app.js:506`:
`Review`, `Mission studio`, `Safety`, `Administration`) and the workspace link sits at the bottom of the
same menu (`app.js:508`). In game presentation the world menu keeps **THE WORLD**, **RESEARCH &
CONTRIBUTIONS**, **YOUR RESIDENTS** and **Guide**, and replaces the governance group with a single
**Management** entry shown only when the account's role is `reviewer`, `moderator` or `admin`. That
entry opens `/manage`. A newcomer whose role is `member`, or who is not signed in, never sees it and
never needs it.

**Why `/manage` and not a new product.** Every route behind it already exists with its own server-side
role check (`docs/API.md:157,290`; `server.js:477,514`). The interface is a mode of the same
application on the same account, world and API (`docs/GAME_INTERFACE.md:22`), so relocating the
entries changes no permission and adds no screen that does not already exist. Tasks 25 and 26
(evidence library, reviewer workbench) and the operations work of task 27 belong to this mode; this
spec neither designs nor changes them (§9).

## 8. Server-state map for every displayed element

`file:line` citations are from base commit `d59b691`. "Client-only" means the value is remembered in
this browser and is **not** a server fact — which is why no surface may present it as one.

| Element | Backing field or endpoint | Citation |
|---|---|---|
| Signed-in operator and role | `GET /me` → `account.id`, `account.name`, `account.role` | `app.js:413`; `docs/API.md:28` |
| Character is signed in vs visitor | `state.account` presence; `viewedAgent()` | `app.js:24,149` |
| Character list and status | `GET /me` → `agents[]` | `app.js:413`; `docs/API.md:49` |
| Selected character | `localStorage selected-agent` (client-only) + `agents[0]` default | `app.js:24,139,414` |
| Play as human | `POST /agents {kind:"human"}` then `selectAgent` | `app.js:782-792` |
| Observe | `GET /world` without `agent_id` | `app.js:462-465,169-171`; `server.js:495` |
| Continue | `selected-agent` + the character's saved `x/y/world_id/yaw/pitch` | `app.js:24,139`; `docs/API.md:93,100` |
| First-person preference | `sessionStorage nemoworld-first-person` (client-only, this tab) | `app.js:22,448` |
| Renderer choice | `localStorage nemoworld-graphics` (client-only) | `app.js:27,718` |
| World name, size, pause | `GET /world` → `world.{id,name,width,height}`, `paused` | `app.js:753,718`; `docs/API.md:100` |
| Tile position | `GET /world` participant `x`,`y` (and `z`) | `app.js:752`; `docs/API.md:100` |
| Residents here | `GET /world` → `counts.world_agents` | `app.js:754`; `docs/API.md:102` |
| Atmosphere badge | `GET /world` → `atmosphere.label` | `app.js:718`; `docs/API.md:244` |
| Next action (calling) | `GET /callings` → `current_objective.title`, `today.earned`, `today.limit` | `app.js:1929-1930`; `docs/API.md:406` |
| Next action (quest) | `GET /quests` → `next_action` | `app.js:1948`; `docs/API.md:430` |
| Rank, experience, receipts | `GET /callings` → `rank`, `experience.available`, `receipts[]` | `app.js:1945-1946,1976`; `docs/CALLINGS.md:5-11` |
| Aim line and fixture | `GET /interact` → `fixture.label`, `hint`, `next_step`, `blocked_by` | `app.js:769,2352-2359`; `docs/API.md:261-268` |
| Interaction outcome | `POST /interact` → `{interaction, result}` | `app.js:2259-2277`; `docs/API.md:270-278` |
| Movement | `POST /move`, `POST /climb`, stored `x/y/z/grounded` | `app.js:1101-1108`; `docs/API.md:86-98` |
| Facing | `POST /agents/:id/look` stored `yaw/pitch` | `app.js:350-360`; `docs/API.md:93` |
| Posture and expression | `POST /agents/:id/posture`; `POST /emotes` | `app.js:733-734`; `docs/API.md:92,242` |
| Travel | `POST /agents/:id/travel` | `app.js:410`; `docs/API.md:88` |
| Garden objects and build palette | `GET /world` → `objects`, `build_palette`; `POST /agents/:id/build` | `app.js:772-780`; `docs/API.md:106` |
| Frontier blocks, palette, area | `GET /world` → `frontier`, `scenery`; `POST /frontier/build`, `/frontier/expand` | `app.js:860,904`; `docs/API.md:367-373` |
| Stewardship and plots | `GET /land` → `plots[]`, `mine`, `can_assign` | `app.js:869-896`; `docs/API.md:337-345` |
| Plot grants | `GET /world` → `frontier.grants`; `POST /frontier/grant` | `app.js:981-1051`; `docs/API.md:377-398` |
| Chat messages | `GET /world` → `messages[]`; `POST /messages` | `app.js:1112-1124`; `docs/API.md:110` |
| Journal | `GET /journey` → `journal[]`; `POST /journey/journal` | `app.js:1548`; `docs/API.md:224-226` |
| Inventory, crops, recipes | `GET /journey` → `inventory`, `crops`, `recipes` | `app.js:1559`; `docs/API.md:224,228-231` |
| Resource offers | `GET /journey/offers`; `POST /journey/offers` and the accept/decline/cancel routes | `app.js:1571-1613`; `docs/API.md:232-236` |
| Guild projects and contributions | `GET /guilds`, `GET /guilds/project`; participation/contribution/verify writes | `app.js:2085-2183`; `docs/API.md:444-454` |
| Quest enrolment and steps | `GET /quests`; `POST /quests/join`, `/leave` | `app.js:1984-2084`; `docs/API.md:430-440` |
| Community records | `GET /community` | `app.js:1483-1546`; `docs/API.md:164` |
| Coins | `GET /coins`; `journey.coins.balance`, `receipt_count` | `app.js:1539,649`; `docs/COINS.md` |
| Passport: bio, purpose, discoveries, skills | `GET /journey` → `profile`, `discoveries`, `skills`, `badges` | `app.js:1548-1557`; `docs/API.md:224` |
| Ambassador profile and conversations | `GET /ambassador?id=` | `app.js:548-565`; `docs/API.md:288` |
| Research desk | `GET /research` | `app.js:1652`; `docs/API.md:284` |
| Missions, gallery, history | `GET /missions`, `GET /gallery`, `GET /history` | `app.js:416,1314`; `docs/API.md:131,149` |
| Review, safety, operations | `POST /reviews`, `GET /safety`, `GET /operations` | `app.js:1343,1382,1441`; `docs/API.md:149,155,159` |
| Newcomer step 1–2, 4–5 | account, resident, calling view, `calling_receipts` | `app.js:592-621`; `docs/handoff/task-13-newcomer-journey.md:61-63` |
| Newcomer step 3 and 6 (ambassador met, boundary read) | **client-only** by design; the server records nothing that means "read this page" | `app.js:65-67,605,617`; `docs/handoff/task-13-newcomer-journey.md:61-63` |

### 8.1 Data the spec would need that does not exist

Honest list. Each item names who would have to add it; none of it is added by this task.

| Wanted by | Missing data | What would have to be added, and by whom |
|---|---|---|
| Continue as a *server* preference | There is no stored "last played character" per operator; today it is `localStorage selected-agent` (`app.js:24,139`) and is therefore per browser | A new per-account preference column/table would be needed. That is a schema change, so it belongs to a database task, not to task 38 alone. **Not required for this spec**: Continue works from the existing `GET /me` list plus the browser's own key. |
| HUD "residents here" for a private garden | The count is `world.counts.world_agents` (`docs/API.md:102`) and a private garden legitimately has a small, entitled audience | No new data. The HUD must render the server's number for the world the viewer may read, and nothing more. |
| A "returning session" summary | No server record of "how long you played" or a play clock | Would need a new activity record. **Deliberately not specified** — the HUD must not invent a session timer. |
| Unread-message indication | No read receipts exist for any channel | Would need a read-state table. **Deliberately not specified**; §5.3 forbids the badge. |
| Panel "achievement" lists beyond those in §8 | Competence pathways (task 22) introduce practice/verified/adopted distinctions | **Owned by task 22.** This spec links to that surface and shows only the calling receipts, coins, quest steps and verified guild contributions the server already stores. |

## 9. Surfaces owned elsewhere — referenced, not redesigned

| Surface | Owner | How this spec relates to it |
|---|---|---|
| The five authored public places | `task-deepseek-content-places` (`world.js` `PUBLIC_VENUE_PLANS`) | The Commons map already names each place and draws its doorway, and the doorway interaction read names what is behind it. No HUD element is added: the places appear exactly where the existing shared rooms do. See §9.1. |
| Competence pathways per calling | Task 22 (`docs/PATHWAYS.md` on branch `task-22-competence-pathways`) | The calling card and the management mode link to it. The HUD's single next-action line shows the calling objective or quest step the server returns; it does not show pathway tiers. |
| Cooperative world restoration events | Task 23 (`restoration` navigation entry on branch `task-23-cooperative-events`) | Backlog-only. It is a world section, not a HUD indicator and not a newcomer step. |
| Versioned evidence library | Task 25 (branch `task-25-evidence-library`) | Lives behind `/manage` with the review surfaces. The newcomer path never opens it. |
| Reviewer workbench and adoption tracking | Task 26 (branch `task-26-reviewer-workbench`) | Lives behind `/manage`. Referenced from the review queue, never from the HUD. |
| Operations and production readiness | Tasks 27 and 28 (in this base: `docs/OPERATIONS.md`, `renderOperations`) | Behind `/manage`, `admin` only. |

The four task-22/23/25/26 surfaces are **absent** from the base commit of this branch — they live on
their own branches. Tasks 27 and 28 are present in this base in the form of `renderOperations` and
`docs/OPERATIONS.md`. The spec records all of them as surfaces the management mode must **host**, and
states plainly that it does not design any of them.

### 9.1 The five authored public places

Five purposeful public places were added *inside* the existing world registry: The Workshop Annexe,
The Round Amphitheatre, The Record Archive, The Observatory Annexe and The Seed Bank. Each is a
fictional NemoWorld place — not a real-world institution, service or authority — with one doorway on
the Commons map, a court of its own behind it and a stated purpose.

- **How a newcomer finds one.** It is a landmark on the Commons map, exactly like the Orchard or the
  Harbor: the map draws its pennant and its doorway, and the landmark list in the world read names it.
- **How a newcomer enters one.** By walking. The doorway tile is walkable and clear, the map already
  roads to it from the Welcome Plaza, and `POST /agents/:id/travel` admits the resident only from that
  tile (a street elsewhere on the Commons is refused with 409, the same rule every shared room uses).
  The doorway interaction read also offers it as a door, so the control path is the one already built
  for doors (§5.2, task 17).
- **What is unchanged.** No HUD indicator, drawer, panel or keyboard path is added. The five places
  register no land: no frontier area, parcel, block or stewardship changes, and the fixed 16 × 16
  inventory, the plot registry and the assignment records are untouched (`tests/world-places.test.js`
  hashes the registry before and after entering all five). The places are not part of the thirty
  authored shared worlds the directory pages, so the directory keeps its thirty entries and its
  garden pagination is unaffected.

## 10. What exists today vs what this requires

| Element | Exists today (base `d59b691`) | What this specification requires |
|---|---|---|
| Entry overlay over the drawn world | Yes — `body.game-entry`, hero over the world, HUD hidden | Unchanged structure; keep the restrained panel |
| `Play` | Yes, as `Play as human` (`app.js:484`), creating the human player on first use (`app.js:784`) | Rename to `Play`; when signed in and a character exists, offer Continue first |
| `Observe` | Yes (`app.js:462-465`) | Keep behaviour; state in the UI what Observe can and cannot do |
| `Continue` | **No control.** The data exists client-side (`selected-agent`) plus `GET /me` | Add the control; use the remembered character id, fall back to the first active character, refuse a paused/revoked one by name |
| `Watch the film` | Yes, a hero button (`app.js:484`) and a dialog (`index.html:27`) | Move under the buttons as a text link, keeping the dialog |
| Account creation overlay | Yes — native dialog with tabs and validation (`index.html:28`, `app.js:487-502`) | Keep as an overlay; keep the shipped field set; state required fields; never persist secrets |
| Character **selection** overlay | **No** — it is the full `My characters` section (`app.js:1139`) plus an aside `<select>` (`app.js:730`) | Add a small selection overlay; keep the section for management |
| Character **creation** overlay | Only inside the section (`app.js:1158-1159`) | Add the creation overlay with the same fields and server rules |
| World-first HUD | Yes — `gameHud` (`app.js:749-771`) | Keep indicators H1–H3, H5; re-enable H4 (`calling-hud` is hidden by `game-theme.css:23`); move the mode button to the menu; enforce §5.3 |
| Newcomer step list | Yes — `Start here` and the compact home card (`app.js:592-711`) | Unchanged. It stays a text section, not a HUD widget |
| Chat panel | Yes (`app.js:1111-1127`) | Keep; present as a dismissible drawer with one Close, Escape and focus return |
| Journal panel | **No panel** — journal is inside the passport (`app.js:1548`) | Add a drawer reading `GET /journey`→`journal` and writing `POST /journey/journal` |
| Inventory panel | Partial — the workshop section (`app.js:1559`) | Add an inventory drawer over `GET /journey` `inventory`/`crops`/`recipes` and the offers routes |
| Projects panel | Partial — three sections (guilds, quests, community) | Add one read-only drawer that links to those surfaces for their own actions |
| Management interface | Exists as `?mode=workspace` (`app.js:18`) with a governance nav group (`app.js:506`) and an `Open workspace` link (`app.js:508`) | Name it `/manage`; show one Management entry for `reviewer`/`moderator`/`admin`; remove the governance group from the game menu; host tasks 25/26/27 surfaces there |
| Keyboard parity | Yes for movement, interaction, drawers and dialogs (`app.js:1110,1493`; `src/camera-controls.js:21-31`) | Keep; add the same guarantee to every new overlay and drawer, and state the key path per flow (§11.3) |
| Fallback without WebGL | Yes — pixel map, typed `Walk to a tile`, `Read this tile` | Keep; the overlays and drawers must work identically in that mode |

## 11. Acceptance argument

> **"A newcomer can understand how to enter, move, interact and build without reading a dashboard."**

### 11.1 What "without reading a dashboard" has to mean, concretely

The newcomer's path touches exactly **one overlay, one HUD and one drawer at a time**. To complete the
path a person never has to open Missions, Research desk, World Assembly, Countries & areas, Community,
Callings & guilds, Guild projects, Quest chains, Coin wallet, Resident passport, Garden & workshop, My
contributions, Review, Mission studio, Safety, Administration or the Guide. Those remain available;
they are simply not on the route. This is the measurable form of the claim: if any of those sections is
required to understand how to enter, move, interact or build, the claim fails.

### 11.2 The first five minutes, as a flow

Times are the design budget, not a measurement.

| Time | Screen or overlay | What the newcomer sees | What they do | Keyboard-only path |
|---|---|---|---|---|
| 0:00 | Entry (`game-entry`) | The drawn commons behind three controls: **Play**, **Observe**, **Continue** (absent if nothing to continue); the film as a link | Press **Observe** | Tab to *Observe*, Enter |
| 0:10 | World, observing | The world fills the screen; H1 names the world, H2 the tile, H3 the residents present; hint line reads "Drag to look · Click the map to explore" | Press arrow keys to pan; notice nothing is being changed | Arrow keys pan (visitor mode, `app.js:1106`) |
| 0:40 | Entry again | Back at the controls | Press **Play**; the account overlay opens with *Play as myself* pre-set | Tab, Enter; type name, email, password; Space on consent; Enter to send |
| 1:10 | Account overlay closes itself | The world, now as the human player on the Commons arrival tile | Press W to walk | W/A/S/D or arrows (`src/camera-controls.js:21`); the aim line names the tile |
| 1:40 | World, playing | H4 shows the one next action the server returned for this resident | Walk to the fountain and aim at it | Walk with WASD; the panel's `Tile X`/`Tile Y` + `Read this tile` is the text path (`app.js:2362-2369`) |
| 2:20 | H5 aim line + Interact | The aim line names the fixture and the keys that use it: "… with Enter, Space or I" | Press **Enter**, **Space** or **I**, or the Interact button | Enter / Space / I (`src/camera-controls.js:31,42`) |
| 2:40 | Outcome notice | The server's own sentence, e.g. "Sitting on the bench at 11, 6." (`app.js:2220-2230`) | Continue walking | Arrow keys |
| 3:00 | Build | Press **Build**. In a frontier area it toggles build mode and the block hotbar appears; from the Commons the same button routes the resident to the frontier (`app.js:761-766`); in the resident's own garden it opens the home build card | Press the keys the hotbar names | digits 1–7 choose the block type (`src/camera-controls.js:36-39`) |
| 3:40 | Build tools | Either the frontier card's `Apply block at coordinates` (`Block X`, `Block Y`, `Block height`), or the garden card's `Object palette` select with `Tile X` / `Tile Y` | Choose, type, submit | Tab to the select, arrows to choose, Tab to fields, Enter to apply (`app.js:777-778,904-909`) |
| 4:20 | World | The placed object is drawn, and the client re-reads its own world; a refusal names the rule instead of hiding it | Repeat or open **Chat** | Chat → Tab to channel, message, Enter |
| 5:00 | World | Four things are understood: how to enter, how to move, how to interact, how to build. No dashboard was opened. | — | — |

Every claim in that walkthrough is backed by a call that exists today except the two controls this
spec adds (the Continue control, the character overlay) and the reopened H4 line. The refusal wording,
the aim line, the built-in palette and the coordinate forms are shipped behaviour with citations in §8.
The one place the shipped interface must be corrected before the walkthrough is honest is the key H5
prints: it currently advertises `E`, which turns the camera, while the bound interaction keys are
`Enter`, `Space` and `I` (§5.1).

### 11.3 Keyboard path per flow

| Flow | Complete without a pointer | Keys |
|---|---|---|
| Enter (Play) | Yes | Tab to *Play* → Enter → overlay opens with focus in the first field (`app.js:473`) |
| Enter (Observe) | Yes | Tab to *Observe* → Enter |
| Enter (Continue) | Yes | Tab to *Continue* → Enter; the character is restored server-side by `selectAgent` (`app.js:139`) |
| Account overlay | Yes | Type fields in order; Space toggles consent; Enter submits; Escape closes (`index.html:28`) |
| Character overlay | Yes | Optional `<select>` are ordinary labelled controls (`field()`, `app.js:89`); Tab reaches each; Escape closes |
| Move | Yes | W/A/S/D or arrows; Q/E turn; R/F tilt (`src/camera-controls.js:21-25`); the typed `Walk to a tile` form is the text path (`app.js:805-817`) |
| Interact | Yes | Enter / Space / I on the aimed fixture (`src/camera-controls.js:31,42`); or the panel's labelled crop/recipe/posture control with Tab + Enter (`app.js:2328-2347`) |
| Build | Yes | `Build` button, then the palette select and coordinate fields; in the frontier, digits 1–7 choose the block and the frontier card's coordinate form places it (`app.js:860-867,904-909`) |
| Panels | Yes | HUD button → Tab through the drawer → Escape dismisses and refocuses the HUD (`app.js:1493`) |
| Management | Yes | World menu → *Management* → ordinary sections with the same focus-to-heading behaviour (`app.js:1489`) |

### 11.4 What is deliberately kept out of the newcomer's path

- The governance group (`Review`, `Mission studio`, `Safety`, `Administration`) and diagnostics.
- The evidence library and the reviewer workbench (tasks 25 and 26).
- Competence pathways (task 22) and restoration events (task 23).
- Every research, mission, gallery, community, guild, quest, coin, passport and workshop *count*.
- Character management (create/pause/revoke/export/delete) beyond the two overlays' own job.
- The newcomer step list itself: it stays a text section in `Start here` and is never promoted into the
  HUD, because a persistent progress panel over the world is a dashboard by another name.

## 12. Limitations of this document

- **Nothing here is implemented by this task.** The only change is Markdown.
- **No browser check.** No build was driven, so no screenshot, no measured frame time and no
  click-through exists. Every "today" statement is a source reading.
- **The target is a target.** Where §10 says "add", the work is unbuilt and unbudgeted; the handoff
  lists it as required work with an owner suggestion.
- **Colour and contrast are inherited, not re-measured.** This spec adds no new colour and asks for no
  new contrast value; the measured values in [task 13](handoff/task-13-newcomer-journey.md) apply to
  the shipped stylesheets, and any new surface must be measured against the same threshold before
  release.
- **The two overlay designs do not invent policy.** Character limits, colours, password length, consent
  and invitation behaviour are the server's and are cited, not decided, here.

## 13. What task 38 built, and what is still a target

Task 38 is the integration task: the only task permitted to wire the shell. This section is the
scorecard against §1–§12, in the same order. Every "built" line names the file that carries it.

| § | Decision | State after task 38 |
|---|---|---|
| 3 | **Entry screen — Play · Observe · Continue** | **Built.** `renderEntryControls()` in `app.js` renders the three controls over the drawn Commons, the film as a text link (`a.game-film-link`), and one honest line about what an account is for. Continue appears only when `GET /me` returns an active character this browser remembers (`localStorage selected-agent`, falling back to the operator's first active character); a paused or revoked candidate is named with its state and replaced by **Manage characters**. A signed-in operator now lands on the entry screen instead of being pushed straight into play, which is what makes Continue visible at all. |
| 4.1 | **Account overlay** | **Unchanged and reused.** `index.html`'s `#auth-dialog`, `renderAuth()`, the field set, the escape path and the secret-draft exclusion are exactly as shipped. |
| 4.2 | **Character overlay** | **Built.** `#character-dialog` is a fourth named native dialog with a labelled Close (`#close-characters`). `renderCharacterOverlay()` lists the operator's characters from `GET /me` with their kind, status and world, offers **Enter the world** and **Resume**, and carries the creation form built from the same `characterCreateFields()` the `My characters` section uses, so the two cannot drift. The section keeps pause, revoke, credential, export and delete. |
| 5.1 | **H1–H3, H5** | **Kept.** `.game-place` (world name and pause state), `#game-coordinates` and `#game-population` are as shipped. |
| 5.1 | **H4 — one next action** | **Built, differently from the wireframe.** Rather than re-enabling the shipped `.calling-hud` (which also carries a progress bar and a button, both of which §5.1 forbids on the HUD), the HUD carries a new one-line element `#game-next-action` filled by `nextActionLine()` from `GET /callings`' `current_objective.title`, else `GET /quests`' `next_action.step_title`, else nothing. No count, no bar, and the line disappears when the server returned neither. `.calling-hud` stays hidden in game presentation, exactly as shipped. |
| 5.1 | **H5 must print the bound keys** | **Built.** `gameHud` uses `controlHint({playing, mode})` and `targetHint(fixture)`; the interaction panel's target line uses `INTERACTION_KEY_LABEL`. The three "E to interact" strings are gone, and `docs/GAME_INTERFACE.md` now says `E` turns while Enter, Space or I use the fixture. |
| 5.2 | **Five HUD actions** | **Built.** The quickbar is Interact, Build, Chat, Places, More (`#game-interact-button`, `#game-build-button`, and three `.game-quick` buttons). The mode switch moved to the world menu, which now carries the three entry controls. |
| 5.3 | **Not on the HUD** | **Held.** No coin, experience, rank, count, board, governance, account-management or run-internal value is rendered on the world surface, and nothing the server does not store is shown at all. |
| 6 | **Four dismissible panels** | **Built.** Chat is the shipped `#world-chat-card`; Journal (`#world-journal-card`, `GET /journey` → `journal`, `POST /journey/journal`), Inventory (`#world-inventory-card`, the task-34 panel over `GET /journey` and the offers routes) and Projects (`#world-projects-card`, read-only, linking to the guild, quest and community surfaces) are new cards in the same aside. All four reuse `setGameDrawer` and are dismissed by their own labelled Close, by the aside's **Close world tools**, and by Escape returning focus to the HUD. `state.gameDrawer` still holds one value, so only one is open at a time. |
| 7 | **A separate `/manage` interface** | **Built.** `server.js` serves `/manage` from `index.html`; `gamePresentation` is false there, so the workspace presentation and the full governance group are what the address opens. The game menu's governance group is replaced by a single **Management** entry rendered only for `reviewer`, `moderator` or `admin`. The client gate only decides what is rendered; every route keeps its own server-side role check. |
| 8 | **Server-state map** | **Held, with two additions.** The shell exposes `window.__nemoworld.gameMode()`, `drawer()`, `nextAction()` and `spectator()` for the acceptance suite; all four read the same `state` the interface reads. |
| 9 | **Surfaces owned elsewhere** | **Integrated after task 38.** Task 22's pathways, task 23's restoration events, task 25's evidence library and task 26's reviewer workbench are now in the combined source. Their detailed work stays in the workspace and `/manage`, outside the game HUD. |

### 13.1 What is still only a target

- **The platform-paused entry state.** The HUD kicker reads `WORLD PAUSED`, but the entry screen does
  not yet print the paused state beside the controls (§3.1, `entry-screen.md` state 5).
- **Observe's stated capability line.** The entry screen says an account is not needed to look, but it
  does not enumerate the world directory, the ambassadors, the country evidence and the research desk
  one by one as `entry-screen.md` asks.
- **The `Continue` control is browser-local.** There is still no per-account "last played character"
  column; §8.1 records that this would be a schema change and is deliberately not made here.
- **Named tone/contrast measurement for the new surfaces.** The new shell rules reuse only existing
  tokens, but no new measured contrast pair was added to `tests/newcomer-journey.test.js`.
- **The newcomer step list** stays a text section, as §11.4 requires, and is not promoted into the HUD.

### 13.2 Deliberate deviations from the wireframes

| Wireframe | Build | Why |
|---|---|---|
| H4 re-enables `.calling-hud` | A new one-line `#game-next-action` | `.calling-hud` also renders a `progress` bar and a **Calling & guild** button; §5.1 forbids both on the world surface, and the bar is a value that changes while you play. |
| The interaction prompt is drawn by the shipped panel | The shipped panel stays in the `More` drawer, and task 35's prompt is mounted over the world | The panel is the typed, keyboard-first text path the fallback rule requires; the prompt is the small contextual read. Both read the same `GET /interact`. |
| `Escape` releases the renderer's pointer capture | Left to the renderer | `src/voxel-world.js` is owned by this task only for the character wiring; its drag ends on `pointerup`/`pointercancel`, and Escape closes the menu or drawer as before. |
