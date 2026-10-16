# NemoWorld Global Map Seams — Proposed Test Matrix & Design Handoff

**Task ID:** A5 — World determinism and saved-state regression tests  
**Base Commit:** `27c0d72`  
**Branch:** `agy/a5-world-determinism`  
**Status of Seam Tests:** **[PENDING IMPLEMENTATION — PENDING CLAUDE’S GLOBAL MAP SLICE]**  
**Status of Determinism Tests:** **VERIFIED PASSING** (`tests/world-determinism.test.js`)  

---

## 1. Executive Summary & Defect Findings

To protect existing saved worlds while Claude builds the continuous Global Map, regression checks were established for:
1. **World Determinism:** Verified that world definitions, terrain, and fixtures across core spaces (`commons`, `hall`, `pavilion`, `gallery`, `meditation`, `library`, `workshop`, `observatory`, `orchard`, `harbor`, districts, country venues, homes, and frontier sectors) generate deterministic, bit-for-bit identical hashes across process restarts.
2. **Walkability Agreement:** Proved exact agreement between server-side `walkable(pos, world)` and client-side voxel scene meshes (`createVoxelScene`).
3. **Collision Defects Discovered in Existing Living World Roster:**
   - **Defect 1 (Harbor Waypoint Collision):** In `src/living-world.js`, Bram Wayfarer (`startX: 50, startY: 40`, and `dawn` destination) and Rowan Commonreach (`dusk` destination) target tile `(50, 40)`. In `commons`, `terrain[40][50] = 'tree'`, making it unwalkable.  
     *Proposed Fix for Feature Owner:* Adjust Harbor waypoint to adjacent walkable meadow tile `(49, 40)`.
   - **Defect 2 (Observatory Waypoint Collision):** In `src/living-world.js`, Bram Wayfarer's `dusk` destination is `{ x: 60, y: 12, label: 'Observatory' }`. In `commons`, tile `(60, 12)` is a tree. The authored Observatory door landmark is located at `(84, 53)`.  
     *Proposed Fix for Feature Owner:* Adjust Observatory waypoint to `(84, 53)` (or nearby plaza path `83, 53`).

---

## 2. Proposed Global-Map Seam Test Matrix

When Claude delivers the global map integration, the following 5 seam tests must be implemented:

```mermaid
flowchart LR
  SectorA["Sector A (e.g. Commons)"] <===>|Seam Boundary\n(Crossing, Visibility, Audio)| SectorB["Sector B (e.g. District East)"]
  Doorway["Legacy Doorway\n(Meeting Hall)"] -.->|Optional Fast Travel| SectorA
```

### Seam Test 1: Bi-Directional Seamless Crossing
- **State:** **PENDING IMPLEMENTATION**
- **Test Invariant:** An avatar walking across the boundary from Sector A (`x=max, y=k`) to Sector B (`x=0, y=k`) steps continuously across the seam without receiving an HTTP 400/409 out-of-bounds error, without falling through the voxel floor (`z=0`), and with instant camera viewport translation.
- **Reverse Invariant:** Walking from Sector B (`x=0, y=k`) back into Sector A (`x=max, y=k`) preserves heading, yaw, and character velocity.

### Seam Test 2: Presence on Either Side
- **State:** **PENDING IMPLEMENTATION**
- **Test Invariant:** Player 1 standing at `Sector A (max-2, k)` and Player 2 standing at `Sector B (2, k)` share an event subscription horizon. Player 1's client renders Player 2's avatar across the visible seam boundary, and motion interpolation updates in real time.

### Seam Test 3: Chat & Emote Horizon Distance
- **State:** **PENDING IMPLEMENTATION**
- **Test Invariant:** Spatial chat and emotes evaluate Euclidian tile distance across global coordinates. If distance $\le 12$ tiles across the seam, proximity chat bubbles and barks appear on both clients. If $> 12$ tiles, messages are culled according to spatial privacy rules.

### Seam Test 4: Return After Restart on Seam Coordinates
- **State:** **PENDING IMPLEMENTATION**
- **Test Invariant:** An avatar standing directly on a boundary seam tile (`x=max, y=k`) disconnects or the server process restarts. Upon reconnection, the saved coordinates restore the avatar to the exact boundary coordinate without clamping or falling back to the default `Welcome Plaza (10, 6)` spawn point.

### Seam Test 5: Legacy Doors as Optional Fast-Travel
- **State:** **PENDING IMPLEMENTATION**
- **Test Invariant:** Existing doorway portals (e.g., `portal(11, 6, 'Meeting Hall', 'hall')`) remain functional as fast-travel waypoints, allowing newcomers or low-bandwidth clients to jump directly between interior spaces without breaking continuous ground navigation.
