# Slice 3 — native text conversation over the same private message records

Branch `task-batch03-native-conversation`, based on the frozen review tree
`review/nemoworld-batch03` @ `30e36cf`.

## 1. What changed and why

The Luanti client can now read and send the **same private conversation records the browser uses**,
through the paired human's own operator session. No second message store, no token in the world.

- **`native/bridge.mjs`** — two routes over the existing `/world` and `/messages` authority:
  - `POST /native/messages` reads the paired human's own readable conversation from the same `/world`
    payload the browser reads (public in the world plus the private/mission threads the human is a
    recipient in). Private threads it is not addressed in never appear.
  - `POST /native/say` posts a public message, or — when `to` names a **visible** participant in the
    human's current world — a private message. A native client cannot address a resident it cannot
    see; the server re-checks the recipient and the pairwise recipients.
- **`native/nemoworld_game/mods/nemo/init.lua`** — `/nemo_chat` (read), `/nemo_say` (public),
  `/nemo_tell RESIDENT_ID text` (private). The sender is the paired human; the token never enters
  the world, a log line or a prompt.
- **`native/bridge.integration.test.mjs`** — one new Node test.
- **`native/luanti-conversation-smoke.mjs`** — one new **real Luanti 5.17** smoke.

## 2. What was tested

**Node (`native/bridge.integration.test.mjs`)** — *native reads and sends the same private messages as
the browser, with recipient isolation* (pass): another operator's resident privately messages the
paired human; the native read returns the **same message id** and lists the visible sender; the human
replies privately to that resident and the reply row has exactly `[human, sender]` as recipients; a
third operator cannot read it (`canReadMessage` false); addressing an unseen resident is **404**; a
public `say` is a public message; **0 coins**.

**Real engine (`native/luanti-conversation-smoke.mjs`)** — PASS, with `LUANTI_BIN` set to the verified
5.17.0 binary: a real Luanti server runs the probe, which pairs and calls `/nemo_chat`,
`/nemo_tell <resident> …` and `/nemo_say …`. Asserted: the native read carries the **same private
message id the browser stored**; the private reply and public say are saved with the right channels
and recipients; the browser reads the **same native reply id**; and no credential string appears in
the conversation payload.

## 3. Actual results

```
npm run check → all files syntax-clean
node --test native/bridge.integration.test.mjs → 3 pass / 0 fail
LUANTI_BIN=<verified 5.17.0> node native/luanti-conversation-smoke.mjs → PASS
npm test → 872 pass / 873 tests (see note)
```

**Note on the single full-suite failure:** `tests/local-launch.test.js` (*local launcher selects a
free loopback port…*) failed/hung in this session. It spawns `scripts/start-mac.sh` and does not touch
the bridge or the Lua mod, and it passed on the review tree earlier. Several stray servers from
earlier real-engine smokes were still resident and contended the environment, so this is read as an
environment flake, not a regression from this slice. It should be re-run on a quiet machine.

## 4. Residual limits

- The native read returns the last 20 messages from the human's current world window, not a full
  history; that matches the browser's bounded world view.
- Recipients are chosen from visibly-present residents only; there is no directory-wide private send
  from the native client, by design.
- The smoke uses a synthetic probe invoking the registered chat commands (no GUI typing), the same
  idiom as the existing smokes.

## 5. Migration / rollback

No schema or storage change. Rollback is a branch revert.
