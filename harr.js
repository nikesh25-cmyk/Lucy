'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const pct = (a, b) => `${Math.max(0, Math.min(100, b ? Math.round((a / b) * 100) : 0))}%`;
function bar(a, b) { const t = el('div', 'bar'); const i = el('i'); i.style.width = pct(a, b); t.append(i); return t; }
const mins = (m) => (m === null ? 'soon' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
function fill(id, children) { const n = $(id); n.replaceChildren(...children); }

function render(d) {
  $('purpose').textContent = d.purpose.text;
  fill('principles', d.purpose.principles.map((p) => { const li = el('li'); li.append(el('b', '', p.name + ' '), document.createTextNode(p.line)); return li; }));
  fill('goals', d.purpose.goals.map((g) => {
    const c = el('div', 'card'); c.append(el('h3', '', g.title), g.done ? el('span', 'tag ok', 'done') : el('span', 'tag', `${g.progress} of ${g.target}`), bar(g.progress, g.target), el('p', '', g.why)); return c;
  }));
  const r = d.research;
  $('research-summary').textContent = `${r.insight} insight earned from ${r.sources.finds} finds, ${r.sources.stages} building stages, ${r.sources.projects} finished projects and ${r.sources.events} village events. ${r.learned} of ${r.total} technologies learned.`;
  fill('current', r.current ? [el('h3', '', `Now learning: ${r.current.name}`), el('p', 'muted', r.current.text), bar(r.current.progress, r.current.cost), el('small', 'muted', `${r.current.progress} of ${r.current.cost} insight`)] : [el('p', '', 'Everything in the queue has been learned.')]);
  fill('techs', r.techs.map((t) => { const li = el('li', t.state); li.append(el('b', '', t.name), el('small', '', `${t.state} · ${t.cost} insight`), el('small', '', t.text)); return li; }));
  fill('works', d.works.map((w) => {
    const c = el('div', 'card'); c.append(el('h3', '', w.name), w.complete ? el('span', 'tag ok', 'finished') : w.next && w.next.waiting ? el('span', 'tag warn', 'needs a crew') : el('span', 'tag on', `${w.done} of ${w.total} stages`), bar(w.done, w.total), el('p', '', w.purpose));
    if (w.next) c.append(el('p', '', `Next: ${w.next.title.toLowerCase()} — ${w.next.waiting ? `${w.next.waiting}. Join the builders to help.` : `in about ${mins(w.next.minutes)}`}.`));
    return c;
  }));
  fill('rhythm', d.rhythm.map((e) => { const c = el('div', 'card'); c.append(el('h3', '', e.title), el('span', e.on_now ? 'tag on' : 'tag', e.on_now ? `on now · ${e.minutes} min left` : `in ${mins(e.minutes)}`), el('p', '', `At ${e.place}. ${e.blurb}`)); return c; }));
  $('pantry').textContent = `The village pantry holds ${d.pantry.shelves}. It is free for everyone, restocked from our fields (scripted).`;
  fill('chronicle', d.chronicle.map((t) => el('li', '', t)));
  fill('library', d.library.map((l) => { const c = el('div', 'card'); c.append(el('h3', '', l.name), el('span', l.found ? 'tag ok' : 'tag', l.found ? 'catalogued' : 'to find'), el('p', '', l.found ? l.finding : l.hint)); return c; }));
  fill('roles', d.roles.map((x) => { const c = el('div', 'card'); c.append(el('h3', '', `${x.title} (${x.count})`), el('p', '', x.purpose), el('p', '', x.daily), el('p', '', x.gives)); return c; }));
  $('stamp').textContent = `Updated ${new Date(d.generated_at).toLocaleTimeString()}`;
}

async function load() {
  try {
    const res = await fetch('/api/v1/veloren/harr/overview', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    $('stamp').textContent = 'Could not reach the village just now; trying again.';
  }
}
load();
setInterval(load, 10000);
