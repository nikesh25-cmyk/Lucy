# Veloren atlas: one map, and travel on it

NemoWorld's places are shown on Veloren's world as real places, and a linked player can ask the keeper
resident **Vaelen Kindred** (`lw-vaelen`) where they are or to take them somewhere on the map. The move
itself is a signed command the Veloren server carries out against a place it resolved itself.

```
player --/tell Vaelen "travel to the library"--> his bridge --POST /veloren/atlas/ask--> NemoWorld
                             (the place is looked up in the atlas file, never in the words)
NemoWorld: link.issueCommand(teleport, {place_id, m})      m = the atlas manifest hash's first 16 hex
Veloren server: allow-list -> resolve the place from world generation -> move that online player -> ack
NemoWorld: only the signed acknowledgement makes it "arrived", and the player is told
```

## The allow-list

`content/veloren-atlas-places.json` (NemoWorld) is the one file both sides judge, in the shape
`nemo-link-proto::atlas::parse_atlas` accepts:

```json
{ "format": "veloren-atlas-server-v1", "manifest_hash": "<64 hex>", "world_seed": 130626853,
  "places": [ { "id": "commons", "name": "The Commons", "short": "…", "kind": "site",
                "site": "Harr", "arrive_radius": 12 },
              { "id": "library", "name": "The Lantern Library", "short": "…", "kind": "plot",
                "site": "Harr", "plot": "House", "nth": 0, "arrive_radius": 8,
                "landmark_id": "lyra-house" } ] }
```

* A place names a **site** or a **plot of a site** — never a coordinate. The server resolves the position
  from world generation, so a command can never be used to move a player somewhere arbitrary.
* The `manifest_hash` is the sha256 of the sites snapshot the mapping was built from
  (`content/veloren-atlas-sites.json`, taken with `nemo-bridge --list-sites` on that world seed). Every
  command carries its first 16 hex, so a command signed against an older map is refused rather than applied
  to a different world.
* The places this stream ships were each verified against that snapshot: Harr itself, its five resolved plots
  (three carrying the same `landmark_id`s the link's landmark file uses, so a quest objective and a travel
  destination are the same place), and two real far sites.

## What the feature refuses to own

| Promise | How |
|---|---|
| A player's words choose nothing but a place the map has | `parse_intent` reads a place by name; the arguments the server parses are a place id and the manifest hash, exactly. A coordinate in the text is not a place. |
| Where you are is the server's word | "Where am I" is answered only from the last **signed** landmark event NemoWorld stored for that player, and says so when there is none. A command's acknowledgement (which reuses the landmark field for its own command id) is never read as a place. |
| Travel is bounded | One place per ask, the same 20-second cooldown the server applies, the player must be linked and online, and the server caps the whole world at 30 travels a minute. |
| "Arrived" means acknowledged | The player is told they arrived only after the server's signed `command.applied`; an unanswered request is "travelling", and a rejection is reported honestly. |
| Nothing is granted | A travel is a move. The feature writes no land, coin, progress or permission, and reads no vault. |

## Commands and configuration

* `teleport` `{"place_id": "<id>", "m": "<16 hex>"}` — the only kind this stream issues.
* The Veloren side is **off unless the link config has an `atlas` section**:
  `"atlas": {"path": "/…/content/veloren-atlas-places.json"}` (or `"enabled": false`).
* The server writes what it resolved to `<outbox>.atlas-resolved.json`, so the mapping can be checked by eye.
* The keeper uses the existing `director` scope restricted to `lw-vaelen`, so no new scope was added.

| Piece | File |
|---|---|
| NemoWorld side (the keeper's answers, the signed travel, the notices, `GET /veloren/atlas`) | `src/veloren-ext/atlas.js` |
| Bridge side (a whisper to the keeper, his answer back) | `nemo-bridge/src/chat_atlas.rs`, started with `--atlas` |
| Veloren server side (the allow-list, the resolution, the move, the acknowledgement) | `server/src/nemo/atlas/mod.rs` and `nemo-link-proto/src/atlas.rs` |

## In the game

Whisper Vaelen: `/tell Vaelen where am I`, `what is near me`, `places`, or `take me to Ajakkuq`. He answers
privately and asks the world to move you; he says you have arrived only when the world confirms.

## Tests

* `node --test tests/veloren-atlas.test.js` (8 tests): the atlas file is the allow-list and ten kinds of
  broken file are refused; a spoken line only chooses a fixed answer and a place the atlas knows; an unlinked
  player is told to link with nothing written; "where am I" comes only from a signed landmark and never from
  a command id; travel is one place at a time inside the server's cooldown, with the command's two keys read
  back out of the signed command file; the signed word decides arrived/refused with one notice; another
  player gets their own map and an unknown place is refused by name; and over HTTP the map, the ask route and
  the notices need the keeper's own credential.
* `cargo test --release -p nemo-link-proto` (15 tests) for the pure rules: canonical place ids, the strict
  argument forms, the atlas file's own validation, the limiter.
* `cargo test --release -p veloren-server --lib nemo_atlas` and `-p nemo-bridge` for the server module and the
  courier.

## Limits

* **`atlas_look` and `atlas_mark` are not implemented.** The proto defines them (and the place shape carries
  an optional `landmark_id`, so a marker could reuse the guide's own quest-flag dialogue), but this stream
  issues only `teleport`, and NemoWorld therefore never sends the other two.
* **The map is seven places, not NemoWorld's whole map.** NemoWorld's own global map has 23 connected regions
  (`docs/GLOBAL_MAP.md`); mapping every region to a real Veloren site is data work on
  `content/veloren-atlas-places.json`, which the honest test is doing against the site snapshot. What cannot
  be mapped is written down rather than guessed.
* No client-side map markers or panel: Veloren's own map shows the world, and the keeper's text tells you
  where things are (a marker would need the client).
* The keeper does not check the terrain itself: the server resolves the place at load time and refuses a
  place it cannot resolve, so a place naming a site this world lacks is simply never travelable.
