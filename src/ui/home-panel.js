// The home panel — an operator's AI residents' private vaults and the two visiting switches of their
// garden and cottage, in one place.
//
// Four rules this file keeps.
//
//   * **Presentation and intent only.** The panel decides no privacy fact, assumes no switch moved and
//     assumes no vault was erased. It renders what the server last said and hands the player's
//     *chosen* change to the caller as `onVisibility(agentId, patch)` or, after a separate confirm,
//     `onErase(agentId)`. Whether either happened is the server's own answer, which arrives as the next
//     `update`: the new state, or the server's refusal wording, shown verbatim.
//   * **The operator never sees a note.** The only vault fields this file reads are the ones the
//     operator route (`GET /vault` for a signed-in session) sends: whether a vault exists, its key
//     model, its note count and byte count, its limits and the server's own privacy statement.
//     `vaultModel` copies exactly those fields and nothing else, so even a payload that carried note
//     text, a slot map or a key check could not reach the page. The statement of who can read a vault is
//     the server's `VAULT_POLICY` text, shown as sent; this file adds no privacy claim of its own.
//   * **Two independent switches.** The garden and the cottage each have their own switch. Closing the
//     garden also closes the cottage; opening the garden does not open the cottage. The panel says so in
//     words next to the switches, and it sends only the one field the player changed (`visibility` for
//     the garden, `house_visibility` for the cottage), leaving the server to apply its own rule.
//   * **No state is carried by colour or hover, and server text is text.** Every state is written out,
//     every control is a real `<button>` (the switches carry `role="switch"` and `aria-checked`), and
//     every string from the server goes through a DOM text node built by `src/ui/build-interface.js`.
//     This file never parses or assigns markup, and the panel never traps focus.
import { el, mount } from './build-interface.js';

/** The project's target minimum (nemo-theme.css, measured at 44 px in game-mobile.css). */
export const TOUCH_TARGET_MIN = 44;
/** Set on the panel while the reader asks for reduced motion, so a stylesheet can suppress transitions. */
export const REDUCED_MOTION_CLASS = 'ui-home-reduced';
/** Enter (or Space) is a native button press; Escape cancels an armed erase. */
export const CANCEL_KEY = 'Escape';
/** The one rule about the two switches, in the words every surface uses. */
export const SWITCH_RULE = 'The garden and the cottage each have their own switch. Closing the garden also closes the cottage. Opening the garden does not open the cottage; open the cottage with its own switch.';
export const VISITOR_NOTE = 'Closing a space sends anyone visiting it back to the Commons. You and your resident can always go in.';
export const ERASE_WARNING = 'Erasing deletes every note and the key that opens them. It cannot be undone, and nothing is recoverable afterwards.';
export const NO_VAULT_SENTENCE = 'This resident has no vault yet. One is created when the resident first writes a note or chooses how its key is held.';
export const OPERATOR_SIGHT = 'From here you can see only whether a vault exists, how its key is held and how many notes it holds. You cannot read, write or search a note.';
/** What the key model is called on the page; the server states only `sealed` or `agent`. */
export const MODE_LABELS = Object.freeze({ sealed: 'Sealed by the server', agent: 'Held by the resident' });

const numberOr = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const textOr = (value) => (typeof value === 'string' && value.trim() ? value : null);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** `1,234 bytes`, `2.5 KiB`: the counts the operator route sends, spelled for a person. */
export function bytesText(bytes) {
  const number = numberOr(bytes);
  if (number === null) return 'a size the server did not state';
  if (number < 1024) return plural(number, 'byte');
  return `${(number / 1024).toFixed(number < 10240 ? 1 : 0)} KiB`;
}

/** A server timestamp a person can read: an ISO instant in local time, anything else as it arrived. */
export function formatTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return text;
  const pad = (part) => String(part).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `prefers-reduced-motion`, read through an injected matchMedia so it can be tested. */
export function prefersReducedMotion(match) {
  if (typeof match !== 'function') return false;
  try { return Boolean(match('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
}

/**
 * The operator's view of one vault, from `GET /vault?agent_id=…` answered to a signed-in session.
 * Only counts and the server's own statement survive: there is deliberately no field for a note, a
 * slot map or a key check, so none can be drawn.
 */
export function vaultModel(status = null) {
  if (!status || typeof status !== 'object') return Object.freeze({ ready: false, enrolled: false, mode: null, mode_label: '', notes: 0, bytes: 0, updated_at: null, slots: null, note_bytes_total: null, policy: null });
  const mode = status.enrolled && (status.mode === 'sealed' || status.mode === 'agent') ? status.mode : null;
  const policy = status.policy && typeof status.policy === 'object' ? status.policy : {};
  return Object.freeze({
    ready: true,
    enrolled: Boolean(status.enrolled),
    mode,
    mode_label: mode ? MODE_LABELS[mode] : '',
    notes: numberOr(status.notes) ?? 0,
    bytes: numberOr(status.bytes) ?? 0,
    updated_at: textOr(status.updated_at),
    slots: numberOr(status.limits?.slots),
    total_bytes: numberOr(status.limits?.total_bytes),
    policy: Object.freeze({
      summary: textOr(policy.summary),
      sealed: textOr(policy.sealed),
      agent: textOr(policy.agent),
      effect: textOr(policy.effect),
    }),
  });
}

/** One space (a garden or a cottage) as the world read states it. Unknown is never read as open. */
export function spaceModel(world = null) {
  const visibility = world?.visibility === 'public' || world?.visibility === 'private' ? world.visibility : null;
  return Object.freeze({ id: textOr(world?.id), name: textOr(world?.name), visibility, known: visibility !== null, open: visibility === 'public' });
}

/** The sentence that says, for the state the server reported, who can visit. */
export function visitingSentence(space, noun) {
  if (!space.known) return `The server has not said who can visit the ${noun}.`;
  return space.open ? `The ${noun} is open: anyone can visit it.` : `The ${noun} is closed: only your account and this resident can enter.`;
}

const residentRow = (entry) => {
  const resident = entry?.resident || entry || {};
  return Object.freeze({
    id: String(resident.id ?? ''),
    name: String(resident.name ?? resident.id ?? 'A resident'),
    vault: vaultModel(entry?.vault),
    garden: spaceModel(entry?.garden),
    cottage: spaceModel(entry?.cottage),
    error: textOr(entry?.error),
  });
};

/** The one line that summarises a vault for the passport and the panel head. */
export function vaultSentence(vault) {
  if (!vault.ready) return 'The server has not described this vault yet.';
  if (!vault.enrolled) return NO_VAULT_SENTENCE;
  const used = `${plural(vault.notes, 'note')}, ${bytesText(vault.bytes)}`;
  return `${vault.mode_label}. ${used}${vault.slots === null ? '' : ` (room for ${vault.slots} notes)`}.`;
}

/** The server's statement of who can read this vault, for the key model it has; never invented here. */
export function policyLines(vault) {
  if (!vault.ready) return [];
  const mode = vault.enrolled && vault.mode ? [vault.policy[vault.mode]] : [];
  return [vault.policy.summary, ...mode, vault.policy.effect].filter(Boolean);
}

/** The "Your resident's home" summary as a model, for the passport. */
export function homeSummaryModel(entry) {
  const row = residentRow(entry);
  return Object.freeze({
    id: row.id,
    name: row.name,
    garden: visitingSentence(row.garden, 'garden'),
    cottage: visitingSentence(row.cottage, 'cottage'),
    vault: vaultSentence(row.vault),
    error: row.error,
  });
}

// `mount` attaches a listener per key of `on`, so a bare function is wrapped into `{ click }`.
const button = (label, on, options = {}) => el('button', { class: options.class || 'small', attrs: { type: 'button', 'aria-label': options.label || label, ...(options.attrs || {}) }, on: typeof on === 'function' ? { click: on } : (on || {}), text: label });

/**
 * The summary card body for the resident passport: three sentences and two links. `onVault` and
 * `onPrivacy` open the Home & vault section at the matching place; the card reads, and sends, nothing.
 */
export function homeSummaryView(summary, { onVault, onPrivacy } = {}) {
  return el('section', { class: 'ui-home-summary', attrs: { 'aria-label': 'Your resident’s home', 'data-home-summary': summary.id || '' } }, [
    el('h3', { text: 'Your resident’s home' }),
    summary.error ? el('p', { class: 'privacy', attrs: { role: 'alert' }, text: summary.error }) : null,
    el('p', { class: 'ui-home-line', attrs: { 'data-home-summary-garden': '1' }, text: summary.garden }),
    el('p', { class: 'ui-home-line', attrs: { 'data-home-summary-cottage': '1' }, text: summary.cottage }),
    el('p', { class: 'ui-home-line', attrs: { 'data-home-summary-vault': '1' }, text: `Vault: ${summary.vault}` }),
    el('div', { class: 'actions' }, [
      button('Open the vault', () => onVault?.(summary.id), { class: 'small ui-home-link', label: `Open ${summary.name}’s vault`, attrs: { 'data-home-open': 'vault' } }),
      button('Who can visit', () => onPrivacy?.(summary.id), { class: 'secondary small ui-home-link', label: `Choose who can visit ${summary.name}’s garden and cottage`, attrs: { 'data-home-open': 'privacy' } }),
    ]),
  ]);
}

const nodesUnder = (root) => {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    found.push(node);
    for (const child of node.childNodes || node.children || []) walk(child);
  };
  walk(root);
  return found;
};
const findByAttribute = (root, name, value) => nodesUnder(root).find((node) => typeof node.getAttribute === 'function' && node.getAttribute(name) === value) || null;

/**
 * The home panel. `update({ residents, refusal, saved })` ingests the shell's payloads;
 * `onVisibility(agentId, patch)` and `onErase(agentId)` are the only things it sends out, and
 * `onErase` only after the player confirms.
 *
 * `residents` is a list of `{ resident, vault, garden, cottage, error }` in the shape of the
 * server's `GET /vault` and `GET /world` answers. `refusal` and `saved` belong to one server answer:
 * `{ agentId, text }`; omitting them clears them, so a fresh payload never leaves a stale refusal.
 */
export function createHomePanel({ onVisibility, onErase, onChange, reducedMotion = () => false } = {}) {
  let rows = [];
  let loading = true;
  let refusal = null; // { agentId, text }
  let saved = null; // { agentId, text }
  let armed = null; // the resident whose erase has been chosen but not confirmed
  let awaiting = null; // the resident whose request is out; cleared by the next update
  let painted = null; // { root, document, node }
  let focusIntent = null; // where the next paint puts the focus, consumed once
  let pendingFocus = null; // where the focus returns once the server's answer repaints the panel

  const quiet = () => (typeof reducedMotion === 'function' ? Boolean(reducedMotion()) : Boolean(reducedMotion));
  const rowById = (id) => rows.find((row) => row.id === id) || null;

  const model = () => Object.freeze({ loading, residents: rows, refusal, saved, armed, awaiting });

  const applyFocus = () => {
    if (!painted || !focusIntent) return null;
    const intent = focusIntent;
    focusIntent = null;
    const root = painted.root;
    let target = null;
    if (intent.kind === 'switch') target = findByAttribute(root, 'data-home-switch', `${intent.agent}:${intent.which}`);
    else if (intent.kind === 'erase') target = findByAttribute(root, 'data-home-erase', intent.agent);
    else if (intent.kind === 'confirm') target = findByAttribute(root, 'data-home-confirm-erase', intent.agent);
    else if (intent.kind === 'section') target = findByAttribute(root, 'data-home-anchor', `${intent.agent}:${intent.which}`);
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: intent.kind !== 'section' });
    return target;
  };

  /** Flip one of the two switches. It sends one field only and moves nothing until the server answers. */
  const toggle = (agentId, which) => {
    if (awaiting) return null;
    const row = rowById(agentId);
    const space = row && (which === 'garden' ? row.garden : which === 'cottage' ? row.cottage : null);
    if (!space || !space.known) return null;
    const next = space.open ? 'private' : 'public';
    const patch = which === 'garden' ? { visibility: next } : { house_visibility: next };
    awaiting = agentId;
    refusal = null;
    saved = null;
    focusIntent = pendingFocus = { kind: 'switch', agent: agentId, which };
    onVisibility?.(agentId, patch, which);
    onChange?.();
    return patch;
  };

  /** The first click on Erase: it arms the confirmation and erases nothing. */
  const arm = (agentId) => {
    const row = rowById(agentId);
    if (!row || !row.vault.enrolled || awaiting) return null;
    armed = agentId;
    refusal = null;
    saved = null;
    focusIntent = { kind: 'confirm', agent: agentId };
    onChange?.();
    return row;
  };

  const cancel = () => {
    const was = armed;
    armed = null;
    if (!was) return null;
    focusIntent = { kind: 'erase', agent: was };
    onChange?.();
    return was;
  };

  /** Confirm the armed erase: calls `onErase(agentId)`. The vault only changes when the next update says so. */
  const erase = () => {
    if (awaiting) return null;
    const row = armed ? rowById(armed) : null;
    if (!row || !row.vault.enrolled) return null;
    awaiting = row.id;
    armed = null;
    focusIntent = pendingFocus = { kind: 'erase', agent: row.id };
    onErase?.(row.id);
    onChange?.();
    return row;
  };

  const vaultView = (row, current) => {
    const vault = row.vault;
    const isArmed = current.armed === row.id;
    const lines = policyLines(vault);
    return el('div', { class: 'ui-home-vault', attrs: { role: 'group', 'aria-labelledby': `home-vault-title-${row.id}`, 'data-home-vault': row.id, 'data-vault-enrolled': String(vault.enrolled), 'data-vault-mode': vault.mode || '' } }, [
      el('h4', { id: `home-vault-title-${row.id}`, attrs: { tabindex: '-1', 'data-home-anchor': `${row.id}:vault` }, text: `${row.name}’s vault` }),
      el('p', { class: 'ui-home-line', attrs: { 'data-vault-status': '1' }, text: vaultSentence(vault) }),
      vault.enrolled && vault.updated_at ? el('p', { class: 'privacy', text: `Last written ${formatTimestamp(vault.updated_at)}.` }) : null,
      ...lines.map((line, index) => el('p', { class: 'privacy ui-home-policy', attrs: { 'data-vault-policy': String(index) }, text: line })),
      el('p', { class: 'privacy', attrs: { 'data-vault-sight': '1' }, text: OPERATOR_SIGHT }),
      isArmed
        ? el('div', { class: 'ui-home-confirm', attrs: { role: 'group', 'aria-label': `Confirm erasing ${row.name}’s vault`, 'data-home-confirm': row.id } }, [
          el('p', { class: 'ui-home-confirm-question', text: `Erase ${row.name}’s vault and its ${plural(vault.notes, 'note')}?` }),
          el('p', { class: 'privacy', text: ERASE_WARNING }),
          el('p', { class: 'privacy', text: 'Nothing has been erased yet. Confirming sends the request, and the server decides.' }),
          button(`Erase ${row.name}’s vault permanently`, () => erase(), { class: 'ui-home-confirm-button danger', attrs: { 'data-home-confirm-erase': row.id } }),
          button('Cancel', () => cancel(), { class: 'secondary small ui-home-cancel', label: `Cancel erasing ${row.name}’s vault`, attrs: { 'data-home-cancel': row.id } }),
        ])
        : button('Erase this vault…', () => arm(row.id), {
          class: 'secondary small ui-home-erase',
          label: vault.enrolled ? `Erase ${row.name}’s vault` : `${row.name} has no vault to erase`,
          // aria-disabled, never `disabled`: the control stays focusable, so the focus is not lost while a request is out.
          attrs: { 'data-home-erase': row.id, ...(vault.enrolled && !current.awaiting ? {} : { 'aria-disabled': 'true' }) },
        }),
    ]);
  };

  const switchView = (row, which, current) => {
    const space = which === 'garden' ? row.garden : row.cottage;
    const noun = which === 'garden' ? 'Garden' : 'Cottage';
    const busy = current.awaiting === row.id;
    return el('div', { class: 'ui-home-switch-row', attrs: { 'data-home-space': `${row.id}:${which}`, 'data-visibility': space.visibility || '' } }, [
      // The visible words are the accessible name, so what a sighted player reads is what a screen
      // reader says, and the switch role adds the on/off state.
      button(`${noun} open to visitors — ${!space.known ? 'state not stated' : space.open ? 'On' : 'Off'}`, () => toggle(row.id, which), {
        class: `ui-home-switch ${space.open ? 'on' : ''}`.trim(),
        attrs: {
          role: 'switch', 'aria-checked': space.known ? String(space.open) : 'false', 'aria-describedby': `home-rule-${row.id}`, 'data-home-switch': `${row.id}:${which}`,
          // A state the server did not state cannot be switched; a busy switch keeps the focus (aria-disabled, not `disabled`).
          ...(!space.known ? { disabled: true, 'aria-disabled': 'true' } : busy ? { 'aria-disabled': 'true' } : {}),
        },
      }),
      el('p', { class: 'privacy ui-home-switch-note', text: visitingSentence(space, which) }),
    ]);
  };

  const privacyView = (row, current) => el('div', { class: 'ui-home-privacy', attrs: { role: 'group', 'aria-labelledby': `home-privacy-title-${row.id}`, 'data-home-privacy': row.id } }, [
    el('h4', { id: `home-privacy-title-${row.id}`, attrs: { tabindex: '-1', 'data-home-anchor': `${row.id}:privacy` }, text: `Who can visit ${row.name}’s garden and cottage` }),
    switchView(row, 'garden', current),
    switchView(row, 'cottage', current),
    el('p', { class: 'privacy ui-home-rule', id: `home-rule-${row.id}`, attrs: { 'data-home-rule': '1' }, text: SWITCH_RULE }),
    el('p', { class: 'privacy', text: VISITOR_NOTE }),
  ]);

  const residentView = (row, current) => {
    const mine = (item) => (item && item.agentId === row.id ? item : null);
    const refused = mine(current.refusal);
    const done = mine(current.saved);
    return el('section', { class: 'ui-home-resident', attrs: { 'aria-label': `${row.name}’s home`, 'data-home-resident': row.id } }, [
      el('h3', { text: row.name }),
      row.error ? el('p', { class: 'ui-home-refusal-words', attrs: { role: 'alert', 'data-home-load-error': row.id }, text: row.error }) : null,
      privacyView(row, current),
      vaultView(row, current),
      refused ? el('div', { class: 'ui-home-refusal', attrs: { 'data-home-refusal': row.id } }, [
        el('p', { class: 'privacy', text: 'The server refused the change. Its own words:' }),
        el('p', { class: 'ui-home-refusal-words', attrs: { role: 'alert', 'aria-live': 'assertive', 'data-home-refusal-words': '1' }, text: refused.text }),
      ]) : null,
      done ? el('p', { class: 'ui-home-saved', attrs: { role: 'status', 'aria-live': 'polite', 'data-home-saved': row.id }, text: done.text }) : null,
    ]);
  };

  const view = () => {
    const current = model();
    return el('section', { class: `ui-home${quiet() ? ` ${REDUCED_MOTION_CLASS}` : ''}`, attrs: { 'aria-label': 'Home and vault', 'data-home-panel': '1', 'aria-busy': String(current.loading) } }, [
      current.loading ? el('p', { class: 'privacy', attrs: { role: 'status', 'data-home-loading': '1' }, text: 'Asking the server about your residents’ homes.' }) : null,
      !current.loading && !current.residents.length
        ? el('p', { class: 'privacy', attrs: { 'data-home-empty': '1' }, text: 'You have no AI residents yet. Create one in My characters and its cottage and vault will appear here.' })
        : null,
      ...current.residents.map((row) => residentView(row, current)),
    ]);
  };

  const paint = (root, { document: dom = globalThis.document } = {}) => {
    if (!root) throw new TypeError('The home panel needs a host element to paint into.');
    if (!dom || typeof dom.createElement !== 'function') throw new TypeError('The home panel needs a DOM document to paint into.');
    mount(root, view(), dom);
    painted = { root, document: dom, node: root.firstChild || null };
    applyFocus();
    return painted.node;
  };

  const update = ({ residents, refusal: refusalPayload = null, saved: savedPayload = null } = {}) => {
    if (residents !== undefined) { rows = (Array.isArray(residents) ? residents : []).map(residentRow); loading = false; }
    refusal = refusalPayload?.text ? Object.freeze({ agentId: String(refusalPayload.agentId ?? ''), text: String(refusalPayload.text) }) : null;
    saved = savedPayload?.text ? Object.freeze({ agentId: String(savedPayload.agentId ?? ''), text: String(savedPayload.text) }) : null;
    awaiting = null;
    // The answer repaints the whole panel: the focus goes back to the control that was pressed.
    if (pendingFocus) { focusIntent = pendingFocus; pendingFocus = null; }
    // A vault that is gone (erased, or never made) cannot stay armed.
    if (armed && !rowById(armed)?.vault.enrolled) armed = null;
    return model();
  };

  /** Ask the next paint to land the focus on a resident's vault or privacy heading, once. */
  const focusSection = (agentId, which) => { focusIntent = { kind: 'section', agent: agentId, which }; };

  /** Keyboard parity: Escape cancels an armed erase. Enter and Space are the native button press. */
  const handleKey = (key) => {
    if (String(key ?? '') === CANCEL_KEY && armed) { cancel(); return true; }
    return false;
  };

  return { update, model, view, paint, toggle, arm, cancel, erase, handleKey, focusSection, isArmed: () => armed };
}
