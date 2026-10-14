# NemoWorld master brief — integration handoff

**Branch** `integration/deepseek-master-2026-10-14` · **worktree**
`work/integ` (`/Users/nikesh/Documents/Codex/2026-10-11/i-ve-prepared-automatic-mac-setup/work/integ`)
· **verified baseline** `46fb135` on `integration/nemoworld-completed` · **first integrated
point** `92d8bcc` · **code tip for every measurement below** `3494a2b`, tree clean, schema **22**
(unchanged throughout) · Node **v24.19.0** (`export PATH="$PWD/../node-bin:$PATH"`).

This document is the §6 handoff of the master brief. It states what was integrated, what was
measured, what is still broken, and what is blocked. Nothing here was published, deployed, purchased
or sent to anyone.

---

## 1. What was integrated, and what was left alone

### 1.1 The base

`46fb135` (the reviewed `integration/nemoworld-completed` tip) → the four delivered Batch 03
candidates were integrated in dependency order. `92d8bcc` is the first point at which all four were
present; everything after it is this session's own work.

### 1.2 Merged and repaired candidates

| Candidate | Branch / commit | How it was integrated | Focused patch |
| --- | --- | --- | --- |
| Batch 03 review queue (mission adapter, private AI reply, cooperative content, phone chat, first-play fixes, compatibility/security tests, four-unit economic policy) | `review/nemoworld-batch03` `30e36cf` (its own merges: `06d5a16`, `ede1bd0`, `8929239`, `00e02da`) | merged into the integration line before this session's first commit; reviewed rather than trusted | `review/nemoworld-queue` history |
| Task 4 acceptance map | `task-batch03-task4-acceptance-map` `d5ca5e6` | merged; it is an acceptance map, **not** a compute-credit ledger or a funded inference entitlement | `task-batch03-task4-acceptance-map.md` |
| Native Luanti mission smoke | `task-batch03-luanti-mission-smoke` `677d20f` | merged at `92d8bcc`; imported, not reimplemented | `task-batch03-luanti-mission-smoke.md` |
| Native text conversation | `task-batch03-native-conversation` (`work/wave-talk`, now clean at 0 dirty files) | committed as `2b30897`, merged at `35be30e` with a union resolution of the `init.lua` conflict | `task-batch03-native-conversation.md` |

### 1.3 This session's own commits (21 on top of `92d8bcc`)

| Commit | What it does | Patch |
| --- | --- | --- |
| `2b30897` | native text conversation over the browser's own message records | `task-batch03-native-conversation.patch` |
| `f980c94` | repairs two confirmed prompt defects (see §4.6) | `task-batch03-*.patch` set |
| `f30297a` | scopes the private chat draft per operator and stops losing it on a failed send | ditto |
| `4b1589d` | pins first-play step survival under bounded-page pressure | `task-firstplay-restoration-read.patch` |
| `35be30e` | merges the native conversation writer | — |
| `c5facb3` | measures one local input to the confirmed step, in the page | `task-b-wave-latency-instrument.patch` |
| `51dfce2` | stops a stale poll from disabling movement and dropping the press | ditto |
| `8edf9c7` | asserts a walkable route to every doorway and frontier gate | `task-b-next-passage-hud.patch` |
| `3c34092` | names the next passage a resident can actually walk to | ditto |
| `78491f8` | shows that next passage in the HUD | ditto |
| `782a98b` | keeps the build tools off the HUD's next-action band | `task-b-hud-build-layering.patch` |
| `4e0a901` | stops the cultivator daily-cap test depending on the wall clock | — |
| `d540f2e` | crosses two connected frontier gates with two humans and one AI (Wave B, first slice) | `task-b-wave-two-gates.patch` |
| `83b9505` | stops a late character selection from overwriting the section a user opened | `task-b-pin-selection-race.patch` |
| `30d8f09` | pins that race with a held world read | ditto |
| `0f2a9ba` | mission quality and abuse-signal module (Wave C) | `task-c-mission-quality.patch` |
| `840648c` | makes the syntax gate cover the tree instead of a hand-written list | — |
| `7eb03e0` | wires the mission-quality signals into the reviewer path | `task-c-quality-wiring.patch` |
| `3ce04e4` | measures write and subscriber capacity, refreshes the performance record | `task-d-capacity-recovery.patch` |
| `8bd2eca` | authors three mission exemplars and checks them in CI | `task-c-mission-exemplars.patch` |
| `3ea39a6` | **Wave B, second slice**: the crossing party chooses callings and leaves one shared saved path | `task-b-wave-shared-change.patch` |
| `3494a2b` | desktop and phone pictures of that world; the release package points at the current capacity record | `task-b-wave-pictures-and-capacity-note.patch` |

### 1.4 Deliberately left alone

- **`outputs/Lucy`, its `data/`, backups, `.runtime/` and the local model weights.** The installed
  application is *running* on `127.0.0.1:3000` (its own `local-launch.mjs`, `server.js` and
  `llama-server`), so its `world.sqlite` and `-wal` change continuously. That is the user's live
  installation, not this session: every gate here runs its own child process against a temporary
  workspace and temporary database, and each one printed `shipped database untouched`.
- **All other worktrees.** 90 git checkouts exist under `work/`; every one of them, including
  `work/wave-talk`, `work/wave-native` and `work/wave-task4`, is at 0 dirty files. No writer was
  active during this session's edits, so no uncommitted work was overwritten or rebased onto.
- **Sealed content.** `node scripts/seal-content.mjs --check` verifies 89 definitions; no sealed
  file was hand-edited.
- **No external action of any kind**: no publication, deployment, purchase, outreach, beneficiary
  activation or real-money movement.

---

## 2. What a player can actually do now

The one polished slice is the Wave B acceptance sentence, and it is now covered by a single real
scenario, `wave-b-two-gates`, driven in Chrome against a disposable database:

1. Two operators (created by the scenario for itself) each create a human avatar; one of them also
   creates an AI resident. All three walk the Commons passage at 19,6 into `frontier:0:0`, arriving
   on 24,24, visible from both browsers.
2. The AI resident's operator records a purpose in its private memory ("Cross both frontier passages
   and keep the shared path open") and the resident reads it back **on its own runtime credential**.
3. The host walks to the up gate and crosses into `frontier:0:-1`; the guest crosses the same gate;
   the AI crosses it three times on the same credential. The second gate (right, in
   `frontier:0:-1` → `frontier:1:-1`) is crossed by all three as well. Every crossing is read back
   as the stored `world_id`, the stored arrival tile and one `world.entered` audit row per operator.
4. The party talks in `frontier:1:-1`: the guest sends a private line through the conversation card,
   the AI sends its own line on its credential, the addressed operator reads both in its browser,
   and a third operator reading the same public sector sees neither.
5. Each of the three chooses a calling — the host's human through the shipped calling card, the
   guest's human and the AI resident through the documented route. Three `resident_callings` rows,
   three `calling.selected` audit rows, the AI reading its own calling back on its runtime credential,
   no coin.
6. The host stewards one assignable plot in the sector it reached (the site is *discovered* from the
   shipped land registry — the seeded frontier reserves the crossroads and every water or
   dense-habitat plot), grants the guest exactly one path block for an hour, and the party walks to
   one staging tile. Each then saves one attributed `path` block: the host through the build panel,
   the guest on its own session inside the grant, the AI on the credential it crossed with. Three
   stored blocks, three distinct creators, two operators, the guest block naming its live grant, and
   all three received by both browsers. The builder and steward callings recognise the saved actions.
7. A real process restart (stop/start against the same database) leaves all three residents on the
   same tile in the same sector, the purpose byte-for-byte unchanged, the three blocks, the three
   callings and the stewardship unchanged, both saved lines addressable, **and no coin minted**.
8. The party leaves `test-results/wave-b-two-gates/desktop.png` and `phone.png` (390 px, asserted to
   fit without horizontal scrolling and to be a real capture over 10,000 bytes).

**Where state persists:** everything above is a SQLite row on the server — `agents`,
`frontier_sectors`, `frontier_blocks`, `land_parcels`, `land_stewardships`, `plot_grants`,
`plot_grant_events`, `messages`, `resident_memory`, `resident_callings`, `calling_receipts`,
`frontier_actions`, `audit`. The browser holds preferences only; a forged `localStorage` completion
record is proven to change nothing (`first-ten-minutes`).

**Native:** the Luanti side has one delivered, integrated callback smoke
(`native/luanti-mission-smoke.mjs`) that the *other* agent ran against a real Luanti 5.17 server for
mission list/claim/submit, idempotent retry, restart and revoked pairing, plus native text
conversation over the same `messages` rows as the browser. See §3 for why this session could not
re-run it.

---

## 3. Gates — actual counts, exactly as run

Run on code tip `3494a2b`, tree clean, on the target machine with the user's own installed
NemoWorld live on `127.0.0.1:3000` (which is part of the background load: **load average 3.40 / 4.04 /
4.62 before the run and 4.21 / 4.40 / 4.75 after it**). Two documentation-only commits follow
`3494a2b`; they add no code and no test, and the operations rehearsal below was re-run after them, on
`0530c0a`.

| Command | Result | Notes |
| --- | --- | --- |
| `npm run check` | **checked 90 files, 0 failed** | the gate named 42 files by hand before `840648c` and now globs the tree; it refuses an empty set, and it was proven non-vacuous by breaking a file in `src/` and watching it refuse |
| `npm test` | **904 tests, 904 pass, 0 fail** | `node --test`, 83.8 s |
| `npm run e2e` | **17 steps passed, 0 failed** | real HTTP against a child server on a temporary database; the shipped server served every step end to end, including the restart-persistence step (`2 objects, 2 pledges and 4 remaining guide steps, byte-for-byte`) |
| `npm run browser` | **45 scenarios, 45 passed, 0 failed** | real Chrome 155; the multiplayer scenarios hold two browsable contexts on one server |
| `node scripts/seal-content.mjs --check` | **Verified: 89 definitions** (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture), 3 support files, 42 referenced notices and assets | |
| `node scripts/ops-rehearsal.mjs` | **7/7 drills passed** | `recovery-point`, `corrupt-backup`, `migration-rehearsal`, `interrupted-worker`, `model-queue-saturation`, `storage-limit`, `diagnostics-redaction`; run on `0530c0a` |
| real Luanti smoke | **NOT RUN — unavailable** | needs `LUANTI_BIN`; no Luanti binary exists on this machine and the pinned archive was not downloaded. The pinned artifact is `luanti_5.17.0_macos12.3_arm64.zip`, SHA-256 `0ba118b537d3cc6fd07cd2268fef25e515fc6d87c27ad69b476144a8e28dba3c`. The delivered native smoke is reported as unverified *here*; it was verified by its own author. |

The same run produced the pictures this report cites:
`test-results/wave-b-two-gates/desktop.png` (1440 × 900, 358,148 bytes — the world the party returned
to, three characters in *Meadow Frontier (1, −1)* with the Builder calling already showing "Place a
saved frontier block" as satisfied) and `test-results/wave-b-two-gates/phone.png` (390 × 844, 88,807
bytes, document width 390 px).

The browser suite is **load-sensitive**. One earlier full run in this session recorded one failure
(`interaction-ambassador-desk`) that did not reproduce: it passed 2/2 in isolation and in the next
full run, and no cause was established, so no cause is claimed. Every load average measured with a
figure in this handoff is stated with that figure.

---

## 4. Evidence

### 4.1 Co-play and travel

Database assertions inside `wave-b-two-gates`: three `agents` rows from two operators, one of them a
runtime-start `kind='agent'` resident; `world.entered` audit rows per operator; stored `world_id` and
arrival tile after each of nine crossings (three residents × three crossings, the AI's twice); the
`frontier_actions` ledger charging the AI's steps to its own runtime credential (37 charged calls).

### 4.2 Conversation

Two `messages` rows stored `private` in `frontier:1:-1` with the right `agent_id`, `account_id`,
`world_id` and recipient list; read by the addressed operator from its own browser payload; withheld
from a third operator reading the same public sector; and the sector's saved lines still addressable
after the restart.

### 4.3 The shared world change

Three `frontier_blocks` rows of type `path`, layer 0, all inside `plot:1:-1:0:5`, with three distinct
`creator_agent_id`s and two distinct `creator_account_id`s; the guest's block carrying `grant_id`;
the stewardship, the grant and the blocks all byte-for-byte identical after a real stop/start; both
browsers reloading all three blocks; and the `builder.frontier_place` / `steward.path_place` receipts
recognising the saved actions.

### 4.4 Mission and coin boundaries

`coin_rewards` is compared, never assumed: choosing a calling, one shared saved path and a restart
each mint **nothing**. `forged-coin-receipt-refused` proves a client-forged receipt cannot reach the
ledger. The 10-coin, 100-per-operator-per-UTC-day, independently-reviewed-only rule is untouched.

### 4.5 Security refusals — an audited map, not a claim

A full read-only audit of the six negative areas the brief requires found **all six already covered**,
in unit/integration, HTTP-over-real-server and real-browser form:

| Area | Representative evidence |
| --- | --- |
| Anonymous observation cannot act; private worlds, conversations and memory unreadable | `tests/spectator-http.test.js:95`, `:131`, `:171`, `:203`; browser `live-observation-readonly` (`scripts/browser-suite.mjs:5161`) |
| Private messages isolated from a third operator, HTTP payload **and** event stream | `tests/private-reply.test.js:47`, `:80`; `tests/realtime-channel.test.js:137`; `tests/spectator-http.test.js:171` |
| Paused / revoked / expired credentials refused; no cached-credential gap | `tests/private-reply.test.js:80`, `tests/first-play-http.test.js:66`, `tests/coin-abuse.test.js:331`, `tests/realtime-channel.test.js:183`, `tests/plot-collaboration.test.js:236`, `tests/http.test.js:58` |
| AI cannot review, adopt or reward its own work | `tests/coins.test.js:17`, `tests/coin-abuse.test.js:357`, `tests/mission-runtime.test.js:155`, `tests/first-play-http.test.js:109`; browser `reward-refusals` (`scripts/browser-suite.mjs:1945`) |
| Duplicate retries cannot double-apply or double-credit | `tests/blueprints.test.js:233`, `tests/community.test.js:66`, `tests/coin-abuse.test.js:80`, `:221`, `tests/inventory-exchange.test.js:84`, `tests/review-states.test.js:114` |
| Restart does not duplicate or lose work; a corrupt store is refused | `tests/startup-integrity.test.js:26`, `tests/resident-crash.test.js:48` (SIGKILL), `tests/recovery.test.js:126` |

**One honest gap in that audit:** the isolation of a private message is proven as *payload absence*
and via `canReadMessage`, and directly for the SSE stream, but no single test drives a third operator
session fetching another pair's private message **by id** over HTTP. That sub-path is "unclear",
not "covered".

### 4.6 The Wave A observed gaps

| Gap named in the brief | Finding |
| --- | --- |
| The AI `submit` example omitted fields the server requires | **confirmed and fixed** (`f980c94`): the prompted example lacked `method`, `limitations` and `rights`, all required at `src/platform.js:501` |
| The private-reply prompt still forbade private messages | **confirmed and fixed** (`f980c94`): the policy sentence forbade the action the same prompt granted |
| Phone/private chat drafts scoped per account, cleared only after a confirmed send, Send reachable at 390 px | **fixed** (`f30297a`); the 390 px panel geometry is asserted by `phone-conversation` |
| Linked-claim first-play/cooperative progress cannot be forged by a client flag | **pinned** (`4b1589d`): forged `localStorage` completion is proven inert under bounded-page pressure |
| Re-run the real Luanti callback smoke | **not re-run here** — no binary; see §3 |

### 4.7 Performance, with hardware and load

From `docs/PERFORMANCE.md` (measured at `7eb03e08d6d8`, schema 22) and re-confirmed in this session's
browser gate:

| Measurement | Result | Workload |
| --- | --- | --- |
| Reads at 1 / 8 / 32 clients | **50.78 / 51.82 / 53.02 req/s**, p95 **60.77 / 274.93 / 3583.25** ms, 0 failures, 0 timeouts | Apple M5, 10 cores, 16 GiB, one process, one SQLite writer, loopback; 10,001 stored agents, 2,000 visits, 2,000 claims — **stored records, not users**; load average 1.78 → 3.07 |
| Movement / building writes | **62.01 steps/s** (paced) and **3,645.28 saves/s** (unpaced) at p95 3.9 ms, 0 failures | 8 movers + 1 builder, own garden, 80 buildable tiles |
| Event subscribers | 8 held SSE subscriptions, delivery p50/p95/p99/max 1/1/2/2 ms | 2 accounts × the 4-per-account bound |
| Input → confirmed step (in the page) | **min 7.2 / median 12.0 / p95 18.9 / max 19.1 ms**, n=24 | the Commons, 12 steps out and back, this session's final browser gate, load average 3.40–4.75 |
| Two-client movement propagation | click → the other client's view in **476 ms**; channel frame delivery 0 ms; animation frames median 16.7 ms, max 16.8 ms over 29 frames | two real browsers, one server |
| Model queue | 9 admitted, 3 refused as saturated, peak waiting 8 of 8; serialized 19.9 inferences/s at a 50 ms **stub** | no real model was called |

**Reading of these numbers:** throughput is flat from 1 to 32 clients while p95 latency compounds —
the binding constraint is the single Node process, and the single SQLite *writer* is refuted for
writes (3,645/s at 3.9 ms p95). The next change is therefore scoped to the crowded-viewport read,
not to a distributed redesign. None of this is a supported simultaneous-user count, and no hostile
traffic, soak, TLS or multi-process behaviour was measured.

---

## 5. Rights, provenance and external references

- **Mission exemplars** (`docs/research/mission-exemplars/`) were authored this session from primary
  sources; each records its sources with hashes and passed the quality module with `missing: []` and
  no near-duplicate. **Their owner and reviewer are declared role slots with no human named** — the
  module can see a label, not a person, and the test asserts `named_owner === false`. Filling those
  slots with an invented person would have been fabrication, so they were left empty and are reported
  as a dependency (§6).
- **No proprietary Minecraft/Mojang code or asset** was copied, and no Sword Art Online character,
  texture or logo was used. Generated decompiler output was never used as a source.
- New external references consulted: [WCAG 2.2](https://www.w3.org/TR/WCAG22/),
  [Luanti modding docs](https://docs.luanti.org/for-creators/creating-mods/) and
  [HTTP API](https://docs.luanti.org/for-creators/api/http-api/), the
  [NIST Generative AI Profile](https://www.nist.gov/itl/ai-risk-management-framework),
  [UN SDG indicator metadata](https://unstats.un.org/sdgs/metadata/) and the
  [FAO Hand-in-Hand data platform](https://www.fao.org/hih-geospatial-platform/about/). **None of
  these implies any affiliation, endorsement or participation.**
- Sealed content still verifies at **89 definitions**; nothing was hand-edited outside the sealing
  workflow.

---

## 6. Known defects, blocked dependencies, public-release limits, next queue

### 6.1 Known defects (honest first)

1. **Wave C has no reviewing human.** The mission-quality module, its wiring and three exemplars are
   done and tested, but no reviewer has assessed the exemplars, and signal dismissals are
   session-scoped only — the additive schema-23 dismissals table and its `recovery.js` validation are
   specified, not built.
2. **No threshold separates good from repetitive proposals.** Measured on the corpus and recorded in
   `docs/MISSION_QUALITY.md`: unrelated work tops out at similarity 0.4464, one-template work starts at
   0.7229, but same-country cross-goal work reaches 0.9563, so the gap is 0.4464 → 0.7229 and 0.6 sits
   inside it — and **1,009 of the 1,015 stored proposals have a closest neighbour ≥ 0.867** while the
   remaining few are ≤ 0.415. The module is therefore advisory by design; it cannot be used as an
   automatic gate.
3. **The shipped backup is not encrypted.** `VACUUM INTO` writes plaintext, proven by planting a
   marker and grepping it back. The brief's "encrypted off-install backup" cannot be met by the
   shipped tool alone.
4. **Moderation/appeal recovery and platform-pause recovery are unmeasured.** The operations
   rehearsal passed **7/7 drills** on the final tip (recovery point, corrupt backup, migration
   rehearsal, interrupted worker, model-queue saturation, storage limit, diagnostics redaction), but
   those two drills were not among them.
5. **The next-passage cue's reason branch is pinned by reading, not exercised**, and the HUD has
   roughly 15 px of headroom before a wrapped line meets the tool host.
6. **The browser suite is load-sensitive** and one unexplained `interaction-ambassador-desk` failure
   occurred once in this session without reproduction. Cause unknown; not attributed.
7. **Native verification is one-sided on this machine.** The native mission smoke and native
   conversation are integrated and were verified by their author against a real Luanti server; this
   session could not re-run either.

### 6.2 Blocked

- **Real Luanti smoke** — blocked on a Luanti binary. The pinned archive was not downloaded because
  the user has declined that download; the decision is theirs.
- **Any real-world adoption or outcome** — blocked on a consenting beneficiary, owner and independent
  reviewer. Until then, no mission is activated and no external result is claimed.

### 6.3 Public-release limits

Hosted TLS, hostile traffic, soak and memory-growth testing, independent security review, moderation
and appeal staffing, off-install encrypted recovery, and funded hosting are **separate release gates**
and none of them is satisfied by local tests. There is still **no authorized commercial land sale and
no cash value for NemoCoins**; the four units (NemoCoins, proposed compute credits, money, verified
carbon credits) remain separate with no conversion path.

### 6.4 Next queue, with owner and file boundaries

1. **Wave C reviewer step** — owner: `src/vocabs`-adjacent reviewer surface + `src/database.js`
   (schema 23, one owner) + `src/recovery.js` + `scripts/browser-suite.mjs`. Build the dismissals
   table, its recovery validation and one browser walkthrough in which a human reviews an exemplar.
2. **Crowded-viewport read** — owner: `src/spaces.js` / `src/platform.js`. Remove the remaining
   `COUNT(*) OVER ()` and the N+1 `mayors()`/avatar-summary read, then re-run the load harness and
   update `docs/PERFORMANCE.md`. This is the measured constraint.
3. **Encrypted off-install backup** — owner: `src/recovery.js` + `docs/OPERATIONS.md`. Choose an
   approach that works without new runtime dependencies, or state plainly that it needs one.
4. **Moderation/appeal and platform-pause drills** — owner: `scripts/ops-rehearsal.mjs` +
   `docs/OPERATIONS.md`.
5. **Third-party private-message fetch by id** — owner: `tests/private-reply.test.js`. Close the one
   "unclear" sub-path from §4.5 with a direct refusal test.
6. **Native re-verification** — owner: the Luanti agent. Re-run both native smokes on a machine with
   a pinned Luanti binary and record its path and version; only then can the native claims join the
   browser claims in the gate table.
7. **Consenting first beneficiary** — owner: Nikesh. Until a named beneficiary, owner and reviewer
   exist, the mission ladder stops at `owner-approved mission` and no adoption or outcome is claimed.
8. **Country venue depth and broader content** — owner: `src/scene/*` + `world.js` + the art queue.
   Eight distinct venues, authored activities and a licensed asset pipeline, one owner for
   `app.js`/`index.html`/main styles.

### 6.5 What this session did not do

It did not finish an MMO, continuous physical simulation, multi-instance capacity, 248 unique
venues, land commerce or verified institutional impact. It produced a reviewable integrated branch
with one honestly proved 60-minute slice, a measured performance record, an advisory mission-quality
layer with three real exemplars, and a precise queue for the rest.
