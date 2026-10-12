# NemoWorld — DeepSeek work packet

## Copy this instruction before each task

You are working on NemoWorld, a peaceful shared world for humans and AI residents. Each AI has a calling; useful tasks give the world its purpose. The requested civic direction is one NemoWorld AI ambassador for each country, replacing the regional mayor framing.

Inspect the existing code before editing. Keep the established zero-dependency Node 24+, ES modules, node:http, node:sqlite, vanilla browser UI and locally vendored Three.js stack. Do not rewrite the app or install a different engine as a shortcut.

**Source checkout:** `work/Lucy-repo` inside the supplied project folder. **Installed app:** `outputs/Lucy`. Edit the source checkout only. The installed database, backups, local model weights and runtime credentials are private and must be preserved. Use a separate temporary database for testing. No real beneficiary pilot is selected. Research proposals are not completed research or institutional partnerships.

Read `HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/CALLINGS.md`, and the relevant task below. Follow any applicable AGENTS.md. Work on ONE task at a time, on an isolated branch or source copy. Do not overwrite another task's files. Report conflicts rather than replacing files wholesale.

The authoritative world is finite: 16 x 16 areas, 48 x 48 virtual meters each, with 6 x 6 virtual-meter registry plots. Opening an area does not create land outside this perimeter. Calling XP is cosmetic, 5 per objective, at most 10 daily, source-bound and independent of NemoCoins. Coins require independent human acceptance of a real scoped agent contribution. NPCs have no account role, operator credentials or authority to mint rewards. Keep authorization, pause/revocation, budgets, privacy, receipts and independent review intact.

For current factual research, use dated primary sources and retain exact URLs, source locations, access/reuse rights, uncertainties and missing values. Do not invent contacts, claims, endorsements, outcomes or completed tests. Do not send messages or activate real missions without the user's explicit authorization.

Finish with: changed files; explanation; actual tests/commands/results; known limitations; a small Git diff or patch. If you cannot access or run the repository, say so and supply a patch or research artifact with unrun validation instructions. Do not call a proposal or scaffold a completed feature.

## Validation

Use Node 24 or later. On the supplied Mac the verified executable is `../node-bin/node` relative to `work/Lucy-repo`; add its directory to PATH for npm commands. Run relevant tests while implementing, then the release gates:

```sh
npm run check
npm test
npm run e2e
node scripts/seal-content.mjs --check
```

The e2e harness starts and removes its own temporary database. Browser testing uses a separately disposable preview, never installed accounts. Tests involving loopback servers may need local sandbox approval; report that limitation rather than deleting or skipping the tests.

## Work order

**Task 01 — country ambassadors is reviewed.** Start with **Task 02 — first-person physical world coherence**, using the reviewed schema 15 source and its 353-test baseline. Read `docs/reviews/task-01-country-ambassadors.md`; the original Task 01 commit alone omits review fixes. Research and asset tasks can run in parallel with code tasks because their outputs are separate files. One code task should edit a shared backend/UI file at a time.

Detailed copy-and-paste tasks: [TASKS.md](TASKS.md).
