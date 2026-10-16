#!/usr/bin/env python3
"""Generates Harr's discovery places and the sites of its public works.

Run from the nemoworld root:  python3 tools/gen-harr-places.py
Writes content/veloren-discoveries.json (the Harr Library's catalogue), content/veloren-landmarks-extra.json
(extra landmarks for the game server), adds the discovery places to content/veloren-landmarks.json (so NemoWorld
accepts events for them) and sends the builders and scholars to the work sites in their daily routines.
"""
import json, pathlib

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

DISCOVERIES = [  # id, name, plot, nth, dx, dy, hint, finding
    ('meadow-flowers', 'The wildflower meadow', 'Plaza', 0, 30, 18, 'east of the plaza, past the lantern path',
     'Seven kinds of flower grow here in bands by soil. The bees visit the yellow band first, in the cool of the morning.'),
    ('boundary-stone', 'The old boundary stone', 'House', 0, -22, -14, 'northwest of the library house',
     'A worn stone, older than the village. Its lichen grows only on the north face, so it also tells you which way you face.'),
    ('hidden-spring', 'The hidden spring', 'FarmField', 1, 14, 12, 'beyond the orchard field',
     'Cold, clear water rises here all year. It fills the well by an underground seam: the well is never really empty.'),
    ('high-view', 'The high view', 'Workshop', 0, 24, -24, 'up the slope north of the workshop',
     'From here the whole valley is a map: fields, the winding road, and where the next cottages could stand.'),
    ('bee-hollow', 'The bee hollow', 'FarmField', 0, -16, 16, 'south of the farm field',
     'A hollow oak hums with a colony. Keepers note they are calm unless smoke is near; the honey feeds the whole village.'),
    ('lichen-wall', 'The lichen wall', 'Workshop', 0, -20, 8, 'west of the workshop',
     'Lichen draws a slow map on the stone. Researchers measure its growth each season; the clean air shows in its colours.'),
    ('birdsong-grove', 'The birdsong grove', 'Plaza', 0, -4, 28, 'south of the plaza',
     'At dawn eleven species sing in turn. Scholars are keeping a score of the chorus, one new voice a week.'),
    ('clay-bank', 'The clay bank', 'FarmField', 1, -18, 4, 'west of the orchard',
     'Fine red clay, good for bricks and pots. Makers dig only what they need and smooth the bank behind them.'),
    ('star-meadow', 'The star meadow', 'House', 0, 8, -26, 'north of the house, away from the lamps',
     'The darkest corner of Harr. On clear nights the observatory scholars chart the sky from here before the platform is done.'),
    ('wind-ridge', 'The wind ridge', 'Workshop', 0, 6, 26, 'a ridge south of the workshop',
     'A steady breeze crosses this ridge. A small mill here could turn grain for the whole village; the plans are in the library.'),
]

RADIUS = 7
extra = []
for id_, label, name, plot, nth, dx, dy, r in SITES:
    extra.append({'id': id_, 'label': label, 'name': name.capitalize(), 'site': 'Harr', 'plot': plot, 'nth': nth, 'dx': dx, 'dy': dy, 'radius': r})
cat = []
for id_, name, plot, nth, dx, dy, hint, finding in DISCOVERIES:
    lid = f'disc-{id_}'
    extra.append({'id': lid, 'label': name, 'name': name, 'site': 'Harr', 'plot': plot, 'nth': nth, 'dx': dx, 'dy': dy, 'radius': RADIUS, 'discovery': True})
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
