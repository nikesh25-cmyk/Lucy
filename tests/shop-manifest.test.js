// The delivery allow-list is the seam between the two repositories: NemoWorld says which GOOD was
// bought, the Veloren server decides which ITEM that is. The only thing that keeps the two copies
// honest is that both hard-code the same fingerprint (`server/src/nemo/shop/logic.rs` pins the same
// string in `manifest_fingerprint_is_pinned_with_nemoworld`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SHOP_CATALOGUE } from '../src/shop.js';
import { SHOP_MANIFEST, MANIFEST_PATH, loadManifest, manifestFingerprint, sellableGoods } from '../src/veloren-ext/shop.js';

const here = fileURLToPath(new URL('..', import.meta.url));

/** The Veloren worktree that sits beside this one (`wt/veloren-<id>`), if this suite is run there. */
function velorenManifestPath() {
  try {
    for (const name of readdirSync(join(here, '..'))) {
      if (!name.startsWith('veloren-')) continue;
      const path = join(here, '..', name, 'server', 'src', 'nemo', 'shop', 'manifest.json');
      if (existsSync(path)) return path;
    }
  } catch { /* no sibling worktree: the fingerprint below is still pinned on both sides */ }
  return null;
}

test('the manifest is exactly the one the Veloren server allows, fingerprint and all', () => {
  assert.equal(
    manifestFingerprint(SHOP_MANIFEST),
    'festival_banner=common.items.crafting_ing.cloth.linen_red*1;' +
      'fiber=common.items.flowers.plant_fiber*2;' +
      'flower_crown=common.items.armor.misc.head.headband*1;' +
      'herb_crate=common.items.food.sage*5;' +
      'herbal_wreath=common.items.flowers.sunflower*1;' +
      'herbs=common.items.food.sage*2;' +
      'wood=common.items.log.wood*2;' +
      'woven_banner=common.items.crafting_ing.cloth.linen*1',
    'server/src/nemo/shop/logic.rs pins this same line; changing one copy without the other must fail',
  );
  const sibling = velorenManifestPath();
  if (sibling) {
    assert.deepEqual(JSON.parse(readFileSync(sibling, 'utf8')), JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), 'the two copies are the same file');
  }
});

test('every deliverable good is a real good of the shop, with the shop\'s own quantity', () => {
  assert.ok(SHOP_MANIFEST.goods.size >= 1);
  for (const entry of SHOP_MANIFEST.goods.values()) {
    const good = SHOP_CATALOGUE.find((item) => item.id === entry.good);
    assert.ok(good, `${entry.good} must be a shop good`);
    const expected = good.category === 'resource' ? good.grant.quantity : 1;
    assert.equal(entry.qty, expected, `${entry.good}: the game must hand over exactly what the shop grants`);
    assert.match(entry.item, /^common\.items(?:\.[a-z0-9_]+)+$/);
  }
  // What a player can ask for is exactly the intersection: a good the shop sells AND that the manifest
  // can deliver. A good with no delivery entry is not sellable in game at all.
  assert.deepEqual(sellableGoods(SHOP_MANIFEST).map((good) => good.id).sort(), [...SHOP_MANIFEST.goods.keys()].sort());
});

test('a broken allow-list is refused at load, never half-loaded', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'shop-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let n = 0;
  const withFile = (body) => {
    const path = join(directory, `manifest-${n += 1}.json`);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    try { return loadManifest(path); } finally { unlinkSync(path); }
  };
  const goods = (list, extra = {}) => ({ format: 'nemo-shop-manifest-v1', max_qty: 10, goods: list, ...extra });
  const ok = { good: 'herbs', item: 'common.items.food.sage', qty: 2 };
  assert.ok(withFile(goods([ok])).goods.has('herbs'));
  // Wrong format, bad cap, no goods.
  assert.throws(() => withFile(goods([ok], { format: 'nemo-shop-manifest-v2' })));
  assert.throws(() => withFile(goods([ok], { max_qty: 0 })));
  assert.throws(() => withFile(goods([ok], { max_qty: 11 })));
  assert.throws(() => withFile(goods([])));
  // A good id, item path or quantity that does not fit the rules.
  for (const bad of [
    { good: 'Herbs', item: 'common.items.food.sage', qty: 2 },
    { good: 'herbs;drop', item: 'common.items.food.sage', qty: 2 },
    { good: 'herbs', item: 'common/items/food/sage', qty: 2 },
    { good: 'herbs', item: 'common.items.food.sage/../x', qty: 2 },
    { good: 'herbs', item: 'common.items.food.sage', qty: 0 },
    { good: 'herbs', item: 'common.items.food.sage', qty: 3 },
    { good: 'herbs', item: 'common.items.food.sage', qty: 1.5 },
    { good: 'herbs', item: 'common.items.food.sage', qty: 11 },
  ]) {
    assert.throws(() => withFile(goods([bad])));
  }
  // A good the shop does not sell, and one listed twice.
  assert.throws(() => withFile(goods([{ good: 'sword', item: 'common.items.food.sage', qty: 1 }])));
  assert.throws(() => withFile(goods([ok, ok])));
  // What is not a manifest at all.
  for (const bad of ['', 'null', '[]', '{"format":"nemo-shop-manifest-v1"}']) assert.throws(() => withFile(bad));
});
