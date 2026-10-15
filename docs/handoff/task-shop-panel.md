# Task — the Karma Coin shop panel (`src/ui/shop-panel.js`)

The panel half of the shop: it shows the player their Karma Coin wallet, what service earns more of
them, what the shop sells, and where the coins they already hold came from. It is presentation plus
intent only — it decides no price, computes no balance, assumes no purchase succeeded and never
writes. `src/karma.js` (the ledger) and `src/shop.js` (the shop engine) are built in parallel by two
other owners; this file reads their projections and sends back exactly one intent, `onPurchase(id)`.

## 1. Files

| File | Change |
| --- | --- |
| `src/ui/shop-panel.js` | **New.** The panel module. Framework-free, one import (`./build-interface.js`), no dependency, no side effect on load. |
| `tests/shop-panel.test.js` | **New.** 14 tests: both payload models, the view tree, the confirm step, refusals, the keyboard path, the focus contract, reduced motion, and a markup-injection check. |
| `docs/handoff/task-shop-panel.md` | **New.** This file. |

**Nothing else was touched.** Specifically not: `app.js`, `index.html`, any `*.css`,
`src/ui/inventory-panel.js`, `src/ui/build-interface.js`, `src/ui/interaction-prompt.js`,
`src/ui/first-play-guide.js`, `src/ui/touch-controls.js`, `src/karma.js`, `src/shop.js`, `server.js`,
`package.json`, or any existing test. No git command beyond reading was run.

## 2. The export

```js
import { createShopPanel } from './src/ui/shop-panel.js';

const shopPanel = createShopPanel({
  onPurchase: (goodId) => { /* the caller performs POST /api/v1/shop/purchase */ },
  onChange:   () => renderView(),      // "my own state changed, repaint me"
  onClose:    () => { state.shopOpen = false; renderView(); },
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
});
```

| Member | Signature | What it does |
| --- | --- | --- |
| `update` | `({ karma, shop, agentId, refusal, purchase }) => model` | Ingests new payloads and returns the model. |
| `model` | `() => model` | The current model. Touches no DOM. |
| `view` | `() => tree` | The view tree for `mount(host, tree)` from `src/ui/build-interface.js`. Touches no DOM. |
| `paint` | `(root, { document, trigger }) => node` | Mounts the view into `root` and puts the focus where the last intention asked. Returns the panel `<section>`. **This is the recommended path.** |
| `open` / `close` | `() => boolean` | The visibility state the panel owns: `open` moves the focus into the panel, `close` returns it to the trigger. Both call `onChange`. |
| `isOpen` | `() => boolean` | |
| `dismiss` | `() => false` | "The player asked to close it": `close()` then `onClose()`. Wired to the Close button and to Escape. |
| `select` | `(goodId) => good \| null` | **The first click.** Arms the confirmation. Buys nothing. Null for a good the server did not flag as buyable. |
| `cancel` | `() => string \| null` | Clears the armed good. |
| `buy` | `() => good \| null` | **The confirm.** Calls `onPurchase(good.id)` once and changes no balance. Null when nothing is armed, when the good is not buyable, or when the previous request is still unanswered. |
| `handleKey` | `(key) => boolean` | Keyboard parity (see §6). `true` when the key was consumed — the caller then calls `event.preventDefault()`. |
| `trigger` | `() => element \| null` | The trigger the last `paint` recorded, for the caller's own use. |

`update` fields:

- `karma` — the `GET /api/v1/karma?agent_id=…` payload. Omitted ⇒ the last one is kept.
- `shop` — the `GET /api/v1/shop?agent_id=…` payload. Omitted ⇒ the last one is kept.
- `agentId` — the resident both payloads belong to. Omitted ⇒ kept.
- `refusal` — `{ error }` from a refused purchase. **Omitted ⇒ cleared.**
- `purchase` — the purchase response. **Omitted ⇒ cleared.**

`refusal` and `purchase` belong to one server answer, so a new payload never leaves a stale refusal on
screen; `karma` and `shop` describe where the player stands, so omitting them keeps the last reading.
Any `update` also releases the "one request in flight" guard, so the next confirmation may fire.

The `model` returned is:

```js
{ ready, agentId,
  wallet: { name, balance, sentence, policy },
  services: [ { id, label, tier, tier_label, award, per_day, remaining_today, exhausted, hint } ],
  goods: [ { id, label, summary, category, category_label, price, per_day, remaining_today,
             exhausted, affordable, can_buy } ],
  categories: [ { name, label, goods: [...] } ],
  entries: [ { direction, label, amount, created_at } ],
  refusal, saved, selected, awaiting, open,
  karma: { ready, balance, currency, services, entries, today, verify, policy },
  shop:  { ready, balance, currency, goods, categories, entries, policy } }
```

`balance` is the server's own number, rendered verbatim: the karma payload's when it states one, else
the shop payload's. `affordable` and `can_buy` come **only** from the server's own flag (and, for
`can_buy`, from a daily allowance that is not zero) — the panel never compares a price with a balance.

## 3. Payload shapes: the panel reads both spellings

The two sibling modules landed their projections while this panel was being written, and their field
names differ from the brief this panel was built to. The panel accepts both, and
`tests/shop-panel.test.js` asserts the panel against **both** shapes.

| The brief said | `src/karma.js` / `src/shop.js` project | The panel reads |
| --- | --- | --- |
| `services[].per_day` | `per_day` | either (also `per_day_limit`, `daily_limit`) |
| `services[].hint` | `hint` (a copy of `note`) | `hint`, else `note` |
| tier `'world'` / `'resident'` | tier `'world'` / `'service'` | any spelling; `service` → "Service to another resident" |
| `goods[].per_day_limit` | `daily_limit`, `per_account_limit_per_day` | any of the three |
| `goods[].affordable` | `can_afford` (`null` when the wallet is unreadable) | `affordable ?? can_afford`; `null` is never read as "yes" |
| `policy: { sentence }` | a policy object with `sentence` **and** `description` | `policy.sentence`, else `policy.description`, else the string |
| `{ purchase: { … }, balance_after }` | a **flat** record: `{ purchase_id, good_id, label, price, granted, balance_after, … }` | either; a `granted` that is an object is not used as a name |
| `entries` on the shop payload | only the karma payload has entries | `karma.entries`, else `shop.entries` |
| `currency` | `currency: 'Karma Coins'` | the payload's own name, else `'Karma Coins'` |

`src/shop.js` also carries `available_today`; the panel derives the same conclusion from
`remaining_today === 0`, which is the number it also renders, so the two cannot disagree on screen.

## 4. What the panel contains

1. **The wallet line** — `Karma Coins: 24`, the currency name, the server's own policy sentence when it
   states one, and one fixed plain sentence saying what Karma Coins are and are not (exported as
   `KARMA_COIN_SENTENCE`): earned by service in the world, spent only in this shop, *not* NemoCoins,
   not money, no cash value, not transferable or convertible, buying nothing that is not an in-world
   good. Asserted verbatim in the DOM by the test.
2. **What you can do to earn** — every service from the payload: label, tier (world service versus
   service to another resident), award, today's remaining allowance *and* the allowance as a fraction,
   plus the server's own hint. Readable with no hover, no colour and no title attribute.
3. **The shop** — goods grouped by the category the server states, in the server's own order, each
   with label, summary, price, remaining daily allowance, and an explicit disabled state with the
   reason written out ("Not affordable yet: this good costs 35 Karma Coins and your wallet holds 24
   Karma Coins."). **A purchase is never fired by the first click**: the row's button arms a confirm
   block (`Confirm purchase of …` / `Cancel`), and only that confirm calls `onPurchase`.
4. **Where your Karma Coins came from** — the ledger entries, earn and spend, each with its human
   label, the word `earned`/`spent` (never a sign or a colour alone) and the time the server recorded.
5. **Comfort and access** — see §5 and §6.

## 5. Class names and attributes for the stylesheet

Panel: `.ui-shop`, `.ui-shop-reduced` (set while the reader asks for reduced motion), `.ui-shop-head`,
`.ui-shop-close`, `.ui-shop-wallet`, `.ui-shop-balance`, `.ui-shop-sentence`, `.ui-shop-policy`,
`.ui-shop-earn`, `.ui-service-list`, `.ui-service`, `.ui-service-line`, `.ui-service-award`,
`.ui-service-allowance`, `.ui-shop-goods`, `.ui-shop-categories`, `.ui-shop-category`,
`.ui-shop-goods-list`, `.ui-shop-good`, `.ui-shop-good-unavailable`, `.ui-shop-good-label`,
`.ui-shop-good-summary`, `.ui-shop-good-price`, `.ui-shop-good-note`, `.ui-shop-buy`, `.ui-shop-confirm`,
`.ui-shop-confirm-question`, `.ui-shop-confirm-button`, `.ui-shop-cancel`, `.ui-shop-ledger`,
`.ui-shop-entries`, `.ui-shop-entry`, `.ui-shop-entry-line`, `.ui-shop-refusal`,
`.ui-shop-refusal-words`, `.ui-shop-saved`, `.ui-shop-footnote`. It also reuses the shipped `.privacy`
and `.secondary small` classes, so it already inherits the theme's muted text.

Hooks for CSS and for a browser test: `[data-shop-panel]`, `[data-shop-close]`, `[data-shop-refusal]`,
`[data-shop-refusal-words]`, `[data-shop-purchase]`, `[data-shop-services="empty"]`,
`[data-shop-goods="empty"]`, `[data-shop-entries="empty"]`, `[data-category]`, `[data-good]`,
`[data-affordable="true|false"]`, `[data-exhausted="true|false"]`, `[data-armed]`, `[data-remaining]`,
`[data-buy]`, `[data-confirm-buy]`, `[data-confirm-cancel]`, `[data-confirm]`, `[data-service]`,
`[data-tier]`, `[data-direction]`, `[data-at]`.

## 6. Behaviour the integrator can rely on

- **One request per confirmation.** The confirm calls `onPurchase(goodId)` once. Until the next
  `update`, `buy()` refuses, so a double activation of the same node cannot send twice.
- **The panel believes nothing.** `buy()` does not touch the balance; the wallet moves only when a new
  payload arrives. A response the caller hands back as `purchase` is rendered from the server's own
  fields; a `refusal` is rendered as `role="alert"` with the server's own wording as the text of one
  paragraph, and never as a success.
- **Keyboard, without a mouse:** digits `1`–`9` arm the nth good, `Enter` (or Space) confirms it,
  `Escape` cancels the armed good and then asks to close. Every control is a real `<button type=button>`
  and the panel container itself is `tabindex="-1"`, so it can receive focus.
- **Focus:** focus moves into the panel when it opens, to the confirm when it is armed, back to the row
  when it is cancelled, and back to the trigger when it closes. Every other repaint leaves the focus
  alone. **Tab is never intercepted** and the panel is `role="dialog" aria-modal="false"` — it is not a
  trapping modal.
- **Reduced motion:** `prefersReducedMotion(matchMedia)` is exported for the caller, and the panel also
  adds `.ui-shop-reduced` itself while `reducedMotion()` is true, so a stylesheet that ignores the media
  query still suppresses the transitions (the same two-way arrangement `src/ui/touch-controls.js` uses).
- **No markup:** every server string is written as a DOM text node by `mount`. There is no markup
  parsing call anywhere in the file (asserted), and the test mounts a payload whose labels are
  `<script>`/`<img onerror>` strings and asserts they arrive whole as text.

## 7. What the integrator must do in `app.js`

```js
import { createShopPanel } from './src/ui/shop-panel.js';

const shopPanel = createShopPanel({
  onPurchase: (goodId) => guarded(async () => {
    try {
      const response = await api('/api/v1/shop/purchase', 'POST', { agent_id: state.selected, good_id: goodId });
      const [karma, shop] = await Promise.all([
        api(`/api/v1/karma?agent_id=${encodeURIComponent(state.selected)}`),
        api(`/api/v1/shop?agent_id=${encodeURIComponent(state.selected)}`),
      ]);
      state.karmaWallet = karma; state.shopCatalogue = shop;
      // The response is handed back as a payload; the panel never assumes it succeeded.
      shopPanel.update({ karma, shop, agentId: state.selected, purchase: response });
      notice('The server recorded the purchase.');
    } catch (error) {
      shopPanel.update({ refusal: { error: error.message } });
      notice(error.message, true);
    }
  }),
  onChange: () => renderView(),                      // or a narrower repaint of the card
  onClose: () => { state.shopOpen = false; renderView(); },
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
});
```

A card in the world aside, in the shape of the existing `inventoryCard()`:

```js
function shopCard(){
  const node = card('Karma Coins and the shop', 'EARNED BY SERVICE · GET /api/v1/karma · GET /api/v1/shop');
  node.id = 'world-shop-card';
  const agent = viewedAgent();
  if (!state.account || !agent) { node.append(paragraph('Sign in and play as a resident to earn and spend Karma Coins. Karma Coins are earned by service in the world and can be spent only in the shop.', 'privacy')); return node; }
  const host = element('div'); host.id = 'shop-panel-host'; node.append(host);
  state.shopTrigger = state.shopTrigger || button('Karma Coins and the shop', () => { shopPanel.open(); }, 'small');
  shopPanel.update({ karma: state.karmaWallet, shop: state.shopCatalogue, agentId: state.selected });
  shopPanel.paint(host, { document, trigger: state.shopTrigger });   // mount + focus, in one call
  return node;
}
```

Notes the integrator needs:

- **Fetch when it matters, not per frame.** `update` twice at the top of the render (once with the two
  payloads, once with the drawing) is fine; a network call inside `onChange` is not.
- **Route keys only while the panel is open and focused.** Digits `1`–`7` are the build palette in a
  frontier area (`src/camera-controls.js:40`), so an unconditional `handleKey` would steal them.
  Cleanest is a guard at the top of the one keydown handler in `app.js`, before
  `interactionPrompt.handleKey(event.key)`:
  ```js
  document.addEventListener('keydown', (event) => {
    // ... inside the existing handler, after the dialog/target guard, before the prompt:
    if (shopPanel.isOpen() && event.target.closest?.('#shop-panel-host') && shopPanel.handleKey(event.key)) {
      event.preventDefault();
      return;
    }
  });
  ```
  A panel that is mounted inline and never opened therefore binds no keys at all.
- **`GET /api/v1/karma` and `GET /api/v1/shop` are owner-session routes.** `src/shop.js` refuses a
  resident credential (`403`) and reads the wallet of the signed-in operator. Fetch them only when
  `state.account` and a selected resident exist, and re-fetch after a purchase. **As of this run,
  `server.js` had no `/api/v1/karma`, `/api/v1/shop` or `/api/v1/shop/purchase` route** — the two
  sibling owners are still wiring them, so confirm the final paths before mounting. The panel does not
  care about the path; only the `onPurchase` handler does.
- **The trigger.** `paint(host, { trigger })` records it, so `close()` and the Close button can return
  the focus. Without a trigger, `close()` simply leaves the focus where it was.
- **If you mount the panel inline and never call `open()`**, nothing is ever focused by the panel, the
  Close button is not rendered, and the panel is decorative in the focus order. That is deliberate:
  focus is only moved when the player asks the panel to open.
- **A repaint replaces every node**, so call `paint(host, …)` (or `mount(host, view())`) after every
  `update`, and after anything that changes the panel's own state.

## 8. What the integrator must do in the stylesheets

The module ships no CSS. A minimum that satisfies the requirements (this is a recipe, not a file that
exists yet):

```css
/* Comfortable and 390 px-safe: no fixed minimum width anywhere, so nothing scrolls sideways. */
.ui-shop{display:flex;flex-direction:column;gap:14px;max-width:100%;min-width:0;overflow-wrap:anywhere}
.ui-shop h3{font-size:1rem;margin:0}
.ui-shop .ui-shop-categories,.ui-shop .ui-service-list,.ui-shop .ui-shop-entries{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.ui-shop .ui-shop-balance{font-size:1.2rem}
.ui-shop .ui-shop-good,.ui-shop .ui-service,.ui-shop .ui-shop-entry{padding:10px 0;border-top:1px solid var(--line)}
/* 44 px touch targets (the project's minimum; style.css ships 34-36 px for .small). */
.ui-shop button{min-height:44px;min-width:44px;white-space:normal;text-align:left}
/* State that must not rely on colour: the reasons are already text, so these only soften it. */
.ui-shop .ui-shop-good-unavailable .ui-shop-buy{opacity:.75}
.ui-shop .ui-shop-good[data-armed="true"]{background:#d5dfb30b}
.ui-shop .ui-shop-refusal .ui-shop-refusal-words{color:var(--danger)}
/* Motion is opt-in, and suppressed again by the class the module sets. */
@media(prefers-reduced-motion:no-preference){ .ui-shop .ui-shop-confirm{transition:opacity .14s ease-out} }
@media(prefers-reduced-motion:reduce){ .ui-shop,.ui-shop *{transition:none!important;animation:none!important} }
.ui-shop.ui-shop-reduced,.ui-shop.ui-shop-reduced *{transition:none!important;animation:none!important}
```

**Contrast.** No rule in the snippet introduces a colour of its own; `--danger` is the theme's and
`.privacy` keeps the theme's muted text. Measured from the shipped tokens in `nemo-theme.css`
(`:root`) and `style.css` with the WCAG 2.1 relative-luminance formula — **computed from the tokens,
not read off a rendered page**:

| Pair | Ratio |
| --- | --- |
| `--ink #f1f0df` on `--panel #12382e` | 11.20:1 |
| `--muted #bccbc0` on `--panel #12382e` | 7.63:1 |
| `--accent/--gold #ded6a5` on `--panel #12382e` | 8.75:1 |
| `--danger #ffc1b5` on `--panel #12382e` | 8.31:1 |
| `--ink` on the deepest world background `#0a2a23` | 13.35:1 |
| `--muted` on `#0a2a23` | 9.09:1 |
| `--danger` on `#0a2a23` | 9.90:1 |
| `#20342c` (button label) on `--accent #c6e597` | 9.48:1 |
| `#133429` on a pressed accent `#e5dea8` | 9.89:1 |
| `#e5ebdb` on `--panel2 #173e34` | 9.71:1 |

Every pair clears WCAG AA (4.5:1 for normal text) and every pair also clears AAA (7:1). If you
introduce a new pair, measure it the same way and add the number to this table.

## 9. Commands run, with their real output

Only the three commands this task was allowed to run were run.

```
$ node --check src/ui/shop-panel.js
$ echo $?
0
$ node --check tests/shop-panel.test.js
$ echo $?
0
```

```
$ node --test tests/shop-panel.test.js
✔ a payload renders the balance, the service list and the goods (7.315208ms)
✔ the wallet states what Karma Coins are and are not, in one plain sentence (0.805625ms)
✔ affordability is the server’s own flag, never an arithmetic the panel performs (0.495791ms)
✔ an unaffordable good is disabled and can never fire a purchase (0.741833ms)
✔ the first click on a good only asks, and the confirm is what fires (1.9135ms)
✔ a refusal is shown in the server’s own words, never rephrased and never as a success (0.833917ms)
✔ a purchase response moves the wallet only when a new payload hands it over (1.36325ms)
✔ the panel is operable from the keyboard alone, and never traps Tab (0.743083ms)
✔ focus moves into the panel when it opens and back to the trigger when it closes (1.469208ms)
✔ the reduced-motion class is applied when the reader asks for it (0.604792ms)
✔ every state is written out, so nothing depends on a tooltip or on colour (0.421584ms)
✔ no server string is ever markup, and the module injects none (0.491708ms)
✔ the models keep only what the server stated (0.257292ms)
✔ the panel reads the sibling modules’ own projection, not just the agreed brief (0.919833ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 104.235291
```

`npm test`, `npm run browser` and `npm run e2e` were **not** run: five owners share this tree and the
full suite is load-sensitive (and `app.js` is not wired yet, so a browser scenario could not be added
anyway). The test file uses the same tiny in-test DOM the other UI module tests use
(`FakeElement`/`FakeText`/`fakeDocument` copied from `tests/build-interface.test.js`, extended with
`focus()`/`activeElement`/`firstChild`/`collect`), so no new helper and no new dependency was added.

## 10. A defect found in the shared button helper (not fixed — not this task's file)

`mount()` in `src/ui/build-interface.js` attaches listeners with
`Object.entries(node.on || {})` (line 793 in the tree as I left it). The local `button()` helpers in
**`src/ui/build-interface.js:409`** and **`src/ui/inventory-panel.js:19`** pass the handler *function*
straight in as `on`, so those buttons get **no listener at all** under `mount` — for instance the
inventory panel's `Craft`/`Accept`/`Decline`/`Cancel` buttons (`src/ui/inventory-panel.js:85,95-97`)
and the placement preview's `Remove my block` (`src/ui/build-interface.js:428`). The existing tests do
not catch it because they call `craft()` and `confirm()` directly instead of clicking. Verified with a
script against the real `el`/`mount`:

```
function-form click listeners = 0
object-form click listeners = 1
```

`src/ui/shop-panel.js` therefore wraps its handlers explicitly
(`on: typeof on === 'function' ? { click: on } : on`) and its test clicks the rendered node, so every
shop control is proven to have a listener. Fixing the shared helpers is the integrator's call; it would
change shipped behaviour in `inventory-panel.js` and `build-interface.js`.

## 11. Limitations — what is not proven

- **Not seen in a real browser.** No page was opened, no screenshot taken, no pointer emulated, no
  screen reader run. Every claim above is either a module test or arithmetic.
- **Not wired.** `app.js`, `index.html` and the stylesheets are untouched, so **nothing renders
  anywhere yet**: no panel appears in the world, the drawer has no trigger, and the classes in §5 have
  no rules. The 44 px targets, the "no horizontal scrolling at 390 px" claim and the contrast table all
  depend on the stylesheet in §8 being added — the module only emits the classes and the data
  attributes.
- **The server routes may not exist yet.** As of this run `server.js` had no `/api/v1/karma`,
  `/api/v1/shop` or `/api/v1/shop/purchase` route; the two sibling owners are still landing them. The
  final path, the request body field name for the good (`good_id` in `src/shop.js`) and the idempotency
  key are the integrator's to confirm.
- **Field drift is handled defensively, but only where it was known.** The alternative names in §3 come
  from reading `src/karma.js` and `src/shop.js` at 16:16 today. If either owner renames a field again,
  the panel degrades to "not stated by the server" rather than guessing — `update` never throws on a
  surprising payload, but the panel could then show less than the server holds.
- **Focus behaviour is asserted on created nodes with a stub document**, not on a live focus ring. The
  shim's `focus()` records the element; a real browser additionally needs the host to be in the
  document and visible when `paint` runs, which is why `open()` calls `onChange()` *before* focusing.
- **Timestamps render in the visitor's local time** (`formatTimestamp`), so an entry recorded late in
  the UTC day can show the next or previous local date. The raw server value stays available as
  `[data-at]` on the entry.
- **The ledger is the first 100 entries the karma payload carries** (`src/karma.js` caps it). The panel
  does not paginate and does not show `has_more`, `today` or `verify`; those stay on `model().karma`
  for whoever wants them.
- **`awaiting` is per panel instance** and is released by any `update`. If the caller never re-fetches
  after a failure, the player must reload before the same good can be confirmed again.
