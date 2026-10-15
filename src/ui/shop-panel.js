// The shop panel — Karma Coins in one place: what you hold, what service earns more of them, what
// the shop sells, and where the coins you already have actually came from.
//
// Four rules this file keeps.
//
//   * **Presentation and intent only.** The panel decides no price, computes no balance, assumes no
//     purchase succeeded and never writes. It renders the server's own payload and hands the player's
//     *confirmed* choice to the caller as `onPurchase(goodId)`. Whether the purchase happened is the
//     server's own answer, which arrives as the next payload: `purchase` for a granted good, `refusal`
//     for the server's refusal wording, shown verbatim.
//   * **Karma Coins are not NemoCoins.** They are earned by doing service in the world and are spent
//     only in this shop: not money, no cash value, not transferable, not convertible, and they buy
//     nothing that is not an in-world good. The wallet line says exactly that in one plain sentence,
//     so a player never has to infer it from a colour, a tooltip or a tooltip-shaped silence.
//   * **No state is carried by hover or by colour.** Every condition a player must know — the tier of
//     a service, the award, the allowance left today, why a good cannot be bought yet, whether a
//     ledger entry earned or spent — is written out as text, and every control is a real `<button>`
//     or the panel container itself, so a keyboard, a switch and a screen reader reach all of it. The
//     panel never traps focus: Tab keeps its native meaning and the container is not a modal.
//   * **Server text is text.** Every string that came from the server is written through a DOM text
//     node built by `src/ui/build-interface.js`; this file never parses markup and never assigns one,
//     so a good called `<b>hat</b>` stays a good called `<b>hat</b>`.
//
// The view is the same plain tree `src/ui/build-interface.js` builds, and `mount` from that module is
// the only function that writes into the document.
import { el, mount } from './build-interface.js';

/** The currency's name, as the wallet line and every award spells it. */
export const KARMA_COIN_NAME = 'Karma Coins';
/** The project's target minimum (nemo-theme.css, measured at 44 px in game-mobile.css). */
export const TOUCH_TARGET_MIN = 44;
/** Set on the panel while the reader asks for reduced motion, so a stylesheet can suppress transitions. */
export const REDUCED_MOTION_CLASS = 'ui-shop-reduced';
/** Enter (or Space) confirms the armed good; Escape cancels the armed good and then closes the panel. */
export const CONFIRM_KEY = 'Enter';
export const CANCEL_KEY = 'Escape';
/** The one plain sentence that says what Karma Coins are and are not. */
export const KARMA_COIN_SENTENCE = 'Karma Coins are earned by doing service in the world, for the world itself or for another resident, and are spent only in this shop: they are not NemoCoins, not money, have no cash value, cannot be transferred or converted, and buy nothing that is not an in-world good.';
export const SHOP_FOOTNOTE = 'A purchase is never sent by the first click: the panel asks you to confirm, and only the server decides whether the purchase happened.';
/** The server states a `tier`; this is only how the panel spells the ones that have a plain name. */
export const TIER_LABELS = Object.freeze({
  world: 'World service', service_to_world: 'World service', for_the_world: 'World service', world_service: 'World service',
  service: 'Service to another resident', service_to_others: 'Service to another resident', others: 'Service to another resident', other_residents: 'Service to another resident',
  resident: 'Service to another resident', another_resident: 'Service to another resident', service_to_another_resident: 'Service to another resident',
  neighbour: 'Service to another resident', neighbor: 'Service to another resident', resident_service: 'Service to another resident',
});

const numberOr = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const wordsOf = (value) => String(value ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const humanise = (value) => { const text = wordsOf(value); return text ? text[0].toUpperCase() + text.slice(1) : ''; };
const textOr = (value) => (typeof value === 'string' && value.trim() ? value : null);
/** The first of several names a payload might use for the same number, so field drift is survivable. */
const firstNumber = (source, names) => { for (const name of names) { const value = numberOr(source?.[name]); if (value !== null) return value; } return null; };
/** The server may carry its policy as a sentence, a description or the bare string. */
const policyText = (policy) => (typeof policy === 'string' ? textOr(policy) : textOr(policy?.sentence) || textOr(policy?.description));

/** `3 Karma Coins`; `1 Karma Coin`; null when the server did not state a number. */
export const coinText = (amount, name = KARMA_COIN_NAME) => {
  const number = numberOr(amount);
  if (number === null) return null;
  return number === 1 && name === KARMA_COIN_NAME ? '1 Karma Coin' : `${number} ${name}`;
};

/** A readable name for the tier the server states, never a guess about what the tier means. */
export function tierLabel(tier) {
  const key = wordsOf(tier).toLowerCase().replace(/\s+/g, '_');
  if (!key) return 'Tier not stated by the server';
  return TIER_LABELS[key] || humanise(key);
}

/**
 * `prefers-reduced-motion`, read through an injected matchMedia so it can be tested (the same
 * helper `src/ui/touch-controls.js` uses, so both surfaces answer the question the same way).
 */
export function prefersReducedMotion(match) {
  if (typeof match !== 'function') return false;
  try { return Boolean(match('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
}

/** A ledger timestamp a person can read: an ISO instant in local time, anything else as it arrived. */
export function formatTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return text;
  const pad = (part) => String(part).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * How much of today's allowance is left, in words. `noun` is what the allowance belongs to, so the
 * same sentence serves a service and a good. Null when the server stated neither number.
 */
export function allowanceText(entry, noun = 'this') {
  const remaining = numberOr(entry?.remaining_today);
  const perDay = numberOr(entry?.per_day);
  if (remaining === 0) return `No more of ${noun} today.`;
  if (remaining === null) return perDay === null ? null : `${perDay} a day.`;
  if (perDay === null) return `${remaining} still available today.`;
  return `${remaining} of ${perDay} still available today.`;
}

const entryRow = (entry) => Object.freeze({
  direction: entry?.direction === 'spend' ? 'spend' : entry?.direction === 'earn' ? 'earn' : String(entry?.direction ?? ''),
  label: String(entry?.label ?? 'Karma Coin movement'),
  amount: numberOr(entry?.amount),
  created_at: entry?.created_at ?? null,
});

/** The `GET /api/v1/karma` payload as a model: the balance, the services and the movement ledger. */
export function karmaModel(karma = null) {
  if (!karma) return Object.freeze({ ready: false, balance: null, services: Object.freeze([]), entries: Object.freeze([]), currency: null, policy: null });
  const services = (Array.isArray(karma.services) ? karma.services : []).map((service) => {
    const remaining = numberOr(service?.remaining_today);
    return Object.freeze({
      id: service?.id ?? null,
      label: String(service?.label ?? service?.id ?? 'A service'),
      tier: service?.tier ?? null,
      tier_label: tierLabel(service?.tier),
      award: numberOr(service?.award),
      per_day: firstNumber(service, ['per_day', 'per_day_limit', 'daily_limit']),
      remaining_today: remaining,
      exhausted: remaining === 0,
      hint: textOr(service?.hint) || textOr(service?.note) || '',
    });
  });
  return Object.freeze({
    ready: true,
    balance: numberOr(karma.balance),
    currency: textOr(karma.currency),
    services: Object.freeze(services),
    entries: Object.freeze((Array.isArray(karma.entries) ? karma.entries : []).map(entryRow)),
    today: karma.today ?? null,
    verify: karma.verify ?? null,
    policy: policyText(karma.policy),
  });
}

/** The `GET /api/v1/shop` payload as a model: the goods, grouped by the category the server states. */
export function shopModel(shop = null) {
  if (!shop) return Object.freeze({ ready: false, balance: null, goods: Object.freeze([]), categories: Object.freeze([]), entries: Object.freeze([]), currency: null, policy: null });
  const goods = (Array.isArray(shop.goods) ? shop.goods : []).map((good) => {
    const remaining = numberOr(good?.remaining_today);
    // The server's own affordability flag under either of the names the projection might use. A
    // null or absent flag is never read as "yes": the panel never compares a price with a balance.
    const flagged = good?.affordable ?? good?.can_afford;
    return Object.freeze({
      id: good?.id ?? null,
      label: String(good?.label ?? good?.id ?? 'A good'),
      summary: textOr(good?.summary) || '',
      category: good?.category ?? null,
      category_label: humanise(good?.category) || 'Other goods',
      price: numberOr(good?.price),
      per_day: firstNumber(good, ['per_day_limit', 'daily_limit', 'per_account_limit_per_day']),
      remaining_today: remaining,
      exhausted: remaining === 0,
      affordable: flagged === true,
      can_buy: flagged === true && remaining !== 0,
    });
  });
  const order = [];
  for (const good of goods) {
    const key = good.category === null || good.category === undefined ? '' : String(good.category);
    if (!order.includes(key)) order.push(key);
  }
  const categories = order.map((key) => Object.freeze({ name: key, label: humanise(key) || 'Other goods', goods: Object.freeze(goods.filter((good) => (good.category === null || good.category === undefined ? '' : String(good.category)) === key)) }));
  return Object.freeze({
    ready: true,
    balance: numberOr(shop.balance),
    currency: textOr(shop.currency),
    goods: Object.freeze(goods),
    categories: Object.freeze(categories),
    entries: Object.freeze((Array.isArray(shop.entries) ? shop.entries : []).map(entryRow)),
    policy: policyText(shop.policy),
  });
}

/**
 * What the server said about one purchase, in its own words. Never a claim the panel invented.
 *
 * Both shapes are read: `{ purchase: {…}, balance_after }` and the flat record the shop projection
 * itself returns (`{ good_id, label, price, granted, balance_after, … }`). A `granted` that is an
 * object is not a name, so the good is named from `granted` only when it is a string.
 */
export function purchaseSentence(payload, name = KARMA_COIN_NAME) {
  const nested = payload?.purchase && typeof payload.purchase === 'object' ? payload.purchase : null;
  const purchase = nested || payload || {};
  const good = [purchase.granted, purchase.good, purchase.label, purchase.good_id].find((value) => typeof value === 'string' && value.trim());
  const price = coinText(purchase.price, name);
  const after = numberOr(payload?.balance_after ?? purchase.balance_after);
  if (!good) return 'The server recorded a purchase.';
  return `The server granted ${good}${price ? ` for ${price}` : ''}.${after === null ? '' : ` Your wallet then held ${after} ${name}.`}`;
}

// `mount` in src/ui/build-interface.js attaches a listener per key of `on`, so a bare function here
// would render a button with no listener at all: the handler is wrapped into `{ click }` explicitly.
const button = (label, on, options = {}) => el('button', { class: options.class || 'small', attrs: { type: 'button', 'aria-label': options.label || label, ...(options.attrs || {}) }, on: typeof on === 'function' ? { click: on } : (on || {}), text: label });

const nodesUnder = (root) => {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    found.push(node);
    const children = node.childNodes || node.children || [];
    for (const child of children) walk(child);
  };
  walk(root);
  return found;
};
const findByAttribute = (root, name, value) => nodesUnder(root).find((node) => typeof node.getAttribute === 'function' && node.getAttribute(name) === value) || null;

const walletView = (model) => el('div', { class: 'ui-shop-wallet', attrs: { role: 'group', 'aria-label': `Your ${model.wallet.name} wallet` } }, [
  el('strong', { class: 'ui-shop-balance', text: model.wallet.balance === null ? `${model.wallet.name}: not stated by the server` : `${model.wallet.name}: ${model.wallet.balance}` }),
  el('p', { class: 'privacy ui-shop-sentence', text: KARMA_COIN_SENTENCE }),
  model.wallet.policy ? el('p', { class: 'privacy ui-shop-policy', text: `The server says: ${model.wallet.policy}` }) : null,
  model.agentId ? null : el('p', { class: 'privacy', text: 'Play as a resident to see the Karma Coins it has earned.' }),
]);

const serviceView = (service, name) => {
  const allowance = allowanceText(service, 'this service');
  return el('li', { class: 'ui-service', attrs: { 'data-service': service.id || '', 'data-tier': service.tier || '', 'data-exhausted': String(service.exhausted) } }, [
    el('p', { class: 'ui-service-line', text: `${service.label} — ${service.tier_label}` }),
    el('p', { class: 'ui-service-award', text: `Award: ${coinText(service.award, name) || 'not stated by the server'}` }),
    allowance ? el('p', { class: 'ui-service-allowance', text: allowance }) : null,
    service.hint ? el('p', { class: 'privacy', text: service.hint }) : null,
  ]);
};

const earnView = (model) => el('div', { class: 'ui-shop-earn' }, [
  el('h3', { text: 'What you can do to earn' }),
  el('p', { class: 'privacy', text: 'A service is done in the world, not from this panel. The award and the allowance below are the server’s own numbers, and it records the service itself.' }),
  model.services.length
    ? el('ul', { class: 'ui-service-list' }, model.services.map((service) => serviceView(service, model.wallet.name)))
    : el('p', { class: 'privacy', attrs: { 'data-shop-services': 'empty' }, text: 'The server has not sent a list of services for this resident yet.' }),
]);

/** Why this good cannot be bought yet, in words — the price and the balance are both the server's. */
const cannotBuyNote = (good, model) => {
  const reasons = [];
  if (!good.affordable) {
    const price = coinText(good.price, model.wallet.name) || 'a price the server did not state';
    const held = model.wallet.balance === null ? 'the server has not stated your balance' : `${model.wallet.balance} ${model.wallet.name}`;
    reasons.push(`Not affordable yet: this good costs ${price} and your wallet holds ${held}.`);
  }
  if (good.exhausted) reasons.push('No more of this good today; it returns tomorrow.');
  return reasons.join(' ');
};

const confirmView = (good, model, handlers) => el('div', { class: 'ui-shop-confirm', attrs: { role: 'group', 'aria-label': `Confirm buying ${good.label}`, 'data-confirm': good.id || '' } }, [
  el('p', { class: 'ui-shop-confirm-question', text: `Buy ${good.label} for ${coinText(good.price, model.wallet.name) || 'the price the server states'}?` }),
  el('p', { class: 'privacy', text: 'Nothing has been bought yet. Confirming sends the request, and the server decides whether it is granted.' }),
  button(`Confirm purchase of ${good.label}`, () => handlers.buy(good.id), { class: 'ui-shop-confirm-button', attrs: { 'data-confirm-buy': good.id || '' } }),
  button('Cancel', () => handlers.cancel(good.id), { class: 'secondary small ui-shop-cancel', label: `Cancel buying ${good.label}`, attrs: { 'data-confirm-cancel': good.id || '' } }),
]);

const goodView = (good, model, handlers) => {
  const armed = model.selected === good.id;
  const name = model.wallet.name;
  const note = good.can_buy ? '' : cannotBuyNote(good, model);
  const allowance = allowanceText(good, 'this good');
  return el('li', {
    class: `ui-shop-good ${good.can_buy ? '' : 'ui-shop-good-unavailable'}`.trim(),
    attrs: {
      'data-good': good.id || '', 'data-affordable': String(good.affordable), 'data-remaining': good.remaining_today === null ? '' : String(good.remaining_today),
      'data-exhausted': String(good.exhausted), 'data-armed': String(armed),
    },
  }, [
    el('p', { class: 'ui-shop-good-label', text: `${good.label} — ${coinText(good.price, name) || 'price not stated by the server'}` }),
    good.summary ? el('p', { class: 'ui-shop-good-summary', text: good.summary }) : null,
    allowance ? el('p', { class: 'ui-shop-good-price', text: allowance }) : null,
    note ? el('p', { class: 'privacy ui-shop-good-note', text: note }) : null,
    armed
      ? confirmView(good, model, handlers)
      : button(good.can_buy ? `Buy ${good.label}` : `${good.label} cannot be bought yet`, () => handlers.select(good.id), {
        class: 'ui-shop-buy',
        label: good.can_buy ? `Buy ${good.label} for ${coinText(good.price, name) || 'the price the server states'}` : `${good.label} cannot be bought yet. ${note}`.trim(),
        attrs: { 'data-buy': good.id || '', ...(good.can_buy ? {} : { disabled: true, 'aria-disabled': 'true' }) },
      }),
  ]);
};

const goodsView = (model, handlers) => el('div', { class: 'ui-shop-goods' }, [
  el('h3', { text: 'The shop' }),
  model.categories.length
    ? el('div', { class: 'ui-shop-categories' }, model.categories.map((category) => el('section', { class: 'ui-shop-category', attrs: { 'data-category': category.name } }, [
      el('h4', { text: category.label }),
      el('ul', { class: 'ui-shop-goods-list' }, category.goods.map((good) => goodView(good, model, handlers))),
    ])))
    : el('p', { class: 'privacy', attrs: { 'data-shop-goods': 'empty' }, text: 'The server has not sent a list of goods for this shop yet.' }),
]);

const entryView = (entry, name) => {
  const verb = entry.direction === 'spend' ? 'spent' : entry.direction === 'earn' ? 'earned' : 'recorded';
  const amount = entry.amount === null ? 'an amount the server did not state' : coinText(entry.amount, name);
  const time = formatTimestamp(entry.created_at);
  return el('li', { class: 'ui-shop-entry', attrs: { 'data-direction': entry.direction, ...(entry.created_at ? { 'data-at': String(entry.created_at) } : {}) } }, [
    el('p', { class: 'ui-shop-entry-line', text: `${entry.label} — ${verb} ${amount}` }),
    el('p', { class: 'privacy', text: time ? `Recorded ${time}` : 'The server did not state when this happened.' }),
  ]);
};

const ledgerView = (model) => el('div', { class: 'ui-shop-ledger' }, [
  el('h3', { text: 'Where your Karma Coins came from' }),
  model.entries.length
    ? el('ul', { class: 'ui-shop-entries' }, model.entries.map((entry) => entryView(entry, model.wallet.name)))
    : el('p', { class: 'privacy', attrs: { 'data-shop-entries': 'empty' }, text: 'No Karma Coin movement is recorded yet. Do a service in the world and the server will record the award here.' }),
]);

const refusalView = (refusal) => el('div', { class: 'ui-shop-refusal', attrs: { 'data-shop-refusal': '1' } }, [
  el('p', { class: 'privacy', text: 'The server refused the purchase. Its own words:' }),
  el('p', { class: 'ui-shop-refusal-words', attrs: { role: 'alert', 'aria-live': 'assertive', 'data-shop-refusal-words': '1' }, text: refusal.error }),
]);

const savedView = (saved, name) => el('div', { class: 'ui-shop-saved', attrs: { role: 'status', 'aria-live': 'polite', 'data-shop-purchase': '1' } }, [
  el('p', { text: purchaseSentence(saved, name) }),
]);

/**
 * The shop panel. `update({ karma, shop, agentId, refusal, purchase })` ingests the shell's payloads;
 * `onPurchase(goodId)` is the only thing it sends out, and only after the player confirms.
 *
 * `karma` and `shop` describe where the player stands: omitting one keeps the last one the panel was
 * given. `refusal` and `purchase` belong to one server answer: omitting them clears them, so a fresh
 * payload never leaves a stale refusal on screen.
 */
export function createShopPanel({ onPurchase, onChange, onClose, reducedMotion = () => false } = {}) {
  let karma = karmaModel(null);
  let shop = shopModel(null);
  let agentId = null;
  let refusal = null; // { error } — the server's own refusal wording
  let saved = null; // the POST /api/v1/shop/purchase response the caller handed back
  let selected = null; // the good that has been chosen but not yet confirmed
  let awaiting = null; // the good whose request is out; cleared by the next payload
  let open = false;
  let painted = null; // { root, document, node, trigger }
  let focusIntent = null; // where the next paint should put the focus, consumed once

  const quiet = () => (typeof reducedMotion === 'function' ? Boolean(reducedMotion()) : Boolean(reducedMotion));
  const goodById = (id) => shop.goods.find((good) => good.id === id) || null;
  const entries = () => (karma.entries.length ? karma.entries : shop.entries);

  const model = () => Object.freeze({
    ready: karma.ready && shop.ready,
    agentId,
    wallet: Object.freeze({
      // The server's own name for the unit when it states one, so the panel and the ledger agree.
      name: shop.currency || karma.currency || KARMA_COIN_NAME,
      balance: karma.balance === null ? shop.balance : karma.balance,
      sentence: KARMA_COIN_SENTENCE,
      policy: shop.policy || karma.policy,
    }),
    services: karma.services,
    goods: shop.goods,
    categories: shop.categories,
    entries: entries(),
    refusal,
    saved,
    selected,
    awaiting,
    open,
    karma,
    shop,
  });

  const applyFocus = () => {
    if (!painted || !focusIntent) return;
    const { kind, good } = focusIntent;
    focusIntent = null;
    let target = null;
    if (kind === 'panel') target = painted.node;
    else if (kind === 'good' && good) target = findByAttribute(painted.root, 'data-buy', good);
    else if (kind === 'confirm' && good) target = findByAttribute(painted.root, 'data-confirm-buy', good);
    else if (kind === 'trigger') target = painted.trigger;
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  };

  /** Choose a good. This is the first click: it arms the confirmation and buys nothing. */
  const select = (goodId) => {
    const good = goodById(goodId);
    if (!good || !good.can_buy) return null;
    selected = good.id;
    focusIntent = { kind: 'confirm', good: good.id };
    onChange?.();
    return good;
  };

  const cancel = () => {
    const was = selected;
    selected = null;
    if (!was) return null;
    focusIntent = { kind: 'good', good: was };
    onChange?.();
    return was;
  };

  /**
   * Confirm the armed good. It calls `onPurchase(goodId)` and changes no balance: the wallet only
   * moves when the caller hands the panel the next payload. Until that payload arrives the same
   * confirmation cannot fire a second request.
   */
  const buy = () => {
    if (awaiting) return null;
    const good = selected ? goodById(selected) : null;
    if (!good || !good.can_buy) return null;
    awaiting = good.id;
    selected = null;
    focusIntent = { kind: 'good', good: good.id };
    onPurchase?.(good.id);
    onChange?.();
    return good;
  };

  const closePanel = () => {
    open = false;
    selected = null;
    focusIntent = { kind: 'trigger' };
    // The focus goes back to the trigger before the caller hides or removes anything.
    applyFocus();
    onChange?.();
    return open;
  };

  const view = () => {
    const current = model();
    return el('section', {
      class: `ui-shop${quiet() ? ` ${REDUCED_MOTION_CLASS}` : ''}`,
      attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Karma Coins and the shop', tabindex: '-1', 'data-shop-panel': '1' },
    }, [
      el('div', { class: 'ui-shop-head' }, [
        el('h2', { text: 'Karma Coins and the shop' }),
        open ? button('Close', () => dismiss(), { class: 'secondary ui-shop-close', label: 'Close the shop panel', attrs: { 'data-shop-close': '1' } }) : null,
      ]),
      walletView(current),
      earnView(current),
      goodsView(current, { select, buy, cancel }),
      ledgerView(current),
      refusal ? refusalView(refusal) : null,
      saved ? savedView(saved, current.wallet.name) : null,
      el('p', { class: 'privacy ui-shop-footnote', text: SHOP_FOOTNOTE }),
    ]);
  };

  /**
   * Mount the panel and put the focus where the last intention asked for it. Focus moves into the
   * panel when it opens and back to the trigger when it closes; every other repaint leaves the focus
   * where the player put it, and Tab is never intercepted.
   */
  const paint = (root, { document: dom = globalThis.document, trigger = null } = {}) => {
    if (!root) throw new TypeError('The shop panel needs a host element to paint into.');
    if (!dom || typeof dom.createElement !== 'function') throw new TypeError('The shop panel needs a DOM document to paint into.');
    mount(root, view(), dom);
    painted = { root, document: dom, node: root.firstChild || null, trigger: trigger || painted?.trigger || null };
    applyFocus();
    return painted.node;
  };

  const update = ({ karma: karmaPayload, shop: shopPayload, agentId: id, refusal: refusalPayload = null, purchase = null } = {}) => {
    if (karmaPayload !== undefined) karma = karmaModel(karmaPayload);
    if (shopPayload !== undefined) shop = shopModel(shopPayload);
    if (id !== undefined) agentId = id;
    refusal = refusalPayload?.error ? Object.freeze({ error: String(refusalPayload.error) }) : null;
    saved = purchase ? Object.freeze({ ...purchase }) : null;
    awaiting = null;
    // A good that the new payload no longer offers, or no longer lets the player buy, cannot stay armed.
    if (selected && !goodById(selected)?.can_buy) selected = null;
    return model();
  };

  const openPanel = () => {
    open = true;
    focusIntent = { kind: 'panel' };
    // The caller shows the panel first (its own repaint), then the focus lands inside it.
    onChange?.();
    applyFocus();
    return open;
  };

  /** The player asked to close the panel: close it, return the focus to the trigger, tell the caller. */
  const dismiss = () => {
    closePanel();
    onClose?.();
    return false;
  };

  /** Keyboard parity: digits arm a good, Enter confirms it, Escape cancels and then closes. */
  const handleKey = (key) => {
    const value = String(key ?? '');
    if (value === CANCEL_KEY) {
      if (selected) { cancel(); return true; }
      if (open) { dismiss(); return true; }
      return false;
    }
    if (value === CONFIRM_KEY || value === ' ') { if (!selected) return false; buy(); return true; }
    if (/^[1-9]$/.test(value)) {
      const good = shop.goods[Number(value) - 1];
      if (!good || !good.can_buy) return false;
      select(good.id);
      return true;
    }
    return false;
  };

  return {
    update,
    model,
    view,
    paint,
    open: openPanel,
    close: closePanel,
    dismiss,
    isOpen: () => open,
    select,
    cancel,
    buy,
    handleKey,
    trigger: () => painted?.trigger || null,
  };
}
