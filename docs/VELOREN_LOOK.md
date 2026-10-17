# Harr Look & Public Works Architecture

This document describes the architectural generator, manifest schema, and design patterns for the Harr settlement in NemoWorld/Veloren.

## Generator Overview
The world manifest `content/veloren-world-harr.json` and project catalogue `content/veloren-projects.json` are generated deterministically by `tools/gen-harr-works.py` and `tools/gen-harr-places.py`.

### Automated Verification
`tools/gen-harr-works.py` performs automated checking prior to writing files:
1. **Overlap Detection**: Resolves all 3D bounding boxes to absolute world voxel coordinates across all plots. Confirms 0 duplicate or colliding voxel claims.
2. **Limit Enforcement**:
   - Total group count (current 129, limit 300)
   - Total block count (current 7,185, limit 60,000)
   - Area radius (110, limit 150)
   - Block kinds restricted to `Rock`, `Wood`, `Grass`, `Earth`, `Sand`, `Misc`
   - Permitted sprite list strictly adhered to

## Visual Previews
Run `python3 tools/preview-harr.py` to produce:
- `evidence/look/map.txt`: ASCII top-down overview.
- `evidence/look/map.png`: Pixel-exact 2D top-down view of the entire settlement.
- `evidence/look/elevations.txt`: Front and side elevations for each individual project.

For full architectural standards, palette, and district breakdown, see `docs/HARR_LOOK.md`.
