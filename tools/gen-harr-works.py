#!/usr/bin/env python3
"""Generates Harr's public works: staged building projects appended to content/veloren-world-harr.json.

Run from the nemoworld root:  python3 tools/gen-harr-works.py
Idempotent: drops every group with a `project` and rewrites them from scratch.
Also writes content/veloren-projects.json (names, purposes and stages for the works board).
Enforces:
  * Strict limits (extents, volume, ops, total blocks)
  * Automated 3D voxel overlap check between different projects
"""
import json, math, pathlib, sys

root = pathlib.Path(__file__).resolve().parent.parent
mpath = root / 'content' / 'veloren-world-harr.json'
GAP = 10  # minutes between the stages of one project
CREW = 2  # cooperation: from stage 2 onward, a project needs this many people at the site

# Coherent design palette:
STONE = [226, 232, 240]  # Bright composite walls
ROOF = [44, 150, 160]    # Teal roofs
WOOD = [96, 108, 128]    # Weathered timber
EARTH = [110, 84, 60]    # Compacted subsoil
PALE = [205, 220, 236]   # Pale paving / glow ground lines
GLASS = [150, 214, 234]  # Clear sky-blue architectural glass
SOLAR = [28, 44, 92]     # Dark-blue photovoltaic glass
TEAL = [40, 200, 190]    # Vibrant teal trim
STEEL = [150, 160, 176]  # Polished steel framing and floors
CEDAR = [120, 75, 45]    # Warm acoustic cedar panelling

def fill(a, b, kind, rgb): return {'op': 'fill', 'from': a, 'to': b, 'kind': kind, 'rgb': rgb}
def clear(a, b): return {'op': 'clear', 'from': a, 'to': b}
def found(a, b, kind='Earth', rgb=EARTH, depth=4): return {'op': 'foundation', 'from': a, 'to': b, 'kind': kind, 'rgb': rgb, 'depth': depth}
def spr(at, name): return {'op': 'sprite', 'at': at, 'sprite': name}

def box_walls(w, d, z0, z1, kind, rgb):
    return [
        fill([0, 0, z0], [w, 0, z1], kind, rgb),
        fill([0, d, z0], [w, d, z1], kind, rgb),
        fill([0, 0, z0], [0, d, z1], kind, rgb),
        fill([w, 0, z0], [w, d, z1], kind, rgb)
    ]

def ring(x0, y0, x1, y1, z0, z1, kind, rgb):
    return [
        fill([x0, y0, z0], [x1, y0, z1], kind, rgb),
        fill([x0, y1, z0], [x1, y1, z1], kind, rgb),
        fill([x0, y0, z0], [x0, y1, z1], kind, rgb),
        fill([x1, y0, z0], [x1, y1, z1], kind, rgb)
    ]

projects = []  # (id, name, purpose, start_minute, anchor, ground_at, [(stage title, ops)...])

# ---- Living Quarter: Original Cottages (Style 1) ----
def cottage(n, start, anchor):
    w, d = 7, 6
    stages = [
        ('Clearing the plot and laying the floor', [
            clear([0, 0, 1], [w, d, 5]),
            found([0, 0], [w, d]),
            fill([0, 0, 0], [w, d, 0], 'Wood', WOOD)
        ]),
        ('Raising the walls', box_walls(w, d, 1, 3, 'Rock', STONE) + [
            clear([3, 0, 1], [3, 0, 2]),
            spr([1, 0, 2], 'Window1'), spr([5, 0, 2], 'Window1'),
            spr([0, 3, 2], 'Window2'), spr([w, 3, 2], 'Window2')
        ]),
        ('Setting the roof', [
            fill([0, 0, 4], [w, d, 4], 'Rock', ROOF)
        ]),
        ('Furnishing the home', [
            spr([1, 1, 1], 'BedWoodWoodlandHead'), spr([1, 2, 1], 'BedWoodWoodlandMiddle'), spr([1, 3, 1], 'BedWoodWoodlandTail'),
            spr([5, 2, 1], 'TableWoodFancyWoodlandCorner'), spr([5, 3, 1], 'ChairWoodWoodland'), spr([2, 5, 1], 'Hearth'),
            spr([6, 5, 1], 'Lantern'), spr([3, -1, 1], 'FlowerpotWoodWoodlandS'), spr([4, -1, 1], 'Sign')
        ]),
    ]
    projects.append((f'cottage-{n}', f'Cottage {n}', 'A new home for the neighbours who are arriving; each cottage is built by the village together.', start, anchor, [3, 0], stages))

# Style A: Tall split-level stone & timber cottages
def cottage_style_a(n, start, anchor):
    w, d = 6, 6
    stages = [
        ('Clearing the foundation terrace', [
            clear([0, 0, 1], [w, d, 6]),
            found([0, 0], [w, d], 'Earth', EARTH, 4),
            fill([0, 0, 0], [w, d, 0], 'Rock', STONE)
        ]),
        ('Framing split-level composite walls', box_walls(w, d, 1, 4, 'Rock', STONE) + [
            clear([3, 0, 1], [3, 0, 2]),
            spr([1, 0, 2], 'Window3'), spr([5, 0, 2], 'Window3'),
            spr([0, 3, 3], 'Window4'), spr([w, 3, 3], 'Window4'),
            fill([1, 1, 3], [5, 5, 3], 'Wood', WOOD)
        ]),
        ('Pitched roof and solar skylight', [
            fill([0, 0, 5], [w, d, 5], 'Rock', ROOF),
            fill([2, 2, 5], [4, 4, 5], 'Rock', SOLAR)
        ]),
        ('Living amenities and balcony lamp', [
            spr([1, 1, 4], 'BedWoodWoodlandHead'), spr([1, 2, 4], 'BedWoodWoodlandMiddle'), spr([1, 3, 4], 'BedWoodWoodlandTail'),
            spr([4, 4, 1], 'TableWoodFancyWoodlandCorner'), spr([3, 4, 1], 'ChairWoodWoodland'),
            spr([1, 4, 1], 'DrawerWoodWoodlandM1'), spr([5, 1, 1], 'Lantern'),
            spr([3, -1, 1], 'Sign')
        ]),
    ]
    projects.append((f'cottage-{n}', f'Cottage {n}', f'A modern split-level eco-cottage with solar skylights for Harr residents.', start, anchor, [3, 0], stages))

# Style B: Stepped dome eco-cottages
def cottage_style_b(n, start, anchor):
    w, d = 6, 5
    stages = [
        ('Excavating stone footing', [
            clear([0, 0, 1], [w, d, 5]),
            found([0, 0], [w, d], 'Rock', PALE, 3),
            fill([0, 0, 0], [w, d, 0], 'Rock', STEEL)
        ]),
        ('Curved rock walls and viewing panes', box_walls(w, d, 1, 3, 'Rock', STONE) + [
            clear([3, 0, 1], [3, 0, 2]),
            spr([1, 0, 2], 'Window1'), spr([5, 0, 2], 'Window1'),
            spr([0, 2, 2], 'Window2'), spr([w, 2, 2], 'Window2')
        ]),
        ('Stepped glass dome roof', [
            fill([1, 1, 4], [5, 4, 4], 'Rock', GLASS),
            fill([2, 2, 5], [4, 3, 5], 'Rock', ROOF)
        ]),
        ('Interior furnishings and garden box', [
            spr([1, 1, 1], 'BedWoodWoodlandHead'), spr([1, 2, 1], 'BedWoodWoodlandMiddle'), spr([1, 3, 1], 'BedWoodWoodlandTail'),
            spr([4, 2, 1], 'DiningtableWoodWoodlandSquare'), spr([4, 3, 1], 'ChairWoodWoodland'),
            spr([5, 1, 1], 'Planter'), spr([2, 4, 1], 'Lantern'),
            spr([3, -1, 1], 'Sign')
        ]),
    ]
    projects.append((f'cottage-{n}', f'Cottage {n}', f'A sun-warmed stepped dome cottage surrounded by flowering planters.', start, anchor, [3, 0], stages))

# ==================== 18 EXISTING PROJECTS ====================
# 1. the well
projects.append(('well', 'The Plaza well', 'Fresh water for the square, built ring by ring.', 5, {'plot': 'Plaza', 'nth': 0, 'dx': -12, 'dy': -8}, [2, 2], [
    ('Marking out and laying the base', [clear([0, 0, 1], [4, 4, 4]), found([0, 0], [4, 4], 'Rock', STONE, 3), fill([0, 0, 0], [4, 4, 0], 'Rock', STONE)]),
    ('Raising the stone ring', [fill([0, 0, 1], [4, 0, 1], 'Rock', STONE), fill([0, 4, 1], [4, 4, 1], 'Rock', STONE), fill([0, 0, 1], [0, 4, 1], 'Rock', STONE), fill([4, 0, 1], [4, 4, 1], 'Rock', STONE)]),
    ('Posts, a bucket and a lantern', [spr([2, 2, 1], 'BarrelWoodWater'), spr([0, 0, 2], 'LanternpostWoodBase'), spr([0, 0, 3], 'LanternpostWoodUpper'), spr([0, 0, 4], 'Lantern'), spr([5, 2, 1], 'BucketWoodM'), spr([-1, 2, 1], 'Sign')]),
]))

# 2. the market hall
projects.append(('market-hall', 'The market hall', 'A roofed hall where makers and farmers share what they have grown and made.', 15, {'plot': 'Plaza', 'nth': 0, 'dx': 10, 'dy': -13}, [4, 3], [
    ('Levelling the ground and laying the floor', [clear([0, 0, 1], [10, 6, 6]), found([0, 0], [10, 6], 'Earth', EARTH, 4), fill([0, 0, 0], [10, 6, 0], 'Wood', WOOD)]),
    ('Raising the posts', [fill([c[0], c[1], 1], [c[0], c[1], 3], 'Wood', WOOD) for c in ([0, 0], [10, 0], [0, 6], [10, 6], [5, 0], [5, 6])]),
    ('Laying the roof', [fill([0, 0, 4], [10, 6, 4], 'Wood', [96, 72, 52])]),
    ('Stalls, baskets and lanterns', [spr([1, 1, 1], 'CounterWoodEnd'), spr([2, 1, 1], 'CounterWoodMiddle'), spr([3, 1, 1], 'CounterWoodEnd'), spr([7, 1, 1], 'CounterWoodEnd'), spr([8, 1, 1], 'CounterWoodEnd'),
                                      spr([1, 2, 1], 'BasketWovenL'), spr([8, 2, 1], 'CrateBlock'), spr([5, 3, 1], 'BarrelWoodWater'), spr([2, 5, 1], 'SackLeatherM'), spr([8, 5, 1], 'Hay'),
                                      spr([0, 3, 3], 'Lantern'), spr([10, 3, 3], 'Lantern'), spr([5, -1, 1], 'Sign')]),
]))

# 3. cottage-1
cottage(1, 35, {'plot': 'Plaza', 'nth': 0, 'dx': -26, 'dy': 2})

# 4. observatory
projects.append(('observatory', 'The star observatory', 'A raised stone platform where scholars chart the sky and record what they learn.', 50, {'plot': 'Plaza', 'nth': 0, 'dx': -4, 'dy': -18}, [4, 4], [
    ('Raising the platform', [clear([0, 0, 1], [8, 8, 5]), found([0, 0], [8, 8], 'Rock', STONE, 6), fill([0, 0, 0], [8, 8, 1], 'Rock', STONE)]),
    ('Parapet and steps', [fill([0, 0, 2], [8, 0, 2], 'Rock', PALE), fill([0, 8, 2], [8, 8, 2], 'Rock', PALE), fill([0, 0, 2], [0, 8, 2], 'Rock', PALE), fill([8, 0, 2], [8, 8, 2], 'Rock', PALE), clear([4, 0, 2], [4, 0, 2])]),
    ('The star chart table', [spr([4, 4, 2], 'CrystalBall'), spr([3, 4, 2], 'BenchWoodWoodland'), spr([5, 4, 2], 'BenchWoodWoodland'), spr([1, 1, 2], 'Lantern'), spr([7, 7, 2], 'Lantern'), spr([4, -1, 2], 'Sign')]),
]))

# 5. lantern-path
projects.append(('lantern-path', 'The lantern path', 'A lit path from the square to the fields so no one walks home in the dark.', 70, {'plot': 'Plaza', 'nth': 0, 'dx': 4, 'dy': -3}, [2, 0], [
    ('Laying the first stretch', [found([0, 0], [11, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (1, 6, 11)]),
    ('Laying the second stretch', [found([12, 0], [23, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (17, 23)]),
    # the glass garden stands from x=32 (plaza-relative); its clearing used to cut the last two lamps down, so the path now stops at x=31
    ('Laying the last stretch', [found([24, 0], [27, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (27,)]),
]))

# 6. cottage-2
cottage(2, 85, {'plot': 'Plaza', 'nth': 0, 'dx': -26, 'dy': 14})

# 7. field-pavilion
projects.append(('field-pavilion', 'The field pavilion', 'A shaded open pavilion beside the fields for rest, reading and shared meals.', 95, {'plot': 'FarmField', 'nth': 0, 'dx': 14, 'dy': 0}, [4, 3], [
    ('Laying the floor', [clear([0, 0, 1], [8, 6, 5]), found([0, 0], [8, 6], 'Earth', EARTH, 4), fill([0, 0, 0], [8, 6, 0], 'Wood', WOOD)]),
    ('Posts and roof', [fill([c[0], c[1], 1], [c[0], c[1], 3], 'Wood', WOOD) for c in ([0, 0], [8, 0], [0, 6], [8, 6])] + [fill([0, 0, 4], [8, 6, 4], 'Wood', [96, 72, 52])]),
    ('Benches, a table and lanterns', [spr([2, 2, 1], 'BenchWoodWoodland'), spr([3, 2, 1], 'BenchWoodWoodland'), spr([5, 2, 1], 'DiningtableWoodWoodlandRound'), spr([2, 4, 1], 'BenchWoodWoodland'), spr([3, 4, 1], 'BenchWoodWoodland'),
                                      spr([0, 3, 3], 'Lantern'), spr([8, 3, 3], 'Lantern'), spr([4, -1, 1], 'Sign')]),
]))

# 8. library-annex (L3: Furnished Interior)
projects.append(('library-annex', 'The library annex', 'More shelves for the Harr Library, where every discovery is written down.', 110, {'plot': 'House', 'nth': 0, 'dx': 10, 'dy': 0}, [3, 0], [
    ('Foundation and floor', [clear([0, 0, 1], [7, 5, 5]), found([0, 0], [7, 5], 'Earth', EARTH, 4), fill([0, 0, 0], [7, 5, 0], 'Wood', WOOD)]),
    ('Walls and windows', box_walls(7, 5, 1, 3, 'Rock', STONE) + [clear([3, 0, 1], [3, 0, 2]), spr([1, 0, 2], 'Window3'), spr([5, 0, 2], 'Window3'), spr([0, 2, 2], 'Window4'), spr([7, 2, 2], 'Window4')]),
    ('Roof', [fill([0, 0, 4], [7, 5, 4], 'Rock', ROOF)]),
    ('Shelves, desks and reading lamps', [
        spr([1, 4, 1], 'BookshelfMiddle'), spr([2, 4, 1], 'BookshelfMiddle'), spr([3, 4, 1], 'BookshelfEnd'),
        spr([5, 4, 1], 'BookshelfMiddle'), spr([6, 4, 1], 'BookshelfEnd'),
        spr([2, 2, 1], 'TableWoodFancyWoodlandCorner'), spr([3, 2, 1], 'TableWoodFancyWoodlandBody'),
        spr([2, 1, 1], 'ChairWoodWoodland'), spr([5, 2, 1], 'ChairWoodWoodland'),
        spr([6, 1, 1], 'Lantern'), spr([1, 1, 1], 'CrystalBall'),
        spr([4, -1, 1], 'Sign')
    ]),
]))

# 9. cottage-3
cottage(3, 125, {'plot': 'Plaza', 'nth': 0, 'dx': -12, 'dy': 22})

# 10. orchard-gate
projects.append(('orchard-gate', 'The orchard fence and gate', 'A low fence and a welcoming gate so the orchard can grow in peace.', 140, {'plot': 'FarmField', 'nth': 1, 'dx': 0, 'dy': -6}, [2, 0], [
    ('The west fence', [spr([x, 0, 1], 'FenceWoodWoodland') for x in range(0, 6)]),
    ('The east fence and the gate', [spr([x, 0, 1], 'FenceWoodWoodland') for x in range(7, 13)] + [spr([6, 0, 1], 'FenceWoodGateWoodland'), spr([6, -1, 1], 'Sign'), spr([5, -1, 1], 'Lantern'), spr([7, -1, 1], 'Lantern')]),
]))

# 11. research-tower (L3: Furnished Interior)
projects.append(('research-tower', 'The research tower', 'A slim glass-banded tower where scholars gather the village\'s findings into one view.', 20, {'plot': 'Plaza', 'nth': 0, 'dx': 34, 'dy': 18}, [3, 3], [
    ('Raising the platform', [clear([0, 0, 1], [6, 6, 20]), found([0, 0], [6, 6], 'Rock', STONE, 6), fill([0, 0, 0], [6, 6, 0], 'Rock', STEEL)]),
    ('The lower shaft and ground study', ring(0, 0, 6, 6, 1, 8, 'Rock', STONE) + [clear([3, 0, 1], [3, 0, 2])] + [spr([x, y, z], 'Window3') for (x, y) in ((2, 0), (4, 0), (2, 6), (4, 6), (0, 3), (6, 3)) for z in (4, 6)] + [fill([0, 0, 4], [6, 6, 4], 'Rock', STEEL)]),
    ('The upper shaft and reading deck', ring(0, 0, 6, 6, 9, 16, 'Rock', STONE) + [spr([x, y, z], 'Window4') for (x, y) in ((2, 0), (4, 0), (2, 6), (4, 6), (0, 3), (6, 3)) for z in (11, 13)] + [fill([0, 0, 8], [6, 6, 8], 'Rock', STEEL), fill([0, 0, 17], [6, 6, 17], 'Rock', ROOF)]),
    ('The crown, telescope optics and research folios', [
        fill([3, 3, 18], [3, 3, 22], 'Rock', TEAL),
        spr([0, 0, 18], 'Lantern'), spr([6, 0, 18], 'Lantern'), spr([0, 6, 18], 'Lantern'), spr([6, 6, 18], 'Lantern'),
        spr([3, 3, 1], 'CrystalBall'), spr([1, 5, 1], 'BookshelfMiddle'), spr([5, 5, 1], 'BookshelfMiddle'),
        spr([2, 2, 1], 'TableWoodFancyWoodlandBody'), spr([4, 2, 1], 'ChairWoodWoodland'),
        spr([3, 3, 9], 'TableWoodFancyWoodlandCorner'), spr([3, 4, 9], 'CrystalBall'),
        spr([3, -1, 1], 'Sign')
    ]),
]))

# 12. solar-array
projects.append(('solar-array', 'The solar array', 'Rows of solar glass that charge the village lamps by day and light the paths all night.', 40, {'plot': 'Plaza', 'nth': 0, 'dx': 24, 'dy': -30}, [5, 4], [
    ('Levelling and paving', [clear([0, 0, 1], [12, 8, 4]), found([0, 0], [12, 8], 'Rock', PALE, 3)]),
    ('The first two rows', [fill([x, y, 1], [x, y, 1], 'Rock', STEEL) for y in (1, 4) for x in (1, 5, 9)] + [fill([x - 1, y - 1, 2], [x + 1, y + 1, 2], 'Rock', SOLAR) for y in (1, 4) for x in (1, 5, 9)]),
    ('The last row and the lamps', [fill([x, 7, 1], [x, 7, 1], 'Rock', STEEL) for x in (1, 5, 9)] + [fill([x - 1, 6, 2], [x + 1, 8, 2], 'Rock', SOLAR) for x in (1, 5, 9)] + [spr([0, 0, 1], 'StreetLamp'), spr([12, 0, 1], 'StreetLamp'), spr([6, -1, 1], 'Sign')]),
]))

# 13. vertical-farm
projects.append(('vertical-farm', 'The vertical farm', 'A stacked greenhouse tower where crops grow in bright rooms, feeding more people from less land.', 80, {'plot': 'FarmField', 'nth': 1, 'dx': -30, 'dy': 8}, [3, 3], [
    ('Foundation and the first floor', [clear([0, 0, 1], [6, 6, 14]), found([0, 0], [6, 6], 'Rock', PALE, 5), fill([0, 0, 0], [6, 6, 0], 'Rock', STEEL)]),
    ('The first two levels', ring(0, 0, 6, 6, 1, 3, 'Rock', GLASS) + [clear([3, 0, 1], [3, 0, 2]), fill([0, 0, 4], [6, 6, 4], 'Rock', STEEL)] + ring(0, 0, 6, 6, 5, 7, 'Rock', GLASS) + [fill([0, 0, 8], [6, 6, 8], 'Rock', STEEL)] + [spr([x, 2, 1], 'Planter') for x in (2, 3, 4)] + [spr([x, 2, 5], 'Planter') for x in (2, 3, 4)]),
    ('The upper levels', ring(0, 0, 6, 6, 9, 11, 'Rock', GLASS) + [fill([0, 0, 12], [6, 6, 12], 'Rock', ROOF)] + [spr([x, 4, 9], 'Planter') for x in (2, 3, 4)] + [spr([x, y, 2], 'Window2') for (x, y) in ((1, 0), (5, 0), (0, 3), (6, 3))]),
    ('Lamps, hanging gardens and the sign', [spr([1, 1, 1], 'Lantern'), spr([5, 5, 5], 'Lantern'), spr([1, 1, 9], 'Lantern'), spr([3, 5, 1], 'HangingBasket'), spr([3, -1, 1], 'Sign')]),
]))

# 14. light-fountain
projects.append(('light-fountain', 'The light fountain', 'A basin of light and lamps where neighbours rest after a day of work.', 60, {'plot': 'Plaza', 'nth': 0, 'dx': -6, 'dy': -28}, [4, 4], [
    ('Laying the basin', [clear([0, 0, 1], [8, 8, 6]), found([0, 0], [8, 8], 'Rock', PALE, 3), fill([0, 0, 0], [8, 8, 0], 'Rock', PALE)] + ring(0, 0, 8, 8, 1, 1, 'Rock', TEAL)),
    ('The inner ring and the pillar', ring(2, 2, 6, 6, 1, 2, 'Rock', STONE) + [fill([4, 4, 1], [4, 4, 5], 'Rock', STONE)]),
    ('The crown and the lamps', [fill([4, 4, 6], [4, 4, 6], 'Rock', TEAL), spr([4, 4, 7], 'Lantern')] + [spr([x, y, 2], 'Lantern') for (x, y) in ((0, 0), (8, 0), (0, 8), (8, 8))] + [spr([x, 9, 1], 'BenchWoodWoodland') for x in (2, 6)]),
]))

# 15. transit-hub
projects.append(('transit-hub', 'The sky transit hub', 'A pale platform with a canopy and lamps, ready for the quiet light-rail and landing pads of the future.', 105, {'plot': 'Workshop', 'nth': 0, 'dx': -36, 'dy': -10}, [7, 4], [
    ('Levelling the platform', [clear([0, 0, 1], [14, 8, 6]), found([0, 0], [14, 8], 'Rock', PALE, 4), fill([0, 0, 0], [14, 8, 0], 'Rock', PALE)]),
    ('Pillars and the canopy', [fill([c[0], c[1], 1], [c[0], c[1], 4], 'Rock', STEEL) for c in ([1, 1], [13, 1], [1, 7], [13, 7], [7, 1], [7, 7])] + [fill([0, 0, 5], [14, 8, 5], 'Rock', ROOF)]),
    ('Benches, lamps and the landing ring', [spr([x, 4, 1], 'BenchWoodWoodland') for x in (3, 4, 10, 11)] + [spr([x, y, 4], 'Lantern') for (x, y) in ((1, 1), (13, 1), (1, 7), (13, 7))] + ring(5, 2, 9, 6, 1, 1, 'Rock', TEAL) + [spr([7, -1, 1], 'Sign')]),
]))

# 16. data-archive (L3: Furnished Interior)
projects.append(('data-archive', 'The open archive', 'A long glass hall where every finding, plan and story is kept for anyone to read, and for other villages to learn from.', 150, {'plot': 'Workshop', 'nth': 0, 'dx': -8, 'dy': 22}, [6, 3], [
    ('Foundation and floor', [clear([0, 0, 1], [12, 5, 6]), found([0, 0], [12, 5], 'Rock', PALE, 4), fill([0, 0, 0], [12, 5, 0], 'Rock', STEEL)]),
    ('Glass walls and the doors', ring(0, 0, 12, 5, 1, 3, 'Rock', GLASS) + [clear([6, 0, 1], [6, 0, 2])] + [spr([x, 0, 2], 'Window1') for x in (2, 4, 8, 10)] + [spr([x, 5, 2], 'Window1') for x in (2, 4, 8, 10)]),
    ('Roof, shelves, archive folios and reading lamps', [
        fill([0, 0, 4], [12, 5, 4], 'Rock', ROOF),
        spr([1, 4, 1], 'BookshelfMiddle'), spr([2, 4, 1], 'BookshelfMiddle'), spr([3, 4, 1], 'BookshelfEnd'),
        spr([8, 4, 1], 'BookshelfMiddle'), spr([9, 4, 1], 'BookshelfMiddle'), spr([10, 4, 1], 'BookshelfEnd'),
        spr([4, 2, 1], 'TableWoodFancyWoodlandBody'), spr([7, 2, 1], 'TableWoodFancyWoodlandBody'),
        spr([4, 1, 1], 'ChairWoodWoodland'), spr([7, 1, 1], 'ChairWoodWoodland'),
        spr([1, 1, 1], 'DrawerWoodWoodlandL1'), spr([10, 1, 1], 'CupboardArabic'),
        spr([6, 3, 3], 'Lantern'), spr([6, -1, 1], 'Sign')
    ]),
]))

# 17. sky-walk
projects.append(('sky-walk', 'The sky walk', 'A raised promenade with lamps, so neighbours can cross the square and see the whole village.', 130, {'plot': 'Plaza', 'nth': 0, 'dx': 8, 'dy': 26}, [12, 1], [
    ('The pillars', [fill([x, y, 0], [x, y, 5], 'Rock', STEEL) for x in (0, 8, 16, 24) for y in (0, 2)]),
    ('The deck', [fill([0, 0, 6], [24, 2, 6], 'Rock', PALE)]),
    ('The rails and the lamps', [fill([0, 0, 7], [24, 0, 7], 'Rock', TEAL), fill([0, 2, 7], [24, 2, 7], 'Rock', TEAL)] + [spr([x, 1, 7], 'StreetLamp') for x in (2, 10, 18, 24)]),
]))

# 18. glass-garden
projects.append(('glass-garden', 'The glass garden', 'A stepped glass dome over a garden of planters and benches, warm in every season.', 175, {'plot': 'House', 'nth': 0, 'dx': 20, 'dy': -34}, [6, 6], [
    ('Foundation and floor', [clear([0, 0, 1], [12, 12, 9]), found([0, 0], [12, 12], 'Rock', PALE, 4), fill([0, 0, 0], [12, 12, 0], 'Rock', STEEL)]),
    ('The ring wall and the door', ring(0, 0, 12, 12, 1, 3, 'Rock', GLASS) + [clear([6, 0, 1], [6, 0, 2])] + [spr([x, 0, 2], 'Window1') for x in (2, 4, 8, 10)]),
    ('The stepped dome', [fill([1, 1, 4], [11, 11, 4], 'Rock', GLASS), fill([2, 2, 5], [10, 10, 5], 'Rock', GLASS), fill([3, 3, 6], [9, 9, 6], 'Rock', GLASS), fill([4, 4, 7], [8, 8, 7], 'Rock', GLASS), fill([5, 5, 8], [7, 7, 8], 'Rock', ROOF)]),
    ('Planters, benches and lamps', [spr([x, y, 1], 'Planter') for (x, y) in ((3, 3), (9, 3), (3, 9), (9, 9), (6, 6))] + [spr([x, 6, 1], 'BenchWoodWoodland') for x in (2, 10)] + [spr([6, 2, 1], 'Lantern'), spr([6, 10, 1], 'Lantern'), spr([6, -1, 1], 'Sign')]),
]))


# ==================== 18 NEW PROJECTS (L2 + L3) ====================

# ---- District 1: Learning Quarter ----
# 19. schoolhouse (L3: Furnished Interior)
projects.append(('schoolhouse', 'The Harr schoolhouse', 'A two-storey house of study where young and old villagers learn reading, history and botany together.', 10, {'plot': 'Workshop', 'nth': 0, 'dx': -20, 'dy': 18}, [4, 0], [
    ('Excavation and stone floor', [
        clear([0, 0, 1], [8, 8, 8]),
        found([0, 0], [8, 8], 'Rock', STONE, 4),
        fill([0, 0, 0], [8, 8, 0], 'Rock', PALE)
    ]),
    ('Composite walls and classroom windows', box_walls(8, 8, 1, 4, 'Rock', STONE) + [
        clear([4, 0, 1], [4, 0, 2]),
        spr([1, 0, 2], 'Window3'), spr([7, 0, 2], 'Window3'),
        spr([0, 4, 2], 'Window3'), spr([8, 4, 2], 'Window3'),
        fill([1, 1, 4], [7, 7, 4], 'Wood', WOOD)
    ]),
    ('Teal timber roof and gables', [
        fill([0, 0, 5], [8, 8, 5], 'Rock', ROOF),
        fill([1, 1, 6], [7, 7, 6], 'Rock', ROOF),
        fill([2, 2, 7], [6, 6, 7], 'Rock', ROOF)
    ]),
    ('Study desks, botanical planters and library shelves', [
        spr([2, 2, 1], 'DiningtableWoodWoodlandSquare'), spr([2, 3, 1], 'ChairWoodWoodland'),
        spr([5, 2, 1], 'DiningtableWoodWoodlandSquare'), spr([5, 3, 1], 'ChairWoodWoodland'),
        spr([1, 7, 1], 'BookshelfMiddle'), spr([2, 7, 1], 'BookshelfMiddle'), spr([3, 7, 1], 'BookshelfEnd'),
        spr([6, 6, 1], 'CarpenterTable'), spr([6, 6, 2], 'CrystalBall'),
        spr([1, 1, 1], 'Planter'), spr([7, 1, 1], 'Planter'),
        spr([4, 4, 3], 'Lantern'), spr([4, -1, 1], 'Sign')
    ]),
]))

# 20. seminar-pavilion
projects.append(('seminar-pavilion', 'The seminar pavilion', 'An open circular colonnade for philosophical discussion and research presentations.', 30, {'plot': 'Workshop', 'nth': 0, 'dx': -34, 'dy': 20}, [4, 4], [
    ('Circular stone terrace', [
        clear([0, 0, 1], [8, 8, 6]),
        found([0, 0], [8, 8], 'Rock', PALE, 4),
        fill([0, 0, 0], [8, 8, 0], 'Rock', PALE)
    ]),
    ('Composite columns and perimeter benches', [
        fill([c[0], c[1], 1], [c[0], c[1], 4], 'Rock', STONE) for c in ([1, 1], [7, 1], [1, 7], [7, 7], [4, 1], [4, 7])
    ] + [
        spr([2, 4, 1], 'BenchWoodWoodland'), spr([6, 4, 1], 'BenchWoodWoodland'),
        spr([4, 2, 1], 'BenchWoodWoodland'), spr([4, 6, 1], 'BenchWoodWoodland')
    ]),
    ('Glass skylight canopy and presentation dais', [
        fill([1, 1, 5], [7, 7, 5], 'Rock', GLASS),
        fill([3, 3, 5], [5, 5, 5], 'Rock', TEAL),
        spr([4, 4, 1], 'TableWoodFancyWoodlandRound' if False else 'TableWoodFancyWoodlandCorner'),
        spr([4, 4, 2], 'Lantern'),
        spr([4, -1, 1], 'Sign')
    ]),
]))

# ---- District 2: Making Quarter ----
# 21. workshop-hall
projects.append(('workshop-hall', 'The makers\' workshop hall', 'A spacious open hall with visible forge-free craft benches for textile, wood, and ceramic artisans.', 45, {'plot': 'Workshop', 'nth': 0, 'dx': 14, 'dy': -6}, [5, 0], [
    ('Steel floor and post piers', [
        clear([0, 0, 1], [10, 6, 6]),
        found([0, 0], [10, 6], 'Rock', STEEL, 4),
        fill([0, 0, 0], [10, 6, 0], 'Rock', STEEL)
    ]),
    ('Timber columns and upper clerestory', [
        fill([c[0], c[1], 1], [c[0], c[1], 3], 'Wood', WOOD) for c in ([0, 0], [10, 0], [0, 6], [10, 6], [5, 0], [5, 6])
    ] + [
        fill([0, 0, 3], [10, 6, 3], 'Rock', GLASS),
        clear([1, 1, 3], [9, 5, 3])
    ]),
    ('Teal timber roof truss', [
        fill([0, 0, 4], [10, 6, 4], 'Rock', ROOF),
        fill([1, 1, 5], [9, 5, 5], 'Rock', ROOF)
    ]),
    ('Forge-free craft benches and artisan stations', [
        spr([2, 1, 1], 'CraftingBench'), spr([4, 1, 1], 'RepairBench'),
        spr([6, 1, 1], 'SpinningWheel'), spr([8, 1, 1], 'Loom'),
        spr([2, 5, 1], 'CarpenterTable'), spr([5, 5, 1], 'CarpenterCrateWoodL'),
        spr([8, 5, 1], 'BarrelWoodWater'), spr([1, 3, 2], 'Lantern'), spr([9, 3, 2], 'Lantern'),
        spr([5, -1, 1], 'Sign')
    ]),
]))

# 22. recycling-garden
projects.append(('recycling-garden', 'The material recycling garden', 'Tidy stone sorting bays where unused clay, timber trimmings and metal offcuts are sorted for reuse.', 65, {'plot': 'Workshop', 'nth': 0, 'dx': 14, 'dy': -14}, [4, 0], [
    ('Paved yard and dividing curbs', [
        clear([0, 0, 1], [8, 6, 4]),
        found([0, 0], [8, 6], 'Rock', PALE, 3),
        fill([0, 0, 0], [8, 6, 0], 'Rock', PALE),
        fill([4, 0, 1], [4, 5, 1], 'Rock', STONE)
    ]),
    ('Sorting bins and storage hampers', [
        spr([1, 2, 1], 'CrateBlock'), spr([2, 2, 1], 'CrateBlock'),
        spr([1, 4, 1], 'Barrel'), spr([2, 4, 1], 'Barrel'),
        spr([6, 2, 1], 'SackLeatherM'), spr([7, 2, 1], 'SackLeatherM'),
        spr([6, 4, 1], 'CarpenterCrateWoodS')
    ]),
    ('Perimeter planters and guiding lantern', [
        spr([0, 1, 1], 'Planter'), spr([0, 5, 1], 'Planter'),
        spr([8, 1, 1], 'Planter'), spr([8, 5, 1], 'Planter'),
        spr([4, 0, 2], 'Lantern'), spr([4, -1, 1], 'Sign')
    ]),
]))

# ---- District 3: Living Quarter (Cottages 4-9 & Guesthouse) ----
# 23. cottage-4 (Style A)
cottage_style_a(4, 75, {'plot': 'Plaza', 'nth': 0, 'dx': -38, 'dy': -8})

# 24. cottage-5 (Style A)
cottage_style_a(5, 100, {'plot': 'Plaza', 'nth': 0, 'dx': -38, 'dy': -16})

# 25. cottage-6 (Style A)
cottage_style_a(6, 155, {'plot': 'Plaza', 'nth': 0, 'dx': -38, 'dy': -24})

# 26. cottage-7 (Style B)
cottage_style_b(7, 115, {'plot': 'Plaza', 'nth': 0, 'dx': 22, 'dy': -18})

# 27. cottage-8 (Style B)
cottage_style_b(8, 145, {'plot': 'Plaza', 'nth': 0, 'dx': 30, 'dy': -18})

# 28. cottage-9 (Style B)
cottage_style_b(9, 165, {'plot': 'Plaza', 'nth': 0, 'dx': 38, 'dy': -18})

# 29. guesthouse (L3: Furnished Interior)
projects.append(('guesthouse', 'The travellers\' guesthouse', 'A warm and restful lodge welcoming newcomers with clean beds, hot tea and quiet reading rooms.', 55, {'plot': 'House', 'nth': 0, 'dx': -10, 'dy': 14}, [4, 0], [
    ('Foundation, timber floor and hearth pad', [
        clear([0, 0, 1], [8, 6, 7]),
        found([0, 0], [8, 6], 'Earth', EARTH, 4),
        fill([0, 0, 0], [8, 6, 0], 'Wood', WOOD)
    ]),
    ('Composite walls, entrance door and guest windows', box_walls(8, 6, 1, 3, 'Rock', STONE) + [
        clear([4, 0, 1], [4, 0, 2]),
        spr([1, 0, 2], 'Window1'), spr([7, 0, 2], 'Window1'),
        spr([0, 3, 2], 'Window2'), spr([8, 3, 2], 'Window2')
    ]),
    ('Teal timber roof and front porch awning', [
        fill([0, 0, 4], [8, 6, 4], 'Rock', ROOF),
        fill([1, 1, 5], [7, 5, 5], 'Rock', ROOF),
        fill([3, -1, 3], [5, 0, 3], 'Rock', TEAL)
    ]),
    ('Welcoming hearth, guest beds, dining table and warm lanterns', [
        spr([1, 1, 1], 'BedWoodWoodlandHead'), spr([1, 2, 1], 'BedWoodWoodlandMiddle'), spr([1, 3, 1], 'BedWoodWoodlandTail'),
        spr([7, 1, 1], 'BedWoodWoodlandHead'), spr([7, 2, 1], 'BedWoodWoodlandMiddle'), spr([7, 3, 1], 'BedWoodWoodlandTail'),
        spr([4, 5, 1], 'Hearth'),
        spr([4, 2, 1], 'DiningtableWoodWoodlandSquare'), spr([3, 2, 1], 'ChairWoodWoodland'), spr([5, 2, 1], 'ChairWoodWoodland'),
        spr([1, 5, 1], 'BookshelfMiddle'), spr([7, 5, 1], 'CupboardMesa'),
        spr([4, -1, 2], 'Lantern'), spr([4, 1, 2], 'Lantern'),
        spr([4, -2, 1], 'Sign')
    ]),
]))

# ---- District 4: Gathering Quarter ----
# 30. amphitheatre
projects.append(('amphitheatre', 'The hillside amphitheatre', 'A tiered open-air stone bowl facing the valley where residents gather for story circle.', 90, {'plot': 'Plaza', 'nth': 0, 'dx': -20, 'dy': -32}, [5, 4], [
    ('Terrace grading and speaker dais', [
        clear([0, 0, 1], [10, 8, 5]),
        found([0, 0], [10, 8], 'Rock', PALE, 4),
        fill([0, 0, 0], [10, 8, 0], 'Rock', PALE),
        fill([4, 1, 1], [6, 2, 1], 'Rock', STONE)
    ]),
    ('Tiered stone seating arcs', [
        fill([1, 3, 1], [9, 4, 1], 'Rock', STONE),
        fill([0, 5, 2], [10, 6, 2], 'Rock', STONE),
        fill([0, 7, 3], [10, 8, 3], 'Rock', STONE)
    ]),
    ('Cedar acoustic shell and ambient lanterns', [
        fill([2, 0, 1], [8, 0, 4], 'Wood', CEDAR),
        spr([1, 1, 2], 'Lantern'), spr([9, 1, 2], 'Lantern'),
        spr([0, 7, 4], 'StreetLamp'), spr([10, 7, 4], 'StreetLamp'),
        spr([5, -1, 1], 'Sign')
    ]),
]))

# 31. festival-lawn
projects.append(('festival-lawn', 'The festival lawn and lamp arches', 'A wide grass commons framed by glowing lamp arches for communal feasts and holiday round dances.', 120, {'plot': 'Plaza', 'nth': 0, 'dx': -20, 'dy': -44}, [6, 4], [
    ('Lawn turf and pale paving perimeter', [
        clear([0, 0, 1], [12, 8, 5]),
        found([0, 0], [12, 8], 'Rock', PALE, 3),
        fill([1, 1, 0], [11, 7, 0], 'Grass', [110, 175, 75]),
    ] + ring(0, 0, 12, 8, 0, 0, 'Rock', PALE)),
    ('Raising teal lamp arches', [
        fill([c[0], c[1], 1], [c[0], c[1], 4], 'Rock', TEAL) for c in ([2, 0], [10, 0], [2, 8], [10, 8])
    ] + [
        fill([2, 0, 4], [10, 0, 4], 'Rock', TEAL),
        fill([2, 8, 4], [10, 8, 4], 'Rock', TEAL),
        spr([6, 0, 5], 'Lantern'), spr([6, 8, 5], 'Lantern')
    ]),
    ('Feast tables, flower planters and festival sign', [
        spr([4, 4, 1], 'TableCoastalLarge'), spr([8, 4, 1], 'TableCoastalLarge'),
        spr([4, 3, 1], 'BenchWoodWoodland'), spr([4, 5, 1], 'BenchWoodWoodland'),
        spr([8, 3, 1], 'BenchWoodWoodland'), spr([8, 5, 1], 'BenchWoodWoodland'),
        spr([0, 2, 1], 'Planter'), spr([0, 6, 1], 'Planter'),
        spr([12, 2, 1], 'Planter'), spr([12, 6, 1], 'Planter'),
        spr([6, -1, 1], 'Sign')
    ]),
]))

# ---- District 5: Water and Energy Quarter ----
# 32. water-tower
projects.append(('water-tower', 'The elevated water tower', 'A stone and steel reservoir tower providing hydrostatic pressure to Harr\'s irrigation network.', 105, {'plot': 'FarmField', 'nth': 0, 'dx': -10, 'dy': 10}, [3, 3], [
    ('Reinforced stone piers and conduit core', [
        clear([0, 0, 1], [6, 6, 14]),
        found([0, 0], [6, 6], 'Rock', STONE, 5),
    ] + [
        fill([c[0], c[1], 0], [c[0] + 1, c[1] + 1, 6], 'Rock', STONE) for c in ([0, 0], [4, 0], [0, 4], [4, 4])
    ] + [
        fill([2, 2, 0], [3, 3, 8], 'Rock', STEEL)
    ]),
    ('Steel bracing and maintenance gallery', [
        fill([0, 0, 6], [5, 5, 6], 'Rock', STEEL),
    ] + ring(0, 0, 5, 5, 7, 7, 'Rock', TEAL)),
    ('Enclosed reservoir cistern and teal dome', [
        fill([0, 0, 8], [5, 5, 12], 'Rock', STONE),
        clear([1, 1, 9], [4, 4, 11]),
        fill([1, 1, 13], [4, 4, 13], 'Rock', ROOF),
        fill([2, 2, 14], [3, 3, 14], 'Rock', ROOF)
    ]),
    ('Telemetry beacon, pressure valves and inspection sign', [
        spr([2, 2, 15], 'Lantern'),
        spr([2, 0, 1], 'BarrelWoodWater'),
        spr([3, -1, 1], 'Sign')
    ]),
]))

# 33. solar-field-2
projects.append(('solar-field-2', 'The southern solar array', 'An expanded field of high-efficiency solar glass charging the nocturnal grid.', 135, {'plot': 'Plaza', 'nth': 0, 'dx': 22, 'dy': -42}, [6, 3], [
    ('Paving the southern terrace', [
        clear([0, 0, 1], [12, 6, 4]),
        found([0, 0], [12, 6], 'Rock', PALE, 3),
        fill([0, 0, 0], [12, 6, 0], 'Rock', PALE)
    ]),
    ('Dual rows of solar collector mounts', [
        fill([x, y, 1], [x, y, 1], 'Rock', STEEL) for y in (1, 4) for x in (1, 5, 9)
    ] + [
        fill([x - 1, y - 1, 2], [x + 1, y + 1, 2], 'Rock', SOLAR) for y in (1, 4) for x in (1, 5, 9)
    ]),
    ('Monitoring console and perimeter lamps', [
        spr([0, 0, 1], 'StreetLamp'), spr([12, 0, 1], 'StreetLamp'),
        spr([6, 3, 1], 'Lantern'),
        spr([6, -1, 1], 'Sign')
    ]),
]))

# 34. wind-array
projects.append(('wind-array', 'The quiet ridge wind array', 'Three vertical-axis spiral turbines that harness gentle ridge winds without noise.', 160, {'plot': 'Plaza', 'nth': 0, 'dx': 4, 'dy': -44}, [5, 2], [
    ('Foundation anchor pads on the high ridge', [
        clear([0, 0, 1], [10, 4, 12]),
        found([0, 0], [10, 4], 'Rock', PALE, 3),
        fill([0, 0, 0], [10, 4, 0], 'Rock', PALE)
    ]),
    ('Three vertical-axis spiral turbine pylons', [
        fill([x, 2, 1], [x, 2, 8], 'Rock', STEEL) for x in (2, 5, 8)
    ] + [
        fill([x - 1, 2, 4], [x + 1, 2, 7], 'Rock', TEAL) for x in (2, 5, 8)
    ]),
    ('Beacon caps, telemetry box and perimeter railing', [
        spr([x, 2, 9], 'Lantern') for x in (2, 5, 8)
    ] + [
        spr([0, 0, 1], 'FenceWoodWoodland'), spr([10, 0, 1], 'FenceWoodWoodland'),
        spr([5, -1, 1], 'Sign')
    ]),
]))

# ---- District 6: Transport Quarter ----
# 35. canal-bridge
projects.append(('canal-bridge', 'The canal stone bridge', 'An arched stone footbridge connecting the central plaza to the western workshops.', 25, {'plot': 'Plaza', 'nth': 0, 'dx': -8, 'dy': 10}, [3, 2], [
    ('Abutment footings and canal clearing', [
        clear([0, 0, 1], [6, 4, 4]),
        found([0, 0], [6, 4], 'Rock', STONE, 3),
        fill([0, 0, 0], [1, 3, 0], 'Rock', STONE),
        fill([4, 0, 0], [5, 3, 0], 'Rock', STONE)
    ]),
    ('Arched bridge deck and glow paving', [
        fill([1, 1, 1], [4, 2, 1], 'Rock', STONE),
        fill([2, 1, 2], [3, 2, 2], 'Rock', PALE)
    ]),
    ('Balustrades and bridge lanterns', [
        fill([0, 0, 2], [5, 0, 2], 'Rock', TEAL),
        fill([0, 3, 2], [5, 3, 2], 'Rock', TEAL),
        spr([0, 0, 3], 'StreetLamp'), spr([5, 0, 3], 'StreetLamp'),
        spr([3, -1, 1], 'Sign')
    ]),
]))

# 36. tram-halt
projects.append(('tram-halt', 'The valley tram halt', 'A passenger halt with canopy and timetable for the future light-rail connection.', 170, {'plot': 'Plaza', 'nth': 0, 'dx': -3, 'dy': -6}, [3, 2], [
    ('Passenger platform foundation', [
        clear([0, 0, 1], [6, 4, 5]),
        found([0, 0], [6, 4], 'Rock', PALE, 3),
        fill([0, 0, 0], [6, 4, 0], 'Rock', STEEL)
    ]),
    ('Steel canopy supports and curved roof', [
        fill([c[0], c[1], 1], [c[0], c[1], 3], 'Rock', STEEL) for c in ([0, 0], [6, 0], [0, 3], [6, 3])
    ] + [
        fill([0, 0, 4], [6, 3, 4], 'Rock', ROOF),
        fill([1, 1, 4], [5, 2, 4], 'Rock', GLASS)
    ]),
    ('Waiting benches, route map and timetable lantern', [
        spr([2, 1, 1], 'BenchWoodWoodland'), spr([4, 1, 1], 'BenchWoodWoodland'),
        spr([0, 1, 2], 'Lantern'), spr([6, 1, 2], 'Lantern'),
        spr([3, -1, 1], 'Sign')
    ]),
]))


# ==================== AUTOMATED OVERLAP & LIMITS CHECKS ====================
print(f"Loaded {len(projects)} projects. Running automated verification...")

plot_offsets = {
    ("Plaza", 0): (0, 0),
    ("House", 0): (12, 30),
    ("FarmField", 0): (18, 48),
    ("FarmField", 1): (12, 6),
    ("Workshop", 0): (-6, 18),
}

claimed_voxels = {}  # (x, y, z) -> (project_id, group_id)
total_blocks = 0
total_groups = 0

for pid, name, purpose, start, anchor, ground_at, stages in projects:
    po = plot_offsets[(anchor['plot'], anchor['nth'])]
    base_x = po[0] + anchor['dx']
    base_y = po[1] + anchor['dy']
    
    # Check anchor extents
    assert abs(anchor['dx']) <= 48 and abs(anchor['dy']) <= 48, f"{pid}: anchor offset exceeds 48"
    
    for s_idx, (stitle, ops) in enumerate(stages, 1):
        total_groups += 1
        assert len(ops) <= 600, f"{pid}-{s_idx}: ops count {len(ops)} exceeds 600"
        
        group_blocks = 0
        for op in ops:
            if op['op'] == 'fill':
                f = op['from']
                t = op['to']
                vol = (abs(t[0] - f[0]) + 1) * (abs(t[1] - f[1]) + 1) * (abs(t[2] - f[2]) + 1)
                assert vol <= 4096, f"{pid}-{s_idx}: fill volume {vol} exceeds 4096"
                group_blocks += vol
                
                # Check height bounds
                assert f[2] >= -12 and t[2] <= 24, f"{pid}-{s_idx}: fill height out of bounds [-12, 24]"
                
                # Check 3D overlaps with other projects
                x_min, x_max = min(f[0], t[0]), max(f[0], t[0])
                y_min, y_max = min(f[1], t[1]), max(f[1], t[1])
                z_min, z_max = min(f[2], t[2]), max(f[2], t[2])
                for vx in range(base_x + x_min, base_x + x_max + 1):
                    for vy in range(base_y + y_min, base_y + y_max + 1):
                        for vz in range(z_min, z_max + 1):
                            cell = (vx, vy, vz)
                            if cell in claimed_voxels:
                                prev_pid, prev_gid = claimed_voxels[cell]
                                if prev_pid != pid:
                                    raise AssertionError(f"OVERLAP ERROR: {pid} ({stitle}) collides with {prev_pid} ({prev_gid}) at cell {cell}")
                            claimed_voxels[cell] = (pid, f"{pid}-{s_idx}")
            elif op['op'] == 'sprite':
                at = op['at']
                assert at[2] >= -12 and at[2] <= 24, f"{pid}-{s_idx}: sprite height out of bounds"
                cell = (base_x + at[0], base_y + at[1], at[2])
                if cell in claimed_voxels:
                    prev_pid, prev_gid = claimed_voxels[cell]
                    if prev_pid != pid:
                        raise AssertionError(f"OVERLAP ERROR: {pid} sprite collides with {prev_pid} at {cell}")
                claimed_voxels[cell] = (pid, f"{pid}-{s_idx}")

        assert group_blocks <= 6000, f"{pid}-{s_idx}: group blocks {group_blocks} exceeds 6000"
        total_blocks += group_blocks

assert total_groups <= 600, f"Total groups {total_groups} exceeds 600"
assert total_blocks <= 60_000, f"Total blocks {total_blocks} exceeds 60,000"
print(f"Overlap check passed: {len(claimed_voxels)} unique voxel cells claimed across {len(projects)} projects.")
print(f"Limits check passed: {total_groups} groups (max 600), {total_blocks} blocks (max 60,000).")

# ==================== WRITE MANIFEST & CATALOGUE ====================
manifest = json.loads(mpath.read_text())
manifest['groups'] = [g for g in manifest['groups'] if not g.get('project')]
manifest['area']['radius'] = 110  # Encompasses all districts comfortably within 150 limit
catalogue = []

for pid, name, purpose, start, anchor, ground_at, stages in projects:
    catalogue.append({'id': pid, 'name': name, 'purpose': purpose, 'stages': len(stages), 'first_stage_minutes': start})
    for i, (title, ops) in enumerate(stages, 1):
        manifest['groups'].append({
            'id': f'{pid}-{i}', 'anchor': anchor, 'ground_at': ground_at, 'project': pid, 'title': title,
            'release_after_minutes': start + (i - 1) * GAP,
            **({'crew': CREW} if i >= 2 and pid != 'lantern-path' else {}),
            'note': f'{name}, stage {i} of {len(stages)}: {title}.', 'ops': ops})

mpath.write_text(json.dumps(manifest, indent=2) + '\n')
(root / 'content' / 'veloren-projects.json').write_text(json.dumps({'format': 'nemo-works-v1', 'stage_gap_minutes': GAP, 'projects': catalogue}, indent=2) + '\n')
print(f"Wrote {len(projects)} projects, {sum(p['stages'] for p in catalogue)} stages to {mpath.name} and veloren-projects.json.")

# ==================== HARR'S MAP: roads, gateways, landscaping (tools/gen-harr-network.py) ====================
# The network generator appends its own groups (project ids start with `map-`) to the manifest and its projects to the
# catalogue we just wrote.  It re-runs the overlap / limits check over ALL groups and refuses to write if it fails.
_net = pathlib.Path(__file__).resolve().parent / 'gen-harr-network.py'
if _net.exists():
    import importlib.util
    sys.path.insert(0, str(_net.parent))
    _spec = importlib.util.spec_from_file_location('gen_harr_network', _net)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    _mod.append_network()
