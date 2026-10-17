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
    # the innovation district
    ('site-tower', 'Research Tower Site', 'the research tower site', 'Plaza', 0, 37, 21, 10),
    ('site-solar', 'Solar Array Site', 'the solar array site', 'Plaza', 0, 30, -26, 10),
    ('site-vfarm', 'Vertical Farm Site', 'the vertical farm site', 'FarmField', 1, -27, 11, 9),
    ('site-fountain', 'Fountain Site', 'the light fountain site', 'Plaza', 0, -2, -24, 9),
    ('site-transit', 'Transit Hub Site', 'the sky transit hub site', 'Workshop', 0, -27, -6, 11),
    ('site-archive', 'Archive Site', 'the open archive site', 'Workshop', 0, -2, 25, 10),
    ('site-skywalk', 'Sky Walk Site', 'the sky walk site', 'Plaza', 0, 20, 31, 13),
    ('site-garden', 'Glass Garden Site', 'the glass garden site', 'House', 0, 26, -28, 11),
    # the learning quarter
    ('site-schoolhouse', 'Schoolhouse Site', 'the schoolhouse site', 'Workshop', 0, -20, 18, 9),
    ('site-seminar', 'Seminar Pavilion Site', 'the seminar pavilion site', 'Workshop', 0, -34, 20, 9),
    # the making quarter
    ('site-workshop', 'Workshop Hall Site', 'the makers workshop hall site', 'Workshop', 0, 14, -6, 9),
    ('site-recycling', 'Recycling Garden Site', 'the recycling garden site', 'Workshop', 0, 14, 4, 9),
    # the living quarter
    ('site-cottages-north', 'North Cottage Row', 'the north cottage row', 'Plaza', 0, -38, -16, 12),
    ('site-cottages-east', 'East Cottage Row', 'the east cottage row', 'Plaza', 0, 30, -18, 12),
    ('site-guesthouse', 'Guesthouse Site', 'the travellers guesthouse site', 'House', 0, -10, 14, 9),
    # the gathering quarter
    ('site-amphitheatre', 'Amphitheatre Site', 'the hillside amphitheatre site', 'Plaza', 0, -20, -32, 10),
    ('site-festival-lawn', 'Festival Lawn Site', 'the festival lawn site', 'Plaza', 0, -20, -44, 11),
    # the water and energy quarter
    ('site-water-tower', 'Water Tower Site', 'the water tower site', 'FarmField', 0, -10, 10, 9),
    ('site-solar-2', 'Second Solar Field', 'the southern solar field site', 'Plaza', 0, 22, -42, 10),
    ('site-wind-array', 'Wind Array Site', 'the quiet wind array site', 'Plaza', 0, 4, -44, 10),
    # the transport quarter
    ('site-bridge', 'Canal Bridge Site', 'the canal stone bridge site', 'Plaza', 0, -8, 10, 8),
    ('site-tram-halt', 'Tram Halt Site', 'the valley tram halt site', 'Plaza', 0, -3, -6, 8),
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


DISCOVERY_NOTES = {
    'meadow-flowers': [
        'Soil core sampling reveals high calcium content near the yellow clover zone, explaining why bumblebees cluster there at dawn.',
        'Purple vetch along the western fringe fixes nitrogen, gradually enriching the subsoil for surrounding grasses.',
        'Flowering cycles shift precisely with daytime thermal currents, petals folding forty minutes before evening rainfall.',
        'Seed pods disperse by wind vortexes formed by the ridge contour, scattering seeds thirty metres down-slope.',
    ],
    'boundary-stone': [
        'Petrographic analysis identifies the rock as metamorphic granodiorite, deposited by prehistoric glacial melt.',
        'Deep horizontal chisel grooves show consistent weathering patina, indicating placement at least three centuries ago.',
        'The northern lichen crust consists of Xanthoria parietina, whose growth rate measures roughly two millimetres per season.',
        'Local magnetic deviation near the stone is completely neutral, making it an ideal reference point for triangulation.',
    ],
    'hidden-spring': [
        'Water temperature stays at a uniform seven degrees Celsius year-round, emerging through a pressurized limestone fissure.',
        'Mineral filtration through alluvial gravel layers leaves zero detectable turbidity or iron precipitate.',
        'Subterranean acoustic probes register an underground chamber roughly twelve metres below the outflow pool.',
        'Freshwater amphipods inhabiting the dark spring pool indicate exceptional dissolved oxygen saturation.',
    ],
    'high-view': [
        'Panoramic line-of-sight analysis confirms visual contact with both the eastern pass and the southern forest belt.',
        'Wind speed at the bluff crest averages four metres per second stronger than at the plaza floor.',
        'Thermal up-drafts along the south-facing rock slope provide effortless lift for soaring raptors every afternoon.',
        'Bedrock fractures here show stable joint patterns, capable of bearing foundations for an extended survey outpost.',
    ],
    'bee-hollow': [
        'Internal hive temperature is regulated at thirty-four degrees through cooperative wing-fanning at the hollow entrance.',
        'Pollen samples brought into the colony show foraging trips extending up to two kilometres into the clover fields.',
        'Propolis resin harvested from poplar buds lines the hollow interior, preventing fungal rot in the aged heartwood.',
        'The colony has wintered safely in this hollow for nine recorded seasons without requiring artificial feeding.',
    ],
    'lichen-wall': [
        'Concentric growth rings on the central thallus suggest continuous symbiotic growth spanning over eighty years.',
        'Spectroscopic readings show zero sulphur dioxide discoloration, serving as a reliable living barometer of air purity.',
        'Moisture absorption happens directly through atmospheric condensation without requiring surface runoff.',
        'Microscopic tardigrades inhabit the damp cushion layer, entering cryptobiosis during dry summer weeks.',
    ],
    'birdsong-grove': [
        'Acoustic frequency analysis reveals the chaffinch chorus peaks at four kilohertz, cutting cleanly through rustling leaves.',
        'Deciduous canopy layering provides distinct vertical nesting tiers for seven non-competing songbird species.',
        'Dawn chorus commencement tracks precisely with nautical twilight rather than local sunrise.',
        'Seed-caching behaviour by nuthatches in oak bark fissures directly contributes to natural sapling regeneration.',
    ],
    'clay-bank': [
        'Sedimentary stratification displays alternate layers of fine kaolinite clay and water-sorted quartz sand.',
        'Plasticity testing proves the material can be thrown on a wheel without cracking at twenty percent moisture content.',
        'High iron oxide content imparts a warm terracotta color upon kiln firing at nine hundred degrees.',
        'Erosion along the excavated cut stabilizes naturally within three weeks when stepped at a forty-degree incline.',
    ],
    'star-meadow': [
        'Atmospheric scintillation measurements show minimal thermal turbulence, yielding Bortle class one sky clarity.',
        'Surrounding woodland ridges create a natural light basin, shielding the meadow from peripheral ground reflections.',
        'Nocturnal dew formation peaks before midnight, after which cool mountain breezes keep telescope optics dry.',
        'Ground radiation cools rapidly after sunset due to low soil moisture and porous gravel underlayment.',
    ],
    'wind-ridge': [
        'Anemometer logs show a continuous laminar airflow originating from the valley pressure gradient.',
        'Wind vector consistency exceeds eighty percent from the south-southwest between midday and twilight.',
        'Dwarf juniper shrubs along the crest exhibit flag-form growth, permanently shaped by prevailing air currents.',
        'Aerodynamic pressure differentials across the saddle create an optimal funnel for small wind turbine placement.',
    ],
}

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
    cat.append({'id': id_, 'landmark_id': lid, 'name': name, 'hint': hint, 'finding': finding, 'notes': DISCOVERY_NOTES.get(id_, [])})
(C / 'veloren-landmarks-extra.json').write_text(json.dumps({'format': 'nemo-landmarks-extra-v1', 'landmarks': extra}, indent=2) + '\n')
(C / 'veloren-discoveries.json').write_text(json.dumps({'format': 'nemo-discoveries-v1', 'discoveries': cat}, indent=2) + '\n')

lm = json.loads((C / 'veloren-landmarks.json').read_text())
lm['landmarks'] = [l for l in lm['landmarks'] if not l['id'].startswith('disc-')]  # discoveries are added at load time
(C / 'veloren-landmarks.json').write_text(json.dumps(lm, indent=2) + '\n')

v = json.loads((C / 'veloren-villagers.json').read_text())
# Cooperation: every work site gets a crew of two or more at some hour of the day, so the village really builds
# together, one site at a time. Builders rotate; makers lend a hand at the pavilion; scholars chart the sky at dusk.
site_names = [s[1] for s in SITES]
dawn_sites = site_names[0:10]
day_sites = site_names[10:20]
dusk_sites = site_names[20:29]

night_places = ['Meeting Hall', 'Cottage Row', 'Library', 'Guesthouse Site']
for i, r in enumerate(v['residents']):
    d = r['destinations']
    d['dawn']['label'] = dawn_sites[i // 2] if i < 20 else dawn_sites[(i - 20) % len(dawn_sites)]
    d['day']['label'] = day_sites[i // 2] if i < 20 else day_sites[(i - 20) % len(day_sites)]
    d['dusk']['label'] = dusk_sites[i // 2] if i < 18 else dusk_sites[(i - 18) % len(dusk_sites)]
    d['night']['label'] = night_places[i % len(night_places)]
(C / 'veloren-villagers.json').write_text(json.dumps(v, indent=2) + '\n')
print(len(SITES), 'sites,', len(cat), 'discoveries')
