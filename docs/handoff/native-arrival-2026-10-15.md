# Native arrival repair — 15 October 2026

## Report and cause

The screenshot showed the old “NemoWorld Native Slice” behind Luanti's pause menu, with no
visible shared scene. Process inspection traced port 39333 to `work/luanti-bridge` in the separate
13 October checkout, not the integrated release installed for the browser. Its copied mod differed
from the current source. That demo required manual token/character-ID pairing and only projected
terrain after pairing. Its unpaired spawn did not emerge terrain or suspend physics.

The integrated mod now emerges its neutral cache floor on join, suspends movement/gravity until
the first authoritative scene is loaded, and presents local pairing instructions with a short-code
field. `/nemo_connect` reopens it. Invalid input remains local; failed pairing stays visible, and
expired/revoked sessions suspend motion and return to the pairing screen. Saved physics resume
after successful scene reconciliation. No account, grant, plot, contribution or reward is created
by the waiting scene. The original text pairing command remains available.

The local native server was switched to this integrated source, using the existing native cache
and native login records, with `NEMO_API=http://127.0.0.1:3000`. It still listens on loopback UDP
39333; pairing is at `http://127.0.0.1:3999/`. The separate demo Node service was left untouched.
The previous native cache/game was backed up before stopping its identified launcher. No live
NemoWorld database migration or record change was needed.

## Evidence

- The new `native/luanti-onboarding-smoke.mjs` first failed on the original join callback because
  gravity/movement were not suspended. It then passed in a real disposable Luanti 5.17 engine:
  pairing instructions/code input, suspended physics, a real generated floor and safe spawn.
- Bridge authority/pairing tests: **10/10**.
- Full `npm test -- --test-concurrency=3`: **1,466/1,466**, zero failed, cancelled or skipped.
  Syntax: **132 files, zero failed**, plus an explicit check of the new smoke script. Sealed
  content remains **136 definitions**. The browser app and its routes were not changed here;
  the full Chrome suite was not rerun for this native-only repair.
- Real engine regression scripts: **3/3**, covering block placement/removal, saved movement and
  sector crossing, restart reconciliation, mission retry/restart, revoked pairing and scoped chat.
- Installed web API health remains `ok`; the replacement pairing page serves normal account
  sign-in instead of raw operator-token input. The running native mod matches the repaired source.

The onboarding smoke invokes the actual Lua join callback with a synthetic player; it is not a
GUI playthrough. A GUI reconnect using a blank password was refused for the existing native player
“Nik”. The user must enter their existing native password and complete normal account pairing.
No password reset, authentication bypass or copied operator token was used.

## Scope

This native adapter renders **one opened 48×48 frontier sector at a time**, including existing
adjacent sector passages. It does not render the browser's Commons or its 23 connected outdoor
regions. An unpaired waiting scene is not a populated shared world. A native GUI playthrough after
the user's account sign-in remains to be verified.
