'use strict';

// Harr Dashboard v2: Mobile-First, Accessible, Interactive SVG Map & Research Tree
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const pct = (a, b) => `${Math.max(0, Math.min(100, b ? Math.round((a / b) * 100) : 0))}%`;
function bar(a, b) {
  const t = el('div', 'bar');
  const i = el('i');
  i.style.width = pct(a, b);
  t.append(i);
  return t;
}
const mins = (m) => (m === null ? 'soon' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
function fill(id, children) {
  const n = $(id);
  if (n) n.replaceChildren(...children);
}

// Plot Origins relative to Plaza[0] @ (0, 0)
const PLOT_ORIGINS = {
  'Plaza:0': [0, 0],
  'House:0': [12, 30],
  'FarmField:0': [18, 48],
  'FarmField:1': [12, 6],
  'Workshop:0': [-6, 18],
};

// Known Sites and Landmark Coordinates for Top-Down Map
const SITES_MAP = [
  { id: 'site-well', label: 'Well Site', plot: 'Plaza:0', dx: -10, dy: -6, project: 'well' },
  { id: 'site-market-hall', label: 'Market Hall Site', plot: 'Plaza:0', dx: 15, dy: -10, project: 'market-hall' },
  { id: 'site-cottage-row', label: 'Cottage Row', plot: 'Plaza:0', dx: -22, dy: 10, project: 'cottage-1' },
  { id: 'site-observatory', label: 'Observatory Site', plot: 'Plaza:0', dx: 0, dy: -14, project: 'observatory' },
  { id: 'site-pavilion', label: 'Pavilion Site', plot: 'FarmField:0', dx: 18, dy: 3, project: 'field-pavilion' },
  { id: 'site-annex', label: 'Annex Site', plot: 'House:0', dx: 13, dy: 2, project: 'library-annex' },
  { id: 'site-orchard-gate', label: 'Orchard Gate', plot: 'FarmField:1', dx: 6, dy: -6, project: 'orchard-gate' },
  { id: 'site-tower', label: 'Research Tower Site', plot: 'Plaza:0', dx: 37, dy: 21, project: 'research-tower' },
  { id: 'site-solar', label: 'Solar Array Site', plot: 'Plaza:0', dx: 30, dy: -26, project: 'solar-array' },
  { id: 'site-vfarm', label: 'Vertical Farm Site', plot: 'FarmField:1', dx: -27, dy: 11, project: 'vertical-farm' },
  { id: 'site-fountain', label: 'Fountain Site', plot: 'Plaza:0', dx: -2, dy: -24, project: 'light-fountain' },
  { id: 'site-transit', label: 'Transit Hub Site', plot: 'Workshop:0', dx: -27, dy: -6, project: 'transit-hub' },
  { id: 'site-archive', label: 'Archive Site', plot: 'Workshop:0', dx: -2, dy: 25, project: 'data-archive' },
  { id: 'site-skywalk', label: 'Sky Walk Site', plot: 'Plaza:0', dx: 20, dy: 31, project: 'sky-walk' },
  { id: 'site-garden', label: 'Glass Garden Site', plot: 'House:0', dx: 26, dy: -28, project: 'glass-garden' },
  { id: 'site-schoolhouse', label: 'Schoolhouse Site', plot: 'Workshop:0', dx: -20, dy: 18, project: 'schoolhouse' },
  { id: 'site-seminar', label: 'Seminar Pavilion Site', plot: 'Workshop:0', dx: -34, dy: 20, project: 'seminar-pavilion' },
  { id: 'site-workshop', label: 'Workshop Hall Site', plot: 'Workshop:0', dx: 14, dy: -6, project: 'workshop-hall' },
  { id: 'site-recycling', label: 'Recycling Garden Site', plot: 'Workshop:0', dx: 14, dy: 4, project: 'recycling-garden' },
  { id: 'site-cottages-north', label: 'North Cottage Row', plot: 'Plaza:0', dx: -38, dy: -16, project: 'cottage-4' },
  { id: 'site-cottages-east', label: 'East Cottage Row', plot: 'Plaza:0', dx: 30, dy: -18, project: 'cottage-7' },
  { id: 'site-guesthouse', label: 'Guesthouse Site', plot: 'House:0', dx: -10, dy: 14, project: 'guesthouse' },
  { id: 'site-amphitheatre', label: 'Amphitheatre Site', plot: 'Plaza:0', dx: -20, dy: -32, project: 'amphitheatre' },
  { id: 'site-festival-lawn', label: 'Festival Lawn Site', plot: 'Plaza:0', dx: -20, dy: -44, project: 'festival-lawn' },
  { id: 'site-water-tower', label: 'Water Tower Site', plot: 'FarmField:0', dx: -10, dy: 10, project: 'water-tower' },
  { id: 'site-solar-2', label: 'Second Solar Field', plot: 'Plaza:0', dx: 22, dy: -42, project: 'solar-field-2' },
  { id: 'site-wind-array', label: 'Wind Array Site', plot: 'Plaza:0', dx: 4, dy: -44, project: 'wind-array' },
  { id: 'site-bridge', label: 'Canal Bridge Site', plot: 'Plaza:0', dx: -8, dy: 10, project: 'canal-bridge' },
  { id: 'site-tram-halt', label: 'Tram Halt Site', plot: 'Plaza:0', dx: -3, dy: -6, project: 'tram-halt' },
  { id: 'site-greenhouse-dome', label: 'Greenhouse Dome Site', plot: 'FarmField:0', dx: -24, dy: -6, project: 'greenhouse-dome' },
  { id: 'site-seed-vault', label: 'Seed Vault Site', plot: 'FarmField:1', dx: 18, dy: 12, project: 'seed-vault' },
  { id: 'site-bakery', label: 'Bakery & Hearth Site', plot: 'Plaza:0', dx: 14, dy: 10, project: 'bakery' },
  { id: 'site-kiln-pottery', label: 'Kiln & Pottery Site', plot: 'Workshop:0', dx: -14, dy: -16, project: 'kiln-pottery' },
  { id: 'site-loom-house', label: 'Loom & Dye House Site', plot: 'Workshop:0', dx: 2, dy: -18, project: 'loom-house' },
  { id: 'site-lantern-foundry', label: 'Lantern Foundry Site', plot: 'Workshop:0', dx: 18, dy: -18, project: 'lantern-foundry' },
  { id: 'site-weather-spire', label: 'Weather Spire Site', plot: 'Plaza:0', dx: 42, dy: 4, project: 'weather-spire' },
];

// Discovery Places Coordinates (dx, dy from Plaza[0])
const DISCOVERY_COORDS = {
  'The wildflower meadow': [36, 6],
  'The old boundary stone': [-36, 26],
  'The hidden spring': [28, 40],
  'The cedar grove': [-28, -26],
  'The high overlook': [40, -18],
  'The ancient terrace': [-18, 42],
  'The sun cleft': [12, -40],
  'The clay pit': [-44, -6],
  'The hollow oak': [22, -38],
  'The quiet pond': [-14, -46],
};

// Safe browser storage: it can throw (private windows, blocked site data), so the page never depends on it.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* the page still works without it */ } },
};
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.documentElement;

// Colour scheme: auto (follows the system), light or dark.
const SCHEMES = ['auto', 'light', 'dark'];
function applyScheme(mode) {
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  const label = mode[0].toUpperCase() + mode.slice(1);
  const text = $('theme-text');
  if (text) text.textContent = label;
  const btn = $('theme-toggle');
  if (btn) btn.setAttribute('aria-label', `Colour scheme: ${mode}. Press to change.`);
}
function cycleScheme() {
  const current = SCHEMES.includes(store.get('harr-theme')) ? store.get('harr-theme') : 'auto';
  const next = SCHEMES[(SCHEMES.indexOf(current) + 1) % SCHEMES.length];
  store.set('harr-theme', next);
  applyScheme(next);
  announce(`Colour scheme ${next}`);
}
function setupTheme() {
  const saved = store.get('harr-theme');
  applyScheme(SCHEMES.includes(saved) ? saved : 'auto');
  const btn = $('theme-toggle');
  if (btn) btn.addEventListener('click', cycleScheme);
}

// Compact view: a dense, no-scroll layout for a second monitor. ?view=compact also switches it on.
function applyCompact(on) {
  document.body.classList.toggle('compact', on);
  const btn = $('compact-toggle');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  const text = $('compact-text');
  if (text) text.textContent = on ? 'Full view' : 'Compact';
}
function toggleCompact() {
  const on = !document.body.classList.contains('compact');
  store.set('harr-compact', on ? '1' : '0');
  applyCompact(on);
  announce(on ? 'Compact view on' : 'Full view');
}
function setupCompact() {
  const fromUrl = new URLSearchParams(location.search).get('view') === 'compact';
  applyCompact(fromUrl || store.get('harr-compact') === '1');
  const btn = $('compact-toggle');
  if (btn) btn.addEventListener('click', toggleCompact);
}

// A polite spoken/visible status for things the keyboard just did.
function announce(text) {
  const n = $('stamp');
  if (n) n.textContent = text;
}

// First-visit welcome card.
let welcomeDismissedThisVisit = false;
function setupWelcome() {
  const card = $('welcome');
  if (!card) return;
  card.hidden = welcomeDismissedThisVisit || store.get('harr-welcomed') === '1';
  const done = $('welcome-dismiss');
  if (done) {
    done.addEventListener('click', () => {
      welcomeDismissedThisVisit = true;
      store.set('harr-welcomed', '1');
      card.hidden = true;
      const next = $('action-panel');
      if (next) { const h = next.querySelector('h2'); if (h) h.focus(); }
    });
  }
  const again = $('welcome-again');
  if (again) again.addEventListener('click', (e) => { e.preventDefault(); showWelcome(); });
}
function showWelcome() {
  const card = $('welcome');
  if (!card) return;
  card.hidden = false;
  const h = $('h-welcome');
  if (h) { h.focus(); card.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); }
}

// Keyboard: j/k move between sections, c compact, t scheme, r refresh, w welcome, ? shortcuts.
function sectionList() {
  return Array.from(document.querySelectorAll('main > section')).filter((n) => !n.hidden && n.offsetParent !== null);
}
function moveSection(step) {
  const list = sectionList();
  if (!list.length) return;
  const here = list.findIndex((n) => n.getBoundingClientRect().top > 8);
  const current = document.activeElement && document.activeElement.closest ? document.activeElement.closest('main > section') : null;
  let index = current ? list.indexOf(current) : (here === -1 ? list.length - 1 : Math.max(0, here - 1));
  index = Math.max(0, Math.min(list.length - 1, index + step));
  const target = list[index];
  const heading = target.querySelector('h2');
  if (heading) heading.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
}
function toggleKeys(force) {
  const panel = $('keys-panel');
  const btn = $('keys-toggle');
  if (!panel) return;
  const open = typeof force === 'boolean' ? force : panel.hidden;
  panel.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', String(open));
  if (open) panel.querySelector('h2').setAttribute('tabindex', '-1'), panel.querySelector('h2').focus();
  else if (btn) btn.focus();
}
function setupKeys() {
  const btn = $('keys-toggle');
  if (btn) btn.addEventListener('click', () => toggleKeys());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'Escape') { if ($('keys-panel') && !$('keys-panel').hidden) toggleKeys(false); return; }
    switch (e.key) {
      case 'j': moveSection(1); break;
      case 'k': moveSection(-1); break;
      case 'c': toggleCompact(); break;
      case 't': cycleScheme(); break;
      case 'r': announce('Refreshing…'); load(); break;
      case 'w': showWelcome(); break;
      case '?': toggleKeys(); break;
      default: return;
    }
    e.preventDefault();
  });
  // Jumping from the section menu moves keyboard focus too, not only the scroll position.
  document.querySelectorAll('.nav-links a, .welcome-steps a').forEach((a) => a.addEventListener('click', () => {
    const target = document.getElementById((a.getAttribute('href') || '').slice(1));
    const h = target && target.querySelector('h2');
    if (h) setTimeout(() => h.focus({ preventScroll: true }), 0);
  }));
}

// 1. Render "What can I do now" Action Panel
function renderActionPanel(overview, tasksData) {
  const actions = [];

  // Active village rhythm event
  const currentEvent = overview.rhythm.find((e) => e.on_now);
  if (currentEvent) {
    const card = el('div', 'action-card event-card');
    card.append(
      el('span', 'action-badge badge-now', 'Active Now'),
      el('h3', '', currentEvent.title),
      el('p', '', `Happening now at ${currentEvent.place} (${currentEvent.minutes}m remaining). Join your neighbours for fellowship!`),
    );
    actions.push(card);
  }

  // Next Personal Task
  if (tasksData && tasksData.lines) {
    const nextLine = tasksData.lines.find((l) => l.startsWith('Next:'));
    const card = el('div', 'action-card task-card');
    card.append(
      el('span', 'action-badge', 'Next Task'),
      el('h3', '', 'Your Next Discovery Step'),
      el('p', '', nextLine ? nextLine.replace('Next: ', '') : 'Explore the village and meet five neighbours to begin.'),
    );
    actions.push(card);
  }

  // Today's Field Survey
  if (overview.gameplay && overview.gameplay.survey && Array.isArray(overview.gameplay.survey.places)) {
    const sv = overview.gameplay.survey;
    const placeNames = sv.places.slice(0, 2).map((p) => p.name).join(' ↔ ');
    const card = el('div', 'action-card task-card');
    card.append(
      el('span', 'action-badge', 'Daily Field Survey'),
      el('h3', '', sv.title || 'Field Survey'),
      el('p', '', `Visit ${placeNames} before ${sv.closes_at_hour || 18}:00 (${sv.places.map((p) => `${p.name}: ${p.hint}`).slice(0, 2).join('; ')}). Whisper Selene: survey.`),
    );
    actions.push(card);
  }

  // Work site needing a crew
  const crewNeeded = overview.works.find((w) => w.next && w.next.waiting && w.next.waiting.startsWith('needs a crew'));
  if (crewNeeded) {
    const card = el('div', 'action-card crew-card');
    card.append(
      el('span', 'action-badge badge-crew', 'Crew Needed'),
      el('h3', '', `Help Build ${crewNeeded.name}`),
      el('p', '', `Stage "${crewNeeded.next.title}" is waiting for a crew at the site. Stand with the builders to help construct it!`),
    );
    actions.push(card);
  }

  // Free Pantry Meal
  const pantryCard = el('div', 'action-card');
  pantryCard.append(
    el('span', 'action-badge', 'Free Sustenance'),
    el('h3', '', 'Share a Meal at the Pantry'),
    el('p', '', `The village pantry holds ${overview.pantry.shelves}. Take an apple or sunflower seeds anytime without cost.`),
  );
  actions.push(pantryCard);

  // Current Tech Research
  if (overview.research && overview.research.current) {
    const cur = overview.research.current;
    const card = el('div', 'action-card');
    card.append(
      el('span', 'action-badge', 'Research'),
      el('h3', '', `Studying: ${cur.name}`),
      el('p', '', `${cur.progress} of ${cur.cost} insight accumulated. Every discovery and crew help adds insight for the whole village!`),
    );
    actions.push(card);
  }

  fill('actions-grid', actions);
}

// 1b. Render Season, Village Level, Field Survey, Apprenticeships & Gratitude Wall
function renderGameplay(gp) {
  if (!gp) return;

  const topCards = [];
  if (gp.season) {
    const s = gp.season;
    const c = el('div', 'card');
    const rates = s.pantry_rates
      ? Object.entries(s.pantry_rates).map(([k, v]) => `${k} ×${v}`).join(', ')
      : '';
    c.append(
      el('h3', '', `Season: ${s.name}`),
      el('span', 'tag on', `Day ${s.day} of ${s.length} · Next: ${s.next || ''}`),
      bar(s.day, s.length),
      el('p', '', s.line || ''),
      el('p', 'muted', rates ? `Seasonal harvest rates: ${rates}` : ''),
    );
    topCards.push(c);
  }

  if (gp.village_level) {
    const vl = gp.village_level;
    const c = el('div', 'card');
    const f = vl.facts || {};
    const missingText = vl.next && Array.isArray(vl.next.missing) && vl.next.missing.length
      ? `Next: Level ${vl.next.level} (${vl.next.name}) — needs ${vl.next.missing.map((m) => `${m.what} ${m.have}/${m.need}`).join(', ')}`
      : 'Highest village milestone reached together!';
    c.append(
      el('h3', '', `Village Milestone: ${vl.name}`),
      el('span', 'tag ok', `Level ${vl.level} of ${vl.of}`),
      bar(vl.level, vl.of || 6),
      el('p', '', vl.text || ''),
      el('p', 'muted', `${f.projects || 0} works · ${f.techs || 0} techs · ${f.residents || 52} villagers · ${missingText}`),
    );
    topCards.push(c);
  }
  fill('season-level-grid', topCards);

  const gpCards = [];
  if (gp.survey) {
    const sv = gp.survey;
    const td = (sv.village && sv.village.today) || {};
    const c = el('div', 'card');
    c.append(
      el('h3', '', `Today's Field Survey (${sv.day})`),
      el('span', 'tag on', `${td.completed || 0} of ${td.goal || 6} surveys today`),
      el('p', '', `${sv.title || 'Daily survey'}: visit any ${sv.need || 2} of today's places before ${sv.closes_at_hour || 18}:00.`),
    );
    if (Array.isArray(sv.places)) {
      const list = el('ul', 'plain guild-list');
      for (const p of sv.places) {
        const li = el('li', '');
        li.append(el('b', '', `${p.name}: `), document.createTextNode(p.hint || ''));
        list.append(li);
      }
      c.append(list);
    }
    gpCards.push(c);
  }

  if (Array.isArray(gp.apprenticeship)) {
    const totalDone = gp.apprenticeship.reduce((acc, a) => acc + (a.completed || 0), 0);
    const c = el('div', 'card');
    c.append(
      el('h3', '', 'Craft Apprenticeships & Guilds'),
      el('span', 'tag ok', `${gp.apprenticeship.length} guilds · ${totalDone} completed`),
      el('p', '', 'Practise alongside any village mentor to learn their craft — no ranks or rivalries, only shared skill:'),
    );
    const list = el('ul', 'plain guild-list');
    for (const g of gp.apprenticeship) {
      const li = el('li', '');
      li.append(el('b', '', `${g.title}: `), document.createTextNode(`Mentor ${g.mentor} (${g.steps} steps)`));
      list.append(li);
    }
    c.append(list);
    gpCards.push(c);
  }

  if (gp.gratitude) {
    const gr = gp.gratitude;
    const wall = gr.wall || [];
    const c = el('div', 'card');
    c.append(
      el('h3', '', 'The Gratitude Wall'),
      el('span', 'tag ok', `${wall.length} recent notes (${gr.days || 7}d)`),
    );
    if (wall.length) {
      const list = el('ul', 'plain gratitude-list');
      for (const item of wall.slice(0, 5)) {
        const li = el('li', '');
        li.append(el('b', '', `[${item.source || 'village'}] `), document.createTextNode(item.text || ''));
        list.append(li);
      }
      c.append(list);
    } else {
      c.append(el('p', '', 'No thank-you notes posted yet today. Whisper Selene "thank <neighbour> <reason>" in the game to leave the first note on the village wall!'));
    }
    gpCards.push(c);
  }
  fill('gameplay-cards', gpCards);
}

// 2. Render Top-Down SVG Map of Harr
function renderSvgMap(overview) {
  const wrap = $('map-svg-wrap');
  if (!wrap) return;

  const worksMap = new Map();
  for (const w of overview.works) {
    worksMap.set(w.id, w);
  }

  // Map viewbox: center (0, 0), span -60 to +60 in X, -60 to +60 in Y
  const vbMinX = -55, vbMaxX = 55, vbMinY = -55, vbMaxY = 55;
  const vbW = vbMaxX - vbMinX;
  const vbH = vbMaxY - vbMinY;

  // Transform world coords (East=+X, North=+Y) to SVG coords (SVG Y is down)
  const toSvgX = (x) => x - vbMinX;
  const toSvgY = (y) => vbMaxY - y;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
  svg.setAttribute('class', 'map-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Top-down village map of Harr with sites and landmarks');

  // Background grid & plaza
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
      <path d="M 10 0 L 0 0 0 10" fill="none" stroke="currentColor" stroke-opacity="0.08" stroke-width="0.5"/>
    </pattern>
  `;
  svg.appendChild(defs);

  // Background terrain rect
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', vbW);
  bg.setAttribute('height', vbH);
  bg.setAttribute('fill', 'url(#grid)');
  svg.appendChild(bg);

  // Central Plaza outline
  const plaza = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  plaza.setAttribute('x', toSvgX(-12));
  plaza.setAttribute('y', toSvgY(12));
  plaza.setAttribute('width', 24);
  plaza.setAttribute('height', 24);
  plaza.setAttribute('fill', 'currentColor');
  plaza.setAttribute('fill-opacity', '0.06');
  plaza.setAttribute('stroke', 'currentColor');
  plaza.setAttribute('stroke-opacity', '0.2');
  plaza.setAttribute('stroke-width', '0.8');
  plaza.setAttribute('rx', '2');
  svg.appendChild(plaza);

  const plazaLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  plazaLabel.setAttribute('x', toSvgX(0));
  plazaLabel.setAttribute('y', toSvgY(0) + 1);
  plazaLabel.setAttribute('text-anchor', 'middle');
  plazaLabel.setAttribute('font-size', '3');
  plazaLabel.setAttribute('fill', 'currentColor');
  plazaLabel.setAttribute('fill-opacity', '0.4');
  plazaLabel.textContent = 'CENTRAL PLAZA';
  svg.appendChild(plazaLabel);

  // Work sites
  for (const s of SITES_MAP) {
    const origin = PLOT_ORIGINS[s.plot] || [0, 0];
    const gx = origin[0] + s.dx;
    const gy = origin[1] + s.dy;

    const w = worksMap.get(s.project);
    let fillCol = '#6c8496'; // planned
    let statusClass = 'status-planned';
    let statusText = 'Planned';

    if (w) {
      if (w.complete) {
        fillCol = '#34d399';
        statusClass = 'status-finished';
        statusText = 'Complete';
      } else if (w.next && w.next.waiting && w.next.waiting.startsWith('needs a crew')) {
        fillCol = '#fbbf24';
        statusClass = 'status-crew';
        statusText = 'Needs a Crew';
      } else if (w.next && w.next.waiting && w.next.waiting.startsWith('waiting for research')) {
        fillCol = '#fbbf24';
        statusClass = 'status-crew';
        statusText = 'Waiting for Research';
      } else if (w.done > 0) {
        fillCol = '#38bdf8';
        statusClass = 'status-active';
        statusText = `In Progress (${w.done}/${w.total})`;
      }
    }

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `map-site-marker ${statusClass}`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${s.label}: ${statusText}`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', toSvgX(gx));
    circle.setAttribute('cy', toSvgY(gy));
    circle.setAttribute('r', '2.5');
    circle.setAttribute('fill', fillCol);
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '0.6');
    g.appendChild(circle);

    const onSelect = () => {
      const detail = $('map-detail-card');
      if (detail) {
        detail.replaceChildren(
          el('b', '', `${s.label} (${s.id})`),
          document.createTextNode(` — World coords: (${gx}, ${gy}). Status: `),
          el('span', `tag ${w && w.complete ? 'ok' : w && w.next && w.next.waiting ? 'warn' : 'on'}`, statusText),
          el('p', '', w ? w.purpose : 'Future civic structure.'),
        );
      }
    };
    g.addEventListener('click', onSelect);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(); });
    g.addEventListener('mouseenter', onSelect);

    svg.appendChild(g);
  }

  // Discovery places (ONLY if found)
  for (const disc of overview.library) {
    if (disc.found && DISCOVERY_COORDS[disc.name]) {
      const [dx, dy] = DISCOVERY_COORDS[disc.name];
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'map-site-marker status-discovery');
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `Discovered Place: ${disc.name}`);

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', toSvgX(dx) - 2);
      rect.setAttribute('y', toSvgY(dy) - 2);
      rect.setAttribute('width', '4');
      rect.setAttribute('height', '4');
      rect.setAttribute('fill', '#e879f9');
      rect.setAttribute('stroke', '#ffffff');
      rect.setAttribute('stroke-width', '0.6');
      rect.setAttribute('transform', `rotate(45, ${toSvgX(dx)}, ${toSvgY(dy)})`);
      g.appendChild(rect);

      const onSelect = () => {
        const detail = $('map-detail-card');
        if (detail) {
          detail.replaceChildren(
            el('b', '', `[Catalogued Discovery] ${disc.name}`),
            document.createTextNode(` — (${dx}, ${dy}): `),
            el('p', '', disc.finding),
          );
        }
      };
      g.addEventListener('click', onSelect);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(); });
      g.addEventListener('mouseenter', onSelect);

      svg.appendChild(g);
    }
  }

  wrap.replaceChildren(svg);
}

// Sims Needs & Daily Life
function renderLife(sim, now) {
  if (!sim) {
    fill('sims-needs-grid', [empty('Personal wellbeing records synchronizing with village...')]);
    fill('career-school-grid', []);
    return;
  }

  // 1. Render 5 Wellbeing Needs
  const needsGrid = $('sims-needs-grid');
  if (needsGrid && sim.simsNeeds) {
    const needCards = Object.entries(sim.simsNeeds).map(([key, item]) => {
      const c = el('div', 'need-card');
      const header = el('div', 'need-header');
      header.append(el('span', 'need-label', item.label), el('span', 'need-val', `${item.value}%`));

      const meterBg = el('div', 'need-meter-bg');
      const meterFill = el('div', 'need-meter-fill');
      meterFill.style.width = `${item.value}%`;
      meterFill.style.background = item.value >= 75 ? 'var(--color-success)' : item.value >= 50 ? 'var(--color-accent)' : item.value >= 30 ? '#e5a50a' : '#e05353';
      meterBg.append(meterFill);

      const status = el('span', 'need-status', `${item.status} · ${item.hint}`);
      c.append(header, meterBg, status);
      return c;
    });
    fill('sims-needs-grid', needCards);
  }

  // 2. Render Career, School & Cottage
  const lifeGrid = $('career-school-grid');
  if (lifeGrid) {
    const cards = [];
    if (sim.career) {
      const c = el('div', 'life-card');
      c.append(
        el('span', 'badge', sim.career.onShift ? 'Shift Active (8:00 - 16:00)' : 'Civic Vocation'),
        el('h3', '', sim.career.title),
        el('p', '', `Duty: ${sim.career.duty}`),
        el('p', '', `Workplace: ${sim.career.office} at (${sim.career.coords.x}, ${sim.career.coords.y}) · In-game: /tell Rowan shift`)
      );
      cards.push(c);
    }
    if (sim.school) {
      const c = el('div', 'life-card');
      c.append(
        el('span', 'badge', 'Academy & University'),
        el('h3', '', `Daily Lecture: ${sim.school.subject}`),
        el('p', '', `Inquiry: ${sim.school.question}`),
        el('p', '', `Location: ${sim.school.place} at (${sim.school.coords.x}, ${sim.school.coords.y}) · In-game: /tell Selene library`)
      );
      cards.push(c);
    }
    if (sim.home) {
      const c = el('div', 'life-card');
      c.append(
        el('span', 'badge', 'Cottage Living'),
        el('h3', '', sim.home.assigned ? `My Cottage (${sim.home.plotId})` : 'Cottage Haven in Harr'),
        el('p', '', sim.home.assigned ? 'Your personal residence in Cottage Row. Rest inside to completely restore Comfort to 100%.' : 'Choose and claim any open cottage plot in Cottage Row with Rowan.'),
        el('p', '', `Location: Cottage Row at (${sim.home.coords.x}, ${sim.home.coords.y}) · In-game: /tell Rowan my plot`)
      );
      cards.push(c);
    }
    fill('career-school-grid', cards);
  }
}

// 3. Render Circular Goal Rings
function renderGoalRings(goals) {
  const container = $('goals');
  if (!container) return;

  const cards = goals.map((g) => {
    const card = el('div', 'goal-card');
    const ringWrap = el('div', 'goal-ring-wrap');

    const radius = 34;
    const circ = 2 * Math.PI * radius;
    const progressFrac = Math.max(0, Math.min(1, g.target ? g.progress / g.target : 0));
    const offset = circ * (1 - progressFrac);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 80 80');
    svg.setAttribute('class', 'goal-ring-svg');

    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', '40');
    bgCircle.setAttribute('cy', '40');
    bgCircle.setAttribute('r', radius);
    bgCircle.setAttribute('class', 'goal-ring-bg');

    const valCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    valCircle.setAttribute('cx', '40');
    valCircle.setAttribute('cy', '40');
    valCircle.setAttribute('r', radius);
    valCircle.setAttribute('class', `goal-ring-val ${g.done ? 'complete' : ''}`);
    valCircle.setAttribute('stroke-dasharray', circ);
    valCircle.setAttribute('stroke-dashoffset', offset);

    svg.append(bgCircle, valCircle);

    const text = el('div', 'goal-ring-text', `${Math.round(progressFrac * 100)}%`);
    ringWrap.append(svg, text);

    card.append(
      ringWrap,
      el('h3', '', g.title),
      el('span', `tag ${g.done ? 'ok' : 'on'}`, g.done ? 'achieved' : `${g.progress} of ${g.target}`),
      el('p', '', g.why),
    );
    return card;
  });

  fill('goals', cards);
}

// 4. Render Visual Research Tree
function renderResearchTree(research) {
  const container = $('research-tree');
  if (!container) return;

  const techNameById = new Map();
  for (const t of research.techs) techNameById.set(t.id, t.name);

  // Partition techs into tiers by cost
  const tiers = [
    { name: 'Foundational Knowledge (10-25 Insight)', maxCost: 25, techs: [] },
    { name: 'Intermediate Architecture & Botany (30-65 Insight)', maxCost: 65, techs: [] },
    { name: 'Advanced Engineering & Synthesis (70-130 Insight)', maxCost: 130, techs: [] },
    { name: 'Mastery & Permanent Abundance (140+ Insight)', maxCost: Infinity, techs: [] },
  ];

  for (const t of research.techs) {
    for (const tier of tiers) {
      if (t.cost <= tier.maxCost) {
        tier.techs.push(t);
        break;
      }
    }
  }

  const tierEls = tiers.map((tier) => {
    const wrap = el('div', 'tree-tier-wrap');
    wrap.append(el('h3', 'section-sub', tier.name));
    const tierDiv = el('div', 'tree-tier');

    for (const t of tier.techs) {
      const node = el('div', `tree-node ${t.state}`);
      node.append(
        el('h4', '', t.name),
        el('span', `tag ${t.state === 'learned' ? 'ok' : t.state === 'learning' ? 'on' : ''}`, `${t.state.toUpperCase()} · ${t.cost} Insight`),
        el('small', '', t.text),
      );
      if (t.needs && t.needs.length) {
        const reqNames = t.needs.map((id) => techNameById.get(id) || id).join(', ');
        node.append(el('small', 'tree-reqs', `Requires: ${reqNames}`));
      }
      tierDiv.append(node);
    }
    wrap.append(tierDiv);
    return wrap;
  });

  fill('research-tree', tierEls);
}

// 5. Public Works with Category Filter
let currentWorksFilter = 'buildings';
function renderWorksList(works) {
  const buildings = works.filter((w) => !w.id.startsWith('map-'));
  const roads = works.filter((w) => w.id.startsWith('map-'));
  const waiting = works.filter((w) => !w.complete && w.next && w.next.waiting);

  const bDone = buildings.filter((w) => w.complete).length;
  const rDone = roads.filter((w) => w.complete).length;
  const summaryEl = $('works-summary');
  if (summaryEl) {
    summaryEl.textContent = `${bDone} of ${buildings.length} civic buildings complete · ${rDone} of ${roads.length} road & gateway segments complete. Each stage advances while a crew of two or more stands at the site.`;
  }

  const filterWrap = $('works-filters');
  if (filterWrap) {
    const counts = {
      buildings: `Buildings & Quarters (${bDone}/${buildings.length})`,
      roads: `Roads & Gateways (${rDone}/${roads.length})`,
      waiting: `Needs Crew / Research (${waiting.length})`,
      all: `All Works (${works.length})`,
    };
    filterWrap.querySelectorAll('button[data-filter]').forEach((btn) => {
      const f = btn.getAttribute('data-filter');
      if (counts[f]) btn.textContent = counts[f];
      btn.setAttribute('aria-pressed', String(f === currentWorksFilter));
    });
  }

  const filtered = currentWorksFilter === 'buildings' ? buildings
    : currentWorksFilter === 'roads' ? roads
    : currentWorksFilter === 'waiting' ? waiting
    : works;

  fill('works', filtered.length ? filtered.map((w) => {
    const c = el('div', 'card');
    const waitLabel = w.next && w.next.waiting
      ? (w.next.waiting.startsWith('waiting for research') ? 'waiting for research' : 'needs a crew')
      : '';
    c.append(
      el('h3', '', w.name),
      w.complete ? el('span', 'tag ok', 'finished') : waitLabel ? el('span', 'tag warn', waitLabel) : el('span', 'tag on', `${w.done} of ${w.total} stages`),
      bar(w.done, w.total),
      el('p', '', w.purpose),
    );
    if (w.next) {
      const hint = w.next.waiting
        ? (w.next.waiting.startsWith('waiting for research')
          ? `${w.next.waiting} (unlocked via village research)`
          : `${w.next.waiting}. Stand at the site with a neighbour to help build.`)
        : `in about ${mins(w.next.minutes)}`;
      c.append(el('p', '', `Next: ${w.next.title.toLowerCase()} — ${hint}.`));
    }
    return c;
  }) : [empty(currentWorksFilter === 'waiting' ? 'Every unlocked stage has a crew right now!' : 'No public works in this category.')]);
}

// ---- sections: each one redraws only when its own data changed, and says when -------------------

const lastSig = new Map();
const lastChanged = new Map();
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function empty(text) { return el('p', 'empty', text); }

function section(id, slice, draw, now) {
  const sig = JSON.stringify(slice);
  const first = !lastSig.has(id);
  if (first || lastSig.get(id) !== sig) {
    draw();
    lastSig.set(id, sig);
    lastChanged.set(id, now);
  }
  const stamp = $(`upd-${id}`);
  if (stamp) stamp.textContent = `Updated ${clock(lastChanged.get(id))}${now - lastChanged.get(id) > 60000 ? ' (unchanged since)' : ''}`;
}

function drawFeed(chronicle) {
  const list = $('chronicle');
  const more = $('feed-more');
  if (!list) return;
  const items = Array.isArray(chronicle) ? chronicle.filter(Boolean) : [];
  if (!items.length) {
    list.replaceChildren(el('li', 'empty', 'Nothing has happened yet. The first visit, harvest or finished stage will appear here.'));
    if (more) more.hidden = true;
    return;
  }
  const expanded = more && more.getAttribute('aria-expanded') === 'true';
  const shown = expanded ? items : items.slice(0, 6);
  list.replaceChildren(...shown.map((t, i) => {
    const li = el('li', i === 0 ? 'feed-item newest' : 'feed-item');
    li.append(el('span', 'feed-dot'), el('span', 'feed-text', t));
    return li;
  }));
  if (more) {
    more.hidden = items.length <= 6;
    more.textContent = expanded ? 'Show fewer' : `Show earlier activity (${items.length - 6} more)`;
  }
}

let lastOverview = null;
function render(d, tasksData, now = Date.now()) {
  lastOverview = d;
  $('purpose').textContent = d.purpose.text;
  section('purpose-section', d.purpose, () => {
    fill('principles', d.purpose.principles.map((p) => {
      const li = el('li');
      li.append(el('b', '', p.name + ' '), document.createTextNode(p.line));
      return li;
    }));
    if (d.purpose.goals && d.purpose.goals.length) renderGoalRings(d.purpose.goals);
    else fill('goals', [empty('No goals have been set yet. They will appear here once the village charter lists them.')]);
  }, now);

  section('life-section', [tasksData && tasksData.player_sim], () => renderLife(tasksData && tasksData.player_sim, now), now);
  section('action-panel', [d.rhythm, d.works, d.pantry, d.research.current, d.gameplay && d.gameplay.survey, tasksData], () => renderActionPanel(d, tasksData), now);
  section('gameplay-section', d.gameplay, () => renderGameplay(d.gameplay), now);
  section('village-map', [d.works, d.library], () => renderSvgMap(d), now);

  section('research-section', d.research, () => {
    const r = d.research;
    $('research-summary').textContent = `${r.insight} insight earned from ${r.sources.finds} finds, ${r.sources.stages} building stages, ${r.sources.projects} finished projects, ${r.sources.helped || 0} crew helps and ${r.sources.events} village events. ${r.learned} of ${r.total} technologies learned.`;
    fill('current', r.current
      ? [el('h3', '', `Now learning: ${r.current.name}`), el('p', 'muted', r.current.text), bar(r.current.progress, r.current.cost), el('small', 'muted', `${r.current.progress} of ${r.current.cost} insight`)]
      : [el('p', '', r.total ? 'Everything in the current research queue has been learned.' : 'No research is queued yet. The first find in the library starts it.')]);
    renderResearchTree(r);
  }, now);

  section('works-section', [d.works, currentWorksFilter], () => renderWorksList(d.works), now);

  section('community-section', [d.rhythm, d.pantry], () => {
    fill('rhythm', d.rhythm.length ? d.rhythm.map((e) => {
      const c = el('div', 'card');
      c.append(el('h3', '', e.title), el('span', e.on_now ? 'tag on' : 'tag', e.on_now ? `on now · ${e.minutes} min left` : `in ${mins(e.minutes)}`), el('p', '', `At ${e.place}. ${e.blurb}`));
      return c;
    }) : [empty('No gatherings are scheduled right now.')]);
    $('pantry').textContent = d.pantry && d.pantry.shelves ? `The village pantry holds ${d.pantry.shelves}.` : 'The pantry shelves are being restocked. Please look again soon.';
  }, now);

  section('library-section', d.library, () => fill('library', d.library.length ? d.library.map((l) => {
    const c = el('div', 'card');
    c.append(el('h3', '', l.name), el('span', l.found ? 'tag ok' : 'tag', l.found ? 'catalogued' : 'to find'), el('p', '', l.found ? l.finding : l.hint));
    return c;
  }) : [empty('The library has no catalogued places yet.')]), now);

  section('roles-section', d.roles, () => fill('roles', d.roles.length ? d.roles.map((x) => {
    const c = el('div', 'card');
    c.append(el('h3', '', `${x.title} (${x.count})`), el('p', '', x.purpose), el('p', '', x.daily), el('p', '', x.gives));
    return c;
  }) : [empty('No villager roles are listed yet.')]), now);

  section('activity-section', d.chronicle, () => drawFeed(d.chronicle), now);

  setStatus(`Checked ${clock(now)}`);
}

function setStatus(text) {
  const n = $('stamp');
  if (n) n.textContent = text;
}

let loaded = false;
let failures = 0;
async function load() {
  const retry = $('retry');
  try {
    const [resOverview, resTasks] = await Promise.allSettled([
      fetch('/api/v1/veloren/harr/overview', { headers: { accept: 'application/json' } }),
      fetch('/api/v1/veloren/harr/tasks', { headers: { accept: 'application/json' } }),
    ]);
    if (resOverview.status !== 'fulfilled' || !resOverview.value.ok) throw new Error('overview unavailable');
    const overviewData = await resOverview.value.json();
    let tasksData = null;
    if (resTasks.status === 'fulfilled' && resTasks.value.ok) tasksData = await resTasks.value.json();
    render(overviewData, tasksData);
    loaded = true;
    failures = 0;
    if (retry) retry.hidden = true;
  } catch {
    failures += 1;
    if (loaded) {
      setStatus(`The village is quiet just now; showing what was last recorded (${clock(Date.now())}). Retrying…`);
    } else {
      $('purpose').textContent = "Harr's records cannot be reached just now. This page will try again on its own.";
      fill('actions-grid', [empty('Nothing to show until the village answers. You can try again now, or ask Selene in the game: tasks.')]);
      setStatus('Waiting for Harr…');
    }
    if (retry) retry.hidden = false;
  }
}

function setupFeed() {
  const more = $('feed-more');
  if (more) more.addEventListener('click', () => {
    more.setAttribute('aria-expanded', String(more.getAttribute('aria-expanded') !== 'true'));
    if (lastOverview) drawFeed(lastOverview.chronicle);
  });
  const retry = $('retry');
  if (retry) retry.addEventListener('click', () => { setStatus('Trying again…'); load(); });
  const filterWrap = $('works-filters');
  if (filterWrap) {
    filterWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-filter]');
      if (!btn) return;
      currentWorksFilter = btn.getAttribute('data-filter') || 'buildings';
      if (lastOverview) section('works-section', [lastOverview.works, currentWorksFilter], () => renderWorksList(lastOverview.works), Date.now());
    });
  }
}

setupTheme();
setupCompact();
setupWelcome();
setupKeys();
setupFeed();
load();
// Refresh politely: slower while the tab is hidden, and a failing server is not hammered.
(function tick() {
  const wait = document.hidden ? 60000 : Math.min(60000, 10000 * (1 + Math.min(failures, 5)));
  setTimeout(() => { if (!document.hidden || failures === 0) load(); tick(); }, wait);
})();
