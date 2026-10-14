#!/usr/bin/env node
/**
 * NemoWorld asset pool fetcher.
 *
 * Downloads a pinned, licence-verified pool of third-party assets from CC0 / OFL / permissive
 * sources, records a SHA-256 for every archive **and every extracted file of interest**, and refuses
 * anything whose terms cannot be named from the artefact itself or from the rights holder's own page.
 * Re-running is idempotent: an archive already on disk is not fetched again, and an extracted tree
 * whose archive hash is unchanged is not unpacked again.
 *
 *   node scripts/fetch-asset-pool.mjs                     # fetch everything within the budget
 *   node scripts/fetch-asset-pool.mjs --only character    # one category (comma separated)
 *   node scripts/fetch-asset-pool.mjs --max-mb 120        # download budget for THIS run
 *   node scripts/fetch-asset-pool.mjs --list              # print the catalogue, fetch nothing
 *   node scripts/fetch-asset-pool.mjs --verify            # re-hash what is on disk, write nothing
 *
 * Output: asset-pool/files/<source>/… (archives, git-ignored)
 *         asset-pool/extracted/<id>/… (unpacked tree, git-ignored)
 *         asset-pool/manifest.json, asset-pool/index.json, asset-pool/NOTICES.md
 *
 * `--max-mb` is the budget for the bytes this run downloads, not the size of the whole pool: the pool
 * is a growing library and a re-run spends nothing, so a per-run budget is what actually bounds the
 * network and the disk. The cap is applied in catalogue order, so a capped run is deterministic and
 * every skip is printed and recorded. A run that skips anything exits non-zero.
 */
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const POOL = join(ROOT, 'asset-pool');
const FILES = join(POOL, 'files');
const EXTRACTED = join(POOL, 'extracted');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || args[i + 1] === undefined || args[i + 1].startsWith('--')) return undefined;
  return args[i + 1];
};
const ONLY = flag('--only') ? String(flag('--only')).split(',').map((s) => s.trim()).filter(Boolean) : null;
const VERIFY = args.includes('--verify');
const LIST = args.includes('--list');
const FETCH_ALL = args.includes('--fetch-all'); // deliberate full re-fetch; ignores the per-run budget
const MAX_MB = Number(flag('--max-mb') ?? 150);
const wanted = (item) => !ONLY || ONLY.includes(item.category);

// Only licences whose terms we can name and which permit redistribution. Anything else is refused.
const LICENSE_ALLOW = ['CC0-1.0', 'OFL-1.1', 'ISC', 'MIT', 'CC-BY-3.0', 'CC-BY-4.0'];
const LICENCE_PATTERNS = {
  'CC0-1.0': [/creative commons zero/i, /\bCC0\b/, /publicdomain\/zero/i],
  'OFL-1.1': [/open font license/i],
  'ISC': [/\bISC\b/, /permission to use, copy, modify, and\/or distribute this software/i],
  'MIT': [/MIT License/i, /permission is hereby granted, free of charge/i],
  'CC-BY-3.0': [/creative commons attribution 3/i, /creative commons[\s-]*3\.0\s*by/i, /licenses\/by\/3\.0/i],
  'CC-BY-4.0': [/creative commons attribution 4/i, /licenses\/by\/4\.0/i],
};
const USEFUL_EXTS = new Set([
  '.png', '.gif', '.jpg', '.jpeg', '.svg', '.webp', '.bmp',
  '.ogg', '.wav', '.mp3', '.flac', '.m4a',
  '.ttf', '.otf', '.woff', '.woff2', '.txt', '.md',
  '.glb', '.gltf', '.obj', '.fbx', '.dae', '.stl', '.mtl', '.blend', '.hdr', '.exr', '.json', '.xml',
]);
// Any file in an archive whose *name* declares it a licence: `License.txt`, `LICENSE`, `OFL.txt`,
// `public-license.txt` (Luis Zuno's Sunny Land notice) or `COPYING`. Nested ones are inspected too, so
// a third-party licence carried inside an otherwise CC0 pack is found rather than passed over.
const LICENCE_FILE = /(^|[-_. ])(licen[cs]e|ofl|copying)([-_. ].*)?(\.(txt|md|html?))?$/i;

// home is the rights holder's own page for the item; url is the pinned artefact.
const KENNEY = (slug, category, url) => ({
  id: `kenney-${slug}`, category, licence: 'CC0-1.0', author: 'Kenney (kenney.nl)', source: 'kenney',
  home: `https://kenney.nl/assets/${slug}`, url, kind: 'zip', slug,
});
const AMBIENTCG = (id) => ({
  id: `ambientcg-${id}`, category: 'texture', licence: 'CC0-1.0', author: 'Lennart Demes / ambientCG', source: 'ambientcg',
  home: `https://ambientcg.com/view?id=${id}`, licenceUrl: 'https://docs.ambientcg.com/license/',
  url: `https://ambientcg.com/get?file=${id}_1K-JPG.zip`, kind: 'zip',
});
const POLYHAVEN = (slug) => ({
  id: `polyhaven-${slug}`, category: 'hdri', licence: 'CC0-1.0', author: 'Poly Haven', source: 'polyhaven',
  home: `https://polyhaven.com/a/${slug}`, licenceUrl: 'https://polyhaven.com/license',
  url: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/${slug}_1k.hdr`, kind: 'file',
});
const OGA = (slug, category, url) => ({
  id: `opengameart-${slug}`, category, licence: 'CC0-1.0', author: null, source: 'opengameart',
  home: `https://opengameart.org/content/${slug}`, licenceUrl: `https://opengameart.org/content/${slug}`, url,
  kind: extname(new URL(url).pathname).toLowerCase() === '.zip' ? 'zip' : 'file',
});
const FONTS_COMMIT = 'e9678a5385322c63730122ba464765baad83cfd8';
const FONT = (family, names) => ({
  id: `googlefont-${family}`, category: 'font', licence: 'OFL-1.1', author: null, source: 'googlefonts',
  home: `https://github.com/google/fonts/tree/${FONTS_COMMIT}/ofl/${family}`, kind: 'files',
  noticeFile: 'OFL.txt', commit: FONTS_COMMIT,
  files: names.map((name) => ({ name, url: `https://raw.githubusercontent.com/google/fonts/${FONTS_COMMIT}/ofl/${family}/${encodeURIComponent(name)}` })),
});

const CATALOGUE = [
  // ---- Kenney (CC0) audio already in the pool ----
  KENNEY('interface-sounds', 'audio', 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip'),
  KENNEY('ui-audio', 'audio', 'https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip'),
  KENNEY('impact-sounds', 'audio', 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip'),
  KENNEY('rpg-audio', 'audio', 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip'),
  KENNEY('digital-audio', 'audio', 'https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip'),
  KENNEY('music-jingles', 'audio', 'https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip'),
  // ---- Kenney (CC0) UI already in the pool ----
  KENNEY('input-prompts', 'ui', 'https://kenney.nl/media/pages/assets/input-prompts/8de120163f-1783763952/kenney_input-prompts_1.5.zip'),
  KENNEY('ui-pack', 'ui', 'https://kenney.nl/media/pages/assets/ui-pack/f651646eab-1718203990/kenney_ui-pack.zip'),
  KENNEY('game-icons', 'ui', 'https://kenney.nl/media/pages/assets/game-icons/1ebf9c14af-1677661579/kenney_game-icons.zip'),
  KENNEY('cursor-pack', 'ui', 'https://kenney.nl/media/pages/assets/cursor-pack/461b29df18-1717599281/kenney_cursor-pack.zip'),
  // A 3D pack is STAGED only: the pinned renderer has no mesh loader, so it must not be wired in.
  KENNEY('nature-kit', 'model-staged', 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip'),
  // ---- ambientCG (CC0) 1K PBR materials already in the pool ----
  AMBIENTCG('Wood096'), AMBIENTCG('Wood066'), AMBIENTCG('Rock030'), AMBIENTCG('Ground037'),
  AMBIENTCG('Grass004'), AMBIENTCG('Fabric085'), AMBIENTCG('Metal032'), AMBIENTCG('Marble016'),
  AMBIENTCG('Concrete034'),
  // ---- Poly Haven (CC0) 1K HDRIs already in the pool ----
  POLYHAVEN('studio_small_03'), POLYHAVEN('kloppenheim_02'), POLYHAVEN('venice_sunset'),
  POLYHAVEN('moonless_golf'), POLYHAVEN('overcast_soil_puresky'), POLYHAVEN('forest_slope'),

  // ================= (a) 2D character art =================
  // Kenney character packs: sprite sheets, walk cycles, avatar parts, faces and 3D character kits.
  KENNEY('roguelike-characters', 'character', 'https://kenney.nl/media/pages/assets/roguelike-characters/53ffff4133-1729196490/kenney_roguelike-characters.zip'),
  KENNEY('roguelike-rpg-pack', 'character', 'https://kenney.nl/media/pages/assets/roguelike-rpg-pack/12c03cd78b-1677697420/kenney_roguelike-rpg-pack.zip'),
  KENNEY('roguelike-indoors', 'character', 'https://kenney.nl/media/pages/assets/roguelike-indoors/4d5b520b03-1702169567/kenney_roguelike-indoors.zip'),
  KENNEY('roguelike-caves-dungeons', 'character', 'https://kenney.nl/media/pages/assets/roguelike-caves-dungeons/5195ceb8ca-1677694831/kenney_roguelike-caves-dungeons.zip'),
  KENNEY('roguelike-modern-city', 'character', 'https://kenney.nl/media/pages/assets/roguelike-modern-city/0ff3dfff2b-1677694743/kenney_roguelike-modern-city.zip'),
  KENNEY('tiny-dungeon', 'character', 'https://kenney.nl/media/pages/assets/tiny-dungeon/f8422efb44-1674742415/kenney_tiny-dungeon.zip'),
  KENNEY('mini-dungeon', 'character', 'https://kenney.nl/media/pages/assets/mini-dungeon/6cd72dc849-1785314274/kenney_mini-dungeon.zip'),
  KENNEY('micro-roguelike', 'character', 'https://kenney.nl/media/pages/assets/micro-roguelike/bbcaf50993-1677578239/kenney_micro-roguelike.zip'),
  KENNEY('1-bit-pack', 'character', 'https://kenney.nl/media/pages/assets/1-bit-pack/aa867a1f37-1677578516/kenney_1-bit-pack.zip'),
  KENNEY('1-bit-platformer-pack', 'character', 'https://kenney.nl/media/pages/assets/1-bit-platformer-pack/7c1e5f05a4-1677693072/kenney_1-bit-platformer-pack.zip'),
  KENNEY('pixel-platformer', 'character', 'https://kenney.nl/media/pages/assets/pixel-platformer/33bb4921eb-1696667883/kenney_pixel-platformer.zip'),
  KENNEY('pixel-platformer-farm-expansion', 'character', 'https://kenney.nl/media/pages/assets/pixel-platformer-farm-expansion/0d64009c0e-1668789813/kenney_pixel-platformer-farm-expansion.zip'),
  KENNEY('pixel-platformer-food-expansion', 'character', 'https://kenney.nl/media/pages/assets/pixel-platformer-food-expansion/76330de2bf-1696596511/kenney_pixel-platformer-food-expansion.zip'),
  KENNEY('pixel-platformer-industrial-expansion', 'character', 'https://kenney.nl/media/pages/assets/pixel-platformer-industrial-expansion/f95a0189cd-1668793443/kenney_pixel-platformer-industrial-expansion.zip'),
  KENNEY('platformer-characters', 'character', 'https://kenney.nl/media/pages/assets/platformer-characters/b85f388c42-1677693768/kenney_platformer-characters.zip'),
  KENNEY('platformer-art-extended-enemies', 'character', 'https://kenney.nl/media/pages/assets/platformer-art-extended-enemies/38f1885b37-1677696504/kenney_platformer-art-extended-enemies.zip'),
  KENNEY('shape-characters', 'character', 'https://kenney.nl/media/pages/assets/shape-characters/c016420b08-1698339465/kenney_shape-characters.zip'),
  KENNEY('emotes-pack', 'character', 'https://kenney.nl/media/pages/assets/emotes-pack/d00a3dcb06-1677578798/kenney_emotes-pack.zip'),
  KENNEY('googly-eyes', 'character', 'https://kenney.nl/media/pages/assets/googly-eyes/b5a22d641d-1709670508/kenney_googly-eyes.zip'),
  KENNEY('background-elements', 'character', 'https://kenney.nl/media/pages/assets/background-elements/b66a1ddec7-1677670395/kenney_background-elements.zip'),
  KENNEY('top-down-shooter', 'character', 'https://kenney.nl/media/pages/assets/top-down-shooter/230204340a-1677694684/kenney_top-down-shooter.zip'),
  KENNEY('rpg-urban-pack', 'character', 'https://kenney.nl/media/pages/assets/rpg-urban-pack/0a097d1dc7-1677578575/kenney_rpg-urban-pack.zip'),
  KENNEY('monochrome-rpg', 'character', 'https://kenney.nl/media/pages/assets/monochrome-rpg/03f49efc13-1674742619/kenney_monochrome-rpg.zip'),
  KENNEY('monochrome-pirates', 'character', 'https://kenney.nl/media/pages/assets/monochrome-pirates/1b6c3591dd-1701252760/kenney_monochrome-pirates.zip'),
  KENNEY('blocky-characters', 'character', 'https://kenney.nl/media/pages/assets/blocky-characters/8369c0cf30-1749547469/kenney_blocky-characters_20.zip'),
  KENNEY('modular-characters', 'character', 'https://kenney.nl/media/pages/assets/modular-characters/d84577feef-1677670340/kenney_modular-characters.zip'),
  KENNEY('toon-characters', 'character', 'https://kenney.nl/media/pages/assets/toon-characters/4e8a6e4e53-1774770819/kenney_toon-characters.zip'),
  KENNEY('mini-characters', 'character', 'https://kenney.nl/media/pages/assets/mini-characters/bfc7e272b4-1774770718/kenney_mini-characters.zip'),
  KENNEY('animated-characters-protagonists', 'character', 'https://kenney.nl/media/pages/assets/animated-characters-protagonists/608191acc4-1774773108/kenney_animated-characters-protagonists.zip'),
  KENNEY('animated-characters-retro', 'character', 'https://kenney.nl/media/pages/assets/animated-characters-retro/93305a3c49-1774772819/kenney_animated-characters-retro.zip'),
  KENNEY('animated-characters-survivors', 'character', 'https://kenney.nl/media/pages/assets/animated-characters-survivors/27b16052a7-1774772958/kenney_animated-characters-survivors.zip'),
  // OpenGameArt CC0 character art: sprite sheets, walk cycles, walk-cycle bases, portraits, faces.
  OGA('dungeon-crawl-32x32-tiles', 'character', 'https://opengameart.org/sites/default/files/Dungeon%20Crawl%20Stone%20Soup%20Full_0.zip'),
  OGA('dungeon-crawl-32x32-tiles-supplemental', 'character', 'https://opengameart.org/sites/default/files/Dungeon%20Crawl%20Stone%20Soup%20Supplemental.zip'),
  OGA('sunny-land-2d-pixel-art-pack', 'character', 'https://opengameart.org/sites/default/files/sunny-land-files.zip'),
  OGA('ninja-adventure-free-sprite', 'character', 'https://opengameart.org/sites/default/files/NinjaAdventure.zip'),
  OGA('hero-spritesheets-ars-notoria', 'character', 'https://opengameart.org/sites/default/files/assets_3.zip'),
  OGA('tiny-characters-set', 'character', 'https://opengameart.org/sites/default/files/32_Characters.zip'),
  OGA('zelda-like-tilesets-and-sprites', 'character', 'https://opengameart.org/sites/default/files/gfx_3.zip'),
  OGA('denzis-public-domain-art', 'character', 'https://opengameart.org/sites/default/files/DENZI_CC0_individual_organized_tiles_sprites.zip'),
  OGA('496-pixel-art-icons-for-medievalfantasy-rpg', 'icons', 'https://opengameart.org/sites/default/files/496_RPG_icons.zip'),

  // ================= (b) audio =================
  KENNEY('sci-fi-sounds', 'audio', 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip'),
  KENNEY('voiceover-pack', 'audio', 'https://kenney.nl/media/pages/assets/voiceover-pack/3f7f168698-1677589897/kenney_voiceover-pack.zip'),
  KENNEY('voiceover-pack-fighter', 'audio', 'https://kenney.nl/media/pages/assets/voiceover-pack-fighter/6ceb77c6f1-1677589837/kenney_voiceover-pack-fighter.zip'),
  KENNEY('casino-audio', 'audio', 'https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip'),
  OGA('4-chiptunes-adventure', 'audio', 'https://opengameart.org/sites/default/files/Juhani%20Junkala%20%5BChiptune%20Adventures%5D%20OGG.zip'),
  OGA('512-sound-effects-8-bit-style', 'audio', 'https://opengameart.org/sites/default/files/The%20Essential%20Retro%20Video%20Game%20Sound%20Effects%20Collection%20%5B512%20sounds%5D.zip'),
  OGA('dungeon-ambience', 'audio', 'https://opengameart.org/sites/default/files/dungeon002_0.ogg'),
  OGA('crystal-cave-song18', 'audio', 'https://opengameart.org/sites/default/files/song18_0.mp3'),

  // ================= (c) more materials and HDRIs =================
  AMBIENTCG('Leather037'), AMBIENTCG('GlazedTerracotta001'), AMBIENTCG('RoofingTiles013A'),
  AMBIENTCG('WoodFloor064'), AMBIENTCG('Fabric081C'),
  POLYHAVEN('kloppenheim_06_puresky'), POLYHAVEN('syferfontein_18d_clear_puresky'),
  POLYHAVEN('kloofendal_48d_partly_cloudy_puresky'), POLYHAVEN('aarfontein_pan'),
  POLYHAVEN('sunflowers_puresky'), POLYHAVEN('spruit_sunrise'), POLYHAVEN('ahornsteig'),
  POLYHAVEN('dikhololo_night'),

  // ================= (d) UI kits, icon sets, OFL fonts =================
  KENNEY('fantasy-ui-borders', 'ui', 'https://kenney.nl/media/pages/assets/fantasy-ui-borders/ab29cd0165-1701602367/kenney_fantasy-ui-borders.zip'),
  KENNEY('ui-pack-adventure', 'ui', 'https://kenney.nl/media/pages/assets/ui-pack-adventure/9a877376bc-1723597274/kenney_ui-pack-adventure.zip'),
  KENNEY('ui-pack-sci-fi', 'ui', 'https://kenney.nl/media/pages/assets/ui-pack-sci-fi/b67c2acd31-1724181109/kenney_ui-pack-space-expansion.zip'),
  KENNEY('ui-pack-pixel-adventure', 'ui', 'https://kenney.nl/media/pages/assets/ui-pack-pixel-adventure/405ba5278a-1729196257/kenney_ui-pack-pixel-adventure.zip'),
  KENNEY('ui-pack-rpg-expansion', 'ui', 'https://kenney.nl/media/pages/assets/ui-pack-rpg-expansion/7ec4a46657-1677661824/kenney_ui-pack-rpg-expansion.zip'),
  KENNEY('input-prompts-pixel', 'ui', 'https://kenney.nl/media/pages/assets/input-prompts-pixel/84a40a31f6-1774771309/kenney_input-prompts-pixel.zip'),
  KENNEY('cursor-pixel-pack', 'ui', 'https://kenney.nl/media/pages/assets/cursor-pixel-pack/092f2b012b-1720601332/kenney_cursor-pixel-pack.zip'),
  KENNEY('crosshair-pack', 'ui', 'https://kenney.nl/media/pages/assets/crosshair-pack/5ef74bd405-1785950072/kenney_crosshair-pack.zip'),
  KENNEY('minimap-pack', 'ui', 'https://kenney.nl/media/pages/assets/minimap-pack/37d4e34596-1730884114/kenney_minimap-pack.zip'),
  KENNEY('game-icons-expansion', 'ui', 'https://kenney.nl/media/pages/assets/game-icons-expansion/afac4593af-1677661643/kenney_game-icons-expansion.zip'),
  KENNEY('ranks-pack', 'icons', 'https://kenney.nl/media/pages/assets/ranks-pack/6f46ba5840-1677578852/kenney_ranks-pack.zip'),
  KENNEY('medals', 'icons', 'https://kenney.nl/media/pages/assets/medals/4ed820ff57-1677699973/kenney_medals.zip'),
  KENNEY('kenney-fonts', 'font', 'https://kenney.nl/media/pages/assets/kenney-fonts/8d5435c213-1677661710/kenney_kenney-fonts.zip'),
  // game-icons.net: SVG set under CC BY 3.0, one directory per contributor (the notice names each).
  {
    id: 'game-icons-icons', category: 'icons', licence: 'CC-BY-3.0', source: 'gameicons',
    author: 'game-icons.net contributors (one directory per author)', commit: '82d948812bfe3f269ef8f731dcdb07b08160edc4',
    home: 'https://game-icons.net/', url: 'https://codeload.github.com/game-icons/icons/zip/82d948812bfe3f269ef8f731dcdb07b08160edc4', kind: 'zip',
  },
  // Heroicons: MIT SVG set, tagged and pinned.
  {
    id: 'heroicons', category: 'icons', licence: 'MIT', source: 'github', author: 'Tailwind Labs',
    commit: 'ca7b62ead85d617ef4deacc56a82a5f3482184ef', kind: 'zip',
    home: 'https://github.com/tailwindlabs/heroicons/tree/v2.2.0',
    url: 'https://codeload.github.com/tailwindlabs/heroicons/zip/ca7b62ead85d617ef4deacc56a82a5f3482184ef',
  },
  FONT('cinzel', ['Cinzel[wght].ttf', 'OFL.txt', 'METADATA.pb']),
  FONT('ebgaramond', ['EBGaramond[wght].ttf', 'EBGaramond-Italic[wght].ttf', 'OFL.txt', 'METADATA.pb']),
  FONT('inter', ['Inter[opsz,wght].ttf', 'Inter-Italic[opsz,wght].ttf', 'OFL.txt', 'METADATA.pb']),
  FONT('ibmplexsans', ['IBMPlexSans[wdth,wght].ttf', 'IBMPlexSans-Italic[wdth,wght].ttf', 'OFL.txt', 'METADATA.pb']),
  FONT('jetbrainsmono', ['JetBrainsMono[wght].ttf', 'JetBrainsMono-Italic[wght].ttf', 'OFL.txt', 'METADATA.pb']),
  FONT('lora', ['Lora[wght].ttf', 'Lora-Italic[wght].ttf', 'OFL.txt', 'METADATA.pb']),
];

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const mb = (n) => (n / 1048576).toFixed(2);
const norm = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
const matchesLicence = (text, licence) => (LICENCE_PATTERNS[licence] || []).some((re) => re.test(text));
/** A bounded excerpt that shows the licence: the head of the file when the licence is named there,
 *  otherwise the lines around the first mention. */
const snippet = (text, licence, budget = 400) => {
  const flat = norm(text).replace(/\n{2,}/g, '\n').replace(/\uFFFD/g, '');
  for (const re of LICENCE_PATTERNS[licence] || []) {
    const m = flat.match(re);
    if (!m) continue;
    if (m.index < budget) return flat.slice(0, budget).trim();
    const start = Math.max(0, m.index - 140);
    const head = start === 0 ? 0 : flat.indexOf('\n', start) + 1;
    return flat.slice(head || start, (head || start) + budget).trim();
  }
  return flat.slice(0, budget);
};
/** The same, for a web page: one line, because a page's stripped text is full of markup whitespace. */
const pageSnippet = (text, licence, budget = 400) => snippet(text.replace(/\s+/g, ' ').trim(), licence, budget);
const unique = (list) => [...new Set(list)];

async function get(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'NemoWorld-asset-pool/1.0 (+local licence research)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

const pageCache = new Map();
/** Read the rights holder's own page and confirm it names the declared licence. */
async function pageStatement(url, licence, author) {
  if (pageCache.has(url)) return pageCache.get(url);
  let result;
  try {
    const html = (await get(url)).toString('utf8');
    const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const named = matchesLicence(text, licence);
    const found = html.match(/Author:&nbsp;<\/div>[\s\S]{0,200}?<a [^>]*>([^<]+)<\/a>/);
    result = {
      url, ok: named, author: author || (found && found[1]) || null,
      statement: named ? pageSnippet(text, licence) : `no ${licence} statement found on this page`,
    };
  } catch (error) {
    result = { url, ok: false, author: author || null, statement: `page unavailable: ${error.message}` };
  }
  pageCache.set(url, result);
  return result;
}

const zipList = (zipPath) => {
  const out = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`cannot list ${basename(zipPath)}: ${(out.stderr || '').toString().slice(0, 160)}`);
  return out.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
};
const licenceFilesIn = (zipPath) => unique(zipList(zipPath)
  .filter((name) => !name.startsWith('__MACOSX/') && LICENCE_FILE.test(basename(name))))
  .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

const readZipEntry = (zipPath, name) => {
  const out = spawnSync('unzip', ['-p', zipPath, name], { maxBuffer: 32 * 1024 * 1024 });
  return out.status === 0 ? out.stdout.toString('utf8') : null;
};

/** Extract an archive once per archive hash, refusing an entry that would escape the target. */
async function extractZip(zipPath, dir, archiveHash) {
  const marker = join(dir, '.extracted.json');
  let cached = null;
  if (existsSync(marker)) {
    try {
      const recorded = JSON.parse(await readFile(marker, 'utf8'));
      if (recorded.archive_sha256 === archiveHash) cached = recorded;
    } catch { /* fall through to a fresh extract */ }
  }
  if (cached) return { extracted: false, cache: cached };
  const entries = zipList(zipPath);
  const unsafe = entries.find((name) => name.startsWith('/') || name.split('/').includes('..'));
  if (unsafe) throw new Error(`refusing archive with an escaping entry: ${unsafe}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // Info-ZIP refuses to create any name that is not valid UTF-8, which some packs use for a "×" in a
  // folder name. bsdtar reads the same archive with the legacy encoding converted, so it is the
  // fallback rather than a reason to refuse an otherwise CC0 pack.
  const out = spawnSync('unzip', ['-qq', '-o', zipPath, '-d', dir, '-x', '__MACOSX/*'], { maxBuffer: 16 * 1024 * 1024 });
  if (out.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const fallback = spawnSync('tar', ['-xf', zipPath, '-C', dir, '--exclude', '__MACOSX/*'], { maxBuffer: 16 * 1024 * 1024 });
    if (fallback.status !== 0) {
      throw new Error(`extraction failed with unzip (${(out.stderr || '').toString().trim().slice(0, 120)}) and with bsdtar (${(fallback.stderr || '').toString().trim().slice(0, 120)})`);
    }
  }
  const record = { archive_sha256: archiveHash, entries: entries.length, files: [] };
  await writeFile(marker, JSON.stringify(record) + '\n');
  return { extracted: true, cache: record };
}

const isResourceFork = (name) => name.startsWith('._') || name === '.DS_Store';

async function walk(dir) {
  const found = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '__MACOSX' || isResourceFork(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.isFile() && entry.name !== '.extracted.json') found.push(path);
  }
  return found;
}

/** Where an item's own files live: a single artefact, or a directory for a multi-file item. */
const itemDest = (item) => item.kind === 'files'
  ? join(FILES, item.source, item.id)
  : item.kind === 'zip'
    ? join(FILES, item.source, `${item.id}.zip`)
    : join(FILES, item.source, `${item.id}${extname(new URL(item.url).pathname) || '.bin'}`);

async function main() {
  if (LIST) {
    for (const item of CATALOGUE) {
      const first = item.kind === 'files' ? item.files[0].url : item.url;
      process.stdout.write(`${item.category}\t${item.id}\t${item.licence}\t${first}\n`);
    }
    process.stdout.write(`\n${CATALOGUE.length} catalogue items\n`);
    return;
  }
  const previous = existsSync(join(POOL, 'manifest.json')) ? JSON.parse(await readFile(join(POOL, 'manifest.json'), 'utf8')) : { items: [] };
  const recordedItems = new Map((previous.items || []).map((entry) => [entry.id, entry]));
  const recordedIndex = existsSync(join(POOL, 'index.json')) ? JSON.parse(await readFile(join(POOL, 'index.json'), 'utf8')) : { items: [] };
  const filesById = new Map((recordedIndex.items || []).map((group) => [group.id, new Map((group.files || []).map((file) => [file.path, file]))]));
  const groupsById = new Map((recordedIndex.items || []).map((group) => [group.id, group]));
  const recordedFile = (itemId, path) => filesById.get(itemId)?.get(path);
  if (!VERIFY) await mkdir(FILES, { recursive: true });

  let spent = 0;
  const items = [];
  const skipped = [];
  const groups = [];
  // A file that reached the disk but cannot be fully accounted for is deleted again, so the pool
  // never holds bytes that the record does not describe.
  const refuse = async (item, dest, downloaded, reason) => {
    if (downloaded) await rm(dest, { recursive: true, force: true }).catch(() => {});
    skipped.push({ id: item.id, reason, url: item.url ?? item.files?.[0]?.url ?? null, licence: item.licence, author: item.author ?? null });
  };

  for (const item of CATALOGUE) {
    if (!wanted(item)) continue;
    if (!LICENSE_ALLOW.includes(item.licence)) {
      await refuse(item, itemDest(item), 0, `licence ${item.licence} is not on the allowlist`);
      continue;
    }
    const dest = itemDest(item);
    let downloaded = 0;
    try {
      // --- obtain the bytes, or check the bytes already there ---
      if (VERIFY && !existsSync(dest)) {
        skipped.push({ id: item.id, reason: 'missing on disk; run the fetcher without --verify' });
        continue;
      }
      if (!VERIFY && !existsSync(dest)) {
        const targets = item.kind === 'files' ? item.files.map((f) => ({ url: f.url, target: join(dest, f.name) })) : [{ url: item.url, target: dest }];
        const missing = [];
        for (const file of targets) {
          if (existsSync(file.target)) continue;
          missing.push({ ...file, buffer: await get(file.url) });
          downloaded += missing[missing.length - 1].buffer.length;
        }
        if (!FETCH_ALL && spent + downloaded > MAX_MB * 1048576) {
          await refuse(item, dest, downloaded, `needs ${mb(downloaded)} MB and only ${mb(MAX_MB * 1048576 - spent)} MB of the ${MAX_MB} MB per-run budget is left`);
          continue;
        }
        for (const file of missing) {
          await mkdir(dirname(file.target), { recursive: true });
          await writeFile(file.target, file.buffer);
        }
        spent += downloaded;
      }

      // --- name the licence, from the artefact first and the rights holder's page second ---
      let notice = null;
      let conflict = null;
      if (item.kind === 'zip') {
        const candidates = licenceFilesIn(dest);
        for (const name of candidates) {
          const text = readZipEntry(dest, name);
          if (text && matchesLicence(text, item.licence)) {
            notice = { source: `archive:${name}`, sha256: sha(Buffer.from(norm(text), 'utf8')), statement: snippet(text, item.licence) };
            break;
          }
        }
        if (!notice && candidates.length) conflict = candidates.join(', ');
      } else if (item.kind === 'files') {
        const path = join(dest, item.noticeFile);
        if (existsSync(path)) {
          const text = await readFile(path, 'utf8');
          if (matchesLicence(text, item.licence)) {
            notice = { source: `archive:${item.noticeFile}`, sha256: sha(Buffer.from(norm(text), 'utf8')), statement: snippet(text, item.licence) };
          } else conflict = item.noticeFile;
        }
      }
      // A font family names its designers in METADATA.pb; that is the author, not the maintainer of
      // the repository that mirrors it.
      let declared = item.author;
      if (item.kind === 'files' && !declared && existsSync(join(dest, 'METADATA.pb'))) {
        const meta = await readFile(join(dest, 'METADATA.pb'), 'utf8');
        declared = (meta.match(/designer:\s*"([^"]+)"/) || [])[1] || null;
      }
      const page = (!notice || !declared) ? await pageStatement(item.licenceUrl || item.home, item.licence, declared) : null;
      if (!notice && !(page && page.ok)) {
        await refuse(item, dest, downloaded, `terms not nameable: ${conflict ? `archive licence file(s) ${conflict} do not name ${item.licence}, and ` : ''}no ${item.licence} statement at ${item.licenceUrl || item.home}`);
        continue;
      }
      const author = declared || (page && page.author);
      if (!author) {
        await refuse(item, dest, downloaded, 'no author could be named');
        continue;
      }

      // --- hash the artefact, extract it, and record every file of interest ---
      const artefacts = item.kind === 'files'
        ? await Promise.all(item.files.map(async (file) => ({ abs: join(dest, file.name), path: join('files', item.source, item.id, file.name) })))
        : [{ abs: dest, path: join('files', item.source, basename(dest)) }];
      for (const artefact of artefacts) {
        if (!existsSync(artefact.abs)) throw new Error(`${artefact.path} is missing after the download`);
        artefact.buffer = await readFile(artefact.abs);
      }
      const primary = artefacts[0];
      const record = {
        id: item.id, category: item.category, licence: item.licence, author,
        home: item.home, url: item.url, kind: item.kind, path: primary.path,
        bytes: primary.buffer.length, sha256: sha(primary.buffer),
        notice: notice ? notice.statement : page.statement,
        notice_source: notice ? notice.source : `page:${page.url}`,
        notice_sha256: notice ? notice.sha256 : sha(Buffer.from(norm(page.statement), 'utf8')),
      };
      if (item.commit) record.commit = item.commit;
      if (item.source === 'kenney') record.pinned_page = `https://kenney.nl/assets/${item.slug}`;
      if (conflict) record.licence_conflict = conflict;

      let files = [];
      if (item.kind === 'zip') {
        const { cache } = await extractZip(dest, join(EXTRACTED, item.id), record.sha256);
        const cached = new Map((cache.files || []).map((file) => [file.path, file]));
        const root = join(EXTRACTED, item.id);
        for (const abs of await walk(root)) {
          if (!USEFUL_EXTS.has(extname(abs).toLowerCase())) continue;
          const info = await stat(abs);
          const path = join('extracted', item.id, abs.slice(root.length + 1));
          const seen = cached.get(path);
          const digest = (!VERIFY && seen && seen.bytes === info.size && seen.mtime === info.mtimeMs) ? seen.sha256 : sha(await readFile(abs));
          files.push({ path, ext: extname(abs).toLowerCase(), bytes: info.size, mtime: info.mtimeMs, sha256: digest });
        }
        if (!VERIFY) await writeFile(join(root, '.extracted.json'), JSON.stringify({ archive_sha256: record.sha256, entries: (cache.entries ?? files.length), files }) + '\n');
      } else {
        for (const artefact of artefacts) {
          const info = await stat(artefact.abs);
          files.push({ path: artefact.path, ext: extname(artefact.abs).toLowerCase(), bytes: info.size, mtime: info.mtimeMs, sha256: sha(artefact.buffer) });
        }
      }
      const extractedBytes = files.reduce((n, file) => n + file.bytes, 0);
      items.push({ ...record, extracted: { files: files.length, bytes: extractedBytes } });
      groups.push({ ...record, extracted_bytes: extractedBytes, files: files.map(({ mtime: _drop, ...rest }) => rest) });
      process.stdout.write(`  ${VERIFY ? 'verify' : 'fetch '} ${item.id.padEnd(46)} ${mb(record.bytes).padStart(7)} MB  ${String(files.length).padStart(6)} files  ${item.licence}\n`);
    } catch (error) {
      await refuse(item, dest, downloaded, error.message);
    }
  }

  // --- the record describes the whole pool, not just this run's slice ---
  // A category-filtered run must not drop every other category from the manifest, and a run that
  // cannot reach an item must not claim it: carry a previous entry forward only while its bytes are
  // still on disk, and keep the catalogue's order.
  if (!VERIFY) {
    const freshItems = new Map(items.map((item) => [item.id, item]));
    const freshGroups = new Map(groups.map((group) => [group.id, group]));
    const skippedIds = new Set(skipped.map((entry) => entry.id));
    items.length = 0;
    groups.length = 0;
    for (const entry of CATALOGUE) {
      if (freshItems.has(entry.id)) { items.push(freshItems.get(entry.id)); groups.push(freshGroups.get(entry.id)); continue; }
      if (skippedIds.has(entry.id) || wanted(entry)) continue;
      const carried = recordedItems.get(entry.id);
      const carriedGroup = groupsById.get(entry.id);
      if (carried && carriedGroup && existsSync(join(POOL, carried.path))) { items.push(carried); groups.push(carriedGroup); }
    }
  }

  // --- verify against the committed record, writing nothing ---
  if (VERIFY) {
    const failures = [];
    for (const item of items) {
      const recorded = recordedItems.get(item.id);
      if (!recorded) { failures.push(`${item.id}: on disk but absent from manifest.json`); continue; }
      if (recorded.sha256 !== item.sha256) failures.push(`${item.id}: archive sha256 ${item.sha256} != recorded ${recorded.sha256}`);
    }
    for (const group of groups) for (const file of group.files) {
      const recorded = recordedFile(group.id, file.path);
      if (!recorded) failures.push(`${file.path}: not recorded in index.json`);
      else if (recorded.sha256 !== file.sha256) failures.push(`${file.path}: sha256 ${file.sha256} != recorded ${recorded.sha256}`);
      else if (recorded.bytes !== file.bytes) failures.push(`${file.path}: ${file.bytes} bytes != recorded ${recorded.bytes}`);
    }
    for (const item of CATALOGUE) {
      if (!wanted(item)) continue;
      if (!items.some((entry) => entry.id === item.id) && !skipped.some((entry) => entry.id === item.id)) {
        failures.push(`${item.id}: neither on disk nor accounted for as skipped`);
      }
    }
    process.stdout.write(`\nverified ${items.length} items, ${mb(items.reduce((n, i) => n + i.bytes, 0))} MB, ${groups.reduce((n, g) => n + g.files.length, 0)} extracted files; ${skipped.length} unavailable, ${failures.length} mismatched\n`);
    for (const entry of skipped) process.stdout.write(`  unavailable ${entry.id}: ${entry.reason}\n`);
    for (const entry of failures) process.stdout.write(`  MISMATCH ${entry}\n`);
    if (failures.length || skipped.length) process.exitCode = 1;
    return;
  }

  // --- the record ---
  const byCategory = {};
  const groupBytes = new Map(groups.map((group) => [group.id, group.extracted_bytes ?? group.files.reduce((n, file) => n + file.bytes, 0)]));
  const groupFiles = new Map(groups.map((group) => [group.id, group.files.length]));
  for (const item of items) {
    const slot = byCategory[item.category] || { items: 0, bytes: 0, extracted_files: 0, extracted_bytes: 0 };
    slot.items += 1; slot.bytes += item.bytes;
    slot.extracted_files += groupFiles.get(item.id) ?? 0;
    slot.extracted_bytes += groupBytes.get(item.id) ?? 0;
    byCategory[item.category] = slot;
  }
  const licences = {};
  for (const item of items) licences[item.licence] = (licences[item.licence] || 0) + 1;
  const extractedFiles = groups.flatMap((group) => group.files);
  const countsByExtension = {};
  for (const file of extractedFiles) countsByExtension[file.ext] = (countsByExtension[file.ext] || 0) + 1;

  await writeFile(join(POOL, 'manifest.json'), JSON.stringify({
    generated_by: 'scripts/fetch-asset-pool.mjs',
    licence_allowlist: LICENSE_ALLOW,
    total_bytes: items.reduce((n, entry) => n + entry.bytes, 0),
    counts_by_category: byCategory,
    counts_by_licence: licences,
    extracted_file_count: extractedFiles.length,
    extracted_bytes: extractedFiles.reduce((n, file) => n + file.bytes, 0),
    items: items.map(({ extracted, ...entry }) => entry),
    skipped,
  }, null, 2) + '\n');
  await writeFile(join(POOL, 'index.json'), JSON.stringify({
    generated_by: 'scripts/fetch-asset-pool.mjs',
    licence_allowlist: LICENSE_ALLOW,
    extracted_file_count: extractedFiles.length,
    useful_files: extractedFiles.length,
    counts_by_extension: countsByExtension,
    items: groups,
  }, null, 2) + '\n');

  const lines = [
    '# Asset pool notices',
    '',
    'Every archive below is recorded with its source URL, home page, author, licence, notice text,',
    'byte size and SHA-256 in `manifest.json`. Every extracted file of interest is recorded with its own',
    'byte size and SHA-256 in `index.json`, inside the rights record of the archive it came from.',
    '',
  ];
  let lastCategory = null;
  for (const item of items) {
    if (item.category !== lastCategory) {
      lines.push(`## ${item.category}`, '', '| id | licence | author | home | notice read from |', '| --- | --- | --- | --- | --- |');
      lastCategory = item.category;
    }
    lines.push(`| ${item.id} | ${item.licence} | ${item.author} | ${item.home} | ${item.notice_source} |`);
  }
  lines.push('', 'Nothing here is legal advice; it records what was verified from the file actually downloaded.', '');
  if (skipped.length) {
    lines.push('## Refused or unavailable', '', '| id | why |', '| --- | --- |');
    for (const entry of skipped) lines.push(`| ${entry.id} | ${entry.reason} |`);
    lines.push('');
  }
  await writeFile(join(POOL, 'NOTICES.md'), lines.join('\n'));

  process.stdout.write(`\ndownloaded ${mb(spent)} MB this run; the pool now holds ${items.length} items and ${mb(items.reduce((n, e) => n + e.bytes, 0))} MB of archives\n`);
  process.stdout.write(`extracted ${extractedFiles.length} files of interest, ${mb(extractedFiles.reduce((n, f) => n + f.bytes, 0))} MB\n`);
  process.stdout.write(`licences: ${Object.entries(licences).map(([name, count]) => `${name}×${count}`).join(', ')}\n`);
  for (const [category, slot] of Object.entries(byCategory).sort()) {
    process.stdout.write(`  ${category.padEnd(13)} ${String(slot.items).padStart(3)} items  ${String(slot.extracted_files).padStart(6)} files  ${mb(slot.bytes).padStart(8)} MB\n`);
  }
  if (skipped.length) {
    process.stdout.write(`${skipped.length} skipped\n`);
    for (const entry of skipped) process.stdout.write(`  skip ${entry.id}: ${entry.reason}\n`);
    process.exitCode = 1;
  }
}

await main();
