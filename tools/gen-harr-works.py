#!/usr/bin/env python3
"""Generates Harr's public works: staged building projects appended to content/veloren-world-harr.json.

Run from the nemoworld root:  python3 tools/gen-harr-works.py
Idempotent: it drops every group that has a `project` and writes the projects again, so edit this file,
not the JSON. Also writes content/veloren-projects.json (names and purposes for the works board).
Everything is additive (a later stage never removes an earlier one), peaceful and original.
"""
import json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
mpath = root / 'content' / 'veloren-world-harr.json'
GAP = 10  # minutes between the stages of one project
CREW = 2  # cooperation: from its second stage on, a project is built only while this many people stand at the site
# Harr's new look: bright composite walls, teal roofs, steel floors, pale paving, dark-blue solar glass.
STONE = [226, 232, 240]; ROOF = [44, 150, 160]; WOOD = [96, 108, 128]; EARTH = [110, 84, 60]; PALE = [205, 220, 236]
GLASS = [150, 214, 234]; SOLAR = [28, 44, 92]; TEAL = [40, 200, 190]; STEEL = [150, 160, 176]


def fill(a, b, kind, rgb): return {'op': 'fill', 'from': a, 'to': b, 'kind': kind, 'rgb': rgb}
def clear(a, b): return {'op': 'clear', 'from': a, 'to': b}
def found(a, b, kind='Earth', rgb=EARTH, depth=4): return {'op': 'foundation', 'from': a, 'to': b, 'kind': kind, 'rgb': rgb, 'depth': depth}
def spr(at, name): return {'op': 'sprite', 'at': at, 'sprite': name}


projects = []   # (id, name, purpose, start_minute, anchor, ground_at, [(stage title, ops)...])


def box_walls(w, d, z0, z1, kind, rgb):
    return [fill([0, 0, z0], [w, 0, z1], kind, rgb), fill([0, d, z0], [w, d, z1], kind, rgb),
            fill([0, 0, z0], [0, d, z1], kind, rgb), fill([w, 0, z0], [w, d, z1], kind, rgb)]


def cottage(n, start, anchor):
    w, d = 7, 6
    stages = [
        ('Clearing the plot and laying the floor', [clear([0, 0, 1], [w, d, 5]), found([0, 0], [w, d]), fill([0, 0, 0], [w, d, 0], 'Wood', WOOD)]),
        ('Raising the walls', box_walls(w, d, 1, 3, 'Rock', STONE) + [clear([3, 0, 1], [3, 0, 2]), spr([1, 0, 2], 'Window1'), spr([5, 0, 2], 'Window1'), spr([0, 3, 2], 'Window2'), spr([w, 3, 2], 'Window2')]),
        ('Setting the roof', [fill([0, 0, 4], [w, d, 4], 'Rock', ROOF)]),
        ('Furnishing the home', [spr([1, 1, 1], 'BedWoodWoodlandHead'), spr([1, 2, 1], 'BedWoodWoodlandMiddle'), spr([1, 3, 1], 'BedWoodWoodlandTail'),
                                 spr([5, 2, 1], 'TableWoodFancyWoodlandCorner'), spr([5, 3, 1], 'ChairWoodWoodland'), spr([2, 5, 1], 'Hearth'),
                                 spr([6, 5, 1], 'Lantern'), spr([3, -1, 1], 'FlowerpotWoodWoodlandS'), spr([4, -1, 1], 'Sign')]),
    ]
    projects.append((f'cottage-{n}', f'Cottage {n}', 'A new home for the neighbours who are arriving; each cottage is built by the village together.', start, anchor, [3, 0], stages))


# 1. the well
projects.append(('well', 'The Plaza well', 'Fresh water for the square, built ring by ring.', 5, {'plot': 'Plaza', 'nth': 0, 'dx': -12, 'dy': -8}, [2, 2], [
    ('Marking out and laying the base', [clear([0, 0, 1], [4, 4, 4]), found([0, 0], [4, 4], 'Rock', STONE, 3), fill([0, 0, 0], [4, 4, 0], 'Rock', STONE)]),
    ('Raising the stone ring', [fill([0, 0, 1], [4, 0, 1], 'Rock', STONE), fill([0, 4, 1], [4, 4, 1], 'Rock', STONE), fill([0, 0, 1], [0, 4, 1], 'Rock', STONE), fill([4, 0, 1], [4, 4, 1], 'Rock', STONE)]),
    ('Posts, a bucket and a lantern', [spr([2, 2, 1], 'BarrelWoodWater'), spr([0, 0, 2], 'LanternpostWoodBase'), spr([0, 0, 3], 'LanternpostWoodUpper'), spr([0, 0, 4], 'Lantern'), spr([5, 2, 1], 'BucketWoodM'), spr([-1, 2, 1], 'Sign')]),
]))

# 2. the market hall
projects.append(('market-hall', 'The market hall', 'A roofed hall where makers and farmers share what they have grown and made.', 20, {'plot': 'Plaza', 'nth': 0, 'dx': 10, 'dy': -13}, [4, 3], [
    ('Levelling the ground and laying the floor', [clear([0, 0, 1], [10, 6, 6]), found([0, 0], [10, 6], 'Earth', EARTH, 4), fill([0, 0, 0], [10, 6, 0], 'Wood', WOOD)]),
    ('Raising the posts', [fill([c[0], c[1], 1], [c[0], c[1], 3], 'Wood', WOOD) for c in ([0, 0], [10, 0], [0, 6], [10, 6], [5, 0], [5, 6])]),
    ('Laying the roof', [fill([0, 0, 4], [10, 6, 4], 'Wood', [96, 72, 52])]),
    ('Stalls, baskets and lanterns', [spr([1, 1, 1], 'CounterWoodEnd'), spr([2, 1, 1], 'CounterWoodMiddle'), spr([3, 1, 1], 'CounterWoodEnd'), spr([7, 1, 1], 'CounterWoodEnd'), spr([8, 1, 1], 'CounterWoodEnd'),
                                      spr([1, 2, 1], 'BasketWovenL'), spr([8, 2, 1], 'CrateBlock'), spr([5, 3, 1], 'BarrelWoodWater'), spr([2, 5, 1], 'SackLeatherM'), spr([8, 5, 1], 'Hay'),
                                      spr([0, 3, 3], 'Lantern'), spr([10, 3, 3], 'Lantern'), spr([5, -1, 1], 'Sign')]),
]))

cottage(1, 35, {'plot': 'Plaza', 'nth': 0, 'dx': -26, 'dy': 2})

# 4. observatory (research)
projects.append(('observatory', 'The star observatory', 'A raised stone platform where scholars chart the sky and record what they learn.', 50, {'plot': 'Plaza', 'nth': 0, 'dx': -4, 'dy': -18}, [4, 4], [
    ('Raising the platform', [clear([0, 0, 1], [8, 8, 5]), found([0, 0], [8, 8], 'Rock', STONE, 6), fill([0, 0, 0], [8, 8, 1], 'Rock', STONE)]),
    ('Parapet and steps', [fill([0, 0, 2], [8, 0, 2], 'Rock', PALE), fill([0, 8, 2], [8, 8, 2], 'Rock', PALE), fill([0, 0, 2], [0, 8, 2], 'Rock', PALE), fill([8, 0, 2], [8, 8, 2], 'Rock', PALE), clear([4, 0, 2], [4, 0, 2])]),
    ('The star chart table', [spr([4, 4, 2], 'CrystalBall'), spr([3, 4, 2], 'BenchWoodWoodland'), spr([5, 4, 2], 'BenchWoodWoodland'), spr([1, 1, 2], 'Lantern'), spr([7, 7, 2], 'Lantern'), spr([4, -1, 2], 'Sign')]),
]))

# 5. lantern path
projects.append(('lantern-path', 'The lantern path', 'A lit path from the square to the fields so no one walks home in the dark.', 65, {'plot': 'Plaza', 'nth': 0, 'dx': 4, 'dy': -3}, [2, 0], [
    ('Laying the first stretch', [found([0, 0], [11, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (1, 6, 11)]),
    ('Laying the second stretch', [found([12, 0], [23, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (17, 23)]),
    ('Laying the last stretch', [found([24, 0], [35, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (29, 35)]),
]))

cottage(2, 80, {'plot': 'Plaza', 'nth': 0, 'dx': -26, 'dy': 14})

# 7. pavilion
projects.append(('field-pavilion', 'The field pavilion', 'A shaded open pavilion beside the fields for rest, reading and shared meals.', 95, {'plot': 'FarmField', 'nth': 0, 'dx': 14, 'dy': 0}, [4, 3], [
    ('Laying the floor', [clear([0, 0, 1], [8, 6, 5]), found([0, 0], [8, 6], 'Earth', EARTH, 4), fill([0, 0, 0], [8, 6, 0], 'Wood', WOOD)]),
    ('Posts and roof', [fill([c[0], c[1], 1], [c[0], c[1], 3], 'Wood', WOOD) for c in ([0, 0], [8, 0], [0, 6], [8, 6])] + [fill([0, 0, 4], [8, 6, 4], 'Wood', [96, 72, 52])]),
    ('Benches, a table and lanterns', [spr([2, 2, 1], 'BenchWoodWoodland'), spr([3, 2, 1], 'BenchWoodWoodland'), spr([5, 2, 1], 'DiningtableWoodWoodlandRound'), spr([2, 4, 1], 'BenchWoodWoodland'), spr([3, 4, 1], 'BenchWoodWoodland'),
                                      spr([0, 3, 3], 'Lantern'), spr([8, 3, 3], 'Lantern'), spr([4, -1, 1], 'Sign')]),
]))

# 8. library annex
projects.append(('library-annex', 'The library annex', 'More shelves for the Harr Library, where every discovery is written down.', 110, {'plot': 'House', 'nth': 0, 'dx': 10, 'dy': 0}, [3, 0], [
    ('Foundation and floor', [clear([0, 0, 1], [7, 5, 5]), found([0, 0], [7, 5], 'Earth', EARTH, 4), fill([0, 0, 0], [7, 5, 0], 'Wood', WOOD)]),
    ('Walls and windows', box_walls(7, 5, 1, 3, 'Rock', STONE) + [clear([3, 0, 1], [3, 0, 2]), spr([1, 0, 2], 'Window3'), spr([5, 0, 2], 'Window3'), spr([0, 2, 2], 'Window4'), spr([7, 2, 2], 'Window4')]),
    ('Roof', [fill([0, 0, 4], [7, 5, 4], 'Rock', ROOF)]),
    ('Shelves, desks and the reading lamp', [spr([1, 4, 1], 'BookshelfMiddle'), spr([2, 4, 1], 'BookshelfMiddle'), spr([3, 4, 1], 'BookshelfEnd'), spr([5, 4, 1], 'BookshelfMiddle'), spr([6, 4, 1], 'BookshelfEnd'),
                                           spr([2, 2, 1], 'TableWoodFancyWoodlandCorner'), spr([3, 2, 1], 'TableWoodFancyWoodlandBody'), spr([2, 1, 1], 'ChairWoodWoodland'), spr([6, 1, 1], 'Lantern'), spr([4, -1, 1], 'Sign')]),
]))

cottage(3, 125, {'plot': 'Plaza', 'nth': 0, 'dx': -14, 'dy': 16})

# 10. orchard gate
projects.append(('orchard-gate', 'The orchard fence and gate', 'A low fence and a welcoming gate so the orchard can grow in peace.', 140, {'plot': 'FarmField', 'nth': 1, 'dx': 0, 'dy': -6}, [2, 0], [
    ('The west fence', [spr([x, 0, 1], 'FenceWoodWoodland') for x in range(0, 6)]),
    ('The east fence and the gate', [spr([x, 0, 1], 'FenceWoodWoodland') for x in range(7, 13)] + [spr([6, 0, 1], 'FenceWoodGateWoodland'), spr([6, -1, 1], 'Sign'), spr([5, -1, 1], 'Lantern'), spr([7, -1, 1], 'Lantern')]),
]))

# ---- the innovation district: tall, bright and calm. Every project is additive and peaceful. ----
def ring(x0, y0, x1, y1, z0, z1, kind, rgb):
    return [fill([x0, y0, z0], [x1, y0, z1], kind, rgb), fill([x0, y1, z0], [x1, y1, z1], kind, rgb),
            fill([x0, y0, z0], [x0, y1, z1], kind, rgb), fill([x1, y0, z0], [x1, y1, z1], kind, rgb)]


# the research tower: seven by seven, eighteen high, where scholars read the village's findings
projects.append(('research-tower', 'The research tower', 'A slim glass-banded tower where scholars gather the village\'s findings into one view.', 20, {'plot': 'Plaza', 'nth': 0, 'dx': 34, 'dy': 18}, [3, 3], [
    ('Raising the platform', [clear([0, 0, 1], [6, 6, 20]), found([0, 0], [6, 6], 'Rock', STONE, 6), fill([0, 0, 0], [6, 6, 0], 'Rock', STEEL)]),
    ('The lower shaft', ring(0, 0, 6, 6, 1, 8, 'Rock', STONE) + [clear([3, 0, 1], [3, 0, 2])] + [spr([x, y, z], 'Window3') for (x, y) in ((2, 0), (4, 0), (2, 6), (4, 6), (0, 3), (6, 3)) for z in (4, 6)] + [fill([0, 0, 4], [6, 6, 4], 'Rock', STEEL)]),
    ('The upper shaft and the cap', ring(0, 0, 6, 6, 9, 16, 'Rock', STONE) + [spr([x, y, z], 'Window4') for (x, y) in ((2, 0), (4, 0), (2, 6), (4, 6), (0, 3), (6, 3)) for z in (11, 13)] + [fill([0, 0, 8], [6, 6, 8], 'Rock', STEEL), fill([0, 0, 17], [6, 6, 17], 'Rock', ROOF)]),
    ('The crown and the star glass', [fill([3, 3, 18], [3, 3, 22], 'Rock', TEAL), spr([0, 0, 18], 'Lantern'), spr([6, 0, 18], 'Lantern'), spr([0, 6, 18], 'Lantern'), spr([6, 6, 18], 'Lantern'),
                                       spr([3, 3, 1], 'CrystalBall'), spr([1, 5, 1], 'BookshelfMiddle'), spr([5, 5, 1], 'BookshelfMiddle'), spr([3, -1, 1], 'Sign')]),
]))

# solar array: three rows of dark-blue glass on slim posts, so the lamps never go out
projects.append(('solar-array', 'The solar array', 'Rows of solar glass that charge the village lamps by day and light the paths all night.', 40, {'plot': 'Plaza', 'nth': 0, 'dx': 24, 'dy': -30}, [5, 4], [
    ('Levelling and paving', [clear([0, 0, 1], [12, 8, 4]), found([0, 0], [12, 8], 'Rock', PALE, 3)]),
    ('The first two rows', [fill([x, y, 1], [x, y, 1], 'Rock', STEEL) for y in (1, 4) for x in (1, 5, 9)] + [fill([x - 1, y - 1, 2], [x + 1, y + 1, 2], 'Rock', SOLAR) for y in (1, 4) for x in (1, 5, 9)]),
    ('The last row and the lamps', [fill([x, 7, 1], [x, 7, 1], 'Rock', STEEL) for x in (1, 5, 9)] + [fill([x - 1, 6, 2], [x + 1, 8, 2], 'Rock', SOLAR) for x in (1, 5, 9)] + [spr([0, 0, 1], 'StreetLamp'), spr([12, 0, 1], 'StreetLamp'), spr([6, -1, 1], 'Sign')]),
]))

# vertical farm: a stacked greenhouse tower that feeds more people from less land
projects.append(('vertical-farm', 'The vertical farm', 'A stacked greenhouse tower where crops grow in bright rooms, feeding more people from less land.', 75, {'plot': 'FarmField', 'nth': 1, 'dx': -30, 'dy': 8}, [3, 3], [
    ('Foundation and the first floor', [clear([0, 0, 1], [6, 6, 14]), found([0, 0], [6, 6], 'Rock', PALE, 5), fill([0, 0, 0], [6, 6, 0], 'Rock', STEEL)]),
    ('The first two levels', ring(0, 0, 6, 6, 1, 3, 'Rock', GLASS) + [clear([3, 0, 1], [3, 0, 2]), fill([0, 0, 4], [6, 6, 4], 'Rock', STEEL)] + ring(0, 0, 6, 6, 5, 7, 'Rock', GLASS) + [fill([0, 0, 8], [6, 6, 8], 'Rock', STEEL)] + [spr([x, 2, 1], 'Planter') for x in (2, 3, 4)] + [spr([x, 2, 5], 'Planter') for x in (2, 3, 4)]),
    ('The upper levels', ring(0, 0, 6, 6, 9, 11, 'Rock', GLASS) + [fill([0, 0, 12], [6, 6, 12], 'Rock', ROOF)] + [spr([x, 4, 9], 'Planter') for x in (2, 3, 4)] + [spr([x, y, 2], 'Window2') for (x, y) in ((1, 0), (5, 0), (0, 3), (6, 3))]),
    ('Lamps, hanging gardens and the sign', [spr([1, 1, 1], 'Lantern'), spr([5, 5, 5], 'Lantern'), spr([1, 1, 9], 'Lantern'), spr([3, 5, 1], 'HangingBasket'), spr([3, -1, 1], 'Sign')]),
]))

# the light fountain: a teal basin ringed with lamps, in the open north of the square
projects.append(('light-fountain', 'The light fountain', 'A basin of light and lamps where neighbours rest after a day of work.', 60, {'plot': 'Plaza', 'nth': 0, 'dx': -6, 'dy': -28}, [4, 4], [
    ('Laying the basin', [clear([0, 0, 1], [8, 8, 6]), found([0, 0], [8, 8], 'Rock', PALE, 3), fill([0, 0, 0], [8, 8, 0], 'Rock', PALE)] + ring(0, 0, 8, 8, 1, 1, 'Rock', TEAL)),
    ('The inner ring and the pillar', ring(2, 2, 6, 6, 1, 2, 'Rock', STONE) + [fill([4, 4, 1], [4, 4, 5], 'Rock', STONE)]),
    ('The crown and the lamps', [fill([4, 4, 6], [4, 4, 6], 'Rock', TEAL), spr([4, 4, 7], 'Lantern')] + [spr([x, y, 2], 'Lantern') for (x, y) in ((0, 0), (8, 0), (0, 8), (8, 8))] + [spr([x, 9, 1], 'BenchWoodWoodland') for x in (2, 6)]),
]))

# the sky transit hub: a quiet landing platform where the wider world will one day arrive
projects.append(('transit-hub', 'The sky transit hub', 'A pale platform with a canopy and lamps, ready for the quiet light-rail and landing pads of the future.', 105, {'plot': 'Workshop', 'nth': 0, 'dx': -34, 'dy': -10}, [7, 4], [
    ('Levelling the platform', [clear([0, 0, 1], [14, 8, 6]), found([0, 0], [14, 8], 'Rock', PALE, 4), fill([0, 0, 0], [14, 8, 0], 'Rock', PALE)]),
    ('Pillars and the canopy', [fill([c[0], c[1], 1], [c[0], c[1], 4], 'Rock', STEEL) for c in ([1, 1], [13, 1], [1, 7], [13, 7], [7, 1], [7, 7])] + [fill([0, 0, 5], [14, 8, 5], 'Rock', ROOF)]),
    ('Benches, lamps and the landing ring', [spr([x, 4, 1], 'BenchWoodWoodland') for x in (3, 4, 10, 11)] + [spr([x, y, 4], 'Lantern') for (x, y) in ((1, 1), (13, 1), (1, 7), (13, 7))] + ring(5, 2, 9, 6, 1, 1, 'Rock', TEAL) + [spr([7, -1, 1], 'Sign')]),
]))

# the open archive: a long low glass hall where every finding is kept
projects.append(('data-archive', 'The open archive', 'A long glass hall where every finding, plan and story is kept for anyone to read, and for other villages to learn from.', 150, {'plot': 'Workshop', 'nth': 0, 'dx': -8, 'dy': 22}, [6, 3], [
    ('Foundation and floor', [clear([0, 0, 1], [12, 5, 6]), found([0, 0], [12, 5], 'Rock', PALE, 4), fill([0, 0, 0], [12, 5, 0], 'Rock', STEEL)]),
    ('Glass walls and the doors', ring(0, 0, 12, 5, 1, 3, 'Rock', GLASS) + [clear([6, 0, 1], [6, 0, 2])] + [spr([x, 0, 2], 'Window1') for x in (2, 4, 8, 10)] + [spr([x, 5, 2], 'Window1') for x in (2, 4, 8, 10)]),
    ('Roof, shelves and reading lamps', [fill([0, 0, 4], [12, 5, 4], 'Rock', ROOF)] + [spr([x, 4, 1], 'BookshelfMiddle') for x in (1, 2, 3, 4, 8, 9, 10, 11)] + [spr([x, 2, 1], 'TableWoodFancyWoodlandBody') for x in (4, 8)] + [spr([6, 3, 3], 'Lantern'), spr([6, -1, 1], 'Sign')]),
]))

# the sky walk: a raised promenade across the north of the square
projects.append(('sky-walk', 'The sky walk', 'A raised promenade with lamps, so neighbours can cross the square and see the whole village.', 130, {'plot': 'Plaza', 'nth': 0, 'dx': 8, 'dy': 30}, [12, 1], [
    ('The pillars', [fill([x, y, 0], [x, y, 5], 'Rock', STEEL) for x in (0, 8, 16, 24) for y in (0, 2)]),
    ('The deck', [fill([0, 0, 6], [24, 2, 6], 'Rock', PALE)]),
    ('The rails and the lamps', [fill([0, 0, 7], [24, 0, 7], 'Rock', TEAL), fill([0, 2, 7], [24, 2, 7], 'Rock', TEAL)] + [spr([x, 1, 7], 'StreetLamp') for x in (2, 10, 18, 24)]),
]))

# the glass garden: a stepped dome of light over a garden everyone may walk in
projects.append(('glass-garden', 'The glass garden', 'A stepped glass dome over a garden of planters and benches, warm in every season.', 180, {'plot': 'House', 'nth': 0, 'dx': 20, 'dy': -34}, [6, 6], [
    ('Foundation and floor', [clear([0, 0, 1], [12, 12, 9]), found([0, 0], [12, 12], 'Rock', PALE, 4), fill([0, 0, 0], [12, 12, 0], 'Rock', STEEL)]),
    ('The ring wall and the door', ring(0, 0, 12, 12, 1, 3, 'Rock', GLASS) + [clear([6, 0, 1], [6, 0, 2])] + [spr([x, 0, 2], 'Window1') for x in (2, 4, 8, 10)]),
    ('The stepped dome', [fill([1, 1, 4], [11, 11, 4], 'Rock', GLASS), fill([2, 2, 5], [10, 10, 5], 'Rock', GLASS), fill([3, 3, 6], [9, 9, 6], 'Rock', GLASS), fill([4, 4, 7], [8, 8, 7], 'Rock', GLASS), fill([5, 5, 8], [7, 7, 8], 'Rock', ROOF)]),
    ('Planters, benches and lamps', [spr([x, y, 1], 'Planter') for (x, y) in ((3, 3), (9, 3), (3, 9), (9, 9), (6, 6))] + [spr([x, 6, 1], 'BenchWoodWoodland') for x in (2, 10)] + [spr([6, 2, 1], 'Lantern'), spr([6, 10, 1], 'Lantern'), spr([6, -1, 1], 'Sign')]),
]))

manifest = json.loads(mpath.read_text())
manifest['groups'] = [g for g in manifest['groups'] if not g.get('project')]
manifest['area']['radius'] = 100  # the innovation district reaches further than the first hamlet
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
print(len(projects), 'projects,', sum(p['stages'] for p in catalogue), 'stages')
