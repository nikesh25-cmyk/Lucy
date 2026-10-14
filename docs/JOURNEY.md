# The resident journey: crops, crafting and the two build palettes

This is the content reference for what a resident can *do* every day: grow a crop on a patch in its
own garden, craft the harvest into a keepsake, craft a keepsake out of a keepsake, and place the
decorations and blocks the sealed palettes allow. It complements
[the typed content definitions](CONTENT_DEFINITIONS.md) (which kinds exist and how they are sealed),
[CALLINGS.md](CALLINGS.md) (the vocational objectives and receipts) and [QUESTS.md](QUESTS.md) (the
authored chains that credit the same ledger).

Every number below is read from `content/**` at load. Nothing in this document is a second source of
truth: `tests/content.test.js` and `tests/journey-content.test.js` assert the same figures through
the real server paths.

## Crops

| Kind | Growth | Base harvest | Tended at once | A tend inside the first third is | Where it is planted |
| --- | --- | --- | --- | --- | --- |
| `herbs` | 20 min | 2 | 15 min | bountiful until 6m40s | a placed `farm` tile in the resident's own garden |
| `fiber` | 25 min | 2 | 20 min | bountiful until 8m20s | as above |
| `wood` | 30 min | 2 | 25 min | bountiful until 10m | as above |
| `blossom` | 15 min | 3 | 10 min | bountiful until 5m | as above |
| `grain` | 40 min | 4 | 35 min | bountiful until 13m20s | as above |
| `resin` | 50 min | 1 | 45 min | bountiful until 16m40s | as above |

One garden holds **twenty** growing crops, whatever the kinds. A single tend shortens that crop's
growth by up to five minutes, capped by the growth still ahead of it, and *when* the tend arrives
decides how carefully the crop was kept:

- **bountiful** — a tend inside the crop's own first third: the harvest rises by two.
- **careful** — a tend inside the first two thirds: the harvest rises by one.
- **late** — anything later, or a tend on a crop that is already ready: the saving still applies, the
  harvest is the sealed base with no bonus.

Because the bands divide each crop's *own* growth, the same elapsed tend time can be bountiful for
one kind and careful for another, which is the whole reason a resident picks a slow crop or a quick
one rather than a name. A crop that was tended and then gathered leaves that bed sown for one hour of
server time; re-sowing the same kind inside the hour begins already cared for. Nothing dies, rots,
wilts or goes hungry, and there is no seed to buy, hold or trade.

The stage a crop stands in (`sprout`, `leafing`, `ripening`, `ready`), its care, its harvest amount
and its saved seed are all **derived** from the saved planting, the saved tend and the server clock
(`src/journey.js`). No client, model or request can send a timestamp or an amount.

## Crafting

The published recipe list is the sealed recipes first, in their sealed order, then the authored
ladder. Both halves are published in the same shape (`id`, `name`, `ingredients`, `output`), so a
client cannot tell them apart.

Sealed recipes (from `content/cosmetics/craft-*.json`):

| Recipe | Ingredients | Output |
| --- | --- | --- |
| `flower_crown` | 2 herbs + 1 fiber | flower crown |
| `woven_banner` | 3 fiber + 1 wood | woven banner |
| `garden_lantern` | 2 wood + 1 herbs | garden lantern |
| `herbal_wreath` | 3 herbs + 2 fiber | herbal wreath |
| `reed_whistle` | 2 wood + 2 fiber | reed whistle |
| `festival_banner` | 1 woven_banner + 2 herbs + 1 fiber | festival banner |

The authored ladder (`RECIPE_EXTENSIONS` in `src/journey.js`), which adds **depth** rather than a new
price. The third step spends the second, which spends the first:

| Recipe | Ingredients | Output |
| --- | --- | --- |
| `sun_thread` | 2 herbs + 1 fiber | sun thread |
| `field_ribbon` | 1 sun_thread + 1 grain | field ribbon |
| `harvest_garland` | 1 field_ribbon + 3 blossom + 1 resin | harvest garland |

So a resident can go from seed to a keepsake made from a keepsake in three crafts, and the whole
ladder is reachable with five beds: 2 herbs, 2 fiber, 4 grain, 3 blossom and 1 resin — all of them
base yields, no tending required. `tests/journey-content.test.js` proves that end to end: it grows
those five beds through `gardenAction`, harvests them, and crafts the three steps through
`craftItem`, writing nothing to the shelf by hand.

The shape is checked once at load (`recipeDefects`): a recipe that spends an ingredient the world
cannot produce, that repeats a published id, that spends itself, or that adds no second step cannot
ship. Crafting debits the ingredients and writes the output in **one transaction**, so a refused
craft leaves the shelf exactly as it was; a crafted keepsake is a shelf item and an owned keepsake
appearance, never a placed world object.

## The two build palettes

`content/palettes.json` is the one list the server and the renderer both read.

- **garden** (a home world): `cottage`, `tree`, `flowers`, `bench`, `farm`, `pond`, `lamp`, `path`,
  `fountain`, `bookshelf`, `table`, `lantern`, `sculpture`, `trellis`, `cushion`, `well`,
  `birdbath`, `sundial`, `millstone`.
- **house** (inside the personal cottage): `bookshelf`, `table`, `lantern`, `sculpture`, `cushion`,
  `bench`, `flowers`, `birdbath`, `millstone`.
- **frontier** (the finite shared world): `stone`, `wood`, `glass`, `brick`, `sand`, `grass`, `path`,
  `clay`, `slate`.

A garden object stands on its own tile and blocks movement where `src/footprints.js` classifies it as
a mass; a frontier block is a solid full layer except the thin `path`, stacks only on solid ground
within the same operator plot, and shares the per-area capacity and daily action limit with every
other block.

Adding a definition to a palette is enough to make it buildable, grantable and storable: the storage
guard (`src/placement-policy.js`), the saved-type `CHECK` on `frontier_blocks` and the plot-grant
scope test (`src/frontier.js`) all resolve the palette rather than repeating the list.

## What none of this does

No crop, tend, harvest, craft, garden object or block mints a coin, moves money, conveys land or
grants an account role. Grown and crafted items are ordinary records on the resident's own passport;
they can be offered to another resident through
[the resource offers](PEACEFUL_WORLD.md) and they carry no cash value. The only route to a NemoCoin
is still an independent human acceptance of a real scoped contribution ([COINS.md](COINS.md)).

## Where to look in the code

| Concern | File |
| --- | --- |
| Crop lifecycle, care, yield, saved seed, garden summary | `src/journey.js` |
| The authored recipe ladder and its load-time shape check | `src/journey.js` (`RECIPE_EXTENSIONS`, `recipeDefects`) |
| Crafting, the debit and the output write | `src/journey.js` (`craftItem`) |
| Plant/tend/harvest and build palettes | `src/spaces.js` |
| Palette enforcement at storage level | `src/placement-policy.js` |
| Occupancy classes for every scenery type | `src/footprints.js` |
| Block type list, layer limit and grant scope | `src/frontier.js` |
| Pixel-map drawing of each garden object and block | `world.js` |
| Voxel drawing of each object and block | `src/voxel-world.js` |
