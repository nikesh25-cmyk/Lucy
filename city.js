const $ = id => document.getElementById(id);
const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
const base = '/api/v1/veloren/city';
let savedHome = null;
let busy = false;
let timer;
let cityTimer;
let cityLoading = false;

async function api(path, input) {
  const response = await fetch(base + path, { credentials: 'same-origin', ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'The city could not answer. Try again.'), { status: response.status });
  return data;
}

function card(title, content, extra, number) {
  const el = text('article', '', 'card');
  if (number) el.append(text('p', number, 'number'));
  el.append(text('h3', title), text('p', content));
  if (extra) el.append(text('small', extra));
  return el;
}

async function loadCity() {
  if (cityLoading) return;
  clearTimeout(cityTimer); cityLoading = true;
  try {
    const city = await api('');
    $('offices').replaceChildren(...city.offices.map((o, i) => card(o.title, o.purpose, o.output, `0${i + 1} / ${o.residents} RESIDENTS`)));
    $('execution').textContent = city.execution;
    const works = [...(city.simulation?.construction || []), ...city.works];
    const unfinished = works.filter(w => !w.complete);
    const featured = [...unfinished, ...works.filter(w => w.complete)].slice(0, 8);
    $('works').replaceChildren(...featured.map(w => {
      const el = card(w.name, w.purpose, `${w.done} of ${w.total} stages saved${w.next?.waiting ? ` · ${w.next.waiting}` : ''}`, w.complete ? 'SAVED IN THE WORLD' : 'IN PROGRESS');
      const bar = document.createElement('progress'); bar.max = w.total || 1; bar.value = w.done; bar.setAttribute('aria-label', `${w.name}: ${w.done} of ${w.total} stages`); el.append(bar); return el;
    }));
    $('research').textContent = city.research.current ? `Learning now: ${city.research.current.name} · ${city.research.current.progress}/${city.research.current.cost} insight` : `${city.research.learned} research topics learned.`;
    const people = city.residents.map(r => {
      const el = text('article', '', 'person');
      const avatar = text('span', r.name.split(' ').map(s => s[0]).slice(0, 2).join(''), 'avatar'); avatar.setAttribute('aria-hidden', 'true');
      const name = text('p', r.name); name.append(text('small', `${r.calling} · scripted`)); el.append(avatar, name); return el;
    });
    const expanded = $('people').querySelector('details')?.open;
    const focusedSummary = document.activeElement === $('people').querySelector('summary');
    $('people').replaceChildren(...people.slice(0, 8));
    if (people.length > 8) {
      const more = document.createElement('details'); more.className = 'more-residents';
      more.open = !!expanded;
      more.append(text('summary', `Meet ${people.length - 8} more residents`));
      const rest = text('div', '', 'people'); rest.append(...people.slice(8)); more.append(rest); $('people').append(more);
      if (focusedSummary) more.querySelector('summary').focus({ preventScroll: true });
    }
    if (city.simulation?.enabled) {
      $('people').prepend(...city.simulation.citizens.map(c => card(c.name, `${c.stage} · ${c.role}`, 'Native city resident · scripted')));
    }
    $('rewards').textContent = city.rewards;
    $('learning').textContent = city.learning.status;
    $('lifecycle').textContent = city.lifecycle.status;
    $('families').replaceChildren(...(city.simulation?.households || []).map(home => {
      const members = city.simulation.citizens.filter(c => c.household_id === home.id);
      const adults = [home.adult_a, home.adult_b].map(id => members.find(c => c.id === id)?.name).filter(Boolean).join(' & ');
      const established = city.simulation.marriages.some(m => m.household_id === home.id);
      return card(adults || 'City household', members.map(c => `${c.name} · ${c.stage}`).join(' / '), established ? 'Household established through recorded native visits.' : 'Preapproved fictional household; waiting for both residents to visit.');
    }));
    $('connection').textContent = `World records checked at ${new Date(city.generated_at).toLocaleTimeString()}. Construction counts come from the game’s saved record.`;
  } catch (error) { $('connection').textContent = error.status === 404 ? 'The native city connection is not enabled on this server.' : error.message; }
  finally { cityLoading = false; if (!document.hidden) cityTimer = setTimeout(loadCity, 15_000); }
}

function renderHome(view) {
  if (savedHome?.home.built !== view.home.built || savedHome?.home.plot !== view.home.plot) {
    $('home-feedback').textContent = view.home.built === 'built' ? 'Construction confirmed by the game server.' : '';
  }
  savedHome = view;
  clearTimeout(timer);
  $('home-status').textContent = view.paused ? `The world is paused. ${view.next}` : view.next;
  $('home-details').replaceChildren();
  if (view.home.plot) {
    for (const [label, value] of [['Plot', view.home.plot], ['Construction', view.home.built], ['Builder', 'Rowan · scripted']]) $('home-details').append(text('dt', label), text('dd', value));
  }
  $('home-details').hidden = !view.home.plot;
  $('metrics').hidden = false;
  $('metrics').textContent = `Registry parcel: ${view.metrics.registry.width} × ${view.metrics.registry.height} conceptual units. Native build pad: ${view.metrics.native.pad_width} × ${view.metrics.native.pad_height} blocks on a ${view.metrics.native.pitch}-block grid. These are different scales. ${view.ground === 'estimated' ? 'The picker uses the game’s ground estimate; final acceptance stays with the game server.' : view.ground === 'unavailable' ? 'The game’s ground survey is unavailable; new home requests are paused.' : 'No native ground estimate is configured; terrain will be checked during construction.'}`;
  const canRequest = view.linked && view.compatible && !view.construction_blocked && view.ground !== 'unavailable' && view.command_channel && !view.paused && !['building', 'built'].includes(view.home.built);
  const plots = view.home.plot ? [{ id: view.home.plot }] : view.available;
  $('plot').replaceChildren(...plots.map(p => { const option = text('option', p.id); option.value = p.id; return option; }));
  $('home-form').hidden = !canRequest || !plots.length;
  $('request-home').textContent = view.home.plot ? 'Ask Rowan to retry construction' : 'Ask Rowan to build my home';
  $('enter-home').hidden = view.paused || !view.home.can_enter || !view.compatible;
  $('leave-home').hidden = view.home.built !== 'built' || !view.compatible;
  if (canRequest && !plots.length) $('home-status').textContent = 'No supported free home plots are available right now. Existing homes and public passages are preserved.';
  if (!view.command_channel) $('home-status').textContent += ' The game command channel is unavailable.';
  if (view.home.built === 'building' && !document.hidden) timer = setTimeout(() => loadHome(), 5000);
}

async function loadHome() {
  try { renderHome(await api('/home')); }
  catch (error) {
    savedHome = null; clearTimeout(timer);
    $('home-feedback').textContent = '';
    $('home-form').hidden = true; $('home-details').hidden = true; $('metrics').hidden = true;
    $('enter-home').hidden = true; $('leave-home').hidden = true;
    $('home-status').textContent = error.status === 401 ? 'Sign in to your NemoWorld account to see your private home request. You can explore the city directory without an account.' : error.message;
  }
}

async function act(path, input) {
  if (busy) return;
  busy = true;
  for (const button of $('home').querySelectorAll('button')) button.disabled = true;
  $('home-feedback').textContent = 'Asking Rowan…';
  try {
    const view = await api(path, input); renderHome(view);
    $('home-feedback').textContent = view.reply || (view.home.built === 'building' ? 'Request saved. Waiting for the game server to confirm construction.' : view.next);
  } catch (error) {
    // A plot can be saved before command delivery fails. Re-read instead of clearing it locally.
    await loadHome(); $('home-feedback').textContent = error.message;
  } finally { busy = false; for (const button of $('home').querySelectorAll('button')) button.disabled = false; }
}

$('home-form').addEventListener('submit', e => { e.preventDefault(); if (savedHome) act('/home/request', { plot_id: $('plot').value, style: Number($('style').value) }); });
$('enter-home').addEventListener('click', () => act('/home/action', { action: 'enter' }));
$('leave-home').addEventListener('click', () => act('/home/action', { action: 'leave' }));
$('refresh-home').addEventListener('click', () => { if (!busy) loadHome(); });
document.addEventListener('visibilitychange', () => { clearTimeout(timer); clearTimeout(cityTimer); if (!document.hidden) { loadCity(); if (!busy) loadHome(); } });
await Promise.allSettled([loadCity(), loadHome()]);

for (const [id, destination] of [['visit-city','city'],['return-harr','harr']]) $(id).addEventListener('click', async () => {
  $(id).disabled = true;
  try {
    const request = await api('/visit', {destination}); $('travel-status').textContent = request.message;
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const result = await api(`/travel?cmd_id=${encodeURIComponent(request.cmd_id)}`);
      if (result.status === 'pending') continue;
      $('travel-status').textContent = result.status === 'applied' ? 'Arrival confirmed by the game server.' : result.status === 'rejected' ? 'The game refused travel. Keep your linked human character online and try again.' : 'Arrival was not confirmed. Check your game before retrying.';
      return;
    }
    $('travel-status').textContent = 'Arrival was not confirmed. Check your game before retrying.';
  }
  catch (error) { $('travel-status').textContent = error.message; }
  finally { $(id).disabled = false; }
});
