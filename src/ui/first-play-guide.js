// The first ten minutes guide.
//
// One dismissible guide that renders three things from a single read: the one next action for this
// resident, the resident standing next to them, and the shared restoration any resident joined. It
// is a reader, never an authority.
//
// The rule the whole feature hangs on: **every "done" state is derived from a saved server row**, so
// nothing here can mark a step complete. The guide renders the server's own `GET /api/v1/first-play`
// payload, sends every action through the allow-listed `transport` (the server's own route, method and
// body — this file never hard-codes a route), and shows the server's own refusal when one comes back.
// Dismissing the guide is a display preference kept in this module only: it never completes a step,
// never writes a completed-step record anywhere, and never treats a dismissal as work done.
//
// Nothing in this module touches a global: the document, the transport and the callbacks are injected,
// so it runs under `node --test` with a tiny fake document and against the real HTTP routes, and the
// integration owner can wire it into the shipped `app.js` shell without this module importing any
// other UI file. DOM is built with `document.createElement` only — text goes in through `textContent`;
// no markup string is ever parsed.

export const FIRST_PLAY_KEYS = Object.freeze({
  dismiss: Object.freeze(['Escape']),
  resume: Object.freeze(['r', 'R']),
  primary: Object.freeze(['Enter']),
});

/**
 * The pure confirmation the guide shows after a server-accepted action. It names the step the reader
 * asked for and states plainly that the server, not the client, records whether the step is done.
 * Accepts the first-play snapshot (or a `{ step }` / `{ action }` shape) so other code can assert on
 * the copy without a DOM.
 */
export function confirmationMessage(snapshot, action = null) {
  const step = snapshot?.next_step || snapshot?.step || null;
  const label = action?.label || snapshot?.action?.label || step?.title || 'this step';
  return `Sent the request for ${label}. The server records whether the step is done.`;
}

/**
 * `Step N of 5`, from the server's own ordinal and step count. `step` is the `next_step` record (or a
 * bare ordinal); `total` is `progress.total` / `policy.steps`. Returns an empty string when the
 * ordinal is unknown rather than inventing one.
 */
export function stepLabel(step, total) {
  const ordinal = Number.isInteger(step?.ordinal) ? step.ordinal : (Number.isInteger(step) ? step : null);
  if (ordinal === null) return '';
  const count = Number.isInteger(total) ? total : null;
  return count === null ? `Step ${ordinal}` : `Step ${ordinal} of ${count}`;
}

/**
 * One readable line for a nearby target: its label, then its tile when the server published one, then
 * its distance in tiles. Only fields the server sent are used; a target with no label and no tile
 * renders as an empty string.
 */
export function targetLine(target) {
  if (!target) return '';
  const label = String(target.label ?? '').trim();
  const notes = [];
  if (Number.isInteger(target.x) && Number.isInteger(target.y)) notes.push(`${target.x}, ${target.y}`);
  if (Number.isFinite(target.distance)) notes.push(`${target.distance} tile${target.distance === 1 ? '' : 's'} away`);
  if (!label && !notes.length) return '';
  return label ? [label, notes.join(' · ')].filter(Boolean).join(' — ') : notes.join(' · ');
}

/**
 * Which step each actor completed, as a table's rows. Each contribution is resolved to the step's
 * title from the restoration's own step lists, so the reader sees a counted step name rather than a
 * raw id. Each actor keeps `operator_distinct` so it is visible that the work came from a different
 * person. Pure and DOM-free.
 */
export function actorRows(restoration) {
  if (!restoration || !Array.isArray(restoration.actors)) return Object.freeze([]);
  const titles = new Map();
  const collect = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (item && item.step_id && !titles.has(item.step_id)) titles.set(item.step_id, item.title || item.step_id);
    }
  };
  collect(restoration.viewer?.steps);
  collect(restoration.remaining);
  collect(restoration.steps);
  return Object.freeze(restoration.actors.map((actor) => Object.freeze({
    name: String(actor?.name ?? ''),
    agent_id: actor?.agent_id ?? null,
    kind: actor?.kind ?? null,
    operator_distinct: actor?.operator_distinct === true,
    promise: actor?.promise ? Object.freeze({ code: actor.promise.code ?? null, label: String(actor.promise.label ?? ''), counted_as_work: actor.promise.counted_as_work === true }) : null,
    contributions: Object.freeze((Array.isArray(actor?.contributions) ? actor.contributions : []).map((entry) => Object.freeze({
      step_id: entry?.step_id ?? null,
      title: titles.get(entry?.step_id) || entry?.step_id || '',
      counted: Number.isFinite(entry?.counted) ? entry.counted : 0,
      standing: Number.isFinite(entry?.standing) ? entry.standing : null,
    }))),
  })));
}

const actionModel = (action) => (action ? Object.freeze({
  id: action.id ?? null,
  label: String(action.label ?? ''),
  route: action.route ?? null,
  method: action.method || 'POST',
  scope: action.scope ?? null,
  body: action.body ?? null,
  ship_route: action.ship_route === true,
  requires_input: action.requires_input === true,
}) : null);

const targetModel = (target) => (target ? Object.freeze({
  kind: target.kind ?? null,
  label: String(target.label ?? ''),
  world_id: target.world_id ?? null,
  world_name: target.world_name ?? null,
  x: Number.isInteger(target.x) ? target.x : null,
  y: Number.isInteger(target.y) ? target.y : null,
  z: Number.isInteger(target.z) ? target.z : null,
  distance: Number.isFinite(target.distance) ? target.distance : null,
  route: target.route ?? null,
  has_position: Number.isInteger(target.x) && Number.isInteger(target.y),
  line: targetLine(target),
}) : null);

/**
 * A refusal the viewer can recover from: the server's own message, its `recover` / `next_step` text,
 * and — only when the server actually named a shipped route — a button for it. Without a route this
 * is plain text, so the guide never invents an action the server did not publish.
 */
export function refusalModel(refusal) {
  if (!refusal) return null;
  const named = refusal.action && typeof refusal.action === 'object' ? refusal.action : null;
  const route = String(named?.route ?? refusal.route ?? '').trim();
  const shipped = route.startsWith('/');
  return Object.freeze({
    code: refusal.code ?? null,
    message: String(refusal.message ?? ''),
    recover: String(refusal.recover ?? ''),
    next_step: String(refusal.next_step ?? ''),
    route: shipped ? route : null,
    method: (named?.method || refusal.method || 'POST'),
    body: named?.body ?? refusal.body ?? null,
    label: String(named?.label ?? refusal.label ?? ''),
  });
}

/**
 * The whole guide as one pure model: the next action, the encounter, the shared restoration and the
 * resume line, all read from the frozen `GET /api/v1/first-play` shape. No rule the server did not
 * send is applied here.
 */
export function guideModel(snapshot, options = {}) {
  const { dismissed = false, busy = false, error = null, confirmation = null, reducedMotion = false, detailsOpen = false, stepDetailsOpen = false } = options;
  const base = {
    ready: Boolean(snapshot && typeof snapshot === 'object'),
    dismissed: Boolean(dismissed), busy: Boolean(busy), reducedMotion: Boolean(reducedMotion), detailsOpen: Boolean(detailsOpen), stepDetailsOpen: Boolean(stepDetailsOpen),
    worldPaused: snapshot?.world?.paused === true,
    error: error || null, confirmation: confirmation || null,
    progress: null, next: null, encounter: null, restoration: null, resume: null, refusals: Object.freeze([]),
  };
  if (!base.ready) return Object.freeze(base);

  const policy = snapshot.policy || {};
  const total = Number.isInteger(snapshot.progress?.total) ? snapshot.progress.total : (Number.isInteger(policy.steps) ? policy.steps : null);
  const done = Number.isInteger(snapshot.progress?.done) ? snapshot.progress.done : 0;
  const step = snapshot.next_step || null;
  const progress = Object.freeze({
    done, total,
    complete: total !== null && done >= total,
    label: step ? stepLabel(step, total) : (total !== null ? `${done} of ${total} steps done` : ''),
  });

  const next = step ? Object.freeze({
    id: step.id ?? null,
    ordinal: Number.isInteger(step.ordinal) ? step.ordinal : null,
    title: String(step.title ?? ''),
    instruction: String(step.instruction ?? ''),
    reason: String(step.reason ?? ''),
    alternative: step.alternative ? String(step.alternative) : null,
    dismissible: step.dismissible !== false,
    target: targetModel(step.target),
    actions: Object.freeze((Array.isArray(step.actions) ? step.actions : []).map(actionModel).filter(Boolean)),
    blocked: step.blocked ? Object.freeze({
      code: step.blocked.code ?? null,
      message: String(step.blocked.message ?? ''),
      next_step: String(step.blocked.next_step ?? ''),
    }) : null,
  }) : null;

  const encounter = snapshot.encounter ? Object.freeze({
    kind: snapshot.encounter.kind ?? null,
    source: snapshot.encounter.source ?? null,
    agent_id: snapshot.encounter.agent_id ?? null,
    npc_id: snapshot.encounter.npc_id ?? null,
    name: String(snapshot.encounter.name ?? ''),
    role_label: String(snapshot.encounter.role_label ?? ''),
    scripted: snapshot.encounter.scripted === true,
    calling: snapshot.encounter.calling ? Object.freeze({
      id: snapshot.encounter.calling.id ?? null,
      name: String(snapshot.encounter.calling.name ?? ''),
      purpose: String(snapshot.encounter.calling.purpose ?? ''),
    }) : null,
    honest_statement: String(snapshot.encounter.honest_statement ?? ''),
    response_availability: snapshot.encounter.response_availability ?? null,
    response_note: String(snapshot.encounter.response_note ?? ''),
    limitations: String(snapshot.encounter.limitations ?? ''),
    capabilities: String(snapshot.encounter.capabilities ?? ''),
    cannot: Object.freeze((Array.isArray(snapshot.encounter.cannot) ? snapshot.encounter.cannot : []).map(String)),
    distance: Number.isFinite(snapshot.encounter.distance) ? snapshot.encounter.distance : null,
    actions: Object.freeze((Array.isArray(snapshot.encounter.actions) ? snapshot.encounter.actions : []).map(actionModel).filter(Boolean)),
  }) : null;

  const restore = snapshot.restoration || null;
  const restoration = restore ? Object.freeze({
    event_id: restore.event_id ?? null,
    site_name: String(restore.site_name ?? ''),
    world_id: restore.world_id ?? null,
    phase: restore.phase ?? null,
    steps_completed: Number.isFinite(restore.steps_completed) ? restore.steps_completed : null,
    steps_total: Number.isFinite(restore.steps_total) ? restore.steps_total : null,
    actors: actorRows(restore),
    remaining: Object.freeze((Array.isArray(restore.remaining) ? restore.remaining : []).map((item) => Object.freeze({
      step_id: item?.step_id ?? null,
      title: String(item?.title ?? ''),
      progress: Number.isFinite(item?.progress) ? item.progress : 0,
      target: Number.isFinite(item?.target) ? item.target : null,
    }))),
    viewer: restore.viewer ? Object.freeze({
      joined: restore.viewer.joined === true,
      my_counted_by_step: Object.freeze({ ...(restore.viewer.my_counted_by_step || {}) }),
      steps: Object.freeze((Array.isArray(restore.viewer.steps) ? restore.viewer.steps : []).map((item) => Object.freeze({
        step_id: item?.step_id ?? null,
        title: String(item?.title ?? ''),
        eligible: item?.eligible === true,
        complete: item?.complete === true,
        progress: Number.isFinite(item?.progress) ? item.progress : 0,
        target: Number.isFinite(item?.target) ? item.target : null,
        my_counted: Number.isFinite(item?.my_counted) ? item.my_counted : 0,
      }))),
      next_action: restore.viewer.next_action ? Object.freeze({
        step_id: restore.viewer.next_action.step_id ?? null,
        title: String(restore.viewer.next_action.title ?? ''),
        role: String(restore.viewer.next_action.role ?? ''),
        action: restore.viewer.next_action.action ? Object.freeze({
          kind: restore.viewer.next_action.action.kind ?? null,
          label: String(restore.viewer.next_action.action.label ?? ''),
          saved_fact: String(restore.viewer.next_action.action.saved_fact ?? ''),
        }) : null,
        target: restore.viewer.next_action.target ? Object.freeze({ ...restore.viewer.next_action.target }) : null,
        out_of_window: restore.viewer.next_action.out_of_window === true,
      }) : null,
    }) : null,
  }) : null;

  const resumable = snapshot.resume || null;
  const resume = resumable ? Object.freeze({
    character_id: resumable.character_id ?? null,
    character_name: String(resumable.character_name ?? ''),
    kind: resumable.kind ?? null,
    world_id: resumable.world_id ?? null,
    world_name: String(resumable.world_name ?? ''),
    x: Number.isInteger(resumable.x) ? resumable.x : null,
    y: Number.isInteger(resumable.y) ? resumable.y : null,
    z: Number.isInteger(resumable.z) ? resumable.z : null,
    grounded: resumable.grounded === true,
    yaw: Number.isFinite(resumable.yaw) ? resumable.yaw : null,
    pitch: Number.isFinite(resumable.pitch) ? resumable.pitch : null,
    posture: resumable.posture ?? null,
    camera: resumable.camera ? Object.freeze({ preference: resumable.camera.preference ?? null, source: String(resumable.camera.source ?? '') }) : null,
    calling_id: resumable.calling_id ?? null,
    calling_name: String(resumable.calling_name ?? ''),
    purpose: String(resumable.purpose ?? ''),
    next_step_id: resumable.next_step_id ?? null,
    restore: Object.freeze((Array.isArray(resumable.restore) ? resumable.restore : []).map((item) => Object.freeze({
      id: item?.id ?? null,
      label: String(item?.label ?? ''),
      source: String(item?.source ?? ''),
    }))),
    refusal: refusalModel(resumable.refusal),
  }) : null;

  const refusals = Object.freeze((Array.isArray(snapshot.refusals) ? snapshot.refusals : []).map((item) => Object.freeze({
    code: item?.code ?? null,
    message: String(item?.message ?? ''),
    next_step: String(item?.next_step ?? ''),
  })));

  return Object.freeze({ ...base, progress, next, encounter, restoration, resume, refusals });
}

// ------------------------------------------------------------------------------------------------
// The view tree. A plain, frozen description so it can be asserted without a browser; the only
// function that touches a real document is `renderNode` below.
// ------------------------------------------------------------------------------------------------
const el = (tag, options = {}, children = []) => Object.freeze({ tag, ...options, children: (children || []).filter((child) => child !== null && child !== undefined && child !== false) });

const button = (label, on, options = {}) => el('button', {
  class: options.class || 'game-guide-button',
  attrs: { type: 'button', 'aria-label': options.label || label, ...(options.attrs || {}) },
  on: { click: on },
  text: label,
});

const progressLine = (progress) => {
  const nodes = [];
  if (progress?.label) nodes.push(el('p', { class: 'game-guide-progress', attrs: { 'data-guide': 'progress' }, text: progress.label }));
  if (Number.isInteger(progress?.total)) {
    nodes.push(el('progress', {
      class: 'game-guide-meter',
      attrs: {
        'data-guide': 'meter',
        max: String(progress.total),
        value: String(Number.isFinite(progress.done) ? progress.done : 0),
        'aria-label': progress.label || 'First-step progress',
      },
    }));
  }
  return nodes;
};

// Opening an existing game panel is a navigation choice. It sends no world action and cannot
// complete a step. Some server steps intentionally name a target without a write (for example,
// choosing a calling), so give those steps a visible route into the interface that already owns it.
export function guideNavigation(next) {
  if (!next || next.actions?.length) return null;
  const choices = {
    enter: { section: 'characters', label: 'Choose a resident' },
    calling: { section: 'callings', label: 'Choose a calling' },
    meet: { section: 'list', label: 'See nearby residents' },
    practice: { section: 'workshop', label: 'Open garden & workshop' },
    restore: { section: 'restoration', label: 'View shared restoration' },
  };
  return choices[next.id] || null;
}

const nextCard = (model, handlers) => {
  const next = model.next;
  const blocked = next?.blocked || null;
  const actionNodes = (next?.actions || []).map((action) => button(action.label || action.id || 'Continue', () => handlers.onAction(action), {
    class: 'game-guide-button game-guide-action',
    label: action.label || action.id || 'Continue',
    attrs: { 'data-guide-action': action.id || '', ...(blocked ? { disabled: true, 'aria-disabled': 'true' } : {}) },
  }));
  const navigation = guideNavigation(next);
  if (navigation && typeof handlers.onNavigate === 'function') actionNodes.push(button(navigation.label, () => handlers.onNavigate(navigation.section), {
    class: 'game-guide-button game-guide-navigation',
    attrs: { 'data-guide-navigation': navigation.section, ...(blocked ? { disabled: true, 'aria-disabled': 'true' } : {}) },
  }));

  const live = el('div', { class: 'game-guide-action-line', attrs: { 'data-guide': 'action-line', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } }, [
    el('h2', { class: 'game-guide-title', text: next?.title || 'No next step right now' }),
    next?.instruction ? el('p', { class: 'game-guide-instruction', text: next.instruction }) : null,
  ]);
  const progress=progressLine(model.progress);
  const nodes = [
    el('div', { class: 'game-guide-heading' }, [progress[0],
      next?.dismissible === false ? null : button('Dismiss', () => handlers.onDismiss(), {
        class: 'game-guide-button game-guide-dismiss', label: 'Dismiss the guide; it does not complete any step', attrs: { 'data-guide': 'dismiss' },
      }),
    ]),
    ...progress.slice(1),
    live,
    actionNodes.length ? el('div', { class: 'game-guide-buttons' }, actionNodes) : null,
    next?.reason || next?.target?.line || next?.alternative ? el('details', { class: 'game-guide-step-details', attrs: { open: model.stepDetailsOpen }, on: { toggle: (event) => handlers.onStepDetailsToggle?.(Boolean(event.currentTarget?.open ?? event.target?.open)) } }, [
      el('summary', { text: 'Where & why' }),
      next?.target?.line ? el('p', { class: 'game-guide-target', attrs: { 'data-guide': 'target' }, text: next.target.line }) : null,
      next?.reason ? el('p', { class: 'game-guide-reason', text: next.reason }) : null,
      next?.alternative ? el('p', { class: 'game-guide-alternative', attrs: { 'data-guide': 'alternative' }, text: next.alternative }) : null,
    ]) : null,
    blocked ? el('p', {
      class: 'game-guide-blocked',
      attrs: { 'data-guide': 'blocked', role: 'alert', 'aria-live': 'assertive' },
      text: [blocked.message, blocked.next_step].filter(Boolean).join(' '),
    }) : null,
    model.confirmation ? el('p', { class: 'game-guide-confirmation', attrs: { 'data-guide': 'confirmation', role: 'status' }, text: model.confirmation }) : null,
    model.error ? el('p', { class: 'game-guide-error', attrs: { 'data-guide': 'error', role: 'alert' }, text: model.error.message || 'That action was refused.' }) : null,
  ];
  return el('section', { class: 'game-guide-card game-guide-next', attrs: { 'data-guide': 'next', 'aria-label': 'Your next action' } }, nodes);
};

const encounterCard = (encounter, handlers, blocked = false) => {
  if (!encounter) return null;
  const nodes = [
    el('h3', { class: 'game-guide-title', attrs: { 'data-guide': 'encounter-name' }, text: encounter.name }),
    el('p', { class: 'game-guide-role', attrs: { 'data-guide': 'encounter-role' }, text: [encounter.role_label, encounter.scripted ? 'Scripted resident' : null, Number.isFinite(encounter.distance) ? `${encounter.distance} tiles away` : null].filter(Boolean).join(' · ') }),
    encounter.calling ? el('p', { class: 'game-guide-calling', text: `${encounter.calling.name} — ${encounter.calling.purpose}` }) : null,
    encounter.honest_statement ? el('p', { class: 'game-guide-honest', attrs: { 'data-guide': 'encounter-honest' }, text: encounter.honest_statement }) : null,
    encounter.response_note ? el('p', { class: 'game-guide-response', attrs: { 'data-guide': 'encounter-response' }, text: encounter.response_note }) : null,
    encounter.limitations ? el('p', { class: 'game-guide-limits', attrs: { 'data-guide': 'encounter-limits' }, text: encounter.limitations }) : null,
    encounter.capabilities ? el('p', { class: 'game-guide-capabilities', text: encounter.capabilities }) : null,
  ];
  if (encounter.cannot.length) {
    nodes.push(el('div', { class: 'game-guide-cannot' }, [
      el('strong', { attrs: { 'data-guide': 'encounter-cannot-heading' }, text: 'What this resident cannot do' }),
      el('ul', {}, encounter.cannot.map((line) => el('li', { text: line }))),
    ]));
  }
  const actionNodes = encounter.actions.map((action) => button(action.label || action.id || 'Continue', () => handlers.onAction(action), {
    class: 'game-guide-button game-guide-encounter-action',
    label: action.label || action.id || 'Continue',
    attrs: { 'data-guide-encounter-action': action.id || '', ...(blocked ? { disabled: true, 'aria-disabled': 'true' } : {}) },
  }));
  if (actionNodes.length) nodes.push(el('div', { class: 'game-guide-buttons' }, actionNodes));
  return el('section', { class: 'game-guide-card game-guide-encounter', attrs: { 'data-guide': 'encounter', 'aria-label': 'A resident near you' } }, nodes);
};

const restorationCard = (restoration) => {
  if (!restoration) return null;
  const rows = [];
  for (const actor of restoration.actors) {
    const marker = actor.operator_distinct ? ' · different operator' : '';
    if (!actor.contributions.length) {
      rows.push(el('tr', { attrs: { 'data-actor': actor.name } }, [
        el('td', { text: `${actor.name}${marker}` }),
        el('td', { text: 'No counted step yet' }),
        el('td', { text: '—' }),
      ]));
      continue;
    }
    for (const contribution of actor.contributions) {
      rows.push(el('tr', { attrs: { 'data-actor': actor.name, 'data-step': contribution.step_id || '', 'data-distinct': String(actor.operator_distinct) } }, [
        el('td', { text: `${actor.name}${marker}` }),
        el('td', { text: contribution.title }),
        el('td', { text: String(contribution.counted) }),
      ]));
    }
  }
  const nodes = [
    el('h3', { class: 'game-guide-title', attrs: { 'data-guide': 'restoration-site' }, text: [`Shared restoration`, restoration.site_name].filter(Boolean).join(' · ') }),
    el('p', { class: 'game-guide-progress', text: restoration.steps_total !== null ? `${restoration.steps_completed ?? 0} of ${restoration.steps_total} steps complete` : '' }),
  ];
  nodes.push(el('table', { class: 'game-guide-table' }, [
    el('caption', { text: 'Which step each resident completed' }),
    el('thead', {}, [el('tr', {}, [
      el('th', { attrs: { scope: 'col' }, text: 'Resident' }),
      el('th', { attrs: { scope: 'col' }, text: 'Step' }),
      el('th', { attrs: { scope: 'col' }, text: 'Counted' }),
    ])]),
    el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { attrs: { colspan: '3' }, text: 'No resident has counted a step yet.' })])]),
  ]));
  if (restoration.remaining.length) {
    nodes.push(el('div', { class: 'game-guide-remaining' }, [
      el('strong', { attrs: { 'data-guide': 'remaining-heading' }, text: 'What remains' }),
      el('ul', {}, restoration.remaining.map((item) => el('li', { text: `${item.title}${item.target !== null ? ` (${item.progress}/${item.target})` : ''}` }))),
    ]));
  }
  if (restoration.viewer) {
    const viewer = restoration.viewer;
    const steps = viewer.steps.length
      ? el('ul', {}, viewer.steps.map((item) => el('li', { text: `${item.title}: you counted ${item.my_counted}${item.target !== null ? ` of ${item.target}` : ''}${item.complete ? ' · complete' : ''}` })))
      : el('p', { class: 'game-guide-note', text: 'You have not joined a restoration step yet.' });
    const nextAction = viewer.next_action
      ? el('p', { attrs: { 'data-guide': 'viewer-next' }, text: [viewer.next_action.title, viewer.next_action.role, viewer.next_action.action?.label, viewer.next_action.out_of_window ? 'Outside the current window' : null].filter(Boolean).join(' · ') })
      : null;
    nodes.push(el('div', { class: 'game-guide-viewer' }, [el('strong', { text: viewer.joined ? 'Your part' : 'Your part — not joined yet' }), steps, nextAction]));
  }
  return el('section', { class: 'game-guide-card game-guide-restoration', attrs: { 'data-guide': 'restoration', 'aria-label': 'Shared restoration' } }, nodes);
};

const resumeCard = (resume, handlers) => {
  if (!resume) return null;
  const place = [resume.world_name, Number.isInteger(resume.x) ? `${resume.x}, ${resume.y}` : null].filter(Boolean).join(' · ');
  const camera = resume.camera?.preference ? `${resume.camera.preference}${resume.camera.source ? ` (${resume.camera.source})` : ''}` : '';
  const nodes = [
    el('h3', { class: 'game-guide-title', attrs: { 'data-guide': 'resume-name' }, text: resume.character_name }),
    el('p', { class: 'game-guide-place', attrs: { 'data-guide': 'resume-place' }, text: [place, camera].filter(Boolean).join(' · ') }),
    resume.calling_name ? el('p', { class: 'game-guide-calling', attrs: { 'data-guide': 'resume-calling' }, text: [resume.calling_name, resume.purpose].filter(Boolean).join(' — ') }) : null,
  ];
  if (resume.refusal) {
    const refusal = resume.refusal;
    const recovery = [refusal.message, refusal.recover, refusal.next_step].filter(Boolean).join(' ');
    const recoveryNode = refusal.route
      ? button(refusal.label || refusal.next_step || 'Recover', () => handlers.onRecover(refusal), {
        class: 'game-guide-button game-guide-recover',
        label: refusal.label || 'Recover this place',
        attrs: { 'data-guide': 'recover' },
      })
      : el('p', { class: 'game-guide-recover-note', text: refusal.next_step || refusal.recover || '' });
    nodes.push(el('div', { class: 'game-guide-refusal', attrs: { 'data-guide': 'resume-refusal', role: 'alert' } }, [
      el('strong', { text: 'This place could not be restored' }),
      el('p', { text: recovery }),
      recoveryNode,
    ]));
  }
  return el('section', { class: 'game-guide-card game-guide-resume', attrs: { 'data-guide': 'resume', 'aria-label': 'Where you left off' } }, nodes);
};

const dismissedBar = (handlers) => el('section', { class: 'game-guide-card game-guide-dismissed', attrs: { 'data-guide': 'dismissed' } }, [
  button('Resume the guide', () => handlers.onResume(), {
    class: 'game-guide-button game-guide-resume',
    label: 'Resume the first-play guide',
    attrs: { 'data-guide': 'resume' },
  }),
]);

/** The four cards, keyed so a shell can mount each in its own host. Null when there is nothing to show. */
export function guideCards(model, handlers = {}) {
  if (!model?.ready) return Object.freeze({ next: null, encounter: null, restoration: null, resume: null });
  if (model.dismissed) return Object.freeze({ next: dismissedBar(handlers), encounter: null, restoration: null, resume: null });
  return Object.freeze({
    next: nextCard(model, handlers),
    encounter: encounterCard(model.encounter, handlers, Boolean(model.worldPaused || model.next?.blocked)),
    restoration: restorationCard(model.restoration),
    resume: resumeCard(model.resume, handlers),
  });
}

/** The full guide as one view tree, for assertion and for a single-host mount. */
export function guideView(model, handlers = {}) {
  const cards = guideCards(model, handlers);
  const supporting = [cards.encounter, cards.restoration, cards.resume].filter(Boolean);
  const details = supporting.length ? el('details', {
    class: 'game-guide-details',
    attrs: { 'data-guide': 'details', open: model.detailsOpen },
    on: { toggle: (event) => handlers.onDetailsToggle?.(Boolean(event.currentTarget?.open ?? event.target?.open)) },
  }, [
    el('summary', { class: 'game-guide-details-summary', text: 'People & progress' }),
    el('div', { class: 'game-guide-details-body' }, supporting),
  ]) : null;
  const children = [cards.next, details].filter(Boolean);
  const classes = ['game-guide'];
  if (model?.reducedMotion) classes.push('game-guide-reduced');
  return el('section', { class: classes.join(' '), attrs: { 'data-guide': 'root', role: 'region', 'aria-label': 'First ten minutes guide' } }, children);
}

// ------------------------------------------------------------------------------------------------
// The controller.
// ------------------------------------------------------------------------------------------------
export function createFirstPlayGuide({ transport, document: injectedDocument = null, onAction = null, onCompose = null, onNavigate = null, onChange = null, onDismiss = null, onResume = null, reducedMotion = false } = {}) {
  if (typeof transport !== 'function') throw new TypeError('The first-play guide needs an async transport(route, method, body, idempotent) function.');
  const doc = injectedDocument || (typeof globalThis !== 'undefined' ? globalThis.document : null);
  const state = { snapshot: null, dismissed: false, busy: false, detailsOpen: false, stepDetailsOpen: false, error: null, confirmation: null, flight: null, host: null };

  const handlersFor = () => ({
    onAction: (action) => { void controller.activate(action); },
    onDismiss: () => controller.dismiss(),
    onResume: () => controller.resume(),
    onRecover: (refusal) => { void controller.recover(refusal); },
    onNavigate: typeof onNavigate === 'function' ? (section) => onNavigate(section) : null,
    onDetailsToggle: (open) => { state.detailsOpen = open; },
    onStepDetailsToggle: (open) => { state.stepDetailsOpen = open; },
  });

  const blockedNow = () => Boolean(state.snapshot?.world?.paused || state.snapshot?.next_step?.blocked);

  async function send(action) {
    if (!action || typeof action.route !== 'string' || !action.route) return null;
    if (state.busy) return state.flight;
    state.busy = true;
    state.error = null;
    const run = Promise.resolve().then(async () => {
      try {
        if (action.requires_input) {
          if (typeof onCompose !== 'function') throw new Error('Open the conversation to enter your own message.');
          await onCompose(action);
          state.confirmation = null;
          state.error = null;
          return { ok: true, composing: true };
        }
        const result = await transport(action.route, action.method || 'POST', action.body ?? null, true);
        state.confirmation = confirmationMessage(state.snapshot, action);
        state.error = null;
        onAction?.(action, { ok: true, result });
        return { ok: true, result };
      } catch (error) {
        state.confirmation = null;
        state.error = { message: error?.message || 'The server refused that action.', status: Number.isInteger(error?.status) ? error.status : 0 };
        return { ok: false, error: state.error };
      } finally {
        state.busy = false;
        state.flight = null;
        // Replacing the guide button immediately after it opens a text composer can steal the
        // browser's newly focused text field. A successful compose changes no saved guide fact.
        if (!action.requires_input || state.error) onChange?.();
      }
    });
    state.flight = run;
    return run;
  }

  const controller = {
    /** Ingest the server's own `GET /api/v1/first-play` payload and return the new model. */
    update(snapshot) {
      const next = snapshot && typeof snapshot === 'object' ? snapshot : null;
      if (next !== state.snapshot) {
        state.snapshot = next;
        state.error = null;
        state.confirmation = null;
      }
      return controller.model();
    },
    model() {
      return guideModel(state.snapshot, { dismissed: state.dismissed, busy: state.busy, detailsOpen: state.detailsOpen, stepDetailsOpen: state.stepDetailsOpen, error: state.error, confirmation: state.confirmation, reducedMotion: Boolean(reducedMotion) });
    },
    view() {
      return guideView(controller.model(), handlersFor());
    },
    /** The cards, for a shell that mounts each in its own host. */
    cards() {
      return guideCards(controller.model(), handlersFor());
    },

    /**
     * Send the one action the server named, through the injected transport, then call `onAction`.
     * Nothing on this side marks a step: the snapshot is re-read by the shell from the server.
     */
    activate(action) {
      if (blockedNow()) return null;
      return send(action);
    },
    /** A refusal the viewer can recover from: only the route the server named is sent. */
    recover(refusal) {
      if (!refusal?.route) return null;
      return send({ id: 'recover', label: refusal.label, route: refusal.route, method: refusal.method, body: refusal.body });
    },

    dismiss() {
      if (state.dismissed) return state.dismissed;
      if (state.snapshot?.next_step?.dismissible === false) return state.dismissed;
      state.dismissed = true;
      onDismiss?.();
      return state.dismissed;
    },
    resume() {
      if (!state.dismissed) return state.dismissed;
      state.dismissed = false;
      onResume?.();
      return state.dismissed;
    },
    get dismissed() { return state.dismissed; },
    get busy() { return state.busy; },

    /**
     * Route one key press. Escape dismisses (a display preference only, never a completion); `r`
     * resumes a dismissed guide; Enter activates the one next action when none is blocked. Any other
     * key returns null so the world keeps its own controls. The triggered work is attached as
     * `pending` for the caller to await.
     */
    handleKey(event) {
      const key = typeof event === 'string' ? event : event?.key;
      if (key == null) return null;
      if (FIRST_PLAY_KEYS.dismiss.includes(key)) { controller.dismiss(); return { kind: 'dismiss' }; }
      if (state.dismissed) {
        if (FIRST_PLAY_KEYS.resume.includes(key)) { controller.resume(); return { kind: 'resume' }; }
        return null;
      }
      if (FIRST_PLAY_KEYS.primary.includes(key)) {
        const action = state.snapshot?.next_step?.actions?.[0];
        if (!action || blockedNow()) return null;
        return { kind: 'action', action, pending: controller.activate(action) };
      }
      return null;
    },

    /**
     * Paint the guide into `target`. `hosts` may name `guide`, `encounter`, `restoration` or `resume`
     * to place a card in its own container; any card without a host renders into `target`.
     */
    paint(target, hosts = {}) {
      if (!target) return controller;
      if (!doc || typeof doc.createElement !== 'function') throw new TypeError('Painting the guide needs a document with createElement.');
      state.host = target;
      const cards = controller.cards();
      const external = { next: hosts.guide, encounter: hosts.encounter, restoration: hosts.restoration, resume: hosts.resume };
      clearNode(target);
      for (const key of ['next', 'encounter', 'restoration', 'resume']) {
        const node = cards[key];
        if (!node) continue;
        const host = external[key] || target;
        if (host !== target) clearNode(host);
        appendNode(host, node);
      }
      return controller;
    },

    destroy() {
      if (state.host && doc) clearNode(state.host);
      state.snapshot = null; state.host = null; state.flight = null; state.error = null; state.confirmation = null;
      return controller;
    },
    reset() {
      controller.destroy();
      state.dismissed = false;state.detailsOpen = false;state.stepDetailsOpen = false;
      return controller;
    },
  };
  return controller;
}

const clearNode = (node) => {
  if (!node) return;
  if (typeof node.replaceChildren === 'function') { node.replaceChildren(); return; }
  node.textContent = '';
};

const appendNode = (host, node) => {
  const child = renderNode(node, host.ownerDocument || (typeof globalThis !== 'undefined' ? globalThis.document : null));
  if (child) host.append(child);
};

/**
 * The one function that touches a real DOM node. It creates elements and sets `textContent` and
 * attributes only — a text string is never parsed as markup, so nothing the server sent can become
 * an element.
 */
export function renderNode(node, doc) {
  if (node === null || node === undefined || node === false) return null;
  if (!doc || typeof doc.createElement !== 'function') throw new TypeError('Rendering needs a document with createElement.');
  const element = doc.createElement(node.tag || 'div');
  if (node.class) element.setAttribute('class', node.class);
  if (node.id) element.setAttribute('id', String(node.id));
  for (const [name, value] of Object.entries(node.attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  if (node.text !== undefined && node.text !== null) element.textContent = String(node.text);
  for (const [event, handler] of Object.entries(node.on || {})) element.addEventListener(event, handler);
  for (const child of node.children || []) {
    const rendered = renderNode(child, doc);
    if (rendered) element.append(rendered);
  }
  return element;
}
