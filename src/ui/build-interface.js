// Building and inventory interface — the build half: the hotbar and the placement preview.
//
// This module replaces the coordinate-first build forms with pointing, selecting and placing. It
// renders three things the shell can mount separately:
//
//   createHotbar            the palette actually available to *this* resident in *this* world
//   createPlacementPreview  pointer-driven selection of a tile and layer, with the server's own
//                           preview/validation, refusal explanations and the plot grant that applies
//   mount                   the only function that touches the DOM
//
// Design rules this file keeps, matching docs/GAME_EXPERIENCE.md §2 and docs/specs/panels.md:
//
//   * No palette, plot, grant, budget or palette label is invented here. Every value comes from a
//     server payload (`GET /world`, `POST /frontier/build` with `preview: true`, `GET /journey`).
//   * Nothing is written to the DOM with innerHTML. The view is a plain tree of text and elements and
//     `mount` sets text with `createTextNode`/`textContent` only.
//   * The component never imports `src/camera-controls.js` or `src/game-input.js`. The pointer/pick
//     source is injected as an `input` interface, and the camera, if any, is injected too.
//   * A rejected placement is rendered as a refusal and is never rendered as saved construction. Only
//     a server 2xx response becomes "saved".
//
// The view-tree shape (plain data, so it can be asserted without a browser):
//
//   { tag, class, id, attrs, value, checked, text, children: [tree|string], on: { event: handler } }
//
// `mount(root, tree, document)` is the single DOM boundary.

// ---------------------------------------------------------------------------------------------
// The refusal-reason table.
//
// The blueprint preview returns the server's own machine codes (`issues[].code`), and the single
// block path returns the server's own message with an HTTP status. This table turns either into a
// plain reason and a next usable step for the player. It never softens a refusal into something the
// server did not say: the server's message is always rendered verbatim beside the reason.
// ---------------------------------------------------------------------------------------------
export const REFUSAL_REASONS = Object.freeze({
  'out-of-range': Object.freeze({ reason: 'Out of range', next_step: 'Walk closer to the tile you are building on, then place again.' }),
  out_of_plot: Object.freeze({ reason: 'Out of plot', next_step: 'Build only inside a plot you steward, or ask its steward for a collaboration grant.' }),
  'no-grant': Object.freeze({ reason: 'No collaboration grant here', next_step: 'A signed-in human must steward this plot, or its steward must grant you a live collaboration on it.' }),
  'grant-expired': Object.freeze({ reason: 'Collaboration grant expired', next_step: 'Ask the plot’s steward to grant a fresh collaboration; the expired one cannot be extended.' }),
  'grant-scope': Object.freeze({ reason: 'Outside the collaboration grant', next_step: 'Use only the block types, layers and actions the grant names, or ask the steward for a wider grant.' }),
  budget: Object.freeze({ reason: 'Daily building budget spent', next_step: 'This operator has no frontier actions left today. Try again after 00:00 UTC.' }),
  'blocked-cell': Object.freeze({ reason: 'That cell is already built', next_step: 'Remove your own block first, or choose a clear cell.' }),
  resident: Object.freeze({ reason: 'A resident is standing there', next_step: 'Ask the resident to step aside, then place again.' }),
  'shared-access': Object.freeze({ reason: 'Protected shared passage', next_step: 'Keep roads, arrivals and gateway passages clear and choose ordinary ground.' }),
  trap: Object.freeze({ reason: 'Would strand a resident', next_step: 'Leave a walkable route to the public passages first.' }),
  'area-capacity': Object.freeze({ reason: 'Area block cap reached', next_step: 'This area holds its maximum blocks; remove some before adding more.' }),
  'blocked-tile': Object.freeze({ reason: 'Ground is not buildable', next_step: 'Choose clear, walkable ground without water, trees or scenery.' }),
  'unsupported-layer': Object.freeze({ reason: 'Unsupported layer', next_step: 'Stack a solid block directly below this layer first.' }),
  'blocked-doorway': Object.freeze({ reason: 'Doorway would be sealed', next_step: 'Move the structure so every entrance opens onto reachable ground.' }),
  'outside-area': Object.freeze({ reason: 'Outside the area', next_step: 'Move the footprint so it stays inside the 48 × 48 area.' }),
  'unknown-blueprint': Object.freeze({ reason: 'Unknown blueprint', next_step: 'Choose one of the listed construction blueprints.' }),
  'invalid-blueprint': Object.freeze({ reason: 'Palette not allowed', next_step: 'Use only the sealed frontier block types and layers.' }),
  paused: Object.freeze({ reason: 'Resident paused', next_step: 'Resume this resident before building.' }),
  'platform-paused': Object.freeze({ reason: 'World paused', next_step: 'The world is paused; building resumes when it is active again.' }),
  'not-signed-in': Object.freeze({ reason: 'Not signed in', next_step: 'Sign in as this resident’s operator to build.' }),
  'stale-world': Object.freeze({ reason: 'Stale area', next_step: 'Refresh the world: your resident has entered another area.' }),
  unknown: Object.freeze({ reason: 'Refused by the server', next_step: 'Read the server’s message and adjust the placement.' }),
});

// The server's own refusal messages, matched in order. Each maps to a code in the table above. The
// message is not replaced: it is shown in full alongside the reason and the next step.
const REFUSAL_MESSAGES = Object.freeze([
  [/:? *another area|Refresh the world/i, 'stale-world'],
  [/Walk closer|further than|build_range/i, 'out-of-range'],
  [/collaboration grant|grant lets you|granted scope|outside this collaboration/i, 'grant-scope'],
  [/assigned land plot|steward an available plot|steward’s grant|steward\u2019s grant/i, 'no-grant'],
  [/daily frontier action|actions left/i, 'budget'],
  [/daily expansion limit/i, 'budget'],
  [/block limit|area holds|has .* left; the blueprint needs/i, 'area-capacity'],
  [/occupied resident|resident is standing|Ask them to step aside/i, 'resident'],
  [/cut a resident off|cut off from|would cut/i, 'trap'],
  [/Keep the public passages and arrivals clear|shared access clear|shared-access|gateway passage|arrival area/i, 'shared-access'],
  [/doorway/i, 'blocked-doorway'],
  [/Remove the upper blocks first|Remove your existing block|Another builder|Legacy construction|belongs to another plot/i, 'blocked-cell'],
  [/solid block directly below|Stack a solid block|Layer \d/i, 'unsupported-layer'],
  [/not walkable|clear frontier tile|Choose a clear/i, 'blocked-tile'],
  [/paused/i, 'paused'],
  [/platform|world is paused|paused platform/i, 'platform-paused'],
  [/Sign in|Authenticate|authorized builder/i, 'not-signed-in'],
  [/palette|supported block|paths belong/i, 'invalid-blueprint'],
  [/48/i, 'outside-area'],
  [/blueprint/i, 'unknown-blueprint'],
]);

/**
 * Classify one refusal. Accepts an `Error` carrying the server's HTTP `status` and `message` (the
 * `api()` contract the shell uses), or a plain `{ status, message, code }`. Returns a frozen record:
 * the server's own message, a short reason, a next usable step, the machine code and the HTTP status.
 * `saved` is always false — a refusal never carries a placement.
 */
export function classifyRefusal(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const message = String(error?.message || '').trim();
  let code = typeof error?.code === 'string' && REFUSAL_REASONS[error.code] ? error.code : null;
  if (!code) for (const [pattern, candidate] of REFUSAL_MESSAGES) if (pattern.test(message)) { code = candidate; break; }
  if (!code && status === 403) code = 'no-grant';
  if (!code && status === 409) code = 'unknown';
  if (!code && status === 429) code = 'budget';
  if (!code) code = 'unknown';
  const entry = REFUSAL_REASONS[code] || REFUSAL_REASONS.unknown;
  return Object.freeze({ code, status, message, reason: entry.reason, next_step: entry.next_step, saved: false });
}

// ---------------------------------------------------------------------------------------------
// Server-payload readers. Each is a pure function of a `GET /world` payload; none of them knows a
// rule the server did not send.
// ---------------------------------------------------------------------------------------------

/** The building palette the server published for this world, or null when the world has none. */
export function paletteFor(world) {
  if (!world) return null;
  // The shell carries the world descriptor at `payload.world`; accept a bare descriptor too.
  const kind = world.world?.kind || world.kind;
  if (kind === 'frontier') {
    const frontier = world.frontier;
    if (!frontier || !Array.isArray(frontier.palette) || !frontier.palette.length) return null;
    return { kind: 'frontier', types: frontier.palette, maximum_z: frontier.limits?.maximum_z ?? 7, build_range: frontier.limits?.build_range ?? null, limits: frontier.limits || null };
  }
  if (['home', 'house'].includes(kind)) {
    const types = world.build_palette;
    if (!Array.isArray(types) || !types.length) return null;
    return { kind, types, maximum_z: 0, build_range: null, limits: null };
  }
  return null;
}

/** The server's own readable label for a palette type: its name, spaces instead of underscores. */
export const paletteLabel = (type) => {
  const words = String(type).replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(type);
};

/** The parcel the server reports at this tile, or null when the tile is in no plot. */
export function plotAt(parcels, pick) {
  if (!Array.isArray(parcels) || !pick || !Number.isInteger(pick.x) || !Number.isInteger(pick.y)) return null;
  return parcels.find((plot) => pick.x >= plot.x && pick.x < plot.x + plot.width && pick.y >= plot.y && pick.y < plot.y + plot.height) || null;
}

/**
 * The resident's own live grant *as a guest* covering one plot, from `frontier.grants.as_guest` (the
 * server's own bounded listing). Only `live` grants count for the grant path; an expired or revoked
 * one is still returned so the preview can explain that it existed and has ended. A grant in
 * `as_steward` is the resident's own plot and never narrows the palette: the steward keeps the full
 * palette, which `plot.is_mine` already decides.
 */
export function grantFor(grants, plotId) {
  if (!grants || !plotId) return null;
  const held = (grants.as_guest || []).filter((grant) => grant.plot_id === plotId);
  return held.find((grant) => grant.live === true) || held[0] || null;
}

/** The type of block at the target cell, read from the server's own block window, or null. */
export function blockAt(blocks, target) {
  if (!Array.isArray(blocks) || !target) return null;
  return blocks.find((block) => block.x === target.x && block.y === target.y && (block.z || 0) === (target.z || 0)) || null;
}

/**
 * The tile a pick acts on. Removing acts on the picked tile; placing acts on the picked tile's own
 * `adjacent` cell the way the shipped renderer already reports it (a face of a block, or the tile
 * itself for ground and scenery). This mirrors the shipped pick contract without importing it.
 */
export function targetOf(pick, mode = 'place') {
  if (!pick) return null;
  if (mode === 'remove') return { x: pick.x, y: pick.y, z: pick.z || 0 };
  const adjacent = pick.adjacent;
  if (adjacent && Number.isInteger(adjacent.x) && Number.isInteger(adjacent.y)) return { x: adjacent.x, y: adjacent.y, z: adjacent.z || 0 };
  return { x: pick.x, y: pick.y, z: pick.z || 0 };
}

// ---------------------------------------------------------------------------------------------
// The hotbar model: the palette actually available to this resident in this world.
// ---------------------------------------------------------------------------------------------
const frontierAvailability = (plot, grant, moderator) => {
  if (!plot) return { allowed: false, reason: 'no-grant', detail: 'Outside a plot' };
  if (plot.is_mine) return { allowed: true, reason: null, detail: null };
  if (grant && grant.live) return { allowed: true, reason: null, detail: grant };
  if (moderator) return { allowed: true, reason: null, detail: null };
  return { allowed: false, reason: 'no-grant', detail: plot };
};

/**
 * The hotbar as this resident actually sees it. `world` is the `GET /world` payload, `pick` the
 * injected pointer selection. The palette list always comes from the payload; only the per-entry
 * availability is computed, and only from server facts (the plot's `is_mine`, the caller's grants).
 */
export function hotbarModel({ world, pick = null, moderator = false } = {}) {
  const palette = paletteFor(world);
  if (!palette) {
    return Object.freeze({
      available: false, kind: world?.world?.kind || world?.kind || null, entries: Object.freeze([]), remove: Object.freeze({ available: false, reason: 'Not here' }),
      maximum_z: 0, plot: null, grant: null, reason: 'Building is not available in this world. Enter the frontier or your own garden.',
    });
  }
  const frontier = palette.kind === 'frontier';
  const plot = frontier ? plotAt(world.frontier?.parcels, pick) : null;
  const grant = frontier ? grantFor(world.frontier?.grants, plot?.id) : null;
  const availability = frontier ? frontierAvailability(plot, grant, moderator) : { allowed: true, reason: null, detail: null };
  const scope = grant?.live && grant.scope ? grant.scope : null;
  const entries = palette.types.map((type, index) => {
    let available = availability.allowed, reason = availability.reason ? REFUSAL_REASONS[availability.reason]?.reason || null : null;
    if (available && scope) {
      if (!scope.block_types.includes(type)) { available = false; reason = `Outside this grant (${scope.block_types.join(', ')})`; }
    }
    return Object.freeze({ type, label: paletteLabel(type), key: String(index + 1), available, reason });
  });
  let removeAvailable = availability.allowed;
  let removeReason = availability.reason ? REFUSAL_REASONS[availability.reason]?.reason || null : null;
  if (removeAvailable && scope && !scope.actions.includes('remove')) { removeAvailable = false; removeReason = 'This grant allows placement only'; }
  return Object.freeze({
    available: true, kind: palette.kind, entries: Object.freeze(entries),
    remove: Object.freeze({ available: removeAvailable, reason: removeReason }),
    maximum_z: palette.maximum_z, plot, grant,
    reason: availability.allowed ? null : 'No plot or collaboration grant here — you cannot build on this tile.',
  });
}

// ---------------------------------------------------------------------------------------------
// The placement model.
// ---------------------------------------------------------------------------------------------
const blueprintAnchorIssues = (report) => (report?.issues || []).map((issue) => Object.freeze({ code: issue.code, reason: REFUSAL_REASONS[issue.code]?.reason || issue.message, next_step: REFUSAL_REASONS[issue.code]?.next_step || null, message: issue.message, source: 'server-preview' }));

/**
 * The whole placement view as one model. Sources, stated explicitly:
 *   * A blueprint preview is the **server's own validation** (`POST /frontier/build preview: true`)
 *     and its `valid`, `issues`, `ownership`, `access` and `budgets` are rendered as returned.
 *   * A single-block preflight is assembled from the **server's observed payload only** — the plot's
 *     `is_mine`, the caller's grants, the parcel's own reservation. It never asserts a rule the
 *     server did not publish; where the server would still decide at write time the model says so.
 *   * `confirmed` is set only by a server 2xx response; `refusal` only by a server error.
 */
export function placementModel({ world, pick = null, session = {}, blueprintReport = null, refusal = null, confirmed = null, moderator = false } = {}) {
  const palette = paletteFor(world);
  const kind = session.kind || (palette?.kind === 'frontier' ? 'wood' : 'flowers');
  const mode = session.mode === 'remove' ? 'remove' : 'place';
  const target = pick ? targetOf(pick, mode) : null;
  const frontier = palette?.kind === 'frontier';
  const plot = frontier ? plotAt(world?.frontier?.parcels, target) : null;
  const grant = frontier ? grantFor(world?.frontier?.grants, plot?.id) : null;
  const existing = frontier ? blockAt(world?.blocks, target) : null;
  const asserts = [];

  // Plot and grant, from server facts only.
  let grantNotice = null;
  if (frontier && target) {
    if (grant && grant.live && grant.plot_id === plot?.id) {
      grantNotice = Object.freeze({ kind: 'grant', purpose: grant.purpose, permissions: grant.permissions, scope: grant.scope, expires_at: grant.expires_at, status: grant.status, plot_id: grant.plot_id });
    } else if (plot?.is_mine) {
      grantNotice = Object.freeze({ kind: 'own-plot', purpose: plot.purpose, plot_id: plot.id });
    } else if (plot) {
      grantNotice = Object.freeze({ kind: 'none', plot_id: plot.id, steward_name: plot.steward_name || null, state: plot.state, ended: grant && !grant.live ? grant.status : null });
      asserts.push(Object.freeze({ code: 'no-grant', reason: REFUSAL_REASONS['no-grant'].reason, next_step: REFUSAL_REASONS['no-grant'].next_step, message: plot.steward_name ? `This plot belongs to ${plot.steward_name} and you hold no live collaboration grant on it.` : 'This plot has no steward you hold a grant from.', source: 'world-payload' }));
    }
    if (grantNotice?.kind === 'none' && grant && !grant.live && grant.status === 'expired') {
      asserts.pop(); asserts.push(Object.freeze({ code: 'grant-expired', reason: REFUSAL_REASONS['grant-expired'].reason, next_step: REFUSAL_REASONS['grant-expired'].next_step, message: 'Your collaboration grant on this plot has expired.', source: 'world-payload' }));
    }
  }
  if (frontier && plot && plot.state === 'reserved' && !plot.is_mine) asserts.push(Object.freeze({ code: 'shared-access', reason: REFUSAL_REASONS['shared-access'].reason, next_step: REFUSAL_REASONS['shared-access'].next_step, message: plot.reserved_reason || 'This plot is reserved and cannot be built on.', source: 'world-payload' }));
  if (world?.paused) asserts.push(Object.freeze({ code: 'platform-paused', reason: REFUSAL_REASONS['platform-paused'].reason, next_step: REFUSAL_REASONS['platform-paused'].next_step, message: 'The world is paused.', source: 'world-payload' }));
  if (session.player && session.player.status && session.player.status !== 'active') asserts.push(Object.freeze({ code: 'paused', reason: REFUSAL_REASONS.paused.reason, next_step: REFUSAL_REASONS.paused.next_step, message: 'This resident is paused.', source: 'world-payload' }));

  // The server's own blueprint preview, when one was requested.
  if (blueprintReport) {
    for (const assert of blueprintAnchorIssues(blueprintReport)) asserts.push(assert);
  }

  const serverPreview = Boolean(blueprintReport);
  const permitted = serverPreview ? blueprintReport.valid === true : asserts.length ? false : null;
  const blocked = serverPreview ? blueprintReport.valid === false : asserts.length > 0;

  return Object.freeze({
    kind, mode, target, plot, grant, grantNotice, existing,
    palette_kind: palette?.kind || null,
    maximum_z: palette?.maximum_z ?? 0,
    blueprint: blueprintReport ? Object.freeze({ id: blueprintReport.blueprint?.id, name: blueprintReport.blueprint?.name, block_count: blueprintReport.block_count, new_blocks: blueprintReport.new_blocks, existing_blocks: blueprintReport.existing_blocks, replay: blueprintReport.replay, ownership: blueprintReport.ownership, access: blueprintReport.access, budgets: blueprintReport.budgets, footprint: blueprintReport.footprint }) : null,
    permitted, blocked, asserts: Object.freeze(asserts),
    source: serverPreview ? 'server-preview' : 'world-payload',
    refusal, saved: confirmed,
  });
}

// ---------------------------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------------------------
export const el = (tag, options = {}, children = []) => Object.freeze({ tag, ...options, children: (children || []).filter((child) => child !== null && child !== undefined && child !== false) });

/** A labelled, keyboard-reachable control: every action is a real button or field, never mouse-only. */
const button = (label, on, options = {}) => el('button', { class: options.class || 'small', attrs: { type: 'button', 'aria-label': options.label || label, ...(options.attrs || {}) }, on, text: label });

const hotbarView = (model, selected) => {
  const rows = [];
  rows.push(el('div', { class: 'game-hotbar-palette', attrs: { role: 'group', 'aria-label': 'Building palette available to this resident' } },
    model.entries.map((entry) => {
      const active = selected === entry.type;
      return el('button', {
        class: `game-hot ${active ? 'active' : ''}`.trim(),
        attrs: { type: 'button', 'data-build-type': entry.type, 'aria-label': `${entry.key}. ${entry.label}${entry.available ? '' : ` — unavailable: ${entry.reason}`}`, 'aria-pressed': String(active), ...(entry.available ? {} : { 'aria-disabled': 'true' }) },
        on: { click: () => entry.available && model.onSelect?.(entry.type) },
        text: `${entry.key} ${entry.label}`,
      });
    }),
  ));
  rows.push(button('Remove my block', () => model.onSelect?.('remove'), { class: `secondary small ${selected === 'remove' ? 'active' : ''}`.trim(), label: 'Remove a block or object you placed', attrs: { 'data-build-remove': '1', 'aria-pressed': String(selected === 'remove'), ...(model.remove.available ? {} : { 'aria-disabled': 'true' }) } }));
  const notes = [];
  if (!model.available) notes.push(el('p', { class: 'privacy', text: model.reason }));
  else if (selected && model.entries.some((entry) => entry.type === selected && !entry.available)) notes.push(el('p', { class: 'privacy', text: `${paletteLabel(selected)}: ${model.entries.find((entry) => entry.type === selected)?.reason}` }));
  else if (selected === 'remove' && !model.remove.available) notes.push(el('p', { class: 'privacy', text: `Removal: ${model.remove.reason}` }));
  else if (model.reason) notes.push(el('p', { class: 'privacy', text: model.reason }));
  return el('section', { class: 'ui-hotbar', attrs: { 'aria-label': 'Building hotbar' } }, [...rows, ...notes]);
};

const grantView = (notice) => {
  if (!notice) return null;
  if (notice.kind === 'grant') {
    const scope = notice.scope || {};
    return el('div', { class: 'ui-grant ui-grant-live', attrs: { 'data-grant': 'live', role: 'note' } }, [
      el('strong', { text: 'You may build here under a collaboration grant' }),
      el('p', { class: 'privacy', text: `Purpose: ${notice.purpose}. ${notice.permissions}` }),
      el('p', { class: 'privacy', text: `Scope: ${(scope.block_types || []).join(', ') || '—'} on ${(scope.layers || []).join(' and ')}; up to ${scope.max_blocks} standing blocks. Expires ${notice.expires_at}.` }),
    ]);
  }
  if (notice.kind === 'own-plot') {
    return el('div', { class: 'ui-grant ui-grant-own', attrs: { 'data-grant': 'own', role: 'note' } }, [
      el('strong', { text: 'This is your stewarded plot' }),
      el('p', { class: 'privacy', text: `Purpose: ${notice.purpose}. You may build here with the full palette.` }),
    ]);
  }
  const ended = notice.ended ? ` Your ${notice.ended} grant has ended.` : '';
  return el('div', { class: 'ui-grant ui-grant-none', attrs: { 'data-grant': 'none', role: 'note' } }, [
    el('strong', { text: 'You may not build here' }),
    el('p', { class: 'privacy', text: `${notice.steward_name ? `This plot belongs to ${notice.steward_name}` : 'This plot has no steward'} and you hold no live collaboration grant on it.${ended}` }),
  ]);
};

const placementReportView = (model) => {
  const nodes = [];
  const target = model.target;
  if (!target) nodes.push(el('p', { class: 'privacy', attrs: { 'data-placement': 'empty' }, text: 'Point at a tile to choose a build target. The text fields below are the keyboard path.' }));
  else nodes.push(el('p', { class: 'ui-target', attrs: { 'data-placement': 'target' }, text: `Target tile ${target.x}, ${target.y}${model.maximum_z > 0 ? `, layer ${target.z}` : ''}` }));

  const grant = grantView(model.grantNotice);
  if (grant) nodes.push(grant);

  if (model.blueprint) {
    const report = model.blueprint;
    nodes.push(el('strong', { attrs: { 'data-placement': 'blueprint' }, text: `${report.name} · ${report.block_count} blocks` }));
    nodes.push(el('p', { class: 'privacy', text: `${report.new_blocks ?? 0} new blocks, ${report.existing_blocks ?? 0} already yours.${report.replay ? ' Every layer already stands here: applying again changes nothing.' : ''}` }));
    if (report.budgets) nodes.push(el('p', { class: 'privacy', text: `${report.budgets.actions_remaining} of ${report.budgets.actions_per_operator_day} daily building actions remain; ${report.budgets.blocks_remaining} of ${report.budgets.blocks_per_sector} blocks remain in this area.` }));
    if (report.access?.doorways) nodes.push(el('p', { class: 'privacy', text: report.access.doorways.map((doorway) => `Doorway ${doorway.x}, ${doorway.y}: ${doorway.clear ? 'opens onto walkable ground' : 'would be sealed'}`).join('; ') }));
  }

  for (const assert of model.asserts) {
    nodes.push(el('p', { class: `ui-assert ${assert.code === 'no-grant' ? 'ui-assert-refusal' : ''}`.trim(), attrs: { 'data-assert': assert.code, 'data-source': assert.source }, text: `${assert.reason}: ${assert.message}` }));
  }
  if (model.permitted === true && model.source === 'server-preview') nodes.push(el('p', { attrs: { 'data-placement': 'permitted' }, text: 'The server reports this placement as valid. Nothing is built until you confirm.' }));
  else if (model.permitted === null && !model.asserts.length) nodes.push(el('p', { class: 'privacy', attrs: { 'data-placement': 'unvalidated' }, text: 'The server decides the final placement when you confirm; preview a blueprint for the server’s own validation first.' }));

  if (model.refusal) nodes.push(el('div', { class: 'ui-refusal', attrs: { 'data-refusal': model.refusal.code, role: 'alert' } }, [
    el('strong', { text: `Refused: ${model.refusal.reason}` }),
    el('p', { text: model.refusal.message }),
    el('p', { class: 'privacy', text: `Next step: ${model.refusal.next_step}` }),
  ]));
  if (model.saved) {
    const saved = model.saved;
    nodes.push(el('div', { class: 'ui-saved', attrs: { 'data-saved': '1', role: 'status' } }, [
      el('strong', { text: saved.blueprint ? `${saved.blueprint.name} saved` : saved.removed ? 'Block removed' : `${paletteLabel(saved.type || 'block')} saved` }),
      el('p', { class: 'privacy', text: saved.replay ? 'The server reports nothing changed.' : saved.blueprint ? `${saved.new_blocks} blocks were confirmed by the server.` : `The server confirmed the change at ${saved.x}, ${saved.y}${saved.z ? `, layer ${saved.z}` : ''}.` }),
    ]));
  } else if (!model.refusal && model.target) {
    nodes.push(el('p', { class: 'privacy', attrs: { 'data-saved': 'pending' }, text: 'Not saved yet — a placement counts only once the server confirms it.' }));
  }
  return el('div', { class: 'ui-placement-report', attrs: { role: 'status', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Placement preview: permitted or blocked, plot grant, and validation' } }, nodes);
};

// ---------------------------------------------------------------------------------------------
// Components.
// ---------------------------------------------------------------------------------------------

/**
 * The hotbar. `update({ world, pick, moderator })` re-reads the server's palette; digits and `0`
 * choose a block (keyboard parity), and every entry is also a labelled button.
 */
export function createHotbar({ onSelect, input, initial = null } = {}) {
  let state = { world: null, pick: null, moderator: false };
  let selected = initial;
  let unsubscribe = null;
  // The pick source is injected (the shell's camera/input layer), never imported. When the shell
  // hands this component an `input` with `subscribe`, a new pick repaints its availability.
  if (input && typeof input.subscribe === 'function') unsubscribe = input.subscribe((pick) => { state.pick = pick; });
  const emit = () => onSelect?.(selected);
  return {
    dispose() { unsubscribe?.(); unsubscribe = null; },
    update(patch = {}) {
      state = { ...state, ...patch };
      const model = hotbarModel(state);
      const types = model.entries.map((entry) => entry.type);
      if (selected !== 'remove' && !types.includes(selected)) selected = model.entries.find((entry) => entry.available)?.type || model.entries[0]?.type || null;
      return model;
    },
    select(type) {
      if (type !== 'remove' && !hotbarModel(state).entries.some((entry) => entry.type === type)) return false;
      selected = type; emit(); return true;
    },
    selected: () => selected,
    model: () => hotbarModel(state),
    /** Keyboard parity: the digits select a block, `0` selects removal. Returns true when consumed. */
    handleKey(key) {
      const value = String(key);
      if (value === '0') { if (hotbarModel(state).remove.available) { selected = 'remove'; emit(); return true; } return false; }
      if (!/^[1-9]$/.test(value)) return false;
      const entry = hotbarModel(state).entries[Number(value) - 1];
      if (!entry) return false;
      selected = entry.available ? entry.type : selected; emit(); return true;
    },
    view() {
      const model = hotbarModel(state);
      return hotbarView({ ...model, onSelect: (type) => { if (type === 'remove' ? model.remove.available : model.entries.find((entry) => entry.type === type)?.available) { selected = type; emit(); } } }, selected);
    },
  };
}

/**
 * The placement preview. It consumes the shell's pick through the injected `input` interface (never
 * importing the camera or input modules), asks the server for the blueprint's own validation, and
 * renders permitted/blocked/refused. `api(path, method, body)` is the shell's own server client.
 */
export function createPlacementPreview({ api, input, onNotice, session = {} } = {}) {
  let state = { world: null, pick: null, session: { ...session }, moderator: false };
  let mode = 'place', kind = null, blueprint = null, report = null, refusal = null, saved = null;
  let manualAnchor = null;
  let unsubscribe = null;

  const reset = () => { report = null; refusal = null; saved = null; };
  const context = () => ({ agentId: state.session.agentId, worldId: state.session.worldId, player: state.session.player });
  const anchor = () => manualAnchor || state.pick;
  // The pick source is injected (the shell's camera/input layer), never imported.
  if (input && typeof input.subscribe === 'function') unsubscribe = input.subscribe((pick) => { state.pick = pick; reset(); });

  const model = () => placementModel({ ...state, session: { ...state.session, kind, mode }, blueprintReport: report, refusal, confirmed: saved, moderator: state.moderator });

  const place = async () => {
    const { agentId, worldId, player } = context();
    if (!api) { refusal = Object.freeze({ code: 'not-signed-in', status: null, message: 'No server client is connected.', reason: REFUSAL_REASONS['not-signed-in'].reason, next_step: REFUSAL_REASONS['not-signed-in'].next_step, saved: false }); return null; }
    if (!player || !agentId) { refusal = Object.freeze({ code: 'not-signed-in', status: null, message: 'Play as a resident in this world before building.', reason: REFUSAL_REASONS['not-signed-in'].reason, next_step: REFUSAL_REASONS['not-signed-in'].next_step, saved: false }); return null; }
    const point = anchor();
    if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y)) { refusal = Object.freeze({ code: 'blocked-tile', status: null, message: 'Choose a target tile first.', reason: 'No target tile', next_step: 'Point at a tile, or type its X and Y below.', saved: false }); return null; }
    try {
      saved = null;
      const body = blueprint
        ? { agent_id: agentId, world_id: worldId, blueprint, x: point.x, y: point.y, ...(mode === 'remove' ? { remove: true } : {}) }
        : { agent_id: agentId, world_id: worldId, x: point.x, y: point.y, z: point.z || 0, ...(mode === 'remove' ? { remove: true } : { type: kind || undefined }) };
      const result = await api('/frontier/build', 'POST', body);
      refusal = null; report = null; saved = Object.freeze(result); onNotice?.(result.replay ? 'The server reports nothing changed.' : 'Placement confirmed by the server.'); return { ok: true, result };
    } catch (error) { saved = null; refusal = classifyRefusal(error); onNotice?.(refusal.message); return { ok: false, refusal };
    }
  };

  const previewBlueprint = async () => {
    const { agentId, worldId, player } = context();
    if (!api || !player || !agentId || !blueprint) return null;
    const point = anchor();
    if (!point) return null;
    try {
      report = await api('/frontier/build', 'POST', { agent_id: agentId, world_id: worldId, blueprint, x: point.x, y: point.y, preview: true });
      refusal = null; saved = null; onNotice?.('Preview only — nothing was built.'); return report;
    } catch (error) { report = null; refusal = classifyRefusal(error); return null; }
  };

  const fields = () => el('div', { class: 'ui-placement-fields' }, [
    el('label', { class: 'full' }, [el('span', { text: 'Build target' }),
      el('input', { attrs: { type: 'number', min: '0', max: '47', name: 'x', 'aria-label': 'Target tile X', value: String((anchor() || {}).x ?? '') }, on: { change: (event) => { manualAnchor = { ...(manualAnchor || anchor() || {}), x: Number(event.target.value) }; } } })]),
    el('label', { class: 'full' }, [el('span', { text: 'Target Y' }),
      el('input', { attrs: { type: 'number', min: '0', max: '47', name: 'y', 'aria-label': 'Target tile Y', value: String((anchor() || {}).y ?? '') }, on: { change: (event) => { manualAnchor = { ...(manualAnchor || anchor() || {}), y: Number(event.target.value) }; } } })]),
    mode === 'place' && model().maximum_z > 0 ? el('label', { class: 'full' }, [el('span', { text: 'Layer' }),
      el('input', { attrs: { type: 'number', min: '0', max: String(model().maximum_z), name: 'z', 'aria-label': 'Block layer', value: String((anchor() || {}).z ?? '0') }, on: { change: (event) => { manualAnchor = { ...(manualAnchor || anchor() || {}), z: Number(event.target.value) }; } } })]) : null,
  ]);

  const controls = () => {
    const list = [];
    if (blueprint) list.push(button('Preview blueprint', previewBlueprint, { class: 'secondary small', label: 'Ask the server to validate this blueprint without building it', attrs: { 'data-preview': '1' } }));
    list.push(button(mode === 'remove' ? 'Remove the block here' : 'Place the block here', place, { class: 'small', label: mode === 'remove' ? 'Ask the server to remove your block at this tile' : 'Ask the server to place the selected block at this tile', attrs: { 'data-confirm': mode } }));
    return el('div', { class: 'ui-placement-controls' }, list);
  };

  return {
    update(patch = {}) { state = { ...state, ...patch }; return model(); },
    setKind(value) { kind = value; mode = value === 'remove' ? 'remove' : 'place'; blueprint = null; manualAnchor = null; reset(); },
    setBlueprint(id) { blueprint = id || null; manualAnchor = null; reset(); },
    setMode(value) { mode = value === 'remove' ? 'remove' : 'place'; reset(); },
    previewBlueprint, confirm: place, reset,
    refresh() { return model(); },
    /** Keyboard parity: `b` previews a blueprint, `c` confirms, `r` switches to remove, Escape clears. */
    handleKey(key) {
      if (key === 'b' && blueprint) { previewBlueprint(); return true; }
      if (key === 'c') { place(); return true; }
      if (key === 'r') { mode = mode === 'remove' ? 'place' : 'remove'; reset(); return true; }
      if (key === 'Escape') { reset(); manualAnchor = null; return true; }
      return false;
    },
    dispose() { unsubscribe?.(); unsubscribe = null; },
    view() {
      const m = model();
      return el('section', { class: 'ui-placement', attrs: { 'aria-label': 'Placement preview' } }, [
        el('h2', { text: 'Place at the tile you point at' }),
        placementReportView(m),
        fields(),
        controls(),
        el('p', { class: 'privacy', text: 'Every placement is validated by the server. A refusal never builds anything; only a confirmed response is saved.' }),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The DOM boundary. The only function that touches a real document.
// ---------------------------------------------------------------------------------------------
export function mount(root, tree, document = globalThis.document) {
  if (!root) throw new Error('mount needs a container element.');
  if (!document || typeof document.createElement !== 'function') throw new Error('mount needs a DOM document.');
  root.replaceChildren(renderNode(tree, document));
  return root;
}

function renderNode(node, document) {
  if (node === null || node === undefined || node === false) return document.createTextNode('');
  if (typeof node === 'string') return document.createTextNode(node);
  if (typeof node.text === 'string' && !node.tag) return document.createTextNode(node.text);
  const element = document.createElement(node.tag || 'div');
  if (node.class) element.setAttribute('class', node.class);
  if (node.id) element.setAttribute('id', node.id);
  for (const [key, value] of Object.entries(node.attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    element.setAttribute(key, value === true ? '' : String(value));
  }
  if (node.value !== undefined) element.value = node.value;
  for (const [event, handler] of Object.entries(node.on || {})) element.addEventListener(event, handler);
  for (const child of node.children || []) element.append(renderNode(child, document));
  if (typeof node.text === 'string') element.append(document.createTextNode(node.text));
  return element;
}
