# Veloren home: a claimed plot with a cottage

A linked player claims a plot in NemoWorld and gets a cottage standing on it in the Veloren world, which
they can walk into. The in-game side is the keeper resident **Rowan Commonreach** (`lw-rowan`); the Veloren
server builds the cottage from a fixed blueprint when NemoWorld signs a `home_build` command for the plot.

```
player --/tell Rowan "build my home"--> his bridge --POST /veloren/home/ask--> NemoWorld
                                        (the plot is read from the land registry, never from the words)
Rowan's answer, privately: "I asked the world to build your cottage at plot:0:0:0:0 ..."
NemoWorld: link.issueCommand(home_build, {plot, style 0..7})
Veloren server: allow-list the plot -> judge its ground -> clear and build the blueprint -> acknowledge
NemoWorld: only that signed acknowledgement makes it "built", and the player is told
player --/tell Rowan "enter"--> link.issueCommand(home_enter, {plot}) -> the server moves that player inside
```

## What this feature refuses to own

| Promise | How |
|---|---|
| The deed is NemoWorld's | The plot is read through `platform.land({mine})` and claimed only through `platform.landAssign`, which is human-only and already enforces the real rules: one plot per operator, four assignments per account per UTC day, a pause between them, no price, no transfer. The keeper says plainly that the deed is not his to give. |
| The door is NemoWorld's | Entry is decided by `platform.space(actor, "house:<resident>")`: a cottage is private until its owner opens it, and the platform refuses a private one to anybody else. The owner opens or closes it with the platform's own `homeSettings` (`house_visibility`) in NemoWorld. |
| The vault is never read | `platform.vaultStatus` gives counts and a mode; the reader that note text needs is never called from this module (a test asserts it), so a player hears "your vault holds N notes … open NemoWorld to read them". |
| A player's words cannot choose anything but a style | The signed arguments are a plot address and a style number 0–7. A plot address written in chat is ignored; the address always comes from the registry. |
| The server decides what a cottage is | NemoWorld never sends a block, a size or a coordinate. `nemo-link-proto` owns the blueprint, the ground rules and the plot address, and it is unit tested (11 tests: the shell is sealed, the door is closed and both ways in and out are free, furniture stands inside, neighbouring plots never touch). |
| Nothing is "done" until the world says so | Every command is answered with a signed `command.applied` or `command.rejected`; the keeper only says a cottage is built after that word, and a refused build is reported honestly. |

## The contract

* **Plot address**: NemoWorld's own canonical parcel id, `plot:<sx>:<sy>:<px>:<py>` — the text
  `land_parcels` builds and `frontier.js` validates. The Veloren side parses exactly that and nothing else.
* **Buildable plots**: only the commons (`sx = sy = 0`) and never the central crossroads band
  (`plot x` or `y` of 3 or 4). Anything else is refused by the server with `NotInCommons`.
* **Commands**: `home_build {"plot":"plot:0:0:1:2","style":3}`, `home_enter {"plot":"…"}`,
  `home_leave {"plot":"…"}`. Anything else in the arguments is refused.
* **Config**: the Veloren feature is off unless the link config has a `home` section,
  `"home": {"origin_x": 15300, "origin_y": 16100}` (the commons sit at that corner, 14 blocks per plot,
  8 plots per side). The server keeps `<outbox>.homes.json` (its registry) and
  `<outbox>.home_plots.json` (the plots it built).
* **Credentials**: the keeper's bridge uses the existing `director` scope, restricted to `lw-rowan` (like
  the guide's), so no new scope is added. The node in the link config's `residents` map decides which
  acknowledgements are signed for which resident (see the merge note in `REMAINING.md`).

## Where the pieces live

| Piece | File |
|---|---|
| NemoWorld side (the keeper's answers, the commands, the notices) | `src/veloren-ext/home.js` (a link extension; one line in `src/veloren-ext/index.js`) |
| Bridge side (a whisper to the keeper, his answer back) | `nemo-bridge/src/chat_home.rs`, started with `--home` |
| Veloren server side (the blueprint, the ground, the door) | `server/src/sys/nemo_home.rs` and `nemo-link-proto/src/home.rs` |

## In the game

Whisper Rowan: `/tell Rowan where is my home`, `build my home` (or `build my home in style 3`), `enter`,
`leave`, `my notes`. He answers privately. He never takes a plot request: he tells you to claim one in
NemoWorld, and then he builds and opens that plot's cottage.

## Tests

* `node --test tests/veloren-home.test.js` (10 tests): the words only choose fixed answers and a bounded
  style; an unlinked player gets nothing; a linked player without a plot is sent to the registry and no
  command is issued; with a plot, one bounded `home_build` naming the registry's own plot; asking again
  while the first is unanswered answers rather than repeats; the world's signed word makes it built (and a
  refusal is reported and cannot be entered); the door is the owner's own and another account cannot read a
  closed cottage; the vault is a pointer.
* `cargo test --release -p veloren-server --lib nemo_home` and the 11 tests in `nemo-link-proto`'s
  `home.rs` for the pure rules; `cargo test --release -p nemo-bridge` for the courier's parsing and bounds.

## Limits

* **No visiting.** A player can enter their own cottage; the keeper never opens somebody else's, so there is
  no in-game visitor path (the platform's own rule allows a visitor only when the owner has opened the
  cottage *and* the visitor's resident is inside it).
* **No visual cottage interior**: the cottage is a real structure in the world, not a rendered room.
* **The keeper does not pre-check the ground.** A plot in the crossroads or on steep ground is refused by
  the server and reported to the player; the module does not duplicate the blueprint's rules.
* The vault pointer shows counts only, by design.
