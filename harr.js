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

// Theme Toggle
function setupTheme() {
  const saved = localStorage.getItem('harr-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  }
  const btn = $('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('harr-theme', next);
    });
  }
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
      el('p', '', `${cur.progress} of ${cur.cost} insight accumulated. Every discovery you record adds insight for the whole village!`),
    );
    actions.push(card);
  }

  fill('actions-grid', actions);
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
      tierDiv.append(node);
    }
    wrap.append(tierDiv);
    return wrap;
  });

  fill('research-tree', tierEls);
}

// Main Render Function
function render(d, tasksData) {
  $('purpose').textContent = d.purpose.text;
  fill(
    'principles',
    d.purpose.principles.map((p) => {
      const li = el('li');
      li.append(el('b', '', p.name + ' '), document.createTextNode(p.line));
      return li;
    }),
  );

  // 1. "What can I do now" Panel
  renderActionPanel(d, tasksData);

  // 2. SVG Map
  renderSvgMap(d);

  // 3. Goal Rings
  renderGoalRings(d.purpose.goals);

  // 4. Research Tree
  const r = d.research;
  $('research-summary').textContent = `${r.insight} insight earned from ${r.sources.finds} finds, ${r.sources.stages} building stages, ${r.sources.projects} finished projects and ${r.sources.events} village events. ${r.learned} of ${r.total} technologies learned.`;
  fill(
    'current',
    r.current
      ? [
          el('h3', '', `Now learning: ${r.current.name}`),
          el('p', 'muted', r.current.text),
          bar(r.current.progress, r.current.cost),
          el('small', 'muted', `${r.current.progress} of ${r.current.cost} insight`),
        ]
      : [el('p', '', 'Everything in the current research queue has been learned.')],
  );
  renderResearchTree(r);

  // 5. Public Works
  fill(
    'works',
    d.works.map((w) => {
      const c = el('div', 'card');
      c.append(
        el('h3', '', w.name),
        w.complete
          ? el('span', 'tag ok', 'finished')
          : w.next && w.next.waiting
          ? el('span', 'tag warn', 'needs a crew')
          : el('span', 'tag on', `${w.done} of ${w.total} stages`),
        bar(w.done, w.total),
        el('p', '', w.purpose),
      );
      if (w.next) {
        c.append(
          el(
            'p',
            '',
            `Next: ${w.next.title.toLowerCase()} — ${
              w.next.waiting ? `${w.next.waiting}. Join the builders to help.` : `in about ${mins(w.next.minutes)}`
            }.`,
          ),
        );
      }
      return c;
    }),
  );

  // 6. Community & Pantry
  fill(
    'rhythm',
    d.rhythm.map((e) => {
      const c = el('div', 'card');
      c.append(
        el('h3', '', e.title),
        el('span', e.on_now ? 'tag on' : 'tag', e.on_now ? `on now · ${e.minutes} min left` : `in ${mins(e.minutes)}`),
        el('p', '', `At ${e.place}. ${e.blurb}`),
      );
      return c;
    }),
  );
  $('pantry').textContent = `The village pantry holds ${d.pantry.shelves}.`;

  // 7. Library
  fill(
    'library',
    d.library.map((l) => {
      const c = el('div', 'card');
      c.append(
        el('h3', '', l.name),
        el('span', l.found ? 'tag ok' : 'tag', l.found ? 'catalogued' : 'to find'),
        el('p', '', l.found ? l.finding : l.hint),
      );
      return c;
    }),
  );

  // 8. Villager Roles
  fill(
    'roles',
    d.roles.map((x) => {
      const c = el('div', 'card');
      c.append(el('h3', '', `${x.title} (${x.count})`), el('p', '', x.purpose), el('p', '', x.daily), el('p', '', x.gives));
      return c;
    }),
  );

  // 9. Chronicle
  fill(
    'chronicle',
    d.chronicle.map((t) => el('li', '', t)),
  );

  $('stamp').textContent = `Updated ${new Date(d.generated_at).toLocaleTimeString()}`;
}

async function load() {
  try {
    const [resOverview, resTasks] = await Promise.allSettled([
      fetch('/api/v1/veloren/harr/overview', { headers: { accept: 'application/json' } }),
      fetch('/api/v1/veloren/harr/tasks', { headers: { accept: 'application/json' } }),
    ]);

    if (resOverview.status !== 'fulfilled' || !resOverview.value.ok) {
      throw new Error('overview unavailable');
    }

    const overviewData = await resOverview.value.json();
    let tasksData = null;
    if (resTasks.status === 'fulfilled' && resTasks.value.ok) {
      tasksData = await resTasks.value.json();
    }

    render(overviewData, tasksData);
  } catch {
    $('stamp').textContent = 'The village is quiet just now; retrying…';
  }
}

setupTheme();
load();
setInterval(load, 10000);
