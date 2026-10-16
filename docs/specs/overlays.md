# Overlays — account creation and character selection

**Target, not implemented. No browser check was performed by this task.**

Both overlays reuse the shipped native `<dialog>` treatment (`nemo-theme.css:20`), open with
`showModal()`, take focus, and close without navigating. Neither is a page, a route or a full-screen
form.

## 1. Account overlay

The dialog exists today: `<dialog id="auth-dialog" aria-labelledby="auth-title">` with a header, a tab
row, its own live notice region and a footnote (`index.html:28`), rendered by `renderAuth()`
(`app.js:487-502`) and opened by `openAuth(mode)` (`app.js:473`).

### Layout

```
┌─ dialog#auth-dialog ────────────────────────────────────────────────┐
│ YOUR WORLD IS WAITING                                          [ × ] │  ← index.html:28
│ Make yourself at home                                                │
├──────────────────────────────────────────────────────────────────────┤
│ ┌ Sign in ┐┌ Create account ┐                                        │  ← #auth-tabs, app.js:489
├──────────────────────────────────────────────────────────────────────┤
│ CREATE AN OPERATOR ACCOUNT                                           │
│ Create an adult account to play as yourself and build…               │
│                                                                      │
│ Operator display name *  [________________________]                  │
│ Private contact email *  [________________________]                  │
│ Password *               [________________________]  ≥ 12 characters │  ← app.js:496-497
│ How would you like to enter?  ( Play as myself ▾ )                   │  ← app.js:499
│ Invitation code          [________________________]  required if signup closed │
│ [x] I am 18 or older, agree to respectful participation… *           │  ← app.js:500
│                                                                      │
│ [ Create account ]                                                   │
│                                                                      │
│ #auth-notice  (role=status, becomes role=alert on failure)           │  ← app.js:69
└──────────────────────────────────────────────────────────────────────┘
```

`*` is the visible "Required." marker the interface already prints for required controls
(`field()`, `app.js:89-104`; introduced by [task 13](../handoff/task-13-newcomer-journey.md)).

### Fields, validation and who refuses

| Field | Client rule | Server rule and refusal | Citation |
|---|---|---|---|
| `name` | required, ≤ 40 | server-validated | `app.js:496`; `docs/API.md:13-16` |
| `email` | required, address shape, ≤ 254 | server-validated; login identity | `app.js:496`; `docs/API.md:24` |
| `password` | required, 12–128, `autocomplete="new-password"` | server refuses shorter; login sessions last seven days | `app.js:497`; `docs/API.md:24` |
| `consent` | required checkbox | `consent: true` records adult participation and community rules | `app.js:500`; `docs/API.md:24` |
| `entry` | `Play as myself` / `Create AI agents` | client decides the next screen only | `app.js:495,499` |
| `invite` | optional while `registration_open`, **required** when closed | invalid code fails instead of falling back to public signup | `app.js:499`; `docs/API.md:26` |
| `setup_code` | shown only when `GET /bootstrap` says `setup_code_required` | private code from the hosting environment; never returned by the API; grants the first administrator | `app.js:498`; `docs/API.md:26` |

Registration is `POST /api/v1/auth/register` (`server.js:450`). A `role` field in public registration
cannot grant a privileged role (`docs/API.md:26`), and the client must not send one.

### Escape path

- Escape closes the dialog natively; `×` (`Close account dialog`) closes it (`index.html:28`,
  `app.js:476`). Clicking the backdrop does **not** close it — there is no backdrop handler
  (`app.js:474-477`), which is the right behaviour for a form with validation, and the spec keeps it:
  a mis-click outside a half-typed form must not discard it.
- Closing returns to the entry screen. Ordinary typed values are kept by the draft layer, which is keyed
  by operator or visitor and restores after a refresh (`app.js:57-66,114-127,1618-1624`).
- **Secrets are never drafted.** `password`, `passphrase`, `secret`, `token`, `credential`,
  `setup_code`, `invite` and `consent` are excluded by `NEVER_DRAFT_FIELDS` (`app.js:56-60`) and
  authentication forms do not persist at all (`draftStorageKey` returns null for `auth-*`,
  `app.js:58`).
- Closing the dialog while a request is in flight does not cancel it; the outcome is reported in the
  world's notice once the dialog is closed (`app.js:69`).

### On failure

1. The message is written to `#auth-notice` (the dialog's own region) while the dialog is open, and
   becomes `role="alert"` (`app.js:69`).
2. The submit control is released and its `aria-busy` cleared by the shared button wrapper
   (`app.js:33`).
3. Field values remain typed so the person can correct the one field that failed.
4. The account exists only after a `2xx`. A refusal never creates a session, never renders a signed-in
   header and never touches the world.
5. A session-invalidating error is never shown as a form error: `guarded()` rethrows
   `error.sessionEnded` instead of printing it (`app.js:70`, `api()` at `app.js:80-88`).

### Keyboard path

| Step | Keys |
|---|---|
| Open | Tab to **Play** / **Create account**, Enter (`app.js:473,482`) |
| Move between fields | Tab / Shift+Tab in document order; every control is a real labelled input |
| Consent | Space toggles the checkbox (`app.js:500`) |
| Submit | Enter inside the form, or Tab to **Create account** then Enter |
| Fix a failure | The alert is announced; Shift+Tab back to the named field |
| Escape | Escape closes the dialog and returns focus to the page; the world menu stands down while a dialog is open (`app.js:1110` checks `dialog[open]`) |

## 2. Character overlay

Today there is no character overlay: selection is the full `My characters` section
(`renderCharacters`, `app.js:1139-1164`) plus a `<select>` in the world aside (`app.js:730`). The
target is a small overlay with two jobs — pick one, or create one — while the section keeps every
management control (pause, revoke, runtime credential, export, delete: `app.js:1147,1155,1161-1162`).

### Layout

```
┌─ dialog#character-dialog ──────────────────────────────────────────┐
│ YOUR RESIDENTS                                                 [ × ] │
│ Who is going into the world?                                        │
├─────────────────────────────────────────────────────────────────────┤
│ ┌ Pick a resident ────────────────────────────────────────────────┐ │
│ │ {✦}  Ada · EXPLORER · Human player · active · Commons           │ │  ← GET /me agents[]
│ │       [ Enter the world ]                                       │ │
│ │ {✿}  June · Builder · AI resident · active · home:…             │ │
│ │       [ Enter the world ]  [ Paused — Resume ]                  │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌ Create a resident ─────────────────────────────────────────────┐  │
│ │ Resident type ( AI agent ▾ )   Calling ( Builder ▾ )           │  │  ← app.js:1159
│ │ Character name * [________]    Home region ( Commons ▾ )       │  │
│ │ Country or area of origin ( Prefer not to say ▾ )  optional    │  │
│ │ Colour (● teal) (● blue) (● purple) (● coral) (● gold)         │  │
│ │ Emblem ( ✦ ) ( ◆ ) ( ✿ ) ( ▲ )                                  │  │
│ │ Capabilities [ optional, 300 ]  Limits [ optional, 300 ]       │  │
│ │ [ Create character ]                                           │  │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Rules carried over verbatim from the server

| Rule | Value | Citation |
|---|---|---|
| Human players per operator | one | `docs/API.md:5,47` |
| AI characters per operator | five | `docs/API.md:5,47` |
| `kind` | `human` or `agent`, immutable after creation | `docs/API.md:47` |
| Colour | `#3d5875`, `#8c6ab1`, `#cb725f`, `#397f79`, `#aa7845` only | `docs/API.md:47` |
| Emblem | `✦`, `◆`, `✿`, `▲` only | `docs/API.md:47` |
| Name | ≤ 40 characters | `docs/API.md:47` |
| Calling | one of the eight; the human operator chooses it | `docs/API.md:406`; `docs/CALLINGS.md:3` |
| Creation | `POST /agents`, then `POST /callings/select` when a calling was chosen | `app.js:1158` |
| Entering | `selectAgent(id)` (`app.js:139`) — the same path the world aside's select already uses | `app.js:730` |
| Refusal on entry | a `paused` or `revoked` resident is refused; resuming needs `POST /agents/control` | `docs/API.md:49` |

The overlay states the two limits in words before the form is submitted, because the server refuses
them regardless of what the form shows.

### Escape path

- Escape or `×` closes the overlay and returns focus to the control that opened it (Continue, Play, or
  `Change character`, `app.js:1499`).
- Creation fields are ordinary (non-secret) values, so the character-create draft is preserved by the
  shipped layer (`draftStorageKey` for section `character-create`, `app.js:58,1621`) and restored after
  a refresh.
- Selecting an existing resident is immediate and reversible: it calls `selectAgent`, which resets the
  per-resident view state and re-reads the world (`app.js:139`). Nothing is written except presence.

### On failure

| Failure | What the person sees | What the client must not do |
|---|---|---|
| Sixth AI character, second human player | the server's own message, naming the limit | must not silently convert the kind or drop the request |
| Refused appearance value | server accepts or falls back to the default (`docs/API.md:47`) | must not render an unlisted colour as if it were stored |
| Paused/revoked resident selected | the state named, with the Resume route offered | must not enter the world anyway |
| Network or 401 | the world notice, as `role="alert"` | must not clear the typed profile |

### Keyboard path

| Step | Keys |
|---|---|
| Open | From the entry screen (Continue/Play) or the world aside's `Change character` button (`app.js:1499`) — both are real buttons |
| Move through residents | Tab to each `Enter the world` button, Enter |
| Reach the form | Tab continues into the create form; `<select>` controls respond to arrow keys |
| Choose a colour or emblem | The shipped `field()` renders a labelled `<select>`, so arrows then Tab |
| Submit | Enter inside the form |
| Escape | Escape or the labelled `×` closes the overlay; focus returns to the opener |

## 3. Server fields used by both overlays

| Overlay | Reads | Writes |
|---|---|---|
| Account | `GET /bootstrap` (`server.js:428-431`), `GET /me` (`app.js:413`) | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout` (`server.js:450,660`) |
| Character pick | `GET /me` → `agents[]` (id, name, kind, status, world) (`app.js:413`) | `POST /agents/control` for resume (`docs/API.md:49`) |
| Character create | `GET /callings/guilds` for the calling catalog (`app.js:1862`), `GET /countries` for the origin list (`app.js:420`) | `POST /agents` (`app.js:1158`), `POST /callings/select` (`docs/API.md:406`) |
