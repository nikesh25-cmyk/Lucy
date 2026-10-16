# Task 01 review — country ambassadors

Reviewed implementation: `e54e961`, branch `task-01-country-ambassadors`, against schema 14 baseline `a2a4e0f`. Review date: 12 October 2026. The original clean branch and its 62-file diff were inspected directly.

## Accepted design

- `amb-<iso3>` is a stable country/area identity. All 248 current catalog ISO3 values are unique.
- A public `country:<iso3>` research venue is a separate shared room. It creates no frontier area, land parcel, stewardship or authored block; it conveys no physical country territory or sale inventory.
- Ambassadors hold fixed stands. The existing 20 compatibility guides retain their patrol and historical records.
- The arbitrary persisted mapping preserves old guide history; it is not a geographic relationship or government affiliation.
- The 20 sealed, licensed portrait sheets are reused. This release does not claim 248 unique portraits or unique venue architectures.
- Legacy API routes remain for compatibility. Canonical ambassador responses attach the assigned country context and numbered evidence.

## Defects corrected before acceptance

| Finding | Correction | Evidence |
|---|---|---|
| Private cached ambassador profile/conversations survived browser sign-out and could render in a later session | Reset profile, privileged directory state and queries; also gate private history rendering on the current session | Extended session-reset regression; browser owner history visible, then no profile/private text after logout; anonymous reopened profile has no history |
| Canonical talk accepted `context:false`, disabling its promised country evidence | Reject caller-provided context overrides; retain context-free legacy answers through an internal-only option | Canonical HTTP 400 regression plus legacy compatibility test |
| Venue button only changed spectator view; residents could not enter via the UI | Separate View country venue and Enter with my resident actions; enforce authoritative Commons/exit travel | Browser player entered country:NPL at 20,25, walked to 20,24 and talked to Nepal |
| Recovery claimed complete country identities but accepted a missing roster entry, altered country label or invalid venue | Validate every row against the retained catalog and each public country venue; require complete roster | New missing-roster, substituted-country and private-venue recovery regressions |
| Moderator UI only controlled the 20 mapped ambassadors | Profile pause/resume and moderator-only inclusion of paused directory entries | Existing real-HTTP pause/privilege tests; browser renders the new profile controls |
| Profile history wrapper appended an undefined disclosure return; question hint overstated natural-language refusal | Use the existing disclosure helper directly; describe fixed country context accurately | Final syntax gate and public profile browser inspection |

## Independently run gates

- `npm run check`: pass.
- `npm test`: **353 tests, 353 passed, 0 failed, 0 skipped**.
- `npm run e2e`: **10 steps, 10 passed**, including 248 ambassadors over five pages, Nepal evidence, mismatch refusal and legacy aliases.
- `node scripts/seal-content.mjs --check`: **86 definitions, 3 support files, 42 referenced notices/assets** verified.
- Browser used a separate temporary database, fictional accounts and scripted guidance. No installed user credentials or model spending were needed. Country search, actual resident entry/walking, private conversation, five evidence cards, owner profile, sign-out clearing and anonymous privacy were observed; browser console had no errors.

Gate logs and a private preservation report are under `work/verification/`, outside the source archive. Browser screenshot: [ambassadors.png](../images/ambassadors.png). Test artifacts are not proof of current external law, country outcomes or government endorsement.

## Integration

The installed schema 14 database is backed up before migration. Old table rows, country-independent authored world state, land and receipt hashes must remain intact. Source-only installation preserves `data/`, private backups and `.runtime/`. Country rows and mappings are additive. The installed source must match the reviewed checkout.

## Next task

Proceed with **Task 02 — first-person physical world coherence**, on top of the reviewed Task 01 source. It shares files with this release and must not start from the original `e54e961` alone. Use `docs/deepseek/TASKS.md` and return a focused diff and actual validation evidence. Leave `outputs/Lucy`, installed accounts/database and local model weights untouched during implementation.
