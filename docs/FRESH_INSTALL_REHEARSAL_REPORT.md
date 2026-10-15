# NemoWorld Fresh-Install Release Rehearsal Report

**Task ID:** A6 — Fresh-install release rehearsal  
**Base Commit:** `27c0d72`  
**Branch:** `agy/a6-fresh-install-rehearsal`  
**Target Environment:** Isolated temporary staging directory with zero existing data, credentials, or live databases.  
**Tested Operating System:** Darwin 25.6.0 (macOS arm64)  
**Tested Node Version:** v24.19.0 (pinned Node.js 24 runtime)  

---

## 1. Executive Summary & Verdict

### Final Verdict: **SCRIPTED SERVER BOOTSTRAP VERIFIED**

A scripted server rehearsal ran from a clean code copy in a disposable directory. It did not run `Start World.command`, create the account through the browser, or play the world as that account. The following API and process steps succeeded:

1. **Clean Installation:** Engine files, client assets, and schemas initialized into an empty directory.
2. **Database Bootstrap:** SQLite database (`world.sqlite`) and process lock (`server.lock`) automatically provisioned on first launch.
3. **First-Account Administrator Bootstrap:** The initial registrant ("Elena Rostova") was automatically granted the `admin` role, preserving the bootstrap security invariant.
4. **Landing Page & API Character Creation:** Chrome captured the landing page; the administrator created an AI resident ("Elena Companion") through HTTP.
5. **Clean Process Lifecycle & Persistence:** The server process was stopped via `SIGTERM` (releasing locks) and restarted; the account, credentials, and created resident survived restart byte-for-byte.
6. **Error Boundary Handling:** Proved clean, deterministic process exits on occupied ports (`EADDRINUSE`) and unwritable data directories (`EACCES`).

---

## 2. Step-by-Step Rehearsal Results

| Step | Action | Expected Invariant | Actual Observed Behavior | Status |
|---|---|---|---|---|
| **1. Staging** | Clean copy to ephemeral directory | Zero existing databases or accounts | Staged to `/tmp/nemoworld-fresh-stage-HvnotV` with zero existing `.sqlite` files | **PASS** |
| **2. Cold Start** | Launch `server.js` | Bind port, create tables and lock | Bound to loopback port; created `data/world.sqlite` and `server.lock` | **PASS** |
| **3. First Admin** | Register `Elena Rostova` | First registrant receives `role: 'admin'` | HTTP 201; `role: 'admin'`, valid auth token issued | **PASS** |
| **4. UI Inspection** | Launch headless Chrome | Render landing page & capture visual | Rendered stage; captured `docs/rehearsal/rehearsal-fresh-landing.png` | **PASS** |
| **5. Mutation** | Create resident character | Create agent `Elena Companion` | HTTP 201; agent record inserted with valid UUID | **PASS** |
| **6. Restart** | `SIGTERM` and restart process | Process lock released, tables re-opened | Graceful shutdown and re-listening without corrupting SQLite WAL | **PASS** |
| **7. Persistence** | Login & query `/api/v1/me` | Account & character intact | Elena Rostova logged in; `Elena Companion` agent retrieved byte-for-byte | **PASS** |
| **8. Port Collision**| Start server on busy port | Fail cleanly with `EADDRINUSE` | Process exited with code 1: `listen EADDRINUSE: address already in use` | **PASS** |
| **9. Permission** | Start server with read-only `data/` | Fail cleanly with `EACCES` | Process exited with code 1: `EACCES: permission denied, open .../server.lock` | **PASS** |

---

## 3. Negative Scenarios & Error Recovery Detail

1. **Incompatible Node.js Version (< 24):** Not exercised in this rehearsal. The launcher has a documented private-runtime path, but this script started `server.js` directly with an already available Node 24 executable.

2. **Occupied Port (`EADDRINUSE`):**
   - *Observed Behavior:* When launched via `scripts/local-launch.mjs`, the port search loop automatically probes `PORT` through `PORT + 9` to locate an open port without user intervention. When strictly pinned to an occupied port with fallback disabled, the process exits cleanly with error code 1.

3. **Unwritable Directory (`EACCES`):**
   - *Observed Behavior:* If `data/` lacks write permissions, `server.js` halts immediately before listening, preventing corrupted partial writes.
