#!/usr/bin/env python3
"""check-harr-map.py: the automated overlap / limits / map-sanity gate for Harr's manifest (ALL groups).

    python3 tools/check-harr-map.py            human-readable report, exit 1 on any failure
    python3 tools/check-harr-map.py --json     the same as JSON (used by tests/veloren-map.test.js)

Checks (works and map together):
  * every Rust and NemoWorld limit on every group (ops, extent, heights, fill volume, blocks per group and in total,
    foundation columns and depth, kinds, sprites, ids, release order, crew), and the area radius for every cell;
  * no two different projects write the same voxel (fills, clears and sprites, 3D, per group ground);
  * map rules: paving is Rock flush at z=0 with a foundation of depth 1-2, every map project has >= 2 stages and no crew,
    is in the works catalogue, every work site is within 4 blocks of the one connected road network, street lamps stand within
    12 blocks of every paved cell, all six district colours and six gateways exist.
"""
import json, math, pathlib, sys
from collections import deque

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import harr_layout as H  # noqa: E402

KERB = (40, 200, 190)
STREET = ('StreetLamp', 'StreetLampTall')   # real street lamps (building lanterns do not count towards road lighting)
DISTRICT_PAVING = {'learning': (150, 182, 240), 'making': (244, 184, 110), 'living': (150, 212, 150),
                   'gathering': (200, 158, 230), 'energy': (246, 228, 110), 'transport': (120, 134, 158)}


def rust_sprites():
    import os, re
    for cand in (os.environ.get('HARR_MANIFEST_RS'), ROOT.parent / 'veloren-integ' / 'nemo-world-core' / 'src' / 'manifest.rs'):
        if cand and pathlib.Path(cand).exists():
            text = pathlib.Path(cand).read_text()
            block = re.search(r'ALLOWED_SPRITES: &\[&str\] = &\[(.*?)\];', text, re.S)
            if block:
                return set(re.findall(r'"([A-Za-z0-9]+)"', re.sub(r'//[^\n]*', '', block.group(1))))
    return None


def run(manifest_path=H.MANIFEST):
    m = H.load_manifest(manifest_path)
    rep = H.check_manifest(m)
    errors, notes = list(rep['errors']), []
    overlaps = list(rep['overlaps'])
    groups = m['groups']
    mapg = [g for g in groups if g.get('project', '').startswith('map-')]
    if not mapg:
        errors.append('the manifest has no map- groups (run tools/gen-harr-works.py or tools/gen-harr-network.py)')

    rs = rust_sprites()
    if rs is None:
        notes.append('Rust manifest.rs not found: sprite list not compared with the game (the Rust checker does that)')
    elif rs != H.SPRITES:
        notes.append(f'sprite list differs from manifest.rs: only here {sorted(H.SPRITES - rs)[:5]}, only there {sorted(rs - H.SPRITES)[:5]}')
        bad = {H.sprite_base(pc[1]) for g in mapg for pc in H.expand_group(g)[0].values() if pc[0] == 'S'} - rs
        if bad:
            errors.append(f'map uses sprites the game does not allow: {sorted(bad)}')

    # --- map rules
    by_project = {}
    for g in mapg:
        by_project.setdefault(g['project'], []).append(g)
    catalogue = {p['id'] for p in json.loads((ROOT / 'content' / 'veloren-projects.json').read_text())['projects']}
    for pid, gs in by_project.items():
        if len(gs) < 2:
            errors.append(f'{pid}: a project needs at least two stages')
        if pid not in catalogue:
            errors.append(f'{pid}: missing from content/veloren-projects.json')
        if any(g.get('crew') for g in gs):
            errors.append(f'{pid}: map stages must not need a crew')
        if any(g.get('release_after_minutes', 0) <= 0 for g in gs):
            errors.append(f'{pid}: map stages need a release time')
    pave, kerbs, lamps = set(), set(), []
    colours = {}
    for g in mapg:
        pieces, found = H.expand_group(g)
        has_pave = False
        for (x, y, z), pc in pieces.items():
            if pc[0] == 'B' and z == 0 and pc[1] == 'Rock':
                if tuple(pc[2]) == KERB:
                    kerbs.add((x, y))
                else:
                    pave.add((x, y))
                    colours[(x, y)] = tuple(pc[2])
                    has_pave = True
            if pc[0] == 'S' and H.sprite_base(pc[1]) in STREET and z <= 3:
                lamps.append((x, y))
            if pc[0] == 'B' and z < 0:
                errors.append(f'{g["id"]}: a block below the ground at {(x, y, z)}')
        if has_pave:
            if not any(1 <= f[4] <= 2 for f in found):
                errors.append(f'{g["id"]}: paving without a foundation of depth 1-2')
    # existing street lamps count too
    for g in groups:
        if not g.get('project', '').startswith('map-'):
            bx, by = H.base_of(g['anchor'])
            lamps += [(bx + o['at'][0], by + o['at'][1]) for o in g['ops'] if o['op'] == 'sprite' and H.sprite_base(o['sprite']) in STREET and o['at'][2] <= 3]
    # connected network
    comp, seen = [], set()
    for c in pave:
        if c in seen:
            continue
        q, cur = deque([c]), {c}
        seen.add(c)
        while q:
            a = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (a[0] + dx, a[1] + dy)
                if n in pave and n not in seen:
                    seen.add(n)
                    cur.add(n)
                    q.append(n)
        comp.append(cur)
    comp.sort(key=len, reverse=True)
    main = comp[0] if comp else set()
    if len(main) < 0.98 * len(pave):
        errors.append(f'the road network is not one piece: largest part {len(main)} of {len(pave)} paved cells')
    # every work site reaches the network
    hard, spr, founded, bbox = H.existing_footprint(groups)
    sites = [p['id'] for p in json.loads((ROOT / 'content' / 'veloren-projects.json').read_text())['projects'] if not p['id'].startswith('map-')]
    unreached = []
    for pid in sites:
        bb = bbox.get(pid)
        if not bb:
            continue
        near = any(bb[0] - 4 <= c[0] <= bb[2] + 4 and bb[1] - 4 <= c[1] <= bb[3] + 4 for c in main)
        if not near:
            unreached.append(pid)
    if unreached:
        errors.append(f'work sites more than 4 blocks from the road network: {unreached}')
    # lamps
    worst = 0.0
    for c in pave:
        worst = max(worst, min((math.hypot(c[0] - l[0], c[1] - l[1]) for l in lamps), default=99))
    if worst > 12:
        errors.append(f'a paved cell is {worst:.1f} blocks from the nearest lamp (limit 12)')
    # districts and gateways
    for d, rgb in DISTRICT_PAVING.items():
        if not any(v == rgb for v in colours.values()):
            errors.append(f'no paving in the {d} colour {rgb}')
        if f'map-gate-{d}' not in by_project:
            errors.append(f'no gateway for the {d} district')
    stats = dict(rep['stats'])
    stats.update(map_groups=len(mapg), map_projects=len(by_project), paved_cells=len(pave), kerb_cells=len(kerbs),
                 lamps=len(lamps), worst_lamp_distance=round(worst, 1), unreached_sites=unreached,
                 network_components=len(comp), last_release=max((g['release_after_minutes'] for g in mapg), default=0))
    stats.pop('per_project', None)
    return dict(ok=not errors and not overlaps, errors=errors, overlaps=overlaps, notes=notes, stats=stats)


if __name__ == '__main__':
    result = run()
    if '--json' in sys.argv:
        print(json.dumps(result))
    else:
        s = result['stats']
        print(f"groups {s['groups']}/{H.LIMITS['max_groups']}  blocks {s['total_blocks']}/{s['limit_blocks']}  overlaps {len(result['overlaps'])}  "
              f"map: {s['map_projects']} projects, {s['map_groups']} stages, {s['paved_cells']} paved cells, {s['lamps']} lamps "
              f"(worst gap {s['worst_lamp_distance']}), {s['network_components']} network piece(s), last release minute {s['last_release']}")
        for n in result['notes']:
            print('note:', n)
        for e in result['errors'] + result['overlaps']:
            print('FAIL:', e)
        print('OK' if result['ok'] else 'FAILED')
    sys.exit(0 if result['ok'] else 1)
