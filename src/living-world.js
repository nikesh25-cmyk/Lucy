import { randomUUID } from 'node:crypto';
import { worldAtmosphere } from './atmosphere.js';
import { ensureTradeMarket } from './trade-market.js';
import { Platform } from './platform.js';


export const LIVING_ROSTER = Object.freeze([
  {
    id: 'lw-aria',
    operatorKey: 'botanists',
    name: 'Aria Greenfield',
    calling: 'cultivator',
    color: '#397f79',
    symbol: '✿',
    capabilities: 'Master herbalist and caretaker of living gardens.',
    limitations: 'Pacifist cultivator; trades harvests fairly.',
    startX: 42,
    startY: 25,
    destinations: {
      dawn: { x: 20, y: 18, label: 'Central Plaza' },
      day: { x: 42, y: 25, label: 'Orchard' },
      dusk: { x: 15, y: 4, label: 'Peace Pavilion' },
      night: { x: 11, y: 7, label: 'Meeting Hall' },
    },
    barks: [
      'The soil by the orchard is rich with blossom resin today.',
      'A patient harvest yields the sweetest medicine.',
      'Have you tended your garden patches this morning, traveler?',
      'Blossom and fiber weave together into fine garments at the loom.',
    ],
  },
  {
    id: 'lw-theron',
    operatorKey: 'artisans',
    name: 'Theron Stonehand',
    calling: 'builder',
    color: '#aa7845',
    symbol: '▲',
    capabilities: 'Architect of enduring stone monuments and cozy shelters.',
    limitations: 'Builds only within stewarded plots and clear ways.',
    startX: 20,
    startY: 18,
    destinations: {
      dawn: { x: 11, y: 7, label: 'Meeting Hall' },
      day: { x: 20, y: 18, label: 'Central Plaza' },
      dusk: { x: 30, y: 15, label: 'Workshop' },
      night: { x: 11, y: 7, label: 'Meeting Hall' },
    },
    barks: [
      'Every great sanctuary starts with a single level foundation block.',
      'Keep the public ways clear, and every traveler will bless your stone.',
      'Checking the alignment of the central fountain pillars.',
      'Stone and slate from the western quarry make sturdy hearths.',
    ],
  },
  {
    id: 'lw-bram',
    operatorKey: 'botanists',
    name: 'Bram Wayfarer',
    calling: 'explorer',
    color: '#3d5875',
    symbol: '✦',
    capabilities: 'Wayfinder charting frontier passages and distant portals.',
    limitations: 'Travels only on foot; respects frontier boundaries.',
    startX: 50,
    startY: 40,
    destinations: {
      dawn: { x: 50, y: 40, label: 'Harbor' },
      day: { x: 20, y: 18, label: 'Central Plaza' },
      dusk: { x: 60, y: 12, label: 'Observatory' },
      night: { x: 11, y: 7, label: 'Meeting Hall' },
    },
    barks: [
      'The horizon over the harbor is clear; another world lies beyond the gates.',
      'A true cartographer knows every bridge and river crossing by heart.',
      'The frontier expands step by step, area by connected area.',
      'Have you climbed to the Observatory yet? The sky cycle is breathtaking.',
    ],
  },
  {
    id: 'lw-lyra',
    operatorKey: 'botanists',
    name: 'Lyra Scrollkeeper',
    calling: 'researcher',
    color: '#8c6ab1',
    symbol: '◆',
    capabilities: 'Archive scholar cataloging verifiable knowledge and evidence.',
    limitations: 'Accepts only independently reviewed facts.',
    startX: 22,
    startY: 10,
    destinations: {
      dawn: { x: 11, y: 7, label: 'Meeting Hall' },
      day: { x: 22, y: 10, label: 'Library' },
      dusk: { x: 15, y: 4, label: 'Peace Pavilion' },
      night: { x: 22, y: 10, label: 'Library' },
    },
    barks: [
      'An unverified claim is only an intention; real knowledge needs proof.',
      'The World Assembly catalog contains records from 248 countries and areas.',
      'Every calling adds an essential thread to the tapestry of NemoWorld.',
      'Reading through the latest regional agricultural briefs in the archive.',
    ],
  },
  {
    id: 'lw-kael',
    operatorKey: 'artisans',
    name: 'Kael Hearthforge',
    calling: 'artisan',
    color: '#cb725f',
    symbol: '▲',
    capabilities: 'Master weaver and blacksmith crafting keepsakes and tools.',
    limitations: 'Crafts only from real harvested and gathered resources.',
    startX: 30,
    startY: 15,
    destinations: {
      dawn: { x: 20, y: 18, label: 'Central Plaza' },
      day: { x: 30, y: 15, label: 'Workshop' },
      dusk: { x: 30, y: 15, label: 'Workshop' },
      night: { x: 11, y: 7, label: 'Meeting Hall' },
    },
    barks: [
      'I have fresh wreaths and banners ready at the workbench.',
      'Check the trade board! I am trading crafted keepsakes for timber and resin.',
      'Patience at the crafting station turns raw fiber into ceremonial beauty.',
      'The forge burns steady; what keepsake shall we shape next?',
    ],
  },
  {
    id: 'lw-selene',
    operatorKey: 'artisans',
    name: 'Selene Dawnbringer',
    calling: 'host',
    color: '#cb725f',
    symbol: '✿',
    capabilities: 'Warm host welcoming travelers to the Peace Pavilion.',
    limitations: 'Welcomes everyone; refuses conflict.',
    startX: 15,
    startY: 4,
    destinations: {
      dawn: { x: 15, y: 4, label: 'Peace Pavilion' },
      day: { x: 15, y: 4, label: 'Peace Pavilion' },
      dusk: { x: 11, y: 7, label: 'Meeting Hall' },
      night: { x: 15, y: 4, label: 'Peace Pavilion' },
    },
    barks: [
      'Welcome to NemoWorld, friend! The Peace Pavilion is open to all.',
      'If you are seeking direction, the first-play guide can show you the way.',
      'Gatherings are richer when voices from many callings meet.',
      'Take a seat on the pavilion cushions and let the world turn peacefully.',
    ],
  },
  {
    id: 'lw-vaelen',
    operatorKey: 'artisans',
    name: 'Vaelen Kindred',
    calling: 'mediator',
    color: '#8c6ab1',
    symbol: '✦',
    capabilities: 'Community mediator fostering cooperative milestones.',
    limitations: 'Shares appreciation; acts without coercion.',
    startX: 11,
    startY: 7,
    destinations: {
      dawn: { x: 11, y: 7, label: 'Meeting Hall' },
      day: { x: 20, y: 18, label: 'Central Plaza' },
      dusk: { x: 11, y: 7, label: 'Meeting Hall' },
      night: { x: 11, y: 7, label: 'Meeting Hall' },
    },
    barks: [
      'Gratitude given freely creates stronger bonds than any trade.',
      'Have you pledged to a community circle project this week?',
      'Cooperative milestones bring human and AI residents into harmony.',
      'A kind word spoken in the Commons echoes through the entire realm.',
    ],
  },
  {
    id: 'lw-rowan',
    operatorKey: 'botanists',
    name: 'Rowan Commonreach',
    calling: 'steward',
    color: '#397f79',
    symbol: '◆',
    capabilities: 'Frontier steward paving roads and connecting common lands.',
    limitations: 'Maintains passages; preserves finite land boundaries.',
    startX: 19,
    startY: 6,
    destinations: {
      dawn: { x: 19, y: 6, label: 'Gateway' },
      day: { x: 20, y: 18, label: 'Central Plaza' },
      dusk: { x: 50, y: 40, label: 'Harbor' },
      night: { x: 11, y: 7, label: 'Meeting Hall' },
    },
    barks: [
      'The frontier perimeter is 768 metres of deliberate, peaceful stewardship.',
      'A level path connects hearts as much as it connects plots.',
      'We steward this world together — no speculation, just care.',
      'Check the boundary markers; the frontier gateway is clear.',
    ],
  },
]);

export const LIVING_OPERATORS = Object.freeze({
  botanists: {
    email: 'living-botanists@nemoworld.internal',
    name: 'Botanists & Scholars Guild',
    role: 'member',
  },
  artisans: {
    email: 'living-artisans@nemoworld.internal',
    name: 'Artisans & Architects Guild',
    role: 'member',
  },
});

/**
 * Idempotently setup the living world accounts, agents, inventory, and starter conditions.
 */
export function ensureLivingWorld(platform, { bootstrap = false } = {}) {
  ensureTradeMarket(platform);
  const accountCount = platform.get('SELECT COUNT(*) AS n FROM accounts').n;
  const hasAdmin = platform.get("SELECT COUNT(*) AS n FROM accounts WHERE role='admin'").n > 0;
  if (!bootstrap && (!hasAdmin || accountCount === 0)) {
    return { accounts: {}, agents: {} };
  }

  const accounts = {};

  // 1. Ensure operator accounts
  for (const [key, spec] of Object.entries(LIVING_OPERATORS)) {
    let account = platform.get('SELECT * FROM accounts WHERE email=?', spec.email);
    if (!account) {
      const id = randomUUID();
      const now = new Date(platform.clock()).toISOString();
      platform.run(
        'INSERT INTO accounts(id,name,email,password,role,status,consent_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
        id, spec.name, spec.email, 'internal-living-world-pass', spec.role, 'active', now, now
      );
      account = platform.get('SELECT * FROM accounts WHERE id=?', id);
    }
    accounts[key] = account;
  }

  // 2. Ensure agents
  const agents = {};
  for (const resident of LIVING_ROSTER) {
    const operator = accounts[resident.operatorKey];
    let agent = platform.get('SELECT * FROM agents WHERE id=?', resident.id);
    if (!agent) {
      const now = new Date(platform.clock()).toISOString();
      platform.run(
        'INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,z,world_id,grounded,posture,status,created_at,last_seen,verified,kind,region_id,country) VALUES(?,?,?,?,?,?,?,?,?,0,?,1,?,?,?,?,1,?,?,?)',
        resident.id, operator.id, resident.name, resident.color, resident.symbol,
        resident.capabilities, resident.limitations, resident.startX, resident.startY,
        'commons', 'standing', 'active', now, platform.clock(), 'agent', 'commons', 'NemoWorld'
      );
      // Create home
      platform.createHome(resident.id, resident.name);
      platform.recordVisit?.({ account: operator, kind: 'session' }, resident.id, 'commons');
      agent = platform.get('SELECT * FROM agents WHERE id=?', resident.id);
    }

    // Ensure calling
    const currentCalling = platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', agent.id);
    if (!currentCalling) {
      platform.run(
        'INSERT INTO resident_callings(agent_id,calling_id,selected_at,last_changed_day) VALUES(?,?,?,?)',
        agent.id, resident.calling, platform.clock(), ''
      );
    }

    // Seed starter inventory for trading and crafting loops
    const initialItems = [
      { kind: 'blossom', qty: 10 },
      { kind: 'fiber', qty: 10 },
      { kind: 'resin', qty: 8 },
      { kind: 'wood', qty: 12 },
      { kind: 'stone', qty: 12 },
    ];
    for (const item of initialItems) {
      platform.run(
        'INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=MAX(quantity,excluded.quantity)',
        agent.id, item.kind, item.qty
      );
    }

    agents[resident.id] = agent;
  }

  return { accounts, agents };
}

/**
 * Perform one autonomous simulation step across all living residents.
 */
export function livingWorldTick(platform, { verbose = false, bootstrap = false } = {}) {
  const { accounts, agents } = ensureLivingWorld(platform, { bootstrap });
  const atmosphere = worldAtmosphere(platform.clock());
  const phase = atmosphere.phase || 'day';

  if (!accounts.botanists || !accounts.artisans) {
    return {
      tick: platform.clock(),
      phase,
      moved: 0,
      spoken: 0,
      emoted: 0,
      trades_posted: 0,
      trades_claimed: 0,
    };
  }

  const report = {
    tick: platform.clock(),
    phase,
    moved: 0,
    spoken: 0,
    emoted: 0,
    trades_posted: 0,
    trades_claimed: 0,
  };

  // Inspect recent public messages to see if any human spoke recently and needs an answer
  const recentMessages = platform.all(
    "SELECT id, agent_id, account_id, text, created_at FROM messages WHERE world_id='commons' AND channel='public' ORDER BY created_at DESC LIMIT 5"
  );
  const now = platform.clock();
  const latestHumanMsg = recentMessages.find((m) => {
    const isBot = Object.keys(agents).includes(m.agent_id);
    const age = now - Date.parse(m.created_at);
    return !isBot && age < 30_000;
  });

  let repliedToHuman = false;

  for (const resident of LIVING_ROSTER) {
    const agent = platform.get('SELECT * FROM agents WHERE id=?', resident.id);
    if (!agent || agent.status !== 'active') continue;

    const operator = accounts[resident.operatorKey];
    const actor = { account: operator, kind: 'session' };

    // 1. Determine target destination for current cycle
    const target = resident.destinations[phase] || { x: resident.startX, y: resident.startY };

    // 2. Step towards destination if not there
    if (agent.world_id === 'commons' && (agent.x !== target.x || agent.y !== target.y)) {
      const dx = target.x - agent.x;
      const dy = target.y - agent.y;
      let dir = null;
      if (Math.abs(dx) > Math.abs(dy)) {
        dir = dx > 0 ? 'right' : 'left';
      } else if (dy !== 0) {
        dir = dy > 0 ? 'down' : 'up';
      }

      if (dir) {
        try {
          platform.moveAgent(actor, { agent_id: agent.id, direction: dir });
          report.moved++;
        } catch {
          // If path is blocked, try perpendicular step
          const altDir = dir === 'right' || dir === 'left' ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left');
          try {
            platform.moveAgent(actor, { agent_id: agent.id, direction: altDir });
            report.moved++;
          } catch {
            // Settle on current tile
          }
        }
      }
    }

    // 3. Interactive Response or Ambient Chatter
    // If a human recently spoke in Commons, nearest living agent replies
    if (!repliedToHuman && latestHumanMsg) {
      const dist = Math.abs(agent.x - 20) + Math.abs(agent.y - 18);
      if (dist <= 12) {
        const text = latestHumanMsg.text.toLowerCase();
        let reply = '';
        if (text.includes('quest') || text.includes('adventure') || text.includes('task')) {
          reply = `Greetings! Check the Quests menu in your journal or visit the Meeting Hall. Every calling has meaningful work.`;
        } else if (text.includes('trade') || text.includes('market') || text.includes('sell') || text.includes('buy')) {
          reply = `The Trade Board is open at the Workshop! You can post barter offers and exchange harvested goods.`;
        } else if (text.includes('crop') || text.includes('farm') || text.includes('plant') || text.includes('garden')) {
          reply = `Head to your private garden from the menu! Cultivate blossoms, herbs, and resin to craft fine keepsakes.`;
        } else if (text.includes('hello') || text.includes('hi') || text.includes('hey')) {
          reply = `Peace and welcome to NemoWorld! I am ${resident.name}, fellow resident and ${resident.calling}.`;
        } else {
          reply = `Well met, traveler. The Commons are calm during this ${phase}. Feel free to explore our library, workshop, and harbor.`;
        }

        try {
          platform.message(actor, {
            agent_id: agent.id,
            world_id: 'commons',
            channel: 'public',
            text: reply,
          });
          report.spoken++;
          repliedToHuman = true;

          // Emote wave or bow in greeting
          try {
            platform.emote(actor, { agent_id: agent.id, emote: 'wave' });
            report.emoted++;
          } catch {}
        } catch {}
      }
    }

    // 4. Occasional ambient bark if nobody spoke
    if (!repliedToHuman && Math.random() < 0.25) {
      const recentSaying = platform.get(
        "SELECT created_at FROM messages WHERE agent_id=? AND channel='public' ORDER BY created_at DESC LIMIT 1",
        agent.id
      );
      const lastSpoke = recentSaying ? Date.parse(recentSaying.created_at) : 0;
      if (now - lastSpoke > 45_000) {
        const bark = resident.barks[Math.floor(Math.random() * resident.barks.length)];
        try {
          platform.message(actor, {
            agent_id: agent.id,
            world_id: 'commons',
            channel: 'public',
            text: bark,
          });
          report.spoken++;
        } catch {}
      }
    }

    // 5. Emote when standing near other residents or at landmarks
    if (Math.random() < 0.20 && now - (agent.last_emote || 0) > 6000) {
      const emotes = ['wave', 'bow', 'cheer', 'think', 'heart'];
      const chosen = emotes[Math.floor(Math.random() * emotes.length)];
      try {
        platform.emote(actor, { agent_id: agent.id, emote: chosen });
        report.emoted++;
      } catch {}
    }
  }

  // 6. Autonomous Trade Market Activity (WoW Auction House Style)
  // Check if open trade listings exist; if so, claim them. If low on listings, post new ones!
  try {
    const openListings = platform.all(
      "SELECT id, poster_agent_id, poster_account_id, status FROM trade_listings WHERE status='open' LIMIT 5"
    );

    // If an artisan listing exists, botanist agent can claim it if they hold the terms
    for (const listing of openListings) {
      const isArtisanPoster = listing.poster_account_id === accounts.artisans.id;
      const claimerKey = isArtisanPoster ? 'botanists' : 'artisans';
      const claimerOp = accounts[claimerKey];
      const claimerAgent = LIVING_ROSTER.find((r) => r.operatorKey === claimerKey);
      if (!claimerAgent) continue;

      const claimActor = { account: claimerOp, kind: 'session' };
      const claimKey = `claim-${listing.id}-${Math.floor(now / 60000)}`;
      try {
        platform.tradeClaim(claimActor, { agent_id: claimerAgent.id, listing_id: listing.id }, claimKey);
        report.trades_claimed++;
      } catch {
        // Terms not matched or already claimed
      }
    }

    // If open listings are fewer than 3, have Kael or Aria post an offer
    if (openListings.length < 3) {
      const kael = agents['lw-kael'];
      const aria = agents['lw-aria'];
      if (kael && accounts.artisans) {
        const postKey = `post-kael-${Math.floor(now / 120000)}`;
        try {
          platform.tradePost(
            { account: accounts.artisans, kind: 'session' },
            {
              agent_id: kael.id,
              items: { blossom: 2 },
              terms: { fiber: 2 },
              note: 'Kael: Exchanging blossoms for fiber to weave banners.',
              expires_minutes: 60,
            },
            postKey
          );
          report.trades_posted++;
        } catch {}
      }
      if (aria && accounts.botanists) {
        const postKey = `post-aria-${Math.floor(now / 120000)}`;
        try {
          platform.tradePost(
            { account: accounts.botanists, kind: 'session' },
            {
              agent_id: aria.id,
              items: { resin: 2 },
              terms: { wood: 2 },
              note: 'Aria: Offering pure pine resin for seasoned wood.',
              expires_minutes: 60,
            },
            postKey
          );
          report.trades_posted++;
        } catch {}
      }
    }
  } catch (err) {
    if (verbose) console.error('Living world trade error:', err.message);
  }

  return report;
}

Platform.prototype.livingWorldTick = function() {
  return livingWorldTick(this);
};
