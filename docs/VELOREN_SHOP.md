# Veloren shop (Karma Coins in the game)

A linked Veloren player can ask a NemoWorld shopkeeper resident (**Kael Hearthforge**, `lw-kael`) what
the shop sells and request one good. He answers privately and takes no payment in chat. The purchase
happens in NemoWorld, done by the signed-in human operator; the good is handed over inside the game by
the Veloren server and the order is complete only when that server acknowledges it.

```
player --/tell--> Kael's bridge --POST /veloren/shop/ask--> NemoWorld lines --> /tell back
                                       (a PENDING request, bounded, 10 minutes; nothing charged)
signed-in human --> /api/v1/veloren/shop/panel --> POST /veloren/shop/requests/confirm
                                          platform.shopPurchase (allowances, ledger, Idempotency-Key)
                                          --> link.issueCommand(grant_item, order/good/qty)
Veloren server: allow-list -> player online -> fits in the pack -> record order -> give items -> ack
NemoWorld: only that signed acknowledgement marks the order delivered
```

## Nothing in this feature can mint, price or hand over value by itself

| Promise | How |
|---|---|
| Karma is never earned in Veloren | This module never calls `karmaSettle` and never writes a Karma table. Karma comes from `src/karma.js` (services performed in the world), as before. |
| A chat line can never buy anything | `parseIntent` maps words onto fixed answers and fixed good ids only. A "yes" in chat is answered with "I cannot take a yes in chat" and changes nothing. |
| Asking costs nothing | An ask writes one pending request row. The Karma is spent by `platform.shopPurchase` inside the platform's own transaction, which is only called from the human's confirmation. |
| The price and the quantity come from NemoWorld | The request stores the price from `SHOP_CATALOGUE`; the command carries only a good id and the manifest's quantity. A player can never name an item, a price or a quantity. |
| One order, one delivery | The order id is the request id; the Veloren server records it before giving anything (`<outbox>.shop-delivered`) and refuses a second delivery of the same order, even across restarts. The platform's ledger cannot be debited twice for one request (the key is derived from the request id). |
| "Delivered" means acknowledged | The shop reads only signed `command.applied` / `command.rejected` events for that command **and that player** (`link_events`). Until then the order is `delivering` or `unconfirmed`, never "done". |
| A failed delivery never loses the purchase or double-charges | The good is already on the buyer's NemoWorld shelf (the platform's own grant, committed with the debit). The in-game hand-over can be retried by the operator; the Karma is never refunded twice and the game never delivers one order twice. |
| No player can see another's orders | `shop_requests` is read only through the signed-in session, always filtered by `account_id`; another account's request answers exactly like a missing one (404). |
| A character that is no longer linked cannot be charged | Confirmation re-checks that the request's character is still linked to the confirming account, with the same resident. |

## The delivery allow-list (the one file two repositories share)

`content/veloren-shop-manifest.json` (NemoWorld) and `server/src/nemo/shop/manifest.json` (Veloren) are
the same file: a good id maps to one *existing* Veloren item definition and a fixed quantity, capped at
10. Both sides pin the same fingerprint line (`tests/shop-manifest.test.js` and
`logic.rs::manifest_fingerprint_is_pinned_with_nemoworld`), so the two copies cannot drift apart
unnoticed. The Rust side also checks that every item is a real asset file and that a keepsake carries no
combat stats, so a purchase can never buy power.

The Veloren server compiles the allow-list into the binary (`include_str!`): it cannot be swapped at run
time.

## The command (`grant_item`)

`args` is a strict JSON object: `order` (the request id, a UUID), `good` (an identifier on the
allow-list), `qty` (must equal the manifest quantity, at most 10) and an optional `dry_run`. Any other
field, a bad shape, an unknown good or a wrong quantity is refused. Rejections are logged on the server
with a reason; the acknowledgement NemoWorld receives carries only `command.applied` / `command.rejected`,
so nothing in it can be used to probe the server.

A `dry_run` command does every check (player online, allow-list, room in the pack) and gives nothing.
NemoWorld uses it as a preflight **before** charging, so a game that cannot deliver never spends Karma.

The server also refuses a grant when the player is offline or has no character in the world, when the
whole order does not fit in the pack (nothing is given, not half), when the item definition is
unavailable, or when more than 16 grants arrive in one pass (the excess is answered `busy`, and the human
can retry).

## Routes

Bridge side, `Authorization: Bearer <link credential>`, scope **`shop`** (a new scope: a shop credential
can only ask and read notices — it can never ingest events, direct a resident or redeem a link):

* `POST /veloren/shop/ask` `{resident_id, player_uuid, player_alias, text}` → `{lines, reply, intent, request_id?}`
* `GET /veloren/shop/notices` → `{notices:[{id, player_uuid, text}]}`
* `POST /veloren/shop/notices/ack` `{ids}` → `{acknowledged}` (only notices actually delivered are acknowledged, so the rest are offered again until they expire)

Signed-in human (NemoWorld session cookie or operator token; the hosting layer requires the same
`Origin` for a write, and an AI runtime credential is refused):

* `GET /veloren/shop/requests` → this account's requests, each with its state, its delivery state and whether it can be confirmed
* `POST /veloren/shop/requests/confirm` `{request_id}` with an `Idempotency-Key` header → charges, then asks the game to deliver
* `POST /veloren/shop/requests/decline` `{request_id}`
* `POST /veloren/shop/orders/retry` `{request_id}` → asks the game again for an order that was paid but not delivered
* `GET /veloren/shop/panel`, `/panel.js`, `/panel.css` → the operator page (no data, no secrets; it reads the requests with the operator's own session)

The operator page is at `/api/v1/veloren/shop/panel` (the extension serves it, so `server.js` needs no
change). It shows the purse, the account's requests, and a Confirm / Decline / Retry button per request.

## In the game

Whisper Kael (`/tell Kael what is for sale`, `buy herb bundle`, `my balance`, `my orders`, `cancel`) or
say his name in public chat. He answers by `/tell`. What he says is scripted; he never speaks for
NemoWorld's prices and refuses to take a confirmation in chat. A player with no linked account is told to
link first and is never given a request row.

## Tests

* `node --test tests/veloren-shop.test.js tests/veloren-shop-http.test.js tests/shop-manifest.test.js`
  (16 tests): what a spoken line can mean, an unlinked player, the bounds and expiry of a request, the
  human-only confirmation, the idempotency key, one charge per request, delivery only on a signed
  acknowledgement for that player, an acknowledgement naming someone else, a game that does not answer or
  refuses, a duplicate acknowledgement recorded as an anomaly, retry without a second charge, a character
  that is no longer linked, the route scopes over HTTP, and the operator page.
* `cargo test --release -p veloren-server --lib nemo_shop` (11 tests): the manifest (validity, the pinned
  fingerprint, real item files, no stats on a keepsake), strict arguments, the allow-list, quantity abuse,
  one delivery per order, and bad manifests at load.
* `cargo test --release -p nemo-bridge` covers the bridge's pure logic (parsing, clipping, splitting,
  script parsing) in `chat_shop.rs`.

## Limits

* Delivery needs the player online and in the world with room in the pack. If not, the Karma is spent and
  the good sits on the buyer's NemoWorld shelf until an operator retries the hand-over in the game.
* The item lands in the Veloren inventory; NemoWorld's own shelf copy is the authoritative grant. The two
  are not reconciled automatically — that is deliberate, so a failed hand-over cannot lose the purchase.
* One shopkeeper is configured (`lw-kael`). A shop credential is refused for any other resident.
* The bridge's shopkeeper mode is started with `--shop`; `wt/stack.sh resident-start` does not pass that
  flag (see `wt/evidence/shop/REMAINING.md`).
* The order's Karma is not refunded automatically. A refund would be a human action in NemoWorld.
