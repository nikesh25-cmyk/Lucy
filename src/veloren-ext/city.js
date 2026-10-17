// Guest-facing city services. Reuse the authoritative land registry and cottage keeper;
// a guest request never becomes an AI runtime credential or a second land/reward ledger.
import { LIVING_ROSTER } from '../living-world.js';
import { VILLAGERS } from './villagers.js';
import { identityFor } from './identity.js';
import { HomeService, HOME_KEEPERS } from './home.js';
import { buildOverview } from './overview.js';
import { spendRate } from './view.js';
import { nativeHomePlot, groundReport, defaultPlotsPath } from './home-site.js';
export { nativeHomePlot } from './home-site.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const METRICS = Object.freeze({
  registry: { width: 6, height: 6, area: 36, unit: 'conceptual registry units' },
  native: { pitch: 14, pad_width: 12, pad_height: 12, unit: 'Veloren blocks' },
  note: 'Registry dimensions and native block placement are different projections. Neither is real land ownership.',
});
const OFFICES = Object.freeze([
  { id: 'architecture', title: 'Architecture & public works', role: 'builder', site: 'site-cottage-row', purpose: 'Build and maintain places people can use.', output: 'Saved native construction acknowledgements and public work stages.' },
  { id: 'farming', title: 'Urban farming', role: 'farmer', site: 'site-vfarm', purpose: 'Care for gardens and the shared pantry.', output: 'The native pantry currently uses a labelled scripted restock; it is not an individual farmer harvest.' },
  { id: 'research', title: 'Research & archive', role: 'scholar', site: 'site-tower', purpose: 'Find, explain and check useful knowledge.', output: 'Recorded discoveries and research progress; independent evidence work still needs the mission review process.' },
  { id: 'design', title: 'Design & making', role: 'maker', site: 'site-pavilion', purpose: 'Make useful and welcoming shared spaces.', output: 'Existing public work stages; attendance alone is not a finished design.' },
  { id: 'logistics', title: 'City connections', role: 'courier', site: 'site-skywalk', purpose: 'Help people find places and understand what changed.', output: 'The chronicle reads saved world facts.' },
  { id: 'hospitality', title: 'Community & hospitality', role: 'keeper', site: 'site-transit', purpose: 'Welcome guests and host the city’s shared life.', output: 'Existing gathering schedules and recorded participation.' },
]);


function strict(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) fail(400, 'Use only the home request fields.');
}


export class CityService {
  constructor(link, platform, { plotsPath = defaultPlotsPath() } = {}) { this.link = link; this.platform = platform; this.plotsPath = plotsPath; this.keeper = new HomeService(link, platform, { plotsPath }); }

  #guest(actor, write = false) {
    if (!actor?.account) fail(401, 'Sign in to request a home.');
    if (actor.kind !== 'session') fail(403, 'A guest session is required; AI and bridge credentials cannot claim a home.');
    if (this.platform.get('SELECT status FROM accounts WHERE id=?', actor.account.id)?.status !== 'active') fail(403, 'This guest account is not active.');
    if (write) this.platform.active();
    return actor;
  }

  #linked(actor) {
    const row = this.link.sql.get('SELECT player_uuid FROM ident_links WHERE account_id=?', actor.account.id);
    const who = row ? identityFor(this.link, row.player_uuid) : null;
    if (!who || who.account_id !== actor.account.id || !who.agent_id) return null;
    const avatar = this.platform.get('SELECT kind,status FROM agents WHERE id=? AND operator_id=?', who.agent_id, actor.account.id);
    return avatar?.kind === 'human' && avatar.status === 'active' ? { ...who, player_uuid: row.player_uuid } : null;
  }

  directory() {
    const overview = buildOverview(this.link);
    return {
      name: 'NemoWorld', human_role: 'guest', generated_at: this.link.clock(),
      purpose: 'AI residents build, learn and care for a peaceful city. Human guests explore and talk with them.',
      execution: 'The current native residents follow scripted schedules. Moving or speaking is not evidence of model inference or completed research.',
      offices: OFFICES.map(office => ({ ...office, residents: VILLAGERS.filter(r => r.role === office.role).length })),
      residents: [...LIVING_ROSTER, ...VILLAGERS].map(r => ({ id: r.id, name: r.name, calling: r.calling, source: 'scripted' })),
      works: overview.works, research: overview.research,
      learning: { title: 'School & university', site: 'site-schoolhouse', status: 'Existing schoolhouse, research and apprenticeship activities. Resident enrollment and qualifications are not implemented.' },
      lifecycle: { implemented: false, status: 'Households, marriages, children and age-based education are planned; no fictional life events have been backfilled.' },
      rewards: 'City activity and home requests do not issue NemoCoins. Independent acceptance of eligible evidence work uses the existing review system.',
    };
  }

  home(actor) {
    this.#guest(actor);
    const who = this.#linked(actor);
    const ground = groundReport(this.plotsPath);
    const mine = this.platform.land(actor, { mine: '1', limit: 1 }).mine;
    const available = this.platform.land(actor, { world_id: 'frontier:0:0', status: 'available', limit: 50 }).plots
      .filter(p => nativeHomePlot(p.id) && ground.state !== 'unavailable' && (!ground.suitable || ground.suitable.get(p.id) === true)).map(p => ({ id: p.id, x: p.plot_x, y: p.plot_y }));
    const home = who ? this.keeper.view(who.player_uuid) : { plot: mine?.id || null, built: 'none', can_enter: false };
    return {
      linked: Boolean(who), paused: this.platform.get("SELECT value FROM settings WHERE key='paused'")?.value === 'true',
      builder: { id: HOME_KEEPERS[0], name: 'Rowan', source: 'scripted', description: 'A scripted AI keeper asks the game server to build your chosen cottage.' },
      metrics: METRICS, available: mine ? [] : available, home, ground: ground.state,
      compatible: !mine || nativeHomePlot(mine.id), command_channel: Boolean(this.link.commands),
      construction_blocked: Boolean(mine?.block_count && home.built !== 'built'),
      next: !who ? 'Link your current Veloren human character to this account, then return.'
        : mine && !nativeHomePlot(mine.id) ? 'Your existing plot is preserved. Native cottages currently support only compatible Commons plots; use the land workspace to review your options.'
        : home.built === 'built' ? 'Your cottage is confirmed. Ask Rowan to enter or leave.'
        : mine?.block_count ? 'Your plot already contains saved browser construction. It is preserved; Rowan cannot stamp a cottage over it. Review the existing construction in the land workspace first.'
        : home.built === 'building' ? 'Rowan has requested construction. Wait for the game server’s confirmation; do not claim another plot.'
        : home.built === 'failed' ? 'The game refused construction. Your plot remains claimed; check terrain and retry with Rowan.'
        : home.built === 'unconfirmed' ? 'Confirmation timed out. Your claim is saved; check the game server before retrying.'
        : 'Choose an available plot and ask Rowan to build a free home. The game server checks the ground.',
    };
  }

  requestHome(actor, input) {
    this.#guest(actor, true);
    strict(input, ['plot_id', 'style']);
    if (!Number.isInteger(input.style) || input.style < 0 || input.style > 7 || typeof input.plot_id !== 'string') fail(400, 'Choose a plot and an integer roof style from 0 to 7.');
    const who = this.#linked(actor);
    if (!who) fail(409, 'Link an active Veloren human character before requesting a home.');
    if (!nativeHomePlot(input.plot_id)) fail(409, 'This plot is outside the current native cottage layout. Your land has not changed.');
    const ground = groundReport(this.plotsPath);
    if (ground.state === 'unavailable') fail(503, 'The game’s plot survey is unavailable. Your plot has not changed; start the native server and refresh.');
    if (ground.suitable && ground.suitable.get(input.plot_id) !== true) fail(409, 'The game’s ground survey marks this plot unsuitable. Your land has not changed.');
    if (!this.link.commands) fail(503, 'The game command channel is unavailable. No new plot was assigned.');
    const mine = this.platform.land(actor, { mine: '1', limit: 1 }).mine;
    if (mine && mine.id !== input.plot_id) fail(409, 'You already have a plot. It has been preserved; this request cannot change or release it.');
    if (mine?.block_count) fail(409, 'This plot contains saved construction. It and your claim are preserved; no native cottage command was issued.');
    const saved = this.keeper.view(who.player_uuid);
    // An old claim is not necessarily an existing native home. Set privacy for a new cottage on
    // either path, while preserving an already requested/confirmed home's chosen visiting setting.
    if (!mine || !['building', 'built'].includes(saved.built)) this.platform.transaction(() => {
      if (!mine) this.platform.landAssign(actor, { plot_id: input.plot_id, purpose: 'Private guest home', description: 'Requested by the guest; construction handled by Rowan’s scripted native home service.' });
      this.platform.homeSettings(actor, who.agent_id, { house_visibility: 'private' });
    });
    if (!['building', 'built'].includes(saved.built)) this.#ask(who, `build my home in style ${input.style}`);
    return this.home(actor);
  }

  #ask(who, text) {
    // This is an internal service call after the guest's authenticated request. No credential is
    // created or returned. The keeper still resolves plot/door rules and signs through the link.
    return this.keeper.ask({ resident_id: HOME_KEEPERS[0] }, { resident_id: HOME_KEEPERS[0], player_uuid: who.player_uuid, text });
  }

  homeAction(actor, input) {
    this.#guest(actor);
    strict(input, ['action']);
    if (!['enter', 'leave'].includes(input.action)) fail(400, 'Choose enter or leave.');
    // Pause stops new activity, but an authenticated guest must retain the escape path.
    if (input.action === 'enter') this.platform.active();
    const who = this.#linked(actor);
    if (!who) fail(409, 'Link an active Veloren human character first.');
    const answer = this.#ask(who, input.action);
    return { ...this.home(actor), reply: answer.reply };
  }
}

export const cityExtension = {
  name: 'city',
  async handle(link, ctx) {
    if (ctx.route !== '/veloren/city' && !ctx.route.startsWith('/veloren/city/')) return false;
    if (!ctx.platform) fail(503, 'The city platform is unavailable.');
    const city = new CityService(link, ctx.platform);
    if (ctx.request.method === 'GET' && ctx.route === '/veloren/city') {
      spendRate(link, '*city', { gapMs: 0, perHour: 720 });
      ctx.json(ctx.response, 200, city.directory()); return true;
    }
    const actor = ctx.platform.authenticate(ctx.tokenFrom(ctx.request));
    if (ctx.request.method === 'GET' && ctx.route === '/veloren/city/home') { ctx.json(ctx.response, 200, city.home(actor)); return true; }
    if (ctx.request.method === 'POST' && ctx.route === '/veloren/city/home/request') { ctx.json(ctx.response, 200, city.requestHome(actor, await ctx.body(ctx.request))); return true; }
    if (ctx.request.method === 'POST' && ctx.route === '/veloren/city/home/action') { ctx.json(ctx.response, 200, city.homeAction(actor, await ctx.body(ctx.request))); return true; }
    ctx.json(ctx.response, 404, { error: 'Not found.' }); return true;
  },
};
