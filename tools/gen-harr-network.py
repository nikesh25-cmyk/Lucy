#!/usr/bin/env python3
"""Harr's MAP: a paved, lit road network, district gateways, wayfinding and landscaping, appended to the manifest.

Run from the nemoworld root:  python3 tools/gen-harr-network.py            (standalone: rewrites the map- groups)
It is also called by tools/gen-harr-works.py (hook `append_network`) after the works are written, because the works
generator rebuilds every group that has a `project` from scratch; the map groups are recognised by the `map-` prefix of
their project id and are always replaced as a set.  Deterministic: no randomness, same input -> same manifest.

What it does (see docs/HARR_MAP.md):
  1. reads the footprints of every existing work (fills, sprites) and plans around them;
  2. routes trunk roads between hand-picked waypoints and one spur from each of the 37 work sites to the nearest road
     (turn-penalised Dijkstra on a 3-wide corridor, so paving never touches a wall or a sprite);
  3. paves them flush with the ground (Rock at z=0 + foundation depth 2 for dips + 2 blocks of headroom cleared),
     edges them with a teal kerb, lights them (StreetLamp every ~8 blocks), adds small plazas, crossings, planters and
     Sign sprites at junctions, and stone arches (Rock) at each district entrance;
  4. colour-codes the paving per district (learning, making, living, gathering, energy, transport);
  5. adds landscaping (grass mounds, stone planters, low walls, a fountain basin) around the plaza and the quarters;
  6. cuts everything into stages of at most SEG road cells, each its own group (own measured ground height), released
     progressively on the open-world clock, never needing a crew.
"""
import importlib.util, json, heapq, math, pathlib, sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import harr_layout as H  # noqa: E402

MANIFEST = ROOT / 'content' / 'veloren-world-harr.json'
CATALOGUE = ROOT / 'content' / 'veloren-projects.json'
PREFIX = 'map-'
SEG = 12          # road cells (centre-line) per stage / group: each group measures its own ground height
GAPM = 3          # minutes between the stages of one map project
LAMP_EVERY = 8
RADIUS_OK = 98    # keep every centre-line cell this close to the site origin (area.radius is 110)

# ---- palette: pale, flush paving; one tint per district; teal kerbs ----
PALE = [205, 220, 236]
KERB = [40, 200, 190]
WHITE = [246, 248, 250]
STONE = [226, 232, 240]
EARTH = [110, 84, 60]
WATER = [96, 186, 232]
GRASS = [86, 156, 70]
GRASS_HI = [108, 178, 82]
DISTRICTS = {  # id: (paving, arch/accent, title)
    'learning': ([150, 182, 240], [96, 130, 214], 'The learning quarter'),
    'making': ([244, 184, 110], [212, 140, 60], 'The making quarter'),
    'living': ([150, 212, 150], [90, 170, 100], 'The living quarter'),
    'gathering': ([200, 158, 230], [158, 110, 200], 'The gathering quarter'),
    'energy': ([246, 228, 110], [214, 190, 50], 'The water and energy quarter'),
    'transport': ([120, 134, 158], [76, 90, 116], 'The transport quarter'),
    'civic': (PALE, [150, 170, 196], 'The civic roads'),
}
DISTRICT_OF = {}
for _d, _ps in {
    'learning': 'schoolhouse seminar-pavilion data-archive library-annex research-tower observatory',
    'making': 'workshop-hall recycling-garden',
    'living': 'cottage-1 cottage-2 cottage-3 cottage-4 cottage-5 cottage-6 cottage-7 cottage-8 cottage-9 guesthouse vertical-farm',
    'gathering': 'market-hall amphitheatre festival-lawn light-fountain glass-garden field-pavilion field-hut well',
    'energy': 'solar-array solar-field-2 wind-array water-tower',
    'transport': 'transit-hub tram-halt canal-bridge sky-walk',
}.items():
    for _p in _ps.split():
        DISTRICT_OF[_p] = _d
NAMES = {  # plain-language names for the works board
    'schoolhouse': 'schoolhouse', 'seminar-pavilion': 'seminar pavilion', 'data-archive': 'open archive',
    'library-annex': 'library annex', 'research-tower': 'research tower', 'observatory': 'star observatory',
    'workshop-hall': 'makers workshop hall', 'recycling-garden': 'recycling garden', 'guesthouse': 'guesthouse',
    'vertical-farm': 'vertical farm', 'market-hall': 'market hall', 'amphitheatre': 'amphitheatre',
    'festival-lawn': 'festival lawn', 'light-fountain': 'light fountain', 'glass-garden': 'glass garden',
    'field-pavilion': 'field pavilion', 'field-hut': 'field hut', 'well': 'plaza well', 'solar-array': 'solar array',
    'solar-field-2': 'southern solar field', 'wind-array': 'wind array', 'water-tower': 'water tower',
    'transit-hub': 'sky transit hub', 'tram-halt': 'tram halt', 'canal-bridge': 'canal bridge', 'sky-walk': 'sky walk',
}
for _n in range(1, 10):
    NAMES[f'cottage-{_n}'] = f'cottage {_n}'

# Trunk roads: hand-picked waypoints (plaza-relative); the router joins them around whatever stands in the way.
TRUNKS = [  # id, title, district, waypoints, start minute
    ('map-road-east', 'The east road', 'civic', [(13, -3), (30, -3)], 6),
    ('map-road-north', 'The north road', 'civic', [(3, 10), (3, 37), (14, 37), (14, 55)], 8),
    ('map-road-south', 'The south road', 'civic', [(7, -3), (7, -34), (30, -34)], 10),
    ('map-road-west', 'The west road', 'civic', [(-12, 2), (-30, 2), (-30, -26)], 12),
    ('map-road-north-west', 'The north-west road', 'civic', [(3, 37), (-30, 37), (-30, 2)], 14),
    ('map-road-south-west', 'The south-west road', 'civic', [(7, -34), (-24, -34), (-30, -26)], 16),
    ('map-road-east-spine', 'The east spine', 'civic', [(22, -3), (22, 25), (22, 36)], 18),
]
PLAZA = (-11, -1, 13, 9)  # x0, y0, x1, y1 of the paved square

# ============================================================ planning data from the existing works
manifest0 = H.load_manifest(MANIFEST)
EX_GROUPS = [g for g in manifest0['groups'] if not str(g.get('project', g['id'])).startswith(PREFIX)]
HARD, SPR, FOUNDED, BBOX = H.existing_footprint(EX_GROUPS)
EX_LAMPS = []
for _g in EX_GROUPS:
    _bx, _by = H.base_of(_g['anchor'])
    for _op in _g['ops']:
        if _op['op'] == 'sprite' and H.sprite_base(_op['sprite']) in ('StreetLamp', 'StreetLampTall') and _op['at'][2] <= 3:
            EX_LAMPS.append((_bx + _op['at'][0], _by + _op['at'][1]))
START_OF = {}
for _g in EX_GROUPS:
    _p = _g.get('project')
    if _p:
        START_OF[_p] = min(START_OF.get(_p, 10 ** 9), _g.get('release_after_minutes', 0))

N4 = [(1, 0), (0, 1), (-1, 0), (0, -1)]


def reachable(c, m=44):
    """Some plot centre is within m blocks (so a group can be anchored on it with |dx|,|dy| <= 48)."""
    return any(max(abs(c[0] - px), abs(c[1] - py)) <= m for px, py in H.PLOTS.values())


def inside_area(c, slack=RADIUS_OK):
    return reachable(c) and math.hypot(c[0] - H.ORIGIN[0], c[1] - H.ORIGIN[1]) <= slack


def footprint(c, r=1):
    return [(c[0] + i, c[1] + j) for i in range(-r, r + 1) for j in range(-r, r + 1)]


def free_for_road(c):
    """A 3x3 corridor can be centred here: no wall, floor or sprite in it, and it is inside the area."""
    if not inside_area(c):
        return False
    for f in footprint(c):
        if f in HARD or f in SPR:
            return False
    return True


def near_hard(c):
    return any(f in HARD for f in footprint(c, 2))


class Router:
    """Turn-penalised Dijkstra on the centre-line grid."""

    def __init__(self, network):
        self.network = network  # set of centre cells already on the network
        self.cache = {}

    def ok(self, c):
        v = self.cache.get(c)
        if v is None:
            v = self.cache[c] = free_for_road(c)
        return v

    def route(self, sources, goal, turn=2.5, reuse=0.4):
        """sources: cells (cost 0); goal: predicate(cell).  Returns the cell list source..goal or None."""
        heap, best, prev = [], {}, {}
        for s in sources:
            if self.ok(s):
                best[(s, -1)] = 0.0
                heapq.heappush(heap, (0.0, s, -1))
        while heap:
            cost, c, d = heapq.heappop(heap)
            if cost > best.get((c, d), 1e18):
                continue
            if goal(c):
                path, key = [c], (c, d)
                while key in prev:
                    key = prev[key]
                    path.append(key[0])
                return path[::-1]
            for nd, (dx, dy) in enumerate(N4):
                n = (c[0] + dx, c[1] + dy)
                if not self.ok(n):
                    continue
                step = reuse if n in self.network else 1.0
                if near_hard(n):
                    step += 0.8
                if d != -1 and nd != d:
                    step += turn
                nc = cost + step
                if nc < best.get((n, nd), 1e18):
                    best[(n, nd)] = nc
                    prev[(n, nd)] = (c, d)
                    heapq.heappush(heap, (nc, n, nd))
        return None


def snap(c):
    """Nearest cell where a corridor fits (for waypoints placed by hand)."""
    if free_for_road(c):
        return c
    for r in range(1, 8):
        for i in range(-r, r + 1):
            for j in range(-r, r + 1):
                if max(abs(i), abs(j)) == r and free_for_road((c[0] + i, c[1] + j)):
                    return (c[0] + i, c[1] + j)
    raise SystemExit(f'no free corridor near waypoint {c}')


def dense(path):
    """Fill gaps between waypoints joined by the router (it already steps 1 at a time)."""
    return path


# ============================================================ the model: paths, stages, features
class Stage:
    """One group: everything with one anchor / one ground measurement."""

    def __init__(self, project, title):
        self.project, self.title = project, title
        self.pave, self.kerb = {}, {}   # cell -> rgb ; cell -> rgb
        self.fills = []                  # (x0,y0,z0,x1,y1,z1,kind,rgb)
        self.clears = []                 # (x0,y0,z0,x1,y1,z1)
        self.sprites = []                # (x,y,z,name)
        self.found = []                  # (x0,y0,x1,y1,kind,rgb,depth)
        self.anchor = None               # absolute cell used as anchor and ground_at
        self.release = 0
        self.note = ''


class Project:
    def __init__(self, pid, name, purpose, district, start):
        self.pid, self.name, self.purpose, self.district, self.start = pid, name, purpose, district, start
        self.stages = []
        self.parent_release = 0


PROJECTS = []   # in creation order
ROAD = {}       # pave cell -> Stage that owns it
COLOUR = {}     # pave cell -> rgb (final; overlays recolour)
KERBS = {}      # kerb cell -> Stage
RESERVED = set()  # cells holding a standing feature (lamp, planter, pillar, sign) at z>=1
PATHS = []      # dicts: pid, district, cells(list centre cells, build order), stages(list of (Stage, i0, i1))
NETWORK = set() # all centre cells
LAMPS = list(EX_LAMPS)


def new_project(pid, name, purpose, district, start):
    p = Project(pid, name, purpose, district, start)
    PROJECTS.append(p)
    return p


def claim_cells(stage, cells, rgb):
    for c in cells:
        if c in ROAD or c in HARD or not inside_area(c, 104):
            continue
        ROAD[c] = stage
        COLOUR[c] = rgb
        stage.pave[c] = rgb


def add_path(proj, cells, district, rgb, ordered_from_network=True):
    """Cut a centre-line into SEG-cell stages and claim the 3x3 corridor of each."""
    cells = list(cells)
    parts = [cells[i:i + SEG] for i in range(0, len(cells), SEG)]
    if len(parts) > 1 and len(parts[-1]) < 4:   # avoid a stub stage
        parts[-2] += parts[-1]
        parts.pop()
    out = []
    for k, part in enumerate(parts):
        st = Stage(proj.pid, '')
        n = len(parts)
        st.title = f'Paving {proj.name}' + (f' (part {k + 1} of {n})' if n > 1 else '')
        claim_cells(st, [f for c in part for f in footprint(c)], rgb)
        proj.stages.append(st)
        out.append((st, part))
        NETWORK.update(part)
    PATHS.append(dict(pid=proj.pid, district=district, rgb=rgb, cells=cells, parts=out, proj=proj))
    return out


def facing(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    return 0 if dx > 0 else 2 if dx < 0 else 1 if dy > 0 else 3


def build_plaza():
    x0, y0, x1, y1 = PLAZA
    proj = new_project('map-plaza', 'the Harr plaza paving', 'The square at the heart of Harr is paved in pale stone, with a lilac ring and a compass cross.', 'gathering', 2)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    cells = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1) if (x, y) not in HARD]
    # three vertical slices, each with its own ground measurement
    third = (x1 - x0 + 1) // 3
    slices = [[c for c in cells if x0 + i * third <= c[0] < (x0 + (i + 1) * third if i < 2 else x1 + 1)] for i in range(3)]
    names = ['west', 'middle', 'east']
    for i, sl in enumerate(slices):
        st = Stage(proj.pid, f'Paving the {names[i]} of the square')
        for c in sl:
            ring = min(c[0] - x0, x1 - c[0], c[1] - y0, y1 - c[1])
            cross = abs(c[0] - cx) <= 0 or abs(c[1] - cy) <= 0
            rgb = DISTRICTS['gathering'][0] if ring == 2 or (cross and ring > 3) else PALE
            ROAD[c] = st
            COLOUR[c] = rgb
            st.pave[c] = rgb
        proj.stages.append(st)
    for c in cells:
        NETWORK.add(c)
    return proj


def build_trunks(router):
    for pid, title, district, wps, start in TRUNKS:
        proj = new_project(pid, title.lower(), f'{title} links the districts of Harr with a lit, paved road.', district, start)
        cells = []
        wps = [snap(w) for w in wps]
        for a, b in zip(wps, wps[1:]):
            seg = router.route([a], lambda c, b=b: c == b)
            if not seg:
                raise SystemExit(f'{pid}: no route {a} -> {b}')
            cells += seg if not cells else seg[1:]
        # remove cells already part of the network at the start so the first stage is new work
        add_path(proj, cells, district, DISTRICTS['civic'][0])
        router.network = NETWORK


CIVIC_CENTRE = (1, 3)
CIVIC_RADIUS = 15


def district_at(c):
    """The district a road cell belongs to: the quarter of the nearest work site, civic near the square."""
    best = None
    for p, d in DISTRICT_OF.items():
        bb = BBOX.get(p)
        if not bb:
            continue
        gap = max(bb[0] - c[0], c[0] - bb[2], bb[1] - c[1], c[1] - bb[3], 0)
        if best is None or gap < best[0]:
            best = (gap, d)
    if best and best[0] <= 6:
        return best[1]
    if math.hypot(c[0] - CIVIC_CENTRE[0], c[1] - CIVIC_CENTRE[1]) <= CIVIC_RADIUS:
        return 'civic'
    return best[1] if best and best[0] <= 28 else 'civic'


def recolour():
    x0, y0, x1, y1 = PLAZA
    for c in ROAD:
        if x0 <= c[0] <= x1 and y0 <= c[1] <= y1:
            continue
        COLOUR[c] = DISTRICTS[district_at(c)][0]


def bbox_ring_targets(bb, router, dist=3):
    x0, y0, x1, y1 = bb
    out = []
    for x in range(x0 - dist, x1 + dist + 1):
        for y in range(y0 - dist, y1 + dist + 1):
            gap = max(x0 - x, x - x1, y0 - y, y - y1)
            if gap == dist and router.ok((x, y)):
                out.append((x, y))
    return out


def centre_of(bb):
    return ((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)


def build_spurs(router):
    dests = [p for p in DISTRICT_OF if p in BBOX]
    dests.sort(key=lambda p: (math.hypot(*[a - b for a, b in zip(centre_of(BBOX[p]), (0, 3))]), p))
    for p in dests:
        d = DISTRICT_OF[p]
        targets = bbox_ring_targets(BBOX[p], router)
        path = router.route(targets, lambda c: c in NETWORK, turn=3.0)
        if not path:
            print(f'  ! no route to {p}', file=sys.stderr)
            continue
        built = path[::-1]   # from the network out to the site
        # the first cell is on the network; keep it so the stage joins the road, but it is already owned
        proj = new_project(f'map-path-{p}', f'the way to the {NAMES[p]}', f'A paved, lit path to the {NAMES[p]}, tinted for the {DISTRICTS[d][2][4:]}.', d, 0)
        proj.site = p
        proj.join = built[0]
        proj.dest = built[-1]
        add_path(proj, built, d, DISTRICTS[d][0])
        router.network = NETWORK


def pad(stage, centre, district, rgb_inlay, radius=2):
    """A small plaza: pale 5x5, inlay in the district colour, teal heart."""
    cx, cy = centre
    for i in range(-radius, radius + 1):
        for j in range(-radius, radius + 1):
            c = (cx + i, cy + j)
            if c in HARD:
                continue
            if c not in ROAD:
                if not inside_area(c, 104):
                    continue
                ROAD[c] = stage
                stage.pave[c] = PALE
            ring = max(abs(i), abs(j))
            COLOUR[c] = KERB if ring == 0 else (rgb_inlay if ring == 1 else PALE)


def spur_details():
    """Junction pads, crossings, forecourts: run once the roads exist."""
    for pth in PATHS:
        proj = pth['proj']
        if not pth['pid'].startswith('map-path-'):
            continue
        inlay = DISTRICTS[pth['district']][0]
        first = pth['parts'][0][0]
        last = pth['parts'][-1][0]
        join, dest = pth['cells'][0], pth['cells'][-1]
        long_way = len(pth['cells']) >= 7
        pth['pads'] = [join, dest] if long_way else [dest]
        if long_way:
            pad(first, join, pth['district'], inlay)
        pad(last, dest, pth['district'], inlay)
        # a marked crossing three cells out from the junction (two white bars across the corridor)
        cells = pth['cells']
        for k in (4, 6):
            if k + 1 < len(cells) - 3:
                a, b, c = cells[k - 1], cells[k], cells[k + 1]
                if a[0] == b[0] == c[0]:
                    bar = [(b[0] + i, b[1]) for i in (-1, 0, 1)]
                elif a[1] == b[1] == c[1]:
                    bar = [(b[0], b[1] + j) for j in (-1, 0, 1)]
                else:
                    continue
                for cc in bar:
                    if cc in ROAD and ROAD[cc].project == pth['pid']:
                        COLOUR[cc] = WHITE


def all_pave_stage_cells():
    return ROAD


def kerbs():
    for c, st in list(ROAD.items()):
        for dx, dy in N4:
            n = (c[0] + dx, c[1] + dy)
            if n in ROAD or n in KERBS or n in HARD or not inside_area(n, 106):
                continue
            KERBS[n] = st
            st.kerb[n] = KERB


def lamps():
    def far(c, d=6):
        return all(max(abs(c[0] - l[0]), abs(c[1] - l[1])) >= d for l in LAMPS)

    for pth in PATHS:
        cells = pth['cells']
        side = 1
        for i0 in range(2, len(cells) - 1, LAMP_EVERY):
            done = False
            for off in (0, 1, -1, 2, -2, 3, -3):
                i = i0 + off
                if done or not (1 <= i < len(cells) - 1):
                    continue
                a, b = cells[i - 1], cells[i + 1]
                dx, dy = b[0] - a[0], b[1] - a[1]
                if dx and dy:
                    continue
                perp = (0, 1) if dx else (1, 0)
                for s_ in (side, -side):
                    c = (cells[i][0] + perp[0] * 2 * s_, cells[i][1] + perp[1] * 2 * s_)
                    if c in KERBS and c not in SPR and c not in RESERVED and far(c):
                        st = KERBS[c]
                        st.sprites.append((c[0], c[1], 1, 'StreetLamp'))
                        st.clears.append((c[0], c[1], 1, c[0], c[1], 1))
                        RESERVED.add(c)
                        LAMPS.append(c)
                        side = -s_
                        done = True
                        break
    # fill any stretch the regular spacing left dark: the farthest paved cell more than 9 blocks from a light gets one
    kerb_list = sorted(KERBS)
    for _ in range(200):
        worst, wc = 0.0, None
        for c in sorted(ROAD):
            d = min((math.hypot(c[0] - l[0], c[1] - l[1]) for l in LAMPS), default=99)
            if d > worst:
                worst, wc = d, c
        if worst <= 9.0:
            break
        opts = sorted((k for k in kerb_list if max(abs(k[0] - wc[0]), abs(k[1] - wc[1])) <= 3 and k not in SPR and k not in RESERVED),
                      key=lambda k: (math.hypot(k[0] - wc[0], k[1] - wc[1]), k))
        if not opts:
            break
        k = opts[0]
        st = KERBS[k]
        st.sprites.append((k[0], k[1], 1, 'StreetLamp'))
        st.clears.append((k[0], k[1], 1, k[0], k[1], 1))
        RESERVED.add(k)
        LAMPS.append(k)
    # plaza lamps around the square, on the kerb ring
    x0, y0, x1, y1 = PLAZA
    for c in [(x0 - 1, y0 + 3), (x0 - 1, y1 - 3), (x1 + 1, y0 + 3), (x1 + 1, y1 - 3), (-2, y1 + 1), (6, y1 + 1), (-2, y0 - 1)]:
        if c in KERBS and c not in SPR and c not in RESERVED and far(c, 5):
            st = KERBS[c]
            st.sprites.append((c[0], c[1], 1, 'StreetLamp'))
            st.clears.append((c[0], c[1], 1, c[0], c[1], 1))
            RESERVED.add(c)
            LAMPS.append(c)


def free_spot(c, extra=()):
    return (c not in HARD and c not in ROAD and c not in KERBS and c not in SPR and c not in RESERVED
            and c not in extra and inside_area(c, 104))


def planters_and_signs():
    """Junction furniture: a Sign at the corner that faces the branch, planters on the other free corners."""
    for pth in PATHS:
        for idx, centre in enumerate(pth.get('pads', [])):
            st = ROAD.get(centre)
            cells = pth['cells']
            if st is None or len(cells) < 2:
                continue
            toward = cells[1] if centre == cells[0] else cells[-2]
            corners = [(centre[0] + i * 3, centre[1] + j * 3) for i in (-1, 1) for j in (-1, 1)]
            corners = [c for c in corners if free_spot(c)]
            corners.sort(key=lambda c: ((c[0] - toward[0]) ** 2 + (c[1] - toward[1]) ** 2, c))
            for n, c in enumerate(corners):
                st.clears.append((c[0], c[1], 1, c[0], c[1], 2))  # grass and bushes first
                if n == 0 and idx == 0:
                    st.sprites.append((c[0], c[1], 1, f'Sign(Ori({facing(centre, toward)}))'))
                else:
                    st.fills.append((c[0], c[1], 1, c[0], c[1], 1, 'Rock', STONE))
                    st.sprites.append((c[0], c[1], 2, 'Planter'))
                RESERVED.add(c)


# ---- gateways: stone arches of Rock at each district entrance
GATE_TARGET = {  # the point of the quarter's road each gateway should stand nearest to (plaza-relative)
    'learning': (-6, 31), 'making': (22, 10), 'living': (-30, -14), 'gathering': (7, -12), 'energy': (10, -30), 'transport': (-30, 8),
}


def build_gates():
    for d in ('learning', 'making', 'living', 'gathering', 'energy', 'transport'):
        pave, accent, title = DISTRICTS[d]
        cand = []
        for pth in PATHS:
            cells = pth['cells']
            for i in range(3, len(cells) - 3):
                b = cells[i]
                if district_at(b) != d:
                    continue
                a, c3 = cells[i - 3], cells[i + 3]
                if (a[0] == b[0] == c3[0]) or (a[1] == b[1] == c3[1]):
                    dist = math.hypot(b[0] - GATE_TARGET[d][0], b[1] - GATE_TARGET[d][1])
                    cand.append((dist, pth['pid'], i, pth))
        cand.sort(key=lambda t: (t[0], t[1], t[2]))
        for _, _, i, pth in cand:
            cells = pth['cells']
            c, a = cells[i], cells[i - 1]
            horizontal = a[1] == c[1]
            perp = (0, 1) if horizontal else (1, 0)
            pillars = [(c[0] + perp[0] * 3 * s, c[1] + perp[1] * 3 * s) for s in (-1, 1)]
            span = [(c[0] + perp[0] * k, c[1] + perp[1] * k) for k in range(-3, 4)]
            signs = [(c[0] + perp[0] * 4 * s, c[1] + perp[1] * 4 * s) for s in (-1, 1)]
            if not all(free_spot(p) for p in pillars) or any(x in HARD for x in span):
                continue
            # the road under the arch must be only this road (no side street through the span)
            if any(x in ROAD for x in span[:1] + span[-1:]):
                continue
            proj = new_project(f'map-gate-{d}', f'the gate to the {title[4:]}', f'A stone arch marks the way into the {title[4:]}; its paving and its arch share one colour.', d, 0)
            st1 = Stage(proj.pid, f'Raising the pillars of the gate to the {title[4:]}')
            st2 = Stage(proj.pid, f'Setting the lintel of the gate to the {title[4:]}')
            for p in pillars:
                st1.fills.append((p[0], p[1], 1, p[0], p[1], 4, 'Rock', accent))
                RESERVED.add(p)
            st1.anchor = c
            for k in range(-2, 3):
                s_ = span[k + 3]
                st2.fills.append((s_[0], s_[1], 5, s_[0], s_[1], 5, 'Rock', KERB if k == 0 else pave))
                st2.clears.append((s_[0], s_[1], 3, s_[0], s_[1], 4))
            for q in pillars:
                st2.fills.append((q[0], q[1], 5, q[0], q[1], 5, 'Rock', accent))
            for sg in signs:
                if free_spot(sg):
                    st2.sprites.append((sg[0], sg[1], 1, 'Sign'))
                    RESERVED.add(sg)
            st2.anchor = c
            proj.stages += [st1, st2]
            proj.gate_at = c
            break
        else:
            print(f'  ! no room for the {d} gate', file=sys.stderr)


# ---- landscaping
def mound(st, c, r=3):
    for i in range(-r, r + 1):
        for j in range(-r, r + 1):
            d = math.hypot(i, j)
            cc = (c[0] + i, c[1] + j)
            h = 0 if d <= r else -1
            if d <= r - 2:
                h = 2
            elif d <= r - 1:
                h = 1
            if h < 0:
                continue
            for z in range(0, h + 1):
                st.fills.append((cc[0], cc[1], z, cc[0], cc[1], z, 'Grass', GRASS if z == 0 else GRASS_HI))
            RESERVED.add(cc)


def near_road(c, lo=4, hi=9):
    best = min((max(abs(c[0] - r_[0]), abs(c[1] - r_[1])) for r_ in KERBS), default=99)
    return lo <= best <= hi


def mound_free(c, r):
    for i in range(-r - 1, r + 2):
        for j in range(-r - 1, r + 2):
            cc = (c[0] + i, c[1] + j)
            if cc in HARD or cc in ROAD or cc in KERBS or cc in SPR or cc in RESERVED or cc in FOUNDED:
                return False
            if not inside_area(cc, 100):
                return False
    return True


def build_landscape():
    # --- plaza: a fountain basin, planters and low walls
    proj = next(q for q in PROJECTS if q.pid == 'map-plaza')   # same project: the basin is set into the paving
    bx, by = -4, 4
    st1 = Stage(proj.pid, 'Laying the fountain basin')
    st1.fills.append((bx - 2, by - 2, 0, bx + 2, by + 2, 0, 'Rock', WATER))
    ring = [(bx + i, by + j) for i in range(-3, 4) for j in range(-3, 4) if max(abs(i), abs(j)) == 3 and not (abs(i) == 3 and abs(j) <= 0 or abs(j) == 3 and abs(i) <= 0)]
    for c in ring:
        st1.fills.append((c[0], c[1], 0, c[0], c[1], 1, 'Rock', STONE))
    for c in [(bx, by + 3), (bx, by - 3), (bx + 3, by), (bx - 3, by)]:   # four steps into the basin
        st1.fills.append((c[0], c[1], 0, c[0], c[1], 0, 'Rock', PALE))
    st1.found.append((bx - 3, by - 3, bx + 3, by + 3, 'Earth', EARTH, 2))
    st1.anchor = (bx, by - 4)
    st2 = Stage(proj.pid, 'Setting the lamp and benches by the basin')
    st2.fills.append((bx, by, 1, bx, by, 1, 'Rock', STONE))
    st2.sprites.append((bx, by, 2, 'StreetLampTall'))
    for c in [(bx - 5, by), (bx + 5, by)]:
        if free_spot(c):
            st2.sprites.append((c[0], c[1], 1, 'BenchWoodWoodland'))
            RESERVED.add(c)
    st2.anchor = (bx, by - 4)
    st3 = Stage(proj.pid, 'Planters and low walls on the corners of the square')
    x0, y0, x1, y1 = PLAZA
    for (cx, cy, sx, sy) in [(x0 + 1, y0 + 1, 1, 1), (x1 - 1, y0 + 1, -1, 1), (x0 + 1, y1 - 1, 1, -1), (x1 - 1, y1 - 1, -1, -1)]:
        cells = [(cx, cy), (cx + sx, cy), (cx, cy + sy)]
        if all(c not in HARD and c not in SPR and c not in RESERVED for c in cells):
            st3.fills.append((cx, cy, 1, cx, cy, 1, 'Rock', STONE))
            st3.sprites.append((cx, cy, 2, 'Planter'))
            for c in cells[1:]:
                st3.fills.append((c[0], c[1], 1, c[0], c[1], 1, 'Rock', STONE))
            for c in cells:
                RESERVED.add(c)
    st3.anchor = (0, 4)
    proj.stages += [st1, st2, st3]
    # --- mounds and planter clusters in each quarter, on land the roads leave free
    anchors = {  # district -> point the open-ground search spirals out from
        'learning': (-14, 32), 'making': (26, 8), 'living': (-24, -6), 'gathering': (14, -22), 'energy': (16, -30), 'transport': (-24, 12),
    }
    for d, (sx, sy) in anchors.items():
        placed = []   # (centre, radius)
        pave, accent, title = DISTRICTS[d]
        for r in (3, 2):
            for ring_r in range(0, 27, 2):
                for ang in range(0, 360, 20):
                    c = (int(round(sx + ring_r * math.cos(math.radians(ang)))), int(round(sy + ring_r * math.sin(math.radians(ang)))))
                    if len(placed) >= 3:
                        break
                    if (all(max(abs(c[0] - p[0][0]), abs(c[1] - p[0][1])) >= 8 for p in placed) and mound_free(c, r)
                            and near_road(c, r + 2, 12)):
                        placed.append((c, r))
        if len(placed) < 2:
            print(f'  ! only {len(placed)} lawn sites in {d}', file=sys.stderr)
            continue
        lp = new_project(f'map-land-{d}', f'the lawns of the {title[4:]}', f'Grass mounds and a stone planter soften the {title[4:]}.', d, 40)
        for k, (c, r) in enumerate(placed):
            st = Stage(lp.pid, f'Raising a grass mound ({k + 1} of {len(placed)})')
            mound(st, c, r)
            for (i, j) in [(r + 2, 0), (-r - 2, 0), (0, r + 2), (0, -r - 2)]:
                pc = (c[0] + i, c[1] + j)
                if k == 0 and mound_free(pc, 0):
                    st.fills.append((pc[0], pc[1], 1, pc[0], pc[1], 1, 'Rock', STONE))
                    st.sprites.append((pc[0], pc[1], 2, 'Planter'))
                    RESERVED.add(pc)
                    break
            st.anchor = c
            lp.stages.append(st)


# ============================================================ emitting groups
def rects(cells):
    """Greedy rectangles covering a set of (x, y) cells exactly."""
    rows = defaultdict(list)
    for x, y in sorted(cells, key=lambda c: (c[1], c[0])):
        rows[y].append(x)
    runs = {}
    for y, xs in rows.items():
        start = prev = xs[0]
        for x in xs[1:] + [None]:
            if x is not None and x == prev + 1:
                prev = x
                continue
            runs.setdefault((start, prev), []).append(y)
            if x is not None:
                start = prev = x
    out = []
    for (xa, xb), ys in runs.items():
        ys.sort()
        s = p = ys[0]
        for y in ys[1:] + [None]:
            if y is not None and y == p + 1:
                p = y
                continue
            out.append((xa, s, xb, p))
            if y is not None:
                s = p = y
    return sorted(out, key=lambda r: (r[1], r[0]))


def nearest_plot(c):
    best = None
    for key, (px, py) in H.PLOTS.items():
        dx, dy = c[0] - px, c[1] - py
        m = max(abs(dx), abs(dy))
        if m <= 48 and (best is None or m < best[0]):
            best = (m, key, dx, dy)
    if best is None:
        raise SystemExit(f'no plot within reach of {c}')
    return best[1], best[2], best[3]


def pick_anchor(st):
    if st.anchor:
        return st.anchor
    cells = sorted(st.pave) or sorted(st.kerb)
    cx = sum(c[0] for c in cells) / len(cells)
    cy = sum(c[1] for c in cells) / len(cells)
    return min(cells, key=lambda c: ((c[0] - cx) ** 2 + (c[1] - cy) ** 2, c))


def emit(st):
    anchor = pick_anchor(st)
    (plot, nth), dx, dy = nearest_plot(anchor)
    ax, ay = anchor

    def L(x, y):
        return x - ax, y - ay

    ops = []
    # foundation first: fills dips under the road (air below the floor only; two blocks deep)
    cells = set(st.pave) | set(st.kerb)
    for (xa, ya, xb, yb) in rects(cells):
        a, b = L(xa, ya), L(xb, yb)
        ops.append({'op': 'foundation', 'from': [a[0], a[1]], 'to': [b[0], b[1]], 'kind': 'Earth', 'rgb': EARTH, 'depth': 2})
    for (xa, ya, xb, yb, kind, rgb, depth) in st.found:
        a, b = L(xa, ya), L(xb, yb)
        ops.append({'op': 'foundation', 'from': [a[0], a[1]], 'to': [b[0], b[1]], 'kind': kind, 'rgb': list(rgb), 'depth': depth})
    # headroom: two blocks of air above the paving, except where a standing sprite already is
    clear_cells = {c for c in st.pave if c not in SPR}
    for (xa, ya, xb, yb) in rects(clear_cells):
        a, b = L(xa, ya), L(xb, yb)
        ops.append({'op': 'clear', 'from': [a[0], a[1], 1], 'to': [b[0], b[1], 2]})
    # paving by colour
    by_rgb = defaultdict(set)
    for c, rgb in st.pave.items():
        by_rgb[tuple(COLOUR.get(c, rgb))].add(c)
    for rgb in sorted(by_rgb):
        for (xa, ya, xb, yb) in rects(by_rgb[rgb]):
            a, b = L(xa, ya), L(xb, yb)
            ops.append({'op': 'fill', 'from': [a[0], a[1], 0], 'to': [b[0], b[1], 0], 'kind': 'Rock', 'rgb': list(rgb)})
    for (xa, ya, xb, yb) in rects(set(st.kerb)):
        a, b = L(xa, ya), L(xb, yb)
        ops.append({'op': 'fill', 'from': [a[0], a[1], 0], 'to': [b[0], b[1], 0], 'kind': 'Rock', 'rgb': KERB})
    for (x0, y0, z0, x1, y1, z1) in st.clears:
        a, b = L(x0, y0), L(x1, y1)
        ops.append({'op': 'clear', 'from': [a[0], a[1], z0], 'to': [b[0], b[1], z1]})
    for (x0, y0, z0, x1, y1, z1, kind, rgb) in st.fills:
        a, b = L(x0, y0), L(x1, y1)
        ops.append({'op': 'fill', 'from': [a[0], a[1], z0], 'to': [b[0], b[1], z1], 'kind': kind, 'rgb': list(rgb)})
    for (x, y, z, name) in st.sprites:
        a = L(x, y)
        ops.append({'op': 'sprite', 'at': [a[0], a[1], z], 'sprite': name})
    return {'anchor': {'plot': plot, 'nth': nth, 'dx': dx, 'dy': dy}, 'ground_at': [0, 0], 'ops': ops}


def schedule():
    """Release minutes: plaza and trunks first, spurs just before their site's own works begin, gates and lawns after."""
    for p in PROJECTS:
        if p.pid.startswith('map-path-'):
            site = p.site
            want = max(10, START_OF.get(site, 60) - 3 * len(p.stages) - 2)
            parent = ROAD.get(p.join)
            floor = 0
            if parent is not None:
                pp = next(q for q in PROJECTS if q.pid == parent.project)
                floor = parent.release + 1
            p.start = max(want, floor)
        elif p.pid.startswith('map-gate-'):
            d = p.district
            starts = [q.start for q in PROJECTS if q.pid.startswith('map-path-') and q.district == d]
            p.start = (min(starts) if starts else 40) + 4 * GAPM
        elif p.pid.startswith('map-land-') and True:
            d = p.district
            starts = [q.start for q in PROJECTS if q.pid.startswith('map-path-') and q.district == d]
            p.start = (min(starts) if starts else 40) + 20
        for i, st in enumerate(p.stages):
            st.release = p.start + i * GAPM
            st.project = p.pid


def build_all():
    router = Router(NETWORK)
    build_plaza()
    router.network = NETWORK
    build_trunks(router)
    build_spurs(router)
    recolour()
    spur_details()
    kerbs()
    lamps()
    planters_and_signs()
    build_gates()
    build_landscape()
    # a stage can end up with no work (all its cells already paved by an earlier road): drop it
    for p in PROJECTS:
        p.stages = [s for s in p.stages if s.pave or s.fills or s.sprites or s.kerb]
        if p.pid.startswith('map-path-') or p.pid.startswith('map-road-'):
            for k, st in enumerate(p.stages):
                st.title = f'Paving {p.name}' + (f' (part {k + 1} of {len(p.stages)})' if len(p.stages) > 1 else '')
    schedule()


def split_stage(p):
    """A one-stage project becomes two: the furniture (lamps, signs, planters) is set after the paving; a project with
    no furniture splits its paving in half instead."""
    first = p.stages[0]
    second = Stage(p.pid, 'Setting the lamps and planters' if (first.sprites or first.fills) else f'{first.title} (second half)')
    second.release = first.release + GAPM
    if first.sprites or first.fills:
        second.sprites, second.fills, second.clears = first.sprites, first.fills, first.clears
        first.sprites, first.fills, first.clears = [], [], []
        second.anchor = first.anchor
        if not (first.pave or first.kerb):   # nothing is left in the first stage: keep the project as it is
            first.sprites, first.fills, first.clears = second.sprites, second.fills, second.clears
            return
        if not first.anchor:
            second.anchor = pick_anchor(first)
    else:
        cells = sorted(first.pave, key=lambda c: (c[1], c[0]))
        half = set(cells[len(cells) // 2:])
        if not half or len(cells) < 2:
            return
        for c in half:
            second.pave[c] = first.pave.pop(c)
            ROAD[c] = second
        for c in [k for k in first.kerb if (k[1], k[0]) >= (cells[len(cells) // 2][1], cells[len(cells) // 2][0])]:
            second.kerb[c] = first.kerb.pop(c)
            KERBS[c] = second
    p.stages.append(second)


def groups_and_catalogue():
    groups, cat = [], []
    for p in PROJECTS:
        if p.stages and len(p.stages) < 2:   # the works board and tests want every project to have at least two stages
            split_stage(p)
        if len(p.stages) < 2:
            continue
        cat.append({'id': p.pid, 'name': p.name[:1].upper() + p.name[1:], 'purpose': p.purpose, 'stages': len(p.stages), 'first_stage_minutes': p.stages[0].release})
        for i, st in enumerate(p.stages, 1):
            g = emit(st)
            gid = f'{p.pid}-{i}'
            groups.append({'id': gid, **g, 'project': p.pid, 'title': (st.title or f'Stage {i}')[:80],
                           'release_after_minutes': st.release,
                           'note': f'{p.name[:1].upper() + p.name[1:]}, stage {i} of {len(p.stages)}: {st.title}.'})
    return groups, cat


def append_network(manifest_path=MANIFEST, catalogue_path=CATALOGUE, quiet=False):
    """Hook for gen-harr-works.py: (re)writes every map- group and catalogue entry."""
    if not PROJECTS:
        build_all()
    m = json.loads(pathlib.Path(manifest_path).read_text())
    m['groups'] = [g for g in m['groups'] if not str(g.get('project', '')).startswith(PREFIX)]
    groups, cat = groups_and_catalogue()
    m['groups'] += groups
    report = H.check_manifest(m)
    if report['errors'] or report['overlaps']:
        for e in (report['errors'] + report['overlaps'])[:40]:
            print('  CHECK FAILED:', e, file=sys.stderr)
        raise SystemExit('the map does not pass the overlap / limits check; nothing written')
    pathlib.Path(manifest_path).write_text(json.dumps(m, indent=2) + '\n')
    c = json.loads(pathlib.Path(catalogue_path).read_text())
    c['projects'] = [p for p in c['projects'] if not p['id'].startswith(PREFIX)] + cat
    pathlib.Path(catalogue_path).write_text(json.dumps(c, indent=2) + '\n')
    if not quiet:
        s = report['stats']
        print(f'Map: {len(cat)} projects, {len(groups)} groups; manifest now {s["groups"]} groups, {s["total_blocks"]} of {s["limit_blocks"]} blocks.')
    return report


def feature_marks():
    marks = {}
    for p in PROJECTS:
        for st in p.stages:
            for (x, y, z, n) in st.sprites:
                marks[(x, y)] = {'StreetLamp': 'L', 'Planter': 'P', 'StreetLampTall': 'T'}.get(n.split('(')[0], 'S' if n.startswith('Sign') else 'b')
            for (x0, y0, z0, x1, y1, z1, kind, rgb) in st.fills:
                if z1 >= 1 and (x0, y0) not in marks:
                    marks[(x0, y0)] = 'm' if kind == 'Grass' else 'A' if p.pid.startswith('map-gate') else 'w'
    return marks


def debug_ascii(x0=-55, x1=62, y0=-52, y1=70):
    marks = feature_marks()
    rows = []
    for y in range(y1, y0 - 1, -1):
        r = []
        for x in range(x0, x1 + 1):
            c = (x, y)
            if c in marks:
                r.append(marks[c])
            elif c in ROAD:
                r.append({'learning': 'l', 'making': 'k', 'living': 'v', 'gathering': 'g', 'energy': 'e', 'transport': 't'}.get(next((d for d, v in DISTRICTS.items() if list(v[0]) == list(COLOUR.get(c, []))), ''), '#') if COLOUR.get(c) != KERB else '+')
            elif c in KERBS:
                r.append('-')
            elif c in HARD:
                r.append('X')
            elif c in SPR:
                r.append('s')
            else:
                r.append('.')
        rows.append(f'{y:4d} ' + ''.join(r))
    return '\n'.join(rows)


if __name__ == '__main__':
    build_all()
    if '--ascii' in sys.argv:
        print(debug_ascii())
    if '--dry' in sys.argv:
        print(f'{len(PROJECTS)} projects, {sum(len(p.stages) for p in PROJECTS)} stages, {len(ROAD)} pave cells, {len(KERBS)} kerbs')
    else:
        append_network()
