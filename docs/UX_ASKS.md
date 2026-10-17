# UX asks for the Rust bridge

Selene's text pages are built in `src/veloren-ext/view.js`. The bridge decides which spoken word
maps to which page. These are the small additions the UX work needs from it. NemoWorld already
serves all of them; nothing here needs a new credential or scope.

## New command words

| Word(s) a player says | Bridge should call | Notes |
| --- | --- | --- |
| `menu`, `commands`, `options`, `words` | `GET /veloren/view/menu?player_uuid=<uuid>` | Open page: works for unlinked players too. Lists every word with a one-line meaning. |
| `help`, `hello`, `hi` | `GET /veloren/view/help?player_uuid=<uuid>` | Now an open page: what Harr is, the one best next step, how to ask. |
| any other single word of 1 to 16 letters that matches no command | `GET /veloren/view/menu?player_uuid=<uuid>&word=<word>` | Selene answers "I did not catch X. Did you mean Y?" then shows the menu. `word` must be letters only; anything else is ignored. |

## Behaviour changes the bridge gets for free

* `GET /veloren/view/<unknown>` still returns 404, but the message now reads
  `Unknown page. Did you mean quests?` (or `Say menu to see what I know.`). The bridge may whisper that message.
* Every page now ends with a footer line beginning `Next: say ...`. It is the last line, so it is
  on the last page only; `more: true` still means there is another page.
* `help`, `start` and `next` for a player who is not linked now return the same short welcome with
  one recommended step (from `tasks.js`) instead of a bare "link first" notice. `linked` stays
  `false`, `more` stays `false`, and no account data is read.

## Optional

* A word list for the bridge's own spell check can be taken from `HUD_PAGES` plus `track` in view.js.
* If the bridge keeps its own copy of the help text, please replace it with a call to `help`.
