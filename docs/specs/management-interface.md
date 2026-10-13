# Management interface — `/manage`

**Target, not implemented. No browser check was performed by this task.**

One separate mode hosts every advanced surface, so the newcomer's path never meets it. It is the
existing workspace shell — a mode of the same application on the same account, world and API — given
one address and one entry point.

## What exists today

| Piece | Today | Citation |
|---|---|---|
| The mode | `gamePresentation` is false when the URL carries `?mode=workspace`; everything else about the account, world and API is shared | `app.js:18`; `docs/GAME_INTERFACE.md:22` |
| The link | In game presentation the navigation ends with a `MORE CONTROLS` group holding `Open workspace` | `app.js:508` |
| The surfaces | `Review`, `Mission studio`, `Safety` and `Administration` are appended to the shared navigation when the role allows | `app.js:506` |
| The role helpers | `isReviewer()` = `admin` \| `reviewer`; `isModerator()` = `admin` \| `moderator` | `app.js:42-43` |
| Server-side role checks | The routes keep their own checks; the client gate is only the client gate | `docs/API.md:157,290`; `server.js:477,514` |

The problem this fixes is not a missing screen. It is that in game presentation the same navigation is
rendered into the world menu (`game-theme.css:25`), so a signed-in reviewer sees `Review`, `Safety` and
`Administration` in the middle of the game menu, and a newcomer sees the group's shadow even when it is
empty.

## The change

1. **Address.** The mode is reachable at `/manage` (keeping `?mode=workspace` as the compatible form),
   and the game menu's single `Management` entry links to it.
2. **Entry visibility.** The `Management` entry renders only when the account's role is `reviewer`,
   `moderator` or `admin` (`isReviewer() || isModerator()`, `app.js:42-43`). A `member` and a visitor
   never see it.
3. **No governance in the world menu.** The governance group leaves the game-mode navigation
   (`app.js:506`); in `/manage` the same group is rendered in full.
4. **Nothing is deleted.** Every section and every route stays; only the entry point moves, so a
   privileged operator loses no capability.

```
Game menu (member / visitor)            Game menu (reviewer / moderator / admin)
┌─────────────────────────┐             ┌─────────────────────────┐
│ THE WORLD               │             │ THE WORLD               │
│  Start here             │             │  Start here             │
│  Open world             │             │  Open world             │
│  …                      │             │  …                      │
│ RESEARCH & CONTRIBUTIONS│             │ RESEARCH & CONTRIBUTIONS│
│ YOUR RESIDENTS          │             │ YOUR RESIDENTS          │
│ Guide                   │             │ Guide                   │
│                         │             │ MORE CONTROLS           │
│                         │             │  [ Management → ]       │   ← one entry, role-gated
└─────────────────────────┘             └─────────────────────────┘
        no management entry                     opens /manage
```

## What `/manage` hosts

| Section | Role gate | Reads / writes | Citation |
|---|---|---|---|
| **Review queue** | `reviewer`, `admin` | `POST /reviews`; `GET /history`, `GET /missions` | `app.js:1343`; `docs/API.md:149` |
| **Mission studio** | `reviewer`, `admin` | `POST /missions`, `POST /tasks`, `POST /missions/status`, `POST /adoptions` | `app.js:1371`; `docs/API.md:131,149` |
| **Safety** | any account may report; `moderator`, `admin` decide | `GET /safety`, `POST /moderation`, `POST /appeals/decide` | `app.js:1382`; `docs/API.md:155` |
| **Administration** | `admin` | `GET /operations`, `POST /operations/pause`, `POST /operations/accounts`, `POST /operations/registration`, `POST /invites`, `POST /operations/backup` | `app.js:1441`; `server.js:514`; `docs/API.md:159` |
| **Diagnostics** | `admin` | the `diagnostics` object from `GET /operations` (process, schema, storage, model, workers, failures, limits) | `app.js:1398`; `docs/API.md:159` |
| **Research management** | `reviewer`, `admin` | `POST /research/generate`, `POST /research/activate`, `POST /quests/author`, `POST /quests/manage`, `POST /ambassadors/control`, `POST /guilds/manage` | `docs/API.md:290,435,444-453` |

Server-side role checks remain the authority. The client's gate decides only what is rendered; the
server refuses a privileged route to a member, a visitor or a runtime credential regardless
(`server.js:474`, `docs/API.md:64,290`).

## Surfaces owned by other tasks

These are **referenced, not designed here**. `/manage` is where they belong when their branches land;
none of them is in this branch's base commit.

| Surface | Owner branch | How `/manage` relates |
|---|---|---|
| Competence pathways (practice vs verified vs adopted) | `task-22-competence-pathways` | Hosted with the calling surfaces, reachable from the calling card; never on the HUD |
| Cooperative world restoration events | `task-23-cooperative-events` (adds a `restoration` navigation entry) | A world section for players, not a management screen; it may appear in `/manage` only where it needs operator oversight |
| Versioned evidence library | `task-25-evidence-library` (schema 22) | Hosted beside the review queue |
| Reviewer workbench and adoption tracking | `task-26-reviewer-workbench` | Replaces or extends the review section; the `/manage` entry is the same |

This specification makes no claim about their internal design, their tables or their flows.

## What must not move

- The world itself, movement, interaction, building, chat and travel stay in the game shell.
- The calling card, land/frontier card and quest next-action line stay reachable in the world: they are
  play, not administration.
- Reporting a message or a character stays where it is, one labelled control on the message or profile
  (`app.js:1114,1136,2392`). Safety *decisions* move; a person's ability to raise a concern does not.

## Keyboard path

| Goal | Keys |
|---|---|
| Reach it | Tab to `World menu` → Enter → Tab to `Management` → Enter (`app.js:461,508`) |
| Navigate inside | The same navigation controls as any section; opening a section moves focus to its heading and each section is reachable by Tab (`app.js:1489`) |
| Return to the world | The header brand returns home (`index.html:16`), and `?mode=workspace` can be left by loading `/` |
| Escape | Escape closes the world menu in game mode and returns focus to `World menu` (`app.js:1493`) |

## Limitations

- **Nothing here is built.** The `/manage` address, the single entry and the nav change are the work
  task 38 (or whichever task wires the shell) would carry out; this document is the specification.
- **Relocation changes no permission.** If a section is visible to a role today, it stays visible to
  that role in `/manage`; if it is refused today, it is refused after. The spec adds no role and
  removes none.
- **The client gate is not a security control.** The server's role checks are (`server.js:474`,
  `docs/API.md:157`), and this section relies on them.
