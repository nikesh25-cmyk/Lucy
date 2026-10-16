import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { ensureLivingWorld, livingWorldTick, LIVING_ROSTER } from '../src/living-world.js';
import content from '../src/content.js';

test('living world initializes 8 diverse resident agents with callings and starter inventory', () => {
  const platform = new Platform(':memory:');
  try {
    const { accounts, agents } = ensureLivingWorld(platform, { bootstrap: true });
    assert.ok(accounts.botanists);
    assert.ok(accounts.artisans);

    assert.equal(Object.keys(agents).length, 8);
    for (const resident of LIVING_ROSTER) {
      const agent = agents[resident.id];
      assert.ok(agent, `Agent ${resident.id} exists`);
      assert.equal(agent.name, resident.name);
      assert.equal(agent.status, 'active');
      assert.equal(agent.world_id, 'commons');

      const calling = platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', agent.id);
      assert.equal(calling.calling_id, resident.calling, `Calling matches for ${resident.id}`);

      const inventory = platform.all('SELECT kind, quantity FROM journey_inventory WHERE agent_id=?', agent.id);
      assert.ok(inventory.length > 0, `Inventory seeded for ${resident.id}`);
    }

    // Re-running ensureLivingWorld is idempotent
    const secondPass = ensureLivingWorld(platform, { bootstrap: true });
    assert.equal(Object.keys(secondPass.agents).length, 8);
  } finally {
    platform.close();
  }
});

test('living world tick moves agents towards designated waypoints and broadcasts actions', () => {
  const platform = new Platform(':memory:');
  try {
    ensureLivingWorld(platform, { bootstrap: true });

    const report = livingWorldTick(platform, { bootstrap: true });
    assert.ok(report.tick > 0);
    assert.ok(['dawn', 'day', 'dusk', 'night'].includes(report.phase));
    assert.ok(typeof report.moved === 'number');
    assert.ok(typeof report.spoken === 'number');
    assert.ok(typeof report.emoted === 'number');
  } finally {
    platform.close();
  }
});

test('living world agents respond to human chat in the Commons with helpful in-character advice', async () => {
  const platform = new Platform(':memory:');
  try {
    // Register a distinct human player who becomes initial admin
    const human = await platform.register({
      name: 'Human Explorer',
      email: 'human-explorer@example.org',
      password: 'human-secure-password-2026',
      consent: true,
    });

    ensureLivingWorld(platform);

    // Advance clock by 2s so message rate limiter doesn't block
    const now = platform.clock() + 2000;
    platform.run(
      "INSERT INTO messages(id, agent_id, account_id, channel, text, created_at, world_id, recipients) VALUES('h-msg-1', NULL, ?, 'public', 'Hello everyone! How do I start a quest?', ?, 'commons', '[]')",
      human.account.id, new Date(now).toISOString()
    );

    const report = livingWorldTick(platform);
    assert.ok(report.spoken >= 1, 'At least one resident responded to human message');

    const botReply = platform.get(
      "SELECT * FROM messages WHERE world_id='commons' AND channel='public' AND text LIKE '%Quests%' LIMIT 1"
    );
    assert.ok(botReply, 'Bot reply about quests recorded in database');
    assert.ok(botReply.agent_id.startsWith('lw-'), 'Reply is attributed to a living world resident');
    livingWorldTick(platform);
    assert.equal(platform.get("SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%Quests%'").n, 1, 'The same human message receives one reply');
  } finally {
    platform.close();
  }
});

test('living residents receive starter stock once and leave human trade listings untouched', async () => {
  const platform = new Platform(':memory:');
  try {
    const human = await platform.register({
      name: 'Human Trader', email: 'trader@example.org', password: 'human-trader-password-2026', consent: true,
    });
    const actor = platform.authenticate(human.token);
    const avatar = platform.createAgent(actor, { kind: 'human', name: 'Trader', country: 'NemoWorld' });
    ensureLivingWorld(platform);
    platform.run("UPDATE journey_inventory SET quantity=0 WHERE agent_id='lw-aria' AND kind='wood'");
    platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?)", avatar.id, 'wood', 2);
    const listing = platform.tradePost(actor, { agent_id: avatar.id, items: { wood: 2 }, note: 'Human offer' }, 'human-offer');
    livingWorldTick(platform);
    assert.equal(platform.get("SELECT quantity FROM journey_inventory WHERE agent_id='lw-aria' AND kind='wood'").quantity, 0, 'Autonomous tick does not refill spent stock');
    assert.equal(platform.get('SELECT status FROM trade_listings WHERE id=?', listing.id).status, 'open', 'Autonomous traders do not take a human offer');
    assert.equal(platform.get('SELECT COUNT(*) AS n FROM trade_claims WHERE listing_id=?', listing.id).n, 0);
  } finally {
    platform.close();
  }
});

test('legacy internal operator credentials are repaired and cannot sign in', async () => {
  const platform = new Platform(':memory:');
  try {
    ensureLivingWorld(platform, { bootstrap: true });
    platform.run("UPDATE accounts SET password='internal-living-world-pass' WHERE email='living-botanists@nemoworld.internal'");
    ensureLivingWorld(platform, { bootstrap: true });
    const stored = platform.get("SELECT password FROM accounts WHERE email='living-botanists@nemoworld.internal'").password;
    assert.match(stored, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    await assert.rejects(platform.login({ email: 'living-botanists@nemoworld.internal', password: 'internal-living-world-pass' }), { status: 401 });
  } finally {
    platform.close();
  }
});

test('the public API cannot force an autonomous living-world tick', async (t) => {
  const platform = new Platform(':memory:');
  const admin = await platform.register({
    name: 'Administrator', email: 'admin-tick@example.org', password: 'admin-tick-password-2026', consent: true,
  });
  const { server } = createApp({ platform, livingWorld: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/living-world/tick`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 404);
});

test('living world autonomous trade market posts and claims listings between guilds', () => {
  const platform = new Platform(':memory:');
  try {
    ensureLivingWorld(platform, { bootstrap: true });

    // Initial tick posts listings
    const firstTick = livingWorldTick(platform, { bootstrap: true });
    assert.ok(firstTick.trades_posted >= 1, 'At least one barter listing posted');

    const listings = platform.all("SELECT * FROM trade_listings WHERE status='open'");
    assert.ok(listings.length > 0, 'Open trade listings present on the board');

    // Give claimer the terms so they can claim
    const listing = listings[0];
    const isArtisan = listing.poster_account_id === platform.get("SELECT id FROM accounts WHERE email='living-artisans@nemoworld.internal'").id;
    const buyerAgentId = isArtisan ? 'lw-aria' : 'lw-kael';
    const terms = platform.all('SELECT kind, offered FROM trade_terms WHERE listing_id=?', listing.id);

    for (const term of terms) {
      platform.run(
        'INSERT INTO journey_inventory(agent_id, kind, quantity) VALUES(?,?,?) ON CONFLICT(agent_id, kind) DO UPDATE SET quantity=quantity+excluded.quantity',
        buyerAgentId, term.kind, term.offered + 5
      );
    }

    // Next tick attempts claims
    const secondTick = livingWorldTick(platform, { bootstrap: true });
    assert.ok(secondTick.trades_claimed >= 1, 'Listing successfully claimed between guilds');
  } finally {
    platform.close();
  }
});

test('HTTP GET /api/v1/living-world/status returns public living world state', async (t) => {
  const platform = new Platform(':memory:');
  await platform.register({
    name: 'Admin',
    email: 'admin-living-world@example.org',
    password: 'local-admin-pass-2026',
    consent: true,
  });
  const { server } = createApp({ platform, livingWorld: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/living-world/status`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.active, true);
  assert.equal(data.population, 8);
  assert.equal(data.residents.length, 8);
  assert.ok(['dawn', 'day', 'dusk', 'night'].includes(data.phase));
});

test('living world residents enroll in practice quests and advance callings through autonomous gardening and crafting', async () => {
  const platform = new Platform(':memory:');
  try {
    ensureLivingWorld(platform, { bootstrap: true });

    // Verify quest enrollments
    const enrollments = platform.all("SELECT * FROM quest_enrollments WHERE agent_id LIKE 'lw-%'");
    assert.ok(enrollments.length >= 4, 'Living world agents enrolled in practice quests');

    // Farm plot exists for Aria
    const farmTile = platform.get("SELECT * FROM world_objects WHERE world_id='home:lw-aria' AND type='farm'");
    assert.ok(farmTile, 'Farm tile exists in Aria garden');

    // First tick plants crop
    let tick = livingWorldTick(platform, { bootstrap: true });
    assert.equal(tick.cultivated, 1, 'Crop planted by cultivator');

    // The resident uses the same sealed growth time as player crops.
    const originalClock = platform.clock;
    let simulatedTime = originalClock.call(platform) + 5000;
    platform.clock = () => simulatedTime;

    tick = livingWorldTick(platform, { bootstrap: true });
    assert.equal(tick.harvested, 0, 'A crop cannot mature after five seconds');
    simulatedTime += content.rules('crop').find((entry) => entry.id === 'blossom').rules.grow_ms;

    // Second tick harvests crop and crafts
    tick = livingWorldTick(platform, { bootstrap: true });
    assert.equal(tick.harvested, 1, 'Mature crop harvested by cultivator');
    assert.ok(tick.crafted >= 1, 'Keepsake crafted by artisan');

    // Verify calling receipts awarded
    const receipts = platform.all("SELECT * FROM calling_receipts WHERE agent_id IN ('lw-aria', 'lw-kael')");
    assert.ok(receipts.length >= 1, 'Calling receipts awarded for autonomous vocation actions');
  } finally {
    platform.close();
  }
});

test('living world residents greet nearby human players in Commons with emotes', async () => {
  const platform = new Platform(':memory:');
  try {
    const human = await platform.register({
      name: 'Wandering Player',
      email: 'wanderer@example.org',
      password: 'wanderer-password-2026',
      consent: true,
    });
    // Create an active human agent standing at (20, 20) in commons (close to Theron at (20, 18))
    platform.run(
      "INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,z,world_id,grounded,posture,status,created_at,last_seen,verified,kind,region_id,country) VALUES('h-agent-1',?,'Wandering Player','#333333','★','Player','None',20,20,0,'commons',1,'standing','active',?,?,'1','human','commons','NemoWorld')",
      human.account.id, new Date(platform.clock()).toISOString(), platform.clock()
    );

    ensureLivingWorld(platform);

    const tick = livingWorldTick(platform);
    assert.ok(tick.emoted >= 1, 'Resident emoted in reaction to nearby human');

    const resident = platform.get("SELECT * FROM agents WHERE id='lw-theron'");
    assert.equal(resident.emote, 'wave', 'Theron waved to nearby player');
  } finally {
    platform.close();
  }
});



