# AI city foundation — 17 October 2026

Base NemoWorld `d4496ac`; Veloren remains `622dfde`. Feature branch `feat/ai-city-foundation-2026-10-17`.

## Delivered

- `/city`: a guest interface with an AI role/workplace directory, the real configured roster and public-work/research records. Desktop, keyboard and 390px support; no new external assets. The CSS skyline is labelled a vision illustration.
- An existing signed-in, linked human guest can choose a supported free plot and ask Rowan to build a cottage. Existing platform assignment/privacy rules and native signed `home_build`/entry/exit commands are reused. Nothing claims construction succeeded before its acknowledgement.
- Clear registry/native measurements: conceptual 6×6 parcel versus native 14-block pitch/12×12 pad. Optional native ground report filters unsuitable choices; configured malformed/missing reports stop new requests.
- Saved claims and native command status survive restart. Retry preserves the same plot. Command-delivery failure after assignment is recoverable. No plot, account, credential or reward ledger is recreated; main schema stays 27, link schema stays 1.
- Existing incompatible or occupied claims stay intact. New native homes on new **or existing empty** claims get private platform visiting settings. Already requested/confirmed homes keep their chosen visiting setting. Anonymous users see no private home state; runtime/bridge credentials cannot use guest home routes.
- Native Rowan path shares supported-layout and terrain-report checks, refuses saved browser construction, pause and inactive avatars, and keeps the exit path available during world pause.

## Fresh checks

| Check | Result |
| --- | --- |
| Node full regression | 1,787 passed, 0 failed, 0 skipped; 335.7 seconds |
| Home/city/identity focused regression | 59 passed, 0 failed |
| Standard e2e | 20 steps passed, 0 failed |
| Real Chrome city acceptance | 8 passed, 0 failed |
| Syntax | 170 files, 0 failed |
| Content seal | 136 definitions, 3 support files, 42 notices/assets |

The independent reviewer found and reproduced two issues: occupied existing claims bypassing new-claim validation and a new cottage on an existing claim retaining public access. Both have regression tests observed failing before the fix and passing after it. Re-review found no additional blocking finding. The final full Node run includes those regressions and the new paused-native-avatar regression. The later browser-only pending-message correction has a separate failing/passing real Chrome assertion and final syntax check.

## Evidence

`work/verification/ai-city-20261017/` under the main task folder contains gate logs, before/after installation records and desktop/phone screenshots. `test-results/city/` contains the repeatable browser probe output. All automated accounts and world databases are temporary and removed after the probe.

The browser test closes and reopens both SQLite databases, checks private account isolation and submits a home request using Tab/Enter. It simulates the native game's acknowledgement with a signed fixture. **No new native-client GUI construction pass, Rust build, city-district scene pass or public-hosting capacity pass is claimed.** The native command format and binaries are unchanged.

## Remaining vision

This is a completed first release, not the full city simulation. Freeform AI-authored construction, office task execution, modern connected city geometry, household/age/marriage/child simulation, enrollment and evidence-backed career progression are specified in `docs/superpowers/specs/2026-10-17-ai-city-design.md` and remain subsequent work. The old browser world's human work flows are retained; the new guest city flow does not claim a completed global role migration. Native pantry restocking and resident schedules remain labelled scripted.

Human operators still approve permissions, budgets and independent evidence reviews; guest-only play does not delegate that authority to AI. City decoration, social events, home requests and future family milestones cannot mint contribution coins.
