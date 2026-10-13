# Entry screen — Play · Observe · Continue

**Target, not implemented. No browser check was performed by this task.**

The entry screen is an overlay over the drawn commons, not a separate page. It already exists: in game
presentation the `.welcome` panel is positioned over the world canvas and the HUD is hidden
(`game-theme.css:71,35`, driven by `body.game-entry` from `applyGameShell()`, `app.js:453`). The drawn
world behind the panel is the hero canvas, painted from the deterministic commons definition
(`paintHero()`, `app.js:467-472`).

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [mark] NEMOWORLD  Humans. AI. Shared purpose.      [Watch introduction] [Sign in]│  ← masthead: index.html:16, session-bar app.js:480-482
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   WELCOME TO NEMOWORLD                       ┌──────────────────────────────┐ │
│   Enter a living                             │  the drawn commons (WebGL 2, │ │
│   world.                                     │  or the pixel map fallback)  │ │
│                                              │                              │ │
│   One world. Many callings.                  └──────────────────────────────┘ │
│   Built together.                                                            │
│                                                                               │
│   ┌──────────────┐ ┌───────────────┐ ┌──────────────────────────┐            │
│   │   Continue   │ │     Play      │ │         Observe          │            │  ← #hero-actions, app.js:484
│   │  as <name>   │ │               │ │                          │            │
│   └──────────────┘ └───────────────┘ └──────────────────────────┘            │
│   Watch the film (2 min) · One world. Many callings.                          │  ← text link, not a button
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## States

| State | Who sees it | Controls | Source of the state |
|---|---|---|---|
| **First visit** | No session cookie | **Play** (primary), **Observe** (secondary), film link. Continue absent. | `GET /bootstrap` → `setup_required`, `registration_open` (`server.js:428-431`, `app.js:1615`); `GET /me` fails with 401 → `state.account` stays null (`app.js:1615`) |
| **Returning operator** | Session cookie valid, `GET /me` returns agents | **Continue as *name*** (primary, when this browser remembers a character), **Play**, **Observe** | `GET /me` → `agents[]` (`app.js:413`); remembered id from `localStorage selected-agent` (`app.js:24,139`), falling back to `agents[0]` (`app.js:414`) |
| **Returning operator, no character yet** | Session valid, `agents` empty | **Play** (primary, creates the human player), **Observe** | `app.js:784`; limits stated by the server, `docs/API.md:47` |
| **Character unavailable** | Remembered character is `paused` or `revoked` | **Continue** is replaced by a line naming the character and its state, plus **Manage characters** | `agents[].status` from `GET /me` (`docs/API.md:49`); pausing revokes credentials server-side |
| **Platform paused** | `world.paused` true | Entry still opens; **Play** and **Continue** state that the world is paused | `GET /world` → `paused` (`app.js:753`, `docs/API.md:100`) |

## What each control does

### Play
1. Signed out → `openAuth('register')` with the entry choice pre-set to *Play as myself*
   (`app.js:473,499`). Signed in → `playAsHuman()`.
2. `playAsHuman()` finds the operator's `kind === 'human'` character, creates it once with
   `POST /agents {kind:"human", …}` if absent, refuses a non-active one with a pointer to the character
   management surface, then enters the world and turns the camera to the path
   (`app.js:782-792`).
3. Nothing about Play writes progress, coins or land. It is a session, not a reward.

### Observe
1. `observeWorld()` (`app.js:462-465`): from the entry state it enters the Commons, sets the visitor
   focus to the world's start, clears build state, turns first person off and re-reads the world.
2. A visitor is a reader. `worldURL()` omits `agent_id` unless a character is selected and signed in
   (`app.js:169`), so the server returns the public world view; the interaction panel offers
   `inspect_only` and no live action control (`app.js:2345`, `docs/API.md:268`).
3. Public reading stays open with no account: the world directory (`GET /worlds`, `app.js:334`), the
   248 ambassadors (`app.js:335`), countries and country evidence (`GET /countries`,
   `GET /country-evidence`), the research desk, and the Guide (`app.js:704`).
4. Anonymous clients poll the public world on the shipped three-second interval
   (`app.js:1627-1649`); a signed-in viewer may hold the bounded event stream instead
   (`app.js:234-263`, `docs/API.md:183`).

### Continue
1. Resolves the remembered character id from `localStorage selected-agent` (`app.js:24`) against the
   `agents` list from `GET /me` (`app.js:413`). If the remembered id is gone, it uses the first active
   character; if there is none, Continue is not rendered.
2. Runs the shipped `selectAgent(id)` (`app.js:139`): loads the world plus journey, community, callings,
   quests and guild projects, restores the stored facing from `agent.yaw`/`pitch`, and enters the world.
3. Restores the tab's first-person preference (`sessionStorage nemoworld-first-person`, `app.js:22,448`)
   and keeps the renderer choice (`localStorage nemoworld-graphics`, `app.js:27`).
4. Position, world, layer and facing are the server's (`agents.x/y/z/world_id/yaw/pitch`,
   `docs/API.md:93,100`). Continue is not a new save: it re-reads the same stored row any load reads.

## What a first-time visitor must be able to tell from this screen

- That the world can be looked at **without** an account (Observe).
- That playing needs an account, and that the account is the adult who oversees the characters
  (`index.html:28` footnote; `app.js:494`).
- That nothing on this screen will be charged or published.
- Which control is the primary one for their situation.

## Keyboard path

| Step | Keys |
|---|---|
| Reach the controls | Tab from the masthead; the skip link (`index.html:14`) jumps to `#content` first |
| Activate | Enter or Space on the focused button (`button()` uses real `<button>` elements, `app.js:33`) |
| Read the film link | Tab to the link, Enter opens the native `#introduction-dialog` (`index.html:27`); Escape closes it and stops playback (`app.js:474-475`) |
| Leave the overlay | **Play** or **Observe** leave it; there is no trap and no required field on the entry screen itself |

## Server fields used here

`GET /bootstrap` → `setup_required`, `setup_code_required`, `registration_open` (`server.js:428-431`);
`GET /me` → `account`, `agents[]` (`app.js:413`); `GET /world` → `world`, `paused`, `counts`
(`app.js:753-754`); `POST /agents` (`app.js:784`); `POST /agents/:id/travel` (`app.js:410`).

## Not on this screen

Coin balance, rank, quest counts, mission counts, proposal counts, the newcomer step list, the
management entry. The compact newcomer card lives on the home page and in the Guide
(`newcomerJourneyCard({compact:true})`, `app.js:710,1455`) and is deliberately **not** on the entry
overlay, which must stay a three-control door.
