# Public-launch readiness handoff — 14 October 2026

## Scope

This release prepares a **fresh**, invitation-only NemoWorld pilot on the Render Blueprint. The
Mac installation and its accounts remain separate. The authoritative world is one Node/SQLite
service; an independently operated AI worker connects over HTTPS with a short-lived, scoped
runtime credential and its own local model. No service, payment, public URL, model host or off-host
backup destination was provisioned by this code change.

The integrated source is committed locally. The remote `main` is over 200 commits behind the integrated
branch. A push attempt was refused by GitHub because this machine's Git credentials authenticated
as `Aananda-giri`, which lacks write access to `nikesh25-cmyk/Lucy`. The release must be pushed
using an account with repository access before Render can deploy this version; do not use a
one-click link that reads the older remote `main`.

## Changed behavior

- A newly created Render world starts with registration **closed**. The first administrator still
  needs its private setup code and can issue invitations. Existing databases keep their stored
  registration policy across restarts and upgrades.
- The recovery CLI can generate a private 32-byte key and create, verify and restore an authenticated
  AES-256-GCM backup. It refuses an active server, a replaced archive, an invalid key and changed
  ciphertext. Plaintext staging is temporary and owner-only; a machine crash during export may
  leave staging bytes for an operator to remove. The web administration backup remains plaintext.
- The operations rehearsal now proves report, independent moderation, appeal, resident revocation,
  world pause, restart persistence and recovery on a disposable database. A separate HTTP test
  proves a third operator cannot fetch another pair's private conversation by ID or act on it.
- The Blueprint selects a single paid `1c-2g` instance and 1 GB persistent disk, disables automatic
  deploys and sets initial registration closed. It keeps model keys and worker tokens off the web
  service. The exact price, region and any effect on an existing Render service require a Blueprint
  preview before approval.

## Local verification

All code gates below ran on this release tree with **Node v24.15.0** and disposable databases:

| Gate | Result |
| --- | --- |
| `npm run check` | 93 files, 0 failures |
| `npm test` | 993 pass, 0 fail, 0 skipped |
| `npm run e2e` | 20/20 steps |
| `npm run browser` | 45/45 real Chrome scenarios; shipped database untouched |
| `node scripts/ops-rehearsal.mjs` | 8/8 drills |
| `node scripts/seal-content.mjs --check` | 89 definitions, 42 notices/assets |
| `npm run capacity` | completed, isolated and installed world untouched; 200/200 HTTP reads at each 1/8/32-client level, 8/8 event feeds, both browser concurrency levels passed |

The local capacity probe measured about 49–52 reads/s across its 1/8/32-client levels, but 32-client
read p95 reached **3.69 s**. This is a local workload measurement, not Render capacity or a supported
user count. Model inference was a stub, and no actual hosted model was called. G9–G13 in
`docs/RELEASE_CHECKLIST.md` remain deployment gates and cannot pass on this Mac alone.

## Hosted go/no-go still required

Review the paid Blueprint in the owner's Render account, create a fresh disk, privately set up the
administrator, verify the live HTTPS origin, and keep enrollment invitation-only. Assign moderator,
appeal reviewer and incident contact; approve privacy, terms, assets and mission exemplars. Run one
independent AI worker against the actual hosted origin and prove revocation. Transfer an encrypted
archive to independent storage, keep its key separately and restore it to a disposable installation.
Measure the chosen host under invited pilot traffic before opening public signup.

This is a tile-based shared-world pilot. It is not MMO-scale capacity, a land-sale platform, an
institutional partnership or a claim of verified real-world impact.
