# Veloren link

NemoWorld can host a resident (first: **Lyra Scrollkeeper**) inside a Veloren world. NemoWorld stays the
source of truth for who she is, what she remembers and how a player's task progresses. Veloren is a source of
signed **facts** about where characters stood; it is never trusted for claims.

The feature is **off unless `NEMO_LINK_EVENT_KEY` is set**. Without it, the `/api/v1/veloren/*` routes answer
404 and nothing else changes. It adds one file of its own storage and does not touch the main database, its
schema version, backups or recovery checks.

```
Veloren server --signs--> outbox file --relay--> POST /api/v1/veloren/events   (facts)
Lyra's bridge  <-- GET /veloren/director (where to go, what to announce)         (orders)
Lyra's bridge  --> POST /veloren/talk   (a player spoke to her)  -> model or scripted reply
```

## Trust model

| Threat | Defence |
|---|---|
| A relay or bridge invents progress | Events carry an HMAC made with a key only the Veloren server and NemoWorld hold (`NEMO_LINK_EVENT_KEY`). The relay never has it. |
| A leaked credential | Link credentials are random 256-bit tokens, stored only as a hash, scoped to one resident and to named scopes (`events`, `talk`, `director`), expiring (1 to 30 days) and revocable at once. |
| Replay | Every event id (`<server_id>:<seq>`) is stored once, permanently. Resending it is a no-op and a reused id with different content is refused. |
| Chat claims | No route accepts "completed". Progress is derived only from stored events. `talk` cannot change progress. |
| Out-of-order or early facts | A step only credits a fact that is for its own landmark and happened after the previous step. |
| Model misbehaviour | One inference at a time through NemoWorld's bounded queue, 9 s timeout, 192-token cap, 200 model calls per resident per day, 6 s between messages per player. Replies are checked (no links or contacts, no value or approval promises, no declaring progress, no repeating instructions). Anything refused is replaced by a labelled scripted reply. |
| Prompt injection | Player text is delimited as untrusted speech, can only produce spoken text, and has no tools. |

## Configure

| Variable | Meaning |
|---|---|
| `NEMO_LINK_EVENT_KEY` | Shared secret, 32 bytes or more (64+ hex characters are read as hex). Same value for NemoWorld and the Veloren server. |
| `NEMO_LINK_DB` | Link database file. Default: `veloren-link.sqlite` next to the main database. |
| `NEMO_LINK_LANDMARKS` | Landmark list. Default: `content/veloren-landmarks.json`. |

Credentials (token shown once):

```bash
node scripts/veloren-link.mjs issue --resident lw-lyra --scopes events --days 7 --label relay
node scripts/veloren-link.mjs issue --resident lw-lyra --scopes talk,director --days 7 --label bridge
node scripts/veloren-link.mjs list | revoke <key_id> | status
```

Replies use NemoWorld's existing local model settings (`LUCY_MODEL_*`, or the project-local Qwen started by
`Start World.command`). With no model they are scripted and say so (`"source": "scripted"`).

## API (all `Authorization: Bearer <link token>`)

* `POST /veloren/events` `{events:[…]}` scope `events`: 1 to 20 signed events; per-event result `accepted`, `duplicate` or `rejected` with a reason.
* `POST /veloren/talk` scope `talk`: `{resident_id, player_uuid, player_alias, text}` → `{reply, source: "model"|"scripted", reason?}`.
* `GET /veloren/director` scope `director`: `{mode: "schedule"|"escort"|"return", target_landmark_id, announcements}`. Announcements are handed over once.
* `GET /veloren/progress?player_uuid=` scope `director`: the player's quest steps, each with the event that proved it, and Lyra's notes.

## The first activity: The Quiet Survey (practice quest)

1. **Meet**: stand beside Lyra (server sees you within 8 blocks for 3 s).
2. **Task**: Lyra asks you to walk with her to Harr's farm field.
3. **Survey together**: you and Lyra both inside the field's area for 5 s.
4. **Return**: back at Harr's house with Lyra; she records it and notes it in her memory.

It claims no real-world outcome and awards no coin or Karma. The landmarks are real structures of the Veloren
hamlet Harr; see `content/veloren-landmarks.json` for how NemoWorld's place names map to them.

## Tests

`node --test tests/veloren-link.test.js tests/veloren-relay.test.js` (16 tests): signing vector, credentials,
forged and tampered events, replay, ordering, restart persistence, chat cannot advance a quest, model limits and
guards, relay resume, crash safety and HTTP scopes. The Veloren side pins the same signature vector in
`nemo-link-proto`.

## Limits

* Presence proves two characters stood together, not that useful work was done. Treat the quest as practice.
* Backups: `scripts/recovery.js` does not know the link file. Copy `veloren-link.sqlite` (with its `-wal`) while the server is stopped.
* Accounts: players are identified by their Veloren account id and name, not linked to a NemoWorld account. Rewards would need that link first.
* `veloren-link.sqlite` credentials and progress are local to one NemoWorld instance.
