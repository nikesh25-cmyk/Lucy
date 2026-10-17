#!/usr/bin/env python3
"""Generate additive native city data. No existing Harr, registry or live files are edited.
Coordinates use the resolved Harr Plaza, not cached site-origin coordinates. Runtime integration
must allow the bounded 400-block anchor/area envelope; every local operation remains within 48.
Glass and steel are represented with existing blue/grey blocks and actual Window sprites.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STONE = [218, 224, 230]
STEEL = [85, 102, 118]
GLASS = [115, 190, 212]
PAVING = [182, 192, 201]
ROAD = [56, 68, 78]
WOOD = [141, 105, 71]
GREEN = [62, 128, 81]
EARTH = [110, 83, 57]


def fill(a, b, kind='Rock', rgb=STONE):
    return dict(op='fill', **{'from': list(a)}, to=list(b), kind=kind, rgb=rgb)


def clear(a, b):
    return dict(op='clear', **{'from': list(a)}, to=list(b))


def sprite(at, name):
    return dict(op='sprite', at=list(at), sprite=name)


def foundation(w, d):
    # A structural centre beam supports paving without budgeting every decorative edge column.
    if w >= d:
        a, b = [0, d//2], [w, d//2]
    else:
        a, b = [w//2, 0], [w//2, d]
    return dict(op='foundation', **{'from': a}, to=b, kind='Rock', rgb=STEEL, depth=8)


def anchor(x, y):
    return dict(plot='Plaza', nth=0, dx=x, dy=y)


def build():
    groups, projects, landmarks = [], [], []

    def landmark(id, name, x, y, radius=9):
        landmarks.append(dict(id=id, label=name, name=name, site='Harr', plot='Plaza', nth=0,
                              dx=x, dy=y, radius=radius))

    def plain(id, x, y, ops, note):
        groups.append(dict(id=id, anchor=anchor(x, y), ground_at=[0, 0], note=note, ops=ops))

    # A narrow two-column connector joins Harr paving at y51, preserving the lamp at (2,53).
    # The three-block protected approach starts beyond the final y53 props.
    # Segmentation resamples terrain along the route rather than forcing one 160-block slab.
    for i, y in enumerate(range(54, 216, 18)):
        end = min(17, 215-y)
        connector = [clear([0, -2, 1], [0, -1, 4]),
                     fill([0, -2, 0], [0, -1, 0], rgb=PAVING)] if i == 0 else []
        plain(f'city-approach-{i+1}', 0, y, connector + [clear([-1, 0, 1], [1, end, 3]),
              dict(op='foundation', **{'from': [-1, 0]}, to=[1, end], kind='Rock', rgb=PAVING, depth=8),
              fill([-1, 0, 0], [1, end, 0], rgb=PAVING),
              sprite([-2, 3, 1], 'StreetLamp')],
              'Protected walking approach; keep centre x=-1..1 clear. Terrain joins require native survey.')

    # Streets: nonoverlapping segments, connected in a cross. Sidewalk strips remain obstacle free.
    roads = [(-68, 216, 64, 8), (-3, 174, 6, 41), (-3, 225, 6, 41), (0, 216, 68, 8)]
    for i, (x, y, w, d) in enumerate(roads):
        # West ends at x=-4; east starts at 0; a central tile joins the crossing.
        ops = [clear([xx, 0, 1], [xx, d, 3]) for xx in (0, 3, 6)] + [foundation(w, d), fill([0, 0, 0], [w, d, 0], rgb=PAVING)]
        if d == 8:
            ops += [fill([0, 2, 0], [w, 6, 0], rgb=ROAD)]
        else:
            ops += [fill([2, 0, 0], [4, d, 0], rgb=ROAD)]
        # Long avenues split into local ops to preserve the strict ±48 operation envelope.
        if w > 48:
            for k in range(0, w+1, 32):
                ww = min(31, w-k)
                po = [clear([0, yy, 1], [ww, yy, 3]) for yy in (0, 4, 8)] + [foundation(ww, d), fill([0, 0, 0], [ww, d, 0], rgb=PAVING),
                      fill([0, 2, 0], [ww, 6, 0], rgb=ROAD)]
                plain(f'city-avenue-{i}-{k//32}', x+k, y, po, 'Public avenue with two clear sidewalks.')
        else:
            plain(f'city-avenue-{i}', x, y, ops, 'Public avenue with two clear sidewalks.')
    plain('city-crossing', -3, 216, [clear([0, yy, 1], [2, yy, 3]) for yy in (0, 4, 8)] + [foundation(2, 8),
          fill([0, 0, 0], [2, 8, 0], rgb=PAVING)], 'Clear central crossing joining both streets.')

    def building(id, name, x, y, w, d, h, use, first, mezzanine=0):
        door = w//2
        # Entrances face south; the landing and connector are part of the stage-one floor.
        # Both north/south buildings join the east/west street through a straight central aisle.
        if y < 216:
            # Rear door faces the street; retain a south door for arrival and emergency egress.
            door_target_y = y+d+1
        else:
            door_target_y = y-1
        nav = id
        site = f'site-{id}'
        landmark(nav, name, x+door, door_target_y)
        landmark(site, name+' construction', x+door, door_target_y, 12)
        ops0 = [clear([1, 1, 1], [w-1, d-1, 3]), foundation(w, d), fill([0, 0, 0], [w, d, 0], rgb=STONE)]
        if mezzanine:
            ops0 += [clear([1, 1, mezzanine+1], [w-1, d-1, mezzanine+3])]
        # Exterior access walkway, narrow to avoid altering neighbouring parcels.
        if y < 216:
            walk_from, walk_to = d+1, 215-y
        else:
            walk_from, walk_to = 225-y, -1
        if walk_from <= walk_to:
            plain(f'{id}-path', x, y,
                  [clear([door-1, walk_from, 1], [door+1, walk_to, 3]),
                   fill([door-1, walk_from, 0], [door+1, walk_to, 0], rgb=PAVING)],
                  'Public approach before construction; native city surface projection follows checked terrain columns. Building remains flat.')
        walls = []
        for a, b in [([0, 0, 1], [w, 0, h-1]), ([0, d, 1], [w, d, h-1]),
                     ([0, 1, 1], [0, d-1, h-1]), ([w, 1, 1], [w, d-1, h-1])]:
            walls.append(fill(a, b, 'Misc', GLASS))
        for xx in (0, w):
            for yy in (0, d):
                walls.append(fill([xx, yy, 1], [xx, yy, h-1], 'Misc', STEEL))
        for z in range(4, h, 5):
            walls += [fill([0, 0, z], [w, 0, z], rgb=STONE), fill([0, d, z], [w, d, z], rgb=STONE)]
        for xx in range(2, w-1, 4):
            walls += [sprite([xx, 0, 3], 'Window3'), sprite([xx, d, 3], 'Window3')]
        walls += [clear([door-1, 0, 1], [door+1, 0, 4]), clear([door-1, d, 1], [door+1, d, 4]),
                  fill([0, 0, h], [w, d, h], 'Misc', STEEL)]
        interior = [sprite([1, 1, 1], 'Lantern'), sprite([w-1, d-1, 1], 'Lantern'),
                    sprite([door+2, d+1 if y < 216 else -1, 1], 'Sign')]
        if mezzanine:
            z = mezzanine
            walls += [fill([1, 1, z], [w-1, d-1, z], 'Misc', STEEL), clear([2, 3, 1], [3, z+4, z+3])]
            # Stair tread rise is one block. Its final landing opens onto the upper floor at y=z+5.
            for step in range(1, z+1):
                walls.append(fill([2, step+3, 1], [3, step+3, step], rgb=STONE))
            interior += [sprite([6, d-3, z+1], 'BookshelfMiddle'),
                         sprite([w-4, 3, z+1], 'DiningtableWoodWoodlandSquare'),
                         sprite([w-4, 4, z+1], 'ChairWoodWoodland'), sprite([w-2, d-2, z+1], 'Lantern')]
        if use == 'home':
            for xx in (2, w-2):
                interior += [sprite([xx, 2, 1], 'BedWoodWoodlandHead'), sprite([xx, 3, 1], 'BedWoodWoodlandMiddle'),
                             sprite([xx, 4, 1], 'BedWoodWoodlandTail')]
            interior += [sprite([2, d-3, 1], 'DiningtableWoodWoodlandSquare'), sprite([3, d-3, 1], 'ChairWoodWoodland'),
                         sprite([w-2, d-2, 1], 'DrawerWoodWoodlandM1'), sprite([1, d-2, 1], 'CookingPot')]
        elif use in ('office', 'school', 'university'):
            for xx in (5, w-5):
                for yy in (5, 10, d-5):
                    interior += [sprite([xx, yy, 1], 'TableWoodFancyWoodlandCorner'), sprite([xx, yy+1, 1], 'ChairWoodWoodland')]
            interior += [sprite([w-2, 2, 1], 'BookshelfMiddle'), sprite([w-2, 3, 1], 'BookshelfMiddle'),
                         sprite([w-2, 4, 1], 'Shelf')]
        else:
            for xx in (3, 6, w-6, w-3):
                interior += [fill([xx, 3, 1], [xx, d-3, 1], 'Earth', EARTH)]
                for yy in range(3, d-2, 3):
                    interior.append(sprite([xx, yy, 2], 'Planter'))
            interior += [sprite([w-2, 2, 1], 'BarrelWoodWater'), sprite([2, d-2, 1], 'CrateBlock')]
        titles = [('foundation', 'Foundation and access', ops0), ('shell', 'Frame, glazing and roof', walls),
                  ('complete', 'Furniture and opening', interior)]
        for stage, (suffix, title, ops) in enumerate(titles):
            groups.append(dict(id=f'{id}-{suffix}', anchor=anchor(x, y), ground_at=[door, d if y < 216 else 0],
                project=id, title=f'{name}: {title}', site=site, crew=2, release_after_minutes=first+stage*2,
                note='City AI crew only. Door and central walking aisle stay open at every construction stage.', ops=ops))
        projects.append(dict(id=id, name=name, purpose=f'City {use}: furnished native space with street access.',
                             stages=3, first_stage_minutes=first))

    building('city-office', 'Civic work and research office', -62, 177, 16, 18, 19, 'office', 1, 7)
    building('city-school', 'City school', 14, 181, 14, 16, 8, 'school', 1)
    building('city-university', 'City university', 42, 177, 16, 18, 16, 'university', 1, 8)
    for n, x in enumerate((-62, -46, -30, -14), 1):
        building(f'city-home-{n}', f'Family home {n}', x, 240, 10, 12, 6, 'home', 1)
    building('city-farm', 'Urban farm greenhouse', 42, 239, 16, 18, 7, 'farm', 1)

    # A public park with a clear central spine and low planting beds; no obstruction on arrival target.
    plain('city-park-garden', 14, 239, [clear([9, 0, 1], [13, 26, 3]), foundation(22, 26),
          fill([0, 0, 0], [22, 26, 0], 'Grass', GREEN), fill([9, 0, 0], [13, 26, 0], rgb=PAVING),
          fill([9, -14, 0], [13, -1, 0], rgb=PAVING), clear([9, -14, 1], [13, -1, 3]),
          sprite([5, 7, 1], 'BenchWoodWoodland'), sprite([17, 7, 1], 'BenchWoodWoodland'),
          sprite([3, 3, 1], 'Planter'), sprite([19, 3, 1], 'Planter'),
          sprite([3, 23, 1], 'Planter'), sprite([19, 23, 1], 'Planter'),
          sprite([4, 18, 1], 'StreetLamp'), sprite([18, 18, 1], 'StreetLamp')],
          'Public park; clear five-block central promenade connects directly to the avenue.')
    plain('city-build-yard', -30, 205, [clear([8, 0, 1], [12, 10, 3]), foundation(20, 10),
          fill([0, 0, 0], [20, 10, 0], rgb=PAVING), sprite([1, 1, 1], 'CarpenterTable'),
          sprite([2, 1, 1], 'CrateBlock'), sprite([18, 1, 1], 'Sign'), sprite([19, 1, 1], 'Lantern')],
          'Shared construction yard; individual builds use their own site-city-* doorstep crew location.')
    plain('city-arrival-signs', -6, 226, [sprite([0, 0, 1], 'Sign'), sprite([12, 0, 1], 'Sign'),
          sprite([0, 2, 1], 'StreetLamp'), sprite([12, 2, 1], 'StreetLamp')], 'Signs flank the arrival promenade.')
    landmark('city-arrival', 'City arrival crossing', 0, 220)
    landmark('city-homes', 'Family homes promenade', -25, 237)
    landmark('city-build', 'Public construction yard', -20, 212)
    landmark('city-park', 'City park', 25, 240)
    # city-homes is connected by the common front walk, which does not enter private parcels.
    plain('city-home-promenade', -64, 236, [clear([0, 0, 1], [31, 2, 3]), fill([0, 0, 0], [31, 2, 0], rgb=PAVING)], 'West family sidewalk.')
    plain('city-home-promenade-east', -32, 236, [clear([0, 0, 1], [28, 2, 3]), fill([0, 0, 0], [28, 2, 0], rgb=PAVING)], 'East family sidewalk.')
    return (dict(format='veloren-world-v1', site='Harr', area=dict(radius=400), groups=groups),
            dict(format='nemo-works-v1', stage_gap_minutes=2, projects=projects),
            dict(format='nemo-landmarks-extra-v1', landmarks=landmarks))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT/'content')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for suffix, value in zip(('', '-projects', '-landmarks'), build()):
        (args.output_dir/f'veloren-ai-city{suffix}.json').write_text(json.dumps(value, indent=2)+'\n')


if __name__ == '__main__':
    main()
