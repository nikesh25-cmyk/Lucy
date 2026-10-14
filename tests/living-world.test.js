import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { ensureLivingWorld, livingWorldTick, LIVING_ROSTER } from '../src/living-world.js';

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
  } finally {
    platform.close();
  }
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


