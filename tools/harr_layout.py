#!/usr/bin/env python3
"""harr_layout.py: shared geometry and the automated overlap / limits check for Harr's manifest.

Used by gen-harr-network.py (to plan around existing works), preview-harr.py (previews) and
check-harr-map.py / tests/veloren-map.test.js (the gate).  Pure standard library.

Coordinates: "plaza-relative" (x east, y north) with the Plaza plot centre at (0, 0).  The site origin
(15216, 16016) is therefore (3, 39).  z is relative to each group's measured ground (z=0 is the ground block itself).
"""
import json, math, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'content' / 'veloren-world-harr.json'

# Plot centres relative to the Plaza centre (world: Plaza 15213,15977  House 15225,16007  Workshop 15207,15995
# FarmField0 15231,16025  FarmField1 15225,15983).
PLOTS = {('Plaza', 0): (0, 0), ('House', 0): (12, 30), ('Workshop', 0): (-6, 18),
         ('FarmField', 0): (18, 48), ('FarmField', 1): (12, 6)}
ORIGIN = (3, 39)

# The Rust rules (veloren/nemo-world-core/src/manifest.rs) and NemoWorld's own (src/veloren-ext/world-manifest.js).
LIMITS = dict(max_area_radius=150, max_groups=600, max_ops=600, max_extent=48, min_dz=-12, max_dz=24, max_fill=4096,
              max_group_blocks=6000, max_total=60000, max_release=7 * 24 * 60, max_crew=8, max_depth=12,
              max_found_cols=1200, max_sprite_text=64)
KINDS = {'Rock', 'Wood', 'Misc', 'Earth', 'Sand', 'Grass'}
# Copy of ALLOWED_SPRITES in manifest.rs; check-harr-map.py compares it with the Rust file when that file is reachable.
SPRITES = set("""Lantern StreetLamp StreetLampTall FireBowlGround LanternpostWoodLantern MesaLantern LampTerracotta
LampMetalShinglesRed LampMetalShinglesCyan WallLamp WallLampSmall WallSconce Candle BonfireMLit LanternpostWoodUpper
LanternpostWoodBase LampMetalBase BenchWoodEnd BenchWoodMiddle BenchWoodWoodland BenchWoodWoodlandGreen1
BenchWoodWoodlandGreen2 BenchWoodWoodlandGreen3 BenchWood2Middle BenchWood2Side BenchWood2Middle2 BenchCoastal
ChairWoodWoodland ChairWoodWoodland2 SeatWoodBlueMiddle SeatWoodBlueSide DiningtableWoodCorner DiningtableWoodBody
DiningtableWoodWoodlandRound DiningtableWoodWoodlandSquare TableWoodFancyWoodlandCorner TableWoodFancyWoodlandBody
TableCoastalLarge TableArabicLarge TableArabicSmall CarpenterTable CounterWoodEnd CounterWoodMiddle CushionArabic
CanapeArabic BookshelfEnd BookshelfMiddle BookshelfArabic Shelf CupboardArabic CupboardMesa DrawerWoodWoodlandL1
DrawerWoodWoodlandL2 DrawerWoodWoodlandM1 DrawerWoodWoodlandM2 DrawerWoodWoodlandS WardrobeSingleMesa
WardrobeDoubleMesa WardrobedoubleWoodWoodland WardrobesingleWoodWoodland Barrel CrateBlock BarrelWoodCoal
BarrelWoodWater BasketWovenL BasketWovenM BasketWovenS CarpenterCrateWoodS CarpenterCrateWoodL SackLeatherM
BucketWoodM JugClayM Hay BedMesa BedWoodWoodlandHead BedWoodWoodlandMiddle BedWoodWoodlandTail CraftingBench Forge
Cauldron Anvil CookingPot SpinningWheel TanningRack Loom RepairBench DismantlingBench BlacksmithBellows Hearth
CrystalBall Sign HangingSign HangingBasket Planter FlowerpotWoodWoodlandS CoatrackWoodWoodland MirrorMesa MirrorWoodM
WallTableMesa WallTableArabic Scarecrow RopeCoilM Ladder FenceWoodGateWoodland FenceWoodWoodland FencePost
HandCartWoodHead HandCartWoodMiddle HandCartWoodTail BroomWoodWoodlandBlue RakeWoodWoodland Window1 Window2 Window3
Window4""".split())
LIGHTS = {'Lantern', 'StreetLamp', 'StreetLampTall', 'FireBowlGround', 'LanternpostWoodLantern', 'MesaLantern',
          'LampTerracotta', 'LampMetalShinglesRed', 'LampMetalShinglesCyan', 'WallLamp', 'WallLampSmall', 'WallSconce',
          'Candle', 'BonfireMLit'}
ID_RE = re.compile(r'^[a-z0-9-]{1,48}$')
SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')  # the stricter JS rule, applied to ids and projects alike


def load_manifest(path=MANIFEST):
    return json.loads(pathlib.Path(path).read_text())


def base_of(anchor):
    px, py = PLOTS[(anchor.get('plot', 'Plaza'), anchor.get('nth', 0))]
    return px + anchor.get('dx', 0), py + anchor.get('dy', 0)


def sprite_base(text):
    return text.split('(', 1)[0]


def expand_group(g):
    """Later ops win, exactly like the Rust expander.  Returns (pieces, foundation) in plaza-relative xy.
    pieces: {(x, y, z): ('B', kind, rgb) | ('A',) | ('S', sprite)}; foundation: [(x, y, kind, rgb, depth)]."""
    bx, by = base_of(g['anchor'])
    pieces, found = {}, []
    for op in g['ops']:
        k = op['op']
        if k in ('fill', 'clear'):
            f, t = op['from'], op['to']
            for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                    for z in range(min(f[2], t[2]), max(f[2], t[2]) + 1):
                        pieces[(bx + x, by + y, z)] = ('B', op['kind'], tuple(op['rgb'])) if k == 'fill' else ('A',)
        elif k == 'sprite':
            a = op['at']
            pieces[(bx + a[0], by + a[1], a[2])] = ('S', op['sprite'])
        elif k == 'foundation':
            f, t = op['from'], op['to']
            for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                    found.append((bx + x, by + y, op['kind'], tuple(op['rgb']), op['depth']))
    return pieces, found


def op_problems(g):
    """Per-group rules (Rust + JS), on the raw ops, before anything is expanded."""
    L, out, gid = LIMITS, [], g.get('id', '?')
    a = g.get('anchor', {})
    if (a.get('plot', 'Plaza'), a.get('nth', 0)) not in PLOTS:
        out.append(f'{gid}: anchor plot {a.get("plot")}#{a.get("nth", 0)} is not a known plot')
    for ax in ('dx', 'dy'):
        if abs(a.get(ax, 0)) > L['max_extent']:
            out.append(f'{gid}: anchor.{ax} {a.get(ax)} is outside +-{L["max_extent"]}')
    if not (0 <= a.get('nth', 0) <= 7):
        out.append(f'{gid}: anchor.nth out of range')
    if not g.get('ops') or len(g['ops']) > L['max_ops']:
        out.append(f'{gid}: needs 1-{L["max_ops"]} ops (has {len(g.get("ops", []))})')
    cols = 0
    for i, op in enumerate(g.get('ops', [])):
        k, w = op.get('op'), f'{gid} ops[{i}]'
        pts = [op['at']] if k == 'sprite' else ([op['from'] + [0], op['to'] + [0]] if k == 'foundation' else [op['from'], op['to']])
        for p in pts:
            if abs(p[0]) > L['max_extent'] or abs(p[1]) > L['max_extent']:
                out.append(f'{w}: reaches more than {L["max_extent"]} blocks from the anchor')
            if k != 'foundation' and not (L['min_dz'] <= p[2] <= L['max_dz']):
                out.append(f'{w}: height {p[2]} outside {L["min_dz"]}..{L["max_dz"]}')
        if k in ('fill', 'clear'):
            f, t = op['from'], op['to']
            if any(t[j] < f[j] for j in range(3)):
                out.append(f'{w}: corners the wrong way round (the JS validator refuses this)')
            vol = abs(t[0] - f[0] + 1) * abs(t[1] - f[1] + 1) * abs(t[2] - f[2] + 1)
            if vol > L['max_fill']:
                out.append(f'{w}: box of {vol} blocks exceeds {L["max_fill"]}')
        if k == 'fill' and op['kind'] not in KINDS:
            out.append(f'{w}: kind {op["kind"]} not allowed')
        if k == 'foundation':
            if op['kind'] not in KINDS:
                out.append(f'{w}: kind {op["kind"]} not allowed')
            if not (1 <= op['depth'] <= L['max_depth']):
                out.append(f'{w}: foundation depth {op["depth"]} outside 1..{L["max_depth"]}')
            cols += (abs(op['to'][0] - op['from'][0]) + 1) * (abs(op['to'][1] - op['from'][1]) + 1)
        if k in ('fill', 'foundation') and not all(0 <= c <= 255 for c in op['rgb']):
            out.append(f'{w}: colour is not bytes')
        if k == 'sprite':
            if len(op['sprite']) > L['max_sprite_text'] or sprite_base(op['sprite']) not in SPRITES:
                out.append(f'{w}: sprite {op["sprite"]} not allowed')
    if cols > L['max_found_cols']:
        out.append(f'{gid}: {cols} foundation columns exceeds {L["max_found_cols"]}')
    return out


def check_manifest(m):
    """Returns a report dict: errors (list), stats, overlaps (list).  errors empty and overlaps empty = clean."""
    L = LIMITS
    errors, overlaps = [], []
    groups = m['groups']
    if m.get('format') != 'veloren-world-v1':
        errors.append('format must be veloren-world-v1')
    radius = m['area']['radius']
    if not (5 <= radius <= L['max_area_radius']):
        errors.append(f'area.radius {radius} outside 5..{L["max_area_radius"]}')
    if len(groups) > L['max_groups']:
        errors.append(f'{len(groups)} groups exceeds {L["max_groups"]}')
    seen, total, per_project = set(), 0, {}
    owner = {}  # (x, y, z) -> (project, group id, piece)
    found_owner = {}  # (x, y) -> set of projects with foundations
    stage_times = {}
    max_group_blocks = (0, '')
    for g in groups:
        gid = g['id']
        if not ID_RE.match(gid) or not SLUG_RE.match(gid):
            errors.append(f'{gid}: id must be a short a-z0-9- slug (max 40 for NemoWorld)')
        if gid in seen:
            errors.append(f'{gid}: duplicate group id')
        seen.add(gid)
        proj = g.get('project', '')
        if proj and not SLUG_RE.match(proj):
            errors.append(f'{gid}: project {proj} is not a short slug')
        if g.get('release_after_minutes', 0) > L['max_release']:
            errors.append(f'{gid}: release too late')
        if g.get('release_after_minutes', 0) > 0 and not proj:
            errors.append(f'{gid}: a staged group needs a project')
        if g.get('crew', 0) > L['max_crew'] or (g.get('crew', 0) and not proj):
            errors.append(f'{gid}: bad crew')
        if len(g.get('title', '')) > 80:
            errors.append(f'{gid}: title longer than 80')
        errors += op_problems(g)
        pieces, found = expand_group(g)
        n = len(pieces)
        if n > L['max_group_blocks']:
            errors.append(f'{gid}: places {n} blocks, at most {L["max_group_blocks"]}')
        total += n + len(found)
        key = proj or gid
        per_project[key] = per_project.get(key, 0) + n + len(found)
        if n + len(found) > max_group_blocks[0]:
            max_group_blocks = (n + len(found), gid)
        if proj:
            stage_times.setdefault(proj, []).append(g.get('release_after_minutes', 0))
        for cell, piece in pieces.items():
            d = math.hypot(cell[0] - ORIGIN[0], cell[1] - ORIGIN[1])
            if d > radius:
                errors.append(f'{gid}: cell {cell} is {d:.0f} blocks from the origin, outside area.radius {radius}')
                break
        for cell, piece in pieces.items():
            prev = owner.get(cell)
            if prev and prev[0] != key and not (prev[2][0] == 'A' and piece[0] == 'A') and prev[2] != piece:
                overlaps.append(f'{key} ({gid}) vs {prev[0]} ({prev[1]}) at {cell}: {piece[0]} over {prev[2][0]}')
            owner[cell] = (key, gid, piece)
        for (x, y, kind, rgb, depth) in found:
            found_owner.setdefault((x, y), set()).add(key)
    if total > L['max_total']:
        errors.append(f'places {total} blocks in total, at most {L["max_total"]}')
    for proj, times in stage_times.items():
        if times != sorted(times):
            errors.append(f'project {proj}: stages are not in release order')
    # A foundation only fills air below the ground; two projects sharing one column is reported, not an error.
    shared_found = sum(1 for v in found_owner.values() if len(v) > 1)
    stats = dict(groups=len(groups), projects=len(per_project), total_blocks=total, limit_blocks=L['max_total'],
                 largest_group=max_group_blocks, per_project=per_project, shared_foundation_columns=shared_found,
                 claimed_voxels=len(owner))
    return dict(errors=errors, overlaps=overlaps, stats=stats)


def existing_footprint(groups, skip_prefix='map-'):
    """Columns the existing works use, for planning around them.
    hard: columns with a fill that reaches z 0..2 (walls, floors, pillars: no road may pass).
    blocked_sprite: columns with a sprite at z 1..2 (a road may be painted under it, but must not clear it).
    founded: columns a foundation touches.  bbox: project id -> (x0, y0, x1, y1) over fills and sprites."""
    hard, spr, founded, bbox = {}, {}, set(), {}
    for g in groups:
        proj = g.get('project', g['id'])
        if proj.startswith(skip_prefix):
            continue
        bx, by = base_of(g['anchor'])
        for op in g['ops']:
            k = op['op']
            if k == 'fill':
                f, t = op['from'], op['to']
                zlo, zhi = min(f[2], t[2]), max(f[2], t[2])
                for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                    for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                        _grow(bbox, proj, bx + x, by + y)
                        if zlo <= 2 and zhi >= 0:
                            hard[(bx + x, by + y)] = proj
            elif k == 'sprite':
                a = op['at']
                _grow(bbox, proj, bx + a[0], by + a[1])
                if a[2] in (1, 2):
                    spr[(bx + a[0], by + a[1])] = proj
            elif k == 'foundation':
                f, t = op['from'], op['to']
                for x in range(min(f[0], t[0]), max(f[0], t[0]) + 1):
                    for y in range(min(f[1], t[1]), max(f[1], t[1]) + 1):
                        founded.add((bx + x, by + y))
    return hard, spr, founded, bbox


def _grow(bbox, proj, x, y):
    b = bbox.setdefault(proj, [x, y, x, y])
    b[0], b[1], b[2], b[3] = min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)
