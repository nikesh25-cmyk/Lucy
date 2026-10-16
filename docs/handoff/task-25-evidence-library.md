# Task 25 — versioned evidence library and source capture

> Historical handoff. The current implementation no longer treats a contributor-declared or curator-declared hash without retained bytes as `captured` evidence. Such records remain readable but are labelled unverified; see [the current evidence review rule](../EVIDENCE_REVIEW.md#versioned-evidence-and-the-exact-supporting-location). The original delivery details below describe the earlier schema-22 behavior.

Branch `task-25-evidence-library` (worktree `work/t25`), based on `verify-batch02-wave-h` at
**5ba8127** (`Merge branch 'task-24b-generator-gate' into verify-batch02-wave-h`). Schema moves from
**21 → 22**, additively.

The library is built on the **existing retained source bytes** — the 228 files under
`catalog/statistics/**` and the `catalog/agriculture-statistics.json` / `catalog/access-statistics.json`
series that index them. It makes **no new outbound network request**. Every capture re-hashes the
retained file it references on import, so a fact and its bytes can never disagree.

## What changed

| File | Change |
| --- | --- |
| `src/database.js` | Schema 22: `evidence_sources`, `evidence_captures`, `evidence_events`, `submission_evidence`; append-only/immutability triggers; guard bumped to `>22`; `PRAGMA user_version=22`. |
| `src/recovery.js` | `EVIDENCE_LIMITS` and `EVIDENCE_KINDS`; `evidenceSourceKey`; `verifyEvidenceRecords`; accepted version **22**; a `version >= 22` validation block; `RECOVERY_LIMITS.schema_version = 22`. |
| `src/platform.js` | The library: `initEvidence`/`seedRetainedCapture` (import the retained catalog), `registerCapture` (fail-closed capture with quota), `evidenceReserve`/`evictOldest`, `evidenceCapture` (curator), `evidenceWithdraw` (reviewer), `attachEvidence`, `resolveCitation`, `evidenceForSubmissions`/`submissionEvidence`, `draftEvidence`, `evidenceLibrary`. `submit()` pins each cited source; `history()`/`gallery()` attach the evidence view. |
| `server.js` | `GET /evidence`, `GET /evidence/draft`, `POST /evidence/capture`, `POST /evidence/withdraw`. |
| `app.js` | Source entries render state, exact location, hash, retained bytes, provenance, licence and every retained version; the review view gains a bounded **evidence library** panel. |
| `scripts/ops-rehearsal.mjs` | Schema-version assertions moved from 21 to 22 only. |
| `tests/evidence-library.test.js` | New — 12 tests. |
| `tests/evidence-http.test.js` | New — 4 tests. |
| `tests/*.test.js` (23 files) | Only the hard-coded schema-version assertions the bump legitimately moves (21 → 22). |
| `docs/API.md`, `docs/EVIDENCE_REVIEW.md`, `docs/RESEARCH_WORKER.md` | Documented model, states, quota numbers and reviewer path. |

No dependency was added; the production server stays dependency-free by hand-writing the DDL in
`src/database.js` rather than introducing a module.

## The evidence model

A **source** is one identity: `host + path + sorted query`, so two captures of the same WDI series or
the same bounded Comtrade query share one source while different queries stay apart.

A **capture** is one immutable exact version of a source: `sha256` (64 hex), `bytes`, `retained`
(1 when its bytes live under `catalog/`), `retained_path`, `retrieved_at` (a full ISO timestamp or a
date when only a date is known), `declared_date` (the source’s own stated publication date, or empty),
`unit`, `title`, `locator` (the exact page/table/section/clause an reviewer opens), `evidence_kind`,
`provenance`, `license {name,url,attribution}` and an optional `supersedes` link to an earlier version
of the same source. `origin` records where it came from: `catalog` (retained bytes re-hashed on import),
`submission` (the hash a contributor’s reader computed) or `curator` (an administrator).

A **citation** (`submission_evidence`) pins one source number of one submission to the exact capture
it named — or leaves `capture_id` null when the source named no version. A `missing` citation is a
saved link with no capture: it is retained as a link but is **never presented as support**.

The library seeds from the retained catalog on first open (222 captures over 222 sources today); a
populated database is not re-seeded. The identity, the exact version, the retrieval observation and
the reader’s host/DNS/redirect protections are all reused, not re-implemented loosely:
`approvedEvidenceUrl` mirrors `approvedSource`, and the seed refuses to import a file whose bytes do
not hash to the catalog’s declared SHA-256.

## The four states (and the healthy one)

`captured`, `missing`, `stale`, `replaced`, `withdrawn` — computed per citation, never stored as a
summary and never conflated:

- **missing** — no capture exists for the citation. A bare link is not verified evidence.
- **stale** — a newer capture of the same source exists than the one cited; the cited version is unchanged.
- **replaced** — a newer capture explicitly `supersedes` the cited one; the original stays readable.
- **withdrawn** — the source is recorded gone or refusing; every captured version stays exactly as captured.
- **captured** — the cited version is stored and no newer version is retained.

A withdrawal is an observation with a timestamp and reason (`POST /evidence/withdraw`, reviewer/admin);
a later capture records `restored` in the append-only event history and returns the source to `active`.
When two captures disagree on a declared date or a unit, both values stay visible in `declared_dates`
and `units` with `conflict: true` — they are **not** normalised away.

## The quota (stated numbers)

`EVIDENCE_LIMITS` in `src/recovery.js`:

| Bound | Value |
| --- | --- |
| Sources | **2 048** |
| Captures (records) | **8 192** |
| Versions per source | **8** |
| Retained bytes under `catalog/` | **96 MiB** (100 663 296 B); today’s library holds 596 346 B |
| Per-artifact evidence | **10** (the same 1–10 the submission route has always allowed) |
| Excerpt characters | **400** |

**Eviction/retention rule.** When a new capture would exceed a quota, the oldest version of the source
(per-source and total/byte quotas) that **no submission cites** is evicted. A version that any
submission cites is **never** evicted — the foreign key and the eviction query both refuse it — so a
capture that has only cited candidates left **fails closed** with a clear error rather than deleting
cited evidence. This is demonstrated by `tests/evidence-library.test.js` (an uncited oldest version is
evicted; then, with every version cited, the next capture is refused `409` and nothing is stored).

## Fail-closed proof

Every rule is checked **before** a row is written, inside the caller’s transaction, so a refusal leaves
no partial record:

- **Forbidden / private / non-allowlisted host** — `approvedEvidenceUrl` mirrors `approvedSource`:
  non-HTTPS, credentials or a port, a literal IP, `localhost` or `.local`, or a host outside the
  allowlist is refused. The curator route additionally requires the host to be **already registered**
  (the library never adopts a stranger’s host), and the reader itself still refuses a non-allowlisted
  host, a private DNS answer and a redirect (`tests/evidence-library.test.js`).
- **Wrong bytes** — a retained capture re-reads the file under `catalog/` and refuses with `409` when
  its SHA-256 does not equal the declared one; nothing is stored.
- **Over quota** — `evidenceReserve` runs the eviction rule above and fails closed when it cannot make
  room without deleting cited evidence.
- **Malformed record** — the `evidence_captures_validate_insert` trigger refuses a bad hash, a retained
  path outside `catalog/`, an unknown origin/kind, an oversized excerpt or a bad stamp; `submission_evidence`
  is immutable after it is written.

`tests/evidence-library.test.js` exercises each of these against the real platform path.

## Reviewer inspection path

A reviewer opens **Review → Load evidence library** (`GET /api/v1/evidence`), which lists each source,
its status, its versions, the exact supporting location, its licence and how many versions are cited,
within the stated quota. The same per-source evidence is attached to every pending contribution in
`GET /history` and `GET /gallery` (and rendered in the contribution’s source list), so the reviewer
reads the **actual location, hash, retained bytes, retrieval date, declared date, unit, provenance and
licence** rather than a link — and sees `missing`/`stale`/`replaced`/`withdrawn` labelled in words. A
saved draft resolves the same versions for its owner through `GET /api/v1/evidence/draft`, writing nothing.

## Migration and rollback

**Forward (21 → 22).** `openDatabase` creates the four tables, indexes and triggers with
`CREATE … IF NOT EXISTS` and sets `PRAGMA user_version=22` inside its one migration transaction; the
library then seeds from the retained catalog. A pre-change database migrates forward, passes
`validateDatabase` and survives a backup/restore round-trip — proven by the new migration test and by
`tests/ops-rehearsal.test.js`. No existing table, row or trigger is rewritten.

**Rollback.** Schema 22 is purely additive. To return to 21: stop the server, restore the pre-upgrade
backup (`npm run backup` before upgrading; `scripts/recovery.js restore`), or — on a disposable copy —
`PRAGMA foreign_keys=OFF; DROP TABLE submission_evidence; DROP TABLE evidence_events; DROP TABLE
evidence_captures; DROP TABLE evidence_sources; PRAGMA user_version=21`. The old code then reads and
validates the database normally; the evidence layer is simply absent. No other table references it, so
nothing else is lost.

## Gate evidence

Recorded for this branch (`work/t25`, Node v24.19.0, `PATH="$PWD/../node-bin:$PATH"`).

```
$ npm run check
> nemoworld@1.0.0 check
> node --check server.js && node --check scripts/local-launch.mjs && node --check scripts/e2e-smoke.mjs && … && node --check scripts/perf-profile.mjs && node --check scripts/load-harness.mjs
(exit 0)

$ npm test
ℹ tests 595
ℹ suites 0
ℹ pass 595
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 93251.112125

$ npm run e2e
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
(exit 0)
```

Baseline was **579 tests, e2e 15/15, seal 89 definitions, schema 21**; this branch is **595 tests
(+16), e2e 15/15, seal unchanged, schema 22**. `npm run browser` was **not run** (see below).

## Limitations

- The library performs **no fetch**. A capture is either bytes retained under `catalog/` or a
  contributor-declared hash; the server never independently re-reads a live URL. “captured” therefore
  means “an exact version is stored and pinned”, not “independently re-verified today”.
- A `submission`-origin capture carries only what the citation had (URL, hash, location, a date): its
  `declared_date` is usually empty and its `bytes` are 0 (hash-only). The reviewer is told this plainly
  (`retained: false`, “hash recorded; bytes not retained in the library”).
- Withdrawal is an **operator observation** recorded after a browser check; the library cannot by
  itself learn that a public source went away.
- Draft-level pinning is resolved on read (`GET /evidence/draft`) rather than stored per revision,
  because `src/drafts.js` is outside this task’s file ownership; the exact version is stored when the
  draft becomes a submission.
- `scripts/browser-suite.mjs` contains one hard-coded `schema_version === 21` assertion (line 2890).
  That file is outside this task’s ownership, so it was **not** edited; the browser suite would fail on
  that single assertion until its owning task bumps it to 22.

## Residual risks

- A determined tamperer with database write access can still fabricate a self-consistent source,
  capture and citation; the row checks raise the bar to “fabricate the whole subgraph”, not to
  impossible. A hash is an integrity check, not consensus.
- A `submission`-origin hash-only capture trusts the contributor’s reader for the hash. The bytes were
  never sent to the server, so the server cannot re-derive them; the citation is honest about that
  (`retained: false`).
- The quota bounds records and referenced bytes, not the size of the retained catalog itself, which is
  shipped source and outside the library’s write path.
- Eviction deletes **uncited** older versions only; it never deletes a cited one, so the library can
  refuse rather than silently drop support — but an operator cannot force a cited version out without
  first removing the submission that cites it (by design).

## Not done / could not be tested

- **No browser check was run for this task.** No browser scenario was added (another task owns
  `scripts/browser-suite.mjs`), and that file’s hard-coded schema-21 assertion was not edited per the
  file-ownership rules, so `npm run browser` was not run.
- No new outbound network request was made; the retained catalog is reused and re-hashed.
