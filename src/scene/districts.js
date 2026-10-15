// District style: what makes the twenty districts, the Commons and the other outdoor places look like
// different places instead of one template repeated.
//
// A style is data, never a rule. It chooses walls, roofs, trim, roof shapes, heights, chimneys, signs,
// door-side extras, tree species and the ground decals a district scatters; `src/scene/architecture.js`,
// `src/scene/props.js` and the sealed builders in `src/voxel-world.js` turn that into boxes. Nothing in a
// style reaches occupancy: it cannot add a scenery type, change a class in src/footprints.js, or move a
// pick, and the tests that measure the drawn columns run over every style.
//
// Every district is described by the ISO-free ids the world already publishes (`district:<region>`); a
// world that has no entry (a frontier sector, a country venue, a garden) takes the `commons` mix, so a
// player-built cottage in a garden still gets variety without a style of its own.
import { shade } from './batch.js';

/** Roof shapes the architecture module can draw. */
export const ROOF_SHAPES = Object.freeze(['hip', 'gable', 'shed', 'flat', 'dome', 'aframe', 'thatch', 'sawtooth', 'tower', 'cone']);
/** Chimney kinds, door-side extras and sign kinds the architecture module can draw. */
export const CHIMNEYS = Object.freeze(['stone', 'brick', 'tall', 'stovepipe', 'twin', 'none']);
export const EXTRAS = Object.freeze(['window-box', 'barrel', 'woodpile', 'awning', 'lantern', 'sign', 'crates', 'ladder', 'vines', 'water-tank', 'banner', 'shutters']);
export const SPECIES = Object.freeze(['oak', 'conifer', 'birch', 'willow', 'jungle', 'acacia', 'orchard']);

const flowers = Object.freeze(['#e1b6a2', '#e7cf83', '#b2a8cb', '#d78b86']);

const style = (value) => Object.freeze({ trim: '#f1e9cb', door: ['#324842', '#5a4636', '#3d5875'], flowers, chimney: ['stone'], extras: ['window-box'],
  heights: [1.6, 1.9], storeys: 1, sign: null, snow: false, species: ['oak'], decals: [], ...value });

/**
 * One style per district. `wall`/`roof` are lists the cottage and the building pick from by its own tile,
 * so neighbours differ; every colour is a tone of a colour the family already uses, or a renderer-only tint
 * like the rest of the building palette (none of them is a sealed definition's colour).
 */
export const DISTRICT_STYLES = Object.freeze({
  commons: style({ wall: ['#d5c4a1', '#cfd8c4', '#dcc3b0', '#c6d2dc', '#e0d3a0'], roof: ['#bd7961', '#6f8f94', '#8a6a52', '#a0677a'], shapes: ['gable', 'hip', 'gable', 'shed'],
    heights: [1.6, 1.9, 2.3], chimney: ['stone', 'brick', 'stovepipe'], extras: ['window-box', 'lantern', 'barrel', 'shutters'], species: ['oak', 'birch'],
    decals: [['petal', '#e8c4c4'], ['petal', '#f2ead0'], ['pebble', '#a9a89c']] }),
  highlands: style({ wall: ['#a8a39a', '#9a9a94', '#b3aa98'], roof: ['#5d6670', '#6b6258', '#4f5a62'], trim: '#d9d5c6', shapes: ['aframe', 'gable', 'gable'], heights: [1.8, 2.2],
    chimney: ['tall', 'stone'], extras: ['woodpile', 'lantern', 'shutters'], door: ['#4a3a2e', '#2f3e44'], species: ['conifer'],
    decals: [['pebble', '#8d8f8b'], ['pebble', '#a3a39a'], ['snow', '#e6eeee']] }),
  snowline: style({ wall: ['#e9eeee', '#dfe5e5', '#d9d2c4'], roof: ['#7a4a45', '#4f6068', '#6d5648'], trim: '#ffffff', shapes: ['aframe', 'gable'], heights: [1.8, 2.1], snow: true,
    chimney: ['stone', 'tall'], extras: ['woodpile', 'lantern', 'shutters'], door: ['#7a3d3d', '#2f3e44'], species: ['conifer'],
    decals: [['snow', '#f2f7f7'], ['snow', '#dbe6e8'], ['ice', '#bfdde4']] }),
  foothills: style({ wall: ['#d4c3a2', '#c4b08c', '#bfc9b0'], roof: ['#9a5c44', '#7d6a50', '#86684c'], shapes: ['gable', 'shed', 'gable'], heights: [1.6, 1.9],
    chimney: ['stone', 'brick'], extras: ['woodpile', 'window-box', 'shutters'], species: ['conifer', 'oak'],
    decals: [['wildflower', '#e7cf83'], ['wildflower', '#b2a8cb'], ['pebble', '#a49c8a']] }),
  riverlands: style({ wall: ['#c9ae92', '#d6c5a4', '#b99a84'], roof: ['#a65d4a', '#7d3f3a', '#6b6a5f'], shapes: ['hip', 'gable'], heights: [1.7, 2.1],
    chimney: ['brick', 'stone'], extras: ['crates', 'sign', 'window-box', 'lantern'], sign: 'fish', species: ['willow', 'oak'],
    decals: [['silt', '#a28b69'], ['pebble', '#9ba39a'], ['reed', '#7a9a6b']] }),
  wetlands: style({ wall: ['#9d8a68', '#a79b7d', '#8d8f78'], roof: ['#b9a56a', '#a08e58', '#8a8b5c'], shapes: ['thatch', 'hip'], heights: [1.7, 1.9], stilts: true,
    chimney: ['none', 'stovepipe'], extras: ['ladder', 'lantern', 'crates', 'vines'], door: ['#4a3a2e', '#2f4a44'], species: ['willow'],
    decals: [['puddle', '#7fa3a6'], ['reed', '#6f9068'], ['moss', '#6f8f5b']] }),
  woodlands: style({ wall: ['#8a6a4c', '#7a5c42', '#946f4e'], roof: ['#56724d', '#4a6444', '#6a5a44'], trim: '#e6d2a4', shapes: ['gable', 'aframe', 'gable'], heights: [1.7, 2.0], logs: true,
    chimney: ['stone', 'stovepipe'], extras: ['woodpile', 'lantern', 'window-box'], door: ['#3d2f24', '#2f4a3c'], species: ['conifer', 'oak', 'birch'],
    decals: [['leaf', '#c47a3c'], ['leaf', '#a8642f'], ['twig', '#6f5339']] }),
  rainforest: style({ wall: ['#9a7d58', '#8c9a6a', '#a98f66'], roof: ['#7a9a4c', '#a8a050', '#6c8a46'], trim: '#e8d9a0', shapes: ['thatch', 'cone', 'thatch'], heights: [1.7, 2.0], stilts: true,
    chimney: ['none'], extras: ['vines', 'banner', 'lantern', 'ladder'], door: ['#5a3a2e', '#2f5a44'], flowers: ['#e86a8a', '#f0b84a', '#e8e85a', '#c46ae8'], species: ['jungle'],
    decals: [['fern', '#4f9a5b'], ['fern', '#3f8a52'], ['bloom', '#e86a8a'], ['moss', '#4f8a50']] }),
  grasslands: style({ wall: ['#cdbf98', '#d8cba6', '#c4b489'], roof: ['#b8a064', '#a89258', '#c8a66a'], shapes: ['cone', 'thatch', 'hip'], heights: [1.6, 1.8],
    chimney: ['none', 'stovepipe'], extras: ['banner', 'lantern', 'crates'], door: ['#6a4a36', '#8a5a40'], species: ['oak', 'acacia'],
    decals: [['tuft', '#b8b46a'], ['tuft', '#98a85a'], ['wildflower', '#e8c45a']] }),
  farmlands: style({ wall: ['#c26a52', '#d0a66a', '#b8c0a0'], roof: ['#7a3d36', '#5a5f66', '#8a5a3c'], trim: '#f5eedc', shapes: ['gable', 'gable', 'hip'], heights: [1.9, 2.4],
    chimney: ['brick', 'stone'], extras: ['barrel', 'crates', 'water-tank', 'lantern'], door: ['#5a3a2e', '#324842'], species: ['orchard', 'oak'],
    decals: [['furrow', '#8a6a48'], ['hay', '#d5c16e'], ['tuft', '#a6b05c']] }),
  drylands: style({ wall: ['#d8bc94', '#cba67c', '#e0c9a4'], roof: ['#b9835c', '#a8714c', '#c48f64'], shapes: ['flat', 'flat', 'dome'], heights: [1.6, 1.9], adobe: true,
    chimney: ['stone', 'none'], extras: ['awning', 'water-tank', 'barrel', 'lantern'], door: ['#3d6a78', '#7a4a36'], species: ['acacia'],
    decals: [['ripple', '#c9b07c'], ['pebble', '#b49a74'], ['tuft', '#a89a5a']] }),
  desert: style({ wall: ['#e8d3a6', '#dcc08c', '#efe0bc'], roof: ['#d9c08a', '#c9a874', '#e0cf9c'], shapes: ['flat', 'dome', 'flat'], heights: [1.6, 2.0], adobe: true,
    chimney: ['none'], extras: ['awning', 'water-tank', 'lantern', 'crates'], door: ['#2f6a78', '#8a4a36', '#3d4a7a'], species: ['acacia'],
    decals: [['ripple', '#d4bb86'], ['ripple', '#ba9f6c'], ['pebble', '#a58c64']] }),
  savanna: style({ wall: ['#c9a97a', '#bb9a6c', '#d2b88a'], roof: ['#c8a458', '#b49048', '#d6b66a'], shapes: ['thatch', 'cone', 'thatch'], heights: [1.6, 1.9],
    chimney: ['none'], extras: ['banner', 'woodpile', 'lantern'], door: ['#5a3a2e', '#8a4a36'], species: ['acacia'],
    decals: [['tuft', '#c4b068'], ['tuft', '#a8a050'], ['pebble', '#b49a74']] }),
  coast: style({ wall: ['#f1ece0', '#e9f0ee', '#f5efe6'], roof: ['#3d7a9a', '#c9674a', '#4d8aa8'], trim: '#3d7a9a', shapes: ['flat', 'hip', 'gable'], heights: [1.7, 2.1], parapet: true,
    chimney: ['stone', 'none'], extras: ['shutters', 'window-box', 'awning', 'lantern'], door: ['#3d7a9a', '#c9674a'], species: ['orchard'],
    decals: [['shell', '#f1ead8'], ['shell', '#e8c4b0'], ['sand', '#e0d2a8'], ['twig', '#8a7a62']] }),
  islands: style({ wall: ['#f0b8a0', '#a8d0c4', '#f0d490', '#c0b0e0'], roof: ['#d9c58a', '#b8a060', '#e8d6a0'], trim: '#ffffff', shapes: ['thatch', 'hip', 'cone'], heights: [1.6, 1.9], stilts: true,
    chimney: ['none'], extras: ['vines', 'banner', 'lantern', 'window-box'], door: ['#3d7a9a', '#c9674a', '#2f6a58'], flowers: ['#e86a8a', '#f0b84a', '#7ac4e8'], species: ['orchard'],
    decals: [['shell', '#f6eedc'], ['star', '#e8905a'], ['sand', '#e6d8b0'], ['bloom', '#e86a8a']] }),
  harbor: style({ wall: ['#8a9aa4', '#b5a48a', '#7e8e98'], roof: ['#3f4f60', '#7a3d36', '#566a78'], trim: '#e8dcc0', shapes: ['gable', 'shed', 'gable'], heights: [2.1, 2.5], storeys: 2, planks: true,
    chimney: ['brick', 'stovepipe'], extras: ['crates', 'barrel', 'sign', 'lantern', 'ladder'], sign: 'anchor', door: ['#324842', '#7a3d36'], species: ['willow'],
    decals: [['plank', '#8a6a48'], ['rope', '#c8b48a'], ['pebble', '#8d9690']] }),
  cities: style({ wall: ['#d9d2c4', '#c4ccd4', '#e0c9b0', '#b8c2bc'], roof: ['#5d6670', '#7a5a4c', '#46535c'], trim: '#f3efe2', shapes: ['flat', 'flat', 'tower', 'gable'], heights: [2.3, 2.7, 3.0], storeys: 2, parapet: true,
    chimney: ['brick', 'tall', 'twin'], extras: ['sign', 'awning', 'lantern', 'banner', 'water-tank'], sign: 'shop', door: ['#324842', '#5a4636', '#7a3d3d'], species: ['birch', 'oak'],
    decals: [['paving', '#aeb2a6'], ['paving', '#9ca096'], ['petal', '#f2ead0']] }),
  workshops: style({ wall: ['#b5835f', '#9a6a4c', '#a8a094'], roof: ['#5d4a3c', '#6b6a66', '#7a4a3c'], trim: '#e6d9b0', shapes: ['sawtooth', 'gable', 'shed'], heights: [1.9, 2.2],
    chimney: ['tall', 'stovepipe', 'twin'], extras: ['crates', 'barrel', 'sign', 'woodpile', 'lantern'], sign: 'gear', door: ['#324842', '#5a4636'], species: ['oak'],
    decals: [['ash', '#6a665e'], ['filing', '#8a8a86'], ['pebble', '#9a948a']] }),
  gardens: style({ wall: ['#f1e9e0', '#ece3f0', '#e6f0e4'], roof: ['#a07ab0', '#6f9a8a', '#c98a9a'], trim: '#ffffff', shapes: ['hip', 'gable', 'gable'], heights: [1.6, 1.9], glasshouse: true,
    chimney: ['stone', 'none'], extras: ['window-box', 'vines', 'lantern', 'shutters'], door: ['#6a4a8a', '#3d7a6a', '#c9674a'], flowers: ['#e86a8a', '#f0b84a', '#b88ae8', '#f2ead0'], species: ['orchard', 'birch'],
    decals: [['petal', '#e8a4b8'], ['petal', '#f6ecd0'], ['bloom', '#b88ae8'], ['bloom', '#f0b84a']] }),
  lakes: style({ wall: ['#b8a68a', '#a6b0b4', '#c4b498'], roof: ['#4f6a78', '#6a5a4a', '#5c7a84'], trim: '#e8e0cc', shapes: ['gable', 'hip', 'shed'], heights: [1.7, 2.0], planks: true,
    chimney: ['stone', 'stovepipe'], extras: ['crates', 'ladder', 'lantern', 'woodpile'], door: ['#3d5a78', '#5a4636'], species: ['birch', 'willow', 'conifer'],
    decals: [['pebble', '#98a09a'], ['pebble', '#b4b0a0'], ['reed', '#7a9a6b'], ['silt', '#a89878']] }),
});

/** The district a world definition belongs to: `district:coast` → `coast`; everything else is the Commons mix. */
export function districtKey(definition) {
  const id = String(definition?.id || '');
  const key = id.startsWith('district:') ? id.slice('district:'.length) : id;
  return Object.hasOwn(DISTRICT_STYLES, key) ? key : 'commons';
}

/** The style for a world definition (never undefined, so a caller needs no fallback). */
export const districtStyle = (definition) => DISTRICT_STYLES[districtKey(definition)];

/** The pick a list offers for a tile hash: the same tile always draws the same choice. */
export const choose = (list, n) => list[(n >>> 0) % list.length];

/** A weathered trim tone for a wall: the wall itself, slightly darker, for plinths and quoins. */
export const footing = (wall) => shade(wall, .82);
