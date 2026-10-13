# NemoWorld integration checkpoint — 14 October 2026

Primary source: `integration/nemoworld-completed` at `70359d0` before this note. Schema remains 22. The installed `outputs/Lucy` tree and its database were not written during this integration.

## What is included

- All committed DeepSeek Batch03 mission, cooperative-content, compute-budget, compatibility, Luanti mission/chat and first-play work through `35be30e`. The measurement handoff from `8fe1600` is also present.
- Native bridge pairing and callback integrity, including paired-avatar claim ownership and private message scoping. Real Luanti 5.17 server/mod callbacks passed the mission, conversation and building/movement smoke probes; those probes use synthetic players, not a connected GUI client.
- World-message visibility is filtered before the result limit; private messages are scoped to the viewing avatar. Quest receipts use the credited task/version and permit a later same-task/version retry without inventing completion.
- First-play encounters distinguish a server-recorded chat-capable managed run from unknown availability. A saved message does not promise an AI reply. The conversation overlay now gives the form visual priority on desktop and 390 px phones while keeping the current task reachable.
- The generic world resident refuses research claims and submissions because it has no source reader. The separate approved-source research worker remains the route for source-based drafts and independent review.
- Contributor-supplied hashes cannot create captured evidence. Only server-held, hash-checked bytes can support the `captured` state. Historic hash-only records remain stored and read as unverified; reviewer comparison and UI wording reflect that distinction.

## Gates and scope of evidence

- `npm run check` — pass on `70359d0`.
- `node scripts/seal-content.mjs --check` — 89 definitions, 3 support files, 42 notices/assets on `70359d0`.
- `npm run e2e` — 17/17 on `70359d0`, including two-operator restoration and restart persistence.
- `LUCY_BROWSER_ONLY=quest-progression,reviewer-workbench,review-states-and-refusals,first-ten-minutes,phone-conversation npm run browser` — 5/5 in real Chrome on `70359d0`, disposable SQLite workspace removed, installed database untouched.
- Full `npm test -- --test-concurrency=4` — 888/888 on parent `1c7f5a3`; the subsequent `70359d0` change is presentation and evidence wording in `app.js` and `game-theme.css`. Its focused Node tests passed 42/42 and the relevant real Chrome paths are included in the 5/5 run above.
- Earlier combined branch: 39/39 real Chrome scenarios. This is not a claim that all 39 were rerun on `70359d0`.

## Work still in progress elsewhere

At this checkpoint DeepSeek's `integration/deepseek-master-2026-10-14` is at `35be30e` with uncommitted browser movement-latency instrumentation. Its `content-places`, `farming-depth`, `render-scale`, `security-privacy`, and `test-depth` branches are still at their shared `f773c46` base with live edits in their worktrees. Do not merge uncommitted files or repeat those slices. Review each delivered commit/patch, reconcile against this source tip, then run its relevant gates. The latency scenario needs a return-direction control check; its measurements include paced `/world` audit reads and should not be described as continuous walking latency.

## Remaining product boundaries

This is a tile-based local multiplayer prototype. A real connected Luanti client, large-world controls and performance, reliably available conversational AI, server-retained ingestion of new external research sources, a named beneficiary pilot, and production-scale operation remain unproven. A historic hash-only row cannot be silently upgraded to retained evidence under schema 22's immutable `(source_id, sha256)` identity; use a reviewed new citation/version or an explicit audited migration. No land sale, institutional adoption, MMO scale, or verified real-world impact is implied by these gates.
