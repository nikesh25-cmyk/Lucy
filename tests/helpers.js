import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '../src/platform.js';

export const PASSWORD = 'local-test-password-2026';
export const evidence = (claim, changes = {}) => ({
  claim_id: claim.id,
  artifact: 'An attributed plain text evidence register entry.',
  sources: [{ url: 'https://example.org/report', location: 'Section 2, paragraph 3', date: '2026-01-01' }],
  method: 'Read the original source and recorded the exact supporting section.',
  limitations: 'A workflow fixture; facts and rights require human verification.',
  rights: 'Permission and attribution were checked for this fixture.',
  ...changes,
});

export async function fixture(t, { startAt } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'seed-test-'));
  const database = join(directory, 'platform.sqlite');
  // Defaults to the wall clock, exactly as before. A test whose assertions depend on which UTC day a
  // saved row lands in passes `startAt`, so its own clock no longer depends on when the suite happens
  // to run (the cultivator daily-cap test advances across a day boundary otherwise).
  let currentTime = startAt ?? Date.now();
  const platform = new Platform(database, () => currentTime);
  t.after(async () => {
    try { platform.close(); } catch { /* A restart test may already have closed it. */ }
    await rm(directory, { recursive: true, force: true });
  });
  const credentials = {};
  credentials.admin = await platform.register({ name: 'Admin', email: 'admin@example.org', password: PASSWORD, consent: true });
  const actor = (name) => platform.authenticate(credentials[name].token);
  const tx = (method, ...args) => platform.transaction(() => platform[method](...args));
  for (const [name, role] of [['alice', 'member'], ['bob', 'member'], ['reviewer', 'reviewer'], ['moderator', 'moderator']]) {
    const invite = tx('invite', actor('admin'), { role });
    credentials[name] = await platform.register({ name, email: `${name}@example.org`, password: PASSWORD, consent: true, invite: invite.code });
  }
  const agent = (owner, name = `${owner} avatar`) => tx('createAgent', actor(owner), { name, capabilities: 'Read and summarize approved sources', limitations: 'Requires source and human review', color: '#397f79', symbol: '✦' });
  const advance = (milliseconds = 2000) => { currentTime += milliseconds; };
  return { platform, directory, database, credentials, actor, tx, agent, advance, clock: () => currentTime };
}

export function realMission(f, overrides = {}) {
  const mission = f.tx('createMission', f.actor('admin'), {
    title: 'Verified fixture mission', area: 'Climate', summary: 'Test an evidence contribution from claim through adoption.',
    beneficiary: 'Test community', owner_id: f.actor('admin').account.id, reviewer_id: f.actor('reviewer').account.id,
    rubric: 'Check exact original sources, rights, uncertainty, and attribution.', ...overrides,
  });
  const task = f.tx('createTask', f.actor('admin'), {
    mission_id: mission.id, title: 'Record one source', instructions: 'Provide attribution, location, rights, and uncertainty.',
    rights: 'Explicit permission required.', allowed_domains: ['example.org'],
  });
  f.tx('missionStatus', f.actor('admin'), mission.id, 'open');
  return { mission, task };
}
