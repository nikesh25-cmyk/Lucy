#!/usr/bin/env python3
"""Generates Harr's night lighting: street lamps along roads, porch lamps at buildings, lit windows.

Run from the nemoworld root, AFTER tools/gen-harr-works.py:  python3 tools/gen-harr-lights.py
Reads   content/harr-lighting.json   (the plan: roads, spacing, window rules, targets - data only)
Rewrites the groups whose id starts with `lights-` in content/veloren-world-harr.json (idempotent: it drops
every `lights-` group first and builds them again from the plan and from the works already in the manifest).
Writes  evidence/look/lights.txt     (what was placed, and the night-readability report).

Nothing here is combat or danger imagery: lamps, lanterns and candles only. A StreetLamp, Lantern or
LanternpostWoodLantern has glow 24 in Veloren (`Block::get_glow`), a Candle glow 16; Window sprites do not
emit light, so a "lit window" is a Candle on the floor just inside the window.

The script refuses to write anything that would collide with the works (fills, sprites, later clears) or break the
world manifest limits (300 groups, 600 ops per group, 48 blocks from an anchor, area radius).
"""
import json, math, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
mpath = root / 'content' / 'veloren-world-harr.json'
ppath = root / 'content' / 'harr-lighting.json'
epath = root / 'evidence' / 'look' / 'lights.txt'

MAX_GROUPS = 300      # nemo-world-core manifest.rs MAX_GROUPS
MAX_EXTENT = 48       # MAX_EXTENT
STRONG = {'Lantern', 'StreetLamp', 'StreetLampTall', 'LanternpostWoodLantern', 'LampMetalShinglesRed', 'LampMetalShinglesCyan'}  # glow 24
OUTDOOR_ALWAYS = {'StreetLamp', 'StreetLampTall', 'LanternpostWoodLantern'}
LIGHT = STRONG | {'FireBowlGround', 'MesaLantern', 'LampTerracotta', 'WallLamp', 'WallLampSmall', 'WallSconce', 'Candle', 'BonfireMLit'}

plan = json.loads(ppath.read_text())
manifest = json.loads(mpath.read_text())
manifest['groups'] = [g for g in manifest['groups'] if not g['id'].startswith('lights-')]
# Lit windows live inside the project's own last stage (so a candle never stands in a house that is not built yet and
# the plot-clearing first stage can never remove it). Earlier candles are removed here so the run is idempotent.
CANDLE = plan['windows']['sprite']
for g in manifest['groups']:
    g['ops'] = [op for op in g['ops'] if not (op['op'] == 'sprite' and op['sprite'] == CANDLE and g.get('project'))]
    g['note'] = re.sub(r' \d+ lit windows? \(a candle just inside the glass\)\.$', '', g.get('note', ''))
last_stage = {}        # project id -> the group dict of its final stage
for g in manifest['groups']:
    if g.get('project'):
        last_stage[g['project']] = g

offsets = {(p['plot'], p['nth']): (p['x'], p['y']) for p in plan['plot_offsets']}
lim = plan['limits']
pad = plan['lamp']['pad']
LAMP = plan['lamp']['sprite']
CLEAR_H = plan['lamp']['clear_height']
RADIUS = plan['area_radius']


def base_of(anchor):
    ox, oy = offsets[(anchor['plot'], anchor.get('nth', 0))]
    return ox + anchor.get('dx', 0), oy + anchor.get('dy', 0)


# ---------------------------------------------------------------- what the works already occupy
claims = {}            # (x, y, z) -> 'fill' | 'sprite' | 'clear'
foundation_cols = set()
lights = []            # (x, y, z, sprite)
projects = {}          # pid -> info
for g in manifest['groups']:
    pid = g.get('project')
    bx, by = base_of(g['anchor'])
    stage = int(g['id'].rsplit('-', 1)[1]) if pid and g['id'].rsplit('-', 1)[-1].isdigit() else 1
    info = projects.setdefault(pid or g['id'], {'anchor': g['anchor'], 'ground_at': g['ground_at'], 'release': 0, 'windows': [],
                                                 'signs': [], 'fills': set(), 'bbox': None, 'project': bool(pid)})
    info['release'] = max(info['release'], g.get('release_after_minutes', 0))
    for op in g['ops']:
        if op['op'] == 'fill':
            f, t = op['from'], op['to']
            for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                    for z in range(min(f[2], t[2]), max(f[2], t[2]) + 1):
                        claims[(bx + x, by + y, z)] = 'fill'
                        info['fills'].add((bx + x, by + y, z))
            b = info['bbox'] or [10**9, 10**9, -10**9, -10**9]
            b[0] = min(b[0], bx + min(f[0], t[0])); b[1] = min(b[1], by + min(f[1], t[1]))
            b[2] = max(b[2], bx + max(f[0], t[0])); b[3] = max(b[3], by + max(f[1], t[1]))
            info['bbox'] = b
        elif op['op'] == 'clear':
            # The first stage of a project clears its own plot before anything else is built, so it never
            # removes what a later group puts there. Every later clear (doorways) is a real claim.
            if stage >= 2 or not pid:
                f, t = op['from'], op['to']
                for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                    for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                        for z in range(min(f[2], t[2]), max(f[2], t[2]) + 1):
                            claims.setdefault((bx + x, by + y, z), 'clear')
        elif op['op'] == 'foundation':
            f, t = op['from'], op['to']
            for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                    foundation_cols.add((bx + x, by + y))
        elif op['op'] == 'sprite':
            at = op['at']
            gx, gy, gz = bx + at[0], by + at[1], at[2]
            claims[(gx, gy, gz)] = 'sprite'
            if op['sprite'] in LIGHT:
                lights.append((gx, gy, gz, op['sprite']))
            if op['sprite'].startswith('Window'):
                info['windows'].append((gx, gy, gz))
            if op['sprite'] == 'Sign':
                info['signs'].append((gx, gy))

bboxes = [i['bbox'] for i in projects.values() if i['bbox'] and i['project']]


def inside_building(x, y):
    return any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in bboxes)


def outdoor_lights():
    return [(x, y) for x, y, z, s in lights if s in OUTDOOR_ALWAYS or (s in STRONG and not inside_building(x, y))]


new_lamps = []         # (x, y) of every lamp this script adds, in placement order


def column_blocked(x, y):
    for z in range(0, CLEAR_H + 1):
        if (x, y, z) in claims:
            return True
    m = lim['wall_margin']
    for dx in range(-m, m + 1):
        for dy in range(-m, m + 1):
            for z in range(1, 4):
                if claims.get((x + dx, y + dy, z)) == 'fill':
                    return True
    return False


def near_light(x, y, gap):
    for lx, ly in outdoor_lights() + new_lamps:
        if (lx - x) ** 2 + (ly - y) ** 2 < gap * gap:
            return True
    return False


# ---------------------------------------------------------------- roads
road_lamps = {}        # road id -> [(x, y), ...]
road_samples = {}      # road id -> [(x, y), ...] one per block, for the coverage report
for road in plan['roads']:
    pts = road['points']
    segs = []
    total = 0.0
    for a, b in zip(pts, pts[1:]):
        ln = math.hypot(b[0] - a[0], b[1] - a[1])
        segs.append((a, b, ln, total))
        total += ln

    def at(s):
        s = max(0.0, min(total, s))
        for a, b, ln, start in segs:
            if s <= start + ln + 1e-9:
                u = (s - start) / ln if ln else 0
                dx, dy = (b[0] - a[0]) / ln, (b[1] - a[1]) / ln
                return a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, -dy, dx
        a, b, ln, start = segs[-1]
        dx, dy = (b[0] - a[0]) / ln, (b[1] - a[1]) / ln
        return b[0], b[1], -dy, dx

    samples = []
    s = 0.0
    while s <= total:
        x, y, _, _ = at(s)
        samples.append((round(x), round(y)))
        s += 1.0
    road_samples[road['id']] = samples

    placed = []
    k = 0
    s = 0.0
    while s <= total + 1e-9:
        sign = 1 if k % 2 == 0 else -1
        done = False
        for along in lim['along_offsets_tried']:
            x0, y0, nx, ny = at(s + along)
            for t in lim['side_offsets_tried']:
                lat = sign * road['side_offset'] + t
                x, y = round(x0 + nx * lat), round(y0 + ny * lat)
                if math.hypot(x, y) > RADIUS:
                    continue
                if near_light(x, y, lim['min_gap_to_existing_light']):
                    done = True   # an existing light already serves this stretch
                    break
                if column_blocked(x, y):
                    continue
                new_lamps.append((x, y))
                placed.append((x, y))
                done = True
                break
            if done:
                break
        k += 1
        s += road['spacing']
    road_lamps[road['id']] = placed


def anchor_for(x, y):
    best = None
    for (plot, nth), (ox, oy) in offsets.items():
        dx, dy = x - ox, y - oy
        if abs(dx) <= MAX_EXTENT and abs(dy) <= MAX_EXTENT:
            d = dx * dx + dy * dy
            if best is None or d < best[0]:
                best = (d, plot, nth, dx, dy)
    assert best, f'no plot within reach of {x},{y}'
    return {'plot': best[1], 'nth': best[2], 'dx': best[3], 'dy': best[4]}


def lamp_ops(lx, ly):
    return [
        {'op': 'clear', 'from': [lx, ly, 1], 'to': [lx, ly, CLEAR_H]},
        {'op': 'foundation', 'from': [lx, ly], 'to': [lx, ly], 'kind': pad['kind'], 'rgb': pad['rgb'], 'depth': pad['foundation_depth']},
        {'op': 'fill', 'from': [lx, ly, 0], 'to': [lx, ly, 0], 'kind': pad['kind'], 'rgb': pad['rgb']},
        {'op': 'sprite', 'at': [lx, ly, 1], 'sprite': LAMP},
    ]


new_groups = []
for road in plan['roads']:
    lamps = road_lamps[road['id']]
    chunks = []
    for lamp in lamps:
        if chunks and len(chunks[-1]) < lim['max_lamps_per_group'] and math.hypot(lamp[0] - chunks[-1][0][0], lamp[1] - chunks[-1][0][1]) <= lim['group_reach']:
            chunks[-1].append(lamp)
        else:
            chunks.append([lamp])
    for n, chunk in enumerate(chunks, 1):
        anchor = anchor_for(*chunk[0])
        bx, by = base_of(anchor)
        ops = []
        for x, y in chunk:
            ops += lamp_ops(x - bx, y - by)
        new_groups.append({
            'id': f"lights-{road['id']}-{n}", 'anchor': anchor, 'ground_at': [chunk[0][0] - bx, chunk[0][1] - by],
            'note': f"{road['name']}: {len(chunk)} street lamp{'s' if len(chunk) != 1 else ''}, about {road['spacing']} blocks apart, so the road is lit from pool to pool all night.",
            'ops': ops})

# ---------------------------------------------------------------- porch lamps and lit windows, one group per building
porch_report = []
window_report = []
lit_total = 0
for pid, info in projects.items():
    if not info['project'] or not info['bbox'] or pid == 'lantern-path':
        continue
    b = info['bbox']
    gb = base_of(info['anchor'])
    local = lambda x, y: (x - gb[0], y - gb[1])
    ops = []
    # entrance: the signboard side, else the middle of the south wall
    ex, ey = info['signs'][0] if info['signs'] else ((b[0] + b[2]) // 2, b[1] - 1)
    porch = None
    if not any((lx - ex) ** 2 + (ly - ey) ** 2 <= plan['sites']['porch_radius'] ** 2 for lx, ly in outdoor_lights() + new_lamps):
        cands = sorted(((x, y) for x in range(ex - 4, ex + 5) for y in range(ey - 4, ey + 5)),
                       key=lambda c: ((c[0] - ex) ** 2 + (c[1] - ey) ** 2, abs(c[0] - ex)))
        for x, y in cands:
            if (x, y) == (ex, ey) or math.hypot(x, y) > RADIUS or column_blocked(x, y) or near_light(x, y, lim['min_gap_to_existing_light']):
                continue
            if abs(x - gb[0]) > MAX_EXTENT or abs(y - gb[1]) > MAX_EXTENT:
                continue
            porch = (x, y)
            break
        if porch:
            new_lamps.append(porch)
            ops += lamp_ops(*local(*porch))
    porch_report.append((pid, porch))

    # lit windows
    rule = next(r for r in plan['windows']['rules'] if re.match(r['match'], pid))
    cells = []
    for wx, wy, wz in sorted(set(info['windows'])):
        if wx == b[0]: step, along = (1, 0), (0, 1)
        elif wx == b[2]: step, along = (-1, 0), (0, 1)
        elif wy == b[1]: step, along = (0, 1), (1, 0)
        elif wy == b[3]: step, along = (0, -1), (1, 0)
        else: continue
        # the cell just inside the glass first, then one or two cells along the wall, then two cells deep
        found = None
        for depth in (1, 2):
            for shift in (0, 1, -1, 2, -2):
                cx = wx + step[0] * depth + along[0] * shift
                cy = wy + step[1] * depth + along[1] * shift
                if not (b[0] < cx < b[2] and b[1] < cy < b[3]):
                    continue
                for z in range(max(1, wz - 1), 0, -1):
                    if (cx, cy, z - 1) in info['fills'] and (cx, cy, z) not in claims and (cx, cy, z) not in cells:
                        found = (cx, cy, z)
                        break
                if found:
                    break
            if found:
                break
        if found:
            cells.append(found)
    want = min(rule['cap'], max(rule['min'], math.ceil(len(info['windows']) * rule['fraction'])))
    want = min(want, len(cells))
    chosen = [cells[int(i * len(cells) / want)] for i in range(want)] if want else []
    for cx, cy, cz in chosen:
        lx, ly = local(cx, cy)
        ops.append({'op': 'sprite', 'at': [lx, ly, cz], 'sprite': plan['windows']['sprite']})
        claims[(cx, cy, cz)] = 'sprite'
    lit_total += len(chosen)
    window_report.append((pid, len(info['windows']), len(chosen)))
    if chosen:
        final = last_stage[pid]
        fb = base_of(final['anchor'])
        for cx, cy, cz in chosen:
            final['ops'].append({'op': 'sprite', 'at': [cx - fb[0], cy - fb[1], cz], 'sprite': plan['windows']['sprite']})
        assert len(final['ops']) <= 600, pid
        final['note'] = final['note'].rstrip() + f" {len(chosen)} lit window{'s' if len(chosen) != 1 else ''} (a candle just inside the glass)."
    if ops:
        for op in ops:
            pts = [op.get('at')] if 'at' in op else [op['from'], op['to']]
            assert all(abs(p[0]) <= MAX_EXTENT and abs(p[1]) <= MAX_EXTENT for p in pts), f'{pid}: op out of reach'
        new_groups.append({
            'id': f'lights-{pid}', 'anchor': info['anchor'], 'ground_at': info['ground_at'],
            'note': f"Night lighting for {pid}: a street lamp at the door, lit from the first evening so the way to the site is never dark.",
            'ops': ops})

# ---------------------------------------------------------------- safety checks
assert len(manifest['groups']) + len(new_groups) <= MAX_GROUPS, f"{len(manifest['groups']) + len(new_groups)} groups exceeds {MAX_GROUPS}"
ids = [g['id'] for g in manifest['groups']] + [g['id'] for g in new_groups]
assert len(ids) == len(set(ids)), 'duplicate group id'
seen = set()
for g in new_groups:
    bx, by = base_of(g['anchor'])
    assert abs(g['anchor'].get('dx', 0)) <= MAX_EXTENT and abs(g['anchor'].get('dy', 0)) <= MAX_EXTENT, g['id']
    for op in g['ops']:
        if op['op'] == 'sprite':
            cell = (bx + op['at'][0], by + op['at'][1], op['at'][2])
            assert cell not in seen, f"{g['id']}: two lights in {cell}"
            seen.add(cell)
            assert claims.get(cell) in (None, 'sprite'), f"{g['id']}: {cell} is already used by the works"

# ---------------------------------------------------------------- night-readability report
tg = plan['targets']
strong_now = outdoor_lights() + new_lamps
lines = ['HARR NIGHT LIGHTING REPORT', 'generated by tools/gen-harr-lights.py from content/harr-lighting.json', '']
lines.append(f"new groups: {len(new_groups)}  (manifest total {len(manifest['groups']) + len(new_groups)} of {MAX_GROUPS})")
lines.append(f"new street lamps: {len(new_lamps)}   (existing outdoor lamps and lanterns counted: {len(outdoor_lights())})")
lines.append('')
lines.append('ROADS (lamp spacing is the plan value; coverage = share of road blocks within '
             f"{tg['road_sample_max_distance_to_light']} blocks of a lamp, building footprints excluded)")
worst = 1.0
for road in plan['roads']:
    samples = [(x, y) for x, y in road_samples[road['id']] if not column_blocked(x, y) or any((x, y) == l for l in strong_now)]
    ok = sum(1 for x, y in samples if any((lx - x) ** 2 + (ly - y) ** 2 <= tg['road_sample_max_distance_to_light'] ** 2 for lx, ly in strong_now))
    cov = ok / len(samples) if samples else 1.0
    worst = min(worst, cov)
    lines.append(f"  {road['id']:<14} spacing {road['spacing']:>2}  new lamps {len(road_lamps[road['id']]):>2}  coverage {cov*100:5.1f}%  ({road['name']})")
lines.append('')
lines.append('BUILDINGS (porch lamp at the door; lit windows = candles just inside the glass)')
for (pid, porch), (_, wins, lit) in zip(porch_report, window_report):
    lines.append(f"  {pid:<18} porch {'lamp at %d,%d' % porch if porch else 'already lit  '}   windows {wins:>2}  lit {lit:>2}")
lines.append('')
lines.append(f"lit windows total: {lit_total}")
text = '\n'.join(lines) + '\n'
print(text)
if worst < tg['road_min_coverage']:
    sys.exit(f"road coverage {worst:.2f} is below the target {tg['road_min_coverage']}")
if lit_total < tg['min_lit_windows_total']:
    sys.exit(f"lit windows {lit_total} is below the target {tg['min_lit_windows_total']}")

manifest['groups'] += new_groups
mpath.write_text(json.dumps(manifest, indent=2) + '\n')
epath.parent.mkdir(parents=True, exist_ok=True)
epath.write_text(text)
print(f"Wrote {len(new_groups)} lighting groups to {mpath.name}.")
