#!/usr/bin/env python3
"""preview-harr.py: Generates top-down ASCII/PNG maps and per-project side elevations.

Reads content/veloren-world-harr.json, computes global voxel layouts, and outputs:
- evidence/look/map.txt (Top-down ASCII layout)
- evidence/look/map.png (Top-down pixel-accurate RGB map)
- evidence/look/elevations.txt (Side elevations for all 36 projects)
"""

import json
import os
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLOT_OFFSETS = {
    ('Plaza', 0): (0, 0),
    ('House', 0): (12, 30),
    ('FarmField', 0): (18, 48),
    ('FarmField', 1): (12, 6),
    ('Workshop', 0): (-6, 18),
}

def generate_previews():
    manifest_path = ROOT / 'content' / 'veloren-world-harr.json'
    manifest = json.loads(manifest_path.read_text())
    
    # Target evidence directories
    evidence_dirs = [
        ROOT / 'evidence' / 'look',
        ROOT.parent / 'evidence' / 'look',
    ]
    for ed in evidence_dirs:
        ed.mkdir(parents=True, exist_ok=True)
        
    # Project voxels: pid -> list of (x, y, z, kind, rgb) in local project coords
    # Global voxels: (gx, gy) -> (gz, kind, rgb, pid)
    project_voxels = {}
    global_voxels = {}
    
    for g in manifest.get('groups', []):
        pid = g.get('project', 'other')
        if pid not in project_voxels:
            project_voxels[pid] = []
            
        anchor = g.get('anchor', {})
        plot = anchor.get('plot', 'Plaza')
        nth = anchor.get('nth', 0)
        p_dx, p_dy = PLOT_OFFSETS.get((plot, nth), (0, 0))
        g_dx = anchor.get('dx', 0)
        g_dy = anchor.get('dy', 0)
        
        base_x = p_dx + g_dx
        base_y = p_dy + g_dy
        
        for op in g.get('ops', []):
            op_name = op.get('op')
            if op_name == 'fill':
                kind = op['kind']
                rgb = op['rgb']
                x0, y0, z0 = op['from']
                x1, y1, z1 = op['to']
                for x in range(min(x0, x1), max(x0, x1) + 1):
                    for y in range(min(y0, y1), max(y0, y1) + 1):
                        for z in range(min(z0, z1), max(z0, z1) + 1):
                            gx = base_x + x
                            gy = base_y + y
                            project_voxels[pid].append((x, y, z, kind, rgb))
                            # Keep highest z for top-down
                            if (gx, gy) not in global_voxels or global_voxels[(gx, gy)][0] < z:
                                global_voxels[(gx, gy)] = (z, kind, rgb, pid)
            elif op_name == 'foundation':
                kind = op.get('kind', 'Earth')
                rgb = op.get('rgb', [110, 84, 60])
                depth = op.get('depth', 3)
                x0, y0 = op['from']
                x1, y1 = op['to']
                for x in range(min(x0, x1), max(x0, x1) + 1):
                    for y in range(min(y0, y1), max(y0, y1) + 1):
                        for z in range(-depth, 0):
                            gx = base_x + x
                            gy = base_y + y
                            project_voxels[pid].append((x, y, z, kind, rgb))
                            if (gx, gy) not in global_voxels or global_voxels[(gx, gy)][0] < z:
                                global_voxels[(gx, gy)] = (z, kind, rgb, pid)

    print(f"Loaded {len(project_voxels)} projects, {len(global_voxels)} top-down surface columns.")
    
    # 1. Generate ASCII Top-down Map
    min_x = min(x for x, y in global_voxels.keys()) - 2
    max_x = max(x for x, y in global_voxels.keys()) + 2
    min_y = min(y for x, y in global_voxels.keys()) - 2
    max_y = max(y for x, y in global_voxels.keys()) + 2
    
    KIND_CHARS = {
        'Rock': '#',
        'Wood': '=',
        'Grass': '"',
        'Earth': '.',
        'Sand': '~',
        'Misc': '*',
    }
    
    ascii_lines = []
    ascii_lines.append(f"HARR TOP-DOWN MAP: X range [{min_x}, {max_x}], Y range [{min_y}, {max_y}]")
    ascii_lines.append("Legend: #=Rock/Stone, ==Wood, \"=Grass, .=Earth, ~=Sand, *=Misc, +=Empty Plaza")
    ascii_lines.append("-" * 80)
    
    # Y from max to min (North to South)
    for y in range(max_y, min_y - 1, -1):
        row = []
        for x in range(min_x, max_x + 1):
            if (x, y) in global_voxels:
                z, kind, rgb, pid = global_voxels[(x, y)]
                # Differentiate glass/solar
                if rgb == [30, 70, 115]:
                    row.append('@')  # Solar
                elif rgb == [120, 190, 215]:
                    row.append('%')  # Glass
                else:
                    row.append(KIND_CHARS.get(kind, '#'))
            elif x == 0 and y == 0:
                row.append('0')  # Plaza Center
            elif abs(x) <= 10 and abs(y) <= 10:
                row.append('+')  # Central Plaza area
            else:
                row.append(' ')
        ascii_lines.append(f"{y:+4d} | " + "".join(row))
        
    map_ascii_content = "\n".join(ascii_lines)
    for ed in evidence_dirs:
        (ed / 'map.txt').write_text(map_ascii_content)
    print("Wrote top-down map.txt")
    
    # 2. Generate PNG Map (Pure Python PNG generator)
    width = max_x - min_x + 1
    height = max_y - min_y + 1
    
    # Raw RGB data
    raw_rows = []
    for y in range(max_y, min_y - 1, -1):
        row_bytes = bytearray(b'\x00')  # Filter byte 0 (None)
        for x in range(min_x, max_x + 1):
            if (x, y) in global_voxels:
                z, kind, rgb, pid = global_voxels[(x, y)]
                row_bytes.extend(bytes(rgb))
            elif abs(x) <= 12 and abs(y) <= 12:
                # Pale plaza paving
                row_bytes.extend(bytes([210, 215, 220]))
            else:
                # Deep grassy ground background
                row_bytes.extend(bytes([55, 95, 45]))
        raw_rows.append(bytes(row_bytes))
        
    def write_png(filepath, w, h, rows):
        def chunk(tag, data):
            return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
            
        header = b'\x89PNG\r\n\x1a\n'
        ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) # 8-bit truecolor RGB
        compressed = zlib.compress(b''.join(rows), 9)
        idat = chunk(b'IDAT', compressed)
        iend = chunk(b'IEND', b'')
        filepath.write_bytes(header + ihdr + idat + iend)

    for ed in evidence_dirs:
        write_png(ed / 'map.png', width, height, raw_rows)
    print("Wrote top-down map.png")
    
    # 3. Generate Per-Project Side Elevations
    elevation_lines = []
    elevation_lines.append("=" * 80)
    elevation_lines.append("HARR PUBLIC WORKS: PROJECT SIDE ELEVATIONS (SOUTH & EAST FACES)")
    elevation_lines.append("=" * 80 + "\n")
    
    for pid in sorted(project_voxels.keys()):
        voxels = project_voxels[pid]
        if not voxels:
            continue
            
        px_min = min(v[0] for v in voxels)
        px_max = max(v[0] for v in voxels)
        py_min = min(v[1] for v in voxels)
        py_max = max(v[1] for v in voxels)
        pz_min = min(v[2] for v in voxels)
        pz_max = max(v[2] for v in voxels)
        
        elevation_lines.append(f"PROJECT: {pid}")
        elevation_lines.append(f"Footprint: X [{px_min:+d}..{px_max:+d}], Y [{py_min:+d}..{py_max:+d}], Z [{pz_min:+d}..{pz_max:+d}]")
        elevation_lines.append(f"Total Blocks: {len(voxels)}")
        
        # South Elevation (Looking North along +Y axis, showing X on horizontal and Z on vertical)
        elevation_lines.append("\n  [South Elevation (X-Z View)]")
        # Find highest Y for each (X, Z) to see frontmost block from south (min Y)
        south_view = {}
        for x, y, z, kind, rgb in voxels:
            if (x, z) not in south_view or y < south_view[(x, z)][0]:
                south_view[(x, z)] = (y, kind, rgb)
                
        for z in range(pz_max, pz_min - 1, -1):
            row = []
            for x in range(px_min, px_max + 1):
                if (x, z) in south_view:
                    y, kind, rgb = south_view[(x, z)]
                    row.append(KIND_CHARS.get(kind, '#'))
                else:
                    row.append(' ')
            elevation_lines.append(f"  Z={z:+2d} | " + "".join(row))
        elevation_lines.append("  " + " " * 7 + "-" * (px_max - px_min + 1))
        
        # East Elevation (Looking West along -X axis, showing Y on horizontal and Z on vertical)
        elevation_lines.append("\n  [East Elevation (Y-Z View)]")
        east_view = {}
        for x, y, z, kind, rgb in voxels:
            if (y, z) not in east_view or x > east_view[(y, z)][0]:
                east_view[(y, z)] = (x, kind, rgb)
                
        for z in range(pz_max, pz_min - 1, -1):
            row = []
            for y in range(py_min, py_max + 1):
                if (y, z) in east_view:
                    x, kind, rgb = east_view[(y, z)]
                    row.append(KIND_CHARS.get(kind, '#'))
                else:
                    row.append(' ')
            elevation_lines.append(f"  Z={z:+2d} | " + "".join(row))
        elevation_lines.append("  " + " " * 7 + "-" * (py_max - py_min + 1))
        elevation_lines.append("\n" + "-" * 60 + "\n")

    elevations_content = "\n".join(elevation_lines)
    for ed in evidence_dirs:
        (ed / 'elevations.txt').write_text(elevations_content)
    print("Wrote elevations.txt")

if __name__ == '__main__':
    generate_previews()
