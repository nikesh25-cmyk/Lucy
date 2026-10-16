#!/usr/bin/env python3
"""Generates Harr's discovery places and the sites of its public works.

Run from the nemoworld root:  python3 tools/gen-harr-places.py
Writes content/veloren-discoveries.json (the Harr Library's catalogue), content/veloren-landmarks-extra.json
(extra landmarks for the game server), adds the discovery places to content/veloren-landmarks.json (so NemoWorld
accepts events for them) and sends the builders and scholars to the work sites in their daily routines.
"""
import json, math, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
C = root / 'content'

SITES = [  # id, label, name, plot, nth, dx, dy, radius
    ('site-well', 'Well Site', 'the well site on the plaza', 'Plaza', 0, -10, -6, 9),
    ('site-market-hall', 'Market Hall Site', 'the market hall site', 'Plaza', 0, 15, -10, 10),
    ('site-cottage-row', 'Cottage Row', 'the cottage row', 'Plaza', 0, -22, 10, 15),
    ('site-observatory', 'Observatory Site', 'the star observatory site', 'Plaza', 0, 0, -14, 9),
    ('site-pavilion', 'Pavilion Site', 'the field pavilion site', 'FarmField', 0, 18, 3, 9),
    ('site-annex', 'Annex Site', 'the library annex site', 'House', 0, 13, 2, 9),
    ('site-orchard-gate', 'Orchard Gate', 'the orchard gate', 'FarmField', 1, 6, -6, 9),
]

# Every place is an offset (east, north) from the plaza's centre; the hint is computed from it, so it is always true.
DISCOVERIES = [  # id, name, dx, dy, finding
    ('meadow-flowers', 'The wildflower meadow', 36, 6,
     'Seven kinds of flower grow here in bands by soil. The bees visit the yellow band first, in the cool of the morning.'),
    ('boundary-stone', 'The old boundary stone', -36, 26,
     'A worn stone, older than the village. Its lichen grows only on the north face, so it also tells you which way you face.'),
    ('hidden-spring', 'The hidden spring', 28, 40,
     'Cold, clear water rises here all year. It feeds the well by an underground seam: the well is never really empty.'),
    ('high-view', 'The high view', 6, 52,
     'From here the whole valley is a map: fields, the winding road, and where the next cottages could stand.'),
    ('bee-hollow', 'The bee hollow', -12, 44,
     'A hollow oak hums with a colony. Keepers note the bees are calm unless smoke is near; the honey feeds the whole village.'),
    ('lichen-wall', 'The lichen wall', -44, 4,
     'Lichen draws a slow map on the stone. Researchers measure its growth each season; the clean air shows in its colours.'),
    ('birdsong-grove', 'The birdsong grove', -30, 52,
     'At dawn eleven species sing in turn. Scholars are keeping a score of the chorus, one new voice a week.'),
    ('clay-bank', 'The clay bank', 14, 26,
     'Fine red clay, good for bricks and pots. Makers dig only what they need and smooth the bank behind them.'),
    ('star-meadow', 'The star meadow', 40, -22,
     'The darkest corner of Harr. On clear nights the observatory scholars chart the sky from here before the platform is done.'),
    ('wind-ridge', 'The wind ridge', -8, -34,
     'A steady breeze crosses this ridge. A small mill here could turn grain for the whole village; the plans are in the library.'),
]


def compass(dx, dy):
    names = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east']
    return names[int(((math.degrees(math.atan2(dy, dx)) + 22.5) % 360) // 45)]


RADIUS = 7
extra = []
for id_, label, name, plot, nth, dx, dy, r in SITES:
    extra.append({'id': id_, 'label': label, 'name': name.capitalize(), 'site': 'Harr', 'plot': plot, 'nth': nth, 'dx': dx, 'dy': dy, 'radius': r})
cat = []
for i, (id_, name, dx, dy, finding) in enumerate(DISCOVERIES):
    lid = f'disc-{id_}'
    for other in DISCOVERIES[:i]:
        assert math.hypot(dx - other[2], dy - other[3]) >= 2 * RADIUS + 2, f'{id_} overlaps {other[0]}'
    hint = f'about {round(math.hypot(dx, dy))} steps {compass(dx, dy)} of the plaza'
    extra.append({'id': lid, 'label': name, 'name': name, 'site': 'Harr', 'plot': 'Plaza', 'nth': 0, 'dx': dx, 'dy': dy, 'radius': RADIUS, 'discovery': True})
    cat.append({'id': id_, 'landmark_id': lid, 'name': name, 'hint': hint, 'finding': finding})
(C / 'veloren-landmarks-extra.json').write_text(json.dumps({'format': 'nemo-landmarks-extra-v1', 'landmarks': extra}, indent=2) + '\n')
(C / 'veloren-discoveries.json').write_text(json.dumps({'format': 'nemo-discoveries-v1', 'discoveries': cat}, indent=2) + '\n')

lm = json.loads((C / 'veloren-landmarks.json').read_text())
lm['landmarks'] = [l for l in lm['landmarks'] if not l['id'].startswith('disc-')]  # discoveries are added at load time
(C / 'veloren-landmarks.json').write_text(json.dumps(lm, indent=2) + '\n')

v = json.loads((C / 'veloren-villagers.json').read_text())
day = {'lw-ignatius': 'Market Hall Site', 'lw-fenwick': 'Cottage Row', 'lw-casimir': 'Market Hall Site', 'lw-hollis': 'Well Site', 'lw-pelham': 'Observatory Site'}
for r in v['residents']:
    if r['id'] in day:
        r['destinations']['day']['label'] = day[r['id']]
    if r['calling'] == 'scholar':
        r['destinations']['dusk']['label'] = 'Observatory Site'
(C / 'veloren-villagers.json').write_text(json.dumps(v, indent=2) + '\n')
print(len(SITES), 'sites,', len(cat), 'discoveries')
