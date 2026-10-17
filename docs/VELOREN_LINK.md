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
Lyra's bridge  <-> /veloren/identity/*  (a one-time code per player; a link or unlink, with notices)
signed-in human --> /veloren-link page  (types the code)         -> POST /veloren/identity/redeem
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
| A player claims to be someone else | The speaker's account id and name come from the Veloren server's player list, never from the message; the code is delivered to that account uuid alone, privately. |
| Guessing or stealing a link code | 49 bits, single use, ten minutes, stored only as an HMAC; guesses are limited per account, per peer and globally; a code spoken in public is cancelled at once; a name that is not a plain single line is never a `/tell` target. |
| A bot or a runtime linking an account | Redeeming, checking and removing a link need a signed-in human session (`actor.kind === "session"`); a runtime or link credential is refused with 403/401, and the code is required to carry the character-name preview the human confirms. |
| A cross-site page linking an account | The hosting layer requires the same `Origin` for a cookie write and refuses a write with neither `Origin` nor a credential. |
| Silently stealing a character | One player to one account and the reverse; the existing link must be removed first, and the character is never moved without the human confirming its name. |

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

## API

`Authorization: Bearer <link token>` (a link credential) unless stated.

* `POST /veloren/events` `{events:[…]}` scope `events`: 1 to 20 signed events; per-event result `accepted`, `duplicate` or `rejected` with a reason.
* `POST /veloren/talk` scope `talk`: `{resident_id, player_uuid, player_alias, text}` → `{reply, source: "model"|"scripted", reason?}`.
* `GET /veloren/director` scope `director`: `{mode: "schedule"|"escort"|"return", target_landmark_id, announcements}`. Announcements are handed over once.
* `GET /veloren/progress?player_uuid=` scope `director`: the player's quest steps, each with the event that proved it, and Lyra's notes.

Account linking (`src/veloren-ext/identity.js`), bridge side, scope `director`:

* `GET /veloren/identity?player_uuid=` → `{linked:false}` or `{linked:true, account_id, agent_id, display_name}`.
* `POST /veloren/identity/code` `{player_uuid, player_alias}` → `{code, expires_in_s, redeem_path, player_alias}`. 409 `already_linked` for a player who is already linked.
* `POST /veloren/identity/unlink` `{player_uuid}` → `{unlinked}`.
* `GET /veloren/identity/notices` → `{notices:[{id, player_uuid, kind, display_name}]}`, handed over once (kinds: `linked`, `unlinked_in_nemoworld`).
* `POST /veloren/identity/leaked` `{code}` → `{revoked}`: the bridge reports a code it saw spoken in public chat.

Account linking, human side. These need a signed-in **session** (NemoWorld cookie or operator Bearer token);
the hosting layer already requires the same `Origin` for a write, and a runtime credential is refused with
403 `human_required`:

* `GET /veloren/identity/me` → the link of the signed-in account, or `{linked:false}`.
* `POST /veloren/identity/check` `{code}` → `{valid, player_alias, expires_at}`: the preview step.
* `POST /veloren/identity/redeem` `{code, expect_alias}`: no preview, no link (400 `alias_mismatch`).
* `POST /veloren/identity/remove` `{}` → `{removed}`.
* `GET /veloren/identity/progress` → the linked character's Quiet Survey steps and Lyra's notes. It takes no
  player from the caller.

## Linking a Veloren player to a NemoWorld account

Progress, ownership and value need to know *which* NemoWorld account a Veloren character belongs to.

1. In game the player says **"link my account"** to Lyra (public chat naming her, or a private `/tell`). Who is
   asking comes from the Veloren server's own player list, never from the words.
2. Lyra's bridge asks NemoWorld for a code (its own `director` credential), and delivers it to **that player
   privately with `/tell`**. The code is never said in public chat.
3. The player, **signed in** to NemoWorld, opens `/veloren-link`, types the code, sees which character it is for,
   and confirms. Redeeming needs a human session: a bot, a runtime credential or a link credential cannot.
4. Lyra confirms in game (`/tell`), and the account's page shows the character's Quiet Survey progress.

Codes: 10 symbols from a 30-symbol alphabet without look-alikes (`23456789ABCDEFGHJKMNPQRSTVWXYZ`, ~49 bits),
single use, valid 10 minutes, stored as an HMAC keyed with the event key (a copy of the database cannot be used
to read or guess one), rate limited per player and per bridge credential when issued, and per account, per
network peer and globally when guessed. A code that somebody speaks in public chat is reported by the bridge
and cancelled at once, and every code is scrubbed out of what the rest of the bridge sees (logs, model prompt).
A name from NemoWorld is cleaned and bounded before Lyra says it, and a name that is not a plain single line is
never used as the target of a `/tell`.

One Veloren player maps to at most one NemoWorld account, and one account to at most one player. Nothing is
replaced silently: the old link must be removed first, in game ("unlink") or on the page.

## The first activity: The Quiet Survey (practice quest)

1. **Meet**: stand beside Lyra (server sees you within 8 blocks for 3 s).
2. **Task**: Lyra asks you to walk with her to Harr's farm field.
3. **Survey together**: you and Lyra both inside the field's area for 5 s.
4. **Return**: back at Harr's house with Lyra; she records it and notes it in her memory.

It claims no real-world outcome and awards no coin or Karma. The landmarks are real structures of the Veloren
hamlet Harr; see `content/veloren-landmarks.json` for how NemoWorld's place names map to them.

## Tests

`node --test tests/veloren-link.test.js tests/veloren-relay.test.js tests/veloren-commands.test.js` (16 tests):
signing vector, credentials, forged and tampered events, replay, ordering, restart persistence, chat cannot
advance a quest, model limits and guards, relay resume, crash safety and HTTP scopes. The Veloren side pins the
same signature vector in `nemo-link-proto`.

`node --test tests/veloren-identity.test.js` (29 tests) covers account linking: code alphabet and entropy,
forgiveness of case and separators, hostile player names, the whole flow, codes stored only as a keyed hash,
replay, expiry at exactly ten minutes, replacement of an earlier code, a code spoken in public, binding someone
else's character, one-to-one mapping, banked brute force (per account, per peer, global) with `Retry-After`,
locked-out right code, issuing limits, restart persistence, the fake provider used by other features, and over
HTTP: who may call which route (a human session is not a bridge credential and vice versa; a runtime credential
or an events-only credential cannot link), same-Origin enforcement for cookie writes, a code never reaching a
log or the audit chain, and the page being served with no inline script. The bridge's pure logic
(`parse_intent`, `scrub`, `tell_safe`, `sanitize_display`, message fitting, no code in `Debug`) is unit tested in
`nemo-bridge/src/chat_link.rs`.

## Limits

* Presence proves two characters stood together, not that useful work was done. Treat the quest as practice.
* Backups: `scripts/recovery.js` does not know the link file. Copy `veloren-link.sqlite` (with its `-wal`) while the server is stopped.
* Account linking covers one Veloren character per NemoWorld account (and the reverse). Anything that needs a
  NemoWorld account for a Veloren player (shop, home, atlas, hud) can now import `identityFor`.
* Someone who asks for a code and hands it to another person, who redeems it while signed in as themselves,
  binds that character to the redeemer's account. The page shows the character name first and requires a
  confirmation, and either side can remove the link, but a person who redeems a code they did not ask for links
  someone else's character. Do not redeem a code you did not ask for yourself.
* A notice (in-game confirmation) that is not collected within ten minutes is dropped; the page is the record.
* `veloren-link.sqlite` credentials and progress are local to one NemoWorld instance.
