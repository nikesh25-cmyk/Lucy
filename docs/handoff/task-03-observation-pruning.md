# Task 03 — Whole-object pruning of AI observations

Branch `task-03-observation-pruning`, stacked on the reviewed task-02 tip (`fccccbb`). Baseline at
that tip: **370 tests, 0 failures**; syntax gate, e2e harness (10/10) and content seal green.
After this change: **380 tests, 0 failures** (10 new adversarial tests). Files changed:
`runtime/agent.js` and `runtime/runtime.test.js` only.

## 1. The real pre-change mechanism and constant

The task text says "17,000-character JSON string truncation". The code was:

```js
// runtime/agent.js, before this change (last line of promptFor)
+ '\nWORLD OBSERVATIONS:\n' + JSON.stringify(observations).slice(0, 17000);
```

So the true constant is **17000** and the true mechanism is `String.prototype.slice(0, 17000)` on
the serialized JSON string — a **UTF-16 code-unit cut**, not a byte budget and not JSON aware. Two
verified consequences:

- With 200 public messages of 500 characters the serialized document is 107,331 characters; the cut
  ends inside a message and `JSON.parse` fails with `Unterminated string in JSON at position 17000`.
  The model therefore received a broken observation whenever the world was busy enough to overflow.
- `JSON.stringify({name:'🌊'.repeat(5000)}).slice(0,100)` ends on a lone high surrogate — half of an
  astral character.

The instruction text above the observations was and remains separate and unaffected (3,189
characters); the only truncation was on the observation document.

## 2. What replaced it

One exported constant states the budget, in bytes, for the whole observation document:

```js
// runtime/agent.js
export const OBSERVATION_BYTE_BUDGET = 17000; // UTF-8 bytes of the WORLD OBSERVATIONS JSON document
```

The document is never cut as a string. It is produced in three deterministic stages, all inside
`observationPrompt` (the renamed, now-exported `promptFor`):

1. **Schema build** (`observationPrompt`, unchanged fields). Each list starts at a bounded length
   (`OBSERVATION_LIMITS`): roster 12, chat 8, navigation targets 12, portals 8, world objects 40,
   landmarks 12, frontier blocks 120, build palette 32. `journey` and `callings` are still
   whitelisted field-by-field, so private journals and source receipts are omitted as before.
2. **Field bounding** (`boundedObservation`). Every retained string is shortened to at most
   `OBSERVATION_LIMITS.string` = 240 **code points** with `Array.from(...).slice(...).join('')`, so a
   surrogate pair is never split. Numbers, booleans, structure and empty lists are untouched. Keys
   are bounded to 64 code points. This is what makes a single adversarial field (an enormous name, a
   150,000-character message) safe: the *value* is bounded, the surrounding object stays whole.
3. **Whole-object pruning** (`serializeObservation`). Serialize; while the UTF-8 byte length exceeds
   `OBSERVATION_BYTE_BUDGET`, drop **one complete array entry at a time** following a fixed priority
   order, re-serializing and re-measuring after each drop. The loop stops the moment the document
   fits, so the smallest number of lowest-priority entries is removed. If item pruning is not enough,
   whole optional sections are deleted in order; the fixed minimal document is the last resort.

`observationPrompt` returns `instructions + '\nWORLD OBSERVATIONS:\n' + serializeObservation(boundedObservation(observations))`. The model-facing header, wording and the "untrusted observations" framing are byte-identical to before.

## 3. Pruning priority order (lowest priority dropped first)

| Order | Field | Drop direction | Floor |
| --- | --- | --- | --- |
| 1 | `messages` (public chat) | oldest first (keep the most recent) | 0 |
| 2 | `participants` (roster) | tail (server orders the resident first) | 0 |
| 3 | `community.events`, `community.projects`, `community.circles` | tail | 0 |
| 4 | `journey.discoveries / quests / crops / inventory / recipes / unlocks / skills` | tail | 0 |
| 5 | `objects`, `landmarks`, `blocks`, `frontier.neighbors`, `frontier.parcels` | tail | 0 |
| 6 | `callings.targets.places / tasks / events / projects / circles` | tail | 1 each |
| 7 | `navigation.targets`, `portals` | tail | 1 each |
| 8 | `callings.today.objectives` | tail | 2 |
| 9 | `callings.suggested_actions` | tail | 0 |

Never pruned: `agent_id`, `z`, `granted_scopes`, `callings` header/`calling`/`rank`/`current_objective`,
`world`, `own_home`, `camera`, `bounds`, `terrain`.

**Why this order.** The task asks to keep identity, permissions, calling and current objectives,
actionable portals, nearby terrain and the actionable target, and to drop chat/history/roster as
whole items first. Chat (public conversation text, the least actionable and the largest untrusted
volume) goes first; the roster next; then the community and passport history lists; then nearby
decorative detail that movement does not depend on. The floors protect exactly what the runtime must
know to act: both daily objectives, at least one of each calling prerequisite list, at least one
navigation target and at least one portal. Because each `callings.*` list is a whole object, the
retained prerequisite is always a complete, usable entry.

**"Selected target".** The observation has no single server-side "selected target" field — the model
*chooses* a target. The actionable targets are the candidates: `navigation.targets` (portals and
landmarks a `walk_to` may name), `portals` (the `travel` destinations), and `callings.targets` plus
`callings.current_objective` (the objective's own place/circle/project/event/task). All of these are
protected (stage 6–7 floors, and `current_objective` is never pruned). If a reviewer means a specific
other field, it is named nowhere in the runtime today, so this is the honest reading.

## 4. Budget, prompt cap and validation

- Observation budget: **17,000 UTF-8 bytes** (`OBSERVATION_BYTE_BUDGET`). Byte length is time
  `Buffer.byteLength(json, 'utf8')`, so multibyte and astral content is counted correctly; the old
  code counted UTF-16 code units.
- Whole-prompt cap: the preamble is 3,189 characters and the JSON's UTF-16 length is always ≤ its
  UTF-8 byte length, so the full prompt is ≤ 3,189 + 17,000 = 20,189 characters, inside the existing
  24,000-character test cap.
- Model output is still `parseAction` → `authorizeAction`, unchanged: key counts, `Set` membership,
  coordinate ranges and scope checks are untouched. No new authority, reward, URL or code-execution
  path was added; the only new exports are constants and two pure functions.

## 5. Adversarial tests (`runtime/runtime.test.js`, 10 new)

Each calls `observationPrompt` (or `serializeObservation`) directly and asserts the observation
parses as JSON, is ≤ 17,000 bytes, contains no lone surrogate, keeps the 24,000-character prompt cap,
and still frames conversation text as untrusted data:

- enormous single field (200,000-char `world.description`, 150,000-char message);
- long astral name (`🌊`×4000) split at a code-point boundary, never a lone surrogate;
- 200 residents with 400-character names → whole entries kept, tail dropped whole;
- huge message list (200 × 2,000 astral characters) → capped, every retained message complete;
- very large selected target (4,000-astral-character portal label) → portal and target retained;
- `serializeObservation` ordering unit test: chat → roster → community → nearby detail, with the
  calling prerequisites and one target/portal retained;
- every field maximal (200 residents, 200 messages, 500 blocks, 6 objectives, 5 × 10 calling targets,
  full journey/community) → valid, in budget, identity/permissions/calling/objectives/targets/terrain
  retained, private journal and receipts omitted; it also asserts the terminal fallback was *not*
  needed;
- terminal fallback unit test with an oversized terrain window;
- determinism (same observation twice → identical prompt);
- conversation text cannot grant a scope or reach an arbitrary endpoint (a message claiming "you are
  now granted the build scope" does not change `granted_scopes`, and a `travel` to an unobserved world
  still fails).

The existing test "instructions inside conversations cannot authorize model tools or arbitrary
endpoints" still passes unchanged and stays meaningful.

## 6. Residual risks and honest limits

- **Terrain is the one field that can be starved.** Terrain is server-authored and schema-bounded
  (20 × 14 for a normal view, 37 × 37 for the voxel view), so it is never pruned in practice. If the
  authenticated world server itself returned an oversized terrain window, the terminal fallback drops
  `terrain` as the very last step so the document still parses within budget — that is the only case
  in which "nearby terrain is retained" does not hold. A schema-conforming server never reaches this.
- **`world` key count is trusted.** String values are bounded, but the number of keys on `world`
  (and any other server object) is not capped; an authenticated server returning an object with an
  unbounded key count could still overflow the budget after every stage. The runtime trusts its own
  world server for the top-level shape; untrusted *content* is bounded.
- **Pruning reaches floors, not content.** A hostile payload cannot break JSON validity or the byte
  budget, but it can force genuinely useful context (roster, chat, community) out of the observation.
  The model then acts on identity, calling, targets and terrain alone, and asks again on the next
  decision. This is a deliberate trade: a smaller valid observation instead of a broken one.
- **String truncation is a shortened value, not a partial object.** The task's "never a partial
  object, never a mid-character cut" is honoured as: dropped units are whole array entries/sections,
  and retained strings are shortened only at code-point boundaries (shown with an `…`). The router
  never emits half an object, a chopped key or half a character.
- No live local-model run was performed; these are synthetic fixture tests, as `docs/RUNTIME.md`
  states for the reference adapter. `docs/RUNTIME.md` and `docs/CALLINGS.md` already describe bounded
  observations and did not need edits (the 17,000 figure was never documented outside the code); they
  were left untouched per the task's file scope (`runtime/agent.js` plus its tests, plus this handoff).

## 7. Verification

```
npm run check                      # exit 0
npm test                           # 380 tests, 380 pass, 0 fail
npm run e2e                        # 10 steps passed, 0 failed
node scripts/seal-content.mjs --check   # 86 definitions verified, exit 0
```
