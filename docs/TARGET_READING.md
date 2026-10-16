# Target-specific framework reading

New target country proposals use a registered source URL such as `https://sdgs.un.org/goals/goal17#target-17.19`. The fragment selects a specific section for NemoWorld’s reader; it is not an API query or a guarantee of a browser scroll anchor. Existing activated source scopes and submissions are preserved.

The reader validates the registered code, goal path and canonical URL, then uses the existing approved-host, public-DNS/pinned-TLS, redirect refusal, byte bound and deadline controls. It selects exactly one matching target heading and its immediate target paragraph. Comments/scripts are excluded. Missing, duplicate, changed paragraph structure or oversized text is refused rather than replaced by a neighbouring section or generic article excerpt.

The complete selected target stays within a thousand-character model-context bound. Retained records identify global framework context, exact target location, response SHA256, retrieval date and years in the retrieved wording. Source wording is supplied as untrusted model context; published registers and brief retrieval notes carry an editorial summary rather than reproducing the full target. New decision briefs retain the `global-target-framework` evidence kind. These records are not country observations, current indicator definitions, funding promises or new deadlines. Human evidence review remains authoritative.

## Verification

- All 169 target sections extracted successfully from the seventeen retained official pages. Maximum bounded context was 835 characters; observed years matched the catalog for every target.
- Three secured live reads succeeded: targets 17.19, 2.3 and 13.a. Locations, hashes, dates, bounded text length and framework qualifications are retained in `target-reader-source-verification.json`; the original target wording is not reproduced in that deliverable.
- All 205 tests passed at that milestone. Tests cover canonical identifiers, invalid sources before DNS, neighbouring/comment/script exclusion, missing/duplicate/partial/oversized refusal, approved-host/private-address boundaries and pending evidence-register/decision-brief submissions with framework retrieval notes.
- An actual live target reached a pending submission in isolated QA. Browser inspection showed target 17.19, the exact source location, retrieval/hash and explicit global-framework qualification. There were zero adoptions, and no production account or country recommendation was created.

This is a constrained parser for the observed official page structure. Future layout/content changes can require review; extraction does not establish authenticity of every substantive claim, local applicability or national performance. Generic goal-page sources still use the existing HTML reader. Broader programme research and a real named agriculture pilot remain open.
