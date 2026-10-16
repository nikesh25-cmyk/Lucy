# Veloren hud: the whole interface inside the game

**Selene Dawnbringer** (`lw-selene`) stands at Harr's plaza as NemoWorld's in-game guide. A player says
or whispers a short command and she answers with **private, paged text**, read from that player's own
saved state in NemoWorld. No client change is needed: it is ordinary chat, and it needs no build of
`voxygen`.

```
player --/tell Selene passport--> her bridge --GET /veloren/view/passport?player_uuid=--> NemoWorld
                                 <-- five lines of that player's own record, or a reason why not --
Selene --/tell player ...--> (five lines, one at a time, then /say to leave whisper mode)
player --/tell Selene track--> POST /veloren/hud/track --> signed hud_marker (a LANDMARK id)
                                 <-- the Veloren server sends its own quest-flag marker, then acknowledges
```

## The pages

`help`, `start`, `passport`, `journal`, `calling`, `quests`, `next`, `community`, `karma`, plus `more` and
`page <n>` for the next or a named page of the last answer, and `track`/`mark`/`waypoint` for the map
marker. Words may be surrounded by fillers ("show me my passport please"). Said aloud, a command must name
the guide (`selene passport`) or be one of the plain ones on its own (`passport`), so ordinary conversation
is never swallowed.

## What it will not do

| Promise | How |
|---|---|
| Never invents a number | Every line is built from NemoWorld's own saved state or a signed acknowledgement. The guide never calculates, promises or announces progress. |
| Never writes anything | The views are built from a fixed allow-list of **read** methods (a test asserts the allow-list), and the only command it can ask for is a map marker. |
| Never shows another player's data | The player id comes from the Veloren server's own player list (the bridge), never from the words; a page is built for exactly that id; ids, other accounts' names, the private journal **text** and the vault never appear (a test asserts this over every page). |
| Never invents a marker | NemoWorld signs `hud_marker` naming a **landmark id**, never coordinates. The server looks the id up in the landmarks it resolved from world generation and refuses anything else. |
| Says "placed" only when it is | The marker is reported as placed only after the Veloren server's signed `command.applied`. Anything unacknowledged is "the world has not confirmed the marker". |
| Cannot be flooded | A per-player gap and hourly cap, an hourly cap for everyone, a cap on requests in flight, a bounded outgoing queue, at most 5 lines of at most 220 bytes per answer, and a bounded response body. Drops are silent, so a flood cannot make the guide noisy. |
| Never splits a character or speaks markup | Text from NemoWorld is cleaned (no control or hidden characters, no brackets, one line) and cut on character boundaries, never in the middle of a character. |

## Routes

`Authorization: Bearer <link credential>` with the **director** scope, and only for a **guide resident**
(`lw-selene`). A credential for another resident is refused with 403, so Lyra's credential cannot read
player views.

* `GET /veloren/view/<page>?player_uuid=<uuid>&page=<n>` → `{linked, command, page, pages, lines, …}`.
  An unlinked player is answered honestly (`linked: false` and a pointer to link first), never with
  somebody's data. A missing, malformed, duplicated or upper-case player id, and a bad page, are refused
  with 400.
* `POST /veloren/hud/track` `{player_uuid}` → issues the signed `hud_marker` command (or answers why not:
  not linked, no objective, commands switched off, too soon).
* `GET /veloren/hud/status?player_uuid=<uuid>&cmd_id=<id>` → the status of that player's own command,
  judged only from signed acknowledgements.

The bridge side is `nemo-bridge/src/chat_hud.rs` (whisper accounting, the page requests, the marker, the
outgoing queue and its pacing); the server side is `server/src/sys/nemo_hud.rs` (the `hud_marker` command:
landmark allow-list, one marker per player per gap, the stock client's own quest-flag dialogue, and the
signed acknowledgement). Both are registered with the one `mod`/`dispatch` line the rules allow, and the
bridge gets one `--guide` flag.

## In the game

Whisper Selene: `/tell Selene help`, then `passport`, `quests`, `next`, `journal`, `calling`, `karma`,
`community`, `start`, `more`, or `track` to put the current objective on the map. She answers privately,
five lines at a time.

## Tests

* `node --test tests/veloren-hud.test.js` (22 tests): text from other people is neutralised before it can
  reach a chat window; cutting never splits a character; paging is bounded and every page stays inside the
  line, byte and reply limits even with hostile data; an unlinked player gets a pointer and nothing is read
  for them; a stale or forged identity answer cannot read somebody else's character; privacy over every
  page (no other player, no journal text, no ids); only an allow-list of read methods is reachable; the
  views write no money, reward or progress however often they are asked; the pages tell the truth about
  saved state; rate limits are stored (a restart does not reset them) and enforced over HTTP; tracking asks
  for a signed `hud_marker` naming a landmark, only for a linked player, paced; with commands switched off
  it says so instead of pretending; a marker is "placed" only after a signed acknowledgement and only its
  own player may ask; and the development identity fixture works only on a developer machine and only from
  the file it is told to read.
* `cargo test --release -p nemo-bridge` covers the guide's pure logic (parsing, limits, cleaning,
  composing, queueing) in `chat_hud.rs`.

## Limits

* One guide (`lw-selene`), one process, started with `--guide`. `wt/stack.sh resident-start` does not pass
  that flag (see `wt/evidence/hud/REMAINING.md`).
* The map marker needs the player online, linked, and an objective whose landmark the Veloren server
  resolved. A landmark the server does not know is refused rather than guessed.
* The guide reads; it cannot change anything, and it awards nothing. It is not a client panel: the text is
  chat, and it looks like chat.
* `NEMO_HUD_DEV_LINKS` installs a development identity fixture (a local file of fake links). It refuses to
  load when the deployment has a public origin, and it prints a warning; it is for a developer machine only.
