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

# ---------------------------------------------------------------------------------------------------------------
# The MAP previews (evidence/map/): the whole village with its roads, colour-coded by district, lamps, gates and
# lawns; the same map at five moments of the open-world clock; and the automated overlap / limits report.
# ---------------------------------------------------------------------------------------------------------------
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harr_layout as HL

MAP_DISTRICTS = [  # key, ascii letter, name, paving rgb (kept in step with tools/gen-harr-network.py)
    ('learning', 'L', 'Learning', (150, 182, 240)), ('making', 'M', 'Making', (244, 184, 110)),
    ('living', 'V', 'Living', (150, 212, 150)), ('gathering', 'G', 'Gathering', (200, 158, 230)),
    ('energy', 'E', 'Water and energy', (246, 228, 110)), ('transport', 'T', 'Transport', (120, 134, 158)),
    ('civic', 'c', 'Civic roads and plaza', (205, 220, 236)),
]
KERB_RGB, WATER_RGB, BG = (40, 200, 190), (96, 186, 232), (55, 95, 45)


def _write_png(path, w, h, rows):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def _surface(manifest, upto=None):
    """Top-down surface of every column of groups released by `upto` minutes (None = all):
    cells {(x, y): (z, rgb, source)} and props {(x, y): sprite}; source is 'map' or 'work'."""
    cells, props = {}, {}
    for g in manifest['groups']:
        if upto is not None and g.get('release_after_minutes', 0) > upto:
            continue
        src = 'map' if g.get('project', '').startswith('map-') else 'work'
        pieces, _found = HL.expand_group(g)
        for (x, y, z), pc in pieces.items():
            if pc[0] == 'B':
                if (x, y) not in cells or cells[(x, y)][0] <= z:
                    cells[(x, y)] = (z, pc[2], src)
            elif pc[0] == 'S':
                props[(x, y)] = (z, HL.sprite_base(pc[1]))
    return cells, props


def _ascii_map(manifest, cells, props, bounds):
    x0, y0, x1, y1 = bounds
    rgb_letter = {rgb: l for _k, l, _n, rgb in MAP_DISTRICTS}
    lines = ['HARR MAP (plaza-relative blocks: x east, y north; the Plaza centre is 0,0 and the site origin is 3,39)',
             'Paving: L learning, M making, V living, G gathering, E water+energy, T transport, c civic/plaza',
             "Other: - teal kerb   i street lamp   S sign   P planter   A gate arch   m grass mound   ~ fountain basin   w basin rim / planter base   # building/work   o other prop", '']
    lines.append('      ' + ''.join(str(abs(x) // 10 % 10) if x % 10 == 0 else ' ' for x in range(x0, x1 + 1)))
    for y in range(y1, y0 - 1, -1):
        row = []
        for x in range(x0, x1 + 1):
            c = (x, y)
            pr = props.get(c)
            cl = cells.get(c)
            if pr and pr[1] in HL.LIGHTS:
                row.append('i')
            elif pr and pr[1] == 'Sign':
                row.append('S')
            elif pr and pr[1] == 'Planter':
                row.append('P')
            elif cl is None:
                row.append('o' if pr else ('0' if c == (0, 0) else ' '))
            else:
                z, rgb, src = cl
                rgb = tuple(rgb)
                if src == 'work':
                    row.append('#')
                elif rgb == KERB_RGB:
                    row.append('A' if z >= 3 else '-')
                elif rgb == WATER_RGB:
                    row.append('~')
                elif rgb == (226, 232, 240):
                    row.append('w')
                elif rgb[1] > rgb[0] and rgb[1] > rgb[2] and rgb[0] < 120 and z >= 0 and rgb in ((86, 156, 70), (108, 178, 82)):
                    row.append('m')
                elif z >= 3:
                    row.append('A')
                else:
                    row.append(rgb_letter.get(rgb, '='))
        lines.append(f'{y:+4d}  ' + ''.join(row))
    return '\n'.join(lines) + '\n'


def generate_map_previews():
    manifest = json.loads((ROOT / 'content' / 'veloren-world-harr.json').read_text())
    out = ROOT / 'evidence' / 'map'
    out.mkdir(parents=True, exist_ok=True)
    cells, props = _surface(manifest)
    xs = [c[0] for c in cells] + [c[0] for c in props]
    ys = [c[1] for c in cells] + [c[1] for c in props]
    bounds = (min(xs) - 3, min(ys) - 3, max(xs) + 3, max(ys) + 3)
    (out / 'map.txt').write_text(_ascii_map(manifest, cells, props, bounds))

    def render(upto, name, scale=6):
        cl, pr = _surface(manifest, upto)
        x0, y0, x1, y1 = bounds
        w, h = (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale + 26
        img = [[BG] * w for _ in range(h)]
        for (x, y), (z, rgb, src) in cl.items():
            px, py = (x - x0) * scale, (y1 - y) * scale
            col = tuple(rgb) if src == 'map' or z <= 6 else (170, 176, 188)
            if src == 'work':
                col = tuple(int(v * 0.72 + 30) for v in rgb)   # works: slightly muted so the map reads first
            for dy in range(scale):
                for dx in range(scale):
                    img[py + dy][px + dx] = col
        for (x, y), (z, name_) in pr.items():
            cx, cy = (x - x0) * scale + scale // 2, (y1 - y) * scale + scale // 2
            col = (255, 235, 90) if name_ in HL.LIGHTS else (255, 140, 50) if name_ == 'Sign' else (30, 120, 50) if name_ == 'Planter' else (120, 100, 90)
            r = 2 if name_ in HL.LIGHTS else 1
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    if 0 <= cy + dy < h and 0 <= cx + dx < w:
                        img[cy + dy][cx + dx] = col
        for gx in range((x0 // 10) * 10, x1 + 1, 10):   # a faint 10-block grid
            if x0 <= gx <= x1:
                for yy in range(0, (y1 - y0 + 1) * scale, 3):
                    px = (gx - x0) * scale
                    if img[yy][px] == BG:
                        img[yy][px] = (70, 110, 60)
        for i, (_k, _l, _n, rgb) in enumerate(MAP_DISTRICTS):   # legend swatches along the bottom
            for yy in range((y1 - y0 + 1) * scale + 6, (y1 - y0 + 1) * scale + 20):
                for xx in range(6 + i * 40, 6 + i * 40 + 32):
                    if xx < w:
                        img[yy][xx] = rgb
        _write_png(out / name, w, h, [[c for px in row for c in px] for row in img])
    render(None, 'map.png')
    moments = [15, 45, 90, 180, 360]
    lines = ['Harr map by open-world minute (works and roads released by then)', '']
    for t in moments:
        render(t, f'map-t{t:03d}.png', 4)
        roads = sum(1 for g in manifest['groups'] if g.get('project', '').startswith('map-') and g.get('release_after_minutes', 0) <= t)
        works = sum(1 for g in manifest['groups'] if not g.get('project', '').startswith('map-') and g.get('release_after_minutes', 0) <= t)
        lines.append(f'  minute {t:>3}: {roads:>3} of {sum(1 for g in manifest["groups"] if g.get("project", "").startswith("map-"))} map stages, {works:>3} of {sum(1 for g in manifest["groups"] if not g.get("project", "").startswith("map-"))} work stages')
    (out / 'timeline.txt').write_text('\n'.join(lines) + '\n')
    report = HL.check_manifest(manifest)
    s = report['stats']
    per = s['per_project']
    mapblocks = sum(v for k, v in per.items() if k.startswith('map-'))
    rl = ['HARR MANIFEST CHECK (all groups, works and map together)', '',
          f"groups {s['groups']} (max {HL.LIMITS['max_groups']}), projects {s['projects']}",
          f"blocks {s['total_blocks']} of {s['limit_blocks']} (cells incl. air + foundation columns; map share {mapblocks})",
          f"largest group {s['largest_group'][1]}: {s['largest_group'][0]} (max {HL.LIMITS['max_group_blocks']})",
          f"claimed voxels {s['claimed_voxels']}, cross-project overlaps {len(report['overlaps'])}, shared foundation columns {s['shared_foundation_columns']}",
          f"errors {len(report['errors'])}", ''] + report['errors'] + report['overlaps']
    (out / 'check.txt').write_text('\n'.join(rl) + '\n')
    print('Wrote evidence/map/: map.png map.txt map-t*.png timeline.txt check.txt')


if __name__ == '__main__':
    generate_previews()
    generate_map_previews()
