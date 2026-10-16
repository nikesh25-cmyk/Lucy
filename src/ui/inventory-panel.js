// Building and inventory interface — the inventory half.
//
// One dismissible panel over `GET /journey` (and, when the shell provides it, `GET /journey/offers`):
// the resident's real shelf, its growing and ready crops, and the sealed recipes with what can
// actually be crafted now and exactly which ingredients are missing.
//
// Two rules this file keeps:
//
//   * **Coins are not items.** A NemoCoin is an independently accepted contribution credit, not a
//     thing on the shelf, so no coin value is ever rendered in the item lists (docs/GAME_EXPERIENCE.md
//     §5.3, docs/COINS.md). The model in this file has no coin field at all.
//   * **Nothing is invented.** The shelf, crops, recipes and offers are the server's own payload; a
//     craft writes only through `POST /journey/craft` and shows only the server's own confirmation.
//
// The view is the same plain tree `src/ui/build-interface.js` uses, and `mount` from that module is
// the only function that touches the DOM.
import { el, mount } from './build-interface.js';

const button = (label, on, options = {}) => el('button', { class: options.class || 'small', attrs: { type: 'button', 'aria-label': options.label || label, ...(options.attrs || {}) }, on, text: label });

/** A readable label for a resource kind. */
export const kindLabel = (kind) => {
  const words = String(kind).replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(kind);
};

/**
 * What one recipe needs and whether the resident can craft it now. `held` is a Map of kind →
 * quantity from the server's `inventory`. Missing ingredients are stated individually.
 */
export function recipeAvailability(recipe, held) {
  const have = (kind) => (held instanceof Map ? held.get(kind) : held?.[kind]) || 0;
  const ingredients = Object.entries(recipe?.ingredients || {}).map(([kind, need]) => Object.freeze({ kind, label: kindLabel(kind), need, have: have(kind), enough: have(kind) >= need }));
  const missing = ingredients.filter((item) => !item.enough);
  return Object.freeze({ craftable: missing.length === 0, ingredients: Object.freeze(ingredients), missing: Object.freeze(missing) });
}

/**
 * The inventory model. `journey` is the `GET /journey` payload; `offers` is optional and is the
 * `GET /journey/offers` payload. Coins are deliberately absent: they are contribution credits, not
 * items, and the panel does not render a coin value at all.
 */
export function inventoryModel({ journey = null, offers = null } = {}) {
  if (!journey) return Object.freeze({ ready: false, shelf: Object.freeze([]), growing: Object.freeze([]), ready: Object.freeze([]), recipes: Object.freeze([]), offers: Object.freeze([]), note: 'Play as a resident to see your inventory.' });
  const inventory = Array.isArray(journey.inventory) ? journey.inventory : [];
  // The shelf is the server's own list. Every kind with a positive quantity is an item; a non-item
  // record (were one ever added) is still just an entry, and no coin field is read here at all.
  const shelf = inventory.filter((item) => Number.isInteger(item?.quantity) && item.quantity > 0).map((item) => Object.freeze({ kind: item.kind, label: kindLabel(item.kind), quantity: item.quantity }));
  const held = new Map(shelf.map((item) => [item.kind, item.quantity]));
  const crops = Array.isArray(journey.crops) ? journey.crops : [];
  const cropRow = (crop) => Object.freeze({ x: crop.x, y: crop.y, kind: crop.kind, label: kindLabel(crop.kind), ready_at: crop.ready_at, ready: crop.ready === true, harvested: crop.harvested_at != null });
  const growing = crops.filter((crop) => crop.harvested_at == null && crop.ready !== true).map(cropRow);
  const ready = crops.filter((crop) => crop.harvested_at == null && crop.ready === true).map(cropRow);
  const recipes = (Array.isArray(journey.recipes) ? journey.recipes : []).map((recipe) => {
    const availability = recipeAvailability(recipe, held);
    return Object.freeze({ id: recipe.id, name: recipe.name, output: recipe.output, output_label: kindLabel(recipe.output), ingredients: availability.ingredients, missing: availability.missing, craftable: availability.craftable });
  });
  const offerRows = (Array.isArray(offers?.offers) ? offers.offers : []).map((offer) => Object.freeze({ id: offer.id, status: offer.status, direction: offer.direction, note: offer.note, items: Object.freeze(Object.entries(offer.items || {}).map(([kind, quantity]) => Object.freeze({ kind, label: kindLabel(kind), quantity }))), other: offer.direction === 'outgoing' ? offer.recipient?.name : offer.offerer?.name, expires_at: offer.expires_at, can_accept: offer.can_accept === true, can_decline: offer.can_decline === true, can_cancel: offer.can_cancel === true }));
  return Object.freeze({
    ready: true, shelf: Object.freeze(shelf), growing: Object.freeze(growing), ready_crops: Object.freeze(ready), recipes: Object.freeze(recipes), offers: Object.freeze(offerRows),
    note: 'NemoCoins are contribution credits, not items, and never appear on this shelf.',
  });
}

const shelfView = (model) => el('div', { class: 'ui-shelf', attrs: { role: 'group', 'aria-label': 'Resources on the shelf' } },
  model.shelf.length
    ? model.shelf.map((item) => el('span', { class: 'ui-shelf-item', attrs: { 'data-item': item.kind }, text: `${item.label} × ${item.quantity}` }))
    : [el('p', { class: 'privacy', text: 'The shelf is empty. Harvest a crop or craft a keepsake to fill it.' })]);

const cropsView = (model) => el('div', { class: 'ui-crops' }, [
  el('strong', { text: 'Growing and ready crops' }),
  model.growing.length || model.ready_crops.length
    ? el('ul', {}, [...model.ready_crops, ...model.growing].map((crop) => el('li', { attrs: { 'data-crop': `${crop.x},${crop.y}` }, text: `${crop.label} at ${crop.x}, ${crop.y} — ${crop.ready ? 'ready to harvest' : 'growing'}` })))
    : el('p', { class: 'privacy', text: 'No crops are planted. Plant one on a farm tile in your garden.' }),
]);

const recipesView = (model, onCraft, selected) => el('div', { class: 'ui-recipes' }, [
  el('strong', { text: 'Sealed recipes' }),
  ...model.recipes.map((recipe, index) => {
    const active = selected === recipe.id;
    const detail = recipe.ingredients.map((item) => `${item.label} ${item.have}/${item.need}`).join(', ');
    return el('div', { class: `ui-recipe ${active ? 'active' : ''}`.trim(), attrs: { 'data-recipe': recipe.id, 'data-craftable': String(recipe.craftable) } }, [
      el('p', { text: `${index + 1}. ${recipe.name} → ${recipe.output_label}` }),
      el('p', { class: 'privacy', text: recipe.craftable ? `Ingredients held: ${detail}.` : `Missing: ${recipe.missing.map((item) => `${item.label} (need ${item.need - item.have} more)`).join(', ')}. Held: ${detail}.` }),
      button(recipe.craftable ? `Craft ${recipe.name}` : `${recipe.name} — missing ingredients`, () => onCraft?.(recipe), { class: 'secondary small', label: recipe.craftable ? `Craft ${recipe.name}` : `${recipe.name} cannot be crafted yet`, attrs: { 'data-craft': recipe.id, ...(recipe.craftable ? {} : { 'aria-disabled': 'true' }) } }),
    ]);
  }),
]);

const offersView = (model, handlers) => el('div', { class: 'ui-offers' }, [
  el('strong', { text: 'Resource offers' }),
  model.offers.length
    ? el('ul', {}, model.offers.map((offer) => el('li', { attrs: { 'data-offer': offer.id, 'data-status': offer.status } }, [
      el('span', { text: `${offer.direction === 'outgoing' ? 'To' : 'From'} ${offer.other || 'a resident'} · ${offer.status} · ${offer.items.map((item) => `${item.label} × ${item.quantity}`).join(', ')}` }),
      offer.can_accept ? button('Accept', () => handlers?.accept?.(offer), { class: 'small' }) : null,
      offer.can_decline ? button('Decline', () => handlers?.decline?.(offer), { class: 'secondary small' }) : null,
      offer.can_cancel ? button('Cancel', () => handlers?.cancel?.(offer), { class: 'secondary small' }) : null,
    ])))
    : el('p', { class: 'privacy', text: 'No offers are open. Offers move grown or crafted items between residents, never coins or land.' }),
]);

/**
 * The inventory panel. `api(path, method, body, idempotent, key)` is the shell's own server client.
 * Every action is a labelled button so the panel is fully keyboard-operable; the digits select a
 * recipe and Enter (or `c`) crafts it.
 */
export function createInventoryPanel({ api, onNotice, idempotencyKey } = {}) {
  let model = inventoryModel({});
  let selected = null;
  let status = null; // { kind: 'saved' | 'refused', text, code }

  const key = () => (typeof idempotencyKey === 'function' ? idempotencyKey() : (globalThis.crypto?.randomUUID?.() || `key-${Date.now()}`));
  const agentId = () => model.agentId;

  const craft = async (recipe) => {
    const id = model.agentId;
    if (!api || !id) { status = { kind: 'refused', code: 'not-signed-in', text: 'Play as a resident before crafting.' }; return null; }
    if (recipe && recipe.craftable === false) { status = { kind: 'refused', code: 'missing', text: `${recipe.name} is missing ingredients.` }; return null; }
    const recipeId = recipe?.id || selected;
    if (!recipeId) return null;
    try {
      const result = await api('/journey/craft', 'POST', { agent_id: id, recipe_id: recipeId });
      status = { kind: 'saved', text: `The server crafted ${kindLabel(result.crafted)}.`, code: null };
      // The server returned the new shelf; take it as the truth rather than guessing.
      model = Object.freeze({ ...model, shelf: Object.freeze((result.inventory || []).map((item) => Object.freeze({ kind: item.kind, label: kindLabel(item.kind), quantity: item.quantity }))) });
      onNotice?.(status.text);
      return result;
    } catch (error) {
      const classified = classify(error);
      status = { kind: 'refused', code: classified.code, text: `${classified.reason}: ${error.message}` };
      onNotice?.(error.message);
      return null;
    }
  };

  const offerAction = async (route, offer, verb) => {
    if (!api) return null;
    try {
      const result = await api(`/journey/offers/${route}`, 'POST', { offer_id: offer.id }, true, key());
      status = { kind: 'saved', text: `The server recorded the offer as ${result.status}.`, code: null };
      onNotice?.(status.text);
      return result;
    } catch (error) { const classified = classify(error); status = { kind: 'refused', code: classified.code, text: `${classified.reason}: ${error.message}` }; onNotice?.(error.message); return null; }
  };

  return {
    /** `update({ journey, offers })` ingests the shell's server payloads. */
    update({ journey = null, offers = null, agentId: id = null } = {}) {
      model = Object.freeze({ ...inventoryModel({ journey, offers }), agentId: id ?? model.agentId ?? journey?.agent_id ?? null });
      return model;
    },
    model: () => model,
    selected: () => selected,
    craft,
    view() {
      const selectedRecipe = model.recipes.find((recipe) => recipe.id === selected);
      return el('section', { class: 'ui-inventory', attrs: { 'aria-label': 'Inventory and crafting' } }, [
        el('h2', { text: 'Inventory and crafting' }),
        el('div', { class: 'ui-shelf-wrap' }, [el('strong', { text: 'On the shelf' }), shelfView(model)]),
        cropsView(model),
        recipesView(model, craft, selected),
        offersView(model, { accept: (offer) => offerAction('accept', offer), decline: (offer) => offerAction('decline', offer), cancel: (offer) => offerAction('cancel', offer) }),
        status ? el('div', { class: status.kind === 'refused' ? 'ui-refusal' : 'ui-saved', attrs: { role: status.kind === 'refused' ? 'alert' : 'status', 'data-inventory-status': status.kind }, text: status.text }) : null,
        el('p', { class: 'privacy', text: model.note }),
        selectedRecipe ? el('p', { class: 'privacy', text: `Selected: ${selectedRecipe.name}. Press c or Enter on its button to craft.` }) : null,
      ]);
    },
    /** Keyboard parity: digits select a recipe, `c` crafts it. Returns true when the key was consumed. */
    handleKey(key) {
      const value = String(key);
      if (/^[1-9]$/.test(value)) { const recipe = model.recipes[Number(value) - 1]; if (!recipe) return false; selected = recipe.id; return true; }
      if (value === 'c' || value === 'Enter') { if (!selected) return false; const recipe = model.recipes.find((item) => item.id === selected); if (!recipe) return false; craft(recipe); return true; }
      return false;
    },
  };
}

// A local, presentation-only classification of a server refusal. The server's own message is always
// the text the panel shows; only the short reason is derived here.
function classify(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const message = String(error?.message || '');
  if (status === 409 && /ingredients/i.test(message)) return { code: 'missing', reason: 'Missing ingredients' };
  if (status === 403) return { code: 'not-active', reason: 'Not available' };
  if (status === 429) return { code: 'budget', reason: 'Rate limited' };
  return { code: 'refused', reason: 'Refused by the server' };
}

export { mount };
