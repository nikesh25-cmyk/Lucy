// Architecture: houses, civic buildings and pavilions that are not one template.
//
// The sealed `house()` builder in src/voxel-world.js used to draw every cottage identically and every civic
// building identically. This module composes them from a district style (src/scene/districts.js) and the
// tile's own hash, so five cottages in a row differ in wall, roof colour, roof shape, height, chimney,
// door, openings and the small things beside the door, and a Highland house is not a Coastal one.
//
// Everything is `BoxGeometry` instances written here. Occupancy is exactly what it was:
//   - a house is one tile and one mass: its body fills the tile from the ground up and carries the tile's pick;
//   - below the resident's height (1.52 m) nothing reaches more than 0.62 m from the tile centre, which is the
//     0.12 m past the tile edge that stops short of a neighbour's standing column (src/footprints.js);
//   - above 1.52 m anything may overhang — roofs, eaves, awnings, signs, a flag — it is over every head;
//   - smoke is unpicked and entirely above 2 m.
// `tests/render-architecture.test.js` measures all of that over every style and many tiles.
import { hash, shade } from './batch.js';
import { choose, footing } from './districts.js';

/** The farthest any box below head height may reach from its tile centre (the tile edge plus 0.12 m). */
export const LOW_REACH = .62;
/** The height of a resident; a box that starts at or above it is overhead. */
export const HEAD = 1.52;

const plank = (color, f) => shade(color, f);

/** A small drawing helper: boxes placed relative to the tile centre, carrying the tile's pick. */
function painter(batch, x, y, pick) {
  const cx = x + .5, cz = y + .5;
  return (dx, h, dz, w, d, l, color, style, own = pick) => batch.add(cx + dx, h, cz + dz, w, d, l, color, own, style);
}

// ---- roofs ------------------------------------------------------------------------------------------------
// Each draws from `top` (the eave height, always >= 1.6 m so every overhang is overhead) and returns its rise.
// `along`/`across` map a roof's own axes onto the tile: a ridge runs along x or z depending on the tile.
function roofs(add, { top, shape, color, trim, snow, axis, glass, gold }) {
  const A = (a, h, c, la, lc, t, col, st) => axis === 'x' ? add(a, h, c, la, t, lc, col, st) : add(c, h, a, lc, t, la, col, st);
  const tone = (i) => shade(color, i % 2 ? .93 : 1.04);
  if (shape === 'hip') {
    for (let i = 0; i < 4; i++) add(0, top + .11 + i * .2, 0, 1.2 - i * .3, .22, 1.2 - i * .3, tone(i));
    add(0, top + .88, 0, .12, .18, .12, gold, 'glow'); return .95;
  }
  if (shape === 'gable') {
    for (let i = 0; i < 4; i++) { A(0, top + .11 + i * .2, 0, 1.18, 1.22 - i * .3, .22, tone(i)); A(.6, top + .11 + i * .2, 0, .045, 1.22 - i * .3, .22, trim); A(-.6, top + .11 + i * .2, 0, .045, 1.22 - i * .3, .22, trim); }
    A(0, top + .9, 0, 1.24, .13, .12, shade(color, 1.16)); return .95;
  }
  if (shape === 'shed') {
    for (let i = 0; i < 4; i++) A(0, top + .1 + i * .19, -i * .12, 1.16, 1.22 - i * .22, .2, tone(i));
    A(0, top + .35, -.5, 1.16, .08, .6, trim); return .85;
  }
  if (shape === 'flat') {
    add(0, top + .07, 0, 1.12, .14, 1.12, color);
    for (const [dx, dz, w, l] of [[0, .53, 1.12, .07], [0, -.53, 1.12, .07], [.53, 0, .07, 1.0], [-.53, 0, .07, 1.0]]) add(dx, top + .24, dz, w, .22, l, trim);
    add(-.28, top + .3, -.25, .28, .22, .28, shade(color, .9)); return .35;
  }
  if (shape === 'dome') {
    for (let i = 0; i < 5; i++) add(0, top + .08 + i * .15, 0, 1.0 - i * .19, .16, 1.0 - i * .19, i ? shade(color, 1 + i * .02) : trim);
    add(0, top + .82, 0, .08, .16, .08, gold, 'glow'); return .85;
  }
  if (shape === 'aframe') {
    for (let i = 0; i < 6; i++) { A(0, top + .15 + i * .26, 0, 1.12, 1.22 - i * .22, .28, tone(i)); if (snow) A(0, top + .3 + i * .26, 0, 1.12, 1.1 - i * .22, .06, '#f4f8f8'); }
    A(0, top + 1.6, 0, 1.2, .1, .1, shade(color, 1.2)); return 1.6;
  }
  if (shape === 'thatch') {
    for (let i = 0; i < 5; i++) add(0, top + .11 + i * .2, 0, 1.55 - i * .33, .22, 1.55 - i * .33, tone(i));
    for (const dx of [-.62, .62]) add(dx, top + .05, 0, .06, .1, 1.35, shade(color, .82));
    return 1.0;
  }
  if (shape === 'cone') {
    for (let i = 0; i < 6; i++) add(0, top + .11 + i * .2, 0, 1.4 - i * .24, .22, 1.4 - i * .24, tone(i));
    add(0, top + 1.28, 0, .05, .5, .05, shade(color, .7)); add(.07, top + 1.4, 0, .14, .1, .03, gold, 'glow'); return 1.3;
  }
  if (shape === 'sawtooth') {
    for (let t = -1; t <= 1; t++) {
      for (let i = 0; i < 3; i++) A(t * .4, top + .11 + i * .2, -i * .13, .36, 1.12 - i * .28, .22, tone(i + t));
      A(t * .4, top + .34, .36, .34, .04, .5, glass, 'glow');
    }
    return .65;
  }
  // tower: a slender belfry above the eave with an arched, lit lantern and a four-step cap
  add(0, top + .45, 0, .62, .9, .62, shade(color, 1.18)); add(0, top + .88, 0, .78, .1, .78, trim);
  for (const dz of [-.33, .33]) add(0, top + .55, dz, .3, .36, .03, glass, 'glow');
  for (const dx of [-.33, .33]) add(dx, top + .55, 0, .03, .36, .3, glass, 'glow');
  for (let i = 0; i < 4; i++) add(0, top + 1.0 + i * .18, 0, .86 - i * .22, .2, .86 - i * .22, tone(i));
  add(0, top + 1.8, 0, .1, .22, .1, gold, 'glow'); return 1.85;
}

// ---- chimneys and smoke -----------------------------------------------------------------------------------
function chimney(add, { kind, top, rise, stone, smoke, lit, dx, dz }) {
  if (kind === 'none') return;
  const height = top + rise * .75 + .3;
  const stack = (ox, w, color, h = height) => { add(dx + ox, h / 2, dz, w, h, w, color); add(dx + ox, h + .03, dz, w + .06, .07, w + .06, shade(color, .78)); };
  if (kind === 'stone') stack(0, .22, stone);
  else if (kind === 'brick') { stack(0, .24, '#a45a48'); add(dx, height - .2, dz, .27, .05, .27, shade('#a45a48', .8)); }
  else if (kind === 'tall') stack(0, .17, shade(stone, 1.05), height + .45);
  else if (kind === 'twin') { stack(-.12, .15, stone); stack(.12, .15, shade(stone, .92), height - .1); }
  else if (kind === 'stovepipe') { add(dx, (height + .4) / 2, dz, .08, height + .4, .08, '#4a4f52'); add(dx, height + .45, dz, .16, .05, .16, '#363a3d'); }
  if (!lit) return;
  const base = height + (kind === 'tall' ? .65 : kind === 'stovepipe' ? .55 : .2);
  for (const [i, size] of [.16, .22, .28].entries()) add(dx + .04 + i * .06, base + .12 + i * .26, dz + i * .03, size, size, size, smoke, 'cloud', null);
}

// ---- the things beside the door ---------------------------------------------------------------------------
const GLYPHS = {
  fish: (add, sx, sy, sz) => { add(sx, sy, sz, .2, .09, .05, '#5aa0b8'); add(sx + .13, sy, sz, .07, .15, .05, '#5aa0b8'); },
  anchor: (add, sx, sy, sz) => { add(sx, sy, sz, .05, .2, .05, '#2f3e44'); add(sx, sy + .07, sz, .18, .05, .05, '#2f3e44'); add(sx, sy - .1, sz, .2, .05, .05, '#2f3e44'); },
  shop: (add, sx, sy, sz) => { for (const [i, c] of ['#c9674a', '#e7cf83', '#6f9a8a'].entries()) add(sx - .1 + i * .1, sy, sz, .08, .2, .05, c); },
  gear: (add, sx, sy, sz) => { add(sx, sy, sz, .2, .2, .05, '#5d6670'); add(sx, sy, sz + .02, .09, .09, .05, '#e0d6b0'); },
};

function extra(add, kind, o) {
  const { dx0, top, style, door, wood, dark, gold, cream, leaf, n, accent } = o, side = dx0 > 0 ? -1 : 1;
  if (kind === 'barrel') { add(side * .38, .26, .5, .24, .32, .24, wood); for (const h of [.14, .38]) add(side * .38, h, .5, .24, .035, .24, dark); }
  else if (kind === 'crates') { add(side * .36, .26, .5, .24, .24, .24, plank(wood, 1.08)); add(side * .36 + .02, .5, .5, .2, .22, .2, plank(wood, .92)); }
  else if (kind === 'woodpile') for (const [dz, h, c] of [[-.22, .12, .85], [-.07, .12, 1], [.08, .12, .9], [-.15, .27, 1.05], [0, .27, .88]]) add(-.56, h, dz, .12, .12, .12, plank(wood, c));
  else if (kind === 'awning') {
    for (let i = 0; i < 4; i++) add(-.45 + i * .3, 1.62, .66, .3, .06, .32, i % 2 ? cream : accent);
    add(0, 1.56, .8, 1.2, .06, .04, accent);
  } else if (kind === 'lantern') { add(dx0 + side * .27, 1.18, .545, .04, .04, .08, dark); add(dx0 + side * .27, 1.1, .56, .1, .14, .1, gold, 'glow'); }
  else if (kind === 'sign') {
    add(.2, 1.9, .66, .04, .04, .32, dark); add(.2, 1.74, .78, .36, .3, .04, cream);
    (GLYPHS[style.sign || 'shop'] || GLYPHS.shop)(add, .2, 1.74, .81);
  } else if (kind === 'ladder') { for (const dx of [-.09, .09]) add(side * .3 + dx, .48, .56, .04, .96, .04, wood); for (const h of [.2, .45, .7]) add(side * .3, h, .56, .22, .04, .04, wood); }
  else if (kind === 'vines') for (let i = 0; i < 7; i++) { const m = hash(`${n},vine,${i}`); add(-.45 + (m % 9) * .1, .55 + ((m >>> 4) % 6) * .17, .515, .1 + (m % 3) * .04, .12, .035, i % 3 ? leaf : shade(leaf, 1.25)); }
  else if (kind === 'banner') { add(.55, (top + .6) / 2, .5, .04, top + .6, .04, dark); add(.55, top + .4, .62, .04, .2, .3, accent); }
  else if (kind === 'water-tank') add(-.28, top + .5, .25, .3, .26, .3, '#8a9aa4');
}

// ---- the house --------------------------------------------------------------------------------------------
/**
 * A cottage. `colors` are the sealed ones (`wall` is the cottage definition's own tone, which a style with no
 * wall list keeps); the district style chooses the rest from the tile's hash.
 */
export function cottage(batch, { x, y, pick, style, colors }) {
  const add = painter(batch, x, y, pick), n = hash(`${x},${y},home`);
  const wall = style.wall ? choose(style.wall, n) : colors.wall, roof = choose(style.roof, n >>> 3), shape = choose(style.shapes, n >>> 5);
  let top = choose(style.heights, n >>> 7); if (shape === 'tower') top = Math.min(Math.max(top, 2.0), 2.4);
  const axis = (n >>> 9) & 1 ? 'x' : 'z', door = choose(style.door, n >>> 11), trim = style.trim || colors.trim;
  const lift = style.stilts ? .34 : .3, storeys = top >= 2.2 ? 2 : 1, dx0 = [-.24, 0, .24][(n >>> 13) % 3];
  const accent = door, glass = colors.glass;
  // The base: a footing, or a stilted floor whose solid core keeps the whole tile a mass.
  if (style.stilts) {
    add(0, lift / 2, 0, .78, lift, .78, footing(wall)); for (const dx of [-.46, .46]) for (const dz of [-.46, .46]) add(dx, lift / 2, dz, .1, lift, .1, colors.wood);
    add(0, lift, 0, 1.06, .07, 1.06, colors.wood);
  } else add(0, lift / 2, 0, 1.02, lift, 1.02, footing(wall));
  // The body, with its own surface: logs, planks, or plain plaster with a cornice.
  add(0, lift + (top - lift) / 2, 0, .99, top - lift, .99, wall);
  if (style.logs) for (let h = lift + .12; h < top; h += .2) add(0, h, 0, 1.03, .09, 1.03, shade(wall, h % .4 < .2 ? .88 : 1.06));
  else if (style.planks) for (let dx = -.42; dx <= .42; dx += .14) add(dx, lift + (top - lift) / 2, .5, .02, top - lift - .1, .03, shade(wall, .86));
  else add(0, top - .04, 0, 1.06, .09, 1.06, trim);
  if (style.adobe) for (const dx of [-.28, 0, .28]) add(dx, top - .14, .52, .07, .07, .2, '#6f5339');
  if ((n >>> 15) % 3 === 0 && !style.logs) for (const dx of [-.47, .47]) add(dx, lift + (top - lift) / 2, .47, .1, top - lift, .1, shade(wall, 1.1));
  // The front: a door, its lintel and step, and openings that fill the remaining slots of each floor.
  add(dx0, lift + .52, .512, .3, 1.04, .04, door); add(dx0, lift + 1.1, .52, .42, .1, .05, trim); add(dx0 + .09, lift + .5, .54, .04, .04, .04, colors.gold);
  add(dx0, .07, .55, .46, .12, .12, footing(wall));
  const slots = [-.3, .3].filter((dx) => Math.abs(dx - dx0) > .2);
  const rows = storeys === 2 ? [lift + .8, lift + 1.55] : [lift + .75];
  for (const [row, h] of rows.entries()) for (const dx of (row ? [-.28, .28] : slots)) {
    add(dx, h, .515, .3, .42, .04, glass, 'glow'); add(dx, h - .26, .525, .36, .06, .05, trim);
    if (style.shutters || (n >>> 17) % 2 === 0) for (const s of [-1, 1]) add(dx + s * .21, h, .52, .08, .42, .03, accent);
    if (!row && (n >>> 19) % 3 !== 0 && o3(style, 'window-box')) { add(dx, h - .34, .55, .32, .1, .08, colors.wood); for (const [i, c] of style.flowers.entries()) if (i < 3) add(dx - .1 + i * .1, h - .27, .56, .07, .09, .07, c); }
  }
  for (const side of [-1, 1]) for (const h of rows) add(side * .515, h, 0, .04, .42, .3, glass, 'glow');
  if (storeys === 2 && style.parapet) { add(0, lift + 1.2, .56, .98, .05, .12, trim); for (const dx of [-.45, -.15, .15, .45]) add(dx, lift + 1.28, .6, .04, .16, .04, trim); }
  // Roof, chimney, smoke, and two of the district's small extras.
  const rise = roofs(add, { top, shape, color: roof, trim, snow: style.snow, axis, glass, gold: colors.gold });
  const chimneyKind = choose(style.chimney, n >>> 21), dxc = (n >>> 23) & 1 ? .3 : -.3, dzc = shape === 'tower' ? .38 : -.28;
  if (shape !== 'tower' || chimneyKind === 'none') chimney(add, { kind: shape === 'tower' ? 'none' : chimneyKind, top, rise, stone: colors.stone, smoke: '#dde2df', lit: (n >>> 25) % 3 !== 0, dx: dxc, dz: dzc });
  const kinds = style.extras.filter((kind, i, list) => list.indexOf(kind) === i), first = choose(kinds, n >>> 4), second = choose(kinds, (n >>> 4) + 1 + (n >>> 27) % Math.max(1, kinds.length - 1));
  const asked = new Set([first, second].filter((kind) => !(kind === 'water-tank' && shape !== 'flat')));
  for (const kind of asked) extra(add, kind, { dx0, top, style, door, wood: colors.wood, dark: colors.dark, gold: colors.gold, cream: colors.cream, leaf: colors.leaf, n, accent: shade(roof, 1.05) });
  return { top, shape, rise };
}
const o3 = (style, kind) => style.extras.includes(kind);

// ---- the civic building -----------------------------------------------------------------------------------
/** A civic anchor: a clock tower, a columned hall or a market hall, by the tile's hash and the district. */
export function civic(batch, { x, y, pick, style, colors }) {
  const add = painter(batch, x, y, pick), n = hash(`${x},${y},civic`);
  const wall = style.wall ? choose(style.wall, n) : colors.wall, roof = choose(style.roof, n >>> 3), trim = style.trim || colors.trim;
  const kind = style.shapes.includes('tower') ? 'clock' : choose(['hall', 'market', 'clock'], n >>> 5), top = 1.7;
  add(0, .17, 0, 1.04, .34, 1.04, shade(wall, .84)); add(0, (top + .34) / 2, 0, .99, top - .34, .99, wall); add(0, top - .04, 0, 1.06, .1, 1.06, trim);
  // The double door and the window pair every civic building shares.
  add(0, .58, .512, .62, .96, .05, colors.dark); add(0, 1.05, .516, .72, .1, .06, shade(wall, 1.06));
  for (const dx of [-.2, .2]) add(dx, .58, .522, .04, .84, .03, colors.glass, 'glow');
  for (const dx of [-.3, .3]) add(dx, 1.33, .512, .26, .42, .04, colors.glass, 'glow');
  add(0, 1.5, .524, .46, .2, .05, colors.cream);
  if (kind === 'clock') {
    add(0, top + .1, 0, 1.3, .16, 1.3, roof); add(0, top + .26, 0, 1.0, .16, 1.0, shade(roof, .92));
    add(0, top + .95, 0, .58, 1.2, .58, shade(wall, 1.1)); add(0, top + 1.6, 0, .72, .1, .72, trim);
    for (const [dx, dz, w, l] of [[0, .3, .4, .03], [0, -.3, .4, .03], [.3, 0, .03, .4], [-.3, 0, .03, .4]]) { add(dx, top + 1.0, dz, w, .4, l, colors.cream); add(dx * .94, top + 1.0, dz * .94, w ? .03 : .05, .22, l ? .03 : .05, colors.dark); add(dx * .94, top + 1.04, dz * .94, w ? .16 : .03, .03, l ? .16 : .03, colors.dark); }
    for (let i = 0; i < 4; i++) add(0, top + 1.78 + i * .17, 0, .84 - i * .22, .2, .84 - i * .22, i % 2 ? shade(roof, .92) : roof);
    add(0, top + 2.5, 0, .08, .24, .08, colors.gold, 'glow'); return { kind };
  }
  if (kind === 'hall') {
    for (const dx of [-.33, -.11, .11, .33]) add(dx, .8, .56, .08, 1.0, .08, trim);
    add(0, 1.4, .545, .96, .1, .13, trim);
    for (let i = 0; i < 4; i++) { add(0, top + .1 + i * .2, 0, 1.16, .22, 1.22 - i * .3, i % 2 ? shade(roof, .92) : roof); }
    for (let i = 0; i < 3; i++) add(0, top + .1 + i * .2, .62, .96 - i * .3, .22, .08, trim);
    add(0, top + .98, 0, .12, .22, .12, colors.gold, 'glow'); return { kind };
  }
  // market hall: a wide striped eave over the front arcade and a row of bunting
  add(0, top + .1, 0, 1.5, .16, 1.5, roof);
  for (let i = 0; i < 5; i++) add(-.56 + i * .28, top + .26, .62, .28, .14, .5, i % 2 ? colors.cream : roof);
  for (const dx of [-.4, .4]) add(dx, .75, .55, .1, 1.5, .1, trim);
  for (let i = 0; i < 6; i++) add(-.5 + i * .2, 1.68, .74, .1, .14, .03, ['#c9674a', '#e7cf83', '#6f9a8a'][i % 3]);
  add(0, top + .42, 0, .7, .28, .7, shade(roof, .92)); add(0, top + .66, 0, .4, .22, .4, roof); add(0, top + .88, 0, .1, .26, .1, colors.gold, 'glow');
  return { kind };
}

// ---- the pavilion -----------------------------------------------------------------------------------------
/** An open pavilion: corner posts and beams, then a roof above every head. The middle of the tile stays open. */
export function pavilion(batch, { x, y, pick, style, colors }) {
  const add = painter(batch, x, y, pick), n = hash(`${x},${y},shelter`), roof = choose(style.roof, n >>> 3);
  const kind = choose(style.shapes.includes('thatch') || style.shapes.includes('cone') ? ['thatch', 'tent'] : style.shapes.includes('flat') ? ['tent', 'hip'] : ['hip', 'pagoda', 'tent'], n >>> 5);
  for (const dx of [-.5, .5]) for (const dz of [-.5, .5]) { add(dx, .8, dz, .16, 1.6, .16, colors.wood); add(dx, .06, dz, .24, .12, .24, shade(colors.wood, .8)); }
  for (const dz of [-.5, .5]) add(0, 1.6, dz, 1.0, .1, .1, shade(colors.wood, .92));
  for (const dx of [-.5, .5]) add(dx, 1.6, 0, .1, .1, 1.0, shade(colors.wood, .92));
  for (let i = 0; i < 5; i++) add(-.4 + i * .2, 1.56, .56, .06, .16, .03, ['#c9674a', '#e7cf83', '#6f9a8a', '#b2a8cb', '#e1b6a2'][(i + n) % 5]);
  add(0, 1.62, 0, .05, .14, .05, colors.dark); add(0, 1.68, 0, .12, .16, .12, colors.gold, 'glow');
  if (kind === 'thatch') for (let i = 0; i < 4; i++) add(0, 1.82 + i * .2, 0, 1.7 - i * .36, .22, 1.7 - i * .36, shade(roof, i % 2 ? .94 : 1.05));
  else if (kind === 'tent') for (let i = 0; i < 5; i++) for (const [dx, dz] of [[0, 0]]) add(dx, 1.8 + i * .16, dz, 1.5 - i * .3, .17, 1.5 - i * .3, i % 2 ? colors.cream : roof);
  else if (kind === 'pagoda') {
    for (let i = 0; i < 3; i++) add(0, 1.82 + i * .2, 0, 1.4 - i * .35, .22, 1.4 - i * .35, shade(roof, 1 - i * .04));
    for (const dx of [-.74, .74]) for (const dz of [-.74, .74]) add(dx, 1.96, dz, .1, .1, .1, roof);
    add(0, 2.5, 0, 1.0, .18, 1.0, roof); add(0, 2.72, 0, .6, .22, .6, shade(roof, .92));
  } else for (let i = 0; i < 3; i++) add(0, 1.82 + i * .2, 0, 1.5 - i * .35, .2, 1.5 - i * .35, roof);
  return { kind };
}
