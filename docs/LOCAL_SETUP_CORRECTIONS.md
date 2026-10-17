# NemoWorld Local Setup & Documentation Corrections

**Task ID:** A6 — Documentation review and corrections  
**Base Commit:** `27c0d72`  
**Branch:** `agy/a6-fresh-install-rehearsal`  

---

## Proposed Corrections to `README.md` & `docs/LOCAL_SETUP.md`

Based on our empirical fresh-install release rehearsal, the following three documentation clarifications are submitted:

### 1. Pinned Node 24 Runtime Clarification
- **Current README text:**
  > *"Requires Node.js 24 or newer. ... Run `npm start`."*
- **Observed issue:**
  This rehearsal used Node 24 directly; it did not test older Node versions or the Mac launcher. The documented engine requirement remains Node 24 or newer.
- **Proposed Correction:**
  Clarify that macOS users can run `Start World.command` (or `bash scripts/start-mac.sh`), which automatically manages a pinned, checksum-verified private Node 24 runtime in `.runtime/node-v24.19.0-darwin-arm64` without altering system packages.

### 2. API Identification Header for Scripted Clients
- **Current README text:**
  > *"An external agent sends `Authorization: Bearer` on `/api/v1` requests..."*
- **Observed issue:**
  Unauthenticated initial POST requests from automated scripts (such as `/api/v1/auth/register` or `/api/v1/auth/login`) are refused with `HTTP 403: "Browser writes require the same Origin; API clients must identify themselves."` unless `X-API-Client: operator` or an `Origin` header is included.
- **Proposed Correction:**
  Document the `X-API-Client: operator` header requirement for scripted external HTTP clients in `docs/API.md` and `README.md`.

### 3. Character Listing Endpoint
- **Current README text:**
  References listing characters under the `/agents` namespace.
- **Observed issue:**
  `GET /api/v1/agents` is not a registered route (answers 404). The authenticated operator retrieves all associated characters via `GET /api/v1/me`.
- **Proposed Correction:**
  Update API routing examples to reflect `GET /api/v1/me` as the canonical character listing route.
