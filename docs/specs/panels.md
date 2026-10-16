# Panels — Chat, Journal, Inventory, Projects

**Target, not implemented. No browser check was performed by this task.**

Four optional drawers over the world. Each is dismissible, each is read-only unless it names an
existing write, and each names the server field it reads.

## The shared drawer shell

The mechanism ships today and is reused unchanged:

| Piece | Behaviour | Citation |
|---|---|---|
| Open/close | `setGameDrawer(name)` toggles the drawer; opening the same drawer again closes it | `app.js:460` |
| Body state | `.game-tools-open` and `body.dataset.gameDrawer` drive the slide-in | `app.js:454-457`; `game-theme.css:65-66` |
| Panel region | `.world-aside` — fixed, scrollable, `min(430px,100vw)` wide | `game-theme.css:65` |
| Close control | `Close world tools` at the top of the aside, plus any panel's own Close | `app.js:728`; `game-theme.css:67` |
| Escape | clears the drawer and returns focus to `#game-hud button` | `app.js:1493` |
| Focus | opening `tools` focuses `.world-aside`; opening `chat` scrolls the chat card into view | `app.js:460` |
| Refresh safety | the three-second poll replaces the message list only when focus is not inside a form or the list | `app.js:1643-1644` |

Each panel is one `<section class="card">` inside the aside with an `h2` heading, so
`openSection`-style focus-to-heading behaviour applies and a screen reader can orient inside the
drawer.

## 1. Chat

```
┌─ Conversation · VOICES IN THE WORLD ────────────────────────────┐
│ [public] Ada: anyone near the fountain?            2 min ago     │  ← world.messages
│ [nearby] June: on my way                                        │
│ …                                                                │
├─────────────────────────────────────────────────────────────────┤
│ Channel ( This world ▾ )   Recipient (hidden unless Direct)      │
│ Message  [____________________________________]  500 characters  │
│ [ Send message ]                                                 │
│ Direct conversations are visible to the participants’ operators.  │
└─────────────────────────────────────────────────────────────────┘
```

| Read / write | Server field or endpoint |
|---|---|
| Messages | `GET /world` → `messages[]` (`app.js:1112-1114`); `author`, `text`, `channel`, `created_at` |
| Send | `POST /messages` → `channel` `public`\|`nearby`\|`private`\|`mission`, `recipient_id` for private, `mission_id` for mission, `text` ≤ 500 (`app.js:1118-1124`, `docs/API.md:110-127`) |
| Report a message | `POST /reports` (`app.js:1114,1381`) |

Rules: 1.5 seconds between messages from one operator; private messages are visible to the
participating characters' operators and are not end-to-end encrypted (`docs/API.md:118,127`). A visitor
with no account sees the list and the sign-in line, not a composer (`app.js:1125`).

Today this exists as `#world-chat-card` inside the aside (`chatCard`, `app.js:1111-1127`); the change
is presentational only.

## 2. Journal

Private. Never public, never on the HUD.

| Read / write | Server field or endpoint |
|---|---|
| Entries | `GET /journey` → `journal[{id,text,created_at}]` (`docs/API.md:224`) |
| Write | `POST /journey/journal` `{agent_id,text}` ≤ 1500 characters; latest 200 kept (`app.js:1556`, `docs/API.md:226`) |

The panel lists entries newest first with a date line, and one textarea with a labelled submit. It is
the same data the passport already renders (`app.js:1556`), moved into its own drawer so a resident can
write a note without opening a passport-sized section.

## 3. Inventory

| Read / write | Server field or endpoint |
|---|---|
| On the shelf | `GET /journey` → `inventory[{kind,quantity}]` (`app.js:1561`, `docs/API.md:224`) |
| Crops | `GET /journey` → `crops[{x,y,kind,planted_at,tended_at,harvested_at,ready_at,ready}]` (`docs/API.md:224`) |
| Recipes | `GET /journey` → `recipes[{id,name,ingredients,output}]` (`app.js:1562`) |
| Grow | `POST /journey/garden` `{agent_id,action:'plant'\|'tend'\|'harvest',x,y,kind?}` (`docs/API.md:228`) |
| Craft | `POST /journey/craft` `{agent_id,recipe_id}` (`docs/API.md:230`) |
| Offers | `GET /journey/offers`; `POST /journey/offers`, `…/accept`, `…/decline`, `…/cancel` (`app.js:1571-1613`, `docs/API.md:232-236`) |

The panel renders: shelf badges (only kinds with quantity > 0), the crops with their readiness, the
recipes with whether the ingredients are held, and the offers the resident is party to. Every button
here is the shipped button from the workshop and offers panels (`renderWorkshop`, `app.js:1559-1565`;
`renderOffers`, `app.js:1571-1613`) — no new rule, no new threshold. Growth times and the accept/decline
rules are the server's (`docs/API.md:228-236`).

Today this is the `Garden & workshop` section; the drawer is the same data with a smaller surface.

## 4. Projects

Read-only by design. It shows what the resident is part of and links to the surface that owns each
action, so no write is duplicated.

| Read | Server field or endpoint | Action it links to |
|---|---|---|
| Guild participation and contributions | `GET /guilds` (public projects plus the caller's own private ones when `agent_id` is supplied) → `projects[]`, `plan[]`, `participants[]`, `contributions[]` (`app.js:2085-2089`, `docs/API.md:444-454`) | `POST /guilds/participation`, `/contributions`, `/verify`, `/manage` on the Guild projects section |
| Quest enrolment and next step | `GET /quests?agent_id=` → `chains[]`, `enrolment`, per-step state, `next_action` (`app.js:1984-1987`, `docs/API.md:430`) | `POST /quests/join`, `/leave` on the Quest chains section |
| Community records | `GET /community` → `circles`, `projects`, `events`, `thanks`, `counts` (`app.js:1483-1487`, `docs/API.md:164`) | `POST /circles`, `/projects`, `/events`, `/thanks` on the Community section |

The panel must distinguish, in words, a **pledge** (an intention), a **submitted claim** (unverified)
and a **verified** contribution — the shipped contribution payload already labels its own state
(`docs/GUILDS.md`; `guildOutcomeTag`, `app.js:2095`). It must not count a pledge as progress.

**Not this panel's job:** competence pathways (task 22), restoration events (task 23) and the
evidence/review surfaces (tasks 25 and 26). Those are separate surfaces; the Projects panel links to
nothing in them.

## Dismissal, parity and the honest-data rules

| Rule | Detail |
|---|---|
| Three dismissal paths | the panel's own labelled Close, the aside's `Close world tools`, and Escape with focus returned to the HUD (`app.js:728,1493`) |
| One panel at a time | `state.gameDrawer` holds a single value, so opening Chat closes the tools drawer (`app.js:460`) |
| No blocking | a drawer never traps the keyboard; Escape always works, and the world keyboard map stands down only while a native dialog is open (`app.js:1110`) |
| Nothing invented | every panel value is a server field listed above. No panel shows a count the server did not return, and none shows a client-only value as a fact |
| Empty states are honest | "The plaza is quiet. Start a conversation." and comparable shipped empty lines (`app.js:1113,1561`) |
| Visitor behaviour | Chat, Journal and Inventory require a resident; for a visitor they are absent or read-only, as the composer already is (`app.js:1125`) |

## Keyboard path

| Goal | Keys |
|---|---|
| Open Chat | Tab to `Chat` in the quickbar, Enter (`app.js:767`) |
| Open the tools drawer (which hosts Journal, Inventory and the projects/calling cards) | Tab to `More`, Enter |
| Move inside a drawer | Tab / Shift+Tab through its labelled controls; `<select>` responds to arrow keys |
| Send a message | Tab to Channel, choose with arrows, Tab to Message, type, Enter |
| Write a journal entry | Tab to the textarea, type, Tab to submit, Enter |
| Dismiss | Escape (focus returns to the HUD), or Tab to the Close control, Enter |
