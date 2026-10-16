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
STONE = [150, 142, 128]; ROOF = [104, 96, 86]; WOOD = [120, 88, 60]; EARTH = [110, 84, 60]; PALE = [196, 188, 170]


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
projects.append(('observatory', 'The star observatory', 'A raised stone platform where scholars chart the sky and record what they learn.', 50, {'plot': 'Plaza', 'nth': 0, 'dx': 0, 'dy': -26}, [4, 4], [
    ('Raising the platform', [clear([0, 0, 1], [8, 8, 5]), found([0, 0], [8, 8], 'Rock', STONE, 6), fill([0, 0, 0], [8, 8, 1], 'Rock', STONE)]),
    ('Parapet and steps', [fill([0, 0, 2], [8, 0, 2], 'Rock', PALE), fill([0, 8, 2], [8, 8, 2], 'Rock', PALE), fill([0, 0, 2], [0, 8, 2], 'Rock', PALE), fill([8, 0, 2], [8, 8, 2], 'Rock', PALE), clear([4, 0, 2], [4, 0, 2])]),
    ('The star chart table', [spr([4, 4, 2], 'CrystalBall'), spr([3, 4, 2], 'BenchWoodWoodland'), spr([5, 4, 2], 'BenchWoodWoodland'), spr([1, 1, 2], 'Lantern'), spr([7, 7, 2], 'Lantern'), spr([4, -1, 2], 'Sign')]),
]))

# 5. lantern path
projects.append(('lantern-path', 'The lantern path', 'A lit path from the square to the fields so no one walks home in the dark.', 65, {'plot': 'Plaza', 'nth': 0, 'dx': 8, 'dy': -3}, [2, 0], [
    ('Laying the first stretch', [found([0, 0], [14, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (1, 7, 13)]),
    ('Laying the second stretch', [found([15, 0], [29, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (19, 25)]),
    ('Laying the last stretch', [found([30, 0], [44, 1], 'Rock', PALE, 2)] + [spr([x, 2, 1], 'StreetLamp') for x in (31, 37, 43)]),
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

manifest = json.loads(mpath.read_text())
manifest['groups'] = [g for g in manifest['groups'] if not g.get('project')]
catalogue = []
for pid, name, purpose, start, anchor, ground_at, stages in projects:
    catalogue.append({'id': pid, 'name': name, 'purpose': purpose, 'stages': len(stages), 'first_stage_minutes': start})
    for i, (title, ops) in enumerate(stages, 1):
        manifest['groups'].append({
            'id': f'{pid}-{i}', 'anchor': anchor, 'ground_at': ground_at, 'project': pid, 'title': title,
            'release_after_minutes': start + (i - 1) * GAP,
            'note': f'{name}, stage {i} of {len(stages)}: {title}.', 'ops': ops})
mpath.write_text(json.dumps(manifest, indent=2) + '\n')
(root / 'content' / 'veloren-projects.json').write_text(json.dumps({'format': 'nemo-works-v1', 'stage_gap_minutes': GAP, 'projects': catalogue}, indent=2) + '\n')
print(len(projects), 'projects,', sum(p['stages'] for p in catalogue), 'stages')
